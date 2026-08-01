// SPDX-License-Identifier: Apache-2.0
//
// Process-control helpers owned by the binary: exiting and spawning are the
// process owner's business, so they stay here while the host-probing helpers
// (paths, PATH resolution, temp dirs) live in shifu-core and are re-exported
// for the call sites' convenience.

use std::path::Path;
use std::process::{Command, Stdio};

pub use shifu_core::host::{find_on_path, kungfu_cache_dir, unique_temp_dir, xdg_dir};

pub fn standard_companion_globs(platform: &str) -> (String, String) {
    let archive_platform = match platform {
        "macos" => "darwin",
        other => other,
    };
    let manifest_platform = match platform {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let archive = if platform == "windows" {
        "zip"
    } else {
        "tar.gz"
    };
    (
        format!("product/release/cli/*cli-{archive_platform}-*.{archive}"),
        format!("product/release/cli/*upgrade-*-{manifest_platform}-*.json"),
    )
}

pub fn registration_policy_is_coherent(trust_domain: &str, publication_eligible: bool) -> bool {
    matches!(
        (trust_domain, publication_eligible),
        ("shifu-local", false) | ("public", true)
    )
}

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

#[cfg(test)]
mod tests {
    use super::{registration_policy_is_coherent, standard_companion_globs};

    #[test]
    fn standard_companions_preserve_platform_names() {
        assert_eq!(
            standard_companion_globs("windows"),
            (
                "product/release/cli/*cli-windows-*.zip".to_string(),
                "product/release/cli/*upgrade-*-win32-*.json".to_string(),
            )
        );
        assert_eq!(
            standard_companion_globs("macos"),
            (
                "product/release/cli/*cli-darwin-*.tar.gz".to_string(),
                "product/release/cli/*upgrade-*-darwin-*.json".to_string(),
            )
        );
        assert_eq!(
            standard_companion_globs("linux"),
            (
                "product/release/cli/*cli-linux-*.tar.gz".to_string(),
                "product/release/cli/*upgrade-*-linux-*.json".to_string(),
            )
        );
    }

    #[test]
    fn registration_policy_requires_a_coherent_trust_domain() {
        assert!(registration_policy_is_coherent("shifu-local", false));
        assert!(registration_policy_is_coherent("public", true));
        assert!(!registration_policy_is_coherent("public", false));
        assert!(!registration_policy_is_coherent("shifu-local", true));
        assert!(!registration_policy_is_coherent("unknown", false));
    }
}
