// SPDX-License-Identifier: Apache-2.0

use crate::{digest, stable_json, verify_atlas};
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

pub const TASK_ENVELOPE_VERSION: &str = "xinfa.task-envelope/v1";
pub const ROUTE_RESOLUTION_VERSION: &str = "xinfa.route-resolution/v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RouteResolution {
    pub receipt: String,
    pub resolved: bool,
}

fn read_json(reference: &Path, filename: &str) -> Result<Value, String> {
    let path = if reference.is_dir() {
        reference.join(filename)
    } else {
        reference.to_path_buf()
    };
    serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("cannot read {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("invalid JSON in {}: {error}", path.display()))
}

fn strings(value: &Value, pointer: &str) -> BTreeSet<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|item| item.to_ascii_lowercase())
        .collect()
}

fn required_text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .ok_or_else(|| format!("task envelope requires non-empty {pointer}"))
}

fn exact_object<'a>(
    value: &'a Value,
    pointer: &str,
    fields: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("task envelope {pointer} must be an object"))?;
    let expected: BTreeSet<&str> = fields.iter().copied().collect();
    let observed: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    if observed != expected {
        let missing: Vec<&str> = expected.difference(&observed).copied().collect();
        let unknown: Vec<&str> = observed.difference(&expected).copied().collect();
        return Err(format!(
            "task envelope {pointer} has missing fields {missing:?} and unknown fields {unknown:?}"
        ));
    }
    Ok(object)
}

fn string_array(value: &Value, pointer: &str) -> Result<(), String> {
    let items = value
        .pointer(pointer)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("task envelope {pointer} must be an array"))?;
    let mut observed = BTreeSet::new();
    for item in items {
        let text = item
            .as_str()
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("task envelope {pointer} requires non-empty strings"))?;
        if !observed.insert(text.to_ascii_lowercase()) {
            return Err(format!(
                "task envelope {pointer} contains duplicate strings"
            ));
        }
    }
    Ok(())
}

fn validate_task_envelope(task: &Value) -> Result<(), String> {
    exact_object(
        task,
        "/",
        &[
            "schema",
            "kind",
            "objective",
            "audience",
            "role",
            "visibility",
            "mission",
            "acceptance",
            "subjects",
            "claims",
            "ownership",
            "dependencies",
            "required_capabilities",
            "required_authority",
            "requested_route",
            "requested_parity_group",
            "atlas",
        ],
    )?;
    exact_object(&task["mission"], "/mission", &["id", "lens", "track"])?;
    exact_object(&task["atlas"], "/atlas", &["atlas_root", "cut_root"])?;
    for pointer in [
        "/acceptance",
        "/subjects",
        "/claims",
        "/ownership",
        "/dependencies",
        "/required_capabilities",
        "/required_authority",
    ] {
        string_array(task, pointer)?;
    }
    for pointer in ["/mission/id", "/mission/lens", "/mission/track"] {
        required_text(task, pointer)?;
    }
    for pointer in ["/requested_route", "/requested_parity_group"] {
        let value = task
            .pointer(pointer)
            .ok_or_else(|| format!("task envelope requires {pointer}"))?;
        if !value.is_null() && value.as_str().is_none() {
            return Err(format!("task envelope {pointer} must be a string or null"));
        }
    }
    Ok(())
}

fn visibility_rank(value: &str) -> Option<usize> {
    ["public", "internal", "private"]
        .iter()
        .position(|candidate| *candidate == value)
}

fn ascii_terms(value: &str) -> BTreeSet<String> {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|item| item.len() >= 2)
        .collect()
}

fn route_vocabulary(atlas: &Value, route: &Value) -> BTreeSet<String> {
    let mut vocabulary = BTreeSet::new();
    for pointer in ["/id", "/parityGroup"] {
        if let Some(value) = route.pointer(pointer).and_then(Value::as_str) {
            vocabulary.extend(ascii_terms(value));
        }
    }
    for pointer in ["/entrypoints", "/nodes"] {
        for value in route
            .pointer(pointer)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            vocabulary.extend(ascii_terms(value));
        }
    }
    let selected = strings(route, "/nodes");
    for node in atlas
        .pointer("/semantic/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = node["id"].as_str() else {
            continue;
        };
        if !selected.contains(&id.to_ascii_lowercase()) {
            continue;
        }
        vocabulary.extend(ascii_terms(id));
        if let Some(path) = node.pointer("/source/path").and_then(Value::as_str) {
            vocabulary.extend(ascii_terms(path));
        }
    }
    vocabulary
}

fn task_lexical_text(task: &Value) -> String {
    let mut values = vec![task["objective"].as_str().unwrap_or_default().to_owned()];
    values.extend(
        task["acceptance"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    values.join(" ").to_ascii_lowercase()
}

fn candidate(atlas: &Value, task: &Value, route: &Value) -> Value {
    let route_id = route["id"].as_str().unwrap_or_default();
    let route_nodes = strings(route, "/nodes");
    let metadata = &route["resolution"];
    let route_subjects = strings(metadata, "/subjects");
    let route_capabilities = strings(metadata, "/capabilities");
    let route_owners = strings(metadata, "/owners");
    let route_roles = strings(metadata, "/roles");
    let route_tracks = strings(metadata, "/mission_tracks");
    let task_subjects = strings(task, "/subjects");
    let task_capabilities = strings(task, "/required_capabilities");
    let task_ownership = strings(task, "/ownership");
    let task_claims = strings(task, "/claims");
    let task_dependencies = strings(task, "/dependencies");
    let required_authority = strings(task, "/required_authority");
    let role = task["role"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mission_track = task
        .pointer("/mission/track")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let requested_parity = task["requested_parity_group"].as_str().unwrap_or_default();
    let requested_route = task["requested_route"].as_str().unwrap_or_default();
    let mut admissible = true;
    let mut omissions = Vec::new();
    let mut evidence = Vec::new();
    let mut structured_score = 0_i64;

    if metadata.is_null() || !metadata.is_object() {
        admissible = false;
        omissions.push(json!({"code": "route-intent-missing", "required": true}));
    }
    if route["audience"] != "agent" {
        admissible = false;
        omissions.push(json!({"code": "audience-mismatch", "required": true}));
    }
    if route["status"] != "current" {
        admissible = false;
        omissions.push(json!({"code": "route-not-current", "required": true}));
    }
    let requested_visibility = task["visibility"].as_str().unwrap_or("public");
    let route_visibility = route["visibility"].as_str().unwrap_or("private");
    if visibility_rank(route_visibility).unwrap_or(usize::MAX)
        > visibility_rank(requested_visibility).unwrap_or_default()
    {
        admissible = false;
        omissions.push(json!({"code": "visibility-broadening", "required": true}));
    }
    if !requested_route.is_empty() && route_id != requested_route {
        admissible = false;
        omissions.push(json!({"code": "requested-route-mismatch", "required": true}));
    }
    if !requested_parity.is_empty() && route["parityGroup"] != requested_parity {
        admissible = false;
        omissions.push(json!({"code": "requested-parity-mismatch", "required": true}));
    }
    if !route_roles.is_empty() && !route_roles.contains(&role) {
        admissible = false;
        omissions.push(json!({"code": "role-mismatch", "required": true, "role": role}));
    }
    for capability in task_capabilities.difference(&route_capabilities) {
        admissible = false;
        omissions.push(json!({"code": "required-capability-missing", "required": true, "capability": capability}));
    }
    for authority in required_authority.difference(&route_nodes) {
        admissible = false;
        omissions.push(
            json!({"code": "required-authority-missing", "required": true, "authority": authority}),
        );
    }

    for subject in task_subjects.intersection(&route_subjects) {
        structured_score += 40;
        evidence.push(json!({"kind": "subject", "value": subject}));
    }
    for owner in task_ownership.intersection(&route_owners) {
        structured_score += 30;
        evidence.push(json!({"kind": "ownership", "value": owner}));
    }
    for claim in task_claims.intersection(&route_nodes) {
        structured_score += 30;
        evidence.push(json!({"kind": "claim", "value": claim}));
    }
    for dependency in task_dependencies.intersection(&route_nodes) {
        structured_score += 25;
        evidence.push(json!({"kind": "dependency", "value": dependency}));
    }
    if !mission_track.is_empty() && route_tracks.contains(&mission_track) {
        structured_score += 35;
        evidence.push(json!({"kind": "mission-track", "value": mission_track}));
    }
    if route_roles.contains(&role) {
        structured_score += 10;
        evidence.push(json!({"kind": "role", "value": role}));
    }
    if !requested_route.is_empty() && route_id == requested_route {
        structured_score += 1000;
        evidence.push(json!({"kind": "explicit-route", "value": route_id}));
    }

    let text = task_lexical_text(task);
    let task_terms = ascii_terms(&text);
    let vocabulary = route_vocabulary(atlas, route);
    let mut lexical_matches = BTreeSet::new();
    for term in task_terms.intersection(&vocabulary) {
        lexical_matches.insert(term.clone());
    }
    for term in strings(metadata, "/terms") {
        if !term.is_empty() && text.contains(&term) {
            lexical_matches.insert(term);
        }
    }
    let lexical_score = i64::try_from(lexical_matches.len()).unwrap_or_default();
    for term in &lexical_matches {
        evidence.push(json!({"kind": "lexical-tiebreak", "value": term}));
    }
    evidence.sort_by_key(|item| {
        (
            item["kind"].as_str().unwrap_or_default().to_owned(),
            item["value"].as_str().unwrap_or_default().to_owned(),
        )
    });
    omissions.sort_by_key(stable_json);
    json!({
        "route_id": route_id,
        "parity_group": route["parityGroup"],
        "route_root": route["routeRoot"],
        "authority_root": route["authorityRoot"],
        "admissible": admissible,
        "score": structured_score * 100 + lexical_score,
        "structured_score": structured_score,
        "lexical_score": lexical_score,
        "evidence": evidence,
        "omissions": omissions,
    })
}

pub fn resolve_route_value(atlas: &Value, task: &Value) -> Result<RouteResolution, String> {
    validate_task_envelope(task)?;
    if task["schema"] != TASK_ENVELOPE_VERSION || task["kind"] != TASK_ENVELOPE_VERSION {
        return Err(format!("task envelope must be {TASK_ENVELOPE_VERSION}"));
    }
    required_text(task, "/objective")?;
    required_text(task, "/role")?;
    if task["audience"] != "agent" {
        return Err("automatic route resolution currently requires audience=agent".to_owned());
    }
    let visibility = required_text(task, "/visibility")?;
    if visibility_rank(visibility).is_none() {
        return Err("task envelope visibility must be public, internal, or private".to_owned());
    }
    let atlas_root = required_text(task, "/atlas/atlas_root")?;
    let cut_root = required_text(task, "/atlas/cut_root")?;
    if atlas["atlas_root"] != atlas_root || atlas.pointer("/roots/cut") != Some(&json!(cut_root)) {
        return Err("task envelope is not bound to this Atlas root and cut".to_owned());
    }

    let mut candidates: Vec<Value> = atlas["routes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|route| route["audience"] == "agent")
        .map(|route| candidate(atlas, task, route))
        .collect();
    candidates.sort_by_key(|item| {
        (
            Reverse(item["score"].as_i64().unwrap_or_default()),
            item["route_id"].as_str().unwrap_or_default().to_owned(),
        )
    });
    let admissible: Vec<&Value> = candidates
        .iter()
        .filter(|candidate| candidate["admissible"] == true)
        .collect();
    let requested = task["requested_route"]
        .as_str()
        .filter(|item| !item.is_empty());
    let top = admissible.first().copied();
    let second = admissible.get(1).copied();
    let margin = top
        .map(|item| item["score"].as_i64().unwrap_or_default())
        .unwrap_or_default()
        - second
            .map(|item| item["score"].as_i64().unwrap_or_default())
            .unwrap_or_default();
    let structured = top
        .map(|item| item["structured_score"].as_i64().unwrap_or_default())
        .unwrap_or_default();
    let tied = top.is_some()
        && second.is_some()
        && top.and_then(|item| item["score"].as_i64())
            == second.and_then(|item| item["score"].as_i64());
    let resolved = top.is_some()
        && !tied
        && structured > 0
        && (requested.is_some() || second.is_none() || margin >= 1000);
    let status = if resolved {
        "resolved"
    } else if admissible.is_empty() {
        "degraded"
    } else {
        "ambiguous"
    };
    let confidence = if resolved && requested.is_some() {
        "exact"
    } else if resolved && structured >= 40 {
        "high"
    } else if resolved {
        "medium"
    } else {
        "insufficient"
    };
    let selected_route = if resolved {
        top.map(|item| item["route_id"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let selected_route_root = if resolved {
        top.map(|item| item["route_root"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let selected_authority_root = if resolved {
        top.map(|item| item["authority_root"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let task_root = digest(task);
    let mut receipt = json!({
        "schema": ROUTE_RESOLUTION_VERSION,
        "kind": ROUTE_RESOLUTION_VERSION,
        "status": status,
        "confidence": confidence,
        "project_id": atlas["project_id"],
        "atlas_root": atlas["atlas_root"],
        "cut_root": atlas["roots"]["cut"],
        "task_root": task_root,
        "selected_route": selected_route,
        "route_root": selected_route_root,
        "authority_root": selected_authority_root,
        "candidates": candidates,
        "ambiguity": {
            "tied": tied,
            "margin": margin,
            "lexical_is_tiebreak_only": true
        },
        "omissions": if status == "resolved" { json!([]) } else { json!([{
            "code": if status == "ambiguous" { "unique-route-unproved" } else { "no-admissible-route" },
            "required": true
        }]) },
        "next_action": if status == "resolved" {
            "create and verify a Task Chart with the selected route"
        } else {
            "declare exact subjects, capabilities, ownership, Mission track, required authority, or requested_route; then resolve again"
        },
        "receipt_root": Value::Null
    });
    let root = digest(&receipt);
    receipt["receipt_root"] = json!(root);
    Ok(RouteResolution {
        receipt: stable_json(&receipt),
        resolved,
    })
}

pub fn resolve_route(atlas_ref: &Path, task_ref: &Path) -> Result<RouteResolution, String> {
    let task = fs::read(task_ref)
        .map_err(|error| format!("cannot read {}: {error}", task_ref.display()))?;
    resolve_route_bytes(atlas_ref, &task, &task_ref.display().to_string())
}

pub fn resolve_route_bytes(
    atlas_ref: &Path,
    task_bytes: &[u8],
    task_label: &str,
) -> Result<RouteResolution, String> {
    let (_, valid) = verify_atlas(atlas_ref)?;
    if !valid {
        return Err("route resolution requires a verified Xinfa Atlas".to_owned());
    }
    let atlas = read_json(atlas_ref, "atlas.json")?;
    let task = serde_json::from_slice(task_bytes)
        .map_err(|error| format!("invalid task envelope JSON in {task_label}: {error}"))?;
    resolve_route_value(&atlas, &task)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atlas() -> Value {
        json!({
            "project_id": "fixture",
            "atlas_root": format!("sha256:{}", "a".repeat(64)),
            "roots": {"cut": format!("sha256:{}", "b".repeat(64))},
            "semantic": {"nodes": [
                {"id": "core.claim.storage", "source": {"path": "docs/core/storage.md"}},
                {"id": "kfx.claim.extension", "source": {"path": "docs/kfx/extensions.md"}}
            ]},
            "routes": [
                {"id":"fixture.core.agent","audience":"agent","parityGroup":"fixture.core","visibility":"public","nodes":["core.claim.storage"],"entrypoints":["docs/core/README.md"],"routeRoot":format!("sha256:{}", "c".repeat(64)),"authorityRoot":format!("sha256:{}", "d".repeat(64)),"status":"current","resolution":{"subjects":["core","storage"],"capabilities":["implementation"],"owners":["core"],"roles":["implementer","reviewer"],"mission_tracks":["core-runtime"],"terms":["core","storage","存储"]}},
                {"id":"fixture.kfx.agent","audience":"agent","parityGroup":"fixture.kfx","visibility":"public","nodes":["kfx.claim.extension"],"entrypoints":["docs/kfx/README.md"],"routeRoot":format!("sha256:{}", "e".repeat(64)),"authorityRoot":format!("sha256:{}", "f".repeat(64)),"status":"current","resolution":{"subjects":["kfx","extension"],"capabilities":["implementation"],"owners":["kfx"],"roles":["implementer","reviewer"],"mission_tracks":["kfx-runtime"],"terms":["kfx","extension","扩展"]}}
            ]
        })
    }

    fn task() -> Value {
        json!({
            "schema": TASK_ENVELOPE_VERSION,
            "kind": TASK_ENVELOPE_VERSION,
            "objective": "修复核心存储并更新证据",
            "audience": "agent",
            "role": "implementer",
            "visibility": "public",
            "mission": {"id":"mission","lens":"principal-engineer","track":"core-runtime"},
            "acceptance": ["storage evidence remains exact"],
            "subjects": ["core","storage"],
            "claims": ["core.claim.storage"],
            "ownership": ["core"],
            "dependencies": [],
            "required_capabilities": ["implementation"],
            "required_authority": ["core.claim.storage"],
            "requested_route": null,
            "requested_parity_group": null,
            "atlas": {"atlas_root": format!("sha256:{}", "a".repeat(64)), "cut_root": format!("sha256:{}", "b".repeat(64))}
        })
    }

    #[test]
    fn structured_evidence_selects_one_route_deterministically() {
        let first = resolve_route_value(&atlas(), &task()).expect("resolution");
        let second = resolve_route_value(&atlas(), &task()).expect("resolution");
        assert!(first.resolved);
        assert_eq!(first.receipt, second.receipt);
        let receipt: Value = serde_json::from_str(&first.receipt).expect("receipt JSON");
        assert_eq!(receipt["selected_route"], "fixture.core.agent");
        assert_eq!(receipt["confidence"], "high");
    }

    #[test]
    fn lexical_signal_alone_never_claims_exact_resolution() {
        let mut task = task();
        task["subjects"] = json!([]);
        task["claims"] = json!([]);
        task["ownership"] = json!([]);
        task["required_authority"] = json!([]);
        task["required_capabilities"] = json!([]);
        task["mission"]["track"] = json!("unclassified");
        let outcome = resolve_route_value(&atlas(), &task).expect("resolution");
        assert!(!outcome.resolved);
        let receipt: Value = serde_json::from_str(&outcome.receipt).expect("receipt JSON");
        assert_eq!(receipt["status"], "ambiguous");
    }

    #[test]
    fn missing_required_capability_is_fail_visible() {
        let mut task = task();
        task["required_capabilities"] = json!(["release"]);
        let outcome = resolve_route_value(&atlas(), &task).expect("resolution");
        assert!(!outcome.resolved);
        let receipt: Value = serde_json::from_str(&outcome.receipt).expect("receipt JSON");
        assert_eq!(receipt["status"], "degraded");
        assert!(receipt["candidates"]
            .as_array()
            .expect("candidates")
            .iter()
            .all(|item| item["admissible"] == false));
    }
}
