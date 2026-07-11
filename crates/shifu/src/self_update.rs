// SPDX-License-Identifier: Apache-2.0
//
// `shifu self-update` — refresh an installed shifu binary in place, with
// provenance and a way back.
//
// Answered before repo delegation on purpose (like self-version): delegation
// replaces the process with the checkout's launcher, and an update must act
// on the binary the user actually invoked.
//
// Where the new binary comes from, in order:
//
//   1. --version <v>       the release asset, verified against SHA256SUMS —
//                          also the explicit road back to the official build
//   2. inside a checkout   built from the checkout's current source (cargo
//                          present) — fresher than any stash can be
//   3. local build slot    the newest source-fresh cache slot the repo shim
//                          built (~/.cache/kungfu/shifu/<slot>/): the binary
//                          that actually drove the last build, surviving its
//                          worktree — so upgrading needs no checkout at all;
//                          its full identity line prints before the swap
//
// Every replacement first archives the outgoing binary (this very process, so
// its identity is compile-time exact) under .../shifu/generations/, keeping
// KUNGFU_SHIFU_GENERATIONS_KEEP (default 3): `--list` shows the ledger,
// `--rollback` restores the previous generation (archiving the current one,
// so a rollback is itself reversible). The helper of last resort must not be
// breakable by its own maintenance — a failed swap restores the old binary,
// and a regretted swap is one verb away from undone.
//
// Shim-cache copies are refused: the repo shim owns their lifecycle.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use shifu_core::bootstrap::{self, FetchSpec};
use shifu_core::{host, style};

use crate::{envfile, util};

const DIST_BASE: &str = "https://github.com/kungfu-systems/kungfu/releases/download";
const USAGE: &str = "usage: shifu self-update [--version <version> | --list | --rollback]";

/// The running binary's own identity — exact by construction: these are the
/// compile-time constants of the process doing the archiving.
fn own_identity() -> (&'static str, &'static str, &'static str) {
    (
        env!("CARGO_PKG_VERSION"),
        env!("SHIFU_GIT_SHA"),
        env!("SHIFU_BUILD_CHANNEL"),
    )
}

pub fn run(root: Option<&Path>, args: &[String]) -> ! {
    let mut version_arg: Option<String> = None;
    let mut list = false;
    let mut rollback = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--version" => match iter.next() {
                Some(v) => version_arg = Some(v.clone()),
                None => util::die(USAGE),
            },
            "--list" => list = true,
            "--rollback" => rollback = true,
            _ => util::die(USAGE),
        }
    }
    if (list && rollback) || (version_arg.is_some() && (list || rollback)) {
        util::die(USAGE);
    }

    let exe = env::current_exe()
        .and_then(|p| p.canonicalize())
        .unwrap_or_else(|e| util::die(&format!("cannot locate this binary: {e}")));

    let shim_cache = host::kungfu_cache_dir().join("shifu");
    if exe.starts_with(&shim_cache) {
        util::die(&format!(
            "this copy lives in the shifu cache ({}) — shim slots refresh themselves, and \
             generations are restored with --rollback from the installed binary",
            exe.display()
        ));
    }

    if list {
        run_list();
    }
    if rollback {
        run_rollback(&exe);
    }

    // Decide the replacement. An explicit --version always means the release
    // asset (also the escape hatch when a checkout's source cannot build).
    let source_root = match version_arg {
        None => root.filter(|_| cargo_path().is_some()),
        Some(_) => None,
    };
    let new_binary = if let Some(root) = source_root {
        build_from_source(root)
    } else if let Some(version) = version_arg.or_else(|| root.and_then(pinned_version)) {
        fetch_release(&version)
    } else if let Some(slot) = newest_build_slot() {
        announce_slot(&slot);
        slot
    } else {
        util::die(
            "nothing to update from: no local build slot exists yet — run inside a kungfu \
             checkout, or pass an explicit release: shifu self-update --version <version>",
        )
    };

    archive_current(&exe);
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

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "shifu.exe"
    } else {
        "shifu"
    }
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
    target_dir.join("release").join(binary_name())
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

// ---------------------------------------------------------------------------
// Local build slots — the shim's source-fresh cache as an upgrade source.

/// The newest binary among the shim's cache slots (release-pin and
/// source-fresh alike), by binary mtime: the build most recently placed is
/// the one most recently proven in use. Bookkeeping dirs are excluded.
fn newest_build_slot() -> Option<PathBuf> {
    let root = host::kungfu_cache_dir().join("shifu");
    let entries = fs::read_dir(&root).ok()?;
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "generations" || name == "cargo-target" || name.contains(".tmp") {
            continue;
        }
        let bin = dir.join(binary_name());
        let Ok(meta) = bin.metadata() else {
            continue;
        };
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, bin));
        }
    }
    best.map(|(_, bin)| bin)
}

/// A binary's full identity line, by asking it. Spawning is safe: --version
/// answers before any delegation, and SHIFU_DELEGATED suppresses delegation
/// entirely.
fn identity_of(binary: &Path) -> Option<String> {
    Command::new(binary)
        .arg("--version")
        .env("SHIFU_DELEGATED", "1")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines().next().map(|line| line.trim().to_string())
        })
}

/// Print the slot binary's identity before the swap: the user sees exactly
/// what they are upgrading to.
fn announce_slot(slot: &Path) {
    let identity = identity_of(slot)
        .unwrap_or_else(|| format!("(unidentifiable binary at {})", slot.display()));
    eprintln!("shifu: upgrading to the newest local build slot:");
    eprintln!("   {}", style::bold(&identity));
}

// ---------------------------------------------------------------------------
// Generations — the archive of replaced binaries, and the way back.

fn generations_dir() -> PathBuf {
    host::kungfu_cache_dir().join("shifu").join("generations")
}

fn generations_keep() -> usize {
    env::var("KUNGFU_SHIFU_GENERATIONS_KEEP")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(3)
}

fn epoch_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

struct Generation {
    dir: PathBuf,
    version: String,
    sha: String,
    channel: String,
    archived_at: u64,
}

/// All archived generations, newest first (slot names sort by zero-padded
/// epoch seconds).
fn generations() -> Vec<Generation> {
    let root = generations_dir();
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| !name.contains(".tmp") && !name.contains(".restoring"))
        .collect();
    names.sort();
    names.reverse();
    names
        .into_iter()
        .filter_map(|name| {
            let dir = root.join(&name);
            if !dir.join(binary_name()).is_file() {
                return None;
            }
            let meta = fs::read_to_string(dir.join("meta.env")).ok()?;
            let get = |key: &str| {
                meta.lines()
                    .filter_map(envfile::parse_line)
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.to_string())
                    .unwrap_or_default()
            };
            Some(Generation {
                version: get("KUNGFU_SHIFU_VERSION"),
                sha: get("KUNGFU_SHIFU_SHA"),
                channel: get("KUNGFU_SHIFU_CHANNEL"),
                archived_at: get("KUNGFU_SHIFU_ARCHIVED_AT").parse().unwrap_or(0),
                dir,
            })
        })
        .collect()
}

fn age(archived_at: u64) -> String {
    let secs = epoch_now().saturating_sub(archived_at);
    if secs < 120 {
        format!("{secs}s ago")
    } else if secs < 7200 {
        format!("{}m ago", secs / 60)
    } else if secs < 172_800 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86_400)
    }
}

/// Archive the outgoing binary (this very process) before it is replaced.
/// Best-effort: an archive failure warns but never blocks the update.
fn archive_current(exe: &Path) {
    let (version, sha, channel) = own_identity();
    let slot = generations_dir().join(format!("{:012}-{sha}", epoch_now()));
    let staging = slot.with_extension("tmp");
    let _ = fs::remove_dir_all(&staging);
    let placed = fs::create_dir_all(&staging).is_ok()
        && fs::copy(exe, staging.join(binary_name())).is_ok()
        && fs::write(
            staging.join("meta.env"),
            format!(
                "KUNGFU_SHIFU_VERSION='{version}'\nKUNGFU_SHIFU_SHA='{sha}'\n\
                 KUNGFU_SHIFU_CHANNEL='{channel}'\nKUNGFU_SHIFU_ARCHIVED_AT='{}'\n\
                 KUNGFU_SHIFU_FROM='{}'\n",
                epoch_now(),
                exe.display()
            ),
        )
        .is_ok()
        && fs::rename(&staging, &slot).is_ok();
    if !placed {
        let _ = fs::remove_dir_all(&staging);
        eprintln!(
            "   {}",
            style::yellow(
                "warning: could not archive the current binary; --rollback will not reach it"
            )
        );
        return;
    }
    // Retention: keep the newest KUNGFU_SHIFU_GENERATIONS_KEEP generations.
    for stale in generations().into_iter().skip(generations_keep()) {
        let _ = fs::remove_dir_all(&stale.dir);
    }
}

fn run_list() -> ! {
    let (version, sha, channel) = own_identity();
    println!(
        "{} shifu {version} (git {sha}, {channel})",
        style::cyan("Installed:")
    );
    match newest_build_slot() {
        Some(slot) => {
            let line = identity_of(&slot).unwrap_or_else(|| slot.display().to_string());
            println!("{} {line}", style::cyan("Local build slot:"));
        }
        None => println!("{} none", style::cyan("Local build slot:")),
    }
    let generations = generations();
    if generations.is_empty() {
        println!("{} none yet", style::cyan("Generations:"));
    } else {
        println!("{}", style::cyan("Generations (newest first):"));
        for (index, generation) in generations.iter().enumerate() {
            println!(
                "  [{index}] shifu {} (git {}, {}) {}",
                generation.version,
                generation.sha,
                generation.channel,
                style::dim(&age(generation.archived_at)),
            );
        }
        println!(
            "\n{} shifu self-update --rollback restores [0]",
            style::cyan("Next:")
        );
    }
    std::process::exit(0)
}

/// Restore the newest generation. The current binary is archived first, so a
/// rollback is itself reversible; the restored generation's slot is consumed.
fn run_rollback(exe: &Path) -> ! {
    let Some(generation) = generations().into_iter().next() else {
        util::die(
            "no generations to roll back to (they accumulate as self-update replaces binaries)",
        );
    };
    eprintln!(
        "\u{1f94b} {}",
        style::bold(&format!(
            "rolling back to shifu {} (git {}, {}, archived {})",
            generation.version,
            generation.sha,
            generation.channel,
            age(generation.archived_at)
        ))
    );
    // Move the target generation aside first: archiving the current binary
    // below prunes old generations, and the one being restored must survive
    // both the prune and the consume-after-install.
    let staging = generation.dir.with_extension("restoring");
    let _ = fs::remove_dir_all(&staging);
    if let Err(e) = fs::rename(&generation.dir, &staging) {
        util::die(&format!("cannot stage the generation: {e}"));
    }
    archive_current(exe);
    replace_binary(exe, &staging.join(binary_name()));
    let _ = fs::remove_dir_all(&staging);
    eprintln!(
        "\u{2705} {} {}",
        style::green("rolled back"),
        style::bold(&exe.display().to_string())
    );
    eprintln!("   {}", style::dim("verify with: shifu --version"));
    std::process::exit(0)
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
