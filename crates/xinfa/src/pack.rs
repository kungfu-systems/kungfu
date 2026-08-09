// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use super::{compile, digest, normalized, parse, stable_json, validate, visibility_rank};

mod impact;
mod source;
mod verification;

pub use impact::impact_between_values;
use source::collect_inventory;
#[cfg(test)]
use verification::verify_value;
pub use verification::{inspect_pack_value, verify_pack_artifacts};

const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct SourceReadError {
    code: &'static str,
    message: String,
}

impl SourceReadError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Host-owned source acquisition for the pure Xinfa compiler core.
///
/// Implementations must resolve an exact repository-relative path without
/// following symlinks. Native and WebAssembly hosts provide different
/// implementations while the compiler semantics remain shared.
pub trait RepositorySource {
    fn read(&self, relative: &str) -> Result<Vec<u8>, SourceReadError>;
}

#[derive(Clone, Debug)]
struct PackDiagnostic {
    code: String,
    severity: &'static str,
    path: String,
    message: String,
    provenance: Option<Value>,
}

impl PackDiagnostic {
    fn error(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            severity: "error",
            path: path.into(),
            message: message.into(),
            provenance: None,
        }
    }

    fn warning(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            severity: "warning",
            path: path.into(),
            message: message.into(),
            provenance: None,
        }
    }

    fn with_provenance(mut self, provenance: Value) -> Self {
        self.provenance = Some(provenance);
        self
    }

    fn value(&self) -> Value {
        json!({
            "code": self.code,
            "severity": self.severity,
            "path": self.path,
            "message": self.message,
            "provenance": self.provenance,
        })
    }
}

#[derive(Clone, Debug)]
pub struct PackArtifacts {
    pub pack: String,
    pub manifest: String,
    pub receipt: String,
    pub pack_root: String,
}

#[derive(Clone, Debug)]
pub struct PackCompileOutcome {
    pub artifacts: Option<PackArtifacts>,
    pub receipt: String,
}

fn byte_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn diagnostics_value(diagnostics: &[PackDiagnostic]) -> Vec<Value> {
    diagnostics.iter().map(PackDiagnostic::value).collect()
}

fn compile_receipt(
    verdict: &str,
    pack_root: Option<&str>,
    diagnostics: &[PackDiagnostic],
) -> Value {
    json!({
        "schema": "xinfa.context-pack-compile-receipt/v1",
        "verdict": verdict,
        "packRoot": pack_root,
        "qualifying": false,
        "selfCertified": false,
        "writesCache": false,
        "diagnostics": diagnostics_value(diagnostics),
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION")},
    })
}

fn complete_routes(
    project: &Value,
    visibility: &str,
    included_nodes: &BTreeSet<String>,
) -> Vec<Value> {
    let routes = project["routes"].as_array().expect("validated routes");
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for route in routes {
        groups
            .entry(route["parityGroup"].as_str().expect("parity group"))
            .or_default()
            .push(route);
    }
    let mut selected = Vec::new();
    for group in groups.values() {
        if group.len() != 2
            || group.iter().any(|route| {
                visibility_rank(route["visibility"].as_str().expect("visibility"))
                    > visibility_rank(visibility)
                    || route["nodes"]
                        .as_array()
                        .expect("route nodes")
                        .iter()
                        .any(|id| !included_nodes.contains(id.as_str().expect("node id")))
            })
        {
            continue;
        }
        selected.extend(group.iter().map(|route| (*route).clone()));
    }
    selected.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    selected
}

fn coverage_index(
    nodes: &[Value],
    edges: &[Value],
    routes: &[Value],
) -> (Value, Vec<PackDiagnostic>) {
    let kinds: BTreeMap<&str, &str> = nodes
        .iter()
        .map(|node| {
            (
                node["id"].as_str().expect("id"),
                node["kind"].as_str().expect("kind"),
            )
        })
        .collect();
    let mut claims = Vec::new();
    let mut diagnostics = Vec::new();
    for claim in nodes
        .iter()
        .filter(|node| node["kind"] == "claim" || node["kind"] == "invariant")
    {
        let id = claim["id"].as_str().expect("claim id");
        let mut documents = BTreeSet::new();
        let mut implementations = BTreeSet::new();
        let mut probes = BTreeSet::new();
        let mut evidence = BTreeSet::new();
        for edge in edges {
            let from = edge["from"].as_str().expect("from");
            let to = edge["to"].as_str().expect("to");
            let relation = edge["relation"].as_str().expect("relation");
            if to == id
                && matches!(relation, "explains" | "defines")
                && kinds.get(from) == Some(&"document")
            {
                documents.insert(from.to_owned());
            }
            if from == id && relation == "implements" && kinds.get(to) == Some(&"implementation") {
                implementations.insert(to.to_owned());
            }
            if to == id && relation == "proves" {
                match kinds.get(from).copied() {
                    Some("probe") => {
                        probes.insert(from.to_owned());
                    }
                    Some("evidence") => {
                        evidence.insert(from.to_owned());
                    }
                    _ => {}
                }
            }
        }
        for dependency in claim["verification"]["dependencies"]
            .as_array()
            .expect("dependencies")
        {
            let dependency_id = dependency["node"].as_str().expect("dependency id");
            match kinds.get(dependency_id).copied() {
                Some("implementation") => {
                    implementations.insert(dependency_id.to_owned());
                }
                Some("probe") => {
                    probes.insert(dependency_id.to_owned());
                }
                Some("evidence") => {
                    evidence.insert(dependency_id.to_owned());
                }
                _ => {}
            }
        }
        let route_ids: BTreeSet<String> = routes
            .iter()
            .filter(|route| {
                route["nodes"]
                    .as_array()
                    .expect("route nodes")
                    .iter()
                    .any(|node| node == id)
            })
            .map(|route| route["id"].as_str().expect("route id").to_owned())
            .collect();
        let mode = claim["verification"]["mode"].as_str().expect("mode");
        if matches!(mode, "machine" | "mixed") && implementations.is_empty() {
            diagnostics.push(PackDiagnostic::warning(
                "missing-implementation-coverage",
                format!("/nodes/{id}"),
                "machine-bearing claim has no implementation anchor",
            ));
        }
        if matches!(mode, "machine" | "mixed") && probes.is_empty() && evidence.is_empty() {
            diagnostics.push(PackDiagnostic::warning(
                "missing-proof-coverage",
                format!("/nodes/{id}"),
                "machine-bearing claim has no probe or evidence",
            ));
        }
        claims.push(json!({
            "claim": id,
            "status": claim["verification"]["status"],
            "documents": documents,
            "implementations": implementations,
            "probes": probes,
            "evidence": evidence,
            "routes": route_ids,
        }));
    }
    let mut implementations = Vec::new();
    for node in nodes.iter().filter(|node| node["kind"] == "implementation") {
        let id = node["id"].as_str().expect("implementation id");
        let covered_claims: BTreeSet<String> = claims
            .iter()
            .filter(|claim| {
                claim["implementations"]
                    .as_array()
                    .expect("implementations")
                    .iter()
                    .any(|item| item == id)
            })
            .map(|claim| claim["claim"].as_str().expect("claim").to_owned())
            .collect();
        let covered_documents: BTreeSet<String> = claims
            .iter()
            .filter(|claim| covered_claims.contains(claim["claim"].as_str().expect("claim")))
            .flat_map(|claim| claim["documents"].as_array().expect("documents").iter())
            .map(|item| item.as_str().expect("document").to_owned())
            .collect();
        let covered_routes: BTreeSet<String> = claims
            .iter()
            .filter(|claim| covered_claims.contains(claim["claim"].as_str().expect("claim")))
            .flat_map(|claim| claim["routes"].as_array().expect("routes").iter())
            .map(|item| item.as_str().expect("route").to_owned())
            .collect();
        implementations.push(json!({
            "implementation": id,
            "claims": covered_claims,
            "documents": covered_documents,
            "routes": covered_routes,
        }));
    }
    let routed: BTreeSet<&str> = routes
        .iter()
        .flat_map(|route| route["nodes"].as_array().expect("route nodes"))
        .filter_map(Value::as_str)
        .collect();
    let orphans: Vec<String> = nodes
        .iter()
        .filter_map(|node| node["id"].as_str())
        .filter(|id| !routed.contains(id))
        .map(str::to_owned)
        .collect();
    for orphan in &orphans {
        diagnostics.push(PackDiagnostic::warning(
            "orphan-node",
            format!("/nodes/{orphan}"),
            "node is not reachable from a published route",
        ));
    }
    (
        json!({"claims": claims, "implementations": implementations, "orphans": orphans}),
        diagnostics,
    )
}

fn build_pack(
    project: &Value,
    inventory: Vec<Value>,
    visibility: &str,
    mut diagnostics: Vec<PackDiagnostic>,
) -> PackArtifacts {
    let ir = compile(project);
    let nodes: Vec<Value> = ir["nodes"]
        .as_array()
        .expect("compiled nodes")
        .iter()
        .filter(|node| {
            visibility_rank(node["visibility"].as_str().expect("visibility"))
                <= visibility_rank(visibility)
        })
        .cloned()
        .collect();
    let included_nodes: BTreeSet<String> = nodes
        .iter()
        .map(|node| node["id"].as_str().expect("id").to_owned())
        .collect();
    let edges: Vec<Value> = ir["edges"]
        .as_array()
        .expect("compiled edges")
        .iter()
        .filter(|edge| {
            included_nodes.contains(edge["from"].as_str().expect("from"))
                && included_nodes.contains(edge["to"].as_str().expect("to"))
        })
        .cloned()
        .collect();
    let routes = complete_routes(&ir, visibility, &included_nodes);
    let (coverage, coverage_diagnostics) = coverage_index(&nodes, &edges, &routes);
    diagnostics.extend(coverage_diagnostics);
    diagnostics.sort_by(|left, right| (&left.path, &left.code).cmp(&(&right.path, &right.code)));

    let source_root = digest(&Value::Array(inventory.clone()));
    let policy_root = digest(&json!({
        "policies": project["policies"],
        "visibility": visibility,
        "routes": routes,
    }));
    let cut_root = digest(&project["cut"]);
    let authority_root = digest(&json!({"cut": project["cut"], "nodes": nodes, "edges": edges}));
    let coverage_root = digest(&coverage);
    let core = json!({
        "schema": "xinfa.context-pack/v1",
        "project": project["project"],
        "cut": project["cut"],
        "visibility": visibility,
        "policies": project["policies"],
        "roots": {
            "source": source_root,
            "policy": policy_root,
            "cut": cut_root,
            "authority": authority_root,
            "coverage": coverage_root,
        },
        "inventory": inventory,
        "nodes": nodes,
        "edges": edges,
        "routes": routes,
        "coverage": coverage,
        "diagnostics": diagnostics_value(&diagnostics),
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION"), "cacheUsed": false},
    });
    let pack_root = digest(&core);
    let mut pack = core;
    pack["roots"]
        .as_object_mut()
        .expect("roots")
        .insert("pack".to_owned(), Value::String(pack_root.clone()));
    let pack_bytes = stable_json(&pack);
    let manifest_core = json!({
        "schema": "xinfa.context-pack-manifest/v1",
        "project": project["project"]["id"],
        "cut": project["cut"],
        "packRoot": pack_root,
        "artifacts": [{"path": "pack.json", "contentRoot": byte_digest(pack_bytes.as_bytes()), "size": pack_bytes.len()}],
    });
    let manifest_root = digest(&manifest_core);
    let mut manifest = manifest_core;
    manifest.as_object_mut().expect("manifest").insert(
        "manifestRoot".to_owned(),
        Value::String(manifest_root.clone()),
    );
    let receipt_core = compile_receipt("pass", Some(&pack_root), &diagnostics);
    let mut receipt = receipt_core;
    receipt
        .as_object_mut()
        .expect("receipt")
        .insert("manifestRoot".to_owned(), Value::String(manifest_root));
    let receipt_root = digest(&receipt);
    receipt
        .as_object_mut()
        .expect("receipt")
        .insert("receiptRoot".to_owned(), Value::String(receipt_root));
    PackArtifacts {
        pack: pack_bytes,
        manifest: stable_json(&manifest),
        receipt: stable_json(&receipt),
        pack_root,
    }
}

pub fn compile_repository_pack_from_source(
    bytes: &[u8],
    source: &str,
    repository: &dyn RepositorySource,
    visibility: &str,
) -> Result<PackCompileOutcome, String> {
    if !matches!(visibility, "public" | "internal" | "private") {
        return Err("visibility must be public, internal, or private".to_owned());
    }
    let project = match parse(bytes) {
        Ok(project) => project,
        Err(message) => {
            let diagnostics = vec![PackDiagnostic::error("invalid-json", "/", message)];
            return Ok(PackCompileOutcome {
                artifacts: None,
                receipt: stable_json(&compile_receipt("fail", None, &diagnostics)),
            });
        }
    };
    let protocol_diagnostics = validate(&project);
    if !protocol_diagnostics.is_empty() {
        let diagnostics: Vec<PackDiagnostic> = protocol_diagnostics
            .iter()
            .map(|item| {
                PackDiagnostic::error(item.code, &item.path, &item.message).with_provenance(
                    json!({"source": if source == "-" { "stdin" } else { "file" }}),
                )
            })
            .collect();
        return Ok(PackCompileOutcome {
            artifacts: None,
            receipt: stable_json(&compile_receipt("fail", None, &diagnostics)),
        });
    }
    let normalized_project = normalized(&project);
    let (inventory, mut diagnostics) =
        collect_inventory(&normalized_project, repository, visibility);
    let included_nodes: BTreeSet<String> = normalized_project["nodes"]
        .as_array()
        .expect("validated nodes")
        .iter()
        .filter(|node| {
            visibility_rank(node["visibility"].as_str().expect("visibility"))
                <= visibility_rank(visibility)
        })
        .map(|node| node["id"].as_str().expect("id").to_owned())
        .collect();
    if included_nodes.is_empty()
        || complete_routes(&normalized_project, visibility, &included_nodes).is_empty()
    {
        diagnostics.push(PackDiagnostic::error(
            "empty-visibility-cut",
            "/visibility",
            "requested visibility has no complete dual-first route group",
        ));
    }
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == "error")
    {
        return Ok(PackCompileOutcome {
            artifacts: None,
            receipt: stable_json(&compile_receipt("fail", None, &diagnostics)),
        });
    }
    let artifacts = build_pack(&normalized_project, inventory, visibility, diagnostics);
    let receipt = artifacts.receipt.clone();
    Ok(PackCompileOutcome {
        artifacts: Some(artifacts),
        receipt,
    })
}

pub fn pack_value(artifacts: &PackArtifacts) -> Result<Value, String> {
    serde_json::from_str(&artifacts.pack).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compile_repository_pack_bytes, impact_between, verify_pack, write_pack_directory};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn fixture_root(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join(name)
    }

    fn compile_fixture(name: &str, visibility: &str) -> PackArtifacts {
        let root = fixture_root(name);
        let bytes = fs::read(root.join("project.json")).expect("project fixture");
        compile_repository_pack_bytes(&bytes, "fixture", &root, visibility)
            .expect("compile result")
            .artifacts
            .expect("valid pack")
    }

    fn owned_temp(label: &str) -> PathBuf {
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "xinfa-pack-test-{label}-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("owned temp root");
        path
    }

    #[test]
    fn clean_repository_compiles_to_stable_portable_pack() {
        let first = compile_fixture("repository-small", "public");
        let second = compile_fixture("repository-small", "public");
        assert_eq!(first.pack, second.pack);
        assert_eq!(first.manifest, second.manifest);
        assert_eq!(first.receipt, second.receipt);

        let pack = pack_value(&first).expect("pack JSON");
        let golden: Value = serde_json::from_str(include_str!(
            "../fixtures/golden/repository-small-pack-v1.json"
        ))
        .expect("golden JSON");
        assert_eq!(pack["schema"], "xinfa.context-pack/v1");
        assert_eq!(pack["roots"]["pack"], golden["packRoot"]);
        assert_eq!(pack["roots"]["source"], golden["sourceRoot"]);
        assert_eq!(pack["roots"]["policy"], golden["policyRoot"]);
        assert_eq!(pack["roots"]["cut"], golden["cutRoot"]);
        assert_eq!(pack["roots"]["authority"], golden["authorityRoot"]);
        assert_eq!(pack["roots"]["coverage"], golden["coverageRoot"]);
        let manifest: Value = serde_json::from_str(&first.manifest).expect("manifest JSON");
        let receipt: Value = serde_json::from_str(&first.receipt).expect("receipt JSON");
        assert_eq!(manifest["manifestRoot"], golden["manifestRoot"]);
        assert_eq!(receipt["receiptRoot"], golden["receiptRoot"]);
        assert_eq!(
            pack["routes"][0]["authorityRoot"],
            pack["routes"][1]["authorityRoot"]
        );
        assert_eq!(
            pack["coverage"]["claims"][0]["implementations"],
            json!(["small.impl.runtime"])
        );
        assert!(!first.pack.contains(env!("CARGO_MANIFEST_DIR")));
        assert!(verify_value(&pack).is_empty());
    }

    #[test]
    fn visibility_filter_keeps_complete_parity_groups_and_provenance() {
        let public = pack_value(&compile_fixture("repository-medium", "public")).expect("public");
        let internal =
            pack_value(&compile_fixture("repository-medium", "internal")).expect("internal");
        assert_eq!(public["routes"].as_array().expect("routes").len(), 2);
        assert_eq!(internal["routes"].as_array().expect("routes").len(), 4);
        assert!(!stable_json(&public).contains("operations.md"));
        assert!(stable_json(&internal).contains("operations.md"));
        assert!(public["routes"]
            .as_array()
            .expect("routes")
            .iter()
            .all(|route| route["visibility"] == "public"));
    }

    #[test]
    fn provider_drift_and_sensitive_paths_fail_without_artifacts() {
        let root = fixture_root("repository-small");
        let mut project: Value =
            serde_json::from_slice(&fs::read(root.join("project.json")).expect("project"))
                .expect("JSON");
        project["providers"][0]["revision"] = Value::String(format!("sha256:{}", "f".repeat(64)));
        let outcome = compile_repository_pack_bytes(
            stable_json(&project).as_bytes(),
            "fixture",
            &root,
            "public",
        )
        .expect("outcome");
        assert!(outcome.artifacts.is_none());
        assert!(outcome.receipt.contains("provider-drift"));

        let malicious = fixture_root("repository-malicious");
        let outcome = compile_repository_pack_bytes(
            &fs::read(malicious.join("project.json")).expect("project"),
            "fixture",
            &malicious,
            "public",
        )
        .expect("outcome");
        assert!(outcome.artifacts.is_none());
        assert!(outcome.receipt.contains("sensitive-path"));

        let fixture_directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let unsupported = compile_repository_pack_bytes(
            &fs::read(fixture_directory.join("project-beta.json")).expect("project"),
            "fixture",
            &fixture_directory,
            "internal",
        )
        .expect("outcome");
        assert!(unsupported.artifacts.is_none());
        assert!(unsupported.receipt.contains("unsupported-provider"));
    }

    #[test]
    fn generated_projection_cannot_feed_the_same_or_a_later_provider_implicitly() {
        let root = owned_temp("generated-feedback");
        fs::create_dir_all(root.join(".xinfa/generated")).expect("generated directory");
        fs::write(
            root.join(".xinfa/generated/task-chart.json"),
            "{\"derived\":true}\n",
        )
        .expect("generated projection");
        let fixture = fixture_root("repository-small");
        let mut project: Value =
            serde_json::from_slice(&fs::read(fixture.join("project.json")).expect("project"))
                .expect("JSON");
        project["providers"][0]["paths"] = json!([".xinfa/generated/task-chart.json"]);
        for node in project["nodes"].as_array_mut().expect("nodes") {
            node["source"]["path"] = json!(".xinfa/generated/task-chart.json");
        }
        for route in project["routes"].as_array_mut().expect("routes") {
            route["entrypoints"] = json!([".xinfa/generated/task-chart.json"]);
        }
        let outcome = compile_repository_pack_bytes(
            stable_json(&project).as_bytes(),
            "fixture",
            &root,
            "public",
        )
        .expect("outcome");
        assert!(outcome.artifacts.is_none());
        assert!(outcome.receipt.contains("generated-projection-input"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_source_fails_closed() {
        use std::os::unix::fs::symlink;

        let root = owned_temp("symlink");
        fs::write(root.join("target.json"), "{}\n").expect("target");
        symlink(root.join("target.json"), root.join("link.json")).expect("symlink");
        let malicious = fixture_root("repository-malicious");
        let mut project: Value =
            serde_json::from_slice(&fs::read(malicious.join("project.json")).expect("project"))
                .expect("JSON");
        project["providers"][0]["paths"][0] = Value::String("link.json".to_owned());
        project["nodes"][0]["source"]["path"] = Value::String("link.json".to_owned());
        project["routes"][0]["entrypoints"][0] = Value::String("link.json".to_owned());
        project["routes"][1]["entrypoints"][0] = Value::String("link.json".to_owned());
        let outcome = compile_repository_pack_bytes(
            stable_json(&project).as_bytes(),
            "fixture",
            &root,
            "public",
        )
        .expect("outcome");
        assert!(outcome.artifacts.is_none());
        assert!(outcome.receipt.contains("symlink-source"));
        fs::remove_dir_all(&root).expect("clean owned temp");
    }

    #[test]
    fn offline_directory_verify_survives_relocation_and_refuses_overwrite() {
        let artifacts = compile_fixture("repository-small", "public");
        let temp = owned_temp("offline");
        let first = temp.join("first");
        let relocated = temp.join("relocated");
        write_pack_directory(&first, &artifacts).expect("write pack");
        assert!(write_pack_directory(&first, &artifacts).is_err());
        fs::rename(&first, &relocated).expect("relocate pack");
        let (receipt, valid) = verify_pack(&relocated).expect("verify");
        assert!(valid, "{receipt}");
        let mut compile_receipt: Value =
            serde_json::from_slice(&fs::read(relocated.join("receipt.json")).expect("receipt"))
                .expect("receipt JSON");
        compile_receipt["verdict"] = Value::String("fail".to_owned());
        fs::write(
            relocated.join("receipt.json"),
            stable_json(&compile_receipt),
        )
        .expect("tamper receipt");
        let (_, valid) = verify_pack(&relocated).expect("tampered verify");
        assert!(!valid);
        fs::remove_dir_all(&temp).expect("clean owned temp");
    }

    fn impact_for_path(path: &str) -> Value {
        let artifacts = compile_fixture("repository-medium", "public");
        let temp = owned_temp("impact");
        let old = temp.join("old.json");
        fs::write(&old, &artifacts.pack).expect("old pack");
        let mut current = pack_value(&artifacts).expect("pack");
        let item = current["inventory"]
            .as_array_mut()
            .expect("inventory")
            .iter_mut()
            .find(|item| item["path"] == path)
            .expect("source path");
        item["contentRoot"] = Value::String(format!("sha256:{}", "a".repeat(64)));
        current["roots"]["source"] = Value::String(digest(&current["inventory"]));
        let impact: Value = serde_json::from_str(&impact_between(&old, &current).expect("impact"))
            .expect("impact JSON");
        fs::remove_dir_all(&temp).expect("clean owned temp");
        impact
    }

    #[test]
    fn impact_propagates_implementation_change_to_claim_document_and_routes() {
        let impact = impact_for_path("src/api.rs");
        assert_eq!(impact["affectedClaims"], json!(["medium.claim.api"]));
        assert!(impact["affectedDocuments"]
            .as_array()
            .expect("documents")
            .contains(&json!("medium.doc.api")));
        assert_eq!(
            impact["affectedRoutes"].as_array().expect("routes").len(),
            2
        );
    }

    #[test]
    fn changed_repository_fixture_has_one_explainable_source_impact() {
        let old = compile_fixture("repository-small", "public");
        let current =
            pack_value(&compile_fixture("repository-small-next", "public")).expect("current pack");
        let temp = owned_temp("changed-fixture");
        let old_path = temp.join("old.json");
        fs::write(&old_path, old.pack).expect("old pack");
        let impact: Value =
            serde_json::from_str(&impact_between(&old_path, &current).expect("changed impact"))
                .expect("impact JSON");
        assert_eq!(impact["changedSources"], json!(["src/runtime.rs"]));
        assert_eq!(impact["affectedClaims"], json!(["small.claim.greeting"]));
        assert_eq!(impact["affectedDocuments"], json!(["small.doc.guide"]));
        assert_eq!(
            impact["affectedRoutes"].as_array().expect("routes").len(),
            2
        );
        fs::remove_dir_all(&temp).expect("clean owned temp");
    }

    #[test]
    fn expressive_non_claim_change_does_not_create_claim_drift() {
        let impact = impact_for_path("README.md");
        assert_eq!(impact["affectedClaims"], json!([]));
        assert_eq!(impact["affectedDocuments"], json!(["medium.doc.readme"]));
        assert_eq!(
            impact["affectedRoutes"].as_array().expect("routes").len(),
            2
        );
    }
}
