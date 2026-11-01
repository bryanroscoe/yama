//! Stamps the lab runner with the source it was built from (`YAMA_LAB_RUNNER`), so every distinct
//! binary writes a distinct `runner` value into its results:
//!
//!   <sha>                  the commit, when play, server and workspace manifests are unchanged
//!   <sha>-dirty-<hash>     uncommitted changes; <hash> is 8 hex digits of an FNV-1a hash of the
//!                          sources that make the binary (play/src, play/build.rs, play/Cargo.toml,
//!                          server sources/resources/migrations/build.rs/Cargo.toml, Cargo.toml,
//!                          Cargo.lock and embedded runtime manifests), so dirty builds reflect
//!                          changes to execution policy and runtime bindings too
//!   unknown-<hash>         no git and no YAMA_LAB_GIT_SHA
//!
//! The historical export uses a distinct Cargo package name so its Git-less build-script
//! output cannot replace this package's runner stamp in the shared target directory.
//!
//! A Docker build context has no .git: deployment passes YAMA_LAB_GIT_SHA (full SHA) and
//! YAMA_LAB_GIT_DIRTY (0 or 1) as build args instead, and the hash is computed here from the same
//! files, so a saget build and a Mac build of the same source carry the same stamp. Setting
//! YAMA_LAB_RUNNER in the build environment overrides all of this.
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let pin = std::fs::read_to_string(manifest_dir().join("../deploy/phase-rev")).expect("deployment Phase pin");
    let pin = pin.trim();
    assert!(pin.len() == 40 && pin.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)), "invalid deployment Phase pin");
    verify_phase_source(pin);
    println!("cargo:rustc-env=YAMA_PLAY_PHASE_REV={pin}");
    for p in ["build.rs", "src", "Cargo.toml", "../Cargo.toml", "../Cargo.lock", "../server/src", "../server/resources", "../server/migrations", "../server/build.rs", "../server/Cargo.toml", "../runtime/historical.json", "../runtime/historical-source.json", "../deploy/phase-rev"] {
        println!("cargo:rerun-if-changed={p}");
    }
    for v in ["YAMA_LAB_RUNNER", "YAMA_LAB_GIT_SHA", "YAMA_LAB_GIT_DIRTY", "YAMA_PHASE_SOURCE_REV"] {
        println!("cargo:rerun-if-env-changed={v}");
    }
    let runner = match std::env::var("YAMA_LAB_RUNNER") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => detect(),
    };
    println!("cargo:rustc-env=YAMA_LAB_RUNNER={runner}");
}

fn verify_phase_source(pin: &str) {
    let phase = manifest_dir().join("../../yama-phase");
    for name in ["Cargo.toml", "Cargo.lock", ".cargo", "crates", ".git"] {
        let path = phase.join(name);
        if path.exists() && (name != ".git" || path.is_file()) { println!("cargo:rerun-if-changed={}", path.display()); }
    }
    if !phase.join(".git").exists() {
        // A committed-source export has no Git metadata. Its build system must
        // explicitly attest the revision it exported, rather than infer it from
        // the runtime label. Production exports come from the verified pin.
        assert_eq!(std::env::var("YAMA_PHASE_SOURCE_REV").ok().as_deref(), Some(pin),
            "Git-less Phase source needs YAMA_PHASE_SOURCE_REV matching deploy/phase-rev");
        return;
    }
    let read = |args: &[&str]| {
        let output = Command::new("git").args(args).current_dir(&phase).output().expect("inspect Phase source");
        assert!(output.status.success(), "cannot verify Phase source checkout");
        String::from_utf8(output.stdout).expect("Phase Git output").trim().to_string()
    };
    assert_eq!(read(&["rev-parse", "HEAD"]), pin,
        "Phase checkout must match deploy/phase-rev before building");
    assert!(read(&["status", "--porcelain", "--untracked-files=all"]).is_empty(),
        "Phase source must be a clean pinned checkout before building");
    let mut paths = vec!["HEAD".to_string(), "index".to_string(), "packed-refs".to_string()];
    let reference = read(&["rev-parse", "--symbolic-full-name", "HEAD"]);
    if reference != "HEAD" { paths.push(reference); }
    for name in paths {
        let path = phase.join(read(&["rev-parse", "--git-path", &name]));
        if path.exists() { println!("cargo:rerun-if-changed={}", path.display()); }
    }
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(manifest_dir()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn detect() -> String {
    let hash = source_hash();
    let env = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let Some(sha) = git(&["rev-parse", "HEAD"]).filter(|s| !s.is_empty()) else {
        // No git (a Docker build context): the deploy script's build args stand in for it.
        return match env("YAMA_LAB_GIT_SHA") {
            Some(sha) if env("YAMA_LAB_GIT_DIRTY").as_deref() == Some("0") => sha,
            Some(sha) => format!("{sha}-dirty-{hash}"),
            None => format!("unknown-{hash}"),
        };
    };
    // Rebuild the stamp when HEAD moves (a commit or checkout). Only existing paths are
    // watched: cargo treats a missing path as always changed.
    let mut watch = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(head_ref) = git(&["symbolic-ref", "-q", "HEAD"]) {
        watch.push(head_ref);
    }
    let dir = manifest_dir();
    for name in watch {
        if let Some(p) = git(&["rev-parse", "--git-path", &name]) {
            let path = dir.join(p);
            if path.exists() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
    match git(&["status", "--porcelain", "--", ".", "../server", "../Cargo.toml", "../Cargo.lock", "../runtime/historical.json", "../runtime/historical-source.json", "../deploy/phase-rev"]) {
        Some(s) if s.is_empty() => sha,
        _ => format!("{sha}-dirty-{hash}"),
    }
}

/// 8 hex digits of a 64-bit FNV-1a hash over the files that make the runner, each fed as its
/// path relative to the workspace root, a NUL, its bytes and a NUL, in sorted path order.
/// FNV is written out here: no build dependency, and std's hasher may change between Rust
/// releases, which would give saget's and the Mac's builds different stamps for one source.
fn source_hash() -> String {
    let dir = manifest_dir();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect(&dir.join("src"), "play/src", &mut files);
    for name in ["src", "resources", "migrations"] {
        collect(&dir.join("../server").join(name), &format!("server/{name}"), &mut files);
    }
    for (rel, path) in [
        ("play/build.rs", dir.join("build.rs")),
        ("play/Cargo.toml", dir.join("Cargo.toml")),
        ("Cargo.toml", dir.join("../Cargo.toml")),
        ("Cargo.lock", dir.join("../Cargo.lock")),
        ("server/build.rs", dir.join("../server/build.rs")),
        ("server/Cargo.toml", dir.join("../server/Cargo.toml")),
        ("runtime/historical.json", dir.join("../runtime/historical.json")),
        ("runtime/historical-source.json", dir.join("../runtime/historical-source.json")),
        ("deploy/phase-rev", dir.join("../deploy/phase-rev")),
    ] {
        if path.is_file() {
            files.push((rel.to_string(), path));
        }
    }
    files.sort();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for (rel, path) in &files {
        feed(rel.as_bytes());
        feed(&[0]);
        feed(&std::fs::read(path).unwrap_or_default());
        feed(&[0]);
    }
    format!("{:08x}", (h >> 32) ^ (h & 0xffff_ffff))
}

fn collect(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let child = format!("{rel}/{name}");
        if path.is_dir() {
            collect(&path, &child, out);
        } else if path.is_file() {
            out.push((child, path));
        }
    }
}
