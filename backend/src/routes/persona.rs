// Persona / archetype classification (single-method, primary + secondary).
//
// Replaces the previous dual (rule_based / llm) classifier with a unified
// 5-archetype scoring system: Power Contributor, Help-Seeker, Evangelist,
// Scrutinizer, Casual Explorer (plus the special "Suno Team" short-circuit).
// All signals come from existing DB tables (messages, message_emotions,
// user_topic_runs/items) so a batch compute for ~100 users runs in a few
// SQL queries + pure Rust math.
//
// Lurker was removed — low-engagement users are classified by
// stance/sentiment, but Contributor is no longer hard-gated by engagement:
// a low-frequency user who dominantly shares knowledge still lands Contributor,
// just at reduced confidence (0.75× dampening vs High/Mid).

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

use crate::{
    error::Result,
    models::AuthUser,
    state::AppState,
};

// ── Request types ────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
pub struct UserStatsInput {
    pub username: String,
    pub total_messages: i64,
    pub weeks_active: i64,
    /// 0–100 (percentage of phase weeks the user was active)
    pub pct_weeks: f64,
    pub avg_words: f64,
    /// Precomputed engagement level from the frontend's `classifyEngagement`.
    /// Values: "high" | "medium" | "low".  This is the AUTHORITATIVE tier
    /// signal — backend just maps it onto `Tier`.  Window-aware absolute
    /// thresholds in the frontend (pct_weeks ≥ 50 AND total_messages ≥ msgFloor
    /// for high) avoid the percentile-rank inflation that would otherwise let
    /// quiet-phase users sneak into Power Contributor.
    #[serde(default)]
    pub engagement: Option<String>,
}

#[derive(Deserialize)]
pub struct ComputeBatchRequest {
    pub phase: String,
    pub phase_label: String,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub upload_ids: Option<String>,
    pub users: Vec<UserStatsInput>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub phase: Option<String>,
    pub method: Option<String>,
}

/// All new persona rows use this single method name.  Legacy rows with
/// method = "rule_based" or "llm" are still readable via list/by_phase
/// endpoints but no new ones are produced.
pub const METHOD_NAME: &str = "archetype";

// ── Topic-role verb/subject mapping ─────────────────────────────────────────

/// Granular topic role — split "Sharing" into three sub-types so the scorer
/// can distinguish knowledge transfer (→ Contributor) from opinion / creative
/// output (→ Explorer).  "Asking" is further split into HelpSeeking vs Asking
/// (curious) so topic evidence is the primary Help-Seeker vs Explorer gate.
#[derive(Copy, Clone, PartialEq)]
enum TopicRole {
    HelpSeeking,       // troubleshooting, fixing, needing help → strong Help-Seeker signal
    Asking,            // curious asking, wondering, questioning → Explorer signal
    KnowledgeSharing,  // tips, workflows, tutorials   → strong Contributor signal
    OpinionSharing,    // thoughts, reactions, feedback → Explorer signal
    CreativeSharing,   // posting music / output alone  → Explorer signal
    Sharing,           // generic sharing verb, no subject match → mild signal
    Neutral,
}

// First-word verbs that signal troubleshooting / help-seeking (topic → HelpSeeking).
const HELP_SEEKING_VERBS: &[&str] = &[
    "troubleshooting", "troubleshoot", "troubleshoots",
    "struggling", "struggles", "struggle",
    "needing", "needs", "need",
    "debugging", "debug", "debugs",
    "fixing",
    "diagnosing", "diagnose",
    "requesting", "requests", "request",
];

// First-word verbs that signal curious / exploratory asking (topic → Asking).
const ASKING_VERBS: &[&str] = &[
    "asking", "asks", "ask",
    "seeking", "seeks", "seek",
    "wondering", "wonders", "wonder",
    "looking", "looks",
    "trying", "tries", "try",
    "questioning", "questions",
    "inquiring", "inquires", "inquire",
    "clarifying", "clarifies", "clarify",
    "investigating",
];

// Verbs that signal sharing / contributing / teaching.
const SHARING_VERBS: &[&str] = &[
    "sharing", "shares", "share", "shared",
    "explaining", "explains", "explain", "explained",
    "recommending", "recommends", "recommend", "recommended",
    "demonstrating", "demonstrates", "demonstrate", "demonstrated",
    "teaching", "teaches", "teach", "taught",
    "guiding", "guides", "guide", "guided",
    "providing", "provides", "provide", "provided",
    "showcasing", "showcases", "showcase", "showcased",
    "showing", "shows", "show", "showed",
    "offering", "offers", "offer", "offered",
    "presenting", "presents", "present", "presented",
    "advising", "advises", "advise", "advised",
    "suggesting", "suggests", "suggest", "suggested",
    "tipping", "tips",
    "creating", "creates", "create", "created",
    "composing", "composes", "compose", "composed",
    "generating", "generates", "generate", "generated",
    "producing", "produces", "produce", "produced",
    "crafting", "crafts", "craft", "crafted",
    "building", "builds", "build", "built",
    "designing", "designs", "design", "designed",
    "making", "makes", "make", "made",
    "posting", "posts", "post", "posted",
    "uploading", "uploads", "upload", "uploaded",
    "publishing", "publishes", "publish", "published",
    "releasing", "releases", "release", "released",
    "dropping", "drops", "dropped",
    "writing", "writes", "write", "wrote",
    "remixing", "remixes", "remix", "remixed",
    "covering", "covers",
    "performing", "performs", "perform",
    "describing", "describes", "describe",
    "reviewing", "reviews", "review", "reviewed",
    "comparing", "compares", "compare", "compared",
    "analyzing", "analyzes", "analyze", "analyzed",
    "reporting", "reports", "report", "reported",
    "discussing", "discusses", "discuss", "discussed",
    "highlighting", "highlights", "highlight",
    "celebrating", "celebrates", "celebrate",
    "praising", "praises", "praise",
    "appreciating", "appreciates", "appreciate",
    "configuring", "configures", "configure",
    "tweaking", "tweaks", "tweak",
    "iterating", "iterates", "iterate",
    "improving", "improves", "improve", "improved",
    "refining", "refines", "refine", "refined",
    "experimenting", "experiments", "experiment",
];

// Phrases that signal troubleshooting / help-seeking — checked BEFORE verb
// classification so "seeking help with X" → HelpSeeking even though "seeking"
// alone is in ASKING_VERBS.
const HELP_SEEKING_PHRASES: &[&str] = &[
    "seeking help", "need help", "needs help", "needing help",
    "having trouble", "not working", "doesn't work",
    "issue with", "problem with", "error in", "stuck on",
    "help with", "can someone", "can anyone",
];

// Phrases that signal curious / exploratory asking.
const ASKING_PHRASES: &[&str] = &[
    "looking for", "trying to", "asking for", "how do",
    "how to", "anyone know", "anyone have", "anyone tried",
    "what about", "what is", "what are", "where can",
    "where to", "is there", "any way", "any tips",
    "how does", "why does", "why is",
];
const SHARING_PHRASES: &[&str] = &[
    "providing help", "showing how", "giving tips", "offering tips",
    "tutorial on", "guide to", "guide for", "tips for",
    "tips on", "workflow for", "workflow with", "recipe for",
    "approach to", "method for", "technique for", "experience with",
    "comparison of", "review of", "demo of", "example of",
    "showcase of", "thoughts on", "feedback on", "results of",
    "successfully created", "successfully made", "just made",
    "just released", "just dropped", "just finished", "check out",
    "behind the", "deep dive", "breakdown of",
];

// Subject nouns that make a sharing verb → KnowledgeSharing (actionable, replicable)
const KNOWLEDGE_SUBJECTS: &[&str] = &[
    "tip", "tips", "trick", "tricks", "workflow", "workflows",
    "technique", "techniques", "tutorial", "tutorials",
    "guide", "guides", "method", "methods", "recipe", "recipes",
    "approach", "prompt", "prompts", "template", "templates",
    "preset", "presets", "setup", "configuration", "optimization",
    "workaround", "solution", "solutions", "process", "steps",
    "strategy", "strategies", "hack", "hacks", "instructions",
    "walkthrough", "explainer", "breakdown", "deepdive", "demo",
    "showcase", "hook", "hooks",
];

// Subject nouns that make a sharing verb → OpinionSharing (non-actionable)
const OPINION_SUBJECTS: &[&str] = &[
    "opinion", "opinions", "thought", "thoughts", "feedback",
    "impression", "impressions", "reaction", "reactions",
    "view", "views", "take", "perspective", "experience", "experiences",
    "feeling", "feelings", "observation", "observations",
    "critique", "criticism", "complaint", "complaints",
];

// Subject nouns that make a sharing verb → CreativeSharing (posting output, not teaching)
const CREATIVE_SUBJECTS: &[&str] = &[
    "music", "song", "songs", "track", "tracks", "album",
    "beat", "beats", "cover", "remix", "composition",
    "piece", "audio", "sound", "output", "creation", "creations",
    "generation", "result", "results", "attempt",
];

// Standalone nouns that imply knowledge-sharing even without a sharing verb
const KNOWLEDGE_NOUNS: &[&str] = &[
    "tutorial", "guide", "workflow", "recipe", "technique",
    "demo", "tip", "tips", "trick", "tricks", "hack", "hacks",
    "explainer", "walkthrough", "breakdown",
];

fn strip_punct(w: &str) -> &str {
    w.trim_end_matches(&[',', '.', ':', ';', '!', '?', ')', ']', '\''][..])
     .trim_start_matches(&['(', '[', '\''][..])
}

fn label_contains_any(label_words: &[&str], needles: &[&str]) -> bool {
    label_words.iter().any(|w| needles.contains(w))
}

fn label_contains_phrase(lower: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|p| lower.contains(p))
}

/// Sub-classify a detected sharing label by looking at what is being shared.
/// Priority: KnowledgeSharing > CreativeSharing > OpinionSharing > generic Sharing.
fn classify_sharing_type(words: &[&str]) -> TopicRole {
    if label_contains_any(words, KNOWLEDGE_SUBJECTS) { return TopicRole::KnowledgeSharing; }
    if label_contains_any(words, CREATIVE_SUBJECTS)  { return TopicRole::CreativeSharing; }
    if label_contains_any(words, OPINION_SUBJECTS)   { return TopicRole::OpinionSharing; }
    TopicRole::Sharing
}

/// Classify a GPT-generated topic label into a granular role.
///
/// Pipeline (in confidence order):
///   1. '?' anywhere → Asking
///   2. HELP_SEEKING_PHRASES (phrase check comes first so "seeking help with X"
///      → HelpSeeking even though "seeking" is in ASKING_VERBS)
///   3. First word is sharing verb → sub-classify by subject
///   4. First word is help-seeking verb → HelpSeeking
///   5. First word is curious-asking verb → Asking
///   6. SHARING_PHRASES phrase match → sub-classify
///   7. ASKING_PHRASES phrase match → Asking
///   8. Sharing verb anywhere → sub-classify by subject
///   9. Knowledge-indicator noun → KnowledgeSharing
///  10. Help-seeking verb anywhere → HelpSeeking
///  11. Asking verb anywhere → Asking
///  12. Neutral
fn classify_topic_role(label: &str) -> TopicRole {
    let lower = label.to_lowercase();

    if lower.contains('?') { return TopicRole::Asking; }

    // Phrase-level help-seeking check before any verb scan so that multi-word
    // patterns ("seeking help", "having trouble") are caught unambiguously.
    if label_contains_phrase(&lower, HELP_SEEKING_PHRASES) { return TopicRole::HelpSeeking; }

    let words_cleaned: Vec<&str> = lower.split_whitespace().map(strip_punct).collect();
    if words_cleaned.is_empty() { return TopicRole::Neutral; }

    let first = words_cleaned[0];

    // First-word sharing verb → look at the rest of the label for subject nuance
    if SHARING_VERBS.contains(&first) {
        return classify_sharing_type(&words_cleaned);
    }
    if HELP_SEEKING_VERBS.contains(&first) { return TopicRole::HelpSeeking; }
    if ASKING_VERBS.contains(&first) { return TopicRole::Asking; }

    if label_contains_phrase(&lower, SHARING_PHRASES) {
        return classify_sharing_type(&words_cleaned);
    }
    if label_contains_phrase(&lower, ASKING_PHRASES) { return TopicRole::Asking; }

    if label_contains_any(&words_cleaned, SHARING_VERBS) {
        return classify_sharing_type(&words_cleaned);
    }

    // Knowledge nouns alone (e.g. "Prompt Engineering Tutorial") → KnowledgeSharing
    if label_contains_any(&words_cleaned, KNOWLEDGE_NOUNS) {
        return TopicRole::KnowledgeSharing;
    }

    if label_contains_any(&words_cleaned, HELP_SEEKING_VERBS) { return TopicRole::HelpSeeking; }
    if label_contains_any(&words_cleaned, ASKING_VERBS) { return TopicRole::Asking; }

    TopicRole::Neutral
}

// ── Emotion sets (mirrors ai_service/main.py) ────────────────────────────────

const POSITIVE_EMOTIONS: &[&str] = &[
    "admiration", "amusement", "approval", "caring",
    "excitement", "gratitude", "joy", "love", "optimism",
    "pride", "relief",
];
const NEGATIVE_EMOTIONS: &[&str] = &[
    "anger", "annoyance", "disappointment", "disapproval",
    "disgust", "embarrassment", "fear", "grief",
    "nervousness", "remorse", "sadness",
];

// ── Derived features per user ────────────────────────────────────────────────

#[derive(Clone)]
struct DerivedFeatures {
    engagement_level: Tier,
    // ── Stage 2: Topic verb detection (granular sharing sub-types) ───────────
    help_seek_ratio: f64,  // help-seeking topics (troubleshooting, fixing, needing help)
    ask_ratio: f64,        // curious-asking topics (wondering, questioning, exploring)
    knowledge_ratio: f64,  // knowledge-sharing topics (tips, tutorials, workflows)
    opinion_ratio: f64,    // opinion-sharing topics (thoughts, reactions)
    creative_ratio: f64,   // creative-output topics (music posts, no teaching)
    share_ratio: f64,      // ALL sharing combined — used for secondary scoring
    // ── Stage 3: Activity stats ──────────────────────────────────────────────
    q_rate: f64,           // fraction of messages containing '?'
    code_url_rate: f64,    // fraction with code block or URL
    avg_words: f64,
    // ── Sentiment (secondary archetype) ─────────────────────────────────────
    pos_ratio: f64,
    neg_ratio: f64,
    sent_score: f64,
    norm_entropy: f64,
    has_pos_emo: bool,
    has_neg_emo: bool,
    has_curiosity_emo: bool, // "curiosity" in top emotions — neutral but signals active interest
    total_messages: i64,
    pct_weeks: f64,
    /// Percentile rank of this user's message count within the current batch (0–1).
    /// Used to gate Low-tier Contributor eligibility: a bursty user who posted
    /// a lot in 1–2 weeks has above-median volume (≥ 0.50) and can qualify;
    /// a genuinely thin-volume user (< 0.50) is blocked.
    msg_pct_rank: f64,
    /// Number of distinct KnowledgeSharing topic clusters for this user.
    /// Exception: Low-tier users with < 5 messages but ≥ 2 knowledge topics
    /// are still eligible for Contributor (knowledge-heavy, volume-light).
    n_knowledge_topics: usize,
    /// Number of distinct opinion + creative + generic sharing topic clusters.
    /// Explorer's opinion/creative signal is gated on ≥ 2 — a single sharing topic
    /// is too thin a signal to confidently award Explorer over Help-Seeker or residual.
    n_sharing_topics: usize,
}

fn clamp01(x: f64) -> f64 {
    if x < 0.0 { 0.0 } else if x > 1.0 { 1.0 } else { x }
}

fn percentile_rank_i64(sorted: &[i64], v: i64) -> f64 {
    let n = sorted.len();
    if n == 0 { return 0.5; }
    let below = sorted.partition_point(|&x| x < v);
    let upper = sorted.partition_point(|&x| x <= v);
    let eq = upper - below;
    (below as f64 + eq as f64 * 0.5) / n as f64
}

fn percentile_rank_f64(sorted: &[f64], v: f64) -> f64 {
    let n = sorted.len();
    if n == 0 { return 0.5; }
    let below = sorted.iter().filter(|&&x| x < v).count();
    let eq    = sorted.iter().filter(|&&x| (x - v).abs() < 1e-9).count();
    (below as f64 + eq as f64 * 0.5) / n as f64
}

// ── Scoring ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct ScoreEntry {
    name: &'static str,
    score: f64,
}

/// Engagement tier — the PRIMARY classifier.  Archetype is selected within tier.
#[derive(Copy, Clone, PartialEq, Debug)]
enum Tier { High, Mid, Low }


/// Map the frontend's precomputed engagement string to a `Tier`.
/// The frontend's `classifyEngagement` already applies window-aware absolute
/// thresholds (e.g. pct_weeks ≥ 50% AND total_messages ≥ 20·weeks/2 for high),
/// which is what we want for the primary tier decision.  Backend just passes
/// it through.
fn parse_engagement(s: &str) -> Tier {
    match s.to_ascii_lowercase().as_str() {
        "high"            => Tier::High,
        "medium" | "mid"  => Tier::Mid,
        _                 => Tier::Low,
    }
}

/// Tier boundaries (now delegated to frontend precompute):
///   High — frontend flagged as "high" engagement (pct_weeks ≥ 50% AND
///          enough absolute messages for the window).  Eligible for all
///          archetypes including Power Contributor.
///   Mid  — frontend flagged as "medium".  Eligible for Help-Seeker,
///          Evangelist, Scrutinizer, Casual Explorer; PC only via the soft
///          gate when sharing evidence is overwhelming.
///   Low  — frontend flagged as "low" (pct_weeks < 20).  Still classified
///          by stance/sentiment (Help-Seeker / Scrutinizer / Casual Explorer);
///          PC blocked.
fn engagement_tier(d: &DerivedFeatures) -> Tier { d.engagement_level }

/// Primary archetype scoring v8.
///
/// Three primary archetypes — topic distribution is the dominant signal in all cases:
///
///   • Contributor  — dominant knowledge-sharing topics, ≥ 2 distinct sharing clusters.
///                    Requires meaningful, repeating knowledge contribution (not a one-off).
///                    Low-tier users are eligible at 0.75× confidence when they have
///                    ≥ 2 knowledge topics or above-median message volume.
///
///   • Help-Seeker  — dominant help-seeking / asking topics.
///                    Curiosity emotion deflates the score so curious askers land
///                    as Explorer instead; frustration/negativity inflates it.
///
///   • Explorer     — dominant asking but without the strong knowledge-sharing signal
///                    that would qualify them as Contributor.  Curiosity emotion and
///                    topic diversity are the key differentiators from Help-Seeker.
///                    Opinion/creative sharing (≥ 2 sharing topic clusters) also qualifies.
fn compute_primary_scores(d: &DerivedFeatures, tier: Tier) -> Vec<ScoreEntry> {
    // ── Tier factor (Contributor eligibility gate) ───────────────────────────
    // High/Mid users get full score.
    // Low-tier: must pass one of two gates, both yield a 0.75 dampener:
    //   a) ≥2 distinct knowledge-sharing topics → knowledge-heavy, volume-light user
    //   b) above-median message count AND ≥5 messages → bursty low-engagement user
    let tier_factor = match tier {
        Tier::High | Tier::Mid => 1.0,
        Tier::Low => {
            if d.n_knowledge_topics >= 2 { 0.75 }
            else if d.msg_pct_rank >= 0.50 && d.total_messages >= 5 { 0.75 }
            else { 0.0 }
        }
    };

    // ── Topic role signals ───────────────────────────────────────────────────
    let knowledge_signal       = clamp01(d.knowledge_ratio / 0.25);
    let opinion_signal         = clamp01((d.opinion_ratio + d.creative_ratio) / 0.35);
    let help_seek_topic_signal = clamp01(d.help_seek_ratio / 0.35); // → Help-Seeker primary
    // broad_share: knowledge + generic sharing, excluding opinion/creative
    let broad_share  = (d.share_ratio - d.opinion_ratio - d.creative_ratio).max(0.0);
    let broad_signal = clamp01(broad_share / 0.30);

    // ── Lexical signals ──────────────────────────────────────────────────────
    let code_url_signal = clamp01(d.code_url_rate / 0.06);
    let avg_words_long  = clamp01((d.avg_words - 15.0) / 25.0).max(0.0);
    let avg_words_short = clamp01((15.0 - d.avg_words) / 10.0).max(0.0);
    let q_signal        = clamp01(d.q_rate / 0.25);

    // ── CONTRIBUTOR ──────────────────────────────────────────────────────────
    // Definition: dominant knowledge-sharing signal with at least 2 distinct
    // knowledge-sharing topic clusters.  A user who has meaningful content in only
    // one topic may be incidental; two or more clusters shows a genuine pattern.
    //
    // knowledge_gate:
    //   ≥2 clusters → full score (confirmed contributor)
    //   1 cluster   → 0.6× (possible contributor, single-topic)
    //   0 clusters  → 0.0 (no knowledge sharing → not a Contributor)
    //
    // hs_suppress_contrib: fades Contributor when help-seeking topics exceed
    //   knowledge sharing.  A user who predominantly asks for help isn't a
    //   Contributor regardless of writing quality.
    //   • help_seek > knowledge by 0.25 → score drops to 0 (fully not a contributor)
    //   • help_seek ≤ knowledge → no penalty
    let knowledge_gate = match d.n_knowledge_topics {
        0 => 0.0,
        1 => 0.6,
        _ => 1.0,
    };
    let hs_suppress_contrib = if d.help_seek_ratio > d.knowledge_ratio {
        let excess = d.help_seek_ratio - d.knowledge_ratio;
        (1.0 - clamp01(excess / 0.25)).max(0.0)
    } else { 1.0 };
    let contributor = {
        let topic_part   = (0.65 * knowledge_signal + 0.35 * broad_signal)
                           * (1.0 - 0.40 * opinion_signal.min(1.0));
        let lexical_part = 0.65 * code_url_signal + 0.35 * avg_words_long;
        let tier_boost   = if matches!(tier, Tier::High) { 0.08 } else { 0.0 };
        // Penalise for curious asking that outpaces knowledge sharing
        let ask_penalty  = if d.ask_ratio > d.knowledge_ratio + 0.15 {
            0.35 * clamp01((d.ask_ratio - d.knowledge_ratio) / 0.30)
        } else { 0.0 };
        let base = (0.58 * topic_part + 0.42 * lexical_part + tier_boost - ask_penalty).max(0.0);
        (base * tier_factor * knowledge_gate * hs_suppress_contrib).clamp(0.0, 1.0)
    };

    // ── HELP-SEEKER ──────────────────────────────────────────────────────────
    // Definition: dominant help-seeking TOPICS (troubleshooting, fixing, needing help).
    // Topics are the primary driver — emotion signals are SECONDARY.
    //
    // topic_dominates_hs: help-seeking topics both exceed the 0.25 threshold AND
    //   outweigh curious-asking topics.  When true, emotion cannot suppress the
    //   score to Explorer territory — a curious person who is primarily seeking
    //   help is still a Help-Seeker.
    //
    // topic_says_hs (weaker): help-seeking is strong but curious asking also competes.
    //   Curiosity can partially suppress (0.60×) but not redirect to Explorer.
    //
    // When topic evidence is absent/weak, emotion modifier applies:
    //   • Curiosity AND neg_ratio ≤ 0.30 → 0.30× (Explorer territory)
    //   • Curiosity AND neg_ratio > 0.30 → 0.50× (curious + frustrated)
    //   • No curiosity, negative signal   → 0.90×
    //   • Default (neutral)               → 0.65×
    let topic_dominates_hs = d.help_seek_ratio > 0.25 && d.help_seek_ratio >= d.ask_ratio;
    let topic_says_hs      = d.help_seek_ratio > 0.25;
    let help_modifier = if topic_dominates_hs {
        // Topic evidence unambiguous — curiosity can't redirect to Explorer
        0.90
    } else if topic_says_hs {
        // Strong HS but curious asking also competes — partial curiosity suppression
        if d.has_curiosity_emo && d.neg_ratio <= 0.20 { 0.60 } else { 0.90 }
    } else if d.has_curiosity_emo {
        // No dominant HS topic — curiosity wins and suppresses Help-Seeker strongly
        if d.neg_ratio > 0.30 { 0.50 } else { 0.30 }
    } else if d.has_neg_emo || d.neg_ratio > 0.28 {
        0.90   // frustrated/negative without curiosity → confirmed Help-Seeker
    } else {
        0.65   // neutral asker → moderate reduction
    };
    let help_seeker = {
        let raw = 0.55 * help_seek_topic_signal + 0.28 * q_signal + 0.17 * avg_words_short;
        (raw * help_modifier).clamp(0.0, 1.0)
    };

    // ── EXPLORER ─────────────────────────────────────────────────────────────
    // Definition: dominant curious-asking behaviour WITHOUT the strong knowledge-sharing
    // signal that would qualify them as Contributor.  The key differentiator
    // from Help-Seeker is curiosity emotion and topic diversity.
    //
    // curious_ask_signal: curiosity × ask_ratio, suppressed by two independent gates:
    //   • knowledge_suppress: fades when knowledge_ratio ≥ 0.35 (→ Contributor)
    //   • help_vs_ask_suppress: fades when help-seeking exceeds curious asking.
    //     If help_seek_ratio > ask_ratio, the dominant asking behaviour is help-
    //     seeking, not curious exploration — Explorer signal weakens proportionally.
    //
    // opinion_part: gated on ≥ 2 distinct sharing topic clusters.
    let curious_ask_signal = if d.ask_ratio > 0.10 {
        let knowledge_suppress = (1.0 - (d.knowledge_ratio / 0.35).min(1.0)).max(0.0);
        // Suppress Explorer when help-seeking asking outweighs curious asking
        let help_vs_ask_suppress = if d.help_seek_ratio > d.ask_ratio && d.help_seek_ratio > 0.15 {
            let excess = d.help_seek_ratio - d.ask_ratio;
            (1.0 - clamp01(excess / 0.25)).max(0.0)
        } else { 1.0 };
        let curious_factor = if d.has_curiosity_emo { 1.30 }
            else if d.has_neg_emo { 0.25 }
            else if d.sent_score >= 0.15 { 0.80 }
            else { 0.50 };
        clamp01((d.ask_ratio / 0.35) * curious_factor * knowledge_suppress * help_vs_ask_suppress)
    } else { 0.0 };

    // Low-tier boost only when the user has no meaningful knowledge sharing
    // (so as not to compete with the Contributor tier_factor for low-volume contributors).
    let low_tier_boost = if matches!(tier, Tier::Low) && d.knowledge_ratio < 0.15 { 0.20 } else { 0.0 };
    let explorer = {
        let opinion_part = if d.n_sharing_topics >= 2 { 0.25 * opinion_signal } else { 0.0 };
        let diversity    = 0.20 * d.norm_entropy;
        let residual     = 0.15 * (1.0 - contributor.max(help_seeker)).max(0.0);
        let tier_part    = low_tier_boost * (1.0 - 0.5 * opinion_signal.min(1.0));
        let curious_part = 0.25 * curious_ask_signal;
        (opinion_part + diversity + residual + tier_part + curious_part).clamp(0.0, 1.0)
    };

    vec![
        ScoreEntry { name: "Contributor", score: contributor },
        ScoreEntry { name: "Help-Seeker", score: help_seeker },
        ScoreEntry { name: "Explorer",    score: explorer },
    ]
}

/// Secondary archetype scoring v7.
///
/// Two secondary archetypes (or None):
///
///   • Evangelist  — positive emotions stand out against the neutral-dominant baseline,
///                   AND the user's topics indicate they are actively supporting or
///                   creating with Suno / AI music (creative sharing, knowledge sharing).
///                   Since most Discord sentiment is neutral, the threshold is intentionally
///                   lower than "strictly above-average positivity" — the emo_pos flag
///                   (positive emotions present in top-5) carries the most weight.
///
///   • Scrutinizer — negative messages outweigh positive (sent_score < 0, hard gate),
///                   with DOMINANT curiosity as the key signal: probing, questioning
///                   the platform from a skeptical / critical angle.
///                   Other negativity signals (neg_ratio, negative emotions, complaint
///                   topics) reinforce but do not replace the curiosity requirement.
fn compute_secondary_scores(d: &DerivedFeatures) -> Vec<ScoreEntry> {
    // ── EVANGELIST ───────────────────────────────────────────────────────────
    // Baseline reality: most Discord messages are classified neutral (50–80%).
    // We do NOT require strictly above-average pos_ratio; instead we look for:
    //   1. Positive emotions present (emo_pos) — the clearest "likes Suno" signal
    //   2. Modest positive tilt in sent_score / pos_ratio
    //   3. Active sharing of Suno/AI content: creative (posting music) or knowledge
    //      (tips, workflows) → these users are invested in the product
    //
    // Thresholds lowered vs v6: pos_ratio gate 0.58→0.35, sent_pos gate 0.35→0.10.
    let pos_signal    = clamp01((d.pos_ratio  - 0.35) / 0.40); // 0 at 35%, 1.0 at 75%
    let sent_pos      = clamp01((d.sent_score - 0.10) / 0.55); // 0 at 0.10, 1.0 at 0.65
    let emo_pos       = if d.has_pos_emo { 1.0 } else { 0.0 };
    // Suno-support topic signal: creative sharing (posting AI music) and knowledge
    // sharing (workflows, tips) both indicate the user is invested in Suno/AI music.
    let suno_signal   = clamp01(d.creative_ratio / 0.20 + d.knowledge_ratio / 0.30 * 0.4);

    let evangelist = (
        0.25 * pos_signal
      + 0.20 * sent_pos
      + 0.30 * emo_pos       // dominant signal — positivity present at all is meaningful
      + 0.25 * suno_signal   // actively creating / sharing Suno content
    ).clamp(0.0, 1.0);

    // ── SCRUTINIZER ──────────────────────────────────────────────────────────
    // Hard gate: negative messages must outweigh positive (sent_score < 0).
    // The DOMINANT signal is curious_probe: a user who actively questions and
    // probes the platform (high ask_ratio + curiosity emotion) while holding a
    // net-negative stance is a Scrutinizer — not just someone who complains.
    // Other negativity signals reinforce but are secondary to the curiosity dimension.
    let scrutinizer = if d.sent_score >= 0.0 {
        0.0  // net-positive or exactly neutral overall → never Scrutinizer
    } else {
        let neg_signal    = clamp01((d.neg_ratio - 0.15) / 0.40);  // 0 at 15%, 1 at 55%
        let sent_neg      = clamp01((-d.sent_score) / 0.40);        // 0 at 0, 1 at -0.40
        let emo_neg       = if d.has_neg_emo { 1.0 } else { 0.0 };
        let opinion_reinf = clamp01(d.opinion_ratio / 0.35);        // complaint/feedback topics
        // Dominant Scrutinizer signal: curiosity + questioning + negative overall stance.
        // 1.5× boost when clearly net-negative (sent_score < -0.05) vs just marginally so.
        let curious_probe = if d.has_curiosity_emo && d.ask_ratio > 0.10 {
            let boost = if d.sent_score < -0.05 { 1.5 } else { 1.0 };
            clamp01(d.ask_ratio / 0.30 * boost)
        } else { 0.0 };

        (
            0.20 * neg_signal     // negativity level above baseline
          + 0.15 * sent_neg       // magnitude of net-negative stance
          + 0.10 * emo_neg        // negative emotions present
          + 0.15 * opinion_reinf  // scrutinizing / complaint topics
          + 0.40 * curious_probe  // THE dominant signal: curious + probing + net-negative
        ).clamp(0.0, 1.0)
    };

    vec![
        ScoreEntry { name: "Evangelist",  score: evangelist },
        ScoreEntry { name: "Scrutinizer", score: scrutinizer },
    ]
}

struct ArchetypeOutcome {
    primary: String,
    confidence: f64,
    secondary: Option<String>,
    secondary_confidence: Option<f64>,
    reasoning: String,
    scores: HashMap<String, f64>,
}

fn assign_archetype(d: &DerivedFeatures) -> ArchetypeOutcome {
    let tier = engagement_tier(d);

    // ── Primary: pick highest-scoring among 3 archetypes ─────────────────────
    let mut primary = compute_primary_scores(d, tier);
    primary.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let p1 = &primary[0];

    // ── Secondary: Evangelist (≥ 0.25) or Scrutinizer (≥ 0.30) ─────────────
    // Scrutinizer has a higher bar because it's easy to over-fire on question-heavy users.
    let mut secondary = compute_secondary_scores(d);
    secondary.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let s1 = &secondary[0];
    // Both secondary archetypes now share a 0.25 threshold.  Scrutinizer was
    // previously at 0.30 to avoid over-firing on question-heavy users, but the
    // frustration_factor change in compute_primary_scores (curiosity → 0.30)
    // already redirects curious askers to Explorer, so the higher gate is no
    // longer needed as a safety net here.
    let sec_threshold = 0.25;
    let sec = if s1.score >= sec_threshold { Some((s1.name.to_string(), s1.score)) } else { None };

    let reasoning = build_reasoning(d, tier, p1, sec.as_ref(), &primary, &secondary);

    let mut all_scores: HashMap<String, f64> = HashMap::new();
    for e in &primary   { all_scores.insert(e.name.to_string(), round3(e.score)); }
    for e in &secondary { all_scores.insert(e.name.to_string(), round3(e.score)); }

    ArchetypeOutcome {
        primary:              p1.name.to_string(),
        confidence:           round3(p1.score),
        secondary:            sec.as_ref().map(|(n, _)| n.clone()),
        secondary_confidence: sec.as_ref().map(|(_, s)| round3(*s)),
        reasoning,
        scores:               all_scores,
    }
}

fn round3(x: f64) -> f64 { (x * 1000.0).round() / 1000.0 }

fn build_reasoning(
    d: &DerivedFeatures,
    tier: Tier,
    top: &ScoreEntry,
    sec: Option<&(String, f64)>,
    primary: &[ScoreEntry],
    secondary: &[ScoreEntry],
) -> String {
    let tier_str = match tier {
        Tier::High => "high", Tier::Mid => "medium", Tier::Low => "low",
    };
    let mut parts: Vec<String> = Vec::new();

    // Engagement tier
    let low_contributor_note = if matches!(tier, Tier::Low) && top.name == "Contributor" {
        if d.n_knowledge_topics >= 2 {
            " — qualified via ≥2 technical knowledge topics (bypasses volume gate); contributor confidence dampened to 75%"
        } else if d.msg_pct_rank >= 0.50 && d.total_messages >= 5 {
            " — bursty low-engagement user with above-median message volume; contributor confidence dampened to 75%"
        } else {
            " — message volume below median; Contributor blocked despite sharing topics"
        }
    } else { "" };
    parts.push(format!("Engagement: {} ({}% weeks active, {} msgs, volume rank {:.0}th pct){} .",
        tier_str, d.pct_weeks as i64, d.total_messages,
        d.msg_pct_rank * 100.0, low_contributor_note,
    ));

    // Stage 2: topic verb evidence
    if d.help_seek_ratio > 0.05 || d.knowledge_ratio > 0.05 || d.opinion_ratio > 0.05
        || d.creative_ratio > 0.05 || d.ask_ratio > 0.05 {
        parts.push(format!(
            "Topic roles: knowledge-sharing {:.0}%, opinion/creative {:.0}%, help-seeking {:.0}%, asking {:.0}%.",
            d.knowledge_ratio * 100.0,
            (d.opinion_ratio + d.creative_ratio) * 100.0,
            d.help_seek_ratio * 100.0,
            d.ask_ratio * 100.0,
        ));
    } else {
        parts.push("No BERTopic data available; relying on lexical signals.".to_string());
    }

    // Stage 3: activity stats
    parts.push(format!(
        "Activity stats: avg {:.0} words/msg, {:.0}% msgs with '?', {:.0}% with code/URL.",
        d.avg_words, d.q_rate * 100.0, d.code_url_rate * 100.0,
    ));

    // Primary outcome
    let all_scores_str: String = primary.iter()
        .map(|e| format!("{} {:.3}", e.name, e.score))
        .collect::<Vec<_>>()
        .join(" | ");
    parts.push(format!("Primary scores: [{}].", all_scores_str));

    // Diagnostic: help_modifier + key intermediate signals
    let topic_dominates_hs = d.help_seek_ratio > 0.25 && d.help_seek_ratio >= d.ask_ratio;
    let topic_says_hs      = d.help_seek_ratio > 0.25;
    let hs_suppress_c      = if d.help_seek_ratio > d.knowledge_ratio {
        (1.0 - clamp01((d.help_seek_ratio - d.knowledge_ratio) / 0.25)).max(0.0)
    } else { 1.0 };
    let hm = if topic_dominates_hs { 0.90 }
    else if topic_says_hs {
        if d.has_curiosity_emo && d.neg_ratio <= 0.20 { 0.60 } else { 0.90 }
    } else if d.has_curiosity_emo {
        if d.neg_ratio > 0.30 { 0.50 } else { 0.30 }
    } else if d.has_neg_emo || d.neg_ratio > 0.28 { 0.90 }
    else { 0.65 };
    parts.push(format!(
        "Diag: help_modifier={:.2} topic_dom_hs={} topic_says_hs={} help_seek={:.0}% ask={:.0}% hs_suppress_contrib={:.2} emo=[curiosity:{} neg:{} pos:{}] n_knowledge_topics={} n_sharing_topics={}.",
        hm, topic_dominates_hs, topic_says_hs,
        d.help_seek_ratio * 100.0, d.ask_ratio * 100.0,
        hs_suppress_c,
        d.has_curiosity_emo, d.has_neg_emo, d.has_pos_emo,
        d.n_knowledge_topics, d.n_sharing_topics,
    ));

    // Sentiment evidence (drives secondary scoring)
    parts.push(format!(
        "Sentiment: {:.0}% positive, {:.0}% negative, net score {:.2} (pos−neg).{}{}{}",
        d.pos_ratio * 100.0, d.neg_ratio * 100.0, d.sent_score,
        if d.has_pos_emo { " [+emo]" } else { "" },
        if d.has_neg_emo { " [−emo]" } else { "" },
        if d.has_curiosity_emo { " [curiosity]" } else { "" },
    ));

    // Secondary outcome
    if let Some((sec_name, sec_score)) = sec {
        parts.push(format!("Secondary: {} (score {:.2}).", sec_name, sec_score));
    } else {
        let best_sec = secondary.iter().max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(s) = best_sec {
            parts.push(format!("Secondary: None (best was {} at {:.2}, below threshold 0.25).", s.name, s.score));
        }
    }

    parts.join(" ")
}

// ── DB save ──────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn save_one(
    pool: &sqlx::PgPool,
    username: &str,
    phase: &str,
    phase_label: &str,
    outcome: &ArchetypeOutcome,
    features_json: &Value,
) -> Result<()> {
    let scores_json = serde_json::to_value(&outcome.scores).unwrap_or(json!({}));
    sqlx::query(
        "INSERT INTO persona_classifications
             (username, phase, phase_label, method, persona, confidence, reasoning,
              features, secondary_persona, secondary_confidence, scores, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (username, phase, method)
         DO UPDATE SET persona              = EXCLUDED.persona,
                       confidence           = EXCLUDED.confidence,
                       reasoning            = EXCLUDED.reasoning,
                       features             = EXCLUDED.features,
                       secondary_persona    = EXCLUDED.secondary_persona,
                       secondary_confidence = EXCLUDED.secondary_confidence,
                       scores               = EXCLUDED.scores,
                       updated_at           = NOW()",
    )
    .bind(username)
    .bind(phase)
    .bind(phase_label)
    .bind(METHOD_NAME)
    .bind(&outcome.primary)
    .bind(outcome.confidence as f32)
    .bind(&outcome.reasoning)
    .bind(features_json)
    .bind(outcome.secondary.as_deref())
    .bind(outcome.secondary_confidence.map(|x| x as f32))
    .bind(&scores_json)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Batch fetch helpers (one query each, no N+1) ─────────────────────────────

/// Aggregated sentiment per user for the given window
struct SentimentAgg {
    pos: i64,
    neg: i64,
    neu: i64,
    top_emotions: Vec<String>,
    /// Count of messages where "curiosity" appears anywhere in their top_emotions JSON.
    /// Used as a fallback: if curiosity doesn't make the aggregated top-5 ranking but
    /// still appeared in ≥ 8% of the user's messages, we still flag has_curiosity_emo.
    curiosity_count: i64,
    /// Total messages with emotion data (rows from the JOIN).
    total_emo_msgs: i64,
}

async fn fetch_sentiment_for_users(
    pool: &sqlx::PgPool,
    usernames: &[String],
    date_from: &str,
    date_to: &str,
    upload_ids: &str,
) -> Result<HashMap<String, SentimentAgg>> {
    if usernames.is_empty() {
        return Ok(HashMap::new());
    }

    // Build positional args (matches stored_sentiment pattern)
    let mut args: Vec<String> = usernames.to_vec();
    let un_placeholders: String = (1..=usernames.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");

    let mut filters = String::new();
    if !date_from.is_empty() {
        filters.push_str(&format!(" AND m.date >= ${}", args.len() + 1));
        args.push(date_from.to_string());
    }
    if !date_to.is_empty() {
        filters.push_str(&format!(" AND m.date <= ${}", args.len() + 1));
        args.push(date_to.to_string());
    }
    if !upload_ids.is_empty() {
        let ids: Vec<&str> = upload_ids.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !ids.is_empty() {
            let phs: Vec<String> = ids.iter().enumerate()
                .map(|(i, _)| format!("${}", args.len() + i + 1))
                .collect();
            filters.push_str(&format!(" AND m.upload_id IN ({})", phs.join(", ")));
            args.extend(ids.iter().map(|s| s.to_string()));
        }
    }

    let sql = format!(
        "SELECT m.username, me.sentiment, me.top_emotions \
         FROM messages m \
         JOIN message_emotions me ON m.msg_uuid = me.msg_uuid \
         WHERE m.username IN ({un}) AND m.msg_uuid IS NOT NULL{filters}",
        un = un_placeholders,
        filters = filters,
    );

    let mut q = sqlx::query(&sql);
    for a in &args { q = q.bind(a.clone()); }
    let rows = q.fetch_all(pool).await?;

    let mut out: HashMap<String, SentimentAgg> = HashMap::new();
    // emotion label → (sum_score, count) per user
    let mut emo_acc: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();

    for row in &rows {
        let username: String = row.get("username");
        let sentiment: String = row.get("sentiment");
        let top_emotions: Value = row.try_get("top_emotions").unwrap_or(json!([]));

        let e = out.entry(username.clone()).or_insert(SentimentAgg {
            pos: 0, neg: 0, neu: 0, top_emotions: Vec::new(),
            curiosity_count: 0, total_emo_msgs: 0,
        });
        match sentiment.as_str() {
            "positive" => e.pos += 1,
            "negative" => e.neg += 1,
            _ => e.neu += 1,
        }
        e.total_emo_msgs += 1;

        if let Some(arr) = top_emotions.as_array() {
            // Per-message curiosity check (before username is moved into emo_acc)
            if arr.iter().any(|em| em["label"].as_str() == Some("curiosity")) {
                e.curiosity_count += 1;
            }
            let label_map = emo_acc.entry(username).or_default();
            for em in arr {
                if let (Some(label), Some(score)) = (em["label"].as_str(), em["score"].as_f64()) {
                    let acc = label_map.entry(label.to_string()).or_insert((0.0, 0));
                    acc.0 += score;
                    acc.1 += 1;
                }
            }
        }
    }

    // Finalize: pick top 5 emotions per user by TOTAL accumulated score (sum, not average).
    // Ranking by average unfairly elevates rare-but-high-confidence emotions (e.g. "love"
    // appearing 4 times at 0.76) over frequent-but-moderate ones (e.g. "curiosity" appearing
    // 38 times at 0.54 avg = 20.5 total weight).  Sum naturally reflects how much that emotion
    // characterises the user across all their messages.
    for (username, label_map) in emo_acc {
        let mut ranked: Vec<(String, f64)> = label_map.into_iter()
            .map(|(l, (sum, _cnt))| (l, sum))   // use sum, not sum/cnt
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(agg) = out.get_mut(&username) {
            agg.top_emotions = ranked.into_iter().take(5).map(|(l, _)| l).collect();
        }
    }

    Ok(out)
}

/// Per-user lexical signals computed directly from raw messages.
/// Orthogonal to BERTopic-derived signals — used to fix the case where the
/// per-user topic clusters get misleading role-verb labels (e.g. an answerer's
/// "voice generation prompts" cluster gets labeled "Requesting prompts…").
struct LexicalStats {
    q_rate: f64,         // fraction with '?'
    code_url_rate: f64,  // fraction with ``` or http(s)://
}

async fn fetch_lexical_stats(
    pool: &sqlx::PgPool,
    usernames: &[String],
    date_from: &str,
    date_to: &str,
    upload_ids: &str,
) -> Result<HashMap<String, LexicalStats>> {
    if usernames.is_empty() {
        return Ok(HashMap::new());
    }

    let mut args: Vec<String> = usernames.to_vec();
    let un_placeholders: String = (1..=usernames.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");

    let mut filters = String::new();
    if !date_from.is_empty() {
        filters.push_str(&format!(" AND date >= ${}", args.len() + 1));
        args.push(date_from.to_string());
    }
    if !date_to.is_empty() {
        filters.push_str(&format!(" AND date <= ${}", args.len() + 1));
        args.push(date_to.to_string());
    }
    if !upload_ids.is_empty() {
        let ids: Vec<&str> = upload_ids.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !ids.is_empty() {
            let phs: Vec<String> = ids.iter().enumerate()
                .map(|(i, _)| format!("${}", args.len() + i + 1))
                .collect();
            filters.push_str(&format!(" AND upload_id IN ({})", phs.join(", ")));
            args.extend(ids.iter().map(|s| s.to_string()));
        }
    }

    // Single aggregated query — PostgreSQL FILTER avoids per-row Rust scanning.
    let sql = format!(
        "SELECT username,
            COUNT(*)                                                                   AS total_msgs,
            COUNT(*) FILTER (WHERE position('?' IN content) > 0)                       AS q_msgs,
            COUNT(*) FILTER (WHERE position('```' IN content) > 0
                              OR position('http://' IN content) > 0
                              OR position('https://' IN content) > 0)                  AS share_msgs
         FROM messages
         WHERE username IN ({un}){filters}
         GROUP BY username",
        un = un_placeholders, filters = filters,
    );

    let mut q = sqlx::query(&sql);
    for a in &args { q = q.bind(a.clone()); }
    let rows = q.fetch_all(pool).await?;

    let mut out = HashMap::new();
    for row in &rows {
        let username:    String = row.get("username");
        let total: i64 = row.get("total_msgs");
        let q_msgs: i64 = row.get("q_msgs");
        let share_msgs: i64 = row.get("share_msgs");
        let denom = total.max(1) as f64;
        out.insert(username, LexicalStats {
            q_rate:        q_msgs as f64 / denom,
            code_url_rate: share_msgs as f64 / denom,
        });
    }
    Ok(out)
}

/// Return the subset of `usernames` that are flagged as Suno team members.
/// Membership is stored as a row-level flag (`is_suno_team` TEXT) on the
/// `messages` table — a user is "on the team" if any of their messages carry it.
async fn fetch_suno_team_set(
    pool: &sqlx::PgPool,
    usernames: &[String],
) -> Result<HashSet<String>> {
    if usernames.is_empty() {
        return Ok(HashSet::new());
    }
    let rows = sqlx::query(
        "SELECT DISTINCT username FROM messages
         WHERE username = ANY($1) AND LOWER(is_suno_team) IN ('true', '1')",
    )
    .bind(usernames)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.get::<String, _>("username")).collect())
}

/// Aggregated topic role distribution per user — granular sharing sub-types.
#[derive(Clone)]
struct TopicAgg {
    help_seeking_msgs: i64,   // HelpSeeking (troubleshooting, fixing, needing help)
    asking_msgs: i64,         // Asking (curious/exploratory)
    knowledge_msgs: i64,      // KnowledgeSharing (tips, tutorials, workflows)
    opinion_msgs: i64,        // OpinionSharing (thoughts, reactions, feedback)
    creative_msgs: i64,       // CreativeSharing (posting music/output)
    generic_share_msgs: i64,  // Sharing (verb matched, no subject match)
    n_knowledge_topics: usize,// count of distinct KnowledgeSharing topic clusters
    n_sharing_topics: usize,  // count of distinct opinion + creative + generic sharing clusters
    topic_msg_counts: Vec<i64>,
    n_topics: usize,
    labels: Vec<String>,
}

/// Resolved topic evidence for one user, after applying the same "exact window,
/// else best-coverage fallback" strategy that /topics/user/:username and
/// /topics/batch-get already use (see topics.rs) — documented there as: "so
/// opening a user detail with a different active filter still shows previously
/// saved results rather than silently returning null". Without this fallback,
/// archetype scoring here regressed to "Uncategorized" for entire batches any
/// time the caller's date window didn't match user_topic_runs byte-for-byte —
/// e.g. an open-ended phase whose upper bound gets resolved differently by
/// different callers, or a window computed before topics were last (re)run.
struct ResolvedTopics {
    agg: Option<TopicAgg>,
    is_warned: bool,
    has_any_run: bool,
}

async fn fetch_topics_for_users(
    pool: &sqlx::PgPool,
    usernames: &[String],
    date_from: &str,
    date_to: &str,
    upload_ids: &str,
) -> Result<HashMap<String, ResolvedTopics>> {
    if usernames.is_empty() {
        return Ok(HashMap::new());
    }

    struct RunRef { id: i64, warning: Option<String> }

    // 1. Exact match on the requested window.
    let exact_rows = sqlx::query(
        "SELECT username, id, warning FROM user_topic_runs
         WHERE username = ANY($1) AND date_from = $2 AND date_to = $3 AND upload_ids = $4",
    )
    .bind(usernames)
    .bind(date_from)
    .bind(date_to)
    .bind(upload_ids)
    .fetch_all(pool)
    .await?;

    let mut run_by_user: HashMap<String, RunRef> = HashMap::new();
    for r in &exact_rows {
        let username: String = r.get("username");
        run_by_user.insert(username, RunRef { id: r.get("id"), warning: r.try_get("warning").ok().flatten() });
    }

    // 2. Fallback: best-coverage run (any window / upload scope) for usernames
    //    without an exact match.
    let missing: Vec<String> = usernames.iter()
        .filter(|u| !run_by_user.contains_key(*u))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let fallback_rows = sqlx::query(
            "SELECT DISTINCT ON (username) username, id, warning
             FROM user_topic_runs
             WHERE username = ANY($1)
             ORDER BY username, filtered_docs DESC, id DESC",
        )
        .bind(&missing)
        .fetch_all(pool)
        .await?;
        for r in &fallback_rows {
            let username: String = r.get("username");
            run_by_user.insert(username, RunRef { id: r.get("id"), warning: r.try_get("warning").ok().flatten() });
        }
    }

    // 3. Pull topic items for exactly the resolved run ids.
    let run_ids: Vec<i64> = run_by_user.values().map(|r| r.id).collect();
    let mut aggs: HashMap<String, TopicAgg> = HashMap::new();
    if !run_ids.is_empty() {
        let item_rows = sqlx::query(
            "SELECT r.username, i.label, i.message_count, i.topic_id
             FROM user_topic_runs r
             JOIN user_topic_items i ON i.run_id = r.id
             WHERE r.id = ANY($1) AND i.topic_id != -1",
        )
        .bind(&run_ids)
        .fetch_all(pool)
        .await?;

        for row in &item_rows {
            let username: String = row.get("username");
            let label: String    = row.get("label");
            let msg_count: i32   = row.get("message_count");
            let role = classify_topic_role(&label);

            let agg = aggs.entry(username).or_insert(TopicAgg {
                help_seeking_msgs: 0, asking_msgs: 0, knowledge_msgs: 0, opinion_msgs: 0,
                creative_msgs: 0, generic_share_msgs: 0,
                n_knowledge_topics: 0, n_sharing_topics: 0,
                topic_msg_counts: Vec::new(), n_topics: 0,
                labels: Vec::new(),
            });
            agg.n_topics += 1;
            agg.topic_msg_counts.push(msg_count as i64);
            agg.labels.push(label.clone());
            match role {
                TopicRole::HelpSeeking     => agg.help_seeking_msgs  += msg_count as i64,
                TopicRole::Asking          => agg.asking_msgs        += msg_count as i64,
                TopicRole::KnowledgeSharing=> {
                    agg.knowledge_msgs     += msg_count as i64;
                    agg.n_knowledge_topics += 1;
                }
                TopicRole::OpinionSharing  => {
                    agg.opinion_msgs       += msg_count as i64;
                    agg.n_sharing_topics   += 1;
                }
                TopicRole::CreativeSharing => {
                    agg.creative_msgs      += msg_count as i64;
                    agg.n_sharing_topics   += 1;
                }
                TopicRole::Sharing         => {
                    agg.generic_share_msgs += msg_count as i64;
                    agg.n_sharing_topics   += 1;
                }
                TopicRole::Neutral         => {}
            }
        }
    }

    Ok(usernames.iter().map(|u| {
        let resolved = match run_by_user.get(u) {
            Some(r) => ResolvedTopics {
                agg: aggs.get(u).cloned(),
                is_warned: r.warning.is_some(),
                has_any_run: true,
            },
            None => ResolvedTopics { agg: None, is_warned: false, has_any_run: false },
        };
        (u.clone(), resolved)
    }).collect())
}

// ── Handler: POST /persona/compute-batch ─────────────────────────────────────

pub async fn compute_batch(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<ComputeBatchRequest>,
) -> Result<Json<Value>> {
    if req.users.is_empty() {
        return Ok(Json(json!({ "results": [], "count": 0 })));
    }

    let usernames: Vec<String> = req.users.iter().map(|u| u.username.clone()).collect();
    let date_from  = req.date_from.as_deref().unwrap_or("");
    let date_to    = req.date_to.as_deref().unwrap_or("");
    let upload_ids = req.upload_ids.as_deref().unwrap_or("");

    // Pull sentiment + topics + suno-team membership + lexical stats in parallel
    let (sentiments, topics, suno_team, lexical) = tokio::try_join!(
        fetch_sentiment_for_users(&state.db, &usernames, date_from, date_to, upload_ids),
        fetch_topics_for_users(&state.db, &usernames, date_from, date_to, upload_ids),
        fetch_suno_team_set(&state.db, &usernames),
        fetch_lexical_stats(&state.db, &usernames, date_from, date_to, upload_ids),
    )?;

    // Build sorted feature vectors for percentile-rank computation
    let mut msg_counts_sorted: Vec<i64> = req.users.iter().map(|u| u.total_messages).collect();
    msg_counts_sorted.sort();
    let mut pct_weeks_sorted: Vec<f64> = req.users.iter().map(|u| u.pct_weeks).collect();
    pct_weeks_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut weeks_active_sorted: Vec<i64> = req.users.iter().map(|u| u.weeks_active).collect();
    weeks_active_sorted.sort();

    let mut results: Vec<Value> = Vec::with_capacity(req.users.len());

    for u in &req.users {
        // Short-circuit: Suno team members are not "users" in the user-archetype
        // sense — they're insiders/staff.  Skip scoring and label them directly.
        if suno_team.contains(&u.username) {
            let outcome = ArchetypeOutcome {
                primary: "Suno Team".into(),
                confidence: 1.0,
                secondary: None,
                secondary_confidence: None,
                reasoning: "User is flagged as a Suno team member; archetype scoring skipped.".into(),
                scores: HashMap::from([("Suno Team".to_string(), 1.0)]),
            };
            let features_json = json!({
                "msg_count":    u.total_messages,
                "weeks_active": u.weeks_active,
                "pct_weeks":    u.pct_weeks,
                "avg_words":    u.avg_words,
                "suno_team":    true,
            });
            if let Err(e) = save_one(&state.db, &u.username, &req.phase, &req.phase_label,
                                     &outcome, &features_json).await
            {
                tracing::warn!("Persona save failed for {}: {}", u.username, e);
            }
            results.push(json!({
                "username":             u.username,
                "persona":              outcome.primary,
                "confidence":           outcome.confidence,
                "secondary_persona":    outcome.secondary,
                "secondary_confidence": outcome.secondary_confidence,
                "reasoning":            outcome.reasoning,
                "scores":               outcome.scores,
            }));
            continue;
        }

        // Short-circuit: no reliable BERTopic topic-role signals → Uncategorized.
        //
        // Three cases:
        //   1. BERTopic exception → fallback with warning; fallback topic has
        //      topic_id = 0 (not filtered by the != -1 query) but its label is
        //      keyword-only and must not drive archetype scoring.
        //   2. No meaningful content (0 docs after filtering) → topics: [] + warning.
        //      topics map has no entry for this user.
        //   3. No topic run at all in this window.
        let resolved = topics.get(&u.username);
        let is_warned = resolved.map(|r| r.is_warned).unwrap_or(false);
        let has_topic_run = resolved.map(|r| r.has_any_run).unwrap_or(false);
        if resolved.and_then(|r| r.agg.as_ref()).is_none() || is_warned {
            let reason = if is_warned {
                "BERTopic clustering failed for this user; keyword-only fallback topics \
                 are not reliable enough to determine archetype."
                    .to_string()
            } else if has_topic_run {
                "BERTopic analysis produced no meaningful topic clusters for this user \
                 (all messages were outliers or content was too short)."
                    .to_string()
            } else {
                "No BERTopic topic analysis found for this user in the given window; \
                 run topic analysis first before computing archetypes."
                    .to_string()
            };
            let outcome = ArchetypeOutcome {
                primary:              "Uncategorized".into(),
                confidence:           1.0,
                secondary:            None,
                secondary_confidence: None,
                reasoning:            reason,
                scores:               HashMap::from([("Uncategorized".to_string(), 1.0)]),
            };
            let features_json = json!({
                "msg_count":        u.total_messages,
                "weeks_active":     u.weeks_active,
                "pct_weeks":        u.pct_weeks,
                "avg_words":        u.avg_words,
                "has_topic_run":    has_topic_run,
                "bertopic_failed":  is_warned,
                "uncategorized":    true,
            });
            if let Err(e) = save_one(&state.db, &u.username, &req.phase, &req.phase_label,
                                     &outcome, &features_json).await
            {
                tracing::warn!("Persona save failed for {}: {}", u.username, e);
            }
            results.push(json!({
                "username":             u.username,
                "persona":              outcome.primary,
                "confidence":           outcome.confidence,
                "secondary_persona":    outcome.secondary,
                "secondary_confidence": outcome.secondary_confidence,
                "reasoning":            outcome.reasoning,
                "scores":               outcome.scores,
            }));
            continue;
        }

        let sent  = sentiments.get(&u.username);
        let topic = topics.get(&u.username).and_then(|r| r.agg.as_ref());

        let (pos, neg, neu) = sent.map(|s| (s.pos, s.neg, s.neu)).unwrap_or((0, 0, 0));
        let total_sent = (pos + neg + neu).max(1);
        let pos_ratio = pos as f64 / total_sent as f64;
        let neg_ratio = neg as f64 / total_sent as f64;
        let sent_score = pos_ratio - neg_ratio;

        let empty_emo: Vec<String> = Vec::new();
        let top_emo = sent.map(|s| &s.top_emotions).unwrap_or(&empty_emo);
        let emo_set: HashSet<&str> = top_emo.iter().map(|s| s.as_str()).collect();
        let has_pos_emo = POSITIVE_EMOTIONS.iter().any(|e| emo_set.contains(*e));
        let has_neg_emo = NEGATIVE_EMOTIONS.iter().any(|e| emo_set.contains(*e));
        // Primary: curiosity is in the aggregated top-5 (by total sum score).
        // Fallback: curiosity appeared in ≥ 8% of this user's messages with emotion data —
        // catches users where curiosity is moderate-but-frequent yet loses the top-5 ranking
        // to a handful of other non-neutral emotions.
        let has_curiosity_emo = emo_set.contains("curiosity")
            || sent.map(|s| {
                s.total_emo_msgs > 0
                    && s.curiosity_count as f64 / s.total_emo_msgs as f64 >= 0.08
            }).unwrap_or(false);

        let (help_seeking, asking, knowledge, opinion, creative, share_all, n_topics, entropy) = match topic {
            Some(t) => {
                let all_msgs = t.help_seeking_msgs + t.asking_msgs + t.knowledge_msgs
                             + t.opinion_msgs + t.creative_msgs + t.generic_share_msgs;
                let denom = all_msgs.max(1) as f64;

                let topic_total: i64 = t.topic_msg_counts.iter().sum();
                let ent = if topic_total > 0 && t.n_topics > 1 {
                    let mut e = 0.0_f64;
                    for &c in &t.topic_msg_counts {
                        if c > 0 {
                            let p = c as f64 / topic_total as f64;
                            e -= p * p.ln();
                        }
                    }
                    let max_ent = (t.n_topics as f64).ln().max(1e-9);
                    (e / max_ent).clamp(0.0, 1.0)
                } else { 0.0 };

                if all_msgs == 0 {
                    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, t.n_topics, ent)
                } else {
                    let share_all = (t.knowledge_msgs + t.opinion_msgs + t.creative_msgs + t.generic_share_msgs) as f64 / denom;
                    (
                        t.help_seeking_msgs as f64 / denom,
                        t.asking_msgs       as f64 / denom,
                        t.knowledge_msgs    as f64 / denom,
                        t.opinion_msgs      as f64 / denom,
                        t.creative_msgs     as f64 / denom,
                        share_all,
                        t.n_topics, ent,
                    )
                }
            }
            None => (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0),
        };

        // Engagement intensity = weighted blend of percentile ranks
        let r_msg   = percentile_rank_i64(&msg_counts_sorted, u.total_messages);
        let r_pct   = percentile_rank_f64(&pct_weeks_sorted, u.pct_weeks);
        let r_weeks = percentile_rank_i64(&weeks_active_sorted, u.weeks_active);
        let eng_intensity = (0.5 * r_msg + 0.3 * r_pct + 0.2 * r_weeks).clamp(0.0, 1.0);

        // Per-message lexical signals (orthogonal channel) + volume rank for AHS gate
        let lex = lexical.get(&u.username);
        let q_rate        = lex.map(|l| l.q_rate).unwrap_or(0.0);
        let code_url_rate = lex.map(|l| l.code_url_rate).unwrap_or(0.0);

        // Tier comes from the frontend's precomputed engagement label.
        // Falls back to derived eng_intensity only if the caller omitted it.
        let engagement_level = match u.engagement.as_deref() {
            Some(s) => parse_engagement(s),
            None => {
                // Conservative fallback: only High if eng_intensity is very strong AND
                // absolute volume is real (≥30 msgs, ≥3 weeks).
                if eng_intensity >= 0.55 && u.total_messages >= 30 && u.weeks_active >= 3 {
                    Tier::High
                } else if eng_intensity >= 0.20 && u.total_messages >= 15 {
                    Tier::Mid
                } else {
                    Tier::Low
                }
            }
        };

        let d = DerivedFeatures {
            engagement_level,
            help_seek_ratio: help_seeking,
            ask_ratio: asking,
            knowledge_ratio: knowledge,
            opinion_ratio: opinion,
            creative_ratio: creative,
            share_ratio: share_all,
            pos_ratio,
            neg_ratio,
            sent_score,
            norm_entropy: entropy,
            has_pos_emo,
            has_neg_emo,
            has_curiosity_emo,
            total_messages: u.total_messages,
            pct_weeks: u.pct_weeks,
            avg_words: u.avg_words,
            q_rate,
            code_url_rate,
            msg_pct_rank: r_msg,
            n_knowledge_topics: topic.map(|t| t.n_knowledge_topics).unwrap_or(0),
            n_sharing_topics:   topic.map(|t| t.n_sharing_topics).unwrap_or(0),
        };

        let outcome = assign_archetype(&d);

        let features_json = json!({
            "msg_count":        u.total_messages,
            "weeks_active":     u.weeks_active,
            "pct_weeks":        u.pct_weeks,
            "avg_words":        u.avg_words,
            "eng_intensity":    round3(eng_intensity),
            "msg_pct_rank":     round3(r_msg),
            "help_seek_ratio":  round3(help_seeking),
            "ask_ratio":        round3(asking),
            "knowledge_ratio":  round3(knowledge),
            "opinion_ratio":    round3(opinion),
            "creative_ratio":   round3(creative),
            "share_ratio":      round3(share_all),
            "q_rate":           round3(q_rate),
            "code_url_rate":    round3(code_url_rate),
            "pos_ratio":        round3(pos_ratio),
            "neg_ratio":        round3(neg_ratio),
            "sent_score":       round3(sent_score),
            "norm_entropy":     round3(entropy),
            "n_topics":         n_topics,
            "top_emotions":     top_emo,
            "has_pos_emo":       has_pos_emo,
            "has_neg_emo":       has_neg_emo,
            "has_curiosity_emo": has_curiosity_emo,
            "curiosity_count":   sent.map(|s| s.curiosity_count).unwrap_or(0),
            "total_emo_msgs":    sent.map(|s| s.total_emo_msgs).unwrap_or(0),
            "n_sharing_topics":  d.n_sharing_topics,
        });

        // Best-effort save; log but don't abort the batch on a single failure
        if let Err(e) = save_one(&state.db, &u.username, &req.phase, &req.phase_label,
                                 &outcome, &features_json).await
        {
            tracing::warn!("Persona save failed for {}: {}", u.username, e);
        }

        results.push(json!({
            "username":             u.username,
            "persona":              outcome.primary,
            "confidence":           outcome.confidence,
            "secondary_persona":    outcome.secondary,
            "secondary_confidence": outcome.secondary_confidence,
            "reasoning":            outcome.reasoning,
            "scores":               outcome.scores,
        }));
    }

    let count = results.len();
    Ok(Json(json!({ "phase": req.phase, "results": results, "count": count })))
}

// ── Read-side handlers (preserved, now expose secondary fields) ──────────────

pub async fn list_for_user(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(username): Path<String>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let mut conditions = vec!["username = $1".to_string()];
    let mut binds: Vec<String> = vec![username.clone()];

    if let Some(ph) = &q.phase {
        conditions.push(format!("phase = ${}", binds.len() + 1));
        binds.push(ph.clone());
    }
    if let Some(m) = &q.method {
        conditions.push(format!("method = ${}", binds.len() + 1));
        binds.push(m.clone());
    }

    let sql = format!(
        "SELECT username, phase, phase_label, method, persona, confidence, reasoning, \
         secondary_persona, secondary_confidence, features, scores, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as created_at, \
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as updated_at \
         FROM persona_classifications WHERE {} ORDER BY phase, method",
        conditions.join(" AND ")
    );

    let mut query = sqlx::query(&sql);
    for b in &binds { query = query.bind(b); }

    let rows = query.fetch_all(&state.db).await?;
    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "username":             r.get::<String, _>("username"),
        "phase":                r.get::<String, _>("phase"),
        "phase_label":          r.get::<String, _>("phase_label"),
        "method":               r.get::<String, _>("method"),
        "persona":              r.get::<String, _>("persona"),
        "confidence":           r.get::<f32, _>("confidence"),
        "reasoning":            r.get::<String, _>("reasoning"),
        "secondary_persona":    r.try_get::<Option<String>, _>("secondary_persona").unwrap_or(None),
        "secondary_confidence": r.try_get::<Option<f32>, _>("secondary_confidence").unwrap_or(None),
        "features":             r.try_get::<Value, _>("features").unwrap_or(Value::Null),
        "scores":               r.try_get::<Value, _>("scores").unwrap_or(Value::Null),
        "created_at":           r.get::<String, _>("created_at"),
        "updated_at":           r.get::<String, _>("updated_at"),
    })).collect();

    Ok(Json(json!(items)))
}

pub async fn phase_summary(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let mut conditions: Vec<String> = vec![];
    let mut binds: Vec<String> = vec![];
    if let Some(m) = &q.method {
        conditions.push(format!("method = ${}", binds.len() + 1));
        binds.push(m.clone());
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT phase, phase_label, method, persona, COUNT(*) as count \
         FROM persona_classifications{} \
         GROUP BY phase, phase_label, method, persona \
         ORDER BY phase, method, count DESC",
        where_clause
    );

    let mut query = sqlx::query(&sql);
    for b in &binds { query = query.bind(b); }

    let rows = query.fetch_all(&state.db).await?;
    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "phase":       r.get::<String, _>("phase"),
        "phase_label": r.get::<String, _>("phase_label"),
        "method":      r.get::<String, _>("method"),
        "persona":     r.get::<String, _>("persona"),
        "count":       r.get::<i64, _>("count"),
    })).collect();

    Ok(Json(json!(items)))
}

pub async fn by_phase(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    // Build WHERE clause dynamically so the optional method filter actually
    // takes effect.  Previous version ignored it, causing legacy rule_based/llm
    // rows to leak into the frontend's result-table snapshot alongside the
    // new "archetype" rows — and per-username dedup at the JS layer let the
    // wrong method win the keyed map.
    let mut conditions: Vec<String> = Vec::new();
    let mut binds: Vec<String> = Vec::new();
    if let Some(ph) = &q.phase {
        conditions.push(format!("phase = ${}", binds.len() + 1));
        binds.push(ph.clone());
    }
    if let Some(m) = &q.method {
        conditions.push(format!("method = ${}", binds.len() + 1));
        binds.push(m.clone());
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT username, method, persona, confidence, reasoning, \
         secondary_persona, secondary_confidence, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as created_at \
         FROM persona_classifications{} ORDER BY username, method",
        where_clause
    );
    let mut query = sqlx::query(&sql);
    for b in &binds { query = query.bind(b); }
    let rows = query.fetch_all(&state.db).await?;

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "username":             r.get::<String, _>("username"),
        "method":               r.get::<String, _>("method"),
        "persona":              r.get::<String, _>("persona"),
        "confidence":           r.get::<f32, _>("confidence"),
        "reasoning":            r.get::<String, _>("reasoning"),
        "secondary_persona":    r.try_get::<Option<String>, _>("secondary_persona").unwrap_or(None),
        "secondary_confidence": r.try_get::<Option<f32>, _>("secondary_confidence").unwrap_or(None),
        "created_at":           r.get::<Option<String>, _>("created_at"),
    })).collect();

    Ok(Json(json!(items)))
}

pub async fn delete_one(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((username, phase, method)): Path<(String, String, String)>,
) -> Result<Json<Value>> {
    let affected = sqlx::query(
        "DELETE FROM persona_classifications WHERE username=$1 AND phase=$2 AND method=$3",
    )
    .bind(&username)
    .bind(&phase)
    .bind(&method)
    .execute(&state.db)
    .await?
    .rows_affected();
    Ok(Json(json!({ "deleted": affected > 0 })))
}

// ── Handler: POST /persona/phase-sentiment ───────────────────────────────────
// Aggregates message_emotions per phase date window.
// Input:  [{ phase, date_from, date_to }]
// Output: [{ phase, positive, negative, neutral, total }]

#[derive(Deserialize)]
pub struct PhaseRange {
    pub phase: String,
    pub date_from: String,
    pub date_to: String,
}

pub async fn phase_sentiment(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(phases): Json<Vec<PhaseRange>>,
) -> Result<Json<Value>> {
    let mut results: Vec<Value> = Vec::with_capacity(phases.len());

    for pd in &phases {
        let mut cond_parts = vec!["m.msg_uuid IS NOT NULL".to_string()];
        let mut args: Vec<String> = Vec::new();

        if !pd.date_from.is_empty() {
            args.push(pd.date_from.clone());
            cond_parts.push(format!("m.date >= ${}", args.len()));
        }
        if !pd.date_to.is_empty() {
            args.push(pd.date_to.clone());
            cond_parts.push(format!("m.date <= ${}", args.len()));
        }

        let where_sql = cond_parts.join(" AND ");
        let sql = format!(
            "SELECT \
             COUNT(*) FILTER (WHERE me.sentiment = 'positive') AS positive, \
             COUNT(*) FILTER (WHERE me.sentiment = 'negative') AS negative, \
             COUNT(*) FILTER (WHERE me.sentiment NOT IN ('positive','negative')) AS neutral, \
             COUNT(*) AS total \
             FROM messages m \
             JOIN message_emotions me ON m.msg_uuid = me.msg_uuid \
             WHERE {where_sql}"
        );

        let mut q = sqlx::query(&sql);
        for a in &args { q = q.bind(a.clone()); }

        match q.fetch_one(&state.db).await {
            Ok(row) => {
                results.push(json!({
                    "phase":    pd.phase,
                    "positive": row.get::<i64, _>("positive"),
                    "negative": row.get::<i64, _>("negative"),
                    "neutral":  row.get::<i64, _>("neutral"),
                    "total":    row.get::<i64, _>("total"),
                }));
            }
            Err(e) => {
                tracing::warn!("phase_sentiment query failed for phase {}: {e}", pd.phase);
                results.push(json!({
                    "phase":    pd.phase,
                    "positive": 0_i64,
                    "negative": 0_i64,
                    "neutral":  0_i64,
                    "total":    0_i64,
                }));
            }
        }
    }

    Ok(Json(json!(results)))
}
