//! Gives every test process its own agent-browser state directory.
//!
//! Compiled into the unit-test binary and, through `tests/common`, into each
//! integration test. When the environment does not already name a state
//! directory, the process gets `AGENT_BROWSER_HOME` pointing at a new
//! directory under the system temp directory, and removes it when it exits.
//! Tests resolve paths from the process environment, and every CLI, daemon,
//! and helper process a test spawns inherits it, so no test reads or writes
//! the developer's real `~/.agent-browser`.

use std::fs::create_dir_all;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const STATE_HOME: &str = "AGENT_BROWSER_HOME";

/// Unix socket paths hold at most 103 bytes on macOS (104 with the NUL; Linux
/// allows 107). Sockets default into the state directory, as
/// `<home>/namespaces/<namespace>/run/<session>.sock`, and this leaves 60
/// bytes for everything after `<home>`.
#[cfg(unix)]
const MAX_HOME_LEN: usize = 103 - 60;

/// The home this process created and the id of that process. Children
/// inherit the variable but not this record, so only the creator removes it.
static CREATED: OnceLock<(PathBuf, u32)> = OnceLock::new();

/// Runs before `main`, while the process still has a single thread, so setting
/// the variable cannot race with a test reading the environment. An explicit,
/// non-empty `AGENT_BROWSER_HOME` (set by the user, local CI, or a parent test
/// process) is kept and never removed.
#[ctor::ctor(unsafe)]
fn isolate_state_home() {
    if std::env::var_os(STATE_HOME).is_some_and(|value| !value.is_empty()) {
        return;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos() as u64);
    let name = format!("ab-test-{}-{:x}", std::process::id(), nanos);
    let candidates = home_candidates(&std::env::temp_dir(), &name);
    let Some(home) = candidates.iter().find(|home| create_dir_all(home).is_ok()) else {
        // Without its own home a test would use the developer's real one.
        eprintln!(
            "agent-browser tests: cannot create a temporary {STATE_HOME} at any of {candidates:?}"
        );
        std::process::exit(1);
    };
    std::env::set_var(STATE_HOME, home);
    let _ = CREATED.set((home.clone(), std::process::id()));
}

/// Removes the home this process created, best effort: a daemon a test left
/// running may still hold files in it, and on Windows a test binary with
/// failures exits through `ExitProcess`, which skips this hook.
#[dtor::dtor(unsafe)]
fn remove_state_home() {
    if let Some((home, creator)) = CREATED.get() {
        if *creator == std::process::id() {
            let _ = std::fs::remove_dir_all(home);
        }
    }
}

/// Where to create a home named `name`, in order of preference. The temp
/// directory comes first if it is absolute (a relative or empty `TMPDIR`
/// would resolve against each process's own working directory) and, on Unix,
/// short enough for socket paths (the macOS default is not). Unix then falls
/// back to `/tmp`.
pub(crate) fn home_candidates(temp_dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let preferred = temp_dir.join(name);
    #[cfg(unix)]
    let fits = preferred.as_os_str().len() <= MAX_HOME_LEN;
    #[cfg(not(unix))]
    let fits = true;
    if temp_dir.is_absolute() && fits {
        candidates.push(preferred);
    }
    #[cfg(unix)]
    candidates.push(Path::new("/tmp").join(name));
    candidates
}
