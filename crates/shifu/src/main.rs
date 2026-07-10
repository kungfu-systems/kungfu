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
//   shifu self-version            print the launcher's own version
//
// plus the capability the scripts could only ask the user for: when fnm / uv
// are missing it bootstraps them from prebuilt release binaries into a
// user-global cache (no compiler, no package manager, no admin required).
//
// Dual-driver toolchain model (unchanged):
//   node side:   fnm selects node (.node-version) -> corepack runs the pinned pnpm
//   python side: uv manages standalone CPython + `uv run` for conan / nuitka
//
// Build logic stays declarative in the repo (pnpm tasks / conan / cmake); this
// binary remains a thin dispatcher and should change rarely.

use std::env;
use std::path::PathBuf;
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

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.first().map(String::as_str) == Some("self-version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        exit(0);
    }

    let root = find_repo_root();
    envfile::load(&root);

    match args.first() {
        Some(cmd) if L2_SUBCOMMANDS.contains(&cmd.as_str()) => dispatch::delegate_l2(&root, &args),
        _ => {
            // Build tasks on Windows need the MSVC environment (cl.exe) for the
            // C++ core; load vcvars when it is not already present.
            #[cfg(windows)]
            msvc::ensure_msvc_env(&root);
            dispatch::run_pnpm(&root, &args)
        }
    }
}

/// Locate the repository root. The binary may run from the repo, from a
/// subdirectory, or from a user-global cache (via the shim), so the root is
/// discovered rather than assumed: explicit override first, then walk up from
/// the current directory looking for the repo's own entrypoint marker.
fn find_repo_root() -> PathBuf {
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
            None => util::die(
                "not inside a kungfu repository (no shifu.mjs found walking up from the \
                 current directory; set SHIFU_ROOT to override)",
            ),
        }
    }
}
