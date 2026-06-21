use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Message {
    pub id: i64,
    pub msg_uuid: String,
    pub author_id: Option<String>,
    pub username: String,
    pub date: String,
    pub content: String,
    pub attachments: Option<String>,
    pub reactions: Option<String>,
    pub is_suno_team: Option<String>,
    pub week: Option<String>,
    pub month: Option<String>,
    pub upload_id: Option<String>,
    pub row_index: Option<i64>,
}

// Auth user extracted from session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
}

// ── Request bodies ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct SetModeRequest {
    pub mode: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateLabelRequest {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLabelRequest {
    pub name: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBookmarkRequest {
    pub msg_id: i64,
    pub ctx_before: Option<i64>,
    pub ctx_after: Option<i64>,
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub query: String,
    #[allow(dead_code)]
    pub strategy: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SummarizeRequest {
    pub query: String,
}

#[derive(Debug, Deserialize)]
pub struct SummarizeFollowupRequest {
    pub query: String,
    pub previous_summary: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SummarizeMsg {
    pub username: String,
    pub date: String,
    pub content: String,
    pub msg_uuid: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SummarizeResultsRequest {
    pub messages: Vec<SummarizeMsg>,
    pub query: Option<String>,
    pub prompt: Option<String>,          // frontend alias for query
    pub model: Option<String>,
    pub retrieval_mode: Option<String>,  // "cluster" | "all"
}

#[derive(Debug, Deserialize)]
pub struct SummarizeResultsFollowupRequest {
    pub messages: Option<Vec<SummarizeMsg>>,
    pub query: Option<String>,
    pub question: Option<String>,     // frontend alias for query
    pub previous_summary: Option<String>,
    pub summary: Option<String>,      // frontend alias for previous_summary
}

#[derive(Debug, Deserialize)]
pub struct UserProfileRequest {
    pub username: String,
    pub query: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UserTopicsRequest {
    pub docs: Vec<String>,
    pub msg_uuids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct StrategyDef {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct StrategyRequest {
    pub messages: Vec<SummarizeMsg>,
    pub strategies: Vec<StrategyDef>,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UserProfileFollowupRequest {
    #[allow(dead_code)]
    pub username: String,
    pub query: String,
    pub previous_profile: String,
}

#[derive(Debug, Deserialize)]
pub struct SetApiKeyRequest {
    #[allow(dead_code)]
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
pub struct SetEmbeddingModelRequest {
    #[allow(dead_code)]
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateCodeRequest {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
    pub category_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCodeRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub description: Option<String>,
    pub category_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCodeCategoryRequest {
    pub name: String,
    pub color: Option<String>,
    pub parent_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCodeCategoryRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub parent_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AssignCodeRequest {
    pub bookmark_id: i64,
    pub code_id: i64,
    pub highlighted_text: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BulkContextRequest {
    pub message_ids: Vec<i64>,
    pub context_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SemanticFilterRequest {
    pub messages: Vec<Message>,
    pub query: String,
}

#[derive(Debug, Deserialize)]
pub struct AddHighlightRequest {
    pub code_id: i64,
    pub highlighted_text: String,
}
