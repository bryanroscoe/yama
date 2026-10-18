use anyhow::Context;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind: String,
    /// Built web app to serve at `/`. Optional: in development Vite serves the UI.
    pub web_dist: Option<PathBuf>,
    /// OAuth client IDs whose Google ID tokens we accept (web, iOS, Android).
    pub google_client_ids: Vec<String>,
    /// Always allowed to sign in, and allowed to invite others.
    pub admin_emails: Vec<String>,
    /// Enables `/api/auth/dev`, which signs in by email with no password. Local use only.
    pub dev_login: bool,
    /// Where downloaded bulk files go before import.
    pub data_dir: PathBuf,
    /// Set the session cookie `Secure` flag (true behind HTTPS).
    pub secure_cookies: bool,
    /// Extra origins allowed to call the API: the phone apps (`capacitor://localhost`, `https://localhost`).
    pub cors_origins: Vec<String>,
    /// Refresh Scryfall data in the background (prices daily, rules weekly).
    pub auto_import: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let _ = dotenv_file(".env");
        let list = |key: &str| -> Vec<String> {
            std::env::var(key)
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        };
        let flag = |key: &str| matches!(std::env::var(key).as_deref(), Ok("1" | "true" | "yes"));
        let data_dir = PathBuf::from(std::env::var("YAMA_DATA_DIR").unwrap_or_else(|_| "data".into()));
        std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
        Ok(Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| format!("sqlite://{}/yama.db", data_dir.display())),
            bind: std::env::var("YAMA_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into()),
            web_dist: std::env::var("YAMA_WEB_DIST").ok().map(PathBuf::from),
            // Client IDs are case-sensitive; don't lowercase them.
            google_client_ids: std::env::var("YAMA_GOOGLE_CLIENT_IDS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            admin_emails: list("YAMA_ADMIN_EMAILS"),
            dev_login: flag("YAMA_DEV_LOGIN"),
            data_dir,
            secure_cookies: flag("YAMA_SECURE_COOKIES"),
            cors_origins: list("YAMA_CORS_ORIGINS"),
            auto_import: flag("YAMA_AUTO_IMPORT"),
        })
    }
}

/// Minimal `.env` loader: KEY=VALUE lines, `#` comments, existing env wins.
fn dotenv_file(path: &str) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let (k, v) = (k.trim(), v.trim().trim_matches('"'));
            if std::env::var_os(k).is_none() {
                // SAFETY: called once at startup before any other threads read the environment.
                unsafe { std::env::set_var(k, v) };
            }
        }
    }
    Ok(())
}
