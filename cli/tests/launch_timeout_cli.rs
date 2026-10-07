//! A browser that never reports a DevTools endpoint must fail the launch
//! after a single attempt, and the CLI must print the daemon's launch error
//! rather than giving up on the socket read first.
//!
//! This binary doubles as that browser: started with Chrome's switches, it
//! records the launch and stays silent until it is killed. It uses
//! `harness = false` because libtest would reject those switches, so `main`
//! handles the few test-runner arguments cargo passes.
//!
//! Output goes to files rather than pipes because the daemon the CLI spawns
//! can inherit the pipe handles and keep them open after the CLI exits.

mod common;

use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");
const TEST_NAME: &str = "silent_browser_launch_error_reaches_cli_once";
const FAKE_BROWSER_DIR: &str = "AGENT_BROWSER_TEST_FAKE_BROWSER_DIR";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .iter()
        .any(|a| a.starts_with("--remote-debugging-port"))
    {
        fake_browser();
        return;
    }
    if !selected(&args) {
        if !args.iter().any(|a| a == "--list") {
            println!("\nrunning 0 tests\n");
            println!(
                "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out\n"
            );
        }
        return;
    }
    if args.iter().any(|a| a == "--list") {
        println!("{TEST_NAME}: test");
        return;
    }
    println!("\nrunning 1 test");
    silent_browser_launch_error_reaches_cli_once();
    println!("test {TEST_NAME} ... ok\n");
    println!("test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n");
}

/// Whether libtest-style arguments select this one non-ignored test.
fn selected(args: &[String]) -> bool {
    let mut filters = Vec::new();
    let mut skips = Vec::new();
    let mut exact = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--ignored" => return false,
            "--exact" => exact = true,
            "--skip" => skips.extend(iter.next().cloned()),
            "--test-threads" | "--color" | "--format" | "--logfile" | "-Z" => {
                iter.next();
            }
            flag if flag.starts_with('-') => {}
            filter => filters.push(filter.to_string()),
        }
    }
    let matches = |pattern: &String| {
        if exact {
            pattern == TEST_NAME
        } else {
            TEST_NAME.contains(pattern.as_str())
        }
    };
    (filters.is_empty() || filters.iter().any(matches)) && !skips.iter().any(matches)
}

fn fake_browser() {
    let dir = std::env::var_os(FAKE_BROWSER_DIR).expect("fake browser directory");
    let launches = Path::new(&dir).join("launches.txt");
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(launches)
        .unwrap();
    std::io::Write::write_all(&mut log, b"launch\n").unwrap();
    drop(log);
    // Bound the lifetime in case the daemon never kills it.
    std::thread::sleep(Duration::from_secs(120));
}

/// A temp directory whose paths stay short enough for Unix sockets.
fn short_tempdir() -> TempDir {
    #[cfg(unix)]
    {
        tempfile::Builder::new()
            .prefix("ab")
            .tempdir_in("/tmp")
            .unwrap()
    }
    #[cfg(not(unix))]
    {
        TempDir::new().unwrap()
    }
}

struct Sandbox {
    tmp: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let tmp = short_tempdir();
        for dir in ["home", "agent-home", "sockets", "work", "fake"] {
            std::fs::create_dir_all(tmp.path().join(dir)).unwrap();
        }
        std::fs::write(tmp.path().join("config.json"), "{}\n").unwrap();
        Self { tmp }
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.tmp.path().join(name)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(BIN);
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("AGENT_BROWSER_") {
                cmd.env_remove(name);
            }
        }
        cmd.args(args)
            .current_dir(self.path("work"))
            .env("AGENT_BROWSER_HOME", self.path("agent-home"))
            .env("AGENT_BROWSER_SOCKET_DIR", self.path("sockets"))
            .env("AGENT_BROWSER_CONFIG", self.path("config.json"))
            .env(
                "AGENT_BROWSER_NAMESPACE",
                self.tmp.path().file_name().unwrap(),
            )
            .env(
                "AGENT_BROWSER_EXECUTABLE_PATH",
                std::env::current_exe().unwrap(),
            )
            .env(FAKE_BROWSER_DIR, self.path("fake"))
            .env("HOME", self.path("home"))
            .env("USERPROFILE", self.path("home"))
            .env("NO_COLOR", "1")
            .env_remove("XDG_RUNTIME_DIR")
            .stdin(Stdio::null());
        cmd
    }

    fn launches(&self) -> usize {
        std::fs::read_to_string(self.path("fake").join("launches.txt"))
            .map(|text| text.lines().count())
            .unwrap_or(0)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let mut close = self.command(&["close", "--all"]);
        close.stdout(Stdio::null()).stderr(Stdio::null());
        let _ = status_within(&mut close, Duration::from_secs(30));
    }
}

/// Runs `command` to completion, killing it if it outlives `timeout`.
fn status_within(command: &mut Command, timeout: Duration) -> Option<ExitStatus> {
    let mut child = command.spawn().expect("failed to run agent-browser");
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn silent_browser_launch_error_reaches_cli_once() {
    let sandbox = Sandbox::new();
    let out_path = sandbox.path("open-out.txt");
    let err_path = sandbox.path("open-err.txt");
    let mut open = sandbox.command(&["--session", "silent", "--json", "open", "about:blank"]);
    open.stdout(std::fs::File::create(&out_path).unwrap())
        .stderr(std::fs::File::create(&err_path).unwrap());

    let started = Instant::now();
    let status = status_within(&mut open, Duration::from_secs(120));
    let elapsed = started.elapsed();
    let stdout = std::fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
    let context = format!("after {elapsed:?}\nstdout:\n{stdout}\nstderr:\n{stderr}");

    let status = status.unwrap_or_else(|| panic!("open hung {context}"));
    assert!(!status.success(), "open succeeded {context}");
    assert!(
        stdout.contains("Timeout waiting for Chrome DevTools endpoint"),
        "the daemon's launch error did not reach the CLI {context}"
    );
    assert!(
        !stdout.contains("Failed to read"),
        "the client gave up before the daemon answered {context}"
    );

    // A retrying daemon would start another attempt within a second.
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(sandbox.launches(), 1, "browser launches {context}");
}
