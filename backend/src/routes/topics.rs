use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    error::AppError,
    models::{AuthUser, BatchGetTopicsRequest, SaveTopicsRequest},
    state::AppState,
};

// ── Shared helper ─────────────────────────────────────────────────────────────

/// Insert (or replace) a full topic run for a user.
/// Deletes the old run for the same (username, date_from, date_to, upload_ids) first.
pub async fn upsert_topic_run(
    pool: &sqlx::PgPool,
    username: &str,
    date_from: &str,
    date_to: &str,
    upload_ids: &str,
    result: &Value,
) -> Result<(), AppError> {
    let total_docs   = result["total_docs"].as_i64().unwrap_or(0) as i32;
    let filtered_docs = result["filtered_docs"].as_i64().unwrap_or(0) as i32;
    let warning      = result["warning"].as_str();

    // Delete existing run (cascade removes items + messages)
    sqlx::query(
        "DELETE FROM user_topic_runs
         WHERE username = $1 AND date_from = $2 AND date_to = $3 AND upload_ids = $4",
    )
    .bind(username)
    .bind(date_from)
    .bind(date_to)
    .bind(upload_ids)
    .execute(pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    // Insert new run
    let run_id: i64 = sqlx::query_scalar(
        "INSERT INTO user_topic_runs (username, date_from, date_to, upload_ids, total_docs, filtered_docs, warning)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id",
    )
    .bind(username)
    .bind(date_from)
    .bind(date_to)
    .bind(upload_ids)
    .bind(total_docs)
    .bind(filtered_docs)
    .bind(warning)
    .fetch_one(pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    // Insert topic items
    if let Some(topics) = result["topics"].as_array() {
        for topic in topics {
            let topic_id     = topic["id"].as_i64().unwrap_or(-1) as i32;
            let label        = topic["label"].as_str().unwrap_or("").to_string();
            let message_count = topic["message_count"].as_i64().unwrap_or(0) as i32;
            let keywords: Vec<String> = topic["keywords"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();

            sqlx::query(
                "INSERT INTO user_topic_items (run_id, topic_id, label, keywords, message_count)
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(run_id)
            .bind(topic_id)
            .bind(&label)
            .bind(&keywords)
            .bind(message_count)
            .execute(pool)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        }
    }

    // Insert message assignments
    if let Some(assignments) = result["doc_assignments"].as_object() {
        for (msg_uuid, topic_id_val) in assignments {
            let topic_id = topic_id_val.as_i64().unwrap_or(-1) as i32;
            sqlx::query(
                "INSERT INTO user_topic_messages (run_id, msg_uuid, topic_id) VALUES ($1, $2, $3)",
            )
            .bind(run_id)
            .bind(msg_uuid)
            .bind(topic_id)
            .execute(pool)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        }
    }

    Ok(())
}

/// Rebuild a `UserTopicsResult`-shaped JSON from DB rows for a given run_id.
async fn build_result_from_run(
    pool: &sqlx::PgPool,
    run_id: i64,
    total_docs: i32,
    filtered_docs: i32,
    warning: Option<String>,
) -> Result<Value, AppError> {
    let items = sqlx::query!(
        "SELECT topic_id, label, keywords, message_count
         FROM user_topic_items WHERE run_id = $1 ORDER BY message_count DESC",
        run_id
    )
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let topics: Vec<Value> = items
        .iter()
        .map(|r| json!({
            "id":            r.topic_id,
            "label":         r.label,
            "keywords":      r.keywords,
            "message_count": r.message_count,
        }))
        .collect();

    let assignments_rows = sqlx::query!(
        "SELECT msg_uuid, topic_id FROM user_topic_messages WHERE run_id = $1",
        run_id
    )
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let mut doc_assignments = serde_json::Map::new();
    for row in &assignments_rows {
        doc_assignments.insert(row.msg_uuid.clone(), json!(row.topic_id));
    }

    Ok(json!({
        "topics":          topics,
        "doc_assignments": doc_assignments,
        "total_docs":      total_docs,
        "filtered_docs":   filtered_docs,
        "warning":         warning,
    }))
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// POST /topics/save — save or replace a topic run
pub async fn save_topics(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<SaveTopicsRequest>,
) -> Result<impl IntoResponse, AppError> {
    let date_from  = req.date_from.as_deref().unwrap_or("");
    let date_to    = req.date_to.as_deref().unwrap_or("");
    let upload_ids = req.upload_ids.as_deref().unwrap_or("");

    upsert_topic_run(&state.pool, &req.username, date_from, date_to, upload_ids, &req.result).await?;

    Ok(Json(json!({ "ok": true })))
}

/// GET /topics/user/:username?date_from=&date_to=&upload_ids=
pub async fn get_topics_for_user(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(username): Path<String>,
    Query(params): Query<GetTopicsParams>,
) -> Result<impl IntoResponse, AppError> {
    let date_from  = params.date_from.as_deref().unwrap_or("");
    let date_to    = params.date_to.as_deref().unwrap_or("");
    let upload_ids = params.upload_ids.as_deref().unwrap_or("");

    let row = sqlx::query!(
        "SELECT id, total_docs, filtered_docs, warning
         FROM user_topic_runs
         WHERE username = $1 AND date_from = $2 AND date_to = $3 AND upload_ids = $4",
        username, date_from, date_to, upload_ids,
    )
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    match row {
        None => Ok(Json(Value::Null)),
        Some(r) => {
            let result = build_result_from_run(
                &state.pool, r.id, r.total_docs, r.filtered_docs, r.warning,
            ).await?;
            Ok(Json(result))
        }
    }
}

/// POST /topics/batch-get — get topic results for multiple users at once
pub async fn batch_get_topics(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<BatchGetTopicsRequest>,
) -> Result<impl IntoResponse, AppError> {
    if req.usernames.is_empty() {
        return Ok(Json(json!({ "results": {} })));
    }

    let date_from  = req.date_from.as_deref().unwrap_or("");
    let date_to    = req.date_to.as_deref().unwrap_or("");
    let upload_ids = req.upload_ids.as_deref().unwrap_or("");

    let runs = sqlx::query!(
        "SELECT id, username, total_docs, filtered_docs, warning
         FROM user_topic_runs
         WHERE username = ANY($1) AND date_from = $2 AND date_to = $3 AND upload_ids = $4",
        &req.usernames, date_from, date_to, upload_ids,
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let mut results = serde_json::Map::new();
    for run in runs {
        let result = build_result_from_run(
            &state.pool, run.id, run.total_docs, run.filtered_docs, run.warning,
        ).await?;
        results.insert(run.username.clone(), result);
    }

    Ok(Json(json!({ "results": results })))
}

#[derive(Debug, Deserialize)]
pub struct GetTopicsParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
}
