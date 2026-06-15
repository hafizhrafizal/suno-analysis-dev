use axum::{
    extract::{Multipart, Path, Query, State},
    http::HeaderMap,
    response::sse::{Event, Sse},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use uuid::Uuid;
use crate::{
    error::{AppError, Result},
    models::AuthUser,
    state::AppState,
};


// ── Transcripts ──────────────────────────────────────────────────────────────

pub async fn list_transcripts(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let rows = if mode.as_deref() == Some("multi") {
        sqlx::query(
            "SELECT id, title, source_type, youtube_url, youtube_id, created_at, updated_at,
                    length(content) as content_len, is_suno_team, source_date, interviewees
             FROM interview_transcripts
             WHERE user_id = $1
             ORDER BY created_at DESC",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT id, title, source_type, youtube_url, youtube_id, created_at, updated_at,
                    length(content) as content_len, is_suno_team, source_date, interviewees
             FROM interview_transcripts
             ORDER BY created_at DESC",
        )
        .fetch_all(&state.db)
        .await?
    };

    use sqlx::Row;
    let transcripts: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "title": r.get::<String, _>("title"),
                "source_type": r.get::<String, _>("source_type"),
                "youtube_url": r.get::<Option<String>, _>("youtube_url"),
                "youtube_id": r.get::<Option<String>, _>("youtube_id"),
                "created_at": r.get::<String, _>("created_at"),
                "updated_at": r.get::<String, _>("updated_at"),
                "content_length": r.get::<Option<i32>, _>("content_len").unwrap_or(0),
                "is_suno_team": r.get::<Option<bool>, _>("is_suno_team").unwrap_or(false),
                "source_date": r.get::<Option<String>, _>("source_date"),
                "interviewees": r.get::<Option<String>, _>("interviewees").unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(json!(transcripts)))
}

pub async fn get_transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT id, title, source_type, youtube_url, youtube_id, content, created_at, updated_at, is_suno_team, source_date, interviewees
         FROM interview_transcripts WHERE id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Transcript {} not found", id)))?;

    Ok(Json(json!({
        "id": row.get::<String, _>("id"),
        "title": row.get::<String, _>("title"),
        "source_type": row.get::<String, _>("source_type"),
        "youtube_url": row.get::<Option<String>, _>("youtube_url"),
        "youtube_id": row.get::<Option<String>, _>("youtube_id"),
        "content": row.get::<String, _>("content"),
        "created_at": row.get::<String, _>("created_at"),
        "updated_at": row.get::<String, _>("updated_at"),
        "is_suno_team": row.get::<Option<bool>, _>("is_suno_team").unwrap_or(false),
        "source_date": row.get::<Option<String>, _>("source_date"),
        "interviewees": row.get::<Option<String>, _>("interviewees").unwrap_or_default(),
    })))
}

/// Upload a text/PDF file as a transcript
pub async fn upload_transcript(
    State(state): State<AppState>,
    user: AuthUser,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let user_id = if mode.as_deref() == Some("multi") { Some(user.id) } else { None };

    let mut title: Option<String> = None;
    let mut content: Option<String> = None;
    let mut is_suno_team = false;
    let mut document_date: Option<String> = None;
    let mut interviewees = String::new();

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        AppError::BadRequest(format!("multipart error: {}", e))
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "title" => {
                title = Some(field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?);
            }
            "is_suno_team" => {
                let v = field.text().await.unwrap_or_default();
                is_suno_team = v == "true" || v == "1";
            }
            "document_date" => {
                let v = field.text().await.unwrap_or_default();
                document_date = if v.trim().is_empty() { None } else { Some(v.trim().to_string()) };
            }
            "interviewees" => {
                interviewees = field.text().await.unwrap_or_default().trim().to_string();
            }
            "file" => {
                let filename = field.file_name().unwrap_or("upload").to_lowercase();
                let bytes = field.bytes().await.map_err(|e| AppError::BadRequest(e.to_string()))?;

                if filename.ends_with(".pdf") {
                    content = Some(extract_pdf_text(&bytes)?);
                } else {
                    content = Some(
                        String::from_utf8(bytes.to_vec())
                            .map_err(|_| AppError::BadRequest("File is not valid UTF-8 text".into()))?,
                    );
                }
            }
            _ => {}
        }
    }

    let content = content.ok_or_else(|| AppError::BadRequest("No file provided".into()))?;
    let title = title.unwrap_or_else(|| "Untitled Interview".to_string());
    let id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO interview_transcripts (id, title, source_type, content, is_suno_team, source_date, interviewees, user_id)
         VALUES ($1, $2, 'upload', $3, $4, $5, $6, $7)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&content)
    .bind(is_suno_team)
    .bind(document_date)
    .bind(&interviewees)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

fn extract_pdf_text(bytes: &[u8]) -> std::result::Result<String, AppError> {
    pdf_extract::extract_text_from_mem(bytes)
        .map_err(|e| AppError::BadRequest(format!("Failed to extract PDF text: {}", e)))
}

#[derive(Debug, Deserialize)]
pub struct YoutubeRequest {
    pub url: String,
    pub title: Option<String>,
    pub format_qa: Option<bool>,
    pub is_suno_team: Option<bool>,
    pub interviewees: Option<String>,
}

/// Transcribe a YouTube video. Primary method: fetch built-in caption track (no API key needed).
/// Fallback: download audio via InnerTube and transcribe with OpenAI Whisper (requires API key).
pub async fn transcribe_youtube(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: AuthUser,
    Json(req): Json<YoutubeRequest>,
) -> Sse<impl futures::Stream<Item = std::result::Result<Event, Infallible>>> {
    let api_key = headers
        .get("x-openai-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .map(String::from);

    let mode = state.get_app_mode().await;
    let user_id = if mode.as_deref() == Some("multi") { Some(user.id) } else { None };
    let youtube_url = req.url.clone();
    let user_title = req.title.clone().filter(|t| !t.trim().is_empty());
    let format_qa = req.format_qa.unwrap_or(false);
    let is_suno_team = req.is_suno_team.unwrap_or(false);
    let interviewees = req.interviewees.clone().unwrap_or_default().trim().to_string();
    let db = state.db.clone();

    let stream = async_stream::stream! {
        macro_rules! sse_err {
            ($msg:expr) => {{
                yield Ok::<Event, Infallible>(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message": $msg})).unwrap()
                ));
                return;
            }};
        }
        macro_rules! sse_progress {
            ($msg:expr) => {
                yield Ok::<Event, Infallible>(Event::default().data(
                    serde_json::to_string(&json!({"type":"progress","message": $msg})).unwrap()
                ));
            };
        }

        let video_id = match extract_youtube_id(&youtube_url) {
            Some(id) => id,
            None => sse_err!("Could not extract video ID from URL. Use a standard youtube.com/watch?v= or youtu.be/ link."),
        };

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_default();

        // Auto-fetch video title and publish date
        sse_progress!("Fetching video info…");
        let title = match user_title {
            Some(t) => t,
            None => get_youtube_title(&youtube_url).await
                .unwrap_or_else(|| "YouTube Transcript".to_string()),
        };
        let video_date = get_youtube_date(&youtube_url).await;
        tracing::info!(video_id, title, "Using title for transcript");

        sse_progress!("Checking for YouTube captions…");

        let transcript_text = match fetch_youtube_captions(&http, &video_id).await {
            Ok(text) => {
                sse_progress!(format!("Captions found ({} chars). Processing…", text.len()));
                text
            }
            Err(caption_err) => {
                tracing::debug!(%caption_err, "No YouTube captions, falling back to Whisper");
                sse_progress!(format!("No captions ({}). Trying audio transcription…", caption_err));

                let ak = match api_key {
                    Some(ref k) if !k.is_empty() => k.clone(),
                    _ => sse_err!(
                        "No YouTube captions found and no OpenAI API key set. \
                         Set an API key via the key button to enable Whisper transcription as fallback."
                    ),
                };

                sse_progress!("Fetching audio from YouTube…");

                let yt_url = format!("https://www.youtube.com/watch?v={}", video_id);
                let (audio_bytes, ext) = match ytdlp_audio(&yt_url).await {
                    Ok(r) => {
                        sse_progress!(format!("Audio via yt-dlp ({:.1} MB). Transcribing…", r.0.len() as f64 / 1_048_576.0));
                        r
                    }
                    Err(ytdlp_err) => {
                        tracing::debug!(%ytdlp_err, "yt-dlp audio failed, trying InnerTube");
                        match download_youtube_audio(&http, &video_id).await {
                            Ok(r) => r,
                            Err(e) => sse_err!(e),
                        }
                    }
                };

                sse_progress!(format!("Transcribing {:.1}MB audio with Whisper…", audio_bytes.len() as f64 / 1_048_576.0));

                let mime = if ext == "webm" { "audio/webm" } else { "audio/mp4" };
                let part = match reqwest::multipart::Part::bytes(audio_bytes)
                    .file_name(format!("audio.{}", ext))
                    .mime_str(mime)
                {
                    Ok(p) => p,
                    Err(e) => sse_err!(format!("Failed to build request: {}", e)),
                };
                let form = reqwest::multipart::Form::new()
                    .part("file", part)
                    .text("model", "whisper-1");

                let whisper_resp = http
                    .post("https://api.openai.com/v1/audio/transcriptions")
                    .bearer_auth(&ak)
                    .multipart(form)
                    .send()
                    .await;

                match whisper_resp {
                    Err(e) => sse_err!(format!("Whisper request failed: {}", e)),
                    Ok(r) => {
                        let status = r.status();
                        let body = r.text().await.unwrap_or_default();
                        if !status.is_success() {
                            sse_err!(format!("Whisper error {}: {}", status, &body[..body.len().min(300)]));
                        }
                        match serde_json::from_str::<Value>(&body) {
                            Ok(v) => {
                                let t = v["text"].as_str().unwrap_or("").to_string();
                                if t.trim().is_empty() {
                                    sse_err!("Whisper returned empty text. The video may contain no speech.");
                                }
                                t
                            }
                            Err(_) => sse_err!("Failed to parse Whisper response"),
                        }
                    }
                }
            }
        };

        // Optionally format the transcript as Q&A using GPT
        let final_text = if format_qa {
            let ak = api_key.as_deref().unwrap_or("");
            if ak.is_empty() {
                sse_progress!("No OpenAI key — skipping Q&A formatting.");
                transcript_text
            } else {
                sse_progress!("Formatting transcript as Q&A with GPT…");
                match format_transcript_qa(&http, ak, &transcript_text).await {
                    Ok(formatted) => {
                        sse_progress!("Q&A formatting done.");
                        formatted
                    }
                    Err(e) => {
                        tracing::warn!(%e, "Q&A formatting failed, using raw transcript");
                        sse_progress!(format!("Q&A formatting failed ({}), saving raw transcript.", e));
                        transcript_text
                    }
                }
            }
        } else {
            transcript_text
        };

        sse_progress!("Saving transcript…");

        let id = Uuid::new_v4().to_string();
        let insert_result = sqlx::query(
            "INSERT INTO interview_transcripts
             (id, title, source_type, youtube_url, youtube_id, content, is_suno_team, source_date, interviewees, user_id)
             VALUES ($1, $2, 'youtube', $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(&id)
        .bind(&title)
        .bind(&youtube_url)
        .bind(&video_id)
        .bind(&final_text)
        .bind(is_suno_team)
        .bind(video_date)
        .bind(&interviewees)
        .bind(user_id)
        .execute(&db)
        .await;

        match insert_result {
            Err(e) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message":format!("DB error: {}", e)})).unwrap()
                ));
            }
            Ok(_) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"done","id":id,"title":title})).unwrap()
                ));
            }
        }
    };

    Sse::new(stream).keep_alive(Default::default())
}

/// Fetch transcript from YouTube. Tries in order:
/// 1. yt-dlp subtitles (best — handles anti-bot, no API key needed)
/// 2. Direct timedtext API URL
/// 3. Watch page captionTracks extraction
/// 4. Full ytInitialPlayerResponse parse
async fn fetch_youtube_captions(
    http: &reqwest::Client,
    video_id: &str,
) -> std::result::Result<String, String> {
    let video_url = format!("https://www.youtube.com/watch?v={}", video_id);

    // ── Method 1: yt-dlp subtitles ───────────────────────────────────────────
    match ytdlp_subtitles(&video_url).await {
        Ok(t) if !t.trim().is_empty() => {
            tracing::info!(video_id, "Captions via yt-dlp");
            return Ok(t);
        }
        Ok(_) => {}
        Err(ref e) if e.contains("not installed") => {
            tracing::debug!("yt-dlp not installed, trying HTTP methods");
        }
        Err(ref e) => {
            tracing::debug!(error = %e, "yt-dlp subtitles failed");
        }
    }

    // ── Method 2: direct timedtext API URL ───────────────────────────────────
    for lang in ["en", "en-US", "en-GB"] {
        let url = format!(
            "https://www.youtube.com/api/timedtext?v={}&lang={}&fmt=json3",
            video_id, lang
        );
        match fetch_caption_json(http, &url).await {
            Ok(t) if !t.trim().is_empty() => {
                tracing::info!(video_id, lang, "Captions via direct timedtext URL");
                return Ok(t);
            }
            _ => {}
        }
    }

    // ── Method 3 & 4: parse watch page ───────────────────────────────────────
    let html = http
        .get(&video_url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Cookie", "SOCS=CAESEwgDEgk0NTgzNzI2MxoEGgAgYQ; CONSENT=YES+cb")
        .send()
        .await
        .map_err(|e| format!("Page fetch failed: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Page read failed: {}", e))?;

    let caption_url = extract_caption_url_direct(&html)
        .or_else(|| extract_player_response_caption_url(&html))
        .ok_or_else(|| {
            if html.contains("consent.youtube.com") || html.len() < 5000 {
                "YouTube requires consent or login — captions unavailable".to_string()
            } else {
                "No caption tracks found (video may have captions disabled)".to_string()
            }
        })?;

    tracing::info!(video_id, "Got caption URL from watch page");
    let text = fetch_caption_json(http, &caption_url).await?;
    if text.trim().is_empty() {
        return Err("Caption content was empty".to_string());
    }
    Ok(text)
}

async fn fetch_caption_json(http: &reqwest::Client, url: &str) -> std::result::Result<String, String> {
    let resp = http
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send()
        .await
        .map_err(|e| format!("Caption request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Caption HTTP {}", resp.status()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Caption read failed: {}", e))?;

    // Try JSON3 format first
    if let Ok(cap) = serde_json::from_str::<Value>(&body) {
        if let Some(events) = cap["events"].as_array() {
            let mut parts: Vec<String> = Vec::new();
            for ev in events {
                if let Some(segs) = ev["segs"].as_array() {
                    let line: String = segs
                        .iter()
                        .filter_map(|s| s["utf8"].as_str())
                        .collect::<Vec<_>>()
                        .join("");
                    let trimmed = line.replace('\n', " ").trim().to_string();
                    if !trimmed.is_empty() {
                        parts.push(trimmed);
                    }
                }
            }
            return Ok(parts.join(" "));
        }
    }

    // Fall back to XML format (YouTube's default caption format)
    if body.contains("<transcript>") || body.contains("<timedtext") {
        return parse_caption_xml(&body);
    }

    Err(format!(
        "Unrecognized caption format: {}",
        &body[..body.len().min(120)]
    ))
}

fn parse_caption_xml(xml: &str) -> std::result::Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut rest = xml;
    while let Some(tag_start) = rest.find("<text ").or_else(|| rest.find("<text>")) {
        rest = &rest[tag_start..];
        let tag_end = rest.find('>').ok_or("Invalid caption XML")?;
        rest = &rest[tag_end + 1..];
        let text_end = rest.find("</text>").ok_or("Invalid caption XML: missing </text>")?;
        let raw = &rest[..text_end];
        rest = &rest[text_end + 7..];
        let decoded = raw
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&#x27;", "'")
            .replace('\n', " ");
        let trimmed = decoded.trim().to_string();
        if !trimmed.is_empty() {
            parts.push(trimmed);
        }
    }
    if parts.is_empty() {
        return Err("No text found in XML captions".to_string());
    }
    Ok(parts.join(" "))
}

/// Fast path: search for `captionTracks` JSON array directly in HTML, no full player parse.
fn extract_caption_url_direct(html: &str) -> Option<String> {
    let pos = html.find("\"captionTracks\":")?;
    let after = &html[pos + "\"captionTracks\":".len()..];
    let arr_start = after.find('[')?;
    let s = &after[arr_start..];

    // Balance brackets to find end of array
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    let mut end = 0usize;
    for (i, c) in s.char_indices() {
        if escape { escape = false; continue; }
        match c {
            '\\' if in_str => escape = true,
            '"' => in_str = !in_str,
            '[' | '{' if !in_str => depth += 1,
            ']' | '}' if !in_str => {
                depth -= 1;
                if depth == 0 { end = i + 1; break; }
            }
            _ => {}
        }
    }
    if end == 0 { return None; }

    let tracks: Vec<Value> = serde_json::from_str(&s[..end]).ok()?;
    pick_caption_url(&tracks)
}

/// Fallback: extract caption URL via full ytInitialPlayerResponse parse.
fn extract_player_response_caption_url(html: &str) -> Option<String> {
    for marker in ["var ytInitialPlayerResponse = ", "ytInitialPlayerResponse="] {
        if let Some(pos) = html.find(marker) {
            let rest = &html[pos + marker.len()..];
            let json_start = rest.find('{')?;
            let s = &rest[json_start..];

            let mut depth = 0i32;
            let mut in_str = false;
            let mut escape = false;
            let mut end = 0usize;
            for (i, c) in s.char_indices() {
                if escape { escape = false; continue; }
                match c {
                    '\\' if in_str => escape = true,
                    '"' => in_str = !in_str,
                    '{' if !in_str => depth += 1,
                    '}' if !in_str => {
                        depth -= 1;
                        if depth == 0 { end = i + 1; break; }
                    }
                    _ => {}
                }
            }
            if end == 0 { continue; }

            if let Ok(player) = serde_json::from_str::<Value>(&s[..end]) {
                if let Some(tracks) = player
                    .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
                    .and_then(|v| v.as_array())
                    .filter(|a| !a.is_empty())
                {
                    return pick_caption_url(tracks);
                }
            }
        }
    }
    None
}

fn pick_caption_url(tracks: &[Value]) -> Option<String> {
    let track = tracks
        .iter()
        .find(|t| {
            t["languageCode"].as_str().map_or(false, |l| l.starts_with("en"))
                && t["kind"].as_str().map_or(true, |k| k != "asr")
        })
        .or_else(|| {
            tracks
                .iter()
                .find(|t| t["languageCode"].as_str().map_or(false, |l| l.starts_with("en")))
        })
        .or_else(|| tracks.first())?;

    let base_url = track["baseUrl"].as_str()?;
    Some(format!("{}&fmt=json3", base_url))
}

/// InnerTube client descriptor
struct InnerTubeClient {
    name: &'static str,
    version: &'static str,
    user_agent: &'static str,
    api_key: &'static str,
    client_id: &'static str, // numeric, sent as X-YouTube-Client-Name header
}

const INNERTUBE_CLIENTS: &[InnerTubeClient] = &[
    // TVHTML5 — TV browser client, no po_token required, returns direct URLs for most public videos
    InnerTubeClient {
        name: "TVHTML5",
        version: "7.20231027.00.00",
        user_agent: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1",
        api_key: "AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8",
        client_id: "7",
    },
    // Android — direct URLs
    InnerTubeClient {
        name: "ANDROID",
        version: "19.44.38",
        user_agent: "com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip",
        api_key: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
        client_id: "3",
    },
    // iOS — direct URLs
    InnerTubeClient {
        name: "IOS",
        version: "19.45.4",
        user_agent: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)",
        api_key: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
        client_id: "5",
    },
    // ANDROID_TESTSUITE — legacy fallback
    InnerTubeClient {
        name: "ANDROID_TESTSUITE",
        version: "1.9",
        user_agent: "com.google.android.youtube/1.9 (Linux; U; Android 11) gzip",
        api_key: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
        client_id: "30",
    },
];

/// Download the lowest-bitrate audio stream for a YouTube video.
/// Tries multiple InnerTube clients in sequence until one succeeds.
/// Returns (audio_bytes, extension) where extension is "m4a" or "webm".
async fn download_youtube_audio(
    http: &reqwest::Client,
    video_id: &str,
) -> std::result::Result<(Vec<u8>, String), String> {
    let mut last_err = String::from("All clients failed");

    for client in INNERTUBE_CLIENTS {
        match try_innertube_client(http, video_id, client).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                tracing::debug!(client = client.name, error = %e, "InnerTube client failed, trying next");
                last_err = e;
            }
        }
    }

    Err(format!(
        "Could not retrieve audio. {}. \
         The video may be private, age-restricted, or region-locked.",
        last_err
    ))
}

async fn try_innertube_client(
    http: &reqwest::Client,
    video_id: &str,
    client: &InnerTubeClient,
) -> std::result::Result<(Vec<u8>, String), String> {
    let mut ctx = json!({
        "clientName": client.name,
        "clientVersion": client.version,
        "hl": "en",
        "gl": "US",
        "utcOffsetMinutes": 0
    });

    if client.name == "IOS" {
        ctx["deviceMake"] = json!("Apple");
        ctx["deviceModel"] = json!("iPhone16,2");
        ctx["osName"] = json!("iPhone");
        ctx["osVersion"] = json!("18.1.0.22B83");
    }
    if client.name.starts_with("ANDROID") {
        ctx["androidSdkVersion"] = json!(30);
    }

    let body = json!({
        "context": { "client": ctx },
        "videoId": video_id
    });

    let url = format!(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key={}",
        client.api_key
    );

    let resp = http
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", client.user_agent)
        .header("X-YouTube-Client-Name", client.client_id)
        .header("X-YouTube-Client-Version", client.version)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed ({}): {}", client.name, e))?;

    let http_status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("Read response failed ({}): {}", client.name, e))?;

    tracing::debug!(client = client.name, http_status = %http_status, "InnerTube response");

    if !http_status.is_success() {
        return Err(format!("HTTP {} from YouTube ({})", http_status, client.name));
    }

    let data: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("JSON parse failed ({}): {} — body: {}", client.name, e, &body_text[..body_text.len().min(200)]))?;

    // Check for top-level API error (different structure from playabilityStatus error)
    if let Some(err) = data.pointer("/error/message").and_then(|v| v.as_str()) {
        return Err(format!("YouTube API error ({}): {}", client.name, err));
    }

    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");

    tracing::debug!(client = client.name, playability_status = status, "Playability status");

    if status != "OK" {
        let reason = data
            .pointer("/playabilityStatus/reason")
            .and_then(|v| v.as_str())
            .or_else(|| {
                data.pointer("/playabilityStatus/messages/0")
                    .and_then(|v| v.as_str())
            })
            .unwrap_or(status); // fall back to the status string itself
        return Err(format!("{} ({})", reason, client.name));
    }

    let formats = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("No adaptiveFormats in response ({})", client.name))?;

    // Keep only audio-only formats that have a direct URL (not ciphered)
    let mut audio: Vec<&Value> = formats
        .iter()
        .filter(|f| {
            f["mimeType"]
                .as_str()
                .map_or(false, |m| m.starts_with("audio/"))
                && f.get("url").and_then(|u| u.as_str()).is_some()
        })
        .collect();

    if audio.is_empty() {
        return Err(format!(
            "No direct audio URL found ({}). Streams may be cipher-protected.",
            client.name
        ));
    }

    // Pick lowest bitrate to stay under Whisper's 25 MB limit
    audio.sort_by_key(|f| f["bitrate"].as_i64().unwrap_or(i64::MAX));
    let chosen = audio[0];

    let audio_url = chosen["url"].as_str().unwrap();
    let mime = chosen["mimeType"].as_str().unwrap_or("audio/mp4");
    let ext = if mime.contains("webm") || mime.contains("opus") {
        "webm"
    } else {
        "m4a"
    };

    tracing::info!(
        video_id,
        client = client.name,
        bitrate = chosen["bitrate"].as_i64().unwrap_or(0),
        mime,
        "Downloading YouTube audio"
    );

    let audio_resp = http
        .get(audio_url)
        .header("User-Agent", client.user_agent)
        .send()
        .await
        .map_err(|e| format!("Audio download failed ({}): {}", client.name, e))?;

    let bytes = audio_resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read audio data ({}): {}", client.name, e))?
        .to_vec();

    const WHISPER_LIMIT: usize = 24 * 1024 * 1024; // 24 MB (Whisper cap is 25 MB)
    if bytes.len() > WHISPER_LIMIT {
        return Err(format!(
            "Audio is {:.0} MB which exceeds Whisper's 25 MB limit. \
             Try a shorter video (under ~30 minutes at low quality).",
            bytes.len() as f64 / 1_048_576.0
        ));
    }

    Ok((bytes, ext.to_string()))
}

/// Fetch the YouTube video title via yt-dlp (fast, no download).
async fn get_youtube_title(video_url: &str) -> Option<String> {
    let out = tokio::process::Command::new("yt-dlp")
        .args([
            "--print", "%(title)s",
            "--skip-download",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            video_url,
        ])
        .output()
        .await
        .ok()?;

    if !out.status.success() { return None; }
    let title = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if title.is_empty() || title == "NA" { None } else { Some(title) }
}

/// Fetch the YouTube video publish date via yt-dlp (returns YYYY-MM-DD).
async fn get_youtube_date(video_url: &str) -> Option<String> {
    let out = tokio::process::Command::new("yt-dlp")
        .args([
            "--print", "%(upload_date)s",
            "--skip-download",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            video_url,
        ])
        .output()
        .await
        .ok()?;

    if !out.status.success() { return None; }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() || raw == "NA" { return None; }
    // yt-dlp returns YYYYMMDD — reformat to YYYY-MM-DD
    if raw.len() == 8 {
        Some(format!("{}-{}-{}", &raw[..4], &raw[4..6], &raw[6..8]))
    } else {
        Some(raw)
    }
}

/// Format a raw transcript as a clean Q&A interview using GPT-4o-mini.
async fn format_transcript_qa(
    http: &reqwest::Client,
    api_key: &str,
    raw: &str,
) -> std::result::Result<String, String> {
    // GPT-4o-mini has 128k context; keep well within limits
    const MAX_CHARS: usize = 300_000;
    let text = if raw.len() > MAX_CHARS { &raw[..MAX_CHARS] } else { raw };

    let prompt = format!(
        "You are an expert transcript editor. Format this interview transcript as a clean, readable Q&A.\n\
         Rules:\n\
         - Label interviewer questions with \"Q:\"\n\
         - Label interviewee answers with \"A:\"\n\
         - Remove filler words (um, uh, like, you know, basically)\n\
         - Fix grammar and capitalization\n\
         - Separate each exchange with a blank line\n\
         - Preserve ALL key content and meaning — do not summarize or omit anything\n\
         Return ONLY the formatted transcript, no preamble.\n\n\
         TRANSCRIPT:\n{}", text
    );

    let resp = http
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&json!({
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3
        }))
        .send()
        .await
        .map_err(|e| format!("GPT request failed: {}", e))?;

    let status = resp.status();
    let data: Value = resp.json().await
        .map_err(|e| format!("GPT parse failed: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "GPT error {}: {}",
            status,
            data.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("unknown")
        ));
    }

    data.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| "GPT returned empty content".to_string())
}

// ── Format-QA endpoint (post-hoc formatting for any transcript) ──────────────

pub async fn format_transcript_qa_endpoint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let api_key = headers
        .get("x-openai-key")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("No OpenAI API key provided".into()))?
        .to_string();

    use sqlx::Row;
    let row = sqlx::query("SELECT content FROM interview_transcripts WHERE id = $1")
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Transcript {} not found", id)))?;

    let raw: String = row.get("content");

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_default();

    let formatted = format_transcript_qa(&http, &api_key, &raw)
        .await
        .map_err(|e| AppError::BadRequest(e))?;

    sqlx::query(
        "UPDATE interview_transcripts SET content = $1,
         updated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = $2",
    )
    .bind(&formatted)
    .bind(&id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "updated": id, "content": formatted })))
}

/// Download YouTube subtitles via yt-dlp (SRT format, no ffmpeg needed).
async fn ytdlp_subtitles(video_url: &str) -> std::result::Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let stem = format!("ytsub_{}", &uuid::Uuid::new_v4().to_string().replace('-', "")[..12]);
    let out_template = temp_dir.join(&stem).to_string_lossy().replace('\\', "/");

    let out = tokio::process::Command::new("yt-dlp")
        .args([
            "--write-auto-subs",
            "--write-subs",
            "--sub-lang", "en.*",
            "--sub-format", "srt",
            "--skip-download",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "-o", &out_template,
            video_url,
        ])
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp not installed".to_string()
            } else {
                format!("yt-dlp exec: {}", e)
            }
        })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("yt-dlp: {}", stderr.trim().chars().take(200).collect::<String>()));
    }

    // yt-dlp writes: {out_template}.en.srt, .en-orig.srt, .en-US.srt, etc.
    let entries = std::fs::read_dir(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&stem) && name.ends_with(".srt") {
            let content = tokio::fs::read_to_string(entry.path())
                .await
                .map_err(|e| format!("read subtitle: {}", e))?;
            let _ = tokio::fs::remove_file(entry.path()).await;
            return parse_srt(&content);
        }
    }
    Err("yt-dlp ran but no .srt file created (video may lack English captions)".to_string())
}

/// Download YouTube audio via yt-dlp (best audio format, no ffmpeg required).
async fn ytdlp_audio(video_url: &str) -> std::result::Result<(Vec<u8>, String), String> {
    let temp_dir = std::env::temp_dir();
    let stem = format!("ytaudio_{}", &uuid::Uuid::new_v4().to_string().replace('-', "")[..12]);
    // %(ext)s lets yt-dlp choose the extension
    let out_template = temp_dir
        .join(format!("{}.%(ext)s", stem))
        .to_string_lossy()
        .replace('\\', "/");

    let out = tokio::process::Command::new("yt-dlp")
        .args([
            "--format", "bestaudio[filesize<24M]/bestaudio",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "-o", &out_template,
            video_url,
        ])
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "yt-dlp not installed".to_string()
            } else {
                format!("yt-dlp exec: {}", e)
            }
        })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("yt-dlp audio: {}", stderr.trim().chars().take(200).collect::<String>()));
    }

    let entries = std::fs::read_dir(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&stem) {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("webm")
                .to_string();
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| format!("read audio: {}", e))?;
            let _ = tokio::fs::remove_file(&path).await;
            const LIMIT: usize = 24 * 1024 * 1024;
            if bytes.len() > LIMIT {
                return Err(format!(
                    "Audio {:.0} MB exceeds Whisper 25 MB limit — try a shorter video.",
                    bytes.len() as f64 / 1_048_576.0
                ));
            }
            return Ok((bytes, ext));
        }
    }
    Err("yt-dlp audio: no output file found".to_string())
}

fn parse_srt(srt: &str) -> std::result::Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut prev = String::new();
    for line in srt.lines() {
        let t = line.trim();
        // Skip blank lines, sequence numbers, and timestamps
        if t.is_empty()
            || t.chars().all(|c| c.is_ascii_digit())
            || t.contains("-->")
        {
            continue;
        }
        // Strip HTML tags (e.g. <i>, <b>, <c>)
        let mut clean = String::new();
        let mut in_tag = false;
        for c in t.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => clean.push(c),
                _ => {}
            }
        }
        let clean = clean.trim().to_string();
        if !clean.is_empty() && clean != prev {
            parts.push(clean.clone());
            prev = clean;
        }
    }
    if parts.is_empty() {
        return Err("SRT has no text content".to_string());
    }
    Ok(parts.join(" "))
}

fn extract_youtube_id(url: &str) -> Option<String> {
    if let Some(pos) = url.find("youtu.be/") {
        let rest = &url[pos + 9..];
        let id: String = rest.chars().take_while(|&c| c != '?' && c != '&' && c != '/').collect();
        if !id.is_empty() { return Some(id); }
    }
    if let Some(pos) = url.find("v=") {
        let rest = &url[pos + 2..];
        let id: String = rest.chars().take_while(|&c| c != '&' && c != '#').collect();
        if !id.is_empty() { return Some(id); }
    }
    if let Some(pos) = url.find("/embed/") {
        let rest = &url[pos + 7..];
        let id: String = rest.chars().take_while(|&c| c != '?' && c != '&' && c != '/').collect();
        if !id.is_empty() { return Some(id); }
    }
    None
}

#[derive(Debug, Deserialize)]
pub struct UpdateTranscriptRequest {
    pub title: Option<String>,
    pub content: Option<String>,
    pub is_suno_team: Option<bool>,
    pub source_date: Option<String>,
    pub interviewees: Option<String>,
}

pub async fn update_transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTranscriptRequest>,
) -> Result<Json<Value>> {
    // Single atomic UPDATE:
    // COALESCE(param, col) — keeps existing when param is NULL (field absent from JSON)
    // source_date uses CASE WHEN so that NULL param (absent) ≠ empty-string param (clear)
    let affected = sqlx::query(
        "UPDATE interview_transcripts SET
             title        = COALESCE($1, title),
             content      = COALESCE($2, content),
             is_suno_team = COALESCE($3, is_suno_team),
             source_date  = CASE WHEN $4 IS NOT NULL THEN NULLIF($4, '') ELSE source_date END,
             interviewees = COALESCE($5, interviewees),
             updated_at   = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = $6",
    )
    .bind(req.title.as_deref())
    .bind(req.content.as_deref())
    .bind(req.is_suno_team)
    .bind(req.source_date.as_deref())
    .bind(req.interviewees.as_deref())
    .bind(&id)
    .execute(&state.db)
    .await?
    .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("Transcript {} not found", id)));
    }
    Ok(Json(json!({ "updated": id })))
}

pub async fn delete_transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let affected = sqlx::query("DELETE FROM interview_transcripts WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("Transcript {} not found", id)));
    }
    Ok(Json(json!({ "deleted": id })))
}

// ── Interview Bookmarks ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateInterviewBookmarkRequest {
    pub interview_id: String,
    pub excerpt: String,
    pub note: Option<String>,
    pub char_start: Option<i32>,
    pub char_end: Option<i32>,
}

pub async fn create_interview_bookmark(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateInterviewBookmarkRequest>,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let user_id = if mode.as_deref() == Some("multi") { Some(user.id) } else { None };

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO interview_bookmarks
         (interview_id, excerpt, note, char_start, char_end, user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(&req.interview_id)
    .bind(&req.excerpt)
    .bind(req.note.as_deref().unwrap_or(""))
    .bind(req.char_start)
    .bind(req.char_end)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "id": id,
        "interview_id": req.interview_id,
        "excerpt": req.excerpt,
    })))
}

#[derive(Debug, Deserialize)]
pub struct InterviewBookmarksQuery {
    pub interview_id: Option<String>,
}

pub async fn list_interview_bookmarks(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<InterviewBookmarksQuery>,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let is_multi = mode.as_deref() == Some("multi");

    let rows = match (q.interview_id.as_deref(), is_multi) {
        (Some(iid), true) => sqlx::query(
            "SELECT ib.id, ib.interview_id, ib.excerpt, ib.note, ib.char_start, ib.char_end, ib.created_at,
                    it.interviewees, it.source_date
             FROM interview_bookmarks ib
             JOIN interview_transcripts it ON it.id = ib.interview_id
             WHERE ib.interview_id = $1 AND ib.user_id = $2
             ORDER BY ib.char_start ASC NULLS LAST, ib.created_at ASC",
        )
        .bind(iid)
        .bind(user.id)
        .fetch_all(&state.db)
        .await?,
        (Some(iid), false) => sqlx::query(
            "SELECT ib.id, ib.interview_id, ib.excerpt, ib.note, ib.char_start, ib.char_end, ib.created_at,
                    it.interviewees, it.source_date
             FROM interview_bookmarks ib
             JOIN interview_transcripts it ON it.id = ib.interview_id
             WHERE ib.interview_id = $1
             ORDER BY ib.char_start ASC NULLS LAST, ib.created_at ASC",
        )
        .bind(iid)
        .fetch_all(&state.db)
        .await?,
        (None, true) => sqlx::query(
            "SELECT ib.id, ib.interview_id, ib.excerpt, ib.note, ib.char_start, ib.char_end, ib.created_at,
                    it.interviewees, it.source_date
             FROM interview_bookmarks ib
             JOIN interview_transcripts it ON it.id = ib.interview_id
             WHERE ib.user_id = $1
             ORDER BY ib.created_at DESC",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?,
        (None, false) => sqlx::query(
            "SELECT ib.id, ib.interview_id, ib.excerpt, ib.note, ib.char_start, ib.char_end, ib.created_at,
                    it.interviewees, it.source_date
             FROM interview_bookmarks ib
             JOIN interview_transcripts it ON it.id = ib.interview_id
             ORDER BY ib.created_at DESC",
        )
        .fetch_all(&state.db)
        .await?,
    };

    if rows.is_empty() {
        return Ok(Json(json!([])));
    }

    use sqlx::Row;
    use std::collections::HashMap;

    let bm_ids: Vec<i64> = rows.iter().map(|r| r.get::<i64, _>("id")).collect();
    let id_list = bm_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");

    let codes_sql = format!(
        "SELECT ibc.bookmark_id, c.id, c.name, c.color
         FROM interview_bookmark_codes ibc JOIN codes c ON c.id = ibc.code_id
         WHERE ibc.bookmark_id IN ({id})
         UNION
         SELECT ibh.bookmark_id, c.id, c.name, c.color
         FROM interview_bookmark_highlights ibh JOIN codes c ON c.id = ibh.code_id
         WHERE ibh.bookmark_id IN ({id})",
        id = id_list
    );
    let codes_rows = sqlx::query(&codes_sql).fetch_all(&state.db).await?;
    let mut codes_map: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in &codes_rows {
        let bm_id: i64 = r.get("bookmark_id");
        let code_id: i64 = r.get("id");
        let entry = codes_map.entry(bm_id).or_default();
        if !entry.iter().any(|c| c["id"].as_i64() == Some(code_id)) {
            entry.push(json!({
                "id": code_id,
                "name": r.get::<String, _>("name"),
                "color": r.get::<String, _>("color"),
            }));
        }
    }

    let hl_sql = format!(
        "SELECT ibh.id, ibh.bookmark_id, ibh.code_id,
                c.name as code_name, c.color as code_color, ibh.highlighted_text
         FROM interview_bookmark_highlights ibh
         JOIN codes c ON c.id = ibh.code_id
         WHERE ibh.bookmark_id IN ({})",
        id_list
    );
    let hl_rows = sqlx::query(&hl_sql).fetch_all(&state.db).await?;
    let mut hl_map: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in &hl_rows {
        let bm_id: i64 = r.get("bookmark_id");
        hl_map.entry(bm_id).or_default().push(json!({
            "id": r.get::<i64, _>("id"),
            "code_id": r.get::<i64, _>("code_id"),
            "code_name": r.get::<String, _>("code_name"),
            "code_color": r.get::<String, _>("code_color"),
            "highlighted_text": r.get::<String, _>("highlighted_text"),
        }));
    }

    let bookmarks: Vec<Value> = rows
        .iter()
        .map(|r| {
            let bm_id: i64 = r.get("id");
            json!({
                "id": bm_id,
                "interview_id": r.get::<String, _>("interview_id"),
                "excerpt": r.get::<String, _>("excerpt"),
                "note": r.get::<String, _>("note"),
                "char_start": r.get::<Option<i32>, _>("char_start"),
                "char_end": r.get::<Option<i32>, _>("char_end"),
                "created_at": r.get::<String, _>("created_at"),
                "interviewees": r.get::<Option<String>, _>("interviewees").unwrap_or_default(),
                "source_date": r.get::<Option<String>, _>("source_date"),
                "codes": codes_map.get(&bm_id).cloned().unwrap_or_default(),
                "highlights": hl_map.get(&bm_id).cloned().unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(json!(bookmarks)))
}

pub async fn delete_interview_bookmark(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let affected = sqlx::query("DELETE FROM interview_bookmarks WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("Bookmark {} not found", id)));
    }
    Ok(Json(json!({ "deleted": id })))
}

pub async fn update_interview_bookmark(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<Value>> {
    if let Some(note) = req.get("note").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE interview_bookmarks SET note = $1 WHERE id = $2")
            .bind(note)
            .bind(id)
            .execute(&state.db)
            .await?;
    }
    Ok(Json(json!({ "updated": id })))
}

// ── Interview Bookmark Codes ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AssignInterviewCodeRequest {
    pub bookmark_id: i64,
    pub code_id: i64,
    pub highlighted_text: Option<String>,
}

pub async fn assign_interview_code(
    State(state): State<AppState>,
    Json(req): Json<AssignInterviewCodeRequest>,
) -> Result<Json<Value>> {
    sqlx::query(
        "INSERT INTO interview_bookmark_codes (bookmark_id, code_id, highlighted_text)
         VALUES ($1, $2, $3)
         ON CONFLICT (bookmark_id, code_id)
         DO UPDATE SET highlighted_text = EXCLUDED.highlighted_text",
    )
    .bind(req.bookmark_id)
    .bind(req.code_id)
    .bind(&req.highlighted_text)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({
        "bookmark_id": req.bookmark_id,
        "code_id": req.code_id,
        "highlighted_text": req.highlighted_text,
    })))
}

pub async fn remove_interview_code(
    State(state): State<AppState>,
    Path((bookmark_id, code_id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    sqlx::query(
        "DELETE FROM interview_bookmark_codes WHERE bookmark_id = $1 AND code_id = $2",
    )
    .bind(bookmark_id)
    .bind(code_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "removed": true, "bookmark_id": bookmark_id, "code_id": code_id })))
}

pub async fn list_all_interview_bookmark_codes(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let mode = state.get_app_mode().await;
    let rows = if mode.as_deref() == Some("multi") {
        sqlx::query(
            "SELECT ibc.bookmark_id, ibc.code_id, ibc.highlighted_text,
                    c.name as code_name, c.color, 'excerpt' as type
             FROM interview_bookmark_codes ibc
             JOIN codes c ON c.id = ibc.code_id
             JOIN interview_bookmarks ib ON ib.id = ibc.bookmark_id AND ib.user_id = $1
             UNION ALL
             SELECT ibh.bookmark_id, ibh.code_id, ibh.highlighted_text,
                    c.name as code_name, c.color, 'highlight' as type
             FROM interview_bookmark_highlights ibh
             JOIN codes c ON c.id = ibh.code_id
             JOIN interview_bookmarks ib ON ib.id = ibh.bookmark_id AND ib.user_id = $1",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT ibc.bookmark_id, ibc.code_id, ibc.highlighted_text,
                    c.name as code_name, c.color, 'excerpt' as type
             FROM interview_bookmark_codes ibc
             JOIN codes c ON c.id = ibc.code_id
             UNION ALL
             SELECT ibh.bookmark_id, ibh.code_id, ibh.highlighted_text,
                    c.name as code_name, c.color, 'highlight' as type
             FROM interview_bookmark_highlights ibh
             JOIN codes c ON c.id = ibh.code_id",
        )
        .fetch_all(&state.db)
        .await?
    };

    let result: Vec<Value> = rows
        .iter()
        .map(|r| json!({
            "bookmark_id": r.get::<i64, _>("bookmark_id"),
            "code_id": r.get::<i64, _>("code_id"),
            "highlighted_text": r.get::<Option<String>, _>("highlighted_text"),
            "code_name": r.get::<String, _>("code_name"),
            "color": r.get::<String, _>("color"),
            "type": r.get::<String, _>("type"),
        }))
        .collect();

    Ok(Json(json!(result)))
}

// ── Interview Bookmark Highlights ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AddInterviewHighlightRequest {
    pub code_id: i64,
    pub highlighted_text: String,
}

pub async fn add_interview_highlight(
    State(state): State<AppState>,
    Path(bookmark_id): Path<i64>,
    Json(req): Json<AddInterviewHighlightRequest>,
) -> Result<Json<Value>> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO interview_bookmark_highlights
         (bookmark_id, code_id, highlighted_text)
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(bookmark_id)
    .bind(req.code_id)
    .bind(&req.highlighted_text)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "id": id,
        "bookmark_id": bookmark_id,
        "code_id": req.code_id,
        "highlighted_text": req.highlighted_text,
    })))
}

pub async fn remove_interview_highlight(
    State(state): State<AppState>,
    Path((bookmark_id, hl_id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    sqlx::query(
        "DELETE FROM interview_bookmark_highlights WHERE id = $1 AND bookmark_id = $2",
    )
    .bind(hl_id)
    .bind(bookmark_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "deleted": hl_id })))
}
