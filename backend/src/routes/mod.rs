pub mod admin;
pub mod auth;
pub mod bookmarks;
pub mod chat;
pub mod codes;
pub mod config_api;
pub mod context_route;
pub mod labels;
pub mod persona;
pub mod search;
pub mod stats;
pub mod suno_team;
pub mod topics;
pub mod uploads;

use axum::{extract::DefaultBodyLimit, routing::{delete, get, post, put}, Router};
use crate::state::AppState;

pub fn all_routes(state: AppState) -> Router {
    Router::new()
        // Auth
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/app-mode", get(auth::get_mode))
        .route("/auth/set-mode", post(auth::set_mode))
        // Admin
        .route("/admin/users", get(admin::list_users))
        .route("/admin/users/:user_id", delete(admin::delete_user))
        .route("/admin/users/:user_id/toggle-admin", post(admin::toggle_admin))
        .route("/admin/users/:user_id/password", post(admin::set_user_password))
        // Stats
        .route("/stats", get(stats::get_stats))
        // Config
        .route("/set-api-key", post(config_api::set_api_key))
        .route("/set-embedding-model", post(config_api::set_embedding_model))
        .route("/embedding-models", get(config_api::list_embedding_models))
        // Search
        .route("/search/keyword", get(search::keyword_search))
        .route("/search/semantic", get(search::semantic_search))
        .route("/search/range", get(search::range_search))
        .route("/search/username", get(search::username_search))
        .route("/search/users-in-range", get(search::users_in_range))
        .route("/search/user-messages", get(search::user_messages))
        .route("/search/bulk-context", post(search::bulk_context))
        .route("/messages/export", get(search::export_csv))
        .route("/messages/emotions", post(search::get_message_emotions))
        .route("/search/stored-sentiment", post(search::stored_sentiment))
        // Context
        .route("/context/:message_id", get(context_route::get_context))
        .route("/filter/semantic", post(context_route::filter_semantic))
        // Chat
        .route("/chat", post(chat::chat))
        .route("/summarize", post(chat::summarize))
        .route("/summarize/followup", post(chat::summarize_followup))
        .route("/summarize-results", post(chat::summarize_results))
        .route("/summarize-results/followup", post(chat::summarize_results_followup))
        .route("/user-profile", post(chat::user_profile))
        .route("/user-profile/followup", post(chat::user_profile_followup))
        .route("/user-topics", post(chat::user_topics))
        .route("/user-topics/stream", post(chat::user_topics_stream))
        // Topic analysis results DB
        .route("/topics/save", post(topics::save_topics))
        .route("/topics/user/:username", get(topics::get_topics_for_user))
        .route("/topics/batch-get", post(topics::batch_get_topics))
        .route("/topics/label", post(topics::update_topic_label))   // manual override
        .route("/topics/relabel", post(topics::relabel_topic))      // AI re-label
        .route("/topics/user/:username/messages", get(topics::get_topic_messages_for_user))
        .route("/user-emotion", post(chat::user_emotion))
        .route("/search/sentiment-count", post(chat::sentiment_count))
        .route("/search/batch-sentiment", post(chat::user_batch_sentiment))
        .route("/search/batch-sentiment-stream", post(chat::batch_sentiment_stream))
        .route("/user-strategy-classify", post(chat::user_strategy_classify))
        .route("/user-engagement-narrative", post(chat::user_engagement_narrative))
        // Persona / archetype classification (single-method primary + secondary)
        .route("/persona/compute-batch", post(persona::compute_batch))
        .route("/persona/by-phase", get(persona::by_phase))
        .route("/persona/user/:username", get(persona::list_for_user))
        .route("/persona/phase-summary", get(persona::phase_summary))
        .route("/persona/phase-sentiment", post(persona::phase_sentiment))
        .route("/persona/:username/:phase/:method", delete(persona::delete_one))
        // Uploads — 200 MB body limit for large Discord CSV exports
        .route("/upload", post(uploads::upload_csv).layer(DefaultBodyLimit::max(200 * 1024 * 1024)))
        .route("/uploads", get(uploads::list_uploads))
        .route("/uploads/:id", delete(uploads::delete_upload))
        .route("/uploads/:id/sqlite", delete(uploads::delete_upload_sqlite))
        .route("/uploads/:id/embeddings", delete(uploads::delete_upload_embeddings))
        .route("/uploads/:id/reembed", post(uploads::reembed))
        .route("/uploads/sync-qdrant", post(uploads::sync_qdrant))
        .route("/jobs/:job_id", get(uploads::get_job))
        // Bookmarks
        .route("/bookmarks", post(bookmarks::create_bookmark).get(bookmarks::list_bookmarks))
        .route("/bookmarks/ids", get(bookmarks::list_bookmark_ids))
        .route("/bookmarks/meta", get(bookmarks::list_bookmarks_meta))
        .route("/bookmarks/:id", delete(bookmarks::delete_bookmark))
        .route("/bookmarks/by-msg/:msg_id", delete(bookmarks::delete_bookmark_by_msg))
        .route("/bookmarks/:id/labels/:label_id",
            post(bookmarks::add_label).delete(bookmarks::remove_label))
        .route("/bookmarks/:id/highlights", post(bookmarks::add_highlight))
        .route("/bookmarks/:id/highlights/:hl_id", delete(bookmarks::remove_highlight))
        // Labels
        .route("/labels", post(labels::create_label).get(labels::list_labels))
        .route("/labels/:id", put(labels::update_label).delete(labels::delete_label))
        // Codes
        .route("/codes", post(codes::create_code).get(codes::list_codes))
        .route("/codes/:id", put(codes::update_code).delete(codes::delete_code))
        .route("/code-categories", post(codes::create_category).get(codes::list_categories))
        .route("/code-categories/:id", put(codes::update_category).delete(codes::delete_category))
        .route("/bookmark-codes", post(codes::assign_code).get(codes::list_all_bookmark_codes))
        .route("/bookmark-codes/:bookmark_id", get(codes::list_codes_for_bookmark))
        .route("/bookmark-codes/:bookmark_id/:code_id", delete(codes::remove_code_assignment))
        // Suno team
        .route("/suno-team", get(suno_team::list_suno_team))
        .route("/suno-team/:username", post(suno_team::add_suno_team).delete(suno_team::remove_suno_team))
        .with_state(state)
}
