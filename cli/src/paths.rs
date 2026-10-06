//! Where agent-browser keeps its own files: user config, sessions, auth
//! profiles, the encryption key, installed browsers, default artifact output,
//! and socket files when no socket or runtime directory is configured.
//!
//! Resolution order:
//! 1. `AGENT_BROWSER_HOME`, on every platform. It replaces `~/.agent-browser`
//!    and keeps the same layout inside.
//! 2. `~/.agent-browser` when it already exists, so upgrading never strands
//!    existing sessions, auth profiles, installed browsers, or the key.
//! 3. Outside Windows, the XDG base directories when the user has set any
//!    of `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, or
//!    `XDG_CACHE_HOME`. Unset ones fall back to their spec defaults.
//! 4. `~/.agent-browser`.

use std::env;
use std::path::{Path, PathBuf};

const HOME_ENV: &str = "AGENT_BROWSER_HOME";
const LEGACY_DIR: &str = ".agent-browser";
const APP_DIR: &str = "agent-browser";

#[derive(Debug, PartialEq, Eq)]
enum Layout {
    /// Everything lives in one directory, like `~/.agent-browser`.
    Single(PathBuf),
    /// Each kind of file lives under its XDG base directory.
    Xdg {
        config: PathBuf,
        state: PathBuf,
        data: PathBuf,
        cache: PathBuf,
    },
}

impl Layout {
    fn current() -> Self {
        Self::resolve(
            |name| env::var(name).ok(),
            dirs::home_dir().as_deref(),
            !cfg!(windows),
        )
    }

    fn resolve(var: impl Fn(&str) -> Option<String>, home: Option<&Path>, allow_xdg: bool) -> Self {
        let set = |name: &str| var(name).filter(|value| !value.is_empty());

        if let Some(root) = set(HOME_ENV) {
            let root = PathBuf::from(root);
            // A relative override must not resolve differently in the CLI and
            // in a daemon started from another directory.
            return Self::Single(std::path::absolute(&root).unwrap_or(root));
        }

        let Some(home) = home else {
            return Self::Single(env::temp_dir().join(APP_DIR));
        };
        let legacy = home.join(LEGACY_DIR);
        if !allow_xdg || legacy.exists() {
            return Self::Single(legacy);
        }

        // The spec says relative values are invalid and must be ignored.
        let base = |name: &str| {
            set(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let config = base("XDG_CONFIG_HOME");
        let state = base("XDG_STATE_HOME");
        let data = base("XDG_DATA_HOME");
        let cache = base("XDG_CACHE_HOME");
        if config.is_none() && state.is_none() && data.is_none() && cache.is_none() {
            return Self::Single(legacy);
        }

        Self::Xdg {
            config: config.unwrap_or_else(|| home.join(".config")).join(APP_DIR),
            state: state
                .unwrap_or_else(|| home.join(".local").join("state"))
                .join(APP_DIR),
            data: data
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join(APP_DIR),
            cache: cache.unwrap_or_else(|| home.join(".cache")).join(APP_DIR),
        }
    }

    fn config(&self) -> &Path {
        match self {
            Self::Single(root) => root,
            Self::Xdg { config, .. } => config,
        }
    }

    fn state(&self) -> &Path {
        match self {
            Self::Single(root) => root,
            Self::Xdg { state, .. } => state,
        }
    }

    fn data(&self) -> &Path {
        match self {
            Self::Single(root) => root,
            Self::Xdg { data, .. } => data,
        }
    }

    fn artifacts(&self) -> PathBuf {
        match self {
            Self::Single(root) => root.join("tmp"),
            Self::Xdg { cache, .. } => cache.clone(),
        }
    }
}

/// User-level `config.json`, the lowest-priority config file.
pub fn user_config_file() -> PathBuf {
    Layout::current().config().join("config.json")
}

/// Root for sessions, auth profiles, namespaces, and the encryption key,
/// before any `AGENT_BROWSER_NAMESPACE` scoping.
pub fn state_dir() -> PathBuf {
    Layout::current().state().to_path_buf()
}

pub fn auth_dir() -> PathBuf {
    state_dir().join("auth")
}

pub fn encryption_key_file() -> PathBuf {
    state_dir().join(".encryption-key")
}

/// Browsers installed by `agent-browser install`.
pub fn browsers_dir() -> PathBuf {
    Layout::current().data().join("browsers")
}

/// Parent of default output directories for screenshots, traces, profiles,
/// HAR files, and PDFs.
pub fn artifacts_dir() -> PathBuf {
    Layout::current().artifacts()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn resolve(vars: &[(&str, &str)], home: &Path, xdg: bool) -> Layout {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Layout::resolve(|name| vars.get(name).cloned(), Some(home), xdg)
    }

    fn abs(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:{}", path.replace('/', "\\")))
        } else {
            PathBuf::from(path)
        }
    }

    fn abs_str(path: &str) -> String {
        abs(path).to_string_lossy().into_owned()
    }

    #[test]
    fn defaults_to_legacy_dir_without_overrides() {
        let home = tempfile::tempdir().unwrap();
        let expected = Layout::Single(home.path().join(".agent-browser"));
        assert_eq!(resolve(&[], home.path(), true), expected);
        assert_eq!(resolve(&[], home.path(), false), expected);
    }

    #[test]
    fn agent_browser_home_wins_everywhere() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".agent-browser")).unwrap();
        let (root, state) = (abs_str("/srv/ab"), abs_str("/xdg/state"));
        let vars = [
            (HOME_ENV, root.as_str()),
            ("XDG_STATE_HOME", state.as_str()),
        ];
        for xdg in [true, false] {
            assert_eq!(
                resolve(&vars, home.path(), xdg),
                Layout::Single(abs("/srv/ab"))
            );
        }
    }

    #[test]
    fn relative_agent_browser_home_is_made_absolute() {
        let home = tempfile::tempdir().unwrap();
        let layout = resolve(&[(HOME_ENV, "rel-home")], home.path(), true);
        assert_eq!(
            layout,
            Layout::Single(env::current_dir().unwrap().join("rel-home"))
        );
    }

    #[test]
    fn empty_agent_browser_home_is_ignored() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(&[(HOME_ENV, "")], home.path(), false),
            Layout::Single(home.path().join(".agent-browser"))
        );
    }

    #[test]
    fn xdg_vars_select_xdg_layout_with_spec_defaults() {
        let home = tempfile::tempdir().unwrap();
        let state = abs_str("/xdg/state");
        let layout = resolve(&[("XDG_STATE_HOME", &state)], home.path(), true);
        assert_eq!(
            layout,
            Layout::Xdg {
                config: home.path().join(".config").join("agent-browser"),
                state: abs("/xdg/state").join("agent-browser"),
                data: home.path().join(".local/share").join("agent-browser"),
                cache: home.path().join(".cache").join("agent-browser"),
            }
        );
        assert_eq!(layout.artifacts(), home.path().join(".cache/agent-browser"));
    }

    #[test]
    fn existing_legacy_dir_wins_over_xdg() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".agent-browser")).unwrap();
        let config = abs_str("/xdg/config");
        assert_eq!(
            resolve(&[("XDG_CONFIG_HOME", &config)], home.path(), true),
            Layout::Single(home.path().join(".agent-browser"))
        );
    }

    #[test]
    fn xdg_vars_are_ignored_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let config = abs_str("/xdg/config");
        assert_eq!(
            resolve(&[("XDG_CONFIG_HOME", &config)], home.path(), false),
            Layout::Single(home.path().join(".agent-browser"))
        );
    }

    #[test]
    fn relative_xdg_vars_are_ignored() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(&[("XDG_CONFIG_HOME", "relative/config")], home.path(), true),
            Layout::Single(home.path().join(".agent-browser"))
        );
    }

    #[test]
    fn missing_home_falls_back_to_temp_dir() {
        assert_eq!(
            Layout::resolve(|_| None, None, true),
            Layout::Single(env::temp_dir().join("agent-browser"))
        );
    }

    #[test]
    fn every_location_follows_agent_browser_home() {
        let guard = crate::test_utils::EnvGuard::new(&[HOME_ENV]);
        let root = tempfile::tempdir().unwrap();
        guard.set(HOME_ENV, root.path().to_str().unwrap());

        let locations = [
            user_config_file(),
            state_dir(),
            auth_dir(),
            encryption_key_file(),
            browsers_dir(),
            artifacts_dir(),
        ];
        let real_legacy = dirs::home_dir().map(|home| home.join(".agent-browser"));
        for location in locations {
            assert!(
                location.starts_with(root.path()),
                "{} should be under AGENT_BROWSER_HOME",
                location.display()
            );
            if let Some(legacy) = &real_legacy {
                assert!(!location.starts_with(legacy));
            }
        }
        assert_eq!(user_config_file(), root.path().join("config.json"));
        assert_eq!(encryption_key_file(), root.path().join(".encryption-key"));
        assert_eq!(browsers_dir(), root.path().join("browsers"));
        assert_eq!(artifacts_dir(), root.path().join("tmp"));
    }
}
