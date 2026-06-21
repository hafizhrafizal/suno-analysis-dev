use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};

fn key_from_header(headers: &HeaderMap) -> Option<String> {
    headers.get("x-openai-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from)
}
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use sqlx::QueryBuilder;
use crate::{error::{AppError, Result}, models::{AuthUser, BulkContextRequest}, state::AppState};

/// Build a PostgreSQL tsquery string from user input.
/// Each word is suffix-matched with `:*` (prefix search).
fn build_pg_tsquery(q: &str, match_type: &str) -> String {
    let tokens: Vec<String> = q
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| {
            // Keep only alphanumeric + hyphen/underscore to avoid breaking tsquery syntax
            let clean: String = w
                .chars()
                .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
                .collect::<String>()
                .to_lowercase();
            clean
        })
        .filter(|w| !w.is_empty())
        .map(|w| format!("{}:*", w))
        .collect();

    if tokens.is_empty() {
        return String::new();
    }

    match match_type {
        "exact" => tokens.join(" <-> "),  // adjacent phrase match
        "any_word" => tokens.join(" | "),
        _ => tokens.join(" & "),           // fuzzy: all word-prefixes AND
    }
}

#[derive(Debug, Deserialize)]
pub struct KeywordParams {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub upload_ids: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub is_suno_team: Option<String>,
    pub min_words: Option<i64>,
    pub match_type: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UsernameParams {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub is_suno_team: Option<String>,
    pub min_words: Option<i64>,
    pub upload_ids: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RangeParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub is_suno_team: Option<String>,
    pub min_words: Option<i64>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub upload_ids: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UserRangeParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
    pub is_suno_team: Option<String>,
    pub min_words: Option<i64>,
    pub min_messages: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UserMessagesParams {
    pub username: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub upload_ids: Option<String>,
}

pub async fn keyword_search(
    State(state): State<AppState>,
    Query(params): Query<KeywordParams>,
) -> Result<Json<Value>> {
    let q = params.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!([])));
    }
    let limit = params.limit.unwrap_or(1_000_000);
    let match_type = params.match_type.as_deref().unwrap_or("fuzzy");
    let use_fts = state.fts_ready.load(Ordering::Relaxed);

    let select = "SELECT m.id, m.msg_uuid, m.author_id, m.username, m.date, m.content,
                         m.attachments, m.reactions, m.is_suno_team, m.week, m.month,
                         m.upload_id, m.row_index
                  FROM messages m";

    let mut qb: QueryBuilder<sqlx::Postgres>;

    if use_fts {
        let tsquery = build_pg_tsquery(&q, match_type);
        if tsquery.is_empty() {
            return Ok(Json(json!([])));
        }
        qb = QueryBuilder::new(format!(
            "{} WHERE m.search_vector @@ to_tsquery('simple', ",
            select
        ));
        qb.push_bind(tsquery);
        qb.push(")");
    } else {
        // LIKE fallback while search_vector backfill is in progress
        let words: Vec<String> = q
            .split_whitespace()
            .filter(|w| !w.is_empty())
            .map(|w| w.to_string())
            .collect();

        qb = QueryBuilder::new(format!("{} WHERE 1=1", select));

        match match_type {
            "exact" => {
                qb.push(" AND m.content ILIKE ");
                qb.push_bind(format!("%{}%", q));
            }
            "any_word" => {
                if !words.is_empty() {
                    qb.push(" AND (");
                    for (i, w) in words.iter().enumerate() {
                        if i > 0 {
                            qb.push(" OR ");
                        }
                        qb.push("m.content ILIKE ");
                        qb.push_bind(format!("%{}%", w));
                    }
                    qb.push(")");
                }
            }
            _ => {
                for w in &words {
                    qb.push(" AND m.content ILIKE ");
                    qb.push_bind(format!("%{}%", w));
                }
            }
        }
    }

    // Common filters
    if let Some(ref df) = params.date_from {
        qb.push(" AND m.date >= ");
        qb.push_bind(df.clone());
    }
    if let Some(ref dt) = params.date_to {
        qb.push(" AND m.date <= ");
        qb.push_bind(dt.clone());
    }
    if let Some(ref st) = params.is_suno_team {
        match st.as_str() {
            "true" | "1" | "only" => {
                qb.push(" AND LOWER(m.is_suno_team) IN ('true','1')");
            }
            "exclude" | "false" | "0" => {
                qb.push(" AND (m.is_suno_team IS NULL OR LOWER(m.is_suno_team) NOT IN ('true','1'))");
            }
            _ => {}
        }
    }
    if let Some(mw) = params.min_words {
        if mw > 0 {
            qb.push(format!(
                " AND (length(m.content) - length(replace(m.content,' ','')) + 1) >= {}",
                mw
            ));
        }
    }
    if let Some(ref un) = params.username {
        if !un.is_empty() {
            qb.push(" AND m.username ILIKE ");
            qb.push_bind(format!("%{}%", un));
        }
    }
    if let Some(ref uid_str) = params.upload_ids {
        let ids: Vec<&str> = uid_str
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if !ids.is_empty() {
            qb.push(" AND m.upload_id IN (");
            let mut sep = qb.separated(", ");
            for id in &ids {
                sep.push_bind(id.to_string());
            }
            qb.push(")");
        }
    }

    qb.push(" ORDER BY m.date DESC LIMIT ");
    qb.push_bind(limit);

    let rows = qb.build().fetch_all(&state.db).await?;

    use sqlx::Row;
    let messages: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "msg_uuid": r.get::<String, _>("msg_uuid"),
                "author_id": r.get::<Option<String>, _>("author_id"),
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
                "attachments": r.get::<Option<String>, _>("attachments"),
                "reactions": r.get::<Option<String>, _>("reactions"),
                "is_suno_team": r.get::<Option<String>, _>("is_suno_team"),
                "upload_id": r.get::<Option<String>, _>("upload_id"),
                "row_index": r.get::<Option<i64>, _>("row_index"),
            })
        })
        .collect();

    Ok(Json(json!(messages)))
}

fn is_question_query(q: &str) -> bool {
    let lower = q.trim().to_lowercase();
    if lower.ends_with('?') {
        return true;
    }
    let starters = [
        "what ", "how ", "why ", "when ", "who ", "which ", "where ",
        "is ", "are ", "do ", "does ", "can ", "could ", "should ", "would ",
        "will ", "has ", "have ", "had ", "did ", "was ", "were ",
        "tell me", "explain ", "describe ", "find ", "show ", "list ",
    ];
    starters.iter().any(|s| lower.starts_with(s))
}

fn normalize_embedding(v: Vec<f64>) -> Vec<f64> {
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm == 0.0 {
        return v;
    }
    v.into_iter().map(|x| x / norm).collect()
}

fn blend_embeddings(a: &[f64], b: &[f64], w: f64) -> Vec<f64> {
    let blended: Vec<f64> = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| x * (1.0 - w) + y * w)
        .collect();
    normalize_embedding(blended)
}

async fn hyde_embed(api_key: &str, query: &str, embed_model: &str) -> Option<Vec<f64>> {
    let client = reqwest::Client::new();

    let chat: serde_json::Value = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&json!({
            "model": "gpt-4o-mini",
            "messages": [
                {
                    "role": "system",
                    "content": "You are searching a Discord community about Suno AI (an AI music generator). \
                                Given a search query, write 2-3 short, realistic Discord messages (~80 words total) \
                                that would directly and relevantly discuss or answer the query. \
                                Write only the message text, no usernames or metadata."
                },
                { "role": "user", "content": query }
            ],
            "max_tokens": 200,
            "temperature": 0.2,
        }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    let hypo_doc = chat["choices"][0]["message"]["content"].as_str()?.to_string();
    tracing::debug!("HyDE document: {}", &hypo_doc[..hypo_doc.len().min(120)]);

    let embed: serde_json::Value = client
        .post("https://api.openai.com/v1/embeddings")
        .bearer_auth(api_key)
        .json(&json!({ "model": embed_model, "input": hypo_doc }))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    let vec: Vec<f64> = embed["data"][0]["embedding"]
        .as_array()?
        .iter()
        .filter_map(|v| v.as_f64())
        .collect();

    if vec.is_empty() { None } else { Some(vec) }
}

async fn embed_query(api_key: &str, text: &str, model: &str) -> Result<Vec<f64>> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.openai.com/v1/embeddings")
        .bearer_auth(api_key)
        .json(&json!({ "model": model, "input": text }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("OpenAI embed request failed: {}", e)))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("OpenAI embed error: {}", err)));
    }

    let data: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("OpenAI embed parse error: {}", e)))?;

    let embedding = data["data"][0]["embedding"]
        .as_array()
        .ok_or_else(|| AppError::Internal("No embedding in OpenAI response".into()))?
        .iter()
        .filter_map(|v| v.as_f64())
        .collect();

    Ok(embedding)
}

#[derive(Debug, Deserialize)]
pub struct SemanticParams {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub upload_ids: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub is_suno_team: Option<String>,
    pub min_words: Option<i64>,
    pub username: Option<String>,
    pub sort_by: Option<String>,
}

pub async fn semantic_search(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Query(params): Query<SemanticParams>,
) -> Result<Json<Value>> {
    let q = params.q.as_deref().unwrap_or("").trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!([])));
    }
    let limit = params.limit.unwrap_or(20).min(200) as usize;

    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let embed_model = state.get_embedding_model();

    let is_question = is_question_query(&q);
    let word_count = q.split_whitespace().count();

    // Always run HyDE in parallel with the raw embed — it always helps when
    // comparing short queries against full-length Discord messages.
    // Blend weight controls how much the hypothetical doc steers the embedding:
    //   short keyword (≤3 words): lean heavily on HyDE (raw query is too sparse)
    //   question or medium phrase:  equal blend
    let hyde_weight = if word_count <= 3 { 0.75 } else { 0.55 };

    tracing::debug!(
        "Semantic: is_question={}, words={}, hyde_weight={}",
        is_question, word_count, hyde_weight
    );

    let (raw_res, hyde_opt) = tokio::join!(
        embed_query(&api_key, &q, &embed_model),
        hyde_embed(&api_key, &q, &embed_model)
    );
    let raw = normalize_embedding(raw_res?);
    let embedding = match hyde_opt {
        Some(hyde) => blend_embeddings(&raw, &normalize_embedding(hyde), hyde_weight),
        None => {
            tracing::warn!("HyDE failed — using raw query embedding");
            raw
        }
    };

    // Fetch more candidates than needed so post-filters have a large pool to work with.
    let n_results = (limit * 8).min(800);
    let client = reqwest::Client::new();

    // ── Qdrant search ─────────────────────────────────────────────────────────
    let url = format!(
        "{}/collections/{}/points/search",
        state.config.qdrant_url, state.config.qdrant_collection
    );
    let mut req = client.post(&url).json(&json!({
        "vector": embedding,
        "limit": n_results,
        "with_payload": true,
        "with_vector": false,
    }));
    if let Some(key) = &state.config.qdrant_api_key {
        req = req.header("api-key", key);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Qdrant unreachable: {}", e);
            return Ok(Json(json!({ "error": "Qdrant unavailable", "results": [] })));
        }
    };
    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        eprintln!("Qdrant error: {}", err);
        return Ok(Json(json!({ "error": format!("Qdrant error: {}", err), "results": [] })));
    }
    let data: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Qdrant parse error: {}", e);
            return Ok(Json(json!({ "error": "Qdrant response parse error", "results": [] })));
        }
    };
    let empty = vec![];
    let results = data["result"].as_array().unwrap_or(&empty);
    if results.is_empty() {
        return Ok(Json(json!([])));
    }
    let msg_uuids: Vec<String> = results
        .iter()
        .filter_map(|p| p["payload"]["msg_uuid"].as_str().map(String::from))
        .collect();
    let uuid_to_similarity: std::collections::HashMap<String, f64> = results
        .iter()
        .filter_map(|p| {
            let uuid = p["payload"]["msg_uuid"].as_str()?;
            let score = p["score"].as_f64()?;
            Some((uuid.to_string(), score.clamp(0.0, 1.0)))
        })
        .collect();

    let best_sim = uuid_to_similarity
        .values()
        .cloned()
        .fold(0.0_f64, f64::max);

    // Use a looser relative threshold — short queries produce lower absolute
    // similarity scores against long messages even when semantically relevant.
    let min_similarity = 0.15_f64.max(best_sim * 0.50);
    tracing::debug!(
        "Semantic: best_sim={:.3}, threshold={:.3}, words={}",
        best_sim, min_similarity, word_count
    );

    // Build IN clause with positional params
    let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, msg_uuid, author_id, username, date, content,
                attachments, reactions, is_suno_team, upload_id, row_index
         FROM messages WHERE msg_uuid IN (",
    );
    let mut sep = qb.separated(", ");
    for uuid in &msg_uuids {
        sep.push_bind(uuid.clone());
    }
    qb.push(")");
    let rows = qb.build().fetch_all(&state.db).await?;

    use sqlx::Row;
    use std::collections::HashMap;
    let mut row_map: HashMap<String, Value> = rows
        .into_iter()
        .map(|r| {
            let uuid: String = r.get("msg_uuid");
            let similarity = uuid_to_similarity.get(&uuid).copied();
            let val = json!({
                "id": r.get::<i64, _>("id"),
                "msg_uuid": uuid.clone(),
                "author_id": r.get::<Option<String>, _>("author_id"),
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
                "attachments": r.get::<Option<String>, _>("attachments"),
                "reactions": r.get::<Option<String>, _>("reactions"),
                "is_suno_team": r.get::<Option<String>, _>("is_suno_team"),
                "upload_id": r.get::<Option<String>, _>("upload_id"),
                "row_index": r.get::<Option<i64>, _>("row_index"),
                "similarity": similarity,
            });
            (uuid, val)
        })
        .collect();

    let mut messages: Vec<Value> = msg_uuids
        .iter()
        .filter_map(|uuid| row_map.remove(uuid))
        .filter(|m| {
            if let Some(sim) = m["similarity"].as_f64() {
                if sim < min_similarity {
                    return false;
                }
            }
            if let Some(ref df) = params.date_from {
                if m["date"].as_str().unwrap_or("") < df.as_str() {
                    return false;
                }
            }
            if let Some(ref dt) = params.date_to {
                if m["date"].as_str().unwrap_or("") > dt.as_str() {
                    return false;
                }
            }
            if let Some(ref un) = params.username {
                if !un.is_empty() {
                    let uname = m["username"].as_str().unwrap_or("").to_lowercase();
                    if !uname.contains(&un.to_lowercase()) {
                        return false;
                    }
                }
            }
            if let Some(ref st) = params.is_suno_team {
                let is_team =
                    matches!(m["is_suno_team"].as_str().unwrap_or("").to_lowercase().as_str(), "true" | "1");
                match st.as_str() {
                    "true" | "1" | "only" => {
                        if !is_team {
                            return false;
                        }
                    }
                    "exclude" | "false" | "0" => {
                        if is_team {
                            return false;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(mw) = params.min_words {
                if mw > 0 {
                    let word_count = m["content"]
                        .as_str()
                        .unwrap_or("")
                        .split_whitespace()
                        .count() as i64;
                    if word_count < mw {
                        return false;
                    }
                }
            }
            if let Some(ref uid_str) = params.upload_ids {
                let allowed: Vec<&str> = uid_str
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if !allowed.is_empty() {
                    let upload_id = m["upload_id"].as_str().unwrap_or("");
                    if !allowed.contains(&upload_id) {
                        return false;
                    }
                }
            }
            true
        })
        .take(limit)
        .collect();

    match params.sort_by.as_deref() {
        Some("date_asc") => messages.sort_by(|a, b| {
            a["date"]
                .as_str()
                .unwrap_or("")
                .cmp(b["date"].as_str().unwrap_or(""))
        }),
        Some("date_desc") => messages.sort_by(|a, b| {
            b["date"]
                .as_str()
                .unwrap_or("")
                .cmp(a["date"].as_str().unwrap_or(""))
        }),
        _ => {}
    }

    Ok(Json(json!(messages)))
}

pub async fn username_search(
    State(state): State<AppState>,
    Query(params): Query<UsernameParams>,
) -> Result<Json<Value>> {
    let q = params.q.unwrap_or_default();
    let limit = params.limit.unwrap_or(1_000_000);

    let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, msg_uuid, author_id, username, date, content,
                attachments, reactions, is_suno_team, upload_id, row_index
         FROM messages WHERE username ILIKE ",
    );
    qb.push_bind(format!("%{}%", q));

    if let Some(ref df) = params.date_from {
        qb.push(" AND date >= ");
        qb.push_bind(df.clone());
    }
    if let Some(ref dt) = params.date_to {
        qb.push(" AND date <= ");
        qb.push_bind(dt.clone());
    }
    if let Some(ref st) = params.is_suno_team {
        match st.as_str() {
            "true" | "1" | "only" => {
                qb.push(" AND LOWER(is_suno_team) IN ('true','1')");
            }
            "exclude" | "false" | "0" => {
                qb.push(" AND (is_suno_team IS NULL OR LOWER(is_suno_team) NOT IN ('true','1'))");
            }
            _ => {}
        }
    }
    if let Some(mw) = params.min_words {
        if mw > 0 {
            qb.push(format!(
                " AND (length(content) - length(replace(content,' ','')) + 1) >= {}",
                mw
            ));
        }
    }
    if let Some(ref uid_str) = params.upload_ids {
        let ids: Vec<&str> = uid_str
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if !ids.is_empty() {
            qb.push(" AND upload_id IN (");
            let mut sep = qb.separated(", ");
            for id in &ids {
                sep.push_bind(id.to_string());
            }
            qb.push(")");
        }
    }

    qb.push(" ORDER BY date ASC LIMIT ");
    qb.push_bind(limit);

    let rows = qb.build().fetch_all(&state.db).await?;

    let messages: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            use sqlx::Row;
            json!({
                "id": r.get::<i64, _>("id"),
                "msg_uuid": r.get::<String, _>("msg_uuid"),
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
                "is_suno_team": r.get::<Option<String>, _>("is_suno_team"),
                "upload_id": r.get::<Option<String>, _>("upload_id"),
                "row_index": r.get::<Option<i64>, _>("row_index"),
            })
        })
        .collect();

    Ok(Json(json!(messages)))
}

pub async fn range_search(
    State(state): State<AppState>,
    Query(params): Query<RangeParams>,
) -> Result<Json<Value>> {
    let offset = params.offset.unwrap_or(0);

    let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, msg_uuid, author_id, username, date, content,
                attachments, reactions, is_suno_team, upload_id, row_index
         FROM messages WHERE 1=1",
    );

    if let Some(ref df) = params.date_from {
        qb.push(" AND date >= ");
        qb.push_bind(df.clone());
    }
    if let Some(ref dt) = params.date_to {
        qb.push(" AND date <= ");
        qb.push_bind(dt.clone());
    }
    if let Some(ref st) = params.is_suno_team {
        match st.as_str() {
            "true" | "1" | "only" => {
                qb.push(" AND LOWER(is_suno_team) IN ('true','1')");
            }
            "exclude" | "false" | "0" => {
                qb.push(" AND (is_suno_team IS NULL OR LOWER(is_suno_team) NOT IN ('true','1'))");
            }
            _ => {}
        }
    }
    if let Some(mw) = params.min_words {
        if mw > 0 {
            qb.push(format!(
                " AND (length(content) - length(replace(content,' ','')) + 1) >= {}",
                mw
            ));
        }
    }
    if let Some(ref uid_str) = params.upload_ids {
        let ids: Vec<&str> = uid_str
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        if !ids.is_empty() {
            qb.push(" AND upload_id IN (");
            let mut sep = qb.separated(", ");
            for id in &ids {
                sep.push_bind(id.to_string());
            }
            qb.push(")");
        }
    }

    qb.push(" ORDER BY date ASC");
    if let Some(lim) = params.limit {
        qb.push(" LIMIT ");
        qb.push_bind(lim);
    }
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows = qb.build().fetch_all(&state.db).await?;

    let messages: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            use sqlx::Row;
            json!({
                "id": r.get::<i64, _>("id"),
                "msg_uuid": r.get::<String, _>("msg_uuid"),
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
                "is_suno_team": r.get::<Option<String>, _>("is_suno_team"),
                "upload_id": r.get::<Option<String>, _>("upload_id"),
                "row_index": r.get::<Option<i64>, _>("row_index"),
            })
        })
        .collect();

    Ok(Json(json!(messages)))
}

pub async fn users_in_range(
    State(state): State<AppState>,
    Query(params): Query<UserRangeParams>,
) -> Result<Json<Value>> {
    // Build the date filter string with $N placeholders.
    // The same $N indices are shared by the subquery and the outer WHERE,
    // so we bind each parameter exactly once.
    let mut filters = String::new();
    let mut args: Vec<String> = Vec::new();

    if let Some(ref df) = params.date_from {
        let n = args.len() + 1;
        filters.push_str(&format!(" AND date >= ${}", n));
        args.push(df.clone());
    }
    if let Some(ref dt) = params.date_to {
        let n = args.len() + 1;
        filters.push_str(&format!(" AND date <= ${}", n));
        args.push(dt.clone());
    }
    match params.is_suno_team.as_deref() {
        Some("only") => filters.push_str(" AND LOWER(is_suno_team) IN ('true', '1')"),
        Some("exclude") => filters.push_str(" AND LOWER(is_suno_team) NOT IN ('true', '1')"),
        _ => {}
    }
    if let Some(mw) = params.min_words {
        if mw > 0 {
            let n = args.len() + 1;
            filters.push_str(&format!(
                " AND COALESCE(word_count, length(content) - length(replace(content, ' ', '')) + 1) >= ${}", n
            ));
            args.push(mw.to_string());
        }
    }

    let upload_ids: Vec<String> = params.upload_ids.as_deref()
        .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();

    let mut upload_filter = String::new();
    if !upload_ids.is_empty() {
        let placeholders: Vec<String> = upload_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("${}", args.len() + i + 1))
            .collect();
        upload_filter = format!(" AND upload_id IN ({})", placeholders.join(", "));
        args.extend(upload_ids.iter().cloned());
    }

    let combined_filters = format!("{}{}", filters, upload_filter);

    let mut having_clause = String::new();
    if let Some(mm) = params.min_messages {
        if mm > 0 {
            let n = args.len() + 1;
            having_clause = format!(" HAVING COUNT(*) >= ${}", n);
            args.push(mm.to_string());
        }
    }

    let limit = params.limit.unwrap_or(1_000_000);
    let sql = format!(
        "WITH tw AS MATERIALIZED (
             SELECT COUNT(DISTINCT COALESCE(week,
                     TO_CHAR(NULLIF(date,'')::timestamp, 'IYYY-IW'))) AS total_weeks
             FROM messages
             WHERE 1=1{cf}
         )
         SELECT m.username,
                COUNT(*) AS message_count,
                MIN(m.date) AS first_date,
                MAX(m.date) AS last_date,
                ROUND(AVG(COALESCE(
                    m.word_count::float8,
                    (length(m.content) - length(replace(m.content, ' ', '')) + 1)::float8
                ))::numeric, 1)::float8 AS avg_words,
                COUNT(DISTINCT COALESCE(m.week,
                    TO_CHAR(NULLIF(m.date,'')::timestamp, 'IYYY-IW'))) AS weeks_active,
                MAX(CASE WHEN LOWER(m.is_suno_team) IN ('true', '1') THEN 1 ELSE 0 END)::bigint AS is_team,
                tw.total_weeks
         FROM messages m
         CROSS JOIN tw
         WHERE 1=1{cf}
         GROUP BY m.username, tw.total_weeks{having}
         ORDER BY message_count DESC
         LIMIT {limit}",
        cf = combined_filters,
        having = having_clause,
        limit = limit,
    );

    let mut q = sqlx::query(&sql);
    for a in &args {
        q = q.bind(a);
    }
    let rows = q.fetch_all(&state.db).await?;

    use sqlx::Row;
    let users: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let weeks_active: i64 = r.get("weeks_active");
            let total_weeks: i64 = r.get::<i64, _>("total_weeks").max(1);
            let pct_weeks =
                (weeks_active as f64 / total_weeks as f64 * 1000.0).round() / 10.0;
            json!({
                "username": r.get::<String, _>("username"),
                "total_messages": r.get::<i64, _>("message_count"),
                "first_date": r.get::<Option<String>, _>("first_date"),
                "last_date": r.get::<Option<String>, _>("last_date"),
                "avg_words": r.get::<Option<f64>, _>("avg_words").unwrap_or(0.0),
                "weeks_active": weeks_active,
                "total_weeks": total_weeks,
                "pct_weeks": pct_weeks,
                "is_suno_team": r.get::<i64, _>("is_team") == 1,
            })
        })
        .collect();

    Ok(Json(json!(users)))
}

pub async fn user_messages(
    State(state): State<AppState>,
    Query(params): Query<UserMessagesParams>,
) -> Result<Json<Value>> {
    let username = params.username.unwrap_or_default();
    let limit = params.limit.unwrap_or(1_000_000);
    let offset = params.offset.unwrap_or(0);

    let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, msg_uuid, author_id, username, date, content,
                attachments, reactions, is_suno_team, upload_id, row_index
         FROM messages WHERE username = ",
    );
    qb.push_bind(username);

    if let Some(ref uid_str) = params.upload_ids {
        let ids: Vec<&str> = uid_str
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !ids.is_empty() {
            qb.push(" AND upload_id IN (");
            let mut sep = qb.separated(", ");
            for id in &ids {
                sep.push_bind(id.to_string());
            }
            qb.push(")");
        }
    }

    qb.push(" ORDER BY date ASC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);

    let rows = qb.build().fetch_all(&state.db).await?;

    let messages: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            use sqlx::Row;
            json!({
                "id": r.get::<i64, _>("id"),
                "msg_uuid": r.get::<String, _>("msg_uuid"),
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
                "upload_id": r.get::<Option<String>, _>("upload_id"),
                "row_index": r.get::<Option<i64>, _>("row_index"),
            })
        })
        .collect();

    Ok(Json(json!(messages)))
}

pub async fn bulk_context(
    State(state): State<AppState>,
    Json(req): Json<BulkContextRequest>,
) -> Result<Json<Value>> {
    let context_size = req.context_size.unwrap_or(5);
    let mut results: Vec<Value> = Vec::new();

    for msg_id in &req.message_ids {
        let row = sqlx::query(
            "SELECT upload_id, row_index FROM messages WHERE id = $1",
        )
        .bind(msg_id)
        .fetch_optional(&state.db)
        .await?;

        if let Some(r) = row {
            use sqlx::Row;
            let upload_id: Option<String> = r.get("upload_id");
            let row_index: Option<i64> = r.get("row_index");

            if let (Some(uid), Some(ri)) = (upload_id, row_index) {
                let context_rows = sqlx::query(
                    "SELECT id, msg_uuid, username, date, content, row_index
                     FROM messages
                     WHERE upload_id = $1 AND row_index BETWEEN $2 AND $3
                     ORDER BY row_index ASC",
                )
                .bind(&uid)
                .bind(ri - context_size)
                .bind(ri + context_size)
                .fetch_all(&state.db)
                .await?;

                let context_msgs: Vec<Value> = context_rows
                    .into_iter()
                    .map(|cr| {
                        use sqlx::Row as R;
                        json!({
                            "id": cr.get::<i64, _>("id"),
                            "msg_uuid": cr.get::<String, _>("msg_uuid"),
                            "username": cr.get::<String, _>("username"),
                            "date": cr.get::<String, _>("date"),
                            "content": cr.get::<String, _>("content"),
                            "row_index": cr.get::<Option<i64>, _>("row_index"),
                            "is_target": cr.get::<i64, _>("id") == *msg_id,
                        })
                    })
                    .collect();

                results.push(json!({
                    "message_id": msg_id,
                    "context": context_msgs,
                }));
            }
        }
    }

    Ok(Json(json!(results)))
}

// ── CSV export ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ExportParams {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
}

pub async fn export_csv(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<ExportParams>,
) -> Result<Response<Body>> {
    use sqlx::Row;

    let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT id, msg_uuid, author_id, username, date, content, \
                attachments, reactions, is_suno_team, upload_id, row_index \
         FROM messages WHERE 1=1",
    );

    if let Some(ref df) = params.date_from {
        qb.push(" AND date >= ");
        qb.push_bind(df.clone());
    }
    if let Some(ref dt) = params.date_to {
        qb.push(" AND date <= ");
        qb.push_bind(dt.clone());
    }
    if let Some(ref uid_str) = params.upload_ids {
        let ids: Vec<&str> = uid_str
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if !ids.is_empty() {
            qb.push(" AND upload_id IN (");
            let mut sep = qb.separated(", ");
            for id in &ids { sep.push_bind(id.to_string()); }
            qb.push(")");
        }
    }
    qb.push(" ORDER BY date ASC");

    let rows = qb.build().fetch_all(&state.db).await?;

    fn csv_field(s: &str) -> String {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
    fn opt_field(o: &Option<String>) -> String {
        o.as_deref().map(csv_field).unwrap_or_default()
    }

    let mut csv =
        String::from("id,msg_uuid,author_id,username,date,content,attachments,reactions,is_suno_team,upload_id,row_index\r\n");

    for row in rows {
        let id: i64 = row.get("id");
        let msg_uuid: String = row.get("msg_uuid");
        let author_id: Option<String> = row.get("author_id");
        let username: String = row.get("username");
        let date: String = row.get("date");
        let content: String = row.get("content");
        let attachments: Option<String> = row.get("attachments");
        let reactions: Option<String> = row.get("reactions");
        let is_suno_team: Option<String> = row.get("is_suno_team");
        let upload_id: Option<String> = row.get("upload_id");
        let row_index: Option<i64> = row.get("row_index");

        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{}\r\n",
            id,
            csv_field(&msg_uuid),
            opt_field(&author_id),
            csv_field(&username),
            csv_field(&date),
            csv_field(&content),
            opt_field(&attachments),
            opt_field(&reactions),
            opt_field(&is_suno_team),
            opt_field(&upload_id),
            row_index.map(|v| v.to_string()).unwrap_or_default(),
        ));
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(header::CONTENT_DISPOSITION, "attachment; filename=\"chat_export.csv\"")
        .body(Body::from(csv))
        .map_err(|e| AppError::Internal(format!("Response build error: {}", e)))
}

/// POST /messages/emotions
/// Body: { "msg_uuids": ["uuid1", ...] }
/// Returns: { "uuid1": { "sentiment": "...", "dominant_emotion": "...", "top_emotions": [...] }, ... }
/// Aggregate already-saved message_emotions rows for a list of usernames.
/// Returns the same shape as /search/batch-sentiment so the frontend can
/// populate the stats table without re-running the AI service.
pub async fn stored_sentiment(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    use std::collections::HashMap;

    let usernames: Vec<String> = body["usernames"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if usernames.is_empty() {
        return Ok(Json(json!({ "results": [] })));
    }

    // Build positional args and optional filters (same pattern as user_batch_sentiment)
    let mut args: Vec<String> = usernames.clone();
    let un_placeholders: String = (1..=usernames.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");

    let mut filters = String::new();
    if let Some(df) = body["date_from"].as_str().filter(|s| !s.is_empty()) {
        filters.push_str(&format!(" AND m.date >= ${}", args.len() + 1));
        args.push(df.to_string());
    }
    if let Some(dt) = body["date_to"].as_str().filter(|s| !s.is_empty()) {
        filters.push_str(&format!(" AND m.date <= ${}", args.len() + 1));
        args.push(dt.to_string());
    }
    if let Some(uid_str) = body["upload_ids"].as_str().filter(|s| !s.is_empty()) {
        let ids: Vec<&str> = uid_str.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
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
         WHERE m.username IN ({un}) AND m.msg_uuid IS NOT NULL{filters} \
         ORDER BY m.username",
        un = un_placeholders,
        filters = filters,
    );

    let mut q = sqlx::query(&sql);
    for a in &args { q = q.bind(a.clone()); }
    let rows = q.fetch_all(&state.db).await?;

    // Aggregate: counts and label score sums per user and per sentiment bucket
    let mut user_counts: HashMap<String, (i64, i64, i64)> = HashMap::new();
    let mut user_label: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();
    let mut user_by_sent: HashMap<String, HashMap<String, HashMap<String, (f64, i64)>>> = HashMap::new();

    for row in &rows {
        let username: String = row.get("username");
        let sentiment: String = row.get("sentiment");
        let top_emotions: serde_json::Value = row.try_get("top_emotions").unwrap_or(json!([]));

        let e = user_counts.entry(username.clone()).or_insert((0, 0, 0));
        match sentiment.as_str() {
            "positive" => e.0 += 1,
            "negative" => e.1 += 1,
            _ => e.2 += 1,
        }

        if let Some(arr) = top_emotions.as_array() {
            let label_map = user_label.entry(username.clone()).or_default();
            let sent_map = user_by_sent
                .entry(username.clone()).or_default()
                .entry(sentiment.clone()).or_default();
            for em in arr {
                if let (Some(label), Some(score)) = (em["label"].as_str(), em["score"].as_f64()) {
                    let acc = label_map.entry(label.to_string()).or_insert((0.0, 0));
                    acc.0 += score; acc.1 += 1;
                    let sacc = sent_map.entry(label.to_string()).or_insert((0.0, 0));
                    sacc.0 += score; sacc.1 += 1;
                }
            }
        }
    }

    let sort_top3 = |label_map: &HashMap<String, (f64, i64)>| -> Vec<serde_json::Value> {
        let mut v: Vec<serde_json::Value> = label_map.iter().map(|(label, (sum, cnt))| {
            let avg = (sum / (*cnt as f64) * 1000.0).round() / 1000.0;
            json!({ "label": label, "score": avg })
        }).collect();
        v.sort_by(|a, b| b["score"].as_f64().unwrap_or(0.0)
            .partial_cmp(&a["score"].as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().take(3).collect()
    };

    let results: Vec<serde_json::Value> = usernames.iter().map(|u| {
        let (pos, neg, neu) = user_counts.get(u).copied().unwrap_or((0, 0, 0));
        let total = pos + neg + neu;
        if total == 0 {
            return json!({ "username": u, "positive": 0.0, "negative": 0.0, "neutral": 0.0, "analyzed": 0 });
        }
        let top_emotions = user_label.get(u).map(&sort_top3).unwrap_or_default();
        let empty_sent: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();
        let sent_data = user_by_sent.get(u).unwrap_or(&empty_sent);
        json!({
            "username": u,
            "positive": (pos as f64) / (total as f64),
            "negative": (neg as f64) / (total as f64),
            "neutral":  (neu as f64) / (total as f64),
            "analyzed": total,
            "top_emotions": top_emotions,
            "by_sentiment": {
                "positive": { "count": pos, "top_emotions": sent_data.get("positive").map(&sort_top3).unwrap_or_default() },
                "negative": { "count": neg, "top_emotions": sent_data.get("negative").map(&sort_top3).unwrap_or_default() },
                "neutral":  { "count": neu, "top_emotions": sent_data.get("neutral").map(&sort_top3).unwrap_or_default() },
            },
        })
    }).collect();

    Ok(Json(json!({ "results": results })))
}

pub async fn get_message_emotions(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let uuids: Vec<String> = body["msg_uuids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if uuids.is_empty() {
        return Ok(Json(json!({})));
    }

    let placeholders: String = (1..=uuids.len()).map(|i| format!("${}", i)).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT msg_uuid, sentiment, dominant_emotion, top_emotions \
         FROM message_emotions WHERE msg_uuid IN ({})",
        placeholders
    );

    let mut q = sqlx::query(&sql);
    for uuid in &uuids { q = q.bind(uuid.clone()); }
    let rows = q.fetch_all(&state.db).await?;

    let mut out = serde_json::Map::new();
    for row in rows {
        let uuid: String = row.get("msg_uuid");
        let sentiment: String = row.get("sentiment");
        let dominant: String = row.get("dominant_emotion");
        let top_emotions: serde_json::Value = row.try_get("top_emotions").unwrap_or(json!([]));
        out.insert(uuid, json!({
            "sentiment": sentiment,
            "dominant_emotion": dominant,
            "top_emotions": top_emotions,
        }));
    }

    Ok(Json(Value::Object(out)))
}
