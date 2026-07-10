// SPDX-License-Identifier: Apache-2.0
//
// shifu — the kungfu dev/build launcher as one self-contained binary.
//
// It is the native successor to the L1 shell entrypoints (shifu sh /
// shifu.cmd) with the same contract:
//
//   shifu <any pnpm task/args>    run the task under the pinned toolchain
//   shifu build | rebuild         rich subcommands -> delegated to L2 node
//   shifu proxy | config ...      (shifu.mjs), not passed to pnpm
//   shifu --version | -v | -V     launcher version + build identity
//   shifu self-version            this binary's crate version (machine readable)
//   shifu / -h / --help           launcher usage (pnpm's own help: `shifu help`)
//
// plus the capability the scripts could only ask the user for: when fnm / uv
// are missing it bootstraps them from prebuilt release binaries into a
// user-global cache (no compiler, no package manager, no admin required).
//
// Installed-binary delegation: a shifu installed outside the repo (e.g.
// ~/.local/bin) never runs its own logic against a checkout — inside a repo it
// delegates to the repo's ./shifu entrypoint, which resolves the version that
// checkout pins. The shim marks its dispatch with SHIFU_FROM_SHIM=1 so the
// delegation cannot loop. `self-version` is exempt: it answers for the binary
// itself.
//
// Dual-driver toolchain model (unchanged):
//   node side:   fnm selects node (.node-version) -> corepack runs the pinned pnpm
//   python side: uv manages standalone CPython + `uv run` for conan / nuitka
//
// Build logic stays declarative in the repo (pnpm tasks / conan / cmake); this
// binary remains a thin dispatcher and should change rarely.

use std::env;
use std::path::{Path, PathBuf};
use std::process::exit;

mod dispatch;
mod envfile;
#[cfg(windows)]
mod msvc;
mod tools;
mod util;

/// Rich subcommands handled by the L2 node implementation (shifu.mjs),
/// mirroring the sh / cmd entrypoints. Everything else goes to corepack pnpm.
const L2_SUBCOMMANDS: &[&str] = &["build", "rebuild", "proxy", "config"];

const USAGE: &str = "\
shifu - the kungfu development/build launcher (pinned-toolchain entrypoint)

Usage:
  shifu <task> [args...]     run any pnpm task under the pinned toolchain
                             (node via fnm/.node-version, python via uv;
                             missing prerequisites bootstrap automatically)
  shifu build | rebuild      bootstrap build (rebuild clears generated outputs)
  shifu proxy | config ...   manage local mirror/cache config (build-local.env)
  shifu --version | -v | -V  launcher version and build identity
  shifu self-version         this binary's version, machine readable
  shifu help                 pnpm's own help (tasks are pnpm scripts)

Common tasks: sync, build, check, fix, verify, dist, app
Docs: AGENTS.md (build), docs/rust-adoption.md (how this launcher works)";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let first = args.first().map(String::as_str);

    // Answers for this binary itself — never delegated (the shim reads it to
    // identify cached binaries).
    if first == Some("self-version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        exit(0);
    }

    // Usage is static and repo-independent: answer before repo discovery so a
    // bare `shifu` outside any checkout is still helpful. Not delegated.
    if args.is_empty() || matches!(first, Some("-h") | Some("--help")) {
        println!("{USAGE}");
        exit(if args.is_empty() { 2 } else { 0 });
    }

    let is_version = matches!(first, Some("--version") | Some("-v") | Some("-V"));
    if is_version {
        println!("{}", version_line());
    }

    let root = find_repo_root(is_version);
    envfile::load(&root);
    maybe_delegate_to_repo_entrypoint(&root, &args);

    if is_version {
        exit(0);
    }

    match first {
        Some(cmd) if L2_SUBCOMMANDS.contains(&cmd) => dispatch::delegate_l2(&root, &args),
        _ => {
            // Build tasks on Windows need the MSVC environment (cl.exe) for the
            // C++ core; load vcvars when it is not already present.
            #[cfg(windows)]
            msvc::ensure_msvc_env(&root);
            dispatch::run_pnpm(&root, &args)
        }
    }
}

/// One line of build identity: crate version (locked to the monorepo train),
/// the commit that built this binary, and whether this process is the repo's
/// own launcher or an externally installed one.
fn version_line() -> String {
    format!(
        "shifu {} (git {}, {})",
        env!("CARGO_PKG_VERSION"),
        env!("SHIFU_GIT_SHA"),
        if env::var("SHIFU_FROM_SHIM").ok().as_deref() == Some("1") {
            "repo"
        } else {
            "installed"
        }
    )
}

/// An installed binary run inside a checkout hands over to that checkout's
/// ./shifu entrypoint, so the repo-pinned launcher version always wins. Skipped
/// when the shim dispatched us (SHIFU_FROM_SHIM=1) or when this binary already
/// lives inside the repo (a local cargo build).
fn maybe_delegate_to_repo_entrypoint(root: &Path, args: &[String]) {
    if env::var("SHIFU_FROM_SHIM").ok().as_deref() == Some("1") {
        return;
    }
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if let Ok(exe) = env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if exe.starts_with(&root) {
            return;
        }
    }
    #[cfg(unix)]
    let script = root.join("shifu");
    #[cfg(windows)]
    let script = root.join("shifu.cmd");
    if !script.is_file() {
        return;
    }
    #[cfg(unix)]
    {
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg(&script).args(args).current_dir(&root);
        util::exec_or_exit(cmd);
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("cmd.exe");
        {
            use std::os::windows::process::CommandExt;
            cmd.arg("/d").arg("/s").arg("/c");
            let mut line = format!("\"\"{}\"", script.display());
            for arg in args {
                line.push_str(&format!(" \"{}\"", arg.replace('"', "\"\"")));
            }
            line.push('"');
            cmd.raw_arg(line);
        }
        cmd.current_dir(&root);
        util::exec_or_exit(cmd);
    }
}

/// Locate the repository root. The binary may run from the repo, from a
/// subdirectory, or from a user-global cache (via the shim), so the root is
/// discovered rather than assumed: explicit override first, then walk up from
/// the current directory looking for the repo's own entrypoint marker.
///
/// With `lenient` (used by --version), failing to find a repo is not an
/// error — the version line has already been printed and the process exits
/// cleanly instead of dying outside a checkout.
fn find_repo_root(lenient: bool) -> PathBuf {
    if let Some(explicit) = env::var_os("SHIFU_ROOT") {
        let root = PathBuf::from(explicit);
        if root.join("shifu.mjs").is_file() {
            return root;
        }
        util::die(&format!(
            "SHIFU_ROOT does not look like a kungfu repo (missing shifu.mjs): {}",
            root.display()
        ));
    }
    let start = env::current_dir().unwrap_or_else(|e| util::die(&format!("cannot read cwd: {e}")));
    let mut dir = start.as_path();
    loop {
        if dir.join("shifu.mjs").is_file() && dir.join(".node-version").is_file() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => {
                if lenient {
                    exit(0);
                }
                util::die(
                    "not inside a kungfu repository (no shifu.mjs found walking up from the \
                     current directory; set SHIFU_ROOT to override)",
                )
            }
        }
    }
}
