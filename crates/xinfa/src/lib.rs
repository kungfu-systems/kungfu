// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

mod atlas;
#[cfg(not(target_arch = "wasm32"))]
pub mod cli;
mod command;
mod engine;
mod episode;
#[cfg(not(target_arch = "wasm32"))]
mod native_io;
mod onboarding;
mod pack;
mod project_validation;
mod projection;
mod resolver;
mod semantic_project;

pub use atlas::{
    compile_repository_atlas_from_source, diff_atlas_values, impact_from_atlas_values,
    import_context_pack_artifacts, inspect_atlas_value, verify_atlas_artifacts, verify_atlas_bytes,
    wrap_context_pack, AtlasArtifacts, AtlasCompileOutcome, ATLAS_VERSION,
};

pub use engine::call_bytes as engine_call_bytes;

pub use onboarding::{
    accept_candidate_from_source, candidate_from_inventory_bytes, discover_repository_value,
    explain_candidate_bytes, AcceptanceOutcome, AcceptanceRequest, RepositorySnapshot,
    ONBOARDING_CANDIDATE_VERSION, ONBOARDING_EXPLANATION_VERSION, ONBOARDING_INVENTORY_VERSION,
    ONBOARDING_SELECTION_VERSION,
};

pub use episode::{
    compile_episode_successor_from_source, EpisodeCompileArtifacts,
    EPISODE_PROVIDER_SUBMISSION_VERSION, REVIEW_CHART_VERSION,
};

pub use pack::{
    compile_repository_pack_from_source, impact_between_values, inspect_pack_value, pack_value,
    verify_pack_artifacts, PackArtifacts, PackCompileOutcome, RepositorySource, SourceReadError,
};

pub use projection::{
    compile_gui_view_value, compile_human_view_value, compile_task_chart_value,
    expand_projection_values, inspect_projection_value, projection_findings,
    verify_projection_values, GUI_VIEW_VERSION, HUMAN_VIEW_VERSION, TASK_CHART_VERSION,
};

#[cfg(not(target_arch = "wasm32"))]
pub use native_io::{
    accept_onboarding, compile_episode_successor_bytes, compile_gui_view, compile_human_view,
    compile_repository_atlas_bytes, compile_repository_pack_bytes, compile_task_chart,
    diff_atlases, discover_repository, existing_onboarding_project, expand_projection,
    impact_between, impact_from_atlas, import_context_pack, inspect_atlas, inspect_pack,
    inspect_projection, repository_snapshot, resolve_route, resolve_route_bytes, verify_atlas,
    verify_pack, verify_projection, write_atlas_directory, write_onboarding_project,
    write_pack_directory,
};
pub use resolver::{
    resolve_route_value, RouteResolution, ROUTE_RESOLUTION_VERSION, TASK_ENVELOPE_VERSION,
};
pub use semantic_project::{materialize_surface_inventory_bytes, SURFACE_INVENTORY_VERSION};

pub const PROJECT_SCHEMA_ID: &str = "https://xinfa.dev/schema/project-v1.schema.json";
pub const PROJECT_VERSION: &str = "xinfa.project/v1";
pub(crate) const CLI_USAGE: &str = concat!(
    "Usage:\n",
    "  xinfa --version\n",
    "  xinfa contract --json\n",
    "  xinfa schema project|semantic-project|repository-discovery-request|repository-inventory|onboarding-candidate|onboarding-explanation|onboarding-selection|onboarding-acceptance|context-ir|context-pack|pack-manifest|pack-receipt|atlas|atlas-view|atlas-manifest|atlas-receipt|human-view|task-envelope|route-resolution|task-chart|gui-view|projection-recipe|episode-provider-submission|review-chart\n",
    "  xinfa project discover --root DIR [--request FILE|-] --json\n",
    "  xinfa project candidate --inventory FILE|- --json\n",
    "  xinfa project explain --candidate FILE|- --json\n",
    "  xinfa project accept --candidate FILE --selection FILE --root DIR [--mode dry-run|execute] --json\n",
    "  xinfa project materialize --inventory FILE|- --json\n",
    "  xinfa validate --project FILE|- --json\n",
    "  xinfa canonicalize --project FILE|- --json\n",
    "  xinfa compile --project FILE|- --json\n",
    "  xinfa compile --project FILE --output DIR [--root DIR] [--visibility public|internal|private] --json\n",
    "  xinfa inspect --pack FILE|DIR --json\n",
    "  xinfa verify --pack FILE|DIR --json\n",
    "  xinfa impact --since FILE|DIR --project FILE [--root DIR] [--visibility public|internal|private] --json\n",
    "  xinfa atlas compile --project FILE --output DIR [--root DIR] [--visibility public|internal|private] --json\n",
    "  xinfa atlas compile --pack DIR --output DIR --json\n",
    "  xinfa atlas inspect --atlas FILE|DIR --json\n",
    "  xinfa atlas verify --atlas FILE|DIR --json\n",
    "  xinfa atlas diff --before DIR --after DIR --json\n",
    "  xinfa atlas impact --since DIR --project FILE [--root DIR] [--visibility public|internal|private] --json\n",
    "  xinfa route resolve --atlas DIR --task FILE|- --json\n",
    "  xinfa episode compile --before DIR --project FILE --submission RELATIVE_FILE --output DIR [--root DIR] --json\n",
    "  xinfa read --atlas DIR --route ID --intent TEXT --surface human|gui --max-hops N --json\n",
    "  xinfa chart create --atlas DIR --route ID --task TEXT --role ROLE --budget TOKENS --json\n",
    "  xinfa chart inspect --chart FILE --json\n",
    "  xinfa chart verify --chart FILE --atlas DIR --json\n",
    "  xinfa context --atlas DIR --route ID --task TEXT --role ROLE --budget TOKENS --json\n",
    "  xinfa expand --atlas DIR --view FILE --handle ID --budget TOKENS --json\n",
    "  xinfa diagnose --json",
);

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
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let mut canonical_object = serde_json::Map::new();
            for (key, value) in entries {
                canonical_object.insert(key.clone(), canonical(value));
            }
            Value::Object(canonical_object)
        }
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
            for key in [
                "subjects",
                "capabilities",
                "owners",
                "roles",
                "mission_tracks",
                "terms",
            ] {
                if let Some(values) = route
                    .pointer_mut(&format!("/resolution/{key}"))
                    .and_then(Value::as_array_mut)
                {
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
    project_validation::validate(project)
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
    fn canonical_json_orders_object_keys_by_utf8_bytes() {
        let first: Value =
            serde_json::from_str(r#"{"z":0,"ä":1,"a":{"y":2,"b":3}}"#).expect("first JSON");
        let second: Value =
            serde_json::from_str(r#"{"a":{"b":3,"y":2},"ä":1,"z":0}"#).expect("second JSON");
        assert_eq!(stable_json(&first), stable_json(&second));
        assert_eq!(digest(&first), digest(&second));
        assert_eq!(
            stable_json(&first),
            "{\"a\":{\"b\":3,\"y\":2},\"z\":0,\"ä\":1}\n"
        );
    }

    #[test]
    fn published_schemas_are_welded_to_runtime_vocabulary() {
        let project: Value = serde_json::from_str(include_str!("../schema/project-v1.schema.json"))
            .expect("project schema");
        let context: Value =
            serde_json::from_str(include_str!("../schema/context-ir-v1.schema.json"))
                .expect("context schema");
        let pack: Value =
            serde_json::from_str(include_str!("../schema/context-pack-v1.schema.json"))
                .expect("pack schema");
        let manifest: Value = serde_json::from_str(include_str!(
            "../schema/context-pack-manifest-v1.schema.json"
        ))
        .expect("manifest schema");
        let receipt: Value = serde_json::from_str(include_str!(
            "../schema/context-pack-receipt-v1.schema.json"
        ))
        .expect("receipt schema");
        let atlas: Value = serde_json::from_str(include_str!("../schema/atlas-v1.schema.json"))
            .expect("Atlas schema");
        let atlas_view: Value =
            serde_json::from_str(include_str!("../schema/atlas-view-v1.schema.json"))
                .expect("Atlas view schema");
        let atlas_manifest: Value =
            serde_json::from_str(include_str!("../schema/atlas-manifest-v1.schema.json"))
                .expect("Atlas manifest schema");
        let atlas_receipt: Value =
            serde_json::from_str(include_str!("../schema/atlas-receipt-v1.schema.json"))
                .expect("Atlas receipt schema");
        let human_view: Value =
            serde_json::from_str(include_str!("../schema/human-view-v1.schema.json"))
                .expect("human view schema");
        let task_chart: Value =
            serde_json::from_str(include_str!("../schema/task-chart-v1.schema.json"))
                .expect("Task Chart schema");
        let gui_view: Value =
            serde_json::from_str(include_str!("../schema/gui-view-v1.schema.json"))
                .expect("GUI view schema");
        let projection_recipe: Value =
            serde_json::from_str(include_str!("../schema/projection-recipe-v1.schema.json"))
                .expect("projection recipe schema");
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
        assert_eq!(
            pack["properties"]["schema"]["const"],
            "xinfa.context-pack/v1"
        );
        assert_eq!(
            manifest["properties"]["schema"]["const"],
            "xinfa.context-pack-manifest/v1"
        );
        assert_eq!(
            receipt["properties"]["schema"]["const"],
            "xinfa.context-pack-compile-receipt/v1"
        );
        assert_eq!(atlas["properties"]["schema"]["const"], ATLAS_VERSION);
        assert_eq!(atlas["properties"]["kind"]["const"], ATLAS_VERSION);
        assert_eq!(
            atlas_view["properties"]["schema"]["const"],
            "xinfa.atlas-view/v1"
        );
        assert_eq!(
            atlas_manifest["properties"]["schema"]["const"],
            "xinfa.atlas-manifest/v1"
        );
        assert_eq!(
            atlas_receipt["properties"]["schema"]["const"],
            "xinfa.atlas-compile-receipt/v1"
        );
        assert_eq!(
            human_view["properties"]["schema"]["const"],
            HUMAN_VIEW_VERSION
        );
        assert_eq!(
            task_chart["properties"]["schema"]["const"],
            TASK_CHART_VERSION
        );
        assert_eq!(gui_view["properties"]["schema"]["const"], GUI_VIEW_VERSION);
        assert_eq!(
            projection_recipe["properties"]["schema"]["const"],
            "xinfa.projection-recipe/v1"
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
    fn published_route_root_contract_reproduces_the_worked_example() {
        let contract: Value =
            serde_json::from_str(include_str!("../contract/route-root-authority-v1.json"))
                .expect("route-root contract");
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/golden/route-root-authority-v1.json"
        ))
        .expect("route-root fixture");
        assert_eq!(contract["schema"], "xinfa.route-root-authority/v1");
        assert_eq!(
            digest(&fixture["workedExample"]["route"]),
            fixture["workedExample"]["routeRoot"]
        );
        assert_eq!(
            digest(&fixture["workedExample"]["selected"]),
            fixture["workedExample"]["authorityRoot"]
        );
        assert_eq!(
            fixture["cases"]
                .as_array()
                .expect("cases")
                .iter()
                .map(|case| case["id"].as_str().expect("case id"))
                .collect::<Vec<_>>(),
            vec![
                "ordering",
                "exclusion",
                "missing-node",
                "conflicting-authority",
                "duplicate-node",
            ]
        );

        let compiled: Value = serde_json::from_str(
            &compile_project_bytes(
                &std::fs::read(format!(
                    "{}/fixtures/repository-small/project.json",
                    env!("CARGO_MANIFEST_DIR")
                ))
                .expect("repository-small project"),
                "route-root-worked-example",
            )
            .expect("compile worked example"),
        )
        .expect("compiled JSON");
        let route = compiled["routes"]
            .as_array()
            .expect("routes")
            .iter()
            .find(|route| route["id"] == "small.agent")
            .expect("agent route");
        assert_eq!(route["routeRoot"], fixture["workedExample"]["routeRoot"]);
        assert_eq!(
            route["authorityRoot"],
            fixture["workedExample"]["authorityRoot"]
        );
    }

    #[test]
    fn route_root_fixtures_cover_ordering_and_exclusion() {
        let source = std::fs::read(format!(
            "{}/fixtures/repository-small/project.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("repository-small project");
        let base: Value = serde_json::from_str(
            &compile_project_bytes(&source, "route-root-base").expect("compile base"),
        )
        .expect("base JSON");

        let mut reordered: Value = serde_json::from_slice(&source).expect("source JSON");
        reordered["routes"]
            .as_array_mut()
            .expect("routes")
            .reverse();
        for route in reordered["routes"].as_array_mut().expect("routes") {
            route["nodes"].as_array_mut().expect("nodes").reverse();
            route["entrypoints"]
                .as_array_mut()
                .expect("entrypoints")
                .reverse();
        }
        let reordered: Value = serde_json::from_str(
            &compile_project_bytes(stable_json(&reordered).as_bytes(), "route-root-ordering")
                .expect("compile reordered"),
        )
        .expect("reordered JSON");
        assert_eq!(base["routes"], reordered["routes"]);

        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/golden/route-root-authority-v1.json"
        ))
        .expect("route-root fixture");
        let exclusion = fixture["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .find(|case| case["id"] == "exclusion")
            .expect("exclusion case");
        let mut excluded: Value = serde_json::from_slice(&source).expect("source JSON");
        for route in excluded["routes"].as_array_mut().expect("routes") {
            route["nodes"]
                .as_array_mut()
                .expect("nodes")
                .retain(|id| id != "small.evidence.runtime");
        }
        let excluded: Value = serde_json::from_str(
            &compile_project_bytes(stable_json(&excluded).as_bytes(), "route-root-exclusion")
                .expect("compile excluded"),
        )
        .expect("excluded JSON");
        let excluded_route = excluded["routes"]
            .as_array()
            .expect("routes")
            .iter()
            .find(|route| route["id"] == "small.agent")
            .expect("agent route");
        assert_eq!(excluded_route["routeRoot"], exclusion["expectedRouteRoot"]);
        assert_eq!(
            excluded_route["authorityRoot"],
            exclusion["expectedAuthorityRoot"]
        );
        assert_eq!(base["roots"]["authority"], excluded["roots"]["authority"]);
        assert_ne!(
            base["routes"][0]["authorityRoot"],
            excluded["routes"][0]["authorityRoot"]
        );
    }

    #[test]
    fn route_root_fixtures_fail_closed_on_missing_duplicate_and_conflicting_authority() {
        let source = std::fs::read(format!(
            "{}/fixtures/repository-small/project.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("repository-small project");
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/golden/route-root-authority-v1.json"
        ))
        .expect("route-root fixture");
        for (name, route_id, node_id, expected_code, remove) in [
            (
                "missing-node",
                "small.agent",
                "small.missing",
                "unknown-node",
                false,
            ),
            (
                "duplicate-node",
                "small.agent",
                "small.claim.greeting",
                "duplicate-route-node",
                false,
            ),
            (
                "conflicting-authority",
                "small.human",
                "small.evidence.runtime",
                "route-parity",
                true,
            ),
        ] {
            let declared = fixture["cases"]
                .as_array()
                .expect("cases")
                .iter()
                .find(|case| case["id"] == name)
                .expect("declared case");
            assert_eq!(declared["expectedCode"], expected_code);
            let mut project: Value = serde_json::from_slice(&source).expect("source JSON");
            let route = project["routes"]
                .as_array_mut()
                .expect("routes")
                .iter_mut()
                .find(|route| route["id"] == route_id)
                .expect("target route");
            let nodes = route["nodes"].as_array_mut().expect("nodes");
            if remove {
                nodes.retain(|id| id != node_id);
            } else {
                nodes.push(Value::String(node_id.to_owned()));
            }
            let receipt: Value = serde_json::from_str(
                &compile_project_bytes(stable_json(&project).as_bytes(), name)
                    .expect_err("invalid route must not emit roots"),
            )
            .expect("validation receipt");
            assert_eq!(receipt["valid"], false, "{name}");
            assert!(
                receipt["diagnostics"]
                    .as_array()
                    .expect("diagnostics")
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == expected_code),
                "{name} lacks {expected_code}"
            );
        }
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
