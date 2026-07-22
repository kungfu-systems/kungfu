// SPDX-License-Identifier: Apache-2.0
//
// Shared local-artifact semantics for the Shifu binary and Kungfu products.
// Storage and installation stay in their command adapters; this module owns
// Git relation, automatic/manual disposition, compact display, and JSON safety.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const CONTRACT: &str = include_str!("../../../docs/shifu/artifact-contract.json");
const SCHEMA: &str =
    include_str!("../../../docs/shifu/schema/local-artifact-catalog-v1.schema.json");
const RECEIPT_SCHEMA: &str =
    include_str!("../../../docs/shifu/schema/local-promotion-receipt-v1.schema.json");

pub fn run_discovery(args: &[String]) -> ! {
    match args {
        [verb] if verb == "contract" => print!("{CONTRACT}"),
        [verb] if verb == "schema" => print!("{SCHEMA}"),
        [verb] if verb == "receipt-schema" => print!("{RECEIPT_SCHEMA}"),
        _ => {
            eprintln!("usage: shifu artifacts <contract|schema|receipt-schema>");
            std::process::exit(2);
        }
    }
    std::process::exit(0)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitRelation {
    Same,
    Descendant,
    Ancestor,
    Diverged,
    Unknown,
}

impl GitRelation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Same => "same",
            Self::Descendant => "descendant",
            Self::Ancestor => "ancestor",
            Self::Diverged => "diverged",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactState {
    Current,
    Candidate,
    Manual,
    Superseded,
    Rollback,
    Invalid,
}

impl ArtifactState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Candidate => "candidate",
            Self::Manual => "manual",
            Self::Superseded => "superseded",
            Self::Rollback => "rollback",
            Self::Invalid => "invalid",
        }
    }
}

pub fn state_for(relation: GitRelation, valid: bool, rollback_only: bool) -> ArtifactState {
    if !valid {
        ArtifactState::Invalid
    } else if rollback_only {
        ArtifactState::Rollback
    } else {
        match relation {
            GitRelation::Same => ArtifactState::Current,
            GitRelation::Descendant => ArtifactState::Candidate,
            GitRelation::Ancestor => ArtifactState::Superseded,
            GitRelation::Diverged | GitRelation::Unknown => ArtifactState::Manual,
        }
    }
}

pub fn automatic(relation: GitRelation, valid: bool, rollback_only: bool) -> bool {
    valid && !rollback_only && matches!(relation, GitRelation::Same | GitRelation::Descendant)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectionError {
    None,
    Ambiguous,
}

/// Shared default resolver for every locally promoted product. Ordering is
/// deliberately absent: callers must never smuggle mtime or slot names back in
/// as authority.
pub fn select_unique_automatic(
    artifacts: &[(GitRelation, bool, bool)],
) -> Result<usize, SelectionError> {
    let descendants: Vec<_> = artifacts
        .iter()
        .enumerate()
        .filter(|(_, (relation, valid, rollback_only))| {
            *valid && !*rollback_only && *relation == GitRelation::Descendant
        })
        .map(|(index, _)| index)
        .collect();
    match descendants.as_slice() {
        [index] => Ok(*index),
        [] => {
            let same: Vec<_> = artifacts
                .iter()
                .enumerate()
                .filter(|(_, (relation, valid, rollback_only))| {
                    *valid && !*rollback_only && *relation == GitRelation::Same
                })
                .map(|(index, _)| index)
                .collect();
            match same.as_slice() {
                [index] => Ok(*index),
                [] => Err(SelectionError::None),
                _ => Err(SelectionError::Ambiguous),
            }
        }
        _ => Err(SelectionError::Ambiguous),
    }
}

fn clean_sha(value: &str) -> &str {
    value.strip_suffix("-dirty").unwrap_or(value)
}

fn git_success(repo: &Path, args: &[&str]) -> Option<bool> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .map(|status| status.success())
}

fn resolve_commit(repo: &Path, value: &str) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify"])
        .arg(format!("{value}^{{commit}}"))
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Compare candidate to installed. A candidate descended from installed is an
/// automatic forward move; a candidate that installed descends from is older.
pub fn git_relation(repo: &Path, installed: &str, candidate: &str) -> GitRelation {
    let installed = clean_sha(installed);
    let candidate = clean_sha(candidate);
    if installed.is_empty()
        || candidate.is_empty()
        || installed == "unknown"
        || candidate == "unknown"
        || installed.contains("dirty")
        || candidate.contains("dirty")
    {
        return GitRelation::Unknown;
    }
    let Some(installed) = resolve_commit(repo, installed) else {
        return GitRelation::Unknown;
    };
    let Some(candidate) = resolve_commit(repo, candidate) else {
        return GitRelation::Unknown;
    };
    if installed == candidate {
        return GitRelation::Same;
    }
    let installed_to_candidate = git_success(
        repo,
        &["merge-base", "--is-ancestor", &installed, &candidate],
    );
    let candidate_to_installed = git_success(
        repo,
        &["merge-base", "--is-ancestor", &candidate, &installed],
    );
    match (installed_to_candidate, candidate_to_installed) {
        (Some(true), _) => GitRelation::Descendant,
        (_, Some(true)) => GitRelation::Ancestor,
        (Some(false), Some(false)) => GitRelation::Diverged,
        _ => GitRelation::Unknown,
    }
}

/// Human compact view. Preserve the branch-kind prefix, twelve characters of
/// the meaningful name, and an eight-character suffix. UTF-8 is handled by
/// character count rather than byte slicing.
pub fn compact_branch(branch: &str, no_truncate: bool) -> String {
    const MAX: usize = 34;
    if no_truncate || branch.chars().count() <= MAX {
        return branch.to_string();
    }
    let (prefix, rest) = branch
        .split_once('/')
        .map(|(head, tail)| (format!("{head}/"), tail))
        .unwrap_or_else(|| (String::new(), branch));
    let rest_chars: Vec<char> = rest.chars().collect();
    if rest_chars.len() <= 22 {
        return branch.to_string();
    }
    let start: String = rest_chars.iter().take(12).collect();
    let end: String = rest_chars[rest_chars.len() - 8..].iter().collect();
    format!("{prefix}{start}…{end}")
}

pub fn short_sha(sha: &str) -> &str {
    sha.get(..sha.len().min(9)).unwrap_or(sha)
}

pub fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

pub fn write_promotion_receipt(
    root: &Path,
    product: &str,
    action: &str,
    artifact_id: &str,
    from_commit: &str,
    to_commit: &str,
    relation: GitRelation,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let occurred_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let receipt = format!(
        "{{\n  \"schema\": \"shifu.local-promotion-receipt/v1\",\n  \
         \"product\": \"{}\",\n  \"action\": \"{}\",\n  \"artifactId\": \"{}\",\n  \
         \"fromCommit\": \"{}\",\n  \"toCommit\": \"{}\",\n  \"relation\": \"{}\",\n  \
         \"occurredAt\": {}\n}}\n",
        json_escape(product),
        json_escape(action),
        json_escape(artifact_id),
        json_escape(from_commit),
        json_escape(to_commit),
        relation.as_str(),
        occurred_at
    );
    let target = root.join("last-promotion.json");
    let staged = root.join(format!(".last-promotion-{}.tmp", std::process::id()));
    fs::write(&staged, receipt).map_err(|error| error.to_string())?;
    fs::rename(&staged, &target).map_err(|error| {
        let _ = fs::remove_file(&staged);
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn output(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn compact_branch_keeps_identifying_middle_and_suffix() {
        assert_eq!(compact_branch("dev/v4/v4.0", false), "dev/v4/v4.0");
        assert_eq!(
            compact_branch("feature/profile-kfd3-qualification-s1", false),
            "feature/profile-kfd3…ation-s1"
        );
        assert_eq!(
            compact_branch("feature/profile-kfd3-qualification-s1", true),
            "feature/profile-kfd3-qualification-s1"
        );
    }

    #[test]
    fn state_separates_manual_and_rollback_from_candidates() {
        assert_eq!(
            state_for(GitRelation::Descendant, true, false),
            ArtifactState::Candidate
        );
        assert_eq!(
            state_for(GitRelation::Diverged, true, false),
            ArtifactState::Manual
        );
        assert_eq!(
            state_for(GitRelation::Ancestor, true, true),
            ArtifactState::Rollback
        );
        assert!(!automatic(GitRelation::Diverged, true, false));
        assert!(!automatic(GitRelation::Descendant, true, true));
    }

    #[test]
    fn divergent_newer_build_cannot_win_default_selection() {
        let artifacts = [
            (GitRelation::Diverged, true, false),
            (GitRelation::Ancestor, true, false),
            (GitRelation::Ancestor, true, true),
        ];
        assert_eq!(
            select_unique_automatic(&artifacts),
            Err(SelectionError::None),
            "the observed 8c9001c90 -> 5d3613fc0 divergent overwrite must fail closed"
        );
    }

    #[test]
    fn one_descendant_wins_over_the_current_slot() {
        let artifacts = [
            (GitRelation::Same, true, false),
            (GitRelation::Descendant, true, false),
            (GitRelation::Ancestor, true, false),
        ];
        assert_eq!(select_unique_automatic(&artifacts), Ok(1));
    }

    #[test]
    fn promotion_receipt_contains_no_local_paths() {
        let root = shifu_core::host::unique_temp_dir("promotion-receipt").unwrap();
        write_promotion_receipt(
            &root,
            "shifu",
            "self-update",
            "slot-1",
            "aaaa",
            "bbbb",
            GitRelation::Descendant,
        )
        .unwrap();
        let text = fs::read_to_string(root.join("last-promotion.json")).unwrap();
        assert!(text.contains("\"relation\": \"descendant\""));
        assert!(!text.contains(&root.display().to_string()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn git_relation_distinguishes_linear_and_diverged_history() {
        let repo = shifu_core::host::unique_temp_dir("artifact-relation").unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.name", "Shifu Test"]);
        git(&repo, &["config", "user.email", "shifu@example.invalid"]);
        fs::write(repo.join("value"), "one").unwrap();
        git(&repo, &["add", "value"]);
        git(
            &repo,
            &["-c", "core.hooksPath=", "commit", "-q", "-m", "one"],
        );
        let one = output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["branch", "side"]);
        fs::write(repo.join("value"), "two").unwrap();
        git(&repo, &["-c", "core.hooksPath=", "commit", "-qam", "two"]);
        let two = output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "-q", "side"]);
        fs::write(repo.join("side"), "side").unwrap();
        git(&repo, &["add", "side"]);
        git(
            &repo,
            &["-c", "core.hooksPath=", "commit", "-q", "-m", "side"],
        );
        let side = output(&repo, &["rev-parse", "HEAD"]);
        assert_eq!(git_relation(&repo, &one, &two), GitRelation::Descendant);
        assert_eq!(git_relation(&repo, &two, &one), GitRelation::Ancestor);
        assert_eq!(git_relation(&repo, &two, &side), GitRelation::Diverged);
        assert_eq!(git_relation(&repo, &two, &two), GitRelation::Same);
        assert_eq!(
            git_relation(&repo, &two[..9], &two),
            GitRelation::Same,
            "short and full forms of one commit are the same artifact history"
        );
        let _ = fs::remove_dir_all(repo);
    }
}
