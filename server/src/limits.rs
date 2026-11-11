//! Limits that keep one account (or one address) from wearing out what everyone shares, written
//! for open sign-up (YAMA_OPEN_SIGNUP): an in-memory rate limiter, the client's address for
//! per-address limits, and the limits themselves.
//!
//! **Which address counts.** The TCP peer, unless the peer is a trusted proxy
//! (YAMA_TRUSTED_PROXIES), in which case Cloudflare's `CF-Connecting-IP` header. On saget the
//! public route is the Cloudflare tunnel: its connector (`novalyst-cloudflared`) reaches Yama over
//! the `novalyst_default` Docker network, so Bryan sets YAMA_TRUSTED_PROXIES to that network's
//! range. Cloudflare writes `CF-Connecting-IP` itself and replaces any value a visitor sends, so a
//! request that came through the tunnel carries the visitor's real address. A request from
//! anywhere else (the LAN port, which Docker hands over with the LAN client's own address, or a
//! peer outside the list) could carry any header, so the header is ignored and the peer counts.
//! With no list, every tunnel request counts as the connector's address; the first such request
//! logs a warning saying so. IPv6 addresses count by their /64, which one home or server holds
//! whole, so walking through a /64 doesn't give fresh attempts.
//!
//! The limiter is per process and forgets everything on restart, which is fine for slowing down
//! guessing and scripted floods. It is not a quota; lasting allowances (the lab's daily games, open
//! online games) are counted in the database where they're enforced.

use crate::auth::User;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MINUTE: Duration = Duration::from_secs(60);
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// Sign-in attempts (Google and password together), per address and per email.
pub const SIGN_IN_ATTEMPTS: usize = 10;
pub const SIGN_IN_WINDOW: Duration = Duration::from_secs(10 * 60);
/// New open sign-up accounts per address per day, and from everywhere per hour.
pub const NEW_ACCOUNTS_PER_ADDRESS: usize = 3;
pub const NEW_ACCOUNTS_PER_HOUR: usize = 60;

/// Tool calls on `/mcp` one account may make in a minute, and in a day when it joined through
/// open sign-up (docs/mcp-design.md, Limits).
pub const MCP_CALLS_PER_MINUTE: usize = 120;
pub const MCP_CALLS_PER_DAY: usize = 200;

/// Keys kept before stale ones are swept out.
const SWEEP_AT: usize = 10_000;

/// A sliding-window counter: at most `max` hits per key in any `window`. A refused hit isn't
/// counted, so hammering while refused doesn't push the wait back.
pub struct RateLimiter {
    /// What is counted, for the message: "sign-in attempts".
    what: &'static str,
    max: usize,
    window: Duration,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new(what: &'static str, max: usize, window: Duration) -> Self {
        Self { what, max, window, hits: Mutex::new(HashMap::new()) }
    }

    /// Count a hit for `key`, or refuse it with a 429 that says how long to wait.
    pub fn check(&self, key: &str) -> AppResult<()> {
        self.check_at(key, Instant::now(), true)
    }

    /// Count a hit for `key` that has already happened, whatever the count: for something
    /// checked with `allows` beforehand and counted only once it really happened.
    pub fn record(&self, key: &str) {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        hits.entry(key.to_string()).or_default().push_back(Instant::now());
    }

    /// Whether a hit for `key` would be allowed, without counting it: for checking several
    /// limits before counting any (`record` or `check` once all allow), so one refusal doesn't use up
    /// another's allowance.
    pub fn allows(&self, key: &str) -> AppResult<()> {
        self.check_at(key, Instant::now(), false)
    }

    /// Per-account limits leave admins out.
    pub fn check_user(&self, user: &User) -> AppResult<()> {
        if user.is_admin { Ok(()) } else { self.check(&user.id) }
    }

    fn check_at(&self, key: &str, now: Instant, count: bool) -> AppResult<()> {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() >= SWEEP_AT {
            let window = self.window;
            hits.retain(|_, q| q.back().is_some_and(|t| now.saturating_duration_since(*t) < window));
        }
        let q = hits.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now.saturating_duration_since(*t) >= self.window) {
            q.pop_front();
        }
        if q.len() >= self.max {
            let wait = self.window.saturating_sub(now.saturating_duration_since(q[0]));
            return Err(AppError::TooManyRequests {
                message: format!("Too many {}. Try again in {}.", self.what, wait_text(wait)),
                retry_after: wait.as_secs().max(1),
            });
        }
        if count {
            q.push_back(now);
        }
        Ok(())
    }
}

fn wait_text(wait: Duration) -> String {
    match wait.as_secs() {
        0..=59 => "under a minute".into(),
        60..=119 => "a minute".into(),
        s @ 120..=7199 => format!("{} minutes", s.div_ceil(60)),
        s => format!("{} hours", s.div_ceil(3600)),
    }
}

/// Every rate limit, shared by the whole server (`AppState::limits`). Per-account limits leave
/// admins out; they are set well above what a person at a screen does, so only scripts meet them.
pub struct Limits {
    /// Public precon reference reads, per client address (including signed-in visitors).
    pub public_precons: RateLimiter,
    /// Google and password sign-in, per client address.
    pub sign_in_address: RateLimiter,
    /// Google and password sign-in, per email (password guessing on one account).
    pub sign_in_email: RateLimiter,
    /// `/api/cards/search`, per account.
    pub search: RateLimiter,
    /// `/api/guest/cards/search`: commander lookups from the life counter without an account,
    /// per client address.
    pub guest_search: RateLimiter,
    /// New accounts through open sign-up, per client address: a person makes one, a script many.
    pub new_accounts_address: RateLimiter,
    /// New accounts through open sign-up from everywhere together, so a flood from many addresses
    /// still stops (invited people are never counted or refused).
    pub new_accounts: RateLimiter,
    /// Held while one sign-up checks both new-account limits, makes the account and counts it,
    /// so sign-ups arriving together can't all pass the checks before any is counted.
    pub new_account_gate: tokio::sync::Mutex<()>,
    /// `/api/cards/autocomplete`, per account (it runs while someone types).
    pub autocomplete: RateLimiter,
    /// Player searches by handle and their public decks (Log a game, New game), per account.
    pub people: RateLimiter,
    /// The 5 MB offline card bundle, per account.
    pub offline_cards: RateLimiter,
    /// Joining a playgroup or an online game by code, right or wrong, per account: a 6-letter
    /// code can't be found by guessing at this pace.
    pub join_codes: RateLimiter,
    /// New playgroups, guests, renames and new join codes, per account.
    pub playgroup_writes: RateLimiter,
    /// Changes to your own account's details (the name you go by), per account.
    pub profile_writes: RateLimiter,
    /// Mythic Tools CSV, collection and plan file imports, per account.
    pub imports: RateLimiter,
    /// Previews of a collection import (collection/import.rs), per account. The page previews
    /// again on each change and nothing is written, so this allows more than `imports`.
    pub collection_previews: RateLimiter,
    /// Collection changes (batches of ops, and making, renaming and deleting containers), per
    /// account. A scanning session sends a batch per card, so this allows one a second.
    pub collection_writes: RateLimiter,
    /// Scan photos kept for improving the scanner (scan_samples.rs), per account.
    pub scan_samples: RateLimiter,
    /// Mythic Tools bridge game previews and imports, per account (bridges/mythic). The page
    /// previews again on each change, so this allows more than `imports`.
    pub mythic_bridge: RateLimiter,
    /// New decks (pasted, from a precon or from a plan list), saved versions and list previews,
    /// per account (each save also queues a Commander Spellbook check).
    pub deck_writes: RateLimiter,
    /// Table and logged games saved through `POST /api/games`, per account. A phone running a
    /// game sends it again with each batch of taps, so this is set for a flood, not for play.
    pub game_saves: RateLimiter,
    /// Games new to Yama among those, per account (a phone back online may bring a night's worth).
    pub game_creates: RateLimiter,
    /// Copies of shared plans saved to an account ("Save a copy"), per account.
    pub research_copies: RateLimiter,
    /// New online games, per account (each one can start a rules engine thread).
    pub play_creates: RateLimiter,
    /// Questions to the advisor, per account (each one is a Claude request).
    pub advisor: RateLimiter,
    /// New watched all-AI games, per account (each one starts a rules engine thread).
    pub watch_creates: RateLimiter,
    /// OAuth app registrations (`oauth/`), per address: each one stores a client.
    pub oauth_register: RateLimiter,
    /// OAuth token and revocation requests, per address. claude.ai's come from Anthropic's few
    /// addresses, so this is set for a flood, not for one person.
    pub oauth_token: RateLimiter,
    /// Approving or denying an app on the consent page, per account (each yes stores a code).
    pub oauth_approve: RateLimiter,
    /// MPC Autofill image searches for a MakePlayingCards order (mpc.rs), per account.
    pub mpc_images: RateLimiter,
    /// Tool calls on `/mcp`, per account: an assistant at work makes a few dozen in a burst, a
    /// loop that never ends makes hundreds.
    pub mcp_calls: RateLimiter,
    /// Tool calls on `/mcp` in a day, for an account that joined through open sign-up
    /// (`User::limited`). Invited accounts and admins have no daily count.
    pub mcp_calls_daily: RateLimiter,
    /// Guest players made from one address in a day (`guests.rs`), counted once Turnstile passed.
    pub new_guests_address: RateLimiter,
    /// Guest players made on the whole server in an hour.
    pub new_guests: RateLimiter,
    /// Guest checks (Turnstile tokens sent to Cloudflare) from one address, passed or not.
    pub guest_checks_address: RateLimiter,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            public_precons: RateLimiter::new("public precon requests", 120, MINUTE),
            sign_in_address: RateLimiter::new("sign-in attempts from this address", SIGN_IN_ATTEMPTS, SIGN_IN_WINDOW),
            sign_in_email: RateLimiter::new("sign-in attempts for this email", SIGN_IN_ATTEMPTS, SIGN_IN_WINDOW),
            search: RateLimiter::new("card searches", 120, MINUTE),
            guest_search: RateLimiter::new("card searches from this address", 60, MINUTE),
            new_accounts_address: RateLimiter::new("new accounts from this address", NEW_ACCOUNTS_PER_ADDRESS, DAY),
            new_accounts: RateLimiter::new("new accounts on Yama just now", NEW_ACCOUNTS_PER_HOUR, 60 * MINUTE),
            new_account_gate: tokio::sync::Mutex::new(()),
            autocomplete: RateLimiter::new("card name lookups", 300, MINUTE),
            people: RateLimiter::new("player searches", 120, MINUTE),
            offline_cards: RateLimiter::new("offline card downloads", 10, 60 * MINUTE),
            join_codes: RateLimiter::new("join codes tried", 20, 10 * MINUTE),
            playgroup_writes: RateLimiter::new("playgroup changes", 60, 10 * MINUTE),
            profile_writes: RateLimiter::new("account changes", 30, 10 * MINUTE),
            imports: RateLimiter::new("imports", 60, 60 * MINUTE),
            collection_previews: RateLimiter::new("import previews", 200, 60 * MINUTE),
            collection_writes: RateLimiter::new("collection changes", 600, 10 * MINUTE),
            scan_samples: RateLimiter::new("scan photos", 600, 60 * MINUTE),
            mythic_bridge: RateLimiter::new("Mythic Tools imports", 200, 60 * MINUTE),
            deck_writes: RateLimiter::new("deck saves", 120, 10 * MINUTE),
            game_saves: RateLimiter::new("game saves", 1200, 10 * MINUTE),
            game_creates: RateLimiter::new("new games", 120, 10 * MINUTE),
            research_copies: RateLimiter::new("saved copies", 30, 10 * MINUTE),
            play_creates: RateLimiter::new("new online games", 30, 60 * MINUTE),
            advisor: RateLimiter::new("questions to Claude", 6, MINUTE),
            watch_creates: RateLimiter::new("new watched games", 30, 60 * MINUTE),
            oauth_register: RateLimiter::new("app registrations from this address", 30, 60 * MINUTE),
            oauth_token: RateLimiter::new("token requests from this address", 300, 10 * MINUTE),
            oauth_approve: RateLimiter::new("app sign-ins", 30, 10 * MINUTE),
            mpc_images: RateLimiter::new("print image searches", 30, 10 * MINUTE),
            mcp_calls: RateLimiter::new("tool calls", MCP_CALLS_PER_MINUTE, MINUTE),
            mcp_calls_daily: RateLimiter::new("tool calls today", MCP_CALLS_PER_DAY, DAY),
            new_guests_address: RateLimiter::new("guest games from this address today", 6, DAY),
            new_guests: RateLimiter::new("guest players on Yama just now", 60, 60 * MINUTE),
            guest_checks_address: RateLimiter::new("tries to start as a guest from this address", 20, 60 * MINUTE),
        }
    }
}

// ── client address ──────────────────────────────────────────────────────────

/// An address or a CIDR range, for YAMA_TRUSTED_PROXIES.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// `172.18.0.0/16`, `10.0.0.5` (a /32), `fd00::/8`.
    pub fn parse(s: &str) -> Result<Self, String> {
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let net: IpAddr = addr.trim().parse().map_err(|_| format!("{s:?} isn't an IP address or range"))?;
        let net = net.to_canonical();
        let max = if net.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(p) => p.trim().parse::<u8>().ok().filter(|p| *p <= max).ok_or_else(|| format!("{s:?} has a bad prefix length"))?,
            None => max,
        };
        Ok(Self { net, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.net, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = if self.prefix == 0 { 0 } else { u32::MAX << (32 - self.prefix) };
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = if self.prefix == 0 { 0 } else { u128::MAX << (128 - self.prefix) };
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

/// The client's address: the peer, or `CF-Connecting-IP` when the peer is a trusted proxy.
pub fn client_address(peer: Option<IpAddr>, cf_connecting_ip: Option<&str>, trusted: &[Cidr]) -> Option<IpAddr> {
    let peer = peer.map(|p| p.to_canonical());
    match (peer, cf_connecting_ip) {
        (Some(p), Some(header)) if trusted.iter().any(|c| c.contains(p)) => {
            header.trim().parse::<IpAddr>().ok().map(|ip| ip.to_canonical()).or(Some(p))
        }
        _ => peer,
    }
}

/// The key per-address limits count under: an IPv4 address, or an IPv6 address's /64.
pub fn address_key(ip: Option<IpAddr>) -> String {
    match ip {
        Some(IpAddr::V4(v4)) => v4.to_string(),
        Some(IpAddr::V6(v6)) => {
            let s = v6.segments();
            format!("{}/64", Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        None => "unknown".into(),
    }
}

static WARNED_UNTRUSTED: AtomicBool = AtomicBool::new(false);

/// Extractor: the client's address (see the module notes). `None` when the server wasn't started
/// with connection info, as in router tests.
pub struct ClientAddress(pub Option<IpAddr>);

impl FromRequestParts<AppState> for ClientAddress {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
        let header = parts.headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok());
        let trusted = &state.cfg.trusted_proxies;
        if let (Some(p), Some(_)) = (peer, header)
            && !trusted.iter().any(|c| c.contains(p))
            && !WARNED_UNTRUSTED.swap(true, Ordering::Relaxed)
        {
            tracing::warn!(
                peer = %p,
                "a request came with CF-Connecting-IP from a peer outside YAMA_TRUSTED_PROXIES, so the header is ignored and \
                 per-address limits count the peer. If this is the Cloudflare tunnel, add its network to YAMA_TRUSTED_PROXIES"
            );
        }
        Ok(Self(client_address(peer, header, trusted)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn a_limiter_allows_max_per_window_and_says_how_long_to_wait() {
        let l = RateLimiter::new("tries", 10, Duration::from_secs(600));
        let t0 = Instant::now();
        for i in 0..10 {
            l.check_at("a", t0 + Duration::from_secs(i), true).unwrap();
        }
        let Err(AppError::TooManyRequests { message, retry_after }) = l.check_at("a", t0 + Duration::from_secs(30), true) else { panic!("11th allowed") };
        assert_eq!(message, "Too many tries. Try again in 10 minutes.");
        assert_eq!(retry_after, 570);
        // Another key has its own count; refused hits weren't counted.
        l.check_at("b", t0 + Duration::from_secs(30), true).unwrap();
        // The oldest hit leaves the window at 600 s, which frees exactly one place.
        l.check_at("a", t0 + Duration::from_secs(600), true).unwrap();
        assert!(l.check_at("a", t0 + Duration::from_secs(600), true).is_err());
        l.check_at("a", t0 + Duration::from_secs(602), true).unwrap();
    }

    #[test]
    fn stale_keys_are_swept_once_there_are_many() {
        let l = RateLimiter::new("tries", 1, Duration::from_secs(1));
        let t0 = Instant::now();
        for i in 0..SWEEP_AT {
            l.check_at(&format!("k{i}"), t0, true).unwrap();
        }
        l.check_at("late", t0 + Duration::from_secs(2), true).unwrap();
        assert_eq!(l.hits.lock().unwrap().len(), 1);
    }

    #[test]
    fn ranges_parse_and_match() {
        let net = Cidr::parse("172.18.0.0/16").unwrap();
        assert!(net.contains(ip("172.18.4.2")));
        assert!(!net.contains(ip("172.19.0.1")));
        assert!(net.contains(ip("::ffff:172.18.0.9")), "IPv4-mapped IPv6 peers match IPv4 ranges");
        assert!(Cidr::parse("10.0.0.5").unwrap().contains(ip("10.0.0.5")));
        assert!(!Cidr::parse("10.0.0.5").unwrap().contains(ip("10.0.0.6")));
        assert!(Cidr::parse("fd00::/8").unwrap().contains(ip("fd12::1")));
        assert!(!Cidr::parse("fd00::/8").unwrap().contains(ip("10.0.0.1")));
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("8.8.8.8")));
        for bad in ["", "nope", "10.0.0.0/33", "10.0.0.0/x", "::/129"] {
            assert!(Cidr::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cf_connecting_ip_counts_only_from_a_trusted_proxy() {
        let tunnel = [Cidr::parse("172.18.0.0/16").unwrap()];
        let connector = Some(ip("172.18.0.7"));
        // Through the tunnel: the visitor's address.
        assert_eq!(client_address(connector, Some("203.0.113.9"), &tunnel), Some(ip("203.0.113.9")));
        // From the LAN, or any peer outside the list, the header is ignored.
        assert_eq!(client_address(Some(ip("192.0.2.17")), Some("203.0.113.9"), &tunnel), Some(ip("192.0.2.17")));
        // With no list nothing is trusted, so every tunnel visitor counts as the connector.
        assert_eq!(client_address(connector, Some("203.0.113.9"), &[]), connector);
        // A garbled header from the tunnel falls back to the peer; no header is the peer.
        assert_eq!(client_address(connector, Some("not an ip"), &tunnel), connector);
        assert_eq!(client_address(connector, None, &tunnel), connector);
        assert_eq!(client_address(None, Some("203.0.113.9"), &tunnel), None);
    }

    #[test]
    fn ipv6_addresses_count_by_their_64() {
        assert_eq!(address_key(Some(ip("2001:db8:1:2:aaaa::1"))), "2001:db8:1:2::/64");
        assert_eq!(address_key(Some(ip("2001:db8:1:2:bbbb::9"))), "2001:db8:1:2::/64");
        assert_eq!(address_key(Some(ip("203.0.113.9"))), "203.0.113.9");
        assert_eq!(address_key(None), "unknown");
    }

    /// Write routes that had no limit at all: saving a game and copying a shared plan.
    #[tokio::test]
    async fn game_saves_and_plan_copies_are_rate_limited_per_account() {
        use crate::testutil::{app, send, user};
        use axum::http::{Method, StatusCode};
        use serde_json::json;
        let (app, pool) = app().await;
        let (_, token) = user(&pool, "pat@example.com").await;
        let (_, other) = user(&pool, "sam@example.com").await;
        let game = |n: usize| json!({ "id": format!("6f1c2c43-6c1e-4d6c-9f55-{n:012}"), "seats": [{ "seat": 0, "guest_name": "Pat" }, { "seat": 1, "guest_name": "Sam" }] });

        // A game sent again (as a phone does with every batch of taps) isn't a new game.
        for _ in 0..150 {
            let (status, body) = send(&app, Method::POST, "/api/games", Some(&token), Some(game(0))).await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
        // New games stop at the limit; the game already there still saves, and so does
        // another account's.
        let mut made = 1;
        loop {
            let (status, _) = send(&app, Method::POST, "/api/games", Some(&token), Some(game(made))).await;
            if status == StatusCode::TOO_MANY_REQUESTS {
                break;
            }
            assert_eq!(status, StatusCode::OK);
            made += 1;
            assert!(made < 1_000, "new games were never limited");
        }
        assert_eq!(made, 120);
        let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games").fetch_one(&pool).await.unwrap();
        assert_eq!(games, 120);
        assert_eq!(send(&app, Method::POST, "/api/games", Some(&token), Some(game(0))).await.0, StatusCode::OK);
        assert_eq!(send(&app, Method::POST, "/api/games", Some(&other), Some(game(5_000))).await.0, StatusCode::OK);

        // Copying a shared plan: tried 30 times in ten minutes, right or wrong.
        async fn copy(app: &axum::Router, token: &str) -> StatusCode {
            send(app, Method::POST, "/api/research/copy", Some(token), Some(json!({ "token": "0123456789abcdef0123" }))).await.0
        }
        for _ in 0..30 {
            assert_eq!(copy(&app, &token).await, StatusCode::NOT_FOUND);
        }
        assert_eq!(copy(&app, &token).await, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(copy(&app, &other).await, StatusCode::NOT_FOUND);
    }

    #[test]
    fn allows_checks_without_counting() {
        let l = RateLimiter::new("tries", 1, Duration::from_secs(60));
        let t0 = Instant::now();
        // Asking any number of times uses nothing up.
        for _ in 0..5 {
            l.check_at("a", t0, false).unwrap();
        }
        l.check_at("a", t0, true).unwrap();
        assert!(l.check_at("a", t0, false).is_err());
    }
}
