// SPDX-License-Identifier: Apache-2.0
//
// Pinned-tool bootstrap — the acquisition leg of the shifu role. First cast
// for the dev launcher's prerequisites (fnm for the node side, uv for the
// python side); the same discipline the product trunk reuses for its lazy
// pinned-uv fetch (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 1).
//
// Two layers:
//
//   FetchSpec / fetch  the engine — given an exact tool/version/URL (and
//                      optionally a pinned SHA-256), place the binary in the
//                      user-global cache and return its path. Any consumer
//                      with its own pin source drives this directly.
//   Tool               the launcher-flavored spec on top: repo pin files,
//                      env version overrides, per-tool mirror env, release
//                      asset naming — resolving into a FetchSpec.
//
// Resolution order per tool:
//   1. already on PATH             -> use it (respect the user's environment)
//   2. user-global cache           -> ${XDG_CACHE_HOME:-~/.cache}/kungfu/tools/<tool>/<version>/<os>-<arch>/
//   3. bootstrap: download the pinned prebuilt release binary into the cache
//
// Step 3 is what makes a fresh machine turnkey: no compiler, no package
// manager, no admin rights — the same "consume the amortized prebuilt binary"
// discipline the repo already applies to node (fnm) and CPython (uv).
//
// Downloads shell out to platform tools (curl + tar/unzip on Unix,
// curl.exe/PowerShell + tar.exe on Windows 10+) so the shifu role itself
// stays dependency-free. Mirrors are configurable through build-local.env
// (KUNGFU_FNM_DIST_MIRROR / KUNGFU_UV_DIST_MIRROR /
// KUNGFU_BUILDCHAIN_DIST_MIRROR), and checksums can be pinned per environment
// (KUNGFU_FNM_SHA256 / KUNGFU_UV_SHA256 / KUNGFU_BUILDCHAIN_SHA256).
//
// A failed fetch is a named error (BootstrapError) carrying the exact URL,
// the expected checksum, and the mirror override to set — self-diagnosing by
// construction, so a consumer's failure report needs no archaeology.
//
// Bootstrap versions resolve like node's: the repo pins them in data files
// (.fnm-version / .uv-version / .buildchain-version, same shape as
// .node-version). Precedence: per-tool env override > repo pin file > compiled
// default (the fallback that keeps a distributed binary working when a
// checkout predates the pin files).

use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::host;
use crate::probe::{Probe, Status};

/// Compiled fallback versions — used only when a tool is absent AND the repo
/// carries no pin file. The repo pin files are the normal source of truth; an
/// fnm / uv already on PATH is always used as-is regardless of version.
const FNM_FALLBACK_VERSION: &str = "1.39.0";
const UV_FALLBACK_VERSION: &str = "0.11.23";
const BUILDCHAIN_FALLBACK_VERSION: &str = "3.0.1-alpha.2";

const FNM_BASE: &str = "https://github.com/Schniz/fnm/releases/download";
const UV_BASE: &str = "https://github.com/astral-sh/uv/releases/download";
const BUILDCHAIN_BASE: &str = "https://github.com/kungfu-systems/buildchain/releases/download";

/// Cache path segment naming the platform triple this process would fetch
/// for, e.g. `macos-aarch64`. Part of the cache contract (see
/// `FetchSpec::cached_binary`): binaries for different targets must never
/// share a cache slot.
fn cache_target() -> String {
    host::os_arch()
}

/// Everything the fetch engine needs to acquire one pinned tool: an exact
/// version, an exact URL, and optionally the expected archive SHA-256. The
/// caller owns pin resolution; the engine owns download / verify / cache.
pub struct FetchSpec {
    /// Cache key and default binary stem ("uv").
    pub tool: String,
    /// Exact pinned version — becomes the cache subdirectory.
    pub version: String,
    /// Exact download URL, mirror override already applied.
    pub url: String,
    /// Expected SHA-256 of the downloaded archive; verified when set.
    pub sha256: Option<String>,
    /// Name of the mirror-override env var, quoted in failure diagnostics.
    pub mirror_env: Option<String>,
    /// Binary file name inside the archive; defaults to `tool` (plus `.exe`
    /// on Windows).
    pub binary: Option<String>,
}

impl FetchSpec {
    fn binary_name(&self) -> String {
        match &self.binary {
            Some(name) => name.clone(),
            None if cfg!(windows) => format!("{}.exe", self.tool),
            None => self.tool.clone(),
        }
    }

    /// Where the engine caches this tool+version:
    /// `${XDG_CACHE_HOME:-~/.cache}/kungfu/tools/<tool>/<version>/<os>-<arch>/<binary>`.
    ///
    /// The target segment is load-bearing: on macOS a Rosetta-context consumer
    /// can populate an arch-blind path with an x86_64 binary that a native
    /// arm64 consumer would then silently run (and it would install x86_64
    /// satellites in turn). One cache key per platform triple keeps every
    /// consumer's toolchain matching its own architecture.
    pub fn cached_binary(&self) -> PathBuf {
        host::kungfu_cache_dir()
            .join("tools")
            .join(&self.tool)
            .join(&self.version)
            .join(cache_target())
            .join(self.binary_name())
    }

    fn error(&self, kind: BootstrapErrorKind) -> BootstrapError {
        BootstrapError::new(
            self.tool.clone(),
            Some(self.url.clone()),
            self.mirror_env.clone(),
            kind,
        )
    }
}

/// A named, self-diagnosing bootstrap failure: what tool, which exact URL,
/// which mirror override to set — everything a failure report needs. Boxed
/// internally so the error path stays cheap to return.
#[derive(Debug)]
pub struct BootstrapError(Box<BootstrapErrorInner>);

#[derive(Debug)]
struct BootstrapErrorInner {
    tool: String,
    url: Option<String>,
    mirror_env: Option<String>,
    kind: BootstrapErrorKind,
}

impl BootstrapError {
    fn new(
        tool: String,
        url: Option<String>,
        mirror_env: Option<String>,
        kind: BootstrapErrorKind,
    ) -> Self {
        BootstrapError(Box::new(BootstrapErrorInner {
            tool,
            url,
            mirror_env,
            kind,
        }))
    }

    pub fn tool(&self) -> &str {
        &self.0.tool
    }

    /// Exact URL involved, when the failure has one.
    pub fn url(&self) -> Option<&str> {
        self.0.url.as_deref()
    }

    /// The mirror-override env var a consumer can set to route around it.
    pub fn mirror_env(&self) -> Option<&str> {
        self.0.mirror_env.as_deref()
    }

    pub fn kind(&self) -> &BootstrapErrorKind {
        &self.0.kind
    }
}

#[derive(Debug)]
pub enum BootstrapErrorKind {
    /// No prebuilt asset exists for this OS/arch.
    NoPrebuilt {
        os: &'static str,
        arch: &'static str,
    },
    /// The download step failed (no downloader, network error, 404, ...).
    Download { detail: String },
    /// The downloaded archive did not match the pinned SHA-256.
    ChecksumMismatch { expected: String, actual: String },
    /// A pinned checksum was requested but could not be verified on this host.
    ChecksumUnverifiable { detail: String },
    /// Extraction or placement failed after a successful download.
    Io { detail: String },
}

impl fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let inner = &self.0;
        match &inner.kind {
            BootstrapErrorKind::NoPrebuilt { os, arch } => {
                write!(f, "no prebuilt {} for {os}/{arch}", inner.tool)?;
            }
            BootstrapErrorKind::Download { detail } => {
                write!(f, "downloading {} failed: {detail}", inner.tool)?;
                if let Some(url) = &inner.url {
                    write!(f, "\n  url: {url}")?;
                }
                if let Some(mirror) = &inner.mirror_env {
                    write!(
                        f,
                        "\n  set {mirror} to a reachable mirror to route around it"
                    )?;
                }
            }
            BootstrapErrorKind::ChecksumMismatch { expected, actual } => {
                write!(f, "checksum mismatch for {}", inner.tool)?;
                if let Some(url) = &inner.url {
                    write!(f, "\n  url: {url}")?;
                }
                write!(
                    f,
                    "\n  expected sha256: {expected}\n  actual sha256:   {actual}"
                )?;
                if let Some(mirror) = &inner.mirror_env {
                    write!(
                        f,
                        "\n  (stale or tampered mirror? point {mirror} elsewhere, or update the pinned checksum)"
                    )?;
                }
            }
            BootstrapErrorKind::ChecksumUnverifiable { detail } => {
                write!(
                    f,
                    "cannot verify the pinned sha256 for {}: {detail}",
                    inner.tool
                )?;
            }
            BootstrapErrorKind::Io { detail } => {
                write!(f, "bootstrapping {} failed: {detail}", inner.tool)?;
                if let Some(url) = &inner.url {
                    write!(f, "\n  url: {url}")?;
                }
            }
        }
        Ok(())
    }
}

impl std::error::Error for BootstrapError {}

pub struct Tool {
    /// Command name and cached-binary file stem ("fnm" / "uv").
    pub name: &'static str,
    version_env: &'static str,
    /// Repo-root pin file, .node-version-shaped (single version line).
    pin_file: &'static str,
    default_version: &'static str,
    mirror_env: &'static str,
    checksum_env: &'static str,
    default_base: &'static str,
    install_hint: &'static str,
    /// Ignore an unrelated executable on PATH and resolve the exact repo pin.
    pin_first: bool,
}

pub const FNM: Tool = Tool {
    name: "fnm",
    version_env: "KUNGFU_FNM_VERSION",
    pin_file: ".fnm-version",
    default_version: FNM_FALLBACK_VERSION,
    mirror_env: "KUNGFU_FNM_DIST_MIRROR",
    checksum_env: "KUNGFU_FNM_SHA256",
    default_base: FNM_BASE,
    install_hint: "https://github.com/Schniz/fnm",
    pin_first: false,
};

pub const UV: Tool = Tool {
    name: "uv",
    version_env: "KUNGFU_UV_VERSION",
    pin_file: ".uv-version",
    default_version: UV_FALLBACK_VERSION,
    mirror_env: "KUNGFU_UV_DIST_MIRROR",
    checksum_env: "KUNGFU_UV_SHA256",
    default_base: UV_BASE,
    install_hint: "https://docs.astral.sh/uv/",
    pin_first: false,
};

/// Buildchain is a repo-pinned build input, so an unrelated global executable
/// must never replace the version declared by `.buildchain-version`.
pub const BUILDCHAIN: Tool = Tool {
    name: "buildchain",
    version_env: "KUNGFU_BUILDCHAIN_VERSION",
    pin_file: ".buildchain-version",
    default_version: BUILDCHAIN_FALLBACK_VERSION,
    mirror_env: "KUNGFU_BUILDCHAIN_DIST_MIRROR",
    checksum_env: "KUNGFU_BUILDCHAIN_SHA256",
    default_base: BUILDCHAIN_BASE,
    install_hint: "https://github.com/kungfu-systems/buildchain/releases",
    pin_first: true,
};

impl Tool {
    /// Repo pin file name (e.g. ".fnm-version"), for doctor-style reporting.
    pub fn pin_file(&self) -> &'static str {
        self.pin_file
    }

    /// Manual install pointer, for failure messages.
    pub fn install_hint(&self) -> &'static str {
        self.install_hint
    }

    /// Pinned version for a checkout: env override > repo pin file >
    /// compiled fallback.
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
        host::kungfu_cache_dir()
            .join("tools")
            .join(self.name)
            .join(self.version(root))
            .join(cache_target())
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
            ("uv", "linux", "x86_64") => "uv-x86_64-unknown-linux-gnu.tar.gz".to_string(),
            ("uv", "linux", "aarch64") => "uv-aarch64-unknown-linux-gnu.tar.gz".to_string(),
            ("uv", "windows", "x86_64") => "uv-x86_64-pc-windows-msvc.zip".to_string(),
            ("buildchain", "macos", "aarch64") => {
                "buildchain-aarch64-apple-darwin.tar.gz".to_string()
            }
            ("buildchain", "linux", "x86_64") => {
                "buildchain-x86_64-unknown-linux-gnu.tar.gz".to_string()
            }
            ("buildchain", "windows", "x86_64") => {
                "buildchain-x86_64-pc-windows-msvc.zip".to_string()
            }
            _ => return None,
        };
        Some(name)
    }

    /// Resolve this tool at an exact version into an engine spec: release
    /// asset for the current platform, mirror override applied, checksum pin
    /// taken from the environment. This is the launcher-flavored front end of
    /// `fetch`; a consumer with its own pin source builds a FetchSpec
    /// directly instead.
    pub fn fetch_spec(&self, version: &str) -> Result<FetchSpec, BootstrapError> {
        let Some(asset) = self.asset() else {
            return Err(BootstrapError::new(
                self.name.to_string(),
                None,
                Some(self.mirror_env.to_string()),
                BootstrapErrorKind::NoPrebuilt {
                    os: env::consts::OS,
                    arch: env::consts::ARCH,
                },
            ));
        };
        let tag = match self.name {
            // fnm tags are v-prefixed; uv tags are bare versions.
            "fnm" | "buildchain" => format!("v{version}"),
            _ => version.to_string(),
        };
        let sha256 = env::var(self.checksum_env)
            .ok()
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        Ok(FetchSpec {
            tool: self.name.to_string(),
            version: version.to_string(),
            url: format!("{}/{}/{}", self.base_url(), tag, asset),
            sha256,
            mirror_env: Some(self.mirror_env.to_string()),
            binary: None,
        })
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
    let cached = tool.cached_binary(root);
    if tool.pin_first {
        return cached.is_file().then_some(cached);
    }
    host::find_on_path(tool.name).or_else(|| cached.is_file().then_some(cached))
}

/// Resolve a tool, bootstrapping the pinned prebuilt release when absent.
/// The error names everything (URL, checksum, mirror override); how to exit
/// on it is the binary's decision (the launcher dies with code 127).
pub fn ensure_tool(tool: &Tool, root: &Path) -> Result<PathBuf, BootstrapError> {
    if let Some(found) = find_tool(tool, root) {
        return Ok(found);
    }
    let spec = tool.fetch_spec(&tool.version(root))?;
    eprintln!(
        "shifu: {} not found; fetching prebuilt {} {} into {}",
        tool.name,
        tool.name,
        spec.version,
        spec.cached_binary()
            .parent()
            .expect("cached binary has a parent dir")
            .display()
    );
    fetch(&spec)
}

/// The fetch engine: return the cached binary for `spec`, downloading,
/// verifying (when a checksum is pinned), extracting, and caching it first
/// when absent. Pure acquisition — no PATH probing, no process exits.
pub fn fetch(spec: &FetchSpec) -> Result<PathBuf, BootstrapError> {
    let target = spec.cached_binary();
    if target.is_file() {
        return Ok(target);
    }
    let target_dir = target.parent().expect("cached binary has a parent dir");
    fs::create_dir_all(target_dir).map_err(|e| {
        spec.error(BootstrapErrorKind::Io {
            detail: format!("cannot create {}: {e}", target_dir.display()),
        })
    })?;

    let work = host::unique_temp_dir(&format!("shifu-{}", spec.tool)).map_err(|e| {
        spec.error(BootstrapErrorKind::Io {
            detail: format!("cannot create temp dir: {e}"),
        })
    })?;
    let archive = work.join(spec.url.rsplit('/').next().unwrap_or("archive"));

    download(&spec.url, &archive)
        .map_err(|detail| spec.error(BootstrapErrorKind::Download { detail }))?;
    if let Some(expected) = &spec.sha256 {
        verify_checksum(spec, expected, &archive)?;
    }

    // Archives are unpacked and searched for the binary; a raw asset (no
    // archive suffix — release binaries like shifu's ship raw) IS the binary.
    let binary_name = spec.binary_name();
    let extracted = if is_archive_name(&archive) {
        extract(&archive, &work).map_err(|detail| spec.error(BootstrapErrorKind::Io { detail }))?;
        find_file(&work, &binary_name, 3).ok_or_else(|| {
            spec.error(BootstrapErrorKind::Io {
                detail: format!("{binary_name} not found inside {}", archive.display()),
            })
        })?
    } else {
        archive.clone()
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&extracted, fs::Permissions::from_mode(0o755));
    }

    // rename() fails across filesystems (temp dir vs cache); fall back to copy.
    if fs::rename(&extracted, &target).is_err() {
        fs::copy(&extracted, &target).map_err(|e| {
            spec.error(BootstrapErrorKind::Io {
                detail: format!("cannot place {}: {e}", target.display()),
            })
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        }
    }
    let _ = fs::remove_dir_all(&work);
    Ok(target)
}

fn is_archive_name(path: &Path) -> bool {
    let name = path.to_string_lossy().to_lowercase();
    name.ends_with(".tar.gz") || name.ends_with(".tgz") || name.ends_with(".zip")
}

/// Download one file with the host's own tools (curl, PowerShell fallback on
/// Windows) — the same zero-dependency engine `fetch` uses, exposed for
/// consumers that need a sidecar file (e.g. a release's SHA256SUMS) rather
/// than a cached tool.
pub fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    download(url, dest)
}

fn download(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(curl) = host::find_on_path("curl") {
        let status = Command::new(curl)
            .args([
                "-fsSL",
                "--retry",
                "4",
                "--retry-all-errors",
                "--connect-timeout",
                "20",
                "--speed-limit",
                "1024",
                "--speed-time",
                "30",
                "--continue-at",
                "-",
                "-o",
            ])
            .arg(dest)
            .arg(url)
            .status()
            .map_err(|e| format!("failed to run curl: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("curl failed".to_string());
    }
    #[cfg(windows)]
    {
        // Windows fallback when curl.exe is unavailable (pre-1803 or stripped
        // images): PowerShell ships everywhere we support.
        for ps in ["pwsh.exe", "powershell.exe"] {
            if host::find_on_path(ps).is_none() {
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
            return Err(format!("{ps} failed"));
        }
    }
    Err("no downloader available (curl not on PATH)".to_string())
}

/// Verify the downloaded archive against the pinned checksum.
fn verify_checksum(spec: &FetchSpec, expected: &str, archive: &Path) -> Result<(), BootstrapError> {
    let expected = expected.trim().to_lowercase();
    if expected.is_empty() {
        return Ok(());
    }
    let actual = sha256_file(archive)
        .map_err(|detail| spec.error(BootstrapErrorKind::ChecksumUnverifiable { detail }))?;
    if actual != expected {
        return Err(spec.error(BootstrapErrorKind::ChecksumMismatch { expected, actual }));
    }
    Ok(())
}

/// SHA-256 of a file via the host's own tools (sha256sum / shasum on Unix,
/// certutil on Windows) — the same zero-dependency discipline as downloads.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let attempts: &[(&str, &[&str])] = if cfg!(windows) {
        &[("certutil", &["-hashfile"])]
    } else {
        &[("sha256sum", &[]), ("shasum", &["-a", "256"])]
    };
    for (program, args) in attempts {
        let Some(bin) = host::find_on_path(program) else {
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
    let bin = host::find_on_path(program)
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
    if fnm_path.starts_with(host::kungfu_cache_dir()) {
        let dir = host::kungfu_cache_dir().join("fnm");
        let _ = fs::create_dir_all(&dir);
        env::set_var("FNM_DIR", &dir);
    }
}

// ---------------------------------------------------------------------------
// Seed probes — the bootstrap leg diagnosing itself through the probe
// framework (report, never repair). Every bearer's doctor can mount these;
// none of them is required, so they inform without changing exit semantics.

/// Cache-health probe: the user-global tool cache exists (or will be created)
/// and is writable.
pub fn cache_probe() -> Probe {
    let dir = host::kungfu_cache_dir().join("tools");
    Probe {
        label: "tool cache".to_string(),
        required: false,
        hint: "the user-global bootstrap cache must stay writable".to_string(),
        repair_cmd: Some(format!("chmod -R u+rw {}", dir.display())),
        probe: Box::new(move || {
            if !dir.exists() {
                return Status::Info(format!(
                    "{} - absent; created on first bootstrap",
                    dir.display()
                ));
            }
            let readonly = fs::metadata(&dir)
                .map(|m| m.permissions().readonly())
                .unwrap_or(false);
            if readonly {
                return Status::Missing;
            }
            let mut tools: Vec<String> = fs::read_dir(&dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .filter(|e| e.path().is_dir())
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .collect()
                })
                .unwrap_or_default();
            tools.sort();
            if tools.is_empty() {
                Status::Present(format!("{} - empty", dir.display()))
            } else {
                Status::Present(format!("{} - caches {}", dir.display(), tools.join(", ")))
            }
        }),
    }
}

/// Mirror probe: when a mirror override is configured for `tool`, check the
/// mirror answers at all (connection-level reachability, not asset presence);
/// otherwise report the default source and the override to set.
pub fn mirror_probe(tool: &'static Tool) -> Probe {
    let configured = env::var(tool.mirror_env)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let label = format!("{} mirror", tool.name);
    match configured {
        None => Probe {
            label,
            required: false,
            hint: String::new(),
            repair_cmd: None,
            probe: Box::new(move || {
                Status::Info(format!(
                    "default ({}); override: {}",
                    tool.default_base, tool.mirror_env
                ))
            }),
        },
        Some(url) => Probe {
            label,
            required: false,
            hint: format!(
                "configured mirror does not answer - fix or unset {}",
                tool.mirror_env
            ),
            repair_cmd: Some(format!("unset {}", tool.mirror_env)),
            probe: Box::new(move || {
                if url_answers(&url) {
                    Status::Present(format!("{url} (reachable, via {})", tool.mirror_env))
                } else {
                    Status::Missing
                }
            }),
        },
    }
}

/// Pin-vs-cache probe (version bite): does the user-global cache hold exactly
/// the version this checkout pins?
pub fn pin_probe(tool: &'static Tool, root: Option<&Path>) -> Probe {
    let root = root.map(Path::to_path_buf);
    let tool_dir = host::kungfu_cache_dir().join("tools").join(tool.name);
    Probe {
        label: format!("{} pin", tool.name),
        required: false,
        hint: "cache holds other versions but not the pinned one; the pin is fetched on next use, stale versions only cost disk".to_string(),
        repair_cmd: Some(format!("rm -rf {}", tool_dir.display())),
        probe: Box::new(move || {
            let lookup_root = root.clone().unwrap_or_else(|| Path::new(".").into());
            let pin = tool.version(&lookup_root);
            if tool.cached_binary(&lookup_root).is_file() {
                return Status::Present(format!("cache holds pinned {pin}"));
            }
            let cache_populated = fs::read_dir(&tool_dir)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
            if cache_populated {
                return Status::Missing;
            }
            if host::find_on_path(tool.name).is_some() {
                Status::Info(format!("pinned {pin}; resolves from PATH, cache unused"))
            } else {
                Status::Info(format!("pinned {pin}; bootstraps on first use"))
            }
        }),
    }
}

/// Connection-level reachability: does anything answer at `url`? Any HTTP
/// response counts (a 404 on the base path still proves the mirror answers);
/// only DNS/connect/timeout failures — or having no curl — report false.
fn url_answers(url: &str) -> bool {
    let Some(curl) = host::find_on_path("curl") else {
        return false;
    };
    Command::new(curl)
        .args(["-sSI", "--connect-timeout", "3", "--max-time", "6"])
        .arg(url)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{resolve_version, BUILDCHAIN};

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

    #[test]
    fn buildchain_is_pin_first_and_uses_release_archives() {
        let spec = BUILDCHAIN
            .fetch_spec("3.0.1-alpha.2")
            .expect("supported CI platforms have a Buildchain archive");
        assert!(spec.url.contains("/v3.0.1-alpha.2/buildchain-"));
        assert!(spec.url.ends_with(".tar.gz") || spec.url.ends_with(".zip"));
        assert_eq!(
            spec.binary_name(),
            if cfg!(windows) {
                "buildchain.exe"
            } else {
                "buildchain"
            }
        );
    }
}
