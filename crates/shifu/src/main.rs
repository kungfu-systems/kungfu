// SPDX-License-Identifier: Apache-2.0
//
// shifu — the kungfu dev/build launcher as one self-contained binary.
//
// It is the native successor to the L1 shell entrypoints (shifu sh /
// shifu.cmd) with the same contract:
//
//   shifu <any pnpm task/args>    run the task under the pinned toolchain
//   shifu build | rebuild         rich subcommands -> delegated to L2 node
//   shifu cache | docs | gate | proxy | config  (shifu.mjs), not passed to pnpm
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

mod artifact_catalog;
mod dispatch;
mod doctor;
mod envfile;
#[cfg(windows)]
mod msvc;
mod promote;
mod registrar;
mod self_update;
mod tools;
mod util;

use shifu_core::style;

/// Rich subcommands handled by the L2 node implementation (shifu.mjs),
/// mirroring the sh / cmd entrypoints. Everything else goes to corepack pnpm.
const L2_SUBCOMMANDS: &[&str] = &[
    "build", "rebuild", "cache", "docs", "gate", "proxy", "config",
];
const SOURCE_ACCEPTANCE_CACHE_BYPASS: &str = "source-acceptance";

#[cfg(any(windows, test))]
fn command_requires_msvc(command: Option<&str>) -> bool {
    !matches!(
        command,
        Some("cache" | "docs" | "gate" | "proxy" | "config")
    )
}

fn should_auto_apply_cache(
    command: Option<&str>,
    gate_subcommand: Option<&str>,
    profile_ref: &str,
    profile_digest: &str,
    cache_active: &str,
    cache_bypass: &str,
) -> bool {
    if cache_active == "1"
        || cache_bypass == SOURCE_ACCEPTANCE_CACHE_BYPASS
        || (profile_ref.is_empty() && profile_digest.is_empty())
    {
        return false;
    }
    if command == Some("gate") {
        return gate_subcommand == Some("run");
    }
    !matches!(
        command,
        None | Some(
            "cache"
                | "docs"
                | "proxy"
                | "config"
                | "clone"
                | "self-update"
                | "self-version"
                | "promote"
                | "builds"
                | "-h"
                | "--help"
                | "-v"
                | "-V"
                | "--version"
        )
    )
}

fn should_pin_cache_launcher(command: Option<&str>) -> bool {
    command == Some("cache")
}

fn auto_apply_args(args: &[String]) -> Vec<String> {
    let mut wrapped = vec![
        "cache".to_string(),
        "apply".to_string(),
        "--".to_string(),
        "./shifu".to_string(),
    ];
    wrapped.extend_from_slice(args);
    wrapped
}

fn print_usage() {
    println!(
        "\u{1f94b} {}",
        style::bold("shifu - the kungfu development/build launcher (pinned-toolchain entrypoint)")
    );
    println!(
        "   {}",
        style::dim(
            "\u{201c}When your kungfu fails you, the one you turn to is your shifu.\u{201d}"
        )
    );
    println!();
    println!("{}", style::cyan("Usage:"));
    println!("  shifu <task> [args...]     run any pnpm task under the pinned toolchain");
    println!(
        "                             {}",
        style::dim("(node via fnm/.node-version, python via uv;")
    );
    println!(
        "                             {}",
        style::dim("missing prerequisites bootstrap automatically)")
    );
    println!("  shifu build | rebuild      bootstrap build (rebuild clears generated outputs)");
    println!("  shifu cache ...            inspect the versioned cache contract and schemas");
    println!("  shifu docs ...             validate documentation submissions and canonical roots");
    println!("  shifu gate ...             inspect and plan registered project gates");
    println!("  shifu proxy | config ...   manage local mirror/cache config (build-local.env)");
    println!("  shifu clone [path]         clone the kungfu repository (default: current dir;");
    println!(
        "                             {}",
        style::dim("SHIFU_CLONE_URL overrides the source)")
    );
    println!("  shifu doctor               check the development environment (install pointers");
    println!(
        "                             {}",
        style::dim("for anything missing; exits 1 on missing required)")
    );
    println!("  shifu --version | -v | -V  launcher version and build identity");
    println!("  shifu self-version         this binary's version, machine readable");
    println!("  shifu self-update          refresh this installed binary in place");
    println!(
        "                             {}",
        style::dim("(checkout source > local build slot; --version <v> for a")
    );
    println!(
        "                             {}",
        style::dim("release; --list provenance; --rollback one step back)")
    );
    println!("  shifu promote [--launch]   install the unique descendant dev build");
    println!("  shifu builds               list provenance and Git relation for dev builds");
    println!("  shifu artifacts <verb>     print the local artifact contract or schema");
    println!("  shifu help                 pnpm's own help (tasks are pnpm scripts)");
    println!();
    println!(
        "{} sync, build, check, fix, verify, dist, app",
        style::cyan("Common tasks:")
    );
    println!(
        "{} AGENTS.md (build), docs/development/rust-adoption.md (how this launcher works)",
        style::cyan("Docs:")
    );
}

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
        print_usage();
        exit(if args.is_empty() { 2 } else { 0 });
    }

    // Repo acquisition — the one verb that must work outside a checkout.
    if first == Some("clone") {
        clone_repo(&args[1..]);
    }

    let is_version = matches!(first, Some("--version") | Some("-v") | Some("-V"));
    let is_doctor = first == Some("doctor");
    let is_self_update = first == Some("self-update");
    // Product-stash verbs work outside a checkout too: the stash is
    // user-global precisely so a cleaned worktree cannot strand its build.
    let is_promote = first == Some("promote");
    let is_builds = first == Some("builds");
    let is_artifacts = first == Some("artifacts");
    let lenient =
        is_version || is_doctor || is_self_update || is_promote || is_builds || is_artifacts;

    let root = find_repo_root(lenient);

    if is_version {
        println!("{}", version_line(root.as_deref()));
    }
    // User-global config loads unconditionally (rootless verbs read it too);
    // the repo-root override only exists inside a checkout.
    envfile::load(root.as_deref());
    if let Some(root) = root.as_deref() {
        // self-update answers for THIS binary (never delegated): delegation
        // would replace the process with the checkout's launcher, while the
        // update must act on the binary the user invoked.
        if is_self_update {
            self_update::run(Some(root), &args[1..]);
        }
        maybe_delegate_to_repo_entrypoint(root, &args);
    }
    if is_version {
        exit(0);
    }
    if is_self_update {
        self_update::run(None, &args[1..]);
    }
    #[cfg(windows)]
    if is_doctor {
        if let Some(root) = root.as_deref() {
            msvc::ensure_msvc_env(root);
        }
    }
    if is_doctor {
        doctor::run(root.as_deref(), &args[1..]);
    }
    if is_promote {
        promote::run_promote(&args[1..]);
    }
    if is_builds {
        promote::run_builds(&args[1..]);
    }
    if is_artifacts {
        artifact_catalog::run_discovery(&args[1..]);
    }
    let root = root.expect("strict repo discovery cannot return None");

    // Explicit cache application delegates to Node before launching the
    // projected child. Pin the already-running native launcher so that child
    // commands can bypass the platform shim without rebuilding or guessing a
    // cache-slot path. Automatic cache application establishes the same
    // contract below.
    if should_pin_cache_launcher(first) && env::var_os("SHIFU_BIN").is_none() {
        if let Ok(current_exe) = env::current_exe() {
            env::set_var("SHIFU_BIN", current_exe);
        }
    }

    // A projected profile makes the ordinary documented entrypoint sufficient:
    // resolve/apply once, then re-enter through ./shifu with the runtime fuse.
    // Either half of the pair triggers the resolver so partial configuration
    // still fails closed. Control/bootstrap verbs stay outside this boundary.
    if should_auto_apply_cache(
        first,
        (first == Some("gate"))
            .then(|| args.get(1).map(String::as_str))
            .flatten(),
        &env::var("SHIFU_CACHE_PROFILE_REF").unwrap_or_default(),
        &env::var("SHIFU_CACHE_PROFILE_DIGEST").unwrap_or_default(),
        &env::var("SHIFU_CACHE_ACTIVE").unwrap_or_default(),
        &env::var("SHIFU_CACHE_BYPASS").unwrap_or_default(),
    ) {
        // The managed child re-enters through the canonical script. Pin it to
        // this already-running launcher so a dirty development checkout does
        // not rebuild the same native binary a second time.
        if let Ok(current_exe) = env::current_exe() {
            env::set_var("SHIFU_BIN", current_exe);
        }
        dispatch::delegate_l2(&root, &auto_apply_args(&args));
    }

    // L2 build/rebuild dispatches inherit this process environment, so load
    // MSVC before selecting the Node path. Proxy/config are intentionally
    // compiler-free; ordinary pnpm tasks keep the historical MSVC bootstrap.
    #[cfg(windows)]
    if command_requires_msvc(first) {
        msvc::ensure_msvc_env(&root);
    }

    match first {
        Some(cmd) if L2_SUBCOMMANDS.contains(&cmd) => dispatch::delegate_l2(&root, &args),
        _ => dispatch::run_pnpm(&root, &args),
    }
}

const DEFAULT_CLONE_URL: &str = "https://github.com/kungfu-systems/kungfu.git";

/// `shifu clone [path]` — fetch the kungfu repository (default: into the
/// current directory, which git requires to be empty). With this one verb an
/// installed shifu is a self-sufficient bootstrap core: clone anywhere, and
/// inside the checkout every later invocation delegates to the repo-pinned
/// launcher, so new functionality always comes from the repo, never from
/// re-installing the binary.
fn clone_repo(args: &[String]) -> ! {
    if args.len() > 1 {
        util::die("usage: shifu clone [path]");
    }
    let dest = args.first().map(String::as_str).unwrap_or(".");
    let url = env::var("SHIFU_CLONE_URL").unwrap_or_else(|_| DEFAULT_CLONE_URL.to_string());
    let Some(git) = util::find_on_path("git") else {
        util::die_code(
            "git is required for clone — install it first (https://git-scm.com/downloads)",
            127,
        );
    };
    eprintln!(
        "\u{1f94b} {}",
        style::bold(&format!("cloning {url} into {dest}"))
    );
    let status = std::process::Command::new(git)
        .arg("clone")
        .arg(&url)
        .arg(dest)
        .status();
    match status {
        Ok(s) if s.success() => {
            let cd_hint = if dest == "." {
                String::new()
            } else {
                format!("cd {dest} && ")
            };
            eprintln!(
                "\u{2705} {} next: {}",
                style::green("done -"),
                style::bold(&format!("{cd_hint}./shifu build")),
            );
            eprintln!(
                "   {}",
                style::dim("(or ./shifu doctor first to check your environment)")
            );
            exit(0);
        }
        Ok(s) => exit(s.code().unwrap_or(1)),
        Err(e) => util::die(&format!("failed to run git clone: {e}")),
    }
}

/// One line of build identity: crate version (locked to the monorepo train),
/// the commit that built this binary, and whether this process is the repo's
/// own launcher or an externally installed one. The repo role also reports the
/// checkout's current branch — the binary identity is baked, but the branch is
/// live repo state.
fn version_line(root: Option<&Path>) -> String {
    let mut is_repo = env::var("SHIFU_FROM_SHIM").ok().as_deref() == Some("1");
    if !is_repo {
        if let (Ok(exe), Some(root)) = (env::current_exe(), root) {
            let exe = exe.canonicalize().unwrap_or(exe);
            let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            is_repo = exe.starts_with(root);
        }
    }
    let role = if is_repo {
        match root.and_then(current_branch) {
            Some(branch) => format!("repo @ {branch}"),
            None => "repo".to_string(),
        }
    } else {
        "installed".to_string()
    };
    format!(
        "shifu {} (git {}, {}, {role})",
        env!("CARGO_PKG_VERSION"),
        env!("SHIFU_GIT_SHA"),
        env!("SHIFU_BUILD_CHANNEL"),
    )
}

fn current_branch(root: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() {
        return None;
    }
    Some(if branch == "HEAD" {
        "detached".to_string()
    } else {
        branch
    })
}

/// An installed binary run inside a checkout hands over to that checkout's
/// ./shifu entrypoint, so the repo-pinned launcher version always wins. Skipped
/// when the shim dispatched us (SHIFU_FROM_SHIM=1) or when this binary already
/// lives inside the repo (a local cargo build).
///
/// Two protocol properties keep the handover future-proof and loop-free:
/// the entrypoint is spawned directly (executable bit + shebang, or cmd.exe
/// for the .cmd), so nothing about its implementation form is baked into old
/// binaries; and the spawn carries SHIFU_DELEGATED=1 as a second fuse — a
/// binary that sees it never delegates again, so even a future shim that
/// forgets SHIFU_FROM_SHIM cannot produce an infinite delegation loop.
fn maybe_delegate_to_repo_entrypoint(root: &Path, args: &[String]) {
    if env::var("SHIFU_FROM_SHIM").ok().as_deref() == Some("1")
        || env::var("SHIFU_DELEGATED").ok().as_deref() == Some("1")
    {
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
        // Spawn the entrypoint directly: the kernel resolves shebang vs native
        // executable, so its implementation form is not baked in here.
        let mut cmd = std::process::Command::new(&script);
        cmd.args(args)
            .env("SHIFU_DELEGATED", "1")
            .current_dir(&root);
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
        cmd.env("SHIFU_DELEGATED", "1").current_dir(&root);
        util::exec_or_exit(cmd);
    }
}

/// Locate the repository root. The binary may run from the repo, from a
/// subdirectory, or from a user-global cache (via the shim), so the root is
/// discovered rather than assumed: explicit override first, then walk up from
/// the current directory looking for the repo's own entrypoint marker.
///
/// A directory is a kungfu repo root when both welded entrypoint files are
/// present. Protocol authority: ADR-0044 (shifu delegation protocol). This recognition protocol is deliberately anchored on nothing but
/// the entrypoints themselves (a KFD-1 welded surface, so it survives any
/// toolchain evolution — even a future without node), and on both of them as a
/// pair so a stray file named `shifu` in some unrelated directory cannot be
/// mistaken for a repo — the delegation path executes what it finds.
fn is_repo_root(dir: &Path) -> bool {
    dir.join("shifu").is_file() && dir.join("shifu.cmd").is_file()
}

/// Nearest ancestor (inclusive) that is a kungfu bootstrap repo root.
fn find_kungfu_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| is_repo_root(dir))
        .map(Path::to_path_buf)
}

/// Nearest ancestor (inclusive) that is a buildchain-managed repo declaring
/// shifu as its KFD-3 registrar. The `.buildchain-version` pin narrows the
/// walk with a cheap existence check; recognition still requires the explicit
/// jurisdiction declaration (read via buildchain), so a stray buildchain repo
/// that never opted into shifu is not claimed.
fn find_buildchain_managed_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .filter(|dir| dir.join(tools::BUILDCHAIN.pin_file()).is_file())
        .find(|dir| registrar::declares_shifu_jurisdiction(dir))
        .map(Path::to_path_buf)
}

/// Locate the repository root, two-level. Level 1 is a kungfu bootstrap repo —
/// the welded `shifu`/`shifu.cmd` entrypoint pair (ADR-0044), which delegates
/// to its own repo-pinned launcher. Level 2, reached only for real dispatch,
/// is a buildchain-managed repo that declares shifu as its KFD-3 registrar: it
/// has no in-repo entrypoint to spawn, so the installed binary serves it
/// directly (delegation no-ops when the pair is absent, then `run_pnpm` runs
/// the declared task).
///
/// With `lenient` (used by --version and doctor), failing to find a repo
/// returns None instead of dying — those verbs are useful rootless, and they
/// deliberately skip the Level-2 check so a version print never triggers a
/// buildchain acquisition.
fn find_repo_root(lenient: bool) -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("SHIFU_ROOT") {
        let root = PathBuf::from(explicit);
        if is_repo_root(&root) {
            return Some(root);
        }
        util::die(&format!(
            "SHIFU_ROOT does not look like a kungfu repo (missing shifu / shifu.cmd entrypoints): {}",
            root.display()
        ));
    }
    let start = env::current_dir().unwrap_or_else(|e| util::die(&format!("cannot read cwd: {e}")));
    if let Some(root) = find_kungfu_root(&start) {
        return Some(root);
    }
    if !lenient {
        if let Some(root) = find_buildchain_managed_root(&start) {
            return Some(root);
        }
    }
    if lenient {
        return None;
    }
    util::die(
        "not inside a kungfu repository (no shifu/shifu.cmd entrypoint pair, and no \
         buildchain-managed repo declaring shifu, walking up from the current \
         directory; set SHIFU_ROOT to override)",
    )
}

#[cfg(test)]
mod tests {
    use super::{
        auto_apply_args, command_requires_msvc, find_kungfu_root, is_repo_root,
        should_auto_apply_cache, should_pin_cache_launcher,
    };
    use std::fs;

    #[test]
    fn kungfu_root_needs_the_welded_entrypoint_pair() {
        let base = shifu_core::host::unique_temp_dir("shifu-root").unwrap();
        let repo = base.join("repo");
        let nested = repo.join("a/b");
        fs::create_dir_all(&nested).unwrap();

        // No entrypoint pair anywhere → no kungfu root.
        assert!(find_kungfu_root(&nested).is_none());
        // A lone `shifu` file is not enough (a stray file must not be a root).
        fs::write(repo.join("shifu"), "x").unwrap();
        assert!(!is_repo_root(&repo));
        assert!(find_kungfu_root(&nested).is_none());
        // Both welded files → the nested cwd resolves up to the repo root.
        fs::write(repo.join("shifu.cmd"), "x").unwrap();
        assert!(is_repo_root(&repo));
        assert_eq!(
            find_kungfu_root(&nested).unwrap().canonicalize().unwrap(),
            repo.canonicalize().unwrap()
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn compiler_environment_precedes_every_build_capable_dispatch() {
        assert!(command_requires_msvc(Some("build")));
        assert!(command_requires_msvc(Some("rebuild")));
        assert!(command_requires_msvc(Some("build:core")));
        assert!(command_requires_msvc(Some("qualify:mmap")));
        assert!(!command_requires_msvc(Some("proxy")));
        assert!(!command_requires_msvc(Some("config")));
        assert!(!command_requires_msvc(Some("cache")));
        assert!(!command_requires_msvc(Some("gate")));
    }

    #[test]
    fn explicit_cache_dispatch_pins_the_running_native_launcher() {
        assert!(should_pin_cache_launcher(Some("cache")));
        assert!(!should_pin_cache_launcher(Some("gate")));
        assert!(!should_pin_cache_launcher(Some("build")));
        assert!(!should_pin_cache_launcher(None));
    }

    #[test]
    fn projected_cache_wraps_tasks_once_and_keeps_control_verbs_direct() {
        assert!(should_auto_apply_cache(
            Some("build"),
            None,
            "profile.json",
            "sha256:abc",
            "",
            ""
        ));
        assert!(should_auto_apply_cache(
            Some("check"),
            None,
            "profile.json",
            "",
            "",
            ""
        ));
        assert!(should_auto_apply_cache(
            Some("gate"),
            Some("run"),
            "profile.json",
            "sha256:abc",
            "",
            ""
        ));
        assert!(!should_auto_apply_cache(
            Some("build"),
            None,
            "profile.json",
            "sha256:abc",
            "1",
            ""
        ));
        assert!(!should_auto_apply_cache(
            Some("build"),
            None,
            "profile.json",
            "sha256:abc",
            "",
            "source-acceptance"
        ));
        assert!(should_auto_apply_cache(
            Some("build"),
            None,
            "profile.json",
            "sha256:abc",
            "",
            "unrecognized-bypass"
        ));
        assert!(!should_auto_apply_cache(
            Some("build"),
            None,
            "",
            "",
            "",
            ""
        ));
        for command in [
            "cache",
            "config",
            "proxy",
            "clone",
            "self-update",
            "self-version",
            "promote",
            "builds",
            "--version",
            "--help",
        ] {
            assert!(!should_auto_apply_cache(
                Some(command),
                None,
                "profile.json",
                "sha256:abc",
                "",
                ""
            ));
        }
        for subcommand in [
            "contract", "schema", "validate", "matrix", "plan", "receipt",
        ] {
            assert!(!should_auto_apply_cache(
                Some("gate"),
                Some(subcommand),
                "profile.json",
                "sha256:abc",
                "",
                ""
            ));
        }
    }

    #[test]
    fn cache_wrapper_reenters_the_canonical_entrypoint() {
        assert_eq!(
            auto_apply_args(&["check".to_string(), "--all".to_string()]),
            ["cache", "apply", "--", "./shifu", "check", "--all"]
        );
    }
}
