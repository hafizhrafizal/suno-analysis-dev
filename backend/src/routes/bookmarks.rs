use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use crate::{
    error::{AppError, Result},
    models::{AuthUser, CreateBookmarkRequest},
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListBookmarksQuery {
    pub source: Option<String>,
}

pub async fn create_bookmark(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateBookmarkRequest>,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let user_id = if mode.as_deref() == Some("multi") {
        Some(user.id)
    } else {
        None
    };

    let ctx_before = req.ctx_before.unwrap_or(5);
    let ctx_after = req.ctx_after.unwrap_or(5);

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO bookmarks (msg_id, ctx_before, ctx_after, note, user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(req.msg_id)
    .bind(ctx_before)
    .bind(ctx_after)
    .bind(&req.note)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({ "id": id, "msg_id": req.msg_id })))
}

pub async fn list_bookmarks(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListBookmarksQuery>,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let source_filter = q.source.as_deref().unwrap_or("discord");
    let bookmark_rows = if mode.as_deref() == Some("multi") {
        sqlx::query(
            "SELECT b.id, b.msg_id, b.ctx_before, b.ctx_after, b.note, b.created_at,
                    b.source, m.content, m.username, m.date, m.is_suno_team
             FROM bookmarks b
             JOIN messages m ON m.id = b.msg_id
             WHERE b.user_id = $1 AND b.source = $2
             ORDER BY b.created_at DESC",
        )
        .bind(user.id)
        .bind(source_filter)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT b.id, b.msg_id, b.ctx_before, b.ctx_after, b.note, b.created_at,
                    b.source, m.content, m.username, m.date, m.is_suno_team
             FROM bookmarks b
             JOIN messages m ON m.id = b.msg_id
             WHERE b.source = $1
             ORDER BY b.created_at DESC",
        )
        .bind(source_filter)
        .fetch_all(&state.db)
        .await?
    };

    use sqlx::Row;
    use std::collections::HashMap;

    if bookmark_rows.is_empty() {
        return Ok(Json(json!([])));
    }

    // Collect IDs for batch sub-queries (our own DB integers — safe for interpolation)
    let bookmark_ids: Vec<i64> = bookmark_rows.iter().map(|r| r.get::<i64, _>("id")).collect();
    let id_list = bookmark_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let codes_sql = format!(
        "SELECT bc.bookmark_id, c.id, c.name, c.color
         FROM bookmark_codes bc JOIN codes c ON c.id = bc.code_id
         WHERE bc.bookmark_id IN ({id})
         UNION
         SELECT bch.bookmark_id, c.id, c.name, c.color
         FROM bookmark_code_highlights bch JOIN codes c ON c.id = bch.code_id
         WHERE bch.bookmark_id IN ({id})",
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
        "SELECT bch.id, bch.bookmark_id, bch.code_id,
                c.name as code_name, c.color as code_color, bch.highlighted_text
         FROM bookmark_code_highlights bch
         JOIN codes c ON c.id = bch.code_id
         WHERE bch.bookmark_id IN ({})",
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

    let bookmarks: Vec<Value> = bookmark_rows
        .iter()
        .map(|row| {
            let bm_id: i64 = row.get("id");
            json!({
                "id": bm_id,
                "msg_id": row.get::<i64, _>("msg_id"),
                "ctx_before": row.get::<i64, _>("ctx_before"),
                "ctx_after": row.get::<i64, _>("ctx_after"),
                "note": row.get::<Option<String>, _>("note"),
                "created_at": row.get::<String, _>("created_at"),
                "source": row.get::<String, _>("source"),
                "content": row.get::<String, _>("content"),
                "username": row.get::<String, _>("username"),
                "date": row.get::<String, _>("date"),
                "is_suno_team": row.get::<Option<String>, _>("is_suno_team"),
                "codes": codes_map.get(&bm_id).cloned().unwrap_or_default(),
                "highlights": hl_map.get(&bm_id).cloned().unwrap_or_default(),
            })
        })
        .collect();

    Ok(Json(json!(bookmarks)))
}

/// Lightweight bookmark list — only message metadata, no codes or highlights sub-queries.
pub async fn list_bookmarks_meta(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let rows = if mode.as_deref() == Some("multi") {
        sqlx::query(
            "SELECT b.id, b.msg_id, b.note, b.created_at,
                    m.content, m.username, m.date, m.is_suno_team
             FROM bookmarks b
             JOIN messages m ON m.id = b.msg_id
             WHERE b.user_id = $1
             ORDER BY b.created_at DESC",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT b.id, b.msg_id, b.note, b.created_at,
                    m.content, m.username, m.date, m.is_suno_team
             FROM bookmarks b
             JOIN messages m ON m.id = b.msg_id
             ORDER BY b.created_at DESC",
        )
        .fetch_all(&state.db)
        .await?
    };

    use sqlx::Row;
    let bookmarks: Vec<Value> = rows
        .into_iter()
        .map(|r| json!({
            "id": r.get::<i64, _>("id"),
            "msg_id": r.get::<i64, _>("msg_id"),
            "note": r.get::<Option<String>, _>("note"),
            "created_at": r.get::<String, _>("created_at"),
            "content": r.get::<String, _>("content"),
            "username": r.get::<String, _>("username"),
            "date": r.get::<String, _>("date"),
            "is_suno_team": r.get::<Option<String>, _>("is_suno_team"),
        }))
        .collect();

    Ok(Json(json!(bookmarks)))
}

pub async fn list_bookmark_ids(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    let ids: Vec<i64> = if mode.as_deref() == Some("multi") {
        sqlx::query_scalar("SELECT msg_id FROM bookmarks WHERE user_id = $1")
            .bind(user.id)
            .fetch_all(&state.db)
            .await?
    } else {
        sqlx::query_scalar("SELECT msg_id FROM bookmarks")
            .fetch_all(&state.db)
            .await?
    };

    Ok(Json(json!(ids)))
}

pub async fn delete_bookmark(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    let affected = sqlx::query("DELETE FROM bookmarks WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("Bookmark {} not found", id)));
    }
    Ok(Json(json!({ "deleted": id })))
}

pub async fn delete_bookmark_by_msg(
    State(state): State<AppState>,
    Path(msg_id): Path<i64>,
) -> Result<Json<Value>> {
    let affected = sqlx::query("DELETE FROM bookmarks WHERE msg_id = $1")
        .bind(msg_id)
        .execute(&state.db)
        .await?
        .rows_affected();

    Ok(Json(json!({ "deleted": affected, "msg_id": msg_id })))
}

pub async fn add_label(
    State(state): State<AppState>,
    Path((bookmark_id, label_id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    sqlx::query(
        "INSERT INTO bookmark_labels (bookmark_id, label_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING",
    )
    .bind(bookmark_id)
    .bind(label_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "bookmark_id": bookmark_id, "label_id": label_id })))
}

pub async fn remove_label(
    State(state): State<AppState>,
    Path((bookmark_id, label_id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    sqlx::query(
        "DELETE FROM bookmark_labels WHERE bookmark_id = $1 AND label_id = $2",
    )
    .bind(bookmark_id)
    .bind(label_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "removed": true })))
}

pub async fn add_highlight(
    State(state): State<AppState>,
    Path(bookmark_id): Path<i64>,
    Json(req): Json<crate::models::AddHighlightRequest>,
) -> Result<Json<Value>> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO bookmark_code_highlights
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

pub async fn remove_highlight(
    State(state): State<AppState>,
    Path((bookmark_id, hl_id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    sqlx::query(
        "DELETE FROM bookmark_code_highlights WHERE id = $1 AND bookmark_id = $2",
    )
    .bind(hl_id)
    .bind(bookmark_id)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "deleted": hl_id })))
}
