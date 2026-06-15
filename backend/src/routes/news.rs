use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::state::AppState;

// ── Structs ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ArticleSummary {
    id: String,
    title: String,
    source_type: String,
    source_url: Option<String>,
    source_filename: Option<String>,
    word_count: i64,
    published_at: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
struct ArticleDetail {
    id: String,
    title: String,
    source_type: String,
    source_url: Option<String>,
    source_filename: Option<String>,
    content: String,
    word_count: i64,
    published_at: Option<String>,
    created_at: String,
}

/// Intermediate result from HTML/Jina extraction.
struct Extracted {
    title: Option<String>,
    published_at: Option<String>,
    content: String,
}

#[derive(Deserialize)]
pub struct ExtractUrlPayload {
    url: String,
    title: Option<String>,
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn list_articles(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query(
        "SELECT id, title, source_type, source_url, source_filename,
                published_at, created_at,
                CASE WHEN trim(COALESCE(content,'')) = '' THEN 0
                     ELSE array_length(
                         regexp_split_to_array(trim(content), '\\s+'), 1)
                END::bigint AS word_count
         FROM news_articles ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => {
            let articles: Vec<ArticleSummary> = rows
                .iter()
                .map(|r| ArticleSummary {
                    id: r.get("id"),
                    title: r.get("title"),
                    source_type: r.get("source_type"),
                    source_url: r.get("source_url"),
                    source_filename: r.get("source_filename"),
                    word_count: r.get("word_count"),
                    published_at: r.get("published_at"),
                    created_at: r.get("created_at"),
                })
                .collect();
            (StatusCode::OK, Json(serde_json::to_value(articles).unwrap())).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn get_article(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match sqlx::query(
        "SELECT id, title, source_type, source_url, source_filename,
                content, published_at, created_at,
                CASE WHEN trim(COALESCE(content,'')) = '' THEN 0
                     ELSE array_length(
                         regexp_split_to_array(trim(content), '\\s+'), 1)
                END::bigint AS word_count
         FROM news_articles WHERE id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(Some(row)) => {
            let detail = ArticleDetail {
                id: row.get("id"),
                title: row.get("title"),
                source_type: row.get("source_type"),
                source_url: row.get("source_url"),
                source_filename: row.get("source_filename"),
                content: row.get("content"),
                word_count: row.get("word_count"),
                published_at: row.get("published_at"),
                created_at: row.get("created_at"),
            };
            (StatusCode::OK, Json(serde_json::to_value(detail).unwrap())).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Article not found" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn extract_url(
    State(state): State<AppState>,
    Json(body): Json<ExtractUrlPayload>,
) -> impl IntoResponse {
    let url = body.url.trim().to_string();
    if url.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "URL is required" })),
        )
            .into_response();
    }

    // Strategy 1: direct HTTP fetch + HTML parse
    let (extracted, method) = match fetch_direct(&url).await {
        Ok(e) if e.content.len() >= 300 => (e, "direct"),
        direct_result => {
            // Strategy 2: Jina AI Reader — handles JS-rendered pages and many paywalls
            match fetch_jina(&url).await {
                Ok(e) if !e.content.trim().is_empty() => (e, "jina"),
                _ => match direct_result {
                    Ok(e) if !e.content.trim().is_empty() => (e, "direct-short"),
                    _ => {
                        return (
                            StatusCode::BAD_GATEWAY,
                            Json(serde_json::json!({
                                "error": "Could not extract article content. \
                                          The page may require login or is not accessible."
                            })),
                        )
                            .into_response();
                    }
                },
            }
        }
    };

    let title = body
        .title
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.to_string())
        .or(extracted.title)
        .unwrap_or_else(|| title_from_url(&url));

    let id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO news_articles (id, title, source_type, source_url, content, published_at)
         VALUES ($1, $2, 'url', $3, $4, $5)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&url)
    .bind(&extracted.content)
    .bind(&extracted.published_at)
    .execute(&state.db)
    .await
    {
        Ok(_) => {
            tracing::info!(
                "Saved news article '{}' via {} ({} chars)",
                title,
                method,
                extracted.content.len()
            );
            (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn upload_article(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut title = String::new();
    let mut filename = String::new();
    let mut content = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "title" => {
                title = field.text().await.unwrap_or_default();
            }
            "file" => {
                filename = field.file_name().unwrap_or("upload").to_string();
                let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
                let bytes = match field.bytes().await {
                    Ok(b) => b,
                    Err(e) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({ "error": format!("Failed to read file: {e}") })),
                        )
                            .into_response()
                    }
                };
                content = match ext.as_str() {
                    "txt" | "md" | "text" => String::from_utf8_lossy(&bytes).to_string(),
                    "html" | "htm" => {
                        let html = String::from_utf8_lossy(&bytes).to_string();
                        let (_, text) = extract_text_from_html(&html);
                        text
                    }
                    "pdf" => match pdf_extract::extract_text_from_mem(&bytes) {
                        Ok(t) => t,
                        Err(e) => {
                            return (
                                StatusCode::UNPROCESSABLE_ENTITY,
                                Json(serde_json::json!({ "error": format!("PDF extraction failed: {e}") })),
                            )
                                .into_response()
                        }
                    },
                    "docx" => match extract_text_from_docx(&bytes) {
                        Ok(t) => t,
                        Err(e) => {
                            return (
                                StatusCode::UNPROCESSABLE_ENTITY,
                                Json(serde_json::json!({ "error": format!("DOCX extraction failed: {e}") })),
                            )
                                .into_response()
                        }
                    },
                    other => {
                        return (
                            StatusCode::UNSUPPORTED_MEDIA_TYPE,
                            Json(serde_json::json!({
                                "error": format!("Unsupported file type: .{other}. Supported: txt, md, html, pdf, docx")
                            })),
                        )
                            .into_response()
                    }
                };
            }
            _ => {}
        }
    }

    if content.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "No file content extracted" })),
        )
            .into_response();
    }

    if title.trim().is_empty() {
        // Derive title from filename (drop extension, replace separators with spaces)
        title = filename
            .rsplit('.')
            .skip(1)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(".")
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            title = filename.clone();
        }
    }

    let id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO news_articles (id, title, source_type, source_filename, content)
         VALUES ($1, $2, 'upload', $3, $4)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&filename)
    .bind(&content)
    .execute(&state.db)
    .await
    {
        Ok(_) => (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn delete_article(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match sqlx::query("DELETE FROM news_articles WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct UpdateArticlePayload {
    pub title: Option<String>,
    pub content: Option<String>,
    pub published_at: Option<String>, // empty string = clear; absent = keep existing
}

pub async fn update_article(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateArticlePayload>,
) -> impl IntoResponse {
    // Normalise published_at: empty string → SQL NULL
    let pub_at: Option<Option<&str>> = body.published_at.as_deref().map(|v| {
        if v.trim().is_empty() { None } else { Some(v.trim()) }
    });

    let result = match pub_at {
        // Caller explicitly cleared published_at
        Some(None) => sqlx::query(
            "UPDATE news_articles
             SET title       = COALESCE($1, title),
                 content     = COALESCE($2, content),
                 published_at = NULL
             WHERE id = $3",
        )
        .bind(body.title.as_deref())
        .bind(body.content.as_deref())
        .bind(&id)
        .execute(&state.db)
        .await,
        // Caller set a value
        Some(Some(v)) => sqlx::query(
            "UPDATE news_articles
             SET title        = COALESCE($1, title),
                 content      = COALESCE($2, content),
                 published_at = $3
             WHERE id = $4",
        )
        .bind(body.title.as_deref())
        .bind(body.content.as_deref())
        .bind(v)
        .bind(&id)
        .execute(&state.db)
        .await,
        // Caller omitted published_at — keep existing
        None => sqlx::query(
            "UPDATE news_articles
             SET title   = COALESCE($1, title),
                 content = COALESCE($2, content)
             WHERE id = $3",
        )
        .bind(body.title.as_deref())
        .bind(body.content.as_deref())
        .bind(&id)
        .execute(&state.db)
        .await,
    };

    match result
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

// ── Scraping helpers ──────────────────────────────────────────────────────────

/// Direct HTTP fetch + HTML parse. Falls back to Jina if content is sparse.
async fn fetch_direct(url: &str) -> Result<Extracted, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/124.0.0.0 Safari/537.36",
        )
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    if content_type.contains("pdf") {
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|e| e.to_string())?;
        return Ok(Extracted { title: None, published_at: None, content: text });
    }

    let html = resp.text().await.map_err(|e| e.to_string())?;
    let document = scraper::Html::parse_document(&html);
    let title = extract_html_title(&document);
    let published_at = extract_published_at(&document);
    let content = extract_body_text(&document);
    Ok(Extracted { title, published_at, content })
}

/// Jina AI Reader: renders JS-heavy pages and can bypass many soft paywalls.
async fn fetch_jina(url: &str) -> Result<Extracted, String> {
    let jina_url = format!("https://r.jina.ai/{}", url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&jina_url)
        .header("Accept", "text/markdown, text/plain")
        .header("X-Return-Format", "markdown")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Jina returned {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_jina_response(text))
}

// ── HTML text extraction ──────────────────────────────────────────────────────

/// Used by the file-upload path (HTML files) where we don't need published_at.
fn extract_text_from_html(html: &str) -> (Option<String>, String) {
    let document = scraper::Html::parse_document(html);
    let title = extract_html_title(&document);
    let content = extract_body_text(&document);
    (title, content)
}

/// Core text extraction from a pre-parsed document.
fn extract_body_text(document: &scraper::Html) -> String {

    // Only gather text from block-level semantic elements to avoid script/style noise
    let text_sel = scraper::Selector::parse(
        "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, figcaption",
    )
    .unwrap();

    // Try known article container selectors in priority order
    let containers: &[&str] = &[
        "article",
        "main",
        "[role='main']",
        "#article-body",
        "#main-content",
        "#content",
        ".post-content",
        ".article-body",
        ".entry-content",
        ".content-body",
        ".story-body",
        ".article__body",
        ".post-body",
        ".entry-body",
        ".article-text",
        ".the-content",
        ".post__content",
    ];

    for sel_str in containers {
        if let Ok(sel) = scraper::Selector::parse(sel_str) {
            if let Some(container) = document.select(&sel).next() {
                let parts: Vec<String> = container
                    .select(&text_sel)
                    .map(|el| collapse_whitespace(&el.text().collect::<String>()))
                    .filter(|t| t.len() > 15)
                    .collect();
                let joined = parts.join("\n\n");
                if joined.len() >= 300 {
                    return joined;
                }
            }
        }
    }

    // Fallback: all block elements anywhere in the document
    let parts: Vec<String> = document
        .select(&text_sel)
        .map(|el| collapse_whitespace(&el.text().collect::<String>()))
        .filter(|t| t.len() > 15)
        .collect();
    parts.join("\n\n")
}

fn extract_html_title(document: &scraper::Html) -> Option<String> {
    // Prefer og:title (more descriptive than <title> which often has site suffix)
    if let Ok(sel) = scraper::Selector::parse("meta[property='og:title']") {
        if let Some(el) = document.select(&sel).next() {
            if let Some(c) = el.value().attr("content") {
                let t = c.trim().to_string();
                if !t.is_empty() {
                    return Some(t);
                }
            }
        }
    }
    if let Ok(sel) = scraper::Selector::parse("title") {
        if let Some(el) = document.select(&sel).next() {
            let t = el.text().collect::<String>().trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

/// Parse Jina AI Reader response (structured header + markdown body).
fn parse_jina_response(text: String) -> Extracted {
    let mut title: Option<String> = None;
    let mut published_at: Option<String> = None;
    let mut content_start = 0usize;

    for line in text.lines() {
        if line.starts_with("Title: ") {
            title = Some(line["Title: ".len()..].trim().to_string());
        } else if line.starts_with("Published Time: ") {
            let v = line["Published Time: ".len()..].trim().to_string();
            if !v.is_empty() { published_at = Some(v); }
        } else if line == "Markdown Content:" || line.starts_with("Markdown Content:\n") {
            content_start = text
                .find("Markdown Content:")
                .map(|p| p + "Markdown Content:".len())
                .unwrap_or(0);
            break;
        }
    }

    let content = if content_start > 0 {
        text[content_start..].trim().to_string()
    } else {
        text
    };

    Extracted { title, published_at, content }
}

/// Extract published-date metadata from common HTML meta patterns.
fn extract_published_at(document: &scraper::Html) -> Option<String> {
    let candidates: &[(&str, &str)] = &[
        ("meta[property='article:published_time']", "content"),
        ("meta[property='og:published_time']", "content"),
        ("meta[name='publication_date']", "content"),
        ("meta[name='publish-date']", "content"),
        ("meta[name='date']", "content"),
        ("meta[itemprop='datePublished']", "content"),
        ("time[itemprop='datePublished']", "datetime"),
        ("time[datetime]", "datetime"),
    ];
    for (sel_str, attr) in candidates {
        if let Ok(sel) = scraper::Selector::parse(sel_str) {
            if let Some(el) = document.select(&sel).next() {
                if let Some(v) = el.value().attr(attr) {
                    let v = v.trim().to_string();
                    if !v.is_empty() { return Some(v); }
                }
            }
        }
    }
    None
}

// ── DOCX text extraction ──────────────────────────────────────────────────────

fn extract_text_from_docx(bytes: &[u8]) -> Result<String, String> {
    use std::io::{Cursor, Read};
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "Not a valid DOCX file (missing word/document.xml)".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    Ok(strip_xml_tags(&xml))
}

/// Strips all XML/HTML tags leaving only text content, collapsing whitespace.
fn strip_xml_tags(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    let mut prev_space = true;

    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !prev_space {
                    out.push(' ');
                    prev_space = true;
                }
            }
            _ if !in_tag => {
                if ch.is_whitespace() {
                    if !prev_space {
                        out.push(' ');
                        prev_space = true;
                    }
                } else {
                    out.push(ch);
                    prev_space = false;
                }
            }
            _ => {}
        }
    }
    out.trim().to_string()
}

// ── String helpers ────────────────────────────────────────────────────────────

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim_end().to_string()
}

fn title_from_url(url: &str) -> String {
    let candidate = url.trim_end_matches('/').rsplit('/').next().unwrap_or("Untitled");
    let words: Vec<&str> = candidate
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    if words.is_empty() {
        "Untitled".to_string()
    } else {
        words.join(" ")
    }
}

// ── Bookmark handlers ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBookmarkPayload {
    pub article_id: String,
    pub excerpt: String,
    pub informant: String,
    pub note: Option<String>,
    pub char_start: Option<i32>,
    pub char_end: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateBookmarkPayload {
    pub informant: Option<String>,
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct ListBookmarksQuery {
    pub article_id: Option<String>,
}

#[derive(Deserialize)]
pub struct AssignCodePayload {
    pub bookmark_id: i64,
    pub code_id: i64,
}

pub async fn create_bookmark(
    State(state): State<AppState>,
    Json(body): Json<CreateBookmarkPayload>,
) -> impl IntoResponse {
    let informant = body.informant.trim().to_string();
    if informant.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Informant is required" })),
        )
            .into_response();
    }
    let excerpt = body.excerpt.trim().to_string();
    if excerpt.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Excerpt is required" })),
        )
            .into_response();
    }

    match sqlx::query_scalar::<_, i64>(
        "INSERT INTO news_bookmarks (article_id, excerpt, informant, note, char_start, char_end)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id",
    )
    .bind(&body.article_id)
    .bind(&excerpt)
    .bind(&informant)
    .bind(body.note.as_deref().unwrap_or(""))
    .bind(body.char_start)
    .bind(body.char_end)
    .fetch_one(&state.db)
    .await
    {
        Ok(id) => (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn list_bookmarks(
    State(state): State<AppState>,
    Query(params): Query<ListBookmarksQuery>,
) -> impl IntoResponse {
    let bookmark_rows = match &params.article_id {
        Some(aid) => sqlx::query(
            "SELECT b.id, b.article_id, b.excerpt, b.informant,
                    COALESCE(b.note, '') AS note,
                    b.char_start, b.char_end, b.created_at,
                    COALESCE(
                        json_agg(json_build_object('id', c.id, 'name', c.name, 'color', c.color))
                        FILTER (WHERE c.id IS NOT NULL),
                        '[]'::json
                    )::text AS codes
             FROM news_bookmarks b
             LEFT JOIN news_bookmark_codes nbc ON b.id = nbc.bookmark_id
             LEFT JOIN codes c ON nbc.code_id = c.id
             WHERE b.article_id = $1
             GROUP BY b.id
             ORDER BY b.created_at DESC",
        )
        .bind(aid)
        .fetch_all(&state.db)
        .await,
        None => sqlx::query(
            "SELECT b.id, b.article_id, b.excerpt, b.informant,
                    COALESCE(b.note, '') AS note,
                    b.char_start, b.char_end, b.created_at,
                    COALESCE(
                        json_agg(json_build_object('id', c.id, 'name', c.name, 'color', c.color))
                        FILTER (WHERE c.id IS NOT NULL),
                        '[]'::json
                    )::text AS codes
             FROM news_bookmarks b
             LEFT JOIN news_bookmark_codes nbc ON b.id = nbc.bookmark_id
             LEFT JOIN codes c ON nbc.code_id = c.id
             GROUP BY b.id
             ORDER BY b.created_at DESC",
        )
        .fetch_all(&state.db)
        .await,
    };

    match bookmark_rows {
        Ok(rows) => {
            let bookmarks: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    let codes_str: String = r.get("codes");
                    let codes: serde_json::Value =
                        serde_json::from_str(&codes_str).unwrap_or(serde_json::json!([]));
                    serde_json::json!({
                        "id": r.get::<i64, _>("id"),
                        "article_id": r.get::<String, _>("article_id"),
                        "excerpt": r.get::<String, _>("excerpt"),
                        "informant": r.get::<String, _>("informant"),
                        "note": r.get::<String, _>("note"),
                        "char_start": r.get::<Option<i32>, _>("char_start"),
                        "char_end": r.get::<Option<i32>, _>("char_end"),
                        "created_at": r.get::<String, _>("created_at"),
                        "codes": codes,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(bookmarks))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn update_bookmark(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateBookmarkPayload>,
) -> impl IntoResponse {
    match sqlx::query(
        "UPDATE news_bookmarks
         SET informant = COALESCE($1, informant),
             note = COALESCE($2, note)
         WHERE id = $3",
    )
    .bind(body.informant.as_deref())
    .bind(body.note.as_deref())
    .bind(id)
    .execute(&state.db)
    .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn delete_bookmark(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match sqlx::query("DELETE FROM news_bookmarks WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn assign_bookmark_code(
    State(state): State<AppState>,
    Json(body): Json<AssignCodePayload>,
) -> impl IntoResponse {
    match sqlx::query(
        "INSERT INTO news_bookmark_codes (bookmark_id, code_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(body.bookmark_id)
    .bind(body.code_id)
    .execute(&state.db)
    .await
    {
        Ok(_) => StatusCode::CREATED.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub async fn remove_bookmark_code(
    State(state): State<AppState>,
    Path((bookmark_id, code_id)): Path<(i64, i64)>,
) -> impl IntoResponse {
    match sqlx::query(
        "DELETE FROM news_bookmark_codes WHERE bookmark_id = $1 AND code_id = $2",
    )
    .bind(bookmark_id)
    .bind(code_id)
    .execute(&state.db)
    .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
