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
// the no-bytecode boundary because product callers may invoke it without the
// outer desktop CLI wrapper.

use crate::variant;
use std::env;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command;

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

    let mut command = Command::new(&exe);
    command
        .arg(&entry)
        .args(args)
        .env("KUNGFU_AS_VARIANT", "node")
        .env("KUNGFU_NODE_VARIANT_ENTRY", &entry)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("KUNGFU_DIR", runtime)
        .env(
            "KUNGFU_KFX_CONTRACT",
            runtime.join("config").join("kungfu-kfx.contract.json"),
        );
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
             runs next to the tree the product ships (dev: use `python -m \
             kungfu` on the managed interpreter, or kungfu-trunk for env \
             commands)",
            python.display()
        ));
    }
    Ok(python)
}

fn product_python_command(python: &Path, args: &[String]) -> Command {
    let mut command = Command::new(python);
    command
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .arg("-B")
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
    let mut command = product_python_command(&python, args);
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
    use std::ffi::OsStr;

    #[test]
    fn product_python_dispatch_disables_signed_tree_bytecode_writes() {
        let args = vec!["dogfood".to_string(), "doctor".to_string()];
        let command = product_python_command(Path::new("/product/python3"), &args);

        assert_eq!(command.get_program(), OsStr::new("/product/python3"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["-B", "-m", "kungfu", "dogfood", "doctor"].map(OsStr::new)
        );
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == OsStr::new("PYTHONDONTWRITEBYTECODE"))
                .and_then(|(_, value)| value),
            Some(OsStr::new("1"))
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
}
