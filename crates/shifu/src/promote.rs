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
use std::path::{Path, PathBuf};
use std::process::Command;

use shifu_core::{bootstrap, host, json, style};

use crate::artifact_catalog::{
    automatic, compact_branch, git_relation, json_escape, product_mainline_ref,
    select_unique_automatic, short_sha, state_for, write_promotion_receipt, GitRelation,
    SelectionError,
};
use crate::{envfile, native_update, util};

#[path = "promote_desktop.rs"]
mod promote_desktop;
use promote_desktop::{
    complete_atomic_target, product_app_manifests_valid, regular_file, tree_exact, DesktopCommit,
};

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
}

fn registry_dir() -> PathBuf {
    host::kungfu_cache_dir()
        .join("product")
        .join(host::os_arch())
}

fn read_meta(slot: &Path) -> Option<Vec<(String, String)>> {
    let text = fs::read_to_string(slot.join("meta.env")).ok()?;
    Some(
        text.lines()
            .filter_map(envfile::parse_line)
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
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
        .filter_map(|name| {
            let slot = dir.join(&name);
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
        })
        .collect()
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

fn build_previewable(entry: &BuildEntry) -> bool {
    !entry.sha.is_empty()
        && entry.sha != "unknown"
        && !entry.sha.ends_with("-dirty")
        && matches!(entry.kind.as_str(), "app" | "installer" | "appimage")
        && entry.slot.join(&entry.artifact).exists()
        && !entry.cli_archive.is_empty()
        && valid_root(&entry.cli_archive_digest)
        && entry.slot.join(&entry.cli_archive).is_file()
        && !entry.upgrade_manifest.is_empty()
        && valid_root(&entry.upgrade_manifest_digest)
        && entry.slot.join(&entry.upgrade_manifest).is_file()
        && !entry.product_version.is_empty()
        && valid_root(&entry.release_cut_root)
        && valid_root(&entry.platform_slice_root)
        && entry.mainline_ref == product_mainline_ref()
        && product_manifests_valid(entry)
}

fn valid_root(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn product_manifests_valid(entry: &BuildEntry) -> bool {
    if entry.kind != "app" {
        return true;
    }
    product_app_manifests_valid(&entry.slot.join(&entry.artifact), &entry.sha).unwrap_or(false)
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

fn rollback_build<'a>(
    entries: &'a [BuildEntry],
    build_id: &str,
    sha: &str,
) -> Option<&'a BuildEntry> {
    entries
        .iter()
        .find(|entry| entry.name == build_id && entry.sha == sha)
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

fn print_builds_json(entries: &[BuildEntry]) {
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
            let valid = build_valid(entry);
            let state = state_for(relation, valid, false);
            format!(
                "    {{\"id\":\"{}\",\"kind\":\"{}\",\"version\":\"{}\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"{}\",\"releaseCutRoot\":\"{}\",\"platformSliceRoot\":\"{}\",\"cliArchivePath\":\"{}\",\"cliArchiveDigest\":\"{}\",\"upgradeManifestPath\":\"{}\",\"upgradeManifestDigest\":\"{}\",\"builtAt\":\"{}\",\"state\":\"{}\",\"relation\":\"{}\",\"automatic\":{},\"rollbackOnly\":false,\"dirty\":{},\"qualified\":{},\"integrated\":{},\"mainlineRef\":\"{}\",\"mainlineCommit\":\"{}\",\"repoPath\":\"{}\",\"worktreePath\":\"{}\",\"buildPath\":\"{}\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"{}\"}}",
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

struct InstalledReceiptContext<'a> {
    rollback_build_id: &'a str,
    rollback_sha: &'a str,
    rollback_release_cut_root: &'a str,
    cut_transition_root: &'a str,
    native_receipt_root: &'a str,
    native_updater: &'a Path,
    mode: &'a str,
}

fn write_installed_receipt(
    entry: &BuildEntry,
    installed: &Path,
    context: &InstalledReceiptContext<'_>,
) -> Result<(), String> {
    let text = format!(
        "KUNGFU_ARTIFACT_SCHEMA='shifu.local-artifact/v1'\n\
         KUNGFU_INSTALLED_SHA='{}'\n\
         KUNGFU_INSTALLED_BRANCH='{}'\n\
         KUNGFU_INSTALLED_REPO='{}'\n\
         KUNGFU_INSTALLED_BUILD_ID='{}'\n\
         KUNGFU_INSTALLED_WORKTREE='{}'\n\
         KUNGFU_INSTALLED_ARTIFACT='{}'\n\
         KUNGFU_INSTALLED_DIGEST='{}'\n\
         KUNGFU_INSTALLED_MAINLINE_REF='{}'\n\
         KUNGFU_INSTALLED_MAINLINE_SHA='{}'\n\
         KUNGFU_INSTALLED_INTEGRATED='{}'\n\
         KUNGFU_INSTALLED_QUALIFIED='{}'\n\
         KUNGFU_INSTALLED_MODE='{}'\n\
         KUNGFU_INSTALLED_PRODUCT_VERSION='{}'\n\
         KUNGFU_INSTALLED_RELEASE_CUT_ROOT='{}'\n\
         KUNGFU_INSTALLED_PLATFORM_SLICE_ROOT='{}'\n\
         KUNGFU_INSTALLED_CUT_TRANSITION_ROOT='{}'\n\
         KUNGFU_INSTALLED_NATIVE_RECEIPT_ROOT='{}'\n\
         KUNGFU_INSTALLED_NATIVE_UPDATER='{}'\n\
         KUNGFU_ROLLBACK_BUILD_ID='{}'\n\
         KUNGFU_ROLLBACK_SHA='{}'\n\
         KUNGFU_ROLLBACK_RELEASE_CUT_ROOT='{}'\n",
        entry.sha,
        entry.branch.replace('\'', ""),
        entry.repo.replace('\'', ""),
        entry.name,
        entry.worktree.replace('\'', ""),
        installed.display(),
        entry.digest,
        entry.mainline_ref,
        entry.mainline_sha,
        entry.integrated,
        entry.qualified,
        context.mode,
        entry.product_version,
        entry.release_cut_root,
        entry.platform_slice_root,
        context.cut_transition_root,
        context.native_receipt_root,
        context.native_updater.display(),
        context.rollback_build_id,
        context.rollback_sha,
        context.rollback_release_cut_root,
    );
    write_installed_receipt_at(&installed_receipt_path(), &text)
}

fn write_installed_receipt_at(path: &Path, text: &str) -> Result<(), String> {
    let staged = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&staged, text)
        .and_then(|()| fs::rename(&staged, path))
        .map_err(|error| {
            let _ = fs::remove_file(&staged);
            format!("cannot persist installed promotion receipt: {error}")
        })
}

fn native_target(entry: &BuildEntry) -> native_update::ApplyTarget<'_> {
    native_update::ApplyTarget {
        kind: &entry.kind,
        slot: &entry.slot,
        artifact: &entry.artifact,
        manifest: &entry.upgrade_manifest,
        archive: &entry.cli_archive,
        archive_digest: &entry.cli_archive_digest,
        manifest_digest: &entry.upgrade_manifest_digest,
        product_version: &entry.product_version,
        release_cut_root: &entry.release_cut_root,
    }
}

fn run_native(
    entry: &BuildEntry,
    rollback: bool,
    execute: bool,
) -> Result<native_update::NativeUpdateResult, String> {
    let current_cut = installed_value("KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    let current_version = installed_value("KUNGFU_INSTALLED_PRODUCT_VERSION");
    let target = native_target(entry);
    if rollback {
        let rollback_cut = installed_value("KUNGFU_ROLLBACK_RELEASE_CUT_ROOT");
        let updater = native_update::updater(&target).ok_or_else(|| {
            "native Kungfu updater is unavailable; set KUNGFU_NATIVE_UPDATER to one exact shipped kungfu executable".to_string()
        })?;
        native_update::rollback(&updater, &current_cut, &rollback_cut, execute)
    } else {
        native_update::apply(&target, &current_cut, &current_version, execute)
    }
}

fn pending_transaction_path() -> PathBuf {
    registry_dir().join("promotion-pending.json")
}

struct PendingTransaction {
    state: String,
    action: String,
    artifact_id: String,
    target_release_cut_root: String,
    cut_transition_root: String,
    native_receipt_root: String,
    previous_build_id: String,
    previous_sha: String,
    previous_release_cut_root: String,
    installed_path: String,
    desktop_backup_path: String,
    force: bool,
    launch: bool,
}

fn write_pending_transaction(pending: &PendingTransaction) {
    let path = pending_transaction_path();
    write_pending_transaction_at(&path, pending).unwrap_or_else(|error| {
        util::die(&format!(
            "cannot retain pending promotion transaction: {error}"
        ))
    });
}

fn write_pending_transaction_at(path: &Path, pending: &PendingTransaction) -> Result<(), String> {
    let staged = path.with_extension("tmp");
    let value = format!(
        "{{\"schema\":\"shifu.local-promotion-transaction/v1\",\
         \"state\":\"{}\",\"action\":\"{}\",\"artifactId\":\"{}\",\
         \"targetReleaseCutRoot\":\"{}\",\
         \"cutTransitionRoot\":\"{}\",\"nativeReceiptRoot\":\"{}\",\
         \"previousBuildId\":\"{}\",\"previousSha\":\"{}\",\
         \"previousReleaseCutRoot\":\"{}\",\"installedPath\":\"{}\",\
         \"desktopBackupPath\":\"{}\",\"force\":\"{}\",\"launch\":\"{}\"}}\n",
        json_escape(&pending.state),
        json_escape(&pending.action),
        json_escape(&pending.artifact_id),
        json_escape(&pending.target_release_cut_root),
        json_escape(&pending.cut_transition_root),
        json_escape(&pending.native_receipt_root),
        json_escape(&pending.previous_build_id),
        json_escape(&pending.previous_sha),
        json_escape(&pending.previous_release_cut_root),
        json_escape(&pending.installed_path),
        json_escape(&pending.desktop_backup_path),
        pending.force,
        pending.launch,
    );
    fs::write(&staged, value)
        .and_then(|()| fs::rename(&staged, path))
        .map_err(|error| {
            let _ = fs::remove_file(&staged);
            error.to_string()
        })
}

fn read_pending_transaction() -> Result<Option<PendingTransaction>, String> {
    read_pending_transaction_at(&pending_transaction_path())
}

fn read_pending_transaction_at(path: &Path) -> Result<Option<PendingTransaction>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cannot read pending promotion transaction {}: {error}",
                path.display()
            ))
        }
    };
    let value = json::parse(&text)
        .map_err(|error| format!("pending promotion transaction is invalid: {error}"))?;
    if value.str_of("schema") != "shifu.local-promotion-transaction/v1" {
        return Err("pending promotion transaction schema is unsupported".to_string());
    }
    let required = |field: &str| -> Result<String, String> {
        let item = value.str_of(field);
        if item.is_empty() {
            Err(format!("pending promotion transaction has no {field}"))
        } else {
            Ok(item.to_string())
        }
    };
    Ok(Some(PendingTransaction {
        state: required("state")?,
        action: required("action")?,
        artifact_id: required("artifactId")?,
        target_release_cut_root: required("targetReleaseCutRoot")?,
        cut_transition_root: required("cutTransitionRoot")?,
        native_receipt_root: value.str_of("nativeReceiptRoot").to_string(),
        previous_build_id: value.str_of("previousBuildId").to_string(),
        previous_sha: value.str_of("previousSha").to_string(),
        previous_release_cut_root: value.str_of("previousReleaseCutRoot").to_string(),
        installed_path: value.str_of("installedPath").to_string(),
        desktop_backup_path: value.str_of("desktopBackupPath").to_string(),
        force: value.str_of("force") == "true",
        launch: value.str_of("launch") == "true",
    }))
}

fn advance_desktop_phase_at<Commit>(
    pending: &mut PendingTransaction,
    entry: &BuildEntry,
    marker_path: &Path,
    commit: Commit,
) -> Result<(), String>
where
    Commit: FnOnce(&BuildEntry, bool) -> Result<DesktopCommit, String>,
{
    if pending.state != "desktop-commit-pending" {
        return Ok(());
    }
    let desktop = commit(entry, pending.force)?;
    pending.installed_path = desktop.installed.display().to_string();
    pending.desktop_backup_path = desktop
        .backup
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    pending.state = "native-commit-pending".to_string();
    write_pending_transaction_at(marker_path, pending)
        .map_err(|error| format!("cannot retain committed desktop phase: {error}"))
}

fn finish_pending_transaction(
    entries: &[BuildEntry],
    entry: &BuildEntry,
    pending: &PendingTransaction,
    updater: &Path,
) -> ! {
    let installed = PathBuf::from(&pending.installed_path);
    if !installed.exists()
        || !valid_root(&pending.cut_transition_root)
        || !valid_root(&pending.native_receipt_root)
    {
        util::die("pending promotion transaction has incomplete desktop or native evidence");
    }
    let relation = build_relation(entry, &pending.previous_sha, entries.len());
    let installed_mode = if build_valid(entry) {
        "qualified"
    } else {
        "preview"
    };
    write_installed_receipt(
        entry,
        &installed,
        &InstalledReceiptContext {
            rollback_build_id: &pending.previous_build_id,
            rollback_sha: &pending.previous_sha,
            rollback_release_cut_root: &pending.previous_release_cut_root,
            cut_transition_root: &pending.cut_transition_root,
            native_receipt_root: &pending.native_receipt_root,
            native_updater: updater,
            mode: installed_mode,
        },
    )
    .unwrap_or_else(|error| {
        util::die(&format!(
            "{error}; exact promotion transaction and desktop backup remain pending"
        ))
    });
    write_promotion_receipt(
        &registry_dir(),
        "kungfu",
        &pending.action,
        &entry.name,
        &pending.previous_sha,
        &entry.sha,
        relation,
    )
    .unwrap_or_else(|error| {
        util::die(&format!(
            "cannot finalize pending Shifu promotion receipt: {error}"
        ))
    });
    DesktopCommit {
        installed: installed.clone(),
        backup: (!pending.desktop_backup_path.is_empty())
            .then(|| PathBuf::from(&pending.desktop_backup_path)),
    }
    .finish_backup()
    .unwrap_or_else(|error| util::die(&error));
    fs::remove_file(pending_transaction_path()).unwrap_or_else(|error| {
        util::die(&format!(
            "promotion completed but pending transaction could not be cleared: {error}"
        ))
    });
    eprintln!(
        "\u{2705} {} {}",
        style::green(match pending.action.as_str() {
            "rollback" => "rolled back",
            "preview" => "previewed",
            _ => "promoted",
        }),
        style::bold(&installed.display().to_string())
    );
    if pending.launch {
        launch_product(&installed);
    }
    std::process::exit(0)
}

fn resume_pending_transaction(entries: &[BuildEntry], check: bool) {
    let Some(mut pending) = read_pending_transaction().unwrap_or_else(|error| util::die(&error))
    else {
        return;
    };
    if check {
        util::die(&format!(
            "promotion transaction {} is pending for {}; rerun promote without --check to resume",
            pending.state, pending.artifact_id
        ));
    }
    let entry = entries
        .iter()
        .find(|candidate| {
            candidate.name == pending.artifact_id
                && candidate.release_cut_root == pending.target_release_cut_root
        })
        .unwrap_or_else(|| {
            util::die("pending promotion target is absent or its Release Cut coordinate changed")
        });
    let marker_path = pending_transaction_path();
    advance_desktop_phase_at(&mut pending, entry, &marker_path, commit_desktop).unwrap_or_else(
        |error| {
            util::die(&format!(
                "desktop promotion remains recoverable and pending: {error}"
            ))
        },
    );
    let target = native_target(entry);
    let updater = native_update::updater(&target).unwrap_or_else(|| {
        util::die("native Kungfu updater is unavailable while resuming promotion")
    });
    if pending.state == "native-commit-pending" {
        let selected =
            native_update::selected_release_cut(&updater).unwrap_or_else(|error| util::die(&error));
        if selected.release_cut_root == pending.target_release_cut_root {
            pending.native_receipt_root = selected.evidence_root;
        } else {
            let native =
                run_native(entry, pending.action == "rollback", true).unwrap_or_else(|error| {
                    util::die(&format!(
                        "native updater resume failed; exact transaction remains pending: {error}"
                    ))
                });
            pending.cut_transition_root = native.transition_root;
            pending.native_receipt_root = native.receipt_root;
        }
        pending.state = "receipt-commit-pending".to_string();
        write_pending_transaction(&pending);
    }
    if pending.state != "receipt-commit-pending" {
        util::die("pending promotion transaction state is unsupported");
    }
    let selected =
        native_update::selected_release_cut(&updater).unwrap_or_else(|error| util::die(&error));
    if selected.release_cut_root != pending.target_release_cut_root {
        util::die("native selection does not match the pending promotion target");
    }
    if pending.native_receipt_root.is_empty() {
        pending.native_receipt_root = selected.evidence_root;
        write_pending_transaction(&pending);
    }
    finish_pending_transaction(entries, entry, &pending, &updater)
}

pub fn run_builds(args: &[String]) -> ! {
    let mut options = ListOptions::default();
    for arg in args {
        match arg.as_str() {
            "--verbose" => options.verbose = true,
            "--json" => options.json = true,
            "--no-truncate" => options.no_truncate = true,
            _ => util::die("usage: shifu builds [--verbose] [--json] [--no-truncate]"),
        }
    }
    let entries = entries();
    if entries.is_empty() {
        no_builds_hint();
    }
    if options.json {
        print_builds_json(&entries);
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
        let state = state_for(relation, build_valid(entry), false);
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

pub fn run_promote(args: &[String]) -> ! {
    let mut launch = false;
    let mut force = false;
    let mut check = false;
    let mut rollback = false;
    let mut preview = false;
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
            "--allow-nonlinear" => allow_nonlinear = true,
            "--build" => match iter.next() {
                Some(value) => build_arg = Some(value.clone()),
                None => util::die(PROMOTE_USAGE),
            },
            _ => util::die(PROMOTE_USAGE),
        }
    }

    let entries = entries();
    if entries.is_empty() {
        no_builds_hint();
    }
    resume_pending_transaction(&entries, check);
    let installed = installed_sha();
    let previous_build_id = installed_value("KUNGFU_INSTALLED_BUILD_ID");
    let previous_release_cut_root = installed_value("KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    let rollback_build_id = installed_value("KUNGFU_ROLLBACK_BUILD_ID");
    let rollback_sha = installed_value("KUNGFU_ROLLBACK_SHA");
    if rollback && (build_arg.is_some() || allow_nonlinear || preview) {
        util::die(
            "--rollback identifies the exact retained Product; do not combine it with \
             --build, --preview, or --allow-nonlinear",
        );
    }
    let entry = if rollback {
        if !rollback_entry_valid(&registry_dir(), &rollback_build_id, &rollback_sha) {
            util::die("installed Product has no verified rollback coordinate");
        }
        rollback_build(&entries, &rollback_build_id, &rollback_sha).unwrap_or_else(|| {
            util::die("verified rollback Product is absent from the local registry")
        })
    } else if preview {
        if !rollback_entry_valid(&registry_dir(), &previous_build_id, &installed) {
            util::die(
                "installed Product has no verified rollback coordinate; refusing dogfood promotion",
            );
        }
        select_preview_build(&entries, &installed, build_arg.as_deref(), allow_nonlinear)
    } else {
        if !rollback_entry_valid(&registry_dir(), &previous_build_id, &installed) {
            util::die(
                "installed Product has no verified rollback coordinate; refusing dogfood promotion",
            );
        }
        select_product_build(&entries, &installed, build_arg.as_deref(), allow_nonlinear)
    };
    let action = if rollback {
        "rollback"
    } else if preview {
        "preview"
    } else {
        "promote"
    };
    let native_plan = run_native(entry, rollback, false)
        .unwrap_or_else(|error| util::die(&format!("native updater preflight failed: {error}")));
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
    "usage: shifu promote [--build <id> [--preview] [--allow-nonlinear] | --rollback] [--check] [--launch] [--force]";

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
    let backup = target_dir.join(format!(".{}.shifu-previous", entry.artifact));
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
    let installer = entry.slot.join(&entry.artifact);
    eprintln!(
        "   {}",
        style::dim("running the nsis installer silently (/S)")
    );
    let status = Command::new(&installer).arg("/S").status();
    match status {
        Ok(result) if result.success() => Ok(DesktopCommit {
            installed: installer,
            backup: None,
        }),
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
    let backup = target_dir.join(".kungfu-dev.AppImage.shifu-previous");
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

#[cfg(test)]
#[path = "promote_tests.rs"]
mod tests;
