use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not signed in")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    /// 410: it was deleted on purpose and won't come back (a table game its recorder deleted).
    #[error("{0} was deleted")]
    Gone(&'static str),
    /// 400 with extra fields beside `error`, e.g. the names a list couldn't resolve.
    #[error("{message}")]
    Invalid { message: String, details: serde_json::Value },
    /// 503: the server can't do this right now (a missing or still-loading resource, or an
    /// outside service Yama needs for this request didn't answer).
    #[error("{0}")]
    Unavailable(String),
    /// 429 with `Retry-After`: a rate limit (`limits.rs`).
    #[error("{message}")]
    TooManyRequests { message: String, retry_after: u64 },
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::BadRequest(_) | Self::Invalid { .. } => StatusCode::BAD_REQUEST,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Gone(_) => StatusCode::GONE,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::Db(sqlx::Error::RowNotFound) => StatusCode::NOT_FOUND,
            Self::Db(_) | Self::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        // Unexpected failures stay vague; a 503 says what's missing, which is the point of it.
        let message = if status.is_server_error() && !matches!(self, Self::Unavailable(_)) {
            tracing::error!(error = ?self, "request failed");
            "internal error".to_string()
        } else {
            self.to_string()
        };
        let mut body = json!({ "error": message });
        if let (Self::Invalid { details: serde_json::Value::Object(extra), .. }, Some(out)) = (&self, body.as_object_mut()) {
            for (k, v) in extra {
                if k != "error" {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        let mut res = (status, Json(body)).into_response();
        if let Self::TooManyRequests { retry_after, .. } = &self {
            res.headers_mut().insert(axum::http::header::RETRY_AFTER, axum::http::HeaderValue::from(*retry_after));
        }
        res
    }
}
