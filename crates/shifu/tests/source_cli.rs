// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root() -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("shifu-source-{}-{suffix}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    path
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    for key in [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_OBJECT_DIRECTORY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_IMPLICIT_WORK_TREE",
        "GIT_GRAFT_FILE",
        "GIT_INDEX_FILE",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_REPLACE_REF_BASE",
        "GIT_PREFIX",
        "GIT_SHALLOW_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    let output = command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .arg("-c")
        .arg("core.hooksPath=")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn shifu(cwd: &Path, args: &[String]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_shifu"))
        // Git hooks export these variables. The source boundary must ignore
        // them and remain pinned to its explicit destination checkout.
        .env("GIT_DIR", cwd.join("ambient.git"))
        .env("GIT_INDEX_FILE", cwd.join("ambient.index"))
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap()
}

fn source_args(repository: &Path, commit: &str, tree: &str, destination: &Path) -> Vec<String> {
    [
        "--repository".to_string(),
        repository.display().to_string(),
        "--commit".to_string(),
        commit.to_string(),
        "--tree".to_string(),
        tree.to_string(),
        "--tag".to_string(),
        "v-source-test".to_string(),
        "--bundle-root".to_string(),
        format!("sha256:{}", "a".repeat(64)),
        "--passport-root".to_string(),
        format!("sha256:{}", "b".repeat(64)),
        "--destination".to_string(),
        destination.display().to_string(),
        "--json".to_string(),
    ]
    .into()
}

#[test]
fn plan_acquire_and_verify_preserve_the_exact_source_cut() {
    let root = temp_root();
    let repository = root.join("origin");
    let destination = root.join("checkout");
    fs::create_dir_all(&repository).unwrap();
    git(&repository, &["init", "-b", "main"]);
    git(&repository, &["config", "user.name", "Source Test"]);
    git(
        &repository,
        &["config", "user.email", "source-test@example.invalid"],
    );
    fs::write(repository.join("shifu"), "#!/bin/sh\nexit 99\n").unwrap();
    git(&repository, &["add", "shifu"]);
    git(&repository, &["commit", "-m", "source fixture"]);
    git(&repository, &["tag", "v-source-test"]);
    let commit = git(&repository, &["rev-parse", "HEAD^{commit}"]);
    let tree = git(&repository, &["rev-parse", "HEAD^{tree}"]);
    let exact = source_args(&repository, &commit, &tree, &destination);

    let mut plan_args = vec!["source".into(), "plan".into()];
    plan_args.extend(exact.clone());
    let planned = shifu(&root, &plan_args);
    assert!(
        planned.status.success(),
        "{}",
        String::from_utf8_lossy(&planned.stderr)
    );
    let planned_json = String::from_utf8_lossy(&planned.stdout);
    assert!(planned_json.contains("\"readOnly\":true"));
    assert!(planned_json.contains("\"planRoot\":\"sha256:"));
    assert!(
        !destination.exists(),
        "planning must not create the destination"
    );

    let mut ungated_args = vec!["source".into(), "acquire".into()];
    ungated_args.extend(exact.clone());
    let ungated = shifu(&root, &ungated_args);
    assert_eq!(ungated.status.code(), Some(2));
    assert!(!destination.exists(), "ungated acquisition must not mutate");

    let mut acquire_args = ungated_args;
    acquire_args.push("--execute".into());
    let acquired = shifu(&root, &acquire_args);
    assert!(
        acquired.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&acquired.stdout),
        String::from_utf8_lossy(&acquired.stderr),
    );
    let receipt = String::from_utf8_lossy(&acquired.stdout);
    assert!(receipt.contains("\"status\":\"qualified\""));
    assert!(receipt.contains("\"repositoryCodeExecuted\":false"));
    assert!(receipt.contains("\"receiptRoot\":\"sha256:"));
    assert_eq!(git(&destination, &["rev-parse", "HEAD^{commit}"]), commit);
    assert_eq!(git(&destination, &["rev-parse", "HEAD^{tree}"]), tree);

    let mut verify_args = vec!["source".into(), "verify".into()];
    verify_args.extend(exact);
    let verified = shifu(&root, &verify_args);
    assert!(verified.status.success());

    let legacy = shifu(
        &root,
        &["clone".into(), root.join("legacy").display().to_string()],
    );
    assert!(!legacy.status.success());
    assert!(
        !root.join("legacy").exists(),
        "retired clone must be absent, not redirected"
    );

    fs::remove_dir_all(root).unwrap();
}
