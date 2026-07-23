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
//   3. local build slot    one unique same/descendant source-fresh cache slot
//                          recorded by the repo shim. Ancestor, divergent,
//                          unknown, and ambiguous slots fail closed unless the
//                          operator names one with --from and --force.
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

use crate::artifact_catalog::{
    automatic, compact_branch, git_relation, json_escape, select_unique_automatic, short_sha,
    state_for, write_promotion_receipt, GitRelation, SelectionError,
};
use crate::{envfile, util};

const DIST_BASE: &str = "https://github.com/kungfu-systems/kungfu/releases/download";
const USAGE: &str = "usage: shifu self-update [--version <version> | --from <id> [--force] | --list [--verbose] [--json] [--no-truncate] | --rollback]";

#[derive(Default)]
struct ListOptions {
    verbose: bool,
    json: bool,
    no_truncate: bool,
}

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
    let mut from_arg: Option<String> = None;
    let mut list = false;
    let mut rollback = false;
    let mut force = false;
    let mut list_options = ListOptions::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--version" => match iter.next() {
                Some(v) => version_arg = Some(v.clone()),
                None => util::die(USAGE),
            },
            "--from" => match iter.next() {
                Some(v) => from_arg = Some(v.clone()),
                None => util::die(USAGE),
            },
            "--list" => list = true,
            "--rollback" => rollback = true,
            "--force" => force = true,
            "--verbose" => list_options.verbose = true,
            "--json" => list_options.json = true,
            "--no-truncate" => list_options.no_truncate = true,
            _ => util::die(USAGE),
        }
    }
    if (list && rollback)
        || (version_arg.is_some() && (list || rollback || from_arg.is_some()))
        || (from_arg.is_some() && (list || rollback))
        || (!list && (list_options.verbose || list_options.json || list_options.no_truncate))
    {
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
        run_list(root, &list_options);
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
        guard_checkout_candidate(root, force);
        build_from_source(root)
    } else if let Some(version) = version_arg.or_else(|| root.and_then(pinned_version)) {
        fetch_release(&version)
    } else {
        select_build_slot(from_arg.as_deref(), force)
    };

    let candidate_sha = identity_parts(&new_binary).1;
    let candidate_relation = candidate_relation(&new_binary, source_root);
    let candidate_id = new_binary
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "source".to_string());
    let previous_sha = own_identity().1.to_string();
    archive_current(&exe);
    replace_binary(&exe, &new_binary);
    write_installed_receipt(&new_binary, source_root);
    if let Err(error) = write_promotion_receipt(
        &host::kungfu_cache_dir().join("shifu"),
        "shifu",
        "self-update",
        &candidate_id,
        &previous_sha,
        &candidate_sha,
        candidate_relation,
    ) {
        eprintln!(
            "   {}",
            style::yellow(&format!("could not write promotion receipt: {error}"))
        );
    }
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

#[derive(Clone)]
struct BuildSlot {
    id: String,
    binary: PathBuf,
    version: String,
    sha: String,
    channel: String,
    branch: String,
    repo: String,
    worktree: String,
    build_path: String,
    built_at: String,
    modified: SystemTime,
    valid: bool,
}

fn meta_value(dir: &Path, key: &str) -> String {
    let Ok(text) = fs::read_to_string(dir.join("meta.env")) else {
        return String::new();
    };
    text.lines()
        .filter_map(envfile::parse_line)
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn identity_parts(binary: &Path) -> (String, String, String) {
    let Some(line) = identity_of(binary) else {
        return (String::new(), String::new(), String::new());
    };
    let version = line.split_whitespace().nth(1).unwrap_or("").to_string();
    let sha = line
        .split("(git ")
        .nth(1)
        .and_then(|tail| tail.split(',').next())
        .unwrap_or("")
        .to_string();
    let channel = line
        .split("(git ")
        .nth(1)
        .and_then(|tail| tail.split(',').nth(1))
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    (version, sha, channel)
}

/// Every usable launcher slot. Recency is display provenance only; it is never
/// the authority for automatic selection.
fn build_slots() -> Vec<BuildSlot> {
    let root = host::kungfu_cache_dir().join("shifu");
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut slots = Vec::new();
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
        let (version, identity_sha, channel) = identity_parts(&bin);
        let recorded_sha = meta_value(&dir, "KUNGFU_ARTIFACT_SHA");
        let sha = if recorded_sha.is_empty() {
            identity_sha
        } else {
            recorded_sha
        };
        slots.push(BuildSlot {
            id: name,
            binary: bin,
            version,
            sha: sha.clone(),
            channel,
            branch: meta_value(&dir, "KUNGFU_ARTIFACT_BRANCH"),
            repo: meta_value(&dir, "KUNGFU_ARTIFACT_REPO"),
            worktree: meta_value(&dir, "KUNGFU_ARTIFACT_WORKTREE"),
            build_path: meta_value(&dir, "KUNGFU_ARTIFACT_BUILD_PATH"),
            built_at: meta_value(&dir, "KUNGFU_ARTIFACT_BUILT_AT"),
            modified,
            valid: !sha.is_empty(),
        });
    }
    slots.sort_by_key(|slot| std::cmp::Reverse(slot.modified));
    slots
}

fn git_output(root: &Path, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

fn slot_relation(slot: &BuildSlot, fallback_root: Option<&Path>) -> GitRelation {
    let worktree = Path::new(&slot.worktree);
    let canonical = Path::new(&slot.repo);
    let repo = worktree
        .is_dir()
        .then_some(worktree)
        .or(fallback_root)
        .or_else(|| canonical.is_dir().then_some(canonical));
    repo.map(|root| git_relation(root, own_identity().1, &slot.sha))
        .unwrap_or(GitRelation::Unknown)
}

fn generation_relation(generation: &Generation, fallback_root: Option<&Path>) -> GitRelation {
    let worktree = Path::new(&generation.worktree);
    let canonical = Path::new(&generation.repo);
    worktree
        .is_dir()
        .then_some(worktree)
        .or(fallback_root)
        .or_else(|| canonical.is_dir().then_some(canonical))
        .map(|root| git_relation(root, own_identity().1, &generation.sha))
        .unwrap_or(GitRelation::Unknown)
}

fn candidate_relation(binary: &Path, source_root: Option<&Path>) -> GitRelation {
    let candidate_sha = identity_parts(binary).1;
    let parent = binary.parent().unwrap_or_else(|| Path::new(""));
    let recorded_worktree = meta_value(parent, "KUNGFU_ARTIFACT_WORKTREE");
    let recorded_repo = meta_value(parent, "KUNGFU_ARTIFACT_REPO");
    let recorded_root = Path::new(&recorded_worktree);
    let canonical_root = Path::new(&recorded_repo);
    source_root
        .or_else(|| recorded_root.is_dir().then_some(recorded_root))
        .or_else(|| canonical_root.is_dir().then_some(canonical_root))
        .map(|repo| git_relation(repo, own_identity().1, &candidate_sha))
        .unwrap_or(GitRelation::Unknown)
}

fn guard_checkout_candidate(root: &Path, force: bool) {
    let candidate = git_output(root, &["rev-parse", "HEAD"]);
    let relation = git_relation(root, own_identity().1, &candidate);
    if matches!(relation, GitRelation::Same | GitRelation::Descendant) {
        return;
    }
    if !force {
        util::die(&format!(
            "refusing non-linear self-update: installed {} -> candidate {} is {}\n  \
             inspect with: shifu self-update --list --verbose\n  \
             override only after review: shifu self-update --force",
            short_sha(own_identity().1),
            short_sha(&candidate),
            relation.as_str()
        ));
    }
    eprintln!(
        "   {}",
        style::yellow(&format!(
            "non-linear history explicitly accepted: {}",
            relation.as_str()
        ))
    );
}

fn select_build_slot(from: Option<&str>, force: bool) -> PathBuf {
    let slots = build_slots();
    if slots.is_empty() {
        util::die(
            "nothing to update from: no local build slot exists yet — run inside a kungfu \
             checkout, or pass an explicit release: shifu self-update --version <version>",
        );
    }
    if let Some(id) = from {
        let matches: Vec<_> = slots
            .iter()
            .filter(|slot| slot.id == id || slot.id.starts_with(id))
            .collect();
        if matches.len() != 1 {
            util::die(&format!(
                "--from {id} matched {} slots; use the exact id from --list",
                matches.len()
            ));
        }
        let slot = matches[0];
        if !slot.valid {
            util::die(&format!(
                "artifact {} is invalid and cannot be installed even with --force",
                slot.id
            ));
        }
        let relation = slot_relation(slot, None);
        if !automatic(relation, slot.valid, false) && !force {
            util::die(&format!(
                "artifact {} is {} and requires both --from {} and --force",
                slot.id,
                relation.as_str(),
                slot.id
            ));
        }
        announce_slot(&slot.binary);
        return slot.binary.clone();
    }
    let dispositions: Vec<_> = slots
        .iter()
        .map(|slot| (slot_relation(slot, None), slot.valid, false))
        .collect();
    match select_unique_automatic(&dispositions) {
        Ok(index) => {
            let slot = &slots[index];
            announce_slot(&slot.binary);
            slot.binary.clone()
        }
        Err(SelectionError::None) => util::die(
            "no automatic self-update candidate: every local slot is older, divergent, or \
             has unknown provenance; inspect --list and select with --from <id> --force",
        ),
        Err(SelectionError::Ambiguous) => util::die(
            "multiple automatic self-update candidates remain; inspect --list and select \
             one explicitly with --from <id>",
        ),
    }
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

fn installed_receipt_path() -> PathBuf {
    host::kungfu_cache_dir()
        .join("shifu")
        .join("installed.meta.env")
}

fn installed_provenance(key: &str) -> String {
    let Ok(text) = fs::read_to_string(installed_receipt_path()) else {
        return String::new();
    };
    let recorded_sha = text
        .lines()
        .filter_map(envfile::parse_line)
        .find(|(name, _)| *name == "KUNGFU_SHIFU_SHA")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    if recorded_sha != own_identity().1 {
        return String::new();
    }
    text.lines()
        .filter_map(envfile::parse_line)
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn write_installed_receipt(binary: &Path, source_root: Option<&Path>) {
    let (version, sha, channel) = identity_parts(binary);
    let parent = binary.parent().unwrap_or_else(|| Path::new(""));
    let branch = source_root
        .map(|root| git_output(root, &["symbolic-ref", "--short", "HEAD"]))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| meta_value(parent, "KUNGFU_ARTIFACT_BRANCH"));
    let repo = source_root
        .map(|root| {
            git_output(root, &["worktree", "list", "--porcelain"])
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
                .unwrap_or("")
                .to_string()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| meta_value(parent, "KUNGFU_ARTIFACT_REPO"));
    let worktree = source_root
        .map(|root| root.display().to_string())
        .unwrap_or_else(|| meta_value(parent, "KUNGFU_ARTIFACT_WORKTREE"));
    let build_path = if source_root.is_some() {
        binary
            .parent()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    } else {
        meta_value(parent, "KUNGFU_ARTIFACT_BUILD_PATH")
    };
    let text = format!(
        "KUNGFU_ARTIFACT_SCHEMA='shifu.local-artifact/v1'\n\
         KUNGFU_SHIFU_VERSION='{}'\n\
         KUNGFU_SHIFU_SHA='{}'\n\
         KUNGFU_SHIFU_CHANNEL='{}'\n\
         KUNGFU_SHIFU_BRANCH='{}'\n\
         KUNGFU_SHIFU_REPO='{}'\n\
         KUNGFU_SHIFU_WORKTREE='{}'\n\
         KUNGFU_SHIFU_BUILD_PATH='{}'\n",
        version,
        sha,
        channel,
        branch.replace('\'', ""),
        repo.replace('\'', ""),
        worktree.replace('\'', ""),
        build_path.replace('\'', "")
    );
    let path = installed_receipt_path();
    let staged = path.with_extension("tmp");
    if fs::write(&staged, text).is_ok() && fs::rename(&staged, &path).is_err() {
        let _ = fs::remove_file(staged);
    }
}

fn write_generation_installed_receipt(generation: &Generation) {
    let text = format!(
        "KUNGFU_ARTIFACT_SCHEMA='shifu.local-artifact/v1'\n\
         KUNGFU_SHIFU_VERSION='{}'\n\
         KUNGFU_SHIFU_SHA='{}'\n\
         KUNGFU_SHIFU_CHANNEL='{}'\n\
         KUNGFU_SHIFU_BRANCH='{}'\n\
         KUNGFU_SHIFU_REPO='{}'\n\
         KUNGFU_SHIFU_WORKTREE='{}'\n\
         KUNGFU_SHIFU_BUILD_PATH='{}'\n",
        generation.version,
        generation.sha,
        generation.channel,
        generation.branch.replace('\'', ""),
        generation.repo.replace('\'', ""),
        generation.worktree.replace('\'', ""),
        generation.build_path.replace('\'', "")
    );
    let path = installed_receipt_path();
    let staged = path.with_extension("tmp");
    if fs::write(&staged, text).is_ok() && fs::rename(&staged, &path).is_err() {
        let _ = fs::remove_file(staged);
    }
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
    branch: String,
    repo: String,
    worktree: String,
    build_path: String,
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
                branch: get("KUNGFU_SHIFU_BRANCH"),
                repo: get("KUNGFU_SHIFU_REPO"),
                worktree: get("KUNGFU_SHIFU_WORKTREE"),
                build_path: get("KUNGFU_SHIFU_BUILD_PATH"),
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
    let branch = installed_provenance("KUNGFU_SHIFU_BRANCH");
    let repo = installed_provenance("KUNGFU_SHIFU_REPO");
    let worktree = installed_provenance("KUNGFU_SHIFU_WORKTREE");
    let build_path = installed_provenance("KUNGFU_SHIFU_BUILD_PATH");
    let slot = generations_dir().join(format!("{:012}-{sha}", epoch_now()));
    let staging = slot.with_extension("tmp");
    let _ = fs::remove_dir_all(&staging);
    let placed = fs::create_dir_all(&staging).is_ok()
        && fs::copy(exe, staging.join(binary_name())).is_ok()
        && fs::write(
            staging.join("meta.env"),
            format!(
                "KUNGFU_SHIFU_VERSION='{version}'\nKUNGFU_SHIFU_SHA='{sha}'\n\
                 KUNGFU_SHIFU_CHANNEL='{channel}'\nKUNGFU_SHIFU_BRANCH='{branch}'\n\
                 KUNGFU_SHIFU_REPO='{repo}'\n\
                 KUNGFU_SHIFU_WORKTREE='{worktree}'\n\
                 KUNGFU_SHIFU_BUILD_PATH='{build_path}'\nKUNGFU_SHIFU_ARCHIVED_AT='{}'\n\
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

fn run_list(root: Option<&Path>, options: &ListOptions) -> ! {
    let (version, sha, channel) = own_identity();
    let installed_branch = installed_provenance("KUNGFU_SHIFU_BRANCH");
    let slots = build_slots();
    let generations = generations();
    if options.json {
        println!("{{");
        println!("  \"schema\": \"shifu.local-artifact-catalog/v1\",");
        println!("  \"product\": \"shifu\",");
        println!("  \"platform\": \"{}\",", json_escape(&host::os_arch()));
        println!("  \"artifacts\": [");
        println!(
            "    {{\"id\":\"installed\",\"kind\":\"shifu-binary\",\"version\":\"{}\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"\",\"builtAt\":\"\",\"state\":\"current\",\"relation\":\"same\",\"automatic\":false,\"rollbackOnly\":false,\"dirty\":null,\"repoPath\":\"\",\"worktreePath\":\"\",\"buildPath\":\"\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"currently installed\"}}{}",
            json_escape(version),
            json_escape(sha),
            json_escape(&installed_branch),
            json_escape(
                &env::current_exe()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            ),
            if slots.is_empty() && generations.is_empty() { "" } else { "," }
        );
        let mut rows = Vec::new();
        for slot in &slots {
            let relation = slot_relation(slot, root);
            let state = state_for(relation, slot.valid, false);
            rows.push(format!(
                "    {{\"id\":\"{}\",\"kind\":\"shifu-binary\",\"version\":\"{}\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"\",\"builtAt\":\"{}\",\"state\":\"{}\",\"relation\":\"{}\",\"automatic\":{},\"rollbackOnly\":false,\"dirty\":null,\"repoPath\":\"{}\",\"worktreePath\":\"{}\",\"buildPath\":\"{}\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"{}\"}}",
                json_escape(&slot.id),
                json_escape(&slot.version),
                json_escape(&slot.sha),
                json_escape(&slot.branch),
                json_escape(&slot.built_at),
                state.as_str(),
                relation.as_str(),
                automatic(relation, slot.valid, false),
                json_escape(&slot.repo),
                json_escape(&slot.worktree),
                json_escape(&slot.build_path),
                json_escape(&slot.binary.display().to_string()),
                if slot.valid { relation.as_str() } else { "identity unavailable" }
            ));
        }
        for generation in &generations {
            let relation = generation_relation(generation, root);
            rows.push(format!(
                "    {{\"id\":\"{}\",\"kind\":\"shifu-binary\",\"version\":\"{}\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"\",\"builtAt\":\"{}\",\"state\":\"rollback\",\"relation\":\"{}\",\"automatic\":false,\"rollbackOnly\":true,\"dirty\":null,\"repoPath\":\"{}\",\"worktreePath\":\"{}\",\"buildPath\":\"{}\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"rollback only\"}}",
                json_escape(
                    &generation
                        .dir
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_default()
                ),
                json_escape(&generation.version),
                json_escape(&generation.sha),
                json_escape(&generation.branch),
                generation.archived_at,
                relation.as_str(),
                json_escape(&generation.repo),
                json_escape(&generation.worktree),
                json_escape(&generation.build_path),
                json_escape(&generation.dir.join(binary_name()).display().to_string())
            ));
        }
        println!("{}", rows.join(",\n"));
        println!("  ]");
        println!("}}");
        std::process::exit(0)
    }
    println!(
        "{} shifu {version} (git {sha}, {channel}) @ {}",
        style::cyan("Installed:"),
        if installed_branch.is_empty() {
            "unknown"
        } else {
            &installed_branch
        }
    );
    if slots.is_empty() {
        println!("{} none", style::cyan("Local artifacts:"));
    } else {
        println!("{}", style::cyan("Local artifacts:"));
        for (index, slot) in slots.iter().enumerate() {
            let relation = slot_relation(slot, root);
            let state = state_for(relation, slot.valid, false);
            let branch = if slot.branch.is_empty() {
                "unknown".to_string()
            } else {
                compact_branch(&slot.branch, options.no_truncate)
            };
            println!(
                "  {} {:10} {:9} {:34} {:10}",
                style::bold(&format!("[{index}]")),
                state.as_str(),
                short_sha(&slot.sha),
                branch,
                relation.as_str()
            );
            if options.verbose {
                println!(
                    "      id={} built={} channel={}\n      artifact={}\n      repo={}\n      worktree={}\n      build={}",
                    slot.id,
                    if slot.built_at.is_empty() { "unknown" } else { &slot.built_at },
                    slot.channel,
                    slot.binary.display(),
                    if slot.repo.is_empty() { "unknown" } else { &slot.repo },
                    if slot.worktree.is_empty() { "unknown" } else { &slot.worktree },
                    if slot.build_path.is_empty() { "unknown" } else { &slot.build_path }
                );
            }
        }
    }
    if generations.is_empty() {
        println!("{} none yet", style::cyan("Generations:"));
    } else {
        println!("{}", style::cyan("Generations (newest first):"));
        for (index, generation) in generations.iter().enumerate() {
            println!(
                "  [{index}] rollback   {:9} {:34} {:10} {}",
                short_sha(&generation.sha),
                compact_branch(
                    if generation.branch.is_empty() {
                        "unknown"
                    } else {
                        &generation.branch
                    },
                    options.no_truncate
                ),
                generation_relation(generation, root).as_str(),
                style::dim(&age(generation.archived_at)),
            );
            if options.verbose {
                println!(
                    "      shifu {} ({})\n      artifact={}\n      repo={}\n      worktree={}\n      build={}",
                    generation.version,
                    generation.channel,
                    generation.dir.join(binary_name()).display(),
                    if generation.repo.is_empty() {
                        "unknown"
                    } else {
                        &generation.repo
                    },
                    if generation.worktree.is_empty() {
                        "unknown"
                    } else {
                        &generation.worktree
                    },
                    if generation.build_path.is_empty() {
                        "unknown"
                    } else {
                        &generation.build_path
                    }
                );
            }
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
    write_generation_installed_receipt(&generation);
    let relation = if generation.sha == own_identity().1 {
        GitRelation::Same
    } else {
        generation_relation(&generation, None)
    };
    if let Err(error) = write_promotion_receipt(
        &host::kungfu_cache_dir().join("shifu"),
        "shifu",
        "rollback",
        &generation
            .dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        own_identity().1,
        &generation.sha,
        relation,
    ) {
        eprintln!(
            "   {}",
            style::yellow(&format!("could not write rollback receipt: {error}"))
        );
    }
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
