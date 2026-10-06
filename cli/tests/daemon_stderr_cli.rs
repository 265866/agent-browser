//! A Windows daemon must keep working after the CLI that launched it exits,
//! even though that CLI held the only reader of the daemon's startup stderr.
#![cfg(windows)]

use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");

/// An agent-browser command isolated to `tmp`. Windows derives the daemon port
/// from the namespace and session, so a unique namespace keeps the port clear
/// of other daemons on the machine.
fn cli(tmp: &TempDir, session: &str) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.current_dir(tmp.path())
        .env("AGENT_BROWSER_SOCKET_DIR", tmp.path())
        .env("AGENT_BROWSER_NAMESPACE", namespace(tmp))
        .env("AGENT_BROWSER_SESSION", session)
        .env_remove("AGENT_BROWSER_CONFIG")
        .env_remove("AGENT_BROWSER_DAEMON")
        .env_remove("AGENT_BROWSER_DEBUG");
    cmd
}

fn namespace(tmp: &TempDir) -> String {
    tmp.path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn run_dir(tmp: &TempDir) -> PathBuf {
    tmp.path()
        .join("namespaces")
        .join(namespace(tmp))
        .join("run")
}

fn read_pid(dir: &Path, session: &str) -> String {
    fs::read_to_string(dir.join(format!("{session}.pid"))).unwrap()
}

/// Runs `command` to completion, killing it if it outlives `timeout`.
/// Returns `Ok(None)` on timeout.
fn status_within(command: &mut Command, timeout: Duration) -> io::Result<Option<ExitStatus>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// Closes the session when the test ends. A daemon that cannot close (for
/// example one stuck behind an undismissed alert) is killed instead, so a
/// failing run does not leak it; its Job Object takes Chrome down with it.
struct Session<'a> {
    tmp: &'a TempDir,
    name: &'a str,
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        let closed = status_within(
            cli(self.tmp, self.name).arg("close"),
            Duration::from_secs(30),
        );
        if matches!(closed, Ok(Some(status)) if status.success()) {
            return;
        }
        if let Ok(pid) = fs::read_to_string(run_dir(self.tmp).join(format!("{}.pid", self.name))) {
            let _ = Command::new("taskkill")
                .args(["/PID", pid.trim(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[test]
fn windows_cli_and_mcp_share_daemon_with_independent_debug_log() {
    const SESSION: &str = "stderr-integration";
    let tmp = TempDir::new().unwrap();
    let command = || {
        let mut cmd = cli(&tmp, SESSION);
        cmd.env("AGENT_BROWSER_DEBUG", "1")
            .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "0");
        cmd
    };
    let _session = Session {
        tmp: &tmp,
        name: SESSION,
    };
    let status = status_within(
        command().args(["stream", "status"]),
        Duration::from_secs(30),
    )
    .unwrap()
    .expect("stream status timed out");
    assert!(status.success());
    // The launching CLI has exited and dropped its daemon stderr pipe reader.
    let original_pid = read_pid(&run_dir(&tmp), SESSION);

    let cli_output = command()
        .args(["--json", "stream", "status"])
        .output()
        .unwrap();
    assert!(cli_output.status.success(), "{cli_output:?}");
    let cli_response: Value = serde_json::from_slice(&cli_output.stdout).unwrap();
    assert_eq!(cli_response["success"], true);

    let mut mcp = command()
        .args(["mcp", "--tools", "all"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        mcp.stdin.take().unwrap(),
        "{}",
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "agent_browser_stream_status", "arguments": {"session": SESSION}
        }})
    )
    .unwrap();
    let output = mcp.wait_with_output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["response"]["success"],
        true
    );

    assert_eq!(read_pid(&run_dir(&tmp), SESSION), original_pid);
    let log = fs::read_to_string(run_dir(&tmp).join(format!("{SESSION}.log"))).unwrap();
    assert!(log.contains(&format!("Debug logging started for session: {SESSION}")));
}

/// The daemon logs every auto-dismissed alert to stderr. Before the fix that
/// write hit the closed startup pipe and panicked the dialog handler, so the
/// alert stayed open and the next command hung until its read timed out.
#[test]
#[ignore = "launches real Chrome; set AGENT_BROWSER_EXECUTABLE_PATH if needed"]
fn e2e_windows_daemon_logs_after_launching_cli_exits() {
    const SESSION: &str = "stderr-e2e";
    let tmp = TempDir::new().unwrap();
    let _session = Session {
        tmp: &tmp,
        name: SESSION,
    };
    let run = |args: &[&str], timeout: Duration| {
        status_within(cli(&tmp, SESSION).args(args), timeout).unwrap()
    };

    let opened = run(&["open", "about:blank"], Duration::from_secs(90));
    assert!(opened.is_some_and(|s| s.success()), "open: {opened:?}");
    let pid = read_pid(&run_dir(&tmp), SESSION);

    let alerted = run(
        &["eval", "setTimeout(() => alert('stderr probe'), 200); 1"],
        Duration::from_secs(30),
    );
    assert!(alerted.is_some_and(|s| s.success()), "eval: {alerted:?}");
    thread::sleep(Duration::from_secs(1));

    let after = run(
        &["eval", "document.title = 'alive'"],
        Duration::from_secs(20),
    );
    assert!(
        after.is_some_and(|s| s.success()),
        "command after the auto-dismissed alert failed or hung: {after:?}"
    );
    assert_eq!(read_pid(&run_dir(&tmp), SESSION), pid);
}
