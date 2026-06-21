use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{
    error::{AppError, Result},
    models::AuthUser,
    state::AppState,
};

// ── Request / Feature types ───────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PersonaFeatures {
    pub msg_count: i64,
    pub avg_words: f64,
    pub pct_weeks: f64,
    pub weeks_active: i64,
    pub dropout_status: Option<String>,
    pub sentiment_positive: Option<f64>,
    pub sentiment_negative: Option<f64>,
    pub sentiment_neutral: Option<f64>,
    pub top_emotions: Option<Vec<String>>,
    pub top_topics: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct SampleMessage {
    pub content: String,
    pub date: String,
}

#[derive(Deserialize)]
pub struct ClassifyRequest {
    pub username: String,
    pub phase: String,
    pub phase_label: String,
    pub features: PersonaFeatures,
    pub sample_messages: Option<Vec<SampleMessage>>,
    pub methods: Vec<String>,
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub phase: Option<String>,
    pub method: Option<String>,
}

// ── Rule-based classifier ─────────────────────────────────────────────────────

fn rule_based_classify(f: &PersonaFeatures) -> (String, f64, String) {
    let neg_emotion_set = [
        "disapproval", "anger", "annoyance", "disgust",
        "disappointment", "remorse", "fear", "grief",
    ];
    let neg_sent = f.sentiment_negative.unwrap_or(0.0);
    let pos_sent = f.sentiment_positive.unwrap_or(0.0);
    let emotions = f.top_emotions.as_deref().unwrap_or(&[]);
    let neg_emo_matches: Vec<&str> = emotions.iter()
        .filter(|e| neg_emotion_set.contains(&e.as_str()))
        .map(|e| e.as_str())
        .collect();
    let has_neg_emotion = !neg_emo_matches.is_empty();

    // 1. Scrutinizer — strong negative sentiment or negative emotion pattern
    if neg_sent > 0.30 || (has_neg_emotion && f.msg_count >= 8) {
        let conf = if neg_sent > 0.30 {
            (neg_sent * 2.5_f64).min(1.0)
        } else {
            0.65
        };
        let reason = if neg_sent > 0.30 {
            format!(
                "Negative sentiment {:.0}% exceeds 30% threshold; top emotions: {}",
                neg_sent * 100.0,
                if neg_emo_matches.is_empty() { "none detected".to_string() } else { neg_emo_matches.join(", ") }
            )
        } else {
            format!(
                "Negative emotions present ({}) with {} messages",
                neg_emo_matches.join(", "),
                f.msg_count
            )
        };
        return ("Scrutinizer".into(), conf, reason);
    }

    // 2. Community Moderator and Mentor — very high engagement + positive tone
    if f.pct_weeks >= 60.0 && f.msg_count >= 40 && pos_sent >= 0.35 {
        let conf = ((f.pct_weeks - 60.0) / 40.0 * 0.35 + 0.65).min(1.0);
        let reason = format!(
            "Very high weekly presence ({:.0}%) with {} messages and positive sentiment ({:.0}%)",
            f.pct_weeks, f.msg_count, pos_sent * 100.0
        );
        return ("Community Moderator and Mentor".into(), conf, reason);
    }

    // 3. Community Mentor — high regular engagement
    if f.pct_weeks >= 45.0 && f.msg_count >= 20 {
        let conf = ((f.pct_weeks - 45.0) / 55.0 * 0.35 + 0.60).min(1.0);
        let reason = format!(
            "Regular presence ({:.0}% weeks, {} messages{})",
            f.pct_weeks,
            f.msg_count,
            if pos_sent > 0.30 {
                format!(", positive sentiment {:.0}%", pos_sent * 100.0)
            } else {
                String::new()
            }
        );
        return ("Community Mentor".into(), conf, reason);
    }

    // 4. Power Technical User — high verbosity + consistent presence
    if f.avg_words >= 22.0 && f.pct_weeks >= 35.0 && f.msg_count >= 12 {
        let conf = ((f.avg_words - 22.0) / 30.0 * 0.30 + 0.65).min(1.0);
        let reason = format!(
            "Technical depth ({:.1} avg words) with consistent presence ({:.0}% weeks, {} messages)",
            f.avg_words, f.pct_weeks, f.msg_count
        );
        return ("Power Technical User".into(), conf, reason);
    }

    // 5. Help-Seeker — short messages + irregular posting
    if f.avg_words <= 15.0 && f.pct_weeks <= 40.0 {
        let conf = if f.avg_words <= 10.0 { 0.80 } else { 0.65 };
        let reason = format!(
            "Short messages ({:.1} avg words) with irregular visits ({:.0}% weeks, {} messages)",
            f.avg_words, f.pct_weeks, f.msg_count
        );
        return ("Help-Seeker".into(), conf, reason);
    }

    // 6. Casual Explorer — default
    let reason = format!(
        "Moderate engagement ({} msgs, {:.0}% weeks, {:.1} avg words) — no dominant behavioral pattern",
        f.msg_count, f.pct_weeks, f.avg_words
    );
    ("Casual Explorer".into(), 0.50, reason)
}

// ── LLM classifier ────────────────────────────────────────────────────────────

async fn llm_classify(
    f: &PersonaFeatures,
    username: &str,
    phase_label: &str,
    sample_messages: &[SampleMessage],
    api_key: &str,
    model: &str,
) -> Result<(String, f64, String)> {
    let persona_defs = "\
- Power Technical User: High avg words (≥22), consistent weekly presence (≥35%), detailed technical posts
- Community Mentor: High regular engagement (≥45% weeks, ≥20 msgs), supportive and helpful tone
- Community Moderator and Mentor: Very high engagement (≥60% weeks, ≥40 msgs), community-building, positive sentiment
- Scrutinizer: Expresses criticism or concerns; negative sentiment or emotions like disapproval/anger/disappointment
- Help-Seeker: Short messages (≤15 avg words), irregular visits (≤40% weeks), asking questions or seeking support
- Casual Explorer: Moderate engagement that doesn't clearly fit any above pattern; intermittent participation";

    let features_summary = format!(
        "Username: {}\nPhase: {}\nMessage count: {}\nAvg words per message: {:.1}\n\
         Weekly presence: {:.0}% of phase weeks\nWeeks active: {}\nDropout status: {}\n\
         Sentiment: positive={:.0}% negative={:.0}% neutral={:.0}%\n\
         Top emotions: {}\nTop topics: {}",
        username, phase_label,
        f.msg_count, f.avg_words, f.pct_weeks, f.weeks_active,
        f.dropout_status.as_deref().unwrap_or("unknown"),
        f.sentiment_positive.unwrap_or(0.0) * 100.0,
        f.sentiment_negative.unwrap_or(0.0) * 100.0,
        f.sentiment_neutral.unwrap_or(0.0) * 100.0,
        f.top_emotions.as_ref().map(|v| v.join(", ")).unwrap_or_default(),
        f.top_topics.as_ref().map(|v| v.join(", ")).unwrap_or_default(),
    );

    let sample_text = if sample_messages.is_empty() {
        "(no sample messages provided)".to_string()
    } else {
        sample_messages.iter().take(12)
            .map(|m| {
                let date = &m.date[..m.date.len().min(10)];
                let content: String = m.content.chars().take(200).collect();
                format!("[{}] {}", date, content)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let prompt = format!(
        "You are a qualitative researcher analyzing user personas in the Suno AI Discord community.\n\
         Suno is an AI music generation platform. Discord phases correspond to different product development stages.\n\n\
         PERSONA DEFINITIONS:\n{}\n\n\
         USER BEHAVIORAL PROFILE:\n{}\n\n\
         SAMPLE MESSAGES (up to 12):\n{}\n\n\
         Based on the behavioral profile and sample messages, assign the SINGLE BEST MATCHING persona.\n\
         Return JSON with keys: \"persona\" (exact label from definitions above), \
         \"confidence\" (0.0-1.0), \"reasoning\" (1-2 sentences explaining the choice).",
        persona_defs, features_summary, sample_text
    );

    let schema = json!({
        "type": "object",
        "properties": {
            "persona":    { "type": "string" },
            "confidence": { "type": "number" },
            "reasoning":  { "type": "string" }
        },
        "required": ["persona", "confidence", "reasoning"],
        "additionalProperties": false
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Internal(format!("HTTP client error: {}", e)))?;

    let body = json!({
        "model": model,
        "temperature": 0.1,
        "seed": 42,
        "messages": [{ "role": "user", "content": prompt }],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "persona_classification",
                "strict": true,
                "schema": schema
            }
        }
    });

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("OpenAI request failed: {}", e)))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("OpenAI error: {}", err)));
    }

    let resp_json: Value = resp.json().await
        .map_err(|e| AppError::Internal(format!("OpenAI parse error: {}", e)))?;

    let content = resp_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");
    let parsed: Value = serde_json::from_str(content)
        .map_err(|e| AppError::Internal(format!("JSON parse error: {}", e)))?;

    let persona    = parsed["persona"].as_str().unwrap_or("Casual Explorer").to_string();
    let confidence = parsed["confidence"].as_f64().unwrap_or(0.5).clamp(0.0, 1.0);
    let reasoning  = parsed["reasoning"].as_str().unwrap_or("").to_string();

    Ok((persona, confidence, reasoning))
}

// ── Save helper ───────────────────────────────────────────────────────────────

async fn save_classification(
    pool: &sqlx::PgPool,
    username: &str,
    phase: &str,
    phase_label: &str,
    method: &str,
    persona: &str,
    confidence: f64,
    reasoning: &str,
    features: &Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO persona_classifications
             (username, phase, phase_label, method, persona, confidence, reasoning, features, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (username, phase, method)
         DO UPDATE SET persona    = EXCLUDED.persona,
                       confidence = EXCLUDED.confidence,
                       reasoning  = EXCLUDED.reasoning,
                       features   = EXCLUDED.features,
                       updated_at = NOW()",
    )
    .bind(username)
    .bind(phase)
    .bind(phase_label)
    .bind(method)
    .bind(persona)
    .bind(confidence as f32)
    .bind(reasoning)
    .bind(features)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Route handlers ────────────────────────────────────────────────────────────

pub async fn classify(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
    Json(req): Json<ClassifyRequest>,
) -> Result<Json<Value>> {
    let features_json = json!({
        "msg_count":          req.features.msg_count,
        "avg_words":          req.features.avg_words,
        "pct_weeks":          req.features.pct_weeks,
        "weeks_active":       req.features.weeks_active,
        "dropout_status":     req.features.dropout_status,
        "sentiment_positive": req.features.sentiment_positive,
        "sentiment_negative": req.features.sentiment_negative,
        "sentiment_neutral":  req.features.sentiment_neutral,
        "top_emotions":       req.features.top_emotions,
        "top_topics":         req.features.top_topics,
    });

    let mut result = json!({});
    let samples = req.sample_messages.as_deref().unwrap_or(&[]);

    for method in &req.methods {
        match method.as_str() {
            "rule_based" => {
                let (persona, confidence, reasoning) = rule_based_classify(&req.features);
                save_classification(
                    &state.db, &req.username, &req.phase, &req.phase_label,
                    "rule_based", &persona, confidence, &reasoning, &features_json,
                ).await?;
                result["rule_based"] = json!({
                    "persona": persona, "confidence": confidence, "reasoning": reasoning
                });
            }
            "llm" => {
                let api_key = state
                    .get_openai_key(
                        headers.get("x-openai-key")
                            .and_then(|v| v.to_str().ok())
                            .filter(|s| !s.is_empty())
                            .map(String::from),
                    )
                    .await
                    .ok_or_else(|| AppError::BadRequest("OpenAI API key not set".into()))?;

                let model = req.model.as_deref().unwrap_or("gpt-4o-mini");
                let (persona, confidence, reasoning) = llm_classify(
                    &req.features, &req.username, &req.phase_label,
                    samples, &api_key, model,
                ).await?;
                save_classification(
                    &state.db, &req.username, &req.phase, &req.phase_label,
                    "llm", &persona, confidence, &reasoning, &features_json,
                ).await?;
                result["llm"] = json!({
                    "persona": persona, "confidence": confidence, "reasoning": reasoning
                });
            }
            _ => {}
        }
    }

    Ok(Json(result))
}

pub async fn list_for_user(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(username): Path<String>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;

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
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as created_at, \
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as updated_at \
         FROM persona_classifications WHERE {} ORDER BY phase, method",
        conditions.join(" AND ")
    );

    let mut query = sqlx::query(&sql);
    for b in &binds { query = query.bind(b); }

    let rows = query.fetch_all(&state.db).await?;
    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "username":    r.get::<String, _>("username"),
        "phase":       r.get::<String, _>("phase"),
        "phase_label": r.get::<String, _>("phase_label"),
        "method":      r.get::<String, _>("method"),
        "persona":     r.get::<String, _>("persona"),
        "confidence":  r.get::<f32, _>("confidence"),
        "reasoning":   r.get::<String, _>("reasoning"),
        "created_at":  r.get::<String, _>("created_at"),
        "updated_at":  r.get::<String, _>("updated_at"),
    })).collect();

    Ok(Json(json!(items)))
}

pub async fn phase_summary(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;

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

pub async fn by_phase(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;

    let rows = match &q.phase {
        Some(phase) => {
            sqlx::query(
                "SELECT username, method, persona, confidence, reasoning, \
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as created_at \
                 FROM persona_classifications WHERE phase = $1 ORDER BY username, method",
            )
            .bind(phase)
            .fetch_all(&state.db)
            .await?
        }
        None => {
            sqlx::query(
                "SELECT username, method, persona, confidence, reasoning, \
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') as created_at \
                 FROM persona_classifications ORDER BY username, method",
            )
            .fetch_all(&state.db)
            .await?
        }
    };

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "username":   r.get::<String, _>("username"),
        "method":     r.get::<String, _>("method"),
        "persona":    r.get::<String, _>("persona"),
        "confidence": r.get::<f32, _>("confidence"),
        "reasoning":  r.get::<String, _>("reasoning"),
        "created_at": r.get::<Option<String>, _>("created_at"),
    })).collect();

    Ok(Json(json!(items)))
}
