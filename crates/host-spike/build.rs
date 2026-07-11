// SPDX-License-Identifier: Apache-2.0
//
// Build script for the host-spike probe.
//
// The probe never builds the C++ core itself: it borrows a fully built sibling
// core (headers + build/Release dylibs + compile_commands.json + .venv) and
// compiles one small C++ shim against it, reusing the exact compiler flags the
// sibling build used (so the shim matches the dylib's ABI vintage). std-only:
// the shim is compiled by shelling out to the system C++ compiler, not via a
// build-dependency crate.
//
// Inputs (all overridable by env):
//   KF_SPIKE_SIBLING_CORE  path to a built framework/core (default ../../framework/core)
//   KF_SPIKE_NATIVE_DIR    dir holding libkungfu.dylib + pykungfu (default <core>/build/Release)
//   KF_SPIKE_PYTHON_HOME   python-build-standalone prefix (default resolved from <core>/.venv)

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=shim/host_shim.cpp");
    println!("cargo:rerun-if-changed=src/embedding.rs");
    println!("cargo:rerun-if-env-changed=KF_SPIKE_SIBLING_CORE");
    println!("cargo:rerun-if-env-changed=KF_SPIKE_NATIVE_DIR");
    println!("cargo:rerun-if-env-changed=KF_SPIKE_PYTHON_HOME");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let core = env::var("KF_SPIKE_SIBLING_CORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join("../../framework/core"))
        .canonicalize()
        .expect(
            "sibling core not found; set KF_SPIKE_SIBLING_CORE to a fully built framework/core",
        );

    let native_dir = env::var("KF_SPIKE_NATIVE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| core.join("build/Release"))
        .canonicalize()
        .expect("native dir not found; set KF_SPIKE_NATIVE_DIR to a dir holding libkungfu.dylib + pykungfu");

    // ── compile flags: replay the sibling build's own flags for io.cpp ──
    let ccj = core.join("build/compile_commands.json");
    let text = fs::read_to_string(&ccj)
        .unwrap_or_else(|_| panic!("{} missing; build the sibling core first", ccj.display()));
    let command = io_cpp_command(&text).expect(
        "compile_commands.json has no io/io.cpp entry; is the sibling core fully configured?",
    );
    let flags = shim_flags(&command);

    let shim_src = manifest.join("shim/host_shim.cpp");
    let shim_obj = out_dir.join("host_shim.o");
    let shim_lib = out_dir.join("libhost_shim.a");

    run(Command::new("c++")
        .args(&flags)
        .arg("-O0")
        .arg("-c")
        .arg(&shim_src)
        .arg("-o")
        .arg(&shim_obj));
    let _ = fs::remove_file(&shim_lib);
    run(Command::new("ar").arg("rcs").arg(&shim_lib).arg(&shim_obj));

    // ── python-build-standalone prefix, resolved from the sibling .venv ──
    let python_home = env::var("KF_SPIKE_PYTHON_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let interp = core
                .join(".venv/bin/python3")
                .canonicalize()
                .expect("sibling .venv missing; run `uv sync --frozen` in the sibling core or set KF_SPIKE_PYTHON_HOME");
            interp.parent().unwrap().parent().unwrap().to_path_buf()
        });
    let python_lib_dir = python_home.join("lib");
    let python_lib = fs::read_dir(&python_lib_dir)
        .expect("python home has no lib/")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with("libpython3.") && n.ends_with(".dylib"))
        .expect("no libpython3.*.dylib under python home lib/");
    let python_link_name = python_lib
        .trim_start_matches("lib")
        .trim_end_matches(".dylib")
        .to_string();

    // ── link directives ──
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=host_shim");
    println!("cargo:rustc-link-search=native={}", native_dir.display());
    println!("cargo:rustc-link-lib=dylib=kungfu");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", native_dir.display());
    println!(
        "cargo:rustc-link-search=native={}",
        python_lib_dir.display()
    );
    println!("cargo:rustc-link-lib=dylib={}", python_link_name);
    println!("cargo:rustc-link-lib=dylib=c++");

    // Bake the resolved defaults into the binary; runtime env still overrides.
    println!(
        "cargo:rustc-env=KF_SPIKE_PYTHON_HOME={}",
        python_home.display()
    );
    println!(
        "cargo:rustc-env=KF_SPIKE_NATIVE_DIR={}",
        native_dir.display()
    );
}

/// Pull the `command` string of the io/io.cpp entry out of compile_commands.json.
/// CMake emits one key per line, so a line-oriented scan is enough here — the
/// probe deliberately avoids pulling in a JSON crate.
fn io_cpp_command(text: &str) -> Option<String> {
    let mut last_command: Option<&str> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("\"command\":") {
            last_command = rest
                .trim()
                .strip_prefix('"')
                .and_then(|s| s.rfind('"').map(|i| &s[..i]));
        }
        if trimmed.starts_with("\"file\":") && trimmed.contains("io/io.cpp") {
            return last_command.map(unescape_json);
        }
    }
    None
}

fn unescape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Keep include/define/std/arch/sysroot/warning flags; drop compiler name,
/// -O/-o/-c and the source file itself.
fn shim_flags(command: &str) -> Vec<String> {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let mut flags = Vec::new();
    let mut i = 1; // skip compiler
    while i < tokens.len() {
        let t = tokens[i];
        match t {
            "-isystem" | "-isysroot" | "-arch" => {
                flags.push(t.to_string());
                if i + 1 < tokens.len() {
                    flags.push(tokens[i + 1].to_string());
                    i += 1;
                }
            }
            "-o" | "-c" => {
                i += 1; // skip the value / handled by us
            }
            _ if t.starts_with("-I")
                || t.starts_with("-D")
                || t.starts_with("-std=")
                || t.starts_with("-W")
                || t == "-fPIC" =>
            {
                flags.push(t.to_string());
            }
            _ => {}
        }
        i += 1;
    }
    flags
}

fn run(cmd: &mut Command) {
    let rendered = format!("{:?}", cmd);
    let status = cmd
        .status()
        .unwrap_or_else(|e| panic!("failed to spawn {rendered}: {e}"));
    if !status.success() {
        panic!("command failed ({status}): {rendered}");
    }
}
