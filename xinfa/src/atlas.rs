// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::pack::{
    compile_repository_pack_bytes, impact_between, pack_value, read_pack_value, verify_pack,
    PackArtifacts,
};
use super::{digest, stable_json};

pub const ATLAS_VERSION: &str = "xinfa.atlas/v1";

const COMPATIBILITY_PATH: &str = "compatibility/context-pack-v1";

#[derive(Clone, Debug)]
pub struct AtlasArtifacts {
    pub atlas: String,
    pub human_view: String,
    pub agent_view: String,
    pub manifest: String,
    pub receipt: String,
    pub context_pack: PackArtifacts,
    pub atlas_root: String,
}

#[derive(Clone, Debug)]
pub struct AtlasCompileOutcome {
    pub artifacts: Option<AtlasArtifacts>,
    pub receipt: String,
}

fn byte_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn atlas_schema_root() -> String {
    let schema = |source: &str| serde_json::from_str::<Value>(source).expect("embedded schema");
    digest(&json!({
        "project": schema(include_str!("../schema/project-v1.schema.json")),
        "context_pack": schema(include_str!("../schema/context-pack-v1.schema.json")),
        "context_pack_manifest": schema(include_str!("../schema/context-pack-manifest-v1.schema.json")),
        "context_pack_receipt": schema(include_str!("../schema/context-pack-receipt-v1.schema.json")),
        "atlas": schema(include_str!("../schema/atlas-v1.schema.json")),
        "atlas_view": schema(include_str!("../schema/atlas-view-v1.schema.json")),
        "atlas_manifest": schema(include_str!("../schema/atlas-manifest-v1.schema.json")),
        "atlas_receipt": schema(include_str!("../schema/atlas-receipt-v1.schema.json")),
    }))
}

fn artifact(path: &str, contents: &str) -> Value {
    json!({
        "path": path,
        "content_root": byte_digest(contents.as_bytes()),
        "size": contents.len(),
    })
}

fn diagnostics(receipt: &str) -> Value {
    serde_json::from_str::<Value>(receipt)
        .ok()
        .and_then(|value| value.get("diagnostics").cloned())
        .unwrap_or_else(|| json!([]))
}

fn failed_compile_receipt(pack_receipt: &str) -> String {
    stable_json(&json!({
        "schema": "xinfa.atlas-compile-receipt/v1",
        "verdict": "fail",
        "atlas_root": null,
        "context_pack_root": null,
        "qualifying": false,
        "selfCertified": false,
        "writesCache": false,
        "diagnostics": diagnostics(pack_receipt),
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION")},
    }))
}

fn shared_view(atlas_root: &str, pack: &Value) -> Value {
    let route_status: Vec<Value> = pack["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|route| {
            json!({
                "id": route["id"],
                "parityGroup": route["parityGroup"],
                "authorityRoot": route["authorityRoot"],
                "status": route["status"],
            })
        })
        .collect();
    let expansion_handles: Vec<Value> = pack["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|route| {
            json!({
                "route": route["id"],
                "routeRoot": route["routeRoot"],
                "nodes": route["nodes"],
            })
        })
        .collect();
    json!({
        "atlas_root": atlas_root,
        "project_id": pack.pointer("/project/id"),
        "cut": pack["cut"],
        "cut_root": pack.pointer("/roots/cut"),
        "visibility": pack["visibility"],
        "status": route_status,
        "evidence": pack.pointer("/coverage/claims").cloned().unwrap_or_else(|| json!([])),
        "omissions": pack.pointer("/coverage/orphans").cloned().unwrap_or_else(|| json!([])),
        "expansion_handles": expansion_handles,
    })
}

fn derived_view(audience: &str, atlas_root: &str, pack: &Value, shared: &Value) -> String {
    let routes: Vec<Value> = pack["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|route| route["audience"] == audience)
        .cloned()
        .collect();
    stable_json(&json!({
        "schema": "xinfa.atlas-view/v1",
        "kind": "xinfa.atlas-view/v1",
        "audience": audience,
        "atlas_root": atlas_root,
        "shared": shared,
        "routes": routes,
        "derived": true,
    }))
}

pub fn wrap_context_pack(context_pack: PackArtifacts) -> Result<AtlasArtifacts, String> {
    let pack = pack_value(&context_pack)?;
    let schema_root = atlas_schema_root();
    let invalidations: Vec<Value> = pack["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|node| {
            matches!(
                node.pointer("/verification/status").and_then(Value::as_str),
                Some("stale" | "invalidated")
            )
        })
        .map(|node| json!({"node": node["id"], "status": node["verification"]["status"]}))
        .collect();
    let gaps: Vec<Value> = pack["diagnostics"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|item| matches!(item["code"].as_str(), Some("coverage-gap" | "orphan-node")))
        .cloned()
        .collect();
    let conflicts: Vec<Value> = pack["diagnostics"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|item| item["severity"] == "error")
        .cloned()
        .collect();
    let expansion_index: Vec<Value> = pack["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|route| {
            json!({
                "id": route["id"],
                "audience": route["audience"],
                "parityGroup": route["parityGroup"],
                "routeRoot": route["routeRoot"],
                "authorityRoot": route["authorityRoot"],
                "status": route["status"],
                "nodes": route["nodes"],
            })
        })
        .collect();
    let core = json!({
        "schema": ATLAS_VERSION,
        "kind": ATLAS_VERSION,
        "concept_namespace": "xinfa",
        "primitive": "atlas",
        "project_id": pack.pointer("/project/id"),
        "lifecycle": "immutable",
        "root_algorithm": "sha256-canonical-json-v1",
        "project": pack["project"],
        "cut": pack["cut"],
        "visibility": pack["visibility"],
        "declared_scope": {
            "visibility": pack["visibility"],
            "source_root": pack.pointer("/roots/source"),
            "policy_root": pack.pointer("/roots/policy"),
            "schema_root": schema_root,
            "cut_root": pack.pointer("/roots/cut"),
        },
        "policy": {
            "policies": pack["policies"],
            "visibility": pack["visibility"],
            "routes": pack["routes"],
        },
        "roots": {
            "source": pack.pointer("/roots/source"),
            "policy": pack.pointer("/roots/policy"),
            "schema": schema_root,
            "cut": pack.pointer("/roots/cut"),
            "semantic": pack.pointer("/roots/authority"),
            "provenance": pack.pointer("/roots/source"),
            "verification": pack.pointer("/roots/coverage"),
            "context_pack": pack.pointer("/roots/pack"),
        },
        "semantic": {"nodes": pack["nodes"], "edges": pack["edges"]},
        "provenance": {"inventory": pack["inventory"]},
        "verification": {
            "coverage": pack["coverage"],
            "diagnostics": pack["diagnostics"],
            "gaps": gaps,
            "conflicts": conflicts,
            "invalidations": invalidations,
        },
        "routes": pack["routes"],
        "expansion_index": expansion_index,
        "compatibility": {
            "schema": "xinfa.context-pack/v1",
            "root": pack.pointer("/roots/pack"),
            "relationship": "immutable-input",
            "embedded_path": COMPATIBILITY_PATH,
            "reinterpretation": false,
        },
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION"), "cache_used": false},
    });
    let atlas_root = digest(&core);
    let mut atlas_value = core;
    atlas_value
        .as_object_mut()
        .expect("Atlas object")
        .insert("atlas_root".to_owned(), Value::String(atlas_root.clone()));
    let atlas = stable_json(&atlas_value);
    let shared = shared_view(&atlas_root, &pack);
    let human_view = derived_view("human", &atlas_root, &pack, &shared);
    let agent_view = derived_view("agent", &atlas_root, &pack, &shared);
    let manifest_core = json!({
        "schema": "xinfa.atlas-manifest/v1",
        "atlas_root": atlas_root,
        "context_pack_root": context_pack.pack_root,
        "artifacts": [
            artifact("atlas.json", &atlas),
            artifact("views/human.json", &human_view),
            artifact("views/agent.json", &agent_view),
            artifact(&format!("{COMPATIBILITY_PATH}/pack.json"), &context_pack.pack),
            artifact(&format!("{COMPATIBILITY_PATH}/manifest.json"), &context_pack.manifest),
            artifact(&format!("{COMPATIBILITY_PATH}/receipt.json"), &context_pack.receipt),
        ],
    });
    let manifest_root = digest(&manifest_core);
    let mut manifest_value = manifest_core;
    manifest_value.as_object_mut().expect("manifest").insert(
        "manifest_root".to_owned(),
        Value::String(manifest_root.clone()),
    );
    let manifest = stable_json(&manifest_value);
    let receipt_core = json!({
        "schema": "xinfa.atlas-compile-receipt/v1",
        "verdict": "pass",
        "atlas_root": atlas_root,
        "context_pack_root": context_pack.pack_root,
        "manifest_root": manifest_root,
        "qualifying": false,
        "selfCertified": false,
        "writesCache": false,
        "diagnostics": [],
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION")},
    });
    let receipt_root = digest(&receipt_core);
    let mut receipt_value = receipt_core;
    receipt_value
        .as_object_mut()
        .expect("receipt")
        .insert("receipt_root".to_owned(), Value::String(receipt_root));
    let receipt = stable_json(&receipt_value);
    Ok(AtlasArtifacts {
        atlas,
        human_view,
        agent_view,
        manifest,
        receipt,
        context_pack,
        atlas_root,
    })
}

pub fn compile_repository_atlas_bytes(
    project_bytes: &[u8],
    source: &str,
    repository_root: &Path,
    visibility: &str,
) -> Result<AtlasCompileOutcome, String> {
    let pack = compile_repository_pack_bytes(project_bytes, source, repository_root, visibility)?;
    let Some(context_pack) = pack.artifacts else {
        let receipt = failed_compile_receipt(&pack.receipt);
        return Ok(AtlasCompileOutcome {
            artifacts: None,
            receipt,
        });
    };
    let artifacts = wrap_context_pack(context_pack)?;
    let receipt = artifacts.receipt.clone();
    Ok(AtlasCompileOutcome {
        artifacts: Some(artifacts),
        receipt,
    })
}

pub fn import_context_pack(reference: &Path) -> Result<AtlasArtifacts, String> {
    if !reference.is_dir() {
        return Err("Atlas import requires a complete Context Pack directory".to_owned());
    }
    let (receipt, valid) = verify_pack(reference)?;
    if !valid {
        return Err(format!(
            "Context Pack verification failed: {}",
            receipt.trim()
        ));
    }
    let pack = fs::read_to_string(reference.join("pack.json"))
        .map_err(|error| format!("cannot read context pack artifact: {error}"))?;
    let manifest = fs::read_to_string(reference.join("manifest.json"))
        .map_err(|error| format!("cannot read context pack manifest: {error}"))?;
    let compile_receipt = fs::read_to_string(reference.join("receipt.json"))
        .map_err(|error| format!("cannot read context pack receipt: {error}"))?;
    let value: Value = serde_json::from_str(&pack).map_err(|error| error.to_string())?;
    let pack_root = value
        .pointer("/roots/pack")
        .and_then(Value::as_str)
        .ok_or_else(|| "Context Pack is missing roots.pack".to_owned())?
        .to_owned();
    wrap_context_pack(PackArtifacts {
        pack,
        manifest,
        receipt: compile_receipt,
        pack_root,
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

pub fn write_atlas_directory(output: &Path, artifacts: &AtlasArtifacts) -> Result<(), String> {
    if output.exists() {
        return Err(
            "output path already exists; Xinfa never overwrites an Atlas directory".to_owned(),
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
    let temporary = parent.join(format!(".{name}.xinfa-atlas-tmp-{}", std::process::id()));
    if temporary.exists() {
        return Err("owned temporary output already exists".to_owned());
    }
    fs::create_dir(&temporary)
        .map_err(|error| format!("cannot create temporary output: {error}"))?;
    let result = (|| {
        fs::create_dir(temporary.join("views"))
            .map_err(|error| format!("cannot create Atlas views directory: {error}"))?;
        let compatibility = temporary.join(COMPATIBILITY_PATH);
        fs::create_dir_all(&compatibility)
            .map_err(|error| format!("cannot create compatibility directory: {error}"))?;
        write_synced(&temporary.join("atlas.json"), &artifacts.atlas)?;
        write_synced(&temporary.join("views/human.json"), &artifacts.human_view)?;
        write_synced(&temporary.join("views/agent.json"), &artifacts.agent_view)?;
        write_synced(&temporary.join("manifest.json"), &artifacts.manifest)?;
        write_synced(&temporary.join("receipt.json"), &artifacts.receipt)?;
        write_synced(
            &compatibility.join("pack.json"),
            &artifacts.context_pack.pack,
        )?;
        write_synced(
            &compatibility.join("manifest.json"),
            &artifacts.context_pack.manifest,
        )?;
        write_synced(
            &compatibility.join("receipt.json"),
            &artifacts.context_pack.receipt,
        )?;
        fs::rename(&temporary, output)
            .map_err(|error| format!("cannot publish Atlas atomically: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn atlas_file(reference: &Path) -> PathBuf {
    if reference.is_dir() {
        reference.join("atlas.json")
    } else {
        reference.to_path_buf()
    }
}

fn read_atlas(reference: &Path) -> Result<Value, String> {
    let bytes =
        fs::read(atlas_file(reference)).map_err(|error| format!("cannot read Atlas: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid Atlas JSON: {error}"))
}

fn atlas_core(atlas: &Value) -> Result<Value, String> {
    let mut core = atlas.clone();
    core.as_object_mut()
        .and_then(|object| object.remove("atlas_root"))
        .ok_or_else(|| "Atlas is missing atlas_root".to_owned())?;
    Ok(core)
}

fn diagnostic(code: &str, path: &str, message: &str) -> Value {
    json!({"code": code, "severity": "error", "path": path, "message": message})
}

fn verify_atlas_value(atlas: &Value, diagnostics: &mut Vec<Value>) {
    if atlas["schema"] != ATLAS_VERSION || atlas["kind"] != ATLAS_VERSION {
        diagnostics.push(diagnostic(
            "atlas-schema",
            "/schema",
            "schema and kind must both be xinfa.atlas/v1",
        ));
        return;
    }
    if atlas["concept_namespace"] != "xinfa"
        || atlas["primitive"] != "atlas"
        || atlas["lifecycle"] != "immutable"
        || atlas["project_id"].as_str().unwrap_or_default().is_empty()
    {
        diagnostics.push(diagnostic(
            "atlas-identity",
            "/",
            "machine identity must declare xinfa, atlas, project_id, and immutable lifecycle",
        ));
    }
    let expected = atlas
        .pointer("/atlas_root")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match atlas_core(atlas) {
        Ok(core) if digest(&core) != expected => diagnostics.push(diagnostic(
            "atlas-root",
            "/atlas_root",
            "Atlas root does not match canonical Atlas content",
        )),
        Err(message) => diagnostics.push(diagnostic("atlas-root", "/atlas_root", &message)),
        _ => {}
    }
    let schema_root = atlas_schema_root();
    let component_checks = [
        ("/roots/source", digest(&atlas["provenance"]["inventory"])),
        (
            "/roots/provenance",
            digest(&atlas["provenance"]["inventory"]),
        ),
        ("/roots/policy", digest(&atlas["policy"])),
        ("/roots/schema", schema_root.clone()),
        ("/roots/cut", digest(&atlas["cut"])),
        (
            "/roots/semantic",
            digest(&json!({
                "cut": atlas["cut"],
                "nodes": atlas["semantic"]["nodes"],
                "edges": atlas["semantic"]["edges"],
            })),
        ),
        (
            "/roots/verification",
            digest(&atlas["verification"]["coverage"]),
        ),
    ];
    for (pointer, value) in component_checks {
        if atlas.pointer(pointer).and_then(Value::as_str) != Some(value.as_str()) {
            diagnostics.push(diagnostic(
                "component-root",
                pointer,
                "component root does not match canonical Atlas content",
            ));
        }
    }
    if atlas.pointer("/project_id") != atlas.pointer("/project/id")
        || atlas.pointer("/declared_scope/visibility") != atlas.pointer("/visibility")
        || atlas.pointer("/declared_scope/source_root") != atlas.pointer("/roots/source")
        || atlas.pointer("/declared_scope/policy_root") != atlas.pointer("/roots/policy")
        || atlas.pointer("/declared_scope/schema_root") != Some(&json!(schema_root))
        || atlas.pointer("/declared_scope/cut_root") != atlas.pointer("/roots/cut")
    {
        diagnostics.push(diagnostic(
            "declared-scope",
            "/declared_scope",
            "declared scope must bind the Atlas project, visibility, and component roots",
        ));
    }
    if atlas.pointer("/compatibility/schema") != Some(&json!("xinfa.context-pack/v1"))
        || atlas.pointer("/compatibility/relationship") != Some(&json!("immutable-input"))
        || atlas.pointer("/compatibility/reinterpretation") != Some(&json!(false))
        || atlas.pointer("/compatibility/embedded_path") != Some(&json!(COMPATIBILITY_PATH))
        || atlas.pointer("/compatibility/root") != atlas.pointer("/roots/context_pack")
    {
        diagnostics.push(diagnostic(
            "compatibility-contract",
            "/compatibility",
            "legacy Context Pack must be an immutable, non-reinterpreted input",
        ));
    }
}

fn read_string(path: &Path, label: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("cannot read {label}: {error}"))
}

pub fn verify_atlas(reference: &Path) -> Result<(String, bool), String> {
    let atlas = read_atlas(reference)?;
    let mut findings = Vec::new();
    verify_atlas_value(&atlas, &mut findings);
    if reference.is_dir() {
        let compatibility = reference.join(COMPATIBILITY_PATH);
        let (pack_receipt, pack_valid) = verify_pack(&compatibility)?;
        if !pack_valid {
            findings.push(diagnostic(
                "context-pack-invalid",
                "/compatibility",
                pack_receipt.trim(),
            ));
        }
        let pack = read_pack_value(&compatibility)?;
        if atlas.pointer("/project_id") != pack.pointer("/project/id")
            || atlas.pointer("/declared_scope/visibility") != atlas.pointer("/visibility")
            || atlas.pointer("/declared_scope/source_root") != pack.pointer("/roots/source")
            || atlas.pointer("/declared_scope/policy_root") != pack.pointer("/roots/policy")
            || atlas.pointer("/declared_scope/cut_root") != pack.pointer("/roots/cut")
            || atlas.pointer("/declared_scope/schema_root") != Some(&json!(atlas_schema_root()))
            || atlas.pointer("/roots/schema") != Some(&json!(atlas_schema_root()))
        {
            findings.push(diagnostic(
                "declared-scope",
                "/declared_scope",
                "declared source, policy, schema, and cut scope must match the verified inputs",
            ));
        }
        let linked = [
            ("/roots/source", "/roots/source"),
            ("/roots/policy", "/roots/policy"),
            ("/roots/cut", "/roots/cut"),
            ("/roots/semantic", "/roots/authority"),
            ("/roots/provenance", "/roots/source"),
            ("/roots/verification", "/roots/coverage"),
            ("/roots/context_pack", "/roots/pack"),
        ];
        for (atlas_pointer, pack_pointer) in linked {
            if atlas.pointer(atlas_pointer) != pack.pointer(pack_pointer) {
                findings.push(diagnostic(
                    "compatibility-root",
                    atlas_pointer,
                    "Atlas root link does not match the embedded Context Pack",
                ));
            }
        }
        if atlas.pointer("/semantic/nodes") != pack.pointer("/nodes")
            || atlas.pointer("/semantic/edges") != pack.pointer("/edges")
            || atlas.pointer("/provenance/inventory") != pack.pointer("/inventory")
            || atlas.pointer("/policy/policies") != pack.pointer("/policies")
            || atlas.pointer("/policy/visibility") != pack.pointer("/visibility")
            || atlas.pointer("/policy/routes") != pack.pointer("/routes")
            || atlas.pointer("/verification/coverage") != pack.pointer("/coverage")
            || atlas.pointer("/verification/diagnostics") != pack.pointer("/diagnostics")
            || atlas.pointer("/routes") != pack.pointer("/routes")
            || atlas.pointer("/cut") != pack.pointer("/cut")
        {
            findings.push(diagnostic(
                "compatibility-content",
                "/compatibility",
                "Atlas projections diverge from the embedded Context Pack",
            ));
        }
        let human_text = read_string(&reference.join("views/human.json"), "human view")?;
        let agent_text = read_string(&reference.join("views/agent.json"), "Agent view")?;
        let human: Value = serde_json::from_str(&human_text)
            .map_err(|error| format!("invalid human view JSON: {error}"))?;
        let agent: Value = serde_json::from_str(&agent_text)
            .map_err(|error| format!("invalid Agent view JSON: {error}"))?;
        let atlas_root = atlas["atlas_root"].as_str().unwrap_or_default();
        let expected_shared = shared_view(atlas_root, &pack);
        let expected_human: Value =
            serde_json::from_str(&derived_view("human", atlas_root, &pack, &expected_shared))
                .expect("derived human view");
        let expected_agent: Value =
            serde_json::from_str(&derived_view("agent", atlas_root, &pack, &expected_shared))
                .expect("derived Agent view");
        if human != expected_human || agent != expected_agent || human["shared"] != agent["shared"]
        {
            findings.push(diagnostic(
                "view-parity",
                "/views",
                "human and Agent views must be exact derived projections of the same Atlas facts",
            ));
        }
        let atlas_text = read_string(&reference.join("atlas.json"), "Atlas artifact")?;
        let pack_text = read_string(&compatibility.join("pack.json"), "context pack")?;
        let pack_manifest_text = read_string(
            &compatibility.join("manifest.json"),
            "context pack manifest",
        )?;
        let pack_receipt_text =
            read_string(&compatibility.join("receipt.json"), "context pack receipt")?;
        let expected_artifacts = vec![
            artifact("atlas.json", &atlas_text),
            artifact("views/human.json", &human_text),
            artifact("views/agent.json", &agent_text),
            artifact(&format!("{COMPATIBILITY_PATH}/pack.json"), &pack_text),
            artifact(
                &format!("{COMPATIBILITY_PATH}/manifest.json"),
                &pack_manifest_text,
            ),
            artifact(
                &format!("{COMPATIBILITY_PATH}/receipt.json"),
                &pack_receipt_text,
            ),
        ];
        let manifest_text = read_string(&reference.join("manifest.json"), "Atlas manifest")?;
        let manifest: Value = serde_json::from_str(&manifest_text)
            .map_err(|error| format!("invalid Atlas manifest JSON: {error}"))?;
        let mut manifest_core = manifest.clone();
        manifest_core
            .as_object_mut()
            .and_then(|object| object.remove("manifest_root"));
        if manifest["schema"] != "xinfa.atlas-manifest/v1"
            || manifest["atlas_root"] != atlas["atlas_root"]
            || manifest["context_pack_root"] != pack["roots"]["pack"]
            || manifest["artifacts"] != Value::Array(expected_artifacts)
            || digest(&manifest_core) != manifest["manifest_root"].as_str().unwrap_or_default()
        {
            findings.push(diagnostic(
                "manifest-binding",
                "/manifest",
                "Atlas manifest does not bind the exact Atlas, views, and compatibility artifacts",
            ));
        }
        let receipt_text = read_string(&reference.join("receipt.json"), "Atlas receipt")?;
        let receipt: Value = serde_json::from_str(&receipt_text)
            .map_err(|error| format!("invalid Atlas receipt JSON: {error}"))?;
        let mut receipt_core = receipt.clone();
        receipt_core
            .as_object_mut()
            .and_then(|object| object.remove("receipt_root"));
        if receipt["schema"] != "xinfa.atlas-compile-receipt/v1"
            || receipt["verdict"] != "pass"
            || receipt["atlas_root"] != atlas["atlas_root"]
            || receipt["context_pack_root"] != pack["roots"]["pack"]
            || receipt["manifest_root"] != manifest["manifest_root"]
            || receipt["qualifying"] != false
            || receipt["selfCertified"] != false
            || digest(&receipt_core) != receipt["receipt_root"].as_str().unwrap_or_default()
        {
            findings.push(diagnostic(
                "receipt-binding",
                "/receipt",
                "Atlas receipt does not bind the verified artifacts",
            ));
        }
    }
    findings.sort_by(|left, right| {
        (left["path"].as_str(), left["code"].as_str())
            .cmp(&(right["path"].as_str(), right["code"].as_str()))
    });
    let valid = findings.is_empty();
    Ok((
        stable_json(&json!({
            "schema": "xinfa.atlas-verification-receipt/v1",
            "valid": valid,
            "qualifying": false,
            "selfCertified": false,
            "atlas_root": atlas.pointer("/atlas_root"),
            "context_pack_root": atlas.pointer("/roots/context_pack"),
            "diagnostics": findings,
        })),
        valid,
    ))
}

pub fn inspect_atlas(reference: &Path) -> Result<String, String> {
    let atlas = read_atlas(reference)?;
    let statuses = atlas["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .fold(BTreeMap::<String, usize>::new(), |mut counts, route| {
            let status = route["status"].as_str().unwrap_or("unknown").to_owned();
            *counts.entry(status).or_default() += 1;
            counts
        });
    Ok(stable_json(&json!({
        "schema": "xinfa.atlas-inspection/v1",
        "kind": atlas["kind"],
        "concept_namespace": atlas["concept_namespace"],
        "primitive": atlas["primitive"],
        "project_id": atlas["project_id"],
        "atlas_root": atlas["atlas_root"],
        "project": atlas["project"],
        "cut": atlas["cut"],
        "visibility": atlas["visibility"],
        "roots": atlas["roots"],
        "counts": {
            "sources": atlas.pointer("/provenance/inventory").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "nodes": atlas.pointer("/semantic/nodes").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "edges": atlas.pointer("/semantic/edges").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "routes": atlas.pointer("/routes").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "expansion_handles": atlas.pointer("/expansion_index").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        },
        "statuses": statuses,
        "compatibility": atlas["compatibility"],
    })))
}

pub fn diff_atlases(before: &Path, after: &Path) -> Result<String, String> {
    if !before.is_dir() || !after.is_dir() {
        return Err("Atlas diff requires two complete Atlas directories".to_owned());
    }
    let (before_receipt, before_valid) = verify_atlas(before)?;
    let (after_receipt, after_valid) = verify_atlas(after)?;
    if !before_valid || !after_valid {
        return Err(format!(
            "Atlas diff requires verified inputs: before={} after={}",
            before_receipt.trim(),
            after_receipt.trim()
        ));
    }
    let old = read_atlas(before)?;
    let new = read_atlas(after)?;
    let names = [
        "source",
        "policy",
        "schema",
        "cut",
        "semantic",
        "provenance",
        "verification",
        "context_pack",
    ];
    let mut changed_roots: Vec<String> = names
        .iter()
        .copied()
        .filter(|name| old["roots"][*name] != new["roots"][*name])
        .map(str::to_owned)
        .collect();
    if old["atlas_root"] != new["atlas_root"] {
        changed_roots.push("atlas_root".to_owned());
    }
    let pack_impact: Value = serde_json::from_str(&impact_between(
        &before.join(COMPATIBILITY_PATH),
        &read_pack_value(&after.join(COMPATIBILITY_PATH))?,
    )?)
    .map_err(|error| error.to_string())?;
    Ok(stable_json(&json!({
        "schema": "xinfa.atlas-diff/v1",
        "before_atlas_root": old.pointer("/atlas_root"),
        "after_atlas_root": new.pointer("/atlas_root"),
        "unchanged": changed_roots.is_empty(),
        "changed_roots": changed_roots,
        "impact": pack_impact,
    })))
}

pub fn impact_from_atlas(since: &Path, current: &AtlasArtifacts) -> Result<String, String> {
    if !since.is_dir() {
        return Err("Atlas impact requires a complete prior Atlas directory".to_owned());
    }
    let (receipt, valid) = verify_atlas(since)?;
    if !valid {
        return Err(format!(
            "prior Atlas verification failed: {}",
            receipt.trim()
        ));
    }
    let old = read_atlas(since)?;
    let new: Value = serde_json::from_str(&current.atlas).map_err(|error| error.to_string())?;
    let current_pack = pack_value(&current.context_pack)?;
    let impact: Value = serde_json::from_str(&impact_between(
        &since.join(COMPATIBILITY_PATH),
        &current_pack,
    )?)
    .map_err(|error| error.to_string())?;
    Ok(stable_json(&json!({
        "schema": "xinfa.atlas-impact/v1",
        "before_atlas_root": old.pointer("/atlas_root"),
        "after_atlas_root": new.pointer("/atlas_root"),
        "impact": impact,
    })))
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

    fn compile_fixture(name: &str) -> AtlasArtifacts {
        let root = fixture_root(name);
        let project = fs::read(root.join("project.json")).expect("fixture");
        compile_repository_atlas_bytes(&project, "fixture", &root, "public")
            .expect("compile")
            .artifacts
            .expect("Atlas")
    }

    fn owned_output(label: &str) -> (PathBuf, PathBuf) {
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let parent = std::env::temp_dir().join(format!(
            "xinfa-atlas-test-{label}-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&parent).expect("temp parent");
        let output = parent.join("atlas");
        (parent, output)
    }

    #[test]
    fn atlas_is_a_distinct_immutable_wrapper_over_the_legacy_pack() {
        let first = compile_fixture("repository-small");
        let second = compile_fixture("repository-small");
        let golden: Value = serde_json::from_str(include_str!(
            "../fixtures/golden/repository-small-atlas-v1.json"
        ))
        .expect("Atlas golden");
        assert_eq!(first.atlas, second.atlas);
        assert_eq!(first.atlas_root, second.atlas_root);
        assert_ne!(first.atlas_root, first.context_pack.pack_root);
        assert_eq!(first.atlas_root, golden["atlas_root"]);
        assert_eq!(first.context_pack.pack_root, golden["context_pack_root"]);
        let manifest: Value = serde_json::from_str(&first.manifest).expect("manifest");
        let receipt: Value = serde_json::from_str(&first.receipt).expect("receipt");
        assert_eq!(manifest["manifest_root"], golden["manifest_root"]);
        assert_eq!(receipt["receipt_root"], golden["receipt_root"]);
        let atlas: Value = serde_json::from_str(&first.atlas).expect("Atlas JSON");
        assert_eq!(atlas["schema"], ATLAS_VERSION);
        assert_eq!(atlas["kind"], ATLAS_VERSION);
        assert_eq!(atlas["concept_namespace"], "xinfa");
        assert_eq!(atlas["primitive"], "atlas");
        assert_eq!(atlas["project_id"], "small");
        assert_eq!(atlas["atlas_root"], golden["atlas_root"]);
        assert_eq!(atlas["roots"]["schema"], golden["schema_root"]);
        assert_eq!(atlas["compatibility"]["reinterpretation"], false);
    }

    #[test]
    fn human_and_agent_views_share_one_object_identity() {
        let artifacts = compile_fixture("repository-small");
        let human: Value = serde_json::from_str(&artifacts.human_view).expect("human");
        let agent: Value = serde_json::from_str(&artifacts.agent_view).expect("agent");
        assert_eq!(human["atlas_root"], agent["atlas_root"]);
        assert_eq!(human["shared"], agent["shared"]);
        assert_ne!(human["routes"], agent["routes"]);
    }

    #[test]
    fn written_atlas_verifies_with_embedded_pack_bytes_unchanged() {
        let artifacts = compile_fixture("repository-small");
        let (parent, output) = owned_output("verify");
        write_atlas_directory(&output, &artifacts).expect("write");
        let (receipt, valid) = verify_atlas(&output).expect("verify");
        assert!(valid, "{receipt}");
        assert_eq!(
            fs::read_to_string(output.join(COMPATIBILITY_PATH).join("pack.json"))
                .expect("embedded pack"),
            artifacts.context_pack.pack
        );
        fs::remove_dir_all(parent).expect("cleanup owned temp");
    }

    #[test]
    fn tampered_atlas_fails_closed_without_reinterpreting_the_pack() {
        let artifacts = compile_fixture("repository-small");
        let (parent, output) = owned_output("tamper");
        write_atlas_directory(&output, &artifacts).expect("write");
        let mut atlas: Value = serde_json::from_str(
            &fs::read_to_string(output.join("atlas.json")).expect("Atlas artifact"),
        )
        .expect("Atlas JSON");
        atlas["primitive"] = Value::String("not-atlas".to_owned());
        fs::write(output.join("atlas.json"), stable_json(&atlas)).expect("tamper owned output");
        let (receipt, valid) = verify_atlas(&output).expect("verification receipt");
        assert!(!valid);
        assert!(receipt.contains("atlas-root"));
        assert_eq!(
            fs::read_to_string(output.join(COMPATIBILITY_PATH).join("pack.json"))
                .expect("embedded pack"),
            artifacts.context_pack.pack
        );
        fs::remove_dir_all(parent).expect("cleanup owned temp");
    }

    #[test]
    fn terminology_keeps_project_and_compiled_primitive_distinct() {
        let contract: Value = serde_json::from_str(include_str!(
            "../fixtures/terminology/atlas-project-and-primitive-v1.json"
        ))
        .expect("terminology contract");
        assert_eq!(
            contract["canonicalSentence"],
            "The Atlas project compiles a Xinfa Atlas"
        );
        assert_ne!(contract["projectTerm"], contract["primitiveTerm"]);
        assert_eq!(
            contract["forbiddenEquivalences"].as_array().unwrap().len(),
            2
        );
    }
}
