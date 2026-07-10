// SPDX-License-Identifier: Apache-2.0
//
// Prerequisite tools (fnm for the node side, uv for the python side).
//
// Resolution order per tool:
//   1. already on PATH             -> use it (respect the user's environment)
//   2. user-global cache           -> ${XDG_CACHE_HOME:-~/.cache}/kungfu/tools/<tool>/<version>/
//   3. bootstrap: download the pinned prebuilt release binary into the cache
//
// Step 3 is what makes a fresh machine turnkey: no compiler, no package
// manager, no admin rights — the same "consume the amortized prebuilt binary"
// discipline the repo already applies to node (fnm) and CPython (uv).
//
// Downloads shell out to platform tools (curl + tar/unzip on Unix,
// curl.exe/PowerShell + tar.exe on Windows 10+) so the launcher itself stays
// dependency-free. Mirrors are configurable through build-local.env
// (KUNGFU_FNM_DIST_MIRROR / KUNGFU_UV_DIST_MIRROR), and checksums can be
// pinned per environment (KUNGFU_FNM_SHA256 / KUNGFU_UV_SHA256).
//
// Bootstrap versions resolve like node's: the repo pins them in data files
// (.fnm-version / .uv-version, same shape as .node-version). Precedence:
// KUNGFU_FNM_VERSION / KUNGFU_UV_VERSION env override > repo pin file >
// compiled default (the fallback that keeps a distributed binary working when
// a checkout predates the pin files).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::util;

/// Compiled fallback versions — used only when a tool is absent AND the repo
/// carries no pin file. The repo pin files are the normal source of truth; an
/// fnm / uv already on PATH is always used as-is regardless of version.
const FNM_FALLBACK_VERSION: &str = "1.39.0";
const UV_FALLBACK_VERSION: &str = "0.11.23";

const FNM_BASE: &str = "https://github.com/Schniz/fnm/releases/download";
const UV_BASE: &str = "https://github.com/astral-sh/uv/releases/download";

pub struct Tool {
    /// Command name and cached-binary file stem ("fnm" / "uv").
    pub name: &'static str,
    version_env: &'static str,
    /// Repo-root pin file, .node-version-shaped (single version line).
    pin_file: &'static str,
    default_version: &'static str,
    mirror_env: &'static str,
    default_base: &'static str,
    install_hint: &'static str,
}

pub const FNM: Tool = Tool {
    name: "fnm",
    version_env: "KUNGFU_FNM_VERSION",
    pin_file: ".fnm-version",
    default_version: FNM_FALLBACK_VERSION,
    mirror_env: "KUNGFU_FNM_DIST_MIRROR",
    default_base: FNM_BASE,
    install_hint: "https://github.com/Schniz/fnm",
};

pub const UV: Tool = Tool {
    name: "uv",
    version_env: "KUNGFU_UV_VERSION",
    pin_file: ".uv-version",
    default_version: UV_FALLBACK_VERSION,
    mirror_env: "KUNGFU_UV_DIST_MIRROR",
    default_base: UV_BASE,
    install_hint: "https://docs.astral.sh/uv/",
};

impl Tool {
    /// Repo pin file name (e.g. ".fnm-version"), for doctor-style reporting.
    pub fn pin_file(&self) -> &'static str {
        self.pin_file
    }

    fn version(&self, root: &Path) -> String {
        let env_val = env::var(self.version_env).ok();
        let file_text = fs::read_to_string(root.join(self.pin_file)).ok();
        resolve_version(
            env_val.as_deref(),
            file_text.as_deref(),
            self.default_version,
        )
    }

    fn base_url(&self) -> String {
        env::var(self.mirror_env)
            .unwrap_or_else(|_| self.default_base.to_string())
            .trim_end_matches('/')
            .to_string()
    }

    fn cached_binary(&self, root: &Path) -> PathBuf {
        let file = if cfg!(windows) {
            format!("{}.exe", self.name)
        } else {
            self.name.to_string()
        };
        util::kungfu_cache_dir()
            .join("tools")
            .join(self.name)
            .join(self.version(root))
            .join(file)
    }

    /// Release asset name for the current platform, or None when the platform
    /// has no prebuilt (the caller then reports how to install manually).
    fn asset(&self) -> Option<String> {
        let (os, arch) = (env::consts::OS, env::consts::ARCH);
        let name = match (self.name, os, arch) {
            // fnm ships a universal macOS binary.
            ("fnm", "macos", _) => "fnm-macos.zip".to_string(),
            ("fnm", "linux", "x86_64") => "fnm-linux.zip".to_string(),
            ("fnm", "linux", "aarch64") => "fnm-arm64.zip".to_string(),
            ("fnm", "windows", "x86_64") => "fnm-windows.zip".to_string(),
            ("uv", "macos", "aarch64") => "uv-aarch64-apple-darwin.tar.gz".to_string(),
            ("uv", "macos", "x86_64") => "uv-x86_64-apple-darwin.tar.gz".to_string(),
            ("uv", "linux", "x86_64") => "uv-x86_64-unknown-linux-gnu.tar.gz".to_string(),
            ("uv", "linux", "aarch64") => "uv-aarch64-unknown-linux-gnu.tar.gz".to_string(),
            ("uv", "windows", "x86_64") => "uv-x86_64-pc-windows-msvc.zip".to_string(),
            _ => return None,
        };
        Some(name)
    }

    fn download_url(&self, root: &Path) -> Option<String> {
        let asset = self.asset()?;
        let tag = match self.name {
            // fnm tags are v-prefixed; uv tags are bare versions.
            "fnm" => format!("v{}", self.version(root)),
            _ => self.version(root),
        };
        Some(format!("{}/{}/{}", self.base_url(), tag, asset))
    }
}

/// Version precedence: env override > repo pin file > compiled fallback.
/// Values are trimmed and a leading `v` is tolerated (tags are normalized
/// per-tool at URL construction).
fn resolve_version(env_val: Option<&str>, file_text: Option<&str>, fallback: &str) -> String {
    for candidate in [env_val, file_text] {
        if let Some(raw) = candidate {
            let v = raw.trim().trim_start_matches('v');
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    fallback.to_string()
}

/// Resolve a tool without bootstrapping (PATH, then cache). Used where the sh
/// entrypoint also degraded gracefully (e.g. rich-subcommand node resolution).
pub fn find_tool(tool: &Tool, root: &Path) -> Option<PathBuf> {
    if let Some(on_path) = util::find_on_path(tool.name) {
        return Some(on_path);
    }
    let cached = tool.cached_binary(root);
    cached.is_file().then_some(cached)
}

/// Resolve a tool, bootstrapping the pinned prebuilt release when absent.
pub fn ensure_tool(tool: &Tool, root: &Path) -> PathBuf {
    if let Some(found) = find_tool(tool, root) {
        return found;
    }
    bootstrap(tool, root).unwrap_or_else(|err| {
        util::die_code(
            &format!(
                "{} is required but was not found on PATH, and bootstrapping the prebuilt binary \
                 failed: {err}\n  install it manually ({}) or fix the failure above and re-run",
                tool.name, tool.install_hint
            ),
            127,
        )
    })
}

fn bootstrap(tool: &Tool, root: &Path) -> Result<PathBuf, String> {
    let url = tool.download_url(root).ok_or_else(|| {
        format!(
            "no prebuilt {} for {}/{}",
            tool.name,
            env::consts::OS,
            env::consts::ARCH
        )
    })?;
    let target = tool.cached_binary(root);
    let target_dir = target.parent().expect("cached binary has a parent dir");
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("cannot create {}: {e}", target_dir.display()))?;

    eprintln!(
        "shifu: {} not found; fetching prebuilt {} {} into {}",
        tool.name,
        tool.name,
        tool.version(root),
        target_dir.display()
    );

    let work = util::unique_temp_dir(&format!("shifu-{}", tool.name))
        .map_err(|e| format!("cannot create temp dir: {e}"))?;
    let archive = work.join(url.rsplit('/').next().unwrap_or("archive"));

    download(&url, &archive)?;
    verify_checksum(tool, &archive)?;
    extract(&archive, &work)?;

    let binary_name = if cfg!(windows) {
        format!("{}.exe", tool.name)
    } else {
        tool.name.to_string()
    };
    let extracted = find_file(&work, &binary_name, 3)
        .ok_or_else(|| format!("{binary_name} not found inside {}", archive.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&extracted, fs::Permissions::from_mode(0o755));
    }

    // rename() fails across filesystems (temp dir vs cache); fall back to copy.
    if fs::rename(&extracted, &target).is_err() {
        fs::copy(&extracted, &target)
            .map_err(|e| format!("cannot place {}: {e}", target.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        }
    }
    let _ = fs::remove_dir_all(&work);
    Ok(target)
}

fn download(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(curl) = util::find_on_path("curl") {
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
            if util::find_on_path(ps).is_none() {
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

/// Optional integrity pin: when KUNGFU_<TOOL>_SHA256 is set (e.g. by CI or a
/// mirror-using environment), the downloaded archive must match it.
fn verify_checksum(tool: &Tool, archive: &Path) -> Result<(), String> {
    let env_key = match tool.name {
        "fnm" => "KUNGFU_FNM_SHA256",
        "uv" => "KUNGFU_UV_SHA256",
        _ => return Ok(()),
    };
    let Ok(expected) = env::var(env_key) else {
        return Ok(());
    };
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

fn sha256_file(path: &Path) -> Result<String, String> {
    let attempts: &[(&str, &[&str])] = if cfg!(windows) {
        &[("certutil", &["-hashfile"])]
    } else {
        &[("sha256sum", &[]), ("shasum", &["-a", "256"])]
    };
    for (program, args) in attempts {
        let Some(bin) = util::find_on_path(program) else {
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

fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
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
    let bin = util::find_on_path(program)
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

fn find_file(root: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
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

/// When the launcher bootstrapped fnm itself there is no pre-existing user fnm
/// state; point FNM_DIR at the user-global kungfu cache so node installs are
/// shared across worktrees and clones. An fnm found on PATH keeps whatever
/// environment the user already has.
pub fn default_fnm_dir_if_bootstrapped(fnm_path: &Path) {
    if env::var_os("FNM_DIR").is_some() {
        return;
    }
    if fnm_path.starts_with(util::kungfu_cache_dir()) {
        let dir = util::kungfu_cache_dir().join("fnm");
        let _ = fs::create_dir_all(&dir);
        env::set_var("FNM_DIR", &dir);
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_version;

    #[test]
    fn env_beats_pin_file_beats_fallback() {
        assert_eq!(
            resolve_version(Some("9.9.9"), Some("1.39.0\n"), "0.0.1"),
            "9.9.9"
        );
        assert_eq!(resolve_version(None, Some("1.39.0\n"), "0.0.1"), "1.39.0");
        assert_eq!(resolve_version(None, None, "0.0.1"), "0.0.1");
    }

    #[test]
    fn tolerates_v_prefix_whitespace_and_empty() {
        assert_eq!(resolve_version(None, Some("v1.39.0\n"), "0.0.1"), "1.39.0");
        assert_eq!(
            resolve_version(Some("  "), Some("  0.11.23  "), "0.0.1"),
            "0.11.23"
        );
        assert_eq!(resolve_version(Some(""), Some("\n"), "0.0.1"), "0.0.1");
    }
}
