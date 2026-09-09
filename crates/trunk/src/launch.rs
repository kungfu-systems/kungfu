// SPDX-License-Identifier: Apache-2.0
//
// The launch leg (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2): installed as `kungfu` next to the
// assembled runtime tree, this binary is the product front door. It stays
// argv-transparent — beyond recognizing the subtrees the trunk itself
// implements (env, prewarm), it interprets nothing and execs the assembled
// interpreter on `-m kungfu`, so the domain CLI remains the single source of
// truth for its own surface. The assembled interpreter is a real
// sys.executable; no Python search-path staging is needed (the tree carries its
// own kungfu-host.json marker and site-packages wiring). The trunk still owns
// the external-bytecode boundary because product callers may invoke it without
// the outer desktop CLI wrapper.

use crate::variant;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command;

const DEVELOPMENT_RUNTIME_BUILD_ID: &str = "development";

#[derive(Debug, PartialEq, Eq)]
struct PythonCacheEnvironment {
    cache_home: PathBuf,
    pycache_prefix: PathBuf,
}

fn non_empty<F>(lookup: &F, key: &str) -> Option<OsString>
where
    F: Fn(&str) -> Option<OsString>,
{
    lookup(key).filter(|value| !value.is_empty())
}

fn home_dir<F>(lookup: &F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    non_empty(lookup, "HOME")
        .or_else(|| non_empty(lookup, "USERPROFILE"))
        .map(PathBuf::from)
}

fn absolute_env_path(value: &OsStr, home: Option<&Path>, cwd: &Path) -> PathBuf {
    let raw = value.to_string_lossy();
    let expanded = if raw == "~" {
        home.map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(value))
    } else if raw.starts_with("~/") || raw.starts_with("~\\") {
        home.map(|root| root.join(&raw[2..]))
            .unwrap_or_else(|| PathBuf::from(value))
    } else {
        PathBuf::from(value)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

/// Resolve the disposable product cache independently from workspace data.
/// Explicit process and instance overrides win; otherwise each OS gets its
/// native per-user cache location.
fn product_cache_home_with<F>(platform: &str, lookup: F, cwd: &Path) -> Result<PathBuf, String>
where
    F: Fn(&str) -> Option<OsString>,
{
    let home = home_dir(&lookup);
    if let Some(explicit) = non_empty(&lookup, "KF_CACHE_HOME") {
        return Ok(absolute_env_path(&explicit, home.as_deref(), cwd));
    }
    if let Some(instance) = non_empty(&lookup, "KF_INSTANCE_HOME") {
        return Ok(absolute_env_path(&instance, home.as_deref(), cwd).join("cache"));
    }

    match platform {
        "macos" => home
            .map(|root| root.join("Library").join("Caches").join("kungfu"))
            .ok_or_else(|| "cannot resolve KF_CACHE_HOME: HOME is unset".to_string()),
        "windows" => {
            if let Some(local) = non_empty(&lookup, "LOCALAPPDATA") {
                Ok(PathBuf::from(local).join("Kungfu").join("Cache"))
            } else {
                home.map(|root| {
                    root.join("AppData")
                        .join("Local")
                        .join("Kungfu")
                        .join("Cache")
                })
                .ok_or_else(|| {
                    "cannot resolve KF_CACHE_HOME: LOCALAPPDATA and USERPROFILE are unset"
                        .to_string()
                })
            }
        }
        _ => {
            let base = non_empty(&lookup, "XDG_CACHE_HOME")
                .map(PathBuf::from)
                .or_else(|| home.map(|root| root.join(".cache")))
                .ok_or_else(|| {
                    "cannot resolve KF_CACHE_HOME: XDG_CACHE_HOME and HOME are unset".to_string()
                })?;
            Ok(base.join("kungfu"))
        }
    }
}

fn product_cache_home() -> Result<PathBuf, String> {
    let cwd = env::current_dir().map_err(|e| format!("cannot resolve current directory: {e}"))?;
    product_cache_home_with(env::consts::OS, |key| env::var_os(key), &cwd)
}

fn validate_runtime_build_id(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("upgrade manifest runtimeBuildId is not a safe cache namespace".to_string());
    }
    Ok(value.to_string())
}

fn runtime_build_id_from_json(contents: &str) -> Result<String, String> {
    let manifest: serde_json::Value = serde_json::from_str(contents)
        .map_err(|e| format!("cannot parse the upgrade manifest: {e}"))?;
    let value = manifest
        .get("runtimeBuildId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "upgrade manifest has no string runtimeBuildId".to_string())?;
    validate_runtime_build_id(value)
}

fn runtime_build_id() -> Result<String, String> {
    let Some(manifest_path) = resolved_upgrade_manifest_path() else {
        return Ok(DEVELOPMENT_RUNTIME_BUILD_ID.to_string());
    };
    let contents = fs::read_to_string(&manifest_path).map_err(|e| {
        format!(
            "cannot read upgrade manifest {}: {e}",
            PathBuf::from(&manifest_path).display()
        )
    })?;
    runtime_build_id_from_json(&contents)
}

fn adjacent_upgrade_manifest(executable: &Path) -> Option<PathBuf> {
    executable.parent()?.parent().map(|resources| {
        resources
            .join("upgrade")
            .join("kungfu-release-manifest.json")
    })
}

fn resolved_upgrade_manifest_path() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("KUNGFU_UPGRADE_MANIFEST").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(explicit));
    }
    env::current_exe()
        .ok()
        .and_then(|executable| adjacent_upgrade_manifest(&executable))
        .filter(|manifest| manifest.is_file())
}

fn python_cache_environment() -> Result<PythonCacheEnvironment, String> {
    let cache_home = product_cache_home()?;
    let pycache_prefix = cache_home.join("python").join(runtime_build_id()?);
    Ok(PythonCacheEnvironment {
        cache_home,
        pycache_prefix,
    })
}

/// Establish the product cache contract in this process before a native
/// runtime variant takes ownership. Normal CLI and GUI launches already pass
/// these variables to children, but a detached Node worker can enter through
/// `variant::dispatch` directly and must not depend on its parent having done
/// so. This also protects workers that survive an in-place App upgrade.
pub fn configure_product_cache_environment() -> Result<(), String> {
    let manifest = resolved_upgrade_manifest_path();
    let cache = python_cache_environment()?;
    if env::var_os("KUNGFU_UPGRADE_MANIFEST").is_none() {
        if let Some(manifest) = manifest {
            env::set_var("KUNGFU_UPGRADE_MANIFEST", manifest);
        }
    }
    env::set_var("KF_CACHE_HOME", cache.cache_home);
    env::set_var("PYTHONPYCACHEPREFIX", cache.pycache_prefix);
    Ok(())
}

/// Whether this process was invoked under the product entry name rather than
/// as kungfu-trunk. The same binary ships under both names; the file stem of
/// argv0 (falling back to the executable path) decides the mode.
pub fn invoked_as_kungfu() -> bool {
    let argv0 = env::args().next().map(PathBuf::from);
    let name = argv0
        .as_deref()
        .and_then(|p| p.file_stem())
        .map(|s| s.to_string_lossy().into_owned())
        .or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        });
    name.as_deref() == Some("kungfu")
}

fn interactive_tui_policy(
    stdin_is_terminal: bool,
    stdout_is_terminal: bool,
    term: Option<&str>,
    ci: Option<&str>,
) -> bool {
    stdin_is_terminal
        && stdout_is_terminal
        && !term.is_some_and(|value| value.eq_ignore_ascii_case("dumb"))
        && ci.is_none_or(|value| value.is_empty())
}

fn product_tui_command(
    exe: &Path,
    entry: &Path,
    runtime: &Path,
    args: &[String],
    cache: &PythonCacheEnvironment,
) -> Command {
    let mut command = Command::new(exe);
    command
        .arg(entry)
        .args(args)
        .env("KUNGFU_AS_VARIANT", "node")
        .env("KUNGFU_NODE_VARIANT_ENTRY", entry)
        .env("KF_CACHE_HOME", &cache.cache_home)
        .env("PYTHONPYCACHEPREFIX", &cache.pycache_prefix)
        .env("KUNGFU_DIR", runtime)
        .env(
            "KUNGFU_KFX_CONTRACT",
            runtime.join("config").join("kungfu-kfx.contract.json"),
        );
    command
}

#[cfg(windows)]
fn node_compatible_windows_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];

    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if let Some(rest) = wide.strip_prefix(VERBATIM_UNC_PREFIX) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(rest);
        return PathBuf::from(OsString::from_wide(&normalized));
    }
    if let Some(rest) = wide.strip_prefix(VERBATIM_PREFIX) {
        return PathBuf::from(OsString::from_wide(rest));
    }
    path.to_path_buf()
}

/// Launch the bundled terminal product through the native libnode host.
///
/// Returns `Ok(false)` when the fast path is not applicable, so callers can
/// preserve the Python/Click fallback. On success this function replaces the
/// process on Unix (or exits with the child status on Windows).
pub fn launch_tui(args: &[String]) -> Result<bool, String> {
    let term = env::var("TERM").ok();
    let ci = env::var("CI").ok();
    if !interactive_tui_policy(
        std::io::stdin().is_terminal(),
        std::io::stdout().is_terminal(),
        term.as_deref(),
        ci.as_deref(),
    ) || !variant::native_node_available()
    {
        return Ok(false);
    }

    let exe = env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|error| format!("cannot resolve the entry binary path: {error}"))?;
    // Windows canonicalization returns an extended-length `\\?\` path. Node's
    // module entry resolver does not accept that form and truncates the drive
    // path to `C:`, so normalize only the argv/env boundary handed to libnode.
    #[cfg(windows)]
    let exe = node_compatible_windows_path(&exe);
    let runtime = exe
        .parent()
        .ok_or_else(|| "the entry binary has no parent directory".to_string())?;
    let resources = runtime
        .parent()
        .ok_or_else(|| "the runtime has no product resources parent".to_string())?;
    let entry = resources.join("tui").join("tui.mjs");
    if !entry.is_file() {
        return Ok(false);
    }

    let cache = python_cache_environment()?;
    let mut command = product_tui_command(&exe, &entry, runtime, args, &cache);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(format!(
            "cannot exec native terminal product {}: {error}",
            entry.display()
        ))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .map_err(|error| format!("cannot run {}: {error}", entry.display()))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

fn tree_python() -> Result<PathBuf, String> {
    let exe = env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("cannot resolve the entry binary path: {e}"))?;
    let root = exe
        .parent()
        .ok_or_else(|| "the entry binary has no parent directory".to_string())?;
    let python = if cfg!(windows) {
        root.join("python").join("python.exe")
    } else {
        root.join("python").join("bin").join("python3")
    };
    if !python.is_file() {
        return Err(format!(
            "assembled runtime tree not found at {} — the `kungfu` entry only \
             runs next to the tree the product ships (dev: invoke repository \
             tasks through `./shifu`, or use kungfu-trunk for env commands)",
            python.display()
        ));
    }
    Ok(python)
}

fn product_python_command(
    python: &Path,
    args: &[String],
    cache: &PythonCacheEnvironment,
) -> Command {
    let mut command = Command::new(python);
    command
        .env("KF_CACHE_HOME", &cache.cache_home)
        .env("PYTHONPYCACHEPREFIX", &cache.pycache_prefix)
        .arg("-m")
        .arg("kungfu")
        .args(args);
    command
}

/// Exec the assembled interpreter on `-m kungfu` with the caller's arguments,
/// verbatim. Unix replaces the process; Windows waits and mirrors the exit
/// code (no exec semantics there).
pub fn launch(args: &[String]) -> Result<(), String> {
    if args.is_empty() && launch_tui(args)? {
        return Ok(());
    }
    let python = tree_python()?;
    let cache = python_cache_environment()?;
    let mut command = product_python_command(&python, args, &cache);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = command.exec();
        Err(format!("cannot exec {}: {err}", python.display()))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .map_err(|e| format!("cannot run {}: {e}", python.display()))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let values: HashMap<String, OsString> = values
            .iter()
            .map(|(key, value)| ((*key).to_string(), OsString::from(value)))
            .collect();
        move |key| values.get(key).cloned()
    }

    #[test]
    fn cache_home_precedence_and_platform_defaults_are_cross_platform() {
        let cwd = Path::new("/workspace");
        assert_eq!(
            product_cache_home_with(
                "macos",
                lookup(&[
                    ("HOME", "/Users/kf"),
                    ("KF_INSTANCE_HOME", "/instances/a"),
                    ("KF_CACHE_HOME", "/cache/explicit"),
                ]),
                cwd,
            )
            .unwrap(),
            PathBuf::from("/cache/explicit")
        );
        assert_eq!(
            product_cache_home_with(
                "linux",
                lookup(&[("HOME", "/home/kf"), ("KF_INSTANCE_HOME", "/instances/a")]),
                cwd,
            )
            .unwrap(),
            PathBuf::from("/instances/a/cache")
        );
        assert_eq!(
            product_cache_home_with("macos", lookup(&[("HOME", "/Users/kf")]), cwd).unwrap(),
            PathBuf::from("/Users/kf/Library/Caches/kungfu")
        );
        assert_eq!(
            product_cache_home_with(
                "windows",
                lookup(&[("LOCALAPPDATA", "C:\\Users\\kf\\AppData\\Local")]),
                cwd,
            )
            .unwrap(),
            PathBuf::from("C:\\Users\\kf\\AppData\\Local")
                .join("Kungfu")
                .join("Cache")
        );
        assert_eq!(
            product_cache_home_with(
                "linux",
                lookup(&[("HOME", "/home/kf"), ("XDG_CACHE_HOME", "/xdg/cache")]),
                cwd,
            )
            .unwrap(),
            PathBuf::from("/xdg/cache/kungfu")
        );
        assert_eq!(
            product_cache_home_with("linux", lookup(&[("HOME", "/home/kf")]), cwd).unwrap(),
            PathBuf::from("/home/kf/.cache/kungfu")
        );
    }

    #[test]
    fn relative_overrides_are_made_absolute() {
        assert_eq!(
            product_cache_home_with(
                "linux",
                lookup(&[("HOME", "/home/kf"), ("KF_CACHE_HOME", "cache")]),
                Path::new("/workspace"),
            )
            .unwrap(),
            PathBuf::from("/workspace/cache")
        );
        assert_eq!(
            product_cache_home_with(
                "linux",
                lookup(&[("HOME", "/home/kf"), ("KF_INSTANCE_HOME", "~/instance")]),
                Path::new("/workspace"),
            )
            .unwrap(),
            PathBuf::from("/home/kf/instance/cache")
        );
    }

    #[test]
    fn release_manifest_build_id_is_a_safe_cache_namespace() {
        assert_eq!(
            runtime_build_id_from_json(r#"{"runtimeBuildId":"runtime-4.0.0-alpha.1-deadbeef"}"#)
                .unwrap(),
            "runtime-4.0.0-alpha.1-deadbeef"
        );
        assert!(runtime_build_id_from_json(r#"{"runtimeBuildId":"../escape"}"#).is_err());
        assert!(runtime_build_id_from_json(r#"{"version":"4.0.0"}"#).is_err());
        assert_eq!(
            adjacent_upgrade_manifest(Path::new(
                "/Applications/Kungfu.app/Contents/Resources/kungfu/kungfu"
            )),
            Some(PathBuf::from(
                "/Applications/Kungfu.app/Contents/Resources/upgrade/kungfu-release-manifest.json"
            ))
        );
    }

    #[test]
    fn product_python_dispatch_externalizes_signed_tree_bytecode_writes() {
        let args = vec!["dogfood".to_string(), "doctor".to_string()];
        let cache = PythonCacheEnvironment {
            cache_home: PathBuf::from("/cache/kungfu"),
            pycache_prefix: PathBuf::from("/cache/kungfu/python/runtime-1"),
        };
        let command = product_python_command(Path::new("/product/python3"), &args, &cache);

        assert_eq!(command.get_program(), OsStr::new("/product/python3"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-m", "kungfu", "dogfood", "doctor"].map(OsStr::new)
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("KF_CACHE_HOME"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("/cache/kungfu"))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("PYTHONPYCACHEPREFIX"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("/cache/kungfu/python/runtime-1"))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("PYTHONDONTWRITEBYTECODE")),
            None
        );
    }

    #[test]
    fn native_tui_dispatch_preserves_external_python_cache_contract() {
        let cache = PythonCacheEnvironment {
            cache_home: PathBuf::from("/cache/kungfu"),
            pycache_prefix: PathBuf::from("/cache/kungfu/python/runtime-1"),
        };
        let command = product_tui_command(
            Path::new("/product/kungfu"),
            Path::new("/product/tui/tui.mjs"),
            Path::new("/product/runtime"),
            &[],
            &cache,
        );

        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("KF_CACHE_HOME"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("/cache/kungfu"))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("PYTHONPYCACHEPREFIX"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("/cache/kungfu/python/runtime-1"))
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("PYTHONDONTWRITEBYTECODE")),
            None
        );
    }

    #[test]
    fn native_tui_fast_path_requires_a_real_interactive_terminal() {
        assert!(interactive_tui_policy(
            true,
            true,
            Some("xterm-256color"),
            None
        ));
        assert!(!interactive_tui_policy(
            false,
            true,
            Some("xterm-256color"),
            None
        ));
        assert!(!interactive_tui_policy(
            true,
            false,
            Some("xterm-256color"),
            None
        ));
        assert!(!interactive_tui_policy(true, true, Some("dumb"), None));
        assert!(!interactive_tui_policy(
            true,
            true,
            Some("xterm-256color"),
            Some("1")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn native_tui_argv_removes_windows_verbatim_path_prefixes() {
        assert_eq!(
            node_compatible_windows_path(Path::new(r"\\?\C:\Users\dkr\Kungfu\tui\tui.mjs")),
            PathBuf::from(r"C:\Users\dkr\Kungfu\tui\tui.mjs")
        );
        assert_eq!(
            node_compatible_windows_path(Path::new(r"\\?\UNC\server\share\Kungfu\tui\tui.mjs")),
            PathBuf::from(r"\\server\share\Kungfu\tui\tui.mjs")
        );
    }
}
