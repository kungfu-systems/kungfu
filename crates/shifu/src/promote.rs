// SPDX-License-Identifier: Apache-2.0
//
// `shifu promote` / `shifu builds` — inspect and install provenance-qualified
// dev Kungfu artifacts from any terminal.
//
// Builds happen in worktrees, and worktrees are temporary: the launcher
// therefore stashes each successful build user-globally as declared by the
// repo's KFD-3 registry (crates/shifu/src/registrar.rs), and these verbs
// consume that stash — the directory IS the registry:
//
//   ${XDG_CACHE_HOME:-~/.cache}/kungfu/product/<os>-<arch>/<utc-ts>-<sha>/
//     meta.env      KEY='VALUE' lines (build-local.env shape)
//     <artifact>    unpacked .app (mac) / nsis installer (win) / AppImage
//
// Slot timestamps are display provenance, never version authority. `builds`
// classifies every entry against the installed receipt; `promote` advances
// only to one unique Git descendant and retires proven ancestors afterward.
// Divergent/unknown entries remain manual-only. Configuration rides the
// existing KUNGFU_PRODUCT_INSTALL_DIR surface.

use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(not(windows))]
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use shifu_core::{bootstrap, host, json, style};

use crate::artifact_catalog::{
    adopted_build_meta, adopted_installed_receipt, adopted_result, automatic, compact_branch,
    git_relation, json_escape, product_mainline_ref, select_unique_automatic, short_sha, state_for,
    write_promotion_receipt, GitRelation, InstalledAdoption, SelectionError,
    CURRENT_REGISTRATION_RELATIVE,
};
use crate::native_update::{artifact_sha256, local_artifact_identity_valid};
use crate::{envfile, native_update, util};

#[path = "promote_catalog.rs"]
mod promote_catalog;
#[path = "promote_convergence.rs"]
mod promote_convergence;
#[path = "promote_desktop.rs"]
mod promote_desktop;
#[path = "promote_desktop_fs.rs"]
mod promote_desktop_fs;
use promote_desktop::*;
use promote_desktop_fs::DesktopCommit;

struct BuildEntry {
    slot: PathBuf,
    name: String,
    sha: String,
    branch: String,
    repo: String,
    worktree: String,
    built_at: String,
    kind: String,
    artifact: String,
    digest: String,
    cli_archive: String,
    cli_archive_digest: String,
    upgrade_manifest: String,
    upgrade_manifest_digest: String,
    product_version: String,
    release_cut_root: String,
    platform_slice_root: String,
    mainline_ref: String,
    mainline_sha: String,
    integrated: bool,
    qualified: bool,
}

#[derive(Default)]
struct ListOptions {
    verbose: bool,
    json: bool,
    no_truncate: bool,
    verify_current: bool,
}

fn registry_dir() -> PathBuf {
    host::kungfu_cache_dir()
        .join("product")
        .join(host::os_arch())
}

fn read_meta(slot: &Path) -> Option<Vec<(String, String)>> {
    read_env(&slot.join("meta.env"))
}

fn read_env(path: &Path) -> Option<Vec<(String, String)>> {
    let text = fs::read_to_string(path).ok()?;
    Some(
        text.lines()
            .filter_map(envfile::parse_line)
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

fn entry_from_slot(slot: PathBuf, name: String) -> Option<BuildEntry> {
    let meta = read_meta(&slot)?;
    let artifact = meta_get(&meta, "KUNGFU_BUILD_ARTIFACT");
    if artifact.is_empty() || !slot.join(&artifact).exists() {
        return None;
    }
    Some(BuildEntry {
        sha: meta_get(&meta, "KUNGFU_BUILD_SHA"),
        branch: meta_get(&meta, "KUNGFU_BUILD_BRANCH"),
        repo: meta_get(&meta, "KUNGFU_BUILD_REPO"),
        worktree: meta_get(&meta, "KUNGFU_BUILD_WORKTREE"),
        built_at: meta_get(&meta, "KUNGFU_BUILD_TIME"),
        kind: meta_get(&meta, "KUNGFU_BUILD_KIND"),
        digest: meta_get(&meta, "KUNGFU_BUILD_SHA256"),
        cli_archive: meta_get(&meta, "KUNGFU_BUILD_CLI_ARCHIVE"),
        cli_archive_digest: meta_get(&meta, "KUNGFU_BUILD_CLI_ARCHIVE_SHA256"),
        upgrade_manifest: meta_get(&meta, "KUNGFU_BUILD_UPGRADE_MANIFEST"),
        upgrade_manifest_digest: meta_get(&meta, "KUNGFU_BUILD_UPGRADE_MANIFEST_SHA256"),
        product_version: meta_get(&meta, "KUNGFU_BUILD_PRODUCT_VERSION"),
        release_cut_root: meta_get(&meta, "KUNGFU_BUILD_RELEASE_CUT_ROOT"),
        platform_slice_root: meta_get(&meta, "KUNGFU_BUILD_PLATFORM_SLICE_ROOT"),
        mainline_ref: meta_get(&meta, "KUNGFU_BUILD_MAINLINE_REF"),
        mainline_sha: meta_get(&meta, "KUNGFU_BUILD_MAINLINE_SHA"),
        integrated: meta_get(&meta, "KUNGFU_BUILD_INTEGRATED") == "true",
        qualified: meta_get(&meta, "KUNGFU_BUILD_QUALIFIED") == "true",
        artifact,
        slot,
        name,
    })
}

fn meta_get(meta: &[(String, String)], key: &str) -> String {
    meta.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// All stashed builds, newest first.
fn entries() -> Vec<BuildEntry> {
    let dir = registry_dir();
    let Ok(read) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| !name.contains(".tmp-"))
        .collect();
    names.sort();
    names.reverse();
    names
        .into_iter()
        .filter_map(|name| entry_from_slot(dir.join(&name), name))
        .collect()
}

fn git_head(root: &Path) -> String {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

fn valid_build_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn current_entry_at(
    root: &Path,
    registry: &Path,
    expected_sha: &str,
) -> Result<BuildEntry, String> {
    let pointer_path = root.join(CURRENT_REGISTRATION_RELATIVE);
    let pointer = read_env(&pointer_path).ok_or_else(|| {
        format!(
            "no fresh current-build registration at {}; run the declared product distribution in this checkout first",
            pointer_path.display()
        )
    })?;
    let product = meta_get(&pointer, "SHIFU_REGISTERED_PRODUCT");
    let platform = meta_get(&pointer, "SHIFU_REGISTERED_PLATFORM");
    let build_id = meta_get(&pointer, "SHIFU_REGISTERED_BUILD_ID");
    let build_sha = meta_get(&pointer, "SHIFU_REGISTERED_BUILD_SHA");
    let artifact_digest = meta_get(&pointer, "SHIFU_REGISTERED_ARTIFACT_SHA256");
    if product != "kungfu"
        || platform != host::os_arch()
        || !valid_build_id(&build_id)
        || expected_sha.is_empty()
        || build_sha != expected_sha
    {
        return Err("current-build registration does not bind this product, platform, and exact checkout revision".to_string());
    }
    let entry = entry_from_slot(registry.join(&build_id), build_id.clone()).ok_or_else(|| {
        format!("current-build registration names an unreadable slot: {build_id}")
    })?;
    if entry.sha != build_sha || entry.digest != artifact_digest {
        return Err(format!(
            "current-build registration differs from slot metadata: {build_id}"
        ));
    }
    Ok(entry)
}

fn no_builds_hint() -> ! {
    util::die(&format!(
        "no registered dev builds for {} — run a product build first (./shifu dist, \
         or ./shifu package for the unpacked app); builds register themselves on success",
        host::os_arch()
    ));
}

fn installed_receipt_path() -> PathBuf {
    registry_dir().join("installed.meta.env")
}

fn rollback_receipt_path() -> PathBuf {
    registry_dir().join("rollback.meta.env")
}

fn rollback_target_receipt_path() -> PathBuf {
    registry_dir().join("rollback-target.meta.env")
}

fn installed_sha() -> String {
    let Ok(text) = fs::read_to_string(installed_receipt_path()) else {
        return String::new();
    };
    text.lines()
        .filter_map(envfile::parse_line)
        .find(|(key, _)| *key == "KUNGFU_INSTALLED_SHA")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn installed_value(key: &str) -> String {
    let Ok(text) = fs::read_to_string(installed_receipt_path()) else {
        return String::new();
    };
    text.lines()
        .filter_map(envfile::parse_line)
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn receipt_value(text: &str, key: &str) -> String {
    text.lines()
        .filter_map(envfile::parse_line)
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn set_receipt_value(text: &str, key: &str, value: &str) -> String {
    let prefix = format!("{key}=");
    let mut replaced = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|line| {
            if line.starts_with(&prefix) {
                replaced = true;
                format!("{key}='{}'", value.replace('\'', ""))
            } else {
                line.to_string()
            }
        })
        .collect();
    if !replaced {
        lines.push(format!("{key}='{}'", value.replace('\'', "")));
    }
    format!("{}\n", lines.join("\n"))
}

fn build_relation(entry: &BuildEntry, installed: &str, entry_count: usize) -> GitRelation {
    if installed.is_empty() {
        return if entry_count == 1 {
            GitRelation::Descendant
        } else {
            GitRelation::Unknown
        };
    }
    let worktree = Path::new(&entry.worktree);
    let canonical = Path::new(&entry.repo);
    let root = worktree
        .is_dir()
        .then_some(worktree)
        .or_else(|| canonical.is_dir().then_some(canonical));
    let Some(root) = root else {
        return GitRelation::Unknown;
    };
    git_relation(root, installed, &entry.sha)
}

fn build_valid(entry: &BuildEntry) -> bool {
    build_previewable(entry)
        && entry.integrated
        && entry.qualified
        && entry.sha == entry.mainline_sha
}

/// Deep verification for the artifact produced by the exact current checkout.
/// Pre-integration qualification must prove payload bytes before a branch can
/// be submitted, so mainline admission remains a promotion concern rather than
/// a prerequisite for verifying the current build.
fn current_payload_valid(entry: &BuildEntry) -> bool {
    build_previewable(entry)
}

/// Fast catalog classification from the immutable registration envelope.
/// This deliberately does not read artifact payload bytes. Promotion and
/// `builds --verify-current` call `build_valid` and re-check the selected
/// payload in full before making any safety claim or state change.
fn build_recorded_valid(entry: &BuildEntry) -> bool {
    promote_catalog::recorded_build_valid(entry)
}

fn build_previewable(entry: &BuildEntry) -> bool {
    promote_catalog::previewable_build(entry)
}

fn valid_root(value: &str) -> bool {
    promote_catalog::content_root_valid(value)
}

fn rollback_entry_valid(registry: &Path, build_id: &str, sha: &str) -> bool {
    if build_id.is_empty() || sha.is_empty() {
        return false;
    }
    let slot = registry.join(build_id);
    let Some(meta) = read_meta(&slot) else {
        return false;
    };
    let artifact = meta_get(&meta, "KUNGFU_BUILD_ARTIFACT");
    meta_get(&meta, "KUNGFU_BUILD_SHA") == sha
        && !artifact.is_empty()
        && slot.join(artifact).exists()
}

fn schema_kind(entry: &BuildEntry) -> &str {
    if matches!(entry.kind.as_str(), "app" | "installer" | "appimage") {
        &entry.kind
    } else {
        "unknown"
    }
}

fn select_product_build<'a>(
    entries: &'a [BuildEntry],
    installed: &str,
    selected: Option<&str>,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    if let Some(id) = selected {
        let entry = select_named_build(entries, id);
        if !build_valid(entry) {
            util::die(&format!(
                "build {} is invalid and cannot be promoted even with an override",
                entry.name
            ));
        }
        let relation = build_relation(entry, installed, entries.len());
        if !automatic(relation, build_valid(entry), false) && !allow_nonlinear {
            util::die(&format!(
                "build {} is {} and is manual-only; after review pass \
                 --build {} --allow-nonlinear",
                entry.name,
                relation.as_str(),
                entry.name
            ));
        }
        return entry;
    }
    let dispositions: Vec<_> = entries
        .iter()
        .map(|entry| {
            (
                build_relation(entry, installed, entries.len()),
                build_valid(entry),
                false,
            )
        })
        .collect();
    match select_unique_automatic(&dispositions) {
        Ok(index) => &entries[index],
        Err(SelectionError::None) => util::die(
            "no automatic product candidate: builds are older, divergent, or have unknown \
             provenance; inspect shifu builds and select --build <id> --allow-nonlinear",
        ),
        Err(SelectionError::Ambiguous) => util::die(
            "multiple automatic product candidates remain; inspect shifu builds and select \
             one explicitly with --build <id>",
        ),
    }
}

fn select_named_build<'a>(entries: &'a [BuildEntry], id: &str) -> &'a BuildEntry {
    let matches: Vec<_> = entries
        .iter()
        .filter(|entry| entry.name == id || entry.name.starts_with(id))
        .collect();
    if matches.len() != 1 {
        util::die(&format!(
            "--build {id} matched {} builds; use the exact id from shifu builds",
            matches.len()
        ));
    }
    matches[0]
}

fn select_preview_build<'a>(
    entries: &'a [BuildEntry],
    installed: &str,
    selected: Option<&str>,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    let Some(id) = selected else {
        util::die("--preview requires an explicit --build <id>");
    };
    let entry = select_named_build(entries, id);
    if !build_previewable(entry) {
        util::die(&format!(
            "build {} lacks exact clean product provenance and cannot be previewed",
            entry.name
        ));
    }
    let relation = build_relation(entry, installed, entries.len());
    if !matches!(relation, GitRelation::Same | GitRelation::Descendant) && !allow_nonlinear {
        util::die(&format!(
            "preview build {} is {} and requires --allow-nonlinear after review",
            entry.name,
            relation.as_str()
        ));
    }
    entry
}

/// Select the exact Product built by the current source checkout. This route
/// deliberately verifies product bytes, not remote delivery state: a developer
/// must be able to install and exercise their own exact build before it has
/// been merged or received any external delivery credential.
fn select_current_source_build<'a>(
    entries: &'a [BuildEntry],
    current: &BuildEntry,
    installed: &str,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    let entry = select_named_build(entries, &current.name);
    if !current_payload_valid(entry) {
        util::die(&format!(
            "current source build {} failed exact payload verification",
            entry.name
        ));
    }
    let relation = build_relation(entry, installed, entries.len());
    if !matches!(relation, GitRelation::Same | GitRelation::Descendant) && !allow_nonlinear {
        util::die(&format!(
            "current source build {} is {} and requires --allow-nonlinear after review",
            entry.name,
            relation.as_str()
        ));
    }
    entry
}

fn print_builds_json(entries: &[BuildEntry], payload_verified: bool) {
    let installed = installed_sha();
    println!("{{");
    println!("  \"schema\": \"shifu.local-artifact-catalog/v1\",");
    println!("  \"product\": \"kungfu\",");
    println!("  \"platform\": \"{}\",", json_escape(&host::os_arch()));
    println!("  \"artifacts\": [");
    let rows: Vec<_> = entries
        .iter()
        .map(|entry| {
            let relation = build_relation(entry, &installed, entries.len());
            let valid = if payload_verified {
                current_payload_valid(entry)
            } else {
                build_recorded_valid(entry)
            };
            let state = state_for(relation, valid, false);
            format!(
                "    {{\"id\":\"{}\",\"kind\":\"{}\",\"version\":\"{}\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"{}\",\"releaseCutRoot\":\"{}\",\"platformSliceRoot\":\"{}\",\"cliArchivePath\":\"{}\",\"cliArchiveDigest\":\"{}\",\"upgradeManifestPath\":\"{}\",\"upgradeManifestDigest\":\"{}\",\"builtAt\":\"{}\",\"state\":\"{}\",\"relation\":\"{}\",\"automatic\":{},\"rollbackOnly\":false,\"integrity\":\"{}\",\"dirty\":{},\"qualified\":{},\"integrated\":{},\"mainlineRef\":\"{}\",\"mainlineCommit\":\"{}\",\"repoPath\":\"{}\",\"worktreePath\":\"{}\",\"buildPath\":\"{}\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"{}\"}}",
                json_escape(&entry.name),
                json_escape(schema_kind(entry)),
                json_escape(&entry.product_version),
                json_escape(&entry.sha),
                json_escape(&entry.branch),
                json_escape(&entry.digest),
                json_escape(&entry.release_cut_root),
                json_escape(&entry.platform_slice_root),
                json_escape(&entry.slot.join(&entry.cli_archive).display().to_string()),
                json_escape(&entry.cli_archive_digest),
                json_escape(
                    &entry
                        .slot
                        .join(&entry.upgrade_manifest)
                        .display()
                        .to_string()
                ),
                json_escape(&entry.upgrade_manifest_digest),
                json_escape(&entry.built_at),
                state.as_str(),
                relation.as_str(),
                automatic(relation, valid, false),
                if payload_verified {
                    "verified"
                } else {
                    "recorded"
                },
                entry.sha.ends_with("-dirty"),
                entry.qualified,
                entry.integrated,
                json_escape(&entry.mainline_ref),
                json_escape(&entry.mainline_sha),
                json_escape(&entry.repo),
                json_escape(&entry.worktree),
                json_escape(&entry.worktree),
                json_escape(&entry.slot.join(&entry.artifact).display().to_string()),
                relation.as_str()
            )
        })
        .collect();
    println!("{}", rows.join(",\n"));
    println!("  ]");
    println!("}}");
}

pub fn run_builds(root: Option<&Path>, args: &[String]) -> ! {
    let mut options = ListOptions::default();
    for arg in args {
        match arg.as_str() {
            "--verbose" => options.verbose = true,
            "--json" => options.json = true,
            "--no-truncate" => options.no_truncate = true,
            "--verify-current" => options.verify_current = true,
            _ => util::die(
                "usage: shifu builds [--verbose] [--json] [--no-truncate] [--verify-current]",
            ),
        }
    }
    let entries = if options.verify_current {
        let root =
            root.unwrap_or_else(|| util::die("--verify-current requires a Kungfu source checkout"));
        let expected_sha = git_head(root);
        let entry = current_entry_at(root, &registry_dir(), &expected_sha)
            .unwrap_or_else(|error| util::die(&error));
        if !current_payload_valid(&entry) {
            util::die(&format!(
                "current registered build {} failed exact payload verification",
                entry.name
            ));
        }
        vec![entry]
    } else {
        entries()
    };
    if entries.is_empty() {
        no_builds_hint();
    }
    if options.json {
        print_builds_json(&entries, options.verify_current);
        std::process::exit(0);
    }
    let installed = installed_sha();
    println!(
        "{}",
        style::cyan(&format!(
            "Registered dev builds ({}, newest first):",
            host::os_arch()
        ))
    );
    for (index, entry) in entries.iter().enumerate() {
        let relation = build_relation(entry, &installed, entries.len());
        let valid = if options.verify_current {
            current_payload_valid(entry)
        } else {
            build_recorded_valid(entry)
        };
        let state = state_for(relation, valid, false);
        println!(
            "  {} {:10} {:9} {:34} {:10}",
            style::bold(&format!("[{index}]")),
            state.as_str(),
            short_sha(&entry.sha),
            compact_branch(&entry.branch, options.no_truncate),
            relation.as_str(),
        );
        if options.verbose {
            let worktree_state = if Path::new(&entry.worktree).is_dir() {
                ""
            } else {
                " (worktree cleaned; stash still usable)"
            };
            println!(
                "      id={} built={} kind={} digest={}\n      artifact={}\n      repo={}\n      worktree={}{}",
                entry.name,
                entry.built_at,
                entry.kind,
                if entry.digest.is_empty() {
                    "unknown"
                } else {
                    &entry.digest
                },
                entry.slot.join(&entry.artifact).display(),
                if entry.repo.is_empty() {
                    "unknown"
                } else {
                    &entry.repo
                },
                entry.worktree,
                worktree_state
            );
        }
    }
    println!(
        "\n{} shifu promote installs the unique descendant; use --build <id> for manual selection",
        style::cyan("Next:")
    );
    std::process::exit(0)
}

pub fn run_promote(root: Option<&Path>, args: &[String]) -> ! {
    let mut launch = false;
    let mut force = false;
    let mut check = false;
    let mut rollback = false;
    let mut preview = false;
    let mut adopt_installed = false;
    let mut allow_nonlinear = false;
    let mut build_arg: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--launch" => launch = true,
            "--force" => force = true,
            "--check" => check = true,
            "--rollback" => rollback = true,
            "--preview" => preview = true,
            "--adopt-installed" => adopt_installed = true,
            "--allow-nonlinear" => allow_nonlinear = true,
            "--build" => match iter.next() {
                Some(value) => build_arg = Some(value.clone()),
                None => util::die(PROMOTE_USAGE),
            },
            _ => util::die(PROMOTE_USAGE),
        }
    }

    if adopt_installed
        && (build_arg.is_none() || rollback || preview || allow_nonlinear || launch || force)
    {
        util::die(
            "--adopt-installed requires --build <id>; --check is its only optional companion",
        );
    }
    let mut promotion_lock = if check {
        None
    } else {
        Some(
            acquire_promotion_lock_at(&promotion_lock_path())
                .unwrap_or_else(|error| util::die(&error)),
        )
    };
    let entries = entries();
    resume_pending_transaction(&entries, check);
    if rollback {
        if build_arg.is_some() || allow_nonlinear || preview || force {
            util::die(
                "--rollback identifies the exact retained Product; do not combine it with \
                 --build, --preview, --allow-nonlinear, or --force",
            );
        }
        start_retained_rollback(check, launch);
    }
    if entries.is_empty() {
        no_builds_hint();
    }
    if adopt_installed {
        let build_id = build_arg.as_deref().expect("validated build id");
        let entry = entries
            .iter()
            .find(|candidate| candidate.name == build_id)
            .unwrap_or_else(|| util::die("--adopt-installed build id is not registered"));
        let result = adopt_installed_product(entry, !check).unwrap_or_else(|error| {
            util::die(&format!("installed Product adoption failed: {error}"))
        });
        if let Some(lock) = promotion_lock.take() {
            lock.release().unwrap_or_else(|error| util::die(&error));
        }
        println!("{result}");
        std::process::exit(0);
    }
    let installed = installed_sha();
    let previous_build_id = installed_value("KUNGFU_INSTALLED_BUILD_ID");
    let mut previous_release_cut_root = installed_value("KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    if previous_release_cut_root.is_empty() {
        previous_release_cut_root = native_update::LEGACY_BOOTSTRAP_ROOT.to_string();
    }
    let entry = if preview {
        if !rollback_entry_valid(&registry_dir(), &previous_build_id, &installed) {
            util::die(
                "installed Product has no verified rollback coordinate; refusing dogfood promotion",
            );
        }
        select_preview_build(&entries, &installed, build_arg.as_deref(), allow_nonlinear)
    } else if let Some(root) = root {
        let pointer_path = root.join(CURRENT_REGISTRATION_RELATIVE);
        if pointer_path.is_file() {
            let expected_sha = git_head(root);
            let current = current_entry_at(root, &registry_dir(), &expected_sha)
                .unwrap_or_else(|error| util::die(&error));
            select_current_source_build(&entries, &current, &installed, allow_nonlinear)
        } else {
            if !rollback_entry_valid(&registry_dir(), &previous_build_id, &installed) {
                util::die(
                    "installed Product has no verified rollback coordinate; refusing dogfood promotion",
                );
            }
            select_product_build(&entries, &installed, build_arg.as_deref(), allow_nonlinear)
        }
    } else {
        if !rollback_entry_valid(&registry_dir(), &previous_build_id, &installed) {
            util::die(
                "installed Product has no verified rollback coordinate; refusing dogfood promotion",
            );
        }
        select_product_build(&entries, &installed, build_arg.as_deref(), allow_nonlinear)
    };
    let action = if preview { "preview" } else { "promote" };
    if !preview
        && promote_convergence::try_finish(
            entry,
            &registry_dir(),
            &installed,
            check,
            launch,
            &mut promotion_lock,
        )
        .unwrap_or_else(|error| util::die(&error))
    {
        std::process::exit(0);
    }
    let native_plan = match run_native(entry, false, false) {
        Ok(value) => value,
        Err(error) => {
            promote_convergence::release_lock(&mut promotion_lock)
                .unwrap_or_else(|release_error| util::die(&release_error));
            util::die(&format!("native updater preflight failed: {error}"));
        }
    };
    if check {
        println!(
            "{{\"schema\":\"shifu.local-promotion-plan/v1\",\"ok\":true,\
             \"action\":\"{}\",\
             \"artifactId\":\"{}\",\"sourceCommit\":\"{}\",\"mainlineRef\":\"{}\",\
             \"mainlineCommit\":\"{}\",\"qualified\":{},\"integrated\":{},\
             \"currentCommit\":\"{}\",\"currentReleaseCutRoot\":\"{}\",\
             \"targetReleaseCutRoot\":\"{}\",\"platformSliceRoot\":\"{}\",\
             \"cutTransitionRoot\":\"{}\",\
             \"wouldWrite\":false}}",
            action,
            json_escape(&entry.name),
            json_escape(&entry.sha),
            json_escape(&entry.mainline_ref),
            json_escape(&entry.mainline_sha),
            entry.qualified,
            entry.integrated,
            json_escape(&installed),
            json_escape(&previous_release_cut_root),
            json_escape(&entry.release_cut_root),
            json_escape(&entry.platform_slice_root),
            json_escape(&native_plan.transition_root),
        );
        std::process::exit(0);
    }
    eprintln!(
        "\u{1f94b} {}",
        style::bold(&format!(
            "{} dev build {} ({} @ {})",
            if rollback {
                "rolling back to"
            } else if preview {
                "previewing"
            } else {
                "promoting"
            },
            entry.name,
            entry.sha,
            entry.branch
        ))
    );

    // Persist every phase; keep the desktop backup until both receipts commit.
    write_pending_transaction(&PendingTransaction {
        state: "desktop-commit-pending".to_string(),
        action: action.to_string(),
        artifact_id: entry.name.clone(),
        target_release_cut_root: entry.release_cut_root.clone(),
        cut_transition_root: native_plan.transition_root,
        native_receipt_root: String::new(),
        previous_build_id,
        previous_sha: installed,
        previous_release_cut_root,
        installed_path: String::new(),
        desktop_backup_path: String::new(),
        force,
        launch,
    });
    resume_pending_transaction(&entries, false);
    unreachable!()
}

const PROMOTE_USAGE: &str =
    "usage: shifu promote [--build <id> [--preview] [--allow-nonlinear] | --rollback | --adopt-installed --build <id>] [--check] [--launch] [--force]";

/// Install target: KUNGFU_PRODUCT_INSTALL_DIR > platform default (falling
/// back to a per-user location when the default is not writable).
fn install_dir(default: PathBuf, user_fallback: PathBuf) -> PathBuf {
    if let Ok(configured) = env::var("KUNGFU_PRODUCT_INSTALL_DIR") {
        let configured = configured.trim();
        if !configured.is_empty() {
            return PathBuf::from(configured);
        }
    }
    if dir_writable(&default) {
        return default;
    }
    user_fallback
}

fn commit_desktop(entry: &BuildEntry, force: bool) -> Result<DesktopCommit, String> {
    match entry.kind.as_str() {
        "app" => promote_app(entry, force),
        "installer" => promote_installer(entry),
        "appimage" => promote_appimage(entry),
        other => Err(format!("unknown artifact kind in stash: {other}")),
    }
}

fn retained_backup_path(directory: &Path, name: &str) -> PathBuf {
    let current = installed_value("KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    let identity = current
        .strip_prefix("sha256:")
        .and_then(|value| value.get(..12))
        .unwrap_or("legacy");
    directory.join(format!(".{name}.shifu-previous-{identity}"))
}

fn dir_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".shifu-probe-{}", std::process::id()));
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// macOS: copy the stashed .app over the installed one (rename dance — the
/// old app is only removed after the new copy fully landed next to it).
fn promote_app(entry: &BuildEntry, force: bool) -> Result<DesktopCommit, String> {
    let target_dir = install_dir(
        PathBuf::from("/Applications"),
        host::home_dir().join("Applications"),
    );
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("cannot create {}: {error}", target_dir.display()))?;
    let target = target_dir.join(&entry.artifact);

    if product_running(&entry.artifact) {
        if force {
            eprintln!(
                "   {}",
                style::yellow("app is running; replacing anyway (--force)")
            );
        } else {
            return Err(format!(
                "{} is running — quit it first, or pass --force to replace it anyway",
                entry.artifact
            ));
        }
    }

    let source = entry.slot.join(&entry.artifact);
    let staged = target_dir.join(format!(".{}.shifu-next", entry.artifact));
    let backup = retained_backup_path(&target_dir, &entry.artifact);
    complete_atomic_target(
        &source,
        &target,
        &backup,
        &staged,
        |from, to| {
            let status = Command::new("ditto").arg(from).arg(to).status();
            match status {
                Ok(result) if result.success() => Ok(()),
                Ok(result) => Err(format!("ditto failed (exit {:?})", result.code())),
                Err(error) => Err(format!("failed to run ditto: {error}")),
            }
        },
        |path| {
            if !product_app_manifests_valid(path, &entry.sha)? {
                return Ok(false);
            }
            tree_exact(&source, path)
        },
    )
}

/// Is the product app currently running? (macOS: match the executable path
/// inside the bundle, the stable signal across renames of the process name.)
fn product_running(app_name: &str) -> bool {
    let pattern = format!("{app_name}/Contents/MacOS/");
    Command::new("pgrep")
        .args(["-f", &pattern])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Windows: the stashed artifact is the self-contained nsis installer; run it
/// silently.
fn promote_installer(entry: &BuildEntry) -> Result<DesktopCommit, String> {
    let source = entry.slot.join(&entry.artifact);
    let retained = registry_dir().join("installed-desktop");
    fs::create_dir_all(&retained)
        .map_err(|error| format!("cannot create {}: {error}", retained.display()))?;
    let installer = retained.join("kungfu-current-installer.exe");
    let backup = retained_backup_path(&retained, "kungfu-current-installer.exe");
    let staged = retained.join(format!(".kungfu-installer-next-{}", std::process::id()));
    let digest = entry.digest.clone();
    let desktop = complete_atomic_target(
        &source,
        &installer,
        &backup,
        &staged,
        |from, to| {
            fs::copy(from, to)
                .map(|_| ())
                .map_err(|error| format!("cannot retain Windows installer: {error}"))
        },
        |candidate| {
            if !regular_file(candidate)? {
                return Ok(false);
            }
            artifact_sha256(candidate).map(|value| value == digest)
        },
    )?;
    eprintln!(
        "   {}",
        style::dim("running the nsis installer silently (/S)")
    );
    let status = Command::new(&installer).arg("/S").status();
    match status {
        Ok(result) if result.success() => Ok(desktop),
        Ok(result) => Err(format!("installer failed (exit {:?})", result.code())),
        Err(error) => Err(format!("failed to run the installer: {error}")),
    }
}

/// Linux: place the AppImage on the user's PATH under a stable name.
fn promote_appimage(entry: &BuildEntry) -> Result<DesktopCommit, String> {
    let target_dir = install_dir(
        host::home_dir().join(".local").join("bin"),
        host::home_dir().join(".local").join("bin"),
    );
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("cannot create {}: {error}", target_dir.display()))?;
    let target = target_dir.join("kungfu-dev.AppImage");
    let source = entry.slot.join(&entry.artifact);
    let staged = target_dir.join(".kungfu-dev.AppImage.shifu-next");
    let backup = retained_backup_path(&target_dir, "kungfu-dev.AppImage");
    let source_digest = bootstrap::sha256_file(&source)
        .map_err(|error| format!("cannot hash {}: {error}", source.display()))?;
    complete_atomic_target(
        &source,
        &target,
        &backup,
        &staged,
        |from, to| {
            fs::copy(from, to)
                .map(|_| ())
                .map_err(|error| format!("cannot stage {}: {error}", to.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(to, fs::Permissions::from_mode(0o755))
                    .map_err(|error| format!("cannot make staged AppImage executable: {error}"))?;
            }
            Ok(())
        },
        |path| {
            if !regular_file(path)? {
                return Ok(false);
            }
            bootstrap::sha256_file(path)
                .map(|digest| digest == source_digest)
                .map_err(|error| format!("cannot verify {}: {error}", path.display()))
        },
    )
}

#[cfg(windows)]
fn launch_product(installed: &Path) {
    // The stashed artifact is the installer, not the installed app; launching
    // it again would rerun the install.
    let _ = installed;
    eprintln!(
        "   {}",
        style::dim("installed - launch Kungfu from the Start Menu")
    );
}

#[cfg(not(windows))]
fn launch_product(installed: &Path) {
    #[cfg(target_os = "macos")]
    let launched = Command::new("open").arg(installed).status().map(|_| ());
    #[cfg(not(target_os = "macos"))]
    // Detached on purpose: promote returns, the product keeps running.
    let launched = Command::new(installed).spawn().map(|_| ());
    match launched {
        Ok(()) => eprintln!("   {}", style::dim("launched")),
        Err(e) => eprintln!(
            "   {}",
            style::yellow(&format!("promoted, but launching failed: {e}"))
        ),
    }
}

fn inspect_installed_adoption_at(
    entry: &BuildEntry,
    registry: &Path,
    target_dir: &Path,
) -> Result<InstalledAdoption, String> {
    if entry.kind != "app" {
        return Err("installed adoption currently requires a macOS app candidate".to_string());
    }
    if registry.join("installed.meta.env").exists() {
        return Err("installed Product already has a Shifu receipt".to_string());
    }
    let app = target_dir.join(&entry.artifact);
    let resources = app.join("Contents/Resources");
    let build = read_document(&resources.join("kungfu/kungfubuildinfo.json"))?
        .ok_or_else(|| "installed Product has no build identity".to_string())?;
    let release = read_document(&resources.join("upgrade/kungfu-release-manifest.json"))?
        .ok_or_else(|| "installed Product has no release manifest".to_string())?;
    let source_commit = build
        .get("git")
        .map(|git| git.str_of("revision").to_string())
        .unwrap_or_default();
    if source_commit.len() != 40
        || !source_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        || release.str_of("sourceCommit") != source_commit
        || !product_app_manifests_valid(&app, &source_commit)?
    {
        return Err("installed Product manifests do not bind one exact source commit".to_string());
    }
    let product_version = release.str_of("productVersion").to_string();
    let desktop_release_cut_root = release.str_of("releaseCutRoot").to_string();
    let desktop_platform_slice_root = release.str_of("platformSliceRoot").to_string();
    if product_version.is_empty()
        || !valid_root(&desktop_release_cut_root)
        || !valid_root(&desktop_platform_slice_root)
        || release
            .get("releaseCut")
            .and_then(|cut| cut.get("publicationPolicy"))
            .map(|policy| policy.str_of("trustDomain"))
            != Some("shifu-local")
    {
        return Err("installed Product release manifest has no exact local Cut".to_string());
    }
    let native_updater = resources.join("kungfu/kungfu");
    if !native_updater.is_file() {
        return Err("installed Product has no native updater".to_string());
    }
    let output = Command::new(&native_updater)
        .args(["update", "status", "--json"])
        .output()
        .map_err(|error| format!("cannot inspect installed native inventory: {error}"))?;
    if !output.status.success() {
        return Err("installed native inventory status failed".to_string());
    }
    let status = json::parse(&String::from_utf8_lossy(&output.stdout))
        .map_err(|error| format!("installed native inventory returned invalid JSON: {error}"))?;
    let selected = status
        .get("frontendInventory")
        .and_then(|inventory| inventory.get("selected"))
        .ok_or_else(|| "installed native inventory has no selected image".to_string())?;
    let release_cut_root = selected.str_of("releaseCutRoot").to_string();
    let platform_slice_root = selected.str_of("platformSliceRoot").to_string();
    let native_receipt_root = status.str_of("nativeReceiptRoot").to_string();
    let native_manifest_path =
        PathBuf::from(selected.str_of("productRoot")).join("upgrade/kungfu-release-manifest.json");
    let native_manifest = read_document(&native_manifest_path)?
        .ok_or_else(|| "selected native image has no release manifest".to_string())?;
    if !valid_root(&release_cut_root)
        || !valid_root(&platform_slice_root)
        || !valid_root(&native_receipt_root)
        || native_manifest.str_of("sourceCommit") != source_commit
        || native_manifest.str_of("productVersion") != product_version
        || native_manifest.str_of("releaseCutRoot") != release_cut_root
        || native_manifest.str_of("platformSliceRoot") != platform_slice_root
        || native_manifest
            .get("releaseCut")
            .and_then(|cut| cut.get("publicationPolicy"))
            .map(|policy| policy.str_of("trustDomain"))
            != Some("shifu-local")
    {
        return Err(
            "installed desktop and native inventory do not share one exact source identity"
                .to_string(),
        );
    }
    let artifact_digest = artifact_sha256(&app)?;
    let build_id = format!(
        "adopted-{}-{}",
        &source_commit[..12],
        &artifact_digest[..12]
    );
    Ok(InstalledAdoption {
        app,
        artifact: entry.artifact.clone(),
        build_id,
        source_commit,
        artifact_digest,
        product_version,
        release_cut_root,
        platform_slice_root,
        native_receipt_root,
        native_updater_digest: artifact_sha256(&native_updater)?,
        native_updater,
    })
}

fn adopt_installed_product_at(
    entry: &BuildEntry,
    execute: bool,
    registry: &Path,
    target_dir: &Path,
) -> Result<String, String> {
    let adoption = inspect_installed_adoption_at(entry, registry, target_dir)?;
    if execute {
        fs::create_dir_all(registry)
            .map_err(|error| format!("cannot create Product registry: {error}"))?;
        let slot = registry.join(&adoption.build_id);
        if slot.exists() {
            let snapshot = slot.join(&adoption.artifact);
            let expected_meta = adopted_build_meta(&adoption);
            if fs::read_to_string(slot.join("meta.env")).ok().as_deref()
                != Some(expected_meta.as_str())
                || !tree_exact(&adoption.app, &snapshot)?
                || artifact_sha256(&snapshot)? != adoption.artifact_digest
            {
                return Err("installed adoption coordinate exists with different bytes".to_string());
            }
        } else {
            let staged = registry.join(format!(
                ".{}.tmp-{}-{}",
                adoption.build_id,
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            fs::create_dir_all(&staged)
                .map_err(|error| format!("cannot stage installed adoption: {error}"))?;
            let staged_app = staged.join(&adoption.artifact);
            let copy = Command::new("ditto")
                .arg(&adoption.app)
                .arg(&staged_app)
                .status()
                .map_err(|error| format!("cannot snapshot installed Product: {error}"))?;
            if !copy.success()
                || !tree_exact(&adoption.app, &staged_app)?
                || artifact_sha256(&staged_app)? != adoption.artifact_digest
            {
                let _ = fs::remove_dir_all(&staged);
                return Err("installed Product snapshot failed exact verification".to_string());
            }
            fs::write(staged.join("meta.env"), adopted_build_meta(&adoption))
                .map_err(|error| format!("cannot stage installed adoption metadata: {error}"))?;
            fs::rename(&staged, &slot)
                .map_err(|error| format!("cannot publish installed adoption slot: {error}"))?;
        }
        write_installed_receipt_at(
            &registry.join("installed.meta.env"),
            &adopted_installed_receipt(&adoption),
        )?;
    }
    Ok(adopted_result(&adoption, execute))
}

fn adopt_installed_product(entry: &BuildEntry, execute: bool) -> Result<String, String> {
    let target_dir = install_dir(
        PathBuf::from("/Applications"),
        host::home_dir().join("Applications"),
    );
    adopt_installed_product_at(entry, execute, &registry_dir(), &target_dir)
}

#[cfg(test)]
#[path = "promote_tests.rs"]
mod tests;
