// SPDX-License-Identifier: Apache-2.0
//
// `shifu self-update` — refresh an installed shifu binary in place.
//
// Answered before repo delegation on purpose (like self-version): delegation
// replaces the process with the checkout's launcher, and an update must act
// on the binary the user actually invoked. Inside a checkout the freshest
// truth is the checkout itself — build from source when cargo is present,
// else fetch the release asset the checkout pins. Outside a checkout an
// explicit `--version <v>` is required: guessing "latest" across a shared
// release namespace is how updaters install the wrong thing.
//
// Shim-cache copies are refused: the repo shim owns their lifecycle (slots
// are content-addressed against the launcher source and retired
// automatically), so updating one in place would only be overwritten.
//
// The replacement is a rename dance — stage next to the target, move the old
// binary aside, move the new one in, restore on failure — so a failed update
// never leaves the machine without a working shifu (the helper of last
// resort must not be breakable by its own maintenance).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use shifu_core::bootstrap::{self, FetchSpec};
use shifu_core::{host, style};

use crate::util;

const DIST_BASE: &str = "https://github.com/kungfu-systems/kungfu/releases/download";

pub fn run(root: Option<&Path>, args: &[String]) -> ! {
    let mut version_arg: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--version" => match iter.next() {
                Some(v) => version_arg = Some(v.clone()),
                None => util::die("usage: shifu self-update [--version <version>]"),
            },
            _ => util::die("usage: shifu self-update [--version <version>]"),
        }
    }

    let exe = env::current_exe()
        .and_then(|p| p.canonicalize())
        .unwrap_or_else(|e| util::die(&format!("cannot locate this binary: {e}")));

    let shim_cache = host::kungfu_cache_dir().join("shifu");
    if exe.starts_with(&shim_cache) {
        util::die(&format!(
            "this copy is a repo-shim cache slot ({}) — the shim refreshes it automatically; \
             to force a refresh remove the slot: rm -rf {}",
            exe.display(),
            exe.parent().unwrap_or(&shim_cache).display()
        ));
    }

    // Decide the replacement. An explicit --version always means the release
    // asset (also the escape hatch when a checkout's source cannot build).
    let source_root = match version_arg {
        None => root.filter(|_| cargo_path().is_some()),
        Some(_) => None,
    };
    let new_binary = if let Some(root) = source_root {
        build_from_source(root)
    } else {
        let version = version_arg
            .or_else(|| root.and_then(pinned_version))
            .unwrap_or_else(|| {
                util::die(
                    "outside a kungfu checkout the target must be explicit: \
                     shifu self-update --version <version>",
                )
            });
        fetch_release(&version)
    };

    replace_binary(&exe, &new_binary);
    eprintln!(
        "\u{2705} {} {}",
        style::green("updated"),
        style::bold(&exe.display().to_string())
    );
    eprintln!("   {}", style::dim("verify with: shifu --version"));
    std::process::exit(0)
}

fn cargo_path() -> Option<PathBuf> {
    host::find_on_path("cargo")
}

/// The launcher release pin of a checkout (crates/shifu/Cargo.toml).
fn pinned_version(root: &Path) -> Option<String> {
    let toml = fs::read_to_string(root.join("crates/shifu/Cargo.toml")).ok()?;
    toml.lines()
        .find_map(|line| line.strip_prefix("version = \""))
        .and_then(|rest| rest.strip_suffix('"'))
        .map(str::to_string)
}

/// Build the launcher from the checkout source. The cargo target dir lives in
/// the user cache so read-only-locked checkouts build too.
fn build_from_source(root: &Path) -> PathBuf {
    let cargo = cargo_path().expect("checked by caller");
    let target_dir = host::kungfu_cache_dir()
        .join("shifu")
        .join("cargo-target")
        .join("self-update");
    if let Err(e) = fs::create_dir_all(&target_dir) {
        util::die(&format!("cannot create {}: {e}", target_dir.display()));
    }
    eprintln!(
        "shifu: building from source at {}",
        style::bold(&root.display().to_string())
    );
    let status = Command::new(cargo)
        .args(["build", "--release", "--locked", "--manifest-path"])
        .arg(root.join("crates/Cargo.toml"))
        .args(["-p", "shifu"])
        .env("CARGO_TARGET_DIR", &target_dir)
        .current_dir(root)
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => util::die(&format!(
            "source build failed (exit {:?}); to update from a release instead: \
             shifu self-update --version <version>",
            s.code()
        )),
        Err(e) => util::die(&format!("failed to run cargo: {e}")),
    }
    let name = if cfg!(windows) { "shifu.exe" } else { "shifu" };
    target_dir.join("release").join(name)
}

/// Release asset name for the current platform (mirrors release-shifu.yml).
fn release_asset() -> String {
    let (os, arch) = (env::consts::OS, env::consts::ARCH);
    match (os, arch) {
        ("macos", "aarch64") => "shifu-macos-arm64".to_string(),
        ("macos", "x86_64") => "shifu-macos-x64".to_string(),
        ("linux", "x86_64") => "shifu-linux-x64".to_string(),
        ("linux", "aarch64") => "shifu-linux-arm64".to_string(),
        ("windows", "x86_64") => "shifu-windows-x64.exe".to_string(),
        _ => util::die(&format!("no prebuilt shifu release for {os}/{arch}")),
    }
}

/// Fetch the pinned release binary, verified against the release's
/// SHA256SUMS, through shifu-core's fetch engine (cached user-globally, so
/// repeating an update needs no second download).
fn fetch_release(version: &str) -> PathBuf {
    let asset = release_asset();
    let base = env::var("SHIFU_DIST_MIRROR").unwrap_or_else(|_| DIST_BASE.to_string());
    let dir = format!("{}/shifu-v{version}", base.trim_end_matches('/'));

    let work = host::unique_temp_dir("shifu-self-update")
        .unwrap_or_else(|e| util::die(&format!("cannot create temp dir: {e}")));
    let sums_path = work.join("SHA256SUMS");
    let sums_url = format!("{dir}/SHA256SUMS");
    if let Err(e) = bootstrap::download_file(&sums_url, &sums_path) {
        util::die(&format!(
            "cannot fetch the release checksum manifest: {e}\n  url: {sums_url}\n  \
             set SHIFU_DIST_MIRROR to a reachable mirror to route around it"
        ));
    }
    let sums = fs::read_to_string(&sums_path)
        .unwrap_or_else(|e| util::die(&format!("cannot read {}: {e}", sums_path.display())));
    let expected = sums
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?, fields.next()?))
        })
        .find_map(|(digest, name)| {
            (name.trim_start_matches('*') == asset).then(|| digest.to_lowercase())
        })
        .unwrap_or_else(|| {
            util::die(&format!(
                "release shifu-v{version} has no checksum entry for {asset} in SHA256SUMS"
            ))
        });
    let _ = fs::remove_dir_all(&work);

    let spec = FetchSpec {
        tool: "shifu".to_string(),
        version: version.to_string(),
        url: format!("{dir}/{asset}"),
        sha256: Some(expected),
        mirror_env: Some("SHIFU_DIST_MIRROR".to_string()),
        binary: None,
    };
    eprintln!("shifu: fetching release {}", style::bold(version));
    bootstrap::fetch(&spec).unwrap_or_else(|err| util::die(&err.to_string()))
}

/// Rename-dance replacement: never a moment without a runnable binary at the
/// target path, and the old binary is restored if the swap fails.
fn replace_binary(exe: &Path, new_binary: &Path) {
    let dir = exe
        .parent()
        .unwrap_or_else(|| util::die("cannot resolve the install directory"));
    let staged = dir.join(format!(".shifu-update-{}", std::process::id()));
    if let Err(e) = fs::copy(new_binary, &staged) {
        util::die(&format!(
            "cannot stage the new binary next to {}: {e}\n  \
             (is the install directory writable?)",
            exe.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&staged, fs::Permissions::from_mode(0o755));
    }
    // Windows cannot delete a running exe but can rename it; Unix does not
    // care either way. Move the old one aside, the new one in.
    let backup = dir.join(".shifu-update-old");
    let _ = fs::remove_file(&backup);
    if let Err(e) = fs::rename(exe, &backup) {
        let _ = fs::remove_file(&staged);
        util::die(&format!("cannot move the old binary aside: {e}"));
    }
    if let Err(e) = fs::rename(&staged, exe) {
        let _ = fs::rename(&backup, exe);
        util::die(&format!("swap failed, old binary restored: {e}"));
    }
    if fs::remove_file(&backup).is_err() {
        // Expected on Windows while the old image is still running.
        eprintln!(
            "   {}",
            style::dim(&format!(
                "old binary left at {} (removable after this process exits)",
                backup.display()
            ))
        );
    }
}
