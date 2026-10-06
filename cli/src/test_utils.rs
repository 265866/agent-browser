use std::sync::{Mutex, MutexGuard};

/// Global mutex shared across all test modules to prevent parallel tests from
/// interfering with each other when mutating environment variables.
pub static ENV_MUTEX: Mutex<()> = Mutex::new(());

const STATE_HOME: &str = "AGENT_BROWSER_HOME";
const SOCKET_DIR: &str = "AGENT_BROWSER_SOCKET_DIR";

/// RAII guard that locks [`ENV_MUTEX`] and restores environment variables on drop.
///
/// Most tests never take the lock and run in parallel with its holder, reading
/// the process environment whenever they resolve a path. A guard therefore
/// never lets state fall back to the user's real `~/.agent-browser` while the
/// process has a temporary `AGENT_BROWSER_HOME` (see `test_home.rs`, or the
/// one local CI sets per job): it refuses to clear `AGENT_BROWSER_HOME`, and clears
/// `AGENT_BROWSER_SOCKET_DIR` only while `AGENT_BROWSER_HOME` is set. Tests of
/// the default location use the pure resolvers instead.
pub struct EnvGuard<'a> {
    _lock: MutexGuard<'a, ()>,
    vars: Vec<(String, Option<String>)>,
}

impl<'a> EnvGuard<'a> {
    pub fn new(var_names: &[&str]) -> Self {
        let lock = ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let vars = var_names
            .iter()
            .map(|&name| (name.to_string(), std::env::var(name).ok()))
            .collect();
        Self { _lock: lock, vars }
    }

    pub fn set(&self, name: &str, value: &str) {
        debug_assert!(
            self.vars.iter().any(|(n, _)| n == name),
            "EnvGuard::set called with unregistered var: {name}"
        );
        if value.is_empty() {
            assert_may_clear(name);
        }
        std::env::set_var(name, value);
    }

    pub fn remove(&self, name: &str) {
        debug_assert!(
            self.vars.iter().any(|(n, _)| n == name),
            "EnvGuard::remove called with unregistered var: {name}"
        );
        assert_may_clear(name);
        std::env::remove_var(name);
    }
}

/// Empty values count as unset for both variables, so blanking one is
/// clearing it.
fn assert_may_clear(name: &str) {
    let state_home = std::env::var(STATE_HOME).ok().filter(|v| !v.is_empty());
    if let Some(message) = clearing_error(name, state_home.is_some()) {
        panic!("{message}");
    }
}

fn clearing_error(name: &str, state_home_set: bool) -> Option<String> {
    match name {
        STATE_HOME => Some(format!(
            "tests must not clear {STATE_HOME}: tests running at the same time would write the \
             user's real ~/.agent-browser. Point it at a temporary directory, or test the \
             resolver without the process environment."
        )),
        SOCKET_DIR if !state_home_set => Some(format!(
            "set {STATE_HOME} to a temporary directory before clearing {SOCKET_DIR}: tests \
             running at the same time would write socket files into the user's real \
             ~/.agent-browser."
        )),
        _ => None,
    }
}

impl Drop for EnvGuard<'_> {
    fn drop(&mut self) {
        for (name, value) in restore_order(&self.vars) {
            RESTORED.with(|log| log.borrow_mut().push(name.clone()));
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }
}

thread_local! {
    /// Names the guards dropped on this thread restored, in order.
    static RESTORED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Values to restore come before variables to remove, so the state directory
/// is never left at its default in between (for example while a restored
/// AGENT_BROWSER_SOCKET_DIR replaces a temporary AGENT_BROWSER_HOME).
fn restore_order(vars: &[(String, Option<String>)]) -> Vec<&(String, Option<String>)> {
    let (restore, remove): (Vec<_>, Vec<_>) = vars.iter().partition(|(_, value)| value.is_some());
    restore.into_iter().chain(remove).collect()
}

/// Creates an executable test fixture at `path` that is safe to exec while
/// other test threads spawn processes.
///
/// A child `/bin/sh` writes the file, so this process never holds a writable
/// descriptor to it. A child forked by another test thread inherits every open
/// descriptor until it execs, and on Linux exec of a file that is still open
/// for writing anywhere fails with ETXTBSY ("Text file busy").
#[cfg(unix)]
pub fn write_executable(path: &std::path::Path, contents: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut writer = Command::new("/bin/sh")
        .args(["-c", r#"cat > "$1" && chmod 755 "$1""#, "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    writer
        .stdin
        .take()
        .unwrap()
        .write_all(contents.as_bytes())
        .unwrap();
    let status = writer.wait().unwrap();
    assert!(
        status.success(),
        "writing {} failed: {status}",
        path.display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_home::home_candidates;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const HOME_REPORT: &str = "AGENT_BROWSER_TEST_HOME_REPORT";

    #[test]
    fn test_homes_never_resolve_against_the_working_directory() {
        for temp_dir in ["", "relative", "relative/dir"] {
            let candidates = home_candidates(Path::new(temp_dir), "ab-test-1");
            assert!(
                candidates.iter().all(|home| home.is_absolute()),
                "{temp_dir:?}: {candidates:?}"
            );
            if cfg!(unix) {
                assert_eq!(candidates, [PathBuf::from("/tmp/ab-test-1")]);
            } else {
                assert!(candidates.is_empty(), "{candidates:?}");
            }
        }
        let temp = std::env::temp_dir();
        assert_eq!(
            home_candidates(&temp, "ab-test-1")[0],
            temp.join("ab-test-1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_homes_leave_room_for_socket_paths() {
        let long = Path::new("/var/folders/ab/cdefghijklmnopqrstuvwxyz0000gn/T");
        assert_eq!(
            home_candidates(long, "ab-test-1"),
            [PathBuf::from("/tmp/ab-test-1")]
        );
    }

    /// Runs in a child process started by the tests below; reports the home
    /// that process got.
    #[test]
    #[ignore = "internal subprocess helper"]
    fn report_test_home_helper() {
        let home = std::env::var("AGENT_BROWSER_HOME").unwrap();
        std::fs::write(std::env::var_os(HOME_REPORT).unwrap(), &home).unwrap();
        std::fs::write(Path::new(&home).join("state.json"), "{}").unwrap();
    }

    fn run_home_helper(report: &Path, home: Option<&Path>) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "test_utils::tests::report_test_home_helper",
                "--ignored",
                "--quiet",
            ])
            .env(HOME_REPORT, report)
            .stdout(std::process::Stdio::null());
        match home {
            Some(home) => command.env(STATE_HOME, home),
            None => command.env_remove(STATE_HOME),
        };
        let status = command.status().unwrap();
        assert!(status.success());
    }

    #[test]
    fn a_test_process_removes_the_home_it_created() {
        let dir = tempfile::tempdir().unwrap();
        let report = dir.path().join("home.txt");
        run_home_helper(&report, None);
        let created = PathBuf::from(std::fs::read_to_string(&report).unwrap());
        assert!(created.is_absolute(), "{}", created.display());
        assert!(!created.exists(), "{} was left behind", created.display());
    }

    #[test]
    fn a_test_process_keeps_a_home_it_did_not_create() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("given-home");
        std::fs::create_dir(&home).unwrap();
        let report = dir.path().join("home.txt");
        run_home_helper(&report, Some(&home));
        assert_eq!(
            std::fs::read_to_string(&report).unwrap(),
            home.to_str().unwrap()
        );
        assert!(home.join("state.json").exists());
    }

    /// Integration test binaries get the temporary home only through
    /// `tests/common`.
    #[test]
    fn every_integration_test_declares_mod_common() {
        let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
        let mut checked = 0;
        for entry in std::fs::read_dir(&tests).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "rs") {
                let source = std::fs::read_to_string(&path).unwrap();
                assert!(
                    source.lines().any(|line| line.trim() == "mod common;"),
                    "{} must declare `mod common;` so its CLIs get a temporary home",
                    path.display()
                );
                checked += 1;
            }
        }
        assert!(checked > 0);
    }

    #[test]
    #[should_panic(expected = "must not clear AGENT_BROWSER_HOME")]
    fn refuses_to_remove_the_state_home() {
        EnvGuard::new(&[STATE_HOME]).remove(STATE_HOME);
    }

    #[test]
    #[should_panic(expected = "must not clear AGENT_BROWSER_HOME")]
    fn refuses_to_blank_the_state_home() {
        EnvGuard::new(&[STATE_HOME]).set(STATE_HOME, "");
    }

    #[test]
    fn clears_the_socket_dir_under_a_temporary_state_home() {
        let home = tempfile::tempdir().unwrap();
        let guard = EnvGuard::new(&[STATE_HOME, SOCKET_DIR]);
        guard.set(STATE_HOME, home.path().to_str().unwrap());
        guard.remove(SOCKET_DIR);
        guard.set(SOCKET_DIR, "");
        assert_eq!(
            std::env::var(STATE_HOME).unwrap(),
            home.path().to_str().unwrap()
        );
    }

    #[test]
    fn drop_restores_values_before_removing_variables() {
        const UNSET: &str = "AGENT_BROWSER_TEST_RESTORE_ORDER_UNSET";
        const SET: &str = "AGENT_BROWSER_TEST_RESTORE_ORDER_SET";
        // Only this test uses these names, so setting one outside the guard
        // cannot affect another test.
        std::env::set_var(SET, "original");
        let guard = EnvGuard::new(&[UNSET, SET]);
        guard.set(UNSET, "temporary");
        guard.set(SET, "temporary");
        RESTORED.with(|log| log.borrow_mut().clear());

        drop(guard);

        let restored = RESTORED.with(|log| log.borrow().clone());
        assert_eq!(restored, [SET, UNSET]);
        assert_eq!(std::env::var(SET).unwrap(), "original");
        assert!(std::env::var_os(UNSET).is_none());
        std::env::remove_var(SET);
    }

    #[test]
    fn socket_dir_is_cleared_only_while_a_state_home_is_set() {
        assert!(clearing_error(SOCKET_DIR, true).is_none());
        assert!(clearing_error(SOCKET_DIR, false)
            .is_some_and(|message| message.contains("before clearing AGENT_BROWSER_SOCKET_DIR")));
        assert!(clearing_error(STATE_HOME, true).is_some());
        assert!(clearing_error("AGENT_BROWSER_SESSION", false).is_none());
    }
}
