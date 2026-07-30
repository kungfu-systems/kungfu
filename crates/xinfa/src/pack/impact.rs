// SPDX-License-Identifier: Apache-2.0

use super::*;

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

pub fn impact_between_values(old: &Value, new_pack: &Value) -> Result<String, String> {
    let changed_paths = changed_sources(old, new_pack);
    let old_nodes = node_map(old);
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
