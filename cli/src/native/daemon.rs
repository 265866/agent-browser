use serde_json::Value;
use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::signal;
use tokio::sync::{Notify, RwLock};

use super::actions::{
    auto_save_restore_state, close_all_browser_backends, close_current_browser, execute_command,
    maybe_autosave_restore_state, DaemonState,
};
use super::cdp::client::CdpClient;
use super::state;
use super::stream::{IdleActivity, StreamServer};
use crate::connection::INTERNAL_DAEMON_SHUTDOWN_ACTION;

pub async fn run_daemon(session: &str) {
    crate::paths::claim_xdg_state_dir();
    let socket_dir = get_daemon_socket_dir();
    if !socket_dir.exists() {
        let _ = fs::create_dir_all(&socket_dir);
    }

    let pid_path = socket_dir.join(format!("{}.pid", session));
    let _ = fs::write(&pid_path, process::id().to_string());

    let version_path = socket_dir.join(format!("{}.version", session));
    let _ = fs::write(&version_path, env!("CARGO_PKG_VERSION"));

    // On Unix the daemon listens on a Unix domain socket; on Windows it uses
    // TCP, so there is no .sock file — only a .port file written by the server.
    let socket_path = socket_dir.join(format!("{}.sock", session));

    #[cfg(unix)]
    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }

    #[cfg(windows)]
    {
        let _ = fs::remove_file(socket_dir.join(format!("{}.port", session)));
    }

    let stream_path = socket_dir.join(format!("{}.stream", session));
    let _ = fs::remove_file(&stream_path);
    let _ = fs::remove_file(socket_dir.join(format!("{}.engine", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.provider", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.extensions", session)));

    if let Ok(days_str) = env::var("AGENT_BROWSER_STATE_EXPIRE_DAYS") {
        if let Ok(days) = days_str.parse::<u64>() {
            if days > 0 {
                let _ = state::state_clean(days);
            }
        }
    }

    let mut stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>> = None;
    let mut stream_server_instance: Option<Arc<StreamServer>> = None;
    let idle_activity = Arc::new(IdleActivity::new());
    let preferred_port = env::var("AGENT_BROWSER_STREAM_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);
    match StreamServer::start_without_client(
        preferred_port,
        session.to_string(),
        true,
        idle_activity.clone(),
    )
    .await
    {
        Ok((stream_server, client_slot)) => {
            stream_client = Some(client_slot.clone());
            if let Err(e) = fs::write(&stream_path, stream_server.port().to_string()) {
                let _ = writeln!(std::io::stderr(), "Failed to write .stream file: {}", e);
            }
            stream_server_instance = Some(Arc::new(stream_server));
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "Stream server failed to start: {}", e);
        }
    }

    // Auto-shutdown the daemon after this many ms of inactivity (no commands
    // or dashboard input received). Applies a default when
    // AGENT_BROWSER_IDLE_TIMEOUT_MS is unset; an explicit 0 disables idle
    // shutdown entirely.
    let idle_timeout = resolve_idle_timeout(env::var("AGENT_BROWSER_IDLE_TIMEOUT_MS").ok());

    let autosave_interval_ms = autosave_interval_ms_from_env();

    let result = run_socket_server(
        &socket_path,
        session,
        stream_client,
        stream_server_instance,
        idle_activity,
        idle_timeout,
        autosave_interval_ms,
    )
    .await;

    #[cfg(unix)]
    {
        let _ = fs::remove_file(&socket_path);
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(socket_dir.join(format!("{}.port", session)));
    }
    let _ = fs::remove_file(&pid_path);
    let _ = fs::remove_file(&version_path);
    let _ = fs::remove_file(&stream_path);
    let _ = fs::remove_file(socket_dir.join(format!("{}.engine", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.provider", session)));
    let _ = fs::remove_file(socket_dir.join(format!("{}.extensions", session)));

    if let Err(e) = result {
        let _ = writeln!(std::io::stderr(), "Daemon error: {}", e);
        process::exit(1);
    }
}

/// Idle timeout applied when AGENT_BROWSER_IDLE_TIMEOUT_MS is unset, so an
/// integration that dies without calling `close` cannot leak the daemon and
/// its Chrome tree indefinitely (issue: leaked daemons observed running for
/// days). Socket commands and dashboard input reset the timer. Unlike an
/// explicit timeout, the default never closes a headed browser (including
/// Safari and iOS WebDriver sessions) or a user-attached browser because those
/// may be in direct human use that the daemon cannot observe. Provider-owned
/// CDP browsers remain eligible for cleanup.
pub const DEFAULT_IDLE_TIMEOUT_MS: u64 = 60 * 60 * 1000;

#[derive(Clone, Copy)]
struct IdleTimeout {
    ms: u64,
    /// True when the value came from DEFAULT_IDLE_TIMEOUT_MS rather than an
    /// explicit AGENT_BROWSER_IDLE_TIMEOUT_MS. Only the default exempts
    /// headed and user-attached browsers from shutdown.
    is_default: bool,
}

/// Resolve AGENT_BROWSER_IDLE_TIMEOUT_MS into an effective idle timeout:
/// unset or unparseable → the default; explicit 0 → disabled (None);
/// any other value → that many milliseconds.
fn resolve_idle_timeout(raw: Option<String>) -> Option<IdleTimeout> {
    match raw.as_deref().map(str::trim).map(str::parse::<u64>) {
        Some(Ok(0)) => None,
        Some(Ok(ms)) => Some(IdleTimeout {
            ms,
            is_default: false,
        }),
        // Unparseable values are validated (with a warning) at the flags
        // layer; falling back to the default here keeps the leak backstop
        // in place rather than silently disabling it.
        Some(Err(_)) | None => Some(IdleTimeout {
            ms: DEFAULT_IDLE_TIMEOUT_MS,
            is_default: true,
        }),
    }
}

fn remaining_idle_timeout(activity: &IdleActivity, timeout_ms: u64) -> Option<Duration> {
    Duration::from_millis(timeout_ms).checked_sub(activity.elapsed())
}

/// Minimum ms between periodic session autosaves while the browser is open.
/// Defaults to 30s; 0 disables periodic autosave (save-on-close still runs).
fn autosave_interval_ms_from_env() -> u64 {
    env::var("AGENT_BROWSER_AUTOSAVE_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30_000)
}

#[cfg(unix)]
async fn run_socket_server(
    socket_path: &PathBuf,
    session: &str,
    stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    stream_server: Option<Arc<StreamServer>>,
    idle_activity: Arc<IdleActivity>,
    idle_timeout: Option<IdleTimeout>,
    autosave_interval_ms: u64,
) -> Result<(), String> {
    use tokio::net::UnixListener;

    let idle_timeout_ms = idle_timeout.map(|t| t.ms);

    let listener =
        UnixListener::bind(socket_path).map_err(|e| format!("Failed to bind socket: {}", e))?;
    let socket_dir = socket_path.parent().unwrap_or(std::path::Path::new("."));
    // Binding failures still reach the launching CLI through the startup pipe.
    // Once bound, daemon warnings must outlive that CLI's stderr reader.
    redirect_daemon_stderr(
        socket_dir,
        session,
        crate::flags::env_var_is_truthy("AGENT_BROWSER_DEBUG"),
    )
    .map_err(|e| format!("Failed to redirect daemon stderr: {}", e))?;

    let stream_file: Option<PathBuf> = if stream_server.is_some() {
        Some(socket_dir.join(format!("{}.stream", session)))
    } else {
        None
    };
    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(DaemonState::new_with_stream(
            stream_client,
            stream_server,
            idle_activity.clone(),
        )));

    // Notifier used by handle_connection to signal the daemon loop to exit
    // after a "close" command, instead of calling process::exit() which skips
    // destructors and can leave Chrome processes orphaned (issue #1113).
    let close_notify = Arc::new(Notify::new());

    let mut drain_interval = tokio::time::interval(Duration::from_millis(100));
    drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let idle_sleep = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
    let mut idle_sleep_pin = idle_sleep.map(Box::pin);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let idle_activity = idle_activity.clone();
                        let sf = stream_file.clone();
                        let cn = close_notify.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, idle_activity, sf, cn).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = drain_interval.tick() => {
                let mut s = state.lock().await;
                let process_exited = s
                    .browser
                    .as_mut()
                    .map(|mgr| mgr.has_process_exited())
                    .unwrap_or(false);
                if process_exited {
                    let _ = close_current_browser(&mut s).await;
                } else if s.browser.is_some() {
                    if let Err(error) = s.drain_cdp_events_background().await {
                        let _ = writeln!(
                            std::io::stderr(),
                            "Failed to apply browser network controls: {}",
                            error
                        );
                    } else {
                        maybe_autosave_restore_state(&mut s, autosave_interval_ms).await;
                    }
                }
            }
            _ = async {
                match idle_sleep_pin {
                    Some(ref mut s) => s.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if idle_timeout_ms.is_some() => {
                let mut s = state.lock().await;
                // The timer may have expired while a command held the state
                // lock. Command completion refreshes the shared activity
                // clock before releasing that lock, so re-check it here.
                if let Some(remaining) =
                    remaining_idle_timeout(&idle_activity, idle_timeout_ms.unwrap_or_default())
                {
                    idle_sleep_pin = Some(Box::pin(tokio::time::sleep(remaining)));
                    continue;
                }
                // The default timeout is a leak backstop, not a lifecycle
                // policy: never pull a headed, WebDriver, or attached browser
                // out from under a human. Re-arm and keep waiting instead.
                if idle_timeout.is_some_and(|t| t.is_default)
                    && s.blocks_default_idle_shutdown()
                {
                    idle_sleep_pin = idle_timeout_ms
                        .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                    continue;
                }
                if idle_timeout.is_some_and(|t| t.is_default) {
                    let _ = writeln!(
                        std::io::stderr(),
                        "Idle for {}m with no commands or dashboard input; saving configured restore state and shutting down (AGENT_BROWSER_IDLE_TIMEOUT_MS=0 disables)",
                        DEFAULT_IDLE_TIMEOUT_MS / 60_000
                    );
                }
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                break;
            }
            _ = idle_activity.notified(), if idle_timeout_ms.is_some() => {
                idle_sleep_pin = idle_timeout_ms
                    .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                continue;
            }
            _ = close_notify.notified() => {
                // "close" command was handled; browser already closed by
                // handle_close(). Break to run cleanup and exit gracefully
                // so destructors fire.
                break;
            }
            _ = shutdown_signal() => {
                let mut s = state.lock().await;
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                break;
            }
        }
    }

    Ok(())
}

/// Replace the startup stderr pipe with the session debug log, or with the
/// null device when debug is off or the log cannot be created. The launching
/// CLI holds the only reader of that pipe and drops it once the daemon is
/// ready, after which any stderr write fails and `eprintln!` panics.
fn redirect_daemon_stderr(
    socket_dir: &std::path::Path,
    session: &str,
    debug: bool,
) -> std::io::Result<()> {
    let log = debug
        .then(|| fs::File::create(socket_dir.join(format!("{}.log", session))).ok())
        .flatten();
    let logging = log.is_some();
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let file = match log {
        Some(file) => file,
        None => fs::OpenOptions::new().write(true).open(null_device)?,
    };

    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: both descriptors are valid; dup2 closes the pipe on fd 2,
        // and `file` closes its own descriptor when dropped.
        if unsafe { libc::dup2(file.as_raw_fd(), 2) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::io::{AsRawHandle, IntoRawHandle};
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
        use windows_sys::Win32::System::Console::{GetStdHandle, SetStdHandle, STD_ERROR_HANDLE};

        // SAFETY: GetStdHandle has no preconditions.
        let pipe = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        // SAFETY: file owns a valid writable handle, and on success it is
        // leaked below so the handle stays open for the rest of the process.
        // Rust looks up the standard handle on every stderr write, and tasks
        // can still write during shutdown; a closed handle value could be
        // reused by another object.
        if unsafe { SetStdHandle(STD_ERROR_HANDLE, file.as_raw_handle() as HANDLE) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let _ = file.into_raw_handle();
        // The C runtime may still write to the pipe handle, so it stays open,
        // but Chrome and other children must not inherit it: they would keep
        // the launching CLI's pipe open after the daemon exits.
        // SAFETY: an invalid or null handle only makes the call fail.
        unsafe { SetHandleInformation(pipe, HANDLE_FLAG_INHERIT, 0) };
    }

    if logging {
        let _ = writeln!(
            std::io::stderr(),
            "[daemon] Debug logging started for session: {}",
            session
        );
    }
    Ok(())
}

#[cfg(windows)]
async fn run_socket_server(
    socket_path: &std::path::Path,
    session: &str,
    stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    stream_server: Option<Arc<StreamServer>>,
    idle_activity: Arc<IdleActivity>,
    idle_timeout: Option<IdleTimeout>,
    autosave_interval_ms: u64,
) -> Result<(), String> {
    use tokio::net::TcpListener;

    let idle_timeout_ms = idle_timeout.map(|t| t.ms);

    let preferred_port = get_port_for_session(session);
    // Try the hash-derived port first; if it is blocked (e.g. Windows Hyper-V
    // excluded port range), fall back to an OS-assigned ephemeral port.
    let listener = match TcpListener::bind(format!("127.0.0.1:{}", preferred_port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind TCP: {}", e))?,
    };
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();

    let socket_dir = socket_path.parent().unwrap_or(std::path::Path::new("."));
    // Binding failures still reach the launching CLI through the startup pipe.
    // Once bound, daemon warnings must outlive that CLI's stderr reader (#1993).
    redirect_daemon_stderr(
        socket_dir,
        session,
        crate::flags::env_var_is_truthy("AGENT_BROWSER_DEBUG"),
    )
    .map_err(|e| format!("Failed to redirect daemon stderr: {}", e))?;
    let port_path = socket_dir.join(format!("{}.port", session));
    let _ = fs::write(&port_path, actual_port.to_string());

    let stream_file: Option<PathBuf> = if stream_server.is_some() {
        Some(socket_dir.join(format!("{}.stream", session)))
    } else {
        None
    };
    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(DaemonState::new_with_stream(
            stream_client,
            stream_server,
            idle_activity.clone(),
        )));

    let close_notify = Arc::new(Notify::new());

    let idle_sleep = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
    let mut idle_sleep_pin = idle_sleep.map(Box::pin);

    // Mirror the unix loop's background tick: reap a browser the user closed
    // by hand, and drain CDP events (dialog state in particular) before
    // autosave so a save never runs against a dialog-blocked renderer.
    let mut drain_interval = tokio::time::interval(Duration::from_millis(100));
    drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let idle_activity = idle_activity.clone();
                        let sf = stream_file.clone();
                        let cn = close_notify.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, idle_activity, sf, cn).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = drain_interval.tick() => {
                let mut s = state.lock().await;
                let process_exited = s
                    .browser
                    .as_mut()
                    .map(|mgr| mgr.has_process_exited())
                    .unwrap_or(false);
                if process_exited {
                    let _ = close_current_browser(&mut s).await;
                } else if s.browser.is_some() {
                    if let Err(error) = s.drain_cdp_events_background().await {
                        let _ = writeln!(
                            std::io::stderr(),
                            "Failed to apply browser network controls: {}",
                            error
                        );
                    } else {
                        maybe_autosave_restore_state(&mut s, autosave_interval_ms).await;
                    }
                }
            }
            _ = async {
                match idle_sleep_pin {
                    Some(ref mut s) => s.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if idle_timeout_ms.is_some() => {
                let mut s = state.lock().await;
                if let Some(remaining) =
                    remaining_idle_timeout(&idle_activity, idle_timeout_ms.unwrap_or_default())
                {
                    idle_sleep_pin = Some(Box::pin(tokio::time::sleep(remaining)));
                    continue;
                }
                // The default timeout is a leak backstop, not a lifecycle
                // policy: never pull a headed, WebDriver, or attached browser
                // out from under a human. Re-arm and keep waiting instead.
                if idle_timeout.is_some_and(|t| t.is_default)
                    && s.blocks_default_idle_shutdown()
                {
                    idle_sleep_pin = idle_timeout_ms
                        .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                    continue;
                }
                if idle_timeout.is_some_and(|t| t.is_default) {
                    let _ = writeln!(
                        std::io::stderr(),
                        "Idle for {}m with no commands or dashboard input; saving configured restore state and shutting down (AGENT_BROWSER_IDLE_TIMEOUT_MS=0 disables)",
                        DEFAULT_IDLE_TIMEOUT_MS / 60_000
                    );
                }
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                let _ = fs::remove_file(&port_path);
                break;
            }
            _ = idle_activity.notified(), if idle_timeout_ms.is_some() => {
                idle_sleep_pin = idle_timeout_ms
                    .map(|ms| Box::pin(tokio::time::sleep(Duration::from_millis(ms))));
                continue;
            }
            _ = close_notify.notified() => {
                let _ = fs::remove_file(&port_path);
                break;
            }
            _ = shutdown_signal() => {
                let mut s = state.lock().await;
                let _ = auto_save_restore_state(&mut s).await;
                let _ = close_all_browser_backends(&mut s).await;
                let _ = fs::remove_file(&port_path);
                break;
            }
        }
    }

    Ok(())
}

async fn handle_connection<S>(
    stream: S,
    state: std::sync::Arc<tokio::sync::Mutex<DaemonState>>,
    idle_activity: Arc<IdleActivity>,
    stream_file_cleanup: Option<PathBuf>,
    close_notify: Arc<Notify>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match buf_reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if looks_like_http(trimmed) {
                    break;
                }

                let cmd: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        let err = serde_json::json!({
                            "success": false,
                            "error": format!("Invalid JSON: {}", e),
                        });
                        let mut resp = serde_json::to_string(&err).unwrap_or_default();
                        resp.push('\n');
                        let _ = writer.write_all(resp.as_bytes()).await;
                        continue;
                    }
                };

                idle_activity.mark();

                let action = cmd
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let response = {
                    let mut s = state.lock().await;
                    let response = execute_command(&cmd, &mut s).await;
                    // Refresh while the state lock is still held. An idle
                    // timer waiting on this command will observe the updated
                    // clock as soon as it acquires the lock.
                    idle_activity.mark();
                    response
                };

                let mut resp = serde_json::to_string(&response).unwrap_or_default();
                resp.push('\n');
                if writer.write_all(resp.as_bytes()).await.is_err() {
                    break;
                }

                if close_completed_response(&action, &response) {
                    if let Some(ref path) = stream_file_cleanup {
                        let _ = fs::remove_file(path);
                    }
                    // Signal the daemon loop to exit gracefully instead of
                    // calling process::exit(), which skips destructors and
                    // can leave Chrome processes orphaned (issue #1113).
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                    close_notify.notify_one();
                    return;
                }
            }
            Err(_) => break,
        }
    }
}

fn looks_like_http(line: &str) -> bool {
    let prefixes = [
        "GET ", "POST ", "PUT ", "DELETE ", "PATCH ", "HEAD ", "OPTIONS ", "CONNECT ", "TRACE ",
    ];
    prefixes.iter().any(|p| line.starts_with(p))
}

fn close_completed_response(action: &str, response: &Value) -> bool {
    if !matches!(
        action,
        "close" | "confirm" | INTERNAL_DAEMON_SHUTDOWN_ACTION
    ) {
        return false;
    }

    fn data_closed(data: &Value) -> bool {
        data.get("closed").and_then(|v| v.as_bool()) == Some(true)
    }

    if response.get("success").and_then(|v| v.as_bool()) != Some(true) {
        return false;
    }

    let Some(data) = response.get("data") else {
        return false;
    };
    if data_closed(data) {
        return true;
    }

    data.get("result").is_some_and(|result| {
        result.get("success").and_then(|v| v.as_bool()) == Some(true)
            && result.get("data").is_some_and(data_closed)
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigint = match signal::unix::signal(signal::unix::SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGINT handler: {}", e);
                process::exit(1);
            }
        };
        let mut sigterm = match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Failed to install SIGTERM handler: {}",
                    e
                );
                process::exit(1);
            }
        };
        let mut sighup = match signal::unix::signal(signal::unix::SignalKind::hangup()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGHUP handler: {}", e);
                process::exit(1);
            }
        };

        tokio::select! {
            _ = sigint.recv() => {}
            _ = sigterm.recv() => {}
            _ = sighup.recv() => {}
        }
    }

    #[cfg(windows)]
    {
        if let Err(e) = signal::ctrl_c().await {
            let _ = writeln!(std::io::stderr(), "Failed to install Ctrl+C handler: {}", e);
            process::exit(1);
        }
    }
}

fn get_daemon_socket_dir() -> PathBuf {
    crate::connection::get_socket_dir()
}

#[cfg(windows)]
fn get_port_for_session(session: &str) -> u16 {
    crate::connection::get_port_for_session(session)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    // Standard handles are process-global, so exercise the stderr redirect in
    // a subprocess rather than changing stderr underneath parallel unit tests.
    #[test]
    #[ignore = "internal subprocess helper"]
    fn daemon_stderr_child() {
        let Ok(dir) = env::var("AGENT_BROWSER_STDERR_TEST_DIR") else {
            return;
        };
        let debug = env::var("AGENT_BROWSER_STDERR_TEST_DEBUG").is_ok();
        redirect_daemon_stderr(std::path::Path::new(&dir), "probe", debug)
            .expect("stderr redirect should succeed");
        #[cfg(windows)]
        if env::var("AGENT_BROWSER_STDERR_TEST_SPAWN").is_ok() {
            // Stands in for Chrome or any other child the daemon starts. It
            // must outlive this helper; the parent test kills it.
            #[allow(clippy::zombie_processes)]
            let grandchild = std::process::Command::new("cmd")
                .args(["/c", "ping", "-n", "30", "127.0.0.1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            println!("stderr-probe-grandchild {}", grandchild.id());
            return;
        }
        println!("stderr-probe-ready");
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        // The parent has now dropped the startup pipe's read end. eprintln!
        // must still succeed, including for warnings introduced in future code.
        eprintln!("stderr-probe-warning-after-parent-exit");
        println!("stderr-probe-survived");
    }

    fn daemon_stderr_probe(dir: &std::path::Path) -> std::process::Command {
        let mut cmd = std::process::Command::new(env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "native::daemon::tests::daemon_stderr_child",
            "--ignored",
            "--nocapture",
        ])
        .env("AGENT_BROWSER_STDERR_TEST_DIR", dir)
        .env_remove("AGENT_BROWSER_STDERR_TEST_DEBUG")
        .env_remove("AGENT_BROWSER_STDERR_TEST_SPAWN")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        cmd
    }

    /// Forwards the probe's stdout lines. The channel closes once every holder
    /// of the pipe's write end has closed it.
    fn probe_lines(stdout: std::process::ChildStdout) -> std::sync::mpsc::Receiver<String> {
        use std::io::{BufRead, BufReader};
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        rx
    }

    fn assert_stderr_survives_closed_pipe(debug: bool, missing_log_dir: bool) {
        use std::process::Child;

        struct Probe(Child);
        impl Drop for Probe {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let dir = if missing_log_dir {
            tmp.path().join("missing")
        } else {
            tmp.path().to_path_buf()
        };
        let mut cmd = daemon_stderr_probe(&dir);
        if debug {
            cmd.env("AGENT_BROWSER_STDERR_TEST_DEBUG", "1");
        }
        let mut child = Probe(cmd.spawn().unwrap());
        let rx = probe_lines(child.0.stdout.take().unwrap());
        loop {
            let line = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("stderr probe did not become ready");
            if line == "stderr-probe-ready" {
                break;
            }
        }
        drop(child.0.stderr.take());
        writeln!(child.0.stdin.take().unwrap(), "pipe closed").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(std::time::Instant::now() < deadline, "stderr probe hung");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            status.success(),
            "writing to daemon stderr panicked: {status}"
        );
        let lines: Vec<String> = rx.iter().collect();
        assert!(
            lines.iter().any(|line| line == "stderr-probe-survived"),
            "{lines:?}"
        );
        if debug && !missing_log_dir {
            let log = fs::read_to_string(dir.join("probe.log")).unwrap();
            assert!(log.contains("Debug logging started for session: probe"));
            assert!(log.contains("stderr-probe-warning-after-parent-exit"));
        } else {
            assert!(!dir.join("probe.log").exists());
        }
    }

    #[test]
    fn daemon_stderr_survives_closed_startup_pipe() {
        assert_stderr_survives_closed_pipe(false, false);
    }

    #[test]
    fn daemon_stderr_debug_log_survives_closed_startup_pipe() {
        assert_stderr_survives_closed_pipe(true, false);
    }

    #[test]
    fn daemon_stderr_falls_back_when_debug_log_cannot_be_opened() {
        assert_stderr_survives_closed_pipe(true, true);
    }

    /// The launching CLI reads the startup pipe to the end when the daemon
    /// exits early, so a child the daemon started must not hold it open.
    #[test]
    #[cfg(windows)]
    fn windows_daemon_children_do_not_inherit_startup_stderr_pipe() {
        use std::io::Read;

        let tmp = tempfile::tempdir().unwrap();
        let mut child = daemon_stderr_probe(tmp.path())
            .env("AGENT_BROWSER_STDERR_TEST_SPAWN", "1")
            .spawn()
            .unwrap();
        let rx = probe_lines(child.stdout.take().unwrap());
        let grandchild = loop {
            let line = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("stderr probe did not start its child");
            if let Some(pid) = line.strip_prefix("stderr-probe-grandchild ") {
                break pid.to_string();
            }
        };
        let status = child.wait().unwrap();

        let mut stderr = child.stderr.take().unwrap();
        let (tx, eof) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = tx.send(stderr.read_to_end(&mut sink).is_ok());
        });
        let reached_eof = eof.recv_timeout(Duration::from_secs(5));
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &grandchild, "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        assert!(status.success(), "stderr probe failed: {status}");
        assert_eq!(
            reached_eof,
            Ok(true),
            "the daemon's child kept the startup stderr pipe open"
        );
    }

    #[test]
    fn test_resolve_idle_timeout_unset_applies_default() {
        let t = resolve_idle_timeout(None).expect("default should apply when unset");
        assert_eq!(t.ms, DEFAULT_IDLE_TIMEOUT_MS);
        assert!(t.is_default);
    }

    #[test]
    fn test_resolve_idle_timeout_explicit_zero_disables() {
        assert!(resolve_idle_timeout(Some("0".to_string())).is_none());
        assert!(resolve_idle_timeout(Some(" 0 ".to_string())).is_none());
    }

    #[test]
    fn test_resolve_idle_timeout_explicit_value_is_not_default() {
        let t = resolve_idle_timeout(Some("5000".to_string())).expect("explicit value");
        assert_eq!(t.ms, 5000);
        assert!(!t.is_default);
    }

    #[test]
    fn test_resolve_idle_timeout_unparseable_falls_back_to_default() {
        for raw in ["banana", "", "-1", "30s"] {
            let t = resolve_idle_timeout(Some(raw.to_string()))
                .unwrap_or_else(|| panic!("{:?} should fall back to default", raw));
            assert_eq!(t.ms, DEFAULT_IDLE_TIMEOUT_MS);
            assert!(t.is_default);
        }
    }

    #[test]
    fn test_default_idle_timeout_does_not_close_webdriver_sessions() {
        let mut state = DaemonState::new();
        assert!(!state.blocks_default_idle_shutdown());

        state.backend_type = crate::native::actions::BackendType::WebDriver;
        assert!(state.blocks_default_idle_shutdown());
    }

    #[tokio::test]
    async fn test_idle_activity_receives_dashboard_activity() {
        let activity = Arc::new(IdleActivity::new());
        activity.mark();

        tokio::time::timeout(Duration::from_millis(100), activity.notified())
            .await
            .expect("dashboard input notification should wake the idle loop");
    }

    #[tokio::test]
    async fn test_command_completion_rearms_expired_idle_timeout() {
        let activity = IdleActivity::new();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(
            remaining_idle_timeout(&activity, 1).is_none(),
            "the original idle deadline should have expired"
        );

        // A command that held the daemon state lock past the deadline marks
        // completion before releasing the lock. The timeout path must then
        // wait for a new full idle period instead of closing immediately.
        activity.mark();
        assert!(remaining_idle_timeout(&activity, 100).is_some());
    }

    #[test]
    fn test_daemon_socket_dir_matches_client_namespace() {
        let guard = crate::test_utils::EnvGuard::new(&[
            "AGENT_BROWSER_SOCKET_DIR",
            "XDG_RUNTIME_DIR",
            "AGENT_BROWSER_NAMESPACE",
        ]);
        let dir = tempfile::tempdir().unwrap();
        guard.set("AGENT_BROWSER_SOCKET_DIR", dir.path().to_str().unwrap());
        guard.remove("XDG_RUNTIME_DIR");
        guard.set("AGENT_BROWSER_NAMESPACE", "Worktree: One");

        let socket_dir = get_daemon_socket_dir();

        assert_eq!(socket_dir, crate::connection::get_socket_dir());
        assert!(socket_dir.ends_with(
            std::path::PathBuf::from("namespaces")
                .join("worktree-one")
                .join("run")
        ));
    }

    #[test]
    fn test_close_completed_response_requires_actual_close_result() {
        let confirmation_response = serde_json::json!({
            "success": true,
            "data": {
                "confirmation_required": true,
                "confirmation_id": "close-1",
                "action": "close"
            }
        });

        assert!(!close_completed_response("close", &confirmation_response));
    }

    #[test]
    fn test_close_completed_response_accepts_direct_and_confirmed_close() {
        let direct = serde_json::json!({
            "success": true,
            "data": { "closed": true }
        });
        let confirmed = serde_json::json!({
            "success": true,
            "data": {
                "confirmed": true,
                "action": "close",
                "result": {
                    "success": true,
                    "data": { "closed": true }
                }
            }
        });

        assert!(close_completed_response("close", &direct));
        assert!(close_completed_response(
            crate::connection::INTERNAL_DAEMON_SHUTDOWN_ACTION,
            &direct
        ));
        assert!(close_completed_response("confirm", &confirmed));
    }

    /// Guard against re-introducing `waitpid(-1)` in daemon code.
    ///
    /// Issue #1035: a SIGCHLD handler that called `waitpid(-1, WNOHANG)` was
    /// added in v0.22.3 to reap zombie Chrome processes. This races with
    /// Rust's `Child::try_wait()` / `Child::wait()` because `waitpid(-1)`
    /// reaps *any* child, stealing the exit status before Rust can collect
    /// it. The result is ECHILD errors in `BrowserManager::has_process_exited()`
    /// and `ChromeProcess::kill()`, which can leave the daemon in a broken
    /// state or cause hangs on certain Linux configurations.
    ///
    /// The fix uses the existing 500ms drain interval to call
    /// `has_process_exited()` (which delegates to `Child::try_wait()`)
    /// for targeted, race-free zombie detection.
    #[test]
    fn test_no_waitpid_minus_one_in_daemon() {
        let source = include_str!("daemon.rs");
        // Only check production code (everything before `#[cfg(test)]`)
        let production_code = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert!(
            !production_code.contains("waitpid(-1"),
            "daemon.rs production code must not call waitpid(-1, ...). \
             Use Child::try_wait() via has_process_exited() instead. \
             See issue #1035."
        );
    }

    /// Verify that `Child::try_wait()` correctly detects a crashed child
    /// without needing a global SIGCHLD handler or `waitpid(-1)`.
    /// This is what `has_process_exited()` uses in the fixed code.
    #[cfg(unix)]
    #[test]
    fn test_child_try_wait_detects_exit_without_sigchld_handler() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 42"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn child");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("child did not exit before the deadline");
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(e) => panic!("try_wait() should succeed without waitpid(-1): {}", e),
            }
        };

        assert_eq!(status.code(), Some(42));
    }

    /// Regression test for #1101: idle timeout must fire even while the
    /// drain interval ticks every 500 ms.  The bug was that `sleep_future`
    /// was created **inside** the loop, so each drain tick dropped the
    /// in-progress sleep and replaced it with a fresh one – the timer
    /// could never reach its deadline.
    #[tokio::test]
    async fn test_idle_timeout_fires_despite_drain_interval() {
        let idle_timeout_ms: u64 = 1000;
        let mut drain_interval = tokio::time::interval(Duration::from_millis(500));
        drain_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let activity = IdleActivity::new();

        let start = tokio::time::Instant::now();

        let exited = tokio::time::timeout(Duration::from_secs(5), async {
            let mut idle_sleep_pin = Some(Box::pin(tokio::time::sleep(Duration::from_millis(
                idle_timeout_ms,
            ))));

            loop {
                tokio::select! {
                    _ = drain_interval.tick() => {}
                    _ = async {
                        match idle_sleep_pin {
                            Some(ref mut s) => s.as_mut().await,
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        break;
                    }
                    _ = activity.notified() => {
                        idle_sleep_pin = Some(Box::pin(
                            tokio::time::sleep(Duration::from_millis(idle_timeout_ms)),
                        ));
                        continue;
                    }
                }
            }
        })
        .await;

        let elapsed = start.elapsed();

        assert!(
            exited.is_ok(),
            "idle timeout never fired – loop ran for >5 s (bug #1101)"
        );
        assert!(
            elapsed < Duration::from_millis(idle_timeout_ms + 500),
            "idle timeout took too long: {:?} (expected ~{} ms)",
            elapsed,
            idle_timeout_ms,
        );
    }

    /// Verify that `ChromeProcess::has_exited()` (which uses `Child::try_wait()`)
    /// correctly detects a killed child, the same way the drain interval does
    /// in the fixed daemon code. This ensures crash detection works without
    /// a SIGCHLD handler.
    #[cfg(unix)]
    #[test]
    fn test_has_exited_detects_killed_process() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn child");

        // Process should be running
        match child.try_wait() {
            Ok(None) => {} // expected
            other => panic!("expected Ok(None) for running process, got {:?}", other),
        }

        // Kill it (simulates Chrome crash)
        child.kill().expect("failed to kill child");
        std::thread::sleep(std::time::Duration::from_millis(100));

        // try_wait should detect the exit
        match child.try_wait() {
            Ok(Some(_)) => {} // expected: detected the crash
            other => panic!(
                "expected Ok(Some(_)) after kill, got {:?}. \
                 Crash detection via try_wait() must work for the drain \
                 interval fix (issue #1035) to function correctly.",
                other
            ),
        }
    }
}
