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

use std::path::{Path, PathBuf};

use shifu_core::probe::{self, Probe, Status};
use shifu_core::{bootstrap, json, style};

use crate::{tools, util};

pub fn run(root: Option<&Path>, args: &[String]) -> ! {
    if args == ["--json"] {
        print_json(root);
        std::process::exit(0);
    }
    if !args.is_empty() {
        eprintln!("shifu doctor: unknown argument {}", args[0]);
        std::process::exit(2);
    }
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
        cpp_compiler_probe(root),
        cmake_probe(root),
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

    println!(
        "\n{}",
        style::cyan("Bootstrap state (informational; never blocks):")
    );
    let mut bootstrap_section = vec![bootstrap::cache_probe()];
    for tool in [&tools::FNM, &tools::UV, &tools::BUILDCHAIN] {
        bootstrap_section.push(bootstrap::mirror_probe(tool));
        bootstrap_section.push(bootstrap::pin_probe(tool, root));
    }
    for finding in probe::run_all(bootstrap_section) {
        probe::print_finding(&finding);
    }

    println!(
        "\n{}",
        style::cyan("Cache profile (informational; never probes endpoints):")
    );
    println!(
        "  profile projection: {} (scope {}; run `./shifu cache doctor` for details)",
        cache_profile_state(),
        cache_profile_scope()
    );

    println!("\n{}", style::cyan("Optional:"));
    for finding in probe::run_all(vec![Probe::command_version(
        "rustc/cargo",
        &["cargo"],
        "https://rustup.rs - only needed to develop the shifu launcher itself",
        false,
    )]) {
        probe::print_finding(&finding);
    }

    if let Some(root) = root {
        println!(
            "\n{}",
            style::cyan("Native build contract (repository-selected):")
        );
        for finding in probe::run_all(contract_probes(root)) {
            probe::print_finding(&finding);
        }
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

fn contract_document(root: &Path) -> Option<json::Json> {
    let text = std::fs::read_to_string(root.join("toolchain.contract.json")).ok()?;
    json::parse(&text).ok()
}

fn contract_minimum(root: &Path, name: &str) -> Option<String> {
    contract_document(root)?
        .get("minimum")?
        .get(name)?
        .as_str()
        .map(str::to_string)
}

fn managed_binary(root: &Path, name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let managed = root
        .join("framework")
        .join("core")
        .join(".venv")
        .join(if cfg!(windows) {
            Path::new("Scripts").join(exe)
        } else {
            Path::new("bin").join(exe)
        });
    managed
        .is_file()
        .then_some(managed)
        .or_else(|| util::find_on_path(name))
}

fn version_of(program: Option<PathBuf>) -> Option<String> {
    program.and_then(|path| probe::version_line(&path.to_string_lossy()))
}

fn contract_probes(root: &Path) -> Vec<Probe> {
    let ninja = version_of(managed_binary(root, "ninja"));
    let conan = version_of(managed_binary(root, "conan"));
    let ninja_min = contract_minimum(root, "ninja").unwrap_or_else(|| "unknown".into());
    let conan_min = contract_minimum(root, "conan").unwrap_or_else(|| "unknown".into());
    let compiler_policy = contract_document(root)
        .and_then(|doc| doc.get("policy")?.get("production_compilers").cloned())
        .map(|matrix| {
            format!(
                "macOS={}, Linux={}, Windows={} (Clang/clang-cl secondary)",
                matrix.str_of("macos"),
                matrix.str_of("linux"),
                matrix.str_of("windows")
            )
        })
        .unwrap_or_else(|| "invalid toolchain.contract.json".into());
    vec![
        Probe {
            label: "compiler matrix".into(),
            probe: Box::new(move || Status::Info(compiler_policy)),
            required: false,
            hint: String::new(),
            repair_cmd: None,
        },
        Probe {
            label: "ninja".into(),
            probe: Box::new(move || {
                Status::Info(ninja.map_or_else(
                    || format!("managed on first core sync/build (minimum {ninja_min})"),
                    |v| format!("{v} (minimum {ninja_min})"),
                ))
            }),
            required: false,
            hint: String::new(),
            repair_cmd: None,
        },
        Probe {
            label: "conan".into(),
            probe: Box::new(move || {
                Status::Info(conan.map_or_else(
                    || format!("managed on first core sync/build (minimum {conan_min})"),
                    |v| format!("{v} (minimum {conan_min})"),
                ))
            }),
            required: false,
            hint: String::new(),
            repair_cmd: None,
        },
        Probe {
            label: "linker".into(),
            probe: Box::new(|| Status::Info(linker_version())),
            required: false,
            hint: String::new(),
            repair_cmd: None,
        },
        Probe {
            label: "compiler cache".into(),
            probe: Box::new(|| Status::Info(command_version(&["sccache", "ccache"]))),
            required: false,
            hint: String::new(),
            repair_cmd: None,
        },
    ]
}

fn command_version(candidates: &[&str]) -> String {
    candidates
        .iter()
        .find_map(|name| probe::version_line(name))
        .unwrap_or_else(|| "not found".into())
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

fn command_banner(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines: Vec<_> = stdout
        .lines()
        .chain(stderr.lines())
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines
        .iter()
        .find(|line| line.to_ascii_lowercase().contains("version"))
        .or_else(|| lines.first())
        .map(|line| line.trim().to_string())
}

fn compiler_version() -> String {
    if cfg!(windows) {
        command_banner("cl", &[])
            .or_else(|| command_output("clang-cl", &["--version"]))
            .unwrap_or_else(|| "not found".into())
    } else {
        let compiler = std::env::var("CXX").unwrap_or_else(|_| "c++".into());
        command_output(&compiler, &["--version"]).unwrap_or_else(|| "not found".into())
    }
}

fn linker_version() -> String {
    if cfg!(windows) {
        return command_banner("link", &["/?"]).unwrap_or_else(|| "not found".into());
    }
    command_output("ld", &["--version"])
        .or_else(|| command_output("ld", &["-v"]))
        .or_else(|| command_output("link", &["/?"]))
        .unwrap_or_else(|| "not found".into())
}

fn runtime_facts(root: &Path) -> (String, String, String) {
    let node = std::fs::read_to_string(root.join(".node-version"))
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|_| "unknown".into());
    let electron = std::fs::read_to_string(root.join("framework/core/package.json"))
        .ok()
        .and_then(|text| json::parse(&text).ok())
        .and_then(|doc| {
            doc.get("devDependencies")?
                .get("electron")?
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".into());
    let python = std::fs::read_to_string(root.join("framework/core/pyproject.toml"))
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.trim_start().starts_with("requires-python ="))
                .and_then(|line| line.split_once('='))
                .map(|(_, value)| value.trim().trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "unknown".into());
    (node, electron, python)
}

fn sdk_version() -> String {
    if cfg!(target_os = "macos") {
        command_output("xcrun", &["--show-sdk-version"]).unwrap_or_else(|| "unknown".into())
    } else if cfg!(windows) {
        std::env::var("WindowsSDKVersion").unwrap_or_else(|_| "available via vcvars".into())
    } else {
        command_output("ldd", &["--version"]).unwrap_or_else(|| "unknown".into())
    }
}

fn json_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn cache_profile_state() -> &'static str {
    let reference = std::env::var_os("SHIFU_CACHE_PROFILE_REF").is_some_and(|v| !v.is_empty());
    let digest = std::env::var_os("SHIFU_CACHE_PROFILE_DIGEST").is_some_and(|v| !v.is_empty());
    cache_profile_pair_state(reference, digest)
}

fn cache_profile_pair_state(reference: bool, digest: bool) -> &'static str {
    match (reference, digest) {
        (true, true) => "complete",
        (false, false) => "absent",
        _ => "partial",
    }
}

fn cache_profile_scope() -> String {
    std::env::var("SHIFU_CACHE_SCOPE")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "development".into())
}

fn print_json(root: Option<&Path>) {
    let compiler = compiler_version();
    let cmake = command_version(&["cmake"]);
    let (ninja, conan, contract, node, electron, python) = root.map_or_else(
        || {
            (
                "not in a checkout".into(),
                "not in a checkout".into(),
                "unavailable".into(),
                "unknown".into(),
                "unknown".into(),
                "unknown".into(),
            )
        },
        |root| {
            let (node, electron, python) = runtime_facts(root);
            (
                version_of(managed_binary(root, "ninja"))
                    .unwrap_or_else(|| "not materialized".into()),
                version_of(managed_binary(root, "conan"))
                    .unwrap_or_else(|| "not materialized".into()),
                root.join("toolchain.contract.json").display().to_string(),
                node,
                electron,
                python,
            )
        },
    );
    let standard_library = if cfg!(windows) {
        "MSVC DLL CRT"
    } else if cfg!(target_os = "macos") {
        "libc++"
    } else {
        "libstdc++"
    };
    println!(
        "{{\"schema_version\":1,\"contract\":\"{}\",\"compiler\":\"{}\",\"standard_library\":\"{}\",\"cmake\":\"{}\",\"ninja\":\"{}\",\"conan\":\"{}\",\"linker\":\"{}\",\"cache\":\"{}\",\"profile_cache\":{{\"state\":\"{}\",\"scope\":\"{}\",\"diagnostic\":\"./shifu cache doctor\"}},\"sdk\":\"{}\",\"runtimes\":{{\"node\":\"{}\",\"electron\":\"{}\",\"python\":\"{}\"}}}}",
        json_escape(&contract),
        json_escape(&compiler),
        standard_library,
        json_escape(&cmake),
        json_escape(&ninja),
        json_escape(&conan),
        json_escape(&linker_version()),
        json_escape(&command_version(&["sccache", "ccache"])),
        cache_profile_state(),
        json_escape(&cache_profile_scope()),
        json_escape(&sdk_version()),
        json_escape(&node),
        json_escape(&electron),
        json_escape(&python),
    );
}

/// Context rows for the toolchain shifu manages itself (fnm / uv) plus the
/// repo's node pin — informational: their absence is not a failure because
/// the launcher bootstraps them on first use.
fn managed_probes(root: Option<&Path>) -> Vec<Probe> {
    let root_buf = root.map(Path::to_path_buf);
    let mut probes: Vec<Probe> = [&tools::FNM, &tools::UV, &tools::BUILDCHAIN]
        .into_iter()
        .map(|tool| {
            let root_buf = root_buf.clone();
            Probe {
                label: tool.name.to_string(),
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
                label: "node".to_string(),
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

fn cpp_compiler_probe(root: Option<&Path>) -> Probe {
    let hint = if cfg!(target_os = "macos") {
        "run `xcode-select --install` (Xcode Command Line Tools)"
    } else if cfg!(windows) {
        "install Visual Studio Build Tools with the C++ workload: https://visualstudio.microsoft.com/downloads/"
    } else {
        "install gcc or clang via your package manager (e.g. `apt install build-essential`)"
    };
    let minimum = root.and_then(|root| {
        let key = if cfg!(target_os = "macos") {
            "apple_clang"
        } else if cfg!(windows) {
            "msvc"
        } else if std::env::var("CXX").is_ok_and(|cxx| cxx.contains("clang")) {
            "clang"
        } else {
            "gcc"
        };
        contract_minimum(root, key)
    });
    let hint = minimum.as_ref().map_or_else(
        || hint.to_string(),
        |minimum| format!("{hint}; version >= {minimum}"),
    );
    let probe = Probe {
        label: "C++ compiler".into(),
        probe: Box::new(move || {
            let command = std::env::var("CXX").unwrap_or_else(|_| {
                if cfg!(windows) {
                    "cl".into()
                } else {
                    "c++".into()
                }
            });
            let evidence = if cfg!(windows) && command.eq_ignore_ascii_case("cl") {
                command_banner("cl", &[])
            } else {
                probe::version_line(&command)
            };
            let Some(evidence) = evidence else {
                #[cfg(windows)]
                if crate::msvc::vcvars_available() {
                    return Status::Present(
                        "MSVC available via vcvars64.bat (version enforced by CMake)".into(),
                    );
                }
                return Status::Missing;
            };
            if let Some(minimum) = &minimum {
                let version = compiler_numeric_version(&command, &evidence);
                if version
                    .as_deref()
                    .is_none_or(|found| version_less(found, minimum))
                {
                    return Status::Missing;
                }
            }
            Status::Present(evidence)
        }),
        required: true,
        hint,
        repair_cmd: None,
    };
    if cfg!(target_os = "macos") {
        probe.with_repair("xcode-select --install")
    } else {
        probe
    }
}

fn compiler_numeric_version(command: &str, evidence: &str) -> Option<String> {
    if !cfg!(windows) && !evidence.to_ascii_lowercase().contains("clang") {
        let output = std::process::Command::new(command)
            .arg("-dumpfullversion")
            .output()
            .ok()?;
        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !version.is_empty() {
                return Some(version);
            }
        }
    }
    let words: Vec<_> = evidence.split_whitespace().collect();
    words
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case("version"))
        .map(|pair| {
            pair[1]
                .trim_matches(|c: char| !c.is_ascii_digit() && c != '.')
                .to_string()
        })
        .filter(|value| !value.is_empty())
}

fn cmake_probe(root: Option<&Path>) -> Probe {
    let minimum = root
        .and_then(|root| contract_minimum(root, "cmake"))
        .unwrap_or_else(|| "3.28.0".into());
    let minimum_for_probe = minimum.clone();
    Probe {
        label: "cmake".to_string(),
        probe: Box::new(move || {
            let Some(version_line) =
                util::find_on_path("cmake").and_then(|_| probe::version_line("cmake"))
            else {
                return Status::Missing;
            };
            let found = version_line.split_whitespace().last().unwrap_or_default();
            if version_less(found, &minimum_for_probe) {
                Status::Missing
            } else {
                Status::Present(version_line)
            }
        }),
        required: true,
        hint: format!("https://cmake.org/download/ (>= {minimum} required)"),
        repair_cmd: None,
    }
}

fn version_less(found: &str, required: &str) -> bool {
    fn parts(value: &str) -> Vec<u32> {
        value
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    }
    let mut found = parts(found);
    let mut required = parts(required);
    let width = found.len().max(required.len());
    found.resize(width, 0);
    required.resize(width, 0);
    found < required
}

#[cfg(windows)]
fn msvc_probe() -> Probe {
    Probe {
        label: "MSVC (cl.exe)".to_string(),
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

#[cfg(test)]
mod tests {
    use super::{cache_profile_pair_state, version_less};

    #[test]
    fn compares_dotted_tool_versions() {
        assert!(version_less("3.27.9", "3.28.0"));
        assert!(!version_less("3.28.3", "3.28.0"));
        assert!(!version_less("4.3.2", "3.28.0"));
    }

    #[test]
    fn classifies_cache_profile_pair() {
        assert_eq!(cache_profile_pair_state(false, false), "absent");
        assert_eq!(cache_profile_pair_state(true, false), "partial");
        assert_eq!(cache_profile_pair_state(false, true), "partial");
        assert_eq!(cache_profile_pair_state(true, true), "complete");
    }
}
