//! Captured CLI and MCP calls must return while the browser daemon remains alive.
#![cfg(windows)]

use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");
const SESSION: &str = "mcp-stdio-lifetime";

/// An agent-browser command isolated to `sockets`. Windows derives the daemon
/// port from the namespace and session, so a unique namespace keeps the port
/// clear of other daemons on the machine.
fn cli(sockets: &TempDir) -> Command {
    let mut command = Command::new(BIN);
    command
        .env("AGENT_BROWSER_SOCKET_DIR", sockets.path())
        .env(
            "AGENT_BROWSER_NAMESPACE",
            sockets.path().file_name().unwrap(),
        )
        .env_remove("AGENT_BROWSER_DAEMON")
        .env_remove("AGENT_BROWSER_SESSION");
    command
}

/// Runs `command` to completion, killing it if it outlives `timeout`.
/// Returns `Ok(None)` on timeout.
fn status_within(command: &mut Command, timeout: Duration) -> io::Result<Option<ExitStatus>> {
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        let polled = child.try_wait();
        if let Ok(Some(status)) = polled {
            return Ok(Some(status));
        }
        if polled.is_err() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return polled.map(|_| None);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// Closes `session`, bounded so a stuck close cannot hang test cleanup.
fn close_session(sockets: &TempDir, session: &str) {
    let _ = status_within(
        cli(sockets)
            .args(["--session", session, "close"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null()),
        Duration::from_secs(30),
    );
}

struct Server {
    child: Child,
    sockets: TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        // Closing via another CLI must also clean up after an MCP timeout.
        close_session(&self.sockets, SESSION);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "launches real Chrome; set AGENT_BROWSER_EXECUTABLE_PATH if needed"]
fn mcp_open_returns_before_the_browser_is_closed() {
    let sockets = TempDir::new().unwrap();
    let child = cli(&sockets)
        .args(["mcp", "--tools", "all"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut server = Server { child, sockets };
    let mut diagnostics = server.child.stderr.take().unwrap();
    let (diagnostics_tx, diagnostics_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        let _ = diagnostics.read_to_string(&mut text);
        let _ = diagnostics_tx.send(text);
    });
    let output = server.child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            let message = serde_json::from_str::<Value>(&line).unwrap();
            if tx.send(message).is_err() {
                break;
            }
        }
    });
    let input = server.child.stdin.as_mut().unwrap();
    writeln!(
        input,
        "{}",
        json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion":"2025-11-25", "capabilities":{},
                "clientInfo":{"name":"mcp-lifetime-test","version":"1"}}
        })
    )
    .unwrap();
    let initialized = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(initialized["id"], 1);
    writeln!(
        input,
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
    writeln!(input, "{}", json!({
        "jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"agent_browser_open","arguments":{"url":"about:blank","session":SESSION}}
    })).unwrap();
    let opened = rx
        .recv_timeout(Duration::from_secs(45))
        .expect("MCP open waited for the browser daemon's inherited output handles to close");
    assert_eq!(opened["id"], 2);
    assert_eq!(opened["result"]["isError"], false, "{opened}");
    assert_eq!(
        opened["result"]["structuredContent"]["response"]["data"]["url"],
        "about:blank"
    );
    writeln!(
        input,
        "{}",
        json!({
            "jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"agent_browser_close","arguments":{"session":SESSION}}
        })
    )
    .unwrap();
    let closed = rx.recv_timeout(Duration::from_secs(15)).unwrap();
    assert_eq!(closed["id"], 3);
    assert_eq!(closed["result"]["isError"], false, "{closed}");

    drop(server.child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(10);
    while server.child.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "MCP server did not exit after stdin closed"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let diagnostics = diagnostics_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("MCP server stderr stayed open after the server exited");
    // run_cli also returns, after a bounded drain, when the daemon holds the
    // CLI's pipes. This warning shows the daemon did not inherit them.
    assert!(
        !diagnostics.contains("output pipes stayed open"),
        "{diagnostics}"
    );
}

const CAPTURE_SESSION: &str = "captured-stdio-lifetime";
/// A page a restarted daemon would not show, unlike its initial about:blank.
const CAPTURE_PAGE: &str = "data:text/html,<title>captured</title>";

struct CapturedSession(TempDir);

impl Drop for CapturedSession {
    fn drop(&mut self) {
        close_session(&self.0, CAPTURE_SESSION);
    }
}

#[test]
#[ignore = "launches real Chrome; set AGENT_BROWSER_EXECUTABLE_PATH if needed"]
fn captured_cold_start_open_sees_eof_while_the_daemon_runs() {
    let session = CapturedSession(TempDir::new().unwrap());
    // Piped stdout/stderr reach the CLI as inheritable standard handles, as with
    // PowerShell capture, Node execFile, or Python subprocess.run.
    let mut child = cli(&session.0)
        .args(["--session", CAPTURE_SESSION, "--json", "open", CAPTURE_PAGE])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let pipes: [Box<dyn Read + Send>; 2] = [
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ];
    for (index, mut pipe) in pipes.into_iter().enumerate() {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            let _ = tx.send((index, String::from_utf8_lossy(&bytes).into_owned()));
        });
    }

    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("agent-browser open did not exit");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let mut output = [String::new(), String::new()];
    for _ in 0..output.len() {
        let (index, text) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the CLI exited but the daemon kept the caller's capture pipes open");
        output[index] = text;
    }
    let [stdout, stderr] = output;
    assert!(status.success(), "stdout: {stdout}\nstderr: {stderr}");
    let response: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(response["data"]["url"], CAPTURE_PAGE, "{response}");

    // EOF came from the CLI exiting, not from the daemon stopping. `get url`
    // starts a new daemon if needed, so it must still show the opened page.
    let url_path = session.0.path().join("get-url.json");
    let status = status_within(
        cli(&session.0)
            .args(["--session", CAPTURE_SESSION, "--json", "get", "url"])
            .stdin(Stdio::null())
            .stdout(File::create(&url_path).unwrap())
            .stderr(Stdio::null()),
        Duration::from_secs(15),
    )
    .expect("could not run get url")
    .expect("get url did not finish after the open command returned");
    let url = std::fs::read_to_string(&url_path).unwrap();
    assert!(status.success(), "{url}");
    let url: Value = serde_json::from_str(url.trim()).unwrap();
    assert_eq!(url["data"]["url"], CAPTURE_PAGE, "{url}");
}
