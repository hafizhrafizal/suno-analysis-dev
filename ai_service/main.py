import asyncio
import logging
import os
import random
import re
from contextlib import asynccontextmanager
from typing import List, Optional

import numpy as np

# Global seed for reproducibility across numpy, Python random, and (where
# supported) any library that respects np.random state.
_SEED = 42
random.seed(_SEED)
np.random.seed(_SEED)

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

embedding_model = None
emotion_classifier = None
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

# Suno/Discord-specific noise words added on top of sklearn's English stopwords
DOMAIN_STOPWORDS = [
    "https", "http", "www", "com", "org", "ve", "don", "doesn", "wasn",
    "suno", "discord", "ai", "like", "just", "know", "think", "really",
    "would", "could", "should", "also", "use", "using", "used", "one",
    "get", "got", "make", "made", "way", "good", "great", "thanks",
    "thank", "yeah", "yes", "hey", "lol", "haha", "ok", "okay", "much",
    "well", "even", "still", "going", "people", "thing", "things",
    "want", "need", "said", "say", "actually", "probably", "basically",
    "literally", "right", "time", "new", "bit", "lot", "let", "try",
]

POSITIVE_EMOTIONS = frozenset({
    "admiration", "amusement", "approval", "caring",
    "excitement", "gratitude", "joy", "love", "optimism",
    "pride", "relief",
})
NEGATIVE_EMOTIONS = frozenset({
    "anger", "annoyance", "disappointment", "disapproval",
    "disgust", "embarrassment", "fear", "grief",
    "nervousness", "remorse", "sadness",
})

# Compiled patterns for document cleaning
_URL_RE = re.compile(r'https?://\S+|www\.\S+')
_MENTION_RE = re.compile(r'<@[!&]?\d+>|@\w+')
_DISCORD_EMOJI_RE = re.compile(r'<a?:\w+:\d+>')
_WHITESPACE_RE = re.compile(r'\s+')


def clean_doc(text: str) -> str:
    """Strip URLs, Discord mentions, and custom emoji; collapse whitespace."""
    text = _URL_RE.sub('', text)
    text = _MENTION_RE.sub('', text)
    text = _DISCORD_EMOJI_RE.sub('', text)
    return _WHITESPACE_RE.sub(' ', text).strip()


def is_meaningful(text: str, min_words: int = 5) -> bool:
    """
    Return True if the document carries enough signal for topic modeling.

    Requires after cleaning:
    - At least `min_words` whitespace-separated tokens
    - At least 3 purely alphabetic tokens of length >= 3
      (filters out emoji-spam, number-only posts, symbol noise)
    """
    cleaned = clean_doc(text)
    words = cleaned.split()
    if len(words) < min_words:
        return False
    alpha_words = [w for w in words if re.fullmatch(r'[a-zA-Z]{3,}', w)]
    return len(alpha_words) >= 3


def emotion_to_sentiment(label: str) -> str:
    if label in POSITIVE_EMOTIONS:
        return "positive"
    if label in NEGATIVE_EMOTIONS:
        return "negative"
    return "neutral"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global embedding_model, emotion_classifier
    logger.info("Loading sentence-transformer model (all-MiniLM-L6-v2) as fallback…")
    from sentence_transformers import SentenceTransformer
    embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
    logger.info("Sentence-transformer ready.")
    logger.info("Loading GoEmotions classifier (SamLowe/roberta-base-go_emotions)…")
    try:
        import torch
        torch.manual_seed(_SEED)
        # Cap PyTorch intra-op threads to avoid over-subscription on CPU
        torch.set_num_threads(min(os.cpu_count() or 1, 4))
        from transformers import pipeline as hf_pipeline
        emotion_classifier = hf_pipeline(
            "text-classification",
            model="SamLowe/roberta-base-go_emotions",
            top_k=None,
            device=-1,
            truncation=True,
            max_length=128,   # Discord messages are short; 128 tokens is ample
        )
        logger.info("Emotion model ready.")
    except Exception as exc:
        logger.warning("Could not load emotion model: %s", exc)
    yield


app = FastAPI(title="BERTopic Service", lifespan=lifespan)


class TopicsRequest(BaseModel):
    docs: List[str]
    embeddings: Optional[List[List[float]]] = None
    msg_uuids: Optional[List[str]] = None


class EmotionMessage(BaseModel):
    content: str
    date: str
    msg_uuid: str


class EmotionRequest(BaseModel):
    messages: List[EmotionMessage]


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": embedding_model is not None}


async def gpt_label(keywords: List[str], rep_docs: List[str]) -> Optional[str]:
    """Call GPT-4o-mini to generate a meaningful topic name."""
    if not OPENAI_API_KEY:
        return None
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        kw_str = ", ".join(keywords[:8])
        docs_str = "\n".join(f"- {d[:200]}" for d in rep_docs[:3])
        prompt = (
            "You are labelling discussion topics from a Suno AI music generation Discord community.\n\n"
            f"Top keywords: {kw_str}\n\n"
            f"Sample messages:\n{docs_str}\n\n"
            "Give a concise, descriptive topic label (3–6 words). "
            "Return ONLY the label, no punctuation, no explanation."
        )
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=20,
            temperature=0,
        )
        label = resp.choices[0].message.content.strip().strip('"').strip("'")
        return label or None
    except Exception as exc:
        logger.warning("OpenAI label generation failed: %s", exc)
        return None


@app.post("/topics")
async def run_bertopic(req: TopicsRequest):
    from bertopic import BERTopic
    from hdbscan import HDBSCAN
    from umap import UMAP
    from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS

    total_input = len(req.docs)
    using_precomputed = req.embeddings is not None and len(req.embeddings) == total_input
    uuids_in = req.msg_uuids or [''] * total_input

    # Filter to meaningful docs only; clean text for better vectorization.
    # Embeddings are pre-computed from original text so clustering is unaffected.
    if using_precomputed:
        triples = [
            (clean_doc(d.strip()), e, u)
            for d, e, u in zip(req.docs, req.embeddings, uuids_in)
            if is_meaningful(d.strip())
        ]
        docs = [t[0] for t in triples]
        precomputed = np.array([t[1] for t in triples], dtype=np.float32) if triples else None
        filtered_uuids = [t[2] for t in triples]
        logger.info(
            "Pre-computed embeddings: %d meaningful docs (%d dropped as noisy/short)",
            len(docs), total_input - len(docs),
        )
    else:
        pairs = [
            (clean_doc(d.strip()), u)
            for d, u in zip(req.docs, uuids_in)
            if is_meaningful(d.strip())
        ]
        docs = [p[0] for p in pairs]
        filtered_uuids = [p[1] for p in pairs]
        precomputed = None
        logger.info(
            "Embedding %d meaningful docs (%d dropped as noisy/short) with sentence-transformers",
            len(docs), total_input - len(docs),
        )

    if len(docs) == 0:
        return {
            "topics": [],
            "total_docs": total_input,
            "filtered_docs": 0,
            "warning": "No messages with enough meaningful content found (need ≥5 words, ≥3 alphabetic).",
        }

    # Tiny-corpus path: BERTopic and HDBSCAN need several samples; handle small
    # batches with a direct CountVectorizer keyword extraction instead.
    if len(docs) < 5:
        stop_words = list(set(ENGLISH_STOP_WORDS) | set(DOMAIN_STOPWORDS))
        tiny_vec = CountVectorizer(stop_words=stop_words, ngram_range=(1, 2), min_df=1)
        try:
            matrix = tiny_vec.fit_transform(docs)
            freqs = matrix.toarray().sum(axis=0)
            vocab = tiny_vec.get_feature_names_out()
            top_idx = freqs.argsort()[::-1][:8]
            keywords = [vocab[i] for i in top_idx if freqs[i] > 0]
        except Exception:
            keywords = []

        fallback_label = " · ".join(keywords[:3]) if keywords else "General Discussion"
        topic_obj = {
            "id": 0,
            "label": fallback_label,
            "keywords": keywords,
            "message_count": len(docs),
            "representative_docs": docs[:10],
        }

        if OPENAI_API_KEY and keywords:
            gpt_result = await gpt_label(keywords, docs[:3])
            if gpt_result:
                topic_obj["label"] = gpt_result

        tiny_assignments = {u: 0 for u in filtered_uuids if u}
        return {
            "topics": [topic_obj],
            "doc_assignments": tiny_assignments,
            "total_docs": total_input,
            "filtered_docs": len(docs),
            "used_precomputed_embeddings": precomputed is not None,
            "used_openai_labels": bool(OPENAI_API_KEY and keywords),
        }

    # --- Adaptive parameters ---
    n = len(docs)

    # min_topic_size: keep close to the original heuristic so HDBSCAN can form
    # fine-grained topics.  Only push higher for very large corpora where
    # micro-clusters become noise rather than signal.
    if n >= 2000:
        min_size = max(15, min(30, n // 100))  # ~1% per topic, cap 30
    else:
        min_size = max(2, min(15, n // 8))     # original formula

    # Sanitize precomputed embeddings — NaN/inf cause HDBSCAN to crash silently
    if precomputed is not None:
        precomputed = np.nan_to_num(precomputed, nan=0.0, posinf=0.0, neginf=0.0)

    n_jobs = max(1, (os.cpu_count() or 1))

    # UMAP: cosine metric matches sentence-transformer training objective;
    # n_components=5 gives better cluster separation than 2D projection.
    # n_epochs=200 (vs default 500) cuts UMAP time ~60% with negligible quality loss.
    # n_jobs parallelises the nearest-neighbour graph construction.
    umap_model = UMAP(
        n_neighbors=min(15, n - 1),
        n_components=min(5, n - 2),
        n_epochs=200,
        min_dist=0.0,
        metric='cosine',
        random_state=_SEED,
        low_memory=n > 5000,
        n_jobs=n_jobs,
    )

    # HDBSCAN: min_samples=1 makes it far less conservative about outlier
    # assignment — any point can be a core point — while min_cluster_size
    # still enforces meaningful topic size.
    # core_dist_n_jobs parallelises the core-distance computation.
    hdbscan_model = HDBSCAN(
        min_cluster_size=min_size,
        min_samples=1,
        metric='euclidean',
        cluster_selection_method='eom',
        prediction_data=True,   # required for reduce_outliers
        core_dist_n_jobs=n_jobs,
    )

    stop_words = list(set(ENGLISH_STOP_WORDS) | set(DOMAIN_STOPWORDS))
    vectorizer = CountVectorizer(
        stop_words=stop_words,
        ngram_range=(1, 2),
        min_df=2,
        max_features=5000,   # cap vocabulary for faster TF-IDF
    )

    try:
        topic_model = BERTopic(
            embedding_model=None if precomputed is not None else embedding_model,
            umap_model=umap_model,
            hdbscan_model=hdbscan_model,
            vectorizer_model=vectorizer,
            min_topic_size=min_size,
            nr_topics="auto",
            verbose=False,
            calculate_probabilities=False,
        )

        # Run CPU-bound fit_transform in a thread so the event loop stays responsive
        if precomputed is not None:
            topic_assignments, _ = await asyncio.to_thread(
                topic_model.fit_transform, docs, embeddings=precomputed
            )
        else:
            topic_assignments, _ = await asyncio.to_thread(
                topic_model.fit_transform, docs
            )

        # Build embedding matrix for representative doc ranking and outlier reduction.
        if precomputed is not None:
            all_embs = precomputed
        else:
            all_embs = np.array(
                embedding_model.encode(docs, show_progress_bar=False), dtype=np.float32
            )

        # Outlier reduction: reassign topic -1 docs to their nearest topic
        # by cosine similarity to topic centroids.  Applied whenever >10% of
        # docs are outliers and at least one real topic exists.
        outlier_count = sum(1 for t in topic_assignments if t == -1)
        outlier_pct = outlier_count / len(topic_assignments)
        real_topics = set(topic_assignments) - {-1}
        logger.info(
            "Initial clustering: %d topics, %d outliers (%.1f%%)",
            len(real_topics), outlier_count, outlier_pct * 100,
        )

        if outlier_pct > 0.10 and real_topics:
            try:
                def _reduce_outliers(_ta=topic_assignments):
                    reduced = topic_model.reduce_outliers(
                        docs,
                        _ta,
                        strategy="embeddings",
                        embeddings=all_embs,
                        threshold=0.25,
                    )
                    topic_model.update_topics(docs, topics=reduced, vectorizer_model=vectorizer)
                    return reduced

                topic_assignments = await asyncio.to_thread(_reduce_outliers)
                new_outliers = sum(1 for t in topic_assignments if t == -1)
                logger.info(
                    "After outlier reduction: %d outliers remain (%.1f%%)",
                    new_outliers, new_outliers / len(topic_assignments) * 100,
                )
            except Exception as exc:
                logger.warning("Outlier reduction failed, keeping original: %s", exc)

        topic_info = topic_model.get_topic_info()
        topic_assignments_arr = np.array(topic_assignments)

        # Build uuid → topic_id map so the frontend can group full message objects
        doc_assignments: dict = {}
        for uuid, tid in zip(filtered_uuids, topic_assignments):
            if uuid:
                doc_assignments[uuid] = int(tid)

        def top_docs_by_similarity(topic_id: int, n: int = 10) -> List[str]:
            """Return up to n docs for a topic, sorted by cosine sim to centroid."""
            from sklearn.metrics.pairwise import cosine_similarity as cos_sim
            idx = np.where(topic_assignments_arr == topic_id)[0]
            if len(idx) == 0:
                return []
            embs = all_embs[idx]
            centroid = embs.mean(axis=0, keepdims=True)
            sims = cos_sim(centroid, embs)[0]
            top_idx = np.argsort(sims)[::-1][:n]
            return [docs[idx[i]] for i in top_idx]

        # Build base topic objects
        raw_topics = []
        for _, row in topic_info.iterrows():
            topic_id = int(row["Topic"])
            kw_pairs = topic_model.get_topic(topic_id) or []
            keywords = [kw for kw, _ in kw_pairs[:8]]
            rep_docs_list = top_docs_by_similarity(topic_id, n=10)

            fallback_label = (
                "Outliers / Miscellaneous"
                if topic_id == -1
                else (" · ".join(kw for kw, _ in kw_pairs[:3]) if kw_pairs else f"Topic {topic_id}")
            )

            raw_topics.append({
                "id": topic_id,
                "label": fallback_label,
                "keywords": keywords,
                "message_count": int(row["Count"]),
                "representative_docs": rep_docs_list,
            })

        # Call GPT-4o-mini in parallel for all non-outlier topics
        used_openai = False
        if OPENAI_API_KEY:
            non_outlier_idx = [i for i, t in enumerate(raw_topics) if t["id"] != -1]
            if non_outlier_idx:
                gpt_results = await asyncio.gather(
                    *[
                        gpt_label(raw_topics[i]["keywords"], raw_topics[i]["representative_docs"])
                        for i in non_outlier_idx
                    ],
                    return_exceptions=True,
                )
                for i, result in zip(non_outlier_idx, gpt_results):
                    if isinstance(result, str) and result:
                        raw_topics[i]["label"] = result
                        used_openai = True

        raw_topics.sort(key=lambda t: (t["id"] == -1, -t["message_count"]))

        return {
            "topics": raw_topics,
            "doc_assignments": doc_assignments,
            "total_docs": total_input,
            "filtered_docs": len(docs),
            "used_precomputed_embeddings": precomputed is not None,
            "used_openai_labels": used_openai,
        }

    except Exception as exc:
        logger.exception("BERTopic pipeline failed, falling back to keyword extraction")

        # Graceful fallback: extract top keywords via CountVectorizer and return
        # a single topic so the frontend still gets usable results.
        stop_words = list(set(ENGLISH_STOP_WORDS) | set(DOMAIN_STOPWORDS))
        fallback_vec = CountVectorizer(stop_words=stop_words, ngram_range=(1, 2), min_df=1)
        try:
            matrix = fallback_vec.fit_transform(docs)
            freqs = matrix.toarray().sum(axis=0)
            vocab = fallback_vec.get_feature_names_out()
            top_idx = freqs.argsort()[::-1][:8]
            keywords = [vocab[i] for i in top_idx if freqs[i] > 0]
        except Exception:
            keywords = []

        fallback_label = " · ".join(keywords[:3]) if keywords else "General Discussion"
        fallback_topic = {
            "id": 0,
            "label": fallback_label,
            "keywords": keywords,
            "message_count": len(docs),
            "representative_docs": docs[:10],
        }
        fallback_assignments = {u: 0 for u in filtered_uuids if u}

        return {
            "topics": [fallback_topic],
            "doc_assignments": fallback_assignments,
            "total_docs": total_input,
            "filtered_docs": len(docs),
            "used_precomputed_embeddings": precomputed is not None,
            "used_openai_labels": False,
            "warning": f"BERTopic clustering failed ({exc}), using keyword-based fallback",
        }


@app.post("/analyze_emotion")
async def analyze_emotion(
    req: EmotionRequest,
    x_hf_token: Optional[str] = Header(default=None, alias="x-hf-token"),
):
    if emotion_classifier is None:
        raise HTTPException(status_code=503, detail="Emotion model not loaded")

    # Make HF token available to huggingface_hub for any on-demand model ops
    if x_hf_token:
        os.environ["HUGGINGFACE_HUB_TOKEN"] = x_hf_token

    total_input = len(req.messages)
    meaningful = [m for m in req.messages if is_meaningful(m.content.strip())]

    if not meaningful:
        return {
            "per_message": [],
            "summary": {
                "sentiment_ratio": {"positive": 0.0, "negative": 0.0, "neutral": 1.0},
                "top_emotions": [],
                "timeline": [],
            },
            "total_messages": total_input,
            "analyzed_messages": 0,
        }

    texts = [clean_doc(m.content.strip()) for m in meaningful]

    def _run_inference(batch):
        return emotion_classifier(batch, batch_size=64)

    try:
        raw_results = await asyncio.to_thread(_run_inference, texts)
    except Exception as exc:
        logger.exception("Emotion inference failed")
        raise HTTPException(status_code=500, detail=str(exc))

    per_message = []
    emotion_totals: dict = {}
    emotion_counts: dict = {}
    sentiment_counts = {"positive": 0, "negative": 0, "neutral": 0}
    timeline_data: dict = {}

    for msg, scores in zip(meaningful, raw_results):
        top = sorted(scores, key=lambda x: x["score"], reverse=True)
        top_filtered = [e for e in top if e["score"] >= 0.05][:5]
        dominant_label = top[0]["label"] if top else "neutral"
        sentiment = emotion_to_sentiment(dominant_label)
        sentiment_counts[sentiment] += 1

        for e in scores:
            lbl = e["label"]
            emotion_totals[lbl] = emotion_totals.get(lbl, 0.0) + e["score"]
            emotion_counts[lbl] = emotion_counts.get(lbl, 0) + 1

        period = msg.date[:7] if len(msg.date) >= 7 else "unknown"
        if period not in timeline_data:
            timeline_data[period] = {"positive": 0, "negative": 0, "neutral": 0, "count": 0}
        timeline_data[period][sentiment] += 1
        timeline_data[period]["count"] += 1

        per_message.append({
            "msg_uuid": msg.msg_uuid,
            "date": msg.date,
            "top_emotions": [{"label": e["label"], "score": round(e["score"], 4)} for e in top_filtered],
            "sentiment": sentiment,
        })

    total_analyzed = len(meaningful)
    avg_emotions = [
        {"label": lbl, "score": round(emotion_totals[lbl] / emotion_counts[lbl], 4)}
        for lbl in emotion_totals
    ]
    avg_emotions.sort(key=lambda x: x["score"], reverse=True)

    return {
        "per_message": per_message,
        "summary": {
            "sentiment_ratio": {k: round(v / total_analyzed, 4) for k, v in sentiment_counts.items()},
            "top_emotions": avg_emotions[:10],
            "timeline": [
                {
                    "period": p,
                    "positive": c["positive"],
                    "negative": c["negative"],
                    "neutral": c["neutral"],
                    "count": c["count"],
                }
                for p, c in sorted(timeline_data.items())
            ],
        },
        "total_messages": total_input,
        "analyzed_messages": total_analyzed,
    }
