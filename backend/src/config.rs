use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    // Qdrant
    pub qdrant_url: String,
    pub qdrant_collection: String,
    pub qdrant_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub app_mode: Option<String>,
    pub ai_service_url: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgres:password@localhost/discord_db".to_string()),
            qdrant_url: env::var("QDRANT_URL")
                .unwrap_or_else(|_| "http://localhost:6333".to_string()),
            qdrant_collection: env::var("QDRANT_COLLECTION")
                .unwrap_or_else(|_| "discord_openai".to_string()),
            qdrant_api_key: env::var("QDRANT_API_KEY").ok(),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            app_mode: env::var("APP_MODE").ok(),
            ai_service_url: env::var("AI_SERVICE_URL")
                .unwrap_or_else(|_| "http://localhost:8001".to_string()),
        }
    }

    pub fn vector_db_label(&self) -> &'static str {
        "Qdrant"
    }
}
