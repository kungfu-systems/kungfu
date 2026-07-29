// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

pub(crate) struct DesktopCommit {
    pub(crate) installed: PathBuf,
    pub(crate) backup: Option<PathBuf>,
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn path_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let mut left = fs::File::open(left).map_err(|error| error.to_string())?;
    let mut right = fs::File::open(right).map_err(|error| error.to_string())?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left
            .read(&mut left_buffer)
            .map_err(|error| error.to_string())?;
        let right_read = right
            .read(&mut right_buffer)
            .map_err(|error| error.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn sorted_entries(path: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

pub(crate) fn contains_file(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.path().is_file())
        })
        .unwrap_or(false)
}

/// Verify a copied desktop tree against its immutable registry source without
/// trusting a sentinel that could have landed before an interrupted copy.
pub(crate) fn tree_exact(source: &Path, candidate: &Path) -> Result<bool, String> {
    let source_meta = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    let candidate_meta = match fs::symlink_metadata(candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let source_type = source_meta.file_type();
    let candidate_type = candidate_meta.file_type();
    if source_type.is_symlink() != candidate_type.is_symlink()
        || source_type.is_dir() != candidate_type.is_dir()
        || source_type.is_file() != candidate_type.is_file()
    {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if source_meta.permissions().mode() & 0o7777 != candidate_meta.permissions().mode() & 0o7777
        {
            return Ok(false);
        }
    }
    if source_type.is_symlink() {
        let source_link = fs::read_link(source).map_err(|error| error.to_string())?;
        let candidate_link = fs::read_link(candidate).map_err(|error| error.to_string())?;
        return Ok(source_link == candidate_link);
    }
    if source_type.is_file() {
        if source_meta.len() != candidate_meta.len() {
            return Ok(false);
        }
        return files_equal(source, candidate);
    }
    if !source_type.is_dir() {
        return Ok(false);
    }
    let source_entries = sorted_entries(source)?;
    let candidate_entries = sorted_entries(candidate)?;
    if source_entries.len() != candidate_entries.len() {
        return Ok(false);
    }
    for (source_entry, candidate_entry) in source_entries.iter().zip(candidate_entries.iter()) {
        if source_entry.file_name() != candidate_entry.file_name()
            || !tree_exact(&source_entry.path(), &candidate_entry.path())?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn complete_atomic_target<Stage, Verify>(
    source: &Path,
    target: &Path,
    backup: &Path,
    staged: &Path,
    mut stage_source: Stage,
    verify: Verify,
) -> Result<DesktopCommit, String>
where
    Stage: FnMut(&Path, &Path) -> Result<(), String>,
    Verify: Fn(&Path) -> Result<bool, String>,
{
    if verify(target)? {
        remove_path(staged).map_err(|error| {
            format!(
                "cannot discard obsolete staged desktop {}: {error}",
                staged.display()
            )
        })?;
        return Ok(DesktopCommit {
            installed: target.to_path_buf(),
            backup: path_exists(backup)
                .map_err(|error| error.to_string())?
                .then(|| backup.to_path_buf()),
        });
    }
    if path_exists(staged).map_err(|error| error.to_string())? && !verify(staged)? {
        remove_path(staged).map_err(|error| {
            format!(
                "cannot discard incomplete staged desktop {}: {error}",
                staged.display()
            )
        })?;
    }
    if !path_exists(staged).map_err(|error| error.to_string())? {
        stage_source(source, staged)?;
    }
    if !verify(staged)? {
        return Err(format!(
            "staged desktop target failed exact verification: {}",
            staged.display()
        ));
    }
    let backup_exists = path_exists(backup).map_err(|error| error.to_string())?;
    let target_exists = path_exists(target).map_err(|error| error.to_string())?;
    if !backup_exists && target_exists {
        fs::rename(target, backup)
            .map_err(|error| format!("cannot stage previous {}: {error}", target.display()))?;
    } else if backup_exists && target_exists {
        remove_path(target).map_err(|error| {
            format!(
                "cannot discard interrupted desktop target {}: {error}",
                target.display()
            )
        })?;
    }
    fs::rename(staged, target)
        .map_err(|error| format!("cannot place {}: {error}", target.display()))?;
    if !verify(target)? {
        return Err(format!(
            "installed desktop target failed exact verification: {}",
            target.display()
        ));
    }
    Ok(DesktopCommit {
        installed: target.to_path_buf(),
        backup: path_exists(backup)
            .map_err(|error| error.to_string())?
            .then(|| backup.to_path_buf()),
    })
}
