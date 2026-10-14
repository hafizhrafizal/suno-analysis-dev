use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    error::AppError,
    models::{AuthUser, BatchGetTopicsRequest, SaveTopicsRequest},
    state::AppState,
};

// ── Shared helper ─────────────────────────────────────────────────────────────

/// Insert (or replace) a full topic run for a user.
/// Deletes the old run for the same (username, date_from, date_to, upload_ids) first,
/// then inserts a new run with all topics and message assignments.
pub async fn upsert_topic_run(
    pool: &sqlx::PgPool,
    username: &str,
    date_from: &str,
    date_to: &str,
    upload_ids: &str,
    result: &Value,
) -> Result<(), AppError> {
    let total_docs    = result["total_docs"].as_i64().unwrap_or(0) as i32;
    let filtered_docs = result["filtered_docs"].as_i64().unwrap_or(0) as i32;
    let warning       = result["warning"].as_str().map(String::from);

    // Delete existing run — ON DELETE CASCADE removes items + messages automatically
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

    // Insert new run, get its generated id
    let run_id: i64 = sqlx::query_scalar(
        "INSERT INTO user_topic_runs
             (username, date_from, date_to, upload_ids, total_docs, filtered_docs, warning)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id",
    )
    .bind(username)
    .bind(date_from)
    .bind(date_to)
    .bind(upload_ids)
    .bind(total_docs)
    .bind(filtered_docs)
    .bind(warning.as_deref())
    .fetch_one(pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    // Insert topic items
    if let Some(topics) = result["topics"].as_array() {
        for topic in topics {
            let topic_id      = topic["id"].as_i64().unwrap_or(-1) as i32;
            let label         = topic["label"].as_str().unwrap_or("").to_string();
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

    // Insert message-to-topic assignments in bulk using unnest
    if let Some(obj) = result["doc_assignments"].as_object() {
        if !obj.is_empty() {
            let uuids: Vec<String>   = obj.keys().cloned().collect();
            let topic_ids: Vec<i32>  = obj.values()
                .map(|v| v.as_i64().unwrap_or(-1) as i32)
                .collect();
            let run_ids: Vec<i64>    = vec![run_id; uuids.len()];

            sqlx::query(
                "INSERT INTO user_topic_messages (run_id, msg_uuid, topic_id)
                 SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[])",
            )
            .bind(&run_ids)
            .bind(&uuids)
            .bind(&topic_ids)
            .execute(pool)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        }
    }

    Ok(())
}

/// Rebuild a `UserTopicsResult`-shaped JSON from DB rows for a given run_id.
///
/// When `include_assignments=false`, the per-message uuid→topic_id map is
/// omitted from the result.  Used by batch-get for the result-table view
/// which only needs topic counts/labels — fetching all message assignments
/// for dozens of users is the dominant cost (~thousands of rows per user).
async fn build_result_from_run(
    pool: &sqlx::PgPool,
    run_id: i64,
    total_docs: i32,
    filtered_docs: i32,
    warning: Option<String>,
    date_from: &str,
    date_to: &str,
    include_assignments: bool,
) -> Result<Value, AppError> {
    let item_rows = sqlx::query(
        "SELECT topic_id, label, keywords, message_count
         FROM user_topic_items WHERE run_id = $1 ORDER BY message_count DESC",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let topics: Vec<Value> = item_rows
        .iter()
        .map(|r| {
            let kws: Vec<String> = r.try_get::<Vec<String>, _>("keywords").unwrap_or_default();
            json!({
                "id":            r.get::<i32, _>("topic_id"),
                "label":         r.get::<String, _>("label"),
                "keywords":      kws,
                "message_count": r.get::<i32, _>("message_count"),
            })
        })
        .collect();

    let doc_assignments = if include_assignments {
        let msg_rows = sqlx::query(
            "SELECT msg_uuid, topic_id FROM user_topic_messages WHERE run_id = $1",
        )
        .bind(run_id)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

        let mut m = serde_json::Map::new();
        for row in &msg_rows {
            let uuid: String = row.get("msg_uuid");
            let tid: i32     = row.get("topic_id");
            m.insert(uuid, json!(tid));
        }
        m
    } else {
        serde_json::Map::new()
    };

    Ok(json!({
        "topics":          topics,
        "doc_assignments": doc_assignments,
        "total_docs":      total_docs,
        "filtered_docs":   filtered_docs,
        "warning":         warning,
        "date_from":       date_from,
        "date_to":         date_to,
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

    upsert_topic_run(&state.db, &req.username, date_from, date_to, upload_ids, &req.result).await?;

    Ok(Json(json!({ "ok": true })))
}

/// GET /topics/user/:username?date_from=&date_to=&upload_ids=
///
/// Returns the saved topic run for this user and date window.
/// Falls back to the highest-coverage run (most filtered_docs) when there
/// is no exact match — so opening a user detail with a different active filter
/// still shows previously saved results rather than silently returning null.
pub async fn get_topics_for_user(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(username): Path<String>,
    Query(params): Query<GetTopicsParams>,
) -> Result<impl IntoResponse, AppError> {
    let date_from  = params.date_from.as_deref().unwrap_or("");
    let date_to    = params.date_to.as_deref().unwrap_or("");
    let upload_ids = params.upload_ids.as_deref().unwrap_or("");

    // 1. Exact match on the requested filter window
    let exact = sqlx::query(
        "SELECT id, date_from, date_to, total_docs, filtered_docs, warning
         FROM user_topic_runs
         WHERE username = $1 AND date_from = $2 AND date_to = $3 AND upload_ids = $4",
    )
    .bind(&username)
    .bind(date_from)
    .bind(date_to)
    .bind(upload_ids)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    // 2. Fallback: best coverage run for this user (any date/upload_ids)
    let row = if exact.is_some() {
        exact
    } else {
        sqlx::query(
            "SELECT id, date_from, date_to, total_docs, filtered_docs, warning
             FROM user_topic_runs
             WHERE username = $1
             ORDER BY filtered_docs DESC, id DESC
             LIMIT 1",
        )
        .bind(&username)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    };

    match row {
        None => Ok(Json(Value::Null)),
        Some(r) => {
            let run_id: i64          = r.get("id");
            let run_date_from: String = r.get("date_from");
            let run_date_to: String   = r.get("date_to");
            let total_docs: i32      = r.get("total_docs");
            let filtered_docs: i32   = r.get("filtered_docs");
            let warning: Option<String> = r.try_get("warning").ok().flatten();
            let result = build_result_from_run(
                &state.db, run_id, total_docs, filtered_docs, warning,
                &run_date_from, &run_date_to, true,
            ).await?;
            Ok(Json(result))
        }
    }
}

/// POST /topics/batch-get — get topic results for multiple users at once
///
/// First tries an exact match on (username, date_from, date_to, upload_ids).
/// For users not found by exact match, falls back to the best-coverage run
/// (highest filtered_docs) — same strategy as the single-user endpoint.
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

    // ── 1. Exact match on the requested filter window ──────────────────────
    let exact_runs = sqlx::query(
        "SELECT id, username, date_from, date_to, total_docs, filtered_docs, warning
         FROM user_topic_runs
         WHERE username = ANY($1) AND date_from = $2 AND date_to = $3 AND upload_ids = $4",
    )
    .bind(&req.usernames)
    .bind(date_from)
    .bind(date_to)
    .bind(upload_ids)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let mut results = serde_json::Map::new();
    let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();

    for run in &exact_runs {
        let run_id: i64             = run.get("id");
        let username: String        = run.get("username");
        let run_date_from: String   = run.get("date_from");
        let run_date_to: String     = run.get("date_to");
        let total_docs: i32         = run.get("total_docs");
        let filtered_docs: i32      = run.get("filtered_docs");
        let warning: Option<String> = run.try_get("warning").ok().flatten();
        let result = build_result_from_run(
            &state.db, run_id, total_docs, filtered_docs, warning,
            &run_date_from, &run_date_to, false,
        ).await?;
        found.insert(username.clone());
        results.insert(username, result);
    }

    // ── 2. Fallback: best-coverage run for users not found by exact match ──
    let missing: Vec<&String> = req.usernames.iter().filter(|u| !found.contains(*u)).collect();
    if !missing.is_empty() {
        // DISTINCT ON gives one row per username (the one with highest filtered_docs)
        let fallback_runs = sqlx::query(
            "SELECT DISTINCT ON (username)
                    id, username, date_from, date_to, total_docs, filtered_docs, warning
             FROM user_topic_runs
             WHERE username = ANY($1)
             ORDER BY username, filtered_docs DESC, id DESC",
        )
        .bind(&missing)
        .fetch_all(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

        for run in &fallback_runs {
            let run_id: i64             = run.get("id");
            let username: String        = run.get("username");
            let run_date_from: String   = run.get("date_from");
            let run_date_to: String     = run.get("date_to");
            let total_docs: i32         = run.get("total_docs");
            let filtered_docs: i32      = run.get("filtered_docs");
            let warning: Option<String> = run.try_get("warning").ok().flatten();
            let result = build_result_from_run(
                &state.db, run_id, total_docs, filtered_docs, warning,
                &run_date_from, &run_date_to, false,
            ).await?;
            results.insert(username, result);
        }
    }

    Ok(Json(json!({ "results": results })))
}

#[derive(Debug, Deserialize)]
pub struct GetTopicsParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
}

// ── Topic-label editing ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UpdateLabelRequest {
    pub username: String,
    pub topic_id: i32,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
    pub label: String,
}

/// PATCH /topics/label — overwrite the label of a single topic in a saved run.
/// Identifies the run by (username, date_from, date_to, upload_ids) so the
/// frontend doesn't need to track the internal `run_id`.
pub async fn update_topic_label(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<UpdateLabelRequest>,
) -> Result<impl IntoResponse, AppError> {
    let date_from  = req.date_from.as_deref().unwrap_or("");
    let date_to    = req.date_to.as_deref().unwrap_or("");
    let upload_ids = req.upload_ids.as_deref().unwrap_or("");
    let trimmed = req.label.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Label must not be empty".into()));
    }

    let res = sqlx::query(
        "UPDATE user_topic_items
            SET label = $5
          WHERE topic_id = $1
            AND run_id IN (
                SELECT id FROM user_topic_runs
                WHERE username = $2 AND date_from = $3 AND date_to = $4 AND upload_ids = $6
            )",
    )
    .bind(req.topic_id)
    .bind(&req.username)
    .bind(date_from)
    .bind(date_to)
    .bind(trimmed)
    .bind(upload_ids)
    .execute(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "updated": res.rows_affected() > 0, "label": trimmed })))
}

#[derive(Debug, Deserialize)]
pub struct RelabelRequest {
    pub username: String,
    pub topic_id: i32,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
}

/// POST /topics/relabel — regenerate one topic's label via GPT-4o-mini.
/// Loads the topic's keywords + sample messages, asks the AI service's
/// `/topics` labeler equivalent via OpenAI directly (so this stays in-process
/// and doesn't depend on a separate microservice endpoint).
pub async fn relabel_topic(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: axum::http::HeaderMap,
    Json(req): Json<RelabelRequest>,
) -> Result<impl IntoResponse, AppError> {
    let date_from  = req.date_from.as_deref().unwrap_or("");
    let date_to    = req.date_to.as_deref().unwrap_or("");
    let upload_ids = req.upload_ids.as_deref().unwrap_or("");

    // 1. Find the run + this topic's keywords
    let topic_row = sqlx::query(
        "SELECT i.keywords FROM user_topic_items i
         JOIN user_topic_runs r ON r.id = i.run_id
         WHERE r.username = $1 AND r.date_from = $2 AND r.date_to = $3 AND r.upload_ids = $4
           AND i.topic_id = $5
         LIMIT 1",
    )
    .bind(&req.username).bind(date_from).bind(date_to).bind(upload_ids).bind(req.topic_id)
    .fetch_optional(&state.db).await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let Some(trow) = topic_row else {
        return Err(AppError::BadRequest("Topic not found".into()));
    };
    let keywords: Vec<String> = trow.try_get("keywords").unwrap_or_default();

    // 2. Pull ALL messages assigned to this topic (up to 60) ordered by length so we
    //    can build a diverse sample: longest (content-rich), median (typical), shortest
    //    (edge-case / low-signal) — mirrors the ai_service diverse_sample_for_labeling().
    let msg_rows = sqlx::query(
        "SELECT m.content FROM user_topic_messages utm
         JOIN user_topic_runs r ON r.id = utm.run_id
         JOIN messages m ON m.msg_uuid = utm.msg_uuid
         WHERE r.username = $1 AND r.date_from = $2 AND r.date_to = $3 AND r.upload_ids = $4
           AND utm.topic_id = $5
         ORDER BY length(m.content) DESC
         LIMIT 60",
    )
    .bind(&req.username).bind(date_from).bind(date_to).bind(upload_ids).bind(req.topic_id)
    .fetch_all(&state.db).await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let all_msgs: Vec<String> = msg_rows.iter()
        .map(|r| r.get::<String, _>("content"))
        .collect();

    // Diverse sampling: 8 longest + 8 from middle + 4 shortest (all unique).
    // For small clusters just use all.
    let cluster_size = all_msgs.len();
    let samples: Vec<String> = if cluster_size <= 20 {
        all_msgs.clone()
    } else {
        let n = cluster_size;
        let mut selected: Vec<String> = Vec::new();
        // top 8 longest (already sorted desc)
        for i in 0..8.min(n) { selected.push(all_msgs[i].clone()); }
        // 8 from middle band
        let mid_start = (n / 2).saturating_sub(4);
        for i in mid_start..(mid_start + 8).min(n) {
            if !selected.contains(&all_msgs[i]) { selected.push(all_msgs[i].clone()); }
        }
        // 4 shortest (from tail)
        for i in (n.saturating_sub(4)..n).rev() {
            if !selected.contains(&all_msgs[i]) { selected.push(all_msgs[i].clone()); }
        }
        selected
    };

    // 3. Call OpenAI directly
    let api_key = state
        .get_openai_key(
            headers.get("x-openai-key")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty())
                .map(String::from),
        )
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    // Acquire global relabel slot — caps concurrent OpenAI calls across all tabs/users.
    let _relabel_permit = state.relabel_semaphore.acquire().await
        .map_err(|_| AppError::Internal("Relabel semaphore closed".into()))?;

    let new_label = call_gpt_label(&api_key, &keywords, &samples, cluster_size).await?;

    // 4. Save back to DB
    sqlx::query(
        "UPDATE user_topic_items SET label = $5
         WHERE topic_id = $1
           AND run_id IN (
               SELECT id FROM user_topic_runs
               WHERE username = $2 AND date_from = $3 AND date_to = $4 AND upload_ids = $6
           )",
    )
    .bind(req.topic_id).bind(&req.username)
    .bind(date_from).bind(date_to).bind(&new_label).bind(upload_ids)
    .execute(&state.db).await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(json!({ "label": new_label })))
}

// ── Topic message retrieval ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TopicMessagesParams {
    pub topic_id: i32,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
}

/// GET /topics/user/:username/messages?topic_id=N
///
/// Returns all messages assigned to `topic_id` in the best-coverage topic run
/// for this user.  Message order is chronological.
pub async fn get_topic_messages_for_user(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(username): Path<String>,
    Query(params): Query<TopicMessagesParams>,
) -> Result<impl IntoResponse, AppError> {
    // Find the matching run — use exact (date_from, date_to, upload_ids) when any param is
    // present (even empty string), so the result matches what batch-get returned.
    let has_run_params = params.date_from.is_some() || params.date_to.is_some() || params.upload_ids.is_some();
    let row = if has_run_params {
        let date_from  = params.date_from.as_deref().unwrap_or("");
        let date_to    = params.date_to.as_deref().unwrap_or("");
        let upload_ids = params.upload_ids.as_deref().unwrap_or("");
        sqlx::query(
            "SELECT id FROM user_topic_runs
             WHERE username = $1 AND date_from = $2 AND date_to = $3 AND upload_ids = $4
             ORDER BY filtered_docs DESC, id DESC
             LIMIT 1",
        )
        .bind(&username)
        .bind(date_from)
        .bind(date_to)
        .bind(upload_ids)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    } else {
        sqlx::query(
            "SELECT id FROM user_topic_runs
             WHERE username = $1
             ORDER BY filtered_docs DESC, id DESC
             LIMIT 1",
        )
        .bind(&username)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    };

    let run_id = match row {
        None => return Ok(Json(json!([]))),
        Some(r) => r.get::<i64, _>("id"),
    };

    // Collect the UUIDs assigned to this topic
    let uuid_rows = sqlx::query(
        "SELECT msg_uuid FROM user_topic_messages WHERE run_id = $1 AND topic_id = $2",
    )
    .bind(run_id)
    .bind(params.topic_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    if uuid_rows.is_empty() {
        return Ok(Json(json!([])));
    }

    let uuids: Vec<String> = uuid_rows.iter().map(|r| r.get::<String, _>("msg_uuid")).collect();

    // Fetch the actual message rows
    let msg_rows = sqlx::query(
        "SELECT id, msg_uuid, username, date, content, upload_id, row_index
         FROM messages WHERE msg_uuid = ANY($1) ORDER BY date ASC",
    )
    .bind(&uuids)
    .fetch_all(&state.db)
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let messages: Vec<Value> = msg_rows.into_iter().map(|r| {
        json!({
            "id":        r.get::<i64, _>("id"),
            "msg_uuid":  r.get::<String, _>("msg_uuid"),
            "username":  r.get::<String, _>("username"),
            "date":      r.get::<String, _>("date"),
            "content":   r.get::<String, _>("content"),
            "upload_id": r.get::<Option<String>, _>("upload_id"),
            "row_index": r.get::<Option<i64>, _>("row_index"),
        })
    }).collect();

    Ok(Json(json!(messages)))
}

/// Mirror of the prompt used by ai_service/main.py::gpt_label so on-demand
/// relabel produces stylistically-identical output (role-prefixed verb + subject).
async fn call_gpt_label(
    api_key: &str,
    keywords: &[String],
    samples: &[String],
    cluster_size: usize,
) -> Result<String, AppError> {
    let kw_str = keywords.iter().cloned().collect::<Vec<_>>().join(", ");
    let docs_str = samples.iter()
        .map(|d| {
            let truncated: String = d.chars().take(250).collect();
            format!("- {}", truncated)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let size_note = if cluster_size >= 30 {
        format!("This is a LARGE cluster ({cluster_size} messages). Look for the single most dominant theme rather than trying to cover everything — the label should describe what the majority of messages are about.")
    } else {
        format!("Cluster size: {cluster_size} messages.")
    };

    let prompt = format!(
        "You are labelling discussion topics from a Suno AI music generation Discord community.\n\n\
         Top keywords: {kw_str}\n\n\
         {size_note}\n\n\
         Sample messages (mix of core and edge examples from the cluster):\n{docs_str}\n\n\
         Write a concise topic label (4–8 words) that captures the DIRECTION of help, the action verb, and the subject.\n\n\
         STEP 1 — Determine the DIRECTION OF HELP by reading the messages carefully:\n\n\
         SHARING HELP (contributor) — the author is helping OTHERS:\n  \
         Signals: imperative instructions ('try this', 'go to Settings', 'make sure you'), \
         step-by-step directions, offering fixes or solutions, explaining how something works, \
         pointing others to resources, caring/supportive tone ('hope that helps', 'let me know if'), \
         troubleshooting guidance aimed at another person's problem.\n  \
         Verbs to use: Sharing / Explaining / Guiding / Recommending / Demonstrating / \
         Teaching / Providing / Offering / Helping troubleshoot / Walking through\n\n\
         SEEKING HELP (help-seeker) — the author needs help THEMSELVES:\n  \
         Signals: first-person confusion or struggle ('I can't', 'why doesn't this work', \
         'not working for me', 'I don't understand'), direct questions about their own problem, \
         reporting their own error or failure, requesting others to fix or explain something for them.\n  \
         Verbs to use: Asking about / Requesting / Seeking help with / Wondering about / \
         Struggling with / Reporting issues with\n\n\
         KEY RULE: A message about troubleshooting, fixing, or solving a problem \
         is SHARING HELP if the author is guiding or advising others. \
         It is SEEKING HELP only if the author is describing their OWN unresolved problem.\n\n\
         STEP 2 — Pick the specific subject (tool name, feature, workflow).\n\n\
         Format: <Verb> <specific subject>\n\
         Good examples:\n  \
         'Guiding troubleshooting audio export issues' (contributor giving directions)\n  \
         'Sharing prompt techniques for style control' (contributor teaching)\n  \
         'Asking about voice cloning with Bark' (seeker with their own problem)\n  \
         'Struggling with song length generation limits' (seeker reporting own issue)\n  \
         'Walking through Suno API setup steps' (contributor providing instructions)\n  \
         'Seeking help with account billing errors' (seeker needing assistance)\n\n\
         Return ONLY the label, no punctuation at the end, no explanation."
    );

    let body = json!({
        "model": "gpt-4o-mini",
        "temperature": 0.2,
        "max_tokens": 45,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client error: {}", e)))?;

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send().await
        .map_err(|e| AppError::Internal(format!("OpenAI request failed: {}", e)))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("OpenAI error: {}", err)));
    }

    let v: Value = resp.json().await
        .map_err(|e| AppError::Internal(format!("OpenAI parse error: {}", e)))?;

    let label = v["choices"][0]["message"]["content"]
        .as_str().unwrap_or("")
        .trim().trim_matches(|c| c == '"' || c == '\'').to_string();
    if label.is_empty() {
        return Err(AppError::Internal("OpenAI returned empty label".into()));
    }
    Ok(label)
}
