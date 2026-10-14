import asyncio
import logging
import os
import random
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

# Load .env BEFORE any os.environ.get() reads below — module-level constants
# like _HF_ENDPOINT_URL are evaluated at import time, so dotenv has to win
# the race.  `.env` is .gitignored; keep secrets there, not in source.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # dotenv missing → fall back to whatever's in the shell env

import numpy as np
import requests

# Global seed for reproducibility across numpy, Python random, and (where
# supported) any library that respects np.random state.
_SEED = 42
random.seed(_SEED)
np.random.seed(_SEED)

# Topic analysis libraries — imported once at startup to avoid per-request overhead
# and to allow numba JIT warmup during lifespan startup.
try:
    from bertopic import BERTopic
    from hdbscan import HDBSCAN
    from umap import UMAP
    from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS
    _TOPIC_LIBS_AVAILABLE = True
except ImportError:
    _TOPIC_LIBS_AVAILABLE = False
    BERTopic = HDBSCAN = UMAP = CountVectorizer = ENGLISH_STOP_WORDS = None  # type: ignore

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Silence BERTopic's "Using a custom list of topic assignments…" warning fired by
# update_topics() inside _reduce_outliers.  We deliberately call update_topics()
# as the final pipeline step (no further reductions follow), so the warning is
# informational noise.
if _TOPIC_LIBS_AVAILABLE:
    logging.getLogger("bertopic").setLevel(logging.ERROR)

embedding_model = None
emotion_classifier = None
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

# Cap concurrent inferences at the CPU count so 8 backend chunks don't oversubscribe
# the CPU and induce swap/contention spikes (which were observed as backend-side
# "client timeout (no response in 300s)" retries).  Excess requests AWAIT inside
# asyncio for ~one-inference-duration instead of being fast-rejected (no 503s,
# no retry storms).  Override with env AI_INFERENCE_CONCURRENCY when needed.
_AI_INFERENCE_CONCURRENCY = max(
    1, int(os.environ.get("AI_INFERENCE_CONCURRENCY", os.cpu_count() or 4))
)
# Created in lifespan so it binds to the FastAPI event loop, not module import time.
_inference_sem: "Optional[asyncio.Semaphore]" = None

# Topic analysis is CPU-heavy (UMAP + HDBSCAN need all cores).  Serialise to 1
# concurrent run by default so each analysis gets the full CPU.  Raise via
# TOPIC_CONCURRENCY env var only if the machine has many NUMA nodes.
_TOPIC_CONCURRENCY = max(1, int(os.environ.get("TOPIC_CONCURRENCY", "1")))
_topic_sem: "Optional[asyncio.Semaphore]" = None

# When set, /analyze_emotion forwards inference to this HF Dedicated Endpoint
# (using the per-request X-HF-Token as the Bearer auth) instead of the local
# ONNX model.  GPU-backed endpoints are ~10-30x faster than local CPU.
# Cold-start (15-min idle scale-to-zero) takes ~30-60s; first call after idle
# may return 503/504 — handled by backend's ai_retry.
_HF_ENDPOINT_URL = os.environ.get("HF_ENDPOINT_URL", "").strip() or None
# Optional token for the startup pre-warm ping (no request exists yet at that
# point, so we can't borrow X-HF-Token).  Falls back to HUGGINGFACE_HUB_TOKEN
# which most HF-aware setups already have.  Inference at runtime still uses
# the per-request X-HF-Token, not this.
_HF_ENDPOINT_WARMUP_TOKEN = (
    os.environ.get("HF_ENDPOINT_TOKEN", "").strip()
    or os.environ.get("HUGGINGFACE_HUB_TOKEN", "").strip()
    or None
)
if _HF_ENDPOINT_URL:
    logger.info("HF_ENDPOINT_URL set — emotion inference will use remote endpoint.")

# Shared HTTPS session for HF calls.  Without an explicit adapter, urllib3
# caps `pool_maxsize` at 10, so 32 parallel inference threads serialize on
# 10 connection slots AND every call pays a full TLS handshake.  Pool of
# 64 + connection reuse drops per-call overhead from ~1s to ~100ms.
_hf_session: "Optional[requests.Session]" = None

def _get_hf_session() -> "requests.Session":
    global _hf_session
    if _hf_session is None:
        s = requests.Session()
        # Pool sized for the peak: backend AI_CONCURRENCY=8 concurrent chunks
        # × max_workers=32 threads per chunk = up to 256 in-flight HTTPS calls
        # to the same host.  Smaller pool causes urllib3 "Connection pool is
        # full" warnings + per-overflow TLS handshakes (wasted ~100-300ms each).
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=64, pool_maxsize=256, pool_block=False,
        )
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        _hf_session = s
    return _hf_session

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

_EMOTION_MODEL_ID = "SamLowe/roberta-base-go_emotions"
# Store ONNX artefacts inside the HuggingFace cache volume so they survive
# container restarts (the volume is mounted at /root/.cache/huggingface in Docker).
_HF_CACHE_ROOT = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface")))
_EMOTION_ONNX_DIR = _HF_CACHE_ROOT / "go_emotions_onnx"
_EMOTION_QUANT_DIR = _HF_CACHE_ROOT / "go_emotions_onnx_int8"

# Each concurrent inference runs in its own asyncio.to_thread worker.
# OMP_NUM_THREADS=1 ensures every ONNX/PyTorch session uses exactly one OS
# thread so N parallel requests use N threads instead of N×cores threads,
# preventing CPU over-subscription.  The backend's AI_CONCURRENCY=8 semaphore
# is the single throttle; no additional semaphore is needed here.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

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


def _is_meaningful_cleaned(cleaned: str, min_words: int = 5) -> bool:
    """Like is_meaningful but accepts pre-cleaned text, avoiding a redundant clean_doc call."""
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


def _load_emotion_pipeline():
    """
    Load the GoEmotions classifier with a 3-tier fallback:
      1. ONNX INT8 quantized  — fastest (~3-5x vs PyTorch CPU)
      2. ONNX FP32            — still faster than PyTorch (~1.5-2x)
      3. PyTorch CPU          — original behaviour, always available
    The ONNX export and INT8 quantization run once and are cached to disk.
    """
    from transformers import pipeline as hf_pipeline

    def _pytorch_fallback():
        import torch
        torch.manual_seed(_SEED)
        torch.set_num_threads(1)  # 1 thread per session so N parallel sessions use N threads
        pipe = hf_pipeline(
            "text-classification",
            model=_EMOTION_MODEL_ID,
            top_k=None,
            device=-1,
            truncation=True,
            max_length=128,
        )
        logger.info("Emotion model ready (PyTorch CPU).")
        return pipe

    # Try to import optimum; skip ONNX tiers if not installed.
    try:
        from optimum.onnxruntime import ORTModelForSequenceClassification, ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig
        from transformers import AutoTokenizer
    except ImportError:
        logger.info("optimum not installed; using PyTorch CPU for emotion model.")
        return _pytorch_fallback()

    tokenizer = AutoTokenizer.from_pretrained(_EMOTION_MODEL_ID)

    def _make_pipeline(model):
        return hf_pipeline(
            "text-classification",
            model=model,
            tokenizer=tokenizer,
            top_k=None,
            truncation=True,
            max_length=128,
        )

    # --- Tier 1: INT8 quantized ONNX ---
    quant_files = sorted(_EMOTION_QUANT_DIR.glob("*.onnx")) if _EMOTION_QUANT_DIR.exists() else []
    if quant_files:
        try:
            model = ORTModelForSequenceClassification.from_pretrained(
                str(_EMOTION_QUANT_DIR), file_name=quant_files[0].name
            )
            logger.info("Emotion model ready (ONNX INT8, cached).")
            return _make_pipeline(model)
        except Exception as exc:
            logger.warning("Cached INT8 model load failed (%s); rebuilding...", exc)

    # Build: export to ONNX then quantize to INT8
    try:
        onnx_model_file = _EMOTION_ONNX_DIR / "model.onnx"
        if not onnx_model_file.exists():
            logger.info("Exporting emotion model to ONNX (one-time setup, ~1 min)...")
            _EMOTION_ONNX_DIR.mkdir(parents=True, exist_ok=True)
            ort_model = ORTModelForSequenceClassification.from_pretrained(
                _EMOTION_MODEL_ID, export=True
            )
            ort_model.save_pretrained(str(_EMOTION_ONNX_DIR))

        logger.info("Quantizing ONNX model to INT8...")
        _EMOTION_QUANT_DIR.mkdir(parents=True, exist_ok=True)
        quantizer = ORTQuantizer.from_pretrained(str(_EMOTION_ONNX_DIR))
        qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=False)
        quantizer.quantize(save_dir=str(_EMOTION_QUANT_DIR), quantization_config=qconfig)

        quant_files = sorted(_EMOTION_QUANT_DIR.glob("*.onnx"))
        if quant_files:
            model = ORTModelForSequenceClassification.from_pretrained(
                str(_EMOTION_QUANT_DIR), file_name=quant_files[0].name
            )
            logger.info("Emotion model ready (ONNX INT8).")
            return _make_pipeline(model)
    except Exception as exc:
        logger.warning("ONNX INT8 setup failed (%s); trying plain ONNX...", exc)

    # --- Tier 2: plain ONNX FP32 ---
    try:
        onnx_model_file = _EMOTION_ONNX_DIR / "model.onnx"
        if not onnx_model_file.exists():
            logger.info("Exporting emotion model to ONNX...")
            _EMOTION_ONNX_DIR.mkdir(parents=True, exist_ok=True)
            ort_model = ORTModelForSequenceClassification.from_pretrained(
                _EMOTION_MODEL_ID, export=True
            )
            ort_model.save_pretrained(str(_EMOTION_ONNX_DIR))

        model = ORTModelForSequenceClassification.from_pretrained(str(_EMOTION_ONNX_DIR))
        logger.info("Emotion model ready (ONNX FP32).")
        return _make_pipeline(model)
    except Exception as exc:
        logger.warning("Plain ONNX setup failed (%s); falling back to PyTorch CPU...", exc)

    # --- Tier 3: original PyTorch CPU ---
    return _pytorch_fallback()


async def _prewarm_hf_endpoint():
    """Wake the HF Dedicated Endpoint at startup so the first user request
    doesn't pay the 30-60s scale-to-zero cold-start.  Runs as a background
    task — never blocks app startup.  Logs success/failure but never raises."""
    if not _HF_ENDPOINT_URL:
        return
    if not _HF_ENDPOINT_WARMUP_TOKEN:
        logger.warning(
            "HF_ENDPOINT_URL is set but no warmup token in env "
            "(HF_ENDPOINT_TOKEN or HUGGINGFACE_HUB_TOKEN).  Pre-warm skipped — "
            "the first user request will pay the cold-start cost (~30-60s)."
        )
        return
    logger.info("Pre-warming HF endpoint in background (may take 30-60s if cold)…")
    t0 = time.perf_counter()
    try:
        sess = _get_hf_session()
        resp = await asyncio.to_thread(
            sess.post,
            _HF_ENDPOINT_URL,
            headers={
                "Authorization": f"Bearer {_HF_ENDPOINT_WARMUP_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"inputs": "warmup"},
            timeout=180,
        )
        dt = time.perf_counter() - t0
        if resp.status_code == 200:
            logger.info("HF endpoint warm (%.1fs).", dt)
        else:
            logger.warning(
                "HF pre-warm got HTTP %d in %.1fs: %s",
                resp.status_code, dt, resp.text[:200],
            )
    except Exception as exc:
        logger.warning("HF endpoint pre-warm failed (non-fatal): %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global embedding_model, emotion_classifier, _inference_sem, _topic_sem
    _inference_sem = asyncio.Semaphore(_AI_INFERENCE_CONCURRENCY)
    logger.info("Inference semaphore initialised with %d slot(s).", _AI_INFERENCE_CONCURRENCY)
    _topic_sem = asyncio.Semaphore(_TOPIC_CONCURRENCY)
    logger.info("Topic semaphore initialised with %d slot(s).", _TOPIC_CONCURRENCY)
    logger.info("Loading sentence-transformer model (all-MiniLM-L6-v2) as fallback…")
    from sentence_transformers import SentenceTransformer
    embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
    logger.info("Sentence-transformer ready.")
    if _HF_ENDPOINT_URL:
        # HF mode: skip local emotion model entirely.  All /analyze_emotion
        # traffic goes to the remote endpoint, so loading + JIT-warming a
        # local fallback would be 30-90s of wasted CPU and ~125MB of dead RAM.
        # If HF goes down, unset HF_ENDPOINT_URL and restart to use the
        # local model instead — there's no automatic silent fallback.
        logger.info("Skipping local emotion model load (HF_ENDPOINT_URL is set).")
    else:
        logger.info("Loading emotion classifier (ONNX INT8 preferred, PyTorch CPU fallback)…")
        try:
            emotion_classifier = _load_emotion_pipeline()
        except Exception as exc:
            logger.warning("Could not load emotion model: %s", exc)
        # Warm up: run dummy inferences matching production shapes so ONNX RT
        # JIT-compiles the graph kernels NOW, not on the first user request.
        # Production calls use batch_size=128 with truncation max_length=128.
        # We warm three shapes so concurrent first-chunks never serialize on a
        # JIT event (this was the dominant cause of "retrying in 0.7s…"
        # warnings right after startup):
        #   - batch=128 → main path
        #   - batch=64  → typical tail batch
        #   - batch=1   → ad-hoc single-message calls (user_emotion endpoint)
        if emotion_classifier is not None:
            try:
                logger.info("Warming up emotion model (JIT-compiling production batch shapes)…")
                warm_text = "the model needs a realistic input to compile its graph properly"
                for warm_batch in (128, 64, 1):
                    emotion_classifier([warm_text] * warm_batch, batch_size=128)
                logger.info("Emotion model warmed up for batch sizes 1/64/128.")
            except Exception as exc:
                logger.warning("Warm-up inference failed (non-fatal): %s", exc)
    # Background pre-warm of the remote HF endpoint so the first user request
    # doesn't wait the 30-60s cold-start.  Non-blocking: app accepts traffic
    # immediately; warmup completes in parallel.
    if _HF_ENDPOINT_URL:
        asyncio.create_task(_prewarm_hf_endpoint())
    # Warm up UMAP's numba JIT so the first real topic analysis doesn't pay the
    # ~10-30s numba compilation cost.  A 30-point dummy fit is enough to trigger
    # all relevant JIT paths (nearest-neighbour graph + layout).
    if _TOPIC_LIBS_AVAILABLE:
        try:
            logger.info("Warming up UMAP numba JIT (one-time compilation)…")
            _n_warmup = max(1, (os.cpu_count() or 1))
            _dummy_umap = UMAP(
                n_neighbors=5, n_components=2, n_epochs=5,
                random_state=_SEED, n_jobs=_n_warmup,
            )
            _dummy_data = np.random.default_rng(_SEED).random((40, 16)).astype(np.float32)
            await asyncio.to_thread(_dummy_umap.fit_transform, _dummy_data)
            logger.info("UMAP numba JIT ready.")
        except Exception as _exc:
            logger.warning("UMAP warmup failed (non-fatal): %s", _exc)
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
    """Call GPT-4o-mini to generate a meaningful topic name.

    `rep_docs` should be a diverse sample (e.g. from diverse_sample_for_labeling)
    of up to ~10 messages spanning the cluster's similarity spectrum, so the
    model sees both the core and the edges when judging the dominant role.
    """
    if not OPENAI_API_KEY:
        return None
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        kw_str = ", ".join(keywords[:8])
        docs_str = "\n".join(f"- {d[:200]}" for d in rep_docs)
        prompt = (
            "You are labelling discussion topics from a Suno AI music generation Discord community.\n\n"
            f"Top keywords: {kw_str}\n\n"
            f"Sample messages (mix of core and edge examples from the cluster):\n{docs_str}\n\n"
            "Write a concise topic label (4–8 words) that captures the DIRECTION of help, the action verb, and the subject.\n\n"
            "STEP 1 — Determine the DIRECTION OF HELP by reading the messages carefully:\n\n"
            "SHARING HELP (contributor) — the author is helping OTHERS:\n"
            "  Signals: imperative instructions ('try this', 'go to Settings', 'make sure you'), "
            "step-by-step directions, offering fixes or solutions, explaining how something works, "
            "pointing others to resources, caring/supportive tone ('hope that helps', 'let me know if'), "
            "troubleshooting guidance aimed at another person's problem.\n"
            "  Verbs to use: Sharing / Explaining / Guiding / Recommending / Demonstrating / "
            "Teaching / Providing / Offering / Helping troubleshoot / Walking through\n\n"
            "SEEKING HELP (help-seeker) — the author needs help THEMSELVES:\n"
            "  Signals: first-person confusion or struggle ('I can't', 'why doesn't this work', "
            "'not working for me', 'I don't understand'), direct questions about their own problem, "
            "reporting their own error or failure, requesting others to fix or explain something for them.\n"
            "  Verbs to use: Asking about / Requesting / Seeking help with / Wondering about / "
            "Struggling with / Reporting issues with\n\n"
            "KEY RULE: A message about troubleshooting, fixing, or solving a problem "
            "is SHARING HELP if the author is guiding or advising others. "
            "It is SEEKING HELP only if the author is describing their OWN unresolved problem.\n\n"
            "STEP 2 — Pick the specific subject (tool name, feature, workflow).\n\n"
            "Format: <Verb> <specific subject>\n"
            "Good examples:\n"
            "  'Guiding troubleshooting audio export issues' (contributor giving directions)\n"
            "  'Sharing prompt techniques for style control' (contributor teaching)\n"
            "  'Asking about voice cloning with Bark' (seeker with their own problem)\n"
            "  'Struggling with song length generation limits' (seeker reporting own issue)\n"
            "  'Walking through Suno API setup steps' (contributor providing instructions)\n"
            "  'Seeking help with account billing errors' (seeker needing assistance)\n\n"
            "Return ONLY the label, no punctuation at the end, no explanation."
        )
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=45,
            temperature=0.2,
        )
        label = resp.choices[0].message.content.strip().strip('"').strip("'")
        return label or None
    except Exception as exc:
        logger.warning("OpenAI label generation failed: %s", exc)
        return None


@app.post("/topics")
async def run_bertopic(req: TopicsRequest):
    if not _TOPIC_LIBS_AVAILABLE:
        raise HTTPException(status_code=503, detail="Topic analysis libraries not installed")

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

    # --- Acquire topic semaphore — only 1 analysis runs at a time so each
    # gets the full CPU budget instead of competing for cores.
    async with _topic_sem:
        return await _run_bertopic_locked(
            docs, precomputed, filtered_uuids, total_input,
        )


async def _run_bertopic_locked(
    docs: list,
    precomputed,
    filtered_uuids: list,
    total_input: int,
):
    """Inner BERTopic pipeline — called only while _topic_sem is held."""
    from sklearn.metrics.pairwise import cosine_similarity as cos_sim

    # --- Adaptive parameters ---
    n = len(docs)

    if n >= 2000:
        min_size = max(15, min(30, n // 100))
    else:
        min_size = max(2, min(15, n // 8))

    if precomputed is not None:
        precomputed = np.nan_to_num(precomputed, nan=0.0, posinf=0.0, neginf=0.0)

    n_jobs = max(1, (os.cpu_count() or 1))

    # Override the global OMP_NUM_THREADS=1 (set for the emotion model) so that
    # UMAP and HDBSCAN can use all available CPU threads.  Restored in finally
    # regardless of success or failure so emotion inference is unaffected.
    _prev_omp = os.environ.get("OMP_NUM_THREADS")
    _prev_mkl = os.environ.get("MKL_NUM_THREADS")
    try:
        os.environ["OMP_NUM_THREADS"] = str(n_jobs)
        os.environ["MKL_NUM_THREADS"] = str(n_jobs)
        try:
            import numba
            numba.set_num_threads(n_jobs)
        except Exception:
            pass

        umap_model = UMAP(
            n_neighbors=min(15, n - 1),
            n_components=min(5, n - 2),
            n_epochs=25 if n > 5000 else (50 if n > 2000 else 100),
            min_dist=0.0,
            metric='cosine',
            random_state=_SEED,
            low_memory=n > 5000,
            n_jobs=n_jobs,
        )

        hdbscan_model = HDBSCAN(
            min_cluster_size=min_size,
            min_samples=1,
            metric='euclidean',
            cluster_selection_method='eom',
            prediction_data=True,
            core_dist_n_jobs=n_jobs,
        )

        stop_words = list(set(ENGLISH_STOP_WORDS) | set(DOMAIN_STOPWORDS))
        # min_df=2 prunes vocabulary aggressively for sparse small corpora —
        # combined with the heavy stopword list this often leaves zero terms
        # and raises "After pruning, no terms remain" from sklearn, or an
        # empty-diagonal ValueError in BERTopic's c-TF-IDF.  Use min_df=1
        # for corpora under 50 docs; the reactive fallback in _fit handles
        # edge cases at larger n.
        adaptive_min_df = 1 if n < 50 else 2
        vectorizer = CountVectorizer(
            stop_words=stop_words,
            ngram_range=(1, 2),
            min_df=adaptive_min_df,
            max_features=5000,
        )

        try:
            # nr_topics="auto" triggers a second HDBSCAN pass (_auto_reduce_topics)
            # that fails with "Found array with 0 sample(s)" when all documents are
            # initially assigned to the outlier class (-1).  This reliably happens
            # on tiny corpora (n < 20) where HDBSCAN has nowhere to cluster.
            nr_topics = None if n < 20 else "auto"

            topic_model = BERTopic(
                embedding_model=None if precomputed is not None else embedding_model,
                umap_model=umap_model,
                hdbscan_model=hdbscan_model,
                vectorizer_model=vectorizer,
                min_topic_size=min_size,
                nr_topics=nr_topics,
                verbose=False,
                calculate_probabilities=False,
            )

            async def _fit(embs=None):
                try:
                    return await asyncio.to_thread(
                        topic_model.fit_transform, docs,
                        **({'embeddings': embs} if embs is not None else {}),
                    )
                except ValueError as exc:
                    exc_str = str(exc)
                    if "0 sample" in exc_str and topic_model.nr_topics is not None:
                        # All docs became outliers; retry without auto-reduction.
                        logger.warning("Auto-reduce got 0 samples, retrying with nr_topics=None: %s", exc)
                        topic_model.nr_topics = None
                        return await asyncio.to_thread(
                            topic_model.fit_transform, docs,
                            **({'embeddings': embs} if embs is not None else {}),
                        )
                    if getattr(topic_model.vectorizer_model, 'min_df', 1) != 1:
                        # Vectorizer pruned all terms ("no terms remain") or the
                        # resulting c-TF-IDF matrix was empty (empty diagonal in
                        # scipy.diags).  Rebuild with min_df=1 and retry once.
                        logger.warning(
                            "Vectorizer/c-TF-IDF empty-vocabulary failure, retrying with min_df=1: %s", exc
                        )
                        topic_model.vectorizer_model = CountVectorizer(
                            stop_words=stop_words,
                            ngram_range=(1, 2),
                            min_df=1,
                            max_features=5000,
                        )
                        return await asyncio.to_thread(
                            topic_model.fit_transform, docs,
                            **({'embeddings': embs} if embs is not None else {}),
                        )
                    raise

            if precomputed is not None:
                topic_assignments, _ = await _fit(precomputed)
            else:
                topic_assignments, _ = await _fit()

            if precomputed is not None:
                all_embs = precomputed
            else:
                all_embs = np.array(
                    embedding_model.encode(docs, show_progress_bar=False), dtype=np.float32
                )

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
                        # c-tf-idf: uses TF-IDF doc representations, ~5-10x faster
                        # than the dense "embeddings" strategy (avoids 384D cosine loop).
                        reduced = topic_model.reduce_outliers(
                            docs, _ta, strategy="c-tf-idf", threshold=0.1,
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

            doc_assignments: dict = {}
            for uuid, tid in zip(filtered_uuids, topic_assignments):
                if uuid:
                    doc_assignments[uuid] = int(tid)

            def top_docs_by_similarity(topic_id: int, k: int = 10) -> List[str]:
                """Top-k docs by cosine similarity to centroid — for display."""
                idx = np.where(topic_assignments_arr == topic_id)[0]
                if len(idx) == 0:
                    return []
                embs = all_embs[idx]
                centroid = embs.mean(axis=0, keepdims=True)
                sims = cos_sim(centroid, embs)[0]
                top_idx = np.argsort(sims)[::-1][:k]
                return [docs[idx[i]] for i in top_idx]

            def diverse_sample_for_labeling(topic_id: int, k: int = 10) -> List[str]:
                """Stratified sample across the cluster's similarity spectrum so GPT
                sees both 'core' examples and edge cases.  Pure top-similarity would
                miss the edges entirely, which are exactly what help disambiguate
                mixed roles (e.g. help-seekers vs contributors in the same cluster).
                Recipe: 3 core (top-sim) + 3 typical (middle) + 2 edges (bottom) + 2 random.
                Falls back to all docs sorted by similarity if cluster has ≤k docs."""
                idx = np.where(topic_assignments_arr == topic_id)[0]
                n_docs = len(idx)
                if n_docs == 0:
                    return []
                embs = all_embs[idx]
                centroid = embs.mean(axis=0, keepdims=True)
                sims = cos_sim(centroid, embs)[0]
                sorted_idx = np.argsort(sims)[::-1]  # high → low similarity

                if n_docs <= k:
                    return [docs[idx[i]] for i in sorted_idx]

                picks: List[int] = []
                picks.extend(int(i) for i in sorted_idx[:3])              # core
                mid_start = max(3, n_docs // 2 - 1)
                picks.extend(int(i) for i in sorted_idx[mid_start : mid_start + 3])  # typical
                picks.extend(int(i) for i in sorted_idx[-2:])             # edges

                seen = set(picks)
                rng = np.random.default_rng(_SEED + topic_id)
                remaining = [int(i) for i in sorted_idx if int(i) not in seen]
                if remaining and len(picks) < k:
                    n_rand = min(k - len(picks), len(remaining))
                    random_picks = rng.choice(remaining, size=n_rand, replace=False)
                    picks.extend(int(i) for i in random_picks)

                # Order by similarity rank so GPT sees most-representative examples first
                rank_map = {int(i): r for r, i in enumerate(sorted_idx)}
                picks.sort(key=lambda i: rank_map[int(i)])
                return [docs[idx[i]] for i in picks]

            raw_topics = []
            labeling_docs_list: List[List[str]] = []
            for _, row in topic_info.iterrows():
                topic_id = int(row["Topic"])
                kw_pairs = topic_model.get_topic(topic_id) or []
                keywords = [kw for kw, _ in kw_pairs[:8]]
                rep_docs_list = top_docs_by_similarity(topic_id)
                labeling_docs_list.append(diverse_sample_for_labeling(topic_id))

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

            used_openai = False
            if OPENAI_API_KEY:
                non_outlier_idx = [i for i, t in enumerate(raw_topics) if t["id"] != -1]
                if non_outlier_idx:
                    gpt_results = await asyncio.gather(
                        *[
                            gpt_label(raw_topics[i]["keywords"], labeling_docs_list[i])
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

            fallback_stop = list(set(ENGLISH_STOP_WORDS) | set(DOMAIN_STOPWORDS))
            fallback_vec = CountVectorizer(stop_words=fallback_stop, ngram_range=(1, 2), min_df=1)
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

    finally:
        # Restore OMP/MKL thread counts so emotion model inference is unaffected.
        if _prev_omp is None:
            os.environ.pop("OMP_NUM_THREADS", None)
        else:
            os.environ["OMP_NUM_THREADS"] = _prev_omp
        if _prev_mkl is None:
            os.environ.pop("MKL_NUM_THREADS", None)
        else:
            os.environ["MKL_NUM_THREADS"] = _prev_mkl


@app.post("/analyze_emotion")
async def analyze_emotion(
    req: EmotionRequest,
    x_hf_token: Optional[str] = Header(default=None, alias="x-hf-token"),
):
    # Local-model gate is bypassed when an HF endpoint is configured:
    # inference happens on HF's GPU and only requires the token to call it.
    if _HF_ENDPOINT_URL is None and emotion_classifier is None:
        raise HTTPException(status_code=503, detail="Emotion model not loaded")
    if _HF_ENDPOINT_URL is not None and not x_hf_token:
        raise HTTPException(
            status_code=401,
            detail="HF endpoint is configured but X-HF-Token header is missing.",
        )

    if x_hf_token:
        os.environ["HUGGINGFACE_HUB_TOKEN"] = x_hf_token

    return await _do_analyze_emotion(req, hf_token=x_hf_token)


async def _do_analyze_emotion(req: EmotionRequest, hf_token: Optional[str] = None):
    total_input = len(req.messages)
    pairs = [(m, clean_doc(m.content.strip())) for m in req.messages]
    meaningful_pairs = [(m, t) for m, t in pairs if _is_meaningful_cleaned(t)]

    if not meaningful_pairs:
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

    meaningful = [p[0] for p in meaningful_pairs]
    texts = [p[1] for p in meaningful_pairs]

    # Match the backend's CHUNK_SIZE so each backend-shipped chunk maps to
    # exactly one batch on the ORT side — no tail batch of mismatched shape.
    _EMOTION_CHUNK = 128

    def _run_chunk(chunk):
        return emotion_classifier(chunk, batch_size=128)

    def _run_chunk_hf(chunk):
        # The HF Dedicated Endpoint we're hitting does NOT batch correctly:
        # sending `inputs: [a, b, c]` returns one prediction (treating the
        # JSON array as a single string or taking only the last item) and
        # large batches trigger 422 schema-validation rejections.  Working
        # around it by sending one HTTP request per input concurrently
        # via a thread pool.  Each single-input response is a flat list
        # of 28 label/score dicts (verified via curl); we assemble them
        # into the list-of-lists shape the downstream code expects:
        #     [[{label,score} × 28], [{label,score} × 28], ...]
        from concurrent.futures import ThreadPoolExecutor

        sess = _get_hf_session()
        def _single(text):
            resp = sess.post(
                _HF_ENDPOINT_URL,
                headers={
                    "Authorization": f"Bearer {hf_token}",
                    "Content-Type": "application/json",
                },
                json={"inputs": text, "parameters": {"top_k": None}},
                timeout=180,
            )
            if not resp.ok:
                body = (resp.text or "")[:300]
                raise requests.HTTPError(
                    f"HF returned {resp.status_code}: {body}", response=resp
                )
            body = resp.json()
            # Defensive normalisation: HF may return either
            #   A. [{label,score}, ...]      (flat, what we expect for single input)
            #   B. [[{label,score}, ...]]    (nested singleton — unwrap)
            if body and isinstance(body, list) and isinstance(body[0], list):
                return body[0]
            return body

        t0 = time.perf_counter()
        # 32 parallel HTTPS calls.  T4 endpoint serves them concurrently;
        # network RTT (~50-100ms) dominates per-call latency, not GPU time.
        # 128 msgs / 32 workers × ~80ms RTT ≈ 320ms per chunk.
        with ThreadPoolExecutor(max_workers=32) as executor:
            results = list(executor.map(_single, chunk))
        dt = time.perf_counter() - t0

        # >30s suggests an actual cold-start wake (HF scale-from-zero is
        # 30-60s).  Sub-30s chunks are just normal HF autoscaling latency or
        # queue depth as parallel requests stack up, not a problem worth
        # warning about — was previously flagging 8s chunks which are fine.
        if dt > 30.0:
            logger.warning("HF chunk: %d msgs in %.2fs (likely cold-start wake)",
                           len(chunk), dt)
        else:
            logger.info("HF chunk: %d msgs in %.2fs (%.0f msg/s)",
                        len(chunk), dt, len(chunk) / dt if dt > 0 else 0.0)
        return results

    async def _run_chunk_gated(chunk):
        if _HF_ENDPOINT_URL is not None:
            # No local semaphore: inference happens on HF's GPU; this process
            # is just I/O-forwarding.  Concurrency is bounded by backend's
            # AI_CONCURRENCY=8, and HF's autoscaling handles its end.
            return await asyncio.to_thread(_run_chunk_hf, chunk)
        # Local path — semaphore caps inferences at cpu_count to avoid
        # oversubscription.
        assert _inference_sem is not None, "Semaphore not initialised"
        async with _inference_sem:
            return await asyncio.to_thread(_run_chunk, chunk)

    t0 = time.perf_counter()
    try:
        chunks = [texts[i:i + _EMOTION_CHUNK] for i in range(0, len(texts), _EMOTION_CHUNK)]
        chunk_results = await asyncio.gather(*[_run_chunk_gated(c) for c in chunks])
        raw_results = [item for sublist in chunk_results for item in sublist]
    except Exception as exc:
        logger.exception("Emotion inference failed")
        raise HTTPException(status_code=500, detail=str(exc))
    dt = time.perf_counter() - t0
    # Per-request timing.  Local mode: >30s means CPU contention.  HF mode:
    # >30s usually means the endpoint was cold-starting (~30-60s wake).
    mode = "HF" if _HF_ENDPOINT_URL else "local"
    level = logging.WARNING if dt > 30.0 else logging.INFO
    logger.log(level,
        "analyze_emotion [%s]: %d msgs (%d meaningful) in %.2fs (%.1f msg/s)",
        mode, total_input, len(meaningful), dt,
        (len(meaningful) / dt) if dt > 0 else 0.0,
    )

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
