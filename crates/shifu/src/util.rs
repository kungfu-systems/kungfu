// SPDX-License-Identifier: Apache-2.0
//
// Launcher-specific helpers: prefixed exit, quiet process running, exec.
// Path/probe helpers come from the shared bootstrap crate and are re-exported
// so call sites keep reading `util::...`.

use std::path::Path;
use std::process::{Command, Stdio};

pub use bootstrap::paths::{find_on_path, kungfu_cache_dir, unique_temp_dir, xdg_dir};

pub fn die(msg: &str) -> ! {
    eprintln!("shifu: {msg}");
    std::process::exit(1);
}

pub fn die_code(msg: &str, code: i32) -> ! {
    eprintln!("shifu: {msg}");
    std::process::exit(code);
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
