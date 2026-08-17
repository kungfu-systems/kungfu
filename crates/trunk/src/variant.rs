// SPDX-License-Identifier: Apache-2.0
//
// Variant dispatch at the trunk front door (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 3).
//
// The `kungfu` binary can be asked to *be* the embedded Node runtime by setting
// KUNGFU_AS_VARIANT=node (the same env the Python-side variant table reads). Today
// that path boots CPython just to reach node::Start through the pykungfu binding;
// KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 wants node-only invocations to never initialize Python. This module
// runs the node variant natively: it dlopens the standalone node-host library the
// product ships next to this binary and calls its C entry (node::Start), so the
// domain runtime — CPython — is never initialized.
//
// It degrades gracefully. If the host library is absent — a dev build, or any
// build that did not stage it — `dispatch` returns None and the caller falls
// through to the existing launch path, where the Python variant table still runs
// node. The native path is therefore a pure fast-path with zero behavior change
// when the library is not present.
//
// The `python` variant deliberately stays Python-side: its dispatch is pervasively
// kungfu-aware (the `-m` redirect to `kungfu.cli.bridging` shims, dist-module
// resolution), so it is not a mechanical "be python" the trunk can own.

use std::env;
use std::ffi::OsStr;

/// The env the variant table reads to decide the process should *be* a variant.
const ENV_VARIANT_KEY: &str = "KUNGFU_AS_VARIANT";
/// Optional exact argv[1] that owns one internal Node-variant invocation.
const ENV_VARIANT_ENTRY_KEY: &str = "KUNGFU_NODE_VARIANT_ENTRY";
/// Node sets this private descriptor only for a child created through
/// `child_process.fork`. Such a child is another Node module invocation even
/// when argv[1] differs from the parent worker's scoped entry.
const ENV_NODE_CHANNEL_FD_KEY: &str = "NODE_CHANNEL_FD";

/// The standalone node-host library the product ships next to this binary; it
/// exports the C entry `kungfu_node_run` (a thin wrapper over node::Start).
/// Note the Windows name has no `lib` prefix: MSVC `add_library(... SHARED)`
/// produces `kungfu_node_host.dll`, not `libkungfu_node_host.dll`.
#[cfg(target_os = "macos")]
const NODE_HOST_LIB: &str = "libkungfu_node_host.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
const NODE_HOST_LIB: &str = "libkungfu_node_host.so";
#[cfg(windows)]
const NODE_HOST_LIB: &str = "kungfu_node_host.dll";

#[cfg(unix)]
const RTLD_NOW: std::ffi::c_int = 2;
// `RTLD_GLOBAL` is platform-defined rather than POSIX-numeric.  The embedded
// Node host must publish libnode's N-API exports so native addons loaded later
// by Node (for example node-pty) can resolve them from the process scope.
#[cfg(target_os = "macos")]
const RTLD_GLOBAL: std::ffi::c_int = 0x8;
#[cfg(all(unix, not(target_os = "macos")))]
const RTLD_GLOBAL: std::ffi::c_int = 0x100;

#[cfg(unix)]
fn node_host_loader_flags() -> std::ffi::c_int {
    RTLD_NOW | RTLD_GLOBAL
}

pub fn native_node_available() -> bool {
    env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|root| root.join(NODE_HOST_LIB)))
        .is_some_and(|path| path.is_file())
}

/// If this process was asked to be a variant the trunk can own natively, run it
/// to completion and return `Some(exit_code)`. Return `None` to fall through to
/// the normal launch path, where the Python variant table still handles it.
pub fn dispatch() -> Option<i32> {
    match env::var(ENV_VARIANT_KEY).ok().as_deref() {
        Some("node")
            if node_variant_entry_matches(
                env::var_os(ENV_VARIANT_ENTRY_KEY).as_deref(),
                env::args_os().nth(1).as_deref(),
                env::var_os(ENV_NODE_CHANNEL_FD_KEY).as_deref(),
            ) =>
        {
            // This fast path bypasses the normal product launch functions, so
            // the worker itself must establish the external Python cache
            // contract before it can launch any bundled interpreter child.
            if let Err(message) = crate::launch::configure_product_cache_environment() {
                eprintln!("kungfu: {message}");
                return Some(1);
            }
            run_node()
        }
        Some("node") => {
            // A scoped Node host may launch the public Kungfu front door as a
            // child adapter.  Do not let its private variant marker turn the
            // child's first public argument into a Node module path.
            env::remove_var(ENV_VARIANT_KEY);
            env::remove_var(ENV_VARIANT_ENTRY_KEY);
            None
        }
        _ => None,
    }
}

fn scoped_entry_matches(expected: Option<&OsStr>, actual: Option<&OsStr>) -> bool {
    expected.is_none() || expected == actual
}

fn node_variant_entry_matches(
    expected: Option<&OsStr>,
    actual: Option<&OsStr>,
    node_channel_fd: Option<&OsStr>,
) -> bool {
    scoped_entry_matches(expected, actual) || node_channel_fd.is_some()
}

/// The C entry the node-host exports: `int kungfu_node_run(int argc, char **argv)`.
#[cfg(any(unix, windows))]
type NodeRunFn = extern "C" fn(std::ffi::c_int, *mut *mut std::ffi::c_char) -> std::ffi::c_int;

/// Build one contiguous, heap-owned, mutable UTF-8 argv buffer.
///
/// node::Start may permute the pointer array and its Windows bootstrap also
/// expects the argument strings to share one contiguous allocation. This
/// mirrors the long-standing Python/libnode bridge instead of allocating one
/// CString per argument, which truncated an absolute Windows entry path to
/// its drive designator (C:).
#[cfg(any(unix, windows))]
fn contiguous_node_argv(
    arguments: impl IntoIterator<Item = Vec<u8>>,
) -> (Vec<u8>, Vec<*mut std::ffi::c_char>) {
    use std::ffi::c_char;

    let arguments: Vec<Vec<u8>> = arguments.into_iter().collect();
    let total_size = arguments.iter().map(|argument| argument.len() + 1).sum();
    let mut buffer = Vec::with_capacity(total_size);
    let mut offsets = Vec::with_capacity(arguments.len());
    for argument in arguments {
        debug_assert!(
            !argument.contains(&0),
            "process arguments cannot contain NUL bytes"
        );
        offsets.push(buffer.len());
        buffer.extend_from_slice(&argument);
        buffer.push(0);
    }
    let base = buffer.as_mut_ptr();
    let argv = offsets
        .into_iter()
        .map(|offset| unsafe { base.add(offset).cast::<c_char>() })
        .collect();
    (buffer, argv)
}

/// Hand contiguous, mutable UTF-8 argv to the node-host entry. node::Start owns
/// the process for its lifetime and may permute argv, so both allocations stay
/// live until it returns. Shared by every platform loader so the argv contract
/// lives in one place.
#[cfg(any(unix, windows))]
fn invoke_node(run: NodeRunFn) -> i32 {
    use std::ffi::c_int;

    let (_buffer, mut argv) =
        contiguous_node_argv(env::args_os().map(|argument| os_arg_bytes(&argument)));
    let argc = argv.len() as c_int;
    run(argc, argv.as_mut_ptr())
}

/// argv bytes for the node-host: raw bytes on unix (exact), lossy UTF-8 on
/// Windows (args arrive as UTF-16; node itself works in UTF-8 argv).
#[cfg(unix)]
fn os_arg_bytes(arg: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    arg.as_bytes().to_vec()
}
#[cfg(windows)]
fn os_arg_bytes(arg: &std::ffi::OsStr) -> Vec<u8> {
    arg.to_string_lossy().into_owned().into_bytes()
}

#[cfg(unix)]
fn run_node() -> Option<i32> {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;

    // POSIX dynamic-loader entry points; std-only, no crate dependency.
    extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    // The host library ships next to this binary (dist/kungfu). If we cannot even
    // resolve our own path, fall through rather than guess.
    let exe = env::current_exe().ok()?;
    let lib_path: PathBuf = exe.parent()?.join(NODE_HOST_LIB);
    let lib_c = CString::new(lib_path.as_os_str().as_bytes()).ok()?;

    // Absent library → not the product build → fall through to the Python path.
    let handle = unsafe { dlopen(lib_c.as_ptr(), node_host_loader_flags()) };
    if handle.is_null() {
        return None;
    }
    let symbol = CString::new("kungfu_node_run").unwrap();
    let entry = unsafe { dlsym(handle, symbol.as_ptr()) };
    if entry.is_null() {
        return None;
    }
    let run: NodeRunFn = unsafe { std::mem::transmute(entry) };
    Some(invoke_node(run))
}

#[cfg(windows)]
fn run_node() -> Option<i32> {
    use std::ffi::{c_char, c_void, CString};
    use std::os::windows::ffi::OsStrExt;

    // Win32 loader entry points from kernel32; std-only, no crate dependency.
    // `extern "system"` is the stdcall/x64 ABI these use.
    extern "system" {
        fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const c_char) -> *mut c_void;
        fn FreeLibrary(h_lib_module: *mut c_void) -> i32;
    }

    // The host DLL ships next to this binary (dist/kungfu); the exe directory is
    // not searched for the host's dependencies when the host is loaded by an
    // absolute path on Windows. Preload the sibling libnode.dll by its exact path
    // so loading the host cannot silently fall through to the Python variant.
    // If we cannot resolve our own path, fall through rather than guess.
    let exe = env::current_exe().ok()?;
    let runtime_dir = exe.parent()?;
    let libnode_path = runtime_dir.join("libnode.dll");
    let lib_path = runtime_dir.join(NODE_HOST_LIB);
    // LoadLibraryW wants a NUL-terminated wide string.
    let libnode_wide: Vec<u16> = libnode_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide: Vec<u16> = lib_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // Absent dependency or host → not a complete product build → fall through
    // to the Python path. Release the dependency on a failed native admission;
    // successful node::Start owns the process lifetime, as before.
    let libnode_handle = unsafe { LoadLibraryW(libnode_wide.as_ptr()) };
    if libnode_handle.is_null() {
        return None;
    }
    let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
    if handle.is_null() {
        unsafe { FreeLibrary(libnode_handle) };
        return None;
    }
    let symbol = CString::new("kungfu_node_run").unwrap();
    let entry = unsafe { GetProcAddress(handle, symbol.as_ptr()) };
    if entry.is_null() {
        unsafe {
            FreeLibrary(handle);
            FreeLibrary(libnode_handle);
        }
        return None;
    }
    let run: NodeRunFn = unsafe { std::mem::transmute(entry) };
    // Deliberately no FreeLibrary: node::Start owns the process and normally exits
    // it; on the rare return the process is ending anyway.
    Some(invoke_node(run))
}

#[cfg(not(any(unix, windows)))]
fn run_node() -> Option<i32> {
    // No native loader for this platform → fall through to the Python variant
    // path, the current behavior.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    // One serial test: `dispatch` reads a process-global env var, so the cases must
    // not run concurrently (cargo runs tests in one binary on parallel threads).
    #[test]
    fn dispatch_falls_through_except_for_ownable_variants() {
        let prior = env::var(ENV_VARIANT_KEY).ok();
        let prior_entry = env::var_os(ENV_VARIANT_ENTRY_KEY);

        assert!(scoped_entry_matches(None, Some(OsStr::new("agent"))));
        assert!(scoped_entry_matches(
            Some(OsStr::new("/exact/runner.mjs")),
            Some(OsStr::new("/exact/runner.mjs")),
        ));
        assert!(!scoped_entry_matches(
            Some(OsStr::new("/exact/runner.mjs")),
            Some(OsStr::new("agent")),
        ));
        assert!(node_variant_entry_matches(
            Some(OsStr::new("C:\\product\\tui\\agent-session-worker.mjs")),
            Some(OsStr::new(
                "C:\\product\\tui\\node_modules\\node-pty\\lib\\conpty_console_list_agent"
            )),
            Some(OsStr::new("3")),
        ));
        assert!(!node_variant_entry_matches(
            Some(OsStr::new("C:\\product\\tui\\agent-session-worker.mjs")),
            Some(OsStr::new("C:\\product\\runtime\\public-adapter.mjs")),
            None,
        ));

        // No variant requested → fall through.
        env::remove_var(ENV_VARIANT_KEY);
        env::remove_var(ENV_VARIANT_ENTRY_KEY);
        assert_eq!(dispatch(), None);

        // A variant the trunk does not own natively (python) → fall through.
        env::set_var(ENV_VARIANT_KEY, "python");
        assert_eq!(dispatch(), None);

        // A scoped node request cannot leak into a child public CLI invocation.
        env::set_var(ENV_VARIANT_KEY, "node");
        env::set_var(ENV_VARIANT_ENTRY_KEY, "/not/the/test/entry.mjs");
        assert_eq!(dispatch(), None);
        assert_eq!(env::var_os(ENV_VARIANT_KEY), None);
        assert_eq!(env::var_os(ENV_VARIANT_ENTRY_KEY), None);

        // node with no host library next to the test binary → the native path must
        // return None (delegating to the Python variant), never crash. This is the
        // zero-regression guarantee for any build that did not stage the launcher.
        env::set_var(ENV_VARIANT_KEY, "node");
        assert_eq!(dispatch(), None);

        match prior {
            Some(v) => env::set_var(ENV_VARIANT_KEY, v),
            None => env::remove_var(ENV_VARIANT_KEY),
        }
        match prior_entry {
            Some(v) => env::set_var(ENV_VARIANT_ENTRY_KEY, v),
            None => env::remove_var(ENV_VARIANT_ENTRY_KEY),
        }
    }

    #[test]
    fn node_argv_uses_one_contiguous_mutable_buffer() {
        let arguments = [
            b"C:\\Kungfu\\runtime\\kungfu.exe".to_vec(),
            b"C:\\Kungfu\\tui\\tui.mjs".to_vec(),
            b"--project".to_vec(),
        ];
        let expected_size: usize = arguments.iter().map(|argument| argument.len() + 1).sum();
        let (buffer, argv) = contiguous_node_argv(arguments.clone());

        assert_eq!(buffer.len(), expected_size);
        assert_eq!(argv.len(), arguments.len());
        let base = buffer.as_ptr() as usize;
        let mut expected_offset = 0;
        for (index, expected) in arguments.iter().enumerate() {
            assert_eq!(argv[index] as usize, base + expected_offset);
            assert_eq!(
                unsafe { CStr::from_ptr(argv[index]) }.to_bytes(),
                expected.as_slice()
            );
            expected_offset += expected.len() + 1;
        }
    }

    #[cfg(unix)]
    #[test]
    fn node_host_loader_publishes_native_addon_symbols() {
        let flags = node_host_loader_flags();
        assert_ne!(flags & RTLD_NOW, 0);
        assert_ne!(flags & RTLD_GLOBAL, 0);
    }
}
