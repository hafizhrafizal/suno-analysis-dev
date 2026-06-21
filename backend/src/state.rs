use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::{RwLock, Semaphore};
use sqlx::PgPool;
use crate::config::Config;

/// Max concurrent HTTP calls to the AI service (emotion/BERTopic).
/// Kept at 8 so the backend never pushes more in-flight requests than the AI
/// service's asyncio queue can hold (concurrency_slots × 2).  Higher values
/// cause the AI service to 503-fast-reject the excess, triggering retry storms.
pub const AI_CONCURRENCY: usize = 8;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub openai_key: Arc<RwLock<Option<String>>>,
    pub fts_ready: Arc<AtomicBool>,
    pub http_client: reqwest::Client,
    /// Global rate-limiter for calls to the AI service.  Shared across all
    /// tabs/users so two browser sessions can't collectively overwhelm the service.
    pub ai_semaphore: Arc<Semaphore>,
}

impl AsRef<AppState> for AppState {
    fn as_ref(&self) -> &AppState {
        self
    }
}

impl AppState {
    pub fn new(db: PgPool, config: Config, fts_ready: Arc<AtomicBool>) -> Self {
        let openai_key = config.openai_api_key.clone();
        // 600s timeout: under CPU contention an emotion-inference chunk can
        // legitimately take 5-30s; the previous 300s cliff was tripping while
        // the AI service was still working.  The AI-side semaphore caps
        // working set, so genuine hangs are not expected — this is headroom.
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .expect("Failed to build shared HTTP client");
        Self {
            db,
            config: Arc::new(config),
            openai_key: Arc::new(RwLock::new(openai_key)),
            fts_ready,
            http_client,
            ai_semaphore: Arc::new(Semaphore::new(AI_CONCURRENCY)),
        }
    }

    pub async fn get_app_mode(&self) -> Option<String> {
        if self.config.app_mode.is_some() {
            return self.config.app_mode.clone();
        }
        sqlx::query_scalar("SELECT value FROM settings WHERE key='app_mode'")
            .fetch_optional(&self.db)
            .await
            .ok()
            .flatten()
    }

    /// Return the OpenAI key to use for a request.
    /// Prefers the value the client sent in the `X-OpenAI-Key` header (sourced from
    /// localStorage — never stored server-side), then falls back to the server-level
    /// key from the `.env` / config file.
    pub async fn get_openai_key(&self, header_key: Option<String>) -> Option<String> {
        if let Some(k) = header_key {
            if !k.is_empty() { return Some(k); }
        }
        self.openai_key.read().await.clone()
    }

    pub fn get_embedding_model(&self) -> String {
        "text-embedding-3-small".to_string()
    }

    /// Query Qdrant for the total number of vectors in the active collection.
    /// Returns None if Qdrant is unreachable or the collection doesn't exist.
    pub async fn get_vector_count(&self) -> Option<i64> {
        let url = format!(
            "{}/collections/{}/points/count",
            self.config.qdrant_url, self.config.qdrant_collection
        );
        let mut req = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .ok()?
            .post(&url)
            .json(&serde_json::json!({ "exact": true }));
        if let Some(key) = &self.config.qdrant_api_key {
            req = req.header("api-key", key);
        }
        let resp: serde_json::Value = req.send().await.ok()?.json().await.ok()?;
        resp["result"]["count"]
            .as_i64()
            .or_else(|| resp["result"]["count"].as_f64().map(|f| f as i64))
    }
}
