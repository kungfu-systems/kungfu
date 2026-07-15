// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;

use super::atlas::{read_atlas, verify_atlas};
use super::{digest, stable_json};

pub const HUMAN_VIEW_VERSION: &str = "xinfa.human-view/v1";
pub const TASK_CHART_VERSION: &str = "xinfa.task-chart/v1";
pub const GUI_VIEW_VERSION: &str = "xinfa.gui-view/v1";
const EXPANSION_VERSION: &str = "xinfa.projection-expansion/v1";
const TOKEN_ACCOUNTING: &str = "utf8-bytes-ceil-div-4-v1";

fn verified_atlas(reference: &Path) -> Result<Value, String> {
    if !reference.is_dir() {
        return Err("projection compilation requires a complete Atlas directory".to_owned());
    }
    let (receipt, valid) = verify_atlas(reference)?;
    if !valid {
        return Err(format!(
            "projection compilation requires a verified Atlas: {}",
            receipt.trim()
        ));
    }
    read_atlas(reference)
}

fn route<'a>(atlas: &'a Value, route_id: &str, audience: &str) -> Result<&'a Value, String> {
    let route = atlas["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .find(|route| route["id"] == route_id)
        .ok_or_else(|| format!("Atlas does not declare route {route_id}"))?;
    if route["audience"] != audience {
        return Err(format!(
            "route {route_id} is for {} rather than {audience}",
            route["audience"].as_str().unwrap_or("unknown")
        ));
    }
    Ok(route)
}

fn parity(atlas: &Value, route: &Value) -> Value {
    json!({
        "atlas_root": atlas["atlas_root"],
        "project_id": atlas["project_id"],
        "cut": atlas["cut"],
        "cut_root": atlas["roots"]["cut"],
        "visibility": atlas["visibility"],
        "route": {
            "id": route["id"],
            "parity_group": route["parityGroup"],
            "route_root": route["routeRoot"],
            "authority_root": route["authorityRoot"],
            "status": route["status"],
        },
        "evidence": atlas["verification"]["coverage"]["claims"],
        "atlas_omissions": atlas["verification"]["coverage"]["orphans"],
        "source_roots": {
            "source": atlas["roots"]["source"],
            "semantic": atlas["roots"]["semantic"],
            "verification": atlas["roots"]["verification"],
        },
    })
}

fn materialization_contract() -> Value {
    json!({
        "derived": true,
        "default_owned_path_prefix": ".xinfa/generated/",
        "provider_input": "excluded",
        "human_owned_prose_overwrite": false,
        "promotion": {
            "requires_explicit_accept": true,
            "same_cut_allowed": false,
            "successor_atlas_required": true,
            "instruction": "accept content into a managed source path, declare a new source cut, and compile a successor Atlas",
        },
    })
}

fn uncertainty(atlas: &Value) -> Value {
    json!({
        "gaps": atlas["verification"]["gaps"],
        "conflicts": atlas["verification"]["conflicts"],
        "invalidations": atlas["verification"]["invalidations"],
    })
}

fn projection_policy(
    surface: &str,
    route: &Value,
    intent: &str,
    role: Option<&str>,
    budget: Value,
) -> (Value, String) {
    let policy = json!({
        "schema": "xinfa.projection-policy/v1",
        "surface": surface,
        "route": route["id"],
        "parity_group": route["parityGroup"],
        "intent": intent,
        "role": role,
        "budget": budget,
        "selection": "declared-route-dependency-closure-v1",
        "ranking": "deterministic-lexical-within-declared-route-v1",
        "cut_policy": "same-atlas-cut-only",
        "token_accounting": TOKEN_ACCOUNTING,
    });
    let root = digest(&policy);
    (policy, root)
}

fn finish(mut value: Value) -> String {
    let root = digest(&value);
    value
        .as_object_mut()
        .expect("projection object")
        .insert("projection_root".to_owned(), Value::String(root));
    stable_json(&value)
}

fn node_map(atlas: &Value) -> BTreeMap<&str, &Value> {
    atlas["semantic"]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|node| node["id"].as_str().map(|id| (id, node)))
        .collect()
}

fn route_ids(route: &Value) -> Vec<&str> {
    route["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

fn task_terms(intent: &str) -> BTreeSet<String> {
    intent
        .split(|character: char| !character.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|term| term.len() >= 2)
        .collect()
}

fn lexical_score(node: &Value, terms: &BTreeSet<String>) -> usize {
    let haystack = format!(
        "{} {} {}",
        node["id"].as_str().unwrap_or_default(),
        node["kind"].as_str().unwrap_or_default(),
        node.pointer("/source/path")
            .and_then(Value::as_str)
            .unwrap_or_default()
    )
    .to_lowercase();
    terms.iter().filter(|term| haystack.contains(*term)).count()
}

fn dependencies<'a>(node: &'a Value, allowed: &BTreeSet<&str>) -> Vec<&'a str> {
    let mut result: Vec<&str> = node
        .pointer("/verification/dependencies")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|dependency| dependency["node"].as_str())
        .filter(|id| allowed.contains(id))
        .collect();
    result.sort_unstable();
    result.dedup();
    result
}

fn visit_dependencies<'a>(
    id: &'a str,
    nodes: &BTreeMap<&'a str, &'a Value>,
    allowed: &BTreeSet<&'a str>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
    order: &mut Vec<&'a str>,
) {
    if visited.contains(id) || !visiting.insert(id) {
        return;
    }
    if let Some(node) = nodes.get(id) {
        for dependency in dependencies(node, allowed) {
            visit_dependencies(dependency, nodes, allowed, visiting, visited, order);
        }
    }
    visiting.remove(id);
    if visited.insert(id) {
        order.push(id);
    }
}

fn dependency_order<'a>(atlas: &'a Value, route: &'a Value, intent: &str) -> Vec<&'a str> {
    let nodes = node_map(atlas);
    let ids = route_ids(route);
    let allowed: BTreeSet<&str> = ids.iter().copied().collect();
    let terms = task_terms(intent);
    let mut ranked: Vec<(usize, usize, &str)> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            (
                nodes
                    .get(id)
                    .map(|node| lexical_score(node, &terms))
                    .unwrap_or(0),
                index,
                *id,
            )
        })
        .collect();
    ranked.sort_by(|left, right| right.0.cmp(&left.0).then(left.1.cmp(&right.1)));
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut order = Vec::new();
    for (_, _, id) in ranked {
        visit_dependencies(
            id,
            &nodes,
            &allowed,
            &mut visiting,
            &mut visited,
            &mut order,
        );
    }
    order
}

fn inventory_entry<'a>(atlas: &'a Value, node: &Value) -> Option<&'a Value> {
    let provider = node.pointer("/source/provider")?;
    let path = node.pointer("/source/path")?;
    atlas["provenance"]["inventory"]
        .as_array()?
        .iter()
        .find(|entry| entry["provider"] == *provider && entry["path"] == *path)
}

fn unit(atlas: &Value, node: &Value, terms: &BTreeSet<String>) -> Value {
    let reasons = if lexical_score(node, terms) > 0 {
        json!(["task-lexical-match", "declared-route", "dependency-closure"])
    } else {
        json!(["declared-route", "dependency-closure"])
    };
    let source = inventory_entry(atlas, node).map(|entry| {
        json!({
            "provider": entry["provider"],
            "path": entry["path"],
            "content_root": entry["contentRoot"],
            "size": entry["size"],
            "encoding": entry["encoding"],
            "content": entry["content"],
        })
    });
    json!({
        "id": node["id"],
        "kind": node["kind"],
        "revision": node["revision"],
        "verification": node["verification"],
        "source": source,
        "why_included": reasons,
        "source_roots": {
            "source": atlas["roots"]["source"],
            "semantic": atlas["roots"]["semantic"],
            "verification": atlas["roots"]["verification"],
        },
    })
}

fn token_cost(value: &Value) -> usize {
    stable_json(value).len().div_ceil(4)
}

fn required_authority(node: &Value) -> bool {
    node.pointer("/verification/status") != Some(&json!("non-claim"))
}

fn handle(atlas: &Value, route: &Value, policy_root: &str, node: &Value, reason: &str) -> Value {
    let core = json!({
        "schema": "xinfa.expansion-handle/v1",
        "atlas_root": atlas["atlas_root"],
        "cut_root": atlas["roots"]["cut"],
        "route": route["id"],
        "route_root": route["routeRoot"],
        "policy_root": policy_root,
        "node": node["id"],
        "reason": reason,
    });
    let id = digest(&core);
    let mut value = core;
    value
        .as_object_mut()
        .expect("handle")
        .insert("id".to_owned(), Value::String(id));
    value
}

struct Selection {
    units: Vec<Value>,
    omissions: Vec<Value>,
    handles: Vec<Value>,
    used_tokens: usize,
}

fn select_units(
    atlas: &Value,
    route: &Value,
    intent: &str,
    budget: usize,
    policy_root: &str,
    only: Option<&str>,
) -> Selection {
    let nodes = node_map(atlas);
    let allowed: BTreeSet<&str> = route_ids(route).into_iter().collect();
    let terms = task_terms(intent);
    let order = if let Some(seed) = only {
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        let mut order = Vec::new();
        visit_dependencies(
            seed,
            &nodes,
            &allowed,
            &mut visiting,
            &mut visited,
            &mut order,
        );
        order
    } else {
        dependency_order(atlas, route, intent)
    };
    let mut units = Vec::new();
    let mut omissions = Vec::new();
    let mut handles = Vec::new();
    let mut selected = BTreeSet::new();
    let mut used_tokens = 0;
    for id in order {
        let Some(node) = nodes.get(id) else {
            continue;
        };
        let missing_dependency = dependencies(node, &allowed)
            .into_iter()
            .find(|dependency| !selected.contains(dependency));
        let candidate = unit(atlas, node, &terms);
        let tokens = token_cost(&candidate);
        let reason = if missing_dependency.is_some() {
            "required-dependency-omitted"
        } else if used_tokens + tokens > budget {
            "token-budget"
        } else {
            let mut with_tokens = candidate;
            with_tokens
                .as_object_mut()
                .expect("unit")
                .insert("tokens".to_owned(), json!(tokens));
            used_tokens += tokens;
            selected.insert(id);
            units.push(with_tokens);
            continue;
        };
        omissions.push(json!({
            "node": id,
            "required": required_authority(node),
            "reason": reason,
            "blocked_by": missing_dependency,
            "estimated_tokens": tokens,
        }));
        handles.push(handle(atlas, route, policy_root, node, reason));
    }
    Selection {
        units,
        omissions,
        handles,
        used_tokens,
    }
}

pub fn compile_task_chart(
    reference: &Path,
    route_id: &str,
    task: &str,
    role: &str,
    max_tokens: usize,
) -> Result<String, String> {
    if task.trim().is_empty() || role.trim().is_empty() || max_tokens == 0 {
        return Err("task, role, and a positive token budget are required".to_owned());
    }
    let atlas = verified_atlas(reference)?;
    let route = route(&atlas, route_id, "agent")?;
    let budget = json!({"max_tokens": max_tokens, "accounting": TOKEN_ACCOUNTING});
    let (policy, policy_root) =
        projection_policy("task-chart", route, task, Some(role), budget.clone());
    let selection = select_units(&atlas, route, task, max_tokens, &policy_root, None);
    let status = if selection
        .omissions
        .iter()
        .any(|item| item["required"] == true)
    {
        "degraded"
    } else {
        "complete"
    };
    Ok(finish(json!({
        "schema": TASK_CHART_VERSION,
        "kind": TASK_CHART_VERSION,
        "surface": "agent-context",
        "atlas_root": atlas["atlas_root"],
        "cut_root": atlas["roots"]["cut"],
        "task": {"intent": task, "role": role, "route": route_id},
        "policy": policy,
        "policy_root": policy_root,
        "parity": parity(&atlas, route),
        "status": status,
        "budget": {
            "max_tokens": max_tokens,
            "used_tokens": selection.used_tokens,
            "remaining_tokens": max_tokens - selection.used_tokens,
            "accounting": TOKEN_ACCOUNTING,
        },
        "units": selection.units,
        "omissions": selection.omissions,
        "uncertainty": uncertainty(&atlas),
        "expansion_handles": selection.handles,
        "materialization": materialization_contract(),
        "derived": true,
    })))
}

fn adjacency<'a>(atlas: &'a Value, route: &'a Value) -> BTreeMap<&'a str, BTreeSet<&'a str>> {
    let allowed: BTreeSet<&str> = route_ids(route).into_iter().collect();
    let mut graph: BTreeMap<&str, BTreeSet<&str>> = allowed
        .iter()
        .copied()
        .map(|id| (id, BTreeSet::new()))
        .collect();
    for edge in atlas["semantic"]["edges"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let Some(from) = edge["from"].as_str() else {
            continue;
        };
        let Some(to) = edge["to"].as_str() else {
            continue;
        };
        if allowed.contains(from) && allowed.contains(to) {
            graph.entry(from).or_default().insert(to);
            graph.entry(to).or_default().insert(from);
        }
    }
    graph
}

fn hop_distances<'a>(atlas: &'a Value, route: &'a Value, intent: &str) -> BTreeMap<&'a str, usize> {
    let graph = adjacency(atlas, route);
    let nodes = node_map(atlas);
    let terms = task_terms(intent);
    let ids = route_ids(route);
    let entry = ids.iter().enumerate().max_by(|left, right| {
        let left_score = nodes
            .get(left.1)
            .map(|node| lexical_score(node, &terms))
            .unwrap_or(0);
        let right_score = nodes
            .get(right.1)
            .map(|node| lexical_score(node, &terms))
            .unwrap_or(0);
        left_score
            .cmp(&right_score)
            .then_with(|| right.0.cmp(&left.0))
    });
    let Some((_, entry)) = entry else {
        return BTreeMap::new();
    };
    let entry = *entry;
    let mut queue = VecDeque::from([entry]);
    let mut distances = BTreeMap::from([(entry, 0)]);
    while let Some(current) = queue.pop_front() {
        let next_distance = distances[current] + 1;
        for next in graph.get(current).into_iter().flatten() {
            if !distances.contains_key(next) {
                distances.insert(next, next_distance);
                queue.push_back(next);
            }
        }
    }
    distances
}

fn bounded_nodes<'a>(
    atlas: &'a Value,
    route: &'a Value,
    intent: &str,
    max_hops: usize,
) -> Vec<(&'a Value, usize)> {
    let nodes = node_map(atlas);
    let distances = hop_distances(atlas, route, intent);
    let mut selected: Vec<(&Value, usize)> = route_ids(route)
        .into_iter()
        .filter_map(|id| {
            let distance = *distances.get(id)?;
            let node = *nodes.get(id)?;
            (distance <= max_hops).then_some((node, distance))
        })
        .collect();
    selected.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then(left.0["id"].as_str().cmp(&right.0["id"].as_str()))
    });
    selected
}

fn bounded_omissions(
    atlas: &Value,
    route: &Value,
    intent: &str,
    max_hops: usize,
    selected: &[(&Value, usize)],
    policy_root: &str,
) -> (Vec<Value>, Vec<Value>) {
    let selected_ids: BTreeSet<&str> = selected
        .iter()
        .filter_map(|(node, _)| node["id"].as_str())
        .collect();
    let nodes = node_map(atlas);
    let distances = hop_distances(atlas, route, intent);
    let mut omissions = Vec::new();
    let mut handles = Vec::new();
    for id in route_ids(route) {
        if selected_ids.contains(id) {
            continue;
        }
        if let Some(node) = nodes.get(id) {
            let distance = distances.get(id).copied();
            let required = distance.is_some_and(|hop| hop > max_hops) && required_authority(node);
            let reason = if distance.is_some() {
                "hop-budget"
            } else {
                "outside-intent-component"
            };
            omissions
                .push(json!({"node": id, "required": required, "reason": reason, "hop": distance}));
            handles.push(handle(atlas, route, policy_root, node, reason));
        }
    }
    (omissions, handles)
}

pub fn compile_human_view(
    reference: &Path,
    route_id: &str,
    intent: &str,
    max_hops: usize,
) -> Result<String, String> {
    if intent.trim().is_empty() {
        return Err("human read intent is required".to_owned());
    }
    let atlas = verified_atlas(reference)?;
    let route = route(&atlas, route_id, "human")?;
    let (policy, policy_root) = projection_policy(
        "human-view",
        route,
        intent,
        None,
        json!({"max_hops": max_hops}),
    );
    let selected = bounded_nodes(&atlas, route, intent, max_hops);
    let (omissions, handles) =
        bounded_omissions(&atlas, route, intent, max_hops, &selected, &policy_root);
    let steps: Vec<Value> = selected
        .iter()
        .map(|(node, hop)| {
            json!({
                "hop": hop,
                "node": node["id"],
                "kind": node["kind"],
                "status": node["verification"]["status"],
                "source": node["source"],
                "why_next": if *hop == 0 { "intent-entry" } else { "declared-relationship" },
            })
        })
        .collect();
    let status = if omissions.iter().any(|item| item["required"] == true) {
        "degraded"
    } else {
        "complete"
    };
    Ok(finish(json!({
        "schema": HUMAN_VIEW_VERSION,
        "kind": HUMAN_VIEW_VERSION,
        "surface": "human",
        "atlas_root": atlas["atlas_root"],
        "cut_root": atlas["roots"]["cut"],
        "intent": intent,
        "entrypoints": route["entrypoints"],
        "policy": policy,
        "policy_root": policy_root,
        "parity": parity(&atlas, route),
        "status": status,
        "steps": steps,
        "metrics": {"max_hops": max_hops, "hops_used": selected.iter().map(|(_, hop)| *hop).max().unwrap_or(0)},
        "omissions": omissions,
        "uncertainty": uncertainty(&atlas),
        "expansion_handles": handles,
        "materialization": materialization_contract(),
        "derived": true,
    })))
}

pub fn compile_gui_view(
    reference: &Path,
    route_id: &str,
    intent: &str,
    max_hops: usize,
) -> Result<String, String> {
    if intent.trim().is_empty() {
        return Err("GUI view intent is required".to_owned());
    }
    let atlas = verified_atlas(reference)?;
    let route = route(&atlas, route_id, "human")?;
    let (policy, policy_root) = projection_policy(
        "gui-view",
        route,
        intent,
        None,
        json!({"max_expansion_hops": max_hops}),
    );
    let selected = bounded_nodes(&atlas, route, intent, max_hops);
    let selected_ids: BTreeSet<&str> = selected
        .iter()
        .filter_map(|(node, _)| node["id"].as_str())
        .collect();
    let (omissions, handles) =
        bounded_omissions(&atlas, route, intent, max_hops, &selected, &policy_root);
    let summaries: Vec<Value> = selected
        .iter()
        .map(|(node, hop)| {
            json!({
                "id": node["id"],
                "kind": node["kind"],
                "status": node["verification"]["status"],
                "hop": hop,
                "source": node["source"],
            })
        })
        .collect();
    let relationships: Vec<Value> = atlas["semantic"]["edges"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|edge| {
            edge["from"]
                .as_str()
                .is_some_and(|id| selected_ids.contains(id))
                && edge["to"]
                    .as_str()
                    .is_some_and(|id| selected_ids.contains(id))
        })
        .cloned()
        .collect();
    let status = if omissions.iter().any(|item| item["required"] == true) {
        "degraded"
    } else {
        "complete"
    };
    Ok(finish(json!({
        "schema": GUI_VIEW_VERSION,
        "kind": GUI_VIEW_VERSION,
        "surface": "gui",
        "atlas_root": atlas["atlas_root"],
        "cut_root": atlas["roots"]["cut"],
        "intent": intent,
        "policy": policy,
        "policy_root": policy_root,
        "parity": parity(&atlas, route),
        "status": status,
        "summary": {"nodes": summaries, "count": selected.len()},
        "detail": {"relationships": relationships},
        "metrics": {"max_expansion_hops": max_hops, "hops_used": selected.iter().map(|(_, hop)| *hop).max().unwrap_or(0)},
        "omissions": omissions,
        "uncertainty": uncertainty(&atlas),
        "expansion_handles": handles,
        "materialization": materialization_contract(),
        "derived": true,
    })))
}

fn read_projection(reference: &Path) -> Result<Value, String> {
    let bytes = fs::read(reference).map_err(|error| format!("cannot read projection: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid projection JSON: {error}"))
}

fn verify_projection_value(value: &Value) -> Vec<Value> {
    let mut findings = Vec::new();
    if !matches!(
        value["schema"].as_str(),
        Some(HUMAN_VIEW_VERSION | TASK_CHART_VERSION | GUI_VIEW_VERSION | EXPANSION_VERSION)
    ) || value["kind"] != value["schema"]
    {
        findings.push(json!({"code": "projection-schema", "path": "/schema", "message": "unsupported projection schema or kind"}));
    }
    let expected = value["projection_root"].as_str().unwrap_or_default();
    let mut core = value.clone();
    core.as_object_mut()
        .and_then(|object| object.remove("projection_root"));
    if expected.is_empty() || digest(&core) != expected {
        findings.push(json!({"code": "projection-root", "path": "/projection_root", "message": "projection root does not match canonical content"}));
    }
    if value["derived"] != true
        || value.pointer("/materialization/provider_input") != Some(&json!("excluded"))
        || value.pointer("/materialization/promotion/same_cut_allowed") != Some(&json!(false))
        || value.pointer("/materialization/promotion/successor_atlas_required")
            != Some(&json!(true))
    {
        findings.push(json!({"code": "materialization-boundary", "path": "/materialization", "message": "generated projections must remain derived, provider-excluded, and successor-only on promotion"}));
    }
    if value.pointer("/parity/atlas_root") != value.pointer("/atlas_root")
        || value.pointer("/parity/cut_root") != value.pointer("/cut_root")
    {
        findings.push(json!({"code": "projection-parity", "path": "/parity", "message": "projection and parity block must bind one Atlas root and cut"}));
    }
    findings
}

pub fn verify_projection(
    projection_reference: &Path,
    atlas_reference: &Path,
) -> Result<(String, bool), String> {
    let projection = read_projection(projection_reference)?;
    let mut findings = verify_projection_value(&projection);
    let atlas = verified_atlas(atlas_reference)?;
    let route_id = projection
        .pointer("/parity/route/id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let audience = if projection["schema"] == TASK_CHART_VERSION {
        "agent"
    } else if projection["schema"] == EXPANSION_VERSION {
        projection
            .pointer("/parity/route/id")
            .and_then(|id| {
                atlas["routes"]
                    .as_array()?
                    .iter()
                    .find(|route| route["id"] == *id)
                    .and_then(|route| route["audience"].as_str())
            })
            .unwrap_or("unknown")
    } else {
        "human"
    };
    match route(&atlas, route_id, audience) {
        Ok(route) if projection["parity"] != parity(&atlas, route) => {
            findings.push(json!({"code": "atlas-parity", "path": "/parity", "message": "projection status, roots, cut, evidence, or Atlas omissions diverge from the verified Atlas"}));
        }
        Err(message) => findings
            .push(json!({"code": "atlas-route", "path": "/parity/route", "message": message})),
        _ => {}
    }
    findings.sort_by(|left, right| {
        (left["path"].as_str(), left["code"].as_str())
            .cmp(&(right["path"].as_str(), right["code"].as_str()))
    });
    let valid = findings.is_empty();
    Ok((
        stable_json(&json!({
            "schema": "xinfa.projection-verification-receipt/v1",
            "valid": valid,
            "projection_root": projection["projection_root"],
            "atlas_root": atlas["atlas_root"],
            "cut_root": atlas["roots"]["cut"],
            "diagnostics": findings,
        })),
        valid,
    ))
}

pub fn inspect_projection(reference: &Path) -> Result<String, String> {
    let projection = read_projection(reference)?;
    let findings = verify_projection_value(&projection);
    Ok(stable_json(&json!({
        "schema": "xinfa.projection-inspection/v1",
        "valid_structure": findings.is_empty(),
        "kind": projection["kind"],
        "surface": projection["surface"],
        "projection_root": projection["projection_root"],
        "atlas_root": projection["atlas_root"],
        "cut_root": projection["cut_root"],
        "policy_root": projection["policy_root"],
        "status": projection["status"],
        "budget": projection["budget"],
        "metrics": projection["metrics"],
        "counts": {
            "units": projection["units"].as_array().map(Vec::len).unwrap_or(0),
            "omissions": projection["omissions"].as_array().map(Vec::len).unwrap_or(0),
            "expansion_handles": projection["expansion_handles"].as_array().map(Vec::len).unwrap_or(0),
        },
        "diagnostics": findings,
    })))
}

pub fn expand_projection(
    atlas_reference: &Path,
    projection_reference: &Path,
    handle_id: &str,
    additional_tokens: usize,
) -> Result<String, String> {
    if additional_tokens == 0 {
        return Err("expand requires a positive additional token budget".to_owned());
    }
    let projection = read_projection(projection_reference)?;
    let findings = verify_projection_value(&projection);
    if !findings.is_empty() {
        return Err("expand requires a structurally valid projection".to_owned());
    }
    let atlas = verified_atlas(atlas_reference)?;
    if projection["atlas_root"] != atlas["atlas_root"]
        || projection["cut_root"] != atlas["roots"]["cut"]
    {
        return Err("expand refuses to switch Atlas root or cut; compile an explicit successor view instead".to_owned());
    }
    let expansion_handle = projection["expansion_handles"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .find(|handle| handle["id"] == handle_id)
        .ok_or_else(|| format!("projection does not declare expansion handle {handle_id}"))?;
    let route_id = expansion_handle["route"]
        .as_str()
        .ok_or_else(|| "expansion handle is missing route".to_owned())?;
    let audience = atlas["routes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .find(|route| route["id"] == route_id)
        .and_then(|route| route["audience"].as_str())
        .ok_or_else(|| "expansion route is not in the Atlas".to_owned())?;
    let route = route(&atlas, route_id, audience)?;
    if expansion_handle["atlas_root"] != atlas["atlas_root"]
        || expansion_handle["cut_root"] != atlas["roots"]["cut"]
        || expansion_handle["route_root"] != route["routeRoot"]
    {
        return Err("expansion handle is not bound to this Atlas cut and route".to_owned());
    }
    let node = expansion_handle["node"]
        .as_str()
        .ok_or_else(|| "expansion handle is missing node".to_owned())?;
    let predecessor = projection["projection_root"]
        .as_str()
        .ok_or_else(|| "projection is missing root".to_owned())?;
    let intent = projection
        .pointer("/task/intent")
        .or_else(|| projection.get("intent"))
        .and_then(Value::as_str)
        .unwrap_or("expand declared authority");
    let (policy, policy_root) = projection_policy(
        "expansion",
        route,
        intent,
        projection.pointer("/task/role").and_then(Value::as_str),
        json!({
            "additional_tokens": additional_tokens,
            "predecessor_root": predecessor,
            "handle": handle_id,
        }),
    );
    let selection = select_units(
        &atlas,
        route,
        intent,
        additional_tokens,
        &policy_root,
        Some(node),
    );
    let status = if selection
        .omissions
        .iter()
        .any(|item| item["required"] == true)
    {
        "degraded"
    } else {
        "complete"
    };
    Ok(finish(json!({
        "schema": EXPANSION_VERSION,
        "kind": EXPANSION_VERSION,
        "surface": "expansion",
        "atlas_root": atlas["atlas_root"],
        "cut_root": atlas["roots"]["cut"],
        "predecessor_root": predecessor,
        "expanded_handle": handle_id,
        "policy": policy,
        "policy_root": policy_root,
        "parity": parity(&atlas, route),
        "status": status,
        "budget": {
            "additional_tokens": additional_tokens,
            "used_tokens": selection.used_tokens,
            "remaining_tokens": additional_tokens - selection.used_tokens,
            "accounting": TOKEN_ACCOUNTING,
        },
        "units": selection.units,
        "omissions": selection.omissions,
        "uncertainty": uncertainty(&atlas),
        "expansion_handles": selection.handles,
        "materialization": materialization_contract(),
        "derived": true,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compile_repository_atlas_bytes, write_atlas_directory, AtlasArtifacts};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn compiled_fixture(name: &str, visibility: &str) -> (PathBuf, PathBuf, AtlasArtifacts) {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join(name);
        let project = fs::read(fixture.join("project.json")).expect("fixture");
        let artifacts = compile_repository_atlas_bytes(&project, "fixture", &fixture, visibility)
            .expect("compile")
            .artifacts
            .expect("Atlas");
        let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let parent = std::env::temp_dir().join(format!(
            "xinfa-projection-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&parent).expect("temp parent");
        let output = parent.join("atlas");
        write_atlas_directory(&output, &artifacts).expect("write Atlas");
        (parent, output, artifacts)
    }

    fn compiled_atlas() -> (PathBuf, PathBuf, AtlasArtifacts) {
        compiled_fixture("repository-small", "public")
    }

    fn write_projection(parent: &Path, name: &str, projection: &str) -> PathBuf {
        let path = parent.join(name);
        fs::write(&path, projection).expect("write projection");
        path
    }

    #[test]
    fn chart_is_deterministic_and_budget_failure_is_explicit() {
        let (parent, atlas, _) = compiled_atlas();
        let first = compile_task_chart(
            &atlas,
            "small.agent",
            "change runtime greeting",
            "implementer",
            80,
        )
        .expect("chart");
        let second = compile_task_chart(
            &atlas,
            "small.agent",
            "change runtime greeting",
            "implementer",
            80,
        )
        .expect("chart");
        assert_eq!(first, second);
        let value: Value = serde_json::from_str(&first).expect("JSON");
        assert_eq!(value["status"], "degraded");
        assert!(!value["omissions"].as_array().unwrap().is_empty());
        assert!(!value["expansion_handles"].as_array().unwrap().is_empty());
        assert_eq!(value["materialization"]["provider_input"], "excluded");
        fs::remove_dir_all(parent).expect("cleanup");
    }

    #[test]
    fn human_agent_and_gui_share_atlas_cut_status_and_evidence() {
        let (parent, atlas, _) = compiled_atlas();
        let human: Value = serde_json::from_str(
            &compile_human_view(&atlas, "small.human", "understand runtime", 2).expect("human"),
        )
        .expect("human JSON");
        let gui: Value = serde_json::from_str(
            &compile_gui_view(&atlas, "small.human", "understand runtime", 2).expect("GUI"),
        )
        .expect("GUI JSON");
        let chart: Value = serde_json::from_str(
            &compile_task_chart(
                &atlas,
                "small.agent",
                "understand runtime",
                "reviewer",
                4096,
            )
            .expect("chart"),
        )
        .expect("chart JSON");
        for projection in [&gui, &chart] {
            assert_eq!(projection["atlas_root"], human["atlas_root"]);
            assert_eq!(projection["cut_root"], human["cut_root"]);
            assert_eq!(
                projection["parity"]["evidence"],
                human["parity"]["evidence"]
            );
            assert_eq!(
                projection["parity"]["atlas_omissions"],
                human["parity"]["atlas_omissions"]
            );
        }
        assert_eq!(
            chart["parity"]["route"]["status"],
            human["parity"]["route"]["status"]
        );
        assert_eq!(
            chart["parity"]["route"]["authority_root"],
            human["parity"]["route"]["authority_root"]
        );
        fs::remove_dir_all(parent).expect("cleanup");
    }

    #[test]
    fn expand_preserves_cut_and_rejects_another_atlas() {
        let (parent, atlas, _) = compiled_atlas();
        let (next_parent, next_atlas, _) = compiled_fixture("repository-small-next", "public");
        let chart = compile_task_chart(
            &atlas,
            "small.agent",
            "change runtime greeting",
            "implementer",
            80,
        )
        .expect("chart");
        let chart_value: Value = serde_json::from_str(&chart).expect("chart JSON");
        let chart_path = write_projection(&parent, "chart.json", &chart);
        let handle = chart_value["expansion_handles"][0]["id"]
            .as_str()
            .expect("handle");
        let expanded: Value = serde_json::from_str(
            &expand_projection(&atlas, &chart_path, handle, 4096).expect("expand"),
        )
        .expect("expansion JSON");
        assert_eq!(expanded["atlas_root"], chart_value["atlas_root"]);
        assert_eq!(expanded["cut_root"], chart_value["cut_root"]);
        assert_eq!(expanded["predecessor_root"], chart_value["projection_root"]);
        let error = expand_projection(&next_atlas, &chart_path, handle, 4096)
            .expect_err("another Atlas cut must be rejected");
        assert!(error.contains("refuses to switch Atlas root or cut"));
        fs::remove_dir_all(parent).expect("cleanup");
        fs::remove_dir_all(next_parent).expect("cleanup successor");
    }

    #[test]
    fn projection_verification_detects_tampering() {
        let (parent, atlas, _) = compiled_atlas();
        let chart = compile_task_chart(&atlas, "small.agent", "review runtime", "reviewer", 4096)
            .expect("chart");
        let chart_path = write_projection(&parent, "chart.json", &chart);
        let (_, valid) = verify_projection(&chart_path, &atlas).expect("verify");
        assert!(valid);
        let mut tampered: Value = serde_json::from_str(&chart).expect("chart JSON");
        tampered["status"] = json!("degraded");
        fs::write(&chart_path, stable_json(&tampered)).expect("tamper");
        let (receipt, valid) = verify_projection(&chart_path, &atlas).expect("verify tampered");
        assert!(!valid);
        assert!(receipt.contains("projection-root"));
        fs::remove_dir_all(parent).expect("cleanup");
    }

    #[test]
    fn four_golden_tasks_hold_their_roots_budgets_and_required_coverage() {
        let golden: Value = serde_json::from_str(include_str!(
            "../fixtures/golden/projection-scenarios-v1.json"
        ))
        .expect("projection golden");
        let (small_parent, small_atlas, _) = compiled_fixture("repository-small", "public");
        let (medium_parent, medium_atlas, _) = compiled_fixture("repository-medium", "internal");
        for scenario in golden["scenarios"].as_array().expect("scenarios") {
            let atlas = if scenario["fixture"] == "repository-small" {
                &small_atlas
            } else {
                &medium_atlas
            };
            let output = match scenario["surface"].as_str().expect("surface") {
                "human" => compile_human_view(
                    atlas,
                    scenario["route"].as_str().expect("route"),
                    scenario["intent"].as_str().expect("intent"),
                    scenario["max_hops"].as_u64().expect("hops") as usize,
                ),
                "gui" => compile_gui_view(
                    atlas,
                    scenario["route"].as_str().expect("route"),
                    scenario["intent"].as_str().expect("intent"),
                    scenario["max_hops"].as_u64().expect("hops") as usize,
                ),
                "task-chart" => compile_task_chart(
                    atlas,
                    scenario["route"].as_str().expect("route"),
                    scenario["intent"].as_str().expect("intent"),
                    scenario["role"].as_str().expect("role"),
                    scenario["max_tokens"].as_u64().expect("tokens") as usize,
                ),
                _ => unreachable!(),
            }
            .expect("projection");
            let value: Value = serde_json::from_str(&output).expect("projection JSON");
            assert_eq!(value["atlas_root"], scenario["atlas_root"]);
            assert_eq!(value["cut_root"], scenario["cut_root"]);
            assert_eq!(value["policy_root"], scenario["policy_root"]);
            assert_eq!(value["projection_root"], scenario["projection_root"]);
            assert_eq!(value["status"], scenario["status"]);
            let required_omissions = value["omissions"]
                .as_array()
                .expect("omissions")
                .iter()
                .filter(|item| item["required"] == true)
                .count();
            assert_eq!(required_omissions, 0);
            let observed_nodes: Vec<Value> = match scenario["surface"].as_str() {
                Some("task-chart") => value["units"]
                    .as_array()
                    .expect("units")
                    .iter()
                    .map(|item| item["id"].clone())
                    .collect(),
                Some("human") => value["steps"]
                    .as_array()
                    .expect("steps")
                    .iter()
                    .map(|item| item["node"].clone())
                    .collect(),
                Some("gui") => value["summary"]["nodes"]
                    .as_array()
                    .expect("nodes")
                    .iter()
                    .map(|item| item["id"].clone())
                    .collect(),
                _ => unreachable!(),
            };
            assert_eq!(Value::Array(observed_nodes), scenario["expected_nodes"]);
            if let Some(expected) = scenario["used_tokens"].as_u64() {
                assert_eq!(value["budget"]["used_tokens"], expected);
            }
            if let Some(expected) = scenario["hops_used"].as_u64() {
                assert_eq!(value["metrics"]["hops_used"], expected);
            }
        }
        fs::remove_dir_all(small_parent).expect("cleanup small");
        fs::remove_dir_all(medium_parent).expect("cleanup medium");
    }
}
