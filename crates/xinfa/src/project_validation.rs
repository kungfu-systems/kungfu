// SPDX-License-Identifier: Apache-2.0

use super::*;

type RootInfo = BTreeMap<String, (String, String)>;
type Providers = BTreeMap<String, (String, BTreeSet<String>)>;
type Nodes = BTreeMap<String, Value>;

pub(super) fn validate(project: &Value) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let Some(top) = object(project, &mut diagnostics, "") else {
        return diagnostics;
    };

    validate_metadata(top, &mut diagnostics);
    let roots = validate_roots(project, &mut diagnostics);
    let providers = validate_providers(project, &roots, &mut diagnostics);
    let nodes = validate_nodes(project, &providers, &mut diagnostics);
    validate_graphs(project, &nodes, &mut diagnostics);
    validate_routes(project, &nodes, &mut diagnostics);
    validate_policies(top, &mut diagnostics);

    diagnostics.sort_by(|left, right| {
        (&left.path, left.code, &left.message).cmp(&(&right.path, right.code, &right.message))
    });
    diagnostics
}

fn validate_metadata(top: &Map<String, Value>, diagnostics: &mut Vec<Diagnostic>) {
    exact_keys(top, TOP_KEYS, &[], "", diagnostics);
    if top.get("$schema").and_then(Value::as_str) != Some(PROJECT_SCHEMA_ID) {
        push(
            diagnostics,
            "schema-id",
            "/$schema",
            format!("must be {PROJECT_SCHEMA_ID}"),
        );
    }
    if top.get("schema").and_then(Value::as_str) != Some(PROJECT_VERSION) {
        push(
            diagnostics,
            "unsupported-version",
            "/schema",
            format!("must be {PROJECT_VERSION}"),
        );
    }

    if let Some(value) = top.get("project") {
        if let Some(project) = object(value, diagnostics, "/project") {
            exact_keys(project, &["id", "title"], &[], "/project", diagnostics);
            identifier(project.get("id"), diagnostics, "/project/id");
            text(project.get("title"), diagnostics, "/project/title");
        }
    }
    if let Some(value) = top.get("cut") {
        if let Some(cut) = object(value, diagnostics, "/cut") {
            exact_keys(cut, &["id", "revision"], &[], "/cut", diagnostics);
            identifier(cut.get("id"), diagnostics, "/cut/id");
            revision(cut.get("revision"), diagnostics, "/cut/revision");
        }
    }
}

fn validate_roots(project: &Value, diagnostics: &mut Vec<Diagnostic>) -> RootInfo {
    let mut root_ids = BTreeSet::new();
    let mut root_info = BTreeMap::new();
    for (index, value) in arrays(project, "roots", diagnostics).iter().enumerate() {
        let path = format!("/roots/{index}");
        let Some(root) = object(value, diagnostics, &path) else {
            continue;
        };
        exact_keys(root, &["id", "path", "visibility"], &[], &path, diagnostics);
        let id = unique_id(root, &path, &mut root_ids, diagnostics);
        let root_path =
            repository_path(root.get("path"), diagnostics, &format!("{path}/path"), true);
        let visibility = enumeration(
            root.get("visibility"),
            VISIBILITIES,
            diagnostics,
            &format!("{path}/visibility"),
        );
        if let (Some(id), Some(root_path), Some(visibility)) = (id, root_path, visibility) {
            root_info.insert(id, (root_path, visibility));
        }
    }
    root_info
}

fn validate_providers(
    project: &Value,
    root_info: &RootInfo,
    diagnostics: &mut Vec<Diagnostic>,
) -> Providers {
    let mut provider_ids = BTreeSet::new();
    let mut providers: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    for (index, value) in arrays(project, "providers", diagnostics).iter().enumerate() {
        let path = format!("/providers/{index}");
        let Some(provider) = object(value, diagnostics, &path) else {
            continue;
        };
        exact_keys(
            provider,
            &[
                "id",
                "kind",
                "authority",
                "visibility",
                "root",
                "paths",
                "revision",
            ],
            &[],
            &path,
            diagnostics,
        );
        let id = unique_id(provider, &path, &mut provider_ids, diagnostics);
        enumeration(
            provider.get("kind"),
            &["exact-file-manifest", "external-adapter"],
            diagnostics,
            &format!("{path}/kind"),
        );
        enumeration(
            provider.get("authority"),
            &[
                "project",
                "shifu",
                "product-runtime",
                "buildchain",
                "human-review",
            ],
            diagnostics,
            &format!("{path}/authority"),
        );
        let visibility = enumeration(
            provider.get("visibility"),
            VISIBILITIES,
            diagnostics,
            &format!("{path}/visibility"),
        );
        let root = identifier(provider.get("root"), diagnostics, &format!("{path}/root"));
        revision(
            provider.get("revision"),
            diagnostics,
            &format!("{path}/revision"),
        );
        if let (Some(root), Some(provider_visibility)) = (&root, &visibility) {
            match root_info.get(root) {
                None => push(
                    diagnostics,
                    "unknown-root",
                    format!("{path}/root"),
                    format!("unknown root: {root}"),
                ),
                Some((_, root_visibility))
                    if visibility_rank(provider_visibility) < visibility_rank(root_visibility) =>
                {
                    push(
                        diagnostics,
                        "visibility-broadening",
                        format!("{path}/visibility"),
                        format!(
                            "{root_visibility} root cannot enter {provider_visibility} provider"
                        ),
                    )
                }
                _ => {}
            }
        }
        let mut exact_paths = BTreeSet::new();
        match provider.get("paths").and_then(Value::as_array) {
            Some(paths) if !paths.is_empty() => {
                for (path_index, value) in paths.iter().enumerate() {
                    if let Some(exact) = repository_path(
                        Some(value),
                        diagnostics,
                        &format!("{path}/paths/{path_index}"),
                        false,
                    ) {
                        if !exact_paths.insert(exact.clone()) {
                            push(
                                diagnostics,
                                "duplicate-path",
                                format!("{path}/paths/{path_index}"),
                                format!("duplicates {exact}"),
                            );
                        }
                    }
                }
            }
            _ => push(
                diagnostics,
                "type",
                format!("{path}/paths"),
                "must be a non-empty array",
            ),
        }
        if let Some((root_path, _)) = root.as_ref().and_then(|id| root_info.get(id)) {
            for exact in &exact_paths {
                if root_path != "."
                    && exact != root_path
                    && !exact.starts_with(&format!("{root_path}/"))
                {
                    push(
                        diagnostics,
                        "root-escape",
                        format!("{path}/paths"),
                        format!("{exact} is outside declared root {root_path}"),
                    );
                }
            }
        }
        if let (Some(id), Some(visibility)) = (id, visibility) {
            providers.insert(id, (visibility, exact_paths));
        }
    }
    providers
}

fn validate_nodes(
    project: &Value,
    providers: &Providers,
    diagnostics: &mut Vec<Diagnostic>,
) -> Nodes {
    let mut node_ids = BTreeSet::new();
    let mut nodes: BTreeMap<String, Value> = BTreeMap::new();
    for (index, value) in arrays(project, "nodes", diagnostics).iter().enumerate() {
        let path = format!("/nodes/{index}");
        let Some(node) = object(value, diagnostics, &path) else {
            continue;
        };
        exact_keys(
            node,
            &[
                "id",
                "kind",
                "visibility",
                "revision",
                "provenance",
                "source",
                "verification",
            ],
            &[],
            &path,
            diagnostics,
        );
        let id = unique_id(node, &path, &mut node_ids, diagnostics);
        enumeration(
            node.get("kind"),
            NODE_KINDS,
            diagnostics,
            &format!("{path}/kind"),
        );
        let node_visibility = enumeration(
            node.get("visibility"),
            VISIBILITIES,
            diagnostics,
            &format!("{path}/visibility"),
        );
        revision(
            node.get("revision"),
            diagnostics,
            &format!("{path}/revision"),
        );
        if let Some(provenance_value) = node.get("provenance") {
            if let Some(provenance) =
                object(provenance_value, diagnostics, &format!("{path}/provenance"))
            {
                exact_keys(
                    provenance,
                    &["kind", "authority"],
                    &[],
                    &format!("{path}/provenance"),
                    diagnostics,
                );
                enumeration(
                    provenance.get("kind"),
                    &[
                        "project-source",
                        "provider-derived",
                        "human-review",
                        "compiler-inference",
                    ],
                    diagnostics,
                    &format!("{path}/provenance/kind"),
                );
                identifier(
                    provenance.get("authority"),
                    diagnostics,
                    &format!("{path}/provenance/authority"),
                );
            }
        }
        if let Some(source_value) = node.get("source") {
            if let Some(source) = object(source_value, diagnostics, &format!("{path}/source")) {
                exact_keys(
                    source,
                    &["provider", "path"],
                    &[],
                    &format!("{path}/source"),
                    diagnostics,
                );
                let provider = identifier(
                    source.get("provider"),
                    diagnostics,
                    &format!("{path}/source/provider"),
                );
                let source_path = repository_path(
                    source.get("path"),
                    diagnostics,
                    &format!("{path}/source/path"),
                    false,
                );
                if let Some(provider) = provider {
                    match providers.get(&provider) {
                        None => push(
                            diagnostics,
                            "unknown-provider",
                            format!("{path}/source/provider"),
                            format!("unknown provider: {provider}"),
                        ),
                        Some((provider_visibility, paths)) => {
                            if let Some(source_path) = source_path.as_ref() {
                                if !paths.contains(source_path) {
                                    push(
                                        diagnostics,
                                        "provider-broadening",
                                        format!("{path}/source/path"),
                                        format!("path is not declared by provider {provider}"),
                                    );
                                }
                            }
                            if let Some(node_visibility) = node_visibility.as_ref() {
                                if visibility_rank(node_visibility)
                                    < visibility_rank(provider_visibility)
                                {
                                    push(diagnostics, "visibility-broadening", format!("{path}/visibility"), format!("{provider_visibility} provider cannot enter {node_visibility} node"));
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(verification_value) = node.get("verification") {
            if let Some(verification) = object(
                verification_value,
                diagnostics,
                &format!("{path}/verification"),
            ) {
                exact_keys(
                    verification,
                    &["mode", "status", "dependencies", "waiver"],
                    &[],
                    &format!("{path}/verification"),
                    diagnostics,
                );
                let mode = enumeration(
                    verification.get("mode"),
                    MODES,
                    diagnostics,
                    &format!("{path}/verification/mode"),
                );
                let status = enumeration(
                    verification.get("status"),
                    STATUSES,
                    diagnostics,
                    &format!("{path}/verification/status"),
                );
                let expected = match mode.as_deref() {
                    Some("machine") => Some("machine-proved"),
                    Some("human") => Some("human-reviewed"),
                    Some("mixed") => Some("mixed"),
                    Some("non-claim") => Some("non-claim"),
                    _ => None,
                };
                if let (Some(expected), Some(status)) = (expected, status.as_deref()) {
                    if status != expected && !matches!(status, "waived" | "stale" | "invalidated") {
                        push(
                            diagnostics,
                            "verification-status",
                            format!("{path}/verification/status"),
                            format!("{mode:?} mode requires {expected} or waived"),
                        );
                    }
                }
                if status.as_deref() == Some("waived") {
                    if let Some(waiver) = verification.get("waiver").and_then(Value::as_object) {
                        let waiver_path = format!("{path}/verification/waiver");
                        exact_keys(
                            waiver,
                            &["reason", "owner", "expires"],
                            &[],
                            &waiver_path,
                            diagnostics,
                        );
                        text(
                            waiver.get("reason"),
                            diagnostics,
                            &format!("{waiver_path}/reason"),
                        );
                        identifier(
                            waiver.get("owner"),
                            diagnostics,
                            &format!("{waiver_path}/owner"),
                        );
                        text(
                            waiver.get("expires"),
                            diagnostics,
                            &format!("{waiver_path}/expires"),
                        );
                    } else {
                        push(
                            diagnostics,
                            "waiver",
                            format!("{path}/verification/waiver"),
                            "waived status requires reason, owner, and expires",
                        );
                    }
                } else if !verification.get("waiver").is_some_and(Value::is_null) {
                    push(
                        diagnostics,
                        "waiver",
                        format!("{path}/verification/waiver"),
                        "must be null unless status is waived",
                    );
                }
                match verification.get("dependencies").and_then(Value::as_array) {
                    Some(dependencies) => {
                        for (dependency_index, value) in dependencies.iter().enumerate() {
                            let dependency_path =
                                format!("{path}/verification/dependencies/{dependency_index}");
                            if let Some(dependency) = object(value, diagnostics, &dependency_path) {
                                exact_keys(
                                    dependency,
                                    &["node", "expectedRevision"],
                                    &[],
                                    &dependency_path,
                                    diagnostics,
                                );
                                identifier(
                                    dependency.get("node"),
                                    diagnostics,
                                    &format!("{dependency_path}/node"),
                                );
                                revision(
                                    dependency.get("expectedRevision"),
                                    diagnostics,
                                    &format!("{dependency_path}/expectedRevision"),
                                );
                            }
                        }
                    }
                    None => push(
                        diagnostics,
                        "type",
                        format!("{path}/verification/dependencies"),
                        "must be an array",
                    ),
                }
            }
        }
        if let Some(id) = id {
            nodes.insert(id, value.clone());
        }
    }
    nodes
}

fn validate_graphs(project: &Value, nodes: &Nodes, diagnostics: &mut Vec<Diagnostic>) {
    let mut dependency_adjacency: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, node) in nodes {
        let dependencies = node
            .pointer("/verification/dependencies")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (index, dependency) in dependencies.iter().enumerate() {
            if let Some(target) = dependency.get("node").and_then(Value::as_str) {
                if !nodes.contains_key(target) {
                    push(
                        diagnostics,
                        "unknown-node",
                        format!("/nodes/{id}/verification/dependencies/{index}/node"),
                        format!("unknown node: {target}"),
                    );
                } else {
                    dependency_adjacency
                        .entry(id.clone())
                        .or_default()
                        .push(target.to_owned());
                }
            }
        }
    }

    let mut relation_adjacency: BTreeMap<String, Vec<String>> = BTreeMap::new();
    match project.get("edges").and_then(Value::as_array) {
        Some(edges) => {
            for (index, value) in edges.iter().enumerate() {
                let path = format!("/edges/{index}");
                let Some(edge) = object(value, diagnostics, &path) else {
                    continue;
                };
                exact_keys(edge, &["from", "relation", "to"], &[], &path, diagnostics);
                let from = identifier(edge.get("from"), diagnostics, &format!("{path}/from"));
                enumeration(
                    edge.get("relation"),
                    RELATIONS,
                    diagnostics,
                    &format!("{path}/relation"),
                );
                let to = identifier(edge.get("to"), diagnostics, &format!("{path}/to"));
                if let Some(from) = from.as_ref() {
                    if !nodes.contains_key(from) {
                        push(
                            diagnostics,
                            "unknown-node",
                            format!("{path}/from"),
                            format!("unknown node: {from}"),
                        );
                    }
                }
                if let Some(to) = to.as_ref() {
                    if !nodes.contains_key(to) {
                        push(
                            diagnostics,
                            "unknown-node",
                            format!("{path}/to"),
                            format!("unknown node: {to}"),
                        );
                    }
                }
                if let (Some(from), Some(to)) = (from, to) {
                    relation_adjacency.entry(from).or_default().push(to);
                }
            }
        }
        None => push(diagnostics, "type", "/edges", "must be an array"),
    }
    fn visit(
        node: &str,
        adjacency: &BTreeMap<String, Vec<String>>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> bool {
        if visiting.contains(node) {
            return true;
        }
        if visited.contains(node) {
            return false;
        }
        visiting.insert(node.to_owned());
        let cycle = adjacency.get(node).is_some_and(|targets| {
            targets
                .iter()
                .any(|target| visit(target, adjacency, visiting, visited))
        });
        visiting.remove(node);
        visited.insert(node.to_owned());
        cycle
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let dependency_cycle = nodes
        .keys()
        .any(|id| visit(id, &dependency_adjacency, &mut visiting, &mut visited));
    visiting.clear();
    visited.clear();
    let relation_cycle = nodes
        .keys()
        .any(|id| visit(id, &relation_adjacency, &mut visiting, &mut visited));
    if dependency_cycle || relation_cycle {
        push(
            diagnostics,
            "cycle",
            "/edges",
            "relation and verification dependency graphs must each be acyclic in v1",
        );
    }
}

fn validate_route_resolution(
    route: &Map<String, Value>,
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let Some(resolution_value) = route.get("resolution") else {
        return;
    };
    let resolution_path = format!("{path}/resolution");
    let Some(resolution) = object(resolution_value, diagnostics, &resolution_path) else {
        return;
    };
    let keys = [
        "subjects",
        "capabilities",
        "owners",
        "roles",
        "mission_tracks",
        "terms",
    ];
    exact_keys(resolution, &keys, &[], &resolution_path, diagnostics);
    for key in keys {
        match resolution.get(key).and_then(Value::as_array) {
            Some(items) if !items.is_empty() => {
                let mut seen = BTreeSet::new();
                for (item_index, item) in items.iter().enumerate() {
                    let item_path = format!("{resolution_path}/{key}/{item_index}");
                    if let Some(value) = text(Some(item), diagnostics, &item_path) {
                        if !seen.insert(value.to_ascii_lowercase()) {
                            push(
                                diagnostics,
                                "duplicate-route-intent",
                                item_path,
                                "duplicates a route resolution value",
                            );
                        }
                    }
                }
            }
            _ => push(
                diagnostics,
                "type",
                format!("{resolution_path}/{key}"),
                "must be a non-empty array",
            ),
        }
    }
}

fn validate_routes(project: &Value, nodes: &Nodes, diagnostics: &mut Vec<Diagnostic>) {
    let mut route_ids = BTreeSet::new();
    let mut parity: BTreeMap<String, Vec<(String, BTreeSet<String>, String)>> = BTreeMap::new();
    for (index, value) in arrays(project, "routes", diagnostics).iter().enumerate() {
        let path = format!("/routes/{index}");
        let Some(route) = object(value, diagnostics, &path) else {
            continue;
        };
        exact_keys(
            route,
            &[
                "id",
                "audience",
                "parityGroup",
                "visibility",
                "nodes",
                "entrypoints",
            ],
            &["resolution"],
            &path,
            diagnostics,
        );
        unique_id(route, &path, &mut route_ids, diagnostics);
        let audience = enumeration(
            route.get("audience"),
            &["human", "agent"],
            diagnostics,
            &format!("{path}/audience"),
        );
        let group = identifier(
            route.get("parityGroup"),
            diagnostics,
            &format!("{path}/parityGroup"),
        );
        let route_visibility = enumeration(
            route.get("visibility"),
            VISIBILITIES,
            diagnostics,
            &format!("{path}/visibility"),
        );
        let mut selected = BTreeSet::new();
        match route.get("nodes").and_then(Value::as_array) {
            Some(items) if !items.is_empty() => {
                for (item_index, item) in items.iter().enumerate() {
                    if let Some(node_id) = identifier(
                        Some(item),
                        diagnostics,
                        &format!("{path}/nodes/{item_index}"),
                    ) {
                        if !selected.insert(node_id.clone()) {
                            push(
                                diagnostics,
                                "duplicate-route-node",
                                format!("{path}/nodes/{item_index}"),
                                format!("duplicates {node_id}"),
                            );
                        }
                        match nodes.get(&node_id) {
                            None => push(
                                diagnostics,
                                "unknown-node",
                                format!("{path}/nodes/{item_index}"),
                                format!("unknown node: {node_id}"),
                            ),
                            Some(node)
                                if route_visibility
                                    .as_ref()
                                    .zip(node.get("visibility").and_then(Value::as_str))
                                    .is_some_and(|(route_visibility, node_visibility)| {
                                        visibility_rank(route_visibility)
                                            < visibility_rank(node_visibility)
                                    }) =>
                            {
                                push(
                                    diagnostics,
                                    "visibility-broadening",
                                    format!("{path}/nodes/{item_index}"),
                                    "route is broader than selected node",
                                )
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => push(
                diagnostics,
                "type",
                format!("{path}/nodes"),
                "must be a non-empty array",
            ),
        }
        match route.get("entrypoints").and_then(Value::as_array) {
            Some(items) if !items.is_empty() => {
                for (item_index, item) in items.iter().enumerate() {
                    repository_path(
                        Some(item),
                        diagnostics,
                        &format!("{path}/entrypoints/{item_index}"),
                        false,
                    );
                }
            }
            _ => push(
                diagnostics,
                "type",
                format!("{path}/entrypoints"),
                "must be a non-empty array",
            ),
        }
        validate_route_resolution(route, &path, diagnostics);
        if let (Some(group), Some(audience)) = (group, audience) {
            let resolution = stable_json(route.get("resolution").unwrap_or(&Value::Null));
            parity
                .entry(group)
                .or_default()
                .push((audience, selected, resolution));
        }
    }
    for (group, routes) in parity {
        let humans: Vec<_> = routes.iter().filter(|route| route.0 == "human").collect();
        let agents: Vec<_> = routes.iter().filter(|route| route.0 == "agent").collect();
        if humans.len() != 1 || agents.len() != 1 {
            push(
                diagnostics,
                "route-parity",
                "/routes",
                format!("parity group {group} requires exactly one human and one agent route"),
            );
        } else if humans[0].1 != agents[0].1 {
            push(
                diagnostics,
                "route-parity",
                "/routes",
                format!("parity group {group} must expose the same authority node set"),
            );
        } else if humans[0].2 != agents[0].2 {
            push(
                diagnostics,
                "route-parity",
                "/routes",
                format!("parity group {group} must declare the same route resolution intent"),
            );
        }
    }
}

fn validate_policies(top: &Map<String, Value>, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(value) = top.get("policies") {
        if let Some(policies) = object(value, diagnostics, "/policies") {
            exact_keys(
                policies,
                &[
                    "unknownFields",
                    "pathSemantics",
                    "visibility",
                    "dualFirstParity",
                    "verification",
                ],
                &[],
                "/policies",
                diagnostics,
            );
            for (key, expected) in [
                ("unknownFields", "reject"),
                ("pathSemantics", "repository-relative-posix"),
                ("visibility", "fail-closed"),
                ("dualFirstParity", "required"),
                ("verification", "declared-dependencies"),
            ] {
                if policies.get(key).and_then(Value::as_str) != Some(expected) {
                    push(
                        diagnostics,
                        "policy",
                        format!("/policies/{key}"),
                        format!("must be {expected}"),
                    );
                }
            }
        }
    }
}
