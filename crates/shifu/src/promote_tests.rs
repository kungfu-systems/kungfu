use super::*;

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
        artifact: "Kungfu Episodes.app".into(),
        digest: "digest".into(),
        cli_archive: "kungfu-episodes-cli-darwin-arm64.tar.gz".into(),
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

fn write_app_manifests(entry: &BuildEntry) {
    let resources = entry.slot.join(&entry.artifact).join("Contents/Resources");
    fs::create_dir_all(resources.join("kungfu")).unwrap();
    fs::create_dir_all(resources.join("upgrade")).unwrap();
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
    fs::write(entry.slot.join(&entry.upgrade_manifest), "{}").unwrap();
}

#[test]
fn qualified_app_requires_exact_product_manifests() {
    let root = shifu_core::host::unique_temp_dir("promote-manifests").unwrap();
    let entry = qualified_app(&root);
    fs::create_dir_all(entry.slot.join(&entry.artifact)).unwrap();
    assert!(!build_valid(&entry));

    write_app_manifests(&entry);
    assert!(build_valid(&entry));

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
    write_app_manifests(&entry);

    assert!(build_previewable(&entry));
    assert!(!build_valid(&entry));
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
         KUNGFU_BUILD_ARTIFACT='Kungfu Episodes.app'\n",
    )
    .unwrap();
    assert!(!rollback_entry_valid(
        &root,
        "prior-build",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ));

    fs::create_dir_all(slot.join("Kungfu Episodes.app")).unwrap();
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
    let mut entry = qualified_app(&slot);
    entry.name = "prior-build".into();
    entry.sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into();
    let entries = vec![entry];
    assert!(rollback_build(
        &entries,
        "prior-build",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )
    .is_some());
    assert!(rollback_build(
        &entries,
        "prior",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )
    .is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn pending_transaction_retains_recovery_state_across_native_failure() {
    let root = shifu_core::host::unique_temp_dir("promote-pending").unwrap();
    let marker = root.join("promotion-pending.json");
    let backup = root.join("Kungfu.previous");
    fs::write(&backup, "previous desktop").unwrap();
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
    let recovered = read_pending_transaction_at(&marker).unwrap().unwrap();
    assert_eq!(recovered.state, "desktop-commit-pending");

    pending.state = "native-commit-pending".into();
    pending.installed_path = root.join("Kungfu.app").display().to_string();
    pending.desktop_backup_path = backup.display().to_string();
    write_pending_transaction_at(&marker, &pending).unwrap();
    let recovered = read_pending_transaction_at(&marker).unwrap().unwrap();
    assert_eq!(recovered.state, "native-commit-pending");
    assert_eq!(recovered.desktop_backup_path, backup.display().to_string());
    assert!(
        backup.exists(),
        "native failure must retain desktop rollback"
    );

    pending.state = "receipt-commit-pending".into();
    pending.native_receipt_root = format!("sha256:{}", "d".repeat(64));
    write_pending_transaction_at(&marker, &pending).unwrap();
    let recovered = read_pending_transaction_at(&marker).unwrap().unwrap();
    assert_eq!(recovered.state, "receipt-commit-pending");
    assert!(valid_root(&recovered.native_receipt_root));
    assert!(
        backup.exists(),
        "receipt failure must retain desktop rollback"
    );
    let _ = fs::remove_dir_all(root);
}
