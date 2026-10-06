//! Where agent-browser keeps its own files: user config, sessions, auth
//! profiles, the encryption key, installed browsers, default artifact output,
//! and socket files when no socket directory is configured.
//!
//! Resolution order:
//! 1. `AGENT_BROWSER_HOME`, on every platform. It replaces `~/.agent-browser`
//!    and keeps the same layout inside. `~` and `~/` (also `~\` on Windows)
//!    are expanded.
//! 2. Outside Windows, the XDG layout when it is selected (see below) and the
//!    `agent-browser` directory under the XDG state or data base already
//!    exists. The config base does not count: `XDG_CONFIG_HOME` may point at
//!    another account's directory, so a folder there proves nothing about this
//!    user's install.
//! 3. `~/.agent-browser` when it already exists, so upgrading never strands
//!    existing sessions, auth profiles, installed browsers, or the key.
//! 4. Outside Windows, the XDG layout when it is selected.
//! 5. `~/.agent-browser`, or `<temp>/agent-browser` without a home directory.
//!
//! The XDG layout is selected by setting `XDG_STATE_HOME` or `XDG_DATA_HOME`.
//! `XDG_CONFIG_HOME` alone does not select it: hosted CI runners set it for
//! every job, sometimes to another account's home, so it says nothing about
//! the user's choice. Once selected, every XDG base is used: config goes to
//! `$XDG_CONFIG_HOME/agent-browser`, and unset bases fall back to their spec
//! defaults, or to the temp directory when there is no home directory.
//!
//! Step 2 keeps an XDG install in place when something later creates
//! `~/.agent-browser`, for example a client launched without the XDG variables.
//! [`claim_xdg_state_dir`] creates the state directory before a daemon starts,
//! so every XDG install that has run a daemon is marked.

use sha2::{Digest, Sha256};
use std::env;
use std::path::{Component, Path, PathBuf};

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
        Inputs::with_current(|inputs| inputs.layout())
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

    /// Whether the XDG state or data directory exists, which marks an install
    /// that later runs must keep using. The state directory is claimed before
    /// any daemon starts and `install` creates the data directory.
    fn is_marked(&self) -> bool {
        match self {
            Self::Single(root) => root.exists(),
            Self::Xdg { state, data, .. } => state.exists() || data.exists(),
        }
    }

    /// Files that hold user data worth keeping.
    fn content_paths(&self) -> Vec<PathBuf> {
        vec![
            self.config().join("config.json"),
            self.state().join("sessions"),
            self.state().join("auth"),
            self.state().join(".encryption-key"),
            self.data().join("browsers"),
        ]
    }
}

/// What decides the layout, separated from the process environment so the
/// rules can be tested directly.
struct Inputs<'a> {
    var: &'a dyn Fn(&str) -> Option<String>,
    home: Option<&'a Path>,
    allow_xdg: bool,
}

impl Inputs<'_> {
    fn with_current<T>(f: impl FnOnce(&Inputs<'_>) -> T) -> T {
        let home = dirs::home_dir();
        let var = |name: &str| env::var(name).ok();
        f(&Inputs {
            var: &var,
            home: home.as_deref(),
            allow_xdg: !cfg!(windows),
        })
    }

    fn set(&self, name: &str) -> Option<String> {
        (self.var)(name).filter(|value| !value.is_empty())
    }

    fn override_root(&self) -> Option<PathBuf> {
        let root = expand_tilde_in(&self.set(HOME_ENV)?, self.home);
        // Relative values resolve against the working directory. Making them
        // absolute keeps reported paths and the state scope stable.
        Some(std::path::absolute(&root).unwrap_or(root))
    }

    fn legacy_dir(&self) -> PathBuf {
        match self.home {
            Some(home) => home.join(LEGACY_DIR),
            None => env::temp_dir().join(APP_DIR),
        }
    }

    /// An XDG base directory variable, ignoring relative values as the spec
    /// requires.
    fn xdg_base(&self, name: &str) -> Option<PathBuf> {
        self.set(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    }

    /// The XDG layout, or `None` unless `XDG_STATE_HOME` or `XDG_DATA_HOME`
    /// selects it.
    fn xdg_layout(&self) -> Option<Layout> {
        let state = self.xdg_base("XDG_STATE_HOME");
        let data = self.xdg_base("XDG_DATA_HOME");
        if !self.allow_xdg || (state.is_none() && data.is_none()) {
            return None;
        }
        Some(self.xdg_with(
            self.xdg_base("XDG_CONFIG_HOME"),
            state,
            data,
            self.xdg_base("XDG_CACHE_HOME"),
        ))
    }

    fn xdg_with(
        &self,
        config: Option<PathBuf>,
        state: Option<PathBuf>,
        data: Option<PathBuf>,
        cache: Option<PathBuf>,
    ) -> Layout {
        Layout::Xdg {
            config: self.xdg_dir(config, &[".config"]),
            state: self.xdg_dir(state, &[".local", "state"]),
            data: self.xdg_dir(data, &[".local", "share"]),
            cache: self.xdg_dir(cache, &[".cache"]),
        }
    }

    fn xdg_dir(&self, base: Option<PathBuf>, spec_default: &[&str]) -> PathBuf {
        let base = base.unwrap_or_else(|| match self.home {
            Some(home) => spec_default
                .iter()
                .fold(home.to_path_buf(), |path, part| path.join(part)),
            None => env::temp_dir(),
        });
        base.join(APP_DIR)
    }

    fn layout(&self) -> Layout {
        if let Some(root) = self.override_root() {
            return Layout::Single(root);
        }
        let legacy = self.legacy_dir();
        match self.xdg_layout() {
            Some(xdg) if xdg.is_marked() => xdg,
            Some(_) if self.home.is_some() && legacy.exists() => Layout::Single(legacy),
            Some(xdg) => xdg,
            None => Layout::Single(legacy),
        }
    }

    /// agent-browser files in the layout that is not in use, each paired with
    /// where it belongs in the layout that is. Only `~/.agent-browser` versus
    /// XDG can conflict; `AGENT_BROWSER_HOME` and Windows never do.
    fn unused_files(&self) -> Vec<(PathBuf, PathBuf)> {
        let Some(home) = self.home.filter(|_| self.allow_xdg) else {
            return Vec::new();
        };
        if self.override_root().is_some() {
            return Vec::new();
        }
        let in_use = self.layout();
        // Unless XDG is selected, its variables are not the user's choice
        // (`XDG_CONFIG_HOME` may be another account's), so look only at the
        // spec defaults under this home.
        let other = match in_use {
            Layout::Xdg { .. } => Layout::Single(home.join(LEGACY_DIR)),
            Layout::Single(_) => self
                .xdg_layout()
                .unwrap_or_else(|| self.xdg_with(None, None, None, None)),
        };
        other
            .content_paths()
            .into_iter()
            .zip(in_use.content_paths())
            .filter(|(unused, _)| unused.exists())
            .collect()
    }

    fn state_scope(&self) -> Option<String> {
        let state = scope_key(self.layout().state());
        if state == scope_key(&self.legacy_dir()) {
            return None;
        }
        let digest = Sha256::digest(state.as_bytes());
        Some(digest[..6].iter().map(|b| format!("{:02x}", b)).collect())
    }
}

/// A spelling-independent key for a directory. Components are resolved left
/// to right: each prefix that exists is canonicalized (folding symlinks and
/// `..` the way the OS does), and `.` and `..` in the part that does not exist
/// yet are resolved lexically, so the key does not change when the directory
/// is created later. ASCII case is folded on Windows; existing components
/// already carry their on-disk spelling, and full Unicode folding would merge
/// names NTFS keeps apart (the Kelvin sign and `K`).
fn scope_key(path: &Path) -> String {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(part) => {
                resolved.push(part);
                if let Ok(canonical) = resolved.canonicalize() {
                    resolved = canonical;
                }
            }
            Component::Prefix(_) | Component::RootDir => resolved.push(component.as_os_str()),
        }
    }
    let key = resolved.to_string_lossy().into_owned();
    if cfg!(windows) {
        key.to_ascii_lowercase()
    } else {
        key
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

/// Create the XDG state directory when the XDG layout is in use. Its presence
/// keeps later runs on the XDG layout even if `~/.agent-browser` appears (step
/// 2 of the resolution order), so a daemon and its CLI never disagree.
pub fn claim_xdg_state_dir() {
    if let Layout::Xdg { state, .. } = Layout::current() {
        let _ = std::fs::create_dir_all(state);
    }
}

/// A short stable id for the state directory, or `None` when it is the default
/// `~/.agent-browser`. Daemon endpoints shared by every process of the user
/// (`XDG_RUNTIME_DIR` sockets, Windows ports) include it, so each state
/// directory gets its own daemons while default users keep the endpoints
/// earlier versions used.
pub fn state_scope() -> Option<String> {
    Inputs::with_current(|inputs| inputs.state_scope())
}

/// agent-browser files (config, sessions, auth profiles, key, browsers) in
/// whichever of `~/.agent-browser` and the XDG directories is not in use,
/// each with the path it would have in the layout in use. They stay
/// invisible until they are moved.
pub fn unused_files() -> Vec<(PathBuf, PathBuf)> {
    Inputs::with_current(|inputs| inputs.unused_files())
}

/// Expand `~` or a leading `~/` (also `~\` on Windows) to the home directory.
/// `~user` forms are left as they are.
pub fn expand_tilde(path: &str) -> String {
    expand_tilde_in(path, dirs::home_dir().as_deref())
        .to_string_lossy()
        .into_owned()
}

fn expand_tilde_in(path: &str, home: Option<&Path>) -> PathBuf {
    let rest = if path == "~" {
        Some("")
    } else {
        path.strip_prefix("~/")
            .or_else(|| path.strip_prefix("~\\").filter(|_| cfg!(windows)))
    };
    match (rest, home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Case {
        vars: HashMap<String, String>,
        home: Option<PathBuf>,
        allow_xdg: bool,
    }

    impl Case {
        fn new(home: Option<&Path>, vars: &[(&str, &str)]) -> Self {
            Self {
                vars: vars
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                home: home.map(Path::to_path_buf),
                allow_xdg: true,
            }
        }

        fn windows(mut self) -> Self {
            self.allow_xdg = false;
            self
        }

        fn with<T>(&self, f: impl FnOnce(&Inputs<'_>) -> T) -> T {
            let var = |name: &str| self.vars.get(name).cloned();
            f(&Inputs {
                var: &var,
                home: self.home.as_deref(),
                allow_xdg: self.allow_xdg,
            })
        }

        fn layout(&self) -> Layout {
            self.with(|inputs| inputs.layout())
        }

        fn scope(&self) -> Option<String> {
            self.with(|inputs| inputs.state_scope())
        }

        fn unused(&self) -> Vec<(PathBuf, PathBuf)> {
            self.with(|inputs| inputs.unused_files())
        }
    }

    fn abs(path: &str) -> String {
        if cfg!(windows) {
            format!("C:{}", path.replace('/', "\\"))
        } else {
            path.to_string()
        }
    }

    fn legacy(home: &Path) -> Layout {
        Layout::Single(home.join(".agent-browser"))
    }

    #[test]
    fn defaults_to_legacy_dir_without_overrides() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            Case::new(Some(home.path()), &[]).layout(),
            legacy(home.path())
        );
        assert_eq!(
            Case::new(Some(home.path()), &[]).windows().layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn agent_browser_home_wins_everywhere() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".agent-browser")).unwrap();
        std::fs::create_dir(xdg.path().join("agent-browser")).unwrap();
        let root = abs("/srv/ab");
        let vars = [
            (HOME_ENV, root.as_str()),
            ("XDG_STATE_HOME", xdg.path().to_str().unwrap()),
        ];
        let expected = Layout::Single(PathBuf::from(&root));
        assert_eq!(Case::new(Some(home.path()), &vars).layout(), expected);
        assert_eq!(
            Case::new(Some(home.path()), &vars).windows().layout(),
            expected
        );
    }

    #[test]
    fn agent_browser_home_expands_tilde() {
        let home = tempfile::tempdir().unwrap();
        let values: &[&str] = if cfg!(windows) {
            &["~/ab-home", "~\\ab-home"]
        } else {
            &["~/ab-home"]
        };
        for value in values {
            assert_eq!(
                Case::new(Some(home.path()), &[(HOME_ENV, value)]).layout(),
                Layout::Single(home.path().join("ab-home")),
                "{}",
                value
            );
        }
    }

    #[test]
    fn relative_agent_browser_home_is_made_absolute() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            Case::new(Some(home.path()), &[(HOME_ENV, "rel-home")]).layout(),
            Layout::Single(env::current_dir().unwrap().join("rel-home"))
        );
    }

    #[test]
    fn empty_agent_browser_home_is_ignored() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            Case::new(Some(home.path()), &[(HOME_ENV, "")]).layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn xdg_vars_select_xdg_layout_with_spec_defaults() {
        let home = tempfile::tempdir().unwrap();
        let state = abs("/xdg/state");
        let layout = Case::new(Some(home.path()), &[("XDG_STATE_HOME", &state)]).layout();
        assert_eq!(
            layout,
            Layout::Xdg {
                config: home.path().join(".config").join("agent-browser"),
                state: PathBuf::from(&state).join("agent-browser"),
                data: home.path().join(".local/share").join("agent-browser"),
                cache: home.path().join(".cache").join("agent-browser"),
            }
        );
        assert_eq!(layout.artifacts(), home.path().join(".cache/agent-browser"));
    }

    #[test]
    fn existing_legacy_dir_wins_over_fresh_xdg() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".agent-browser")).unwrap();
        let state = abs("/xdg/state");
        assert_eq!(
            Case::new(Some(home.path()), &[("XDG_STATE_HOME", &state)]).layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn only_state_or_data_home_selects_xdg_on_a_fresh_home() {
        let names = [
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
        ];
        for mask in 0..16u8 {
            let home = tempfile::tempdir().unwrap();
            let values: Vec<(&str, String)> = names
                .iter()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(i, name)| (*name, abs(&format!("/xdg/{}", i))))
                .collect();
            let vars: Vec<(&str, &str)> = values.iter().map(|(k, v)| (*k, v.as_str())).collect();
            let selects = mask & 0b0110 != 0;
            let layout = Case::new(Some(home.path()), &vars).layout();
            assert_eq!(matches!(layout, Layout::Xdg { .. }), selects, "{:?}", vars);
            if selects && mask & 0b0001 != 0 {
                assert_eq!(
                    layout.config(),
                    PathBuf::from(abs("/xdg/0")).join("agent-browser")
                );
            }
        }
    }

    #[test]
    fn config_home_alone_never_selects_xdg_even_with_markers() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let config = xdg.path().join("config");
        std::fs::create_dir_all(config.join("agent-browser")).unwrap();
        std::fs::create_dir_all(home.path().join(".local/state/agent-browser")).unwrap();

        assert_eq!(
            Case::new(
                Some(home.path()),
                &[("XDG_CONFIG_HOME", config.to_str().unwrap())]
            )
            .layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn existing_xdg_state_wins_over_later_legacy_dir() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let state = xdg.path().join("state");
        std::fs::create_dir_all(state.join("agent-browser")).unwrap();
        std::fs::create_dir(home.path().join(".agent-browser")).unwrap();

        let case = Case::new(
            Some(home.path()),
            &[("XDG_STATE_HOME", state.to_str().unwrap())],
        );
        assert!(matches!(case.layout(), Layout::Xdg { .. }));
        assert_eq!(case.layout().state(), state.join("agent-browser"));
        assert!(
            case.unused().is_empty(),
            "an empty ~/.agent-browser holds nothing"
        );

        let sessions = home.path().join(".agent-browser/sessions");
        std::fs::create_dir(&sessions).unwrap();
        assert_eq!(
            case.unused(),
            vec![(sessions, state.join("agent-browser/sessions"))]
        );
    }

    #[test]
    fn existing_xdg_state_or_data_dir_marks_the_install() {
        for marker in ["state", "data"] {
            let home = tempfile::tempdir().unwrap();
            let xdg = tempfile::tempdir().unwrap();
            let base = |name: &str| xdg.path().join(name).to_str().unwrap().to_string();
            let (config, state, data) = (base("config"), base("state"), base("data"));
            std::fs::create_dir_all(xdg.path().join(marker).join("agent-browser")).unwrap();
            std::fs::create_dir(home.path().join(".agent-browser")).unwrap();

            let layout = Case::new(
                Some(home.path()),
                &[
                    ("XDG_CONFIG_HOME", &config),
                    ("XDG_STATE_HOME", &state),
                    ("XDG_DATA_HOME", &data),
                ],
            )
            .layout();
            assert_eq!(
                layout.state(),
                xdg.path().join("state/agent-browser"),
                "{}",
                marker
            );
        }
    }

    #[test]
    fn foreign_xdg_config_dir_does_not_mark_the_install() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let foreign_config = xdg.path().join("runneradmin/.config");
        std::fs::create_dir_all(foreign_config.join("agent-browser")).unwrap();
        std::fs::create_dir_all(home.path().join(".agent-browser/sessions")).unwrap();
        let state = xdg.path().join("state").to_str().unwrap().to_string();

        assert_eq!(
            Case::new(
                Some(home.path()),
                &[
                    ("XDG_CONFIG_HOME", foreign_config.to_str().unwrap()),
                    ("XDG_STATE_HOME", &state),
                ],
            )
            .layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn xdg_cache_alone_does_not_mark_the_install() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(xdg.path().join("cache/agent-browser")).unwrap();
        std::fs::create_dir(home.path().join(".agent-browser")).unwrap();
        let cache = xdg.path().join("cache").to_str().unwrap().to_string();

        assert_eq!(
            Case::new(Some(home.path()), &[("XDG_CACHE_HOME", &cache)]).layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn xdg_vars_are_ignored_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let state = abs("/xdg/state");
        assert_eq!(
            Case::new(Some(home.path()), &[("XDG_STATE_HOME", &state)])
                .windows()
                .layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn relative_xdg_vars_are_ignored() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            Case::new(
                Some(home.path()),
                &[
                    ("XDG_STATE_HOME", "relative/state"),
                    ("XDG_DATA_HOME", "relative/data")
                ]
            )
            .layout(),
            legacy(home.path())
        );
    }

    #[test]
    fn missing_home_falls_back_to_temp_dir() {
        assert_eq!(
            Case::new(None, &[]).layout(),
            Layout::Single(env::temp_dir().join("agent-browser"))
        );
    }

    #[test]
    fn missing_home_still_honors_absolute_xdg_vars() {
        let state = abs("/xdg/state");
        let layout = Case::new(None, &[("XDG_STATE_HOME", &state)]).layout();
        assert_eq!(layout.state(), PathBuf::from(&state).join("agent-browser"));
        assert_eq!(layout.config(), env::temp_dir().join("agent-browser"));
    }

    #[test]
    fn state_scope_is_empty_only_for_the_default_dir() {
        let home = tempfile::tempdir().unwrap();
        let (a, b) = (abs("/homes/a"), abs("/homes/b"));
        let default_spelled_out = home.path().join(".agent-browser");

        assert_eq!(Case::new(Some(home.path()), &[]).scope(), None);
        assert_eq!(
            Case::new(
                Some(home.path()),
                &[(HOME_ENV, default_spelled_out.to_str().unwrap())]
            )
            .scope(),
            None
        );
        let scope_a = Case::new(Some(home.path()), &[(HOME_ENV, &a)]).scope();
        let scope_b = Case::new(Some(home.path()), &[(HOME_ENV, &b)]).scope();
        assert!(scope_a.as_deref().is_some_and(|s| s.len() == 12));
        assert_ne!(scope_a, scope_b);

        let state = abs("/xdg/state");
        assert!(Case::new(Some(home.path()), &[("XDG_STATE_HOME", &state)])
            .scope()
            .is_some());
    }

    #[test]
    fn unused_files_lists_only_agent_browser_content() {
        let home = tempfile::tempdir().unwrap();
        let case = || Case::new(Some(home.path()), &[]);
        assert!(case().unused().is_empty());

        let legacy_dir = home.path().join(".agent-browser");
        let xdg_state = home.path().join(".local/state/agent-browser");
        std::fs::create_dir(&legacy_dir).unwrap();
        std::fs::create_dir_all(&xdg_state).unwrap();
        std::fs::write(xdg_state.join("unrelated.txt"), "x").unwrap();
        assert!(case().unused().is_empty(), "no agent-browser content yet");

        std::fs::create_dir(xdg_state.join("auth")).unwrap();
        std::fs::write(xdg_state.join(".encryption-key"), "k").unwrap();
        assert_eq!(
            case().unused(),
            vec![
                (xdg_state.join("auth"), legacy_dir.join("auth")),
                (
                    xdg_state.join(".encryption-key"),
                    legacy_dir.join(".encryption-key")
                ),
            ]
        );
        assert!(case().windows().unused().is_empty());
        let root = abs("/srv/ab");
        assert!(Case::new(Some(home.path()), &[(HOME_ENV, &root)])
            .unused()
            .is_empty());
    }

    #[test]
    fn unused_files_ignore_an_unselected_xdg_config_home() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let legacy_dir = home.path().join(".agent-browser");
        std::fs::create_dir(&legacy_dir).unwrap();
        let foreign_config = xdg.path().join("runneradmin/.config");
        std::fs::create_dir_all(foreign_config.join("agent-browser")).unwrap();
        std::fs::write(foreign_config.join("agent-browser/config.json"), "{}").unwrap();
        let case = || {
            Case::new(
                Some(home.path()),
                &[("XDG_CONFIG_HOME", foreign_config.to_str().unwrap())],
            )
        };
        assert!(case().unused().is_empty(), "{:?}", case().unused());

        let own_config = home.path().join(".config/agent-browser");
        std::fs::create_dir_all(&own_config).unwrap();
        std::fs::write(own_config.join("config.json"), "{}").unwrap();
        assert_eq!(
            case().unused(),
            vec![(
                own_config.join("config.json"),
                legacy_dir.join("config.json")
            )]
        );
    }

    #[test]
    fn unused_files_name_the_matching_xdg_target() {
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let base = |name: &str| xdg.path().join(name);
        for name in ["config", "state", "data"] {
            std::fs::create_dir_all(base(name).join("agent-browser")).unwrap();
        }
        let legacy_dir = home.path().join(".agent-browser");
        std::fs::create_dir_all(legacy_dir.join("browsers")).unwrap();
        std::fs::write(legacy_dir.join("config.json"), "{}").unwrap();
        let (config, state, data) = (
            base("config").to_str().unwrap().to_string(),
            base("state").to_str().unwrap().to_string(),
            base("data").to_str().unwrap().to_string(),
        );

        let unused = Case::new(
            Some(home.path()),
            &[
                ("XDG_CONFIG_HOME", &config),
                ("XDG_STATE_HOME", &state),
                ("XDG_DATA_HOME", &data),
            ],
        )
        .unused();
        assert_eq!(
            unused,
            vec![
                (
                    legacy_dir.join("config.json"),
                    base("config").join("agent-browser/config.json")
                ),
                (
                    legacy_dir.join("browsers"),
                    base("data").join("agent-browser/browsers")
                ),
            ]
        );
    }

    #[test]
    fn state_scope_ignores_spelling() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("data");
        let plain = dir.to_str().unwrap().to_string();
        let sep = std::path::MAIN_SEPARATOR;
        let spellings = [
            format!("{plain}{sep}"),
            format!("{}{sep}.{sep}data", home.path().display()),
            format!("{}{sep}{sep}data", home.path().display()),
            format!("{}{sep}missing{sep}..{sep}data", home.path().display()),
            format!("{plain}{sep}..{sep}data"),
            format!("{plain}{sep}sub{sep}..{sep}"),
        ];
        let scope = |value: &str| Case::new(Some(home.path()), &[(HOME_ENV, value)]).scope();
        let expected = scope(&plain);
        assert!(expected.is_some());
        for spelling in &spellings {
            assert_eq!(scope(spelling), expected, "{}", spelling);
        }

        // Creating the directory later does not change its id.
        std::fs::create_dir(&dir).unwrap();
        for spelling in std::iter::once(&plain).chain(&spellings) {
            assert_eq!(scope(spelling), expected, "{} after creation", spelling);
        }

        let default_with_slash = format!("{}{sep}.agent-browser{sep}", home.path().display());
        assert_eq!(scope(&default_with_slash), None);
    }

    #[cfg(unix)]
    #[test]
    fn state_scope_follows_symlinked_parents() {
        let home = tempfile::tempdir().unwrap();
        let real = home.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, home.path().join("link")).unwrap();
        let scope = |value: &std::path::Path| {
            Case::new(Some(home.path()), &[(HOME_ENV, value.to_str().unwrap())]).scope()
        };
        assert_eq!(scope(&home.path().join("link/ab")), scope(&real.join("ab")));
    }

    #[cfg(windows)]
    #[test]
    fn state_scope_ignores_case_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let scope = |value: &str| Case::new(Some(home.path()), &[(HOME_ENV, value)]).scope();
        let dir = home.path().join("Data").to_str().unwrap().to_string();
        assert_eq!(scope(&dir), scope(&dir.to_uppercase()));
        // An existing directory resolves to its on-disk spelling, so non-ASCII
        // case differences fold too.
        std::fs::create_dir(home.path().join("\u{c4}rger")).unwrap();
        let upper = home.path().join("\u{c4}rger").to_str().unwrap().to_string();
        let lower = home.path().join("\u{e4}rger").to_str().unwrap().to_string();
        assert_eq!(scope(&upper), scope(&lower));
        let default_lower = home
            .path()
            .join(".agent-browser")
            .to_str()
            .unwrap()
            .to_lowercase();
        assert_eq!(scope(&default_lower), None);
    }

    #[cfg(windows)]
    #[test]
    fn state_scope_keeps_distinct_ntfs_names_apart_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let kelvin = home.path().join("\u{212a}x");
        let ascii = home.path().join("Kx");
        std::fs::create_dir(&kelvin).unwrap();
        std::fs::create_dir(&ascii).unwrap();
        let scope = |value: &Path| {
            Case::new(Some(home.path()), &[(HOME_ENV, value.to_str().unwrap())]).scope()
        };
        assert_ne!(scope(&kelvin), scope(&ascii));
    }

    #[test]
    fn expand_tilde_replaces_leading_tilde_only() {
        let home = Path::new("/home/user");
        assert_eq!(
            expand_tilde_in("~/test/path", Some(home)),
            home.join("test/path")
        );
        assert_eq!(
            expand_tilde_in("/absolute/path", Some(home)),
            PathBuf::from("/absolute/path")
        );
        assert_eq!(expand_tilde_in("~/x", None), PathBuf::from("~/x"));
        assert_eq!(expand_tilde_in("~", Some(home)), home.join(""));
        assert_eq!(
            expand_tilde_in("~other/x", Some(home)),
            PathBuf::from("~other/x")
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
        assert!(state_scope().is_some());
    }
}
