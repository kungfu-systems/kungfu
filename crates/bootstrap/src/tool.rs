// SPDX-License-Identifier: Apache-2.0
//
// Pinned prebuilt tools (fnm for the node side, uv for the python side).
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
// Mirrors are configurable through build-local.env
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

use crate::{fetch, paths};

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
    /// Pin file resolved against the caller-provided pin root
    /// (.node-version-shaped: a single version line).
    pin_file: &'static str,
    default_version: &'static str,
    mirror_env: &'static str,
    sha256_env: &'static str,
    default_base: &'static str,
    install_hint: &'static str,
}

pub const FNM: Tool = Tool {
    name: "fnm",
    version_env: "KUNGFU_FNM_VERSION",
    pin_file: ".fnm-version",
    default_version: FNM_FALLBACK_VERSION,
    mirror_env: "KUNGFU_FNM_DIST_MIRROR",
    sha256_env: "KUNGFU_FNM_SHA256",
    default_base: FNM_BASE,
    install_hint: "https://github.com/Schniz/fnm",
};

pub const UV: Tool = Tool {
    name: "uv",
    version_env: "KUNGFU_UV_VERSION",
    pin_file: ".uv-version",
    default_version: UV_FALLBACK_VERSION,
    mirror_env: "KUNGFU_UV_DIST_MIRROR",
    sha256_env: "KUNGFU_UV_SHA256",
    default_base: UV_BASE,
    install_hint: "https://docs.astral.sh/uv/",
};

impl Tool {
    /// Pin file name (e.g. ".fnm-version"), for doctor-style reporting.
    pub fn pin_file(&self) -> &'static str {
        self.pin_file
    }

    pub fn version(&self, root: &Path) -> String {
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
        paths::kungfu_cache_dir()
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

    /// Optional integrity pin: the expected sha256 for the downloaded archive
    /// when KUNGFU_<TOOL>_SHA256 is set (e.g. by CI or a mirror-using
    /// environment). Product-side consumers pass their own expectation from a
    /// committed manifest instead.
    fn env_sha256(&self) -> Option<String> {
        let expected = env::var(self.sha256_env).ok()?;
        let expected = expected.trim().to_lowercase();
        (!expected.is_empty()).then_some(expected)
    }
}

/// Version precedence: env override > repo pin file > compiled fallback.
/// Values are trimmed and a leading `v` is tolerated (tags are normalized
/// per-tool at URL construction).
fn resolve_version(env_val: Option<&str>, file_text: Option<&str>, fallback: &str) -> String {
    for raw in [env_val, file_text].into_iter().flatten() {
        let v = raw.trim().trim_start_matches('v');
        if !v.is_empty() {
            return v.to_string();
        }
    }
    fallback.to_string()
}

/// Resolve a tool without bootstrapping (PATH, then cache). Used where the sh
/// entrypoint also degraded gracefully (e.g. rich-subcommand node resolution).
pub fn find_tool(tool: &Tool, root: &Path) -> Option<PathBuf> {
    if let Some(on_path) = paths::find_on_path(tool.name) {
        return Some(on_path);
    }
    let cached = tool.cached_binary(root);
    cached.is_file().then_some(cached)
}

/// Resolve a tool, bootstrapping the pinned prebuilt release when absent.
/// `log_prefix` names the consuming binary in the progress line ("shifu",
/// "kungfu-trunk"). Never exits: the caller decides what a failure costs.
pub fn ensure_tool(tool: &Tool, root: &Path, log_prefix: &str) -> Result<PathBuf, String> {
    if let Some(found) = find_tool(tool, root) {
        return Ok(found);
    }
    bootstrap(tool, root, log_prefix).map_err(|err| {
        format!(
            "{} is required but was not found on PATH, and bootstrapping the prebuilt binary \
             failed: {err}\n  install it manually ({}) or fix the failure above and re-run",
            tool.name, tool.install_hint
        )
    })
}

fn bootstrap(tool: &Tool, root: &Path, log_prefix: &str) -> Result<PathBuf, String> {
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
        "{log_prefix}: {} not found; fetching prebuilt {} {} into {}",
        tool.name,
        tool.name,
        tool.version(root),
        target_dir.display()
    );

    let work = paths::unique_temp_dir(&format!("{log_prefix}-{}", tool.name))
        .map_err(|e| format!("cannot create temp dir: {e}"))?;
    let archive = work.join(url.rsplit('/').next().unwrap_or("archive"));

    fetch::download(&url, &archive)?;
    if let Some(expected) = tool.env_sha256() {
        fetch::verify_sha256(&archive, &expected)?;
    }
    fetch::extract(&archive, &work)?;

    let binary_name = if cfg!(windows) {
        format!("{}.exe", tool.name)
    } else {
        tool.name.to_string()
    };
    let extracted = fetch::find_file(&work, &binary_name, 3)
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

/// When the launcher bootstrapped fnm itself there is no pre-existing user fnm
/// state; point FNM_DIR at the user-global kungfu cache so node installs are
/// shared across worktrees and clones. An fnm found on PATH keeps whatever
/// environment the user already has.
pub fn default_fnm_dir_if_bootstrapped(fnm_path: &Path) {
    if env::var_os("FNM_DIR").is_some() {
        return;
    }
    if fnm_path.starts_with(paths::kungfu_cache_dir()) {
        let dir = paths::kungfu_cache_dir().join("fnm");
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
