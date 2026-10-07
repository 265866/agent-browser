//! A Unix daemon that cannot bind its socket must report why to the CLI that
//! launched it. The daemon replaces its startup stderr pipe only after the
//! bind, so the error still reaches the CLI, with or without a debug log.
#![cfg(unix)]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");
const SESSION: &str = "bindfail";

/// Kills a daemon that started despite the occupied socket path, so a failing
/// run does not leak it.
struct DaemonGuard(PathBuf);

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        if let Ok(pid) = fs::read_to_string(self.0.join(format!("{SESSION}.pid"))) {
            let _ = Command::new("kill").args(["-9", pid.trim()]).status();
        }
    }
}

fn assert_bind_error_reaches_cli(debug: bool) {
    // Directly under /tmp: the system temp dir (long on macOS) could push the
    // socket path past the Unix limit.
    let tmp = tempfile::Builder::new()
        .prefix("ab")
        .tempdir_in("/tmp")
        .unwrap();
    let sockets = tmp.path().join("s");
    // A directory at the socket path makes the bind fail with "Address already
    // in use"; a directory at the log path makes the debug log uncreatable.
    fs::create_dir_all(sockets.join(format!("{SESSION}.sock"))).unwrap();
    if debug {
        fs::create_dir_all(sockets.join(format!("{SESSION}.log"))).unwrap();
    }
    let _daemon = DaemonGuard(sockets.clone());

    let output = cli(&tmp, &sockets, debug)
        .args(["stream", "status"])
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{output:?}");
    assert!(
        stderr.contains("Failed to bind socket"),
        "the bind error did not reach the CLI (debug={debug}): {stderr}"
    );
}

fn cli(tmp: &TempDir, sockets: &Path, debug: bool) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.current_dir(tmp.path())
        .env("AGENT_BROWSER_HOME", tmp.path().join("home"))
        .env("AGENT_BROWSER_SOCKET_DIR", sockets)
        .env("AGENT_BROWSER_SESSION", SESSION)
        .env("AGENT_BROWSER_DEBUG", if debug { "1" } else { "0" })
        .env_remove("AGENT_BROWSER_NAMESPACE")
        .env_remove("AGENT_BROWSER_CONFIG")
        .env_remove("AGENT_BROWSER_DAEMON");
    cmd
}

#[test]
fn unix_bind_error_reaches_cli() {
    assert_bind_error_reaches_cli(false);
}

#[test]
fn unix_bind_error_reaches_cli_when_debug_log_cannot_be_created() {
    assert_bind_error_reaches_cli(true);
}
