// SPDX-License-Identifier: Apache-2.0
//
// Native Product updater adapter used by Shifu. Shifu chooses one exact local
// build; this module delegates Cut verification, CLI installation, selection,
// and rollback to the shipped Kungfu updater.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use shifu_core::{bootstrap, host, json};

use crate::envfile;

pub(crate) const LEGACY_BOOTSTRAP_ROOT: &str =
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
    pub transition_root: String,
    pub receipt_root: String,
}

fn configured_updater() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("KUNGFU_NATIVE_UPDATER") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub fn installed_updater() -> Option<PathBuf> {
    configured_updater().or_else(|| {
        host::find_on_path(if cfg!(windows) {
            "kungfu.exe"
        } else {
            "kungfu"
        })
    })
}

pub fn updater(target: &ApplyTarget<'_>) -> Option<PathBuf> {
    if let Some(path) = configured_updater() {
        return Some(path);
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
    installed_updater()
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
    if current_cut.is_empty() || current_cut == LEGACY_BOOTSTRAP_ROOT {
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
    output: std::process::Output,
    expected_state: &str,
    expected_cut: &str,
    action: &str,
) -> Result<NativeUpdateResult, String> {
    if !output.status.success() {
        return Err(format!(
            "native updater rejected {action} (exit {:?}): {}",
            output.status.code(),
            failure_detail(&output.stderr, &output.stdout)
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
        transition_root: transition_root.to_string(),
        receipt_root: receipt_root.to_string(),
    })
}

fn failure_detail(stderr: &[u8], stdout: &[u8]) -> String {
    let error = String::from_utf8_lossy(stderr);
    let error = error.trim();
    if !error.is_empty() {
        return error.to_string();
    }
    let receipt = String::from_utf8_lossy(stdout);
    let receipt = receipt.trim();
    if !receipt.is_empty() {
        return receipt.to_string();
    }
    "no diagnostic output".to_string()
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

pub struct NativeSelection {
    pub release_cut_root: String,
    pub receipt_root: String,
}

pub fn selected_release_cut(updater: &Path) -> Result<NativeSelection, String> {
    let output = Command::new(updater)
        .args(["update", "status", "--json"])
        .output()
        .map_err(|error| format!("failed to inspect native updater state: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "native updater status failed (exit {:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let status = json::parse(&String::from_utf8_lossy(&output.stdout))
        .map_err(|error| format!("native updater status returned invalid JSON: {error}"))?;
    let release_cut_root = status
        .get("frontendInventory")
        .and_then(|inventory| inventory.get("selected"))
        .map(|selection| selection.str_of("releaseCutRoot").to_string())
        .unwrap_or_default();
    let receipt_root = status.str_of("nativeReceiptRoot").to_string();
    Ok(NativeSelection {
        release_cut_root,
        receipt_root,
    })
}

pub(crate) fn installed_release_cut_root(text: &str) -> Option<String> {
    let root = text
        .lines()
        .filter_map(envfile::parse_line)
        .find(|(key, _)| *key == "KUNGFU_INSTALLED_RELEASE_CUT_ROOT")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();
    valid_sha256_root(&root).then_some(root)
}

fn release_cut_for_child(
    native_selection: Option<&NativeSelection>,
    installed_receipt: Option<&str>,
) -> Option<String> {
    native_selection
        .map(|selection| selection.release_cut_root.as_str())
        .filter(|root| valid_sha256_root(root))
        .map(str::to_string)
        .or_else(|| installed_receipt.and_then(installed_release_cut_root))
}

pub fn installed_release_cut_for_child(installed_receipt: Option<&str>) -> Option<String> {
    let native_selection =
        installed_updater().and_then(|updater| selected_release_cut(&updater).ok());
    release_cut_for_child(native_selection.as_ref(), installed_receipt)
}

pub(crate) fn valid_sha256_root(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn artifact_sha256(path: &Path) -> Result<String, String> {
    if path.is_file() {
        return bootstrap::sha256_file(path);
    }
    if !path.is_dir() {
        return Err(format!(
            "artifact is not a regular file or directory: {}",
            path.display()
        ));
    }
    fn visit(root: &Path, current: &Path, rows: &mut Vec<String>) -> Result<(), String> {
        let mut entries = fs::read_dir(current)
            .map_err(|error| format!("cannot read {}: {error}", current.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("cannot read {}: {error}", current.display()))?;
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let candidate = entry.path();
            let metadata = fs::symlink_metadata(&candidate)
                .map_err(|error| format!("cannot inspect {}: {error}", candidate.display()))?;
            let relative = candidate
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if metadata.file_type().is_symlink() {
                let target = fs::read_link(&candidate)
                    .map_err(|error| format!("cannot read {}: {error}", candidate.display()))?;
                if target.is_absolute() {
                    return Err(format!("artifact has an absolute symlink: {relative}"));
                }
                let resolved = candidate
                    .parent()
                    .unwrap_or(root)
                    .join(&target)
                    .canonicalize()
                    .map_err(|error| format!("cannot resolve {relative}: {error}"))?;
                let canonical_root = root
                    .canonicalize()
                    .map_err(|error| format!("cannot resolve {}: {error}", root.display()))?;
                if !resolved.starts_with(&canonical_root) {
                    return Err(format!("artifact has an escaping symlink: {relative}"));
                }
                rows.push(format!("{relative}\0symlink:{}", target.to_string_lossy()));
            } else if metadata.is_dir() {
                visit(root, &candidate, rows)?;
            } else if metadata.is_file() {
                rows.push(format!(
                    "{relative}\0{}",
                    bootstrap::sha256_file(&candidate)?
                ));
            }
        }
        Ok(())
    }
    let mut rows = Vec::new();
    visit(path, path, &mut rows)?;
    rows.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    let temporary = env::temp_dir().join(format!(
        "shifu-artifact-tree-{}-{}.txt",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::write(&temporary, format!("{}\n", rows.join("\n")))
        .map_err(|error| format!("cannot stage artifact tree identity: {error}"))?;
    let digest = bootstrap::sha256_file(&temporary);
    let _ = fs::remove_file(&temporary);
    digest
}

pub(crate) fn artifact_size(path: &Path) -> Result<u64, String> {
    if path.is_file() {
        return fs::metadata(path)
            .map(|metadata| metadata.len())
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!(
            "artifact is not a regular file or directory: {}",
            path.display()
        ));
    }
    fn visit(root: &Path, current: &Path) -> Result<u64, String> {
        let mut size = 0_u64;
        for entry in fs::read_dir(current)
            .map_err(|error| format!("cannot read {}: {error}", current.display()))?
        {
            let entry =
                entry.map_err(|error| format!("cannot read {}: {error}", current.display()))?;
            let candidate = entry.path();
            let metadata = fs::symlink_metadata(&candidate)
                .map_err(|error| format!("cannot inspect {}: {error}", candidate.display()))?;
            if metadata.file_type().is_symlink() {
                let target = fs::read_link(&candidate)
                    .map_err(|error| format!("cannot read {}: {error}", candidate.display()))?;
                if target.is_absolute() {
                    return Err(format!(
                        "artifact has an absolute symlink: {}",
                        candidate.display()
                    ));
                }
                let resolved = candidate
                    .parent()
                    .unwrap_or(root)
                    .join(&target)
                    .canonicalize()
                    .map_err(|error| format!("cannot resolve {}: {error}", candidate.display()))?;
                let canonical_root = root
                    .canonicalize()
                    .map_err(|error| format!("cannot resolve {}: {error}", root.display()))?;
                if !resolved.starts_with(&canonical_root) {
                    return Err(format!(
                        "artifact has an escaping symlink: {}",
                        candidate.display()
                    ));
                }
                size = size
                    .checked_add(target.to_string_lossy().len() as u64)
                    .ok_or_else(|| "artifact size overflow".to_string())?;
            } else if metadata.is_dir() {
                size = size
                    .checked_add(visit(root, &candidate)?)
                    .ok_or_else(|| "artifact size overflow".to_string())?;
            } else if metadata.is_file() {
                size = size
                    .checked_add(metadata.len())
                    .ok_or_else(|| "artifact size overflow".to_string())?;
            }
        }
        Ok(size)
    }
    visit(path, path)
}

pub(crate) fn declared_artifact_size(value: Option<&json::Json>) -> Option<u64> {
    let json::Json::Number(number) = value? else {
        return None;
    };
    if !number.is_finite() || *number < 0.0 || number.fract() != 0.0 || *number > u64::MAX as f64 {
        return None;
    }
    let size = *number as u64;
    ((size as f64) == *number).then_some(size)
}

pub(crate) fn local_artifact_identity_valid(
    path: &Path,
    actual_sha256: &str,
    declared: &json::Json,
) -> bool {
    declared.str_of("kind") == "desktop-local"
        && declared.str_of("format") == if path.is_dir() { "directory" } else { "file" }
        && declared.str_of("digest") == format!("sha256:{actual_sha256}")
        && declared_artifact_size(declared.get("size")) == artifact_size(path).ok()
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
        let recovered_bootstrap =
            apply_args(&target, LEGACY_BOOTSTRAP_ROOT, "4.0.0-alpha.0", false);
        assert!(recovered_bootstrap.contains(&OsString::from("--bootstrap-release-cut-root")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_failure_uses_machine_readable_stdout_when_stderr_is_empty() {
        assert_eq!(
            failure_detail(b"", br#"{"reasonCode":"frontend-build-id-collision"}"#),
            r#"{"reasonCode":"frontend-build-id-collision"}"#
        );
        assert_eq!(
            failure_detail(b"explicit stderr", b"ignored stdout"),
            "explicit stderr"
        );
        assert_eq!(failure_detail(b"", b""), "no diagnostic output");
    }

    #[test]
    fn native_selection_outranks_a_stale_shifu_receipt_for_child_cut() {
        let native_root = format!("sha256:{}", "a".repeat(64));
        let receipt_root = format!("sha256:{}", "b".repeat(64));
        let selection = NativeSelection {
            release_cut_root: native_root.clone(),
            receipt_root: format!("sha256:{}", "c".repeat(64)),
        };
        let receipt = format!("KUNGFU_INSTALLED_RELEASE_CUT_ROOT='{receipt_root}'\n");

        assert_eq!(
            release_cut_for_child(Some(&selection), Some(&receipt)),
            Some(native_root)
        );
        assert_eq!(
            release_cut_for_child(None, Some(&receipt)),
            Some(receipt_root)
        );
    }
}
