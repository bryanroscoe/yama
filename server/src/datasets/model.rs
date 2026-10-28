use crate::error::{AppError, AppResult};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const SCHEMA: &str = "yama-dataset/1";
pub const MAX_BYTES: usize = 128 << 20;
pub const MAX_UPLOAD: usize = 32 << 20;
pub const MAX_RECORD_BYTES: usize = 2 << 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub schema: String,
    pub id: String,
    pub title: String,
    pub generated_at: DateTime<Utc>,
    pub source: Source,
    pub method: String,
    pub coverage: Value,
    pub sources: Vec<SourceDocument>,
    pub records: Vec<Record>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub name: String,
    pub url: Option<String>,
    pub attribution: String,
    pub license: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct SourceDocument {
    pub sha256: String,
    pub url: Option<String>,
    pub retrieved_at: Option<DateTime<Utc>>,
    pub source_as_of: Option<DateTime<Utc>>,
    pub captured_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub flags: Vec<String>,
    pub transformation: Option<String>,
    pub original_response_sha256: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Performance,
    WeeklyActivity,
    Commander,
    CommanderHistory,
    Archetype,
    SourceTable,
}
impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Performance => "performance",
            Self::WeeklyActivity => "weekly_activity",
            Self::Commander => "commander",
            Self::CommanderHistory => "commander_history",
            Self::Archetype => "archetype",
            Self::SourceTable => "source_table",
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub kind: Kind,
    pub entity: String,
    pub sources: Vec<String>,
    pub data: Value,
}
impl Record {
    pub fn label(&self) -> &str {
        self.data
            .get("entity_name")
            .or_else(|| self.data.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&self.entity)
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeriodKind {
    CalendarMonth,
    RollingWindow,
    CumulativeSnapshot,
    Unknown,
}

#[derive(Deserialize)]
pub struct Period {
    pub kind: PeriodKind,
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
    pub lookback_days: Option<u32>,
    pub source_as_of: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct Observation {
    pub entity_id: String,
    pub entity_kind: String,
    pub metric: String,
    pub value: f64,
    pub source_reported_games: u64,
    pub cohort: String,
    pub observation_period: Period,
    #[serde(default)]
    pub quality_flags: Vec<String>,
}

fn text(s: &str, max: usize, field: &str) -> AppResult<()> {
    if s.trim().is_empty() || s.len() > max || s.chars().any(|c| c.is_control()) {
        return Err(AppError::bad(format!(
            "{field} must contain 1–{max} bytes of text without control characters"
        )));
    }
    Ok(())
}
pub fn key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:./".contains(&c))
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn source_url(s: Option<&str>) -> AppResult<()> {
    if let Some(s) = s {
        let u = url::Url::parse(s).map_err(|_| AppError::bad("source URL is invalid"))?;
        if s.len() > 2048
            || !matches!(u.scheme(), "https" | "http")
            || u.host_str().is_none()
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err(AppError::bad(
                "source URLs must be HTTP(S) URLs without credentials",
            ));
        }
    }
    Ok(())
}

impl Document {
    pub fn validate(&self) -> AppResult<BTreeMap<String, usize>> {
        if self.schema != SCHEMA {
            return Err(AppError::bad("expected yama-dataset/1"));
        }
        if !key(&self.id)
            || self.id.contains('/')
            || matches!(self.id.as_str(), "." | ".." | "import")
        {
            return Err(AppError::bad("invalid dataset id"));
        }
        text(&self.title, 240, "title")?;
        text(&self.method, 4000, "method")?;
        text(&self.source.name, 240, "source name")?;
        text(&self.source.attribution, 4000, "attribution")?;
        text(&self.source.license, 1000, "license")?;
        source_url(self.source.url.as_deref())?;
        if !self.coverage.is_object()
            || serde_json::to_vec(&self.coverage)
                .map_err(anyhow::Error::from)?
                .len()
                > 65536
        {
            return Err(AppError::bad(
                "coverage must be an object of at most 64 KiB",
            ));
        }
        if self.records.len() > 200_000 || self.sources.len() > 10_000 {
            return Err(AppError::bad(
                "dataset exceeds 200,000 records or 10,000 source documents",
            ));
        }
        let mut sources = HashSet::new();
        for s in &self.sources {
            if !hash(&s.sha256) || !sources.insert(s.sha256.as_str()) {
                return Err(AppError::bad(
                    "source hashes must be distinct lowercase SHA-256 values",
                ));
            }
            source_url(s.url.as_deref())?;
            if s.original_response_sha256
                .as_deref()
                .is_some_and(|h| !hash(h))
            {
                return Err(AppError::bad("invalid original response hash"));
            }
            if s.captured_at
                .zip(s.source_as_of)
                .is_some_and(|(capture, as_of)| as_of > capture)
            {
                return Err(AppError::bad(
                    "source update date is later than its archived capture",
                ));
            }
            if s.flags.len() > 20
                || s.flags.iter().any(|s| s.len() > 1000)
                || s.transformation.as_ref().is_some_and(|s| s.len() > 4000)
            {
                return Err(AppError::bad("source annotations are too long"));
            }
        }
        let mut ids = HashSet::new();
        let mut counts = BTreeMap::new();
        for record in &self.records {
            if !key(&record.id) || !key(&record.entity) || !ids.insert(&record.id) {
                return Err(AppError::bad(
                    "record ids must be distinct; record/entity keys must be 1–160 ASCII identifier bytes",
                ));
            }
            if record.sources.is_empty()
                || record.sources.len() > 32
                || record.sources.iter().any(|s| !sources.contains(s.as_str()))
            {
                return Err(AppError::bad(format!(
                    "record {} has missing or unknown source references",
                    record.id
                )));
            }
            if !record.data.is_object()
                || serde_json::to_vec(&record.data)
                    .map_err(anyhow::Error::from)?
                    .len()
                    > MAX_RECORD_BYTES
            {
                return Err(AppError::bad(
                    "each record's data must be an object of at most 2 MiB",
                ));
            }
            if record.kind == Kind::Performance {
                let o: Observation = serde_json::from_value(record.data.clone())
                    .map_err(|e| AppError::bad(format!("invalid performance record: {e}")))?;
                if o.entity_id != record.entity
                    || !matches!(o.entity_kind.as_str(), "commander" | "precon")
                    || o.metric != "source_reported_normalized_4p_win_rate_percent"
                    || !o.value.is_finite()
                    || !(0.0..=100.0).contains(&o.value)
                    || o.source_reported_games > 1_000_000_000
                    || o.quality_flags.len() > 20
                    || o.quality_flags.iter().any(|s| s.len() > 1000)
                {
                    return Err(AppError::bad(
                        "performance identity, metric, rate or sample size is invalid",
                    ));
                }
                text(&o.cohort, 2048, "cohort")?;
                match o.observation_period.kind {
                    PeriodKind::CalendarMonth => {
                        let p = &o.observation_period;
                        let valid = p.start.zip(p.end).is_some_and(|(start, end)| {
                            start.day() == 1
                                && start.year() == end.year()
                                && start.month() == end.month()
                                && end.succ_opt().is_some_and(|d| d.day() == 1)
                        });
                        if !valid || p.lookback_days.is_some() {
                            return Err(AppError::bad(
                                "calendar-month observations need an exact complete month",
                            ));
                        }
                    }
                    PeriodKind::RollingWindow => {
                        if !o
                            .observation_period
                            .lookback_days
                            .is_some_and(|d| (1..=3650).contains(&d))
                            || o.observation_period.source_as_of.is_none()
                        {
                            return Err(AppError::bad(
                                "rolling windows need a 1–3650 day window and its source date",
                            ));
                        }
                    }
                    PeriodKind::CumulativeSnapshot | PeriodKind::Unknown => {}
                }
            }
            if record.kind == Kind::WeeklyActivity {
                let week = record
                    .data
                    .get("week")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<NaiveDate>().ok());
                if record.data.get("entity_id").and_then(Value::as_str)
                    != Some(record.entity.as_str())
                    || week.is_none()
                    || !record
                        .data
                        .get("value")
                        .and_then(Value::as_u64)
                        .is_some_and(|v| v <= 1_000_000_000)
                    || record.data.get("metric").and_then(Value::as_str)
                        != Some("source_reported_weekly_activity")
                {
                    return Err(AppError::bad(
                        "weekly activity needs its matching entity, valid week, metric and nonnegative count",
                    ));
                }
            }
            *counts.entry(record.kind.as_str().to_string()).or_insert(0) += 1;
        }
        Ok(counts)
    }
}
