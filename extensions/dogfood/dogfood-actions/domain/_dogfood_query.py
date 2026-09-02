# SPDX-License-Identifier: Apache-2.0

"""Dogfood local/federated queries and Issue planning projections."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from kungfu import workspace_federation
from kungfu.storage import service as storage_service
from kungfu.workspace import WorkspaceIdentity

from ._dogfood_records import (
    CONSIDERATION_SURFACE_ID,
    DIMENSION_WEIGHTS,
    FINDING_SURFACE_ID,
    ISSUE_PROPOSAL_SCHEMA,
    ISSUE_SURFACE_ID,
    LOOKUP_SCHEMA,
    POLICY_VERSION,
    QUERY_SCHEMA,
    RECONCILIATION_SCHEMA,
    _content_root,
    _dimension_map,
    _normalize_impact,
    _records,
    _root,
    _stable_id,
    _text,
)


def local_projection(runtime_dir: str, *, cut_system_time: int = 0) -> dict[str, Any]:
    findings = _records(
        runtime_dir, FINDING_SURFACE_ID, cut_system_time=cut_system_time
    )
    issues = _records(runtime_dir, ISSUE_SURFACE_ID, cut_system_time=cut_system_time)
    considerations = _records(
        runtime_dir, CONSIDERATION_SURFACE_ID, cut_system_time=cut_system_time
    )
    histories = {}
    for name, surface_id in (
        ("finding", FINDING_SURFACE_ID),
        ("issue", ISSUE_SURFACE_ID),
        ("consideration", CONSIDERATION_SURFACE_ID),
    ):
        material = storage_service.fact_material_list(
            runtime_dir,
            type_id=surface_id,
            cut_system_time=cut_system_time,
        )
        histories[name] = list(
            (material.get("state") or {}).get("observation_history") or []
        )
    cut_body = {
        "schema": "kungfu.dogfood-feedback.component-cut/v1",
        "finding_versions": sorted(
            row["sealed_identity"]["payload_hash"] for row in findings
        ),
        "issue_versions": sorted(
            row["sealed_identity"]["payload_hash"] for row in issues
        ),
        "consideration_versions": sorted(
            row["sealed_identity"]["payload_hash"] for row in considerations
        ),
        "observation_payloads": {
            name: sorted(
                {
                    str(row.get("payload_hash") or "")
                    for row in rows
                    if str(row.get("payload_hash") or "")
                }
            )
            for name, rows in sorted(histories.items())
        },
    }
    cut_root = _content_root(cut_body)
    return {
        "cut_root": cut_root,
        "query_proof_root": cut_root,
        "findings": findings,
        "issues": issues,
        "considerations": considerations,
        "observation_counts": {
            name: len(rows) for name, rows in sorted(histories.items())
        },
    }


def _component(identity: WorkspaceIdentity) -> dict[str, Any]:
    runtime_dir = str(Path(identity.data_home) / "runtime")
    if not Path(runtime_dir).is_dir():
        empty = _content_root(
            {
                "schema": "kungfu.dogfood-feedback.component-cut/v1",
                "workspace_identity_root": identity.identity_root,
                "state": "empty",
            }
        )
        return {
            "availability": "available",
            "stale": False,
            "cut_root": empty,
            "query_proof_root": empty,
            "findings": [],
            "issues": [],
            "considerations": [],
            "observation_counts": {
                "finding": 0,
                "issue": 0,
                "consideration": 0,
            },
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [],
        }
    projection = local_projection(runtime_dir)
    return {
        "availability": "available",
        "stale": False,
        **projection,
        "initiatives": [],
        "assignments": [],
        "relations": [],
        "problems": [],
    }


def federated_query(
    current: WorkspaceIdentity,
    *,
    scope: str = "local",
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    include_excluded: bool = False,
) -> dict[str, Any]:
    query = workspace_federation.query_federation(
        current,
        scope=scope,  # type: ignore[arg-type]
        config_home=config_home,
        env=env,
        loader=_component,
        include_excluded=include_excluded,
    )
    return {
        "schema": QUERY_SCHEMA,
        "scope": scope,
        "observed_at": query["observed_at"],
        "components": query["components"],
        "proof": query["proof"],
        "authority": query["authority"],
        "atomic_global_cut": False,
        "writes": [],
    }


def local_lookup(runtime_dir: str, identity: str) -> dict[str, Any]:
    """Resolve one local Finding or Issue without consulting federation."""

    identity = _text(identity, "identity")
    projection = local_projection(runtime_dir)
    matches = []
    for kind, field in (
        ("finding", "findings"),
        ("issue", "issues"),
        ("consideration", "considerations"),
    ):
        for row in projection[field]:
            record = row["record"]
            identities = {
                str(record.get("finding_id") or ""),
                str(record.get("finding_root") or ""),
                str(record.get("issue_id") or ""),
                str(record.get("issue_root") or ""),
                str(record.get("receipt_root") or ""),
            }
            if identity in identities:
                matches.append({"kind": kind, **row})
    body = {
        "schema": LOOKUP_SCHEMA,
        "scope": "local",
        "identity": identity,
        "component_cut_root": projection["cut_root"],
        "query_proof_root": projection["query_proof_root"],
        "matches": matches,
        "match_count": len(matches),
        "ok": len(matches) == 1,
        "writes": [],
    }
    return {**body, "lookup_root": _content_root(body)}


def propose_issue(
    runtime_dir: str,
    *,
    finding_identity: str,
    owner_candidates: Iterable[str] = (),
) -> dict[str, Any]:
    """Build a deterministic admission proposal without admitting an Issue."""

    lookup = local_lookup(runtime_dir, finding_identity)
    matches = [row for row in lookup["matches"] if row["kind"] == "finding"]
    if len(matches) != 1:
        raise ValueError("Finding proposal requires one exact local Finding")
    finding = dict(matches[0]["record"])
    finding_root = _root(finding.get("finding_root"), "finding_root")
    owners = sorted(
        {_stable_id(value, "owner_candidate") for value in owner_candidates}
    )
    dimensions = _dimension_map(finding.get("dimensions") or {})
    verification = [
        f"verify {dimension}={value}"
        for dimension in ("component", "capability", "contract", "command", "error")
        for value in dimensions[dimension]
    ]
    if not verification:
        verification = ["independently reproduce and verify the reported behavior"]
    cluster = _finding_cluster(runtime_dir, finding)
    proposal = {
        "issueId": f"issue-{finding_root[7:39]}",
        "title": str(finding.get("title") or ""),
        "owner": owners[0] if len(owners) == 1 else "",
        "ownerCandidates": owners,
        "findingRoots": cluster["finding_roots"],
        "impact": _normalize_impact(finding.get("impact") or "medium", write=False)
        or "medium",
        "hardClass": str(finding.get("hard_class") or ""),
        "dimensions": dimensions,
        "verificationCriteria": verification,
    }
    body = {
        "schema": ISSUE_PROPOSAL_SCHEMA,
        "policy_version": POLICY_VERSION,
        "finding_root": finding_root,
        "finding_id": finding.get("finding_id"),
        "cluster": cluster,
        "proposal": proposal,
        "admission_ready": bool(proposal["owner"]),
        "requires_explicit_authorization": True,
        "automatic_admission": False,
        "automatic_scope_expansion": False,
        "component_cut_root": lookup["component_cut_root"],
        "writes": [],
        "next_actions": (
            [
                {
                    "action": "review-and-authorize-issue-admission",
                    "description": "Review the rooted proposal, keep one known owner, then use dogfood admit.",
                }
            ]
            if proposal["owner"]
            else [
                {
                    "action": "select-known-owner",
                    "description": "Choose one accountable owner before Issue admission can be planned.",
                }
            ]
        ),
    }
    return {**body, "proposal_root": _content_root(body)}


def reconcile_issue(
    runtime_dir: str,
    *,
    issue_identity: str,
    evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Explain candidate settlement evidence without changing Issue state."""

    lookup = local_lookup(runtime_dir, issue_identity)
    matches = [row for row in lookup["matches"] if row["kind"] == "issue"]
    if len(matches) != 1:
        raise ValueError("Issue reconciliation requires one exact local Issue")
    issue = dict(matches[0]["record"])
    supplied = dict(evidence or {})
    root_fields = {
        "independent_assessment_root": "independentAssessmentRoot",
        "authorized_decision_root": "authorizedDecisionRoot",
        "successor_fact_root": "successorFactRoot",
        "product_root": "productRoot",
    }
    normalized: dict[str, Any] = {
        "expected_issue_root": (
            _root(supplied.get("expectedIssueRoot"), "expected_issue_root")
            if supplied.get("expectedIssueRoot")
            else ""
        ),
        "implementation_roots": sorted(
            {
                _root(value, "implementation_root")
                for value in supplied.get("implementationRoots") or []
            }
        ),
        "protected_prs": sorted(
            {
                _text(value, "protected_pr")
                for value in supplied.get("protectedPrs") or []
            }
        ),
        "verification_evidence_roots": sorted(
            {
                _root(value, "verification_evidence_root")
                for value in supplied.get("verificationEvidenceRoots") or []
            }
        ),
    }
    for output_name, input_name in root_fields.items():
        raw = supplied.get(input_name)
        normalized[output_name] = _root(raw, output_name) if raw else ""
    matches_by_reason = []
    for name, value in normalized.items():
        present = bool(value)
        if present:
            matches_by_reason.append(
                {
                    "kind": name,
                    "reason": "explicit-rooted-candidate-evidence",
                    "value": value,
                }
            )
    resolution_required = [
        "expected_issue_root",
        "independent_assessment_root",
        "authorized_decision_root",
        "successor_fact_root",
        "product_root",
        "verification_evidence_roots",
    ]
    delivery_required = ["implementation_roots", "protected_prs"]
    delivery_omissions = [
        field for field in delivery_required if not normalized.get(field)
    ]
    resolution_omissions = [
        field for field in resolution_required if not normalized.get(field)
    ]
    expected_root_matches = (
        normalized["expected_issue_root"] == issue.get("issue_root")
        if normalized["expected_issue_root"]
        else False
    )
    if normalized["expected_issue_root"] and not expected_root_matches:
        resolution_omissions.append("expected_current_issue_root_match")
    legal_predecessor = str(issue.get("state") or "") == "in-progress"
    delivery_complete = not delivery_omissions
    resolution_evidence_complete = not resolution_omissions
    resolution_complete = str(issue.get("state") or "") == "resolved"
    body = {
        "schema": RECONCILIATION_SCHEMA,
        "policy_version": POLICY_VERSION,
        "issue_id": issue.get("issue_id"),
        "issue_root": issue.get("issue_root"),
        "issue_state": issue.get("state"),
        "candidate_evidence": normalized,
        "match_reasons": matches_by_reason,
        "delivery": {
            "complete": delivery_complete,
            "omissions": delivery_omissions,
        },
        "resolution": {
            "complete": resolution_complete,
            "evidence_complete": resolution_evidence_complete,
            "expected_root_matches": expected_root_matches,
            "omissions": resolution_omissions,
        },
        "delivery_complete": delivery_complete,
        "resolution_complete": resolution_complete,
        "merged_code_not_resolved": delivery_complete and not resolution_complete,
        "omissions": sorted(set(delivery_omissions + resolution_omissions)),
        "resolution_transition_eligible": (
            legal_predecessor and delivery_complete and resolution_evidence_complete
        ),
        "independent_verification_required": True,
        "merge_is_not_completion_proof": True,
        "automatic_transition": False,
        "component_cut_root": lookup["component_cut_root"],
        "writes": [],
        "next_actions": (
            [
                {
                    "action": "supply-missing-governed-evidence",
                    "fields": sorted(set(delivery_omissions + resolution_omissions)),
                }
            ]
            if delivery_omissions or resolution_omissions
            else (
                [
                    {
                        "action": "move-issue-to-in-progress-first",
                        "current_state": issue.get("state"),
                    }
                ]
                if not legal_predecessor
                else [
                    {
                        "action": "review-and-authorize-explicit-transition",
                        "description": "Use the existing transition intent with this exact predecessor and evidence.",
                    }
                ]
            )
        ),
    }
    return {**body, "reconciliation_root": _content_root(body)}


def _logical_finding_key(record: Mapping[str, Any]) -> str:
    migration = record.get("migration") or {}
    source_root = str(migration.get("source_root") or "")
    source_item_id = str(migration.get("source_item_id") or "")
    if source_root and source_item_id:
        return f"atlas:{source_root}:{source_item_id}"
    return str(record.get("finding_root") or "")


def _dimension_tokens(record: Mapping[str, Any], dimension: str) -> set[str]:
    dimensions = _dimension_map(record.get("dimensions") or {})
    return {
        token
        for value in dimensions[dimension]
        for token in re.findall(r"[a-z0-9]+", value.lower())
        if len(token) >= 3
    }


def _finding_cluster_score(
    anchor: Mapping[str, Any], candidate: Mapping[str, Any]
) -> tuple[int, list[dict[str, Any]]]:
    anchor_dimensions = _dimension_map(anchor.get("dimensions") or {})
    candidate_dimensions = _dimension_map(candidate.get("dimensions") or {})
    repositories = sorted(
        set(anchor_dimensions["repository"]) & set(candidate_dimensions["repository"])
    )
    if not repositories:
        return 0, []
    matches = [
        {
            "dimension": "repository",
            "values": repositories,
            "weight": DIMENSION_WEIGHTS["repository"],
        }
    ]
    semantic_score = 0
    for dimension in (
        "component",
        "capability",
        "command",
        "error",
        "path",
        "contract",
        "schema",
    ):
        overlap = sorted(
            _dimension_tokens(anchor, dimension)
            & _dimension_tokens(candidate, dimension)
        )
        if not overlap:
            continue
        weight = DIMENSION_WEIGHTS[dimension]
        semantic_score += weight * len(overlap)
        matches.append({"dimension": dimension, "values": overlap, "weight": weight})
    return semantic_score, matches


def _finding_cluster(runtime_dir: str, anchor: Mapping[str, Any]) -> dict[str, Any]:
    latest: dict[str, dict[str, Any]] = {}
    for row in _records(runtime_dir, FINDING_SURFACE_ID):
        record = dict(row["record"])
        key = _logical_finding_key(record)
        revision = int((record.get("migration") or {}).get("source_revision") or 0)
        current = latest.get(key)
        current_revision = int(
            ((current or {}).get("migration") or {}).get("source_revision") or 0
        )
        if current is None or (
            revision,
            str(record.get("finding_root") or ""),
        ) > (
            current_revision,
            str(current.get("finding_root") or ""),
        ):
            latest[key] = record
    members = []
    anchor_root = str(anchor.get("finding_root") or "")
    for record in latest.values():
        score, matches = _finding_cluster_score(anchor, record)
        if str(record.get("finding_root") or "") == anchor_root:
            score = max(score, 10)
        if score < 10:
            continue
        members.append(
            {
                "finding_id": record.get("finding_id"),
                "finding_root": record.get("finding_root"),
                "recurrence": int(record.get("recurrence") or 1),
                "score": score,
                "matches": matches,
            }
        )
    members.sort(key=lambda row: str(row["finding_root"]))
    body = {
        "algorithm": "bounded-dimension-token-overlap/v1",
        "anchor_finding_root": anchor_root,
        "threshold": 10,
        "members": members,
        "finding_roots": [str(row["finding_root"]) for row in members],
        "finding_count": len(members),
        "recurrence": sum(int(row["recurrence"]) for row in members),
        "automatic_admission": False,
    }
    return {**body, "cluster_root": _content_root(body)}
