// SPDX-License-Identifier: Apache-2.0
//
// host-spike — Rust host shell feasibility probe.
//
// The question this binary answers: can a Rust `main()` own the kungfu
// process and drive the full runtime fabric that the Nuitka-frozen Python
// entrypoint owns today? Five steps, each independently reported:
//
//   1. link libkungfu, run the runtime-layer core init + a C++ journal
//      write/read roundtrip (via the one extern "C" shim seam);
//   2. embed python-build-standalone (the uv-managed CPython) — Py_Initialize;
//   3. `import pykungfu` inside the embedded interpreter;
//   4. a Python-level journal write/read roundtrip (real runtime, not a
//      compile check);
//   5. start libnode through the same pykungfu.libnode.run path the product
//      uses today, and prove control returns to the Rust host afterwards.
//
// Exit code 0 = all five steps PASS.

use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::time::Instant;

extern "C" {
    fn kf_shim_core_init(root: *const c_char) -> c_int;
    fn Py_Initialize();
    fn Py_IsInitialized() -> c_int;
    fn Py_FinalizeEx() -> c_int;
    fn PyRun_SimpleString(s: *const c_char) -> c_int;
}

fn step(n: u32, desc: &str, f: impl FnOnce() -> bool) -> bool {
    let started = Instant::now();
    let ok = f();
    println!(
        "[host-spike] step {n} {desc}: {} ({} ms)",
        if ok { "PASS" } else { "FAIL" },
        started.elapsed().as_millis()
    );
    ok
}

fn pyrun(code: &str) -> bool {
    let code = CString::new(code).expect("python snippet contains NUL");
    unsafe { PyRun_SimpleString(code.as_ptr()) == 0 }
}

const PY_ROUNDTRIP: &str = r#"
import os
import pykungfu
yjj = pykungfu.yijinjing
lf = pykungfu.longfist
root = os.environ['KF_SPIKE_ROOT']
locator = yjj.locator(root)
loc = yjj.location(lf.enums.mode.LIVE, lf.enums.category.SYSTEM, 'host_spike', 'py', locator)
w = yjj.writer(loc, 0, True, yjj.noop_publisher(), False, yjj.bus(False), 0)
payload = b'host-spike-py-roundtrip'
w.write_bytes(0, 20001, list(payload), len(payload))
header, data = yjj.assemble(loc, 0).read_bytes()[0]
assert header.msg_type == 20001, 'msg_type mismatch'
assert bytes(data)[:len(payload)] == payload, 'payload mismatch'
print('[py] journal roundtrip ok, frame_uid', hex(header.frame_uid))
# cross-language: read back the frame step 1 wrote from C++ under this host
cpp_loc = yjj.location(lf.enums.mode.LIVE, lf.enums.category.SYSTEM, 'host_spike', 'cpp', locator)
cpp_header, cpp_data = yjj.assemble(cpp_loc, 0).read_bytes()[0]
assert bytes(cpp_data).rstrip(b'\0') == b'host-spike-cpp-roundtrip', 'cpp frame not visible from python'
print('[py] cross-language readback ok: python read the frame the C++ side wrote')
"#;

const PY_LIBNODE: &str = r#"
import pykungfu
pykungfu.libnode.run('kf-host-spike', '-e', 'console.log("[node] hello from libnode under the rust host")')
print('[py] control returned from libnode to the embedded interpreter')
"#;

fn main() {
    // Baked at build time from the sibling core; runtime env overrides.
    let python_home =
        std::env::var("KF_SPIKE_PYTHON_HOME").unwrap_or_else(|_| env!("KF_SPIKE_PYTHON_HOME").to_string());
    let native_dir =
        std::env::var("KF_SPIKE_NATIVE_DIR").unwrap_or_else(|_| env!("KF_SPIKE_NATIVE_DIR").to_string());

    let root = std::env::temp_dir().join(format!("kf-host-spike-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("cannot create journal root");
    let root_str = root.to_str().expect("journal root not utf-8").to_string();
    println!("[host-spike] rust host up (pid {}), journal root {root_str}", std::process::id());

    // 1 — Rust owns main(), libkungfu does the core init.
    let ok1 = step(1, "libkungfu core init + C++ journal roundtrip", || {
        let root_c = CString::new(root_str.clone()).unwrap();
        unsafe { kf_shim_core_init(root_c.as_ptr()) == 0 }
    });

    // 2 — embed python-build-standalone. Env must be staged before init.
    std::env::set_var("PYTHONHOME", &python_home);
    std::env::set_var("PYTHONPATH", &native_dir);
    std::env::set_var("PYTHONDONTWRITEBYTECODE", "1");
    std::env::set_var("KF_SPIKE_ROOT", &root_str);
    let ok2 = step(2, "embed python-build-standalone (Py_Initialize)", || {
        unsafe { Py_Initialize() };
        let initialized = unsafe { Py_IsInitialized() } != 0;
        initialized && pyrun("import sys; print('[py]', sys.version.split()[0], 'prefix', sys.prefix)")
    });

    // 3 — the binding loads into the embedded interpreter.
    let ok3 = ok2 && step(3, "import pykungfu", || {
        pyrun("import pykungfu; print('[py] pykungfu loaded from', pykungfu.__file__)")
    });

    // 4 — real runtime evidence: a journal frame survives write → read.
    let ok4 = ok3 && step(4, "python journal roundtrip", || pyrun(PY_ROUNDTRIP));

    // 5 — the node satellite answers under the new host, then hands back.
    let ok5 = ok3 && step(5, "libnode starts and returns control", || pyrun(PY_LIBNODE));

    if ok2 {
        unsafe { Py_FinalizeEx() };
    }

    let all = [ok1, ok2, ok3, ok4, ok5];
    let passed = all.iter().filter(|&&b| b).count();
    println!("[host-spike] {passed}/5 steps passed");
    std::process::exit(if passed == all.len() { 0 } else { 1 });
}
