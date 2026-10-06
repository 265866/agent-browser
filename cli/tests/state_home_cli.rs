//! Integration tests for `AGENT_BROWSER_HOME`.
//!
//! These spawn the real CLI with `AGENT_BROWSER_HOME` pointing at a temp
//! directory and a separate fake `HOME` / `USERPROFILE`, then check that every
//! file agent-browser reads or writes for itself lands under the override.
//! Read-only checks run first so a binary that ignores the override fails
//! before it writes anything to the real home directory (Windows resolves the
//! home directory from the user profile, not from `USERPROFILE`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_agent-browser");

const CLEARED_ENV: &[&str] = &[
    "AGENT_BROWSER_SOCKET_DIR",
    "AGENT_BROWSER_NAMESPACE",
    "AGENT_BROWSER_SESSION",
    "AGENT_BROWSER_CONFIG",
    "AGENT_BROWSER_ENCRYPTION_KEY",
    "AGENT_BROWSER_PROVIDER",
    "AGENT_BROWSER_CDP",
    "AGENT_BROWSER_PLUGINS",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
];

struct Sandbox {
    tmp: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let sandbox = Self {
            tmp: TempDir::new().unwrap(),
        };
        std::fs::create_dir_all(sandbox.fake_home()).unwrap();
        std::fs::create_dir_all(sandbox.work_dir()).unwrap();
        sandbox
    }

    fn fake_home(&self) -> PathBuf {
        self.tmp.path().join("home")
    }

    fn agent_home(&self) -> PathBuf {
        self.tmp.path().join("agent-home")
    }

    fn work_dir(&self) -> PathBuf {
        self.tmp.path().join("work")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(BIN);
        cmd.args(args)
            .current_dir(self.work_dir())
            .env("AGENT_BROWSER_HOME", self.agent_home())
            .env("HOME", self.fake_home())
            .env("USERPROFILE", self.fake_home())
            .env("NO_COLOR", "1");
        for name in CLEARED_ENV {
            cmd.env_remove(name);
        }
        cmd
    }

    fn run_json(&self, args: &[&str]) -> serde_json::Value {
        let output = self
            .command(args)
            .output()
            .expect("failed to run agent-browser");
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr);
        serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
            panic!(
                "{:?} did not print JSON ({}), exit {:?}\nstdout:\n{}\nstderr:\n{}",
                args,
                e,
                output.status.code(),
                stdout,
                stderr
            )
        })
    }
}

fn assert_same_path(actual: &serde_json::Value, expected: &Path, what: &str) {
    let actual = actual
        .as_str()
        .unwrap_or_else(|| panic!("{} missing from output", what));
    assert_eq!(
        PathBuf::from(actual),
        expected,
        "{} should resolve under AGENT_BROWSER_HOME",
        what
    );
}

#[test]
fn agent_browser_home_owns_state_sockets_config_and_key() {
    let sandbox = Sandbox::new();
    let agent_home = sandbox.agent_home();

    let state = sandbox.run_json(&["--json", "state", "list"]);
    assert_same_path(
        &state["data"]["directory"],
        &agent_home.join("sessions"),
        "sessions directory",
    );

    let session = sandbox.run_json(&["--json", "session", "info"]);
    assert_same_path(&session["data"]["socketDir"], &agent_home, "socket dir");

    let added = sandbox.run_json(&[
        "plugin",
        "add",
        "agent-browser-home-test-plugin",
        "--capability",
        "browser.launch",
        "--no-manifest",
        "--global",
        "--json",
    ]);
    assert_eq!(added["success"], true, "plugin add failed: {}", added);
    assert_same_path(
        &added["configPath"],
        &agent_home.join("config.json"),
        "global config path",
    );

    let listed = sandbox.run_json(&["plugin", "list", "--json"]);
    let listed_text = listed.to_string();
    assert!(
        listed_text.contains("agent-browser-home-test-plugin"),
        "user config under AGENT_BROWSER_HOME should be loaded: {}",
        listed_text
    );

    let doctor = sandbox.run_json(&["doctor", "--offline", "--quick", "--fix", "--json"]);
    assert!(
        agent_home.join(".encryption-key").is_file(),
        "doctor --fix should create the key under AGENT_BROWSER_HOME: {}",
        doctor
    );

    let leaked: Vec<_> = std::fs::read_dir(sandbox.fake_home())
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(
        leaked.is_empty(),
        "nothing should be written under HOME when AGENT_BROWSER_HOME is set: {:?}",
        leaked
    );
}

#[test]
fn mcp_plugin_add_global_writes_under_agent_browser_home() {
    let sandbox = Sandbox::new();
    let requests = [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "state-home-test", "version": "0" }
            }
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "agent_browser_plugin_add",
                "arguments": {
                    "reference": "agent-browser-home-mcp-plugin",
                    "capabilities": ["browser.launch"],
                    "noManifest": true,
                    "global": true
                }
            }
        }),
    ];

    let mut child = sandbox
        .command(&["mcp", "--tools", "debug"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to start agent-browser mcp");
    {
        let mut stdin = child.stdin.take().unwrap();
        for request in &requests {
            writeln!(stdin, "{}", request).unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let call = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|message| message["id"] == 2)
        .unwrap_or_else(|| {
            panic!(
                "no tools/call response in:
{}",
                stdout
            )
        });
    let result = &call["result"];
    assert_eq!(result["isError"], false, "plugin add failed: {}", call);
    assert_same_path(
        &result["structuredContent"]["response"]["configPath"],
        &sandbox.agent_home().join("config.json"),
        "MCP global config path",
    );
    assert!(
        std::fs::read_to_string(sandbox.agent_home().join("config.json"))
            .unwrap()
            .contains("agent-browser-home-mcp-plugin")
    );
}
