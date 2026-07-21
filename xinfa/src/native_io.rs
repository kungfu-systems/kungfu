// SPDX-License-Identifier: Apache-2.0

//! Native filesystem host for the pure Xinfa compiler core.

use serde_json::Value;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path};

use crate::{
    compile_episode_successor_from_source, compile_gui_view_value, compile_human_view_value,
    compile_repository_atlas_from_source, compile_repository_pack_from_source,
    compile_task_chart_value, diff_atlas_values, expand_projection_values, impact_between_values,
    impact_from_atlas_values, import_context_pack_artifacts, inspect_atlas_value,
    inspect_pack_value, inspect_projection_value, pack_value, resolve_route_value,
    verify_atlas_artifacts, verify_atlas_bytes, verify_pack_artifacts, verify_projection_values,
    AtlasArtifacts, AtlasCompileOutcome, EpisodeCompileArtifacts, PackArtifacts,
    PackCompileOutcome, RepositorySource, RouteResolution, SourceReadError,
};

const COMPATIBILITY_PATH: &str = "compatibility/context-pack-v1";

struct NativeRepositorySource<'a> {
    root: &'a Path,
}

impl<'a> NativeRepositorySource<'a> {
    fn new(root: &'a Path) -> Result<Self, String> {
        let metadata = fs::symlink_metadata(root)
            .map_err(|error| format!("cannot inspect repository root: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("repository root must be a real directory, not a symlink".to_owned());
        }
        Ok(Self { root })
    }
}

impl RepositorySource for NativeRepositorySource<'_> {
    fn read(&self, relative: &str) -> Result<Vec<u8>, SourceReadError> {
        let mut current = self.root.to_path_buf();
        for component in Path::new(relative).components() {
            let Component::Normal(component) = component else {
                return Err(SourceReadError::new(
                    "invalid-path",
                    "source path must remain repository relative",
                ));
            };
            current.push(component);
            let metadata = fs::symlink_metadata(&current).map_err(|error| {
                SourceReadError::new(
                    "missing-source",
                    format!("declared source cannot be read: {error}"),
                )
            })?;
            if metadata.file_type().is_symlink() {
                return Err(SourceReadError::new(
                    "symlink-source",
                    "declared sources and their parent components must not be symlinks",
                ));
            }
        }
        let metadata = fs::metadata(&current).map_err(|error| {
            SourceReadError::new(
                "missing-source",
                format!("declared source cannot be inspected: {error}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(SourceReadError::new(
                "unsupported-source-type",
                "declared source must be a regular file",
            ));
        }
        fs::read(&current).map_err(|error| {
            SourceReadError::new(
                "source-read",
                format!("declared source cannot be read: {error}"),
            )
        })
    }
}

fn read_file(reference: &Path, directory_name: &str, label: &str) -> Result<Vec<u8>, String> {
    let path = if reference.is_dir() {
        reference.join(directory_name)
    } else {
        reference.to_path_buf()
    };
    fs::read(&path).map_err(|error| format!("cannot read {label}: {error}"))
}

fn read_text(path: &Path, label: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|error| format!("cannot read {label}: {error}"))
}

fn write_synced(path: &Path, contents: &str) -> Result<(), String> {
    let mut file =
        File::create(path).map_err(|error| format!("cannot create artifact: {error}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("cannot write artifact: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("cannot sync artifact: {error}"))
}

fn output_parts<'a>(output: &'a Path, suffix: &str) -> Result<(&'a Path, String), String> {
    if output.exists() {
        return Err(
            "output path already exists; Xinfa never overwrites an artifact directory".to_owned(),
        );
    }
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("output parent must already exist".to_owned());
    }
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "output must have a portable UTF-8 basename".to_owned())?;
    Ok((parent, format!(".{name}.{suffix}-{}", std::process::id())))
}

pub fn compile_repository_pack_bytes(
    bytes: &[u8],
    source: &str,
    repository_root: &Path,
    visibility: &str,
) -> Result<PackCompileOutcome, String> {
    compile_repository_pack_from_source(
        bytes,
        source,
        &NativeRepositorySource::new(repository_root)?,
        visibility,
    )
}

pub fn write_pack_directory(output: &Path, artifacts: &PackArtifacts) -> Result<(), String> {
    let (parent, temporary_name) = output_parts(output, "xinfa-tmp")?;
    let temporary = parent.join(temporary_name);
    if temporary.exists() {
        return Err("owned temporary output already exists".to_owned());
    }
    fs::create_dir(&temporary)
        .map_err(|error| format!("cannot create temporary output: {error}"))?;
    let result = (|| {
        write_synced(&temporary.join("pack.json"), &artifacts.pack)?;
        write_synced(&temporary.join("manifest.json"), &artifacts.manifest)?;
        write_synced(&temporary.join("receipt.json"), &artifacts.receipt)?;
        fs::rename(&temporary, output)
            .map_err(|error| format!("cannot publish pack atomically: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

pub fn inspect_pack(reference: &Path) -> Result<String, String> {
    let value: Value = serde_json::from_slice(&read_file(reference, "pack.json", "pack")?)
        .map_err(|error| format!("invalid pack JSON: {error}"))?;
    inspect_pack_value(&value)
}

pub fn verify_pack(reference: &Path) -> Result<(String, bool), String> {
    let pack = read_file(reference, "pack.json", "pack")?;
    if reference.is_dir() {
        let manifest = read_file(&reference.join("manifest.json"), "", "manifest")?;
        let receipt = read_file(&reference.join("receipt.json"), "", "receipt")?;
        verify_pack_artifacts(&pack, Some(&manifest), Some(&receipt))
    } else {
        verify_pack_artifacts(&pack, None, None)
    }
}

pub fn impact_between(old_reference: &Path, new_pack: &Value) -> Result<String, String> {
    let old: Value = serde_json::from_slice(&read_file(old_reference, "pack.json", "pack")?)
        .map_err(|error| format!("invalid pack JSON: {error}"))?;
    impact_between_values(&old, new_pack)
}

pub fn compile_repository_atlas_bytes(
    project_bytes: &[u8],
    source: &str,
    repository_root: &Path,
    visibility: &str,
) -> Result<AtlasCompileOutcome, String> {
    compile_repository_atlas_from_source(
        project_bytes,
        source,
        &NativeRepositorySource::new(repository_root)?,
        visibility,
    )
}

pub fn import_context_pack(reference: &Path) -> Result<AtlasArtifacts, String> {
    if !reference.is_dir() {
        return Err("Atlas import requires a complete Context Pack directory".to_owned());
    }
    import_context_pack_artifacts(
        &fs::read(reference.join("pack.json"))
            .map_err(|error| format!("cannot read context pack artifact: {error}"))?,
        &fs::read(reference.join("manifest.json"))
            .map_err(|error| format!("cannot read context pack manifest: {error}"))?,
        &fs::read(reference.join("receipt.json"))
            .map_err(|error| format!("cannot read context pack receipt: {error}"))?,
    )
}

pub fn write_atlas_directory(output: &Path, artifacts: &AtlasArtifacts) -> Result<(), String> {
    let (parent, temporary_name) = output_parts(output, "xinfa-atlas-tmp")?;
    let temporary = parent.join(temporary_name);
    if temporary.exists() {
        return Err("owned temporary output already exists".to_owned());
    }
    fs::create_dir(&temporary)
        .map_err(|error| format!("cannot create temporary output: {error}"))?;
    let result = (|| {
        fs::create_dir(temporary.join("views"))
            .map_err(|error| format!("cannot create Atlas views directory: {error}"))?;
        let compatibility = temporary.join(COMPATIBILITY_PATH);
        fs::create_dir_all(&compatibility)
            .map_err(|error| format!("cannot create compatibility directory: {error}"))?;
        write_synced(&temporary.join("atlas.json"), &artifacts.atlas)?;
        write_synced(&temporary.join("views/human.json"), &artifacts.human_view)?;
        write_synced(&temporary.join("views/agent.json"), &artifacts.agent_view)?;
        write_synced(&temporary.join("manifest.json"), &artifacts.manifest)?;
        write_synced(&temporary.join("receipt.json"), &artifacts.receipt)?;
        write_synced(
            &compatibility.join("pack.json"),
            &artifacts.context_pack.pack,
        )?;
        write_synced(
            &compatibility.join("manifest.json"),
            &artifacts.context_pack.manifest,
        )?;
        write_synced(
            &compatibility.join("receipt.json"),
            &artifacts.context_pack.receipt,
        )?;
        fs::rename(&temporary, output)
            .map_err(|error| format!("cannot publish Atlas atomically: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

fn read_complete_atlas(reference: &Path) -> Result<AtlasArtifacts, String> {
    if !reference.is_dir() {
        return Err("operation requires a complete Atlas directory".to_owned());
    }
    let pack = read_text(
        &reference.join(COMPATIBILITY_PATH).join("pack.json"),
        "context pack",
    )?;
    let pack_value: Value = serde_json::from_str(&pack)
        .map_err(|error| format!("invalid context pack JSON: {error}"))?;
    let atlas = read_text(&reference.join("atlas.json"), "Atlas artifact")?;
    let atlas_value: Value =
        serde_json::from_str(&atlas).map_err(|error| format!("invalid Atlas JSON: {error}"))?;
    Ok(AtlasArtifacts {
        human_view: read_text(&reference.join("views/human.json"), "human view")?,
        agent_view: read_text(&reference.join("views/agent.json"), "Agent view")?,
        manifest: read_text(&reference.join("manifest.json"), "Atlas manifest")?,
        receipt: read_text(&reference.join("receipt.json"), "Atlas receipt")?,
        context_pack: PackArtifacts {
            manifest: read_text(
                &reference.join(COMPATIBILITY_PATH).join("manifest.json"),
                "context pack manifest",
            )?,
            receipt: read_text(
                &reference.join(COMPATIBILITY_PATH).join("receipt.json"),
                "context pack receipt",
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

fn verified_atlas(reference: &Path) -> Result<(AtlasArtifacts, Value), String> {
    let artifacts = read_complete_atlas(reference)?;
    let (receipt, valid) = verify_atlas_artifacts(&artifacts)?;
    if !valid {
        return Err(format!(
            "operation requires a verified Atlas: {}",
            receipt.trim()
        ));
    }
    let value = serde_json::from_str(&artifacts.atlas)
        .map_err(|error| format!("invalid Atlas JSON: {error}"))?;
    Ok((artifacts, value))
}

pub fn verify_atlas(reference: &Path) -> Result<(String, bool), String> {
    if reference.is_dir() {
        verify_atlas_artifacts(&read_complete_atlas(reference)?)
    } else {
        verify_atlas_bytes(
            &fs::read(reference).map_err(|error| format!("cannot read Atlas: {error}"))?,
        )
    }
}

pub fn inspect_atlas(reference: &Path) -> Result<String, String> {
    let bytes = read_file(reference, "atlas.json", "Atlas")?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("invalid Atlas JSON: {error}"))?;
    inspect_atlas_value(&value)
}

pub fn diff_atlases(before: &Path, after: &Path) -> Result<String, String> {
    let (before_artifacts, old) = verified_atlas(before)?;
    let (after_artifacts, new) = verified_atlas(after)?;
    diff_atlas_values(
        &old,
        &new,
        &pack_value(&before_artifacts.context_pack)?,
        &pack_value(&after_artifacts.context_pack)?,
    )
}

pub fn impact_from_atlas(since: &Path, current: &AtlasArtifacts) -> Result<String, String> {
    let (prior, old) = verified_atlas(since)?;
    impact_from_atlas_values(&old, &pack_value(&prior.context_pack)?, current)
}

pub fn compile_task_chart(
    reference: &Path,
    route: &str,
    task: &str,
    role: &str,
    budget: usize,
) -> Result<String, String> {
    compile_task_chart_value(&verified_atlas(reference)?.1, route, task, role, budget)
}

pub fn compile_human_view(
    reference: &Path,
    route: &str,
    intent: &str,
    max_hops: usize,
) -> Result<String, String> {
    compile_human_view_value(&verified_atlas(reference)?.1, route, intent, max_hops)
}

pub fn compile_gui_view(
    reference: &Path,
    route: &str,
    intent: &str,
    max_hops: usize,
) -> Result<String, String> {
    compile_gui_view_value(&verified_atlas(reference)?.1, route, intent, max_hops)
}

fn read_json(path: &Path, label: &str) -> Result<Value, String> {
    serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("cannot read {label}: {error}"))?,
    )
    .map_err(|error| format!("invalid {label} JSON: {error}"))
}

pub fn inspect_projection(reference: &Path) -> Result<String, String> {
    inspect_projection_value(&read_json(reference, "projection")?)
}

pub fn verify_projection(
    projection_reference: &Path,
    atlas_reference: &Path,
) -> Result<(String, bool), String> {
    verify_projection_values(
        &read_json(projection_reference, "projection")?,
        &verified_atlas(atlas_reference)?.1,
    )
}

pub fn expand_projection(
    atlas_reference: &Path,
    projection_reference: &Path,
    handle: &str,
    budget: usize,
) -> Result<String, String> {
    expand_projection_values(
        &verified_atlas(atlas_reference)?.1,
        &read_json(projection_reference, "projection")?,
        handle,
        budget,
    )
}

pub fn resolve_route(atlas_ref: &Path, task_ref: &Path) -> Result<RouteResolution, String> {
    resolve_route_bytes(
        atlas_ref,
        &fs::read(task_ref)
            .map_err(|error| format!("cannot read {}: {error}", task_ref.display()))?,
        &task_ref.display().to_string(),
    )
}

pub fn resolve_route_bytes(
    atlas_ref: &Path,
    task_bytes: &[u8],
    task_label: &str,
) -> Result<RouteResolution, String> {
    let task: Value = serde_json::from_slice(task_bytes)
        .map_err(|error| format!("invalid task envelope JSON in {task_label}: {error}"))?;
    resolve_route_value(&verified_atlas(atlas_ref)?.1, &task)
}

pub fn compile_episode_successor_bytes(
    project_bytes: &[u8],
    project_source: &str,
    submission_bytes: &[u8],
    submission_source: &str,
    repository_root: &Path,
    visibility: &str,
    before_atlas: &Path,
) -> Result<EpisodeCompileArtifacts, String> {
    compile_episode_successor_from_source(
        project_bytes,
        project_source,
        submission_bytes,
        submission_source,
        &NativeRepositorySource::new(repository_root)?,
        visibility,
        &read_complete_atlas(before_atlas)?,
    )
}
