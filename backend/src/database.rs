use sqlx::{PgPool, postgres::PgPoolOptions, Row};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub async fn create_pool(url: &str) -> Result<PgPool, sqlx::Error> {
    // 5-minute statement_timeout on every connection — if a query (e.g. a
    // pathological COUNT scan) runs longer than this, Postgres kills it
    // server-side instead of letting it linger after the HTTP client
    // disconnected.  Prevents the zombie-query/lock cascade where stale
    // SELECTs block subsequent ALTER TABLEs in init_db.
    use sqlx::Executor;
    PgPoolOptions::new()
        .max_connections(10)
        .after_connect(|conn, _meta| Box::pin(async move {
            conn.execute("SET statement_timeout = '300s'").await?;
            Ok(())
        }))
        .connect(url)
        .await
}

pub async fn init_db(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS uploads (
            id TEXT PRIMARY KEY,
            filename TEXT,
            row_count BIGINT DEFAULT 0,
            upload_time TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            msg_uuid TEXT UNIQUE,
            author_id TEXT,
            username TEXT NOT NULL DEFAULT 'unknown',
            date TEXT,
            content TEXT,
            attachments TEXT,
            reactions TEXT,
            is_suno_team TEXT DEFAULT 'false',
            week TEXT,
            month TEXT,
            upload_id TEXT REFERENCES uploads(id) ON DELETE CASCADE,
            row_index BIGINT,
            word_count BIGINT,
            search_vector tsvector
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            password_hash TEXT,
            password_salt TEXT,
            is_admin BOOLEAN DEFAULT false,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            google_id TEXT UNIQUE,
            email TEXT UNIQUE
        )",
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))",
    )
    .execute(pool)
    .await;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bookmarks (
            id BIGSERIAL PRIMARY KEY,
            msg_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            ctx_before BIGINT DEFAULT 5,
            ctx_after BIGINT DEFAULT 5,
            note TEXT,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS labels (
            id BIGSERIAL PRIMARY KEY,
            name TEXT UNIQUE,
            color TEXT DEFAULT '#6366f1',
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bookmark_labels (
            bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
            label_id BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
            PRIMARY KEY (bookmark_id, label_id)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS embedded_uploads (
            upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
            model_id TEXT NOT NULL,
            embedded_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            PRIMARY KEY (upload_id, model_id)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS code_categories (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL DEFAULT '#94a3b8',
            parent_id BIGINT REFERENCES code_categories(id) ON DELETE SET NULL,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS codes (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT DEFAULT '#6366f1',
            description TEXT DEFAULT '',
            category_id BIGINT REFERENCES code_categories(id) ON DELETE SET NULL,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bookmark_codes (
            bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
            code_id BIGINT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
            highlighted_text TEXT,
            PRIMARY KEY (bookmark_id, code_id)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS bookmark_code_highlights (
            id BIGSERIAL PRIMARY KEY,
            bookmark_id BIGINT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
            code_id BIGINT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
            highlighted_text TEXT NOT NULL,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    // Migrate messages.upload_id FK to ON DELETE CASCADE (safe to re-run)
    let _ = sqlx::query(
        "ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_upload_id_fkey",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "ALTER TABLE messages ADD CONSTRAINT messages_upload_id_fkey \
         FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE",
    )
    .execute(pool)
    .await;

    // Column migrations — ADD COLUMN IF NOT EXISTS is safe to re-run
    for stmt in &[
        "ALTER TABLE code_categories ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#94a3b8'",
        "ALTER TABLE code_categories ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES code_categories(id) ON DELETE SET NULL",
        "ALTER TABLE codes ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''",
        "ALTER TABLE bookmark_codes ADD COLUMN IF NOT EXISTS highlighted_text TEXT",
        "ALTER TABLE messages ADD COLUMN IF NOT EXISTS word_count BIGINT",
        "ALTER TABLE messages ADD COLUMN IF NOT EXISTS search_vector tsvector",
        "ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'discord'",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    // Full-text search: trigger function to maintain search_vector on messages
    sqlx::query(
        "CREATE OR REPLACE FUNCTION messages_search_vector_update() RETURNS trigger AS $$
         BEGIN
             NEW.search_vector := to_tsvector('simple',
                 coalesce(NEW.content, '') || ' ' || coalesce(NEW.username, ''));
             RETURN NEW;
         END;
         $$ LANGUAGE plpgsql",
    )
    .execute(pool)
    .await?;

    let _ = sqlx::query("DROP TRIGGER IF EXISTS tg_messages_sv_update ON messages")
        .execute(pool)
        .await;
    sqlx::query(
        "CREATE TRIGGER tg_messages_sv_update
         BEFORE INSERT OR UPDATE ON messages
         FOR EACH ROW EXECUTE FUNCTION messages_search_vector_update()",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS persona_classifications (
            id BIGSERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            phase TEXT NOT NULL,
            phase_label TEXT NOT NULL,
            method TEXT NOT NULL,
            persona TEXT NOT NULL,
            confidence REAL DEFAULT 0.5,
            reasoning TEXT DEFAULT '',
            features JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(username, phase, method)
        )",
    )
    .execute(pool)
    .await?;

    // Add secondary archetype + scores columns for the new persona flow.
    // Idempotent so existing DBs migrate in place without losing data.
    for stmt in &[
        "ALTER TABLE persona_classifications ADD COLUMN IF NOT EXISTS secondary_persona TEXT",
        "ALTER TABLE persona_classifications ADD COLUMN IF NOT EXISTS secondary_confidence REAL",
        "ALTER TABLE persona_classifications ADD COLUMN IF NOT EXISTS scores JSONB DEFAULT '{}'",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS message_emotions (
            msg_uuid TEXT PRIMARY KEY,
            dominant_emotion TEXT NOT NULL DEFAULT '',
            sentiment TEXT NOT NULL DEFAULT 'neutral',
            top_emotions JSONB NOT NULL DEFAULT '[]',
            analyzed_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    for stmt in &[
        "CREATE INDEX IF NOT EXISTS idx_persona_username ON persona_classifications(username)",
        "CREATE INDEX IF NOT EXISTS idx_persona_phase ON persona_classifications(phase)",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    // B-tree indexes for common filter columns
    for stmt in &[
        "CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date)",
        "CREATE INDEX IF NOT EXISTS idx_messages_username ON messages(username)",
        "CREATE INDEX IF NOT EXISTS idx_messages_upload_id ON messages(upload_id)",
        "CREATE INDEX IF NOT EXISTS idx_messages_suno_team ON messages(is_suno_team)",
        "CREATE INDEX IF NOT EXISTS idx_messages_date_username ON messages(date, username)",
        "CREATE INDEX IF NOT EXISTS idx_messages_week ON messages(week)",
        "CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN(search_vector)",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    // ── User topic analysis tables ────────────────────────────────────────────

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_topic_runs (
            id          BIGSERIAL PRIMARY KEY,
            username    TEXT NOT NULL,
            date_from   TEXT NOT NULL DEFAULT '',
            date_to     TEXT NOT NULL DEFAULT '',
            upload_ids  TEXT NOT NULL DEFAULT '',
            total_docs  INTEGER NOT NULL DEFAULT 0,
            filtered_docs INTEGER NOT NULL DEFAULT 0,
            warning     TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (username, date_from, date_to, upload_ids)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_topic_items (
            id            BIGSERIAL PRIMARY KEY,
            run_id        BIGINT NOT NULL REFERENCES user_topic_runs(id) ON DELETE CASCADE,
            topic_id      INTEGER NOT NULL,
            label         TEXT NOT NULL,
            keywords      TEXT[] NOT NULL DEFAULT '{}',
            message_count INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS user_topic_messages (
            id        BIGSERIAL PRIMARY KEY,
            run_id    BIGINT NOT NULL REFERENCES user_topic_runs(id) ON DELETE CASCADE,
            msg_uuid  TEXT NOT NULL,
            topic_id  INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    for stmt in &[
        "CREATE INDEX IF NOT EXISTS idx_user_topic_items_run_id ON user_topic_items(run_id)",
        "CREATE INDEX IF NOT EXISTS idx_user_topic_messages_run_id ON user_topic_messages(run_id)",
        "CREATE INDEX IF NOT EXISTS idx_user_topic_messages_uuid ON user_topic_messages(msg_uuid)",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    Ok(())
}

/// Check whether any messages are missing search_vector (backfill needed).
pub async fn needs_fts_rebuild(pool: &PgPool) -> bool {
    sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE search_vector IS NULL AND content IS NOT NULL)",
    )
    .fetch_one(pool)
    .await
    .map(|r| r.get::<bool, _>(0))
    .unwrap_or(false)
}

/// Populate search_vector for all rows missing it. Sets `fts_ready` true on success.
pub async fn rebuild_fts(pool: &PgPool, fts_ready: Arc<AtomicBool>) {
    tracing::info!("Populating search_vector for existing rows…");
    match sqlx::query(
        "UPDATE messages
         SET search_vector = to_tsvector('simple',
             coalesce(content, '') || ' ' || coalesce(username, ''))
         WHERE search_vector IS NULL",
    )
    .execute(pool)
    .await
    {
        Ok(r) => {
            tracing::info!("search_vector backfill: {} rows updated", r.rows_affected());
            fts_ready.store(true, Ordering::Relaxed);
        }
        Err(e) => tracing::warn!("search_vector backfill failed: {}", e),
    }
}

/// Returns true if any messages row is missing word_count (backfill needed).
pub async fn needs_word_count_backfill(pool: &PgPool) -> bool {
    sqlx::query(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE word_count IS NULL AND content IS NOT NULL)",
    )
    .fetch_one(pool)
    .await
    .map(|r| r.get::<bool, _>(0))
    .unwrap_or(false)
}

/// Populate word_count and week for all existing rows that are missing them.
pub async fn backfill_precomputed_columns(pool: &PgPool) {
    tracing::info!("Backfilling word_count and week columns…");
    match sqlx::query(
        "UPDATE messages
         SET word_count = length(trim(content)) - length(replace(trim(content), ' ', '')) + 1
         WHERE word_count IS NULL AND content IS NOT NULL",
    )
    .execute(pool)
    .await
    {
        Ok(r) => tracing::info!("Backfill word_count: {} rows updated", r.rows_affected()),
        Err(e) => tracing::warn!("Backfill word_count failed: {}", e),
    }
    match sqlx::query(
        "UPDATE messages
         SET week = TO_CHAR(NULLIF(date, '')::timestamp, 'IYYY-IW')
         WHERE week IS NULL AND date IS NOT NULL AND date != ''",
    )
    .execute(pool)
    .await
    {
        Ok(r) => tracing::info!("Backfill week: {} rows updated", r.rows_affected()),
        Err(e) => tracing::warn!("Backfill week failed: {}", e),
    }
}

pub async fn seed_demo_user(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, password_salt, is_admin)
         VALUES (1, 'admin', '', '', true)
         ON CONFLICT (id) DO NOTHING",
    )
    .execute(pool)
    .await?;
    Ok(())
}
