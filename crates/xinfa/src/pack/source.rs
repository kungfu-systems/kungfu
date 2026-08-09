// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::path::{Component, Path};

fn sensitive_path(relative: &str) -> bool {
    relative.split('/').any(|part| {
        part == ".git"
            || part == ".private"
            || part == ".env"
            || part.starts_with(".env.")
            || part.eq_ignore_ascii_case("secrets")
            || part.eq_ignore_ascii_case("credentials.json")
    })
}

fn generated_projection_path(relative: &str) -> bool {
    relative == ".xinfa/generated" || relative.starts_with(".xinfa/generated/")
}

fn checked_source(
    repository: &dyn RepositorySource,
    relative: &str,
) -> Result<(Vec<u8>, u64), PackDiagnostic> {
    if generated_projection_path(relative) {
        return Err(PackDiagnostic::error(
            "generated-projection-input",
            relative,
            "generated Xinfa projections are derived data and cannot enter a provider; explicitly accept content into a managed source path and compile a successor cut",
        ));
    }
    if sensitive_path(relative) {
        return Err(PackDiagnostic::error(
            "sensitive-path",
            relative,
            "sensitive path classes cannot enter a context pack",
        ));
    }
    for component in Path::new(relative).components() {
        let Component::Normal(_) = component else {
            return Err(PackDiagnostic::error(
                "invalid-path",
                relative,
                "source path must remain repository relative",
            ));
        };
    }
    let bytes = repository
        .read(relative)
        .map_err(|error| PackDiagnostic::error(error.code, relative, error.message))?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(PackDiagnostic::error(
            "source-too-large",
            relative,
            format!("declared source exceeds the {MAX_SOURCE_BYTES} byte v1 limit"),
        ));
    }
    let size = bytes.len() as u64;
    Ok((bytes, size))
}

fn provider_inventory_root(entries: &[Value]) -> String {
    digest(&Value::Array(
        entries
            .iter()
            .map(|entry| {
                json!({
                    "path": entry["path"],
                    "contentRoot": entry["contentRoot"],
                    "size": entry["size"],
                })
            })
            .collect(),
    ))
}

pub(super) fn collect_inventory(
    project: &Value,
    repository: &dyn RepositorySource,
    visibility: &str,
) -> (Vec<Value>, Vec<PackDiagnostic>) {
    let mut inventory = Vec::new();
    let mut diagnostics = Vec::new();
    for provider in project["providers"]
        .as_array()
        .expect("validated providers")
    {
        let provider_visibility = provider["visibility"].as_str().expect("visibility");
        if visibility_rank(provider_visibility) > visibility_rank(visibility) {
            continue;
        }
        let id = provider["id"].as_str().expect("provider id");
        let kind = provider["kind"].as_str().expect("provider kind");
        if kind != "exact-file-manifest" {
            diagnostics.push(
                PackDiagnostic::error(
                    "unsupported-provider",
                    format!("/providers/{id}"),
                    "repository pack v1 accepts only exact-file-manifest providers",
                )
                .with_provenance(json!({"provider": id, "kind": kind})),
            );
            continue;
        }
        let mut provider_entries = Vec::new();
        for path in provider["paths"].as_array().expect("provider paths") {
            let relative = path.as_str().expect("validated path");
            match checked_source(repository, relative) {
                Ok((bytes, size)) => match String::from_utf8(bytes) {
                    Ok(content) => provider_entries.push(json!({
                        "path": relative,
                        "contentRoot": byte_digest(content.as_bytes()),
                        "size": size,
                        "encoding": "utf-8",
                        "content": content,
                    })),
                    Err(_) => diagnostics.push(
                        PackDiagnostic::error(
                            "unsupported-encoding",
                            relative,
                            "repository pack v1 accepts only UTF-8 source units",
                        )
                        .with_provenance(json!({"provider": id})),
                    ),
                },
                Err(error) => diagnostics.push(error.with_provenance(json!({"provider": id}))),
            }
        }
        provider_entries.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        let actual = provider_inventory_root(&provider_entries);
        let expected = provider["revision"].as_str().expect("provider revision");
        if actual != expected {
            diagnostics.push(
                PackDiagnostic::error(
                    "provider-drift",
                    format!("/providers/{id}/revision"),
                    format!(
                        "declared provider revision {expected} does not match observed {actual}"
                    ),
                )
                .with_provenance(json!({"provider": id, "expected": expected, "observed": actual})),
            );
        }
        for entry in provider_entries {
            inventory.push(json!({
                "provider": id,
                "visibility": provider_visibility,
                "path": entry["path"],
                "contentRoot": entry["contentRoot"],
                "size": entry["size"],
                "encoding": entry["encoding"],
                "content": entry["content"],
            }));
        }
    }
    inventory.sort_by(|left, right| {
        (left["provider"].as_str(), left["path"].as_str())
            .cmp(&(right["provider"].as_str(), right["path"].as_str()))
    });
    let mut owners = BTreeMap::new();
    for item in &inventory {
        let path = item["path"].as_str().expect("inventory path");
        let provider = item["provider"].as_str().expect("inventory provider");
        if let Some(previous) = owners.insert(path, provider) {
            diagnostics.push(
                PackDiagnostic::error(
                    "duplicate-source-owner",
                    path,
                    "one repository path must not be acquired by multiple providers",
                )
                .with_provenance(json!({"providers": [previous, provider]})),
            );
        }
    }
    (inventory, diagnostics)
}
