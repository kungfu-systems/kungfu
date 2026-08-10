// SPDX-License-Identifier: Apache-2.0

//! Native filesystem host for the pure Xinfa compiler core.

use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path};
use std::process::Command as ProcessCommand;

use crate::{
    compile_episode_successor_from_source, compile_gui_view_value, compile_human_view_value,
    compile_repository_atlas_from_source, compile_repository_pack_from_source,
    compile_task_chart_value, diff_atlas_values, expand_projection_values, impact_between_values,
    impact_from_atlas_values, import_context_pack_artifacts, inspect_atlas_value,
    inspect_pack_value, inspect_projection_value, pack_value, resolve_route_value,
    verify_atlas_artifacts, verify_atlas_bytes, verify_pack_artifacts, verify_projection_values,
    AcceptanceOutcome, AcceptanceRequest, AtlasArtifacts, AtlasCompileOutcome,
    EpisodeCompileArtifacts, PackArtifacts, PackCompileOutcome, RepositorySnapshot,
    RepositorySource, RouteResolution, SourceReadError,
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

fn git(root: &Path, arguments: &[&str], allow_failure: bool) -> Result<Option<Vec<u8>>, String> {
    let mut command = ProcessCommand::new("git");
    for name in [
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_WORK_TREE",
    ] {
        command.env_remove(name);
    }
    let output = command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .arg("--no-optional-locks")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .output()
        .map_err(|error| format!("cannot run read-only Git discovery: {error}"))?;
    if output.status.success() {
        return Ok(Some(output.stdout));
    }
    if allow_failure {
        return Ok(None);
    }
    Err(format!(
        "read-only Git discovery failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn git_text(root: &Path, arguments: &[&str]) -> Result<Option<String>, String> {
    git(root, arguments, true)?.map_or(Ok(None), |bytes| {
        String::from_utf8(bytes)
            .map(|value| Some(value.trim().to_owned()))
            .map_err(|error| format!("Git discovery returned non-UTF-8 metadata: {error}"))
    })
}

fn nul_paths(bytes: &[u8], state: &str) -> Result<Vec<Value>, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            let path = std::str::from_utf8(path)
                .map_err(|_| "Git discovery requires UTF-8 repository paths".to_owned())?;
            Ok(serde_json::json!({"path":path, "state":state}))
        })
        .collect()
}

pub fn repository_snapshot(repository_root: &Path) -> Result<RepositorySnapshot, String> {
    let metadata = fs::symlink_metadata(repository_root)
        .map_err(|error| format!("cannot inspect repository root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("repository root must be a real directory, not a symlink".to_owned());
    }
    let canonical = fs::canonicalize(repository_root)
        .map_err(|error| format!("cannot canonicalize repository root: {error}"))?;
    let top = git_text(&canonical, &["rev-parse", "--show-toplevel"])?
        .ok_or_else(|| "repository discovery requires a Git worktree".to_owned())?;
    let top = fs::canonicalize(&top)
        .map_err(|error| format!("cannot canonicalize Git worktree root: {error}"))?;
    if top != canonical {
        return Err("repository discovery --root must be the exact Git worktree root".to_owned());
    }
    let stage = git(&canonical, &["ls-files", "--stage", "-z"], false)?
        .expect("required Git command succeeded");
    let mut entries = Vec::new();
    let mut index_preimage = Vec::new();
    for row in stage.split(|byte| *byte == 0).filter(|row| !row.is_empty()) {
        let row = std::str::from_utf8(row)
            .map_err(|_| "Git discovery requires UTF-8 repository paths".to_owned())?;
        let (metadata, path) = row
            .split_once('\t')
            .ok_or_else(|| "unexpected git ls-files --stage row".to_owned())?;
        let mut fields = metadata.split(' ');
        let mode = fields.next().unwrap_or_default();
        let object = fields.next().unwrap_or_default();
        let stage = fields
            .next()
            .unwrap_or_default()
            .parse::<u64>()
            .map_err(|_| "unexpected Git index stage".to_owned())?;
        if mode.is_empty() || object.is_empty() || path.is_empty() {
            return Err("unexpected git ls-files --stage metadata".to_owned());
        }
        let size = fs::symlink_metadata(canonical.join(path))
            .ok()
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len());
        let entry = serde_json::json!({
            "path":path, "state":"tracked", "mode":mode, "object":object,
            "stage":stage, "size":size
        });
        index_preimage.push(entry.clone());
        entries.push(entry);
    }
    index_preimage.sort_by(|left, right| {
        (left["path"].as_str(), left["stage"].as_u64())
            .cmp(&(right["path"].as_str(), right["stage"].as_u64()))
    });
    let untracked = git(
        &canonical,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        false,
    )?
    .expect("required Git command succeeded");
    entries.extend(nul_paths(&untracked, "untracked")?);
    let ignored = git(
        &canonical,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        false,
    )?
    .expect("required Git command succeeded");
    entries.extend(nul_paths(&ignored, "ignored")?);
    let tracked_dirty = git(
        &canonical,
        &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
        false,
    )?
    .expect("required Git command succeeded");
    let dirty = !tracked_dirty.is_empty() || !untracked.is_empty();
    RepositorySnapshot::new(
        serde_json::json!({
            "head":git_text(&canonical, &["rev-parse", "--verify", "HEAD"])?,
            "tree":git_text(&canonical, &["rev-parse", "--verify", "HEAD^{tree}"])?,
            "indexRoot":crate::digest(&Value::Array(index_preimage)),
            "dirty":dirty,
        }),
        entries,
    )
}

pub fn discover_repository(
    repository_root: &Path,
    request_bytes: Option<&[u8]>,
    request_source: &str,
) -> Result<String, String> {
    let snapshot = repository_snapshot(repository_root)?;
    crate::discover_repository_value(
        &snapshot,
        &NativeRepositorySource::new(repository_root)?,
        request_bytes,
        request_source,
    )
}

pub fn existing_onboarding_project(repository_root: &Path) -> Result<Option<Vec<u8>>, String> {
    let path = repository_root.join(".xinfa/project.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot inspect existing Xinfa project: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("existing .xinfa/project.json must be a regular file".to_owned());
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("cannot read existing Xinfa project: {error}"))
}

pub fn accept_onboarding(
    candidate_bytes: &[u8],
    candidate_source: &str,
    selection_bytes: &[u8],
    selection_source: &str,
    repository_root: &Path,
    mode: &str,
) -> Result<AcceptanceOutcome, String> {
    let snapshot = repository_snapshot(repository_root)?;
    let existing = existing_onboarding_project(repository_root)?;
    crate::accept_candidate_from_source(
        AcceptanceRequest {
            candidate_bytes,
            candidate_source,
            selection_bytes,
            selection_source,
            existing_project: existing.as_deref(),
            mode,
        },
        &snapshot,
        &NativeRepositorySource::new(repository_root)?,
    )
}

pub fn write_onboarding_project(repository_root: &Path, contents: &str) -> Result<(), String> {
    let directory = repository_root.join(".xinfa");
    let mut created_directory = false;
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(".xinfa must be a real directory".to_owned())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory)
                .map_err(|error| format!("cannot create .xinfa directory: {error}"))?;
            created_directory = true;
        }
        Err(error) => return Err(format!("cannot inspect .xinfa directory: {error}")),
    }
    let target = directory.join("project.json");
    if target
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(".xinfa/project.json must not be a symlink".to_owned());
    }
    let temporary = directory.join(format!(".project.json.xinfa-{}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("cannot create onboarding temporary file: {error}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|error| format!("cannot write onboarding project: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync onboarding project: {error}"))?;
        fs::rename(&temporary, &target)
            .map_err(|error| format!("cannot publish onboarding project atomically: {error}"))?;
        #[cfg(unix)]
        {
            File::open(&directory)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("cannot sync .xinfa directory: {error}"))
        }
        #[cfg(not(unix))]
        {
            // Windows does not expose a portable directory fsync through
            // std::fs::File; the file itself was synced before the atomic rename.
            Ok(())
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        if created_directory {
            let _ = fs::remove_dir(&directory);
        }
    }
    result
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
        return Err("Context Pack import requires a complete directory".to_owned());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    fn fixture_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "xinfa-native-io-{label}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("create native I/O fixture");
        root
    }

    fn fixture_git(root: &Path) -> ProcessCommand {
        let mut command = ProcessCommand::new("git");
        for name in [
            "GIT_DIR",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_WORK_TREE",
        ] {
            command.env_remove(name);
        }
        command.arg("-C").arg(root);
        command
    }

    #[test]
    #[cfg(unix)]
    fn repository_source_rejects_traversal_and_symlink_components() {
        let root = fixture_root("source-boundary");
        fs::create_dir(root.join("real")).expect("create real directory");
        fs::write(root.join("real/source.md"), "source").expect("write source");
        std::os::unix::fs::symlink(root.join("real"), root.join("linked"))
            .expect("create directory symlink");

        let source = NativeRepositorySource::new(&root).expect("repository source");
        assert_eq!(
            source.read("real/source.md").expect("regular source"),
            b"source"
        );
        assert_eq!(
            source
                .read("../outside")
                .expect_err("traversal rejected")
                .code(),
            "invalid-path"
        );
        assert_eq!(
            source
                .read("linked/source.md")
                .expect_err("symlink rejected")
                .code(),
            "symlink-source"
        );

        fs::remove_dir_all(root).expect("remove native I/O fixture");
    }

    #[test]
    fn output_boundary_never_overwrites_and_requires_an_existing_parent() {
        let root = fixture_root("output-boundary");
        let existing = root.join("existing");
        fs::create_dir(&existing).expect("create existing output");
        assert_eq!(
            output_parts(&existing, "tmp").expect_err("existing output rejected"),
            "output path already exists; Xinfa never overwrites an artifact directory"
        );
        assert_eq!(
            output_parts(&root.join("missing/output"), "tmp").expect_err("missing parent rejected"),
            "output parent must already exist"
        );

        fs::remove_dir_all(root).expect("remove native I/O fixture");
    }

    #[test]
    fn onboarding_transaction_is_dry_run_first_stale_safe_and_atomic() {
        let root = fixture_root("onboarding-transaction");
        fs::write(root.join("README.md"), "# Native fixture\n").expect("write README");
        fs::write(root.join("package.json"), "{\"name\":\"native-fixture\"}\n")
            .expect("write package");
        for arguments in [
            vec!["init", "-q"],
            vec!["add", "--", "README.md", "package.json"],
        ] {
            let status = fixture_git(&root)
                .args(arguments)
                .status()
                .expect("run fixture Git");
            assert!(status.success());
        }
        let inventory = discover_repository(&root, None, "fixture").expect("inventory");
        let candidate = crate::candidate_from_inventory_bytes(inventory.as_bytes(), "fixture")
            .expect("candidate");
        let candidate_value: Value = serde_json::from_str(&candidate).expect("candidate JSON");
        let accepted: Vec<&str> = candidate_value["proposals"]
            .as_array()
            .expect("proposals")
            .iter()
            .filter_map(|proposal| proposal["id"].as_str())
            .collect();
        let selection = crate::stable_json(&serde_json::json!({
            "schema":"xinfa.repository-onboarding-selection/v1",
            "candidateRoot":candidate_value["candidateRoot"],
            "reviewer":"native-qualification",
            "project":{"id":"native","title":"Native fixture"},
            "visibility":"public",
            "acceptedProposalIds":accepted,
            "routes":{
                "parityGroup":"native.contributor","visibility":"public",
                "human":{"id":"native.human","entrypoints":["README.md"]},
                "agent":{"id":"native.agent","entrypoints":["README.md"]},
                "resolution":{
                    "subjects":["repository"],"capabilities":["onboarding"],
                    "owners":["project"],"roles":["contributor"],
                    "mission_tracks":["repository-onboarding"],"terms":["node"]
                }
            },
            "existingProject":{"replace":false,"expectedRoot":null}
        }));
        let dry_run = accept_onboarding(
            candidate.as_bytes(),
            "fixture-candidate",
            selection.as_bytes(),
            "fixture-selection",
            &root,
            "dry-run",
        )
        .expect("dry-run");
        assert!(!dry_run.execute);
        assert!(!root.join(".xinfa").exists());

        fs::write(root.join("README.md"), "# Drifted fixture\n").expect("drift README");
        let stale = accept_onboarding(
            candidate.as_bytes(),
            "fixture-candidate",
            selection.as_bytes(),
            "fixture-selection",
            &root,
            "execute",
        )
        .expect_err("stale candidate rejected");
        assert!(stale.contains("stale onboarding candidate"));
        assert!(!root.join(".xinfa").exists());

        fs::write(root.join("README.md"), "# Native fixture\n").expect("restore README");
        let execute = accept_onboarding(
            candidate.as_bytes(),
            "fixture-candidate",
            selection.as_bytes(),
            "fixture-selection",
            &root,
            "execute",
        )
        .expect("execute plan");
        assert!(execute.execute);
        write_onboarding_project(&root, &execute.project).expect("atomic project write");
        assert_eq!(
            fs::read_to_string(root.join(".xinfa/project.json")).expect("project bytes"),
            execute.project
        );
        assert!(fs::read_dir(root.join(".xinfa"))
            .expect("read .xinfa")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".project.json.xinfa-")));

        let status = fixture_git(&root)
            .args(["add", "--", ".xinfa/project.json"])
            .status()
            .expect("stage existing project");
        assert!(status.success());
        let successor_inventory =
            discover_repository(&root, None, "fixture").expect("successor inventory");
        let successor_candidate = crate::candidate_from_inventory_bytes(
            successor_inventory.as_bytes(),
            "successor-inventory",
        )
        .expect("successor candidate");
        let successor_candidate_value: Value =
            serde_json::from_str(&successor_candidate).expect("successor candidate JSON");
        let mut replacement: Value = serde_json::from_str(&selection).expect("selection JSON");
        replacement["candidateRoot"] = successor_candidate_value["candidateRoot"].clone();
        replacement["existingProject"] = serde_json::json!({
            "replace":true,
            "expectedRoot":"sha256:0000000000000000000000000000000000000000000000000000000000000000"
        });
        let wrong_root = accept_onboarding(
            successor_candidate.as_bytes(),
            "successor-candidate",
            crate::stable_json(&replacement).as_bytes(),
            "replacement-selection",
            &root,
            "dry-run",
        )
        .expect_err("wrong existing root rejected");
        assert!(wrong_root.contains("existing project root mismatch"));
        let current_project: Value =
            serde_json::from_str(&execute.project).expect("current project JSON");
        replacement["existingProject"]["expectedRoot"] =
            Value::String(crate::digest(&current_project));
        let replacement_plan = accept_onboarding(
            successor_candidate.as_bytes(),
            "successor-candidate",
            crate::stable_json(&replacement).as_bytes(),
            "replacement-selection",
            &root,
            "dry-run",
        )
        .expect("exact-root replacement plan");
        assert!(!replacement_plan.execute);

        fs::remove_dir_all(root).expect("remove native I/O fixture");
    }
}
