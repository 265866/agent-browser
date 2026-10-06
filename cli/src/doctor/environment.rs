//! Check the local environment: CLI version, platform, state/socket dirs,
//! and free disk space.

use std::path::{Path, PathBuf};

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

    checks.extend(state_dir_conflict(category, &crate::paths::unused_files()));

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

/// Warn about agent-browser files in the directory layout not in use, which
/// stay invisible until they are moved. `unused` pairs each with its path in
/// the layout in use.
fn state_dir_conflict(category: &'static str, unused: &[(PathBuf, PathBuf)]) -> Option<Check> {
    if unused.is_empty() {
        return None;
    }
    let moves = unused
        .iter()
        .map(|(from, to)| format!("{} -> {}", from.display(), to.display()))
        .collect::<Vec<_>>()
        .join(", ");
    Some(
        Check::new(
            "env.state_dir_conflict",
            category,
            Status::Warn,
            format!(
                "agent-browser files from the directory layout not in use are ignored: {}",
                unused
                    .iter()
                    .map(|(from, _)| from.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_fix(format!(
            "move what you still need (from -> to): {} (see Data Directory in the docs)",
            moves
        )),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_when_the_unused_layout_holds_agent_browser_files() {
        assert!(state_dir_conflict("Environment", &[]).is_none());

        let unused = PathBuf::from("legacy").join("sessions");
        let target = PathBuf::from("state")
            .join("agent-browser")
            .join("sessions");
        let conflict = state_dir_conflict("Environment", &[(unused.clone(), target.clone())])
            .expect("conflict warning");

        assert_eq!(conflict.id, "env.state_dir_conflict");
        assert_eq!(conflict.status, Status::Warn);
        assert!(
            conflict.message.contains(&unused.display().to_string()),
            "{}",
            conflict.message
        );
        let fix = conflict.fix.as_deref().unwrap_or("");
        assert!(!fix.contains("remove"));
        assert!(
            fix.contains(&format!("{} -> {}", unused.display(), target.display())),
            "{}",
            fix
        );
    }
}
