// SPDX-License-Identifier: Apache-2.0
//
// Native Product updater adapter used by Shifu. Shifu chooses one exact local
// build; this module delegates Cut verification, CLI installation, selection,
// and rollback to the shipped Kungfu updater.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use shifu_core::{host, json};

const LEGACY_BOOTSTRAP_ROOT: &str =
    "sha256:ec51232534d89e75615d44f41ed6af0b2e9978e7bf6655bf231e7f35cefd13fc";

pub struct ApplyTarget<'a> {
    pub kind: &'a str,
    pub slot: &'a Path,
    pub artifact: &'a str,
    pub manifest: &'a str,
    pub archive: &'a str,
    pub archive_digest: &'a str,
    pub manifest_digest: &'a str,
    pub product_version: &'a str,
    pub release_cut_root: &'a str,
}

pub struct NativeUpdateResult {
    pub updater: PathBuf,
    pub transition_root: String,
    pub receipt_root: String,
}

pub fn updater(target: &ApplyTarget<'_>) -> Option<PathBuf> {
    if let Ok(value) = std::env::var("KUNGFU_NATIVE_UPDATER") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    if target.kind == "app" {
        let candidate = target
            .slot
            .join(target.artifact)
            .join("Contents/Resources/kungfu/kungfu");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    host::find_on_path(if cfg!(windows) {
        "kungfu.exe"
    } else {
        "kungfu"
    })
}

fn valid_root(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn apply_args(
    target: &ApplyTarget<'_>,
    current_cut: &str,
    current_version: &str,
    execute: bool,
) -> Vec<OsString> {
    let mut args = vec![
        "update".into(),
        "shifu-apply".into(),
        target.slot.join(target.manifest).into_os_string(),
        target.slot.join(target.archive).into_os_string(),
        "--expected-digest".into(),
        target.archive_digest.into(),
        "--evidence-root".into(),
        target.archive_digest.into(),
        "--evidence-root".into(),
        target.manifest_digest.into(),
        "--json".into(),
    ];
    if current_cut.is_empty() {
        args.extend([
            "--bootstrap-release-cut-root".into(),
            LEGACY_BOOTSTRAP_ROOT.into(),
            "--bootstrap-version".into(),
            if current_version.is_empty() {
                target.product_version.into()
            } else {
                current_version.into()
            },
        ]);
    }
    if execute {
        args.push("--yes".into());
    }
    args
}

fn parse_receipt(
    updater: PathBuf,
    output: std::process::Output,
    expected_state: &str,
    expected_cut: &str,
    action: &str,
) -> Result<NativeUpdateResult, String> {
    if !output.status.success() {
        return Err(format!(
            "native updater rejected {action} (exit {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let receipt = json::parse(&String::from_utf8_lossy(&output.stdout))
        .map_err(|error| format!("native updater returned invalid JSON: {error}"))?;
    let transition_root = receipt.str_of("cutTransitionRoot");
    let receipt_root = receipt.str_of("receiptRoot");
    if receipt.str_of("state") != expected_state
        || receipt.str_of("targetReleaseCutRoot") != expected_cut
        || !valid_root(transition_root)
        || (expected_state == "complete" && !valid_root(receipt_root))
    {
        return Err(format!(
            "native updater receipt does not bind the selected Release Cut for {action}"
        ));
    }
    Ok(NativeUpdateResult {
        updater,
        transition_root: transition_root.to_string(),
        receipt_root: receipt_root.to_string(),
    })
}

pub fn apply(
    target: &ApplyTarget<'_>,
    current_cut: &str,
    current_version: &str,
    execute: bool,
) -> Result<NativeUpdateResult, String> {
    let updater = updater(target).ok_or_else(|| {
        "native Kungfu updater is unavailable; set KUNGFU_NATIVE_UPDATER to one exact shipped kungfu executable".to_string()
    })?;
    let output = Command::new(&updater)
        .args(apply_args(target, current_cut, current_version, execute))
        .output()
        .map_err(|error| format!("failed to run native updater: {error}"))?;
    parse_receipt(
        updater,
        output,
        if execute {
            "complete"
        } else {
            "action-required"
        },
        target.release_cut_root,
        "Shifu selection",
    )
}

pub fn rollback(
    updater: &Path,
    current_cut: &str,
    rollback_cut: &str,
    execute: bool,
) -> Result<NativeUpdateResult, String> {
    if !valid_root(current_cut) || !valid_root(rollback_cut) {
        return Err("installed Product has no exact native Cut rollback coordinate".to_string());
    }
    let mut command = Command::new(updater);
    command
        .arg("update")
        .arg("shifu-rollback")
        .arg("--expected-current-release-cut-root")
        .arg(current_cut)
        .arg("--expected-rollback-release-cut-root")
        .arg(rollback_cut)
        .arg("--evidence-root")
        .arg(current_cut)
        .arg("--json");
    if execute {
        command.arg("--yes");
    }
    let output = command
        .output()
        .map_err(|error| format!("failed to run native rollback: {error}"))?;
    parse_receipt(
        updater.to_path_buf(),
        output,
        if execute {
            "complete"
        } else {
            "action-required"
        },
        rollback_cut,
        "rollback",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_adapter_binds_exact_slot_evidence_and_explicit_bootstrap() {
        let root = host::unique_temp_dir("native-apply-args").unwrap();
        let target = ApplyTarget {
            kind: "app",
            slot: &root,
            artifact: "Kungfu.app",
            manifest: "manifest.json",
            archive: "cli.tar.gz",
            archive_digest: "sha256:archive",
            manifest_digest: "sha256:manifest",
            product_version: "4.0.0-alpha.0",
            release_cut_root: "sha256:target",
        };
        let bootstrap = apply_args(&target, "", "", false);
        assert!(bootstrap.contains(&OsString::from("--bootstrap-release-cut-root")));
        assert!(!bootstrap.contains(&OsString::from("--yes")));
        let successor = apply_args(&target, "sha256:current", "4.0.0-alpha.0", true);
        assert!(!successor.contains(&OsString::from("--bootstrap-release-cut-root")));
        assert!(successor.contains(&OsString::from("--yes")));
        let _ = std::fs::remove_dir_all(root);
    }
}
