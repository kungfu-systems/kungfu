// SPDX-License-Identifier: Apache-2.0
//
// Windows MSVC environment absorption (port of the CI wrapper's
// ensureWindowsMsvcEnv): when cl.exe is not on PATH, locate vcvars64.bat
// (VSINSTALLDIR, then vswhere, then a bounded scan of the Visual Studio
// install roots), run it through cmd.exe, and merge the resulting environment
// into this process so the C++ core build finds the toolchain.
//
// Missing MSVC is a warning by default — most tasks (lint, tests, config) do
// not need cl.exe and the build itself fails with a clear cause if it comes to
// that. CI sets SHIFU_REQUIRE_MSVC=1 to make it a hard error instead.

#![cfg(windows)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::util;

pub fn ensure_msvc_env(root: &Path) {
    if cl_available(root) {
        return;
    }
    let Some(vcvars) = vcvars_candidates().into_iter().next() else {
        let msg = "MSVC cl.exe not found in PATH and vcvars64.bat could not be located";
        if env::var_os("SHIFU_REQUIRE_MSVC").is_some_and(|v| v == "1") {
            util::die(msg);
        }
        eprintln!("shifu: warning: {msg}; C++ builds will fail until Visual Studio Build Tools are installed");
        return;
    };

    eprintln!("shifu: cl.exe not found; loading {}", vcvars.display());
    let mut cmd = Command::new("cmd.exe");
    {
        use std::os::windows::process::CommandExt;
        cmd.arg("/d").arg("/s").arg("/c");
        cmd.raw_arg(format!("\"\"{}\" x64 >nul && set\"", vcvars.display()));
    }
    let out = cmd
        .current_dir(root)
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output();
    let Ok(out) = out else {
        util::die("failed to run cmd.exe for the MSVC environment bootstrap");
    };
    if !out.status.success() {
        util::die(&format!(
            "MSVC environment bootstrap failed with exit {:?}",
            out.status.code()
        ));
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some((key, value)) = line.split_once('=') {
            if !key.is_empty() {
                env::set_var(key, value);
            }
        }
    }
    if !cl_available(root) {
        util::die("MSVC environment bootstrap did not produce cl.exe in PATH");
    }
}

fn cl_available(root: &Path) -> bool {
    Command::new("where.exe")
        .arg("cl")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn program_files_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(v) = env::var_os(key) {
            if !v.is_empty() {
                roots.push(PathBuf::from(v));
            }
        }
    }
    roots.push(PathBuf::from("C:\\Program Files"));
    roots.push(PathBuf::from("C:\\Program Files (x86)"));
    roots.dedup();
    roots.retain(|p| p.is_dir());
    let mut seen = Vec::new();
    roots.retain(|p| {
        if seen.contains(p) {
            false
        } else {
            seen.push(p.clone());
            true
        }
    });
    roots
}

fn vcvars_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if p.is_file() && !candidates.contains(&p) {
            candidates.push(p);
        }
    };

    if let Some(vs) = env::var_os("VSINSTALLDIR") {
        add(PathBuf::from(vs).join("VC\\Auxiliary\\Build\\vcvars64.bat"));
    }

    for root in program_files_roots() {
        let vswhere = root.join("Microsoft Visual Studio\\Installer\\vswhere.exe");
        if !vswhere.is_file() {
            continue;
        }
        let out = Command::new(&vswhere)
            .args([
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property",
                "installationPath",
            ])
            .stdin(Stdio::null())
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    let line = line.trim();
                    if !line.is_empty() {
                        add(PathBuf::from(line).join("VC\\Auxiliary\\Build\\vcvars64.bat"));
                    }
                }
            }
        }
    }

    for root in program_files_roots() {
        let vs_root = root.join("Microsoft Visual Studio");
        for found in find_files_by_name(&vs_root, "vcvars64.bat", 5, 8) {
            add(found);
        }
    }

    candidates
}

fn find_files_by_name(
    root: &Path,
    name: &str,
    max_depth: usize,
    max_matches: usize,
) -> Vec<PathBuf> {
    let mut matches = Vec::new();
    let mut queue = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = queue.pop() {
        if matches.len() >= max_matches {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .file_name()
                    .is_some_and(|f| f.eq_ignore_ascii_case(name))
            {
                matches.push(path);
                if matches.len() >= max_matches {
                    break;
                }
            } else if path.is_dir() && depth < max_depth {
                queue.push((path, depth + 1));
            }
        }
    }
    matches
}
