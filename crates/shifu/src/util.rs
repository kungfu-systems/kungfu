// SPDX-License-Identifier: Apache-2.0
//
// Small shared helpers: home/cache paths, PATH probing, process running, exit.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub fn die(msg: &str) -> ! {
    eprintln!("shifu: {msg}");
    std::process::exit(1);
}

pub fn die_code(msg: &str, code: i32) -> ! {
    eprintln!("shifu: {msg}");
    std::process::exit(code);
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

/// Run a command quietly (used for idempotent steps such as `fnm install`);
/// returns whether it succeeded but never fails the launcher.
pub fn run_quiet(program: &Path, args: &[&str], cwd: &Path) -> bool {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Replace the current process with `cmd` on Unix; on Windows run it and exit
/// with its status (Windows has no exec).
pub fn exec_or_exit(mut cmd: Command) -> ! {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = cmd.exec();
        die(&format!("failed to exec {:?}: {err}", cmd.get_program()));
    }
    #[cfg(windows)]
    {
        match cmd.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(err) => die(&format!("failed to run {:?}: {err}", cmd.get_program())),
        }
    }
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
