//! Phase games run in disposable processes: an allocator abort, stack overflow or hung step
//! must not kill the HTTP server or retain a game thread indefinitely.

use super::experiments::{LabCard, LabList};
use super::pairing::Limits;
use super::worker::{EngineSim, Simulator};
use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use yama_play::Engine;
use yama_play::lab::{ENGINE, End, GameReport, GameResult, GameSpec, RUNNER, STACK, WALL_FACTOR};

const MEMORY_BYTES: u64 = 2 << 30;
const REQUEST_BYTES: u64 = 8 << 20;
const RESULT_BYTES: u64 = 1 << 20;

#[derive(Serialize, Deserialize)]
pub(super) struct Request {
    pub spec: GameSpec,
    pub decks: Vec<LabList>,
    pub limits: Limits,
    pub card_data: String,
}

pub(super) fn runner() -> String {
    // Bump this suffix whenever child execution or resource policy changes.
    let policy = if cfg!(target_os = "linux") {
        "isolated-linux-2g-v1"
    } else {
        "isolated-local-v1"
    };
    format!("{RUNNER}/{policy}")
}

pub(super) struct IsolatedSim {
    lookup: EngineSim,
    card_data_path: PathBuf,
}

impl IsolatedSim {
    pub fn new(engine: Arc<Engine>, hash: String, card_data_path: PathBuf) -> Self {
        Self {
            lookup: EngineSim::new(engine, hash),
            card_data_path,
        }
    }
}

impl Simulator for IsolatedSim {
    fn card_data(&self) -> String {
        self.lookup.card_data()
    }

    fn runner(&self) -> String {
        runner()
    }

    fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
        self.lookup.unknown(cards)
    }

    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
        let request = Request {
            spec: spec.clone(),
            decks: decks.iter().map(|d| d.as_ref().clone()).collect(),
            limits: *limits,
            card_data: self.card_data(),
        };
        let result = (|| {
            let mut command = Command::new(std::env::current_exe()?);
            command.arg("lab-game").arg(&self.card_data_path);
            run_child(
                command,
                &request,
                Duration::from_secs(
                    spec.max_seconds
                        .saturating_mul(WALL_FACTOR)
                        .saturating_add(30),
                ),
            )
        })();
        result.unwrap_or_else(|e: anyhow::Error| {
            let mut r =
                GameReport::failed(spec, &request.card_data, End::Error, format!("{e:#}")).result;
            r.runner = runner();
            r
        })
    }
}

/// Kill and reap even when an I/O error or unwind leaves the normal waiting path.
struct Reap(Child);

impl Drop for Reap {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_child(
    mut command: Command,
    request: &Request,
    timeout: Duration,
) -> anyhow::Result<GameResult> {
    let bytes = serde_json::to_vec(request)?;
    ensure!(
        bytes.len() as u64 <= REQUEST_BYTES,
        "game request exceeds size limit"
    );
    // Private, unlinked files avoid pipe-buffer deadlocks and disappear even after an abort.
    let mut input = tempfile::tempfile()?;
    input.write_all(&bytes)?;
    input.rewind()?;
    let mut output = tempfile::tempfile()?;
    command.env_clear().env("RUST_MIN_STACK", STACK.to_string());
    command
        .stdin(Stdio::from(input))
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::inherit());
    let mut child = Reap(command.spawn().context("starting child")?);
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait()? {
            break status;
        }
        ensure!(
            start.elapsed() < timeout,
            "wall-clock safety limit: isolated worker exceeded {} seconds",
            timeout.as_secs()
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let policy = if cfg!(target_os = "linux") {
        "Linux heap limit 2 GiB"
    } else {
        "local process isolation"
    };
    ensure!(
        status.success(),
        "worker ended with {status} ({policy}); game is unscored"
    );
    let bytes = read_bounded(&mut output, RESULT_BYTES)?;
    let result: GameResult = serde_json::from_slice(&bytes).context("reading child result")?;
    ensure!(
        result.game == request.spec.game
            && result.seed == request.spec.seed
            && result.decks == request.spec.decks,
        "child result does not match the scheduled game"
    );
    ensure!(
        result.engine == ENGINE
            && result.card_data == request.card_data
            && result.runner == runner(),
        "child result has a different build"
    );
    Ok(result)
}

fn read_bounded(file: &mut File, max: u64) -> anyhow::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= max, "child output exceeds size limit");
    Ok(bytes)
}

pub(crate) fn child_main(path: PathBuf) -> anyhow::Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= REQUEST_BYTES,
        "game request exceeds size limit"
    );
    let request: Request = serde_json::from_slice(&bytes)?;
    request.spec.check().map_err(anyhow::Error::msg)?;
    apply_limits(request.spec.max_seconds.saturating_add(30), MEMORY_BYTES)?;
    let result = std::thread::Builder::new()
        .name("isolated lab game".into())
        .stack_size(STACK)
        .spawn(move || {
            let engine = Arc::new(Engine::load(&path)?);
            let sim = EngineSim::new(engine, request.card_data);
            let decks: Vec<_> = request.decks.into_iter().map(Arc::new).collect();
            let mut result = sim.play(&request.spec, &decks, &request.limits);
            result.runner = runner();
            Ok::<_, anyhow::Error>(result)
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("isolated game thread panicked"))??;
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &result)?;
    output.flush()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_limits(cpu_seconds: u64, memory_bytes: u64) -> anyhow::Result<()> {
    // RLIMIT_DATA also covers anonymous mmap on Linux >= 4.7. RLIMIT_RSS does not enforce a cap.
    // Set limits inside the fresh executable, before engine loading, without forking Rust state.
    for (resource, value) in [
        (libc::RLIMIT_DATA, memory_bytes),
        (libc::RLIMIT_CPU, cpu_seconds),
        (libc::RLIMIT_FSIZE, RESULT_BYTES),
        (libc::RLIMIT_CORE, 0),
    ] {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        // SAFETY: a valid, initialized rlimit pointer is passed for the current process only.
        if unsafe { libc::setrlimit(resource, &limit) } != 0 {
            return Err(std::io::Error::last_os_error()).context("setting game resource limit");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn apply_limits(_cpu_seconds: u64, _memory_bytes: u64) -> anyhow::Result<()> {
    // Production is Linux. Local development still isolates crashes and enforces the deadline.
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::pairing::LIMITS;
    use super::*;

    fn request() -> Request {
        Request {
            spec: GameSpec {
                game: "process-test".into(),
                seed: 7,
                decks: vec!["a".into(), "b".into()],
                difficulty: "Easy".into(),
                max_turns: 10,
                max_actions: 100,
                max_seconds: 5,
                pilots: None,
            },
            decks: vec![],
            limits: LIMITS,
            card_data: "fixture".into(),
        }
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    fn result_fixture(request: &Request) -> tempfile::NamedTempFile {
        let mut result = GameReport::failed(
            &request.spec,
            &request.card_data,
            End::Error,
            "fixture".into(),
        )
        .result;
        result.runner = runner();
        let mut file = tempfile::NamedTempFile::new().unwrap();
        serde_json::to_writer(&mut file, &result).unwrap();
        file.flush().unwrap();
        file
    }

    #[test]
    fn completed_child_result_keeps_schedule_and_build_identity_without_credentials() {
        let request = request();
        let fixture = result_fixture(&request);
        let mut command = shell("test -z \"$YAMA_TEST_SECRET\" && cat \"$1\"");
        command
            .arg("fixture")
            .arg(fixture.path())
            .env("YAMA_TEST_SECRET", "must-not-reach-child");
        let result = run_child(command, &request, Duration::from_secs(2)).unwrap();
        assert_eq!(result.game, request.spec.game);
        assert_eq!(result.runner, runner());
    }

    #[test]
    fn killed_game_is_an_error_instead_of_killing_its_parent() {
        let error =
            run_child(shell("kill -KILL $$"), &request(), Duration::from_secs(2)).unwrap_err();
        assert!(error.to_string().contains("worker ended"));
        // A subsequent child still works, proving the parent remains available after the kill.
        let request = request();
        let fixture = result_fixture(&request);
        let mut command = shell("cat \"$1\"");
        command.arg("fixture").arg(fixture.path());
        assert!(run_child(command, &request, Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn hung_child_is_killed_and_reaped_at_the_deadline() {
        let start = Instant::now();
        let error = run_child(
            shell("exec sleep 60"),
            &request(),
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert!(error.to_string().contains("wall-clock safety limit"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn oversized_child_output_is_rejected() {
        let error = run_child(
            shell("dd if=/dev/zero bs=1024 count=1025 2>/dev/null"),
            &request(),
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(error.to_string().contains("output exceeds size limit"));
    }

    #[test]
    fn another_games_result_is_rejected() {
        let input = request();
        let mut other = request();
        other.spec.game = "another-game".into();
        let fixture = result_fixture(&other);
        let mut command = shell("cat \"$1\"");
        command.arg("fixture").arg(fixture.path());
        assert!(
            run_child(command, &input, Duration::from_secs(2))
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn allocation_limit_failure_is_confined_to_the_child() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--ignored",
            "--exact",
            "lab::process::tests::memory_probe",
            "--nocapture",
        ]);
        assert!(
            run_child(command, &request(), Duration::from_secs(5))
                .unwrap_err()
                .to_string()
                .contains("73")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "fixture executed only in the memory-isolation child"]
    fn memory_probe() {
        apply_limits(5, 64 << 20).unwrap();
        let mut allocation = Vec::<u8>::new();
        let limited = allocation.try_reserve_exact(3usize << 30).is_err();
        std::process::exit(if limited { 73 } else { 0 });
    }
}
