// SPDX-License-Identifier: Apache-2.0

//! Authority-safe onboarding for previously unknown Git repositories.
//!
//! Discovery records host-provided repository evidence. Candidate generation is
//! deterministic but explicitly non-authoritative. Only a selection-bound
//! acceptance transaction can produce a `xinfa.project/v1` declaration.

mod acceptance;
mod candidate;
mod discovery;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::{digest, stable_json, RepositorySource};

pub const DISCOVERY_REQUEST_VERSION: &str = "xinfa.repository-discovery-request/v1";
pub const ONBOARDING_INVENTORY_VERSION: &str = "xinfa.repository-inventory/v1";
pub const ONBOARDING_CANDIDATE_VERSION: &str = "xinfa.repository-onboarding-candidate/v1";
pub const ONBOARDING_EXPLANATION_VERSION: &str = "xinfa.repository-onboarding-explanation/v1";
pub const ONBOARDING_SELECTION_VERSION: &str = "xinfa.repository-onboarding-selection/v1";
pub const ONBOARDING_ACCEPTANCE_VERSION: &str = "xinfa.repository-onboarding-acceptance/v1";
pub const REPOSITORY_SNAPSHOT_VERSION: &str = "xinfa.repository-snapshot/v1";

pub const DEFAULT_MAX_FILES: u64 = 4_096;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const DEFAULT_MAX_UNTRACKED_PATHS: u64 = 256;

#[derive(Clone, Debug)]
pub struct RepositorySnapshot {
    value: Value,
}

impl RepositorySnapshot {
    pub fn from_value(value: Value) -> Result<Self, String> {
        if value.get("schema").and_then(Value::as_str) != Some(REPOSITORY_SNAPSHOT_VERSION) {
            return Err(format!(
                "repository snapshot schema must be {REPOSITORY_SNAPSHOT_VERSION}"
            ));
        }
        let repository = object(&value, "repository")?;
        required_text(repository, "indexRoot")?;
        bool_field(repository, "dirty")?;
        array(&value, "entries")?;
        Ok(Self { value })
    }

    pub fn new(repository: Value, entries: Vec<Value>) -> Result<Self, String> {
        Self::from_value(json!({
            "schema": REPOSITORY_SNAPSHOT_VERSION,
            "repository": repository,
            "entries": entries,
        }))
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn repository(&self) -> &Map<String, Value> {
        self.value["repository"]
            .as_object()
            .expect("validated repository snapshot")
    }

    pub fn entries(&self) -> &[Value] {
        self.value["entries"]
            .as_array()
            .expect("validated repository snapshot")
    }

    pub fn index_root(&self) -> &str {
        self.repository()["indexRoot"]
            .as_str()
            .expect("validated repository index root")
    }
}

#[derive(Debug)]
pub struct AcceptanceOutcome {
    pub receipt: String,
    pub project: String,
    pub execute: bool,
    pub project_root: String,
    pub atlas_root: String,
}

pub struct AcceptanceRequest<'a> {
    pub candidate_bytes: &'a [u8],
    pub candidate_source: &'a str,
    pub selection_bytes: &'a [u8],
    pub selection_source: &'a str,
    pub existing_project: Option<&'a [u8]>,
    pub mode: &'a str,
}

pub fn discover_repository_value(
    snapshot: &RepositorySnapshot,
    repository: &dyn RepositorySource,
    request_bytes: Option<&[u8]>,
    source: &str,
) -> Result<String, String> {
    discovery::discover(snapshot, repository, request_bytes, source)
}

pub fn candidate_from_inventory_bytes(bytes: &[u8], source: &str) -> Result<String, String> {
    candidate::candidate(bytes, source)
}

pub fn explain_candidate_bytes(bytes: &[u8], source: &str) -> Result<String, String> {
    candidate::explain(bytes, source)
}

pub fn accept_candidate_from_source(
    request: AcceptanceRequest<'_>,
    snapshot: &RepositorySnapshot,
    repository: &dyn RepositorySource,
) -> Result<AcceptanceOutcome, String> {
    acceptance::accept(request, snapshot, repository)
}

pub(crate) fn parse_json(bytes: &[u8], source: &str, label: &str) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("invalid {label} {source}: {error}"))
}

pub(crate) fn object<'a>(value: &'a Value, key: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("onboarding document requires object {key}"))
}

pub(crate) fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("onboarding document requires array {key}"))
}

pub(crate) fn required_text<'a>(
    value: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("onboarding document requires non-empty {key}"))
}

pub(crate) fn bool_field(value: &Map<String, Value>, key: &str) -> Result<bool, String> {
    value
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("onboarding document requires boolean {key}"))
}

pub(crate) fn u64_field(value: &Map<String, Value>, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("onboarding document requires unsigned integer {key}"))
}

pub(crate) fn bytes_root(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(crate) fn rooted(mut value: Value, field: &str) -> Value {
    let root = digest(&value);
    value
        .as_object_mut()
        .expect("rooted onboarding document is an object")
        .insert(field.to_owned(), Value::String(root));
    value
}

pub(crate) fn verify_root(value: &Value, field: &str, label: &str) -> Result<String, String> {
    let declared = value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} requires {field}"))?;
    let mut preimage = value.clone();
    preimage
        .as_object_mut()
        .ok_or_else(|| format!("{label} must be an object"))?
        .remove(field);
    let observed = digest(&preimage);
    if declared != observed {
        return Err(format!(
            "{label} root mismatch: declared {declared}, computed {observed}"
        ));
    }
    Ok(declared.to_owned())
}

pub(crate) fn stable(value: &Value) -> String {
    stable_json(value)
}

pub(crate) fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub(crate) fn sensitive_path(path: &str) -> bool {
    path.split('/').any(|part| {
        part == ".git"
            || part == ".private"
            || part == ".env"
            || part.starts_with(".env.")
            || part.eq_ignore_ascii_case("secrets")
            || part.eq_ignore_ascii_case("credentials.json")
            || part.eq_ignore_ascii_case("id_rsa")
            || part.eq_ignore_ascii_case("id_ed25519")
    })
}

pub(crate) fn generated_or_vendor_path(path: &str) -> Option<&'static str> {
    if path == ".xinfa/generated" || path.starts_with(".xinfa/generated/") {
        return Some("generated-xinfa-feedback");
    }
    if path.split('/').any(|part| {
        matches!(
            part,
            "node_modules" | "target" | "dist" | "build" | "vendor" | ".venv" | "__pycache__"
        )
    }) {
        return Some("generated-or-vendor");
    }
    None
}

pub(crate) fn id(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && chars.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

pub(crate) fn unique_strings(value: &Value, key: &str) -> Result<Vec<String>, String> {
    let values = array(value, key)?;
    let mut unique = BTreeSet::new();
    let mut output = Vec::new();
    for value in values {
        let item = value
            .as_str()
            .filter(|item| !item.is_empty())
            .ok_or_else(|| format!("{key} requires non-empty strings"))?;
        if !unique.insert(item.to_owned()) {
            return Err(format!("{key} contains duplicate value {item}"));
        }
        output.push(item.to_owned());
    }
    Ok(output)
}

#[cfg(test)]
mod qualification_tests {
    use super::*;
    use std::collections::BTreeMap;

    use crate::SourceReadError;

    struct Memory(BTreeMap<String, Vec<u8>>);

    impl RepositorySource for Memory {
        fn read(&self, relative: &str) -> Result<Vec<u8>, SourceReadError> {
            self.0
                .get(relative)
                .cloned()
                .ok_or_else(|| SourceReadError::new("missing-source", "fixture source missing"))
        }
    }

    fn fixture(case: &Value) -> (RepositorySnapshot, Memory) {
        let files = case["files"].as_array().expect("fixture files");
        let mut entries = Vec::new();
        let mut memory = BTreeMap::new();
        for (index, file) in files.iter().enumerate() {
            let path = file["path"].as_str().expect("fixture path");
            let bytes = file["text"]
                .as_str()
                .expect("fixture text")
                .as_bytes()
                .to_vec();
            entries.push(json!({
                "path":path, "state":"tracked", "mode":"100644",
                "object":format!("fixture-{index}"), "stage":0, "size":bytes.len()
            }));
            memory.insert(path.to_owned(), bytes);
        }
        let index_root = digest(&Value::Array(entries.clone()));
        (
            RepositorySnapshot::new(
                json!({"head":null,"tree":null,"indexRoot":index_root,"dirty":false}),
                entries,
            )
            .expect("fixture snapshot"),
            Memory(memory),
        )
    }

    #[test]
    fn seven_ecosystems_have_deterministic_evidence_and_candidates() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../fixtures/onboarding/ecosystem-corpus-v1.json"
        ))
        .expect("onboarding corpus");
        let cases = corpus["cases"].as_array().expect("corpus cases");
        assert_eq!(cases.len(), 7);
        for case in cases {
            let (snapshot, repository) = fixture(case);
            let first = discover_repository_value(&snapshot, &repository, None, "fixture")
                .expect("first inventory");
            let second = discover_repository_value(&snapshot, &repository, None, "fixture")
                .expect("second inventory");
            assert_eq!(first, second, "{} inventory drifted", case["id"]);
            let inventory: Value = serde_json::from_str(&first).expect("inventory JSON");
            let observed: BTreeSet<&str> = inventory["ecosystems"]
                .as_array()
                .expect("ecosystems")
                .iter()
                .filter_map(|value| value["id"].as_str())
                .collect();
            let expected: BTreeSet<&str> = case["expectedEcosystems"]
                .as_array()
                .expect("expected ecosystems")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(observed, expected, "{} ecosystem evidence", case["id"]);
            let candidate =
                candidate_from_inventory_bytes(first.as_bytes(), "fixture-a").expect("candidate");
            let candidate_again = candidate_from_inventory_bytes(first.as_bytes(), "fixture-b")
                .expect("candidate from another input reference");
            assert_eq!(
                candidate, candidate_again,
                "{} candidate drifted",
                case["id"]
            );
            let candidate_value: Value = serde_json::from_str(&candidate).expect("candidate JSON");
            assert_eq!(candidate_value["authoritative"], false);
            assert!(!candidate_value["proposals"]
                .as_array()
                .expect("proposals")
                .is_empty());
        }
    }

    #[test]
    fn two_non_isomorphic_consumers_complete_accept_and_compile() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../fixtures/onboarding/ecosystem-corpus-v1.json"
        ))
        .expect("onboarding corpus");
        for case in corpus["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .filter(|case| matches!(case["id"].as_str(), Some("rust-cargo" | "documentation")))
        {
            let (snapshot, repository) = fixture(case);
            let inventory = discover_repository_value(&snapshot, &repository, None, "fixture")
                .expect("inventory");
            let candidate =
                candidate_from_inventory_bytes(inventory.as_bytes(), "fixture").expect("candidate");
            let candidate_value: Value = serde_json::from_str(&candidate).expect("candidate JSON");
            let project_id = case["id"].as_str().expect("case id");
            let accepted: Vec<&str> = candidate_value["proposals"]
                .as_array()
                .expect("proposals")
                .iter()
                .filter(|proposal| project_id != "documentation" || proposal["path"] == "README.md")
                .filter_map(|proposal| proposal["id"].as_str())
                .collect();
            let entrypoint = candidate_value["proposals"]
                .as_array()
                .expect("proposals")
                .iter()
                .find(|proposal| proposal["path"] == "README.md")
                .or_else(|| candidate_value["proposals"].as_array()?.first())
                .and_then(|proposal| proposal["path"].as_str())
                .expect("entrypoint");
            let selection = stable(&json!({
                "schema":ONBOARDING_SELECTION_VERSION,
                "candidateRoot":candidate_value["candidateRoot"],
                "reviewer":"qualification-fixture",
                "project":{"id":project_id,"title":format!("{project_id} fixture")},
                "visibility":"public",
                "acceptedProposalIds":accepted,
                "routes":{
                    "parityGroup":format!("{project_id}.contributor"),
                    "visibility":"public",
                    "human":{"id":format!("{project_id}.human"),"entrypoints":[entrypoint]},
                    "agent":{"id":format!("{project_id}.agent"),"entrypoints":[entrypoint]},
                    "resolution":{
                        "subjects":["repository"],"capabilities":["onboarding"],
                        "owners":["project"],"roles":["contributor"],
                        "mission_tracks":["repository-onboarding"],"terms":[project_id]
                    }
                },
                "existingProject":{"replace":false,"expectedRoot":null}
            }));
            let dry_run = accept_candidate_from_source(
                AcceptanceRequest {
                    candidate_bytes: candidate.as_bytes(),
                    candidate_source: "fixture-candidate",
                    selection_bytes: selection.as_bytes(),
                    selection_source: "fixture-selection",
                    existing_project: None,
                    mode: "dry-run",
                },
                &snapshot,
                &repository,
            )
            .expect("accept and compile");
            let receipt: Value = serde_json::from_str(&dry_run.receipt).expect("receipt JSON");
            assert_eq!(receipt["status"], "planned");
            assert_eq!(receipt["qualification"]["verify"], "passed");
            assert!(!dry_run.execute);
            if project_id == "documentation" {
                let project: Value = serde_json::from_str(&dry_run.project).expect("project JSON");
                assert_eq!(project["providers"][0]["paths"], json!(["README.md"]));
            }
        }
    }
}
