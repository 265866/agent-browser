//! Integration tests for `AGENT_BROWSER_HOME`.
//!
//! These spawn the real CLI with `AGENT_BROWSER_HOME` pointing at a temp
//! directory and a separate fake `HOME` / `USERPROFILE`, then check that every
//! file agent-browser reads or writes for itself lands under the override.
//! Read-only path checks run first in each test, so a binary that ignores the
//! override fails before it writes anything to the real home directory
//! (Windows resolves the home directory from the user profile, not from
//! `USERPROFILE`). No browser is needed: `auth save` runs in the daemon
//! without launching one.
//!
//! Output goes to files rather than pipes because a daemon spawned by the CLI
//! can inherit the pipe handles and keep them open after the CLI exits.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
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

static OUTPUT_ID: AtomicUsize = AtomicUsize::new(0);

struct Sandbox {
    tmp: TempDir,
    runtime_dir: Option<PathBuf>,
}

impl Sandbox {
    fn new() -> Self {
        Self::with_runtime_dir(None)
    }

    fn with_runtime_dir(runtime_dir: Option<&Path>) -> Self {
        let sandbox = Self {
            tmp: TempDir::new().unwrap(),
            runtime_dir: runtime_dir.map(Path::to_path_buf),
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
        if let Some(runtime_dir) = &self.runtime_dir {
            cmd.env("XDG_RUNTIME_DIR", runtime_dir);
        }
        cmd
    }

    fn run_json(&self, args: &[&str]) -> serde_json::Value {
        self.run_json_with_stdin(args, None)
    }

    fn run_json_with_stdin(&self, args: &[&str], stdin: Option<&str>) -> serde_json::Value {
        run_json(self.command(args), self.tmp.path(), stdin)
    }

    fn auth_save(&self, profile: &str) -> serde_json::Value {
        self.run_json_with_stdin(
            &[
                "--json",
                "auth",
                "save",
                profile,
                "--url",
                "https://example.com/login",
                "--username",
                "user",
                "--password-stdin",
            ],
            Some("secret\n"),
        )
    }

    /// Fail before anything is written if the binary ignores the override.
    fn assert_sessions_dir_is_overridden(&self) {
        let state = self.run_json(&["--json", "state", "list"]);
        assert_same_path(
            &state["data"]["directory"],
            &self.agent_home().join("sessions"),
            "sessions directory",
        );
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = self
            .command(&["close", "--all"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Run a CLI command and parse its stdout as JSON. Output goes to files under
/// `scratch` rather than pipes (see the module comment).
fn run_json(mut command: Command, scratch: &Path, stdin: Option<&str>) -> serde_json::Value {
    let id = OUTPUT_ID.fetch_add(1, Ordering::Relaxed);
    let out_path = scratch.join(format!("out-{}.txt", id));
    let err_path = scratch.join(format!("err-{}.txt", id));
    let description = format!("{:?}", command.get_args().collect::<Vec<_>>());
    let mut child = command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(std::fs::File::create(&out_path).unwrap())
        .stderr(std::fs::File::create(&err_path).unwrap())
        .spawn()
        .expect("failed to run agent-browser");
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    let status = child.wait().unwrap();
    let stdout = std::fs::read_to_string(&out_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
    serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
        panic!(
            "{} did not print JSON ({}), exit {:?}\nstdout:\n{}\nstderr:\n{}",
            description,
            e,
            status.code(),
            stdout,
            stderr
        )
    })
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

fn assert_success(response: &serde_json::Value, what: &str) {
    assert_eq!(response["success"], true, "{} failed: {}", what, response);
}

#[test]
fn agent_browser_home_owns_state_sockets_config_and_key() {
    let sandbox = Sandbox::new();
    let agent_home = sandbox.agent_home();

    sandbox.assert_sessions_dir_is_overridden();

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
    assert_success(&added, "plugin add");
    assert_same_path(
        &added["configPath"],
        &agent_home.join("config.json"),
        "global config path",
    );

    let listed = sandbox.run_json(&["plugin", "list", "--json"]);
    assert!(
        listed
            .to_string()
            .contains("agent-browser-home-test-plugin"),
        "user config under AGENT_BROWSER_HOME should be loaded: {}",
        listed
    );

    let saved = sandbox.auth_save("home-profile");
    assert_success(&saved, "auth save");
    assert!(
        agent_home.join("auth").join("home-profile.json").is_file(),
        "auth profile should be saved under AGENT_BROWSER_HOME"
    );
    assert!(
        agent_home.join(".encryption-key").is_file(),
        "auth save should create the key under AGENT_BROWSER_HOME"
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

/// `XDG_RUNTIME_DIR` is shared by every process of the user. Two homes must
/// still get separate daemons, or the second home's commands run in the first
/// home's daemon and write its files.
#[cfg(unix)]
#[test]
fn homes_sharing_xdg_runtime_dir_use_separate_daemons() {
    // Keep socket paths short enough for the Unix socket length limit.
    let runtime = tempfile::Builder::new()
        .prefix("abrt")
        .tempdir_in("/tmp")
        .unwrap();
    let first = Sandbox::with_runtime_dir(Some(runtime.path()));
    let second = Sandbox::with_runtime_dir(Some(runtime.path()));
    first.assert_sessions_dir_is_overridden();
    second.assert_sessions_dir_is_overridden();

    assert_success(&first.auth_save("first-profile"), "first auth save");
    assert_success(&second.auth_save("second-profile"), "second auth save");

    let first_auth = first.agent_home().join("auth");
    let second_auth = second.agent_home().join("auth");
    assert!(first_auth.join("first-profile.json").is_file());
    assert!(second_auth.join("second-profile.json").is_file());
    assert!(!first_auth.join("second-profile.json").exists());
    assert!(!second_auth.join("first-profile.json").exists());
}

/// An XDG install must stay on the XDG layout after one run without the XDG
/// variables (cron, an IDE's MCP client) creates `~/.agent-browser`.
#[cfg(unix)]
#[test]
fn xdg_install_survives_a_run_without_xdg_vars() {
    struct Env {
        tmp: TempDir,
        runtime: TempDir,
    }
    impl Env {
        fn path(&self, name: &str) -> PathBuf {
            self.tmp.path().join(name)
        }
        fn command(&self, args: &[&str], xdg: bool) -> Command {
            let mut cmd = Command::new(BIN);
            cmd.args(args)
                .current_dir(self.tmp.path())
                .env("HOME", self.path("home"))
                .env_remove("AGENT_BROWSER_HOME")
                .env("NO_COLOR", "1");
            for name in CLEARED_ENV {
                cmd.env_remove(name);
            }
            if xdg {
                cmd.env("XDG_CONFIG_HOME", self.path("xc"))
                    .env("XDG_STATE_HOME", self.path("xs"))
                    .env("XDG_DATA_HOME", self.path("xd"))
                    .env("XDG_CACHE_HOME", self.path("xx"))
                    .env("XDG_RUNTIME_DIR", self.runtime.path());
            }
            cmd
        }
        fn run(&self, args: &[&str], xdg: bool) -> serde_json::Value {
            run_json(self.command(args, xdg), self.tmp.path(), None)
        }
    }
    impl Drop for Env {
        fn drop(&mut self) {
            for xdg in [true, false] {
                let _ = self
                    .command(&["close", "--all"], xdg)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }

    let env = Env {
        tmp: TempDir::new().unwrap(),
        runtime: tempfile::Builder::new()
            .prefix("abrt")
            .tempdir_in("/tmp")
            .unwrap(),
    };
    std::fs::create_dir_all(env.path("home")).unwrap();

    let added = env.run(
        &[
            "plugin",
            "add",
            "flip-plugin",
            "--capability",
            "browser.launch",
            "--no-manifest",
            "--global",
            "--json",
        ],
        true,
    );
    assert_success(&added, "plugin add");
    assert_same_path(
        &added["configPath"],
        &env.path("xc/agent-browser/config.json"),
        "XDG config path",
    );
    assert_success(&env.run(&["--json", "auth", "list"], true), "auth list");
    assert!(
        env.path("xs/agent-browser").is_dir(),
        "starting a daemon should create the XDG state directory"
    );
    let socket_dir = env.run(&["--json", "session", "info"], true)["data"]["socketDir"].clone();

    assert_success(
        &env.run(&["--json", "auth", "list"], false),
        "plain auth list",
    );
    assert!(env.path("home/.agent-browser").is_dir());

    let state = env.run(&["--json", "state", "list"], true);
    assert_same_path(
        &state["data"]["directory"],
        &env.path("xs/agent-browser/sessions"),
        "sessions directory after ~/.agent-browser appeared",
    );
    let session = env.run(&["--json", "session", "info"], true);
    assert_eq!(session["data"]["socketDir"], socket_dir, "socket dir moved");
    let listed = env.run(&["plugin", "list", "--json"], true);
    assert!(
        listed.to_string().contains("flip-plugin"),
        "XDG user config should still be loaded: {}",
        listed
    );
}

#[test]
fn mcp_plugin_add_global_writes_under_agent_browser_home() {
    let sandbox = Sandbox::new();
    sandbox.assert_sessions_dir_is_overridden();

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
        .unwrap_or_else(|| panic!("no tools/call response in:\n{}", stdout));
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
