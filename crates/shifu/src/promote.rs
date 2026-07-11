// SPDX-License-Identifier: Apache-2.0
//
// `shifu promote` / `shifu builds` — use the freshest built dev kungfu from
// any terminal.
//
// Builds happen in worktrees, and worktrees are temporary: the product
// pipeline therefore stashes each successful desktop build user-globally
// (product/scripts/register-build.mjs), and these verbs consume that stash —
// the directory IS the registry:
//
//   ${XDG_CACHE_HOME:-~/.cache}/kungfu/product/<os>-<arch>/<utc-ts>-<sha>/
//     meta.env      KEY='VALUE' lines (build-local.env shape)
//     <artifact>    unpacked .app (mac) / nsis installer (win) / AppImage
//
// The newest build is the lexicographically greatest slot. `builds` lists
// the stash; `promote` installs the newest entry — the shifu-jurisdiction
// sibling of `clone`: clone acquires the repository, promote acquires the
// product. Configuration rides the existing build-local.env surface:
// KUNGFU_PRODUCT_INSTALL_DIR (install target) and, on the producer side,
// KUNGFU_PRODUCT_BUILDS_KEEP (stash retention).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use shifu_core::{host, style};

use crate::{envfile, util};

struct BuildEntry {
    slot: PathBuf,
    name: String,
    sha: String,
    branch: String,
    worktree: String,
    built_at: String,
    kind: String,
    artifact: String,
}

fn registry_dir() -> PathBuf {
    host::kungfu_cache_dir()
        .join("product")
        .join(host::os_arch())
}

fn read_meta(slot: &Path) -> Option<Vec<(String, String)>> {
    let text = fs::read_to_string(slot.join("meta.env")).ok()?;
    Some(
        text.lines()
            .filter_map(envfile::parse_line)
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

fn meta_get(meta: &[(String, String)], key: &str) -> String {
    meta.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// All stashed builds, newest first.
fn entries() -> Vec<BuildEntry> {
    let dir = registry_dir();
    let Ok(read) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| !name.contains(".tmp-"))
        .collect();
    names.sort();
    names.reverse();
    names
        .into_iter()
        .filter_map(|name| {
            let slot = dir.join(&name);
            let meta = read_meta(&slot)?;
            let artifact = meta_get(&meta, "KUNGFU_BUILD_ARTIFACT");
            if artifact.is_empty() || !slot.join(&artifact).exists() {
                return None;
            }
            Some(BuildEntry {
                sha: meta_get(&meta, "KUNGFU_BUILD_SHA"),
                branch: meta_get(&meta, "KUNGFU_BUILD_BRANCH"),
                worktree: meta_get(&meta, "KUNGFU_BUILD_WORKTREE"),
                built_at: meta_get(&meta, "KUNGFU_BUILD_TIME"),
                kind: meta_get(&meta, "KUNGFU_BUILD_KIND"),
                artifact,
                slot,
                name,
            })
        })
        .collect()
}

fn no_builds_hint() -> ! {
    util::die(&format!(
        "no registered dev builds for {} — run a product build first (./shifu dist, \
         or ./shifu package for the unpacked app); builds register themselves on success",
        host::os_arch()
    ));
}

pub fn run_builds() -> ! {
    let entries = entries();
    if entries.is_empty() {
        no_builds_hint();
    }
    println!(
        "{}",
        style::cyan(&format!(
            "Registered dev builds ({}, newest first):",
            host::os_arch()
        ))
    );
    for (index, entry) in entries.iter().enumerate() {
        let worktree_note = if Path::new(&entry.worktree).is_dir() {
            entry.worktree.clone()
        } else {
            format!("{} (worktree cleaned; stash still usable)", entry.worktree)
        };
        println!(
            "  {} {} {} @ {}",
            style::bold(&format!("[{index}]")),
            entry.built_at,
            style::bold(&entry.sha),
            entry.branch,
        );
        println!(
            "      {}",
            style::dim(&format!("{} - from {}", entry.artifact, worktree_note))
        );
    }
    println!(
        "\n{} shifu promote [--launch] installs [0]",
        style::cyan("Next:")
    );
    std::process::exit(0)
}

pub fn run_promote(args: &[String]) -> ! {
    let mut launch = false;
    let mut force = false;
    for arg in args {
        match arg.as_str() {
            "--launch" => launch = true,
            "--force" => force = true,
            _ => util::die("usage: shifu promote [--launch] [--force]"),
        }
    }

    let entries = entries();
    let Some(entry) = entries.first() else {
        no_builds_hint();
    };
    eprintln!(
        "\u{1f94b} {}",
        style::bold(&format!(
            "promoting dev build {} ({} @ {})",
            entry.name, entry.sha, entry.branch
        ))
    );

    let installed = match entry.kind.as_str() {
        "app" => promote_app(entry, force),
        "installer" => promote_installer(entry),
        "appimage" => promote_appimage(entry),
        other => util::die(&format!("unknown artifact kind in stash: {other}")),
    };

    eprintln!(
        "\u{2705} {} {}",
        style::green("promoted"),
        style::bold(&installed.display().to_string())
    );
    if launch {
        launch_product(&installed);
    }
    std::process::exit(0)
}

/// Install target: KUNGFU_PRODUCT_INSTALL_DIR > platform default (falling
/// back to a per-user location when the default is not writable).
fn install_dir(default: PathBuf, user_fallback: PathBuf) -> PathBuf {
    if let Ok(configured) = env::var("KUNGFU_PRODUCT_INSTALL_DIR") {
        let configured = configured.trim();
        if !configured.is_empty() {
            return PathBuf::from(configured);
        }
    }
    if dir_writable(&default) {
        return default;
    }
    user_fallback
}

fn dir_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".shifu-probe-{}", std::process::id()));
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// macOS: copy the stashed .app over the installed one (rename dance — the
/// old app is only removed after the new copy fully landed next to it).
fn promote_app(entry: &BuildEntry, force: bool) -> PathBuf {
    let target_dir = install_dir(
        PathBuf::from("/Applications"),
        host::home_dir().join("Applications"),
    );
    if let Err(e) = fs::create_dir_all(&target_dir) {
        util::die(&format!("cannot create {}: {e}", target_dir.display()));
    }
    let target = target_dir.join(&entry.artifact);

    if product_running(&entry.artifact) {
        if force {
            eprintln!(
                "   {}",
                style::yellow("app is running; replacing anyway (--force)")
            );
        } else {
            util::die(&format!(
                "{} is running — quit it first, or pass --force to replace it anyway",
                entry.artifact
            ));
        }
    }

    let staged = target_dir.join(format!(".{}.new-{}", entry.artifact, std::process::id()));
    let _ = fs::remove_dir_all(&staged);
    let status = Command::new("ditto")
        .arg(entry.slot.join(&entry.artifact))
        .arg(&staged)
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => util::die(&format!("ditto failed (exit {:?})", s.code())),
        Err(e) => util::die(&format!("failed to run ditto: {e}")),
    }
    if target.exists() {
        if let Err(e) = fs::remove_dir_all(&target) {
            let _ = fs::remove_dir_all(&staged);
            util::die(&format!(
                "cannot remove the previous {}: {e}",
                target.display()
            ));
        }
    }
    if let Err(e) = fs::rename(&staged, &target) {
        util::die(&format!("cannot place {}: {e}", target.display()));
    }
    target
}

/// Is the product app currently running? (macOS: match the executable path
/// inside the bundle, the stable signal across renames of the process name.)
fn product_running(app_name: &str) -> bool {
    let pattern = format!("{app_name}/Contents/MacOS/");
    Command::new("pgrep")
        .args(["-f", &pattern])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Windows: the stashed artifact is the self-contained nsis installer; run it
/// silently.
fn promote_installer(entry: &BuildEntry) -> PathBuf {
    let installer = entry.slot.join(&entry.artifact);
    eprintln!(
        "   {}",
        style::dim("running the nsis installer silently (/S)")
    );
    let status = Command::new(&installer).arg("/S").status();
    match status {
        Ok(s) if s.success() => installer,
        Ok(s) => util::die(&format!("installer failed (exit {:?})", s.code())),
        Err(e) => util::die(&format!("failed to run the installer: {e}")),
    }
}

/// Linux: place the AppImage on the user's PATH under a stable name.
fn promote_appimage(entry: &BuildEntry) -> PathBuf {
    let target_dir = install_dir(
        host::home_dir().join(".local").join("bin"),
        host::home_dir().join(".local").join("bin"),
    );
    if let Err(e) = fs::create_dir_all(&target_dir) {
        util::die(&format!("cannot create {}: {e}", target_dir.display()));
    }
    let target = target_dir.join("kungfu-dev.AppImage");
    if let Err(e) = fs::copy(entry.slot.join(&entry.artifact), &target) {
        util::die(&format!("cannot place {}: {e}", target.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
    }
    target
}

#[cfg(windows)]
fn launch_product(installed: &Path) {
    // The stashed artifact is the installer, not the installed app; launching
    // it again would rerun the install.
    let _ = installed;
    eprintln!(
        "   {}",
        style::dim("installed - launch Kungfu from the Start Menu")
    );
}

#[cfg(not(windows))]
fn launch_product(installed: &Path) {
    #[cfg(target_os = "macos")]
    let launched = Command::new("open").arg(installed).status().map(|_| ());
    #[cfg(not(target_os = "macos"))]
    // Detached on purpose: promote returns, the product keeps running.
    let launched = Command::new(installed).spawn().map(|_| ());
    match launched {
        Ok(()) => eprintln!("   {}", style::dim("launched")),
        Err(e) => eprintln!(
            "   {}",
            style::yellow(&format!("promoted, but launching failed: {e}"))
        ),
    }
}
