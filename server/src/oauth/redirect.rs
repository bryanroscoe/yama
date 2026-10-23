//! Which redirect URIs an OAuth app may register, and whether an authorization request's
//! redirect URI is one it registered.
//!
//! A code goes wherever the redirect URI says, so an app that could register any https address
//! could phish a Yama grant: send someone a sign-in link, and collect their code on its own site.
//! Only two kinds are accepted:
//! - **Loopback** `http://localhost`, `http://127.0.0.1` or `http://[::1]`, any port and path: a
//!   native app on the person's own computer (Claude Code listens on a random port). RFC 8252 7.3
//!   says to ignore the port when matching, and Claude Code's docs ask for the same with
//!   `localhost`, which one version swapped for `127.0.0.1`, so the three loopback hosts also
//!   match each other. The consent page says plainly that such an app runs on this computer.
//! - **https on an allowlisted host** (YAMA_OAUTH_REDIRECT_HOSTS; claude.ai and claude.com by
//!   default), matched exactly: claude.ai's connector callback, `https://claude.ai/api/mcp/auth_callback`.
//!
//! Everything else is refused: other https hosts, plain http anywhere but loopback, custom schemes,
//! fragments (RFC 6749 3.1.2) and URIs with a user name or password.

use url::{Host, Url};

/// Longest redirect URI accepted.
const MAX_LEN: usize = 2000;

fn is_loopback(u: &Url) -> bool {
    u.scheme() == "http"
        && match u.host() {
            Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            None => false,
        }
}

/// Whether an app may register `uri`; `Err` says why not, for the registration error.
pub fn check_registration(uri: &str, https_hosts: &[String]) -> Result<(), String> {
    if uri.len() > MAX_LEN {
        return Err("a redirect URI is too long".into());
    }
    let u = Url::parse(uri).map_err(|_| format!("{uri:?} isn't an absolute URI"))?;
    if u.fragment().is_some() {
        return Err(format!("{uri}: a redirect URI can't have a fragment"));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(format!("{uri}: a redirect URI can't carry a user name or password"));
    }
    if is_loopback(&u) {
        return Ok(());
    }
    if u.scheme() == "https"
        && u.port().is_none()
        && let Some(Host::Domain(host)) = u.host()
        && https_hosts.iter().any(|h| h.eq_ignore_ascii_case(host))
    {
        return Ok(());
    }
    Err(format!(
        "{uri}: Yama sends codes only to a program on this computer (http://localhost, http://127.0.0.1 or http://[::1]) or to https on {}",
        if https_hosts.is_empty() { "no other host".to_string() } else { https_hosts.join(" or ") }
    ))
}

/// Whether the authorization request's `requested` redirect URI is the `registered` one: the same
/// string, or for loopback the same scheme, path and query on any loopback host and port.
pub fn matches(registered: &str, requested: &str) -> bool {
    if registered == requested {
        return true;
    }
    let (Ok(a), Ok(b)) = (Url::parse(registered), Url::parse(requested)) else { return false };
    is_loopback(&a)
        && is_loopback(&b)
        && a.path() == b.path()
        && a.query() == b.query()
        && b.fragment().is_none()
        && b.username().is_empty()
        && b.password().is_none()
}

/// What the consent page and Connected apps show for where codes go: the host, and whether it's
/// a program on this computer.
pub fn describe(uri: &str) -> (String, bool) {
    match Url::parse(uri) {
        Ok(u) if is_loopback(&u) => (u.host_str().unwrap_or("localhost").to_string(), true),
        Ok(u) => (u.host_str().unwrap_or_default().to_string(), false),
        Err(_) => (String::new(), false),
    }
}

/// An RFC 8707 resource in canonical form, for comparing: lower-case scheme and host (the URL
/// parser does that), no default port, no fragment, no trailing slash. Claude sends the canonical
/// form of the URL the person typed.
pub fn canonical_resource(raw: &str) -> Option<String> {
    let mut u = Url::parse(raw.trim()).ok()?;
    if u.fragment().is_some() || u.cannot_be_a_base() {
        return None;
    }
    u.set_fragment(None);
    let s = u.as_str();
    Some(s.strip_suffix('/').unwrap_or(s).to_string())
}

/// `uri` with `params` added to its query (an existing query is kept).
pub fn with_params(uri: &str, params: &[(&str, &str)]) -> Option<String> {
    let mut u = Url::parse(uri).ok()?;
    {
        let mut q = u.query_pairs_mut();
        for (k, v) in params {
            q.append_pair(k, v);
        }
    }
    Some(u.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        vec!["claude.ai".into(), "claude.com".into()]
    }

    #[test]
    fn loopback_on_any_port_and_allowlisted_https_register() {
        for ok in [
            "http://localhost:3118/callback",
            "http://localhost/callback",
            "http://127.0.0.1:54321/callback",
            "http://[::1]:8080/cb",
            "http://LOCALHOST:9/x",
            "https://claude.ai/api/mcp/auth_callback",
            "https://claude.com/api/mcp/auth_callback",
            "https://CLAUDE.ai/api/mcp/auth_callback",
        ] {
            assert_eq!(check_registration(ok, &hosts()), Ok(()), "{ok}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for bad in [
            "https://evil.com/callback",
            "https://claude.ai.evil.com/api/mcp/auth_callback",
            "https://evil.claude.ai/cb",
            "https://claude.ai:8443/api/mcp/auth_callback",
            "http://claude.ai/api/mcp/auth_callback",
            "http://evil.com/callback",
            "http://192.168.1.5:8080/callback",
            "http://127.0.0.2/callback",
            "http://localhost.evil.com/callback",
            "https://localhost/callback",
            "cursor://anysphere.cursor-retrieval/oauth/callback",
            "javascript:alert(1)",
            "http://localhost:3000/callback#frag",
            "http://user:pass@localhost:3000/callback",
            "https://user@claude.ai/api/mcp/auth_callback",
            "/callback",
            "",
        ] {
            assert!(check_registration(bad, &hosts()).is_err(), "{bad}");
        }
        // With no https hosts allowed, only loopback is left.
        assert!(check_registration("https://claude.ai/api/mcp/auth_callback", &[]).is_err());
        assert!(check_registration("http://localhost:1/cb", &[]).is_ok());
    }

    #[test]
    fn loopback_matches_on_any_port_and_loopback_host_but_nothing_else_moves() {
        let reg = "http://localhost:3118/callback";
        assert!(matches(reg, reg));
        assert!(matches(reg, "http://localhost:40000/callback"));
        assert!(matches(reg, "http://127.0.0.1:40000/callback"));
        assert!(matches(reg, "http://[::1]:40000/callback"));
        assert!(!matches(reg, "http://localhost:40000/other"));
        assert!(!matches(reg, "http://localhost:40000/callback?x=1"));
        assert!(!matches(reg, "https://localhost:40000/callback"));
        assert!(!matches(reg, "http://evil.com:3118/callback"));
        assert!(!matches(reg, "http://localhost:3118/callback#x"));
        // https is exact.
        let claude = "https://claude.ai/api/mcp/auth_callback";
        assert!(matches(claude, claude));
        assert!(!matches(claude, "https://claude.ai/api/mcp/auth_callback/"));
        assert!(!matches(claude, "https://claude.com/api/mcp/auth_callback"));
    }

    #[test]
    fn resources_compare_in_canonical_form() {
        let ours = "https://yama.saget.org/mcp";
        for same in ["https://yama.saget.org/mcp", "https://YAMA.saget.org/mcp", "https://yama.saget.org:443/mcp", "https://yama.saget.org/mcp/", "HTTPS://yama.saget.org/mcp"] {
            assert_eq!(canonical_resource(same).as_deref(), Some(ours), "{same}");
        }
        for other in ["https://yama.saget.org/", "https://yama.saget.org/mcp2", "http://yama.saget.org/mcp", "https://evil.com/mcp"] {
            assert_ne!(canonical_resource(other).as_deref(), Some(ours), "{other}");
        }
        assert_eq!(canonical_resource("https://yama.saget.org/mcp#x"), None);
    }

    #[test]
    fn params_are_added_to_an_existing_query() {
        assert_eq!(
            with_params("http://localhost:1/cb?a=1", &[("code", "x y"), ("state", "s&t")]).unwrap(),
            "http://localhost:1/cb?a=1&code=x+y&state=s%26t"
        );
        assert_eq!(describe("http://127.0.0.1:5/cb"), ("127.0.0.1".into(), true));
        assert_eq!(describe("https://claude.ai/api/mcp/auth_callback"), ("claude.ai".into(), false));
    }
}
