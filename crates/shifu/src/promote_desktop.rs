// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use shifu_core::json;

use super::*;

pub(crate) fn swap_retained_desktop<Identity>(
    installed: &Path,
    rollback: &Path,
    current_identity: &str,
    rollback_identity: &str,
    identity: Identity,
) -> Result<(), String>
where
    Identity: Fn(&Path) -> Result<String, String>,
{
    promote_desktop_fs::swap_retained(
        installed,
        rollback,
        current_identity,
        rollback_identity,
        identity,
    )
}

pub(crate) fn regular_file(path: &Path) -> Result<bool, String> {
    promote_desktop_fs::is_regular_file(path)
}

pub(super) fn read_document(path: &Path) -> Result<Option<json::Json>, String> {
    promote_desktop_fs::parse_document(path)
}

pub(crate) fn product_app_manifests_valid(app: &Path, expected_sha: &str) -> Result<bool, String> {
    promote_desktop_fs::app_manifests_valid(app, expected_sha)
}

/// Verify a copied desktop tree against its immutable registry source without
/// trusting a sentinel that could have landed before an interrupted copy.
pub(super) fn tree_exact(source: &Path, candidate: &Path) -> Result<bool, String> {
    promote_desktop_fs::exact_tree(source, candidate)
}

pub(crate) fn complete_atomic_target<Stage, Verify>(
    source: &Path,
    target: &Path,
    backup: &Path,
    staged: &Path,
    stage_source: Stage,
    verify: Verify,
) -> Result<DesktopCommit, String>
where
    Stage: FnMut(&Path, &Path) -> Result<(), String>,
    Verify: Fn(&Path) -> Result<bool, String>,
{
    promote_desktop_fs::complete_target(source, target, backup, staged, stage_source, verify)
}

pub(super) struct InstalledReceiptContext<'a> {
    rollback_build_id: &'a str,
    rollback_sha: &'a str,
    rollback_release_cut_root: &'a str,
    cut_transition_root: &'a str,
    native_receipt_root: &'a str,
    native_updater: &'a Path,
    native_updater_digest: &'a str,
    mode: &'a str,
    rollback_desktop_path: &'a str,
}

pub(super) fn write_installed_receipt(
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
         KUNGFU_INSTALLED_KIND='{}'\n\
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
         KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST='{}'\n\
         KUNGFU_ROLLBACK_BUILD_ID='{}'\n\
         KUNGFU_ROLLBACK_SHA='{}'\n\
         KUNGFU_ROLLBACK_RELEASE_CUT_ROOT='{}'\n\
         KUNGFU_ROLLBACK_DESKTOP_PATH='{}'\n",
        entry.sha,
        entry.branch.replace('\'', ""),
        entry.repo.replace('\'', ""),
        entry.name,
        entry.worktree.replace('\'', ""),
        installed.display(),
        entry.kind,
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
        context.native_updater_digest,
        context.rollback_build_id,
        context.rollback_sha,
        context.rollback_release_cut_root,
        context.rollback_desktop_path,
    );
    write_installed_receipt_at(&installed_receipt_path(), &text)
}

pub(super) fn write_installed_receipt_at(path: &Path, text: &str) -> Result<(), String> {
    let staged = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::write(&staged, text)
        .and_then(|()| fs::rename(&staged, path))
        .map_err(|error| {
            let _ = fs::remove_file(&staged);
            format!("cannot persist installed promotion receipt: {error}")
        })
}

pub(super) fn retain_previous_installed_receipt(
    pending: &PendingTransaction,
) -> Result<(), String> {
    let current = fs::read_to_string(installed_receipt_path())
        .map_err(|error| format!("cannot retain previous installed Product receipt: {error}"))?;
    let recorded_current_cut = receipt_value(&current, "KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    let legacy_bootstrap = recorded_current_cut.is_empty();
    let current_cut = if legacy_bootstrap {
        native_update::LEGACY_BOOTSTRAP_ROOT.to_string()
    } else {
        recorded_current_cut
    };
    if current_cut == pending.target_release_cut_root {
        return Ok(());
    }
    if current_cut != pending.previous_release_cut_root {
        return Err("installed Product changed during promotion receipt commit".to_string());
    }
    let mut kind = receipt_value(&current, "KUNGFU_INSTALLED_KIND");
    if kind.is_empty() && receipt_value(&current, "KUNGFU_INSTALLED_ARTIFACT").ends_with(".app") {
        kind = "app".to_string();
    }
    let (updater_path, updater_digest) = if kind == "app" {
        let installed_updater =
            PathBuf::from(&pending.installed_path).join("Contents/Resources/kungfu/kungfu");
        if legacy_bootstrap {
            retain_external_updater(&installed_updater, &pending.target_release_cut_root)?
        } else {
            let backup_updater = PathBuf::from(&pending.desktop_backup_path)
                .join("Contents/Resources/kungfu/kungfu");
            if !backup_updater.is_file() {
                return Err("retained desktop has no native updater".to_string());
            }
            let digest = artifact_sha256(&backup_updater)?;
            (backup_updater, digest)
        }
    } else {
        let source = PathBuf::from(receipt_value(&current, "KUNGFU_INSTALLED_NATIVE_UPDATER"));
        retain_external_updater(&source, &current_cut)?
    };
    let rollback_digest = artifact_sha256(Path::new(&pending.desktop_backup_path))?;
    let enriched = set_receipt_value(
        &set_receipt_value(
            &set_receipt_value(
                &set_receipt_value(&current, "KUNGFU_INSTALLED_RELEASE_CUT_ROOT", &current_cut),
                "KUNGFU_INSTALLED_NATIVE_UPDATER",
                &updater_path.display().to_string(),
            ),
            "KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST",
            &updater_digest,
        ),
        "KUNGFU_INSTALLED_DIGEST",
        &rollback_digest,
    );
    write_installed_receipt_at(&rollback_receipt_path(), &enriched)
        .map_err(|error| format!("cannot retain rollback Product receipt: {error}"))
}

pub(super) fn retain_renamed_desktop_at(
    current: &str,
    installed: &Path,
    backup: &Path,
) -> Result<PathBuf, String> {
    if receipt_value(current, "KUNGFU_INSTALLED_KIND") != "app" {
        return Err("pending desktop promotion has no retained rollback payload".to_string());
    }
    let previous = PathBuf::from(receipt_value(current, "KUNGFU_INSTALLED_ARTIFACT"));
    let expected = receipt_value(current, "KUNGFU_INSTALLED_DIGEST");
    if previous.as_os_str().is_empty() || previous == installed || expected.len() != 64 {
        return Err("pending desktop promotion has no renamed Product rollback source".to_string());
    }
    let previous_exists = previous.exists();
    let backup_exists = backup.exists();
    if previous_exists && backup_exists {
        return Err("renamed Product rollback source and retained payload both exist".to_string());
    }
    if !backup_exists {
        if !previous_exists || artifact_sha256(&previous)? != expected {
            return Err(
                "renamed Product rollback source differs from its exact receipt".to_string(),
            );
        }
        fs::rename(&previous, backup)
            .map_err(|error| format!("cannot retain renamed Product rollback payload: {error}"))?;
    }
    if artifact_sha256(backup)? != expected {
        return Err(
            "retained renamed Product rollback payload differs from its receipt".to_string(),
        );
    }
    Ok(backup.to_path_buf())
}

fn retain_renamed_desktop(pending: &mut PendingTransaction) -> Result<(), String> {
    if !pending.desktop_backup_path.is_empty() {
        return Ok(());
    }
    let current = fs::read_to_string(installed_receipt_path())
        .map_err(|error| format!("cannot read installed Product receipt: {error}"))?;
    let installed = PathBuf::from(&pending.installed_path);
    let parent = installed
        .parent()
        .ok_or_else(|| "pending installed Product has no parent directory".to_string())?;
    let name = installed
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "pending installed Product has no desktop name".to_string())?;
    let backup = retained_backup_path(parent, name);
    pending.desktop_backup_path = retain_renamed_desktop_at(&current, &installed, &backup)?
        .display()
        .to_string();
    write_pending_transaction(pending);
    Ok(())
}

#[cfg(test)]
pub(super) fn retain_previous_installed_receipt_at(
    installed_path: &Path,
    rollback_path: &Path,
    pending: &PendingTransaction,
) -> Result<(), String> {
    let current = fs::read_to_string(installed_path)
        .map_err(|error| format!("cannot retain previous installed Product receipt: {error}"))?;
    let current_cut = current
        .lines()
        .filter_map(envfile::parse_line)
        .find(|(key, _)| *key == "KUNGFU_INSTALLED_RELEASE_CUT_ROOT")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    if current_cut == pending.target_release_cut_root {
        return Ok(());
    }
    if current_cut != pending.previous_release_cut_root {
        return Err("installed Product changed during promotion receipt commit".to_string());
    }
    write_installed_receipt_at(rollback_path, &current)
        .map_err(|error| format!("cannot retain rollback Product receipt: {error}"))
}

pub(super) fn retain_native_updater(
    entry: &BuildEntry,
    installed: &Path,
    source_updater: &Path,
) -> Result<(PathBuf, String), String> {
    let source_digest = artifact_sha256(source_updater)?;
    let retained = if entry.kind == "app" {
        installed.join("Contents/Resources/kungfu/kungfu")
    } else {
        retain_external_updater(source_updater, &entry.release_cut_root)?.0
    };
    if !retained.is_file() {
        return Err(format!(
            "installed Product has no retained native updater: {}",
            retained.display()
        ));
    }
    let digest = artifact_sha256(&retained)?;
    if digest != source_digest {
        return Err("retained native updater differs from the exact promotion updater".to_string());
    }
    Ok((retained, digest))
}

pub(super) fn retain_external_updater(
    source_updater: &Path,
    release_cut_root: &str,
) -> Result<(PathBuf, String), String> {
    let identity = release_cut_root
        .strip_prefix("sha256:")
        .ok_or_else(|| "native updater has no exact Release Cut identity".to_string())?;
    let directory = registry_dir().join("installed-native").join(identity);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("cannot create {}: {error}", directory.display()))?;
    let target = directory.join(if cfg!(windows) {
        "kungfu.exe"
    } else {
        "kungfu"
    });
    let source_digest = artifact_sha256(source_updater)?;
    if source_updater != target && !target.exists() {
        let staged = directory.join(format!(
            ".kungfu-next-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::copy(source_updater, &staged)
            .map_err(|error| format!("cannot retain native updater: {error}"))?;
        let permissions = fs::metadata(source_updater)
            .map_err(|error| format!("cannot inspect native updater: {error}"))?
            .permissions();
        fs::set_permissions(&staged, permissions)
            .map_err(|error| format!("cannot preserve native updater permissions: {error}"))?;
        fs::rename(&staged, &target).map_err(|error| {
            let _ = fs::remove_file(&staged);
            format!("cannot commit retained native updater: {error}")
        })?;
    }
    let target_digest = artifact_sha256(&target)?;
    if target_digest != source_digest {
        return Err("retained native updater differs from its exact source".to_string());
    }
    Ok((target, target_digest))
}

pub(super) fn native_target(entry: &BuildEntry) -> native_update::ApplyTarget<'_> {
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

pub(super) fn run_native(
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

pub(super) fn pending_transaction_path() -> PathBuf {
    registry_dir().join("promotion-pending.json")
}

pub(super) fn promotion_lock_path() -> PathBuf {
    registry_dir().join("promotion.lock")
}

#[derive(Debug)]
pub(super) struct PromotionLock {
    path: PathBuf,
}

impl PromotionLock {
    pub(super) fn release(self) -> Result<(), String> {
        let owner = fs::read_to_string(&self.path)
            .map_err(|error| format!("cannot inspect promotion lock owner: {error}"))?;
        if owner.trim() != std::process::id().to_string() {
            return Err("promotion lock owner changed before release".to_string());
        }
        fs::remove_file(&self.path)
            .map_err(|error| format!("cannot release promotion lock: {error}"))
    }
}

pub(super) fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

pub(super) fn acquire_promotion_lock_at(path: &Path) -> Result<PromotionLock, String> {
    let create = || -> Result<PromotionLock, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("cannot timestamp promotion lock owner: {error}"))?
            .as_nanos();
        let candidate = path.with_extension(format!("owner-{}-{nonce}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .map_err(|error| error.to_string())?;
        file.write_all(std::process::id().to_string().as_bytes())
            .map_err(|error| format!("cannot record promotion lock owner: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync promotion lock owner: {error}"))?;
        drop(file);
        let publish = fs::hard_link(&candidate, path);
        let _ = fs::remove_file(&candidate);
        publish.map_err(|error| error.to_string())?;
        Ok(PromotionLock {
            path: path.to_path_buf(),
        })
    };
    match create() {
        Ok(lock) => return Ok(lock),
        Err(_) if !path.exists() => {
            return Err(format!("cannot acquire promotion lock {}", path.display()))
        }
        Err(_) => {}
    }
    let owner = fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());
    if owner.is_some_and(process_alive) {
        return Err(format!(
            "another shifu promote process owns {}",
            path.display()
        ));
    }
    let recovery = path.with_extension("reclaim");
    let recovery_guard = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&recovery)
        .map_err(|_| "another shifu promote process is reclaiming the stale lock".to_string())?;
    fs::remove_file(path)
        .map_err(|error| format!("cannot reclaim stale promotion lock: {error}"))?;
    let result = create();
    drop(recovery_guard);
    let _ = fs::remove_file(recovery);
    result.map_err(|error| format!("cannot acquire promotion lock after recovery: {error}"))
}

pub(super) struct PendingTransaction {
    pub(super) state: String,
    pub(super) action: String,
    pub(super) artifact_id: String,
    pub(super) target_release_cut_root: String,
    pub(super) cut_transition_root: String,
    pub(super) native_receipt_root: String,
    pub(super) previous_build_id: String,
    pub(super) previous_sha: String,
    pub(super) previous_release_cut_root: String,
    pub(super) installed_path: String,
    pub(super) desktop_backup_path: String,
    pub(super) force: bool,
    pub(super) launch: bool,
}

pub(super) fn write_pending_transaction(pending: &PendingTransaction) {
    let path = pending_transaction_path();
    write_pending_transaction_at(&path, pending).unwrap_or_else(|error| {
        util::die(&format!(
            "cannot retain pending promotion transaction: {error}"
        ))
    });
}

pub(super) fn write_pending_transaction_at(
    path: &Path,
    pending: &PendingTransaction,
) -> Result<(), String> {
    let staged = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
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

pub(super) fn read_pending_transaction() -> Result<Option<PendingTransaction>, String> {
    read_pending_transaction_at(&pending_transaction_path())
}

pub(super) fn read_pending_transaction_at(
    path: &Path,
) -> Result<Option<PendingTransaction>, String> {
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

pub(super) fn advance_desktop_phase_at<Commit>(
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

pub(super) fn finish_pending_transaction(
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
    let (retained_updater, retained_updater_digest) =
        retain_native_updater(entry, &installed, updater).unwrap_or_else(|error| {
            util::die(&format!(
                "{error}; exact promotion transaction and desktop backup remain pending"
            ))
        });
    retain_previous_installed_receipt(pending).unwrap_or_else(|error| {
        util::die(&format!(
            "{error}; exact promotion transaction and desktop backup remain pending"
        ))
    });
    write_installed_receipt(
        entry,
        &installed,
        &InstalledReceiptContext {
            rollback_build_id: &pending.previous_build_id,
            rollback_sha: &pending.previous_sha,
            rollback_release_cut_root: &pending.previous_release_cut_root,
            cut_transition_root: &pending.cut_transition_root,
            native_receipt_root: &pending.native_receipt_root,
            native_updater: &retained_updater,
            native_updater_digest: &retained_updater_digest,
            mode: installed_mode,
            rollback_desktop_path: &pending.desktop_backup_path,
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
    fs::remove_file(pending_transaction_path()).unwrap_or_else(|error| {
        util::die(&format!(
            "promotion completed but pending transaction could not be cleared: {error}"
        ))
    });
    PromotionLock {
        path: promotion_lock_path(),
    }
    .release()
    .unwrap_or_else(|error| util::die(&error));
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

pub(super) fn resume_pending_transaction(entries: &[BuildEntry], check: bool) {
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
    if pending.action == "rollback-retained" {
        resume_retained_rollback(&mut pending);
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
            pending.native_receipt_root =
                recovered_native_receipt_root(&selected, &pending.target_release_cut_root)
                    .unwrap_or_else(|error| util::die(&error));
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
        util::die("native selection has no exact persisted apply or rollback receipt");
    }
    if selected.receipt_root != pending.native_receipt_root {
        util::die("native selection receipt does not match the pending promotion receipt");
    }
    retain_renamed_desktop(&mut pending).unwrap_or_else(|error| {
        util::die(&format!(
            "{error}; exact promotion transaction remains pending"
        ))
    });
    finish_pending_transaction(entries, entry, &pending, &updater)
}

pub(super) fn exact_receipt_updater(receipt: &str) -> Result<PathBuf, String> {
    let updater = PathBuf::from(receipt_value(receipt, "KUNGFU_INSTALLED_NATIVE_UPDATER"));
    let expected = receipt_value(receipt, "KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST");
    if !updater.is_file()
        || expected.len() != 64
        || artifact_sha256(&updater).ok().as_deref() != Some(expected.as_str())
    {
        return Err("installed Product native updater differs from its exact receipt".to_string());
    }
    Ok(updater)
}

pub(super) fn rebind_exact_app_receipt(
    receipt: &str,
    app: &Path,
) -> Result<(String, PathBuf), String> {
    if receipt_value(receipt, "KUNGFU_INSTALLED_KIND") != "app"
        || artifact_sha256(app)? != receipt_value(receipt, "KUNGFU_INSTALLED_DIGEST")
    {
        return Err("retained App differs from its exact receipt".to_string());
    }
    let updater = app.join("Contents/Resources/kungfu/kungfu");
    let expected = receipt_value(receipt, "KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST");
    if !updater.is_file() || expected.len() != 64 || artifact_sha256(&updater)? != expected {
        return Err("retained App native updater differs from its exact receipt".to_string());
    }
    let rebound = set_receipt_value(
        &set_receipt_value(
            receipt,
            "KUNGFU_INSTALLED_ARTIFACT",
            &app.display().to_string(),
        ),
        "KUNGFU_INSTALLED_NATIVE_UPDATER",
        &updater.display().to_string(),
    );
    Ok((rebound, updater))
}

pub(super) fn resume_retained_rollback(pending: &mut PendingTransaction) -> ! {
    let marker = pending_transaction_path();
    let target_receipt =
        fs::read_to_string(rollback_target_receipt_path()).unwrap_or_else(|error| {
            util::die(&format!(
                "retained rollback receipt is unavailable: {error}"
            ))
        });
    let current_receipt = fs::read_to_string(installed_receipt_path()).unwrap_or_else(|error| {
        util::die(&format!(
            "installed Product receipt is unavailable: {error}"
        ))
    });
    if pending.state == "desktop-rollback-pending" {
        let installed = PathBuf::from(&pending.installed_path);
        let rollback = PathBuf::from(&pending.desktop_backup_path);
        let current_identity = receipt_value(&current_receipt, "KUNGFU_INSTALLED_DIGEST");
        let rollback_identity = receipt_value(&target_receipt, "KUNGFU_INSTALLED_DIGEST");
        swap_retained_desktop(
            &installed,
            &rollback,
            &current_identity,
            &rollback_identity,
            artifact_sha256,
        )
        .unwrap_or_else(|error| util::die(&format!("desktop rollback remains pending: {error}")));
        if receipt_value(&current_receipt, "KUNGFU_INSTALLED_KIND") == "installer" {
            let status = Command::new(&installed)
                .arg("/S")
                .status()
                .unwrap_or_else(|error| {
                    util::die(&format!(
                        "retained Windows installer could not run: {error}"
                    ))
                });
            if !status.success() {
                util::die(&format!(
                    "retained Windows installer failed (exit {:?})",
                    status.code()
                ));
            }
        }
        pending.state = "native-rollback-pending".to_string();
        write_pending_transaction_at(&marker, pending).unwrap_or_else(|error| {
            util::die(&format!("cannot retain desktop rollback state: {error}"))
        });
    }
    let (target_receipt, updater) =
        if receipt_value(&target_receipt, "KUNGFU_INSTALLED_KIND") == "app" {
            rebind_exact_app_receipt(&target_receipt, Path::new(&pending.installed_path))
                .unwrap_or_else(|error| util::die(&error))
        } else {
            let updater =
                exact_receipt_updater(&target_receipt).unwrap_or_else(|error| util::die(&error));
            (target_receipt, updater)
        };
    if pending.state == "native-rollback-pending" {
        let selected =
            native_update::selected_release_cut(&updater).unwrap_or_else(|error| util::die(&error));
        if selected.release_cut_root == pending.target_release_cut_root {
            pending.native_receipt_root =
                recovered_native_receipt_root(&selected, &pending.target_release_cut_root)
                    .unwrap_or_else(|error| util::die(&error));
        } else {
            let native = native_update::rollback(
                &updater,
                &pending.previous_release_cut_root,
                &pending.target_release_cut_root,
                true,
            )
            .unwrap_or_else(|error| {
                util::die(&format!(
                    "native retained rollback remains pending: {error}"
                ))
            });
            pending.cut_transition_root = native.transition_root;
            pending.native_receipt_root = native.receipt_root;
        }
        pending.state = "receipt-rollback-pending".to_string();
        write_pending_transaction_at(&marker, pending).unwrap_or_else(|error| {
            util::die(&format!("cannot retain native rollback state: {error}"))
        });
    }
    if pending.state != "receipt-rollback-pending" {
        util::die("retained rollback transaction state is unsupported");
    }
    let target_updater_digest =
        receipt_value(&target_receipt, "KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST");
    let mut restored = target_receipt;
    for (key, value) in [
        (
            "KUNGFU_ROLLBACK_BUILD_ID",
            receipt_value(&current_receipt, "KUNGFU_INSTALLED_BUILD_ID"),
        ),
        (
            "KUNGFU_ROLLBACK_SHA",
            receipt_value(&current_receipt, "KUNGFU_INSTALLED_SHA"),
        ),
        (
            "KUNGFU_ROLLBACK_RELEASE_CUT_ROOT",
            receipt_value(&current_receipt, "KUNGFU_INSTALLED_RELEASE_CUT_ROOT"),
        ),
        (
            "KUNGFU_ROLLBACK_DESKTOP_PATH",
            pending.desktop_backup_path.clone(),
        ),
        (
            "KUNGFU_INSTALLED_CUT_TRANSITION_ROOT",
            pending.cut_transition_root.clone(),
        ),
        (
            "KUNGFU_INSTALLED_NATIVE_RECEIPT_ROOT",
            pending.native_receipt_root.clone(),
        ),
        (
            "KUNGFU_INSTALLED_NATIVE_UPDATER",
            updater.display().to_string(),
        ),
        (
            "KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST",
            target_updater_digest,
        ),
    ] {
        restored = set_receipt_value(&restored, key, &value);
    }
    let reverse_receipt = if receipt_value(&current_receipt, "KUNGFU_INSTALLED_KIND") == "app" {
        rebind_exact_app_receipt(&current_receipt, Path::new(&pending.desktop_backup_path))
            .unwrap_or_else(|error| util::die(&error))
            .0
    } else {
        current_receipt
    };
    write_installed_receipt_at(&rollback_receipt_path(), &reverse_receipt).unwrap_or_else(
        |error| {
            util::die(&format!(
                "cannot retain current Product for reverse rollback: {error}"
            ))
        },
    );
    write_installed_receipt_at(&installed_receipt_path(), &restored).unwrap_or_else(|error| {
        util::die(&format!("cannot commit retained rollback receipt: {error}"))
    });
    let _ = fs::remove_file(rollback_target_receipt_path());
    fs::remove_file(&marker).unwrap_or_else(|error| {
        util::die(&format!("rollback completed but marker remains: {error}"))
    });
    PromotionLock {
        path: promotion_lock_path(),
    }
    .release()
    .unwrap_or_else(|error| util::die(&error));
    eprintln!(
        "\u{2705} {} {}",
        style::green("rolled back"),
        style::bold(&pending.installed_path)
    );
    if pending.launch {
        launch_product(Path::new(&pending.installed_path));
    }
    std::process::exit(0)
}

pub(super) fn start_retained_rollback(check: bool, launch: bool) -> ! {
    let current = fs::read_to_string(installed_receipt_path()).unwrap_or_else(|error| {
        util::die(&format!(
            "installed Product receipt is unavailable: {error}"
        ))
    });
    let rollback = fs::read_to_string(rollback_receipt_path()).unwrap_or_else(|error| {
        util::die(&format!(
            "installed Product has no retained rollback receipt: {error}"
        ))
    });
    let current_cut = receipt_value(&current, "KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    let rollback_cut = receipt_value(&current, "KUNGFU_ROLLBACK_RELEASE_CUT_ROOT");
    let retained_cut = receipt_value(&rollback, "KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    let installed = receipt_value(&current, "KUNGFU_INSTALLED_ARTIFACT");
    let desktop_backup = receipt_value(&current, "KUNGFU_ROLLBACK_DESKTOP_PATH");
    let updater = exact_receipt_updater(&current).unwrap_or_else(|error| util::die(&error));
    if !valid_root(&current_cut)
        || !valid_root(&rollback_cut)
        || retained_cut != rollback_cut
        || installed.is_empty()
        || desktop_backup.is_empty()
        || !Path::new(&installed).exists()
        || !Path::new(&desktop_backup).exists()
    {
        util::die("installed Product has no complete cache-independent rollback state");
    }
    let plan = native_update::rollback(&updater, &current_cut, &rollback_cut, false)
        .unwrap_or_else(|error| util::die(&format!("native updater preflight failed: {error}")));
    if check {
        println!(
            "{{\"schema\":\"shifu.local-promotion-plan/v1\",\"ok\":true,\"action\":\"rollback\",\
             \"currentReleaseCutRoot\":\"{}\",\"targetReleaseCutRoot\":\"{}\",\
             \"cutTransitionRoot\":\"{}\",\"wouldWrite\":false}}",
            json_escape(&current_cut),
            json_escape(&rollback_cut),
            json_escape(&plan.transition_root)
        );
        std::process::exit(0);
    }
    write_installed_receipt_at(&rollback_target_receipt_path(), &rollback).unwrap_or_else(
        |error| util::die(&format!("cannot stage retained rollback receipt: {error}")),
    );
    write_pending_transaction(&PendingTransaction {
        state: "desktop-rollback-pending".to_string(),
        action: "rollback-retained".to_string(),
        artifact_id: receipt_value(&rollback, "KUNGFU_INSTALLED_BUILD_ID"),
        target_release_cut_root: rollback_cut,
        cut_transition_root: plan.transition_root,
        native_receipt_root: String::new(),
        previous_build_id: receipt_value(&current, "KUNGFU_INSTALLED_BUILD_ID"),
        previous_sha: receipt_value(&current, "KUNGFU_INSTALLED_SHA"),
        previous_release_cut_root: current_cut,
        installed_path: installed,
        desktop_backup_path: desktop_backup,
        force: false,
        launch,
    });
    let mut pending = read_pending_transaction()
        .unwrap_or_else(|error| util::die(&error))
        .unwrap_or_else(|| util::die("retained rollback transaction was not persisted"));
    resume_retained_rollback(&mut pending)
}

pub(super) fn recovered_native_receipt_root(
    selected: &native_update::NativeSelection,
    target_release_cut_root: &str,
) -> Result<String, String> {
    if selected.release_cut_root != target_release_cut_root {
        return Err("native selection does not match the pending promotion target".to_string());
    }
    if !valid_root(&selected.receipt_root) {
        return Err(
            "native selection has no exact persisted apply or rollback receipt".to_string(),
        );
    }
    Ok(selected.receipt_root.clone())
}
