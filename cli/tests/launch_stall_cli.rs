//! A browser that never reports its DevTools endpoint must surface the
//! daemon's own launch error through the CLI, from a single launch request.
//!
//! The client used to wait 30 s for `launch`, while the daemon makes up to
//! three 30 s launch attempts, so the client gave up first with a socket read
//! timeout (EAGAIN) and then re-sent the launch, which queued more launches in
//! the daemon.
//!
//! Output goes to files rather than pipes because a daemon spawned by the CLI
//! can inherit the pipe handles and keep them open after the CLI exits.
#![cfg(unix)]

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");
const SESSION: &str = "launch-stall";

/// Records each launch next to itself, then keeps writing to stderr without
/// ever printing a DevTools endpoint or writing DevToolsActivePort.
const NOISY_BROWSER: &str = "#!/bin/sh
echo launch >> \"$(dirname \"$0\")/launches.txt\"
i=0
while [ $i -lt 45 ]; do
  echo 'still starting' >&2
  sleep 2
  i=$((i + 1))
done
";

fn cli(root: &std::path::Path) -> Command {
    let mut command = Command::new(BIN);
    command
        .env("AGENT_BROWSER_HOME", root.join("home"))
        .env("AGENT_BROWSER_SOCKET_DIR", root.join("sock"))
        .env("AGENT_BROWSER_EXECUTABLE_PATH", root.join("noisy-browser"))
        .env("TMPDIR", root.join("tmp"))
        .env_remove("AGENT_BROWSER_NAMESPACE")
        .env_remove("AGENT_BROWSER_SESSION")
        .env_remove("AGENT_BROWSER_CONFIG")
        .env_remove("AGENT_BROWSER_CDP")
        .env_remove("AGENT_BROWSER_PROVIDER")
        .env_remove("XDG_RUNTIME_DIR")
        .stdin(Stdio::null());
    command
}

#[test]
#[ignore = "waits out the daemon's three 30 s Chrome launch attempts"]
fn e2e_launch_stall_reports_the_daemon_error_once() {
    // Socket paths must stay short, so keep the root directly under /tmp.
    let root = tempfile::Builder::new()
        .prefix("ab")
        .tempdir_in("/tmp")
        .unwrap();
    for dir in ["home", "sock", "tmp"] {
        fs::create_dir_all(root.path().join(dir)).unwrap();
    }
    let fake = root.path().join("noisy-browser");
    fs::write(&fake, NOISY_BROWSER).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

    let stdout_path = root.path().join("open.out");
    let stderr_path = root.path().join("open.err");
    let mut open = cli(root.path())
        .args(["--session", SESSION, "open", "about:blank"])
        .stdout(File::create(&stdout_path).unwrap())
        .stderr(File::create(&stderr_path).unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    let status = loop {
        if let Some(status) = open.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = open.kill();
            let _ = open.wait();
            panic!("open did not finish within 180 s");
        }
        thread::sleep(Duration::from_millis(100));
    };
    // A client that re-sends the launch would start another fake browser.
    thread::sleep(Duration::from_secs(3));
    let launches = fs::read_to_string(root.path().join("launches.txt"))
        .unwrap_or_default()
        .lines()
        .count();
    let stderr = fs::read_to_string(&stderr_path).unwrap();

    let _ = cli(root.path())
        .args(["--session", SESSION, "close"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    assert!(!status.success(), "open must fail: {stderr}");
    assert!(
        stderr.contains("Timeout waiting for Chrome DevTools"),
        "the daemon's launch error must reach the CLI: {stderr}"
    );
    assert!(!stderr.contains("os error"), "{stderr}");
    // One launch request: at most the daemon's own three attempts.
    assert!(
        (1..=3).contains(&launches),
        "the launch must not be re-sent ({launches} browser starts): {stderr}"
    );
}
