//! Captured CLI and MCP calls must return while the browser daemon remains alive.
#![cfg(windows)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
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

struct Server {
    child: Child,
    sockets: TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        // Closing via another CLI must also clean up after an MCP timeout.
        let _ = cli(&self.sockets)
            .args(["--session", SESSION, "close"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
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

struct CapturedSession(TempDir);

impl Drop for CapturedSession {
    fn drop(&mut self) {
        let _ = cli(&self.0)
            .args(["--session", CAPTURE_SESSION, "close"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[test]
#[ignore = "launches real Chrome; set AGENT_BROWSER_EXECUTABLE_PATH if needed"]
fn captured_cold_start_open_sees_eof_while_the_daemon_runs() {
    let session = CapturedSession(TempDir::new().unwrap());
    // Piped stdout/stderr reach the CLI as inheritable standard handles, as with
    // PowerShell capture, Node execFile, or Python subprocess.run.
    let mut child = cli(&session.0)
        .args([
            "--session",
            CAPTURE_SESSION,
            "--json",
            "open",
            "about:blank",
        ])
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
    assert_eq!(response["data"]["url"], "about:blank", "{response}");
}
