// SPDX-License-Identifier: Apache-2.0
//
// Download, integrity, and extraction primitives. All of them shell out to
// platform tools (curl + tar/unzip on Unix, curl.exe/PowerShell + tar.exe on
// Windows 10+) so the library stays dependency-free.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths;

pub fn download(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(curl) = paths::find_on_path("curl") {
        let status = Command::new(curl)
            .args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-o"])
            .arg(dest)
            .arg(url)
            .status()
            .map_err(|e| format!("failed to run curl: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("curl failed downloading {url}"));
    }
    #[cfg(windows)]
    {
        // Windows fallback when curl.exe is unavailable (pre-1803 or stripped
        // images): PowerShell ships everywhere we support.
        for ps in ["pwsh.exe", "powershell.exe"] {
            if paths::find_on_path(ps).is_none() {
                continue;
            }
            let script = format!(
                "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '{}' -OutFile '{}'",
                url.replace('\'', "''"),
                dest.display().to_string().replace('\'', "''"),
            );
            let status = Command::new(ps)
                .args(["-NoProfile", "-Command", &script])
                .status()
                .map_err(|e| format!("failed to run {ps}: {e}"))?;
            if status.success() {
                return Ok(());
            }
            return Err(format!("{ps} failed downloading {url}"));
        }
    }
    Err("no downloader available (curl not on PATH)".to_string())
}

/// Verify an archive against an expected sha256 (lowercased hex). Callers
/// resolve where the expected value comes from (env pin for the launcher,
/// committed manifest for the product trunk); an empty expectation is the
/// caller's decision to skip, not this function's.
pub fn verify_sha256(archive: &Path, expected: &str) -> Result<(), String> {
    let expected = expected.trim().to_lowercase();
    if expected.is_empty() {
        return Ok(());
    }
    let actual = sha256_file(archive)?;
    if actual != expected {
        return Err(format!(
            "checksum mismatch for {} (expected {expected}, got {actual})",
            archive.display()
        ));
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let attempts: &[(&str, &[&str])] = if cfg!(windows) {
        &[("certutil", &["-hashfile"])]
    } else {
        &[("sha256sum", &[]), ("shasum", &["-a", "256"])]
    };
    for (program, args) in attempts {
        let Some(bin) = paths::find_on_path(program) else {
            continue;
        };
        let mut cmd = Command::new(bin);
        cmd.args(*args).arg(path);
        if *program == "certutil" {
            cmd.arg("SHA256");
        }
        let out = cmd
            .output()
            .map_err(|e| format!("failed to run {program}: {e}"))?;
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        // Both formats put the digest as a standalone 64-hex-char token.
        for token in text.split_whitespace() {
            if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
                return Ok(token.to_lowercase());
            }
        }
    }
    Err("no sha256 tool available to verify the pinned checksum".to_string())
}

pub fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let name = archive.to_string_lossy().to_lowercase();
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        return run_extract("tar", &["-xzf"], archive, Some(dest));
    }
    if name.ends_with(".zip") {
        if cfg!(windows) {
            // Windows 10+ tar.exe is bsdtar and reads zip archives.
            return run_extract("tar", &["-xf"], archive, Some(dest));
        }
        return run_extract("unzip", &["-oq"], archive, Some(dest));
    }
    Err(format!("unsupported archive type: {}", archive.display()))
}

fn run_extract(
    program: &str,
    flags: &[&str],
    archive: &Path,
    dest: Option<&Path>,
) -> Result<(), String> {
    let bin = paths::find_on_path(program)
        .ok_or_else(|| format!("{program} not available to extract {}", archive.display()))?;
    let mut cmd = Command::new(bin);
    cmd.args(flags).arg(archive);
    if let Some(dir) = dest {
        cmd.current_dir(dir);
        if program == "unzip" {
            cmd.args(["-d"]).arg(dir);
        }
    }
    let status = cmd
        .status()
        .map_err(|e| format!("failed to run {program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} failed extracting {}", archive.display()))
    }
}

pub fn find_file(root: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .is_some_and(|f| f.eq_ignore_ascii_case(name))
        {
            return Some(path);
        }
        if path.is_dir() {
            subdirs.push(path);
        }
    }
    if max_depth == 0 {
        return None;
    }
    subdirs
        .into_iter()
        .find_map(|dir| find_file(&dir, name, max_depth - 1))
}
