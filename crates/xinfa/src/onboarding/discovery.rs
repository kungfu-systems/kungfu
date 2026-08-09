// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

use super::{
    bytes_root, generated_or_vendor_path, object, parse_json, required_text, rooted,
    safe_relative_path, sensitive_path, u64_field, RepositorySnapshot, DEFAULT_MAX_FILES,
    DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_UNTRACKED_PATHS, DISCOVERY_REQUEST_VERSION,
    ONBOARDING_INVENTORY_VERSION,
};
use crate::{digest, RepositorySource};

#[derive(Clone, Copy)]
struct Limits {
    max_files: u64,
    max_file_bytes: u64,
    max_untracked_paths: u64,
    include_untracked_names: bool,
}

fn request(bytes: Option<&[u8]>, source: &str) -> Result<(Value, Limits), String> {
    let value = match bytes {
        Some(bytes) => parse_json(bytes, source, "repository discovery request")?,
        None => json!({
            "schema": DISCOVERY_REQUEST_VERSION,
            "trackedOnly": true,
            "includeUntrackedNames": true,
            "limits": {
                "maxFiles": DEFAULT_MAX_FILES,
                "maxFileBytes": DEFAULT_MAX_FILE_BYTES,
                "maxUntrackedPaths": DEFAULT_MAX_UNTRACKED_PATHS
            }
        }),
    };
    if value.get("schema").and_then(Value::as_str) != Some(DISCOVERY_REQUEST_VERSION) {
        return Err(format!(
            "repository discovery request schema must be {DISCOVERY_REQUEST_VERSION}"
        ));
    }
    if value.get("trackedOnly").and_then(Value::as_bool) != Some(true) {
        return Err("repository discovery v1 requires trackedOnly=true".to_owned());
    }
    let limits = object(&value, "limits")?;
    let limits = Limits {
        max_files: u64_field(limits, "maxFiles")?,
        max_file_bytes: u64_field(limits, "maxFileBytes")?,
        max_untracked_paths: u64_field(limits, "maxUntrackedPaths")?,
        include_untracked_names: value
            .get("includeUntrackedNames")
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                "repository discovery request requires boolean includeUntrackedNames".to_owned()
            })?,
    };
    if limits.max_files == 0
        || limits.max_file_bytes == 0
        || limits.max_untracked_paths == 0
        || limits.max_files > DEFAULT_MAX_FILES
        || limits.max_file_bytes > DEFAULT_MAX_FILE_BYTES
        || limits.max_untracked_paths > DEFAULT_MAX_UNTRACKED_PATHS
    {
        return Err(format!(
            "discovery limits must be positive and must not exceed maxFiles={DEFAULT_MAX_FILES}, maxFileBytes={DEFAULT_MAX_FILE_BYTES}, maxUntrackedPaths={DEFAULT_MAX_UNTRACKED_PATHS}"
        ));
    }
    Ok((value, limits))
}

fn classify(path: &str) -> (&'static str, Vec<&'static str>) {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if matches!(
        name,
        "Cargo.toml" | "package.json" | "pyproject.toml" | "setup.py" | "CMakeLists.txt" | "go.mod"
    ) || lower.starts_with("requirements") && lower.ends_with(".txt")
    {
        return ("manifest", vec!["path", "ecosystem-marker"]);
    }
    if name == "AGENTS.md" || name == "CLAUDE.md" || lower.starts_with("readme") {
        return ("guidance", vec!["path", "well-known-guidance-name"]);
    }
    if path.starts_with("docs/adr/") || path.starts_with("doc/adr/") || lower.starts_with("adr-") {
        return ("decision-record", vec!["path", "adr-convention"]);
    }
    if path.starts_with("docs/") || path.starts_with("doc/") || lower.ends_with(".md") {
        return ("documentation", vec!["path", "documentation-extension"]);
    }
    if path.starts_with(".github/workflows/") || path.starts_with(".gitlab/") {
        return ("ci", vec!["path", "ci-convention"]);
    }
    if path
        .split('/')
        .any(|part| matches!(part, "test" | "tests" | "spec" | "specs"))
    {
        return ("test", vec!["path", "test-directory"]);
    }
    if [
        ".rs", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".c", ".cc", ".cpp", ".cxx", ".h",
        ".hpp", ".go", ".java", ".kt", ".swift", ".rb",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
    {
        return ("source", vec!["path", "source-extension"]);
    }
    ("unknown", vec!["path"])
}

fn ecosystems(included: &[Value]) -> Vec<Value> {
    let markers = [
        ("rust-cargo", "Cargo.toml"),
        ("node", "package.json"),
        ("python", "pyproject.toml"),
        ("python", "setup.py"),
        ("cmake", "CMakeLists.txt"),
        ("go", "go.mod"),
    ];
    let mut evidence: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for entry in included {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        let name = path.rsplit('/').next().unwrap_or(path);
        for (ecosystem, marker) in markers {
            if name == marker {
                evidence.entry(ecosystem).or_default().insert(path);
            }
        }
        if name.starts_with("requirements") && name.ends_with(".txt") {
            evidence.entry("python").or_default().insert(path);
        }
    }
    evidence
        .into_iter()
        .map(|(id, paths)| json!({"id": id, "evidence": paths.into_iter().collect::<Vec<_>>() }))
        .collect()
}

fn exclusion(entry: &Value, path: &str, reason: &str) -> Value {
    json!({
        "path": path,
        "kind": "excluded",
        "reason": reason,
        "sourceEvidence": ["git-index-metadata"],
        "digest": digest(entry),
    })
}

pub(super) fn discover(
    snapshot: &RepositorySnapshot,
    repository: &dyn RepositorySource,
    request_bytes: Option<&[u8]>,
    source: &str,
) -> Result<String, String> {
    let (request, limits) = request(request_bytes, source)?;
    let mut entries = snapshot.entries().to_vec();
    entries.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .cmp(&right.get("path").and_then(Value::as_str))
            .then_with(|| {
                left.get("state")
                    .and_then(Value::as_str)
                    .cmp(&right.get("state").and_then(Value::as_str))
            })
    });
    let mut seen = BTreeSet::new();
    let mut included = Vec::new();
    let mut excluded = Vec::new();
    let mut untracked_count = 0_u64;
    let mut ignored_count = 0_u64;
    let mut tracked_count = 0_u64;

    for entry in entries {
        let entry_object = entry
            .as_object()
            .ok_or_else(|| "repository snapshot entries must be objects".to_owned())?;
        let path = required_text(entry_object, "path")?;
        if !safe_relative_path(path) {
            return Err(format!("repository snapshot path escapes root: {path}"));
        }
        let state = required_text(entry_object, "state")?;
        let dedupe = format!(
            "{state}\0{path}\0{}",
            entry_object
                .get("stage")
                .and_then(Value::as_u64)
                .unwrap_or_default()
        );
        if !seen.insert(dedupe) {
            return Err(format!(
                "repository snapshot contains duplicate {state} path {path}"
            ));
        }
        if state == "untracked" || state == "ignored" {
            if state == "untracked" {
                untracked_count += 1;
            } else {
                ignored_count += 1;
            }
            if limits.include_untracked_names
                && untracked_count + ignored_count <= limits.max_untracked_paths
            {
                excluded.push(exclusion(&entry, path, state));
            }
            continue;
        }
        if state != "tracked" {
            return Err(format!("unsupported repository snapshot state: {state}"));
        }
        tracked_count += 1;
        let mode = required_text(entry_object, "mode")?;
        if entry_object.get("stage").and_then(Value::as_u64) != Some(0) {
            excluded.push(exclusion(&entry, path, "index-conflict"));
            continue;
        }
        if mode == "120000" {
            excluded.push(exclusion(&entry, path, "symlink"));
            continue;
        }
        if mode == "160000" {
            excluded.push(exclusion(&entry, path, "gitlink"));
            continue;
        }
        if !matches!(mode, "100644" | "100755") {
            excluded.push(exclusion(&entry, path, "unsupported-file-mode"));
            continue;
        }
        if sensitive_path(path) {
            excluded.push(exclusion(&entry, path, "sensitive-path"));
            continue;
        }
        if path == ".xinfa" || path.starts_with(".xinfa/") {
            excluded.push(exclusion(&entry, path, "xinfa-control-plane"));
            continue;
        }
        if let Some(reason) = generated_or_vendor_path(path) {
            excluded.push(exclusion(&entry, path, reason));
            continue;
        }
        if included.len() as u64 >= limits.max_files {
            excluded.push(exclusion(&entry, path, "inventory-file-limit"));
            continue;
        }
        let bytes = match repository.read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                excluded.push(exclusion(&entry, path, error.code()));
                continue;
            }
        };
        if bytes.len() as u64 > limits.max_file_bytes {
            excluded.push(exclusion(&entry, path, "source-too-large"));
            continue;
        }
        if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            excluded.push(exclusion(&entry, path, "unsupported-encoding"));
            continue;
        }
        let (kind, evidence) = classify(path);
        included.push(json!({
            "path": path,
            "kind": kind,
            "reason": "safe-tracked-utf8",
            "sourceEvidence": evidence,
            "contentRoot": bytes_root(&bytes),
            "size": bytes.len() as u64,
        }));
    }
    included.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    excluded.sort_by(|left, right| {
        (left["path"].as_str(), left["reason"].as_str())
            .cmp(&(right["path"].as_str(), right["reason"].as_str()))
    });
    let ecosystems = ecosystems(&included);
    let repository_value = Value::Object(snapshot.repository().clone());
    let value = rooted(
        json!({
            "$schema": "https://xinfa.dev/schema/repository-inventory-v1.schema.json",
            "schema": ONBOARDING_INVENTORY_VERSION,
            "authoritative": false,
            "source": "git-index",
            "repository": repository_value,
            "policy": request,
            "ecosystems": ecosystems,
            "included": included,
            "excluded": excluded,
            "summary": {
                "tracked": tracked_count,
                "included": included.len(),
                "excluded": excluded.len(),
                "untracked": untracked_count,
                "ignored": ignored_count,
                "untrackedNamesTruncated": limits.include_untracked_names && untracked_count + ignored_count > limits.max_untracked_paths,
                "authorityState": "evidence-only"
            }
        }),
        "inventoryRoot",
    );
    Ok(super::stable(&value))
}

pub(super) fn request_from_inventory(inventory: &Value) -> Result<Vec<u8>, String> {
    let policy = inventory
        .get("policy")
        .ok_or_else(|| "candidate requires discovery policy".to_owned())?;
    Ok(super::stable(policy).into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RepositorySource, SourceReadError};

    struct Memory(BTreeMap<String, Vec<u8>>);
    impl RepositorySource for Memory {
        fn read(&self, relative: &str) -> Result<Vec<u8>, SourceReadError> {
            self.0
                .get(relative)
                .cloned()
                .ok_or_else(|| SourceReadError::new("missing-source", "missing"))
        }
    }

    #[test]
    fn discovery_excludes_sensitive_and_never_reads_it() {
        let snapshot = RepositorySnapshot::new(
            json!({"indexRoot":"sha256:index", "head":null, "tree":null, "dirty":false}),
            vec![
                json!({"path":"README.md","state":"tracked","mode":"100644","object":"a","stage":0}),
                json!({"path":".env","state":"tracked","mode":"100644","object":"b","stage":0}),
            ],
        )
        .expect("snapshot");
        let output: Value = serde_json::from_str(
            &discover(
                &snapshot,
                &Memory(BTreeMap::from([(
                    "README.md".to_owned(),
                    b"hello".to_vec(),
                )])),
                None,
                "test",
            )
            .expect("inventory"),
        )
        .expect("JSON");
        assert_eq!(output["included"][0]["path"], "README.md");
        assert_eq!(output["excluded"][0]["reason"], "sensitive-path");
    }

    #[test]
    fn adversarial_inventory_fails_closed_with_explicit_reasons() {
        let snapshot = RepositorySnapshot::new(
            json!({"indexRoot":"sha256:index", "head":null, "tree":null, "dirty":true}),
            vec![
                json!({"path":".env","state":"tracked","mode":"100644","object":"a","stage":0}),
                json!({"path":"vendor/lib.rs","state":"tracked","mode":"100644","object":"b","stage":0}),
                json!({"path":".xinfa/generated/view.json","state":"tracked","mode":"100644","object":"c","stage":0}),
                json!({"path":"linked.md","state":"tracked","mode":"120000","object":"d","stage":0}),
                json!({"path":"asset.bin","state":"tracked","mode":"100644","object":"e","stage":0}),
                json!({"path":"huge.md","state":"tracked","mode":"100644","object":"f","stage":0}),
                json!({"path":"conflicted.toml","state":"tracked","mode":"100644","object":"g","stage":2}),
                json!({"path":"scratch.txt","state":"untracked"}),
            ],
        )
        .expect("snapshot");
        let repository = Memory(BTreeMap::from([
            ("asset.bin".to_owned(), vec![0, 1, 2]),
            (
                "huge.md".to_owned(),
                vec![b'x'; DEFAULT_MAX_FILE_BYTES as usize + 1],
            ),
        ]));
        let output: Value = serde_json::from_str(
            &discover(&snapshot, &repository, None, "test").expect("inventory"),
        )
        .expect("JSON");
        let reasons: BTreeMap<&str, &str> = output["excluded"]
            .as_array()
            .expect("excluded")
            .iter()
            .map(|entry| {
                (
                    entry["path"].as_str().expect("path"),
                    entry["reason"].as_str().expect("reason"),
                )
            })
            .collect();
        assert_eq!(reasons[".env"], "sensitive-path");
        assert_eq!(reasons["vendor/lib.rs"], "generated-or-vendor");
        assert_eq!(reasons[".xinfa/generated/view.json"], "xinfa-control-plane");
        assert_eq!(reasons["linked.md"], "symlink");
        assert_eq!(reasons["asset.bin"], "unsupported-encoding");
        assert_eq!(reasons["huge.md"], "source-too-large");
        assert_eq!(reasons["conflicted.toml"], "index-conflict");
        assert_eq!(reasons["scratch.txt"], "untracked");
    }

    #[test]
    fn discovery_honors_untracked_name_privacy_and_hard_caps() {
        let snapshot = RepositorySnapshot::new(
            json!({"indexRoot":"sha256:index", "head":null, "tree":null, "dirty":true}),
            vec![json!({"path":"private-name.txt","state":"untracked"})],
        )
        .expect("snapshot");
        let request = super::super::stable(&json!({
            "schema": DISCOVERY_REQUEST_VERSION,
            "trackedOnly": true,
            "includeUntrackedNames": false,
            "limits": {
                "maxFiles": DEFAULT_MAX_FILES,
                "maxFileBytes": DEFAULT_MAX_FILE_BYTES,
                "maxUntrackedPaths": DEFAULT_MAX_UNTRACKED_PATHS
            }
        }));
        let output: Value = serde_json::from_str(
            &discover(
                &snapshot,
                &Memory(BTreeMap::new()),
                Some(request.as_bytes()),
                "test",
            )
            .expect("inventory"),
        )
        .expect("JSON");
        assert_eq!(output["summary"]["untracked"], 1);
        assert_eq!(output["summary"]["untrackedNamesTruncated"], false);
        assert_eq!(output["excluded"], json!([]));

        let over_limit = request.replace(
            &format!("\"maxFiles\":{DEFAULT_MAX_FILES}"),
            &format!("\"maxFiles\":{}", DEFAULT_MAX_FILES + 1),
        );
        assert!(discover(
            &snapshot,
            &Memory(BTreeMap::new()),
            Some(over_limit.as_bytes()),
            "test"
        )
        .expect_err("hard cap")
        .contains("must not exceed"));
    }
}
