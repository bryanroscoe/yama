//! Who plays a seat in a lab game: one of phase's heuristic AI levels, or a language model.
//!
//! A schedule line may name a pilot per seat (`"pilots": ["easy", "hard", "llm:claude-haiku-5-5",
//! "medium"]`). Without it every seat plays at the line's `difficulty`, as before.
//!
//! An LLM seat uses phase's own `phase-llm` crate: it renders the seat's view of the position
//! and the engine-issued options into a prompt, and binds the model's reply back to one of those
//! options (an index, re-checked against the decision's fingerprint). The model never authors an
//! action. Anything that goes wrong (a forced move, a timeout, an unreadable reply) falls back to
//! the heuristic AI at the line's `difficulty` for that one decision, and is counted.
//!
//! The transport is a trait so the server never needs one and tests can fake it.
//! [`ClaudeCli`] runs the Claude Code CLI already signed in on this machine (`claude -p`), with
//! no tools, no MCP servers, no settings files and no API key in its environment, from an empty
//! directory.

use std::io::{Read as _, Write as _};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use phase_ai::config::{ACCEPTED_DIFFICULTY_LABELS, AiDifficulty};
use serde::{Deserialize, Serialize};

/// The persona an LLM seat is briefed with when its label doesn't name one (phase-llm's
/// difficulty brief: "a strong competitive player", 2 turn cycles of history, 400 characters of
/// Oracle text per card).
pub const DEFAULT_LLM_PERSONA: AiDifficulty = AiDifficulty::Hard;

#[derive(Debug, Clone, PartialEq)]
pub enum Pilot {
    Heuristic(AiDifficulty),
    Llm(LlmPilot),
}

#[derive(Debug, Clone, PartialEq)]
pub struct LlmPilot {
    /// Model id passed to the transport, e.g. "claude-haiku-5-5".
    pub model: String,
    /// The phase-llm difficulty brief the model plays under.
    pub persona: AiDifficulty,
}

impl Pilot {
    /// "easy", "Medium", ... (phase's labels, any case), or "llm:<model>" / "llm:<model>:<persona>".
    pub fn parse(label: &str) -> Result<Pilot, String> {
        let label = label.trim();
        if let Some(rest) = label.strip_prefix("llm:") {
            let (model, persona) = match rest.split_once(':') {
                Some((m, p)) => (m, Some(p)),
                None => (rest, None),
            };
            let ok_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_');
            if model.is_empty() || model.len() > 64 || model.starts_with('-') || !model.chars().all(ok_char) {
                return Err(format!("pilot {label:?}: the model id must be 1-64 letters, digits, '-', '.' or '_', not starting with '-'"));
            }
            let persona = match persona {
                None => DEFAULT_LLM_PERSONA,
                Some(p) => heuristic_level(p).ok_or_else(|| format!("pilot {label:?}: unknown persona {p:?} (accepted: {})", ACCEPTED_DIFFICULTY_LABELS.join(", ")))?,
            };
            return Ok(Pilot::Llm(LlmPilot { model: model.to_string(), persona }));
        }
        heuristic_level(label)
            .map(Pilot::Heuristic)
            .ok_or_else(|| format!("unknown pilot {label:?} (accepted: {}, or llm:<model>[:<persona>])", ACCEPTED_DIFFICULTY_LABELS.join(", ")))
    }

    pub fn is_llm(&self) -> bool {
        matches!(self, Pilot::Llm(_))
    }
}

fn heuristic_level(label: &str) -> Option<AiDifficulty> {
    let label = label.trim();
    ACCEPTED_DIFFICULTY_LABELS.iter().any(|l| l.eq_ignore_ascii_case(label)).then(|| AiDifficulty::from_label(label))
}

// ---------------------------------------------------------------------------------------------
// Transport

/// One completion request: a system prompt and a user message, both from phase-llm.
pub struct LlmRequest<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlmText {
    pub text: String,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
}

/// Why a request produced no text. All of them make the seat fall back for that decision.
#[derive(Debug, Clone, PartialEq)]
pub enum LlmFailure {
    Timeout,
    /// The CLI couldn't start, exited badly, or printed something that isn't its JSON result.
    Transport(String),
    /// The model service answered with an error (rate or usage limit, overload, refusal...).
    Service(String),
}

impl LlmFailure {
    pub fn kind(&self) -> &'static str {
        match self {
            LlmFailure::Timeout => "timeout",
            LlmFailure::Transport(_) => "transport",
            LlmFailure::Service(_) => "service",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            LlmFailure::Timeout => "no reply within the time limit".into(),
            LlmFailure::Transport(d) | LlmFailure::Service(d) => d.clone(),
        }
    }
}

pub trait LlmTransport: Send + Sync {
    fn complete(&self, req: &LlmRequest) -> Result<LlmText, LlmFailure>;
}

/// The Claude Code CLI on this machine, with whatever login it has (a Claude subscription on
/// Bryan's Mac). Each request is one `claude -p` run: no tools, no MCP servers, no settings
/// files, no slash commands, no saved session, run from an empty directory, with the API-key
/// and provider variables removed from its environment so it can only use the login. Never
/// `--bare`, which ignores the login.
pub struct ClaudeCli {
    pub exe: PathBuf,
    pub timeout: Duration,
    /// "low" / "medium" / ...; `None` leaves the model's default.
    pub effort: Option<String>,
    /// An empty directory the CLI runs in, so no project CLAUDE.md or settings apply.
    pub workdir: PathBuf,
    /// Let the CLI cache prompts. Off by default: almost every decision's prompt is new (the board
    /// and history change), so cache writes cost more than they save; off, the CLI gets
    /// DISABLE_PROMPT_CACHING=1 and input is read once at the plain rate.
    pub prompt_cache: bool,
    slots: Mutex<usize>,
    freed: Condvar,
}

/// Environment variables removed from the CLI's environment: anything that would make it bill an
/// API key or reach another provider instead of using the machine's login.
const STRIPPED_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CONFIG_DIR_OVERRIDE",
];

impl ClaudeCli {
    /// `concurrency` is how many CLI runs may be in flight at once across all games.
    pub fn new(exe: PathBuf, timeout: Duration, effort: Option<String>, concurrency: usize) -> std::io::Result<Self> {
        let workdir = std::env::temp_dir().join(format!("yama-lab-llm-{}", std::process::id()));
        std::fs::create_dir_all(&workdir)?;
        Ok(ClaudeCli { exe, timeout, effort, workdir, prompt_cache: false, slots: Mutex::new(concurrency.max(1)), freed: Condvar::new() })
    }

    /// The arguments for one request (the user message goes on stdin).
    pub fn args(&self, req: &LlmRequest) -> Vec<String> {
        let mut a: Vec<String> = [
            "-p",
            "--model",
            req.model,
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--system-prompt",
            req.system,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if let Some(e) = &self.effort {
            a.push("--effort".into());
            a.push(e.clone());
        }
        a
    }

    fn acquire(&self) {
        let mut free = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        while *free == 0 {
            free = self.freed.wait(free).unwrap_or_else(|e| e.into_inner());
        }
        *free -= 1;
    }

    fn release(&self) {
        *self.slots.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.freed.notify_one();
    }

    fn run(&self, req: &LlmRequest) -> Result<LlmText, LlmFailure> {
        let mut cmd = Command::new(&self.exe);
        cmd.args(self.args(req)).current_dir(&self.workdir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for k in STRIPPED_ENV {
            cmd.env_remove(k);
        }
        if !self.prompt_cache {
            cmd.env("DISABLE_PROMPT_CACHING", "1");
        }
        let mut child = cmd.spawn().map_err(|e| LlmFailure::Transport(format!("can't start {}: {e}", self.exe.display())))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let user = req.user.to_string();
        // Write on a thread: a large prompt must not block on a full pipe while nobody reads.
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(user.as_bytes());
        });
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let out_reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stdout.read_to_string(&mut s);
            s
        });
        let err_reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() >= self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = writer.join();
                    let _ = out_reader.join();
                    let _ = err_reader.join();
                    return Err(LlmFailure::Timeout);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(LlmFailure::Transport(format!("waiting for the CLI: {e}"))),
            }
        };
        let _ = writer.join();
        let out = out_reader.join().unwrap_or_default();
        let err = err_reader.join().unwrap_or_default();
        parse_cli_output(&out).map_err(|f| match f {
            LlmFailure::Transport(d) if !status.success() => {
                LlmFailure::Transport(format!("CLI exited with {status}: {d}; stderr: {}", clip(err.trim(), 300)))
            }
            other => other,
        })
    }
}

impl LlmTransport for ClaudeCli {
    fn complete(&self, req: &LlmRequest) -> Result<LlmText, LlmFailure> {
        self.acquire();
        let r = self.run(req);
        self.release();
        r
    }
}

/// The CLI's `--output-format json` result.
#[derive(Deserialize)]
struct CliResult {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    api_error_status: Option<serde_json::Value>,
    #[serde(default)]
    usage: Option<CliUsage>,
}

#[derive(Deserialize, Default)]
struct CliUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

pub fn parse_cli_output(out: &str) -> Result<LlmText, LlmFailure> {
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err(LlmFailure::Transport("the CLI printed nothing".into()));
    }
    let r: CliResult = serde_json::from_str(trimmed).map_err(|e| LlmFailure::Transport(format!("unreadable CLI output ({e}): {}", clip(trimmed, 200))))?;
    if r.is_error {
        let status = r.api_error_status.map(|s| format!(" (status {s})")).unwrap_or_default();
        let why = r.result.or(r.subtype).unwrap_or_else(|| "error".into());
        return Err(LlmFailure::Service(format!("{}{status}", clip(&why, 300))));
    }
    let text = r.result.ok_or_else(|| LlmFailure::Transport("the CLI result has no text".into()))?;
    let u = r.usage.unwrap_or_default();
    Ok(LlmText {
        text,
        input_tokens: u.input_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        cache_write_tokens: u.cache_creation_input_tokens,
        output_tokens: u.output_tokens,
    })
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

// ---------------------------------------------------------------------------------------------
// Deck guides and rules-issue reports (the same words as the Forge LLM seat, forge-referee llm
// Prompt.java, so the two engines' seats are briefed alike)

/// Asked after the reply contract with --llm-report-issues: an optional "rules_issue" field in
/// any reply.
pub const ISSUE_CONTRACT: &str = "Rules check: you are also helping test this rules engine. If something in the \
position or the recent log contradicts the rules of Magic or a card's Oracle text (a card that didn't do what its \
text says, a trigger that should have happened and didn't or one that shouldn't have, a wrong life total, counter, \
power or toughness, an option offered that shouldn't be legal, or a play you clearly should have that isn't \
offered), add a \"rules_issue\" field to your JSON object: one sentence naming the card, what happened and what \
the rules say should have happened. Report only what you can see and are confident about: hidden cards, choices \
made for you by your assistant and how your mana was paid are not issues. Leave the field out when nothing is \
wrong, which is almost always.";

/// The seat's deck guide (its plan and full list, written by us, not untrusted data), appended
/// to the system prompt.
pub fn guide_section(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    format!(
        "\n\nYOUR DECK. You know your own decklist, as any player does. This guide to it (its plan and the full list) \
was written for you by your team before the game:\n{}",
        text.trim()
    )
}

/// The reply's "rules_issue", when it is a non-blank string other than "none". Reads the same
/// JSON object phase-llm decodes the choice from, so prose around it (mana costs like {2}{G})
/// can't hide the report.
pub fn rules_issue(reply: &str) -> Option<String> {
    let v = reply_object(reply)?;
    let t = v.get("rules_issue")?.as_str()?.trim();
    (!t.is_empty() && !t.eq_ignore_ascii_case("none")).then(|| t.to_string())
}

/// The first balanced `{...}` span that parses as JSON: phase-llm's `extract_json_object`
/// (crates/phase-llm/src/prompt.rs, private there), the scan its choice decoding uses.
fn reply_object(text: &str) -> Option<serde_json::Value> {
    let bytes = text.as_bytes();
    for (start, _) in text.char_indices().filter(|(_, c)| *c == '{') {
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        for (offset, byte) in bytes[start..].iter().enumerate() {
            if in_string {
                match byte {
                    _ if escaped => escaped = false,
                    b'\\' => escaped = true,
                    b'"' => in_string = false,
                    _ => {}
                }
                continue;
            }
            match byte {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        let end = start + offset + 1;
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[start..end]) {
                            return Some(v);
                        }
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// First 8 hex digits of the text's SHA-256: names a guide in the seat's prompt label.
pub fn sha8(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------------
// Per-seat bookkeeping, written into the result line

/// What an LLM seat did in one game.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LlmSeatStats {
    pub seat: u8,
    pub pilot: String,
    /// The prompt: "phase-llm" (phase's own), then "+object-key" (a key naming the objects the
    /// options refer to by number), "+guide-<sha 8>" (the seat's deck guide) and "+issues" (asked
    /// to report rules problems) when they were on.
    #[serde(default)]
    pub prompt: String,
    /// Decisions the seat faced with more than one engine-issued option.
    pub decisions: usize,
    /// Decisions with one option, taken without asking (not a fallback).
    pub forced: usize,
    /// Requests sent.
    pub calls: usize,
    /// Decisions settled by the model's own choice.
    pub chosen: usize,
    /// Decisions that fell back to the heuristic AI, by reason: "timeout", "transport",
    /// "service", "undecodable", "out_of_range", "stale", "prompt", "cap".
    pub fallbacks: std::collections::BTreeMap<String, usize>,
    /// Total wall-clock milliseconds spent waiting for replies.
    pub wait_ms: u64,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    /// Replies that reported a rules problem ("rules_issue"); absent when the seat wasn't asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules_issues: Option<usize>,
}

impl LlmSeatStats {
    pub fn fallback(&mut self, why: &str) {
        *self.fallbacks.entry(why.to_string()).or_default() += 1;
    }

    pub fn fallback_count(&self) -> usize {
        self.fallbacks.values().sum()
    }
}

// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pilot_labels() {
        assert_eq!(Pilot::parse("easy").unwrap(), Pilot::Heuristic(AiDifficulty::Easy));
        assert_eq!(Pilot::parse(" VeryHard ").unwrap(), Pilot::Heuristic(AiDifficulty::VeryHard));
        assert_eq!(
            Pilot::parse("llm:claude-haiku-5-5").unwrap(),
            Pilot::Llm(LlmPilot { model: "claude-haiku-5-5".into(), persona: DEFAULT_LLM_PERSONA })
        );
        assert_eq!(
            Pilot::parse("llm:claude-opus-5-5:medium").unwrap(),
            Pilot::Llm(LlmPilot { model: "claude-opus-5-5".into(), persona: AiDifficulty::Medium })
        );
        assert!(Pilot::parse("mediu").is_err());
        assert!(Pilot::parse("llm:").is_err());
        assert!(Pilot::parse("llm:bad model").is_err());
        assert!(Pilot::parse("llm:--tools").is_err(), "a model id can't look like a flag");
        assert!(Pilot::parse("llm:a;b").is_err());
        assert!(Pilot::parse("llm:claude-haiku-5-5:expert").is_err());
    }

    #[test]
    fn cli_args_disable_every_tool_and_setting() {
        let cli = ClaudeCli::new("claude".into(), Duration::from_secs(5), Some("low".into()), 1).unwrap();
        let a = cli.args(&LlmRequest { model: "claude-haiku-5-5", system: "SYS", user: "U" });
        let pos = |flag: &str| a.iter().position(|x| x == flag).unwrap_or_else(|| panic!("{flag} missing"));
        assert_eq!(a[pos("--tools") + 1], "");
        assert_eq!(a[pos("--setting-sources") + 1], "");
        assert_eq!(a[pos("--model") + 1], "claude-haiku-5-5");
        assert_eq!(a[pos("--system-prompt") + 1], "SYS");
        assert_eq!(a[pos("--effort") + 1], "low");
        pos("--strict-mcp-config");
        pos("--disable-slash-commands");
        pos("--no-session-persistence");
        assert!(!a.iter().any(|x| x == "--bare"));
        assert!(!a.iter().any(|x| x == "U"), "the user message goes on stdin");
    }

    #[test]
    fn rules_issue_field() {
        assert_eq!(rules_issue(r#"{"choice": 0, "rules_issue": "Hydra got no counters"}"#).as_deref(), Some("Hydra got no counters"));
        assert_eq!(rules_issue("```json\n{\"choice\": 1, \"rules_issue\": \" x \"}\n```").as_deref(), Some("x"));
        let prose = r#"Casting it costs {2}{G}. {"choice": 1, "reason": "pay {X}", "rules_issue": "Hydra got no counters"} then {U}"#;
        assert_eq!(rules_issue(prose).as_deref(), Some("Hydra got no counters"), "mana symbols around the object");
        for none in [r#"{"choice": 0}"#, r#"{"choice": 0, "rules_issue": " "}"#, r#"{"choice": 0, "rules_issue": "None"}"#, r#"{"choice": 0, "rules_issue": null}"#, r#"{"rules_issue": {"a": 1}}"#, "2", "} {"] {
            assert_eq!(rules_issue(none), None, "{none}");
        }
    }

    #[test]
    fn deck_guide_section() {
        assert_eq!(guide_section("  \n"), "");
        let g = guide_section("Plan: go wide.\n");
        assert!(g.starts_with("\n\nYOUR DECK.") && g.ends_with("before the game:\nPlan: go wide."), "{g}");
        assert_eq!(sha8("abc"), "ba7816bf");
    }

    #[test]
    fn cli_output_parsing() {
        let ok = r#"{"type":"result","is_error":false,"result":"{\"choice\": 1}","usage":{"input_tokens":2,"cache_read_input_tokens":600,"cache_creation_input_tokens":35,"output_tokens":9}}"#;
        let t = parse_cli_output(ok).unwrap();
        assert_eq!(t.text, r#"{"choice": 1}"#);
        assert_eq!((t.input_tokens, t.cache_read_tokens, t.cache_write_tokens, t.output_tokens), (2, 600, 35, 9));
        let err = r#"{"type":"result","is_error":true,"result":"Claude usage limit reached","api_error_status":429}"#;
        assert!(matches!(parse_cli_output(err), Err(LlmFailure::Service(d)) if d.contains("usage limit") && d.contains("429")));
        assert!(matches!(parse_cli_output("not json"), Err(LlmFailure::Transport(_))));
        assert!(matches!(parse_cli_output(""), Err(LlmFailure::Transport(_))));
    }
}
