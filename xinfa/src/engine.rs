// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::{
    canonicalize_project_bytes_with_validity, compile_episode_successor_from_source,
    compile_gui_view_value, compile_human_view_value, compile_project_bytes_with_validity,
    compile_repository_atlas_from_source, compile_repository_pack_from_source,
    compile_task_chart_value, diff_atlas_values, expand_projection_values, impact_between_values,
    impact_from_atlas_values, import_context_pack_artifacts, inspect_atlas_value,
    inspect_pack_value, inspect_projection_value, materialize_surface_inventory_bytes, pack_value,
    resolve_route_value, stable_json, validate_project_bytes_with_validity, verify_atlas_artifacts,
    verify_pack_artifacts, verify_projection_values, AtlasArtifacts, PackArtifacts,
    RepositorySource, SourceReadError,
};

const REQUEST_SCHEMA: &str = "xinfa.engine-request/v1";
const RESPONSE_SCHEMA: &str = "xinfa.engine-response/v1";

struct MemoryRepository {
    files: BTreeMap<String, Vec<u8>>,
}

impl RepositorySource for MemoryRepository {
    fn read(&self, relative: &str) -> Result<Vec<u8>, SourceReadError> {
        self.files.get(relative).cloned().ok_or_else(|| {
            SourceReadError::new(
                "missing-source",
                "declared source is absent from the host-provided inventory",
            )
        })
    }
}

fn byte_map(value: Option<&Value>, label: &str) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let rows = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{label} must be an array"))?;
    let mut files = BTreeMap::new();
    for row in rows {
        let path = row
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| format!("{label} entry path must be non-empty"))?;
        let bytes = row
            .get("bytes")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{label} entry bytes must be an array"))?
            .iter()
            .map(|byte| {
                byte.as_u64()
                    .filter(|byte| *byte <= u8::MAX as u64)
                    .map(|byte| byte as u8)
                    .ok_or_else(|| format!("{label} entry contains a non-byte value"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if files.insert(path.to_owned(), bytes).is_some() {
            return Err(format!("{label} contains duplicate path {path}"));
        }
    }
    Ok(files)
}

fn option<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

fn input<'a>(inputs: &'a BTreeMap<String, Vec<u8>>, path: &str) -> Result<&'a [u8], String> {
    inputs
        .get(path)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("host input is missing {path}"))
}

fn artifact_input<'a>(
    inputs: &'a BTreeMap<String, Vec<u8>>,
    reference: &str,
    name: &str,
) -> Option<&'a [u8]> {
    inputs
        .get(reference)
        .or_else(|| inputs.get(&format!("{reference}/{name}")))
        .map(Vec::as_slice)
}

fn required_artifact<'a>(
    inputs: &'a BTreeMap<String, Vec<u8>>,
    reference: &str,
    name: &str,
) -> Result<&'a [u8], String> {
    artifact_input(inputs, reference, name)
        .ok_or_else(|| format!("host input is missing {reference}/{name}"))
}

fn text_artifact(
    inputs: &BTreeMap<String, Vec<u8>>,
    reference: &str,
    name: &str,
) -> Result<String, String> {
    String::from_utf8(required_artifact(inputs, reference, name)?.to_vec())
        .map_err(|error| format!("host artifact {reference}/{name} is not UTF-8: {error}"))
}

fn atlas_artifacts(
    inputs: &BTreeMap<String, Vec<u8>>,
    reference: &str,
) -> Result<AtlasArtifacts, String> {
    let pack = text_artifact(inputs, reference, "compatibility/context-pack-v1/pack.json")?;
    let pack_value: Value =
        serde_json::from_str(&pack).map_err(|error| format!("invalid pack JSON: {error}"))?;
    let atlas = text_artifact(inputs, reference, "atlas.json")?;
    let atlas_value: Value =
        serde_json::from_str(&atlas).map_err(|error| format!("invalid Atlas JSON: {error}"))?;
    Ok(AtlasArtifacts {
        human_view: text_artifact(inputs, reference, "views/human.json")?,
        agent_view: text_artifact(inputs, reference, "views/agent.json")?,
        manifest: text_artifact(inputs, reference, "manifest.json")?,
        receipt: text_artifact(inputs, reference, "receipt.json")?,
        context_pack: PackArtifacts {
            manifest: text_artifact(
                inputs,
                reference,
                "compatibility/context-pack-v1/manifest.json",
            )?,
            receipt: text_artifact(
                inputs,
                reference,
                "compatibility/context-pack-v1/receipt.json",
            )?,
            pack_root: pack_value
                .pointer("/roots/pack")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            pack,
        },
        atlas_root: atlas_value
            .pointer("/atlas_root")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        atlas,
    })
}

fn positive(arguments: &[String], name: &str) -> Result<usize, String> {
    let value =
        option(arguments, name).ok_or_else(|| format!("missing required option: {name}"))?;
    let value = value
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{name} must be a positive integer"));
    }
    Ok(value)
}

fn write(path: String, contents: &str) -> Value {
    json!({"path": path, "bytes": contents.as_bytes()})
}

fn pack_writes(output: &str, artifacts: &PackArtifacts) -> Vec<Value> {
    [
        ("pack.json", artifacts.pack.as_str()),
        ("manifest.json", artifacts.manifest.as_str()),
        ("receipt.json", artifacts.receipt.as_str()),
    ]
    .into_iter()
    .map(|(name, contents)| write(format!("{output}/{name}"), contents))
    .collect()
}

fn atlas_writes(output: &str, artifacts: &AtlasArtifacts) -> Vec<Value> {
    let mut writes = vec![
        write(format!("{output}/atlas.json"), &artifacts.atlas),
        write(format!("{output}/views/human.json"), &artifacts.human_view),
        write(format!("{output}/views/agent.json"), &artifacts.agent_view),
        write(format!("{output}/manifest.json"), &artifacts.manifest),
        write(format!("{output}/receipt.json"), &artifacts.receipt),
    ];
    writes.extend(pack_writes(
        &format!("{output}/compatibility/context-pack-v1"),
        &artifacts.context_pack,
    ));
    writes
}

fn schema(name: &str) -> Option<&'static str> {
    Some(match name {
        "project" => include_str!("../schema/project-v1.schema.json"),
        "semantic-project" => include_str!("../schema/semantic-project-v1.schema.json"),
        "context-ir" => include_str!("../schema/context-ir-v1.schema.json"),
        "context-pack" => include_str!("../schema/context-pack-v1.schema.json"),
        "pack-manifest" => include_str!("../schema/context-pack-manifest-v1.schema.json"),
        "pack-receipt" => include_str!("../schema/context-pack-receipt-v1.schema.json"),
        "atlas" => include_str!("../schema/atlas-v1.schema.json"),
        "atlas-view" => include_str!("../schema/atlas-view-v1.schema.json"),
        "atlas-manifest" => include_str!("../schema/atlas-manifest-v1.schema.json"),
        "atlas-receipt" => include_str!("../schema/atlas-receipt-v1.schema.json"),
        "human-view" => include_str!("../schema/human-view-v1.schema.json"),
        "task-envelope" => include_str!("../schema/task-envelope-v1.schema.json"),
        "route-resolution" => include_str!("../schema/route-resolution-v1.schema.json"),
        "task-chart" => include_str!("../schema/task-chart-v1.schema.json"),
        "gui-view" => include_str!("../schema/gui-view-v1.schema.json"),
        "projection-recipe" => include_str!("../schema/projection-recipe-v1.schema.json"),
        "episode-provider-submission" => {
            include_str!("../schema/episode-provider-submission-v1.schema.json")
        }
        "review-chart" => include_str!("../schema/review-chart-v1.schema.json"),
        _ => return None,
    })
}

fn dispatch(
    arguments: &[String],
    inputs: &BTreeMap<String, Vec<u8>>,
    repository: &MemoryRepository,
    host: &Value,
) -> Result<(u8, String, Vec<Value>), String> {
    match arguments {
        [flag] if flag == "--version" || flag == "-V" => {
            Ok((0, format!("xinfa {}\n", env!("CARGO_PKG_VERSION")), vec![]))
        }
        [flag] if flag == "--help" || flag == "-h" => {
            Ok((0, format!("{}\n", crate::CLI_USAGE), vec![]))
        }
        [command, format] if command == "contract" && format == "--json" => Ok((
            0,
            include_str!("../contract/xinfa-product-v2.json").to_owned(),
            vec![],
        )),
        [command, name] if command == "schema" => schema(name)
            .map(|schema| (0, schema.to_owned(), vec![]))
            .ok_or_else(|| format!("unsupported schema: {name}")),
        [command, format] if command == "diagnose" && format == "--json" => {
            let field = |name: &str| {
                host.get(name)
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("host is missing {name}"))
                    .and_then(|value| {
                        serde_json::to_string(value).map_err(|error| error.to_string())
                    })
            };
            Ok((
                0,
                format!(
                    "{{\"schema\":\"xinfa.diagnostic/v1\",\"product\":\"xinfa\",\"version\":{},\"stateHome\":{},\"stateSource\":{},\"cacheHome\":{},\"cacheSource\":{},\"writesState\":false}}\n",
                    serde_json::to_string(env!("CARGO_PKG_VERSION")).expect("version JSON"),
                    field("state_home")?,
                    field("state_source")?,
                    field("cache_home")?,
                    field("cache_source")?,
                ),
                vec![],
            ))
        }
        [namespace, operation, rest @ ..]
            if namespace == "project" && operation == "materialize" =>
        {
            let reference = option(rest, "--inventory")
                .ok_or_else(|| "missing required option: --inventory".to_owned())?;
            Ok((
                0,
                materialize_surface_inventory_bytes(input(inputs, reference)?, reference)?,
                vec![],
            ))
        }
        [command, rest @ ..]
            if matches!(command.as_str(), "validate" | "canonicalize" | "compile")
                && !rest.iter().any(|argument| argument == "--output") =>
        {
            let reference = option(rest, "--project")
                .ok_or_else(|| "missing required option: --project".to_owned())?;
            let bytes = input(inputs, reference)?;
            let (stdout, valid) = match command.as_str() {
                "validate" => validate_project_bytes_with_validity(bytes, reference)?,
                "canonicalize" => canonicalize_project_bytes_with_validity(bytes, reference)?,
                "compile" => compile_project_bytes_with_validity(bytes, reference)?,
                _ => unreachable!(),
            };
            Ok((u8::from(!valid), stdout, vec![]))
        }
        [command, rest @ ..]
            if command == "compile" && rest.iter().any(|argument| argument == "--output") =>
        {
            let reference = option(rest, "--project")
                .ok_or_else(|| "missing required option: --project".to_owned())?;
            let output = option(rest, "--output")
                .ok_or_else(|| "missing required option: --output".to_owned())?;
            let visibility = option(rest, "--visibility").unwrap_or("public");
            let outcome = compile_repository_pack_from_source(
                input(inputs, reference)?,
                reference,
                repository,
                visibility,
            )?;
            match outcome.artifacts {
                Some(artifacts) => Ok((
                    0,
                    artifacts.receipt.clone(),
                    pack_writes(output, &artifacts),
                )),
                None => Ok((1, outcome.receipt, vec![])),
            }
        }
        [command, rest @ ..] if command == "inspect" || command == "verify" => {
            let reference = option(rest, "--pack")
                .ok_or_else(|| "missing required option: --pack".to_owned())?;
            let pack = required_artifact(inputs, reference, "pack.json")?;
            if command == "inspect" {
                let value: Value = serde_json::from_slice(pack)
                    .map_err(|error| format!("invalid pack JSON: {error}"))?;
                Ok((0, inspect_pack_value(&value)?, vec![]))
            } else {
                let (receipt, valid) = verify_pack_artifacts(
                    pack,
                    artifact_input(inputs, reference, "manifest.json"),
                    artifact_input(inputs, reference, "receipt.json"),
                )?;
                Ok((u8::from(!valid), receipt, vec![]))
            }
        }
        [command, rest @ ..] if command == "impact" => {
            let since = option(rest, "--since")
                .ok_or_else(|| "missing required option: --since".to_owned())?;
            let project = option(rest, "--project")
                .ok_or_else(|| "missing required option: --project".to_owned())?;
            let visibility = option(rest, "--visibility").unwrap_or("public");
            let old: Value = serde_json::from_slice(required_artifact(inputs, since, "pack.json")?)
                .map_err(|error| format!("invalid prior pack JSON: {error}"))?;
            let outcome = compile_repository_pack_from_source(
                input(inputs, project)?,
                project,
                repository,
                visibility,
            )?;
            match outcome.artifacts {
                Some(artifacts) => Ok((
                    0,
                    impact_between_values(&old, &pack_value(&artifacts)?)?,
                    vec![],
                )),
                None => Ok((1, outcome.receipt, vec![])),
            }
        }
        [namespace, operation, rest @ ..] if namespace == "atlas" && operation == "compile" => {
            let output = option(rest, "--output")
                .ok_or_else(|| "missing required option: --output".to_owned())?;
            if let Some(reference) = option(rest, "--project") {
                let visibility = option(rest, "--visibility").unwrap_or("public");
                let outcome = compile_repository_atlas_from_source(
                    input(inputs, reference)?,
                    reference,
                    repository,
                    visibility,
                )?;
                match outcome.artifacts {
                    Some(artifacts) => Ok((
                        0,
                        artifacts.receipt.clone(),
                        atlas_writes(output, &artifacts),
                    )),
                    None => Ok((1, outcome.receipt, vec![])),
                }
            } else if let Some(reference) = option(rest, "--pack") {
                let artifacts = import_context_pack_artifacts(
                    required_artifact(inputs, reference, "pack.json")?,
                    required_artifact(inputs, reference, "manifest.json")?,
                    required_artifact(inputs, reference, "receipt.json")?,
                )?;
                Ok((
                    0,
                    artifacts.receipt.clone(),
                    atlas_writes(output, &artifacts),
                ))
            } else {
                Err("Atlas compile requires exactly one of --project or --pack".to_owned())
            }
        }
        [namespace, operation, rest @ ..] if namespace == "episode" && operation == "compile" => {
            let project = option(rest, "--project")
                .ok_or_else(|| "missing required option: --project".to_owned())?;
            let submission = option(rest, "--submission")
                .ok_or_else(|| "missing required option: --submission".to_owned())?;
            let before = option(rest, "--before")
                .ok_or_else(|| "missing required option: --before".to_owned())?;
            let output = option(rest, "--output")
                .ok_or_else(|| "missing required option: --output".to_owned())?;
            let submission_bytes = repository
                .read(submission)
                .map_err(|error| error.message().to_owned())?;
            let artifacts = compile_episode_successor_from_source(
                input(inputs, project)?,
                project,
                &submission_bytes,
                submission,
                repository,
                "public",
                &atlas_artifacts(inputs, before)?,
            )?;
            Ok((0, artifacts.receipt, atlas_writes(output, &artifacts.atlas)))
        }
        [namespace, operation, rest @ ..]
            if namespace == "atlas" && (operation == "inspect" || operation == "verify") =>
        {
            let reference = option(rest, "--atlas")
                .ok_or_else(|| "missing required option: --atlas".to_owned())?;
            let artifacts = atlas_artifacts(inputs, reference)?;
            if operation == "inspect" {
                let value: Value = serde_json::from_str(&artifacts.atlas)
                    .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
                Ok((0, inspect_atlas_value(&value)?, vec![]))
            } else {
                let (receipt, valid) = verify_atlas_artifacts(&artifacts)?;
                Ok((u8::from(!valid), receipt, vec![]))
            }
        }
        [namespace, operation, rest @ ..] if namespace == "atlas" && operation == "diff" => {
            let before = option(rest, "--before")
                .ok_or_else(|| "missing required option: --before".to_owned())?;
            let after = option(rest, "--after")
                .ok_or_else(|| "missing required option: --after".to_owned())?;
            let before_artifacts = atlas_artifacts(inputs, before)?;
            let after_artifacts = atlas_artifacts(inputs, after)?;
            for (label, artifacts) in [("before", &before_artifacts), ("after", &after_artifacts)] {
                let (receipt, valid) = verify_atlas_artifacts(artifacts)?;
                if !valid {
                    return Err(format!("Atlas diff requires verified {label}: {receipt}"));
                }
            }
            let old: Value = serde_json::from_str(&before_artifacts.atlas)
                .map_err(|error| format!("invalid before Atlas JSON: {error}"))?;
            let new: Value = serde_json::from_str(&after_artifacts.atlas)
                .map_err(|error| format!("invalid after Atlas JSON: {error}"))?;
            Ok((
                0,
                diff_atlas_values(
                    &old,
                    &new,
                    &pack_value(&before_artifacts.context_pack)?,
                    &pack_value(&after_artifacts.context_pack)?,
                )?,
                vec![],
            ))
        }
        [namespace, operation, rest @ ..] if namespace == "atlas" && operation == "impact" => {
            let since = option(rest, "--since")
                .ok_or_else(|| "missing required option: --since".to_owned())?;
            let project = option(rest, "--project")
                .ok_or_else(|| "missing required option: --project".to_owned())?;
            let prior = atlas_artifacts(inputs, since)?;
            let (receipt, valid) = verify_atlas_artifacts(&prior)?;
            if !valid {
                return Err(format!("prior Atlas verification failed: {receipt}"));
            }
            let outcome = compile_repository_atlas_from_source(
                input(inputs, project)?,
                project,
                repository,
                option(rest, "--visibility").unwrap_or("public"),
            )?;
            match outcome.artifacts {
                Some(current) => {
                    let old: Value = serde_json::from_str(&prior.atlas)
                        .map_err(|error| format!("invalid prior Atlas JSON: {error}"))?;
                    Ok((
                        0,
                        impact_from_atlas_values(
                            &old,
                            &pack_value(&prior.context_pack)?,
                            &current,
                        )?,
                        vec![],
                    ))
                }
                None => Ok((1, outcome.receipt, vec![])),
            }
        }
        [namespace, operation, rest @ ..] if namespace == "route" && operation == "resolve" => {
            let atlas_reference = option(rest, "--atlas")
                .ok_or_else(|| "missing required option: --atlas".to_owned())?;
            let task_reference = option(rest, "--task")
                .ok_or_else(|| "missing required option: --task".to_owned())?;
            let artifacts = atlas_artifacts(inputs, atlas_reference)?;
            let (_, valid) = verify_atlas_artifacts(&artifacts)?;
            if !valid {
                return Err("route resolution requires a verified Xinfa Atlas".to_owned());
            }
            let atlas: Value = serde_json::from_str(&artifacts.atlas)
                .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
            let task: Value = serde_json::from_slice(input(inputs, task_reference)?)
                .map_err(|error| format!("invalid task envelope JSON: {error}"))?;
            let outcome = resolve_route_value(&atlas, &task)?;
            Ok((u8::from(!outcome.resolved), outcome.receipt, vec![]))
        }
        [command, rest @ ..] if command == "read" => {
            let reference = option(rest, "--atlas")
                .ok_or_else(|| "missing required option: --atlas".to_owned())?;
            let artifacts = atlas_artifacts(inputs, reference)?;
            let (_, valid) = verify_atlas_artifacts(&artifacts)?;
            if !valid {
                return Err("projection compilation requires a verified Atlas".to_owned());
            }
            let atlas: Value = serde_json::from_str(&artifacts.atlas)
                .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
            let route = option(rest, "--route")
                .ok_or_else(|| "missing required option: --route".to_owned())?;
            let intent = option(rest, "--intent")
                .ok_or_else(|| "missing required option: --intent".to_owned())?;
            let output = match option(rest, "--surface") {
                Some("human") => {
                    compile_human_view_value(&atlas, route, intent, positive(rest, "--max-hops")?)?
                }
                Some("gui") => {
                    compile_gui_view_value(&atlas, route, intent, positive(rest, "--max-hops")?)?
                }
                Some(value) => return Err(format!("unsupported read surface: {value}")),
                None => return Err("missing required option: --surface".to_owned()),
            };
            Ok((0, output, vec![]))
        }
        [namespace, operation, rest @ ..]
            if namespace == "chart"
                && (operation == "create" || operation == "inspect" || operation == "verify") =>
        {
            if operation == "create" {
                let reference = option(rest, "--atlas")
                    .ok_or_else(|| "missing required option: --atlas".to_owned())?;
                let artifacts = atlas_artifacts(inputs, reference)?;
                let (_, valid) = verify_atlas_artifacts(&artifacts)?;
                if !valid {
                    return Err("projection compilation requires a verified Atlas".to_owned());
                }
                let atlas: Value = serde_json::from_str(&artifacts.atlas)
                    .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
                return Ok((
                    0,
                    compile_task_chart_value(
                        &atlas,
                        option(rest, "--route")
                            .ok_or_else(|| "missing required option: --route".to_owned())?,
                        option(rest, "--task")
                            .ok_or_else(|| "missing required option: --task".to_owned())?,
                        option(rest, "--role")
                            .ok_or_else(|| "missing required option: --role".to_owned())?,
                        positive(rest, "--budget")?,
                    )?,
                    vec![],
                ));
            }
            let chart = option(rest, "--chart")
                .ok_or_else(|| "missing required option: --chart".to_owned())?;
            let projection: Value = serde_json::from_slice(input(inputs, chart)?)
                .map_err(|error| format!("invalid projection JSON: {error}"))?;
            if operation == "inspect" {
                Ok((0, inspect_projection_value(&projection)?, vec![]))
            } else {
                let reference = option(rest, "--atlas")
                    .ok_or_else(|| "missing required option: --atlas".to_owned())?;
                let artifacts = atlas_artifacts(inputs, reference)?;
                let (_, atlas_valid) = verify_atlas_artifacts(&artifacts)?;
                if !atlas_valid {
                    return Err("projection verification requires a verified Atlas".to_owned());
                }
                let atlas: Value = serde_json::from_str(&artifacts.atlas)
                    .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
                let (receipt, valid) = verify_projection_values(&projection, &atlas)?;
                Ok((u8::from(!valid), receipt, vec![]))
            }
        }
        [command, rest @ ..] if command == "context" => {
            let reference = option(rest, "--atlas")
                .ok_or_else(|| "missing required option: --atlas".to_owned())?;
            let artifacts = atlas_artifacts(inputs, reference)?;
            let (_, valid) = verify_atlas_artifacts(&artifacts)?;
            if !valid {
                return Err("projection compilation requires a verified Atlas".to_owned());
            }
            let atlas: Value = serde_json::from_str(&artifacts.atlas)
                .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
            Ok((
                0,
                compile_task_chart_value(
                    &atlas,
                    option(rest, "--route")
                        .ok_or_else(|| "missing required option: --route".to_owned())?,
                    option(rest, "--task")
                        .ok_or_else(|| "missing required option: --task".to_owned())?,
                    option(rest, "--role")
                        .ok_or_else(|| "missing required option: --role".to_owned())?,
                    positive(rest, "--budget")?,
                )?,
                vec![],
            ))
        }
        [command, rest @ ..] if command == "expand" => {
            let reference = option(rest, "--atlas")
                .ok_or_else(|| "missing required option: --atlas".to_owned())?;
            let view = option(rest, "--view")
                .ok_or_else(|| "missing required option: --view".to_owned())?;
            let artifacts = atlas_artifacts(inputs, reference)?;
            let (_, valid) = verify_atlas_artifacts(&artifacts)?;
            if !valid {
                return Err("expand requires a verified Atlas".to_owned());
            }
            let atlas: Value = serde_json::from_str(&artifacts.atlas)
                .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
            let projection: Value = serde_json::from_slice(input(inputs, view)?)
                .map_err(|error| format!("invalid projection JSON: {error}"))?;
            Ok((
                0,
                expand_projection_values(
                    &atlas,
                    &projection,
                    option(rest, "--handle")
                        .ok_or_else(|| "missing required option: --handle".to_owned())?,
                    positive(rest, "--budget")?,
                )?,
                vec![],
            ))
        }
        _ => Err("command is not yet available through the Xinfa WebAssembly engine".to_owned()),
    }
}

pub fn call_bytes(bytes: &[u8]) -> Vec<u8> {
    let result = (|| {
        let request: Value = serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid request JSON: {error}"))?;
        if request.get("schema").and_then(Value::as_str) != Some(REQUEST_SCHEMA) {
            return Err(format!("request schema must be {REQUEST_SCHEMA}"));
        }
        let arguments = request
            .get("arguments")
            .and_then(Value::as_array)
            .ok_or_else(|| "arguments must be an array".to_owned())?
            .iter()
            .map(|argument| {
                argument
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "arguments must contain only strings".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let inputs = byte_map(request.get("inputs"), "inputs")?;
        let repository = MemoryRepository {
            files: byte_map(request.get("repository"), "repository")?,
        };
        dispatch(
            &arguments,
            &inputs,
            &repository,
            request.get("host").unwrap_or(&Value::Null),
        )
    })();
    let response = match result {
        Ok((status, stdout, writes)) => json!({
            "schema": RESPONSE_SCHEMA,
            "status": status,
            "stdout": stdout,
            "stderr": "",
            "writes": writes,
        }),
        Err(error) => json!({
            "schema": RESPONSE_SCHEMA,
            "status": 2,
            "stdout": "",
            "stderr": format!("xinfa: {error}\n"),
            "writes": [],
        }),
    };
    stable_json(&response).into_bytes()
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn xinfa_alloc(len: u32) -> u32 {
    let mut bytes = vec![0_u8; len as usize].into_boxed_slice();
    let pointer = bytes.as_mut_ptr() as u32;
    std::mem::forget(bytes);
    pointer
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn xinfa_call(pointer: u32, len: u32) -> u64 {
    let request = std::slice::from_raw_parts(pointer as *const u8, len as usize);
    let mut response = call_bytes(request).into_boxed_slice();
    let response_len = response.len() as u32;
    let response_pointer = response.as_mut_ptr() as u32;
    std::mem::forget(response);
    ((response_pointer as u64) << 32) | response_len as u64
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn xinfa_free(pointer: u32, len: u32) {
    let slice = std::ptr::slice_from_raw_parts_mut(pointer as *mut u8, len as usize);
    drop(Box::from_raw(slice));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_request_is_stable() {
        let response: Value = serde_json::from_slice(&call_bytes(
            br#"{"schema":"xinfa.engine-request/v1","arguments":["--version"],"inputs":[],"repository":[]}"#,
        ))
        .expect("response");
        assert_eq!(response["status"], 0);
        assert_eq!(
            response["stdout"],
            format!("xinfa {}\n", env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(response["writes"], json!([]));
    }
}
