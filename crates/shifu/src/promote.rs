// SPDX-License-Identifier: Apache-2.0
//
// `shifu promote` / `shifu builds` — inspect and install provenance-qualified
// dev Kungfu artifacts from any terminal.
//
// Builds happen in worktrees, and worktrees are temporary: the launcher
// therefore stashes each successful build user-globally as declared by the
// repo's KFD-3 registry (crates/shifu/src/registrar.rs), and these verbs
// consume that stash — the directory IS the registry:
//
//   ${XDG_CACHE_HOME:-~/.cache}/kungfu/product/<os>-<arch>/<utc-ts>-<sha>/
//     meta.env      KEY='VALUE' lines (build-local.env shape)
//     <artifact>    unpacked .app (mac) / nsis installer (win) / AppImage
//
// Slot timestamps are display provenance, never version authority. `builds`
// classifies every entry against the installed receipt; `promote` advances
// only to one unique Git descendant and retires proven ancestors afterward.
// Divergent/unknown entries remain manual-only. Configuration rides the
// existing KUNGFU_PRODUCT_INSTALL_DIR surface.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use shifu_core::{host, style};

use crate::artifact_catalog::{
    automatic, compact_branch, git_relation, json_escape, select_unique_automatic, short_sha,
    state_for, write_promotion_receipt, GitRelation, SelectionError,
};
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
    digest: String,
}

#[derive(Default)]
struct ListOptions {
    verbose: bool,
    json: bool,
    no_truncate: bool,
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
                digest: meta_get(&meta, "KUNGFU_BUILD_SHA256"),
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

fn installed_receipt_path() -> PathBuf {
    registry_dir().join("installed.meta.env")
}

fn installed_sha() -> String {
    let Ok(text) = fs::read_to_string(installed_receipt_path()) else {
        return String::new();
    };
    text.lines()
        .filter_map(envfile::parse_line)
        .find(|(key, _)| *key == "KUNGFU_INSTALLED_SHA")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn build_relation(entry: &BuildEntry, installed: &str, entry_count: usize) -> GitRelation {
    if installed.is_empty() {
        return if entry_count == 1 {
            GitRelation::Descendant
        } else {
            GitRelation::Unknown
        };
    }
    let worktree = Path::new(&entry.worktree);
    if !worktree.is_dir() {
        return GitRelation::Unknown;
    }
    git_relation(worktree, installed, &entry.sha)
}

fn build_valid(entry: &BuildEntry) -> bool {
    !entry.sha.is_empty()
        && entry.sha != "unknown"
        && matches!(entry.kind.as_str(), "app" | "installer" | "appimage")
        && entry.slot.join(&entry.artifact).exists()
}

fn schema_kind(entry: &BuildEntry) -> &str {
    if matches!(entry.kind.as_str(), "app" | "installer" | "appimage") {
        &entry.kind
    } else {
        "unknown"
    }
}

fn select_product_build<'a>(
    entries: &'a [BuildEntry],
    installed: &str,
    selected: Option<&str>,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    if let Some(id) = selected {
        let matches: Vec<_> = entries
            .iter()
            .filter(|entry| entry.name == id || entry.name.starts_with(id))
            .collect();
        if matches.len() != 1 {
            util::die(&format!(
                "--build {id} matched {} builds; use the exact id from shifu builds",
                matches.len()
            ));
        }
        let entry = matches[0];
        if !build_valid(entry) {
            util::die(&format!(
                "build {} is invalid and cannot be promoted even with an override",
                entry.name
            ));
        }
        let relation = build_relation(entry, installed, entries.len());
        if !automatic(relation, build_valid(entry), false) && !allow_nonlinear {
            util::die(&format!(
                "build {} is {} and is manual-only; after review pass \
                 --build {} --allow-nonlinear",
                entry.name,
                relation.as_str(),
                entry.name
            ));
        }
        return entry;
    }
    let dispositions: Vec<_> = entries
        .iter()
        .map(|entry| {
            (
                build_relation(entry, installed, entries.len()),
                build_valid(entry),
                false,
            )
        })
        .collect();
    match select_unique_automatic(&dispositions) {
        Ok(index) => &entries[index],
        Err(SelectionError::None) => util::die(
            "no automatic product candidate: builds are older, divergent, or have unknown \
             provenance; inspect shifu builds and select --build <id> --allow-nonlinear",
        ),
        Err(SelectionError::Ambiguous) => util::die(
            "multiple automatic product candidates remain; inspect shifu builds and select \
             one explicitly with --build <id>",
        ),
    }
}

fn print_builds_json(entries: &[BuildEntry]) {
    let installed = installed_sha();
    println!("{{");
    println!("  \"schema\": \"shifu.local-artifact-catalog/v1\",");
    println!("  \"product\": \"kungfu\",");
    println!("  \"platform\": \"{}\",", json_escape(&host::os_arch()));
    println!("  \"artifacts\": [");
    let rows: Vec<_> = entries
        .iter()
        .map(|entry| {
            let relation = build_relation(entry, &installed, entries.len());
            let valid = build_valid(entry);
            let state = state_for(relation, valid, false);
            format!(
                "    {{\"id\":\"{}\",\"kind\":\"{}\",\"version\":\"\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"{}\",\"builtAt\":\"{}\",\"state\":\"{}\",\"relation\":\"{}\",\"automatic\":{},\"rollbackOnly\":false,\"dirty\":{},\"repoPath\":\"{}\",\"worktreePath\":\"{}\",\"buildPath\":\"{}\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"{}\"}}",
                json_escape(&entry.name),
                json_escape(schema_kind(entry)),
                json_escape(&entry.sha),
                json_escape(&entry.branch),
                json_escape(&entry.digest),
                json_escape(&entry.built_at),
                state.as_str(),
                relation.as_str(),
                automatic(relation, valid, false),
                entry.sha.ends_with("-dirty"),
                json_escape(&entry.worktree),
                json_escape(&entry.worktree),
                json_escape(&entry.worktree),
                json_escape(&entry.slot.join(&entry.artifact).display().to_string()),
                relation.as_str()
            )
        })
        .collect();
    println!("{}", rows.join(",\n"));
    println!("  ]");
    println!("}}");
}

fn write_installed_receipt(entry: &BuildEntry, installed: &Path) {
    let text = format!(
        "KUNGFU_ARTIFACT_SCHEMA='shifu.local-artifact/v1'\n\
         KUNGFU_INSTALLED_SHA='{}'\n\
         KUNGFU_INSTALLED_BRANCH='{}'\n\
         KUNGFU_INSTALLED_BUILD_ID='{}'\n\
         KUNGFU_INSTALLED_WORKTREE='{}'\n\
         KUNGFU_INSTALLED_ARTIFACT='{}'\n",
        entry.sha,
        entry.branch.replace('\'', ""),
        entry.name,
        entry.worktree.replace('\'', ""),
        installed.display()
    );
    let path = installed_receipt_path();
    let staged = path.with_extension("tmp");
    if fs::write(&staged, text).is_ok() {
        if let Err(error) = fs::rename(&staged, &path) {
            let _ = fs::remove_file(&staged);
            eprintln!(
                "   {}",
                style::yellow(&format!("could not write promotion receipt: {error}"))
            );
        }
    }
}

/// A successful promotion is the only point where ancestry authorizes
/// retirement. Divergent and unknown builds remain visible and manual-only.
fn retire_superseded(promoted: &BuildEntry, entries: &[BuildEntry]) {
    let repo = Path::new(&promoted.worktree);
    if !repo.is_dir() {
        return;
    }
    for entry in entries {
        if entry.name == promoted.name {
            continue;
        }
        if git_relation(repo, &promoted.sha, &entry.sha) == GitRelation::Ancestor {
            if let Err(error) = fs::remove_dir_all(&entry.slot) {
                eprintln!(
                    "   {}",
                    style::yellow(&format!(
                        "could not retire superseded build {}: {error}",
                        entry.name
                    ))
                );
            }
        }
    }
}

pub fn run_builds(args: &[String]) -> ! {
    let mut options = ListOptions::default();
    for arg in args {
        match arg.as_str() {
            "--verbose" => options.verbose = true,
            "--json" => options.json = true,
            "--no-truncate" => options.no_truncate = true,
            _ => util::die("usage: shifu builds [--verbose] [--json] [--no-truncate]"),
        }
    }
    let entries = entries();
    if entries.is_empty() {
        no_builds_hint();
    }
    if options.json {
        print_builds_json(&entries);
        std::process::exit(0);
    }
    let installed = installed_sha();
    println!(
        "{}",
        style::cyan(&format!(
            "Registered dev builds ({}, newest first):",
            host::os_arch()
        ))
    );
    for (index, entry) in entries.iter().enumerate() {
        let relation = build_relation(entry, &installed, entries.len());
        let state = state_for(relation, build_valid(entry), false);
        println!(
            "  {} {:10} {:9} {:34} {:10}",
            style::bold(&format!("[{index}]")),
            state.as_str(),
            short_sha(&entry.sha),
            compact_branch(&entry.branch, options.no_truncate),
            relation.as_str(),
        );
        if options.verbose {
            let worktree_state = if Path::new(&entry.worktree).is_dir() {
                ""
            } else {
                " (worktree cleaned; stash still usable)"
            };
            println!(
                "      id={} built={} kind={} digest={}\n      artifact={}\n      worktree={}{}",
                entry.name,
                entry.built_at,
                entry.kind,
                if entry.digest.is_empty() {
                    "unknown"
                } else {
                    &entry.digest
                },
                entry.slot.join(&entry.artifact).display(),
                entry.worktree,
                worktree_state
            );
        }
    }
    println!(
        "\n{} shifu promote installs the unique descendant; use --build <id> for manual selection",
        style::cyan("Next:")
    );
    std::process::exit(0)
}

pub fn run_promote(args: &[String]) -> ! {
    let mut launch = false;
    let mut force = false;
    let mut allow_nonlinear = false;
    let mut build_arg: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--launch" => launch = true,
            "--force" => force = true,
            "--allow-nonlinear" => allow_nonlinear = true,
            "--build" => match iter.next() {
                Some(value) => build_arg = Some(value.clone()),
                None => util::die(PROMOTE_USAGE),
            },
            _ => util::die(PROMOTE_USAGE),
        }
    }

    let entries = entries();
    if entries.is_empty() {
        no_builds_hint();
    }
    let installed = installed_sha();
    let entry = select_product_build(&entries, &installed, build_arg.as_deref(), allow_nonlinear);
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
    let previous_sha = installed_sha();
    let relation = build_relation(entry, &previous_sha, entries.len());
    write_installed_receipt(entry, &installed);
    if let Err(error) = write_promotion_receipt(
        &registry_dir(),
        "kungfu",
        "promote",
        &entry.name,
        &previous_sha,
        &entry.sha,
        relation,
    ) {
        eprintln!(
            "   {}",
            style::yellow(&format!("could not write promotion receipt: {error}"))
        );
    }
    retire_superseded(entry, &entries);
    if launch {
        launch_product(&installed);
    }
    std::process::exit(0)
}

const PROMOTE_USAGE: &str =
    "usage: shifu promote [--build <id> [--allow-nonlinear]] [--launch] [--force]";

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
