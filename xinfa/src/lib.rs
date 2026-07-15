// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const PROJECT_SCHEMA_ID: &str = "https://xinfa.dev/schema/project-v1.schema.json";
pub const PROJECT_VERSION: &str = "xinfa.project/v1";

const TOP_KEYS: &[&str] = &[
    "$schema",
    "schema",
    "project",
    "cut",
    "roots",
    "providers",
    "nodes",
    "edges",
    "routes",
    "policies",
];
const VISIBILITIES: &[&str] = &["public", "internal", "private"];
const NODE_KINDS: &[&str] = &[
    "document",
    "subject",
    "claim",
    "invariant",
    "decision",
    "implementation",
    "probe",
    "evidence",
];
const MODES: &[&str] = &["machine", "human", "mixed", "non-claim"];
const STATUSES: &[&str] = &[
    "machine-proved",
    "human-reviewed",
    "mixed",
    "non-claim",
    "waived",
    "stale",
    "invalidated",
];
const RELATIONS: &[&str] = &[
    "defines",
    "explains",
    "constrains",
    "decides",
    "implements",
    "proves",
    "depends-on",
    "supersedes",
    "expands-to",
];

#[derive(Clone, Debug, Eq, PartialEq)]
struct Diagnostic {
    code: &'static str,
    path: String,
    message: String,
}

impl Diagnostic {
    fn value(&self) -> Value {
        json!({"code": self.code, "path": self.path, "message": self.message})
    }
}

fn push(
    diagnostics: &mut Vec<Diagnostic>,
    code: &'static str,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    diagnostics.push(Diagnostic {
        code,
        path: path.into(),
        message: message.into(),
    });
}

fn object<'a>(
    value: &'a Value,
    diagnostics: &mut Vec<Diagnostic>,
    path: &str,
) -> Option<&'a Map<String, Value>> {
    value.as_object().or_else(|| {
        push(diagnostics, "type", path, "must be an object");
        None
    })
}

fn exact_keys(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    path: &str,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let allowed: BTreeSet<&str> = required.iter().chain(optional.iter()).copied().collect();
    for key in object.keys() {
        if !allowed.contains(key.as_str()) {
            push(
                diagnostics,
                "unknown-field",
                format!("{path}/{key}"),
                "is not declared by v1",
            );
        }
    }
    for key in required {
        if !object.contains_key(*key) {
            push(
                diagnostics,
                "required-field",
                format!("{path}/{key}"),
                "is required",
            );
        }
    }
}

fn text<'a>(
    value: Option<&'a Value>,
    diagnostics: &mut Vec<Diagnostic>,
    path: &str,
) -> Option<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            push(diagnostics, "type", path, "must be a non-empty string");
            None
        })
}

fn identifier(
    value: Option<&Value>,
    diagnostics: &mut Vec<Diagnostic>,
    path: &str,
) -> Option<String> {
    let value = text(value, diagnostics, path)?;
    let valid = value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.split(['.', '_', '-']).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        });
    if !valid {
        push(
            diagnostics,
            "id",
            path,
            "must be a lowercase dotted identifier",
        );
        return None;
    }
    Some(value.to_owned())
}

fn enumeration(
    value: Option<&Value>,
    allowed: &[&str],
    diagnostics: &mut Vec<Diagnostic>,
    path: &str,
) -> Option<String> {
    let value = text(value, diagnostics, path)?;
    if !allowed.contains(&value) {
        push(
            diagnostics,
            "enum",
            path,
            format!("must be one of: {}", allowed.join(", ")),
        );
        return None;
    }
    Some(value.to_owned())
}

fn revision(
    value: Option<&Value>,
    diagnostics: &mut Vec<Diagnostic>,
    path: &str,
) -> Option<String> {
    let value = text(value, diagnostics, path)?;
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        push(
            diagnostics,
            "revision",
            path,
            "must be sha256 followed by 64 lowercase hexadecimal digits",
        );
        return None;
    }
    Some(value.to_owned())
}

fn repository_path(
    value: Option<&Value>,
    diagnostics: &mut Vec<Diagnostic>,
    path: &str,
    allow_root: bool,
) -> Option<String> {
    let value = text(value, diagnostics, path)?;
    let invalid = value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\\')
        || value.contains('*')
        || value.contains('?')
        || value.contains('[')
        || value.contains(']')
        || value.contains('{')
        || value.contains('}')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == ".." || part == ".")
        || (!allow_root && value == ".")
        || (value.len() > 1 && value.as_bytes()[1] == b':');
    if invalid && !(allow_root && value == ".") {
        push(
            diagnostics,
            "invalid-path",
            path,
            "must be an exact repository-relative POSIX path without traversal or glob syntax",
        );
        return None;
    }
    Some(value.to_owned())
}

fn visibility_rank(value: &str) -> usize {
    VISIBILITIES
        .iter()
        .position(|candidate| *candidate == value)
        .unwrap_or(usize::MAX)
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn stable_json(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string(&canonical(value)).expect("JSON value serializes")
    )
}

fn digest(value: &Value) -> String {
    format!("sha256:{:x}", Sha256::digest(stable_json(value).as_bytes()))
}

fn sort_by_id(value: &mut Value, key: &str) {
    if let Some(values) = value.get_mut(key).and_then(Value::as_array_mut) {
        values.sort_by(|left, right| {
            left.get("id")
                .and_then(Value::as_str)
                .cmp(&right.get("id").and_then(Value::as_str))
        });
    }
}

fn normalized(project: &Value) -> Value {
    let mut value = project.clone();
    for key in ["roots", "providers", "nodes", "routes"] {
        sort_by_id(&mut value, key);
    }
    if let Some(edges) = value.get_mut("edges").and_then(Value::as_array_mut) {
        edges.sort_by_key(|edge| {
            (
                edge.get("from")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                edge.get("relation")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                edge.get("to")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )
        });
    }
    if let Some(providers) = value.get_mut("providers").and_then(Value::as_array_mut) {
        for provider in providers {
            if let Some(paths) = provider.get_mut("paths").and_then(Value::as_array_mut) {
                paths.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
        }
    }
    if let Some(nodes) = value.get_mut("nodes").and_then(Value::as_array_mut) {
        for node in nodes {
            if let Some(dependencies) = node
                .pointer_mut("/verification/dependencies")
                .and_then(Value::as_array_mut)
            {
                dependencies.sort_by(|a, b| {
                    a.get("node")
                        .and_then(Value::as_str)
                        .cmp(&b.get("node").and_then(Value::as_str))
                });
            }
        }
    }
    if let Some(routes) = value.get_mut("routes").and_then(Value::as_array_mut) {
        for route in routes {
            for key in ["nodes", "entrypoints"] {
                if let Some(values) = route.get_mut(key).and_then(Value::as_array_mut) {
                    values.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                }
            }
        }
    }
    canonical(&value)
}

fn arrays<'a>(value: &'a Value, key: &str, diagnostics: &mut Vec<Diagnostic>) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .map(Vec::as_slice)
        .unwrap_or_else(|| {
            push(
                diagnostics,
                "type",
                format!("/{key}"),
                "must be a non-empty array",
            );
            &[]
        })
}

fn unique_id(
    object: &Map<String, Value>,
    path: &str,
    seen: &mut BTreeSet<String>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<String> {
    let id = identifier(object.get("id"), diagnostics, &format!("{path}/id"))?;
    if !seen.insert(id.clone()) {
        push(
            diagnostics,
            "duplicate-id",
            format!("{path}/id"),
            format!("duplicates {id}"),
        );
    }
    Some(id)
}

fn validate(project: &Value) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let Some(top) = object(project, &mut diagnostics, "") else {
        return diagnostics;
    };
    exact_keys(top, TOP_KEYS, &[], "", &mut diagnostics);
    if top.get("$schema").and_then(Value::as_str) != Some(PROJECT_SCHEMA_ID) {
        push(
            &mut diagnostics,
            "schema-id",
            "/$schema",
            format!("must be {PROJECT_SCHEMA_ID}"),
        );
    }
    if top.get("schema").and_then(Value::as_str) != Some(PROJECT_VERSION) {
        push(
            &mut diagnostics,
            "unsupported-version",
            "/schema",
            format!("must be {PROJECT_VERSION}"),
        );
    }

    if let Some(value) = top.get("project") {
        if let Some(project) = object(value, &mut diagnostics, "/project") {
            exact_keys(project, &["id", "title"], &[], "/project", &mut diagnostics);
            identifier(project.get("id"), &mut diagnostics, "/project/id");
            text(project.get("title"), &mut diagnostics, "/project/title");
        }
    }
    if let Some(value) = top.get("cut") {
        if let Some(cut) = object(value, &mut diagnostics, "/cut") {
            exact_keys(cut, &["id", "revision"], &[], "/cut", &mut diagnostics);
            identifier(cut.get("id"), &mut diagnostics, "/cut/id");
            revision(cut.get("revision"), &mut diagnostics, "/cut/revision");
        }
    }

    let mut root_ids = BTreeSet::new();
    let mut root_info = BTreeMap::new();
    for (index, value) in arrays(project, "roots", &mut diagnostics)
        .iter()
        .enumerate()
    {
        let path = format!("/roots/{index}");
        let Some(root) = object(value, &mut diagnostics, &path) else {
            continue;
        };
        exact_keys(
            root,
            &["id", "path", "visibility"],
            &[],
            &path,
            &mut diagnostics,
        );
        let id = unique_id(root, &path, &mut root_ids, &mut diagnostics);
        let root_path = repository_path(
            root.get("path"),
            &mut diagnostics,
            &format!("{path}/path"),
            true,
        );
        let visibility = enumeration(
            root.get("visibility"),
            VISIBILITIES,
            &mut diagnostics,
            &format!("{path}/visibility"),
        );
        if let (Some(id), Some(root_path), Some(visibility)) = (id, root_path, visibility) {
            root_info.insert(id, (root_path, visibility));
        }
    }

    let mut provider_ids = BTreeSet::new();
    let mut providers: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    for (index, value) in arrays(project, "providers", &mut diagnostics)
        .iter()
        .enumerate()
    {
        let path = format!("/providers/{index}");
        let Some(provider) = object(value, &mut diagnostics, &path) else {
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
            &mut diagnostics,
        );
        let id = unique_id(provider, &path, &mut provider_ids, &mut diagnostics);
        enumeration(
            provider.get("kind"),
            &["exact-file-manifest", "external-adapter"],
            &mut diagnostics,
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
            &mut diagnostics,
            &format!("{path}/authority"),
        );
        let visibility = enumeration(
            provider.get("visibility"),
            VISIBILITIES,
            &mut diagnostics,
            &format!("{path}/visibility"),
        );
        let root = identifier(
            provider.get("root"),
            &mut diagnostics,
            &format!("{path}/root"),
        );
        revision(
            provider.get("revision"),
            &mut diagnostics,
            &format!("{path}/revision"),
        );
        if let (Some(root), Some(provider_visibility)) = (&root, &visibility) {
            match root_info.get(root) {
                None => push(
                    &mut diagnostics,
                    "unknown-root",
                    format!("{path}/root"),
                    format!("unknown root: {root}"),
                ),
                Some((_, root_visibility))
                    if visibility_rank(provider_visibility) < visibility_rank(root_visibility) =>
                {
                    push(
                        &mut diagnostics,
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
                        &mut diagnostics,
                        &format!("{path}/paths/{path_index}"),
                        false,
                    ) {
                        if !exact_paths.insert(exact.clone()) {
                            push(
                                &mut diagnostics,
                                "duplicate-path",
                                format!("{path}/paths/{path_index}"),
                                format!("duplicates {exact}"),
                            );
                        }
                    }
                }
            }
            _ => push(
                &mut diagnostics,
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
                        &mut diagnostics,
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

    let mut node_ids = BTreeSet::new();
    let mut nodes: BTreeMap<String, Value> = BTreeMap::new();
    for (index, value) in arrays(project, "nodes", &mut diagnostics)
        .iter()
        .enumerate()
    {
        let path = format!("/nodes/{index}");
        let Some(node) = object(value, &mut diagnostics, &path) else {
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
            &mut diagnostics,
        );
        let id = unique_id(node, &path, &mut node_ids, &mut diagnostics);
        enumeration(
            node.get("kind"),
            NODE_KINDS,
            &mut diagnostics,
            &format!("{path}/kind"),
        );
        let node_visibility = enumeration(
            node.get("visibility"),
            VISIBILITIES,
            &mut diagnostics,
            &format!("{path}/visibility"),
        );
        revision(
            node.get("revision"),
            &mut diagnostics,
            &format!("{path}/revision"),
        );
        if let Some(provenance_value) = node.get("provenance") {
            if let Some(provenance) = object(
                provenance_value,
                &mut diagnostics,
                &format!("{path}/provenance"),
            ) {
                exact_keys(
                    provenance,
                    &["kind", "authority"],
                    &[],
                    &format!("{path}/provenance"),
                    &mut diagnostics,
                );
                enumeration(
                    provenance.get("kind"),
                    &[
                        "project-source",
                        "provider-derived",
                        "human-review",
                        "compiler-inference",
                    ],
                    &mut diagnostics,
                    &format!("{path}/provenance/kind"),
                );
                identifier(
                    provenance.get("authority"),
                    &mut diagnostics,
                    &format!("{path}/provenance/authority"),
                );
            }
        }
        if let Some(source_value) = node.get("source") {
            if let Some(source) = object(source_value, &mut diagnostics, &format!("{path}/source"))
            {
                exact_keys(
                    source,
                    &["provider", "path"],
                    &[],
                    &format!("{path}/source"),
                    &mut diagnostics,
                );
                let provider = identifier(
                    source.get("provider"),
                    &mut diagnostics,
                    &format!("{path}/source/provider"),
                );
                let source_path = repository_path(
                    source.get("path"),
                    &mut diagnostics,
                    &format!("{path}/source/path"),
                    false,
                );
                if let Some(provider) = provider {
                    match providers.get(&provider) {
                        None => push(
                            &mut diagnostics,
                            "unknown-provider",
                            format!("{path}/source/provider"),
                            format!("unknown provider: {provider}"),
                        ),
                        Some((provider_visibility, paths)) => {
                            if let Some(source_path) = source_path.as_ref() {
                                if !paths.contains(source_path) {
                                    push(
                                        &mut diagnostics,
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
                                    push(&mut diagnostics, "visibility-broadening", format!("{path}/visibility"), format!("{provider_visibility} provider cannot enter {node_visibility} node"));
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
                &mut diagnostics,
                &format!("{path}/verification"),
            ) {
                exact_keys(
                    verification,
                    &["mode", "status", "dependencies", "waiver"],
                    &[],
                    &format!("{path}/verification"),
                    &mut diagnostics,
                );
                let mode = enumeration(
                    verification.get("mode"),
                    MODES,
                    &mut diagnostics,
                    &format!("{path}/verification/mode"),
                );
                let status = enumeration(
                    verification.get("status"),
                    STATUSES,
                    &mut diagnostics,
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
                            &mut diagnostics,
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
                            &mut diagnostics,
                        );
                        text(
                            waiver.get("reason"),
                            &mut diagnostics,
                            &format!("{waiver_path}/reason"),
                        );
                        identifier(
                            waiver.get("owner"),
                            &mut diagnostics,
                            &format!("{waiver_path}/owner"),
                        );
                        text(
                            waiver.get("expires"),
                            &mut diagnostics,
                            &format!("{waiver_path}/expires"),
                        );
                    } else {
                        push(
                            &mut diagnostics,
                            "waiver",
                            format!("{path}/verification/waiver"),
                            "waived status requires reason, owner, and expires",
                        );
                    }
                } else if !verification.get("waiver").is_some_and(Value::is_null) {
                    push(
                        &mut diagnostics,
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
                            if let Some(dependency) =
                                object(value, &mut diagnostics, &dependency_path)
                            {
                                exact_keys(
                                    dependency,
                                    &["node", "expectedRevision"],
                                    &[],
                                    &dependency_path,
                                    &mut diagnostics,
                                );
                                identifier(
                                    dependency.get("node"),
                                    &mut diagnostics,
                                    &format!("{dependency_path}/node"),
                                );
                                revision(
                                    dependency.get("expectedRevision"),
                                    &mut diagnostics,
                                    &format!("{dependency_path}/expectedRevision"),
                                );
                            }
                        }
                    }
                    None => push(
                        &mut diagnostics,
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

    let mut dependency_adjacency: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, node) in &nodes {
        let dependencies = node
            .pointer("/verification/dependencies")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for (index, dependency) in dependencies.iter().enumerate() {
            if let Some(target) = dependency.get("node").and_then(Value::as_str) {
                if !nodes.contains_key(target) {
                    push(
                        &mut diagnostics,
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
                let Some(edge) = object(value, &mut diagnostics, &path) else {
                    continue;
                };
                exact_keys(
                    edge,
                    &["from", "relation", "to"],
                    &[],
                    &path,
                    &mut diagnostics,
                );
                let from = identifier(edge.get("from"), &mut diagnostics, &format!("{path}/from"));
                enumeration(
                    edge.get("relation"),
                    RELATIONS,
                    &mut diagnostics,
                    &format!("{path}/relation"),
                );
                let to = identifier(edge.get("to"), &mut diagnostics, &format!("{path}/to"));
                if let Some(from) = from.as_ref() {
                    if !nodes.contains_key(from) {
                        push(
                            &mut diagnostics,
                            "unknown-node",
                            format!("{path}/from"),
                            format!("unknown node: {from}"),
                        );
                    }
                }
                if let Some(to) = to.as_ref() {
                    if !nodes.contains_key(to) {
                        push(
                            &mut diagnostics,
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
        None => push(&mut diagnostics, "type", "/edges", "must be an array"),
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
            &mut diagnostics,
            "cycle",
            "/edges",
            "relation and verification dependency graphs must each be acyclic in v1",
        );
    }

    let mut route_ids = BTreeSet::new();
    let mut parity: BTreeMap<String, Vec<(String, String, BTreeSet<String>)>> = BTreeMap::new();
    for (index, value) in arrays(project, "routes", &mut diagnostics)
        .iter()
        .enumerate()
    {
        let path = format!("/routes/{index}");
        let Some(route) = object(value, &mut diagnostics, &path) else {
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
            &[],
            &path,
            &mut diagnostics,
        );
        let id = unique_id(route, &path, &mut route_ids, &mut diagnostics);
        let audience = enumeration(
            route.get("audience"),
            &["human", "agent"],
            &mut diagnostics,
            &format!("{path}/audience"),
        );
        let group = identifier(
            route.get("parityGroup"),
            &mut diagnostics,
            &format!("{path}/parityGroup"),
        );
        let route_visibility = enumeration(
            route.get("visibility"),
            VISIBILITIES,
            &mut diagnostics,
            &format!("{path}/visibility"),
        );
        let mut selected = BTreeSet::new();
        match route.get("nodes").and_then(Value::as_array) {
            Some(items) if !items.is_empty() => {
                for (item_index, item) in items.iter().enumerate() {
                    if let Some(node_id) = identifier(
                        Some(item),
                        &mut diagnostics,
                        &format!("{path}/nodes/{item_index}"),
                    ) {
                        if !selected.insert(node_id.clone()) {
                            push(
                                &mut diagnostics,
                                "duplicate-route-node",
                                format!("{path}/nodes/{item_index}"),
                                format!("duplicates {node_id}"),
                            );
                        }
                        match nodes.get(&node_id) {
                            None => push(
                                &mut diagnostics,
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
                                    &mut diagnostics,
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
                &mut diagnostics,
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
                        &mut diagnostics,
                        &format!("{path}/entrypoints/{item_index}"),
                        false,
                    );
                }
            }
            _ => push(
                &mut diagnostics,
                "type",
                format!("{path}/entrypoints"),
                "must be a non-empty array",
            ),
        }
        if let (Some(group), Some(id), Some(audience)) = (group, id, audience) {
            parity
                .entry(group)
                .or_default()
                .push((id, audience, selected));
        }
    }
    for (group, routes) in parity {
        let humans: Vec<_> = routes.iter().filter(|route| route.1 == "human").collect();
        let agents: Vec<_> = routes.iter().filter(|route| route.1 == "agent").collect();
        if humans.len() != 1 || agents.len() != 1 {
            push(
                &mut diagnostics,
                "route-parity",
                "/routes",
                format!("parity group {group} requires exactly one human and one agent route"),
            );
        } else if humans[0].2 != agents[0].2 {
            push(
                &mut diagnostics,
                "route-parity",
                "/routes",
                format!("parity group {group} must expose the same authority node set"),
            );
        }
    }

    if let Some(value) = top.get("policies") {
        if let Some(policies) = object(value, &mut diagnostics, "/policies") {
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
                &mut diagnostics,
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
                        &mut diagnostics,
                        "policy",
                        format!("/policies/{key}"),
                        format!("must be {expected}"),
                    );
                }
            }
        }
    }
    diagnostics.sort_by(|left, right| {
        (&left.path, left.code, &left.message).cmp(&(&right.path, right.code, &right.message))
    });
    diagnostics
}

fn parse(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("invalid JSON: {error}"))
}

fn receipt(
    project: Option<&Value>,
    source: &str,
    diagnostics: &[Diagnostic],
    projection: Option<Value>,
) -> Value {
    let source_kind = if source == "-" || source == "stdin" {
        "stdin"
    } else {
        "file"
    };
    json!({
        "schema": "xinfa.project-validation-receipt/v1",
        "source": source_kind,
        "valid": diagnostics.is_empty(),
        "qualifying": false,
        "selfCertified": false,
        "projectRoot": project.map(|value| digest(&normalized(value))),
        "diagnostics": diagnostics.iter().map(Diagnostic::value).collect::<Vec<_>>(),
        "projection": projection,
    })
}

pub fn validate_project_bytes(bytes: &[u8], source: &str) -> Result<String, String> {
    validate_project_bytes_with_validity(bytes, source).map(|result| result.0)
}

pub fn validate_project_bytes_with_validity(
    bytes: &[u8],
    source: &str,
) -> Result<(String, bool), String> {
    let project = match parse(bytes) {
        Ok(project) => project,
        Err(message) => {
            let diagnostics = vec![Diagnostic {
                code: "invalid-json",
                path: "/".to_owned(),
                message,
            }];
            let output = serde_json::to_string_pretty(&receipt(None, source, &diagnostics, None))
                .map(|value| format!("{value}\n"))
                .map_err(|error| error.to_string())?;
            return Ok((output, false));
        }
    };
    let diagnostics = validate(&project);
    let valid = diagnostics.is_empty();
    serde_json::to_string_pretty(&receipt(Some(&project), source, &diagnostics, None))
        .map(|value| (format!("{value}\n"), valid))
        .map_err(|error| error.to_string())
}

pub fn canonicalize_project_bytes(bytes: &[u8], source: &str) -> Result<String, String> {
    let (output, valid) = canonicalize_project_bytes_with_validity(bytes, source)?;
    if valid {
        Ok(output)
    } else {
        Err(output)
    }
}

pub fn canonicalize_project_bytes_with_validity(
    bytes: &[u8],
    source: &str,
) -> Result<(String, bool), String> {
    let (validation, valid) = validate_project_bytes_with_validity(bytes, source)?;
    if !valid {
        return Ok((validation, false));
    }
    let project = parse(bytes)?;
    Ok((stable_json(&normalized(&project)), true))
}

fn derive_statuses(project: &Value) -> BTreeMap<String, String> {
    let nodes = project
        .get("nodes")
        .and_then(Value::as_array)
        .expect("validated nodes");
    let by_id: BTreeMap<&str, &Value> = nodes
        .iter()
        .map(|node| {
            (
                node.get("id")
                    .and_then(Value::as_str)
                    .expect("validated id"),
                node,
            )
        })
        .collect();
    let mut statuses: BTreeMap<String, String> = by_id
        .iter()
        .map(|(id, node)| {
            (
                (*id).to_owned(),
                node.pointer("/verification/status")
                    .and_then(Value::as_str)
                    .expect("validated status")
                    .to_owned(),
            )
        })
        .collect();
    for _ in 0..nodes.len() {
        let previous = statuses.clone();
        for (id, node) in &by_id {
            let base = node
                .pointer("/verification/status")
                .and_then(Value::as_str)
                .expect("validated status");
            let mut derived = base;
            for dependency in node
                .pointer("/verification/dependencies")
                .and_then(Value::as_array)
                .expect("validated dependencies")
            {
                let target_id = dependency
                    .get("node")
                    .and_then(Value::as_str)
                    .expect("validated dependency");
                let Some(target) = by_id.get(target_id) else {
                    derived = "invalidated";
                    break;
                };
                let target_status = previous
                    .get(target_id)
                    .map(String::as_str)
                    .unwrap_or("invalidated");
                if target_status == "invalidated" {
                    derived = "invalidated";
                    break;
                }
                let expected = dependency
                    .get("expectedRevision")
                    .and_then(Value::as_str)
                    .expect("validated revision");
                let actual = target
                    .get("revision")
                    .and_then(Value::as_str)
                    .expect("validated revision");
                if expected != actual || target_status == "stale" {
                    derived = "stale";
                }
            }
            statuses.insert((*id).to_owned(), derived.to_owned());
        }
        if statuses == previous {
            break;
        }
    }
    statuses
}

fn compile(project: &Value) -> Value {
    let normalized_project = normalized(project);
    let statuses = derive_statuses(&normalized_project);
    let nodes = normalized_project
        .get("nodes")
        .and_then(Value::as_array)
        .expect("validated nodes");
    let compiled_nodes: Vec<Value> = nodes
        .iter()
        .map(|node| {
            let mut node = node.clone();
            let id = node
                .get("id")
                .and_then(Value::as_str)
                .expect("validated id")
                .to_owned();
            node.pointer_mut("/verification/status")
                .expect("validated status")
                .clone_from(&Value::String(statuses[&id].clone()));
            node
        })
        .collect();
    let node_map: BTreeMap<&str, &Value> = compiled_nodes
        .iter()
        .map(|node| (node.get("id").and_then(Value::as_str).expect("id"), node))
        .collect();
    let mut compiled_routes = Vec::new();
    for route in normalized_project
        .get("routes")
        .and_then(Value::as_array)
        .expect("validated routes")
    {
        let selected: Vec<Value> = route.get("nodes").and_then(Value::as_array).expect("validated route nodes").iter().map(|id| {
            let id = id.as_str().expect("validated route id");
            let node = node_map[id];
            json!({"id": id, "revision": node["revision"], "status": node["verification"]["status"]})
        }).collect();
        let authority_root = digest(&Value::Array(selected));
        let route_status = if route
            .get("nodes")
            .and_then(Value::as_array)
            .expect("nodes")
            .iter()
            .any(|id| {
                matches!(
                    statuses[id.as_str().expect("id")].as_str(),
                    "stale" | "invalidated"
                )
            }) {
            "stale"
        } else {
            "current"
        };
        let mut compiled = route.clone();
        let object = compiled.as_object_mut().expect("route object");
        object.insert("authorityRoot".to_owned(), Value::String(authority_root));
        object.insert("status".to_owned(), Value::String(route_status.to_owned()));
        object.insert("routeRoot".to_owned(), Value::String(digest(route)));
        compiled_routes.push(compiled);
    }
    let authority = json!({"cut": normalized_project["cut"], "nodes": compiled_nodes, "edges": normalized_project["edges"]});
    json!({
        "schema": "xinfa.context-ir/v1",
        "project": normalized_project["project"],
        "cut": normalized_project["cut"],
        "roots": {"project": digest(&normalized_project), "authority": digest(&authority)},
        "nodes": authority["nodes"],
        "edges": authority["edges"],
        "routes": compiled_routes,
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION")}
    })
}

pub fn compile_project_bytes(bytes: &[u8], source: &str) -> Result<String, String> {
    let (output, valid) = compile_project_bytes_with_validity(bytes, source)?;
    if valid {
        Ok(output)
    } else {
        Err(output)
    }
}

pub fn compile_project_bytes_with_validity(
    bytes: &[u8],
    source: &str,
) -> Result<(String, bool), String> {
    let (validation, valid) = validate_project_bytes_with_validity(bytes, source)?;
    if !valid {
        return Ok((validation, false));
    }
    let project = parse(bytes)?;
    let projection = compile(&project);
    serde_json::to_string_pretty(&projection)
        .map(|value| (format!("{value}\n"), true))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/fixtures/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("fixture")
    }

    fn negative_fixture(name: &str) -> (Value, String) {
        let specification: Value = serde_json::from_slice(&fixture(&format!("negative/{name}")))
            .expect("negative fixture");
        let mut project: Value =
            serde_json::from_slice(&fixture("project-alpha")).expect("base fixture");
        for mutation in specification["mutations"].as_array().expect("mutations") {
            let pointer = mutation["pointer"].as_str().expect("pointer");
            *project.pointer_mut(pointer).expect("existing pointer") = mutation["value"].clone();
        }
        (
            project,
            specification["expectedCode"]
                .as_str()
                .expect("expected code")
                .to_owned(),
        )
    }

    #[test]
    fn canonicalization_is_byte_stable() {
        let first = canonicalize_project_bytes(&fixture("project-alpha"), "alpha").expect("valid");
        let second = canonicalize_project_bytes(first.as_bytes(), "canonical").expect("valid");
        assert_eq!(first, second);
    }

    #[test]
    fn published_schemas_are_welded_to_runtime_vocabulary() {
        let project: Value = serde_json::from_str(include_str!("../schema/project-v1.schema.json"))
            .expect("project schema");
        let context: Value =
            serde_json::from_str(include_str!("../schema/context-ir-v1.schema.json"))
                .expect("context schema");
        assert_eq!(project["$id"], PROJECT_SCHEMA_ID);
        assert_eq!(project["properties"]["schema"]["const"], PROJECT_VERSION);
        assert_eq!(project["$defs"]["visibility"]["enum"], json!(VISIBILITIES));
        assert_eq!(
            project["$defs"]["node"]["properties"]["kind"]["enum"],
            json!(NODE_KINDS)
        );
        assert_eq!(
            project["$defs"]["verification"]["properties"]["mode"]["enum"],
            json!(MODES)
        );
        assert_eq!(
            project["$defs"]["verification"]["properties"]["status"]["enum"],
            json!(STATUSES)
        );
        assert_eq!(
            project["$defs"]["edge"]["properties"]["relation"]["enum"],
            json!(RELATIONS)
        );
        assert_eq!(
            context["properties"]["schema"]["const"],
            "xinfa.context-ir/v1"
        );
    }

    #[test]
    fn non_isomorphic_projects_compile_without_core_changes() {
        let alpha: Value = serde_json::from_str(
            &compile_project_bytes(&fixture("project-alpha"), "alpha").expect("alpha"),
        )
        .expect("json");
        let beta: Value = serde_json::from_str(
            &compile_project_bytes(&fixture("project-beta"), "beta").expect("beta"),
        )
        .expect("json");
        assert_eq!(alpha["schema"], beta["schema"]);
        assert_ne!(alpha["roots"]["authority"], beta["roots"]["authority"]);
    }

    #[test]
    fn implementation_revision_drift_marks_claim_document_and_routes_stale() {
        let mut project: Value = serde_json::from_slice(&fixture("project-alpha")).expect("json");
        project["nodes"][2]["revision"] = Value::String(format!("sha256:{}", "f".repeat(64)));
        let compiled: Value = serde_json::from_str(
            &compile_project_bytes(stable_json(&project).as_bytes(), "drift").expect("compile"),
        )
        .expect("json");
        let status: BTreeMap<_, _> = compiled["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .map(|node| {
                (
                    node["id"].as_str().expect("id"),
                    node["verification"]["status"].as_str().expect("status"),
                )
            })
            .collect();
        assert_eq!(status["alpha.claim.runtime"], "stale");
        assert_eq!(status["alpha.doc.guide"], "stale");
        assert!(compiled["routes"]
            .as_array()
            .expect("routes")
            .iter()
            .all(|route| route["status"] == "stale"));
    }

    #[test]
    fn invalidated_evidence_invalidates_claim_and_document() {
        let mut project: Value = serde_json::from_slice(&fixture("project-alpha")).expect("json");
        project["nodes"][4]["verification"]["status"] = Value::String("invalidated".to_owned());
        let compiled: Value = serde_json::from_str(
            &compile_project_bytes(stable_json(&project).as_bytes(), "invalidated")
                .expect("compile"),
        )
        .expect("json");
        let status: BTreeMap<_, _> = compiled["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .map(|node| {
                (
                    node["id"].as_str().expect("id"),
                    node["verification"]["status"].as_str().expect("status"),
                )
            })
            .collect();
        assert_eq!(status["alpha.claim.runtime"], "invalidated");
        assert_eq!(status["alpha.doc.guide"], "invalidated");
    }

    #[test]
    fn non_claim_change_does_not_create_implementation_drift() {
        let mut project: Value = serde_json::from_slice(&fixture("project-alpha")).expect("json");
        project["nodes"][3]["revision"] = Value::String(format!("sha256:{}", "e".repeat(64)));
        let compiled: Value = serde_json::from_str(
            &compile_project_bytes(stable_json(&project).as_bytes(), "non-claim").expect("compile"),
        )
        .expect("json");
        let claim = compiled["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .find(|node| node["id"] == "alpha.claim.runtime")
            .expect("claim");
        assert_eq!(claim["verification"]["status"], "machine-proved");
    }

    #[test]
    fn negative_fixtures_have_stable_diagnostics() {
        for name in [
            "cycle",
            "dependency-cycle",
            "private-leak",
            "provider-broadening",
            "route-parity",
            "version",
            "duplicate-id",
            "invalid-cut",
            "unknown-field",
        ] {
            let (project, code) = negative_fixture(name);
            let value: Value = serde_json::from_str(
                &validate_project_bytes(stable_json(&project).as_bytes(), name).expect("receipt"),
            )
            .expect("json");
            assert_eq!(value["valid"], false, "{name}");
            assert!(
                value["diagnostics"]
                    .as_array()
                    .expect("diagnostics")
                    .iter()
                    .any(|item| item["code"] == code),
                "{name} lacks {code}"
            );
        }
    }

    #[test]
    fn malformed_json_has_a_stable_nonqualifying_receipt() {
        let (output, valid) = validate_project_bytes_with_validity(b"{", "stdin").expect("receipt");
        let receipt: Value = serde_json::from_str(&output).expect("json");
        assert!(!valid);
        assert_eq!(receipt["valid"], false);
        assert_eq!(receipt["qualifying"], false);
        assert_eq!(receipt["diagnostics"][0]["code"], "invalid-json");
    }

    #[test]
    fn receipts_do_not_expose_host_paths() {
        let output = validate_project_bytes(
            &fixture("project-alpha"),
            "/Users/private/project/secret-input.json",
        )
        .expect("receipt");
        assert!(!output.contains("/Users/private"));
        assert!(!output.contains("secret-input"));
        let receipt: Value = serde_json::from_str(&output).expect("json");
        assert_eq!(receipt["source"], "file");
    }

    #[test]
    fn human_and_agent_routes_share_authority_root_and_status() {
        let compiled: Value = serde_json::from_str(
            &compile_project_bytes(&fixture("project-alpha"), "alpha").expect("compile"),
        )
        .expect("json");
        let routes = compiled["routes"].as_array().expect("routes");
        assert_eq!(routes[0]["authorityRoot"], routes[1]["authorityRoot"]);
        assert_eq!(routes[0]["status"], routes[1]["status"]);
    }
}
