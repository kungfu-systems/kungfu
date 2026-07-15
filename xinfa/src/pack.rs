// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use super::{compile, digest, normalized, parse, stable_json, validate, visibility_rank};

const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;

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

fn sensitive_path(relative: &str) -> bool {
    relative.split('/').any(|part| {
        part == ".git"
            || part == ".private"
            || part == ".env"
            || part.starts_with(".env.")
            || part.eq_ignore_ascii_case("secrets")
            || part.eq_ignore_ascii_case("credentials.json")
    })
}

fn checked_source(root: &Path, relative: &str) -> Result<(Vec<u8>, u64), PackDiagnostic> {
    if sensitive_path(relative) {
        return Err(PackDiagnostic::error(
            "sensitive-path",
            relative,
            "sensitive path classes cannot enter a context pack",
        ));
    }
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(component) = component else {
            return Err(PackDiagnostic::error(
                "invalid-path",
                relative,
                "source path must remain repository relative",
            ));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            PackDiagnostic::error(
                "missing-source",
                relative,
                format!("declared source cannot be read: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(PackDiagnostic::error(
                "symlink-source",
                relative,
                "declared sources and their parent components must not be symlinks",
            ));
        }
    }
    let metadata = fs::metadata(&current).map_err(|error| {
        PackDiagnostic::error(
            "missing-source",
            relative,
            format!("declared source cannot be inspected: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(PackDiagnostic::error(
            "unsupported-source-type",
            relative,
            "declared source must be a regular file",
        ));
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(PackDiagnostic::error(
            "source-too-large",
            relative,
            format!("declared source exceeds the {MAX_SOURCE_BYTES} byte v1 limit"),
        ));
    }
    let bytes = fs::read(&current).map_err(|error| {
        PackDiagnostic::error(
            "source-read",
            relative,
            format!("declared source cannot be read: {error}"),
        )
    })?;
    Ok((bytes, metadata.len()))
}

fn provider_inventory_root(entries: &[Value]) -> String {
    digest(&Value::Array(
        entries
            .iter()
            .map(|entry| {
                json!({
                    "path": entry["path"],
                    "contentRoot": entry["contentRoot"],
                    "size": entry["size"],
                })
            })
            .collect(),
    ))
}

fn collect_inventory(
    project: &Value,
    root: &Path,
    visibility: &str,
) -> (Vec<Value>, Vec<PackDiagnostic>) {
    let mut inventory = Vec::new();
    let mut diagnostics = Vec::new();
    for provider in project["providers"]
        .as_array()
        .expect("validated providers")
    {
        let provider_visibility = provider["visibility"].as_str().expect("visibility");
        if visibility_rank(provider_visibility) > visibility_rank(visibility) {
            continue;
        }
        let id = provider["id"].as_str().expect("provider id");
        let kind = provider["kind"].as_str().expect("provider kind");
        if kind != "exact-file-manifest" {
            diagnostics.push(
                PackDiagnostic::error(
                    "unsupported-provider",
                    format!("/providers/{id}"),
                    "repository pack v1 accepts only exact-file-manifest providers",
                )
                .with_provenance(json!({"provider": id, "kind": kind})),
            );
            continue;
        }
        let mut provider_entries = Vec::new();
        for path in provider["paths"].as_array().expect("provider paths") {
            let relative = path.as_str().expect("validated path");
            match checked_source(root, relative) {
                Ok((bytes, size)) => match String::from_utf8(bytes) {
                    Ok(content) => provider_entries.push(json!({
                        "path": relative,
                        "contentRoot": byte_digest(content.as_bytes()),
                        "size": size,
                        "encoding": "utf-8",
                        "content": content,
                    })),
                    Err(_) => diagnostics.push(
                        PackDiagnostic::error(
                            "unsupported-encoding",
                            relative,
                            "repository pack v1 accepts only UTF-8 source units",
                        )
                        .with_provenance(json!({"provider": id})),
                    ),
                },
                Err(error) => diagnostics.push(error.with_provenance(json!({"provider": id}))),
            }
        }
        provider_entries.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        let actual = provider_inventory_root(&provider_entries);
        let expected = provider["revision"].as_str().expect("provider revision");
        if actual != expected {
            diagnostics.push(
                PackDiagnostic::error(
                    "provider-drift",
                    format!("/providers/{id}/revision"),
                    format!(
                        "declared provider revision {expected} does not match observed {actual}"
                    ),
                )
                .with_provenance(json!({"provider": id, "expected": expected, "observed": actual})),
            );
        }
        for entry in provider_entries {
            inventory.push(json!({
                "provider": id,
                "visibility": provider_visibility,
                "path": entry["path"],
                "contentRoot": entry["contentRoot"],
                "size": entry["size"],
                "encoding": entry["encoding"],
                "content": entry["content"],
            }));
        }
    }
    inventory.sort_by(|left, right| {
        (left["provider"].as_str(), left["path"].as_str())
            .cmp(&(right["provider"].as_str(), right["path"].as_str()))
    });
    let mut owners = BTreeMap::new();
    for item in &inventory {
        let path = item["path"].as_str().expect("inventory path");
        let provider = item["provider"].as_str().expect("inventory provider");
        if let Some(previous) = owners.insert(path, provider) {
            diagnostics.push(
                PackDiagnostic::error(
                    "duplicate-source-owner",
                    path,
                    "one repository path must not be acquired by multiple providers",
                )
                .with_provenance(json!({"providers": [previous, provider]})),
            );
        }
    }
    (inventory, diagnostics)
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

pub fn compile_repository_pack_bytes(
    bytes: &[u8],
    source: &str,
    repository_root: &Path,
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
    let root_metadata = fs::symlink_metadata(repository_root)
        .map_err(|error| format!("cannot inspect repository root: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("repository root must be a real directory, not a symlink".to_owned());
    }
    let normalized_project = normalized(&project);
    let (inventory, mut diagnostics) =
        collect_inventory(&normalized_project, repository_root, visibility);
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

fn write_synced(path: &Path, contents: &str) -> Result<(), String> {
    let mut file =
        File::create(path).map_err(|error| format!("cannot create artifact: {error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("cannot write artifact: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("cannot sync artifact: {error}"))
}

pub fn write_pack_directory(output: &Path, artifacts: &PackArtifacts) -> Result<(), String> {
    if output.exists() {
        return Err(
            "output path already exists; Xinfa never overwrites a pack directory".to_owned(),
        );
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("output parent must already exist".to_owned());
    }
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "output must have a portable UTF-8 basename".to_owned())?;
    let temporary = parent.join(format!(".{name}.xinfa-tmp-{}", std::process::id()));
    if temporary.exists() {
        return Err("owned temporary output already exists".to_owned());
    }
    fs::create_dir(&temporary)
        .map_err(|error| format!("cannot create temporary output: {error}"))?;
    let result = (|| {
        write_synced(&temporary.join("pack.json"), &artifacts.pack)?;
        write_synced(&temporary.join("manifest.json"), &artifacts.manifest)?;
        write_synced(&temporary.join("receipt.json"), &artifacts.receipt)?;
        fs::rename(&temporary, output)
            .map_err(|error| format!("cannot publish pack atomically: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn pack_file(reference: &Path) -> PathBuf {
    if reference.is_dir() {
        reference.join("pack.json")
    } else {
        reference.to_path_buf()
    }
}

fn read_json(reference: &Path) -> Result<Value, String> {
    let path = pack_file(reference);
    let bytes = fs::read(&path).map_err(|error| format!("cannot read pack: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid pack JSON: {error}"))
}

fn pack_core(pack: &Value) -> Result<Value, String> {
    let mut core = pack.clone();
    core.pointer_mut("/roots")
        .and_then(Value::as_object_mut)
        .and_then(|roots| roots.remove("pack"))
        .ok_or_else(|| "pack is missing roots.pack".to_owned())?;
    Ok(core)
}

fn verify_value(pack: &Value) -> Vec<PackDiagnostic> {
    let mut diagnostics = Vec::new();
    if pack["schema"] != "xinfa.context-pack/v1" {
        diagnostics.push(PackDiagnostic::error(
            "pack-schema",
            "/schema",
            "must be xinfa.context-pack/v1",
        ));
        return diagnostics;
    }
    let expected = pack
        .pointer("/roots/pack")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match pack_core(pack) {
        Ok(core) if digest(&core) != expected => diagnostics.push(PackDiagnostic::error(
            "pack-root",
            "/roots/pack",
            "pack root does not match canonical pack content",
        )),
        Err(message) => {
            diagnostics.push(PackDiagnostic::error("pack-root", "/roots/pack", message))
        }
        _ => {}
    }
    if let Some(inventory) = pack["inventory"].as_array() {
        for item in inventory {
            let path = item["path"].as_str().unwrap_or_default();
            let content = item["content"].as_str();
            if item["encoding"] != "utf-8" || content.is_none() {
                diagnostics.push(PackDiagnostic::error(
                    "source-encoding",
                    format!("/inventory/{path}"),
                    "source unit must contain UTF-8 payload",
                ));
                continue;
            }
            let bytes = content.expect("checked content").as_bytes();
            if byte_digest(bytes) != item["contentRoot"].as_str().unwrap_or_default()
                || item["size"].as_u64() != Some(bytes.len() as u64)
            {
                diagnostics.push(PackDiagnostic::error(
                    "source-content-root",
                    format!("/inventory/{path}"),
                    "source payload does not match its content root and size",
                ));
            }
        }
    } else {
        diagnostics.push(PackDiagnostic::error(
            "source-inventory",
            "/inventory",
            "pack inventory must be an array",
        ));
    }
    for (field, value) in [
        ("source", &pack["inventory"]),
        ("coverage", &pack["coverage"]),
        ("cut", &pack["cut"]),
    ] {
        let expected = pack["roots"][field].as_str().unwrap_or_default();
        if digest(value) != expected {
            diagnostics.push(PackDiagnostic::error(
                "component-root",
                format!("/roots/{field}"),
                format!("{field} root does not match content"),
            ));
        }
    }
    let authority = json!({"cut": pack["cut"], "nodes": pack["nodes"], "edges": pack["edges"]});
    if digest(&authority) != pack["roots"]["authority"].as_str().unwrap_or_default() {
        diagnostics.push(PackDiagnostic::error(
            "component-root",
            "/roots/authority",
            "authority root does not match content",
        ));
    }
    let policy = json!({"policies": pack["policies"], "visibility": pack["visibility"], "routes": pack["routes"]});
    if digest(&policy) != pack["roots"]["policy"].as_str().unwrap_or_default() {
        diagnostics.push(PackDiagnostic::error(
            "component-root",
            "/roots/policy",
            "policy root does not match content",
        ));
    }
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    let nodes: BTreeMap<&str, &Value> = pack["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|node| Some((node["id"].as_str()?, node)))
        .collect();
    if let Some(routes) = pack["routes"].as_array() {
        for route in routes {
            let selected: Vec<Value> = route["nodes"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|id| {
                    let id = id.as_str()?;
                    let node = nodes.get(id)?;
                    Some(json!({
                        "id": id,
                        "revision": node["revision"],
                        "status": node["verification"]["status"],
                    }))
                })
                .collect();
            if selected.len() != route["nodes"].as_array().map(Vec::len).unwrap_or_default()
                || digest(&Value::Array(selected))
                    != route["authorityRoot"].as_str().unwrap_or_default()
            {
                diagnostics.push(PackDiagnostic::error(
                    "route-authority-root",
                    format!("/routes/{}", route["id"].as_str().unwrap_or_default()),
                    "route authority root does not match selected nodes",
                ));
            }
            let mut source_route = route.clone();
            if let Some(object) = source_route.as_object_mut() {
                object.remove("authorityRoot");
                object.remove("routeRoot");
                object.remove("status");
            }
            if digest(&source_route) != route["routeRoot"].as_str().unwrap_or_default() {
                diagnostics.push(PackDiagnostic::error(
                    "route-root",
                    format!("/routes/{}", route["id"].as_str().unwrap_or_default()),
                    "route root does not match route declaration",
                ));
            }
            let expected_status = if route["nodes"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|id| nodes.get(id))
                .any(|node| {
                    matches!(
                        node["verification"]["status"].as_str(),
                        Some("stale" | "invalidated")
                    )
                }) {
                "stale"
            } else {
                "current"
            };
            if route["status"] != expected_status {
                diagnostics.push(PackDiagnostic::error(
                    "route-status",
                    format!("/routes/{}", route["id"].as_str().unwrap_or_default()),
                    "route status does not match selected node status",
                ));
            }
            groups
                .entry(route["parityGroup"].as_str().unwrap_or_default())
                .or_default()
                .push(route);
        }
    }
    for (group, routes) in groups {
        if routes.len() != 2
            || routes
                .iter()
                .map(|route| route["audience"].as_str())
                .collect::<BTreeSet<_>>()
                .len()
                != 2
            || routes[0]["authorityRoot"] != routes[1]["authorityRoot"]
            || routes[0]["status"] != routes[1]["status"]
        {
            diagnostics.push(PackDiagnostic::error(
                "route-parity",
                "/routes",
                format!("parity group {group} does not preserve dual-first authority"),
            ));
        }
    }
    if let (Some(nodes), Some(edges), Some(routes)) = (
        pack["nodes"].as_array(),
        pack["edges"].as_array(),
        pack["routes"].as_array(),
    ) {
        let (coverage, _) = coverage_index(nodes, edges, routes);
        if coverage != pack["coverage"] {
            diagnostics.push(PackDiagnostic::error(
                "coverage-index",
                "/coverage",
                "coverage index does not match the authority graph",
            ));
        }
    }
    diagnostics
}

pub fn inspect_pack(reference: &Path) -> Result<String, String> {
    let pack = read_json(reference)?;
    let statuses: BTreeMap<String, usize> = pack["nodes"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .fold(BTreeMap::new(), |mut counts, node| {
            let status = node
                .pointer("/verification/status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            *counts.entry(status).or_default() += 1;
            counts
        });
    Ok(stable_json(&json!({
        "schema": "xinfa.context-pack-inspection/v1",
        "project": pack["project"],
        "cut": pack["cut"],
        "visibility": pack["visibility"],
        "roots": pack["roots"],
        "counts": {
            "sources": pack["inventory"].as_array().map(Vec::len).unwrap_or(0),
            "nodes": pack["nodes"].as_array().map(Vec::len).unwrap_or(0),
            "edges": pack["edges"].as_array().map(Vec::len).unwrap_or(0),
            "routes": pack["routes"].as_array().map(Vec::len).unwrap_or(0),
        },
        "statuses": statuses,
        "coverage": {
            "claims": pack.pointer("/coverage/claims").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "orphans": pack.pointer("/coverage/orphans").cloned().unwrap_or_else(|| json!([])),
        },
        "diagnostics": pack["diagnostics"],
    })))
}

pub fn verify_pack(reference: &Path) -> Result<(String, bool), String> {
    let pack = read_json(reference)?;
    let mut diagnostics = verify_value(&pack);
    if reference.is_dir() {
        let manifest_bytes = fs::read(reference.join("manifest.json"))
            .map_err(|error| format!("cannot read manifest: {error}"))?;
        let manifest: Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("invalid manifest JSON: {error}"))?;
        let pack_bytes = fs::read(reference.join("pack.json"))
            .map_err(|error| format!("cannot read pack: {error}"))?;
        if manifest["schema"] != "xinfa.context-pack-manifest/v1"
            || manifest["packRoot"] != pack["roots"]["pack"]
            || manifest["artifacts"][0]["contentRoot"] != byte_digest(&pack_bytes)
            || manifest["artifacts"][0]["size"].as_u64() != Some(pack_bytes.len() as u64)
        {
            diagnostics.push(PackDiagnostic::error(
                "artifact-root",
                "/artifacts/0",
                "manifest does not bind the exact pack.json artifact",
            ));
        }
        let mut manifest_core = manifest.clone();
        manifest_core
            .as_object_mut()
            .and_then(|object| object.remove("manifestRoot"));
        if digest(&manifest_core) != manifest["manifestRoot"].as_str().unwrap_or_default() {
            diagnostics.push(PackDiagnostic::error(
                "manifest-root",
                "/manifestRoot",
                "manifest root does not match content",
            ));
        }
        let receipt_bytes = fs::read(reference.join("receipt.json"))
            .map_err(|error| format!("cannot read receipt: {error}"))?;
        let receipt: Value = serde_json::from_slice(&receipt_bytes)
            .map_err(|error| format!("invalid receipt JSON: {error}"))?;
        if receipt["schema"] != "xinfa.context-pack-compile-receipt/v1"
            || receipt["verdict"] != "pass"
            || receipt["packRoot"] != pack["roots"]["pack"]
            || receipt["manifestRoot"] != manifest["manifestRoot"]
            || receipt["qualifying"] != false
            || receipt["selfCertified"] != false
        {
            diagnostics.push(PackDiagnostic::error(
                "receipt-binding",
                "/receipt",
                "compile receipt does not bind the verified Pack and manifest",
            ));
        }
        let mut receipt_core = receipt.clone();
        receipt_core
            .as_object_mut()
            .and_then(|object| object.remove("receiptRoot"));
        if digest(&receipt_core) != receipt["receiptRoot"].as_str().unwrap_or_default() {
            diagnostics.push(PackDiagnostic::error(
                "receipt-root",
                "/receiptRoot",
                "receipt root does not match content",
            ));
        }
    }
    diagnostics.sort_by(|left, right| (&left.path, &left.code).cmp(&(&right.path, &right.code)));
    let valid = diagnostics.is_empty();
    let receipt = json!({
        "schema": "xinfa.context-pack-verification-receipt/v1",
        "valid": valid,
        "qualifying": false,
        "selfCertified": false,
        "packRoot": pack.pointer("/roots/pack"),
        "diagnostics": diagnostics_value(&diagnostics),
    });
    Ok((stable_json(&receipt), valid))
}

fn node_map(pack: &Value) -> BTreeMap<String, Value> {
    pack["nodes"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|node| node["id"].as_str().map(|id| (id.to_owned(), node.clone())))
        .collect()
}

fn changed_sources(old: &Value, new: &Value) -> BTreeSet<String> {
    fn roots(value: &Value) -> BTreeMap<String, String> {
        value["inventory"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|item| {
                Some((
                    item["path"].as_str()?.to_owned(),
                    item["contentRoot"].as_str()?.to_owned(),
                ))
            })
            .collect()
    }
    let old = roots(old);
    let new = roots(new);
    old.keys()
        .chain(new.keys())
        .filter(|path| old.get(*path) != new.get(*path))
        .cloned()
        .collect()
}

fn reverse_dependents(pack: &Value) -> BTreeMap<String, BTreeSet<String>> {
    let mut reverse: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for node in pack["nodes"].as_array().unwrap_or(&Vec::new()) {
        let id = node["id"].as_str().unwrap_or_default();
        for dependency in node
            .pointer("/verification/dependencies")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            if let Some(target) = dependency["node"].as_str() {
                reverse
                    .entry(target.to_owned())
                    .or_default()
                    .insert(id.to_owned());
            }
        }
    }
    for edge in pack["edges"].as_array().unwrap_or(&Vec::new()) {
        let from = edge["from"].as_str().unwrap_or_default();
        let to = edge["to"].as_str().unwrap_or_default();
        match edge["relation"].as_str().unwrap_or_default() {
            "proves" => {
                reverse
                    .entry(from.to_owned())
                    .or_default()
                    .insert(to.to_owned());
            }
            "explains" | "defines" | "implements" | "depends-on" | "expands-to" => {
                reverse
                    .entry(to.to_owned())
                    .or_default()
                    .insert(from.to_owned());
            }
            _ => {}
        }
    }
    reverse
}

pub fn impact_between(old_reference: &Path, new_pack: &Value) -> Result<String, String> {
    let old = read_json(old_reference)?;
    let changed_paths = changed_sources(&old, new_pack);
    let old_nodes = node_map(&old);
    let new_nodes = node_map(new_pack);
    let mut seeds: BTreeSet<String> = old_nodes
        .keys()
        .chain(new_nodes.keys())
        .filter(|id| old_nodes.get(*id) != new_nodes.get(*id))
        .cloned()
        .collect();
    for (id, node) in old_nodes.iter().chain(new_nodes.iter()) {
        if node
            .pointer("/source/path")
            .and_then(Value::as_str)
            .is_some_and(|path| changed_paths.contains(path))
        {
            seeds.insert(id.clone());
        }
    }
    let reverse = reverse_dependents(new_pack);
    let mut affected = seeds.clone();
    let mut queue: VecDeque<String> = seeds.into_iter().collect();
    while let Some(id) = queue.pop_front() {
        for dependent in reverse.get(&id).into_iter().flatten() {
            if affected.insert(dependent.clone()) {
                queue.push_back(dependent.clone());
            }
        }
    }
    let kinds: BTreeMap<String, String> = old_nodes
        .iter()
        .chain(new_nodes.iter())
        .filter_map(|(id, node)| Some((id.clone(), node["kind"].as_str()?.to_owned())))
        .collect();
    let select_kind = |kind: &str| -> Vec<String> {
        affected
            .iter()
            .filter(|id| {
                kinds
                    .get(*id)
                    .is_some_and(|value| value == kind || (kind == "claim" && value == "invariant"))
            })
            .cloned()
            .collect()
    };
    let affected_routes: Vec<String> = new_pack["routes"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter(|route| {
            route["nodes"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .any(|id| id.as_str().is_some_and(|id| affected.contains(id)))
        })
        .filter_map(|route| route["id"].as_str().map(str::to_owned))
        .collect();
    Ok(stable_json(&json!({
        "schema": "xinfa.context-pack-impact/v1",
        "since": old.pointer("/roots/pack"),
        "current": new_pack.pointer("/roots/pack"),
        "changedSources": changed_paths,
        "affectedNodes": affected,
        "affectedClaims": select_kind("claim"),
        "affectedDocuments": select_kind("document"),
        "affectedRoutes": affected_routes,
    })))
}

pub fn pack_value(artifacts: &PackArtifacts) -> Result<Value, String> {
    serde_json::from_str(&artifacts.pack).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
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
