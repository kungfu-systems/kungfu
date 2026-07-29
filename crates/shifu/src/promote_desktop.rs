// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};

pub(crate) struct DesktopCommit {
    pub(crate) installed: PathBuf,
    pub(crate) backup: Option<PathBuf>,
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
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
    Verify: Fn(&Path) -> bool,
{
    if verify(target) {
        let _ = remove_path(staged);
        return Ok(DesktopCommit {
            installed: target.to_path_buf(),
            backup: backup.exists().then(|| backup.to_path_buf()),
        });
    }
    if staged.exists() && !verify(staged) {
        remove_path(staged).map_err(|error| {
            format!(
                "cannot discard incomplete staged desktop {}: {error}",
                staged.display()
            )
        })?;
    }
    if !staged.exists() {
        stage_source(source, staged)?;
    }
    if !verify(staged) {
        return Err(format!(
            "staged desktop target failed exact verification: {}",
            staged.display()
        ));
    }
    if !backup.exists() && target.exists() {
        fs::rename(target, backup)
            .map_err(|error| format!("cannot stage previous {}: {error}", target.display()))?;
    } else if backup.exists() && target.exists() {
        remove_path(target).map_err(|error| {
            format!(
                "cannot discard interrupted desktop target {}: {error}",
                target.display()
            )
        })?;
    }
    fs::rename(staged, target)
        .map_err(|error| format!("cannot place {}: {error}", target.display()))?;
    if !verify(target) {
        return Err(format!(
            "installed desktop target failed exact verification: {}",
            target.display()
        ));
    }
    Ok(DesktopCommit {
        installed: target.to_path_buf(),
        backup: backup.exists().then(|| backup.to_path_buf()),
    })
}
