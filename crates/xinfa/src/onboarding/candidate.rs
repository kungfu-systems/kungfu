// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use super::{
    array, parse_json, required_text, rooted, verify_root, ONBOARDING_CANDIDATE_VERSION,
    ONBOARDING_EXPLANATION_VERSION, ONBOARDING_INVENTORY_VERSION,
};

const RULES_VERSION: &str = "xinfa.repository-onboarding-rules/v1";
const MAX_PROPOSALS: usize = 96;

fn proposal_id(path: &str) -> String {
    let root = format!("{:x}", Sha256::digest(path.as_bytes()));
    format!("source.{}", &root[..24])
}

fn node_kind(kind: &str) -> &'static str {
    match kind {
        "guidance" | "documentation" | "decision-record" => "document",
        "test" | "ci" => "probe",
        _ => "implementation",
    }
}

fn rank(kind: &str) -> usize {
    match kind {
        "guidance" => 0,
        "manifest" => 1,
        "decision-record" => 2,
        "documentation" => 3,
        "source" => 4,
        "test" => 5,
        "ci" => 6,
        _ => 7,
    }
}

pub(super) fn verified_candidate(bytes: &[u8], source: &str) -> Result<Value, String> {
    let value = parse_json(bytes, source, "repository onboarding candidate")?;
    if value.get("schema").and_then(Value::as_str) != Some(ONBOARDING_CANDIDATE_VERSION) {
        return Err(format!(
            "repository onboarding candidate schema must be {ONBOARDING_CANDIDATE_VERSION}"
        ));
    }
    if value.get("authoritative").and_then(Value::as_bool) != Some(false) {
        return Err("repository onboarding candidate must remain non-authoritative".to_owned());
    }
    verify_root(&value, "candidateRoot", "repository onboarding candidate")?;
    Ok(value)
}

pub(super) fn candidate(bytes: &[u8], source: &str) -> Result<String, String> {
    let inventory = parse_json(bytes, source, "repository inventory")?;
    if inventory.get("schema").and_then(Value::as_str) != Some(ONBOARDING_INVENTORY_VERSION) {
        return Err(format!(
            "repository inventory schema must be {ONBOARDING_INVENTORY_VERSION}"
        ));
    }
    if inventory.get("authoritative").and_then(Value::as_bool) != Some(false) {
        return Err("repository inventory must be evidence-only".to_owned());
    }
    let inventory_root = verify_root(&inventory, "inventoryRoot", "repository inventory")?;
    let repository = inventory
        .get("repository")
        .cloned()
        .ok_or_else(|| "repository inventory requires repository identity".to_owned())?;
    let policy = inventory
        .get("policy")
        .cloned()
        .ok_or_else(|| "repository inventory requires discovery policy".to_owned())?;
    let mut rows = array(&inventory, "included")?.clone();
    rows.sort_by(|left, right| {
        let left_kind = left
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let right_kind = right
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        (rank(left_kind), left.get("path").and_then(Value::as_str))
            .cmp(&(rank(right_kind), right.get("path").and_then(Value::as_str)))
    });
    let mut proposals = Vec::new();
    let mut omissions = Vec::new();
    for row in rows {
        let row = row
            .as_object()
            .ok_or_else(|| "repository inventory included entries must be objects".to_owned())?;
        let path = required_text(row, "path")?;
        let kind = required_text(row, "kind")?;
        if kind == "unknown" || proposals.len() >= MAX_PROPOSALS {
            omissions.push(json!({
                "path": path,
                "reason": if kind == "unknown" { "unknown-structure" } else { "candidate-budget" },
                "humanReview": true
            }));
            continue;
        }
        let evidence = row
            .get("sourceEvidence")
            .cloned()
            .unwrap_or_else(|| json!([]));
        let content_root = required_text(row, "contentRoot")?;
        let size = row
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("inventory entry {path} requires size"))?;
        proposals.push(json!({
            "id": proposal_id(path),
            "type": "source-unit",
            "authorityState": "proposal",
            "path": path,
            "observed": {
                "kind": kind,
                "contentRoot": content_root,
                "size": size,
                "sourceEvidence": evidence
            },
            "inference": {
                "nodeKind": node_kind(kind),
                "confidence": if matches!(kind, "guidance" | "manifest") { "high" } else { "bounded" },
                "rule": format!("{RULES_VERSION}:{kind}")
            },
            "proposal": {
                "includeInProvider": true,
                "includeInParityRoutes": true,
                "verification": "non-claim"
            },
            "explanation": {
                "whySelected": format!("tracked safe UTF-8 {kind} matched a static v1 path rule"),
                "alternatives": [],
                "rejectedReasons": [],
                "requiredHumanDecision": "accept or reject this exact source unit"
            }
        }));
    }
    proposals.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    omissions.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));

    let mut top_level_markers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for proposal in &proposals {
        if proposal["observed"]["kind"] == "manifest" {
            let path = proposal["path"].as_str().expect("proposal path");
            let marker = path.rsplit('/').next().unwrap_or(path).to_owned();
            top_level_markers
                .entry(marker)
                .or_default()
                .push(path.to_owned());
        }
    }
    let conflicts: Vec<Value> = top_level_markers
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|(marker, paths)| {
            json!({
                "code": "multiple-ecosystem-roots",
                "marker": marker,
                "paths": paths,
                "resolution": "reviewer must decide whether all package roots share one Xinfa project"
            })
        })
        .collect();
    let excluded = inventory
        .get("excluded")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let excluded_count = excluded.as_array().map(Vec::len).unwrap_or_default();
    let value = rooted(
        json!({
            "$schema": "https://xinfa.dev/schema/onboarding-candidate-v1.schema.json",
            "schema": ONBOARDING_CANDIDATE_VERSION,
            "authoritative": false,
            "authorityState": "proposal-only",
            "source": "repository-inventory",
            "inventoryRoot": inventory_root,
            "repository": repository,
            "discoveryPolicy": policy,
            "rulesVersion": RULES_VERSION,
            "proposals": proposals,
            "conflicts": conflicts,
            "omissions": omissions,
            "excludedEvidence": excluded,
            "requiredDecisions": [
                {"id":"project-identity","question":"What stable project id and title should become authoritative?"},
                {"id":"source-selection","question":"Which exact proposals should enter the provider?"},
                {"id":"route-intent","question":"Which Human and Agent entrypoints and route-resolution intent are authoritative?"},
                {"id":"visibility","question":"What visibility ceiling applies to accepted sources?"}
            ],
            "coverage": {
                "candidateCount": proposals.len(),
                "omittedCount": omissions.len(),
                "excludedCount": excluded_count,
                "complete": omissions.is_empty() && conflicts.is_empty()
            }
        }),
        "candidateRoot",
    );
    Ok(super::stable(&value))
}

pub(super) fn explain(bytes: &[u8], source: &str) -> Result<String, String> {
    let candidate = verified_candidate(bytes, source)?;
    let candidate_root = candidate["candidateRoot"]
        .as_str()
        .expect("verified candidate root");
    let proposals = array(&candidate, "proposals")?;
    let mut selected = Vec::new();
    for proposal in proposals {
        selected.push(json!({
            "proposalId": proposal["id"],
            "path": proposal["path"],
            "observedFact": proposal["observed"],
            "inference": proposal["inference"],
            "proposal": proposal["proposal"],
            "why": proposal["explanation"],
            "authorityState": "proposal"
        }));
    }
    let value = rooted(
        json!({
            "schema": ONBOARDING_EXPLANATION_VERSION,
            "candidateRoot": candidate_root,
            "authoritative": false,
            "selected": selected,
            "whyNotSelected": candidate["omissions"],
            "excluded": candidate["excludedEvidence"],
            "conflicts": candidate["conflicts"],
            "requiredDecisions": candidate["requiredDecisions"],
            "summary": candidate["coverage"]
        }),
        "explanationRoot",
    );
    Ok(super::stable(&value))
}

pub(super) fn proposal_map(candidate: &Value) -> Result<BTreeMap<String, Value>, String> {
    let mut output = BTreeMap::new();
    for proposal in array(candidate, "proposals")? {
        let object = proposal
            .as_object()
            .ok_or_else(|| "candidate proposals must be objects".to_owned())?;
        let id = required_text(object, "id")?;
        if output.insert(id.to_owned(), proposal.clone()).is_some() {
            return Err(format!("candidate contains duplicate proposal {id}"));
        }
    }
    Ok(output)
}

pub(super) fn ecosystem_terms(candidate: &Value) -> Vec<String> {
    let mut terms = BTreeSet::new();
    for proposal in candidate["proposals"].as_array().into_iter().flatten() {
        let path = proposal["path"].as_str().unwrap_or_default();
        let name = path.rsplit('/').next().unwrap_or(path);
        let term = match name {
            "Cargo.toml" => Some("rust"),
            "package.json" => Some("node"),
            "pyproject.toml" | "setup.py" => Some("python"),
            "CMakeLists.txt" => Some("cmake"),
            "go.mod" => Some("go"),
            _ => None,
        };
        if let Some(term) = term {
            terms.insert(term.to_owned());
        }
    }
    if terms.is_empty() {
        terms.insert("repository".to_owned());
    }
    terms.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_rejects_unrooted_inventory() {
        assert!(candidate(
            br#"{"schema":"xinfa.repository-inventory/v1","authoritative":false}"#,
            "test"
        )
        .is_err());
    }
}
