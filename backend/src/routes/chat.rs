use axum::{
    extract::State,
    http::HeaderMap,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    Json,
};

fn key_from_header(headers: &HeaderMap) -> Option<String> {
    headers.get("x-openai-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Retry an ai_service request up to 5 times with jittered exponential back-off.
/// `make_req` is called fresh each attempt so headers/body are re-attached.
/// Retries on connection errors, HTTP 503 (overloaded) and HTTP 504 (timeout).
/// Jitter prevents a thundering herd when multiple browser tabs retry simultaneously.
async fn ai_retry<F>(mut make_req: F) -> Result<reqwest::Response, reqwest::Error>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    // Base delays in ms; actual delay = base + random [0, base/2)
    const BASE_DELAYS_MS: [u64; 5] = [500, 1_500, 3_000, 6_000, 12_000];
    let mut last_err: Option<reqwest::Error> = None;
    let mut last_reason: String = String::from("unknown");
    for (attempt, &base_ms) in std::iter::once(&0u64).chain(BASE_DELAYS_MS.iter()).enumerate() {
        if attempt > 0 {
            let jitter_ms = rand::random::<u64>() % (base_ms / 2 + 1);
            let delay_ms = base_ms + jitter_ms;
            tracing::warn!(
                "ai_service {} (attempt {}/{}), retrying in {:.1}s…",
                last_reason, attempt, BASE_DELAYS_MS.len(), delay_ms as f64 / 1000.0
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }
        match make_req().send().await {
            Ok(resp) if matches!(resp.status().as_u16(), 503 | 504) => {
                last_reason = format!("HTTP {}", resp.status().as_u16());
                if attempt < BASE_DELAYS_MS.len() { continue; }
                return Ok(resp);
            }
            Ok(resp) => return Ok(resp),
            Err(e) if e.is_connect() || e.is_request() || e.is_timeout() => {
                last_reason = if e.is_timeout() { "client timeout (no response in 600s)".into() }
                    else if e.is_connect() { "connection refused (ai_service down?)".into() }
                    else { format!("request error: {}", e) };
                last_err = Some(e);
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap())
}

/// Bulk-upsert a batch of (uuid, dominant, sentiment, top_emotions_json) into
/// `message_emotions`.  Used by the SSE stream to write per-chunk results
/// incrementally so a crash mid-stream leaves the analyzed messages persisted
/// — the next "Analyze New Only" run picks up where it left off.
async fn upsert_message_emotions(
    db: &sqlx::PgPool,
    rows: &[(String, String, String, String)],
) -> Result<(), sqlx::Error> {
    if rows.is_empty() { return Ok(()); }
    let uuids:      Vec<String> = rows.iter().map(|(u,_,_,_)| u.clone()).collect();
    let dominants:  Vec<String> = rows.iter().map(|(_,d,_,_)| d.clone()).collect();
    let sentiments: Vec<String> = rows.iter().map(|(_,_,s,_)| s.clone()).collect();
    let top_jsons:  Vec<String> = rows.iter().map(|(_,_,_,j)| j.clone()).collect();
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO message_emotions (msg_uuid, dominant_emotion, sentiment, top_emotions) \
         SELECT u, d, s, j::jsonb \
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(u, d, s, j) \
         ON CONFLICT (msg_uuid) DO UPDATE \
         SET dominant_emotion = EXCLUDED.dominant_emotion, \
             sentiment = EXCLUDED.sentiment, \
             top_emotions = EXCLUDED.top_emotions, \
             analyzed_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
    )
    .bind(uuids).bind(dominants).bind(sentiments).bind(top_jsons)
    .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
use serde_json::json;
use std::convert::Infallible;
use crate::{
    error::AppError,
    models::{
        AuthUser, ChatRequest, StrategyRequest, SummarizeFollowupRequest, SummarizeMsg,
        SummarizeRequest, SummarizeResultsFollowupRequest, SummarizeResultsRequest,
        UserProfileFollowupRequest, UserProfileRequest, UserTopicsRequest,
    },
    prompts,
    state::{AppState, AI_CONCURRENCY},
};

fn format_messages_as_context(
    rows: &[serde_json::Value],
) -> String {
    rows.iter()
        .enumerate()
        .map(|(i, m)| {
            let username = m["username"].as_str().unwrap_or("unknown");
            let date = m["date"].as_str().unwrap_or("");
            let content = m["content"].as_str().unwrap_or("");
            format!("[{}] {} ({}): {}", i + 1, username, date, content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_messages_as_context_slim(msgs: &[SummarizeMsg]) -> String {
    msgs.iter()
        .enumerate()
        .map(|(i, m)| format!("[{}] {} ({}): {}", i + 1, m.username, m.date, m.content))
        .collect::<Vec<_>>()
        .join("\n")
}

fn log_event(step: &str, label: &str, message: &str) -> Event {
    Event::default().data(
        serde_json::to_string(&json!({
            "type": "log",
            "step": step,
            "label": label,
            "message": message,
        }))
        .unwrap(),
    )
}

fn dedup_messages(msgs: Vec<SummarizeMsg>) -> (Vec<SummarizeMsg>, usize) {
    let mut seen = std::collections::HashSet::new();
    let before = msgs.len();
    let deduped = msgs
        .into_iter()
        .filter(|m| seen.insert(m.content.trim().to_lowercase()))
        .collect::<Vec<_>>();
    let removed = before - deduped.len();
    (deduped, removed)
}

/// Convert any msg_uuid to a Qdrant-compatible UUID string (mirrors uploads.rs logic).
fn to_qdrant_id(id: &str) -> String {
    if uuid::Uuid::parse_str(id).is_ok() {
        id.to_string()
    } else {
        uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, id.as_bytes()).to_string()
    }
}

/// Fetch embeddings from Qdrant for the given msg_uuids.
/// Converts IDs to Qdrant UUID form for the lookup, then reads original msg_uuid
/// back from the point payload so the returned keys match the database values.
async fn fetch_embeddings_qdrant(
    qdrant_url: &str,
    collection: &str,
    api_key: Option<&str>,
    uuids: &[String],
) -> Option<Vec<(String, Vec<f32>)>> {
    let client = reqwest::Client::new();
    // /points/get is the correct endpoint for fetching points by ID
    let url = format!("{}/collections/{}/points/get", qdrant_url, collection);
    let qdrant_ids: Vec<String> = uuids.iter().map(|id| to_qdrant_id(id)).collect();
    let mut req = client.post(&url).json(&serde_json::json!({
        "ids": qdrant_ids,
        "with_vectors": true,
        "with_payload": true,  // needed to read back original msg_uuid
    }));
    if let Some(key) = api_key { req = req.header("api-key", key); }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() { return None; }
    let body: serde_json::Value = resp.json().await.ok()?;
    let points = body["result"].as_array()?;
    let result: Vec<(String, Vec<f32>)> = points
        .iter()
        .filter_map(|p| {
            // Use payload.msg_uuid (original ID) as the map key so callers can
            // look up by the same msg_uuid values they have from the database
            let id = p["payload"]["msg_uuid"].as_str()
                .or_else(|| p["id"].as_str())
                .map(String::from)?;
            let vec: Vec<f32> = p["vector"]
                .as_array()?
                .iter()
                .filter_map(|v| v.as_f64().map(|x| x as f32))
                .collect();
            if vec.is_empty() { None } else { Some((id, vec)) }
        })
        .collect();
    Some(result)
}

async fn retrieve_keyword_messages(
    state: &AppState,
    query: &str,
    limit: i64,
) -> Vec<serde_json::Value> {
    if query.is_empty() {
        return vec![];
    }
    let rows = sqlx::query(
        "SELECT id, msg_uuid, username, date, content
         FROM messages
         WHERE search_vector @@ plainto_tsquery('simple', $1)
         ORDER BY date DESC
         LIMIT $2",
    )
    .bind(query)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    rows.into_iter()
        .map(|r| {
            use sqlx::Row;
            json!({
                "id": r.get::<i64, _>("id"),
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
            })
        })
        .collect()
}

async fn call_openai_stream(
    api_key: &str,
    system_prompt: &str,
    user_message: &str,
    model: &str,
) -> Result<impl futures::Stream<Item = Result<Event, Infallible>>, AppError> {
    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "stream": true,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_message }
        ]
    });

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("OpenAI request failed: {}", e)))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("OpenAI error: {}", err_text)));
    }

    use futures::StreamExt;
    let byte_stream = resp.bytes_stream();

    let event_stream = async_stream::stream! {
        let mut buf = String::new();
        tokio::pin!(byte_stream);

        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(_) => break,
            };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            let parts: Vec<&str> = buf.split("\n\n").collect();
            let last = parts.last().map(|s| s.to_string()).unwrap_or_default();

            for part in &parts[..parts.len().saturating_sub(1)] {
                let line = part.trim();
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        yield Ok(Event::default().data(
                            serde_json::to_string(&json!({"type":"done","sources":[]})).unwrap()
                        ));
                        return;
                    }
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(content) = parsed["choices"][0]["delta"]["content"].as_str() {
                            if !content.is_empty() {
                                yield Ok(Event::default().data(
                                    serde_json::to_string(&json!({"type":"chunk","content": content})).unwrap()
                                ));
                            }
                        }
                    }
                }
            }
            buf = last;
        }

        yield Ok(Event::default().data(
            serde_json::to_string(&json!({"type":"done","sources":[]})).unwrap()
        ));
    };

    Ok(event_stream)
}

pub async fn chat(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<ChatRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let messages = retrieve_keyword_messages(&state, &req.query, 10).await;
    let context = format_messages_as_context(&messages);

    let system = req
        .system_prompt
        .clone()
        .unwrap_or_else(|| prompts::CHAT.replace("{context}", &context));

    let event_stream = call_openai_stream(&api_key, &system, &req.query, "gpt-4o").await?;
    Ok(Sse::new(event_stream))
}

pub async fn summarize(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<SummarizeRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let messages = retrieve_keyword_messages(&state, &req.query, 20).await;
    let context = format_messages_as_context(&messages);
    let system = prompts::SUMMARIZE.replace("{context}", &context);

    let event_stream = call_openai_stream(&api_key, &system, &req.query, "gpt-4o").await?;
    Ok(Sse::new(event_stream))
}

pub async fn summarize_followup(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<SummarizeFollowupRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let messages = retrieve_keyword_messages(&state, &req.query, 10).await;
    let context = format_messages_as_context(&messages);
    let system = prompts::SUMMARIZE_FOLLOWUP
        .replace("{context}", &context)
        .replace("{previous_summary}", &req.previous_summary);

    let event_stream = call_openai_stream(&api_key, &system, &req.query, "gpt-4o").await?;
    Ok(Sse::new(event_stream))
}

pub async fn summarize_results(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<SummarizeResultsRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let query = req.query.or(req.prompt).unwrap_or_default();
    let model = req.model.unwrap_or_else(|| "gpt-4o".to_string());
    let retrieval_mode = req.retrieval_mode.unwrap_or_else(|| "cluster".to_string());
    let input_messages = req.messages;
    let qdrant_url = state.config.qdrant_url.clone();
    let qdrant_collection = state.config.qdrant_collection.clone();
    let qdrant_api_key = state.config.qdrant_api_key.clone();

    let stream = async_stream::stream! {
        use futures::StreamExt;
        use crate::hdbscan;

        // ── Step 1: Filter ──────────────────────────────────────────────────
        let total = input_messages.len();
        yield Ok(log_event("filter", "Filter", &format!("{} messages received", total)));
        if total == 0 {
            yield Ok(log_event("fallback", "Warning", "No messages to analyse"));
            return;
        }

        // ── Step 2: Dedup ───────────────────────────────────────────────────
        let (deduped, removed) = dedup_messages(input_messages);
        if removed > 0 {
            yield Ok(log_event("dedup", "Dedup",
                &format!("Removed {} duplicates — {} unique messages remain", removed, deduped.len())));
        } else {
            yield Ok(log_event("dedup", "Dedup",
                &format!("{} messages (no duplicates)", deduped.len())));
        }

        // ── Step 3: Cluster or all ──────────────────────────────────────────
        let final_msgs: Vec<SummarizeMsg> = if retrieval_mode == "cluster" {
            let n = deduped.len();
            let min_cs = 3usize.min(n / 4).max(2);

            // Try to fetch embeddings from ChromaDB
            let uuids: Vec<String> = deduped.iter()
                .filter_map(|m| m.msg_uuid.clone())
                .collect();
            let has_uuids = !uuids.is_empty();

            if has_uuids {
                yield Ok(log_event("retrieval", "Retrieval",
                    &format!("Fetching embeddings for {} messages from Qdrant…", uuids.len())));
            }

            let embedding_map: std::collections::HashMap<String, Vec<f32>> = if has_uuids {
                match fetch_embeddings_qdrant(
                    &qdrant_url, &qdrant_collection, qdrant_api_key.as_deref(), &uuids,
                ).await {
                    Some(pairs) => pairs.into_iter().collect(),
                    None => {
                        yield Ok(log_event("fallback", "Warning",
                            "Could not fetch embeddings from Qdrant — falling back to word-count sampling"));
                        std::collections::HashMap::new()
                    }
                }
            } else {
                yield Ok(log_event("fallback", "Warning",
                    "No UUIDs in messages — falling back to word-count sampling"));
                std::collections::HashMap::new()
            };

            // Build embedding matrix aligned to deduped
            let embeddings: Vec<Option<Vec<f32>>> = deduped.iter()
                .map(|m| m.msg_uuid.as_deref().and_then(|u| embedding_map.get(u)).cloned())
                .collect();

            let embedded_indices: Vec<usize> = embeddings.iter().enumerate()
                .filter_map(|(i, e)| e.as_ref().map(|_| i))
                .collect();
            let embedded_vecs: Vec<Vec<f32>> = embedded_indices.iter()
                .filter_map(|&i| embeddings[i].clone())
                .collect();

            if embedded_vecs.len() >= min_cs * 2 {
                // ── HDBSCAN ────────────────────────────────────────────────
                yield Ok(log_event("cluster", "Cluster",
                    &format!("Running HDBSCAN on {} embedded messages (min_cluster_size={})",
                        embedded_vecs.len(), min_cs)));

                let labels = hdbscan::hdbscan(&embedded_vecs, min_cs);
                let n_clusters = {
                    let mut ids: Vec<i32> = labels.iter().filter(|&&l| l >= 0).cloned().collect();
                    ids.sort_unstable();
                    ids.dedup();
                    ids.len()
                };
                let n_noise = labels.iter().filter(|&&l| l < 0).count();
                yield Ok(log_event("cluster", "Cluster",
                    &format!("Found {} clusters ({} noise points)", n_clusters, n_noise)));

                // ── Sample: closest + furthest from each cluster centroid ──
                let mut sampled_embedded_indices: Vec<usize> = Vec::new();
                let max_label = labels.iter().filter(|&&l| l >= 0).copied().max().unwrap_or(-1);
                for cluster_id in 0..=(max_label as usize) {
                    let members: Vec<usize> = labels.iter().enumerate()
                        .filter(|(_, &l)| l == cluster_id as i32)
                        .map(|(local_i, _)| local_i)
                        .collect();
                    if members.is_empty() { continue; }
                    if let Some((closest, furthest)) = hdbscan::closest_and_furthest(&embedded_vecs, &members) {
                        sampled_embedded_indices.push(closest);
                        if furthest != closest {
                            sampled_embedded_indices.push(furthest);
                        }
                    }
                }
                // Also include noise points (1 per noise, capped)
                let noise_local: Vec<usize> = labels.iter().enumerate()
                    .filter(|(_, &l)| l < 0)
                    .map(|(i, _)| i)
                    .take(5)
                    .collect();
                sampled_embedded_indices.extend(noise_local);
                sampled_embedded_indices.sort_unstable();
                sampled_embedded_indices.dedup();

                yield Ok(log_event("sample", "Sample",
                    &format!("Selected {} messages (closest + furthest from each cluster centroid)",
                        sampled_embedded_indices.len())));

                // Map local embedded indices → indices in deduped
                sampled_embedded_indices.iter()
                    .map(|&local_i| deduped[embedded_indices[local_i]].clone())
                    .collect()
            } else {
                // Not enough embeddings — fall back to word-count top-N per time window
                yield Ok(log_event("fallback", "Warning",
                    "Too few embeddings for HDBSCAN — using word-count sampling"));
                let cap = 60usize;
                let mut msgs = deduped.clone();
                msgs.sort_by(|a, b| a.date.cmp(&b.date));
                let n_buckets = ((msgs.len() / 5).max(2)).min(10);
                let bucket_sz = (msgs.len() + n_buckets - 1) / n_buckets;
                let per_bucket = ((cap + n_buckets - 1) / n_buckets).max(1);
                let mut result = Vec::new();
                for bucket in msgs.chunks(bucket_sz) {
                    let mut b: Vec<&SummarizeMsg> = bucket.iter().collect();
                    b.sort_by_key(|m| std::cmp::Reverse(m.content.split_whitespace().count()));
                    result.extend(b.into_iter().take(per_bucket).cloned());
                }
                result
            }
        } else {
            // "all" mode
            let cap = 200usize;
            let n = deduped.len().min(cap);
            if deduped.len() > cap {
                yield Ok(log_event("retrieval", "Retrieval",
                    &format!("Using all messages (capped at {})", cap)));
            } else {
                yield Ok(log_event("retrieval", "Retrieval",
                    &format!("Using all {} messages as context", n)));
            }
            deduped.into_iter().take(cap).collect()
        };

        // ── Step 4: LLM ─────────────────────────────────────────────────────
        let n_final = final_msgs.len();
        yield Ok(log_event("llm", "LLM",
            &format!("Sending {} messages to {} for analysis…", n_final, model)));

        let context = format_messages_as_context_slim(&final_msgs);
        let prompt = if query.is_empty() {
            "Summarize the key themes, notable discussions, and important insights from these messages.".to_string()
        } else {
            query.clone()
        };
        let system = prompts::SUMMARIZE.replace("{context}", &context);

        match call_openai_stream(&api_key, &system, &prompt, &model).await {
            Ok(llm_stream) => {
                tokio::pin!(llm_stream);
                while let Some(ev) = llm_stream.next().await {
                    yield ev;
                }
            }
            Err(e) => {
                yield Ok(log_event("fallback", "Error", &e.to_string()));
            }
        }
    };

    Ok(Sse::new(stream))
}

pub async fn summarize_results_followup(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<SummarizeResultsFollowupRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let query = req.query.or(req.question).unwrap_or_default();
    let previous_summary = req.previous_summary.or(req.summary).unwrap_or_default();

    let context = if let Some(msgs) = &req.messages {
        format_messages_as_context_slim(msgs)
    } else {
        String::new()
    };
    let system = prompts::SUMMARIZE_FOLLOWUP
        .replace("{context}", &context)
        .replace("{previous_summary}", &previous_summary);

    let event_stream = call_openai_stream(&api_key, &system, &query, "gpt-4o").await?;
    Ok(Sse::new(event_stream))
}

pub async fn user_profile(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<UserProfileRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let rows = sqlx::query(
        "SELECT username, date, content FROM messages WHERE username = ? ORDER BY date ASC LIMIT 50",
    )
    .bind(&req.username)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    let msgs_json: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            use sqlx::Row;
            json!({
                "username": r.get::<String, _>("username"),
                "date": r.get::<String, _>("date"),
                "content": r.get::<String, _>("content"),
            })
        })
        .collect();

    let context = format_messages_as_context(&msgs_json);
    let system = prompts::USER_PROFILE
        .replace("{username}", &req.username)
        .replace("{context}", &context);
    let user_msg = req
        .query
        .as_deref()
        .unwrap_or("Please analyze this user's profile.");

    let event_stream = call_openai_stream(&api_key, &system, user_msg, "gpt-4o").await?;
    Ok(Sse::new(event_stream))
}

pub async fn user_profile_followup(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<UserProfileFollowupRequest>,
) -> Result<impl IntoResponse, AppError> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let system = prompts::USER_PROFILE_FOLLOWUP
        .replace("{previous_profile}", &req.previous_profile);

    let event_stream = call_openai_stream(&api_key, &system, &req.query, "gpt-4o").await?;
    Ok(Sse::new(event_stream))
}

pub async fn user_topics_stream(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<UserTopicsRequest>,
) -> impl IntoResponse {
    let s = async_stream::stream! {
        macro_rules! emit {
            ($val:expr) => {{
                let line = serde_json::to_string(&$val).unwrap_or_default();
                yield Ok::<Event, Infallible>(Event::default().data(line));
            }};
        }

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                emit!(json!({"stage":"error","status":"error","message": format!("HTTP client error: {}", e)}));
                return;
            }
        };

        // Stage 1: prepare
        emit!(json!({
            "stage": "prepare",
            "status": "done",
            "message": format!("Collected {} messages", req.docs.len())
        }));

        // Stage 2: fetch embeddings
        let n_batches = (req.msg_uuids.len().saturating_add(249)) / 250;
        emit!(json!({
            "stage": "fetch_embeddings",
            "status": "running",
            "message": format!("Fetching embeddings from Qdrant ({} batch{})…",
                n_batches, if n_batches == 1 { "" } else { "es" })
        }));

        let mut uuid_to_vector: std::collections::HashMap<String, Vec<f64>> =
            std::collections::HashMap::new();

        // Fetch all embedding chunks concurrently instead of sequentially
        let scroll_url = format!(
            "{}/collections/{}/points/scroll",
            state.config.qdrant_url, state.config.qdrant_collection
        );
        let chunk_bodies: Vec<serde_json::Value> = req.msg_uuids.chunks(250).map(|chunk| {
            json!({
                "filter": {
                    "must": [{ "key": "msg_uuid", "match": { "any": chunk } }]
                },
                "with_payload": true,
                "with_vector": true,
                "limit": chunk.len()
            })
        }).collect();
        let fetch_futs: Vec<_> = chunk_bodies.into_iter().map(|body| {
            let url = scroll_url.clone();
            let api_key = state.config.qdrant_api_key.clone();
            let mut req_b = client.post(&url).json(&body);
            if let Some(ref key) = api_key {
                req_b = req_b.header("api-key", key.as_str());
            }
            async move {
                match req_b.send().await {
                    Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
                    Err(_) => None,
                }
            }
        }).collect();
        for data_opt in futures::future::join_all(fetch_futs).await.into_iter().flatten() {
            if let Some(points) = data_opt["result"]["points"].as_array() {
                for point in points {
                    if let (Some(uuid), Some(vector)) = (
                        point["payload"]["msg_uuid"].as_str(),
                        point["vector"].as_array(),
                    ) {
                        let vec: Vec<f64> =
                            vector.iter().filter_map(|v| v.as_f64()).collect();
                        uuid_to_vector.insert(uuid.to_string(), vec);
                    }
                }
            }
        }

        emit!(json!({
            "stage": "fetch_embeddings",
            "status": "done",
            "message": format!("Retrieved {} of {} embeddings",
                uuid_to_vector.len(), req.msg_uuids.len())
        }));

        // Stage 3: align docs
        let mut docs_out: Vec<&str> = Vec::new();
        let mut embeddings_out: Vec<Vec<f64>> = Vec::new();
        let mut uuids_out: Vec<&str> = Vec::new();
        for (doc, uuid) in req.docs.iter().zip(req.msg_uuids.iter()) {
            if let Some(vec) = uuid_to_vector.get(uuid) {
                docs_out.push(doc.as_str());
                embeddings_out.push(vec.clone());
                uuids_out.push(uuid.as_str());
            }
        }
        let dropped = req.docs.len().saturating_sub(docs_out.len());

        emit!(json!({
            "stage": "align_docs",
            "status": "done",
            "message": if dropped > 0 {
                format!("Kept {} doc-embedding pairs ({} without embedding)", docs_out.len(), dropped)
            } else {
                format!("Aligned all {} doc-embedding pairs", docs_out.len())
            }
        }));

        // Stage 4: BERTopic
        let using_embeddings = !embeddings_out.is_empty();
        let bertopic_payload = if using_embeddings {
            json!({ "docs": docs_out, "embeddings": embeddings_out, "msg_uuids": uuids_out })
        } else {
            json!({ "docs": req.docs, "msg_uuids": req.msg_uuids })
        };

        emit!(json!({
            "stage": "bertopic",
            "status": "running",
            "message": if using_embeddings {
                "Running BERTopic with pre-computed embeddings…"
            } else {
                "Running BERTopic (computing embeddings on service)…"
            }
        }));

        let ai_service_url = format!("{}/topics", state.config.ai_service_url);
        let resp = match ai_retry(|| client.post(&ai_service_url).json(&bertopic_payload)).await {
            Ok(r) => r,
            Err(e) => {
                emit!(json!({"stage":"bertopic","status":"error",
                    "message": format!("AI service unreachable: {}", e)}));
                return;
            }
        };

        if !resp.status().is_success() {
            let err = resp.text().await.unwrap_or_default();
            emit!(json!({"stage":"bertopic","status":"error",
                "message": format!("BERTopic error: {}", err)}));
            return;
        }

        let result: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                emit!(json!({"stage":"bertopic","status":"error",
                    "message": format!("Response parse error: {}", e)}));
                return;
            }
        };

        let n_topics = result["topics"].as_array().map(|a| a.len()).unwrap_or(0);
        let used_openai = result["used_openai_labels"].as_bool().unwrap_or(false);
        let used_precomputed = result["used_precomputed_embeddings"].as_bool().unwrap_or(false);

        emit!(json!({
            "stage": "bertopic",
            "status": "done",
            "message": format!("Found {} topic{}{}",
                n_topics,
                if n_topics == 1 { "" } else { "s" },
                if used_openai { " · labels generated by GPT" } else { "" }
            ),
            "used_precomputed": used_precomputed
        }));

        // Stage 5: complete — carry the full result
        emit!(json!({
            "stage": "complete",
            "status": "done",
            "message": "Analysis complete",
            "result": result
        }));

        yield Ok(Event::default().data("[DONE]"));
    };

    Sse::new(s).keep_alive(axum::response::sse::KeepAlive::default())
}

pub async fn user_topics(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<UserTopicsRequest>,
) -> crate::error::Result<Json<serde_json::Value>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client error: {}", e)))?;

    // Fetch pre-computed embeddings from Qdrant in batches of 250
    let mut uuid_to_vector: std::collections::HashMap<String, Vec<f64>> =
        std::collections::HashMap::new();

    // Fetch all embedding chunks concurrently instead of sequentially
    let scroll_url = format!(
        "{}/collections/{}/points/scroll",
        state.config.qdrant_url, state.config.qdrant_collection
    );
    let chunk_bodies: Vec<serde_json::Value> = req.msg_uuids.chunks(250).map(|chunk| {
        json!({
            "filter": {
                "must": [{ "key": "msg_uuid", "match": { "any": chunk } }]
            },
            "with_payload": true,
            "with_vector": true,
            "limit": chunk.len()
        })
    }).collect();
    let fetch_futs: Vec<_> = chunk_bodies.into_iter().map(|body| {
        let url = scroll_url.clone();
        let api_key = state.config.qdrant_api_key.clone();
        let mut req_b = client.post(&url).json(&body);
        if let Some(ref key) = api_key {
            req_b = req_b.header("api-key", key.as_str());
        }
        async move {
            match req_b.send().await {
                Ok(resp) => resp.json::<serde_json::Value>().await.ok(),
                Err(_) => None,
            }
        }
    }).collect();
    for data_opt in futures::future::join_all(fetch_futs).await.into_iter().flatten() {
        if let Some(points) = data_opt["result"]["points"].as_array() {
            for point in points {
                if let (Some(uuid), Some(vector)) = (
                    point["payload"]["msg_uuid"].as_str(),
                    point["vector"].as_array(),
                ) {
                    let vec: Vec<f64> =
                        vector.iter().filter_map(|v| v.as_f64()).collect();
                    uuid_to_vector.insert(uuid.to_string(), vec);
                }
            }
        }
    }

    // Pair docs with their embeddings; drop any doc whose UUID wasn't found
    let mut docs_out: Vec<&str> = Vec::new();
    let mut embeddings_out: Vec<Vec<f64>> = Vec::new();
    let mut uuids_out: Vec<&str> = Vec::new();
    for (doc, uuid) in req.docs.iter().zip(req.msg_uuids.iter()) {
        if let Some(vec) = uuid_to_vector.get(uuid) {
            docs_out.push(doc.as_str());
            embeddings_out.push(vec.clone());
            uuids_out.push(uuid.as_str());
        }
    }

    // Build BERTopic payload — include embeddings and uuids if available
    let bertopic_payload = if embeddings_out.is_empty() {
        json!({ "docs": req.docs, "msg_uuids": req.msg_uuids })
    } else {
        json!({ "docs": docs_out, "embeddings": embeddings_out, "msg_uuids": uuids_out })
    };

    let ai_service_url = format!("{}/topics", state.config.ai_service_url);
    let resp = ai_retry(|| client.post(&ai_service_url).json(&bertopic_payload))
        .await
        .map_err(|e| AppError::Internal(format!("AI service unreachable: {}", e)))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("AI service error: {}", err)));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("AI service response parse error: {}", e)))?;

    Ok(Json(result))
}

#[derive(Debug, serde::Deserialize)]
pub struct BatchSentimentRequest {
    pub usernames: Vec<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub upload_ids: Option<String>,
    pub max_per_user: Option<i64>,
    pub analyze_new_only: Option<bool>,
}

/// Return the exact count of messages that will be sent to the AI service for
/// the given filter parameters.  Used by the frontend to set the progress
/// denominator before analysis starts, so it is correct from the first tick.
pub async fn sentiment_count(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(req): Json<BatchSentimentRequest>,
) -> crate::error::Result<Json<serde_json::Value>> {
    use sqlx::Row;

    if req.usernames.is_empty() {
        return Ok(Json(json!({ "count": 0 })));
    }

    let mut args: Vec<String> = req.usernames.clone();
    let username_placeholders: String = (1..=req.usernames.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");

    let mut filters = String::new();
    if let Some(ref df) = req.date_from {
        let n = args.len() + 1;
        filters.push_str(&format!(" AND date >= ${}", n));
        args.push(df.clone());
    }
    if let Some(ref dt) = req.date_to {
        let n = args.len() + 1;
        filters.push_str(&format!(" AND date <= ${}", n));
        args.push(dt.clone());
    }
    if let Some(ref uid_str) = req.upload_ids {
        let ids: Vec<&str> = uid_str.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !ids.is_empty() {
            let placeholders: Vec<String> = ids.iter().enumerate()
                .map(|(i, _)| format!("${}", args.len() + i + 1))
                .collect();
            filters.push_str(&format!(" AND upload_id IN ({})", placeholders.join(", ")));
            args.extend(ids.iter().map(|s| s.to_string()));
        }
    }

    let new_only_clause = if req.analyze_new_only.unwrap_or(false) {
        // NOT EXISTS plans as an anti-join using message_emotions(msg_uuid) PK,
        // avoiding the materialization + NULL-check overhead of NOT IN that made
        // "Analyze New Only" slow to begin on large emotion tables.
        " AND NOT EXISTS (SELECT 1 FROM message_emotions me WHERE me.msg_uuid = messages.msg_uuid)"
    } else {
        ""
    };

    let sql = format!(
        "SELECT COUNT(*) FROM messages \
         WHERE username IN ({un}) AND msg_uuid IS NOT NULL AND msg_uuid != '' \
         AND trim(content) != ''{filters}{new_only}",
        un = username_placeholders,
        filters = filters,
        new_only = new_only_clause,
    );

    let mut q = sqlx::query(&sql);
    for a in &args { q = q.bind(a.clone()); }

    let count: i64 = q.fetch_one(&state.db).await
        .map(|r| r.get::<i64, _>(0))
        .unwrap_or(0);

    Ok(Json(json!({ "count": count })))
}

pub async fn user_batch_sentiment(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<BatchSentimentRequest>,
) -> crate::error::Result<Json<serde_json::Value>> {
    use sqlx::Row;
    use std::collections::HashMap;

    if req.usernames.is_empty() {
        return Ok(Json(json!({ "results": [] })));
    }

    // 0 or None = no per-user cap (analyze every message)
    let max_per_user = req.max_per_user.unwrap_or(0);

    // Build positional placeholders for usernames: $1, $2, ..., $N
    let mut args: Vec<String> = req.usernames.clone();
    let username_placeholders: String = (1..=req.usernames.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");

    // Append date and upload_id filters, tracking the running $N index
    let mut filters = String::new();
    if let Some(ref df) = req.date_from {
        let n = args.len() + 1;
        filters.push_str(&format!(" AND date >= ${}", n));
        args.push(df.clone());
    }
    if let Some(ref dt) = req.date_to {
        let n = args.len() + 1;
        filters.push_str(&format!(" AND date <= ${}", n));
        args.push(dt.clone());
    }
    if let Some(ref uid_str) = req.upload_ids {
        let ids: Vec<&str> = uid_str.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !ids.is_empty() {
            let placeholders: Vec<String> = ids.iter().enumerate()
                .map(|(i, _)| format!("${}", args.len() + i + 1))
                .collect();
            filters.push_str(&format!(" AND upload_id IN ({})", placeholders.join(", ")));
            args.extend(ids.iter().map(|s| s.to_string()));
        }
    }

    // Only include messages that have a valid msg_uuid (required for DB persistence).
    // When analyze_new_only is set, exclude messages already saved in message_emotions.
    let new_only_clause = if req.analyze_new_only.unwrap_or(false) {
        // NOT EXISTS plans as an anti-join using message_emotions(msg_uuid) PK,
        // avoiding the materialization + NULL-check overhead of NOT IN that made
        // "Analyze New Only" slow to begin on large emotion tables.
        " AND NOT EXISTS (SELECT 1 FROM message_emotions me WHERE me.msg_uuid = messages.msg_uuid)"
    } else {
        ""
    };
    let base_filter = format!(
        "username IN ({un}) AND msg_uuid IS NOT NULL AND msg_uuid != ''{filters}{new_only}",
        un = username_placeholders,
        filters = filters,
        new_only = new_only_clause,
    );

    // When max_per_user == 0 fetch every matching message; otherwise cap via ROW_NUMBER()
    let sql = if max_per_user == 0 {
        format!(
            "SELECT msg_uuid, username, content, date \
             FROM messages WHERE {base} ORDER BY username, date",
            base = base_filter,
        )
    } else {
        format!(
            "SELECT msg_uuid, username, content, date FROM (\
             SELECT msg_uuid, username, content, date, \
             ROW_NUMBER() OVER (PARTITION BY username ORDER BY date DESC) AS rn \
             FROM messages WHERE {base}\
             ) sub WHERE rn <= {max} ORDER BY username, date",
            base = base_filter,
            max = max_per_user,
        )
    };

    let mut q = sqlx::query(&sql);
    for a in &args { q = q.bind(a.clone()); }
    let rows = q.fetch_all(&state.db).await?;

    let mut uuid_to_user: HashMap<String, String> = HashMap::new();
    let mut ai_messages: Vec<serde_json::Value> = Vec::new();
    // Empty-content messages are saved as neutral without going through the AI service.
    let mut neutral_saves: Vec<(String, String, String, String)> = Vec::new();

    for row in &rows {
        let msg_uuid: Option<String> = row.try_get("msg_uuid").ok();
        let msg_uuid = match msg_uuid { Some(u) if !u.is_empty() => u, _ => continue };
        let username: String = row.get("username");
        let content: String = row.get("content");
        if content.trim().is_empty() {
            neutral_saves.push((msg_uuid, String::new(), "neutral".to_string(), "[]".to_string()));
            continue;
        }
        let date: String = row.get("date");
        uuid_to_user.insert(msg_uuid.clone(), username);
        ai_messages.push(json!({ "msg_uuid": msg_uuid, "content": content, "date": date }));
    }

    if ai_messages.is_empty() {
        // Still persist empty-content messages as neutral before returning.
        if !neutral_saves.is_empty() {
            let mut tx = state.db.begin().await?;
            for (uuid, dominant, sentiment, top_json) in &neutral_saves {
                sqlx::query(
                    "INSERT INTO message_emotions (msg_uuid, dominant_emotion, sentiment, top_emotions) \
                     VALUES ($1, $2, $3, $4::jsonb) \
                     ON CONFLICT (msg_uuid) DO UPDATE \
                     SET dominant_emotion = EXCLUDED.dominant_emotion, \
                         sentiment = EXCLUDED.sentiment, \
                         top_emotions = EXCLUDED.top_emotions, \
                         analyzed_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
                )
                .bind(uuid).bind(dominant).bind(sentiment).bind(top_json)
                .execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        let results: Vec<serde_json::Value> = req.usernames.iter()
            .map(|u| json!({ "username": u, "positive": 0.0, "negative": 0.0, "neutral": 1.0, "analyzed": 0 }))
            .collect();
        return Ok(Json(json!({ "results": results })));
    }

    let url = format!("{}/analyze_emotion", state.config.ai_service_url);
    let hf_token = headers.get("x-hf-token")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from);

    const CHUNK_SIZE: usize = 200;
    const PARALLEL_CALLS: usize = 5;

    let chunks: Vec<Vec<serde_json::Value>> = ai_messages
        .chunks(CHUNK_SIZE)
        .map(|c| c.to_vec())
        .collect();

    let mut per_message_combined: Vec<serde_json::Value> = Vec::new();

    for window in chunks.chunks(PARALLEL_CALLS) {
        let call_futures: Vec<_> = window.iter().map(|chunk| {
            let url      = url.clone();
            let client   = state.http_client.clone();
            let token    = hf_token.clone();
            let msgs     = chunk.clone();
            let sem      = state.ai_semaphore.clone();
            async move {
                // Acquire a global permit before calling the AI service so that
                // concurrent requests from multiple browser tabs don't overwhelm it.
                let _permit = sem.acquire().await
                    .map_err(|_| crate::error::AppError::Internal("AI semaphore closed".into()))?;
                let resp = ai_retry(|| {
                    let mut r = client.post(&url).json(&json!({ "messages": msgs }));
                    if let Some(ref t) = token { r = r.header("X-HF-Token", t.as_str()); }
                    r
                })
                .await
                .map_err(|e| crate::error::AppError::Internal(
                    format!("AI service unreachable: {}", e)
                ))?;

                if !resp.status().is_success() {
                    let err = resp.text().await.unwrap_or_default();
                    return Err(crate::error::AppError::Internal(
                        format!("AI service error: {}", err)
                    ));
                }

                let result: serde_json::Value = resp.json().await
                    .map_err(|e| crate::error::AppError::Internal(
                        format!("AI response parse error: {}", e)
                    ))?;

                Ok::<Vec<serde_json::Value>, crate::error::AppError>(
                    result["per_message"].as_array().cloned().unwrap_or_default()
                )
            }
        }).collect();

        let window_results = futures::future::try_join_all(call_futures).await?;
        for msgs in window_results {
            per_message_combined.extend(msgs);
        }
    }

    let per_message = &per_message_combined;

    // Aggregate per-user sentiment counts, overall emotion scores, and per-sentiment emotion breakdown.
    let mut user_counts: HashMap<String, (i64, i64, i64)> = HashMap::new(); // (pos, neg, neu)
    let mut user_label_scores: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();
    // username → sentiment → label → (score_sum, count)
    let mut user_by_sentiment: HashMap<String, HashMap<String, HashMap<String, (f64, i64)>>> = HashMap::new();
    // per-message DB persistence: (uuid, dominant_emotion, sentiment, top_emotions_json)
    let mut msgs_to_save: Vec<(String, String, String, String)> = Vec::new();

    for msg in per_message {
        let uuid = msg["msg_uuid"].as_str().unwrap_or("");
        let sentiment = msg["sentiment"].as_str().unwrap_or("neutral");
        if let Some(username) = uuid_to_user.get(uuid) {
            let e = user_counts.entry(username.clone()).or_insert((0, 0, 0));
            match sentiment {
                "positive" => e.0 += 1,
                "negative" => e.1 += 1,
                _ => e.2 += 1,
            }
            let empty_arr = vec![];
            let top_emotions_arr = msg["top_emotions"].as_array().unwrap_or(&empty_arr);
            let dominant = top_emotions_arr.first()
                .and_then(|e| e["label"].as_str())
                .unwrap_or("")
                .to_string();
            let top_emotions_json = serde_json::to_string(&msg["top_emotions"])
                .unwrap_or_else(|_| "[]".to_string());
            msgs_to_save.push((uuid.to_string(), dominant, sentiment.to_string(), top_emotions_json));

            let label_map = user_label_scores.entry(username.clone()).or_default();
            let sent_map = user_by_sentiment
                .entry(username.clone()).or_default()
                .entry(sentiment.to_string()).or_default();
            for em in top_emotions_arr {
                if let (Some(label), Some(score)) = (em["label"].as_str(), em["score"].as_f64()) {
                    let acc = label_map.entry(label.to_string()).or_insert((0.0, 0));
                    acc.0 += score; acc.1 += 1;
                    let sacc = sent_map.entry(label.to_string()).or_insert((0.0, 0));
                    sacc.0 += score; sacc.1 += 1;
                }
            }
        }
    }

    // Any message sent to the AI but not returned (short/skipped by service) → neutral
    {
        use std::collections::HashSet;
        let returned: HashSet<String> = msgs_to_save.iter().map(|(u, _, _, _)| u.clone()).collect();
        let mut skipped: Vec<(String, String, String, String)> = Vec::new();
        for (uuid, username) in &uuid_to_user {
            if !returned.contains(uuid) {
                let e = user_counts.entry(username.clone()).or_insert((0, 0, 0));
                e.2 += 1; // neutral
                user_by_sentiment.entry(username.clone()).or_default()
                    .entry("neutral".to_string()).or_default();
                skipped.push((uuid.clone(), String::new(), "neutral".to_string(), "[]".to_string()));
            }
        }
        msgs_to_save.extend(skipped);
    }

    msgs_to_save.extend(neutral_saves);

    if !msgs_to_save.is_empty() {
        let uuids:     Vec<String> = msgs_to_save.iter().map(|(u,_,_,_)| u.clone()).collect();
        let dominants: Vec<String> = msgs_to_save.iter().map(|(_,d,_,_)| d.clone()).collect();
        let sentiments:Vec<String> = msgs_to_save.iter().map(|(_,_,s,_)| s.clone()).collect();
        let top_jsons: Vec<String> = msgs_to_save.iter().map(|(_,_,_,j)| j.clone()).collect();
        let mut tx = state.db.begin().await?;
        sqlx::query(
            "INSERT INTO message_emotions (msg_uuid, dominant_emotion, sentiment, top_emotions) \
             SELECT u, d, s, j::jsonb \
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(u, d, s, j) \
             ON CONFLICT (msg_uuid) DO UPDATE \
             SET dominant_emotion = EXCLUDED.dominant_emotion, \
                 sentiment = EXCLUDED.sentiment, \
                 top_emotions = EXCLUDED.top_emotions, \
                 analyzed_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
        )
        .bind(uuids).bind(dominants).bind(sentiments).bind(top_jsons)
        .execute(&mut *tx).await?;
        tx.commit().await?;
    }

    let sort_top3 = |label_map: &HashMap<String, (f64, i64)>| -> Vec<serde_json::Value> {
        let mut v: Vec<serde_json::Value> = label_map
            .iter()
            .map(|(label, (sum, cnt))| {
                let avg = (sum / (*cnt as f64) * 1000.0).round() / 1000.0;
                json!({ "label": label, "score": avg })
            })
            .collect();
        v.sort_by(|a, b| {
            b["score"].as_f64().unwrap_or(0.0)
                .partial_cmp(&a["score"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        v.into_iter().take(3).collect()
    };

    let results: Vec<serde_json::Value> = req.usernames.iter().map(|u| {
        let (pos, neg, neu) = user_counts.get(u).copied().unwrap_or((0, 0, 0));
        let total = pos + neg + neu;

        let top_emotions = user_label_scores.get(u).map(&sort_top3).unwrap_or_default();

        let empty_sent: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();
        let sent_data = user_by_sentiment.get(u).unwrap_or(&empty_sent);
        let empty_label: HashMap<String, (f64, i64)> = HashMap::new();
        let by_sentiment = json!({
            "positive": {
                "count": pos,
                "top_emotions": sent_data.get("positive").map(&sort_top3).unwrap_or_default()
            },
            "negative": {
                "count": neg,
                "top_emotions": sent_data.get("negative").map(&sort_top3).unwrap_or_else(|| sort_top3(&empty_label))
            },
            "neutral": {
                "count": neu,
                "top_emotions": sent_data.get("neutral").map(&sort_top3).unwrap_or_else(|| sort_top3(&empty_label))
            },
        });

        if total == 0 {
            json!({
                "username": u,
                "positive": 0.0, "negative": 0.0, "neutral": 1.0,
                "analyzed": 0,
                "top_emotions": top_emotions,
                "by_sentiment": by_sentiment,
            })
        } else {
            json!({
                "username": u,
                "positive": (pos as f64 / total as f64 * 1000.0).round() / 1000.0,
                "negative": (neg as f64 / total as f64 * 1000.0).round() / 1000.0,
                "neutral":  (neu as f64 / total as f64 * 1000.0).round() / 1000.0,
                "analyzed": total,
                "top_emotions": top_emotions,
                "by_sentiment": by_sentiment,
            })
        }
    }).collect();

    Ok(Json(json!({ "results": results })))
}

/// SSE variant of `user_batch_sentiment`.  Streams three event types:
///   {"type":"total","msgs":N}          — total messages about to be analyzed
///   {"type":"progress","delta":K}      — K more messages finished one parallel window
///   {"type":"user","username":"...","result":{...}} — per-user aggregate when all done
///   {"type":"done"}                    — stream finished
pub async fn batch_sentiment_stream(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<BatchSentimentRequest>,
) -> impl IntoResponse {
    use std::convert::Infallible;

    let hf_token = headers
        .get("x-hf-token")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from);

    let s = async_stream::stream! {
        macro_rules! emit {
            ($val:expr) => {{
                let line = serde_json::to_string(&$val).unwrap_or_default();
                yield Ok::<Event, Infallible>(Event::default().data(line));
            }};
        }

        use sqlx::Row;
        use std::collections::HashMap;

        if req.usernames.is_empty() {
            emit!(json!({ "type": "done" }));
            return;
        }

        let max_per_user = req.max_per_user.unwrap_or(0);

        let mut args: Vec<String> = req.usernames.clone();
        let username_placeholders: String = (1..=req.usernames.len())
            .map(|i| format!("${}", i))
            .collect::<Vec<_>>()
            .join(", ");

        let mut filters = String::new();
        if let Some(ref df) = req.date_from {
            let n = args.len() + 1;
            filters.push_str(&format!(" AND date >= ${}", n));
            args.push(df.clone());
        }
        if let Some(ref dt) = req.date_to {
            let n = args.len() + 1;
            filters.push_str(&format!(" AND date <= ${}", n));
            args.push(dt.clone());
        }
        if let Some(ref uid_str) = req.upload_ids {
            let ids: Vec<&str> = uid_str.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
            if !ids.is_empty() {
                let placeholders: Vec<String> = ids.iter().enumerate()
                    .map(|(i, _)| format!("${}", args.len() + i + 1))
                    .collect();
                filters.push_str(&format!(" AND upload_id IN ({})", placeholders.join(", ")));
                args.extend(ids.iter().map(|s| s.to_string()));
            }
        }

        let new_only_clause = if req.analyze_new_only.unwrap_or(false) {
            // NOT EXISTS plans as an anti-join using message_emotions(msg_uuid) PK,
        // avoiding the materialization + NULL-check overhead of NOT IN that made
        // "Analyze New Only" slow to begin on large emotion tables.
        " AND NOT EXISTS (SELECT 1 FROM message_emotions me WHERE me.msg_uuid = messages.msg_uuid)"
        } else {
            ""
        };
        let base_filter = format!(
            "username IN ({un}) AND msg_uuid IS NOT NULL AND msg_uuid != ''{filters}{new_only}",
            un = username_placeholders,
            filters = filters,
            new_only = new_only_clause,
        );

        let sql = if max_per_user == 0 {
            format!(
                "SELECT msg_uuid, username, content, date \
                 FROM messages WHERE {base} ORDER BY username, date",
                base = base_filter,
            )
        } else {
            format!(
                "SELECT msg_uuid, username, content, date FROM (\
                 SELECT msg_uuid, username, content, date, \
                 ROW_NUMBER() OVER (PARTITION BY username ORDER BY date DESC) AS rn \
                 FROM messages WHERE {base}\
                 ) sub WHERE rn <= {max} ORDER BY username, date",
                base = base_filter,
                max = max_per_user,
            )
        };

        let mut q = sqlx::query(&sql);
        for a in &args { q = q.bind(a.clone()); }
        let rows = match q.fetch_all(&state.db).await {
            Ok(r) => r,
            Err(e) => { emit!(json!({ "type": "error", "message": e.to_string() })); return; }
        };

        let mut uuid_to_user: HashMap<String, String> = HashMap::new();
        let mut ai_messages: Vec<serde_json::Value> = Vec::new();
        let mut neutral_saves: Vec<(String, String, String, String)> = Vec::new();

        for row in &rows {
            let msg_uuid: Option<String> = row.try_get("msg_uuid").ok();
            let msg_uuid = match msg_uuid { Some(u) if !u.is_empty() => u, _ => continue };
            let username: String = row.get("username");
            let content: String = row.get("content");
            if content.trim().is_empty() {
                neutral_saves.push((msg_uuid, String::new(), "neutral".to_string(), "[]".to_string()));
                continue;
            }
            let date: String = row.get("date");
            uuid_to_user.insert(msg_uuid.clone(), username);
            ai_messages.push(json!({ "msg_uuid": msg_uuid, "content": content, "date": date }));
        }

        // Emit total so frontend can show a denominator
        emit!(json!({ "type": "total", "msgs": ai_messages.len() }));

        let url = format!("{}/analyze_emotion", state.config.ai_service_url);

        // Match the AI service's batch_size=128 so each chunk becomes exactly
        // one ONNX batch (no 72-msg tail batch that would force ORT to JIT a
        // second kernel shape per request).
        const CHUNK_SIZE: usize = 128;

        let chunks: Vec<Vec<serde_json::Value>> = ai_messages
            .chunks(CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        drop(ai_messages); // Free the source vector now that chunks own copies.

        // Per-user aggregators (cheap — at most one entry per username).
        let mut user_counts: HashMap<String, (i64, i64, i64)> = HashMap::new();
        let mut user_label_scores: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();
        let mut user_by_sentiment: HashMap<String, HashMap<String, HashMap<String, (f64, i64)>>> = HashMap::new();
        let mut returned_uuids: std::collections::HashSet<String> =
            std::collections::HashSet::with_capacity(uuid_to_user.len());

        // Stream chunks lazily so at most `AI_CONCURRENCY * 2` are in-flight at
        // a time.  Pushing all chunks upfront would pin Vec<Value> clones for
        // every chunk in memory (~1GB for a 1M-message run) — unbounded buffer
        // is the largest cliff at scale.
        use futures::StreamExt as _;
        let chunk_stream = futures::stream::iter(chunks.into_iter().map(|chunk| {
            let url    = url.clone();
            let client = state.http_client.clone();
            let token  = hf_token.clone();
            let sem    = state.ai_semaphore.clone();
            async move {
                let _permit = sem.acquire().await
                    .map_err(|_| crate::error::AppError::Internal("AI semaphore closed".into()))?;
                let resp = ai_retry(|| {
                    let mut r = client.post(&url).json(&json!({ "messages": chunk }));
                    if let Some(ref t) = token { r = r.header("X-HF-Token", t.as_str()); }
                    r
                })
                .await
                .map_err(|e| crate::error::AppError::Internal(format!("AI unreachable: {}", e)))?;
                if !resp.status().is_success() {
                    let err = resp.text().await.unwrap_or_default();
                    return Err(crate::error::AppError::Internal(format!("AI error: {}", err)));
                }
                let result: serde_json::Value = resp.json().await
                    .map_err(|e| crate::error::AppError::Internal(format!("Parse error: {}", e)))?;
                Ok::<Vec<serde_json::Value>, crate::error::AppError>(
                    result["per_message"].as_array().cloned().unwrap_or_default()
                )
            }
        }));
        let mut buffered = chunk_stream.buffer_unordered(AI_CONCURRENCY * 2);

        while let Some(result) = buffered.next().await {
            match result {
                Ok(msgs) => {
                    let delta = msgs.len();

                    // Aggregate into per-user counters AND build this chunk's
                    // save batch inline; no global per_message accumulator.
                    let mut chunk_saves: Vec<(String, String, String, String)> =
                        Vec::with_capacity(msgs.len());
                    for msg in &msgs {
                        let uuid = msg["msg_uuid"].as_str().unwrap_or("");
                        let sentiment = msg["sentiment"].as_str().unwrap_or("neutral");
                        let Some(username) = uuid_to_user.get(uuid) else { continue };

                        let e = user_counts.entry(username.clone()).or_insert((0, 0, 0));
                        match sentiment {
                            "positive" => e.0 += 1,
                            "negative" => e.1 += 1,
                            _          => e.2 += 1,
                        }
                        returned_uuids.insert(uuid.to_string());

                        let empty_arr = vec![];
                        let top_arr = msg["top_emotions"].as_array().unwrap_or(&empty_arr);
                        let dominant = top_arr.first().and_then(|e| e["label"].as_str()).unwrap_or("").to_string();
                        let top_json = serde_json::to_string(&msg["top_emotions"]).unwrap_or_else(|_| "[]".to_string());
                        chunk_saves.push((uuid.to_string(), dominant, sentiment.to_string(), top_json));

                        let label_map = user_label_scores.entry(username.clone()).or_default();
                        let sent_map = user_by_sentiment.entry(username.clone()).or_default()
                            .entry(sentiment.to_string()).or_default();
                        for em in top_arr {
                            if let (Some(label), Some(score)) = (em["label"].as_str(), em["score"].as_f64()) {
                                let acc = label_map.entry(label.to_string()).or_insert((0.0, 0));
                                acc.0 += score; acc.1 += 1;
                                let sacc = sent_map.entry(label.to_string()).or_insert((0.0, 0));
                                sacc.0 += score; sacc.1 += 1;
                            }
                        }
                    }

                    // Persist this chunk immediately so a mid-stream crash
                    // leaves analyzed messages in the DB — "Analyze New Only"
                    // can then resume from the boundary.  A DB failure here is
                    // non-fatal: those rows will fall through skipped-detection
                    // and be neutral-tagged at the end.
                    if !chunk_saves.is_empty() {
                        if let Err(e) = upsert_message_emotions(&state.db, &chunk_saves).await {
                            tracing::warn!("Chunk upsert failed (will be retried as neutral): {}", e);
                        }
                    }

                    emit!(json!({ "type": "progress", "delta": delta }));
                }
                Err(e) => {
                    // Don't abort — these messages will be picked up by the
                    // skipped-detection pass below and marked neutral.
                    tracing::warn!("AI chunk failed (messages will be neutral): {}", e);
                }
            }
        }

        // Skipped pass: messages sent to AI that did not come back (filtered as
        // non-meaningful by the model OR chunk-failed).  Marked neutral so the
        // user-level totals reconcile with the pre-fetched denominator.
        let mut skipped_saves: Vec<(String, String, String, String)> = Vec::new();
        for (uuid, username) in &uuid_to_user {
            if !returned_uuids.contains(uuid) {
                let e = user_counts.entry(username.clone()).or_insert((0, 0, 0));
                e.2 += 1;
                user_by_sentiment.entry(username.clone()).or_default()
                    .entry("neutral".to_string()).or_default();
                skipped_saves.push((uuid.clone(), String::new(), "neutral".to_string(), "[]".to_string()));
            }
        }
        let skipped_count = skipped_saves.len();
        if !skipped_saves.is_empty() {
            if let Err(e) = upsert_message_emotions(&state.db, &skipped_saves).await {
                emit!(json!({ "type": "error", "message": format!("DB save error: {}", e) }));
                return;
            }
        }
        if skipped_count > 0 {
            emit!(json!({ "type": "progress", "delta": skipped_count }));
        }

        // Empty-content messages that never went to AI.
        if !neutral_saves.is_empty() {
            if let Err(e) = upsert_message_emotions(&state.db, &neutral_saves).await {
                emit!(json!({ "type": "error", "message": format!("DB save error: {}", e) }));
                return;
            }
        }

        let sort_top3 = |label_map: &HashMap<String, (f64, i64)>| -> Vec<serde_json::Value> {
            let mut v: Vec<serde_json::Value> = label_map.iter()
                .map(|(label, (sum, cnt))| {
                    let avg = (sum / (*cnt as f64) * 1000.0).round() / 1000.0;
                    json!({ "label": label, "score": avg })
                })
                .collect();
            v.sort_by(|a, b| b["score"].as_f64().unwrap_or(0.0)
                .partial_cmp(&a["score"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal));
            v.into_iter().take(3).collect()
        };

        for u in &req.usernames {
            let (pos, neg, neu) = user_counts.get(u).copied().unwrap_or((0, 0, 0));
            let total = pos + neg + neu;
            let top_emotions = user_label_scores.get(u).map(&sort_top3).unwrap_or_default();
            let empty_sent: HashMap<String, HashMap<String, (f64, i64)>> = HashMap::new();
            let sent_data = user_by_sentiment.get(u).unwrap_or(&empty_sent);
            let empty_label: HashMap<String, (f64, i64)> = HashMap::new();
            let by_sentiment = json!({
                "positive": { "count": pos, "top_emotions": sent_data.get("positive").map(&sort_top3).unwrap_or_default() },
                "negative": { "count": neg, "top_emotions": sent_data.get("negative").map(&sort_top3).unwrap_or_else(|| sort_top3(&empty_label)) },
                "neutral":  { "count": neu, "top_emotions": sent_data.get("neutral").map(&sort_top3).unwrap_or_else(|| sort_top3(&empty_label)) },
            });
            let result = if total == 0 {
                json!({ "positive": 0.0, "negative": 0.0, "neutral": 1.0, "analyzed": 0,
                        "top_emotions": top_emotions, "by_sentiment": by_sentiment })
            } else {
                json!({
                    "positive": (pos as f64 / total as f64 * 1000.0).round() / 1000.0,
                    "negative": (neg as f64 / total as f64 * 1000.0).round() / 1000.0,
                    "neutral":  (neu as f64 / total as f64 * 1000.0).round() / 1000.0,
                    "analyzed": total,
                    "top_emotions": top_emotions,
                    "by_sentiment": by_sentiment,
                })
            };
            emit!(json!({ "type": "user", "username": u, "result": result }));
        }

        emit!(json!({ "type": "done" }));
    };

    Sse::new(s).keep_alive(axum::response::sse::KeepAlive::default())
}

pub async fn user_emotion(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> crate::error::Result<Json<serde_json::Value>> {
    let url = format!("{}/analyze_emotion", state.config.ai_service_url);
    let hf_token = headers.get("x-hf-token")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let resp = ai_retry(|| {
        let mut r = state.http_client.post(&url).json(&body);
        if let Some(ref t) = hf_token { r = r.header("X-HF-Token", t.as_str()); }
        r
    })
    .await
    .map_err(|e| AppError::Internal(format!("AI service unreachable: {}", e)))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("AI service error: {}", err)));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("AI service response parse error: {}", e)))?;

    Ok(Json(result))
}

pub async fn user_strategy_classify(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<StrategyRequest>,
) -> crate::error::Result<Json<serde_json::Value>> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    if req.strategies.is_empty() {
        return Err(AppError::BadRequest("At least one strategy is required".into()));
    }
    if req.messages.is_empty() {
        return Ok(Json(json!({ "strategies": [], "total_messages": 0, "total_classified": 0 })));
    }

    let model = req.model.as_deref().unwrap_or("gpt-4o-mini").to_string();
    let strategy_ids: Vec<String> = req.strategies.iter().map(|s| s.id.clone()).collect();

    let strategy_list = req.strategies.iter()
        .map(|s| format!("  id=\"{}\" name=\"{}\" - {}", s.id, s.name, s.description))
        .collect::<Vec<_>>()
        .join("\n");

    let mut uuid_to_strategies: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client error: {}", e)))?;

    const BATCH: usize = 40;

    for chunk in req.messages.chunks(BATCH) {
        let msg_list = chunk.iter().enumerate()
            .map(|(i, m)| {
                let date = &m.date[..m.date.len().min(10)];
                let content = if m.content.len() > 300 { &m.content[..300] } else { &m.content };
                format!("[{}] {} ({}): {}", i, m.username, date, content)
            })
            .collect::<Vec<_>>()
            .join("\n");

        let prompt = format!(
            "You are a research assistant analysing community reactions on a Suno AI Discord server.\n\
             Suno is an AI music generation company. The decisions listed below are specific actions or changes made by Suno.\n\
             For each Discord message, determine whether it is a reaction to — or discussion of — any of these Suno decisions.\n\
             A message may react to multiple decisions or none at all.\n\n\
             Suno Decisions:\n{}\n\n\
             Messages:\n{}\n\n\
             Return JSON with key \"assignments\": an array of objects, one per message, \
             each with \"index\" (0-based integer) and \"strategy_ids\" \
             (array of matching decision id strings — empty array if the message does not react to any listed decision). \
             Use ONLY the exact id strings above. Include ALL {} messages.",
            strategy_list, msg_list, chunk.len()
        );

        let schema = json!({
            "type": "object",
            "properties": {
                "assignments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": { "type": "integer" },
                            "strategy_ids": { "type": "array", "items": { "type": "string" } }
                        },
                        "required": ["index", "strategy_ids"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["assignments"],
            "additionalProperties": false
        });

        let body = json!({
            "model": model,
            "temperature": 0,
            "seed": 42,
            "messages": [{ "role": "user", "content": prompt }],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "strategy_assignments",
                    "strict": true,
                    "schema": schema
                }
            }
        });

        let resp = client
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("OpenAI request failed: {}", e)))?;

        if !resp.status().is_success() {
            let err = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!("OpenAI error (strategy): {}", err)));
        }

        let resp_json: serde_json::Value = resp.json().await
            .map_err(|e| AppError::Internal(format!("OpenAI response parse error: {}", e)))?;

        let content = resp_json["choices"][0]["message"]["content"].as_str().unwrap_or("{}");

        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
            if let Some(assignments) = parsed["assignments"].as_array() {
                for item in assignments {
                    let idx = item["index"].as_u64().unwrap_or(0) as usize;
                    if idx >= chunk.len() { continue; }
                    let uuid = chunk[idx].msg_uuid.clone().unwrap_or_default();
                    if uuid.is_empty() { continue; }
                    let matched: Vec<String> = item["strategy_ids"]
                        .as_array()
                        .map(|arr| arr.iter()
                            .filter_map(|v| v.as_str())
                            .filter(|s| strategy_ids.contains(&s.to_string()))
                            .map(String::from)
                            .collect())
                        .unwrap_or_default();
                    uuid_to_strategies.insert(uuid, matched);
                }
            }
        }

        for msg in chunk {
            let uuid = msg.msg_uuid.clone().unwrap_or_default();
            if !uuid.is_empty() {
                uuid_to_strategies.entry(uuid).or_insert_with(Vec::new);
            }
        }
    }

    let mut buckets: std::collections::HashMap<String, Vec<serde_json::Value>> =
        req.strategies.iter().map(|s| (s.id.clone(), vec![])).collect();

    for msg in &req.messages {
        let uuid = msg.msg_uuid.clone().unwrap_or_default();
        if let Some(sids) = uuid_to_strategies.get(&uuid) {
            for sid in sids {
                if let Some(bucket) = buckets.get_mut(sid) {
                    bucket.push(json!({
                        "msg_uuid": uuid,
                        "content": msg.content,
                        "date": msg.date,
                        "username": msg.username,
                    }));
                }
            }
        }
    }

    let total_classified = uuid_to_strategies.values().filter(|v| !v.is_empty()).count();

    let strategies_out: Vec<serde_json::Value> = req.strategies.iter()
        .map(|s| {
            let msgs = buckets.get(&s.id).cloned().unwrap_or_default();
            json!({
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "count": msgs.len(),
                "messages": msgs,
            })
        })
        .collect();

    Ok(Json(json!({
        "strategies": strategies_out,
        "total_messages": req.messages.len(),
        "total_classified": total_classified,
    })))
}

#[derive(serde::Deserialize)]
pub struct PhaseStatusItem {
    pub label: String,
    pub sub: String,
    pub status: Option<String>,
    pub msg_count: u32,
}

#[derive(serde::Deserialize)]
pub struct EngagementNarrativeRequest {
    pub username: String,
    pub phase_statuses: Vec<PhaseStatusItem>,
    pub model: Option<String>,
}

pub async fn user_engagement_narrative(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<EngagementNarrativeRequest>,
) -> crate::error::Result<Json<serde_json::Value>> {
    let api_key = state
        .get_openai_key(key_from_header(&headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let model = req.model.as_deref().unwrap_or("gpt-4o-mini").to_string();

    let phase_lines: Vec<String> = req.phase_statuses.iter()
        .map(|p| {
            let status = p.status.as_deref().unwrap_or("absent");
            format!("  - {} ({}): status={}, messages={}", p.label, p.sub, status, p.msg_count)
        })
        .collect();

    let prompt = format!(
        "You are a research analyst studying user engagement patterns in a Discord community for Suno AI, \
         an AI music generation platform. The platform went through several distinct phases of development.\n\n\
         User: {}\n\n\
         Phase-by-phase engagement (status is one of: active, transient, dropout, or absent):\n{}\n\n\
         Status definitions:\n\
         - active: User posted consistently and frequently throughout the phase\n\
         - transient: User posted sporadically or briefly\n\
         - dropout: User showed signs of disengagement (high silence after activity)\n\
         - absent: No messages in this phase\n\n\
         Write a concise 2-4 sentence analytical narrative describing this user's engagement journey \
         across phases. Focus on: when they were most engaged, any notable transitions (e.g. active → absent, \
         return after absence), their overall trajectory, and what this suggests about their relationship \
         with the platform. Be specific about which phases. Do not use bullet points — write flowing prose.",
        req.username,
        phase_lines.join("\n")
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client error: {}", e)))?;

    let body = json!({
        "model": model,
        "temperature": 0.3,
        "messages": [{ "role": "user", "content": prompt }]
    });

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("OpenAI request failed: {}", e)))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("OpenAI error (narrative): {}", err)));
    }

    let resp_json: serde_json::Value = resp.json().await
        .map_err(|e| AppError::Internal(format!("OpenAI response parse error: {}", e)))?;

    let narrative = resp_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("Unable to generate narrative.")
        .to_string();

    Ok(Json(json!({ "narrative": narrative })))
}
