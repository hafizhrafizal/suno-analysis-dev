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
        "ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS published_at TEXT",
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

    // ── Interview Analysis tables ─────────────────────────────────────────────
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interview_transcripts (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'upload',
            youtube_url TEXT,
            youtube_id TEXT,
            content TEXT NOT NULL DEFAULT '',
            is_suno_team BOOLEAN NOT NULL DEFAULT false,
            source_date TEXT,
            interviewees TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            updated_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )",
    )
    .execute(pool)
    .await?;
    // Migrate existing tables
    for stmt in &[
        "ALTER TABLE interview_transcripts ADD COLUMN IF NOT EXISTS is_suno_team BOOLEAN NOT NULL DEFAULT false",
        "ALTER TABLE interview_transcripts ADD COLUMN IF NOT EXISTS source_date TEXT",
        "ALTER TABLE interview_transcripts ADD COLUMN IF NOT EXISTS interviewees TEXT NOT NULL DEFAULT ''",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interview_bookmarks (
            id BIGSERIAL PRIMARY KEY,
            interview_id TEXT NOT NULL REFERENCES interview_transcripts(id) ON DELETE CASCADE,
            excerpt TEXT NOT NULL,
            note TEXT DEFAULT '',
            char_start INT,
            char_end INT,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interview_bookmark_codes (
            bookmark_id BIGINT NOT NULL REFERENCES interview_bookmarks(id) ON DELETE CASCADE,
            code_id BIGINT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
            highlighted_text TEXT,
            PRIMARY KEY (bookmark_id, code_id)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS interview_bookmark_highlights (
            id BIGSERIAL PRIMARY KEY,
            bookmark_id BIGINT NOT NULL REFERENCES interview_bookmarks(id) ON DELETE CASCADE,
            code_id BIGINT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
            highlighted_text TEXT NOT NULL,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
        )",
    )
    .execute(pool)
    .await?;

    // ── News Article tables ───────────────────────────────────────────────────
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS news_articles (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'url',
            source_url TEXT,
            source_filename TEXT,
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS news_bookmarks (
            id BIGSERIAL PRIMARY KEY,
            article_id TEXT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
            excerpt TEXT NOT NULL,
            informant TEXT NOT NULL DEFAULT '',
            note TEXT DEFAULT '',
            char_start INT,
            char_end INT,
            created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
            user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS news_bookmark_codes (
            bookmark_id BIGINT NOT NULL REFERENCES news_bookmarks(id) ON DELETE CASCADE,
            code_id BIGINT NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
            PRIMARY KEY (bookmark_id, code_id)
        )",
    )
    .execute(pool)
    .await?;

    // ── GitHub Activity Analysis tables ───────────────────────────────────────
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_repos (
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            full_name TEXT NOT NULL UNIQUE,
            description TEXT,
            html_url TEXT NOT NULL,
            stars INT NOT NULL DEFAULT 0,
            forks INT NOT NULL DEFAULT 0,
            open_issues INT NOT NULL DEFAULT 0,
            language TEXT,
            is_private BOOLEAN NOT NULL DEFAULT false,
            default_branch TEXT DEFAULT 'main',
            created_at_gh TEXT,
            updated_at_gh TEXT,
            fetched_at TEXT NOT NULL,
            user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_commits (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            sha TEXT NOT NULL,
            author_name TEXT,
            author_email TEXT,
            author_login TEXT,
            message TEXT NOT NULL DEFAULT '',
            committed_at TEXT,
            additions INT DEFAULT 0,
            deletions INT DEFAULT 0,
            changed_files INT DEFAULT 0,
            html_url TEXT,
            UNIQUE(repo_id, sha)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_issues (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            number INT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            body TEXT DEFAULT '',
            state TEXT NOT NULL DEFAULT 'open',
            author_login TEXT,
            labels TEXT DEFAULT '[]',
            created_at TEXT,
            updated_at TEXT,
            closed_at TEXT,
            comments INT DEFAULT 0,
            html_url TEXT,
            UNIQUE(repo_id, number)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_pulls (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            number INT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            body TEXT DEFAULT '',
            state TEXT NOT NULL DEFAULT 'open',
            author_login TEXT,
            labels TEXT DEFAULT '[]',
            created_at TEXT,
            updated_at TEXT,
            closed_at TEXT,
            merged_at TEXT,
            comments INT DEFAULT 0,
            commits INT DEFAULT 0,
            additions INT DEFAULT 0,
            deletions INT DEFAULT 0,
            changed_files INT DEFAULT 0,
            html_url TEXT,
            UNIQUE(repo_id, number)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_releases (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            tag_name TEXT NOT NULL,
            name TEXT DEFAULT '',
            body TEXT DEFAULT '',
            is_draft BOOLEAN NOT NULL DEFAULT false,
            is_prerelease BOOLEAN NOT NULL DEFAULT false,
            author_login TEXT,
            created_at TEXT,
            published_at TEXT,
            html_url TEXT,
            UNIQUE(repo_id, tag_name)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_discussions (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            number INT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            body TEXT DEFAULT '',
            category TEXT DEFAULT '',
            author_login TEXT,
            created_at TEXT,
            updated_at TEXT,
            comments INT DEFAULT 0,
            html_url TEXT,
            UNIQUE(repo_id, number)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_forks (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            fork_full_name TEXT NOT NULL,
            owner_login TEXT,
            html_url TEXT,
            stars INT NOT NULL DEFAULT 0,
            forks INT NOT NULL DEFAULT 0,
            language TEXT,
            description TEXT,
            created_at TEXT,
            updated_at TEXT,
            UNIQUE(repo_id, fork_full_name)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_issue_comments (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            issue_number INT NOT NULL,
            comment_gh_id BIGINT,
            author_login TEXT,
            body TEXT NOT NULL DEFAULT '',
            created_at TEXT,
            html_url TEXT,
            UNIQUE(repo_id, comment_gh_id)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS github_discussion_comments (
            id TEXT PRIMARY KEY,
            repo_id TEXT NOT NULL REFERENCES github_repos(id) ON DELETE CASCADE,
            discussion_number INT NOT NULL,
            comment_gh_id BIGINT,
            author_login TEXT,
            body TEXT NOT NULL DEFAULT '',
            created_at TEXT,
            UNIQUE(repo_id, comment_gh_id)
        )",
    )
    .execute(pool)
    .await?;

    for stmt in &[
        "ALTER TABLE github_commits ADD COLUMN IF NOT EXISTS stats_fetched BOOLEAN NOT NULL DEFAULT false",
        "ALTER TABLE github_commits ADD COLUMN IF NOT EXISTS files TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE github_issues ADD COLUMN IF NOT EXISTS comments_fetched BOOLEAN NOT NULL DEFAULT false",
        "ALTER TABLE github_discussions ADD COLUMN IF NOT EXISTS comments_fetched BOOLEAN NOT NULL DEFAULT false",
        "ALTER TABLE github_pulls ADD COLUMN IF NOT EXISTS comments_fetched BOOLEAN NOT NULL DEFAULT false",
    ] {
        let _ = sqlx::query(stmt).execute(pool).await;
    }

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
