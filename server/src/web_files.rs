//! The built web app's files, cached as the web build expects (web PR #110; ARCHITECTURE.md,
//! "Faster first load, caching and cache busting").
//!
//! - `/assets/*` and `/ocr/<version>/*` are content-addressed: kept for a year, never revalidated.
//! - Everything else (the shell, `sw.js`, the manifest, icons, the fixed-name public files and
//!   pages) is `no-cache`: kept, but checked with its ETag or Last-Modified before each use.
//! - Only an address with no file extension is an app route that falls back to `index.html`. A
//!   missing file (any extension, and anything under `/assets/` or `/ocr/`) is a 404 that nothing
//!   keeps, so a build file missing after a release is never answered with the shell.
//! - The build writes `.br` and `.gz` beside each compressible file; they're served as they are,
//!   by `Accept-Encoding`, instead of compressing on every request.
//!
//! These files sit outside the API's layers: no CORS (its `Vary: Origin` stopped the service
//! worker's saved files matching) and no response compression.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use std::convert::Infallible;
use std::path::Path;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

/// Content-addressed files: a new build gets new names.
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Fixed names: kept, but revalidated each time.
pub const REVALIDATE: &str = "no-cache";
/// A missing file: nobody keeps the answer.
pub const NO_STORE: &str = "no-store";

#[derive(Clone)]
pub struct WebFiles {
    files: ServeDir,
    index: ServeFile,
}

/// What an address is, by its path alone.
#[derive(Debug, PartialEq, Eq)]
enum Kind {
    /// Under `/assets/` or `/ocr/`.
    Hashed,
    /// No extension on its last segment: an app route or a directory page.
    Route,
    /// Any other file.
    File,
}

fn kind(path: &str) -> Kind {
    if path.starts_with("/assets/") || path.starts_with("/ocr/") {
        return Kind::Hashed;
    }
    let last = path.rsplit('/').next().unwrap_or_default();
    if last.contains('.') { Kind::File } else { Kind::Route }
}

fn with_cache(mut res: Response, value: &'static str) -> Response {
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    res
}

fn missing() -> Response {
    with_cache((StatusCode::NOT_FOUND, "Not found").into_response(), NO_STORE)
}

impl WebFiles {
    pub fn new(dist: &Path) -> Self {
        Self {
            files: ServeDir::new(dist).precompressed_br().precompressed_gzip(),
            index: ServeFile::new(dist.join("index.html")).precompressed_br().precompressed_gzip(),
        }
    }

    pub async fn serve(self, req: Request) -> Result<Response, Infallible> {
        let kind = kind(req.uri().path());
        // For the shell, if this turns out to be an app route: the same conditional and
        // encoding headers.
        let (method, headers) = (req.method().clone(), req.headers().clone());
        let res = self.files.oneshot(req).await?.map(Body::new);
        if res.status() != StatusCode::NOT_FOUND {
            let cache = if kind == Kind::Hashed && res.status().is_success() { IMMUTABLE } else { REVALIDATE };
            return Ok(with_cache(res, cache));
        }
        if kind != Kind::Route || !(method == Method::GET || method == Method::HEAD) {
            return Ok(missing());
        }
        let mut shell = Request::builder().method(method).uri("/index.html").body(Body::empty()).expect("shell request");
        *shell.headers_mut() = headers;
        let res = self.index.oneshot(shell).await?.map(Body::new);
        Ok(if res.status() == StatusCode::NOT_FOUND { missing() } else { with_cache(res, REVALIDATE) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dist() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join("assets")).unwrap();
        std::fs::create_dir_all(p.join("ocr/abc123")).unwrap();
        std::fs::create_dir_all(p.join("about")).unwrap();
        std::fs::write(p.join("index.html"), "<!doctype html><title>Yama</title>").unwrap();
        std::fs::write(p.join("index.html.br"), b"brotli shell").unwrap();
        std::fs::write(p.join("assets/app-1a2b.js"), "console.log('app')").unwrap();
        std::fs::write(p.join("assets/app-1a2b.js.gz"), b"gzip app").unwrap();
        std::fs::write(p.join("ocr/abc123/worker.js"), "ocr").unwrap();
        std::fs::write(p.join("sw.js"), "self.x = 1").unwrap();
        std::fs::write(p.join("about/index.html"), "about").unwrap();
        dir
    }

    async fn get(files: &WebFiles, path: &str, headers: &[(header::HeaderName, &str)]) -> Response {
        let mut req = Request::builder().uri(path).body(Body::empty()).unwrap();
        for (k, v) in headers {
            req.headers_mut().insert(k.clone(), HeaderValue::from_str(v).unwrap());
        }
        files.clone().serve(req).await.unwrap()
    }

    fn cache(res: &Response) -> &str {
        res.headers().get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap()).unwrap_or("")
    }

    async fn text(res: Response) -> String {
        String::from_utf8(axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    #[test]
    fn addresses_are_sorted_by_path_alone() {
        assert_eq!(kind("/assets/app-1a2b.js"), Kind::Hashed);
        assert_eq!(kind("/ocr/abc/x.wasm"), Kind::Hashed);
        assert_eq!(kind("/decks/123"), Kind::Route);
        assert_eq!(kind("/"), Kind::Route);
        assert_eq!(kind("/about/"), Kind::Route);
        assert_eq!(kind("/sw.js"), Kind::File);
        assert_eq!(kind("/precon-fonts/a.woff2"), Kind::File);
    }

    #[tokio::test]
    async fn build_files_are_kept_a_year_and_missing_ones_are_never_the_shell() {
        let dir = dist();
        let files = WebFiles::new(dir.path());
        let res = get(&files, "/assets/app-1a2b.js", &[]).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(cache(&res), IMMUTABLE);
        assert!(res.headers().get(header::ETAG).is_some() || res.headers().get(header::LAST_MODIFIED).is_some());
        assert_eq!(cache(&get(&files, "/ocr/abc123/worker.js", &[]).await), IMMUTABLE);
        for path in ["/assets/gone-9z9z.js", "/ocr/old/worker.js", "/assets/gone"] {
            let res = get(&files, path, &[]).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
            assert_eq!(cache(&res), NO_STORE, "{path}");
            assert!(!text(res).await.contains("<title>"), "{path} answered with the shell");
        }
    }

    #[tokio::test]
    async fn precompressed_files_go_by_accept_encoding() {
        let dir = dist();
        let files = WebFiles::new(dir.path());
        let res = get(&files, "/assets/app-1a2b.js", &[(header::ACCEPT_ENCODING, "gzip, br")]).await;
        assert_eq!(res.headers().get(header::CONTENT_ENCODING).unwrap(), "gzip");
        assert_eq!(res.headers().get(header::VARY).unwrap(), "accept-encoding");
        assert_eq!(text(res).await, "gzip app");
        let res = get(&files, "/assets/app-1a2b.js", &[]).await;
        assert!(res.headers().get(header::CONTENT_ENCODING).is_none());
        assert_eq!(text(res).await, "console.log('app')");
    }

    #[tokio::test]
    async fn routes_get_the_shell_and_other_files_are_revalidated() {
        let dir = dist();
        let files = WebFiles::new(dir.path());
        for path in ["/", "/decks/123", "/cards"] {
            let res = get(&files, path, &[(header::ACCEPT_ENCODING, "br")]).await;
            assert_eq!(res.status(), StatusCode::OK, "{path}");
            assert_eq!(cache(&res), REVALIDATE, "{path}");
            assert_eq!(res.headers().get(header::CONTENT_ENCODING).unwrap(), "br", "{path}");
        }
        // The shell answers a conditional request with 304.
        let res = get(&files, "/decks/123", &[]).await;
        let etag = res.headers().get(header::ETAG).unwrap().to_str().unwrap().to_string();
        let again = get(&files, "/decks/123", &[(header::IF_NONE_MATCH, &etag)]).await;
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
        let res = get(&files, "/sw.js", &[]).await;
        assert_eq!((res.status(), cache(&res)), (StatusCode::OK, REVALIDATE));
        assert_eq!(text(get(&files, "/about/", &[]).await).await, "about");
        let res = get(&files, "/missing.png", &[]).await;
        assert_eq!((res.status(), cache(&res)), (StatusCode::NOT_FOUND, NO_STORE));
    }
}
