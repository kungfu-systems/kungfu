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
    let contents = entry.slot.join(&entry.artifact).join("Contents");
    let resources = contents.join("Resources");
    fs::create_dir_all(resources.join("kungfu")).unwrap();
    fs::create_dir_all(resources.join("upgrade")).unwrap();
    fs::create_dir_all(contents.join("MacOS")).unwrap();
    fs::write(contents.join("MacOS/Kungfu Episodes"), "executable").unwrap();
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

    fs::remove_file(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/MacOS/Kungfu Episodes"),
    )
    .unwrap();
    assert!(!build_valid(&entry));
    fs::write(
        entry
            .slot
            .join(&entry.artifact)
            .join("Contents/MacOS/Kungfu Episodes"),
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
    let source_entry = qualified_app(&root.join("slot"));
    write_app_manifests(&source_entry);
    let source = source_entry.slot.join(&source_entry.artifact);
    fs::create_dir_all(source.join("Contents/Frameworks")).unwrap();
    fs::write(
        source.join("Contents/Frameworks/Kungfu Framework"),
        "required framework",
    )
    .unwrap();
    let install = root.join("install");
    let target = install.join(&source_entry.artifact);
    let staged = install.join(".Kungfu Episodes.app.shifu-next");
    let backup = install.join(".Kungfu Episodes.app.shifu-previous");
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
fn product_manifest_io_error_is_not_corruption() {
    let root = shifu_core::host::unique_temp_dir("promote-manifest-read-error").unwrap();
    let entry = qualified_app(&root);
    write_app_manifests(&entry);
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
