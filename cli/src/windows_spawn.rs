//! Windows process creation that hands a child only the handles it is given.
//!
//! `std::process::Command` creates children with handle inheritance on, so a
//! child receives every inheritable handle in this process, including any a
//! caller passed to us, such as an extra pipe from Python with
//! `close_fds=False`. A detached background process would keep those handles,
//! and a caller waiting for them to close, open until it exits.
//! `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` limits inheritance to an explicit list.

use std::collections::BTreeMap;
use std::ffi::{c_void, OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::marker::PhantomData;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::process::{Command, ExitStatus};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{
    DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

/// A detached background process. Dropping it leaves the process running.
pub(crate) struct DetachedChild {
    process: OwnedHandle,
    pid: u32,
    pub stderr: Option<File>,
}

impl DetachedChild {
    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn kill(&mut self) -> io::Result<()> {
        // SAFETY: process is our owned handle to the process we created.
        check(unsafe { TerminateProcess(raw(&self.process), 1) })
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: process stays owned for both calls. Waiting first means an
        // exit code of STILL_ACTIVE (259) is not mistaken for a running process.
        match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                check(unsafe { GetExitCodeProcess(raw(&self.process), &mut code) })?;
                Ok(Some(ExitStatus::from_raw(code)))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

/// Starts `command` without a console in a new process group, with stdin and
/// stdout on NUL and stderr on NUL or, with `capture_stderr`, a pipe. The child
/// inherits no other handle. Uses the program, arguments, environment changes,
/// and working directory of `command`; `Command::env_clear` is not supported.
pub(crate) fn spawn_detached(command: &Command, capture_stderr: bool) -> io::Result<DetachedChild> {
    let application = wide(command.get_program())?;
    let mut command_line = quoted(command.get_program())?;
    for arg in command.get_args() {
        command_line.push(b' ' as u16);
        command_line.extend(quoted(arg)?);
    }
    command_line.push(0);
    let environment = environment_block(command)?;
    let current_dir = command
        .get_current_dir()
        .map(|dir| wide(dir.as_os_str()))
        .transpose()?;

    let null_file = OpenOptions::new().read(true).write(true).open("NUL")?;
    let null_handle = inheritable(null_file.as_raw_handle() as HANDLE)?;
    let stderr_pipe = if capture_stderr {
        Some(io::pipe()?)
    } else {
        None
    };
    let stderr_handle = stderr_pipe
        .as_ref()
        .map(|(_, writer)| inheritable(writer.as_raw_handle() as HANDLE))
        .transpose()?;
    // The list must not repeat a handle, so NUL appears once for all streams.
    let mut handles = vec![raw(&null_handle)];
    handles.extend(stderr_handle.as_ref().map(raw));
    let mut attributes = AttributeList::new(1)?;
    attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = size_of_val(&startup) as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw(&null_handle);
    startup.StartupInfo.hStdOutput = raw(&null_handle);
    startup.StartupInfo.hStdError = stderr_handle.as_ref().map_or(raw(&null_handle), raw);
    startup.lpAttributeList = attributes.as_ptr();
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: All strings, the environment block, attribute values, and the
    // listed handles stay alive through CreateProcessW.
    check(unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            DETACHED_PROCESS
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            current_dir.as_ref().map_or(null(), |dir| dir.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    })?;
    // SAFETY: Successful CreateProcessW transfers these two valid handles to us.
    let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess as *mut c_void) };
    let _thread = unsafe { OwnedHandle::from_raw_handle(info.hThread as *mut c_void) };
    Ok(DetachedChild {
        process,
        pid: info.dwProcessId,
        stderr: stderr_pipe.map(|(reader, _)| File::from(OwnedHandle::from(reader))),
    })
}

/// This process's environment with the changes made on `command`, as a sorted
/// block of `name=value` strings. Windows names are case-insensitive.
fn environment_block(command: &Command) -> io::Result<Vec<u16>> {
    let mut variables: BTreeMap<OsString, (OsString, OsString)> = std::env::vars_os()
        .map(|(name, value)| (name.to_ascii_uppercase(), (name, value)))
        .collect();
    for (name, value) in command.get_envs() {
        let key = name.to_ascii_uppercase();
        match value {
            Some(value) => {
                variables.insert(key, (name.to_owned(), value.to_owned()));
            }
            None => {
                variables.remove(&key);
            }
        }
    }
    let mut block = Vec::new();
    for (name, value) in variables.into_values() {
        let mut entry = name;
        entry.push("=");
        entry.push(value);
        block.extend(wide(&entry)?);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// Attribute storage must be aligned and must outlive CreateProcessW.
pub(crate) struct AttributeList<'a>(Vec<usize>, PhantomData<&'a [HANDLE]>);

impl<'a> AttributeList<'a> {
    pub fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: The first call queries the required allocation size.
        unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes) };
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        check(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut bytes)
        })?;
        Ok(Self(storage, PhantomData))
    }

    pub fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_mut_ptr().cast()
    }

    pub fn add(&mut self, key: u32, handles: &'a [HANDLE]) -> io::Result<()> {
        // SAFETY: Callers retain the handle arrays until after CreateProcessW.
        check(unsafe {
            UpdateProcThreadAttribute(
                self.as_ptr(),
                0,
                key as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        })
    }
}

impl Drop for AttributeList<'_> {
    fn drop(&mut self) {
        // SAFETY: Only initialized lists are constructed; storage is still live.
        unsafe { DeleteProcThreadAttributeList(self.as_ptr()) };
    }
}

pub(crate) fn check(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

pub(crate) fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle == 0 {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: Called only for newly created, non-null handles.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle as *mut c_void) })
    }
}

/// An inheritable duplicate of `handle`, for a child's handle list.
pub(crate) fn inheritable(handle: HANDLE) -> io::Result<OwnedHandle> {
    let mut duplicate = 0;
    // SAFETY: Duplicate into our process; ownership is transferred below.
    check(unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            GetCurrentProcess(),
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    })?;
    owned(duplicate)
}

pub(crate) fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in process argument or environment",
        ));
    }
    value.push(0);
    Ok(value)
}

/// Quote a single argument for the Windows C runtime. Backslashes are doubled
/// only before a quote or the closing quote, preserving paths and JSON.
pub(crate) fn quoted(value: &OsStr) -> io::Result<Vec<u16>> {
    let value = wide(value)?;
    let mut output = vec![b'"' as u16];
    let mut slashes = 0;
    for &ch in &value[..value.len() - 1] {
        if ch == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        if ch == b'"' as u16 {
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes + 1));
        }
        output.push(ch);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    const TEST_DIR: &str = "AGENT_BROWSER_TEST_WINDOWS_SPAWN_DIR";
    const REMOVED: &str = "AGENT_BROWSER_TEST_WINDOWS_SPAWN_REMOVED";
    const SET: &str = "AGENT_BROWSER_TEST_WINDOWS_SPAWN_SET";

    fn helper(name: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            &format!("windows_spawn::tests::{name}"),
            "--ignored",
            "--nocapture",
        ]);
        command
    }

    struct Killed(DetachedChild);

    impl Drop for Killed {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }

    #[test]
    #[ignore = "internal subprocess helper"]
    fn detached_helper() {
        let dir = PathBuf::from(std::env::var_os(TEST_DIR).unwrap());
        let cwd = std::env::current_dir().unwrap();
        let removed = std::env::var_os(REMOVED);
        let set = std::env::var_os(SET);
        std::fs::write(dir.join("seen.txt"), format!("{cwd:?} {removed:?} {set:?}")).unwrap();
        eprintln!("detached helper ready");
        // Bound helper lifetime even if the parent test panics.
        std::thread::sleep(Duration::from_secs(30));
    }

    /// Runs in its own process so that no concurrent test spawns a child that
    /// inherits the pipe below while it is inheritable.
    #[test]
    #[ignore = "internal subprocess helper"]
    fn leak_check_helper() {
        let dir = PathBuf::from(std::env::var_os(TEST_DIR).unwrap());
        // An inheritable pipe in this process, like one a caller passed to the CLI.
        let (mut leaked_reader, writer) = io::pipe().unwrap();
        let leaked_writer = inheritable(writer.as_raw_handle() as HANDLE).unwrap();
        drop(writer);

        let mut command = helper("detached_helper");
        command
            .env_remove(REMOVED)
            .env(SET, "from command")
            .current_dir(&dir);
        let mut child = Killed(spawn_detached(&command, true).unwrap());
        drop(leaked_writer);

        let mut ready = String::new();
        BufReader::new(child.0.stderr.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "detached helper ready");
        assert_eq!(
            std::fs::read_to_string(dir.join("seen.txt")).unwrap(),
            format!("{dir:?} None Some(\"from command\")")
        );

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = sender.send(leaked_reader.read_to_end(&mut bytes).map(|_| bytes));
        });
        let eof = receiver.recv_timeout(Duration::from_secs(5));
        assert!(child.0.try_wait().unwrap().is_none());
        assert!(
            matches!(eof, Ok(Ok(ref bytes)) if bytes.is_empty()),
            "the detached child inherited a pipe it was not given: {eof:?}"
        );
    }

    #[test]
    fn detached_child_inherits_only_its_standard_handles() {
        let dir = tempfile::tempdir().unwrap();
        let output = helper("leak_check_helper")
            .env(TEST_DIR, dir.path())
            .env(REMOVED, "from parent")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn quotes_preserve_paths_quotes_and_empty_arguments() {
        for (input, expected) in [
            ("", "\"\""),
            ("plain", "\"plain\""),
            (
                r"C:\profile with spaces\",
                "\"C:\\profile with spaces\\\\\"",
            ),
            ("a\"b", "\"a\\\"b\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
            ("你好", "\"你好\""),
        ] {
            assert_eq!(
                String::from_utf16(&quoted(OsStr::new(input)).unwrap()).unwrap(),
                expected
            );
        }
        assert!(quoted(OsStr::new("a\0b")).is_err());
    }
}
