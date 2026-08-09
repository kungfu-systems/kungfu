// SPDX-License-Identifier: Apache-2.0
//
// Host-machine layout and probing helpers: home/cache paths, PATH resolution,
// per-invocation temp dirs. Process control (die/exec) deliberately stays with
// the binaries — a library reports, the process owner decides how to exit.

use std::env;
use std::path::PathBuf;

pub const INTEL_MACOS_DIAGNOSTIC: &str =
    "unsupported-host: Intel macOS (Darwin x86_64) is not supported by Kungfu";

pub fn validate_product_host(os: &str, arch: &str) -> Result<(), &'static str> {
    if os == "macos" && arch == "x86_64" {
        return Err(INTEL_MACOS_DIAGNOSTIC);
    }
    Ok(())
}

pub fn validate_current_host() -> Result<(), &'static str> {
    validate_product_host(env::consts::OS, env::consts::ARCH)
}

pub fn home_dir() -> PathBuf {
    if let Some(h) = env::var_os("HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Some(h) = env::var_os("USERPROFILE") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::from(".")
}

/// `${XDG_CONFIG_HOME:-~/.config}` and friends — the repo already uses this
/// convention on every platform (build-local.env), so the launcher follows it.
pub fn xdg_dir(env_key: &str, default_leaf: &str) -> PathBuf {
    match env::var_os(env_key) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home_dir().join(default_leaf),
    }
}

/// User-global tool cache shared by the main repo and all worktrees:
/// `${XDG_CACHE_HOME:-~/.cache}/kungfu`.
pub fn kungfu_cache_dir() -> PathBuf {
    xdg_dir("XDG_CACHE_HOME", ".cache").join("kungfu")
}

/// Platform tag naming what this process runs on, `<os>-<arch>` in
/// std::env::consts vocabulary (e.g. `macos-aarch64`). Cache layouts key on
/// it so artifacts for different targets never share a slot.
pub fn os_arch() -> String {
    format!("{}-{}", env::consts::OS, env::consts::ARCH)
}

/// Resolve a command name against PATH (honoring PATHEXT on Windows).
/// Equivalent to `command -v` / `where`, without spawning a process.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for dir in env::split_paths(&paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(name);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = candidate.metadata() {
                if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                    return Some(candidate);
                }
            }
        }
        #[cfg(windows)]
        {
            let exts: Vec<String> = env::var("PATHEXT")
                .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
                .split(';')
                .filter(|e| !e.is_empty())
                .map(|e| e.to_lowercase())
                .collect();
            if candidate.is_file() {
                return Some(candidate);
            }
            for ext in &exts {
                let with_ext = dir.join(format!("{name}{ext}"));
                if with_ext.is_file() {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

/// A process-unique temp dir (no external crates; collision-safe enough for
/// per-invocation shim dirs that the OS cleans with the temp root).
pub fn unique_temp_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::{validate_product_host, INTEL_MACOS_DIAGNOSTIC};

    #[test]
    fn intel_macos_is_explicitly_unsupported() {
        assert_eq!(
            validate_product_host("macos", "x86_64"),
            Err(INTEL_MACOS_DIAGNOSTIC)
        );
        for (os, arch) in [
            ("macos", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("windows", "x86_64"),
        ] {
            assert_eq!(validate_product_host(os, arch), Ok(()));
        }
    }
}
