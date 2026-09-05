// SPDX-License-Identifier: Apache-2.0
//
// The kungfu-owned env/package surface (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 1).
//
// Environments derive only from the blessed interpreter: the pinned uv
// (fetched checksum-verified through shifu-core on first use) installs the
// pinned python-build-standalone into the kungfu-owned location, every env is
// created from that exact interpreter, and the kungfu wheel shipped in
// dist/kungfu/wheels is pre-installed so `import pykungfu` works out of the
// box. uv runs with UV_PYTHON_PREFERENCE=only-managed so a system python can
// never leak into an env.
//
// The trunk deliberately skips PATH probing for uv (unlike the dev
// launcher): the product uses exactly the pinned uv from the kungfu cache,
// not whatever uv the user happens to have. The cache directory is shared
// with the launcher, so dev machines pay the download once.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use shifu_core::bootstrap::{self, UV};
use shifu_core::host;

use crate::pins::Pins;

const ENV_META_FILE: &str = "kungfu-env.meta";

// ---------------------------------------------------------------- locations

/// The kungfu runtime home, resolved like the config contract's
/// `runtimeHomeEnv` / `defaultRuntimeHome` (framework/core/config/
/// kungfu-config.contract.json — the welded surface for these constants;
/// keep them in sync).
pub fn kf_home() -> PathBuf {
    if let Some(home) = env::var_os("KF_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home);
    }
    #[cfg(target_os = "macos")]
    {
        host::home_dir().join("Library/Application Support/kungfu/home")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| host::home_dir().join("AppData/Roaming"));
        appdata.join("kungfu").join("home")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        host::xdg_dir("XDG_CONFIG_HOME", ".config")
            .join("kungfu")
            .join("home")
    }
}

pub fn envs_root() -> PathBuf {
    kf_home().join("envs")
}

fn env_dir(name: &str) -> PathBuf {
    envs_root().join(name)
}

fn env_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("Scripts").join("python.exe")
    } else {
        dir.join("bin").join("python")
    }
}

/// dist/kungfu — the directory this binary ships in.
fn trunk_dir() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| format!("cannot locate own binary: {e}"))?;
    Ok(exe
        .parent()
        .ok_or("own binary has no parent directory")?
        .to_path_buf())
}

pub fn load_pins() -> Result<Pins, String> {
    // KUNGFU_RUNTIME_PINS lets dev/test runs point at a pins file without
    // staging a dist layout; the product always finds it next to the binary.
    let path = match env::var_os("KUNGFU_RUNTIME_PINS").filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => trunk_dir()?.join("runtime-pins.env"),
    };
    crate::pins::load(&path)
}

// ----------------------------------------------------------------------- uv

/// Acquire the pinned uv: kungfu cache first, checksum-verified download on
/// miss. Checksum precedence: KUNGFU_UV_SHA256 env (operator escape hatch,
/// resolved inside fetch_spec) > runtime-pins manifest > named error — the
/// product never downloads its toolchain unverified.
fn ensure_uv(pins: &Pins) -> Result<PathBuf, String> {
    let mut spec = UV.fetch_spec(&pins.uv_version).map_err(|e| e.to_string())?;
    if spec.sha256.is_none() {
        spec.sha256 = pins.uv_sha256.clone();
    }
    if spec.sha256.is_none() {
        let key = format!(
            "UV_SHA256_{}_{}",
            env::consts::OS.to_uppercase(),
            env::consts::ARCH.to_uppercase()
        );
        return Err(format!(
            "runtime pins carry no uv checksum for {}/{} (key {key}); refusing an unverified \
             toolchain download — update runtime-pins.env or set KUNGFU_UV_SHA256",
            env::consts::OS,
            env::consts::ARCH,
        ));
    }
    if !spec.cached_binary().is_file() {
        eprintln!(
            "kungfu: fetching pinned uv {} into {}",
            spec.version,
            spec.cached_binary()
                .parent()
                .expect("cached binary has a parent dir")
                .display()
        );
    }
    bootstrap::fetch(&spec).map_err(|e| e.to_string())
}

/// Every uv invocation runs pinned and managed-only: the interpreter store is
/// kungfu-owned and a system python is never eligible.
fn uv_command(uv: &Path) -> Command {
    let mut cmd = Command::new(uv);
    cmd.env(
        "UV_PYTHON_INSTALL_DIR",
        host::kungfu_cache_dir().join("python"),
    )
    .env("UV_PYTHON_PREFERENCE", "only-managed");
    cmd
}

fn run_uv(uv: &Path, args: &[&str], context: &str) -> Result<(), String> {
    let status = uv_command(uv)
        .args(args)
        .status()
        .map_err(|e| format!("failed to run uv: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{context} failed (uv {} exited {})",
            args.join(" "),
            status.code().unwrap_or(-1)
        ))
    }
}

/// The full python-build-standalone key for the pinned version on this host,
/// e.g. `cpython-3.13.14-macos-aarch64-none`. The arch qualification is
/// load-bearing: a bare version lets uv satisfy the request with a
/// wrong-arch interpreter already sitting in the shared store (runnable via
/// Rosetta on macOS), and every wheel install then fails on platform tags.
/// The trailing segment is the key's libc field: none on macOS/Windows,
/// gnu on Linux (the product targets glibc) — a `-none` request simply does
/// not exist for linux and uv refuses it by name.
fn python_request(pins: &Pins) -> String {
    let libc = if cfg!(target_os = "linux") {
        "gnu"
    } else {
        "none"
    };
    format!(
        "cpython-{}-{}-{}-{}",
        pins.python_pin,
        env::consts::OS,
        env::consts::ARCH,
        libc
    )
}

/// Install the pinned satellite CPython into the kungfu-owned store.
/// Idempotent: uv reuses an already-installed pinned interpreter.
fn ensure_python(uv: &Path, pins: &Pins) -> Result<(), String> {
    run_uv(
        uv,
        &["python", "install", &python_request(pins)],
        "installing the pinned satellite CPython",
    )
}

// ------------------------------------------------------------------ actions

pub fn prewarm() -> Result<(), String> {
    let pins = load_pins()?;
    let uv = ensure_uv(&pins)?;
    ensure_python(&uv, &pins)?;
    println!(
        "kungfu: toolchain cache warm (uv {} + cpython {})",
        pins.uv_version, pins.python_pin
    );
    Ok(())
}

pub fn create(name: &str) -> Result<(), String> {
    let pins = load_pins()?;
    let uv = ensure_uv(&pins)?;
    ensure_python(&uv, &pins)?;

    let dir = env_dir(name);
    if dir.exists() {
        return Err(format!(
            "env '{name}' already exists at {} (delete it first, or pick another name)",
            dir.display()
        ));
    }
    fs::create_dir_all(envs_root()).map_err(|e| format!("cannot create envs root: {e}"))?;
    run_uv(
        uv.as_path(),
        &[
            "venv",
            dir.to_str().ok_or("env path is not valid unicode")?,
            "--python",
            &python_request(&pins),
        ],
        "creating the env",
    )?;

    // Pre-install the kungfu wheel(s) shipped with the product so the env
    // speaks pykungfu from birth. A dev/test layout without wheels still
    // yields a usable bare env — named as such, not silently.
    let wheels = shipped_wheels()?;
    if wheels.is_empty() {
        eprintln!(
            "kungfu: no wheels shipped next to the trunk (dev layout?); \
             created a bare env without the kungfu package"
        );
    } else {
        let python = env_python(&dir);
        let mut args = vec!["pip", "install", "--python"];
        args.push(
            python
                .to_str()
                .ok_or("env python path is not valid unicode")?,
        );
        let wheel_strs: Vec<&str> = wheels.iter().filter_map(|w| w.to_str()).collect();
        args.extend(wheel_strs.iter());
        run_uv(uv.as_path(), &args, "installing the kungfu wheel")?;
    }

    write_meta(&dir, &pins)?;
    println!("kungfu: env '{name}' ready at {}", dir.display());
    Ok(())
}

fn shipped_wheels() -> Result<Vec<PathBuf>, String> {
    let dir = trunk_dir()?.join("wheels");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut wheels: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "whl"))
        .collect();
    wheels.sort();
    Ok(wheels)
}

fn write_meta(dir: &Path, pins: &Pins) -> Result<(), String> {
    let meta = format!(
        "PYTHON_PIN={}\nUV_VERSION={}\nTRUNK_VERSION={}\n",
        pins.python_pin,
        pins.uv_version,
        env!("CARGO_PKG_VERSION"),
    );
    fs::write(dir.join(ENV_META_FILE), meta).map_err(|e| format!("cannot write env metadata: {e}"))
}

fn require_env(name: &str) -> Result<PathBuf, String> {
    let dir = env_dir(name);
    if !env_python(&dir).is_file() {
        return Err(format!(
            "env '{name}' does not exist under {} (create it: kungfu env create {name})",
            envs_root().display()
        ));
    }
    Ok(dir)
}

pub fn add(name: &str, packages: &[String]) -> Result<(), String> {
    pip(name, "install", packages, "installing packages")
}

pub fn remove(name: &str, packages: &[String]) -> Result<(), String> {
    pip(name, "uninstall", packages, "removing packages")
}

fn pip(name: &str, verb: &str, packages: &[String], context: &str) -> Result<(), String> {
    if packages.is_empty() {
        return Err("no packages given".to_string());
    }
    let dir = require_env(name)?;
    let pins = load_pins()?;
    let uv = ensure_uv(&pins)?;
    let python = env_python(&dir);
    let mut args = vec!["pip", verb, "--python"];
    args.push(
        python
            .to_str()
            .ok_or("env python path is not valid unicode")?,
    );
    let pkg_refs: Vec<&str> = packages.iter().map(String::as_str).collect();
    args.extend(pkg_refs.iter());
    run_uv(uv.as_path(), &args, context)
}

pub fn list() -> Result<(), String> {
    let root = envs_root();
    if !root.is_dir() {
        println!("no envs yet (kungfu env create <name>)");
        return Ok(());
    }
    let mut names: Vec<String> = fs::read_dir(&root)
        .map_err(|e| format!("cannot read {}: {e}", root.display()))?
        .flatten()
        .filter(|e| env_python(&e.path()).is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    if names.is_empty() {
        println!("no envs yet (kungfu env create <name>)");
        return Ok(());
    }
    for name in names {
        println!("{name}\t{}", root.join(&name).display());
    }
    Ok(())
}

pub fn info(name: &str) -> Result<(), String> {
    let dir = require_env(name)?;
    println!("env:    {name}");
    println!("path:   {}", dir.display());
    println!("python: {}", env_python(&dir).display());
    if let Ok(meta) = fs::read_to_string(dir.join(ENV_META_FILE)) {
        for line in meta.lines().filter(|l| !l.trim().is_empty()) {
            println!("pin:    {line}");
        }
    }
    Ok(())
}

pub fn delete(name: &str) -> Result<(), String> {
    let dir = require_env(name)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("cannot delete {}: {e}", dir.display()))?;
    println!("kungfu: env '{name}' deleted");
    Ok(())
}

/// Run a command inside the env: VIRTUAL_ENV set, env bin dir first on PATH.
/// Replaces the process on Unix; runs and exits with the status on Windows.
pub fn run(name: &str, command: &[String]) -> Result<(), String> {
    let dir = require_env(name)?;
    let (program, rest) = match command.split_first() {
        Some((p, r)) => (p.clone(), r.to_vec()),
        // Bare `kungfu env run` drops into the env's python.
        None => (
            env_python(&dir)
                .to_str()
                .ok_or("env python path is not valid unicode")?
                .to_string(),
            Vec::new(),
        ),
    };
    let bin_dir = if cfg!(windows) {
        dir.join("Scripts")
    } else {
        dir.join("bin")
    };
    let mut paths = vec![bin_dir];
    if let Some(current) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current));
    }
    let joined = env::join_paths(paths).map_err(|e| format!("cannot build PATH: {e}"))?;

    let mut cmd = Command::new(&program);
    cmd.args(&rest).env("VIRTUAL_ENV", &dir).env("PATH", joined);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        Err(format!("failed to exec {program}: {err}"))
    }
    #[cfg(windows)]
    {
        let status = cmd
            .status()
            .map_err(|e| format!("failed to run {program}: {e}"))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}
