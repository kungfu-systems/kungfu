// SPDX-License-Identifier: Apache-2.0
//
// `shifu doctor` — development environment preflight, built on shifu-core's
// probe framework (the first consumer of the declarative contract).
//
// Reports, never repairs: the heavyweight prerequisites (C++ toolchain,
// CMake, git, curl) are deliberately outside shifu's bootstrap scope, so the
// doctor's job is a precise checklist — what is present (with version), what
// is missing, where to get it, and, where one can be named precisely, the
// exact repair command (printed, never run). Tools shifu bootstraps itself
// (fnm / uv) and the repo pins (node) are shown for context. Works outside a
// checkout too; repo-pinned rows appear only when a repo root is available.
//
// Exit code: 1 when any required tool is missing, 0 otherwise.

use std::path::Path;

use shifu_core::probe::{self, Probe, Status};
use shifu_core::style;

use crate::{tools, util};

pub fn run(root: Option<&Path>) -> ! {
    println!(
        "\u{1f94b} {}",
        style::bold("shifu doctor - development environment preflight")
    );
    println!(
        "   {}\n",
        style::dim(
            "\u{201c}When your kungfu fails you, the one you turn to is your shifu.\u{201d}"
        )
    );

    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut required = vec![
        git_probe(),
        Probe::command_version(
            "curl",
            &["curl"],
            "ships with macOS / Windows 10+; linux: install via your package manager",
            true,
        ),
        cpp_compiler_probe(),
        cmake_probe(),
    ];
    #[cfg(windows)]
    required.push(msvc_probe());

    println!(
        "{}",
        style::cyan("Required (preinstall these; shifu does not manage them):")
    );
    let required = probe::run_all(required);
    for finding in &required {
        probe::print_finding(finding);
    }

    println!(
        "\n{}",
        style::cyan("Managed by shifu (bootstrapped automatically when missing):")
    );
    for finding in probe::run_all(managed_probes(root)) {
        probe::print_finding(&finding);
    }
    if root.is_none() {
        println!(
            "  {}",
            style::dim("(run inside a kungfu checkout to see the repo's toolchain pins)")
        );
    }

    println!("\n{}", style::cyan("Optional:"));
    for finding in probe::run_all(vec![Probe::command_version(
        "rustc/cargo",
        &["cargo"],
        "https://rustup.rs - only needed to develop the shifu launcher itself",
        false,
    )]) {
        probe::print_finding(&finding);
    }

    if probe::any_required_missing(&required) {
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

/// Context rows for the toolchain shifu manages itself (fnm / uv) plus the
/// repo's node pin — informational: their absence is not a failure because
/// the launcher bootstraps them on first use.
fn managed_probes(root: Option<&Path>) -> Vec<Probe> {
    let root_buf = root.map(Path::to_path_buf);
    let mut probes: Vec<Probe> = [&tools::FNM, &tools::UV]
        .into_iter()
        .map(|tool| {
            let root_buf = root_buf.clone();
            Probe {
                label: tool.name,
                probe: Box::new(move || {
                    let lookup_root = root_buf.clone().unwrap_or_else(|| Path::new(".").into());
                    let found = tools::find_tool(tool, &lookup_root)
                        .and_then(|p| probe::version_line(&p.to_string_lossy()));
                    let pin = root_buf
                        .and_then(|r| std::fs::read_to_string(r.join(tool.pin_file())).ok())
                        .map(|s| s.trim().to_string());
                    Status::Info(match (found, pin) {
                        (Some(v), Some(p)) => format!("{v} (repo pins {p})"),
                        (Some(v), None) => v,
                        (None, Some(p)) => format!("absent; will bootstrap {p} on first run"),
                        (None, None) => {
                            "absent; will bootstrap the pinned version on first run".to_string()
                        }
                    })
                }),
                required: false,
                hint: String::new(),
                repair_cmd: None,
            }
        })
        .collect();
    if let Some(root) = root {
        if let Ok(node) = std::fs::read_to_string(root.join(".node-version")) {
            probes.push(Probe {
                label: "node",
                probe: Box::new(move || {
                    Status::Info(format!(
                        "pinned {} by .node-version (installed via fnm on first build)",
                        node.trim()
                    ))
                }),
                required: false,
                hint: String::new(),
                repair_cmd: None,
            });
        }
    }
    probes
}

fn git_probe() -> Probe {
    let probe = Probe::command_version("git", &["git"], "https://git-scm.com/downloads", true);
    if cfg!(target_os = "macos") {
        // The Xcode Command Line Tools ship git; one command covers it.
        probe.with_repair("xcode-select --install")
    } else {
        probe
    }
}

fn cpp_compiler_probe() -> Probe {
    let hint = if cfg!(target_os = "macos") {
        "run `xcode-select --install` (Xcode Command Line Tools)"
    } else if cfg!(windows) {
        "install Visual Studio Build Tools with the C++ workload: https://visualstudio.microsoft.com/downloads/"
    } else {
        "install gcc or clang via your package manager (e.g. `apt install build-essential`)"
    };
    let candidates: &'static [&'static str] = if cfg!(windows) {
        &["cl"]
    } else {
        &["c++", "clang++", "g++"]
    };
    let probe = Probe::command_version("C++ compiler", candidates, hint, true);
    if cfg!(target_os = "macos") {
        probe.with_repair("xcode-select --install")
    } else {
        probe
    }
}

fn cmake_probe() -> Probe {
    Probe {
        label: "cmake",
        probe: Box::new(|| {
            let Some(version_line) =
                util::find_on_path("cmake").and_then(|_| probe::version_line("cmake"))
            else {
                return Status::Missing;
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
            if too_old {
                Status::Missing
            } else {
                Status::Present(version_line)
            }
        }),
        required: true,
        hint: "https://cmake.org/download/ (>= 3.20 required)".to_string(),
        repair_cmd: None,
    }
}

#[cfg(windows)]
fn msvc_probe() -> Probe {
    Probe {
        label: "MSVC (cl.exe)",
        probe: Box::new(|| {
            // cl on PATH or discoverable via vcvars is both fine; the launcher
            // loads vcvars itself at build time.
            if util::find_on_path("cl").is_some() {
                let banner = std::process::Command::new("cl")
                    .output()
                    .ok()
                    .filter(|out| out.status.success())
                    .and_then(|out| {
                        let text = String::from_utf8_lossy(&out.stdout);
                        text.lines()
                            .find(|l| !l.trim().is_empty())
                            .map(|l| l.trim().to_string())
                    });
                Status::Present(banner.unwrap_or_else(|| "cl.exe on PATH".to_string()))
            } else if crate::msvc::vcvars_available() {
                Status::Present("available via vcvars64.bat (loaded automatically)".to_string())
            } else {
                Status::Missing
            }
        }),
        required: true,
        hint: "install Visual Studio Build Tools with the C++ workload: https://visualstudio.microsoft.com/downloads/"
            .to_string(),
        repair_cmd: None,
    }
}
