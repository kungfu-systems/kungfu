// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn fail(code: &str, path: &str, message: &str) -> String {
    format!("{code} at {path}: {message}")
}

pub(super) fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| fail("episode-type", path, "must be an object"))
}

pub(super) fn exact_keys(
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

pub(super) fn text(value: Option<&Value>, path: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| fail("episode-type", path, "must be a non-empty string"))
}

pub(super) fn identifier(value: Option<&Value>, path: &str) -> Result<String, String> {
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

pub(super) fn root(value: Option<&Value>, path: &str) -> Result<String, String> {
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

pub(super) fn repository_path(value: Option<&Value>, path: &str) -> Result<String, String> {
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

pub(super) fn read_bytes(
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

pub(super) fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(super) fn validate_kungfu_value(value: &Value, path: &str) -> Result<(), String> {
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

pub(super) fn kungfu_canonical_json(value: &Value) -> Result<String, String> {
    validate_kungfu_value(value, "$")?;
    serde_json::to_string(value).map_err(|error| error.to_string())
}

pub(super) fn kungfu_root(value: &Value) -> Result<String, String> {
    Ok(sha256_bytes(kungfu_canonical_json(value)?.as_bytes()))
}

pub(super) fn provider_inventory_root(
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

pub(super) fn parse_claims(
    bytes: &[u8],
    manifest: &Value,
    path: &str,
) -> Result<Vec<Value>, String> {
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

pub(super) fn admit_episode(
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
