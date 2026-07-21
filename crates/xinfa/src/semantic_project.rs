// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::{digest, validate_project_bytes_with_validity};

pub const SURFACE_INVENTORY_VERSION: &str = "shifu.documentation-surface-inventory/v1";

fn node_identity(id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
    format!("surface.{}", &digest[..24])
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("semantic project inventory requires {key}"))
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("semantic project inventory requires {key}"))
}

fn verification(lifecycle: &str) -> Result<(&'static str, &'static str), String> {
    match lifecycle {
        "generated" => Ok(("machine", "machine-proved")),
        "managed-block" => Ok(("mixed", "mixed")),
        "non-claim" => Ok(("non-claim", "non-claim")),
        "authored" | "historical-append-only" => Ok(("human", "human-reviewed")),
        other => Err(format!("unsupported documentation lifecycle: {other}")),
    }
}

fn validate_route_declarations(routes: &[Value]) -> Result<(), String> {
    let required_capabilities: BTreeSet<&str> = [
        "value",
        "use",
        "authority",
        "constraints",
        "known-limits",
        "evidence",
        "next-action",
    ]
    .into_iter()
    .collect();
    let mut ids = BTreeSet::new();
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    for route in routes {
        let id = text(route, "id")?;
        if !ids.insert(id) {
            return Err(format!("duplicate semantic route: {id}"));
        }
        if !matches!(text(route, "audience")?, "human" | "agent") {
            return Err(format!(
                "unsupported route audience: {}",
                text(route, "audience")?
            ));
        }
        let capabilities: BTreeSet<&str> = array(route, "capabilities")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| format!("route {id} capability must be a string"))
            })
            .collect::<Result<_, _>>()?;
        if capabilities != required_capabilities {
            return Err(format!(
                "route {id} does not declare the complete dual-first capability set"
            ));
        }
        let resolution = route
            .get("resolution")
            .ok_or_else(|| format!("route {id} requires resolution"))?;
        for field in [
            "subjects",
            "capabilities",
            "owners",
            "roles",
            "mission_tracks",
            "terms",
        ] {
            let values = array(resolution, field)?;
            let unique: BTreeSet<&str> = values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            format!("route {id} resolution.{field} requires non-empty strings")
                        })
                })
                .collect::<Result<_, _>>()?;
            if unique.len() != values.len() || values.is_empty() {
                return Err(format!(
                    "route {id} resolution.{field} requires unique non-empty strings"
                ));
            }
        }
        groups
            .entry(text(route, "parityGroup")?)
            .or_default()
            .push(route);
    }
    for (group, paired) in groups {
        let audiences: BTreeSet<&str> = paired
            .iter()
            .map(|route| text(route, "audience"))
            .collect::<Result<_, _>>()?;
        if !audiences.contains("human") || !audiences.contains("agent") {
            return Err(format!(
                "parity group {group} requires human and agent routes"
            ));
        }
        let selections: BTreeSet<String> = paired
            .iter()
            .map(|route| {
                let route_id = text(route, "id")?;
                Ok(digest(route.get("selection").ok_or_else(|| {
                    format!("route {route_id} requires selection")
                })?))
            })
            .collect::<Result<_, String>>()?;
        if selections.len() != 1 {
            return Err(format!(
                "parity group {group} must use one shared selection"
            ));
        }
        let resolutions: BTreeSet<String> = paired
            .iter()
            .map(|route| {
                let route_id = text(route, "id")?;
                Ok(digest(route.get("resolution").ok_or_else(|| {
                    format!("route {route_id} requires resolution")
                })?))
            })
            .collect::<Result<_, String>>()?;
        if resolutions.len() != 1 {
            return Err(format!(
                "parity group {group} must use one shared route resolution intent"
            ));
        }
    }
    Ok(())
}

pub fn materialize_surface_inventory_bytes(bytes: &[u8], source: &str) -> Result<String, String> {
    let inventory: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid semantic project inventory {source}: {error}"))?;
    if inventory.get("schema").and_then(Value::as_str) != Some(SURFACE_INVENTORY_VERSION) {
        return Err(format!(
            "unsupported semantic project inventory in {source}"
        ));
    }
    let project_id = text(&inventory, "project")?;
    let declared_inventory_root = text(&inventory, "inventoryRoot")?;
    let mut entries = array(&inventory, "entries")?.clone();
    entries.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    let mut bindings = array(&inventory, "bindings")?.clone();
    bindings.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    let mut routes = array(&inventory, "routes")?.clone();
    routes.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    validate_route_declarations(&routes)?;

    let policy_root = text(
        inventory
            .get("policy")
            .ok_or_else(|| "semantic project inventory requires policy".to_owned())?,
        "root",
    )?;
    let inventory_entries = entries
        .iter()
        .map(|entry| {
            let id = text(entry, "id")?;
            if entry.get("node").is_some() {
                return Err(format!(
                    "surface {id} must not submit a semantic node identity"
                ));
            }
            Ok(json!({
                "id": id,
                "path": text(entry, "path")?,
                "kind": text(entry, "kind")?,
                "classification": text(entry, "classification")?,
                "lifecycle": text(entry, "lifecycle")?,
                "visibility": text(entry, "visibility")?,
                "owner": text(entry, "owner")?,
                "waiver": entry.get("waiver").cloned().ok_or_else(|| format!("surface {id} requires waiver"))?,
                "contentRoot": text(entry, "contentRoot")?,
                "size": entry.get("size").cloned().ok_or_else(|| format!("surface {id} requires size"))?
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let inventory_root = digest(&json!({
        "policyRoot": policy_root,
        "entries": inventory_entries,
        "bindings": &bindings
    }));
    if declared_inventory_root != inventory_root {
        return Err(format!(
            "semantic project inventory root mismatch: declared {declared_inventory_root}, computed {inventory_root}"
        ));
    }

    let mut paths = BTreeSet::new();
    let mut entry_by_path = BTreeMap::new();
    for entry in &entries {
        let path = text(entry, "path")?;
        if entry_by_path.insert(path, entry).is_some() {
            return Err(format!("duplicate semantic project surface path: {path}"));
        }
        paths.insert(path);
    }
    let mut binding_by_path = BTreeMap::new();
    for binding in &bindings {
        let target = text(binding, "targetPath")?;
        binding_by_path.entry(target).or_insert(binding);
        paths.insert(target);
    }
    let provider_entries = paths.iter().map(|path| {
        if let Some(entry) = entry_by_path.get(*path) {
            Ok(json!({"path": path, "contentRoot": text(entry, "contentRoot")?, "size": entry.get("size").cloned().ok_or_else(|| format!("surface {path} requires size"))?}))
        } else {
            let binding = binding_by_path[*path];
            Ok(json!({"path": path, "contentRoot": text(binding, "observedRevision")?, "size": binding.get("size").cloned().ok_or_else(|| format!("binding target {path} requires size"))?}))
        }
    }).collect::<Result<Vec<_>, String>>()?;

    let mut nodes = Vec::new();
    let mut node_ids = BTreeSet::new();
    for entry in &entries {
        let node = node_identity(text(entry, "id")?);
        if !node_ids.insert(node.to_owned()) {
            return Err(format!("duplicate semantic project node: {node}"));
        }
        let (mode, status) = verification(text(entry, "lifecycle")?)?;
        let path = text(entry, "path")?;
        let dependencies = bindings.iter().filter(|binding| binding.get("documentPath").and_then(Value::as_str) == Some(path)).map(|binding| {
            Ok(json!({"node": text(binding, "targetId")?, "expectedRevision": text(binding, "expectedRevision")?}))
        }).collect::<Result<Vec<_>, String>>()?;
        nodes.push(json!({
            "id": node, "kind": "document", "visibility": text(entry, "visibility")?, "revision": text(entry, "contentRoot")?,
            "provenance": {"kind": "project-source", "authority": project_id},
            "source": {"provider": "human-surfaces", "path": path},
            "verification": {"mode": mode, "status": status, "dependencies": dependencies, "waiver": null}
        }));
    }
    for binding in &bindings {
        let target = text(binding, "targetId")?;
        if node_ids.insert(target.to_owned()) {
            nodes.push(json!({
                "id": target, "kind": text(binding, "targetKind")?, "visibility": "public", "revision": text(binding, "observedRevision")?,
                "provenance": {"kind": "project-source", "authority": project_id},
                "source": {"provider": "human-surfaces", "path": text(binding, "targetPath")?},
                "verification": {"mode": "machine", "status": "machine-proved", "dependencies": [], "waiver": null}
            }));
        }
    }
    let edges = bindings.iter().map(|binding| {
        let document_path = text(binding, "documentPath")?;
        let binding_id = text(binding, "id")?;
        let document = entry_by_path.get(document_path).filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("document-file"))
            .ok_or_else(|| format!("binding {binding_id} has no file document node"))?;
        Ok(json!({"from": node_identity(text(document, "id")?), "relation": text(binding, "relation")?, "to": text(binding, "targetId")?}))
    }).collect::<Result<Vec<_>, String>>()?;

    let all_nodes: Vec<String> = node_ids.into_iter().collect();
    let materialized_routes = routes.iter().map(|route| {
        let route_id = text(route, "id")?;
        let selection = route.get("selection").ok_or_else(|| format!("route {route_id} requires selection"))?;
        let selected_nodes = match text(selection, "mode")? {
            "all" => all_nodes.clone(),
            "exact" => {
                let selected_paths: BTreeSet<&str> = array(selection, "paths")?.iter().map(|value| value.as_str().ok_or_else(|| "route selection path must be a string".to_owned())).collect::<Result<_, _>>()?;
                let mut selected = BTreeSet::new();
                for entry in &entries { if selected_paths.contains(text(entry, "path")?) { selected.insert(node_identity(text(entry, "id")?)); } }
                for binding in &bindings { if selected_paths.contains(text(binding, "documentPath")?) { selected.insert(text(binding, "targetId")?.to_owned()); } }
                selected.into_iter().collect()
            }
            mode => return Err(format!("unsupported route selection mode: {mode}")),
        };
        Ok(json!({
            "id": text(route, "id")?, "audience": text(route, "audience")?, "parityGroup": text(route, "parityGroup")?,
            "entrypoints": route.get("entrypoints").cloned().ok_or_else(|| "route requires entrypoints".to_owned())?,
            "visibility": "public", "nodes": selected_nodes,
            "resolution": route.get("resolution").cloned().ok_or_else(|| "route requires resolution".to_owned())?
        }))
    }).collect::<Result<Vec<_>, String>>()?;

    let project = json!({
        "$schema": "https://xinfa.dev/schema/project-v1.schema.json", "schema": "xinfa.project/v1",
        "project": {"id": project_id, "title": "Human Surfaces"},
        "cut": {"id": "human-surface-cut", "revision": inventory_root},
        "roots": [{"id": "repository", "path": ".", "visibility": "public"}],
        "providers": [{"id": "human-surfaces", "kind": "exact-file-manifest", "authority": "project", "visibility": "public", "root": "repository", "paths": paths.into_iter().collect::<Vec<_>>(), "revision": digest(&Value::Array(provider_entries))}],
        "nodes": nodes, "edges": edges, "routes": materialized_routes,
        "policies": {"unknownFields": "reject", "pathSemantics": "repository-relative-posix", "visibility": "fail-closed", "dualFirstParity": "required", "verification": "declared-dependencies"}
    });
    let project_bytes = serde_json::to_vec(&project).expect("materialized project serializes");
    let (validation, valid) =
        validate_project_bytes_with_validity(&project_bytes, "xinfa:semantic-project")?;
    if !valid {
        return Err(format!(
            "materialized semantic project is invalid: {validation}"
        ));
    }
    Ok(serde_json::to_string(&json!({
        "schema": "xinfa.semantic-project-materialization/v1", "valid": true, "source": source,
        "inventoryRoot": inventory_root, "projectRoot": digest(&project), "project": project
    }))
    .expect("materialization receipt serializes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_inventory_input() {
        assert!(materialize_surface_inventory_bytes(br#"{"schema":"other"}"#, "test").is_err());
    }
}
