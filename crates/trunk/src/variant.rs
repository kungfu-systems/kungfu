// SPDX-License-Identifier: Apache-2.0
//
// Variant dispatch at the trunk front door (ADR-0046 stage 3).
//
// The `kungfu` binary can be asked to *be* the embedded Node runtime by setting
// KUNGFU_AS_VARIANT=node (the same env the Python-side variant table reads). Today
// that path boots CPython just to reach node::Start through the pykungfu binding;
// ADR-0046 wants node-only invocations to never initialize Python. This module
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

/// The env the variant table reads to decide the process should *be* a variant.
const ENV_VARIANT_KEY: &str = "KUNGFU_AS_VARIANT";

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

/// If this process was asked to be a variant the trunk can own natively, run it
/// to completion and return `Some(exit_code)`. Return `None` to fall through to
/// the normal launch path, where the Python variant table still handles it.
pub fn dispatch() -> Option<i32> {
    match env::var(ENV_VARIANT_KEY).ok().as_deref() {
        Some("node") => run_node(),
        _ => None,
    }
}

/// The C entry the node-host exports: `int kungfu_node_run(int argc, char **argv)`.
#[cfg(any(unix, windows))]
type NodeRunFn = extern "C" fn(std::ffi::c_int, *mut *mut std::ffi::c_char) -> std::ffi::c_int;

/// Build heap-owned, mutable UTF-8 argv copies and hand them to the node-host
/// entry. node::Start owns the process for its lifetime and may permute argv, so
/// the copies must be heap-owned (argv[0] = program name, matching sys.argv). The
/// copies are reclaimed only if node::Start returns rather than exiting the
/// process itself. Shared by every platform loader so the argv contract lives in
/// one place.
#[cfg(any(unix, windows))]
fn invoke_node(run: NodeRunFn) -> i32 {
    use std::ffi::{c_char, c_int, CString};

    let mut argv: Vec<*mut c_char> = env::args_os()
        .map(|arg| {
            CString::new(os_arg_bytes(&arg))
                .unwrap_or_default()
                .into_raw()
        })
        .collect();
    let argc = argv.len() as c_int;
    let code = run(argc, argv.as_mut_ptr());
    for ptr in argv {
        unsafe { drop(CString::from_raw(ptr)) };
    }
    code as i32
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
    const RTLD_NOW: c_int = 2;
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
    let handle = unsafe { dlopen(lib_c.as_ptr(), RTLD_NOW) };
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
    }

    // The host DLL ships next to this binary (dist/kungfu); the exe directory is
    // on the default DLL search path. If we cannot resolve our own path, fall
    // through rather than guess.
    let exe = env::current_exe().ok()?;
    let lib_path = exe.parent()?.join(NODE_HOST_LIB);
    // LoadLibraryW wants a NUL-terminated wide string.
    let wide: Vec<u16> = lib_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // Absent library → not the product build → fall through to the Python path.
    let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    let symbol = CString::new("kungfu_node_run").unwrap();
    let entry = unsafe { GetProcAddress(handle, symbol.as_ptr()) };
    if entry.is_null() {
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

    // One serial test: `dispatch` reads a process-global env var, so the cases must
    // not run concurrently (cargo runs tests in one binary on parallel threads).
    #[test]
    fn dispatch_falls_through_except_for_ownable_variants() {
        let prior = env::var(ENV_VARIANT_KEY).ok();

        // No variant requested → fall through.
        env::remove_var(ENV_VARIANT_KEY);
        assert_eq!(dispatch(), None);

        // A variant the trunk does not own natively (python) → fall through.
        env::set_var(ENV_VARIANT_KEY, "python");
        assert_eq!(dispatch(), None);

        // node with no host library next to the test binary → the native path must
        // return None (delegating to the Python variant), never crash. This is the
        // zero-regression guarantee for any build that did not stage the launcher.
        env::set_var(ENV_VARIANT_KEY, "node");
        assert_eq!(dispatch(), None);

        match prior {
            Some(v) => env::set_var(ENV_VARIANT_KEY, v),
            None => env::remove_var(ENV_VARIANT_KEY),
        }
    }
}
