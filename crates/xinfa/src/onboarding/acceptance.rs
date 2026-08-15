// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use super::candidate::{ecosystem_terms, proposal_map, verified_candidate};
use super::discovery::request_from_inventory;
use super::{
    bool_field, discover_repository_value, id, object, parse_json, required_text, rooted,
    unique_strings, verify_root, AcceptanceOutcome, AcceptanceRequest, RepositorySnapshot,
    ONBOARDING_ACCEPTANCE_VERSION, ONBOARDING_SELECTION_VERSION,
};
use crate::{
    compile_repository_atlas_from_source, digest, stable_json,
    validate_project_bytes_with_validity, verify_atlas_artifacts, RepositorySource,
};

fn node_id(project: &str, path: &str) -> String {
    let root = format!("{:x}", Sha256::digest(path.as_bytes()));
    format!("{project}.source.{}", &root[..24])
}

fn exact_resolution(value: &Value) -> Result<Value, String> {
    let resolution = value
        .as_object()
        .ok_or_else(|| "selection route resolution must be an object".to_owned())?;
    let allowed: BTreeSet<&str> = [
        "subjects",
        "capabilities",
        "owners",
        "roles",
        "mission_tracks",
        "terms",
    ]
    .into_iter()
    .collect();
    let observed: BTreeSet<&str> = resolution.keys().map(String::as_str).collect();
    if observed != allowed {
        return Err("selection route resolution must declare exactly subjects, capabilities, owners, roles, mission_tracks, and terms".to_owned());
    }
    let mut output = Map::new();
    for key in allowed {
        let mut values = unique_strings(value, key)?;
        if values.is_empty() {
            return Err(format!(
                "selection route resolution {key} must not be empty"
            ));
        }
        values.sort();
        output.insert(key.to_owned(), json!(values));
    }
    Ok(Value::Object(output))
}

fn route(
    routes: &Map<String, Value>,
    audience: &str,
    parity_group: &str,
    nodes: &[String],
    accepted_paths: &BTreeSet<String>,
    resolution: &Value,
) -> Result<Value, String> {
    let route = routes
        .get(audience)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("selection routes requires {audience}"))?;
    let route_id = required_text(route, "id")?;
    if !id(route_id) {
        return Err(format!("selection {audience} route id is invalid"));
    }
    let mut entrypoints = route
        .get("entrypoints")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("selection {audience} route requires entrypoints"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| accepted_paths.contains(*value))
                .map(str::to_owned)
                .ok_or_else(|| {
                    format!("selection {audience} route entrypoint must be an accepted path")
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entrypoints.sort();
    entrypoints.dedup();
    if entrypoints.is_empty() {
        return Err(format!(
            "selection {audience} route requires at least one accepted entrypoint"
        ));
    }
    Ok(json!({
        "id": route_id,
        "audience": audience,
        "parityGroup": parity_group,
        "visibility": routes["visibility"],
        "nodes": nodes,
        "entrypoints": entrypoints,
        "resolution": resolution,
    }))
}

fn existing_root(existing: Option<&[u8]>) -> Result<(Option<Value>, Option<String>), String> {
    let Some(bytes) = existing else {
        return Ok((None, None));
    };
    let value = parse_json(bytes, ".xinfa/project.json", "existing Xinfa project")?;
    Ok((Some(value.clone()), Some(digest(&value))))
}

fn provider_paths(project: Option<&Value>) -> BTreeSet<String> {
    project
        .and_then(|project| project.get("providers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|provider| {
            provider
                .get("paths")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn project_from_selection(
    candidate: &Value,
    selection: &Value,
    existing: Option<&[u8]>,
) -> Result<(Value, Value), String> {
    let selection_object = selection
        .as_object()
        .ok_or_else(|| "onboarding selection must be an object".to_owned())?;
    let project = object(selection, "project")?;
    let project_id = required_text(project, "id")?;
    let title = required_text(project, "title")?;
    if !id(project_id) {
        return Err("selection project id is invalid".to_owned());
    }
    let visibility = required_text(selection_object, "visibility")?;
    if !matches!(visibility, "public" | "internal" | "private") {
        return Err("selection visibility must be public, internal, or private".to_owned());
    }
    let accepted_ids = unique_strings(selection, "acceptedProposalIds")?;
    if accepted_ids.is_empty() {
        return Err("selection must accept at least one proposal".to_owned());
    }
    let proposals = proposal_map(candidate)?;
    let mut selected = Vec::new();
    for proposal_id in accepted_ids {
        selected.push(
            proposals
                .get(&proposal_id)
                .cloned()
                .ok_or_else(|| format!("selection references unknown proposal {proposal_id}"))?,
        );
    }
    selected.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
    let accepted_paths: BTreeSet<String> = selected
        .iter()
        .map(|proposal| proposal["path"].as_str().expect("proposal path").to_owned())
        .collect();
    let provider_entries: Vec<Value> = selected
        .iter()
        .map(|proposal| {
            json!({
                "path": proposal["path"],
                "contentRoot": proposal["observed"]["contentRoot"],
                "size": proposal["observed"]["size"],
            })
        })
        .collect();
    let provider_revision = digest(&Value::Array(provider_entries));
    let nodes: Vec<Value> = selected
        .iter()
        .map(|proposal| {
            let path = proposal["path"].as_str().expect("proposal path");
            json!({
                "id": node_id(project_id, path),
                "kind": proposal["inference"]["nodeKind"],
                "visibility": visibility,
                "revision": proposal["observed"]["contentRoot"],
                "provenance": {"kind":"project-source", "authority":project_id},
                "source": {"provider":format!("{project_id}.files"), "path":path},
                "verification": {"mode":"non-claim", "status":"non-claim", "dependencies":[], "waiver":null}
            })
        })
        .collect();
    let node_ids: Vec<String> = nodes
        .iter()
        .map(|node| node["id"].as_str().expect("node id").to_owned())
        .collect();
    let routes = object(selection, "routes")?;
    let parity_group = required_text(routes, "parityGroup")?;
    if !id(parity_group) {
        return Err("selection parity group is invalid".to_owned());
    }
    let route_visibility = required_text(routes, "visibility")?;
    if route_visibility != visibility {
        return Err("selection route visibility must equal project visibility".to_owned());
    }
    let resolution = exact_resolution(
        routes
            .get("resolution")
            .ok_or_else(|| "selection routes requires resolution".to_owned())?,
    )?;
    let human = route(
        routes,
        "human",
        parity_group,
        &node_ids,
        &accepted_paths,
        &resolution,
    )?;
    let agent = route(
        routes,
        "agent",
        parity_group,
        &node_ids,
        &accepted_paths,
        &resolution,
    )?;
    let cut_revision = digest(&json!({
        "candidateRoot": candidate["candidateRoot"],
        "acceptedProposalIds": selection["acceptedProposalIds"],
        "project": selection["project"],
        "routes": selection["routes"],
    }));
    let value = json!({
        "$schema": "https://xinfa.dev/schema/project-v1.schema.json",
        "schema": "xinfa.project/v1",
        "project": {"id": project_id, "title": title},
        "cut": {"id":format!("{project_id}.onboarding"), "revision":cut_revision},
        "roots": [{"id":"repository", "path":".", "visibility":visibility}],
        "providers": [{
            "id":format!("{project_id}.files"), "kind":"exact-file-manifest", "authority":"project",
            "visibility":visibility, "root":"repository", "paths":accepted_paths.iter().collect::<Vec<_>>(),
            "revision":provider_revision
        }],
        "nodes":nodes,
        "edges":[],
        "routes":[agent,human],
        "policies": {
            "unknownFields":"reject", "pathSemantics":"repository-relative-posix",
            "visibility":"fail-closed", "dualFirstParity":"required", "verification":"declared-dependencies"
        }
    });
    let project_bytes = stable_json(&value).into_bytes();
    let (validation, valid) =
        validate_project_bytes_with_validity(&project_bytes, "xinfa:onboarding-accept")?;
    if !valid {
        return Err(format!(
            "accepted onboarding project is invalid: {}",
            validation.trim()
        ));
    }

    let (existing_value, existing_root) = existing_root(existing)?;
    let replacement = selection
        .get("existingProject")
        .and_then(Value::as_object)
        .ok_or_else(|| "selection requires existingProject policy".to_owned())?;
    let replace = bool_field(replacement, "replace")?;
    let expected = replacement.get("expectedRoot").and_then(Value::as_str);
    match (&existing_root, replace, expected) {
        (None, false, None) => {}
        (None, true, _) => return Err("cannot replace a missing .xinfa/project.json".to_owned()),
        (None, false, Some(_)) => {
            return Err("expectedRoot must be null when no project exists".to_owned())
        }
        (Some(_), false, _) => {
            return Err("existing project requires explicit replace=true".to_owned())
        }
        (Some(observed), true, Some(expected)) if observed == expected => {}
        (Some(observed), true, Some(expected)) => {
            return Err(format!(
                "existing project root mismatch: expected {expected}, observed {observed}"
            ))
        }
        (Some(_), true, None) => {
            return Err("existing project replacement requires expectedRoot".to_owned())
        }
    }
    let before_paths = provider_paths(existing_value.as_ref());
    let added: Vec<String> = accepted_paths.difference(&before_paths).cloned().collect();
    let removed: Vec<String> = before_paths.difference(&accepted_paths).cloned().collect();
    let plan = json!({
        "existingProjectRoot": existing_root,
        "projectRoot": digest(&value),
        "diff": {"addedPaths":added, "removedPaths":removed, "replacement":existing_value.is_some()},
        "write": {"path":".xinfa/project.json", "atomic":true, "overwrite":existing_value.is_some()},
        "rollback": if existing_value.is_some() { "restore the tracked prior .xinfa/project.json from Git" } else { "remove the newly tracked .xinfa/project.json before commit" }
    });
    Ok((value, plan))
}

pub(super) fn accept(
    request: AcceptanceRequest<'_>,
    snapshot: &RepositorySnapshot,
    repository: &dyn RepositorySource,
) -> Result<AcceptanceOutcome, String> {
    let AcceptanceRequest {
        candidate_bytes,
        candidate_source,
        selection_bytes,
        selection_source,
        existing_project,
        mode,
    } = request;
    if !matches!(mode, "dry-run" | "execute") {
        return Err("accept mode must be dry-run or execute".to_owned());
    }
    let candidate = verified_candidate(candidate_bytes, candidate_source)?;
    let selection = parse_json(selection_bytes, selection_source, "onboarding selection")?;
    if selection.get("schema").and_then(Value::as_str) != Some(ONBOARDING_SELECTION_VERSION) {
        return Err(format!(
            "onboarding selection schema must be {ONBOARDING_SELECTION_VERSION}"
        ));
    }
    let candidate_root = candidate["candidateRoot"]
        .as_str()
        .expect("verified candidate root");
    if selection.get("candidateRoot").and_then(Value::as_str) != Some(candidate_root) {
        return Err("selection candidateRoot does not match the candidate".to_owned());
    }
    let selection_object = selection
        .as_object()
        .ok_or_else(|| "onboarding selection must be an object".to_owned())?;
    required_text(selection_object, "reviewer")?;
    let inventory_root = candidate["inventoryRoot"]
        .as_str()
        .ok_or_else(|| "candidate requires inventoryRoot".to_owned())?;

    let inventory_stub = json!({"policy": candidate["discoveryPolicy"]});
    let request = request_from_inventory(&inventory_stub)?;
    let current_inventory_text = discover_repository_value(
        snapshot,
        repository,
        Some(&request),
        "xinfa:onboarding-accept-freshness",
    )?;
    let current_inventory: Value = serde_json::from_str(&current_inventory_text)
        .map_err(|error| format!("invalid current inventory: {error}"))?;
    verify_root(
        &current_inventory,
        "inventoryRoot",
        "current repository inventory",
    )?;
    if current_inventory["inventoryRoot"] != inventory_root {
        return Err(format!(
            "stale onboarding candidate: expected inventory {inventory_root}, observed {}",
            current_inventory["inventoryRoot"]
                .as_str()
                .unwrap_or("missing")
        ));
    }

    let (project, plan) = project_from_selection(&candidate, &selection, existing_project)?;
    let project_text = stable_json(&project);
    let visibility = selection["visibility"]
        .as_str()
        .expect("validated selection visibility");
    let compile = compile_repository_atlas_from_source(
        project_text.as_bytes(),
        ".xinfa/project.json",
        repository,
        visibility,
    )?;
    let Some(artifacts) = compile.artifacts else {
        return Err(format!(
            "accepted project failed Atlas compilation: {}",
            compile.receipt.trim()
        ));
    };
    let (verification, valid) = verify_atlas_artifacts(&artifacts)?;
    if !valid {
        return Err(format!(
            "accepted project produced an invalid Atlas: {}",
            verification.trim()
        ));
    }
    let project_root = digest(&project);
    let terms = ecosystem_terms(&candidate);
    let receipt = rooted(
        json!({
            "$schema":"https://xinfa.dev/schema/onboarding-acceptance-v1.schema.json",
            "schema":ONBOARDING_ACCEPTANCE_VERSION,
            "mode":mode,
            "status":if mode == "execute" { "accepted" } else { "planned" },
            "authoritative":mode == "execute",
            "candidateRoot":candidate_root,
            "inventoryRoot":inventory_root,
            "repositoryRoot":snapshot.index_root(),
            "selectionRoot":digest(&selection),
            "reviewer":selection["reviewer"],
            "reviewerClaim":"selection identity records who approved the transition; it does not prove source truth",
            "projectRoot":project_root,
            "atlasRoot":artifacts.atlas_root,
            "plan":plan,
            "qualification":{"compile":"passed","verify":"passed","ecosystemTerms":terms},
            "writes":if mode == "execute" { json!([".xinfa/project.json"]) } else { json!([]) }
        }),
        "receiptRoot",
    );
    Ok(AcceptanceOutcome {
        receipt: super::stable(&receipt),
        project: project_text,
        execute: mode == "execute",
        project_root,
        atlas_root: artifacts.atlas_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_requires_exact_candidate_root() {
        let candidate = rooted(
            json!({
                "schema": super::super::ONBOARDING_CANDIDATE_VERSION,
                "authoritative":false,
                "proposals":[],
            }),
            "candidateRoot",
        );
        let candidate_bytes = super::super::stable(&candidate).into_bytes();
        assert!(verified_candidate(&candidate_bytes, "test").is_ok());
    }
}
