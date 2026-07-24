// SPDX-License-Identifier: Apache-2.0
//
// KFD-declared build registration — the declarative successor of the
// per-repo register-build script.
//
// A repo that wants its builds registered does not write a registration
// script; it declares the artifacts in its Buildchain-managed KFD-3 surface
// registry (.buildchain/kfd/kfd-3/surfaces.json):
//
//   "distribution": {
//     "registrar": "shifu",
//     "tasks": ["dist", "dist:dir", "package"],
//     "artifacts": [
//       {"kind": "app", "platform": "macos", "pathGlob": "product/dist/desktop/mac*/*.app"},
//       {"kind": "installer", "platform": "windows", "pathGlob": "product/dist/desktop/*.exe"},
//       {"kind": "appimage", "platform": "linux", "pathGlob": "product/dist/desktop/*.AppImage"}
//     ]
//   }
//
// When a task named in a declaration succeeds under shifu, the launcher reads
// the declaration back, resolves the artifact for the host platform, verifies
// it (a pinned sha256 must match; a computed one is recorded for provenance),
// and stashes it in the user-global build registry that `shifu builds` /
// `shifu promote` already consume — the directory IS the registry:
//
//   ${XDG_CACHE_HOME:-~/.cache}/kungfu/product/<os>-<arch>/<utc-ts>-<sha>[-dirty]/
//     meta.env      KEY='VALUE' lines (build-local.env shape)
//     <artifact>    the declared artifact, copied as built
//
// (Products other than kungfu itself get their own namespace one level down:
// product/<product-id>/<os>-<arch>/. The kungfu path stays where existing
// consumers already look.)
//
// Registration is advisory by design: a build that succeeded must not be
// failed by its own bookkeeping, so every failure here is a named warning and
// the task's exit code passes through untouched.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use shifu_core::{bootstrap, host, json, style};

/// The buildchain self-describe contract shifu asks for the repo's KFD-3
/// registry location. shifu holds no copy of that layout path: the layout is
/// buildchain's to define, so shifu asks the pinned `buildchain` binary
/// (`buildchain layout --json`) and reads `kfd.registries."kfd-3".path` back.
/// The two welded surfaces are the `.buildchain-version` pin name and this
/// verb; see docs/rust-adoption.md and the contract registry.
const LAYOUT_DISCOVERY_CONTRACT: &str = "kungfu-buildchain-layout-discovery";

/// Local, read-only hint used to decide whether a fresh checkout needs the
/// pinned Buildchain binary before a declared distribution task. Normally it
/// only authorizes discovery: Buildchain resolves the KFD-3 layout and that
/// answer is reparsed. The explicit Buildchain source-build boundary may use
/// the tracked hint directly because that qualification environment owns the
/// exact source checkout and intentionally has no released binary dependency.
const REGISTRY_DISCOVERY_HINT: &str = ".buildchain/kfd/kfd-3/surfaces.json";

const BUILDCHAIN_SOURCE_BUILD_ENV: &str = "KUNGFU_BUILDCHAIN_SOURCE_BUILD";

/// Locate the repo's KFD-3 surface registry by asking buildchain, caching the
/// answer per (repo, buildchain version). Returns the absolute registry path,
/// or None when the repo is not buildchain-managed (no `.buildchain-version`
/// pin) or buildchain is not already available on this advisory hot path.
///
/// There is deliberately no hardcoded fallback path: a repo with a KFD-3
/// registry is by definition buildchain-managed, so the single source of truth
/// is buildchain's own answer, never a shifu-side copy that could silently
/// drift when buildchain moves the layout.
fn resolve_kfd3_registry(root: &Path) -> Option<PathBuf> {
    // Registration is advisory, so path resolution must not add a network
    // fetch to ordinary dispatch: resolve only from an already-available
    // buildchain (PATH/cache), never a forced download.
    resolve_kfd3_registry_with(root, Acquire::CachedOnly)
}

/// How to obtain the buildchain binary when the layout answer is not yet
/// cached: the advisory dispatch hot path stays cache-only, while a deliberate
/// serve-downstream jurisdiction check may fetch the pinned release.
enum Acquire {
    CachedOnly,
    Fetch,
}

fn resolve_kfd3_registry_with(root: &Path, acquire: Acquire) -> Option<PathBuf> {
    // Not buildchain-managed → no registry (the common, silent case, same as a
    // repo without a registry today).
    if !root.join(bootstrap::BUILDCHAIN.pin_file()).is_file() {
        return None;
    }
    let version = bootstrap::BUILDCHAIN.version(root);
    if let Some(rel) = read_layout_cache(root, &version) {
        return Some(root.join(rel));
    }
    // The answer is cached, so the ask happens at most once per buildchain
    // version regardless of which acquisition strategy resolved it.
    let buildchain = match acquire {
        Acquire::CachedOnly => bootstrap::find_tool(&bootstrap::BUILDCHAIN, root)?,
        Acquire::Fetch => bootstrap::ensure_tool(&bootstrap::BUILDCHAIN, root).ok()?,
    };
    let rel = query_layout_registry(&buildchain, root)?;
    write_layout_cache(root, &version, &rel);
    Some(root.join(rel))
}

/// Whether this repo explicitly declares shifu as its KFD-3 distribution
/// registrar — the jurisdiction signal that makes a non-kungfu,
/// buildchain-managed repo one that shifu serves. A `.buildchain-version` pin
/// alone is not enough (a KFD file is not the same as opting into shifu), so a
/// stray buildchain repo cannot have its management silently claimed. Reads
/// the registry buildchain points to, fetching the pinned binary if needed
/// (this is the deliberate serve-downstream context, not the hot path).
pub fn declares_shifu_jurisdiction(root: &Path) -> bool {
    let Some(path) = resolve_kfd3_registry_with(root, Acquire::Fetch) else {
        return false;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return false;
    };
    match json::parse(&text) {
        Ok(doc) => registry_declares_shifu(&doc),
        Err(_) => false,
    }
}

/// Pure jurisdiction test over a parsed registry: any surface whose
/// distribution names shifu as registrar.
fn registry_declares_shifu(doc: &json::Json) -> bool {
    doc.get("surfaces")
        .and_then(json::Json::as_array)
        .unwrap_or(&[])
        .iter()
        .any(|surface| {
            surface
                .get("distribution")
                .map(|dist| dist.str_of("registrar") == "shifu")
                .unwrap_or(false)
        })
}

/// Ask `buildchain layout --json` where the KFD-3 registry lives. Returns the
/// repo-relative path, or None on any failure (advisory: never blocks).
fn query_layout_registry(buildchain: &Path, root: &Path) -> Option<String> {
    let out = Command::new(buildchain)
        .arg("layout")
        .arg("--json")
        .arg("--cwd")
        .arg(root)
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let doc = json::parse(&String::from_utf8_lossy(&out.stdout)).ok()?;
    let contract = doc.str_of("contract");
    if contract != LAYOUT_DISCOVERY_CONTRACT {
        warn(&format!(
            "buildchain layout returned contract {contract:?} (expected \
             {LAYOUT_DISCOVERY_CONTRACT}); builds will not be registered"
        ));
        return None;
    }
    let rel = doc
        .get("kfd")
        .and_then(|kfd| kfd.get("registries"))
        .and_then(|reg| reg.get("kfd-3"))
        .map(|k3| k3.str_of("path"))
        .unwrap_or("");
    (!rel.is_empty()).then(|| rel.to_string())
}

/// Cache file for a resolved layout answer, namespaced per buildchain version.
/// The file records the root and version it was resolved for so a hash
/// collision (or a moved checkout) reads as a miss, never a wrong path.
fn layout_cache_path(root: &Path, version: &str) -> PathBuf {
    let key = fnv1a_hex(root.to_string_lossy().as_bytes());
    host::kungfu_cache_dir()
        .join("shifu")
        .join("layout")
        .join(version)
        .join(format!("{key}.json"))
}

fn read_layout_cache(root: &Path, version: &str) -> Option<String> {
    let doc = json::parse(&fs::read_to_string(layout_cache_path(root, version)).ok()?).ok()?;
    if doc.str_of("root") != root.to_string_lossy() || doc.str_of("version") != version {
        return None;
    }
    let rel = doc.str_of("registryPath");
    (!rel.is_empty()).then(|| rel.to_string())
}

fn write_layout_cache(root: &Path, version: &str, rel: &str) {
    let path = layout_cache_path(root, version);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let body = format!(
        "{{\"root\":{},\"version\":{},\"registryPath\":{}}}\n",
        json_string(&root.to_string_lossy()),
        json_string(version),
        json_string(rel),
    );
    let _ = fs::write(path, body);
}

/// Minimal JSON string encoding for the cache file (paths can contain
/// backslashes and quotes on Windows).
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// FNV-1a 64-bit, hex — a fast, dependency-free cache-key hash. Not
/// cryptographic; the cache file's stored root/version make any collision a
/// harmless miss.
fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub struct DistributionPlan {
    product_id: String,
    surface_id: String,
    artifacts: Vec<DeclaredArtifact>,
}

struct DeclaredArtifact {
    kind: String,
    path_glob: String,
    /// Pinned content hash from the declaration; empty when the artifact's
    /// content is only known after the build (the dev-build case).
    sha256: String,
}

/// Read the repo's KFD-3 registry and return the registration plan for
/// `task`, if any surface declares one for the host platform. A repo without
/// a registry, or without a matching declaration, simply has no plan — that
/// is the common case and stays silent. A registry that exists but cannot be
/// parsed gets a named warning: a declared intent we cannot read is worth a
/// line, but never worth blocking the task.
pub fn plan_for_task(root: &Path, task: &str) -> Option<DistributionPlan> {
    if let Some(path) = resolve_kfd3_registry(root) {
        return plan_at(root, &path, task);
    }

    // A fresh runner has neither the per-repo layout cache nor a cached
    // Buildchain binary. Avoid fetching Buildchain for ordinary tasks: first
    // check the tracked registry hint for a host distribution declaration for
    // this exact task. A match normally only authorizes discovery; the named
    // source-build boundary below is the sole direct-hint exception.
    let hint_plan = plan_at(root, &root.join(REGISTRY_DISCOVERY_HINT), task)?;
    if source_registry_hint_allowed(env::var_os(BUILDCHAIN_SOURCE_BUILD_ENV).as_deref()) {
        warn(&format!(
            "{BUILDCHAIN_SOURCE_BUILD_ENV}=1; using the tracked KFD-3 registry hint for source-build registration"
        ));
        return Some(hint_plan);
    }
    let path = resolve_kfd3_registry_with(root, Acquire::Fetch)?;
    plan_at(root, &path, task)
}

fn source_registry_hint_allowed(value: Option<&std::ffi::OsStr>) -> bool {
    value == Some(std::ffi::OsStr::new("1"))
}

/// Parse a distribution plan from a specific registry path. Split from
/// `plan_for_task` so parsing is exercised without a live buildchain to answer
/// the layout query.
fn plan_at(root: &Path, path: &Path, task: &str) -> Option<DistributionPlan> {
    // The registry path relative to the repo, for messages and the
    // self-attestation check below.
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned();
    let text = fs::read_to_string(path).ok()?;
    let doc = match json::parse(&text) {
        Ok(doc) => doc,
        Err(e) => {
            warn(&format!(
                "cannot read {rel} ({e}); builds will not be registered"
            ));
            return None;
        }
    };
    // Self-attestation: the registry declares its own path; if buildchain
    // answered a different location the two have drifted — worth a named line
    // (never blocks: buildchain's answer is authoritative for where we read).
    let declared = doc.str_of("registryPath");
    if !declared.is_empty() && declared != rel {
        warn(&format!(
            "buildchain resolved the KFD-3 registry at {rel} but it self-declares \
             registryPath {declared}; the layout has drifted"
        ));
    }
    let product_id = {
        let id = doc.get("product").map(|p| p.str_of("id")).unwrap_or("");
        if id.is_empty() {
            warn(&format!(
                "{rel} has no product.id; builds will not be registered"
            ));
            return None;
        }
        id.to_string()
    };
    for surface in doc
        .get("surfaces")
        .and_then(json::Json::as_array)
        .unwrap_or(&[])
    {
        let Some(dist) = surface.get("distribution") else {
            continue;
        };
        if dist.str_of("registrar") != "shifu" {
            continue;
        }
        let tasks = dist
            .get("tasks")
            .and_then(json::Json::as_array)
            .unwrap_or(&[]);
        if !tasks.iter().any(|t| t.as_str() == Some(task)) {
            continue;
        }
        let artifacts: Vec<DeclaredArtifact> = dist
            .get("artifacts")
            .and_then(json::Json::as_array)
            .unwrap_or(&[])
            .iter()
            .filter(|a| a.str_of("platform") == env::consts::OS)
            .map(|a| DeclaredArtifact {
                kind: a.str_of("kind").to_string(),
                path_glob: a.str_of("pathGlob").to_string(),
                sha256: a.str_of("sha256").to_string(),
            })
            .filter(|a| !a.kind.is_empty() && !a.path_glob.is_empty())
            .collect();
        if artifacts.is_empty() {
            continue;
        }
        return Some(DistributionPlan {
            product_id,
            surface_id: surface.str_of("id").to_string(),
            artifacts,
        });
    }
    None
}

/// Stash the plan's artifacts in the user-global build registry. Advisory:
/// warns and returns on any failure, never exits.
pub fn register(root: &Path, plan: &DistributionPlan) {
    let mut resolved: Vec<(PathBuf, &DeclaredArtifact, String)> = Vec::new();
    for artifact in &plan.artifacts {
        let matches = glob_matches(root, &artifact.path_glob);
        let Some(path) = matches.first().cloned() else {
            warn(&format!(
                "declared artifact not found: {} (surface {})",
                artifact.path_glob, plan.surface_id
            ));
            continue;
        };
        if matches.len() > 1 {
            warn(&format!(
                "{} matched {} paths; registering {}",
                artifact.path_glob,
                matches.len(),
                path.display()
            ));
        }
        // Content hash: single-file artifacts are hashed (and must match a
        // pinned declaration); directory artifacts (the unpacked .app) carry
        // no whole-content hash — recording a fake one would be worse than
        // recording none.
        let mut sha256 = String::new();
        if path.is_file() {
            match bootstrap::sha256_file(&path) {
                Ok(actual) => {
                    let pinned = artifact.sha256.trim().to_lowercase();
                    if !pinned.is_empty() && pinned != actual {
                        warn(&format!(
                            "sha256 mismatch for {} (declared {pinned}, built {actual}); not registering it",
                            path.display()
                        ));
                        continue;
                    }
                    sha256 = actual;
                }
                Err(e) => warn(&format!("cannot hash {}: {e}", path.display())),
            }
        } else if !artifact.sha256.trim().is_empty() {
            warn(&format!(
                "declared sha256 on directory artifact {} cannot be verified; not registering it",
                path.display()
            ));
            continue;
        }
        resolved.push((path, artifact, sha256));
    }
    let Some((primary_path, primary, primary_sha)) = resolved.first() else {
        warn("no declared artifacts to register");
        return;
    };

    let sha = git(root, &["rev-parse", "HEAD"]);
    let sha = if sha.is_empty() {
        "unknown".to_string()
    } else {
        sha
    };
    let dirty = !git(root, &["status", "--porcelain", "--untracked-files=no"]).is_empty();
    let (build_sha, slot_fingerprint) = build_identifiers(&sha, dirty);
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let branch = if branch.is_empty() {
        "unknown".to_string()
    } else {
        branch
    };
    let mainline_ref = "origin/dev/v4/v4.0";
    let mainline_sha = git(root, &["rev-parse", mainline_ref]);
    let integrated = sha != "unknown"
        && !dirty
        && !mainline_sha.is_empty()
        && sha == mainline_sha
        && git_success(root, &["merge-base", "--is-ancestor", &sha, mainline_ref]);
    let repo = git(root, &["worktree", "list", "--porcelain"])
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(str::to_string)
        .unwrap_or_else(|| root.display().to_string());
    let (stamp, built_at) = utc_now();

    let registry = registry_dir(&plan.product_id);
    let slot = registry.join(format!("{stamp}-{slot_fingerprint}"));
    let staging = registry.join(format!(
        "{stamp}-{slot_fingerprint}.tmp-{}",
        std::process::id()
    ));
    if let Err(e) = fs::create_dir_all(&staging) {
        warn(&format!("cannot create {}: {e}", staging.display()));
        return;
    }
    for (path, _, _) in &resolved {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string());
        let Some(name) = name else { continue };
        if let Err(e) = copy_artifact(path, &staging.join(&name)) {
            warn(&format!("cannot copy {}: {e}", path.display()));
            let _ = fs::remove_dir_all(&staging);
            return;
        }
    }
    let primary_name = primary_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut meta = vec![
        format!("KUNGFU_BUILD_SHA={}", quote(&build_sha)),
        format!("KUNGFU_BUILD_BRANCH={}", quote(&branch)),
        format!("KUNGFU_BUILD_REPO={}", quote(&repo)),
        format!(
            "KUNGFU_BUILD_WORKTREE={}",
            quote(&root.display().to_string())
        ),
        format!("KUNGFU_BUILD_TIME={}", quote(&built_at)),
        format!("KUNGFU_BUILD_KIND={}", quote(&primary.kind)),
        format!("KUNGFU_BUILD_ARTIFACT={}", quote(&primary_name)),
        format!("KUNGFU_BUILD_SURFACE={}", quote(&plan.surface_id)),
        format!("KUNGFU_BUILD_MAINLINE_REF={}", quote(mainline_ref)),
        format!("KUNGFU_BUILD_MAINLINE_SHA={}", quote(&mainline_sha)),
        format!(
            "KUNGFU_BUILD_INTEGRATED={}",
            quote(if integrated { "true" } else { "false" })
        ),
        format!(
            "KUNGFU_BUILD_QUALIFIED={}",
            quote(if integrated { "true" } else { "false" })
        ),
    ];
    if !primary_sha.is_empty() {
        meta.push(format!("KUNGFU_BUILD_SHA256={}", quote(primary_sha)));
    }
    meta.push(String::new());
    if let Err(e) = fs::write(staging.join("meta.env"), meta.join("\n")) {
        warn(&format!("cannot write meta.env: {e}"));
        let _ = fs::remove_dir_all(&staging);
        return;
    }
    let _ = fs::remove_dir_all(&slot);
    if let Err(e) = fs::rename(&staging, &slot) {
        warn(&format!("cannot place {}: {e}", slot.display()));
        let _ = fs::remove_dir_all(&staging);
        return;
    }
    eprintln!(
        "\u{1f94b} {}",
        style::bold(&format!("registered build -> {}", slot.display()))
    );
}

/// The kungfu product keeps its historical registry path (existing `builds` /
/// `promote` consumers read it); every other product namespaces below it.
fn registry_dir(product_id: &str) -> PathBuf {
    let base = host::kungfu_cache_dir().join("product");
    let base = if product_id == "kungfu" {
        base
    } else {
        base.join(product_id)
    };
    base.join(host::os_arch())
}

fn warn(msg: &str) {
    eprintln!("   {}", style::yellow(&format!("shifu registrar: {msg}")));
}

fn git(root: &Path, args: &[&str]) -> String {
    // Bind provenance to the declared product root. Hooks and nested Git
    // callers may export repository-local variables that otherwise override
    // current_dir/-C and silently fingerprint the caller's repository.
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

fn git_success(root: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// meta.env values use the build-local.env single-quote shape; single quotes
/// cannot be escaped in it, so they are stripped (same rule as the historical
/// register script).
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', ""))
}

/// Keep registry directory names compact without truncating the provenance
/// identity consumed by `shifu promote`.
fn build_identifiers(sha: &str, dirty: bool) -> (String, String) {
    let short_sha = sha.get(..sha.len().min(9)).unwrap_or(sha);
    if dirty {
        (format!("{sha}-dirty"), format!("{short_sha}-dirty"))
    } else {
        (sha.to_string(), short_sha.to_string())
    }
}

/// Copy an artifact preserving what its platform requires: `ditto` on macOS
/// (symlinks, permissions, xattrs — a .app is not a plain tree), plain copy
/// for files, and a symlink-aware walk for directories elsewhere.
fn copy_artifact(source: &Path, target: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") && source.is_dir() {
        let status = Command::new("ditto")
            .arg(source)
            .arg(target)
            .status()
            .map_err(|e| format!("failed to run ditto: {e}"))?;
        return if status.success() {
            Ok(())
        } else {
            Err("ditto failed".to_string())
        };
    }
    if source.is_file() {
        fs::copy(source, target).map_err(|e| e.to_string())?;
        return Ok(());
    }
    copy_dir(source, target)
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())?.flatten() {
        let from = entry.path();
        let to = target.join(entry.file_name());
        let meta = fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            #[cfg(unix)]
            {
                let link = fs::read_link(&from).map_err(|e| e.to_string())?;
                std::os::unix::fs::symlink(link, &to).map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            {
                fs::copy(&from, &to).map_err(|e| e.to_string())?;
            }
        } else if meta.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Resolve a declaration path glob against the repo root. `*` matches within
/// one path segment (and skips dotfiles, shell-style); that is the whole
/// pattern language — declarations name build outputs, not search spaces.
fn glob_matches(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let mut current = vec![root.to_path_buf()];
    for segment in pattern.split('/').filter(|s| !s.is_empty()) {
        let mut next = Vec::new();
        if segment.contains('*') {
            for dir in &current {
                let Ok(read) = fs::read_dir(dir) else {
                    continue;
                };
                for entry in read.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with('.') && segment_matches(segment, &name) {
                        next.push(entry.path());
                    }
                }
            }
        } else {
            for dir in &current {
                let candidate = dir.join(segment);
                if candidate.exists() {
                    next.push(candidate);
                }
            }
        }
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current.sort();
    current
}

fn segment_matches(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == name;
    }
    let mut remainder = name;
    if !remainder.starts_with(parts[0]) {
        return false;
    }
    remainder = &remainder[parts[0].len()..];
    for part in &parts[1..parts.len() - 1] {
        if part.is_empty() {
            continue;
        }
        match remainder.find(part) {
            Some(index) => remainder = &remainder[index + part.len()..],
            None => return false,
        }
    }
    remainder.ends_with(parts[parts.len() - 1])
}

/// UTC now as (slot stamp, ISO time): `20260711T031500Z` /
/// `2026-07-11T03:15:00Z`. The stamp shape matches the historical slots so
/// lexicographic "newest" ordering spans the migration.
fn utc_now() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    let (hh, mm, ss) = ((secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    (
        format!("{year:04}{month:02}{day:02}T{hh:02}{mm:02}{ss:02}Z"),
        format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z"),
    )
}

/// Days-since-epoch to (year, month, day), the standard era-based civil
/// calendar conversion.
fn civil_from_days(z: i64) -> (i64, u64, u64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_metadata_preserves_full_revision_while_slot_name_stays_compact() {
        let sha = "9bc84c97c9ce6120dd68a296c46298b361f3a034";
        assert_eq!(
            build_identifiers(sha, false),
            (sha.to_string(), "9bc84c97c".to_string())
        );
        assert_eq!(
            build_identifiers(sha, true),
            (format!("{sha}-dirty"), "9bc84c97c-dirty".to_string())
        );
    }

    #[test]
    fn register_stashes_declared_artifact() {
        // The only test that touches XDG_CACHE_HOME: registration must land
        // in the isolated cache, write a promote-compatible meta.env, and
        // record the artifact's content hash.
        let root = shifu_core::host::unique_temp_dir("registrar-register").unwrap();
        let cache = root.join("cache");
        env::set_var("XDG_CACHE_HOME", &cache);
        let kfd = root.join(".buildchain/kfd/kfd-3");
        fs::create_dir_all(&kfd).unwrap();
        fs::write(
            kfd.join("surfaces.json"),
            format!(
                r#"{{
                  "product": {{"id": "kungfu"}},
                  "surfaces": [{{
                    "id": "kungfu.product.release-build",
                    "distribution": {{
                      "registrar": "shifu",
                      "tasks": ["dist"],
                      "artifacts": [
                        {{"kind": "installer", "platform": "{os}", "pathGlob": "out/*.bin"}}
                      ]
                    }}
                  }}]
                }}"#,
                os = env::consts::OS
            ),
        )
        .unwrap();
        fs::create_dir_all(root.join("out")).unwrap();
        fs::write(root.join("out/app.bin"), b"artifact-bytes").unwrap();

        let plan = plan_at(&root, &kfd.join("surfaces.json"), "dist").expect("plan");
        register(&root, &plan);

        let registry = cache.join("kungfu/product").join(host::os_arch());
        let slots: Vec<_> = fs::read_dir(&registry).unwrap().flatten().collect();
        assert_eq!(slots.len(), 1, "exactly one slot registered");
        let slot = slots[0].path();
        assert!(slot.join("app.bin").is_file());
        let meta = fs::read_to_string(slot.join("meta.env")).unwrap();
        assert!(meta.contains("KUNGFU_BUILD_ARTIFACT='app.bin'"));
        assert!(meta.contains("KUNGFU_BUILD_KIND='installer'"));
        assert!(meta.contains("KUNGFU_BUILD_SURFACE='kungfu.product.release-build'"));
        // No git repo at the temp root: fingerprint degrades honestly.
        assert!(meta.contains("KUNGFU_BUILD_SHA='unknown'"));
        assert!(meta.contains("KUNGFU_BUILD_MAINLINE_REF='origin/dev/v4/v4.0'"));
        assert!(meta.contains("KUNGFU_BUILD_INTEGRATED='false'"));
        assert!(meta.contains("KUNGFU_BUILD_QUALIFIED='false'"));
        // Content hash of b"artifact-bytes", recorded for provenance.
        assert!(meta.contains(
            "KUNGFU_BUILD_SHA256='6521df166eb07efaf36eba5b6bedefd9d6a252e9c80bab1c99653700ec71473c'"
        ));

        // Layout-answer cache round-trip. This lives inside the single test
        // that owns XDG_CACHE_HOME (its writes land in the isolated cache);
        // running it here keeps env mutation from racing the parallel suite.
        assert!(read_layout_cache(&root, "2.12.1-alpha.4").is_none());
        write_layout_cache(
            &root,
            "2.12.1-alpha.4",
            ".buildchain/kfd/kfd-3/surfaces.json",
        );
        assert_eq!(
            read_layout_cache(&root, "2.12.1-alpha.4").as_deref(),
            Some(".buildchain/kfd/kfd-3/surfaces.json")
        );
        // A different pinned version is a distinct cache slot (a miss), and a
        // different root never reads another root's answer.
        assert!(read_layout_cache(&root, "2.13.0").is_none());
        assert!(read_layout_cache(&root.join("other"), "2.12.1-alpha.4").is_none());

        env::remove_var("XDG_CACHE_HOME");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn segment_matching_is_shell_like() {
        assert!(segment_matches("mac*", "mac-arm64"));
        assert!(segment_matches("mac*", "mac"));
        assert!(!segment_matches("mac*", "windows"));
        assert!(segment_matches("*.app", "Kungfu Episodes.app"));
        assert!(!segment_matches("*.app", "Kungfu.app.zip"));
        assert!(segment_matches("a*b*c", "aXbYc"));
        assert!(!segment_matches("a*b*c", "aXcYb"));
        assert!(segment_matches("exact", "exact"));
        assert!(!segment_matches("exact", "exactly"));
    }

    #[test]
    fn civil_conversion_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // leap year start
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // leap day
        assert_eq!(civil_from_days(20_645), (2026, 7, 11));
    }

    #[test]
    fn quoting_strips_single_quotes() {
        assert_eq!(quote("a'b"), "'ab'");
        assert_eq!(quote("plain"), "'plain'");
    }

    #[test]
    fn jurisdiction_requires_an_explicit_shifu_registrar() {
        let shifu =
            json::parse(r#"{"surfaces": [{"distribution": {"registrar": "shifu"}}]}"#).unwrap();
        assert!(registry_declares_shifu(&shifu));
        // A KFD registry that names some other registrar, or none, is not
        // shifu's to claim.
        let other =
            json::parse(r#"{"surfaces": [{"distribution": {"registrar": "someone-else"}}]}"#)
                .unwrap();
        assert!(!registry_declares_shifu(&other));
        let bare = json::parse(r#"{"surfaces": [{"id": "x"}]}"#).unwrap();
        assert!(!registry_declares_shifu(&bare));
        let empty = json::parse(r#"{"product": {"id": "x"}}"#).unwrap();
        assert!(!registry_declares_shifu(&empty));
    }

    #[test]
    fn plan_parses_declaration_for_host_platform() {
        let dir = shifu_core::host::unique_temp_dir("registrar-test").unwrap();
        let kfd = dir.join(".buildchain/kfd/kfd-3");
        fs::create_dir_all(&kfd).unwrap();
        fs::write(
            kfd.join("surfaces.json"),
            format!(
                r#"{{
                  "product": {{"id": "kungfu"}},
                  "surfaces": [{{
                    "id": "kungfu.product.release-build",
                    "distribution": {{
                      "registrar": "shifu",
                      "tasks": ["dist", "package"],
                      "artifacts": [
                        {{"kind": "app", "platform": "{os}", "pathGlob": "out/*.bin"}},
                        {{"kind": "app", "platform": "not-an-os", "pathGlob": "other/*.bin"}}
                      ]
                    }}
                  }}]
                }}"#,
                os = env::consts::OS
            ),
        )
        .unwrap();
        let reg = kfd.join("surfaces.json");
        let plan = plan_at(&dir, &reg, "dist").expect("plan for dist");
        assert_eq!(plan.product_id, "kungfu");
        assert_eq!(plan.surface_id, "kungfu.product.release-build");
        assert_eq!(plan.artifacts.len(), 1);
        assert_eq!(plan.artifacts[0].path_glob, "out/*.bin");
        assert!(plan_at(&dir, &reg, "package").is_some());
        assert!(plan_at(&dir, &reg, "verify").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_hint_prefilters_only_declared_distribution_tasks() {
        let dir = shifu_core::host::unique_temp_dir("registrar-hint").unwrap();
        let registry = dir.join(REGISTRY_DISCOVERY_HINT);
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        fs::write(
            &registry,
            format!(
                r#"{{
                  "product": {{"id": "kungfu"}},
                  "surfaces": [{{
                    "id": "kungfu.product.release-build",
                    "distribution": {{
                      "registrar": "shifu",
                      "tasks": ["dist"],
                      "artifacts": [
                        {{"kind": "appimage", "platform": "{os}", "pathGlob": "out/*.bin"}}
                      ]
                    }}
                  }}]
                }}"#,
                os = env::consts::OS
            ),
        )
        .unwrap();
        assert!(plan_at(&dir, &registry, "dist").is_some());
        assert!(plan_at(&dir, &registry, "verify").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn source_build_boundary_alone_allows_the_tracked_registry_hint() {
        assert!(source_registry_hint_allowed(Some(std::ffi::OsStr::new(
            "1"
        ))));
        assert!(!source_registry_hint_allowed(None));
        assert!(!source_registry_hint_allowed(Some(std::ffi::OsStr::new(
            "0"
        ))));
        assert!(!source_registry_hint_allowed(Some(std::ffi::OsStr::new(
            "true"
        ))));
    }

    #[test]
    fn fnv1a_is_deterministic_and_distinguishes_inputs() {
        assert_eq!(fnv1a_hex(b"/a/b"), fnv1a_hex(b"/a/b"));
        assert_ne!(fnv1a_hex(b"/a/b"), fnv1a_hex(b"/a/c"));
        assert_eq!(fnv1a_hex(b"").len(), 16);
    }

    #[test]
    fn json_string_escapes_backslashes_and_quotes() {
        assert_eq!(json_string(r"C:\repo"), r#""C:\\repo""#);
        assert_eq!(json_string(r#"a"b"#), r#""a\"b""#);
        assert_eq!(json_string("plain"), r#""plain""#);
    }

    #[test]
    fn glob_resolves_within_segments() {
        let dir = shifu_core::host::unique_temp_dir("registrar-glob").unwrap();
        fs::create_dir_all(dir.join("dist/mac-arm64")).unwrap();
        fs::write(dir.join("dist/mac-arm64/App.app"), b"x").unwrap();
        fs::write(dir.join("dist/setup.exe"), b"x").unwrap();
        fs::write(dir.join("dist/.hidden.exe"), b"x").unwrap();
        let apps = glob_matches(&dir, "dist/mac*/*.app");
        assert_eq!(apps.len(), 1);
        assert!(apps[0].ends_with("mac-arm64/App.app"));
        let exes = glob_matches(&dir, "dist/*.exe");
        assert_eq!(exes.len(), 1, "dotfiles must not match");
        assert!(glob_matches(&dir, "dist/none*/*.app").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
