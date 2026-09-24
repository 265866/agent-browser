#![cfg(target_os = "linux")]

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn conflicting_angle_backend_has_the_same_cli_and_mcp_error() {
    let binary = env!("CARGO_BIN_EXE_agent-browser");
    let session = format!("webgpu-angle-test-{}", std::process::id());

    let cli = Command::new(binary)
        .args([
            "--json",
            "--session",
            &session,
            "--webgpu",
            "--executable-path",
            "/usr/bin/true",
            "open",
            "about:blank",
        ])
        .env("AGENT_BROWSER_ARGS", "--use-angle=swiftshader")
        .output()
        .expect("CLI should run");
    assert!(!cli.status.success());
    let cli_response: Value = serde_json::from_slice(&cli.stdout).expect("CLI JSON response");
    let cli_error = cli_response["error"].as_str().expect("CLI error text");
    assert!(cli_error.contains("--use-angle=swiftshader"));
    assert!(cli_error.contains("--webgpu false"));

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "agent_browser_open",
            "arguments": {
                "webgpu": true,
                "session": session,
                "extraArgs": ["--executable-path", "/usr/bin/true"]
            }
        }
    });
    let mut mcp = Command::new(binary)
        .args(["mcp", "--tools", "all"])
        .env("AGENT_BROWSER_ARGS", "--use-angle=swiftshader")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("MCP server should run");
    writeln!(mcp.stdin.take().unwrap(), "{request}").expect("MCP request should be sent");
    let mcp_output = mcp
        .wait_with_output()
        .expect("MCP server should exit on EOF");
    assert!(mcp_output.status.success());
    let mcp_response: Value =
        serde_json::from_slice(&mcp_output.stdout).expect("MCP JSON response");
    assert_eq!(mcp_response["result"]["isError"], true);
    assert_eq!(
        mcp_response["result"]["structuredContent"]["response"]["error"],
        cli_error
    );

    let _ = Command::new(binary)
        .args(["--session", &session, "close"])
        .output();
}
