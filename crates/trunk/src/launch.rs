// SPDX-License-Identifier: Apache-2.0
//
// The launch leg (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2): installed as `kungfu` next to the
// assembled runtime tree, this binary is the product front door. It stays
// argv-transparent — beyond recognizing the subtrees the trunk itself
// implements (env, prewarm), it interprets nothing and execs the assembled
// interpreter on `-m kungfu`, so the domain CLI remains the single source of
// truth for its own surface. The assembled interpreter is a real
// sys.executable; no PYTHON* staging is needed (the tree carries its own
// kungfu-host.json marker and site-packages wiring).

use std::env;
use std::path::PathBuf;
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

/// Exec the assembled interpreter on `-m kungfu` with the caller's arguments,
/// verbatim. Unix replaces the process; Windows waits and mirrors the exit
/// code (no exec semantics there).
pub fn launch(args: &[String]) -> Result<(), String> {
    let python = tree_python()?;
    let mut command = Command::new(&python);
    command.arg("-m").arg("kungfu").args(args);
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
