//! Stamps the server with the commit it was built from (`YAMA_SERVER_VERSION`), for the admin
//! area's Server page:
//!
//!   <sha>          the commit, with no uncommitted changes
//!   <sha>-dirty    uncommitted changes in the checkout
//!   unknown        no git and no YAMA_GIT_SHA
//!
//! A Docker build context has no .git, so deploy/deploy.sh passes YAMA_GIT_SHA (short SHA) and
//! YAMA_GIT_DIRTY (0 or 1) as build args instead.
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(env!("CARGO_MANIFEST_DIR")).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    for v in ["YAMA_GIT_SHA", "YAMA_GIT_DIRTY"] {
        println!("cargo:rerun-if-env-changed={v}");
    }
    let env = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let version = match git(&["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty()) {
        Some(sha) => {
            // Rebuild the stamp when HEAD moves; watch only paths that exist (cargo treats a
            // missing path as always changed).
            for name in ["HEAD", "index"] {
                if let Some(p) = git(&["rev-parse", "--git-path", name]) {
                    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(p);
                    if path.exists() {
                        println!("cargo:rerun-if-changed={}", path.display());
                    }
                }
            }
            let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
            if dirty { format!("{sha}-dirty") } else { sha }
        }
        None => match env("YAMA_GIT_SHA") {
            Some(sha) if env("YAMA_GIT_DIRTY").as_deref() == Some("1") => format!("{sha}-dirty"),
            Some(sha) => sha,
            None => "unknown".into(),
        },
    };
    println!("cargo:rustc-env=YAMA_SERVER_VERSION={version}");
}
