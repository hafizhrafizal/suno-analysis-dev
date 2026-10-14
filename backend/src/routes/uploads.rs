use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    response::{sse::{Event, Sse}, IntoResponse},
    Json,
};

fn key_from_header(headers: &HeaderMap) -> Option<String> {
    headers.get("x-openai-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from)
}
use serde_json::{json, Value};
use std::convert::Infallible;
use uuid::Uuid;
use chrono::Datelike;
use crate::{error::{AppError, Result}, models::AuthUser, state::AppState};

const EMBED_MODEL: &str = "text-embedding-3-small";
/// 500 inputs × 1 536 dims × ~12 chars/float ≈ 9 MB per response — reliable ceiling before
/// reqwest body reads become unstable.  Throughput comes from EMBED_CONCURRENCY, not batch size.
const EMBED_BATCH_SIZE: usize = 500;
/// Parallel OpenAI requests per window.  Kept at 3 to stay within default tier rate limits
/// (text-embedding-3-small: 3 000 RPM / 1 000 000 TPM on tier 1 — 3 × 500 = 1 500 per window).
const EMBED_CONCURRENCY: usize = 3;

fn compute_week(date: &str) -> Option<String> {
    let date = date.trim();
    if date.is_empty() {
        return None;
    }
    chrono::NaiveDateTime::parse_from_str(date, "%Y-%m-%d %H:%M:%S%.f")
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(date, "%Y-%m-%d %H:%M:%S").ok())
        .map(|dt| {
            let iw = dt.iso_week();
            format!("{}-{:02}", iw.year(), iw.week())
        })
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .map(|d| {
                    let iw = d.iso_week();
                    format!("{}-{:02}", iw.year(), iw.week())
                })
        })
}

/// Call OpenAI batch embeddings API once.
/// Returns `Ok(embeddings)` on success, `Err(retry_after_secs)` on 429,
/// `Err(u64::MAX)` on permanent errors (4xx), `Err(0)` on transient failures (5xx, network).
async fn embed_batch_once(
    client: &reqwest::Client,
    api_key: &str,
    texts: &[String],
) -> std::result::Result<Vec<Option<Vec<f64>>>, u64> {
    let resp = match client
        .post("https://api.openai.com/v1/embeddings")
        .bearer_auth(api_key)
        .json(&json!({ "model": EMBED_MODEL, "input": texts }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("OpenAI embed request failed: {}", e);
            return Err(0);
        }
    };

    let status = resp.status();

    if status.as_u16() == 429 {
        // Read Retry-After header BEFORE consuming the body with .text()
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(5)
            .max(1); // .max(1) prevents Err(0) collision with the transient-failure sentinel
        let body_preview = resp.text().await.unwrap_or_default();
        tracing::warn!(
            "OpenAI embed rate limited (429), will retry in {}s: {}",
            retry_after,
            &body_preview[..body_preview.len().min(200)]
        );
        return Err(retry_after);
    }

    // Read body as text first — avoids opaque "error decoding response body" on failures
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("OpenAI embed body read failed: {}", e);
            return Err(0);
        }
    };

    // 4xx (other than 429) = permanent — wrong key, bad input, etc. Don't retry.
    if status.is_client_error() {
        tracing::warn!("OpenAI embed permanent error HTTP {} — {}", status, &body[..body.len().min(300)]);
        return Err(u64::MAX);
    }

    // 5xx = transient server error — retry with back-off.
    if !status.is_success() {
        tracing::warn!("OpenAI embed server error HTTP {} — {}", status, &body[..body.len().min(200)]);
        return Err(0);
    }

    if !body.starts_with('{') {
        tracing::warn!("OpenAI embed unexpected body (first 200 chars): {}", &body[..body.len().min(200)]);
        return Err(0);
    }

    let data: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("OpenAI embed JSON parse error: {} — body len {} bytes", e, body.len());
            return Err(0);
        }
    };

    // Surface API-level error objects (e.g. token limit exceeded, invalid model)
    if let Some(err_obj) = data.get("error") {
        tracing::warn!("OpenAI embed API error (permanent): {}", err_obj);
        return Err(u64::MAX);
    }

    let mut result: Vec<Option<Vec<f64>>> = vec![None; texts.len()];
    if let Some(arr) = data["data"].as_array() {
        for item in arr {
            let idx = item["index"].as_u64().unwrap_or(0) as usize;
            if idx < texts.len() {
                let v: Vec<f64> = item["embedding"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_f64()).collect())
                    .unwrap_or_default();
                if !v.is_empty() {
                    result[idx] = Some(v);
                }
            }
        }
    }
    Ok(result)
}

/// Embed a batch with up to 4 attempts using a *shared* client (TLS connections are reused).
/// On 429 respects `Retry-After`; on transient failures uses exponential back-off (2 s, 4 s, 8 s).
/// On permanent errors (4xx, API error object) fails immediately without retrying.
async fn embed_batch(client: reqwest::Client, api_key: &str, texts: &[String]) -> Vec<Option<Vec<f64>>> {
    for attempt in 0u32..4 {
        match embed_batch_once(&client, api_key, texts).await {
            Ok(embeddings) => return embeddings,
            Err(u64::MAX) => {
                // Permanent error (invalid key, bad request, API-level error) — no point retrying
                tracing::warn!("Embedding batch skipped (permanent error) — {} messages", texts.len());
                return vec![None; texts.len()];
            }
            Err(0) => {
                if attempt < 3 {
                    let delay = 2u64.pow(attempt);
                    tracing::info!("Embed attempt {} failed (transient), retrying in {}s", attempt + 1, delay);
                    tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                }
            }
            Err(retry_after) => {
                tracing::info!(
                    "OpenAI rate-limited (attempt {}), waiting {}s (Retry-After header)",
                    attempt + 1,
                    retry_after
                );
                tokio::time::sleep(std::time::Duration::from_secs(retry_after)).await;
            }
        }
    }
    tracing::warn!("Embedding batch failed after 4 attempts — skipping {} messages", texts.len());
    vec![None; texts.len()]
}

/// Delete all Qdrant vectors whose payload `upload_id` matches.
/// Returns an approximate count of deleted vectors (best-effort; 0 on failure).
async fn delete_qdrant_by_upload_id(
    client: &reqwest::Client,
    qdrant_url: &str,
    collection: &str,
    api_key: Option<&str>,
    upload_id: &str,
) -> i64 {
    let filter = json!({
        "filter": {
            "must": [{"key": "upload_id", "match": {"value": upload_id}}]
        }
    });
    // Count first for best-effort reporting
    let count_url = format!("{}/collections/{}/points/count", qdrant_url, collection);
    let mut count_req = client.post(&count_url).json(&filter);
    if let Some(key) = api_key { count_req = count_req.header("api-key", key); }
    let approx_count: i64 = match count_req.send().await {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok()
            .and_then(|v| v["result"]["count"].as_i64())
            .unwrap_or(0),
        _ => 0,
    };

    let delete_url = format!("{}/collections/{}/points/delete", qdrant_url, collection);
    let mut del_req = client.post(&delete_url).json(&filter);
    if let Some(key) = api_key { del_req = del_req.header("api-key", key); }
    match del_req.send().await {
        Ok(r) if r.status().is_success() => approx_count,
        Ok(r) => {
            let s = r.status();
            let b = r.text().await.unwrap_or_default();
            tracing::warn!("Qdrant delete by upload_id HTTP {}: {}", s, &b[..b.len().min(200)]);
            0
        }
        Err(e) => { tracing::warn!("Qdrant delete by upload_id failed: {}", e); 0 }
    }
}

/// Convert any msg_uuid to a Qdrant-compatible UUID string.
/// Qdrant only accepts UUIDs (string) or u64 (number) as point IDs.
/// Discord Snowflake IDs are numeric strings that are not valid UUIDs, so we
/// derive a deterministic UUID5 from them using NAMESPACE_OID — the same
/// namespace used by the migration script (migrate_chroma_to_qdrant.py).
fn to_qdrant_id(id: &str) -> String {
    if Uuid::parse_str(id).is_ok() {
        id.to_string()
    } else {
        Uuid::new_v5(&Uuid::NAMESPACE_OID, id.as_bytes()).to_string()
    }
}

/// Ensure a Qdrant collection exists; create with cosine distance if missing.
async fn ensure_qdrant_collection(
    client: &reqwest::Client,
    qdrant_url: &str,
    collection: &str,
    api_key: Option<&str>,
    vector_size: u64,
) -> bool {
    let url = format!("{}/collections/{}", qdrant_url, collection);
    let mut get_req = client.get(&url);
    if let Some(key) = api_key { get_req = get_req.header("api-key", key); }
    if let Ok(r) = get_req.send().await {
        if r.status().is_success() { return true; }
    }
    let mut put_req = client
        .put(&url)
        .json(&json!({ "vectors": { "size": vector_size, "distance": "Cosine" } }));
    if let Some(key) = api_key { put_req = put_req.header("api-key", key); }
    put_req.send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

/// Return the set of original msg_uuid values already stored in Qdrant for a specific upload.
/// Uses scroll + upload_id filter so results come from the payload field we write on every
/// upsert — far more reliable than batch /points/get for large collections.
async fn get_existing_qdrant_ids_for_upload(
    client: &reqwest::Client,
    qdrant_url: &str,
    collection: &str,
    api_key: Option<&str>,
    upload_id: &str,
) -> std::collections::HashSet<String> {
    let scroll_url = format!("{}/collections/{}/points/scroll", qdrant_url, collection);
    let mut existing = std::collections::HashSet::new();
    let mut next_offset = serde_json::Value::Null;

    loop {
        let mut body = json!({
            "filter": {
                "must": [{"key": "upload_id", "match": {"value": upload_id}}]
            },
            "limit": 10000,
            "with_payload": ["msg_uuid"],
            "with_vectors": false,
        });
        if !next_offset.is_null() {
            body["offset"] = next_offset.clone();
        }
        let mut req = client.post(&scroll_url).json(&body);
        if let Some(key) = api_key { req = req.header("api-key", key); }

        match req.send().await {
            Ok(r) if r.status().is_success() => {
                match r.json::<Value>().await {
                    Ok(data) => {
                        let points = data["result"]["points"].as_array()
                            .map(|a| a.to_vec())
                            .unwrap_or_default();
                        let count = points.len();
                        for p in &points {
                            // Prefer payload.msg_uuid (original Discord/DB ID) over point ID
                            if let Some(orig) = p["payload"]["msg_uuid"].as_str() {
                                existing.insert(orig.to_string());
                            } else if let Some(qid) = p["id"].as_str() {
                                existing.insert(qid.to_string());
                            }
                        }
                        next_offset = data["result"]["next_page_offset"].clone();
                        if next_offset.is_null() || count == 0 { break; }
                    }
                    Err(_) => break,
                }
            }
            _ => break,
        }
    }
    existing
}

/// Return the set of ORIGINAL IDs (msg_uuid) already present in a Qdrant collection.
/// Converts each ID to its Qdrant UUID form for the lookup, then maps results back
/// to original IDs so the caller can compare directly with database msg_uuid values.
async fn get_existing_qdrant_ids(
    client: &reqwest::Client,
    qdrant_url: &str,
    collection: &str,
    api_key: Option<&str>,
    ids: &[String],
) -> std::collections::HashSet<String> {
    let futs = ids.chunks(1000).map(|chunk| {
        let client = client.clone();
        // Batch retrieval is POST /collections/{c}/points (PUT to the same path
        // upserts) — /points/get 404s on Qdrant 1.x.
        let url = format!("{}/collections/{}/points", qdrant_url, collection);
        // Build original→qdrant_id mapping before the async block
        let pairs: Vec<(String, String)> = chunk.iter()
            .map(|id| (id.clone(), to_qdrant_id(id)))
            .collect();
        let qdrant_ids: Vec<String> = pairs.iter().map(|(_, qid)| qid.clone()).collect();
        let qdrant_to_orig: std::collections::HashMap<String, String> = pairs
            .into_iter()
            .map(|(orig, qid)| (qid, orig))
            .collect();
        let api_key = api_key.map(String::from);
        async move {
            let mut found = Vec::<String>::new();
            let mut req = client.post(&url).json(&json!({
                "ids": qdrant_ids,
                "with_payload": false,
                "with_vectors": false,
            }));
            if let Some(key) = &api_key { req = req.header("api-key", key); }
            if let Ok(r) = req.send().await {
                if let Ok(data) = r.json::<Value>().await {
                    if let Some(arr) = data["result"].as_array() {
                        for p in arr {
                            // Qdrant returns UUID IDs as strings; map back to original
                            if let Some(qid) = p["id"].as_str() {
                                if let Some(orig) = qdrant_to_orig.get(qid) {
                                    found.push(orig.clone());
                                }
                            }
                        }
                    }
                }
            }
            found
        }
    });
    futures::future::join_all(futs).await.into_iter().flatten().collect()
}

/// Upsert a batch of embeddings into Qdrant.
async fn upsert_qdrant_batch(
    client: &reqwest::Client,
    qdrant_url: &str,
    collection: &str,
    api_key: Option<&str>,
    ids: &[String],
    embeddings: &[Vec<f64>],
    documents: &[String],
    upload_id: &str,
) {
    let points: Vec<Value> = ids
        .iter()
        .zip(embeddings.iter())
        .zip(documents.iter())
        .map(|((id, emb), doc)| json!({
            // Qdrant requires UUID or u64 as point ID; convert Snowflake IDs → UUID5
            "id": to_qdrant_id(id),
            "vector": emb,
            // Keep original msg_uuid in payload so we can recover it on reads
            "payload": { "msg_uuid": id, "upload_id": upload_id, "document": doc }
        }))
        .collect();
    let url = format!("{}/collections/{}/points", qdrant_url, collection);
    let mut req = client.put(&url).json(&json!({ "points": points }));
    if let Some(key) = api_key { req = req.header("api-key", key); }
    match req.send().await {
        Ok(r) if !r.status().is_success() => {
            let s = r.status();
            let b = r.text().await.unwrap_or_default();
            tracing::warn!("Qdrant upsert HTTP {}: {}", s, &b[..b.len().min(300)]);
        }
        Err(e) => tracing::warn!("Qdrant upsert failed: {}", e),
        _ => {}
    }
}

pub async fn upload_csv(
    State(state): State<AppState>,
    _user: AuthUser,
    req_headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<impl IntoResponse> {
    let mut csv_bytes: Option<Vec<u8>> = None;
    let mut original_filename = String::from("upload.csv");

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            original_filename = field
                .file_name()
                .unwrap_or("upload.csv")
                .to_string();
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(e.to_string()))?;
            csv_bytes = Some(data.to_vec());
        }
    }

    let csv_data = csv_bytes.ok_or_else(|| AppError::BadRequest("No file field found".into()))?;

    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(csv_data.as_slice());

    let headers = reader
        .headers()
        .map_err(|e| AppError::BadRequest(format!("CSV parse error: {}", e)))?
        .clone();

    fn normalize_header(h: &str) -> &'static str {
        match h.trim().to_lowercase().as_str() {
            "id" | "message id" | "msg_uuid" => "msg_uuid",
            "author" | "author id" | "username" => "username",
            "content" | "message" | "text" => "content",
            "date" | "timestamp" | "created_at" | "time" => "date",
            "attachments" | "attachment" => "attachments",
            "reactions" | "reaction" => "reactions",
            "is_suno_team" | "suno_team" | "is_team" => "is_suno_team",
            _ => "unknown",
        }
    }

    let header_map: Vec<(&'static str, usize)> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| (normalize_header(h), i))
        .filter(|(name, _)| *name != "unknown")
        .collect();

    let get_field = move |row: &csv::StringRecord, field: &str| -> Option<String> {
        header_map
            .iter()
            .find(|(n, _)| *n == field)
            .and_then(|(_, i)| row.get(*i))
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };

    let upload_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let records: Vec<csv::StringRecord> = reader
        .records()
        .filter_map(|r| r.ok())
        .collect();
    let total = records.len() as i64;

    sqlx::query(
        "INSERT INTO uploads (id, filename, row_count, upload_time) VALUES ($1, $2, $3, $4)",
    )
    .bind(&upload_id)
    .bind(&original_filename)
    .bind(total)
    .bind(&now)
    .execute(&state.db)
    .await?;

    // Capture everything the stream needs before moving into the generator
    let upload_id_clone = upload_id.clone();
    let db = state.db.clone();
    let openai_key_opt = state.get_openai_key(key_from_header(&req_headers)).await;
    let qdrant_url_cfg = state.config.qdrant_url.clone();
    let qdrant_collection_cfg = state.config.qdrant_collection.clone();
    let qdrant_api_key_cfg = state.config.qdrant_api_key.clone();

    let event_stream = async_stream::stream! {
        // ── Phase 1: insert rows ──────────────────────────────────────────────
        let mut processed: i64 = 0; // rows seen (used for row_index ordering)
        let mut inserted: i64 = 0;  // rows actually inserted (not duplicate-skipped)
        let mut all_csv_uuids: Vec<String> = Vec::new(); // every UUID from the CSV (inserted + skipped)
        let batch_size = 500usize;

        for chunk in records.chunks(batch_size) {
            let mut tx = match db.begin().await {
                Ok(tx) => tx,
                Err(e) => {
                    yield Ok::<Event, Infallible>(Event::default().data(
                        serde_json::to_string(&json!({"type":"error","message":e.to_string()})).unwrap()
                    ));
                    return;
                }
            };

            for record in chunk {
                let msg_uuid = get_field(record, "msg_uuid")
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                all_csv_uuids.push(msg_uuid.clone()); // track before conflict check
                let username = get_field(record, "username")
                    .unwrap_or_else(|| "unknown".to_string());
                let content = match get_field(record, "content") {
                    Some(c) => c,
                    None => continue,
                };
                let date = get_field(record, "date").unwrap_or_default();
                let attachments = get_field(record, "attachments");
                let reactions = get_field(record, "reactions");
                let is_suno_team = get_field(record, "is_suno_team")
                    .unwrap_or_else(|| "false".to_string());
                let row_idx = processed;
                processed += 1;
                let word_count = content.split_whitespace().count() as i64;
                let week = compute_week(&date);

                if let Ok(r) = sqlx::query(
                    "INSERT INTO messages
                     (msg_uuid, username, date, content, attachments, reactions,
                      is_suno_team, upload_id, row_index, week, word_count)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     ON CONFLICT DO NOTHING",
                )
                .bind(&msg_uuid)
                .bind(&username)
                .bind(&date)
                .bind(&content)
                .bind(&attachments)
                .bind(&reactions)
                .bind(&is_suno_team)
                .bind(&upload_id_clone)
                .bind(row_idx)
                .bind(&week)
                .bind(word_count)
                .execute(&mut *tx)
                .await {
                    inserted += r.rows_affected() as i64;
                }
            }

            let _ = tx.commit().await;

            yield Ok(Event::default().data(
                serde_json::to_string(&json!({
                    "type": "progress",
                    "inserted": inserted,
                    "skipped": processed - inserted,
                    "total": total,
                })).unwrap()
            ));
        }

        // ── Suno-team backfill ────────────────────────────────────────────────
        let _ = sqlx::query(
            "UPDATE messages
             SET is_suno_team = 'true'
             WHERE upload_id = $1
               AND LOWER(is_suno_team) NOT IN ('true', '1')
               AND username IN (
                   SELECT DISTINCT username FROM messages
                   WHERE LOWER(is_suno_team) IN ('true', '1')
                     AND upload_id != $1
               )",
        )
        .bind(&upload_id_clone)
        .execute(&db)
        .await;

        // ── Phase 2: embed with text-embedding-3-small ────────────────────────
        let mut embedded_count: i64 = 0;
        let mut already_embedded: i64 = 0;

        match openai_key_opt {
            None => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({
                        "type": "embed_skip",
                        "reason": "no_api_key",
                    })).unwrap()
                ));
            }
            Some(api_key) => {
                // Fetch msg_uuid + content for all rows in the CSV (both newly inserted and
                // pre-existing ones that were skipped by ON CONFLICT). This handles re-uploads
                // of the same file correctly: even if 0 rows were inserted, the messages still
                // exist in the DB under their original upload_id and need to be embedded.
                let msgs: Vec<(String, String)> = match sqlx::query(
                    "SELECT msg_uuid, content FROM messages
                     WHERE msg_uuid = ANY($1) AND content IS NOT NULL",
                )
                .bind(&all_csv_uuids)
                .fetch_all(&db)
                .await
                {
                    Ok(rows) => {
                        use sqlx::Row;
                        rows.into_iter()
                            .map(|r| (r.get::<String, _>("msg_uuid"), r.get::<String, _>("content")))
                            .collect()
                    }
                    Err(e) => {
                        tracing::warn!("Failed to fetch messages for embedding: {}", e);
                        vec![]
                    }
                };

                if !msgs.is_empty() {
                    let http_client = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(120))
                        .build()
                        .unwrap_or_else(|_| reqwest::Client::new());
                    let embed_client = http_client.clone();

                    let collection_ready = ensure_qdrant_collection(
                        &http_client,
                        &qdrant_url_cfg,
                        &qdrant_collection_cfg,
                        qdrant_api_key_cfg.as_deref(),
                        1536,
                    ).await;

                    if !collection_ready {
                        tracing::warn!("Vector store unavailable — embedding skipped");
                        yield Ok(Event::default().data(
                            serde_json::to_string(&json!({
                                "type": "embed_skip",
                                "reason": "vector_db_unavailable",
                            })).unwrap()
                        ));
                    } else {
                        let all_ids: Vec<String> = msgs.iter().map(|(id, _)| id.clone()).collect();
                        let existing_ids = get_existing_qdrant_ids(
                            &http_client,
                            &qdrant_url_cfg,
                            &qdrant_collection_cfg,
                            qdrant_api_key_cfg.as_deref(),
                            &all_ids,
                        ).await;
                        already_embedded = existing_ids.len() as i64;

                        let msgs_to_embed: Vec<(String, String)> = msgs
                            .into_iter()
                            .filter(|(id, _)| !existing_ids.contains(id))
                            .collect();
                        let total_to_embed = msgs_to_embed.len() as i64;

                        if total_to_embed == 0 {
                            tracing::info!(
                                "All {} vectors already in vector store — embedding skipped",
                                already_embedded
                            );
                            yield Ok(Event::default().data(
                                serde_json::to_string(&json!({
                                    "type": "embed_skip",
                                    "reason": "all_already_embedded",
                                    "count": already_embedded,
                                })).unwrap()
                            ));
                        } else {
                            yield Ok(Event::default().data(
                                serde_json::to_string(&json!({
                                    "type": "embed_start",
                                    "total": total_to_embed,
                                    "already_embedded": already_embedded,
                                    "model": EMBED_MODEL,
                                })).unwrap()
                            ));

                            let all_batches: Vec<(Vec<String>, Vec<String>)> = msgs_to_embed
                                .chunks(EMBED_BATCH_SIZE)
                                .map(|chunk| (
                                    chunk.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
                                    chunk.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>(),
                                ))
                                .collect();

                            for window in all_batches.chunks(EMBED_CONCURRENCY) {
                                let embed_futs = window.iter().map(|(ids, texts)| {
                                    let embed_client = embed_client.clone();
                                    let api_key = api_key.clone();
                                    let ids = ids.clone();
                                    let texts = texts.clone();
                                    async move {
                                        let embeddings = embed_batch(embed_client, &api_key, &texts).await;
                                        ids.into_iter()
                                            .zip(embeddings)
                                            .zip(texts)
                                            .filter_map(|((id, emb_opt), text)| {
                                                emb_opt.map(|emb| (id, emb, text))
                                            })
                                            .collect::<Vec<_>>()
                                    }
                                });
                                let window_results = futures::future::join_all(embed_futs).await;

                                let upsert_futs = window_results.iter().map(|valid| {
                                    let http_client = http_client.clone();
                                    let upload_id_inner = upload_id_clone.clone();
                                    let valid = valid.clone();
                                    let qdrant_url = qdrant_url_cfg.clone();
                                    let qdrant_col = qdrant_collection_cfg.clone();
                                    let qdrant_key = qdrant_api_key_cfg.clone();
                                    async move {
                                        if valid.is_empty() { return 0i64; }
                                        let v_ids: Vec<String> = valid.iter().map(|(id, _, _)| id.clone()).collect();
                                        let v_embs: Vec<Vec<f64>> = valid.iter().map(|(_, emb, _)| emb.clone()).collect();
                                        let v_docs: Vec<String> = valid.iter().map(|(_, _, doc)| doc.clone()).collect();
                                        upsert_qdrant_batch(
                                            &http_client, &qdrant_url, &qdrant_col,
                                            qdrant_key.as_deref(),
                                            &v_ids, &v_embs, &v_docs, &upload_id_inner,
                                        ).await;
                                        valid.len() as i64
                                    }
                                });
                                let counts = futures::future::join_all(upsert_futs).await;
                                embedded_count += counts.iter().sum::<i64>();

                                yield Ok(Event::default().data(
                                    serde_json::to_string(&json!({
                                        "type": "embed_progress",
                                        "embedded": embedded_count,
                                        "total": total_to_embed,
                                    })).unwrap()
                                ));
                            }
                        }

                        if embedded_count > 0 || already_embedded > 0 {
                            let _ = sqlx::query(
                                "INSERT INTO embedded_uploads (upload_id, model_id)
                                 VALUES ($1, $2)
                                 ON CONFLICT DO NOTHING",
                            )
                            .bind(&upload_id_clone)
                            .bind(EMBED_MODEL)
                            .execute(&db)
                            .await;
                        }
                    }
                }
            }
        }

        // ── Done ──────────────────────────────────────────────────────────────
        yield Ok(Event::default().data(
            serde_json::to_string(&json!({
                "type": "done",
                "upload_id": upload_id_clone,
                "total_inserted": inserted,
                "total_skipped": processed - inserted,
                "embedded": embedded_count,
                "already_embedded": already_embedded,
                "embed_model": if embedded_count > 0 || already_embedded > 0 { EMBED_MODEL } else { "" },
            })).unwrap()
        ));
    };

    Ok(Sse::new(event_stream))
}

pub async fn list_uploads(State(state): State<AppState>) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "SELECT id, filename, row_count, upload_time FROM uploads ORDER BY upload_time DESC",
    )
    .fetch_all(&state.db)
    .await?;

    // Fetch which models each upload has been embedded with
    let embed_rows = sqlx::query("SELECT upload_id, model_id FROM embedded_uploads")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

    use sqlx::Row;
    let mut embed_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &embed_rows {
        embed_map
            .entry(r.get::<String, _>("upload_id"))
            .or_default()
            .push(r.get::<String, _>("model_id"));
    }

    let uploads: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let id: String = r.get("id");
            let models = embed_map.get(&id).cloned().unwrap_or_default();
            let embedded_models: serde_json::Map<String, Value> = models
                .into_iter()
                .map(|m| (m, Value::Bool(true)))
                .collect();
            json!({
                "id": id,
                "filename": r.get::<String, _>("filename"),
                "row_count": r.get::<i64, _>("row_count"),
                "upload_time": r.get::<String, _>("upload_time"),
                "embedded_models": embedded_models,
            })
        })
        .collect();

    Ok(Json(json!(uploads)))
}

pub async fn delete_upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let deleted_messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE upload_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    // ON DELETE CASCADE removes messages and embedded_uploads automatically
    let affected = sqlx::query("DELETE FROM uploads WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("Upload {} not found", id)));
    }

    // Delete vectors for this upload from Qdrant (best-effort)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let deleted_vectors = delete_qdrant_by_upload_id(
        &client, &state.config.qdrant_url, &state.config.qdrant_collection,
        state.config.qdrant_api_key.as_deref(), &id,
    ).await;

    Ok(Json(json!({
        "deleted": id,
        "deleted_messages": deleted_messages,
        "deleted_vectors": deleted_vectors,
    })))
}

/// Delete only the relational-DB rows (messages + upload record) while leaving
/// Qdrant vectors in place.
pub async fn delete_upload_sqlite(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let deleted_messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE upload_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let affected = sqlx::query("DELETE FROM uploads WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("Upload {} not found", id)));
    }
    Ok(Json(json!({ "deleted": id, "deleted_messages": deleted_messages })))
}

pub async fn delete_upload_embeddings(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    // Remove the tracking record so re-embed can run again
    sqlx::query("DELETE FROM embedded_uploads WHERE upload_id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;

    // Delete actual vectors for this upload from Qdrant
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let deleted_vectors = delete_qdrant_by_upload_id(
        &client, &state.config.qdrant_url, &state.config.qdrant_collection,
        state.config.qdrant_api_key.as_deref(), &id,
    ).await;

    Ok(Json(json!({ "deleted_vectors": deleted_vectors })))
}

pub async fn reembed(
    State(state): State<AppState>,
    _user: AuthUser,
    req_headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse> {
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM uploads WHERE id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Upload {} not found", id)));
    }

    let api_key = state
        .get_openai_key(key_from_header(&req_headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let db = state.db.clone();
    let qdrant_url = state.config.qdrant_url.clone();
    let qdrant_collection = state.config.qdrant_collection.clone();
    let qdrant_api_key = state.config.qdrant_api_key.clone();

    let event_stream = async_stream::stream! {
        // ── Step 1: connect to vector store ───────────────────────────────────
        let http_client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                yield Ok::<Event, Infallible>(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message":e.to_string()})).unwrap()
                ));
                return;
            }
        };
        let embed_client = http_client.clone();

        let ok = ensure_qdrant_collection(
            &http_client, &qdrant_url, &qdrant_collection,
            qdrant_api_key.as_deref(), 1536,
        ).await;
        if !ok {
            yield Ok(Event::default().data(
                serde_json::to_string(&json!({"type":"error","message":"Qdrant unavailable"})).unwrap()
            ));
            return;
        }

        // ── Step 2: load messages ──────────────────────────────────────────────
        let msgs: Vec<(String, String)> = match sqlx::query(
            "SELECT msg_uuid, content FROM messages
             WHERE upload_id = $1 AND content IS NOT NULL
             ORDER BY row_index",
        )
        .bind(&id)
        .fetch_all(&db)
        .await
        {
            Ok(rows) => {
                use sqlx::Row;
                rows.into_iter().map(|r| (r.get("msg_uuid"), r.get("content"))).collect()
            }
            Err(e) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message":e.to_string()})).unwrap()
                ));
                return;
            }
        };

        let total = msgs.len() as i64;

        // ── Step 3: check which IDs already have vectors ──────────────────────
        yield Ok(Event::default().data(
            serde_json::to_string(&json!({"type":"checking","total":total})).unwrap()
        ));

        // Scroll by upload_id filter + read msg_uuid from payload — resumable,
        // reflects actual Qdrant state rather than a batch /points/get that can
        // silently return empty on partial failures.
        let existing_ids = get_existing_qdrant_ids_for_upload(
            &http_client, &qdrant_url, &qdrant_collection,
            qdrant_api_key.as_deref(), &id,
        ).await;

        let skipped = existing_ids.len() as i64;
        let msgs_to_embed: Vec<(String, String)> = msgs
            .into_iter()
            .filter(|(mid, _)| !existing_ids.contains(mid))
            .collect();
        let total_to_embed = msgs_to_embed.len() as i64;

        if total_to_embed == 0 {
            yield Ok(Event::default().data(
                serde_json::to_string(&json!({
                    "type":"done","upload_id":id,"total":total,
                    "embedded":0,"skipped":skipped,"model":EMBED_MODEL,
                })).unwrap()
            ));
            return;
        }

        yield Ok(Event::default().data(
            serde_json::to_string(&json!({
                "type":"embed_start","total":total_to_embed,"skipped":skipped,"model":EMBED_MODEL,
            })).unwrap()
        ));

        // ── Step 4: embed + upsert in windows ─────────────────────────────────
        let all_batches: Vec<(Vec<String>, Vec<String>)> = msgs_to_embed
            .chunks(EMBED_BATCH_SIZE)
            .map(|chunk| (
                chunk.iter().map(|(mid, _)| mid.clone()).collect(),
                chunk.iter().map(|(_, c)| c.clone()).collect(),
            ))
            .collect();

        let mut embedded: i64 = 0;

        for window in all_batches.chunks(EMBED_CONCURRENCY) {
            let embed_futs = window.iter().map(|(ids, texts)| {
                let embed_client = embed_client.clone();
                let api_key = api_key.clone();
                let ids = ids.clone();
                let texts = texts.clone();
                async move {
                    let embeddings = embed_batch(embed_client, &api_key, &texts).await;
                    ids.into_iter()
                        .zip(embeddings)
                        .zip(texts)
                        .filter_map(|((mid, emb_opt), text)| emb_opt.map(|emb| (mid, emb, text)))
                        .collect::<Vec<_>>()
                }
            });
            let window_results = futures::future::join_all(embed_futs).await;

            let upsert_futs = window_results.iter().map(|valid| {
                let http_client = http_client.clone();
                let upload_id_inner = id.clone();
                let valid = valid.clone();
                let qu = qdrant_url.clone();
                let qc = qdrant_collection.clone();
                let qk = qdrant_api_key.clone();
                async move {
                    if valid.is_empty() { return 0i64; }
                    let v_ids: Vec<String> = valid.iter().map(|(vid, _, _)| vid.clone()).collect();
                    let v_embs: Vec<Vec<f64>> = valid.iter().map(|(_, emb, _)| emb.clone()).collect();
                    let v_docs: Vec<String> = valid.iter().map(|(_, _, doc)| doc.clone()).collect();
                    upsert_qdrant_batch(
                        &http_client, &qu, &qc, qk.as_deref(),
                        &v_ids, &v_embs, &v_docs, &upload_id_inner,
                    ).await;
                    valid.len() as i64
                }
            });
            let counts = futures::future::join_all(upsert_futs).await;
            embedded += counts.iter().sum::<i64>();

            yield Ok(Event::default().data(
                serde_json::to_string(&json!({
                    "type":"embed_progress","embedded":embedded,"total":total_to_embed,
                })).unwrap()
            ));
        }

        // ── Step 5: mark as embedded ───────────────────────────────────────────
        let _ = sqlx::query(
            "INSERT INTO embedded_uploads (upload_id, model_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(&id)
        .bind(EMBED_MODEL)
        .execute(&db)
        .await;

        yield Ok(Event::default().data(
            serde_json::to_string(&json!({
                "type":"done","upload_id":id,"total":total,
                "embedded":embedded,"skipped":skipped,"model":EMBED_MODEL,
            })).unwrap()
        ));
    };

    Ok(Sse::new(event_stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    ))
}

pub async fn get_job(Path(job_id): Path<String>) -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "No active embedding jobs", "job_id": job_id })),
    )
}

/// Scan all uploads, compare DB message UUIDs against Qdrant point UUIDs, then:
/// - embed messages that are in the DB but missing from Qdrant, and
/// - delete vectors that are in Qdrant but have no matching DB message (orphans).
/// Streams SSE events for scan progress, per-upload embed/delete progress, and final summary.
pub async fn sync_qdrant(
    State(state): State<AppState>,
    _user: AuthUser,
    req_headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let api_key = state
        .get_openai_key(key_from_header(&req_headers))
        .await
        .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

    let db = state.db.clone();
    let qdrant_url = state.config.qdrant_url.clone();
    let qdrant_collection = state.config.qdrant_collection.clone();
    let qdrant_api_key = state.config.qdrant_api_key.clone();

    let event_stream = async_stream::stream! {
        let http_client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                yield Ok::<Event, Infallible>(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message":e.to_string()})).unwrap()
                ));
                return;
            }
        };

        let ok = ensure_qdrant_collection(
            &http_client, &qdrant_url, &qdrant_collection,
            qdrant_api_key.as_deref(), 1536,
        ).await;
        if !ok {
            yield Ok(Event::default().data(
                serde_json::to_string(&json!({"type":"error","message":"Qdrant unavailable"})).unwrap()
            ));
            return;
        }

        // Load all uploads
        let uploads: Vec<(String, String)> = match sqlx::query(
            "SELECT id, filename FROM uploads ORDER BY upload_time DESC",
        )
        .fetch_all(&db)
        .await
        {
            Ok(rows) => {
                use sqlx::Row;
                rows.into_iter().map(|r| (r.get("id"), r.get("filename"))).collect()
            }
            Err(e) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message":e.to_string()})).unwrap()
                ));
                return;
            }
        };

        let total_uploads = uploads.len();
        yield Ok(Event::default().data(
            serde_json::to_string(&json!({
                "type": "scan_start",
                "total_uploads": total_uploads,
            })).unwrap()
        ));

        // Phase 1: full UUID scan per upload
        //   work_items: (upload_id, filename, missing_msg_uuids, orphan_qdrant_point_ids)
        let mut work_items: Vec<(String, String, Vec<String>, Vec<String>)> = Vec::new();

        for (upload_id, filename) in &uploads {
            // DB UUIDs with non-empty content
            let db_uuids: std::collections::HashSet<String> = {
                use sqlx::Row;
                sqlx::query(
                    "SELECT msg_uuid FROM messages WHERE upload_id = $1 AND content IS NOT NULL",
                )
                .bind(upload_id)
                .fetch_all(&db)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|r| r.get::<String, _>("msg_uuid"))
                .collect()
            };

            // Qdrant UUIDs for this upload (full scroll via payload filter)
            let qdrant_uuids = get_existing_qdrant_ids_for_upload(
                &http_client, &qdrant_url, &qdrant_collection,
                qdrant_api_key.as_deref(), upload_id,
            ).await;

            let db_count = db_uuids.len() as i64;
            let qdrant_count = qdrant_uuids.len() as i64;

            // Messages in DB but not in Qdrant → need embedding
            let missing_uuids: Vec<String> = db_uuids.iter()
                .filter(|id| !qdrant_uuids.contains(*id))
                .cloned()
                .collect();

            // Vectors in Qdrant but not in DB → orphans to delete
            // Convert original msg_uuid back to the Qdrant point ID (UUID5 form)
            let orphan_point_ids: Vec<String> = qdrant_uuids.iter()
                .filter(|id| !db_uuids.contains(*id))
                .map(|id| to_qdrant_id(id))
                .collect();

            let missing = missing_uuids.len() as i64;
            let orphans = orphan_point_ids.len() as i64;

            yield Ok(Event::default().data(
                serde_json::to_string(&json!({
                    "type": "scan_result",
                    "upload_id": upload_id,
                    "filename": filename,
                    "db_count": db_count,
                    "qdrant_count": qdrant_count,
                    "missing": missing,
                    "orphans": orphans,
                })).unwrap()
            ));

            if missing > 0 || orphans > 0 {
                work_items.push((
                    upload_id.clone(),
                    filename.clone(),
                    missing_uuids,
                    orphan_point_ids,
                ));
            }
        }

        yield Ok(Event::default().data(
            serde_json::to_string(&json!({
                "type": "sync_start",
                "to_sync": work_items.len(),
            })).unwrap()
        ));

        if work_items.is_empty() {
            yield Ok(Event::default().data(
                serde_json::to_string(&json!({
                    "type": "done",
                    "total_uploads": total_uploads,
                    "synced_uploads": 0,
                    "total_embedded": 0,
                    "total_deleted": 0,
                })).unwrap()
            ));
            return;
        }

        // Phase 2: for each upload that needs action, delete orphans then embed missing
        let mut total_embedded_all: i64 = 0;
        let mut total_deleted_all: i64 = 0;
        let mut synced_count: i64 = 0;

        for (upload_id, filename, missing_uuids, orphan_point_ids) in work_items {
            let mut embedded: i64 = 0;
            let mut deleted: i64 = 0;

            // ── Step A: delete orphan vectors ────────────────────────────────────
            if !orphan_point_ids.is_empty() {
                let delete_url = format!(
                    "{}/collections/{}/points/delete",
                    qdrant_url, qdrant_collection,
                );
                for chunk in orphan_point_ids.chunks(500) {
                    let mut req = http_client.post(&delete_url)
                        .json(&json!({ "points": chunk }));
                    if let Some(key) = &qdrant_api_key { req = req.header("api-key", key); }
                    match req.send().await {
                        Ok(r) if r.status().is_success() => deleted += chunk.len() as i64,
                        Ok(r) => {
                            let s = r.status();
                            let b = r.text().await.unwrap_or_default();
                            tracing::warn!(
                                "Qdrant orphan delete HTTP {}: {}",
                                s, &b[..b.len().min(200)]
                            );
                        }
                        Err(e) => tracing::warn!("Qdrant orphan delete failed: {}", e),
                    }
                }
            }

            // ── Step B: embed missing messages ───────────────────────────────────
            if !missing_uuids.is_empty() {
                let msgs: Vec<(String, String)> = match sqlx::query(
                    "SELECT msg_uuid, content FROM messages
                     WHERE upload_id = $1 AND content IS NOT NULL
                       AND msg_uuid = ANY($2)
                     ORDER BY row_index",
                )
                .bind(&upload_id)
                .bind(&missing_uuids)
                .fetch_all(&db)
                .await
                {
                    Ok(rows) => {
                        use sqlx::Row;
                        rows.into_iter()
                            .map(|r| (r.get("msg_uuid"), r.get("content")))
                            .collect()
                    }
                    Err(_) => vec![],
                };

                let total_to_embed = msgs.len() as i64;
                if total_to_embed > 0 {
                    yield Ok(Event::default().data(
                        serde_json::to_string(&json!({
                            "type": "embed_start",
                            "upload_id": upload_id,
                            "filename": filename,
                            "total": total_to_embed,
                        })).unwrap()
                    ));

                    let embed_client = http_client.clone();
                    let all_batches: Vec<(Vec<String>, Vec<String>)> = msgs
                        .chunks(EMBED_BATCH_SIZE)
                        .map(|chunk| (
                            chunk.iter().map(|(id, _)| id.clone()).collect(),
                            chunk.iter().map(|(_, c)| c.clone()).collect(),
                        ))
                        .collect();

                    for window in all_batches.chunks(EMBED_CONCURRENCY) {
                        let embed_futs = window.iter().map(|(ids, texts)| {
                            let embed_client = embed_client.clone();
                            let api_key = api_key.clone();
                            let ids = ids.clone();
                            let texts = texts.clone();
                            async move {
                                let embeddings = embed_batch(embed_client, &api_key, &texts).await;
                                ids.into_iter()
                                    .zip(embeddings)
                                    .zip(texts)
                                    .filter_map(|((id, emb_opt), text)| {
                                        emb_opt.map(|emb| (id, emb, text))
                                    })
                                    .collect::<Vec<_>>()
                            }
                        });
                        let window_results = futures::future::join_all(embed_futs).await;

                        let upsert_futs = window_results.iter().map(|valid| {
                            let http_client = http_client.clone();
                            let uid = upload_id.clone();
                            let valid = valid.clone();
                            let qu = qdrant_url.clone();
                            let qc = qdrant_collection.clone();
                            let qk = qdrant_api_key.clone();
                            async move {
                                if valid.is_empty() { return 0i64; }
                                let v_ids: Vec<String> = valid.iter().map(|(vid, _, _)| vid.clone()).collect();
                                let v_embs: Vec<Vec<f64>> = valid.iter().map(|(_, emb, _)| emb.clone()).collect();
                                let v_docs: Vec<String> = valid.iter().map(|(_, _, doc)| doc.clone()).collect();
                                upsert_qdrant_batch(
                                    &http_client, &qu, &qc, qk.as_deref(),
                                    &v_ids, &v_embs, &v_docs, &uid,
                                ).await;
                                valid.len() as i64
                            }
                        });
                        let counts = futures::future::join_all(upsert_futs).await;
                        embedded += counts.iter().sum::<i64>();

                        yield Ok(Event::default().data(
                            serde_json::to_string(&json!({
                                "type": "embed_progress",
                                "upload_id": upload_id,
                                "embedded": embedded,
                                "total": total_to_embed,
                            })).unwrap()
                        ));
                    }

                    let _ = sqlx::query(
                        "INSERT INTO embedded_uploads (upload_id, model_id) VALUES ($1, $2)
                         ON CONFLICT DO NOTHING",
                    )
                    .bind(&upload_id)
                    .bind(EMBED_MODEL)
                    .execute(&db)
                    .await;
                }
            }

            total_embedded_all += embedded;
            total_deleted_all += deleted;
            synced_count += 1;

            yield Ok(Event::default().data(
                serde_json::to_string(&json!({
                    "type": "upload_done",
                    "upload_id": upload_id,
                    "filename": filename,
                    "embedded": embedded,
                    "deleted": deleted,
                })).unwrap()
            ));
        }

        yield Ok(Event::default().data(
            serde_json::to_string(&json!({
                "type": "done",
                "total_uploads": total_uploads,
                "synced_uploads": synced_count,
                "total_embedded": total_embedded_all,
                "total_deleted": total_deleted_all,
            })).unwrap()
        ));
    };

    Ok(Sse::new(event_stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    ))
}
