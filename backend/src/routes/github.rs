use axum::{
    extract::{Path, Query, State},
    response::sse::{Event, Sse},
    Json,
};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use uuid::Uuid;
use crate::{
    error::{AppError, Result},
    models::AuthUser,
    state::AppState,
};

const GH_API: &str = "https://api.github.com";
const PER_PAGE: u32 = 100;
const MAX_PAGES: u32 = 5; // up to 500 items per resource

// ── token pool helpers ────────────────────────────────────────────────────────

async fn load_tokens(state: &AppState) -> Vec<String> {
    use sqlx::Row;
    let raw: Option<String> = sqlx::query(
        "SELECT value FROM settings WHERE key = 'github_tokens'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|r| r.get::<Option<String>, _>("value"));

    raw.and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .collect()
}

async fn save_tokens(state: &AppState, tokens: &[String]) -> Result<()> {
    let json = serde_json::to_string(tokens).unwrap_or_else(|_| "[]".into());
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('github_tokens', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    )
    .bind(&json)
    .execute(&state.db)
    .await?;
    Ok(())
}

fn pick_token(tokens: &[String]) -> Option<&str> {
    if tokens.is_empty() { return None; }
    let idx = (rand::random::<u32>() as usize) % tokens.len();
    Some(&tokens[idx])
}

fn gh_client(token: Option<&str>) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        "retrieval-web/1.0".parse().unwrap(),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    if let Some(tok) = token {
        if let Ok(v) = format!("Bearer {tok}").parse() {
            headers.insert(reqwest::header::AUTHORIZATION, v);
        }
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap()
}

async fn gh_get_all(client: &reqwest::Client, url: &str) -> Result<Vec<Value>> {
    let mut all: Vec<Value> = vec![];
    for page in 1..=MAX_PAGES {
        let sep = if url.contains('?') { "&" } else { "?" };
        let resp = client
            .get(format!("{url}{sep}per_page={PER_PAGE}&page={page}"))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!("GitHub API {status}: {body}")));
        }

        let items: Vec<Value> = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        let done = items.len() < PER_PAGE as usize;
        all.extend(items);
        if done { break; }
    }
    Ok(all)
}

/// Exhaustive fetcher — no page limit, used for forks which can number
/// in the thousands for popular repositories.
async fn gh_get_all_exhaustive(client: &reqwest::Client, url: &str) -> Result<Vec<Value>> {
    let mut all: Vec<Value> = vec![];
    let mut page = 1u32;
    loop {
        let sep = if url.contains('?') { "&" } else { "?" };
        let resp = client
            .get(format!("{url}{sep}per_page={PER_PAGE}&page={page}"))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!("GitHub API {status}: {body}")));
        }

        let items: Vec<Value> = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        let done = items.len() < PER_PAGE as usize;
        let count = items.len();
        all.extend(items);
        tracing::info!("Fetched fork page {page} ({count} items, total so far: {})", all.len());
        if done {
            break;
        }
        page += 1;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    tracing::info!("Exhaustive fork fetch complete: {} total items", all.len());
    Ok(all)
}

fn str_val(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(|s| s.to_string())
}

fn int_val(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}

fn bool_val(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}

fn labels_json(v: &Value) -> String {
    v["labels"]
        .as_array()
        .map(|arr| {
            serde_json::to_string(
                &arr.iter()
                    .filter_map(|l| l["name"].as_str())
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        })
        .unwrap_or_else(|| "[]".into())
}

fn now_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// ── Token pool management ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AddTokenBody {
    pub token: String,
}

pub async fn list_github_tokens(
    State(state): State<AppState>,
) -> Result<Json<Value>> {
    let tokens = load_tokens(&state).await;
    let masked: Vec<Value> = tokens
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let suffix = if t.len() >= 4 { &t[t.len() - 4..] } else { t };
            json!({ "index": i, "masked": format!("****{}", suffix) })
        })
        .collect();
    Ok(Json(json!({ "tokens": masked, "count": masked.len() })))
}

pub async fn add_github_token(
    State(state): State<AppState>,
    Json(body): Json<AddTokenBody>,
) -> Result<Json<Value>> {
    let tok = body.token.trim().to_string();
    if tok.is_empty() {
        return Err(AppError::BadRequest("Token must not be empty".into()));
    }
    let mut tokens = load_tokens(&state).await;
    if tokens.iter().any(|t| t == &tok) {
        return Ok(Json(json!({ "ok": true, "count": tokens.len() })));
    }
    tokens.push(tok);
    save_tokens(&state, &tokens).await?;
    Ok(Json(json!({ "ok": true, "count": tokens.len() })))
}

pub async fn delete_github_token(
    State(state): State<AppState>,
    Path(index): Path<usize>,
) -> Result<Json<Value>> {
    let mut tokens = load_tokens(&state).await;
    if index >= tokens.len() {
        return Err(AppError::NotFound("Token index out of range".into()));
    }
    tokens.remove(index);
    save_tokens(&state, &tokens).await?;
    Ok(Json(json!({ "ok": true, "count": tokens.len() })))
}

// ── List repos ───────────────────────────────────────────────────────────────

pub async fn list_repos(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>> {
    let mode = state.get_app_mode().await;
    use sqlx::Row;
    let rows = if mode.as_deref() == Some("multi") {
        sqlx::query(
            "SELECT id, owner, name, full_name, description, html_url, stars, forks,
                    open_issues, language, is_private, default_branch,
                    created_at_gh, updated_at_gh, fetched_at
             FROM github_repos WHERE user_id = $1 ORDER BY fetched_at DESC",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT id, owner, name, full_name, description, html_url, stars, forks,
                    open_issues, language, is_private, default_branch,
                    created_at_gh, updated_at_gh, fetched_at
             FROM github_repos ORDER BY fetched_at DESC",
        )
        .fetch_all(&state.db)
        .await?
    };

    let repos: Vec<Value> = rows
        .into_iter()
        .map(|r| json!({
            "id": r.get::<String, _>("id"),
            "owner": r.get::<String, _>("owner"),
            "name": r.get::<String, _>("name"),
            "full_name": r.get::<String, _>("full_name"),
            "description": r.get::<Option<String>, _>("description"),
            "html_url": r.get::<String, _>("html_url"),
            "stars": r.get::<i32, _>("stars"),
            "forks": r.get::<i32, _>("forks"),
            "open_issues": r.get::<i32, _>("open_issues"),
            "language": r.get::<Option<String>, _>("language"),
            "is_private": r.get::<bool, _>("is_private"),
            "default_branch": r.get::<Option<String>, _>("default_branch"),
            "created_at_gh": r.get::<Option<String>, _>("created_at_gh"),
            "updated_at_gh": r.get::<Option<String>, _>("updated_at_gh"),
            "fetched_at": r.get::<String, _>("fetched_at"),
        }))
        .collect();

    Ok(Json(json!(repos)))
}

// ── Add / refresh repo ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AddRepoBody {
    pub url: String,
}

pub async fn add_repo(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<AddRepoBody>,
) -> Sse<impl Stream<Item = std::result::Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        macro_rules! sse_err {
            ($msg:expr) => {{
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message": $msg})).unwrap()
                ));
                return;
            }};
        }
        macro_rules! sse_progress {
            ($msg:expr) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"progress","message": $msg})).unwrap()
                ));
            };
        }
        macro_rules! sse_done {
            ($data:expr) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"done","result": $data})).unwrap()
                ));
            };
        }

        let full_name = match parse_repo_slug(&body.url) {
            Ok(n) => n,
            Err(e) => sse_err!(e.to_string()),
        };
        let tokens = load_tokens(&state).await;
        let client = gh_client(pick_token(&tokens));

        // Fetch repo metadata
        sse_progress!(format!("Fetching repository metadata for {}…", full_name));
        let meta_url = format!("{GH_API}/repos/{full_name}");
        let meta_resp = match client.get(&meta_url).send().await {
            Ok(r) => r,
            Err(e) => sse_err!(format!("Failed to fetch repo: {}", e)),
        };
        if !meta_resp.status().is_success() {
            let status = meta_resp.status().as_u16();
            let body_txt = meta_resp.text().await.unwrap_or_default();
            sse_err!(format!("GitHub API {}: {}", status, body_txt));
        }
        let meta: Value = match meta_resp.json().await {
            Ok(m) => m,
            Err(e) => sse_err!(format!("Failed to parse repo metadata: {}", e)),
        };
        sse_progress!(format!("✓ Repository metadata loaded (⭐ {}, 🍴 {})",
            int_val(&meta, "stargazers_count"), int_val(&meta, "forks_count")));

        let repo_id = Uuid::new_v4().to_string();
        let owner = meta["owner"]["login"].as_str().unwrap_or_else(|| full_name.split('/').next().unwrap_or("")).to_string();
        let name = str_val(&meta, "name");
        let html_url = str_val(&meta, "html_url");
        let description = opt_str(&meta, "description");
        let stars = int_val(&meta, "stargazers_count") as i32;
        let forks = int_val(&meta, "forks_count") as i32;
        let open_issues = int_val(&meta, "open_issues_count") as i32;
        let language = opt_str(&meta, "language");
        let is_private = bool_val(&meta, "private");
        let default_branch = opt_str(&meta, "default_branch");
        let created_at_gh = opt_str(&meta, "created_at");
        let updated_at_gh = opt_str(&meta, "updated_at");
        let fetched_at = now_utc();

        let repo_db_id: String = match sqlx::query_scalar(
            "INSERT INTO github_repos (id, owner, name, full_name, description, html_url, stars, forks,
                 open_issues, language, is_private, default_branch, created_at_gh, updated_at_gh, fetched_at, user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (full_name) DO UPDATE SET description = EXCLUDED.description, html_url = EXCLUDED.html_url,
                 stars = EXCLUDED.stars, forks = EXCLUDED.forks, open_issues = EXCLUDED.open_issues,
                 language = EXCLUDED.language, is_private = EXCLUDED.is_private,
                 default_branch = EXCLUDED.default_branch, updated_at_gh = EXCLUDED.updated_at_gh,
                 fetched_at = EXCLUDED.fetched_at RETURNING id",
        ).bind(&repo_id).bind(&owner).bind(&name).bind(&full_name).bind(&description)
         .bind(&html_url).bind(stars).bind(forks).bind(open_issues).bind(&language)
         .bind(is_private).bind(&default_branch).bind(&created_at_gh).bind(&updated_at_gh)
         .bind(&fetched_at).bind(user.id).fetch_one(&state.db).await {
            Ok(id) => id,
            Err(e) => sse_err!(format!("Database error: {}", e)),
        };

        // Fetch resources in parallel
        sse_progress!("Fetching commits, issues, PRs, releases, forks in parallel…");
        let commits_url = format!("{GH_API}/repos/{full_name}/commits");
        let issues_url = format!("{GH_API}/repos/{full_name}/issues?state=all");
        let pulls_url = format!("{GH_API}/repos/{full_name}/pulls?state=all");
        let releases_url = format!("{GH_API}/repos/{full_name}/releases");
        let forks_url = format!("{GH_API}/repos/{full_name}/forks");
        let discussions_url = format!("{GH_API}/repos/{full_name}/discussions");

        let commits_res = gh_get_all(&client, &commits_url);
        let issues_res = gh_get_all(&client, &issues_url);
        let pulls_res = gh_get_all(&client, &pulls_url);
        let releases_res = gh_get_all(&client, &releases_url);
        let forks_res = gh_get_all_exhaustive(&client, &forks_url);

        let (commits_res, issues_res, pulls_res, releases_res, forks_res) = tokio::join!(
            commits_res, issues_res, pulls_res, releases_res, forks_res,
        );
        let discussions_res = gh_get_all(&client, &discussions_url).await.unwrap_or_default();

        let c_count = commits_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let i_count = issues_res.as_ref().map(|v| v.iter().filter(|i| i["pull_request"].is_null()).count()).unwrap_or(0);
        let p_count = pulls_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let r_count = releases_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let f_count = forks_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let d_count = discussions_res.len();
        sse_progress!(format!("Fetched: {} commits, {} issues, {} PRs, {} releases, {} discussions, {} forks",
            c_count, i_count, p_count, r_count, d_count, f_count));

        // Store commits
        if let Ok(ref commits) = commits_res {
            sse_progress!(format!("Storing {} commits…", commits.len()));
            for c in commits {
                let sha = str_val(c, "sha");
                if sha.is_empty() { continue; }
                let commit_obj = &c["commit"]; let author_obj = &commit_obj["author"];
                let gh_author = &c["author"]; let cid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_commits (id, repo_id, sha, author_name, author_email, author_login, message, committed_at, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (repo_id, sha) DO UPDATE SET author_name = EXCLUDED.author_name, author_email = EXCLUDED.author_email, author_login = EXCLUDED.author_login, message = EXCLUDED.message, committed_at = EXCLUDED.committed_at")
                    .bind(&cid).bind(&repo_db_id).bind(&sha).bind(opt_str(author_obj, "name"))
                    .bind(opt_str(author_obj, "email")).bind(gh_author["login"].as_str().map(|s| s.to_string()))
                    .bind(str_val(commit_obj, "message")).bind(opt_str(author_obj, "date"))
                    .bind(opt_str(c, "html_url")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} commits stored", commits.len()));
        }

        // Store issues
        if let Ok(ref issues) = issues_res {
            let filtered: Vec<_> = issues.iter().filter(|i| i["pull_request"].is_null()).collect();
            sse_progress!(format!("Storing {} issues…", filtered.len()));
            for iss in &filtered {
                let number = int_val(iss, "number") as i32; if number == 0 { continue; }
                let iid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_issues (id, repo_id, number, title, body, state, author_login, labels, created_at, updated_at, closed_at, comments, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (repo_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, state = EXCLUDED.state, labels = EXCLUDED.labels, updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at, comments = EXCLUDED.comments")
                    .bind(&iid).bind(&repo_db_id).bind(number).bind(str_val(iss, "title"))
                    .bind(opt_str(iss, "body")).bind(str_val(iss, "state"))
                    .bind(iss["user"]["login"].as_str().map(|s| s.to_string())).bind(labels_json(iss))
                    .bind(opt_str(iss, "created_at")).bind(opt_str(iss, "updated_at"))
                    .bind(opt_str(iss, "closed_at")).bind(int_val(iss, "comments") as i32)
                    .bind(opt_str(iss, "html_url")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} issues stored", filtered.len()));
        }

        // Store pull requests
        if let Ok(ref pulls) = pulls_res {
            sse_progress!(format!("Storing {} pull requests…", pulls.len()));
            for pr in pulls {
                let number = int_val(pr, "number") as i32; if number == 0 { continue; }
                let pid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_pulls (id, repo_id, number, title, body, state, author_login, labels, created_at, updated_at, closed_at, merged_at, comments, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (repo_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, state = EXCLUDED.state, labels = EXCLUDED.labels, updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at, merged_at = EXCLUDED.merged_at, comments = EXCLUDED.comments")
                    .bind(&pid).bind(&repo_db_id).bind(number).bind(str_val(pr, "title"))
                    .bind(opt_str(pr, "body")).bind(str_val(pr, "state"))
                    .bind(pr["user"]["login"].as_str().map(|s| s.to_string())).bind(labels_json(pr))
                    .bind(opt_str(pr, "created_at")).bind(opt_str(pr, "updated_at"))
                    .bind(opt_str(pr, "closed_at")).bind(opt_str(pr, "merged_at"))
                    .bind(int_val(pr, "comments") as i32).bind(opt_str(pr, "html_url"))
                    .execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} PRs stored", pulls.len()));
        }

        // Store releases
        if let Ok(ref releases) = releases_res {
            sse_progress!(format!("Storing {} releases…", releases.len()));
            for rel in releases {
                let tag = str_val(rel, "tag_name"); if tag.is_empty() { continue; }
                let rid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_releases (id, repo_id, tag_name, name, body, is_draft, is_prerelease, author_login, created_at, published_at, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (repo_id, tag_name) DO UPDATE SET name = EXCLUDED.name, body = EXCLUDED.body, is_draft = EXCLUDED.is_draft, is_prerelease = EXCLUDED.is_prerelease, published_at = EXCLUDED.published_at")
                    .bind(&rid).bind(&repo_db_id).bind(&tag).bind(opt_str(rel, "name"))
                    .bind(opt_str(rel, "body")).bind(bool_val(rel, "draft")).bind(bool_val(rel, "prerelease"))
                    .bind(rel["author"]["login"].as_str().map(|s| s.to_string()))
                    .bind(opt_str(rel, "created_at")).bind(opt_str(rel, "published_at"))
                    .bind(opt_str(rel, "html_url")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} releases stored", releases.len()));
        }

        // Store discussions
        sse_progress!(format!("Storing {} discussions…", discussions_res.len()));
        for disc in &discussions_res {
            let number = int_val(disc, "number") as i32; if number == 0 { continue; }
            let did = Uuid::new_v4().to_string();
            let _ = sqlx::query("INSERT INTO github_discussions (id, repo_id, number, title, body, category, author_login, created_at, updated_at, comments, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (repo_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at, comments = EXCLUDED.comments")
                .bind(&did).bind(&repo_db_id).bind(number).bind(str_val(disc, "title"))
                .bind(opt_str(disc, "body")).bind(disc["category"]["name"].as_str().map(|s| s.to_string()))
                .bind(disc["user"]["login"].as_str().map(|s| s.to_string()))
                .bind(opt_str(disc, "created_at")).bind(opt_str(disc, "updated_at"))
                .bind(int_val(disc, "comments") as i32).bind(opt_str(disc, "html_url"))
                .execute(&state.db).await;
        }
        sse_progress!(format!("✓ {} discussions stored", discussions_res.len()));

        // Store forks
        if let Ok(ref forks) = forks_res {
            sse_progress!(format!("Storing {} forks…", forks.len()));
            for fork in forks {
                let fork_full_name = str_val(fork, "full_name");
                if fork_full_name.is_empty() { continue; }
                let fid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_forks (id, repo_id, fork_full_name, owner_login, html_url, stars, forks, language, description, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (repo_id, fork_full_name) DO UPDATE SET stars = EXCLUDED.stars, forks = EXCLUDED.forks, updated_at = EXCLUDED.updated_at")
                    .bind(&fid).bind(&repo_db_id).bind(&fork_full_name)
                    .bind(fork["owner"]["login"].as_str().map(|s| s.to_string()))
                    .bind(opt_str(fork, "html_url")).bind(int_val(fork, "stargazers_count") as i32)
                    .bind(int_val(fork, "forks_count") as i32).bind(opt_str(fork, "language"))
                    .bind(opt_str(fork, "description")).bind(opt_str(fork, "created_at"))
                    .bind(opt_str(fork, "updated_at")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} forks stored", forks.len()));
        }

        sse_progress!("All data stored successfully!");
        sse_done!(json!({
            "id": repo_db_id,
            "full_name": full_name,
            "stats": {
                "commits": c_count, "issues": i_count, "pulls": p_count,
                "releases": r_count, "discussions": d_count, "forks": f_count
            }
        }));
    };

    Sse::new(stream)
}

// ── Get repo detail ───────────────────────────────────────────────────────────

pub async fn get_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT id, owner, name, full_name, description, html_url, stars, forks,
                open_issues, language, is_private, default_branch,
                created_at_gh, updated_at_gh, fetched_at
         FROM github_repos WHERE id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Repo not found".into()))?;

    Ok(Json(json!({
        "id": row.get::<String, _>("id"),
        "owner": row.get::<String, _>("owner"),
        "name": row.get::<String, _>("name"),
        "full_name": row.get::<String, _>("full_name"),
        "description": row.get::<Option<String>, _>("description"),
        "html_url": row.get::<String, _>("html_url"),
        "stars": row.get::<i32, _>("stars"),
        "forks": row.get::<i32, _>("forks"),
        "open_issues": row.get::<i32, _>("open_issues"),
        "language": row.get::<Option<String>, _>("language"),
        "is_private": row.get::<bool, _>("is_private"),
        "default_branch": row.get::<Option<String>, _>("default_branch"),
        "created_at_gh": row.get::<Option<String>, _>("created_at_gh"),
        "updated_at_gh": row.get::<Option<String>, _>("updated_at_gh"),
        "fetched_at": row.get::<String, _>("fetched_at"),
    })))
}

// ── Delete repo ───────────────────────────────────────────────────────────────

pub async fn delete_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    sqlx::query("DELETE FROM github_repos WHERE id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Re-analyze repo ───────────────────────────────────────────────────────────

pub async fn reanalyze_repo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Sse<impl Stream<Item = std::result::Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        use sqlx::Row;

        macro_rules! sse_err {
            ($msg:expr) => {{
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"error","message": $msg})).unwrap()
                ));
                return;
            }};
        }
        macro_rules! sse_progress {
            ($msg:expr) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"progress","message": $msg})).unwrap()
                ));
            };
        }
        macro_rules! sse_done {
            ($data:expr) => {
                yield Ok(Event::default().data(
                    serde_json::to_string(&json!({"type":"done","result": $data})).unwrap()
                ));
            };
        }

        let row = match sqlx::query("SELECT id, full_name FROM github_repos WHERE id = $1")
            .bind(&id).fetch_optional(&state.db).await {
            Ok(Some(r)) => r,
            Ok(None) => sse_err!("Repo not found"),
            Err(e) => sse_err!(format!("Database error: {}", e)),
        };

        let repo_db_id: String = row.get("id");
        let full_name: String = row.get("full_name");

        let tokens = load_tokens(&state).await;
        let client = gh_client(pick_token(&tokens));

        sse_progress!(format!("Re-fetching metadata for {}…", full_name));
        let meta_url = format!("{GH_API}/repos/{full_name}");
        let meta_resp = match client.get(&meta_url).send().await {
            Ok(r) => r,
            Err(e) => sse_err!(format!("Failed to fetch repo: {}", e)),
        };
        if !meta_resp.status().is_success() {
            let status = meta_resp.status().as_u16();
            let body_txt = meta_resp.text().await.unwrap_or_default();
            sse_err!(format!("GitHub API {}: {}", status, body_txt));
        }
        let meta: Value = match meta_resp.json().await {
            Ok(m) => m,
            Err(e) => sse_err!(format!("Parse error: {}", e)),
        };
        sse_progress!(format!("✓ Metadata updated (⭐ {}, 🍴 {})",
            int_val(&meta, "stargazers_count"), int_val(&meta, "forks_count")));

        // Update repo row
        let _ = sqlx::query("UPDATE github_repos SET description = $1, html_url = $2, stars = $3, forks = $4, open_issues = $5, language = $6, is_private = $7, default_branch = $8, updated_at_gh = $9, fetched_at = $10 WHERE id = $11")
            .bind(opt_str(&meta, "description")).bind(str_val(&meta, "html_url"))
            .bind(int_val(&meta, "stargazers_count") as i32).bind(int_val(&meta, "forks_count") as i32)
            .bind(int_val(&meta, "open_issues_count") as i32).bind(opt_str(&meta, "language"))
            .bind(bool_val(&meta, "private")).bind(opt_str(&meta, "default_branch"))
            .bind(opt_str(&meta, "updated_at")).bind(now_utc()).bind(&repo_db_id)
            .execute(&state.db).await;

        // Re-fetch all resources
        sse_progress!("Fetching all resources in parallel…");
        let commits_url = format!("{GH_API}/repos/{full_name}/commits");
        let issues_url = format!("{GH_API}/repos/{full_name}/issues?state=all");
        let pulls_url = format!("{GH_API}/repos/{full_name}/pulls?state=all");
        let releases_url = format!("{GH_API}/repos/{full_name}/releases");
        let forks_url = format!("{GH_API}/repos/{full_name}/forks");
        let discussions_url = format!("{GH_API}/repos/{full_name}/discussions");

        let commits_res = gh_get_all(&client, &commits_url);
        let issues_res = gh_get_all(&client, &issues_url);
        let pulls_res = gh_get_all(&client, &pulls_url);
        let releases_res = gh_get_all(&client, &releases_url);
        let forks_res = gh_get_all_exhaustive(&client, &forks_url);

        let (commits_res, issues_res, pulls_res, releases_res, forks_res) = tokio::join!(
            commits_res, issues_res, pulls_res, releases_res, forks_res,
        );
        let discussions_res = gh_get_all(&client, &discussions_url).await.unwrap_or_default();

        let c_count = commits_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let i_count = issues_res.as_ref().map(|v| v.iter().filter(|i| i["pull_request"].is_null()).count()).unwrap_or(0);
        let p_count = pulls_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let r_count = releases_res.as_ref().map(|v| v.len()).unwrap_or(0);
        let f_count = forks_res.as_ref().map(|v| v.len()).unwrap_or(0);
        sse_progress!(format!("Fetched: {} commits, {} issues, {} PRs, {} releases, {} discussions, {} forks",
            c_count, i_count, p_count, r_count, discussions_res.len(), f_count));

        // Store commits
        if let Ok(ref commits) = commits_res {
            sse_progress!(format!("Storing {} commits…", commits.len()));
            for c in commits {
                let sha = str_val(c, "sha"); if sha.is_empty() { continue; }
                let co = &c["commit"]; let ao = &co["author"]; let ga = &c["author"];
                let cid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_commits (id, repo_id, sha, author_name, author_email, author_login, message, committed_at, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (repo_id, sha) DO UPDATE SET author_name = EXCLUDED.author_name, author_email = EXCLUDED.author_email, author_login = EXCLUDED.author_login, message = EXCLUDED.message, committed_at = EXCLUDED.committed_at")
                    .bind(&cid).bind(&repo_db_id).bind(&sha).bind(opt_str(ao, "name"))
                    .bind(opt_str(ao, "email")).bind(ga["login"].as_str().map(|s| s.to_string()))
                    .bind(str_val(co, "message")).bind(opt_str(ao, "date"))
                    .bind(opt_str(c, "html_url")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} commits stored", commits.len()));
        }

        // Store issues
        if let Ok(ref issues) = issues_res {
            let filtered: Vec<_> = issues.iter().filter(|i| i["pull_request"].is_null()).collect();
            sse_progress!(format!("Storing {} issues…", filtered.len()));
            for iss in &filtered {
                let number = int_val(iss, "number") as i32; if number == 0 { continue; }
                let iid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_issues (id, repo_id, number, title, body, state, author_login, labels, created_at, updated_at, closed_at, comments, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (repo_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, state = EXCLUDED.state, labels = EXCLUDED.labels, updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at, comments = EXCLUDED.comments")
                    .bind(&iid).bind(&repo_db_id).bind(number).bind(str_val(iss, "title"))
                    .bind(opt_str(iss, "body")).bind(str_val(iss, "state"))
                    .bind(iss["user"]["login"].as_str().map(|s| s.to_string())).bind(labels_json(iss))
                    .bind(opt_str(iss, "created_at")).bind(opt_str(iss, "updated_at"))
                    .bind(opt_str(iss, "closed_at")).bind(int_val(iss, "comments") as i32)
                    .bind(opt_str(iss, "html_url")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} issues stored", filtered.len()));
        }

        // Store PRs
        if let Ok(ref pulls) = pulls_res {
            sse_progress!(format!("Storing {} pull requests…", pulls.len()));
            for pr in pulls {
                let number = int_val(pr, "number") as i32; if number == 0 { continue; }
                let pid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_pulls (id, repo_id, number, title, body, state, author_login, labels, created_at, updated_at, closed_at, merged_at, comments, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (repo_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, state = EXCLUDED.state, labels = EXCLUDED.labels, updated_at = EXCLUDED.updated_at, closed_at = EXCLUDED.closed_at, merged_at = EXCLUDED.merged_at, comments = EXCLUDED.comments")
                    .bind(&pid).bind(&repo_db_id).bind(number).bind(str_val(pr, "title"))
                    .bind(opt_str(pr, "body")).bind(str_val(pr, "state"))
                    .bind(pr["user"]["login"].as_str().map(|s| s.to_string())).bind(labels_json(pr))
                    .bind(opt_str(pr, "created_at")).bind(opt_str(pr, "updated_at"))
                    .bind(opt_str(pr, "closed_at")).bind(opt_str(pr, "merged_at"))
                    .bind(int_val(pr, "comments") as i32).bind(opt_str(pr, "html_url"))
                    .execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} PRs stored", pulls.len()));
        }

        // Store releases
        if let Ok(ref releases) = releases_res {
            sse_progress!(format!("Storing {} releases…", releases.len()));
            for rel in releases {
                let tag = str_val(rel, "tag_name"); if tag.is_empty() { continue; }
                let rid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_releases (id, repo_id, tag_name, name, body, is_draft, is_prerelease, author_login, created_at, published_at, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (repo_id, tag_name) DO UPDATE SET name = EXCLUDED.name, body = EXCLUDED.body, is_draft = EXCLUDED.is_draft, is_prerelease = EXCLUDED.is_prerelease, published_at = EXCLUDED.published_at")
                    .bind(&rid).bind(&repo_db_id).bind(&tag).bind(opt_str(rel, "name"))
                    .bind(opt_str(rel, "body")).bind(bool_val(rel, "draft")).bind(bool_val(rel, "prerelease"))
                    .bind(rel["author"]["login"].as_str().map(|s| s.to_string()))
                    .bind(opt_str(rel, "created_at")).bind(opt_str(rel, "published_at"))
                    .bind(opt_str(rel, "html_url")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} releases stored", releases.len()));
        }

        // Store discussions
        sse_progress!(format!("Storing {} discussions…", discussions_res.len()));
        for disc in &discussions_res {
            let number = int_val(disc, "number") as i32; if number == 0 { continue; }
            let did = Uuid::new_v4().to_string();
            let _ = sqlx::query("INSERT INTO github_discussions (id, repo_id, number, title, body, category, author_login, created_at, updated_at, comments, html_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (repo_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at, comments = EXCLUDED.comments")
                .bind(&did).bind(&repo_db_id).bind(number).bind(str_val(disc, "title"))
                .bind(opt_str(disc, "body")).bind(disc["category"]["name"].as_str().map(|s| s.to_string()))
                .bind(disc["user"]["login"].as_str().map(|s| s.to_string()))
                .bind(opt_str(disc, "created_at")).bind(opt_str(disc, "updated_at"))
                .bind(int_val(disc, "comments") as i32).bind(opt_str(disc, "html_url"))
                .execute(&state.db).await;
        }
        sse_progress!(format!("✓ {} discussions stored", discussions_res.len()));

        // Store forks
        let forks_stored = forks_res.as_ref().map(|f| f.len()).unwrap_or(0);
        if let Ok(ref forks) = forks_res {
            sse_progress!(format!("Storing {} forks…", forks.len()));
            for fork in forks {
                let fn2 = str_val(fork, "full_name");
                if fn2.is_empty() { continue; }
                let fid = Uuid::new_v4().to_string();
                let _ = sqlx::query("INSERT INTO github_forks (id, repo_id, fork_full_name, owner_login, html_url, stars, forks, language, description, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (repo_id, fork_full_name) DO UPDATE SET stars = EXCLUDED.stars, forks = EXCLUDED.forks, updated_at = EXCLUDED.updated_at")
                    .bind(&fid).bind(&repo_db_id).bind(&fn2)
                    .bind(fork["owner"]["login"].as_str().map(|s| s.to_string()))
                    .bind(opt_str(fork, "html_url")).bind(int_val(fork, "stargazers_count") as i32)
                    .bind(int_val(fork, "forks_count") as i32).bind(opt_str(fork, "language"))
                    .bind(opt_str(fork, "description")).bind(opt_str(fork, "created_at"))
                    .bind(opt_str(fork, "updated_at")).execute(&state.db).await;
            }
            sse_progress!(format!("✓ {} forks stored", forks.len()));
        }

        sse_progress!("All data re-fetched successfully!");
        sse_done!(json!({
            "ok": true,
            "id": repo_db_id,
            "full_name": full_name,
            "forks_stored": forks_stored,
            "stats": {
                "commits": c_count, "issues": i_count, "pulls": p_count,
                "releases": r_count, "discussions": discussions_res.len(), "forks": f_count
            }
        }));
    };

    Sse::new(stream)
}

// ── Commits ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PageQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub q: Option<String>,
}

pub async fn list_commits(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<PageQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * per_page;

    let rows = if let Some(q) = &params.q {
        let pattern = format!("%{}%", q);
        sqlx::query(
            "SELECT id, sha, author_name, author_email, author_login, message,
                    committed_at, additions, deletions, changed_files, html_url
             FROM github_commits WHERE repo_id = $1 AND message ILIKE $2
             ORDER BY committed_at DESC NULLS LAST
             LIMIT $3 OFFSET $4",
        )
        .bind(&id).bind(&pattern).bind(per_page).bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query(
            "SELECT id, sha, author_name, author_email, author_login, message,
                    committed_at, additions, deletions, changed_files, html_url
             FROM github_commits WHERE repo_id = $1
             ORDER BY committed_at DESC NULLS LAST
             LIMIT $2 OFFSET $3",
        )
        .bind(&id).bind(per_page).bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM github_commits WHERE repo_id = $1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "sha": r.get::<String, _>("sha"),
        "author_name": r.get::<Option<String>, _>("author_name"),
        "author_email": r.get::<Option<String>, _>("author_email"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "message": r.get::<String, _>("message"),
        "committed_at": r.get::<Option<String>, _>("committed_at"),
        "additions": r.get::<Option<i32>, _>("additions"),
        "deletions": r.get::<Option<i32>, _>("deletions"),
        "changed_files": r.get::<Option<i32>, _>("changed_files"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();

    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

// ── Issues ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct IssueQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub state: Option<String>,
    pub q: Option<String>,
}

pub async fn list_issues(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<IssueQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * per_page;
    let state_filter = params.state.as_deref().unwrap_or("all");

    let (rows, total) = if state_filter == "all" {
        if let Some(q) = &params.q {
            let pattern = format!("%{}%", q);
            (sqlx::query(
                "SELECT id, number, title, body, state, author_login, labels,
                        created_at, updated_at, closed_at, comments, html_url
                 FROM github_issues WHERE repo_id = $1 AND title ILIKE $2
                 ORDER BY created_at DESC NULLS LAST LIMIT $3 OFFSET $4",
            ).bind(&id).bind(&pattern).bind(per_page).bind(offset).fetch_all(&state.db).await?,
             sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM github_issues WHERE repo_id = $1").bind(&id).fetch_one(&state.db).await?)
        } else {
            (sqlx::query(
                "SELECT id, number, title, body, state, author_login, labels,
                        created_at, updated_at, closed_at, comments, html_url
                 FROM github_issues WHERE repo_id = $1
                 ORDER BY created_at DESC NULLS LAST LIMIT $2 OFFSET $3",
            ).bind(&id).bind(per_page).bind(offset).fetch_all(&state.db).await?,
             sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM github_issues WHERE repo_id = $1").bind(&id).fetch_one(&state.db).await?)
        }
    } else {
        (sqlx::query(
            "SELECT id, number, title, body, state, author_login, labels,
                    created_at, updated_at, closed_at, comments, html_url
             FROM github_issues WHERE repo_id = $1 AND state = $2
             ORDER BY created_at DESC NULLS LAST LIMIT $3 OFFSET $4",
        ).bind(&id).bind(state_filter).bind(per_page).bind(offset).fetch_all(&state.db).await?,
         sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM github_issues WHERE repo_id = $1 AND state = $2").bind(&id).bind(state_filter).fetch_one(&state.db).await?)
    };

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "number": r.get::<i32, _>("number"),
        "title": r.get::<String, _>("title"),
        "body": r.get::<Option<String>, _>("body"),
        "state": r.get::<String, _>("state"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "labels": serde_json::from_str::<Value>(&r.get::<String, _>("labels")).unwrap_or(json!([])),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "updated_at": r.get::<Option<String>, _>("updated_at"),
        "closed_at": r.get::<Option<String>, _>("closed_at"),
        "comments": r.get::<Option<i32>, _>("comments"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();

    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

// ── Pull Requests ─────────────────────────────────────────────────────────────

pub async fn list_pulls(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<IssueQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * per_page;
    let state_filter = params.state.as_deref().unwrap_or("all");

    let (rows, total) = if state_filter == "all" {
        (sqlx::query(
            "SELECT id, number, title, body, state, author_login, labels,
                    created_at, updated_at, closed_at, merged_at, comments, html_url
             FROM github_pulls WHERE repo_id = $1
             ORDER BY created_at DESC NULLS LAST LIMIT $2 OFFSET $3",
        ).bind(&id).bind(per_page).bind(offset).fetch_all(&state.db).await?,
         sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM github_pulls WHERE repo_id = $1").bind(&id).fetch_one(&state.db).await?)
    } else {
        (sqlx::query(
            "SELECT id, number, title, body, state, author_login, labels,
                    created_at, updated_at, closed_at, merged_at, comments, html_url
             FROM github_pulls WHERE repo_id = $1 AND state = $2
             ORDER BY created_at DESC NULLS LAST LIMIT $3 OFFSET $4",
        ).bind(&id).bind(state_filter).bind(per_page).bind(offset).fetch_all(&state.db).await?,
         sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM github_pulls WHERE repo_id = $1 AND state = $2").bind(&id).bind(state_filter).fetch_one(&state.db).await?)
    };

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "number": r.get::<i32, _>("number"),
        "title": r.get::<String, _>("title"),
        "body": r.get::<Option<String>, _>("body"),
        "state": r.get::<String, _>("state"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "labels": serde_json::from_str::<Value>(&r.get::<String, _>("labels")).unwrap_or(json!([])),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "updated_at": r.get::<Option<String>, _>("updated_at"),
        "closed_at": r.get::<Option<String>, _>("closed_at"),
        "merged_at": r.get::<Option<String>, _>("merged_at"),
        "comments": r.get::<Option<i32>, _>("comments"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();

    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

// ── Releases ──────────────────────────────────────────────────────────────────

pub async fn list_releases(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<PageQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * per_page;

    let rows = sqlx::query(
        "SELECT id, tag_name, name, body, is_draft, is_prerelease,
                author_login, created_at, published_at, html_url
         FROM github_releases WHERE repo_id = $1
         ORDER BY published_at DESC NULLS LAST LIMIT $2 OFFSET $3",
    )
    .bind(&id).bind(per_page).bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM github_releases WHERE repo_id = $1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "tag_name": r.get::<String, _>("tag_name"),
        "name": r.get::<Option<String>, _>("name"),
        "body": r.get::<Option<String>, _>("body"),
        "is_draft": r.get::<bool, _>("is_draft"),
        "is_prerelease": r.get::<bool, _>("is_prerelease"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "published_at": r.get::<Option<String>, _>("published_at"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();

    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

// ── Discussions ───────────────────────────────────────────────────────────────

pub async fn list_discussions(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<PageQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * per_page;

    let rows = sqlx::query(
        "SELECT id, number, title, body, category, author_login,
                created_at, updated_at, comments, html_url
         FROM github_discussions WHERE repo_id = $1
         ORDER BY created_at DESC NULLS LAST LIMIT $2 OFFSET $3",
    )
    .bind(&id).bind(per_page).bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM github_discussions WHERE repo_id = $1")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "number": r.get::<i32, _>("number"),
        "title": r.get::<String, _>("title"),
        "body": r.get::<Option<String>, _>("body"),
        "category": r.get::<Option<String>, _>("category"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "updated_at": r.get::<Option<String>, _>("updated_at"),
        "comments": r.get::<Option<i32>, _>("comments"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();

    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

// ── Forks ─────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ForkQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    /// Sort by: stars, updated, created
    pub sort: Option<String>,
    /// Order: asc or desc
    pub order: Option<String>,
    /// Filter: only forks updated since this many months ago (e.g. 12 = 1 year)
    pub active_months: Option<i64>,
    /// Filter: only forks NOT updated since this many months ago (inactive)
    pub inactive_months: Option<i64>,
    /// Filter: minimum stars
    pub min_stars: Option<i64>,
}

pub async fn list_forks(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<ForkQuery>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(50).clamp(1, 200);
    let offset = (page - 1) * per_page;

    // Validate sort/order against known values to prevent SQL injection
    let sort_col = match params.sort.as_deref() {
        Some("updated") => "updated_at",
        Some("created") => "created_at",
        _ => "stars",
    };
    let order_dir = match params.order.as_deref() {
        Some("asc") => "ASC",
        _ => "DESC",
    };
    let min_stars = params.min_stars.unwrap_or(0);
    let active_cutoff = params.active_months.map(|m| {
        (chrono::Utc::now() - chrono::Duration::days(m * 30))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    });
    let inactive_cutoff = params.inactive_months.map(|m| {
        (chrono::Utc::now() - chrono::Duration::days(m * 30))
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    });

    // Build query based on which filters are active
    // Inactive filter uses updated_at < cutoff (opposite of active)
    let (rows, total) = if let Some(ref cutoff) = inactive_cutoff {
        if min_stars > 0 {
            let rows = sqlx::query(&format!(
                "SELECT id, fork_full_name, owner_login, html_url, stars, forks,
                        language, description, created_at, updated_at
                 FROM github_forks WHERE repo_id = $1 AND stars >= $2 AND updated_at < $3
                 ORDER BY {sort_col} {order_dir} NULLS LAST
                 LIMIT $4 OFFSET $5"
            ))
            .bind(&id).bind(min_stars).bind(cutoff).bind(per_page).bind(offset)
            .fetch_all(&state.db).await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM github_forks WHERE repo_id = $1 AND stars >= $2 AND updated_at < $3"
            )
            .bind(&id).bind(min_stars).bind(cutoff)
            .fetch_one(&state.db).await?;
            (rows, total)
        } else {
            let rows = sqlx::query(&format!(
                "SELECT id, fork_full_name, owner_login, html_url, stars, forks,
                        language, description, created_at, updated_at
                 FROM github_forks WHERE repo_id = $1 AND updated_at < $2
                 ORDER BY {sort_col} {order_dir} NULLS LAST
                 LIMIT $3 OFFSET $4"
            ))
            .bind(&id).bind(cutoff).bind(per_page).bind(offset)
            .fetch_all(&state.db).await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM github_forks WHERE repo_id = $1 AND updated_at < $2"
            )
            .bind(&id).bind(cutoff)
            .fetch_one(&state.db).await?;
            (rows, total)
        }
    } else if min_stars > 0 && active_cutoff.is_some() {
        let cutoff = active_cutoff.unwrap();
        let rows = sqlx::query(&format!(
            "SELECT id, fork_full_name, owner_login, html_url, stars, forks,
                    language, description, created_at, updated_at
             FROM github_forks WHERE repo_id = $1 AND stars >= $2 AND updated_at >= $3
             ORDER BY {sort_col} {order_dir} NULLS LAST
             LIMIT $4 OFFSET $5"
        ))
        .bind(&id).bind(min_stars).bind(&cutoff).bind(per_page).bind(offset)
        .fetch_all(&state.db).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM github_forks WHERE repo_id = $1 AND stars >= $2 AND updated_at >= $3"
        )
        .bind(&id).bind(min_stars).bind(&cutoff)
        .fetch_one(&state.db).await?;
        (rows, total)
    } else if min_stars > 0 {
        let rows = sqlx::query(&format!(
            "SELECT id, fork_full_name, owner_login, html_url, stars, forks,
                    language, description, created_at, updated_at
             FROM github_forks WHERE repo_id = $1 AND stars >= $2
             ORDER BY {sort_col} {order_dir} NULLS LAST
             LIMIT $3 OFFSET $4"
        ))
        .bind(&id).bind(min_stars).bind(per_page).bind(offset)
        .fetch_all(&state.db).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM github_forks WHERE repo_id = $1 AND stars >= $2"
        )
        .bind(&id).bind(min_stars)
        .fetch_one(&state.db).await?;
        (rows, total)
    } else if let Some(ref cutoff) = active_cutoff {
        let rows = sqlx::query(&format!(
            "SELECT id, fork_full_name, owner_login, html_url, stars, forks,
                    language, description, created_at, updated_at
             FROM github_forks WHERE repo_id = $1 AND updated_at >= $2
             ORDER BY {sort_col} {order_dir} NULLS LAST
             LIMIT $3 OFFSET $4"
        ))
        .bind(&id).bind(cutoff).bind(per_page).bind(offset)
        .fetch_all(&state.db).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM github_forks WHERE repo_id = $1 AND updated_at >= $2"
        )
        .bind(&id).bind(cutoff)
        .fetch_one(&state.db).await?;
        (rows, total)
    } else {
        let rows = sqlx::query(&format!(
            "SELECT id, fork_full_name, owner_login, html_url, stars, forks,
                    language, description, created_at, updated_at
             FROM github_forks WHERE repo_id = $1
             ORDER BY {sort_col} {order_dir} NULLS LAST
             LIMIT $2 OFFSET $3"
        ))
        .bind(&id).bind(per_page).bind(offset)
        .fetch_all(&state.db).await?;
        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM github_forks WHERE repo_id = $1"
        )
        .bind(&id)
        .fetch_one(&state.db).await?;
        (rows, total)
    };

    let items: Vec<Value> = rows.into_iter().map(|r| json!({
        "full_name": r.get::<String, _>("fork_full_name"),
        "owner_login": r.get::<Option<String>, _>("owner_login"),
        "html_url": r.get::<Option<String>, _>("html_url"),
        "stars": r.get::<i32, _>("stars"),
        "forks": r.get::<i32, _>("forks"),
        "language": r.get::<Option<String>, _>("language"),
        "description": r.get::<Option<String>, _>("description"),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "updated_at": r.get::<Option<String>, _>("updated_at"),
    })).collect();

    Ok(Json(json!({ "items": items, "total": total, "page": page, "per_page": per_page })))
}

// ── Commit detail (lazy-fetch stats + files from GitHub API) ──────────────────

pub async fn get_commit_detail(
    State(state): State<AppState>,
    Path((repo_id, sha)): Path<(String, String)>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT c.sha, c.author_name, c.author_email, c.author_login, c.message,
                c.committed_at, c.additions, c.deletions, c.changed_files,
                c.html_url, c.stats_fetched, c.files, r.full_name
         FROM github_commits c
         JOIN github_repos r ON r.id = c.repo_id
         WHERE c.repo_id = $1 AND c.sha LIKE $2",
    )
    .bind(&repo_id)
    .bind(format!("{}%", sha))
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Commit not found".into()))?;

    let stats_fetched = row.get::<bool, _>("stats_fetched");
    let full_name = row.get::<String, _>("full_name");
    let db_sha = row.get::<String, _>("sha");

    if !stats_fetched {
        let tokens = load_tokens(&state).await;
        let client = gh_client(pick_token(&tokens));
        if let Ok(resp) = client
            .get(format!("{GH_API}/repos/{full_name}/commits/{db_sha}"))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(detail) = resp.json::<Value>().await {
                    let additions = detail["stats"]["additions"].as_i64().unwrap_or(0) as i32;
                    let deletions = detail["stats"]["deletions"].as_i64().unwrap_or(0) as i32;
                    let files_arr = detail["files"].as_array().cloned().unwrap_or_default();
                    let changed_files = files_arr.len() as i32;
                    let files: Vec<Value> = files_arr.iter().map(|f| json!({
                        "filename": f["filename"].as_str().unwrap_or(""),
                        "status": f["status"].as_str().unwrap_or(""),
                        "additions": f["additions"].as_i64().unwrap_or(0),
                        "deletions": f["deletions"].as_i64().unwrap_or(0),
                        "changes": f["changes"].as_i64().unwrap_or(0),
                    })).collect();
                    let files_json = serde_json::to_string(&files).unwrap_or_else(|_| "[]".into());
                    let _ = sqlx::query(
                        "UPDATE github_commits
                         SET additions=$1, deletions=$2, changed_files=$3,
                             files=$4, stats_fetched=true
                         WHERE repo_id=$5 AND sha=$6",
                    )
                    .bind(additions).bind(deletions).bind(changed_files)
                    .bind(&files_json).bind(&repo_id).bind(&db_sha)
                    .execute(&state.db)
                    .await;
                    return Ok(Json(json!({
                        "sha": db_sha,
                        "author_name": row.get::<Option<String>, _>("author_name"),
                        "author_email": row.get::<Option<String>, _>("author_email"),
                        "author_login": row.get::<Option<String>, _>("author_login"),
                        "message": row.get::<String, _>("message"),
                        "committed_at": row.get::<Option<String>, _>("committed_at"),
                        "html_url": row.get::<Option<String>, _>("html_url"),
                        "additions": additions,
                        "deletions": deletions,
                        "changed_files": changed_files,
                        "files": files,
                    })));
                }
            }
        }
    }

    let files: Value = serde_json::from_str(
        &row.get::<String, _>("files")
    ).unwrap_or(json!([]));
    Ok(Json(json!({
        "sha": db_sha,
        "author_name": row.get::<Option<String>, _>("author_name"),
        "author_email": row.get::<Option<String>, _>("author_email"),
        "author_login": row.get::<Option<String>, _>("author_login"),
        "message": row.get::<String, _>("message"),
        "committed_at": row.get::<Option<String>, _>("committed_at"),
        "html_url": row.get::<Option<String>, _>("html_url"),
        "additions": row.get::<Option<i32>, _>("additions"),
        "deletions": row.get::<Option<i32>, _>("deletions"),
        "changed_files": row.get::<Option<i32>, _>("changed_files"),
        "files": files,
    })))
}

// ── Issue / PR thread comments (lazy-fetch + cache) ───────────────────────────

pub async fn get_issue_comments(
    State(state): State<AppState>,
    Path((repo_id, number)): Path<(String, i32)>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let issue = sqlx::query(
        "SELECT i.comments_fetched, r.full_name
         FROM github_issues i
         JOIN github_repos r ON r.id = i.repo_id
         WHERE i.repo_id = $1 AND i.number = $2",
    )
    .bind(&repo_id).bind(number)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Issue not found".into()))?;

    if !issue.get::<bool, _>("comments_fetched") {
        let full_name = issue.get::<String, _>("full_name");
        let tokens = load_tokens(&state).await;
        let client = gh_client(pick_token(&tokens));
        let url = format!("{GH_API}/repos/{full_name}/issues/{number}/comments");
        if let Ok(items) = gh_get_all(&client, &url).await {
            for c in &items {
                let gh_id = c["id"].as_i64();
                let _ = sqlx::query(
                    "INSERT INTO github_issue_comments
                         (id, repo_id, issue_number, comment_gh_id, author_login,
                          body, created_at, html_url)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (repo_id, comment_gh_id) DO NOTHING",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(&repo_id).bind(number).bind(gh_id)
                .bind(c["user"]["login"].as_str().map(|s| s.to_string()))
                .bind(c["body"].as_str().unwrap_or(""))
                .bind(opt_str(c, "created_at"))
                .bind(opt_str(c, "html_url"))
                .execute(&state.db)
                .await;
            }
        }
        let _ = sqlx::query(
            "UPDATE github_issues SET comments_fetched=true WHERE repo_id=$1 AND number=$2",
        )
        .bind(&repo_id).bind(number)
        .execute(&state.db)
        .await;
    }

    let rows = sqlx::query(
        "SELECT id, comment_gh_id, author_login, body, created_at, html_url
         FROM github_issue_comments
         WHERE repo_id=$1 AND issue_number=$2
         ORDER BY created_at ASC NULLS LAST",
    )
    .bind(&repo_id).bind(number)
    .fetch_all(&state.db)
    .await?;

    let comments: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "body": r.get::<String, _>("body"),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();
    Ok(Json(json!(comments)))
}

pub async fn get_pull_comments(
    State(state): State<AppState>,
    Path((repo_id, number)): Path<(String, i32)>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let pr = sqlx::query(
        "SELECT p.comments_fetched, r.full_name
         FROM github_pulls p
         JOIN github_repos r ON r.id = p.repo_id
         WHERE p.repo_id = $1 AND p.number = $2",
    )
    .bind(&repo_id).bind(number)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Pull request not found".into()))?;

    if !pr.get::<bool, _>("comments_fetched") {
        let full_name = pr.get::<String, _>("full_name");
        let tokens = load_tokens(&state).await;
        let client = gh_client(pick_token(&tokens));
        let url = format!("{GH_API}/repos/{full_name}/issues/{number}/comments");
        if let Ok(items) = gh_get_all(&client, &url).await {
            for c in &items {
                let gh_id = c["id"].as_i64();
                let _ = sqlx::query(
                    "INSERT INTO github_issue_comments
                         (id, repo_id, issue_number, comment_gh_id, author_login,
                          body, created_at, html_url)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (repo_id, comment_gh_id) DO NOTHING",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(&repo_id).bind(number).bind(gh_id)
                .bind(c["user"]["login"].as_str().map(|s| s.to_string()))
                .bind(c["body"].as_str().unwrap_or(""))
                .bind(opt_str(c, "created_at"))
                .bind(opt_str(c, "html_url"))
                .execute(&state.db)
                .await;
            }
        }
        let _ = sqlx::query(
            "UPDATE github_pulls SET comments_fetched=true WHERE repo_id=$1 AND number=$2",
        )
        .bind(&repo_id).bind(number)
        .execute(&state.db)
        .await;
    }

    let rows = sqlx::query(
        "SELECT id, comment_gh_id, author_login, body, created_at, html_url
         FROM github_issue_comments
         WHERE repo_id=$1 AND issue_number=$2
         ORDER BY created_at ASC NULLS LAST",
    )
    .bind(&repo_id).bind(number)
    .fetch_all(&state.db)
    .await?;

    let comments: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "body": r.get::<String, _>("body"),
        "created_at": r.get::<Option<String>, _>("created_at"),
        "html_url": r.get::<Option<String>, _>("html_url"),
    })).collect();
    Ok(Json(json!(comments)))
}

// ── Discussion thread comments ────────────────────────────────────────────────

pub async fn get_discussion_comments(
    State(state): State<AppState>,
    Path((repo_id, number)): Path<(String, i32)>,
) -> Result<Json<Value>> {
    use sqlx::Row;
    let disc = sqlx::query(
        "SELECT d.comments_fetched, r.full_name
         FROM github_discussions d
         JOIN github_repos r ON r.id = d.repo_id
         WHERE d.repo_id = $1 AND d.number = $2",
    )
    .bind(&repo_id).bind(number)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Discussion not found".into()))?;

    if !disc.get::<bool, _>("comments_fetched") {
        let full_name = disc.get::<String, _>("full_name");
        let tokens = load_tokens(&state).await;
        let client = gh_client(pick_token(&tokens));
        let url = format!("{GH_API}/repos/{full_name}/discussions/{number}/comments");
        if let Ok(items) = gh_get_all(&client, &url).await {
            for c in &items {
                let gh_id = c["id"].as_i64();
                let _ = sqlx::query(
                    "INSERT INTO github_discussion_comments
                         (id, repo_id, discussion_number, comment_gh_id,
                          author_login, body, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (repo_id, comment_gh_id) DO NOTHING",
                )
                .bind(Uuid::new_v4().to_string())
                .bind(&repo_id).bind(number).bind(gh_id)
                .bind(c["user"]["login"].as_str().map(|s| s.to_string()))
                .bind(c["body"].as_str().unwrap_or(""))
                .bind(opt_str(c, "created_at"))
                .execute(&state.db)
                .await;
            }
        }
        let _ = sqlx::query(
            "UPDATE github_discussions SET comments_fetched=true WHERE repo_id=$1 AND number=$2",
        )
        .bind(&repo_id).bind(number)
        .execute(&state.db)
        .await;
    }

    let rows = sqlx::query(
        "SELECT id, comment_gh_id, author_login, body, created_at
         FROM github_discussion_comments
         WHERE repo_id=$1 AND discussion_number=$2
         ORDER BY created_at ASC NULLS LAST",
    )
    .bind(&repo_id).bind(number)
    .fetch_all(&state.db)
    .await?;

    let comments: Vec<Value> = rows.into_iter().map(|r| json!({
        "id": r.get::<String, _>("id"),
        "author_login": r.get::<Option<String>, _>("author_login"),
        "body": r.get::<String, _>("body"),
        "created_at": r.get::<Option<String>, _>("created_at"),
    })).collect();
    Ok(Json(json!(comments)))
}

// ── URL parser ────────────────────────────────────────────────────────────────

fn parse_repo_slug(input: &str) -> Result<String> {
    let s = input.trim().trim_end_matches('/');
    // Handle full URLs: https://github.com/owner/repo
    if s.contains("github.com") {
        let path = s
            .splitn(2, "github.com/")
            .nth(1)
            .ok_or_else(|| AppError::BadRequest("Invalid GitHub URL".into()))?;
        let parts: Vec<&str> = path.splitn(3, '/').collect();
        if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
            return Err(AppError::BadRequest("Could not parse owner/repo from URL".into()));
        }
        return Ok(format!("{}/{}", parts[0], parts[1]));
    }
    // Bare "owner/repo"
    let parts: Vec<&str> = s.splitn(3, '/').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(AppError::BadRequest("Provide a GitHub URL or owner/repo slug".into()));
    }
    Ok(format!("{}/{}", parts[0], parts[1]))
}

