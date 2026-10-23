use crate::limits::Cidr;
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
    /// Check each saved deck version with Commander Spellbook in the background (bracket
    /// estimate, flagged cards, combos). On unless `YAMA_DECK_CHECKS=0`; sends deck lists there.
    pub deck_checks: bool,
    /// The rules engine's card data (phase card-data.json). Online play is off without it.
    pub engine_card_data: Option<PathBuf>,
    /// Cloudflare Access team name (`<team>.cloudflareaccess.com`) and application audience
    /// tag. With both set, people signed in by Access are signed in to Yama.
    pub cf_access_team: Option<String>,
    pub cf_access_aud: Option<String>,
    /// Game threads for the simulation lab's experiments (YAMA_LAB_THREADS, default 2). 0 turns
    /// the lab off: experiments can be read but no new ones start.
    pub lab_threads: usize,
    /// Anyone with a verified Google account may make an account (YAMA_OPEN_SIGNUP=1; off by
    /// default). Invites still matter: an account that isn't invited gets the smaller allowance
    /// (`auth::User::limited`), and can't use Yama at all once this is off again.
    pub open_signup: bool,
    /// Password sign-in for accounts given a password with `yama-server user add`. On unless
    /// YAMA_PASSWORD_LOGIN=0. Nothing ever makes a password account except that command.
    pub password_login: bool,
    /// Peers whose `CF-Connecting-IP` header is believed (YAMA_TRUSTED_PROXIES: addresses or
    /// CIDR ranges, comma-separated). Set it to the Cloudflare tunnel connector's Docker network;
    /// without it, per-address limits count the connector's address (see `limits.rs`).
    pub trusted_proxies: Vec<Cidr>,
    /// The lab's caps on queued games and on accounts that joined without an invite.
    pub lab_quota: LabQuota,
    /// "Ask Claude" (`advisor/`): where the sidecar is, and who may use the server's subscription.
    pub advisor: AdvisorConfig,
    /// Forge as a second Lab engine (`lab/forge.rs`): where its worker container is.
    pub forge: ForgeConfig,
    /// Yama's public address, as people and Claude's connectors reach it (YAMA_PUBLIC_URL, e.g.
    /// `https://yama.saget.org`): an origin, with no path or trailing slash. OAuth sign-in for
    /// the tools (`oauth/`) is off without it. Its issuer, endpoints and the `/mcp` resource are
    /// built from this, never from a request's Host header.
    pub public_url: Option<String>,
    /// Hosts an OAuth app may send people back to over https (YAMA_OAUTH_REDIRECT_HOSTS,
    /// comma-separated; `claude.ai,claude.com` when unset). Loopback `http` redirects (Claude Code)
    /// are always allowed; everything else is refused at registration (`oauth/redirect.rs`).
    pub oauth_redirect_hosts: Vec<String>,
}

/// The https hosts OAuth apps may redirect to when YAMA_OAUTH_REDIRECT_HOSTS isn't set: claude.ai's
/// connector callback (`https://claude.ai/api/mcp/auth_callback`), and claude.com, where Anthropic
/// says that callback may move.
pub const DEFAULT_OAUTH_REDIRECT_HOSTS: [&str; 2] = ["claude.ai", "claude.com"];

/// YAMA_PUBLIC_URL as an origin (`https://host[:port]`, lower case, no default port), or why not.
pub fn public_origin(raw: &str) -> anyhow::Result<String> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| anyhow::anyhow!("YAMA_PUBLIC_URL {raw:?} isn't a URL: {e}"))?;
    anyhow::ensure!(matches!(parsed.scheme(), "https" | "http"), "YAMA_PUBLIC_URL must start with https:// (or http:// for local testing)");
    anyhow::ensure!(parsed.host_str().is_some_and(|h| !h.is_empty()), "YAMA_PUBLIC_URL has no host");
    anyhow::ensure!(
        matches!(parsed.path(), "" | "/") && parsed.query().is_none() && parsed.fragment().is_none() && parsed.username().is_empty() && parsed.password().is_none(),
        "YAMA_PUBLIC_URL must be just the address, like https://yama.saget.org (no path, query or login)"
    );
    Ok(parsed.origin().ascii_serialization())
}

/// The Forge worker's settings. Forge runs are off unless both are set.
#[derive(Clone, Debug, Default)]
pub struct ForgeConfig {
    /// The worker's address on the private Docker network (YAMA_FORGE_URL, e.g.
    /// `http://yama-forge:8791`).
    pub url: Option<String>,
    /// Shared with the worker as FORGE_SECRET (YAMA_FORGE_SECRET, at least 32 characters).
    pub secret: Option<String>,
}

impl ForgeConfig {
    pub fn enabled(&self) -> bool {
        self.url.is_some() && self.secret.is_some()
    }
}

/// The advisor's settings. The advisor is off unless both `url` and `secret` are set.
#[derive(Clone, Debug)]
pub struct AdvisorConfig {
    /// The sidecar's address on the private Docker network (YAMA_ADVISOR_URL, e.g.
    /// `http://yama-advisor:8790`).
    pub url: Option<String>,
    /// Shared with the sidecar as ADVISOR_SECRET (YAMA_ADVISOR_SECRET, at least 32 characters).
    pub secret: Option<String>,
    /// Accounts that may use the server's Claude subscription (YAMA_ADVISOR_SUBSCRIPTION_EMAILS,
    /// comma-separated; empty by default). Anthropic doesn't allow sharing one person's
    /// subscription with other people, so this is the subscription owner's own account(s) only.
    pub subscription_emails: Vec<String>,
    /// Encrypts users' own API keys at rest (YAMA_ADVISOR_KEY_SECRET, at least 32 characters).
    /// Without it nobody can save a key, so only subscription accounts can ask.
    pub key_secret: Option<String>,
    /// Where the sidecar reaches Yama's tools for Claude (`mcp/`), on the same private network
    /// (YAMA_ADVISOR_TOOLS_URL, e.g. `http://yama:8787/mcp`). Without it Ask Claude answers from
    /// the context alone, with no tools.
    pub tools_url: Option<String>,
    /// The shared API key (`advisor/shared.rs`): the most its questions may cost together in one
    /// calendar month, UTC, in USD (YAMA_ADVISOR_SHARED_MONTHLY_USD, default 10). The key itself is
    /// only in the sidecar; 0 pauses shared questions.
    pub shared_monthly_usd: f64,
    /// Models a shared-key question may use (YAMA_ADVISOR_SHARED_MODELS, comma-separated ids from
    /// `advisor::MODELS`; default Haiku only, the cheapest).
    pub shared_models: Vec<String>,
    /// Whose key it is, for "On Bryan's shared key" (YAMA_ADVISOR_SHARED_OWNER_NAME). Without it,
    /// the display name of the admin who granted the account.
    pub shared_owner_name: Option<String>,
}

impl Default for AdvisorConfig {
    fn default() -> Self {
        Self {
            url: None,
            secret: None,
            subscription_emails: vec![],
            key_secret: None,
            tools_url: None,
            shared_monthly_usd: 10.0,
            shared_models: vec![crate::advisor::DEFAULT_MODEL.to_string()],
            shared_owner_name: None,
        }
    }
}

impl AdvisorConfig {
    pub fn enabled(&self) -> bool {
        self.url.is_some() && self.secret.is_some()
    }
}

/// YAMA_ADVISOR_SHARED_MODELS: model ids the advisor offers, or Haiku alone when unset.
pub(crate) fn shared_models(raw: Option<&str>) -> anyhow::Result<Vec<String>> {
    let ids: Vec<String> = raw.unwrap_or_default().split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    if ids.is_empty() {
        return Ok(vec![crate::advisor::DEFAULT_MODEL.to_string()]);
    }
    for id in &ids {
        anyhow::ensure!(
            crate::advisor::MODELS.iter().any(|(m, ..)| m == id),
            "YAMA_ADVISOR_SHARED_MODELS: {id:?} isn't one of {}",
            crate::advisor::MODELS.iter().map(|m| m.0).collect::<Vec<_>>().join(", ")
        );
    }
    Ok(ids)
}

/// YAMA_ADVISOR_SHARED_MONTHLY_USD: dollars, at least 0, or 10 when unset.
pub(crate) fn monthly_usd(raw: Option<&str>) -> anyhow::Result<f64> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(10.0),
        Some(v) => {
            let n: f64 = v.trim_start_matches('$').parse().with_context(|| format!("YAMA_ADVISOR_SHARED_MONTHLY_USD {v:?} must be a number of dollars"))?;
            anyhow::ensure!(n.is_finite() && n >= 0.0, "YAMA_ADVISOR_SHARED_MONTHLY_USD can't be negative");
            Ok(n)
        }
    }
}

/// How much of the lab anyone but an admin may take. Admins have no caps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LabQuota {
    /// Most games waiting or playing at once for everyone but admins together
    /// (YAMA_LAB_QUEUE_GAMES, default 2,000).
    pub queue_games: i64,
    /// Most of those from accounts that joined without an invite, together
    /// (YAMA_LAB_OPEN_QUEUE_GAMES, default 400).
    pub open_queue_games: i64,
    /// Games one account that joined without an invite may ask for in 24 hours
    /// (YAMA_LAB_OPEN_DAILY_GAMES, default 300: three 100-game runs).
    pub open_daily_games: i64,
}

impl Default for LabQuota {
    fn default() -> Self {
        Self { queue_games: 2_000, open_queue_games: 400, open_daily_games: 300 }
    }
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
        let off = |key: &str| matches!(std::env::var(key).as_deref(), Ok("0" | "false" | "no"));
        let number = |key: &str, default: i64| -> anyhow::Result<i64> {
            match std::env::var(key) {
                Ok(v) if !v.trim().is_empty() => {
                    let n: i64 = v.trim().parse().with_context(|| format!("{key} {v:?} must be a whole number"))?;
                    anyhow::ensure!(n >= 0, "{key} can't be negative");
                    Ok(n)
                }
                _ => Ok(default),
            }
        };
        let trusted_proxies = std::env::var("YAMA_TRUSTED_PROXIES")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| Cidr::parse(s).map_err(|e| anyhow::anyhow!("YAMA_TRUSTED_PROXIES: {e}")))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let defaults = LabQuota::default();
        let lab_quota = LabQuota {
            queue_games: number("YAMA_LAB_QUEUE_GAMES", defaults.queue_games)?,
            open_queue_games: number("YAMA_LAB_OPEN_QUEUE_GAMES", defaults.open_queue_games)?,
            open_daily_games: number("YAMA_LAB_OPEN_DAILY_GAMES", defaults.open_daily_games)?,
        };
        let data_dir = PathBuf::from(std::env::var("YAMA_DATA_DIR").unwrap_or_else(|_| "data".into()));
        std::fs::create_dir_all(&data_dir).with_context(|| format!("creating {}", data_dir.display()))?;
        let engine_card_data = std::env::var("YAMA_ENGINE_CARD_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("engine/card-data-eb309108eb0df708.json"));
        let bind = std::env::var("YAMA_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
        // Dev login lets anyone in as anyone, so it only works on a server only this machine can reach.
        let loopback = bind.parse::<std::net::SocketAddr>().is_ok_and(|a| a.ip().is_loopback());
        let dev_login = flag("YAMA_DEV_LOGIN") && {
            if !loopback {
                eprintln!("YAMA_DEV_LOGIN ignored: YAMA_BIND {bind} is reachable from other machines. Use `yama-server user add` instead.");
            }
            loopback
        };
        let secret = |key: &str| -> anyhow::Result<Option<String>> {
            match std::env::var(key) {
                Ok(v) if !v.trim().is_empty() => {
                    anyhow::ensure!(v.trim().len() >= 32, "{key} must be at least 32 characters (try `openssl rand -hex 32`)");
                    Ok(Some(v.trim().to_string()))
                }
                _ => Ok(None),
            }
        };
        let advisor = AdvisorConfig {
            url: std::env::var("YAMA_ADVISOR_URL").ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()),
            secret: secret("YAMA_ADVISOR_SECRET")?,
            subscription_emails: list("YAMA_ADVISOR_SUBSCRIPTION_EMAILS"),
            shared_monthly_usd: monthly_usd(std::env::var("YAMA_ADVISOR_SHARED_MONTHLY_USD").ok().as_deref())?,
            shared_models: shared_models(std::env::var("YAMA_ADVISOR_SHARED_MODELS").ok().as_deref())?,
            shared_owner_name: std::env::var("YAMA_ADVISOR_SHARED_OWNER_NAME").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            key_secret: secret("YAMA_ADVISOR_KEY_SECRET")?,
            tools_url: std::env::var("YAMA_ADVISOR_TOOLS_URL").ok().map(|s| s.trim().to_string()).filter(|s| s.starts_with("http://") || s.starts_with("https://")),
        };
        let public_url = match std::env::var("YAMA_PUBLIC_URL") {
            Ok(v) if !v.trim().is_empty() => Some(public_origin(&v)?),
            _ => None,
        };
        // Unset means the default; set but empty means loopback redirects only.
        let oauth_redirect_hosts = match std::env::var("YAMA_OAUTH_REDIRECT_HOSTS") {
            Ok(_) => list("YAMA_OAUTH_REDIRECT_HOSTS"),
            Err(_) => DEFAULT_OAUTH_REDIRECT_HOSTS.iter().map(|h| h.to_string()).collect(),
        };
        let forge = ForgeConfig {
            url: std::env::var("YAMA_FORGE_URL").ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| s.starts_with("http://") || s.starts_with("https://")),
            secret: secret("YAMA_FORGE_SECRET")?,
        };
        Ok(Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| format!("sqlite://{}/yama.db", data_dir.display())),
            bind,
            web_dist: std::env::var("YAMA_WEB_DIST").ok().map(PathBuf::from),
            // Client IDs are case-sensitive; don't lowercase them.
            google_client_ids: std::env::var("YAMA_GOOGLE_CLIENT_IDS")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            admin_emails: list("YAMA_ADMIN_EMAILS"),
            dev_login,
            data_dir,
            secure_cookies: flag("YAMA_SECURE_COOKIES"),
            cors_origins: list("YAMA_CORS_ORIGINS"),
            auto_import: flag("YAMA_AUTO_IMPORT"),
            deck_checks: !off("YAMA_DECK_CHECKS"),
            engine_card_data: Some(engine_card_data),
            cf_access_team: std::env::var("YAMA_CF_ACCESS_TEAM").ok().filter(|s| !s.is_empty()),
            cf_access_aud: std::env::var("YAMA_CF_ACCESS_AUD").ok().filter(|s| !s.is_empty()),
            lab_threads: match std::env::var("YAMA_LAB_THREADS") {
                Ok(v) if !v.trim().is_empty() => v.trim().parse().with_context(|| format!("YAMA_LAB_THREADS {v:?} must be a whole number"))?,
                _ => 2,
            },
            open_signup: flag("YAMA_OPEN_SIGNUP"),
            password_login: !off("YAMA_PASSWORD_LOGIN"),
            trusted_proxies,
            lab_quota,
            advisor,
            forge,
            public_url,
            oauth_redirect_hosts,
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
