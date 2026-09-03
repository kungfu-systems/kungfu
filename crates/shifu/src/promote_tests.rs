use super::*;
use crate::native_update::artifact_size;

fn qualified_app(slot: &Path) -> BuildEntry {
    BuildEntry {
        slot: slot.to_path_buf(),
        name: "qualified-build".into(),
        sha: "1111111111111111111111111111111111111111".into(),
        branch: "detached".into(),
        repo: String::new(),
        worktree: String::new(),
        built_at: "2026-07-24T00:00:00Z".into(),
        kind: "app".into(),
        artifact: "Kungfu.app".into(),
        digest: "digest".into(),
        cli_archive: "kungfu-cli-darwin-arm64.tar.gz".into(),
        cli_archive_digest: format!("sha256:{}", "a".repeat(64)),
        upgrade_manifest: "kungfu-upgrade.json".into(),
        upgrade_manifest_digest: format!("sha256:{}", "b".repeat(64)),
        product_version: "4.0.0-alpha.0".into(),
        release_cut_root: format!("sha256:{}", "c".repeat(64)),
        platform_slice_root: format!("sha256:{}", "d".repeat(64)),
        mainline_ref: "origin/HEAD".into(),
        mainline_sha: "1111111111111111111111111111111111111111".into(),
        integrated: true,
        qualified: true,
    }
}

fn write_app_manifests(entry: &mut BuildEntry) {
    let contents = entry.slot.join(&entry.artifact).join("Contents");
    let resources = contents.join("Resources");
    fs::create_dir_all(resources.join("kungfu")).unwrap();
    fs::create_dir_all(resources.join("upgrade")).unwrap();
    fs::create_dir_all(contents.join("MacOS")).unwrap();
    fs::write(contents.join("MacOS/Kungfu"), "executable").unwrap();
    fs::write(
        resources.join("kungfu/kungfubuildinfo.json"),
        format!(r#"{{"git":{{"revision":"{}"}}}}"#, entry.sha),
    )
    .unwrap();
    fs::write(
        resources.join("upgrade/kungfu-release-manifest.json"),
        format!(r#"{{"sourceCommit":"{}"}}"#, entry.sha),
    )
    .unwrap();
    fs::write(
        resources.join("kungfu/profile-kfd3.json"),
        r#"{"schema":"kungfu.system-profile-kfd3-manifest/v1","entries":[{"id":"work-control"}]}"#,
    )
    .unwrap();
    fs::write(entry.slot.join(&entry.cli_archive), "cli archive").unwrap();
    entry.digest = artifact_sha256(&entry.slot.join(&entry.artifact)).unwrap();
    entry.cli_archive_digest = format!(
        "sha256:{}",
        bootstrap::sha256_file(&entry.slot.join(&entry.cli_archive)).unwrap()
    );
    let artifact_size = artifact_size(&entry.slot.join(&entry.artifact)).unwrap();
    fs::write(
        entry.slot.join(&entry.upgrade_manifest),
        format!(
            r#"{{"schema":"kungfu.product-upgrade.manifest/v1","releaseCutRoot":"{}","platformSliceRoot":"{}","localArtifact":{{"kind":"desktop-local","format":"directory","size":{},"digest":"sha256:{}"}}}}"#,
            entry.release_cut_root, entry.platform_slice_root, artifact_size, entry.digest
        ),
    )
    .unwrap();
    entry.upgrade_manifest_digest = format!(
        "sha256:{}",
        bootstrap::sha256_file(&entry.slot.join(&entry.upgrade_manifest)).unwrap()
    );
}

fn write_entry_meta(entry: &BuildEntry) {
    fs::write(
        entry.slot.join("meta.env"),
        format!(
            "KUNGFU_BUILD_SHA='{}'\n\
             KUNGFU_BUILD_BRANCH='{}'\n\
             KUNGFU_BUILD_REPO='{}'\n\
             KUNGFU_BUILD_WORKTREE='{}'\n\
             KUNGFU_BUILD_TIME='{}'\n\
             KUNGFU_BUILD_KIND='{}'\n\
             KUNGFU_BUILD_ARTIFACT='{}'\n\
             KUNGFU_BUILD_SHA256='{}'\n\
             KUNGFU_BUILD_CLI_ARCHIVE='{}'\n\
             KUNGFU_BUILD_CLI_ARCHIVE_SHA256='{}'\n\
             KUNGFU_BUILD_UPGRADE_MANIFEST='{}'\n\
             KUNGFU_BUILD_UPGRADE_MANIFEST_SHA256='{}'\n\
             KUNGFU_BUILD_PRODUCT_VERSION='{}'\n\
             KUNGFU_BUILD_RELEASE_CUT_ROOT='{}'\n\
             KUNGFU_BUILD_PLATFORM_SLICE_ROOT='{}'\n\
             KUNGFU_BUILD_MAINLINE_REF='{}'\n\
             KUNGFU_BUILD_MAINLINE_SHA='{}'\n\
             KUNGFU_BUILD_INTEGRATED='{}'\n\
             KUNGFU_BUILD_QUALIFIED='{}'\n",
            entry.sha,
            entry.branch,
            entry.repo,
            entry.worktree,
            entry.built_at,
            entry.kind,
            entry.artifact,
            entry.digest,
            entry.cli_archive,
            entry.cli_archive_digest,
            entry.upgrade_manifest,
            entry.upgrade_manifest_digest,
            entry.product_version,
            entry.release_cut_root,
            entry.platform_slice_root,
            entry.mainline_ref,
            entry.mainline_sha,
            entry.integrated,
            entry.qualified,
        ),
    )
    .unwrap();
}

#[test]
fn current_build_verification_is_independent_of_unrelated_history() {
    let root = shifu_core::host::unique_temp_dir("promote-current-registration").unwrap();
    let registry = root.join("registry");
    let slot = registry.join("current-build");
    let mut entry = qualified_app(&slot);
    entry.name = "current-build".into();
    entry.integrated = false;
    entry.qualified = false;
    entry.mainline_sha = "2".repeat(40);
    write_app_manifests(&mut entry);
    write_entry_meta(&entry);

    // These entries are deliberately unreadable as metadata files. Resolving
    // the exact current registration must never enumerate or inspect them.
    for index in 0..512 {
        fs::create_dir_all(registry.join(format!("unrelated-{index}")).join("meta.env")).unwrap();
    }
    let pointer = root.join(CURRENT_REGISTRATION_RELATIVE);
    fs::create_dir_all(pointer.parent().unwrap()).unwrap();
    fs::write(
        &pointer,
        format!(
            "SHIFU_REGISTERED_PRODUCT='kungfu'\n\
             SHIFU_REGISTERED_PLATFORM='{}'\n\
             SHIFU_REGISTERED_BUILD_ID='{}'\n\
             SHIFU_REGISTERED_BUILD_SHA='{}'\n\
             SHIFU_REGISTERED_ARTIFACT_SHA256='{}'\n",
            host::os_arch(),
            entry.name,
            entry.sha,
            entry.digest,
        ),
    )
    .unwrap();

    let mut selected = current_entry_at(&root, &registry, &entry.sha).unwrap();
    assert_eq!(selected.name, entry.name);
    assert!(current_payload_valid(&selected));
    assert!(
        !build_valid(&selected),
        "pre-integration verification must not claim promotion eligibility"
    );
    assert!(current_entry_at(&root, &registry, &"2".repeat(40)).is_err());

    selected.integrated = true;
    selected.qualified = true;
    selected.mainline_sha = selected.sha.clone();
    fs::write(
        selected
            .slot
            .join(&selected.artifact)
            .join("Contents/MacOS/Kungfu"),
        "tampered executable",
    )
    .unwrap();
    assert!(
        build_recorded_valid(&selected),
        "metadata listing must not read retained payload bytes"
    );
    assert!(
        !current_payload_valid(&selected),
        "exact current-build verification must still fail closed on tampering"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn qualified_app_requires_exact_product_manifests() {
    let root = shifu_core::host::unique_temp_dir("promote-manifests").unwrap();
    let mut entry = qualified_app(&root);
    fs::create_dir_all(entry.slot.join(&entry.artifact)).unwrap();
    assert!(!build_valid(&entry));

    write_app_manifests(&mut entry);
    assert!(build_valid(&entry));

    let manifest_path = entry.slot.join(&entry.upgrade_manifest);
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    let exact_size = artifact_size(&entry.slot.join(&entry.artifact)).unwrap();
    let wrong_size_manifest = manifest.replace(
        &format!(r#""size":{exact_size}"#),
        &format!(r#""size":{}"#, exact_size + 1),
    );
    assert_ne!(wrong_size_manifest, manifest);
    fs::write(&manifest_path, wrong_size_manifest).unwrap();
    entry.upgrade_manifest_digest =
        format!("sha256:{}", bootstrap::sha256_file(&manifest_path).unwrap());
    assert!(
        !build_valid(&entry),
        "promotion must reject a self-consistent manifest digest with a false artifact size"
    );
    write_app_manifests(&mut entry);
    assert!(build_valid(&entry));

    fs::write(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/MacOS/Kungfu"),
        "tampered executable",
    )
    .unwrap();
    assert!(!build_valid(&entry));
    fs::write(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/MacOS/Kungfu"),
        "executable",
    )
    .unwrap();
    assert!(build_valid(&entry));

    fs::write(entry.slot.join(&entry.cli_archive), "tampered cli").unwrap();
    assert!(!build_valid(&entry));
    write_app_manifests(&mut entry);
    assert!(build_valid(&entry));

    fs::remove_file(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/MacOS/Kungfu"),
    )
    .unwrap();
    assert!(!build_valid(&entry));
    fs::write(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/MacOS/Kungfu"),
        "executable",
    )
    .unwrap();
    fs::write(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/Resources/upgrade/kungfu-release-manifest.json"),
        r#"{"sourceCommit":"2222222222222222222222222222222222222222"}"#,
    )
    .unwrap();
    assert!(!build_valid(&entry));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn preview_keeps_mainline_qualification_separate_from_exact_product_provenance() {
    let root = shifu_core::host::unique_temp_dir("promote-preview").unwrap();
    let mut entry = qualified_app(&root);
    entry.branch = "feature/local-review".into();
    entry.integrated = false;
    entry.qualified = false;
    entry.mainline_sha = "2222222222222222222222222222222222222222".into();
    fs::create_dir_all(entry.slot.join(&entry.artifact)).unwrap();
    write_app_manifests(&mut entry);

    assert!(build_previewable(&entry));
    assert!(!build_valid(&entry));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn current_source_build_can_be_selected_without_mainline_delivery_state() {
    let root = shifu_core::host::unique_temp_dir("promote-current-source").unwrap();
    let mut entry = qualified_app(&root);
    entry.integrated = false;
    entry.qualified = false;
    entry.mainline_sha = "2".repeat(40);
    fs::create_dir_all(entry.slot.join(&entry.artifact)).unwrap();
    write_app_manifests(&mut entry);

    let entries = vec![entry];
    let selected = select_current_source_build(&entries, &entries[0], "", true);
    assert_eq!(selected.name, "qualified-build");
    assert!(current_payload_valid(selected));
    assert!(!build_valid(selected));
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn exact_installed_preview_converges_only_with_matching_native_receipt() {
    use std::os::unix::fs::PermissionsExt;

    let root = shifu_core::host::unique_temp_dir("promote-preview-convergence").unwrap();
    let registry = root.join("registry");
    let slot = registry.join("qualified-build");
    let mut entry = qualified_app(&slot);
    fs::create_dir_all(&slot).unwrap();
    write_app_manifests(&mut entry);
    let native_receipt_root = format!("sha256:{}", "e".repeat(64));
    let updater = slot
        .join(&entry.artifact)
        .join("Contents/Resources/kungfu/kungfu");
    let updater_status = format!(
        r#"{{"frontendInventory":{{"selected":{{"releaseCutRoot":"{}"}}}},"nativeReceiptRoot":"{}"}}"#,
        entry.release_cut_root, native_receipt_root
    );
    fs::write(
        &updater,
        format!("#!/bin/sh\nprintf '%s\\n' '{updater_status}'\n"),
    )
    .unwrap();
    fs::set_permissions(&updater, fs::Permissions::from_mode(0o755)).unwrap();
    entry.digest = artifact_sha256(&slot.join(&entry.artifact)).unwrap();
    write_entry_meta(&entry);

    let rollback_id = "prior-build";
    let rollback_sha = "2".repeat(40);
    let rollback_slot = registry.join(rollback_id);
    fs::create_dir_all(rollback_slot.join("Prior.app")).unwrap();
    fs::write(
        rollback_slot.join("meta.env"),
        format!("KUNGFU_BUILD_SHA='{rollback_sha}'\nKUNGFU_BUILD_ARTIFACT='Prior.app'\n"),
    )
    .unwrap();
    let installed_receipt = format!(
        "KUNGFU_INSTALLED_SHA='{}'\n\
         KUNGFU_INSTALLED_BUILD_ID='{}'\n\
         KUNGFU_INSTALLED_ARTIFACT='{}'\n\
         KUNGFU_INSTALLED_DIGEST='{}'\n\
         KUNGFU_INSTALLED_MAINLINE_SHA='{}'\n\
         KUNGFU_INSTALLED_INTEGRATED='true'\n\
         KUNGFU_INSTALLED_QUALIFIED='true'\n\
         KUNGFU_INSTALLED_MODE='qualified'\n\
         KUNGFU_INSTALLED_PRODUCT_VERSION='{}'\n\
         KUNGFU_INSTALLED_RELEASE_CUT_ROOT='{}'\n\
         KUNGFU_INSTALLED_PLATFORM_SLICE_ROOT='{}'\n\
         KUNGFU_INSTALLED_NATIVE_RECEIPT_ROOT='{}'\n\
         KUNGFU_INSTALLED_NATIVE_UPDATER='{}'\n\
         KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST='{}'\n\
         KUNGFU_ROLLBACK_BUILD_ID='{}'\n\
         KUNGFU_ROLLBACK_SHA='{}'\n",
        entry.sha,
        entry.name,
        slot.join(&entry.artifact).display(),
        entry.digest,
        entry.mainline_sha,
        entry.product_version,
        entry.release_cut_root,
        entry.platform_slice_root,
        native_receipt_root,
        updater.display(),
        bootstrap::sha256_file(&updater).unwrap(),
        rollback_id,
        rollback_sha,
    );
    fs::write(registry.join("installed.meta.env"), &installed_receipt).unwrap();
    fs::write(
        registry.join("last-promotion.json"),
        format!(
            r#"{{"schema":"shifu.local-promotion-receipt/v1","product":"kungfu","action":"preview","artifactId":"{}","fromCommit":"{}","toCommit":"{}","relation":"descendant","occurredAt":1}}"#,
            entry.name, rollback_sha, entry.sha
        ),
    )
    .unwrap();

    let convergence = promote_convergence::inspect_at(&entry, &registry)
        .unwrap()
        .expect("exact preview must converge without reinstalling Product bytes");
    assert_eq!(convergence.from_sha, rollback_sha);
    assert_eq!(convergence.relation, GitRelation::Descendant);
    assert_eq!(convergence.installed, slot.join(&entry.artifact));

    let mismatched = set_receipt_value(
        &installed_receipt,
        "KUNGFU_INSTALLED_NATIVE_RECEIPT_ROOT",
        &format!("sha256:{}", "f".repeat(64)),
    );
    fs::write(registry.join("installed.meta.env"), mismatched).unwrap();
    assert!(promote_convergence::inspect_at(&entry, &registry).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rollback_coordinate_requires_exact_retained_artifact() {
    let root = shifu_core::host::unique_temp_dir("promote-rollback").unwrap();
    let slot = root.join("prior-build");
    fs::create_dir_all(&slot).unwrap();
    fs::write(
        slot.join("meta.env"),
        "KUNGFU_BUILD_SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n\
         KUNGFU_BUILD_ARTIFACT='Kungfu.app'\n",
    )
    .unwrap();
    assert!(!rollback_entry_valid(
        &root,
        "prior-build",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ));

    fs::create_dir_all(slot.join("Kungfu.app")).unwrap();
    assert!(rollback_entry_valid(
        &root,
        "prior-build",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ));
    assert!(!rollback_entry_valid(
        &root,
        "prior-build",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    ));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn desktop_phase_resumes_after_backup_and_before_target_placement() {
    let root = shifu_core::host::unique_temp_dir("promote-desktop-resume").unwrap();
    let source = root.join("source.AppImage");
    fs::write(&source, b"new desktop").unwrap();
    for partial_target in [false, true] {
        let case = root.join(if partial_target { "partial" } else { "missing" });
        fs::create_dir_all(&case).unwrap();
        let target = case.join("kungfu-dev.AppImage");
        let backup = case.join(".kungfu-dev.AppImage.shifu-previous");
        let staged = case.join(".kungfu-dev.AppImage.shifu-next");
        fs::write(&target, b"old desktop").unwrap();
        fs::write(&staged, b"new desktop").unwrap();
        fs::rename(&target, &backup).unwrap();
        if partial_target {
            fs::write(&target, b"partial desktop").unwrap();
        }
        let marker = case.join("promotion-pending.json");
        let mut pending = PendingTransaction {
            state: "desktop-commit-pending".into(),
            action: "promote".into(),
            artifact_id: "target-build".into(),
            target_release_cut_root: format!("sha256:{}", "a".repeat(64)),
            cut_transition_root: format!("sha256:{}", "b".repeat(64)),
            native_receipt_root: String::new(),
            previous_build_id: "previous-build".into(),
            previous_sha: "1".repeat(40),
            previous_release_cut_root: format!("sha256:{}", "c".repeat(64)),
            installed_path: String::new(),
            desktop_backup_path: String::new(),
            force: false,
            launch: false,
        };
        write_pending_transaction_at(&marker, &pending).unwrap();
        let entry = qualified_app(&case);
        advance_desktop_phase_at(&mut pending, &entry, &marker, |_, _| {
            complete_atomic_target(
                &source,
                &target,
                &backup,
                &staged,
                |from, to| {
                    fs::copy(from, to)
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                },
                |path| Ok(fs::read(path).ok().as_deref() == Some(b"new desktop")),
            )
        })
        .unwrap();
        let recovered = read_pending_transaction_at(&marker).unwrap().unwrap();
        assert_eq!(recovered.state, "native-commit-pending");
        assert_eq!(fs::read(&target).unwrap(), b"new desktop");
        assert_eq!(fs::read(&backup).unwrap(), b"old desktop");
        assert_eq!(recovered.installed_path, target.display().to_string());
        assert_eq!(recovered.desktop_backup_path, backup.display().to_string());
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn native_commit_recovery_requires_the_persisted_native_receipt_root() {
    let target = format!("sha256:{}", "a".repeat(64));
    let mut selected = native_update::NativeSelection {
        release_cut_root: target.clone(),
        receipt_root: String::new(),
    };
    assert!(recovered_native_receipt_root(&selected, &target).is_err());

    selected.receipt_root = format!("sha256:{}", "b".repeat(64));
    assert_eq!(
        recovered_native_receipt_root(&selected, &target).unwrap(),
        selected.receipt_root
    );
    assert!(
        recovered_native_receipt_root(&selected, &format!("sha256:{}", "c".repeat(64))).is_err()
    );
}

#[test]
fn macos_shaped_partial_bundle_is_rejected_and_recovered() {
    fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
        fs::create_dir_all(target).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
        {
            let from = entry.path();
            let to = target.join(entry.file_name());
            if from.is_dir() {
                copy_tree(&from, &to)?;
            } else {
                fs::copy(&from, &to).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    let root = shifu_core::host::unique_temp_dir("promote-partial-app").unwrap();
    let mut source_entry = qualified_app(&root.join("slot"));
    write_app_manifests(&mut source_entry);
    let source = source_entry.slot.join(&source_entry.artifact);
    fs::create_dir_all(source.join("Contents/Frameworks")).unwrap();
    fs::write(
        source.join("Contents/Frameworks/Kungfu Framework"),
        "required framework",
    )
    .unwrap();
    let install = root.join("install");
    let target = install.join(&source_entry.artifact);
    let staged = install.join(".Kungfu.app.shifu-next");
    let backup = install.join(".Kungfu.app.shifu-previous");
    fs::create_dir_all(staged.join("Contents")).unwrap();
    copy_tree(
        &source.join("Contents/Resources"),
        &staged.join("Contents/Resources"),
    )
    .unwrap();
    copy_tree(
        &source.join("Contents/MacOS"),
        &staged.join("Contents/MacOS"),
    )
    .unwrap();
    assert!(
        product_app_manifests_valid(&staged, &source_entry.sha).unwrap(),
        "partial bundle has the old shallow success signals"
    );
    assert!(!tree_exact(&source, &staged).unwrap());

    complete_atomic_target(&source, &target, &backup, &staged, copy_tree, |candidate| {
        tree_exact(&source, candidate)
    })
    .unwrap();
    assert!(tree_exact(&source, &target).unwrap());
    assert!(target
        .join("Contents/Frameworks/Kungfu Framework")
        .is_file());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn pending_transaction_io_error_is_not_absence() {
    let root = shifu_core::host::unique_temp_dir("promote-pending-read-error").unwrap();
    let marker = root.join("promotion-pending.json");
    fs::create_dir(&marker).unwrap();
    let error = match read_pending_transaction_at(&marker) {
        Ok(_) => panic!("pending transaction read error was treated as absence"),
        Err(error) => error,
    };
    assert!(error.contains("cannot read pending promotion transaction"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn promotion_lock_has_one_live_writer_and_releases_exactly() {
    let root = shifu_core::host::unique_temp_dir("promote-lock").unwrap();
    let path = root.join("promotion.lock");
    let lock = acquire_promotion_lock_at(&path).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        std::process::id().to_string(),
        "the public lock must never expose an uninitialized owner"
    );
    assert!(acquire_promotion_lock_at(&path)
        .unwrap_err()
        .contains("another shifu promote process owns"));
    lock.release().unwrap();
    let replacement = acquire_promotion_lock_at(&path).unwrap();
    replacement.release().unwrap();
    assert!(!path.exists());
    fs::write(&path, (i32::MAX as u32).to_string()).unwrap();
    let recovered = acquire_promotion_lock_at(&path).unwrap();
    recovered.release().unwrap();
    assert!(!path.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn retained_rollback_uses_installed_state_after_source_slot_removal() {
    let root = shifu_core::host::unique_temp_dir("retained-product-rollback").unwrap();
    let installed = root.join("kungfu-dev.AppImage");
    let rollback = root.join(".kungfu-dev.AppImage.previous-cut");
    fs::write(&installed, b"current").unwrap();
    fs::write(&rollback, b"previous").unwrap();
    let source_slot = root.join("source-slot");
    fs::create_dir(&source_slot).unwrap();
    fs::remove_dir(&source_slot).unwrap();

    let current_digest = artifact_sha256(&installed).unwrap();
    let previous_digest = artifact_sha256(&rollback).unwrap();
    swap_retained_desktop(
        &installed,
        &rollback,
        &current_digest,
        &previous_digest,
        artifact_sha256,
    )
    .unwrap();
    assert_eq!(fs::read(&installed).unwrap(), b"previous");
    assert_eq!(fs::read(&rollback).unwrap(), b"current");
    swap_retained_desktop(
        &installed,
        &rollback,
        &current_digest,
        &previous_digest,
        artifact_sha256,
    )
    .unwrap();
    assert_eq!(fs::read(&installed).unwrap(), b"previous");
    assert_eq!(fs::read(&rollback).unwrap(), b"current");

    let interrupted_installed = root.join("interrupted-current.AppImage");
    let interrupted_rollback = root.join(".interrupted-previous.AppImage");
    fs::write(&interrupted_installed, b"current").unwrap();
    fs::write(&interrupted_rollback, b"previous").unwrap();
    let interrupted_stage = interrupted_rollback.with_extension("shifu-swap-pending");
    fs::rename(&interrupted_installed, &interrupted_stage).unwrap();
    swap_retained_desktop(
        &interrupted_installed,
        &interrupted_rollback,
        &current_digest,
        &previous_digest,
        artifact_sha256,
    )
    .unwrap();
    assert_eq!(fs::read(&interrupted_installed).unwrap(), b"previous");
    assert_eq!(fs::read(&interrupted_rollback).unwrap(), b"current");
    assert!(!interrupted_stage.exists());

    let installed_receipt = root.join("installed.meta.env");
    let rollback_receipt = root.join("rollback.meta.env");
    fs::write(
        &installed_receipt,
        format!(
            "KUNGFU_INSTALLED_RELEASE_CUT_ROOT='sha256:{}'\n",
            "a".repeat(64)
        ),
    )
    .unwrap();
    let pending = PendingTransaction {
        state: "receipt-commit-pending".into(),
        action: "promote".into(),
        artifact_id: "next".into(),
        target_release_cut_root: format!("sha256:{}", "b".repeat(64)),
        cut_transition_root: format!("sha256:{}", "c".repeat(64)),
        native_receipt_root: String::new(),
        previous_build_id: "previous".into(),
        previous_sha: "1".repeat(40),
        previous_release_cut_root: format!("sha256:{}", "a".repeat(64)),
        installed_path: installed.display().to_string(),
        desktop_backup_path: rollback.display().to_string(),
        force: false,
        launch: false,
    };
    retain_previous_installed_receipt_at(&installed_receipt, &rollback_receipt, &pending).unwrap();
    assert_eq!(
        fs::read_to_string(&rollback_receipt).unwrap(),
        fs::read_to_string(&installed_receipt).unwrap()
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn product_manifest_io_error_is_not_corruption() {
    let root = shifu_core::host::unique_temp_dir("promote-manifest-read-error").unwrap();
    let mut entry = qualified_app(&root);
    write_app_manifests(&mut entry);
    let build_info = entry
        .slot
        .join(&entry.artifact)
        .join("Contents/Resources/kungfu/kungfubuildinfo.json");
    fs::remove_file(&build_info).unwrap();
    fs::create_dir(&build_info).unwrap();
    assert!(product_app_manifests_valid(&entry.slot.join(&entry.artifact), &entry.sha).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn receipt_persistence_failure_retains_pending_recovery_material() {
    let root = shifu_core::host::unique_temp_dir("promote-receipt-failure").unwrap();
    let marker = root.join("promotion-pending.json");
    let backup = root.join("Kungfu.previous");
    fs::write(&backup, b"previous desktop").unwrap();
    let pending = PendingTransaction {
        state: "receipt-commit-pending".into(),
        action: "promote".into(),
        artifact_id: "target-build".into(),
        target_release_cut_root: format!("sha256:{}", "a".repeat(64)),
        cut_transition_root: format!("sha256:{}", "b".repeat(64)),
        native_receipt_root: format!("sha256:{}", "d".repeat(64)),
        previous_build_id: "previous-build".into(),
        previous_sha: "1".repeat(40),
        previous_release_cut_root: format!("sha256:{}", "c".repeat(64)),
        installed_path: root.join("Kungfu.app").display().to_string(),
        desktop_backup_path: backup.display().to_string(),
        force: false,
        launch: false,
    };
    write_pending_transaction_at(&marker, &pending).unwrap();
    let missing_parent = root.join("missing/installed.meta.env");
    assert!(write_installed_receipt_at(&missing_parent, "receipt").is_err());
    let rename_target = root.join("installed.meta.env");
    fs::create_dir(&rename_target).unwrap();
    assert!(write_installed_receipt_at(&rename_target, "receipt").is_err());
    assert!(
        marker.exists(),
        "pending marker must survive receipt failure"
    );
    assert!(
        backup.exists(),
        "desktop backup must survive receipt failure"
    );
    assert!(
        !rename_target
            .with_extension(format!("tmp-{}", std::process::id()))
            .exists(),
        "failed staged receipt must not become a second authority"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::Command;

    use shifu_core::{bootstrap, host};

    fn root(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    struct ReceiptFixture<'a> {
        path: &'a Path,
        installed: &'a Path,
        rollback: &'a Path,
        updater: &'a Path,
        installed_digest: &'a str,
        updater_digest: &'a str,
        current_cut: &'a str,
        rollback_cut: &'a str,
        build: &'a str,
    }

    fn write_receipt(fixture: ReceiptFixture<'_>) {
        fs::write(
            fixture.path,
            format!(
                "KUNGFU_ARTIFACT_SCHEMA='shifu.local-artifact/v1'\n\
                 KUNGFU_INSTALLED_SHA='{}'\n\
                 KUNGFU_INSTALLED_BUILD_ID='{}'\n\
                 KUNGFU_INSTALLED_ARTIFACT='{}'\n\
                 KUNGFU_INSTALLED_KIND='appimage'\n\
                 KUNGFU_INSTALLED_DIGEST='{}'\n\
                 KUNGFU_INSTALLED_PRODUCT_VERSION='4.0.0-alpha.0'\n\
                 KUNGFU_INSTALLED_RELEASE_CUT_ROOT='{}'\n\
                 KUNGFU_INSTALLED_NATIVE_UPDATER='{}'\n\
                 KUNGFU_INSTALLED_NATIVE_UPDATER_DIGEST='{}'\n\
                 KUNGFU_ROLLBACK_BUILD_ID='other'\n\
                 KUNGFU_ROLLBACK_SHA='{}'\n\
                 KUNGFU_ROLLBACK_RELEASE_CUT_ROOT='{}'\n\
                 KUNGFU_ROLLBACK_DESKTOP_PATH='{}'\n",
                if fixture.build == "current" {
                    "2".repeat(40)
                } else {
                    "1".repeat(40)
                },
                fixture.build,
                fixture.installed.display(),
                fixture.installed_digest,
                fixture.current_cut,
                fixture.updater.display(),
                fixture.updater_digest,
                if fixture.build == "current" {
                    "1".repeat(40)
                } else {
                    "2".repeat(40)
                },
                fixture.rollback_cut,
                fixture.rollback.display(),
            ),
        )
        .unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_adoption_is_read_only_until_execute_and_snapshots_exact_bytes() {
        let root_dir = host::unique_temp_dir("shifu-installed-adoption").unwrap();
        let registry = root_dir.join("registry");
        let install_dir = root_dir.join("Applications");
        let app = install_dir.join("Kungfu.app");
        let resources = app.join("Contents/Resources");
        let native_root = root_dir.join("native-image");
        let source_commit = "1".repeat(40);
        let desktop_cut = root('a');
        let desktop_slice = root('b');
        let native_cut = root('c');
        let native_slice = root('d');
        let native_receipt = root('e');
        fs::create_dir_all(resources.join("kungfu")).unwrap();
        fs::create_dir_all(resources.join("upgrade")).unwrap();
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::create_dir_all(native_root.join("upgrade")).unwrap();
        fs::write(app.join("Contents/MacOS/Kungfu"), "desktop").unwrap();
        fs::write(
            resources.join("kungfu/kungfubuildinfo.json"),
            format!(r#"{{"git":{{"revision":"{source_commit}"}}}}"#),
        )
        .unwrap();
        fs::write(
            resources.join("kungfu/profile-kfd3.json"),
            r#"{"schema":"kungfu.system-profile-kfd3-manifest/v1","entries":[{"id":"work-control"}]}"#,
        )
        .unwrap();
        fs::write(
            resources.join("upgrade/kungfu-release-manifest.json"),
            format!(r#"{{"sourceCommit":"{source_commit}","productVersion":"4.0.0-alpha.1","releaseCutRoot":"{desktop_cut}","platformSliceRoot":"{desktop_slice}","releaseCut":{{"publicationPolicy":{{"trustDomain":"shifu-local"}}}}}}"#),
        )
        .unwrap();
        fs::write(
            native_root.join("upgrade/kungfu-release-manifest.json"),
            format!(r#"{{"sourceCommit":"{source_commit}","productVersion":"4.0.0-alpha.1","releaseCutRoot":"{native_cut}","platformSliceRoot":"{native_slice}","releaseCut":{{"publicationPolicy":{{"trustDomain":"shifu-local"}}}}}}"#),
        )
        .unwrap();
        let updater = resources.join("kungfu/kungfu");
        let status = format!(
            r#"{{"frontendInventory":{{"selected":{{"releaseCutRoot":"{native_cut}","platformSliceRoot":"{native_slice}","productRoot":"{}"}}}},"nativeReceiptRoot":"{native_receipt}"}}"#,
            native_root.display()
        );
        fs::write(
            &updater,
            format!("#!/bin/sh\nprintf '%s\\n' '{}'\n", status.replace('\'', "")),
        )
        .unwrap();
        fs::set_permissions(&updater, fs::Permissions::from_mode(0o755)).unwrap();

        let entry = qualified_app(&root_dir.join("candidate"));
        let plan = adopt_installed_product_at(&entry, false, &registry, &install_dir).unwrap();
        assert!(plan.contains("\"state\":\"action-required\""));
        assert!(!registry.exists());

        let receipt = adopt_installed_product_at(&entry, true, &registry, &install_dir).unwrap();
        assert!(receipt.contains("\"state\":\"complete\""));
        let installed = fs::read_to_string(registry.join("installed.meta.env")).unwrap();
        let build_id = receipt_value(&installed, "KUNGFU_INSTALLED_BUILD_ID");
        assert!(rollback_entry_valid(&registry, &build_id, &source_commit));
        assert_eq!(
            artifact_sha256(&registry.join(&build_id).join(&entry.artifact)).unwrap(),
            artifact_sha256(&app).unwrap()
        );
        assert!(installed.contains(&format!("KUNGFU_INSTALLED_RELEASE_CUT_ROOT='{native_cut}'")));
        fs::remove_file(registry.join("installed.meta.env")).unwrap();
        assert!(adopt_installed_product_at(&entry, true, &registry, &install_dir).is_ok());
        assert!(adopt_installed_product_at(&entry, true, &registry, &install_dir).is_err());
        let _ = fs::remove_dir_all(root_dir);
    }

    #[test]
    fn product_rollback_survives_source_slot_removal() {
        let root_dir = host::unique_temp_dir("shifu-product-rollback-e2e").unwrap();
        let cache = root_dir.join("cache");
        let registry = cache.join("kungfu").join("product").join(host::os_arch());
        fs::create_dir_all(&registry).unwrap();
        let installed = root_dir.join("kungfu-dev.AppImage");
        let rollback = root_dir.join(".kungfu-dev.AppImage.previous");
        fs::write(&installed, b"current desktop").unwrap();
        fs::write(&rollback, b"previous desktop").unwrap();
        let current_digest = bootstrap::sha256_file(&installed).unwrap();
        let rollback_digest = bootstrap::sha256_file(&rollback).unwrap();

        let current_cut = root('a');
        let rollback_cut = root('b');
        let current_receipt = root('c');
        let rollback_native_receipt = root('d');
        let transition = root('e');
        let state = root_dir.join("native-state");
        fs::write(&state, &current_cut).unwrap();
        let updater = root_dir.join("kungfu");
        fs::write(
            &updater,
            format!(
                "#!/bin/sh\n\
                 if [ \"$2\" = \"status\" ]; then\n\
                   selected=$(cat \"$FAKE_STATE\")\n\
                   receipt=\"$CURRENT_RECEIPT\"\n\
                   if [ \"$selected\" = \"$ROLLBACK_CUT\" ]; then receipt=\"$ROLLBACK_RECEIPT\"; fi\n\
                   printf '{{\"frontendInventory\":{{\"selected\":{{\"releaseCutRoot\":\"%s\"}}}},\"nativeReceiptRoot\":\"%s\"}}\\n' \"$selected\" \"$receipt\"\n\
                   exit 0\n\
                 fi\n\
                 yes=false\n\
                 for arg in \"$@\"; do if [ \"$arg\" = \"--yes\" ]; then yes=true; fi; done\n\
                 state=action-required\n\
                 receipt=''\n\
                 if [ \"$yes\" = true ]; then\n\
                   printf '%s' \"$ROLLBACK_CUT\" > \"$FAKE_STATE\"\n\
                   state=complete\n\
                   receipt=\"$ROLLBACK_RECEIPT\"\n\
                 fi\n\
                 printf '{{\"state\":\"%s\",\"targetReleaseCutRoot\":\"%s\",\"cutTransitionRoot\":\"{}\",\"receiptRoot\":\"%s\"}}\\n' \"$state\" \"$ROLLBACK_CUT\" \"$receipt\"\n",
                transition
            ),
        )
        .unwrap();
        fs::set_permissions(&updater, fs::Permissions::from_mode(0o755)).unwrap();
        let updater_digest = bootstrap::sha256_file(&updater).unwrap();

        write_receipt(ReceiptFixture {
            path: &registry.join("installed.meta.env"),
            installed: &installed,
            rollback: &rollback,
            updater: &updater,
            installed_digest: &current_digest,
            updater_digest: &updater_digest,
            current_cut: &current_cut,
            rollback_cut: &rollback_cut,
            build: "current",
        });
        write_receipt(ReceiptFixture {
            path: &registry.join("rollback.meta.env"),
            installed: &installed,
            rollback: &rollback,
            updater: &updater,
            installed_digest: &rollback_digest,
            updater_digest: &updater_digest,
            current_cut: &rollback_cut,
            rollback_cut: &current_cut,
            build: "previous",
        });
        let removed_source_slot = registry.join("removed-source-slot");
        fs::create_dir(&removed_source_slot).unwrap();
        fs::remove_dir(&removed_source_slot).unwrap();

        let command = |check: bool| {
            let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
            let mut command =
                Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
            command
                .current_dir(workspace)
                .args([
                    "run",
                    "--quiet",
                    "--locked",
                    "--offline",
                    "-p",
                    "shifu",
                    "--bin",
                    "shifu",
                    "--",
                    "promote",
                    "--rollback",
                ])
                .env("XDG_CACHE_HOME", &cache)
                .env("FAKE_STATE", &state)
                .env("CURRENT_RECEIPT", &current_receipt)
                .env("ROLLBACK_RECEIPT", &rollback_native_receipt)
                .env("CURRENT_CUT", &current_cut)
                .env("ROLLBACK_CUT", &rollback_cut);
            if check {
                command.arg("--check");
            }
            command.output().unwrap()
        };
        let plan = command(true);
        assert!(
            plan.status.success(),
            "{}",
            String::from_utf8_lossy(&plan.stderr)
        );
        assert_eq!(fs::read(&installed).unwrap(), b"current desktop");
        assert_eq!(fs::read_to_string(&state).unwrap(), current_cut);

        let applied = command(false);
        assert!(
            applied.status.success(),
            "{}",
            String::from_utf8_lossy(&applied.stderr)
        );
        assert_eq!(fs::read(&installed).unwrap(), b"previous desktop");
        assert_eq!(fs::read(&rollback).unwrap(), b"current desktop");
        assert_eq!(fs::read_to_string(&state).unwrap(), rollback_cut);
        let receipt = fs::read_to_string(registry.join("installed.meta.env")).unwrap();
        assert!(receipt.contains(&format!(
            "KUNGFU_INSTALLED_RELEASE_CUT_ROOT='{rollback_cut}'"
        )));
        assert!(!registry.join("promotion-pending.json").exists());
        assert!(!registry.join("promotion.lock").exists());
        assert!(!removed_source_slot.exists());
        let _ = fs::remove_dir_all(root_dir);
    }
}
