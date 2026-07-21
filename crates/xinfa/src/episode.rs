// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
use std::fs;
use std::path::{Component, Path};

use super::atlas::{compile_repository_atlas_from_source, verify_atlas_artifacts, AtlasArtifacts};
use super::pack::{impact_between_values, pack_value, RepositorySource};
use super::{digest, stable_json};
#[cfg(test)]
use crate::{compile_repository_atlas_bytes, impact_between};

pub const EPISODE_PROVIDER_SUBMISSION_VERSION: &str = "xinfa.episode-provider-submission/v1";
pub const REVIEW_CHART_VERSION: &str = "xinfa.review-chart/v1";

const GIT_PROVIDER: &str = "git-workspace-jsonl/v1";
const GIT_MANIFEST_SCHEMA: &str = "kungfu.episode.git-workspace-manifest/v1";
const GIT_SEGMENT_SCHEMA: &str = "kungfu.episode.git-workspace-segment/v1";
const QUALIFICATION_SCHEMA: &str = "kungfu.episode.qualification/v1";
const ROOT: &str = "sha256:";

#[derive(Clone, Debug)]
pub struct EpisodeCompileArtifacts {
    pub atlas: AtlasArtifacts,
    pub receipt: String,
    pub review_chart: String,
    pub successor_project: String,
}

#[derive(Clone)]
struct AdmittedEpisode {
    id: String,
    episode_id: Value,
    manifest_path: String,
    claims_path: String,
    qualification_path: String,
    semantic_root: String,
    provider_root: String,
    qualification_root: String,
    rows: Vec<Value>,
}

fn fail(code: &str, path: &str, message: &str) -> String {
    format!("{code} at {path}: {message}")
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| fail("episode-type", path, "must be an object"))
}

fn exact_keys(
    value: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
    path: &str,
) -> Result<(), String> {
    let allowed: BTreeSet<&str> = required.iter().chain(optional).copied().collect();
    for key in value.keys() {
        if !allowed.contains(key.as_str()) {
            return Err(fail(
                "episode-unknown-field",
                &format!("{path}/{key}"),
                "is not declared by v1",
            ));
        }
    }
    for key in required {
        if !value.contains_key(*key) {
            return Err(fail(
                "episode-required-field",
                &format!("{path}/{key}"),
                "is required",
            ));
        }
    }
    Ok(())
}

fn text(value: Option<&Value>, path: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| fail("episode-type", path, "must be a non-empty string"))
}

fn identifier(value: Option<&Value>, path: &str) -> Result<String, String> {
    let value = text(value, path)?;
    let mut characters = value.chars();
    let first = characters.next().unwrap_or_default();
    if !first.is_ascii_lowercase()
        || characters.any(|character| {
            !(character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-'))
        })
    {
        return Err(fail(
            "episode-identifier",
            path,
            "must be a Xinfa lowercase identifier",
        ));
    }
    Ok(value)
}

fn root(value: Option<&Value>, path: &str) -> Result<String, String> {
    let value = text(value, path)?;
    if value.len() != 71
        || !value.starts_with(ROOT)
        || !value[ROOT.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(fail(
            "episode-root",
            path,
            "must be sha256 followed by 64 lowercase hexadecimal digits",
        ));
    }
    Ok(value)
}

fn repository_path(value: Option<&Value>, path: &str) -> Result<String, String> {
    let value = text(value, path)?;
    let parsed = Path::new(&value);
    if parsed.is_absolute()
        || parsed
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.contains('\\')
        || value.contains('*')
        || value.contains('?')
        || value.contains('[')
        || value.contains(']')
        || value.contains('{')
        || value.contains('}')
    {
        return Err(fail(
            "episode-invalid-path",
            path,
            "must be an exact repository-relative POSIX path",
        ));
    }
    let lowered = value.to_ascii_lowercase();
    if value == ".xinfa/generated"
        || value.starts_with(".xinfa/generated/")
        || value.starts_with(".kungfu/runtime/")
        || value.starts_with(".kungfu/private/")
        || lowered.contains("terminal-transcript")
        || lowered.contains("raw-transcript")
        || value.split('/').any(|part| {
            part == ".git"
                || part == ".private"
                || part == ".env"
                || part.starts_with(".env.")
                || part.eq_ignore_ascii_case("secrets")
                || part.eq_ignore_ascii_case("credentials.json")
        })
    {
        return Err(fail(
            "episode-source-not-admitted",
            path,
            "generated, runtime, private, sensitive, and raw transcript paths are excluded",
        ));
    }
    Ok(value)
}

fn read_bytes(
    repository: &dyn RepositorySource,
    relative: &str,
    label: &str,
) -> Result<Vec<u8>, String> {
    repository.read(relative).map_err(|error| {
        fail(
            error.code(),
            relative,
            &format!("cannot read {label}: {}", error.message()),
        )
    })
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn validate_kungfu_value(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
        Value::Number(number) => number
            .as_u64()
            .filter(|number| *number <= 9_007_199_254_740_991)
            .map(|_| ())
            .ok_or_else(|| {
                fail(
                    "episode-noncanonical-number",
                    path,
                    "must be a non-negative safe integer",
                )
            }),
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                validate_kungfu_value(value, &format!("{path}/{index}"))?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, value) in values {
                validate_kungfu_value(value, &format!("{path}/{key}"))?;
            }
            Ok(())
        }
    }
}

fn kungfu_canonical_json(value: &Value) -> Result<String, String> {
    validate_kungfu_value(value, "$")?;
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn kungfu_root(value: &Value) -> Result<String, String> {
    Ok(sha256_bytes(kungfu_canonical_json(value)?.as_bytes()))
}

fn provider_inventory_root(
    repository: &dyn RepositorySource,
    paths: &BTreeSet<String>,
) -> Result<String, String> {
    let mut entries = Vec::new();
    for path in paths {
        let bytes = read_bytes(repository, path, "provider source")?;
        std::str::from_utf8(&bytes).map_err(|_| {
            fail(
                "episode-source-encoding",
                path,
                "provider sources must be UTF-8",
            )
        })?;
        entries.push(json!({
            "path": path,
            "contentRoot": sha256_bytes(&bytes),
            "size": bytes.len(),
        }));
    }
    Ok(digest(&Value::Array(entries)))
}

fn parse_claims(bytes: &[u8], manifest: &Value, path: &str) -> Result<Vec<Value>, String> {
    if bytes.last() != Some(&b'\n') {
        return Err(fail(
            "episode-claims-torn-tail",
            path,
            "claims JSONL must end with LF",
        ));
    }
    if manifest.pointer("/claims/digest").and_then(Value::as_str)
        != Some(sha256_bytes(bytes).as_str())
    {
        return Err(fail(
            "episode-claims-root-mismatch",
            path,
            "claims bytes do not match the admitted manifest",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| fail("episode-claims-encoding", path, "claims must be UTF-8"))?;
    let mut rows = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let row: Value = serde_json::from_str(line).map_err(|error| {
            fail(
                "episode-claims-json",
                &format!("{path}/{index}"),
                &error.to_string(),
            )
        })?;
        if row["schema"] != GIT_SEGMENT_SCHEMA || row["index"] != index {
            return Err(fail(
                "episode-claims-sequence",
                &format!("{path}/{index}"),
                "row schema and zero-based index must match",
            ));
        }
        if kungfu_canonical_json(&row)? != line {
            return Err(fail(
                "episode-claims-noncanonical",
                &format!("{path}/{index}"),
                "row is not canonical Kungfu JSON",
            ));
        }
        rows.push(row);
    }
    if manifest.pointer("/claims/count").and_then(Value::as_u64) != Some(rows.len() as u64) {
        return Err(fail(
            "episode-claims-count",
            path,
            "claims row count does not match the manifest",
        ));
    }
    Ok(rows)
}

fn admit_episode(
    value: &Value,
    index: usize,
    repository: &dyn RepositorySource,
) -> Result<AdmittedEpisode, String> {
    let path = format!("/episodes/{index}");
    let episode = object(value, &path)?;
    exact_keys(
        episode,
        &[
            "id",
            "manifestPath",
            "claimsPath",
            "qualificationPath",
            "semanticRoot",
            "providerRoot",
            "qualificationRoot",
            "visibility",
        ],
        &[],
        &path,
    )?;
    let id = identifier(episode.get("id"), &format!("{path}/id"))?;
    if episode.get("visibility") != Some(&json!("public")) {
        return Err(fail(
            "episode-visibility-not-admitted",
            &format!("{path}/visibility"),
            "v1 admits only explicitly public Episode evidence",
        ));
    }
    let manifest_path =
        repository_path(episode.get("manifestPath"), &format!("{path}/manifestPath"))?;
    let claims_path = repository_path(episode.get("claimsPath"), &format!("{path}/claimsPath"))?;
    let qualification_path = repository_path(
        episode.get("qualificationPath"),
        &format!("{path}/qualificationPath"),
    )?;
    if !manifest_path.contains("/.kungfu/episodes/sealed/")
        && !manifest_path.starts_with(".kungfu/episodes/sealed/")
    {
        return Err(fail(
            "episode-not-sealed",
            &format!("{path}/manifestPath"),
            "manifest must come from the public sealed Episode layout",
        ));
    }
    let semantic_root = root(episode.get("semanticRoot"), &format!("{path}/semanticRoot"))?;
    let provider_root = root(episode.get("providerRoot"), &format!("{path}/providerRoot"))?;
    let qualification_root = root(
        episode.get("qualificationRoot"),
        &format!("{path}/qualificationRoot"),
    )?;

    let manifest_bytes = read_bytes(repository, &manifest_path, "Episode manifest")?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| fail("episode-manifest-json", &manifest_path, &error.to_string()))?;
    if manifest["schema"] != GIT_MANIFEST_SCHEMA || manifest["provider"] != GIT_PROVIDER {
        return Err(fail(
            "episode-manifest-unknown",
            &manifest_path,
            "unsupported Episode provider manifest",
        ));
    }
    if manifest["authority"] != "shadow-of-yijinjing-journal"
        || manifest["semanticRootContract"] != "kungfu.episode-root/v1"
        || manifest["providerRootAlgorithm"] != "sha256-kungfu-git-episode-canonical-json-v1"
    {
        return Err(fail(
            "episode-authority-boundary",
            &manifest_path,
            "manifest must preserve the qualified yijinjing Episode root as a shadow",
        ));
    }
    if manifest["semanticRoot"] != semantic_root
        || manifest["providerRoot"] != provider_root
        || manifest["qualificationRoot"] != qualification_root
    {
        return Err(fail(
            "episode-root-mismatch",
            &manifest_path,
            "submission and manifest roots disagree",
        ));
    }
    let mut manifest_core = manifest.clone();
    object(&manifest_core, &manifest_path)?;
    manifest_core
        .as_object_mut()
        .expect("checked object")
        .remove("providerRoot");
    if kungfu_root(&manifest_core)? != provider_root {
        return Err(fail(
            "episode-provider-root-mismatch",
            &manifest_path,
            "provider root does not match canonical manifest content",
        ));
    }
    if manifest.pointer("/claims/path") != Some(&json!("claims.jsonl"))
        || manifest.pointer("/claims/framing") != Some(&json!("canonical-json-lines-lf/v1"))
    {
        return Err(fail(
            "episode-claims-contract",
            &manifest_path,
            "manifest must name the canonical claims.jsonl segment",
        ));
    }
    if Path::new(&manifest_path).parent() != Path::new(&claims_path).parent()
        || Path::new(&claims_path)
            .file_name()
            .and_then(|name| name.to_str())
            != Some("claims.jsonl")
    {
        return Err(fail(
            "episode-claims-location",
            &claims_path,
            "claims must be the manifest sibling named claims.jsonl",
        ));
    }

    let qualification_bytes = read_bytes(repository, &qualification_path, "Episode qualification")?;
    let qualification: Value = serde_json::from_slice(&qualification_bytes).map_err(|error| {
        fail(
            "episode-qualification-json",
            &qualification_path,
            &error.to_string(),
        )
    })?;
    if qualification["schema"] != QUALIFICATION_SCHEMA {
        return Err(fail(
            "episode-qualification-unknown",
            &qualification_path,
            "unsupported Episode qualification schema",
        ));
    }
    if qualification["policy_source"] != "cpp-typed-fold-fsck"
        || qualification["lifecycle"] != "ended"
        || qualification["status"] != "ok"
        || qualification["episode_id"] != manifest["episodeId"]
        || !qualification["capabilities"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|capability| capability["name"] == "export_evidence" && capability["safe"] == true)
    {
        return Err(fail(
            "episode-qualification-not-admissible",
            &qualification_path,
            "qualification must prove an ended Episode and safe export_evidence",
        ));
    }
    if kungfu_root(&qualification)? != qualification_root {
        return Err(fail(
            "episode-qualification-root-mismatch",
            &qualification_path,
            "qualification bytes do not match the admitted root",
        ));
    }
    let claims_bytes = read_bytes(repository, &claims_path, "Episode claims")?;
    let rows = parse_claims(&claims_bytes, &manifest, &claims_path)?;
    Ok(AdmittedEpisode {
        id,
        episode_id: manifest["episodeId"].clone(),
        manifest_path,
        claims_path,
        qualification_path,
        semantic_root,
        provider_root,
        qualification_root,
        rows,
    })
}

fn unit_shape(unit_type: &str) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    match unit_type {
        "mission-declaration" | "go-declaration" => {
            Some(("decision", "human-review", "human", "human-reviewed"))
        }
        "proof-ref" | "receipt-ref" => {
            Some(("evidence", "provider-derived", "machine", "machine-proved"))
        }
        "review-finding" => Some(("claim", "human-review", "human", "human-reviewed")),
        _ => None,
    }
}

fn compile_unit(
    value: &Value,
    index: usize,
    episodes: &BTreeMap<String, AdmittedEpisode>,
    provider_id: &str,
    route_ids: &BTreeSet<String>,
) -> Result<(Value, Vec<String>), String> {
    let path = format!("/units/{index}");
    let unit = object(value, &path)?;
    exact_keys(
        unit,
        &[
            "id",
            "type",
            "episode",
            "recordIndex",
            "dependsOn",
            "routes",
        ],
        &[],
        &path,
    )?;
    let id = identifier(unit.get("id"), &format!("{path}/id"))?;
    let unit_type = text(unit.get("type"), &format!("{path}/type"))?;
    let (kind, provenance_kind, mode, status) = unit_shape(&unit_type).ok_or_else(|| {
        fail(
            "episode-unit-type-not-admitted",
            &format!("{path}/type"),
            "only mission/go declarations, proof/receipt refs, and review findings are admitted",
        )
    })?;
    let episode_id = identifier(unit.get("episode"), &format!("{path}/episode"))?;
    let episode = episodes.get(&episode_id).ok_or_else(|| {
        fail(
            "episode-unit-unknown-episode",
            &format!("{path}/episode"),
            "typed unit names an unadmitted Episode",
        )
    })?;
    let record_index = unit
        .get("recordIndex")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .ok_or_else(|| {
            fail(
                "episode-unit-record-index",
                &format!("{path}/recordIndex"),
                "must be a non-negative integer",
            )
        })?;
    let row = episode.rows.get(record_index).ok_or_else(|| {
        fail(
            "episode-unit-record-missing",
            &format!("{path}/recordIndex"),
            "typed unit references a missing Episode record",
        )
    })?;
    let depends_on = unit
        .get("dependsOn")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            fail(
                "episode-type",
                &format!("{path}/dependsOn"),
                "must be an array",
            )
        })?;
    let mut dependencies = Vec::new();
    for (dependency_index, dependency) in depends_on.iter().enumerate() {
        let dependency_path = format!("{path}/dependsOn/{dependency_index}");
        let dependency = object(dependency, &dependency_path)?;
        exact_keys(
            dependency,
            &["node", "expectedRevision"],
            &[],
            &dependency_path,
        )?;
        dependencies.push(json!({
            "node": identifier(dependency.get("node"), &format!("{dependency_path}/node"))?,
            "expectedRevision": root(dependency.get("expectedRevision"), &format!("{dependency_path}/expectedRevision"))?,
        }));
    }
    dependencies.sort_by(|left, right| left["node"].as_str().cmp(&right["node"].as_str()));
    let routes = unit
        .get("routes")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            fail(
                "episode-type",
                &format!("{path}/routes"),
                "must be an array",
            )
        })?;
    if routes.is_empty() {
        return Err(fail(
            "episode-unit-routes",
            &format!("{path}/routes"),
            "typed unit must enter at least one declared route",
        ));
    }
    let mut selected_routes = BTreeSet::new();
    for (route_index, route) in routes.iter().enumerate() {
        let route = identifier(Some(route), &format!("{path}/routes/{route_index}"))?;
        if !route_ids.contains(&route) {
            return Err(fail(
                "episode-unit-unknown-route",
                &format!("{path}/routes/{route_index}"),
                "typed unit names an unknown route",
            ));
        }
        selected_routes.insert(route);
    }
    let revision = digest(&json!({
        "schema": "xinfa.episode-typed-unit/v1",
        "id": id,
        "type": unit_type,
        "episode": episode.id,
        "episodeId": episode.episode_id,
        "semanticRoot": episode.semantic_root,
        "providerRoot": episode.provider_root,
        "qualificationRoot": episode.qualification_root,
        "recordIndex": record_index,
        "record": row,
        "dependencies": dependencies,
    }));
    let authority = format!("kungfu.episode.{unit_type}");
    Ok((
        json!({
            "id": id,
            "kind": kind,
            "visibility": "public",
            "revision": revision,
            "provenance": {"kind": provenance_kind, "authority": authority},
            "source": {"provider": provider_id, "path": episode.claims_path},
            "verification": {
                "mode": mode,
                "status": status,
                "waiver": null,
                "dependencies": dependencies,
            },
        }),
        selected_routes.into_iter().collect(),
    ))
}

fn build_review_chart(
    before: &Value,
    after: &Value,
    episodes: &BTreeMap<String, AdmittedEpisode>,
    impact: Value,
) -> Value {
    let omissions = after
        .pointer("/verification/gaps")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let conflicts = after
        .pointer("/verification/conflicts")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let stale: Vec<Value> = after
        .pointer("/semantic/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|node| {
            matches!(
                node.pointer("/verification/status").and_then(Value::as_str),
                Some("stale" | "invalidated")
            )
        })
        .map(|node| json!({"node": node["id"], "status": node["verification"]["status"]}))
        .collect();
    let episode_roots: Vec<Value> = episodes
        .values()
        .map(|episode| {
            json!({
                "id": episode.id,
                "episodeId": episode.episode_id,
                "semanticRoot": episode.semantic_root,
                "providerRoot": episode.provider_root,
                "qualificationRoot": episode.qualification_root,
            })
        })
        .collect();
    json!({
        "schema": REVIEW_CHART_VERSION,
        "beforeAtlasRoot": before["atlas_root"],
        "resultAtlasRoot": after["atlas_root"],
        "resultCut": after["cut"],
        "episodeRoots": episode_roots,
        "impact": impact,
        "omissions": omissions,
        "staleEvidence": stale,
        "conflictedEvidence": conflicts,
        "status": if omissions.as_array().is_some_and(Vec::is_empty)
            && conflicts.as_array().is_some_and(Vec::is_empty)
            && stale.is_empty() { "current" } else { "degraded" },
        "qualifying": false,
        "selfCertified": false,
    })
}

pub fn compile_episode_successor_from_source(
    project_bytes: &[u8],
    project_source: &str,
    submission_bytes: &[u8],
    submission_source: &str,
    repository: &dyn RepositorySource,
    visibility: &str,
    before_artifacts: &AtlasArtifacts,
) -> Result<EpisodeCompileArtifacts, String> {
    if visibility != "public" {
        return Err(fail(
            "episode-visibility-not-admitted",
            "/visibility",
            "Episode provider v1 compiles only a public evidence cut",
        ));
    }
    let (before_receipt, before_valid) = verify_atlas_artifacts(before_artifacts)?;
    if !before_valid {
        return Err(format!(
            "episode-before-atlas-invalid: {}",
            before_receipt.trim()
        ));
    }
    let before: Value = serde_json::from_str(&before_artifacts.atlas)
        .map_err(|error| format!("invalid predecessor Atlas JSON: {error}"))?;
    let submission_path = repository_path(
        Some(&Value::String(submission_source.to_owned())),
        "/submissionSource",
    )?;
    let observed_submission = read_bytes(repository, &submission_path, "Episode submission")?;
    if observed_submission != submission_bytes {
        return Err(fail(
            "episode-submission-drift",
            "/submissionSource",
            "provided submission bytes differ from the declared repository source",
        ));
    }
    let mut project: Value = serde_json::from_slice(project_bytes)
        .map_err(|error| fail("episode-project-json", project_source, &error.to_string()))?;
    let submission: Value = serde_json::from_slice(submission_bytes).map_err(|error| {
        fail(
            "episode-submission-json",
            submission_source,
            &error.to_string(),
        )
    })?;
    let top = object(&submission, "")?;
    exact_keys(
        top,
        &[
            "schema",
            "provider",
            "providerId",
            "root",
            "beforeAtlasRoot",
            "resultCut",
            "episodes",
            "units",
            "edges",
        ],
        &[],
        "",
    )?;
    if submission["schema"] != EPISODE_PROVIDER_SUBMISSION_VERSION
        || submission["provider"] != GIT_PROVIDER
    {
        return Err(fail(
            "episode-submission-unknown",
            "/schema",
            "unsupported Xinfa Episode provider submission",
        ));
    }
    if submission["beforeAtlasRoot"] != before["atlas_root"] {
        return Err(fail(
            "episode-before-atlas-root-mismatch",
            "/beforeAtlasRoot",
            "submission does not name the verified predecessor Atlas",
        ));
    }
    let provider_id = identifier(submission.get("providerId"), "/providerId")?;
    let root_id = identifier(submission.get("root"), "/root")?;
    let cut = object(&submission["resultCut"], "/resultCut")?;
    exact_keys(cut, &["id"], &[], "/resultCut")?;
    let cut_id = identifier(cut.get("id"), "/resultCut/id")?;

    let episode_values = submission["episodes"]
        .as_array()
        .filter(|values| !values.is_empty())
        .ok_or_else(|| fail("episode-type", "/episodes", "must be a non-empty array"))?;
    let mut episodes = BTreeMap::new();
    for (index, value) in episode_values.iter().enumerate() {
        let episode = admit_episode(value, index, repository)?;
        let id = episode.id.clone();
        if episodes.insert(id.clone(), episode).is_some() {
            return Err(fail(
                "episode-duplicate-id",
                &format!("/episodes/{index}/id"),
                &format!("duplicates {id}"),
            ));
        }
    }

    let project_object = project
        .as_object_mut()
        .ok_or_else(|| fail("episode-project-type", project_source, "must be an object"))?;
    let route_ids: BTreeSet<String> = project_object
        .get("routes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|route| route["id"].as_str().map(str::to_owned))
        .collect();
    let mut paths = BTreeSet::new();
    for episode in episodes.values() {
        paths.insert(episode.manifest_path.clone());
        paths.insert(episode.claims_path.clone());
        paths.insert(episode.qualification_path.clone());
    }
    let provider_revision = provider_inventory_root(repository, &paths)?;
    let provider = json!({
        "id": provider_id,
        "kind": "exact-file-manifest",
        "authority": "product-runtime",
        "visibility": "public",
        "root": root_id,
        "paths": paths,
        "revision": provider_revision,
    });
    project_object
        .get_mut("providers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| fail("episode-project-type", "/providers", "must be an array"))?
        .push(provider);

    let unit_values = submission["units"]
        .as_array()
        .filter(|values| !values.is_empty())
        .ok_or_else(|| fail("episode-type", "/units", "must be a non-empty array"))?;
    let mut compiled_units = Vec::new();
    let mut typed_unit_cut = Vec::new();
    let mut route_additions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut unit_ids = BTreeSet::new();
    for (index, value) in unit_values.iter().enumerate() {
        let (node, routes) = compile_unit(value, index, &episodes, &provider_id, &route_ids)?;
        let id = node["id"].as_str().expect("compiled unit id").to_owned();
        if !unit_ids.insert(id.clone()) {
            return Err(fail(
                "episode-duplicate-unit",
                &format!("/units/{index}/id"),
                &format!("duplicates {id}"),
            ));
        }
        for route in routes {
            route_additions.entry(route).or_default().insert(id.clone());
        }
        typed_unit_cut.push(json!({"id": id, "revision": node["revision"]}));
        compiled_units.push(node);
    }
    typed_unit_cut.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    project_object
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| fail("episode-project-type", "/nodes", "must be an array"))?
        .extend(compiled_units);
    for route in project_object
        .get_mut("routes")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| fail("episode-project-type", "/routes", "must be an array"))?
    {
        if let Some(additions) = route["id"].as_str().and_then(|id| route_additions.get(id)) {
            route["nodes"]
                .as_array_mut()
                .expect("base route validation occurs during compile")
                .extend(additions.iter().cloned().map(Value::String));
        }
    }
    let edges = submission["edges"]
        .as_array()
        .ok_or_else(|| fail("episode-type", "/edges", "must be an array"))?;
    let mut episode_edges = edges.clone();
    episode_edges.sort_by(|left, right| {
        (
            left["from"].as_str(),
            left["relation"].as_str(),
            left["to"].as_str(),
        )
            .cmp(&(
                right["from"].as_str(),
                right["relation"].as_str(),
                right["to"].as_str(),
            ))
    });
    project_object
        .get_mut("edges")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| fail("episode-project-type", "/edges", "must be an array"))?
        .extend(edges.iter().cloned());

    let episode_roots: Vec<Value> = episodes
        .values()
        .map(|episode| {
            json!({
                "id": episode.id,
                "episodeId": episode.episode_id,
                "semanticRoot": episode.semantic_root,
                "providerRoot": episode.provider_root,
                "qualificationRoot": episode.qualification_root,
            })
        })
        .collect();
    let source_cut = project_object
        .get("cut")
        .cloned()
        .ok_or_else(|| fail("episode-project-type", "/cut", "is required"))?;
    let cut_revision = digest(&json!({
        "schema": "xinfa.episode-cut/v1",
        "beforeAtlasRoot": before["atlas_root"],
        "sourceCut": source_cut,
        "provider": {"id": provider_id, "revision": provider_revision},
        "episodes": episode_roots,
        "typedUnits": typed_unit_cut,
        "edges": episode_edges,
    }));
    project_object.insert(
        "cut".to_owned(),
        json!({"id": cut_id, "revision": cut_revision}),
    );
    let successor_project = stable_json(&project);
    let outcome = compile_repository_atlas_from_source(
        successor_project.as_bytes(),
        "episode-successor-project",
        repository,
        visibility,
    )?;
    let Some(atlas) = outcome.artifacts else {
        return Err(format!(
            "episode-successor-project-invalid: {}",
            outcome.receipt.trim()
        ));
    };
    let after: Value = serde_json::from_str(&atlas.atlas).map_err(|error| error.to_string())?;
    let current_pack = pack_value(&atlas.context_pack)?;
    let old_pack = pack_value(&before_artifacts.context_pack)?;
    let impact: Value = serde_json::from_str(&impact_between_values(&old_pack, &current_pack)?)
        .map_err(|error| error.to_string())?;
    let review = build_review_chart(&before, &after, &episodes, impact);
    let review_chart = stable_json(&review);
    let receipt = stable_json(&json!({
        "schema": "xinfa.episode-compile-receipt/v1",
        "verdict": "pass",
        "beforeAtlasRoot": before["atlas_root"],
        "resultAtlasRoot": after["atlas_root"],
        "resultCut": after["cut"],
        "admittedEpisodes": episode_roots,
        "reviewChart": review,
        "incrementalMode": "deterministic-full-rebuild",
        "fullIncrementalEquivalent": true,
        "cacheUsed": false,
        "qualifying": false,
        "selfCertified": false,
        "compiler": {"product": "xinfa", "version": env!("CARGO_PKG_VERSION")},
    }));
    Ok(EpisodeCompileArtifacts {
        atlas,
        receipt,
        review_chart,
        successor_project,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compile_episode_successor_bytes, write_atlas_directory};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(label: &str) -> std::path::PathBuf {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("xinfa-episode-{label}-{}-{id}", std::process::id()))
    }

    fn write(path: &Path, bytes: impl AsRef<[u8]>) {
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
        fs::write(path, bytes).expect("write fixture");
    }

    fn read_atlas(reference: &Path) -> Result<Value, String> {
        serde_json::from_slice(
            &fs::read(reference.join("atlas.json")).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }

    fn copy_base(root: &Path) -> Value {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/repository-small");
        for relative in [
            "AGENTS.md",
            "docs/guide.md",
            "evidence/runtime.json",
            "src/runtime.rs",
        ] {
            write(
                &root.join(relative),
                fs::read(fixture.join(relative)).expect("read base fixture"),
            );
        }
        serde_json::from_slice(
            &fs::read(fixture.join("project.json")).expect("read project fixture"),
        )
        .expect("parse project fixture")
    }

    fn qualification(episode_id: u64) -> Value {
        json!({
            "schema": QUALIFICATION_SCHEMA,
            "policy_source": "cpp-typed-fold-fsck",
            "episode_id": episode_id,
            "lifecycle": "ended",
            "status": "ok",
            "evidence": {"manifest_integrity": {"state": "verified", "issue_codes": []}},
            "issues": [],
            "capabilities": [{"name": "export_evidence", "safe": true, "requires": [], "blocked_by": []}],
            "safe_capabilities": ["export_evidence"],
            "contractions": [],
            "repair_prerequisites": [],
        })
    }

    fn seal_fixture(root: &Path, id: &str, episode_id: u64, marker: &str) -> Value {
        let semantic_root = format!("sha256:{}", marker.repeat(64));
        let rows = [
            json!({"schema": GIT_SEGMENT_SCHEMA, "index": 0, "record": {"episode_id": episode_id, "declaration": id}}),
            json!({"schema": GIT_SEGMENT_SCHEMA, "index": 1, "record": {"episode_id": episode_id, "proof_ref": format!("proof:{id}")}}),
        ];
        let claims = format!(
            "{}\n",
            rows.iter()
                .map(|row| kungfu_canonical_json(row).expect("canonical row"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let qualification = qualification(episode_id);
        let qualification_root = kungfu_root(&qualification).expect("qualification root");
        let manifest_core = json!({
            "schema": GIT_MANIFEST_SCHEMA,
            "provider": GIT_PROVIDER,
            "providerRootAlgorithm": "sha256-kungfu-git-episode-canonical-json-v1",
            "authority": "shadow-of-yijinjing-journal",
            "episodeId": episode_id,
            "semanticRoot": semantic_root,
            "semanticRootContract": "kungfu.episode-root/v1",
            "qualificationRoot": qualification_root,
            "claims": {
                "path": "claims.jsonl",
                "digest": sha256_bytes(claims.as_bytes()),
                "count": rows.len(),
                "framing": "canonical-json-lines-lf/v1"
            },
            "contentRefs": [],
            "dependencies": []
        });
        let provider_root = kungfu_root(&manifest_core).expect("provider root");
        let mut manifest = manifest_core;
        manifest
            .as_object_mut()
            .expect("manifest")
            .insert("providerRoot".to_owned(), json!(provider_root));
        let hex = semantic_root.trim_start_matches(ROOT);
        let segment = format!(".kungfu/episodes/sealed/sha256/{}/{}", &hex[..2], hex);
        let manifest_path = format!("{segment}/manifest.json");
        let claims_path = format!("{segment}/claims.jsonl");
        let qualification_path = format!("evidence/{id}-qualification.json");
        write(
            &root.join(&manifest_path),
            format!(
                "{}\n",
                kungfu_canonical_json(&manifest).expect("manifest JSON")
            ),
        );
        write(&root.join(&claims_path), claims);
        write(
            &root.join(&qualification_path),
            format!(
                "{}\n",
                kungfu_canonical_json(&qualification).expect("qualification JSON")
            ),
        );
        json!({
            "id": id,
            "manifestPath": manifest_path,
            "claimsPath": claims_path,
            "qualificationPath": qualification_path,
            "semanticRoot": semantic_root,
            "providerRoot": provider_root,
            "qualificationRoot": qualification_root,
            "visibility": "public"
        })
    }

    fn base_atlas(root: &Path, project: &Value) -> std::path::PathBuf {
        let project_bytes = stable_json(project);
        let outcome = compile_repository_atlas_bytes(
            project_bytes.as_bytes(),
            "project.json",
            root,
            "public",
        )
        .expect("compile base Atlas");
        let before = root.join("before-atlas");
        write_atlas_directory(&before, &outcome.artifacts.expect("base artifacts"))
            .expect("write base Atlas");
        before
    }

    fn submission(before: &Value, episodes: Vec<Value>) -> Value {
        let units = episodes
            .iter()
            .map(|episode| {
                let episode_id = episode["id"].as_str().expect("episode id");
                let suffix = episode_id.replace('.', "-");
                json!({
                    "id": format!("small.evidence.{suffix}"),
                    "type": if episode_id == "episode.one" { "proof-ref" } else { "review-finding" },
                    "episode": episode["id"],
                    "recordIndex": 1,
                    "dependsOn": [],
                    "routes": ["small.agent", "small.human"]
                })
            })
            .collect::<Vec<_>>();
        json!({
            "schema": EPISODE_PROVIDER_SUBMISSION_VERSION,
            "provider": GIT_PROVIDER,
            "providerId": "small.episode-evidence",
            "root": "repository",
            "beforeAtlasRoot": before["atlas_root"],
            "resultCut": {"id": "small.episode-successor"},
            "episodes": episodes,
            "units": units,
            "edges": []
        })
    }

    fn compile_fixture(
        root: &Path,
        project: &Value,
        before: &Path,
        submission: &Value,
    ) -> Result<EpisodeCompileArtifacts, String> {
        let submission_bytes = stable_json(submission);
        write(&root.join("evidence/submission.json"), &submission_bytes);
        compile_episode_successor_bytes(
            stable_json(project).as_bytes(),
            "project.json",
            submission_bytes.as_bytes(),
            "evidence/submission.json",
            root,
            "public",
            before,
        )
    }

    #[test]
    fn qualified_episode_cut_is_deterministic_and_reviewable() {
        let root = temp_root("deterministic");
        let project = copy_base(&root);
        let before_path = base_atlas(&root, &project);
        let before = read_atlas(&before_path).expect("read base Atlas");
        let one = seal_fixture(&root, "episode.one", 7, "a");
        let two = seal_fixture(&root, "episode.two", 8, "b");
        let first_submission = submission(&before, vec![one.clone(), two.clone()]);
        let first = compile_fixture(&root, &project, &before_path, &first_submission)
            .expect("compile admitted Episodes");
        let mut second_submission = submission(&before, vec![two, one]);
        second_submission["units"]
            .as_array_mut()
            .expect("units")
            .reverse();
        let second = compile_fixture(&root, &project, &before_path, &second_submission)
            .expect("compile reordered Episodes");
        assert_eq!(first.atlas.atlas_root, second.atlas.atlas_root);
        let review: Value = serde_json::from_str(&first.review_chart).expect("review chart");
        assert_eq!(review["schema"], REVIEW_CHART_VERSION);
        assert_eq!(review["beforeAtlasRoot"], before["atlas_root"]);
        assert_eq!(review["resultAtlasRoot"], first.atlas.atlas_root);
        assert_eq!(review["status"], "current");
        let receipt: Value = serde_json::from_str(&first.receipt).expect("episode receipt");
        assert_eq!(receipt["incrementalMode"], "deterministic-full-rebuild");
        assert_eq!(receipt["fullIncrementalEquivalent"], true);
        assert_eq!(receipt["cacheUsed"], false);
        fs::remove_dir_all(root).expect("remove test fixture");
    }

    #[test]
    fn admission_rejects_unsealed_unverified_private_missing_and_generated_inputs() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/negative/episode-provider-cases-v1.json"
        ))
        .expect("negative fixture catalog");
        let expected_codes: BTreeSet<&str> = fixture["cases"]
            .as_array()
            .expect("negative cases")
            .iter()
            .filter_map(|case| case["expectedCode"].as_str())
            .collect();
        for code in [
            "episode-visibility-not-admitted",
            "episode-not-sealed",
            "episode-claims-location",
            "episode-source-not-admitted",
            "episode-qualification-not-admissible",
        ] {
            assert!(expected_codes.contains(code), "fixture omits {code}");
        }
        let root = temp_root("negative");
        let project = copy_base(&root);
        let before_path = base_atlas(&root, &project);
        let before = read_atlas(&before_path).expect("read base Atlas");
        let episode = seal_fixture(&root, "episode.one", 7, "a");
        let valid = submission(&before, vec![episode]);

        let mut private = valid.clone();
        private["episodes"][0]["visibility"] = json!("private");
        assert!(compile_fixture(&root, &project, &before_path, &private)
            .unwrap_err()
            .contains("episode-visibility-not-admitted"));

        let mut unsealed = valid.clone();
        unsealed["episodes"][0]["manifestPath"] = json!("evidence/open-manifest.json");
        assert!(compile_fixture(&root, &project, &before_path, &unsealed)
            .unwrap_err()
            .contains("episode-not-sealed"));

        let mut missing = valid.clone();
        missing["episodes"][0]["claimsPath"] = json!("evidence/missing.jsonl");
        assert!(compile_fixture(&root, &project, &before_path, &missing)
            .unwrap_err()
            .contains("episode-claims-location"));

        let mut generated = valid.clone();
        generated["episodes"][0]["qualificationPath"] =
            json!(".xinfa/generated/qualification.json");
        assert!(compile_fixture(&root, &project, &before_path, &generated)
            .unwrap_err()
            .contains("episode-source-not-admitted"));

        let qualification_path = valid["episodes"][0]["qualificationPath"]
            .as_str()
            .expect("qualification path");
        let mut qualification: Value = serde_json::from_slice(
            &fs::read(root.join(qualification_path)).expect("qualification"),
        )
        .expect("qualification JSON");
        qualification["status"] = json!("failed");
        write(
            &root.join(qualification_path),
            format!("{}\n", kungfu_canonical_json(&qualification).expect("JSON")),
        );
        assert!(compile_fixture(&root, &project, &before_path, &valid)
            .unwrap_err()
            .contains("episode-qualification-not-admissible"));

        fs::remove_dir_all(root).expect("remove test fixture");
    }

    #[test]
    fn unknown_or_raw_transcript_units_do_not_enter_the_cut() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../fixtures/negative/episode-provider-cases-v1.json"
        ))
        .expect("negative fixture catalog");
        let expected_codes: BTreeSet<&str> = fixture["cases"]
            .as_array()
            .expect("negative cases")
            .iter()
            .filter_map(|case| case["expectedCode"].as_str())
            .collect();
        assert!(expected_codes.contains("episode-unit-type-not-admitted"));
        assert!(expected_codes.contains("episode-unit-unknown-episode"));
        let root = temp_root("unit-boundary");
        let project = copy_base(&root);
        let before_path = base_atlas(&root, &project);
        let before = read_atlas(&before_path).expect("read base Atlas");
        let episode = seal_fixture(&root, "episode.one", 7, "a");
        let mut value = submission(&before, vec![episode]);
        value["units"][0]["type"] = json!("raw-terminal-transcript");
        assert!(compile_fixture(&root, &project, &before_path, &value)
            .unwrap_err()
            .contains("episode-unit-type-not-admitted"));
        value["units"][0]["type"] = json!("proof-ref");
        value["units"][0]["episode"] = json!("episode.unknown");
        assert!(compile_fixture(&root, &project, &before_path, &value)
            .unwrap_err()
            .contains("episode-unit-unknown-episode"));
        fs::remove_dir_all(root).expect("remove test fixture");
    }

    #[test]
    fn episode_revision_drift_stales_related_claims_without_global_impact() {
        let root = temp_root("impact");
        let project = copy_base(&root);
        let before_path = base_atlas(&root, &project);
        let before = read_atlas(&before_path).expect("read base Atlas");
        let one = seal_fixture(&root, "episode.one", 7, "a");
        let two = seal_fixture(&root, "episode.two", 8, "b");
        let initial_submission = submission(&before, vec![one, two.clone()]);
        let initial = compile_fixture(&root, &project, &before_path, &initial_submission)
            .expect("compile initial Episode cut");
        let initial_atlas: Value =
            serde_json::from_str(&initial.atlas.atlas).expect("initial Atlas");
        let old_revision = initial_atlas["semantic"]["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .find(|node| node["id"] == "small.evidence.episode-one")
            .expect("Episode unit")["revision"]
            .clone();

        let mut successor_source = project.clone();
        successor_source["nodes"]
            .as_array_mut()
            .expect("base nodes")
            .iter_mut()
            .find(|node| node["id"] == "small.claim.greeting")
            .expect("base claim")["verification"]["dependencies"]
            .as_array_mut()
            .expect("claim dependencies")
            .push(json!({
                "node": "small.evidence.episode-one",
                "expectedRevision": old_revision
            }));
        let updated_one = seal_fixture(&root, "episode.one", 7, "c");
        let updated_submission = submission(&before, vec![updated_one, two]);
        let updated = compile_fixture(&root, &successor_source, &before_path, &updated_submission)
            .expect("compile updated Episode cut");
        let updated_atlas: Value =
            serde_json::from_str(&updated.atlas.atlas).expect("updated Atlas");
        let claim = updated_atlas["semantic"]["nodes"]
            .as_array()
            .expect("nodes")
            .iter()
            .find(|node| node["id"] == "small.claim.greeting")
            .expect("base claim");
        assert_eq!(claim["verification"]["status"], "stale");
        assert!(updated_atlas["routes"]
            .as_array()
            .expect("routes")
            .iter()
            .all(|route| route["status"] == "stale"));
        let review: Value = serde_json::from_str(&updated.review_chart).expect("review chart");
        assert!(review["staleEvidence"]
            .as_array()
            .expect("stale evidence")
            .iter()
            .any(|entry| entry["node"] == "small.claim.greeting"));

        let initial_directory = root.join("initial-atlas");
        write_atlas_directory(&initial_directory, &initial.atlas).expect("write initial Atlas");
        let impact: Value = serde_json::from_str(
            &impact_between(
                &initial_directory.join("compatibility/context-pack-v1"),
                &pack_value(&updated.atlas.context_pack).expect("updated pack"),
            )
            .expect("Episode impact"),
        )
        .expect("impact JSON");
        assert!(impact["affectedClaims"]
            .as_array()
            .expect("affected claims")
            .iter()
            .any(|claim| claim == "small.claim.greeting"));
        assert_eq!(
            impact["affectedRoutes"].as_array().expect("routes").len(),
            2
        );
        assert!(!impact["affectedNodes"]
            .as_array()
            .expect("affected nodes")
            .iter()
            .any(|node| node == "small.evidence.episode-two"));
        fs::remove_dir_all(root).expect("remove test fixture");
    }
}
