//! Check the local environment: CLI version, platform, state/socket dirs,
//! and free disk space.

use std::path::Path;

use super::helpers::{disk_free_bytes, human_size, is_writable_dir};
use super::{Check, Status};
use crate::connection::get_socket_dir;
use crate::native::state::get_state_dir;

pub(super) fn check(checks: &mut Vec<Check>) {
    let category = "Environment";

    let version = env!("CARGO_PKG_VERSION");
    let platform = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    checks.push(Check::new(
        "env.version",
        category,
        Status::Pass,
        format!("CLI version {} ({})", version, platform),
    ));

    match dirs::home_dir() {
        Some(home) => checks.push(Check::new(
            "env.home",
            category,
            Status::Pass,
            format!("Home directory {}", home.display()),
        )),
        None => checks.push(Check::new(
            "env.home",
            category,
            Status::Fail,
            "Could not determine home directory",
        )),
    }

    let state_dir = get_state_dir();
    let socket_dir = get_socket_dir();

    // Without a namespace, socket files default to the state directory.
    // Collapse to a single line when they match; split when XDG_RUNTIME_DIR
    // or AGENT_BROWSER_SOCKET_DIR diverts sockets elsewhere.
    if state_dir == socket_dir {
        push_dir_check(
            checks,
            "env.state_dir",
            category,
            "State and socket directory",
            &state_dir,
        );
    } else {
        push_dir_check(
            checks,
            "env.state_dir",
            category,
            "State directory",
            &state_dir,
        );
        push_dir_check(
            checks,
            "env.socket_dir",
            category,
            "Socket directory",
            &socket_dir,
        );
    }

    if let Some(unused) = crate::paths::unused_state_dir() {
        let in_use = crate::paths::state_dir();
        checks.push(
            Check::new(
                "env.state_dir_conflict",
                category,
                Status::Warn,
                format!(
                    "Both {} and {} exist; agent-browser uses {}, so sessions and auth profiles in {} are not visible",
                    in_use.display(),
                    unused.display(),
                    in_use.display(),
                    unused.display()
                ),
            )
            .with_fix(format!(
                "move what you need from {} into {}, then remove {}",
                unused.display(),
                in_use.display(),
                unused.display()
            )),
        );
    }

    match disk_free_bytes(&state_dir) {
        Some(bytes) => {
            let mb = bytes / (1024 * 1024);
            let human = human_size(bytes);
            if mb < 500 {
                checks.push(
                    Check::new(
                        "env.disk_free",
                        category,
                        Status::Warn,
                        format!("Low disk space at state dir: {} free", human),
                    )
                    .with_fix("free up disk space; Chrome installs require ~500 MB"),
                );
            } else {
                checks.push(Check::new(
                    "env.disk_free",
                    category,
                    Status::Pass,
                    format!("{} free at state dir", human),
                ));
            }
        }
        None => checks.push(Check::new(
            "env.disk_free",
            category,
            Status::Info,
            "Disk free check unavailable on this platform",
        )),
    }
}

fn push_dir_check(
    checks: &mut Vec<Check>,
    id: &'static str,
    category: &'static str,
    label: &str,
    dir: &Path,
) {
    if dir.exists() {
        if is_writable_dir(dir) {
            checks.push(Check::new(
                id,
                category,
                Status::Pass,
                format!("{} {}", label, dir.display()),
            ));
        } else {
            checks.push(
                Check::new(
                    id,
                    category,
                    Status::Fail,
                    format!("{} not writable: {}", label, dir.display()),
                )
                .with_fix(format!("chmod u+rwx {}", dir.display())),
            );
        }
    } else {
        checks.push(Check::new(
            id,
            category,
            Status::Info,
            format!(
                "{} does not exist yet (will be created on first use): {}",
                label,
                dir.display()
            ),
        ));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn warns_when_legacy_and_xdg_state_dirs_both_exist() {
        let guard = crate::test_utils::EnvGuard::new(&[
            "HOME",
            "AGENT_BROWSER_HOME",
            "AGENT_BROWSER_NAMESPACE",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
        ]);
        let home = tempfile::tempdir().unwrap();
        for name in [
            "AGENT_BROWSER_HOME",
            "AGENT_BROWSER_NAMESPACE",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
        ] {
            guard.remove(name);
        }
        guard.set("HOME", home.path().to_str().unwrap());
        let legacy = home.path().join(".agent-browser");
        let xdg_state = home.path().join("state");
        guard.set("XDG_STATE_HOME", xdg_state.to_str().unwrap());
        std::fs::create_dir_all(&legacy).unwrap();

        let mut checks = Vec::new();
        check(&mut checks);
        assert!(!checks.iter().any(|c| c.id == "env.state_dir_conflict"));

        std::fs::create_dir_all(xdg_state.join("agent-browser")).unwrap();
        let mut checks = Vec::new();
        check(&mut checks);
        let conflict = checks
            .iter()
            .find(|c| c.id == "env.state_dir_conflict")
            .expect("conflict warning");
        assert_eq!(conflict.status, Status::Warn);
        let unused = legacy.display().to_string();
        let in_use = xdg_state.join("agent-browser").display().to_string();
        assert!(conflict.message.contains(&unused), "{}", conflict.message);
        assert!(conflict.message.contains(&in_use), "{}", conflict.message);
    }
}
