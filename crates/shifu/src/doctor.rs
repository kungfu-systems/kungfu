// SPDX-License-Identifier: Apache-2.0
//
// `shifu doctor` — development environment preflight.
//
// Reports, never installs: the heavyweight prerequisites (C++ toolchain,
// CMake, git, curl) are deliberately outside shifu's bootstrap scope, so the
// doctor's job is a precise checklist — what is present (with version), what
// is missing, and where to get it. Tools shifu bootstraps itself (fnm / uv)
// and the repo pins (node) are shown for context. Works outside a checkout
// too; repo-pinned rows appear only when a repo root is available.
//
// Exit code: 1 when any required tool is missing, 0 otherwise.

use std::path::Path;
use std::process::Command;

use crate::{style, tools, util};

struct Check {
    label: &'static str,
    found: Option<String>,
    hint: &'static str,
    required: bool,
}

pub fn run(root: Option<&Path>) -> ! {
    println!(
        "\u{1f94b} {}\n",
        style::bold("shifu doctor - development environment preflight")
    );

    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut required = vec![
        probe("git", &["git"], "https://git-scm.com/downloads", true),
        probe(
            "curl",
            &["curl"],
            "ships with macOS / Windows 10+; linux: install via your package manager",
            true,
        ),
        cpp_compiler_check(),
        cmake_check(),
    ];
    #[cfg(windows)]
    required.push(msvc_check());

    println!(
        "{}",
        style::cyan("Required (preinstall these; shifu does not manage them):")
    );
    let mut missing_required = false;
    for check in &required {
        missing_required |= check.required && check.found.is_none();
        print_check(check);
    }

    println!(
        "\n{}",
        style::cyan("Managed by shifu (bootstrapped automatically when missing):")
    );
    for tool in [&tools::FNM, &tools::UV] {
        let found = tools::find_tool(tool, root.unwrap_or(Path::new(".")))
            .and_then(|p| version_of(&p.to_string_lossy(), &["--version"]));
        let pin = root
            .and_then(|r| std::fs::read_to_string(r.join(tool.pin_file())).ok())
            .map(|s| s.trim().to_string());
        let label = match (&found, &pin) {
            (Some(v), Some(p)) => format!("{v} (repo pins {p})"),
            (Some(v), None) => v.clone(),
            (None, Some(p)) => format!("absent; will bootstrap {p} on first run"),
            (None, None) => "absent; will bootstrap the pinned version on first run".to_string(),
        };
        println!("  \u{1f9f0} {:<14} {label}", tool.name);
    }
    if let Some(root) = root {
        if let Ok(node) = std::fs::read_to_string(root.join(".node-version")) {
            println!(
                "  \u{1f9f0} {:<14} pinned {} by .node-version (installed via fnm on first build)",
                "node",
                node.trim()
            );
        }
    } else {
        println!(
            "  {}",
            style::dim("(run inside a kungfu checkout to see the repo's toolchain pins)")
        );
    }

    println!("\n{}", style::cyan("Optional:"));
    print_check(&probe(
        "rustc/cargo",
        &["cargo"],
        "https://rustup.rs - only needed to develop the shifu launcher itself",
        false,
    ));

    if missing_required {
        println!(
            "\n\u{26d4} {}",
            style::red("missing required tools - see the install pointers above")
        );
        std::process::exit(1);
    }
    println!(
        "\n\u{1f94b} {}",
        style::green("all required tools present - ready to train")
    );
    std::process::exit(0)
}

fn print_check(check: &Check) {
    match &check.found {
        Some(version) => println!("  \u{2705} {:<14} {}", check.label, style::dim(version)),
        None if check.required => println!(
            "  \u{274c} {:<14} {} - {}",
            check.label,
            style::red("not found"),
            style::yellow(check.hint)
        ),
        None => println!(
            "  \u{2796} {:<14} {} - {}",
            check.label,
            style::dim("not found"),
            style::dim(check.hint)
        ),
    }
}

/// Probe candidate commands in order; report the first hit's version line.
fn probe(label: &'static str, candidates: &[&str], hint: &'static str, required: bool) -> Check {
    for name in candidates {
        if util::find_on_path(name).is_some() {
            if let Some(v) = version_of(name, &["--version"]) {
                return Check {
                    label,
                    found: Some(v),
                    hint,
                    required,
                };
            }
        }
    }
    Check {
        label,
        found: None,
        hint,
        required,
    }
}

fn version_of(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    Some(line.trim().to_string())
}

fn cpp_compiler_check() -> Check {
    let hint = if cfg!(target_os = "macos") {
        "run `xcode-select --install` (Xcode Command Line Tools)"
    } else if cfg!(windows) {
        "install Visual Studio Build Tools with the C++ workload: https://visualstudio.microsoft.com/downloads/"
    } else {
        "install gcc or clang via your package manager (e.g. `apt install build-essential`)"
    };
    let candidates: &[&str] = if cfg!(windows) {
        &["cl"]
    } else {
        &["c++", "clang++", "g++"]
    };
    probe("C++ compiler", candidates, hint, true)
}

fn cmake_check() -> Check {
    let hint = "https://cmake.org/download/ (>= 3.20 required)";
    let Some(version_line) = util::find_on_path("cmake")
        .and_then(|_| version_of("cmake", &["--version"]))
    else {
        return Check {
            label: "cmake",
            found: None,
            hint,
            required: true,
        };
    };
    // "cmake version X.Y.Z" — flag versions below the repo's minimum.
    let too_old = version_line
        .split_whitespace()
        .last()
        .and_then(|v| {
            let mut parts = v.split('.');
            Some((
                parts.next()?.parse::<u32>().ok()?,
                parts.next()?.parse::<u32>().ok()?,
            ))
        })
        .is_some_and(|(major, minor)| (major, minor) < (3, 20));
    Check {
        label: "cmake",
        found: (!too_old).then_some(version_line),
        hint,
        required: true,
    }
}

#[cfg(windows)]
fn msvc_check() -> Check {
    // cl on PATH or discoverable via vcvars is both fine; the launcher loads
    // vcvars itself at build time.
    let found = if util::find_on_path("cl").is_some() {
        version_of("cl", &[]).or(Some("cl.exe on PATH".to_string()))
    } else if crate::msvc::vcvars_available() {
        Some("available via vcvars64.bat (loaded automatically)".to_string())
    } else {
        None
    };
    Check {
        label: "MSVC (cl.exe)",
        found,
        hint: "install Visual Studio Build Tools with the C++ workload: https://visualstudio.microsoft.com/downloads/",
        required: true,
    }
}
