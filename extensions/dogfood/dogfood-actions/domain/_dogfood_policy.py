# SPDX-License-Identifier: Apache-2.0

"""Dogfood health, relevance, consideration, and starvation policy."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from kungfu.workspace import WorkspaceIdentity

from ._dogfood_query import _logical_finding_key, federated_query
from ._dogfood_records import (
    ALLOWED_DISPOSITIONS,
    CONSIDERATION_SCHEMA,
    CONSIDERATION_STAGES,
    CONSIDERATION_SURFACE_ID,
    DIMENSIONS,
    DIMENSION_WEIGHTS,
    FINDING_SURFACE_ID,
    GATE_SCHEMA,
    HARD_CLASSES,
    HEALTH_SCHEMA,
    ISSUE_SURFACE_ID,
    POLICY_VERSION,
    STARVATION_SCHEMA,
    _content_root,
    _dimension_map,
    _normalize_impact,
    _parse_time,
    _put,
    _records,
    _root,
    _source,
    _stable_id,
    _text,
    _utc_now,
)


def health_projection(
    current: WorkspaceIdentity,
    *,
    scope: str = "local",
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    now: str = "",
) -> dict[str, Any]:
    """Project deduplicated Dogfood health over one declared federation cut."""

    evaluated_at = _parse_time(now or _utc_now(), "now")
    query = federated_query(
        current,
        scope=scope,
        config_home=config_home,
        env=env,
        include_excluded=True,
    )
    finding_observations = []
    issue_observations = []
    raw_finding_observation_count = 0
    raw_issue_observation_count = 0
    for component in query["components"]:
        authority = str((component.get("workspace") or {}).get("identity_root") or "")
        counts = component.get("observation_counts") or {}
        raw_finding_observation_count += int(
            counts.get("finding", len(component.get("findings") or []))
        )
        raw_issue_observation_count += int(
            counts.get("issue", len(component.get("issues") or []))
        )
        for field, target in (
            ("findings", finding_observations),
            ("issues", issue_observations),
        ):
            for row in component.get(field, []):
                target.append(
                    {
                        **row,
                        "workspace_identity_root": authority,
                    }
                )
    unique_findings: dict[str, dict[str, Any]] = {}
    for row in finding_observations:
        record = dict(row["record"])
        key = _logical_finding_key(record)
        current_row = unique_findings.get(key)
        revision = int((record.get("migration") or {}).get("source_revision") or 0)
        current_revision = int(
            ((current_row or {}).get("record", {}).get("migration") or {}).get(
                "source_revision"
            )
            or 0
        )
        if current_row is None or (
            revision,
            str(record.get("finding_root") or ""),
        ) > (
            current_revision,
            str((current_row.get("record") or {}).get("finding_root") or ""),
        ):
            unique_findings[key] = row
    issue_groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in issue_observations:
        key = (
            str(row.get("workspace_identity_root") or ""),
            str(row["record"].get("issue_id") or ""),
        )
        issue_groups.setdefault(key, []).append(row)
    latest_issues = {}
    issue_conflicts = []
    for (workspace_identity_root, issue_id), rows in sorted(issue_groups.items()):
        maximum = max(int(row["record"].get("version") or 0) for row in rows)
        candidates = [
            row for row in rows if int(row["record"].get("version") or 0) == maximum
        ]
        roots = sorted(
            {str(row["record"].get("issue_root") or "") for row in candidates}
        )
        if len(roots) > 1:
            issue_conflicts.append(
                {
                    "workspace_identity_root": workspace_identity_root,
                    "issue_id": issue_id,
                    "version": maximum,
                    "roots": roots,
                }
            )
        latest_issues[(workspace_identity_root, issue_id)] = min(
            candidates,
            key=lambda row: str(row["record"].get("issue_root") or ""),
        )
    owner_counts: dict[str, int] = {}
    state_counts: dict[str, int] = {}
    latency_rows = []
    finding_records = {
        str(row["record"].get("finding_root") or ""): row["record"]
        for row in finding_observations
    }
    attention = []
    for (workspace_identity_root, issue_id), row in sorted(latest_issues.items()):
        issue = row["record"]
        owner = str(issue.get("owner") or "unknown")
        state = str(issue.get("state") or "unknown")
        owner_counts[owner] = owner_counts.get(owner, 0) + 1
        state_counts[state] = state_counts.get(state, 0) + 1
        linked = [
            finding_records[root]
            for root in issue.get("finding_roots") or []
            if root in finding_records
        ]
        observed = [
            _parse_time(item.get("observed_at"), "observed_at") for item in linked
        ]
        admitted = _parse_time(issue.get("admitted_at"), "admitted_at")
        updated = _parse_time(issue.get("updated_at"), "updated_at")
        first_observed = min(observed) if observed else None
        latency_rows.append(
            {
                "issue_id": issue_id,
                "time_to_admit_seconds": (
                    max(0, int((admitted - first_observed).total_seconds()))
                    if first_observed
                    else None
                ),
                "time_to_first_owned_state_seconds": (
                    max(0, int((admitted - first_observed).total_seconds()))
                    if first_observed and owner != "unknown"
                    else None
                ),
                "verified_resolution_seconds": (
                    max(0, int((updated - first_observed).total_seconds()))
                    if first_observed and state == "resolved"
                    else None
                ),
            }
        )
        impact_raw = str(issue.get("impact") or "")
        impact = _normalize_impact(impact_raw or "medium", write=False)
        attention.append(
            {
                "workspace_identity_root": workspace_identity_root,
                "issue_id": issue_id,
                "issue_root": issue.get("issue_root"),
                "owner": owner,
                "state": state,
                "age_days": max(0, (evaluated_at - admitted).days),
                "deferral_count": int(issue.get("deferral_count") or 0),
                "impact": impact,
                "impact_raw": impact_raw,
                "recurrence": sum(int(item.get("recurrence") or 1) for item in linked)
                or 1,
            }
        )
    component_states = []
    omissions = []
    for component in query["components"]:
        problems = list(component.get("problems") or [])
        lifecycle = (
            next(
                (
                    problem.get("lifecycle")
                    for problem in problems
                    if problem.get("code") == "workspace-excluded"
                ),
                {},
            )
            or {}
        )
        state = str(lifecycle.get("state") or "")
        classification = (
            state
            if state in {"retired", "test-only", "quarantined"}
            else (
                "stale"
                if component.get("stale")
                else str(component.get("availability") or "unknown")
            )
        )
        projected = {
            "workspace_identity_root": (component.get("workspace") or {}).get(
                "identity_root"
            ),
            "classification": classification,
            "availability": component.get("availability"),
            "stale": bool(component.get("stale")),
            "reasons": problems,
            "cut_root": component.get("cut_root") or "",
        }
        component_states.append(projected)
        if classification in {"stale", "unavailable", "unknown"}:
            omissions.append(projected)
    metric_body = {
        "schema": HEALTH_SCHEMA,
        "policy_version": POLICY_VERSION,
        "scope": scope,
        "evaluated_at": evaluated_at.isoformat().replace("+00:00", "Z"),
        "federation_proof_root": query["proof"]["proof_root"],
        "component_cuts": query["proof"]["component_cuts"],
        "atomic_global_cut": False,
        "counts": {
            "raw_finding_observations": raw_finding_observation_count,
            "raw_issue_observations": raw_issue_observation_count,
            "unique_logical_findings": len(unique_findings),
            "latest_logical_issues": len(latest_issues),
            "finding_replicas_or_revisions": max(
                0, len(finding_observations) - len(unique_findings)
            ),
            "issue_replicas_or_revisions": max(
                0, raw_issue_observation_count - len(latest_issues)
            ),
        },
        "ownership_counts": dict(sorted(owner_counts.items())),
        "state_counts": dict(sorted(state_counts.items())),
        "attention": attention,
        "latencies": latency_rows,
        "issue_conflicts": issue_conflicts,
        "components": component_states,
        "omissions": omissions,
        "p10": {
            "supports_human_evidence_gate": True,
            "completion_authority": False,
            "manufactures_historical_consideration": False,
        },
        "writes": [],
    }
    return {
        **metric_body,
        "health_root": _content_root(metric_body),
        "state": "partial" if omissions or issue_conflicts else "complete",
        "next_actions": (
            [
                {
                    "action": "inspect-visible-health-omissions",
                    "description": "Repair, retire, or explicitly retain unavailable and stale component evidence.",
                }
            ]
            if omissions or issue_conflicts
            else []
        ),
    }


def _assignment_dimensions(assignment: Mapping[str, Any]) -> dict[str, list[str]]:
    explicit = assignment.get("dogfood_dimensions")
    if explicit is not None:
        return _dimension_map(explicit)
    work = assignment.get("work_definition") or {}
    context = work.get("context_admission") or {}
    derived = {
        "repository": assignment.get("repository") or [],
        "component": assignment.get("components") or [],
        "path": assignment.get("paths") or [],
        "capability": context.get("required_capabilities") or [],
        "schema": context.get("subjects") or [],
        "contract": assignment.get("contracts") or [],
        "command": assignment.get("commands") or [],
        "error": assignment.get("errors") or [],
        "build": assignment.get("builds") or [],
        "platform": assignment.get("platforms") or [],
        "tag": context.get("subjects") or [],
        "history": assignment.get("history") or [],
        "evidence": assignment.get("evidence") or [],
    }
    return _dimension_map(derived)


def _candidate_relevance(
    finding: Mapping[str, Any], assignment_dimensions: Mapping[str, list[str]]
) -> tuple[int, list[dict[str, Any]]]:
    finding_dimensions = _dimension_map(finding.get("dimensions") or {})
    matches = []
    score = 0
    for dimension in DIMENSIONS:
        overlap = sorted(
            set(finding_dimensions[dimension]) & set(assignment_dimensions[dimension])
        )
        if not overlap:
            continue
        weight = DIMENSION_WEIGHTS[dimension]
        score += weight * len(overlap)
        matches.append({"dimension": dimension, "values": overlap, "weight": weight})
    return score, matches


def relevance_query(
    current: WorkspaceIdentity,
    *,
    assignment: Mapping[str, Any],
    scope: str = "local",
    limit: int = 50,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    if limit < 1 or limit > 100:
        raise ValueError("relevance limit must be between 1 and 100")
    query = federated_query(current, scope=scope, config_home=config_home, env=env)
    dimensions = _assignment_dimensions(assignment)
    issues_by_finding: dict[str, list[dict[str, Any]]] = {}
    for component in query["components"]:
        workspace_root = str(component.get("workspace", {}).get("identity_root") or "")
        for issue in component.get("issues", []):
            projected = {
                **dict(issue["record"]),
                "workspace_identity_root": workspace_root,
                "sealed_identity": dict(issue["sealed_identity"]),
            }
            for finding_root in issue["record"].get("finding_roots", []):
                issues_by_finding.setdefault(str(finding_root), []).append(projected)
    candidates = []
    for component in query["components"]:
        workspace_root = str(component.get("workspace", {}).get("identity_root") or "")
        for finding in component.get("findings", []):
            score, matches = _candidate_relevance(finding["record"], dimensions)
            if score <= 0:
                continue
            finding_root = str(finding["record"].get("finding_root") or "")
            candidates.append(
                {
                    "finding_root": finding_root,
                    "finding_id": finding["record"].get("finding_id"),
                    "workspace_identity_root": workspace_root,
                    "score": score,
                    "matches": matches,
                    "impact": (
                        _normalize_impact(
                            finding["record"].get("impact") or "medium",
                            write=False,
                        )
                        or "unknown"
                    ),
                    "impact_raw": finding["record"].get("impact"),
                    "hard_class": finding["record"].get("hard_class"),
                    "issues": sorted(
                        issues_by_finding.get(finding_root, []),
                        key=lambda row: (
                            str(row.get("issue_id") or ""),
                            str(row.get("issue_root") or ""),
                        ),
                    ),
                }
            )
    candidates.sort(
        key=lambda row: (
            -int(row["score"]),
            str(row["workspace_identity_root"]),
            str(row["finding_root"]),
        )
    )
    truncated = len(candidates) > limit
    selected = candidates[:limit]
    unknowns = []
    for component in query["components"]:
        if component.get("availability") != "available" or component.get("stale"):
            unknowns.append(
                {
                    "workspace_identity_root": component.get("workspace", {}).get(
                        "identity_root"
                    ),
                    "availability": component.get("availability"),
                    "stale": bool(component.get("stale")),
                    "problems": component.get("problems") or [],
                }
            )
    return {
        "schema": "kungfu.dogfood-feedback.relevance/v1",
        "scope": scope,
        "assignment_dimensions": dimensions,
        "limit": limit,
        "candidate_count": len(candidates),
        "truncated": truncated,
        "candidates": selected,
        "federation": query,
        "unknowns": unknowns,
        "determinism": {
            "algorithm": "exact-normalized-dimension-intersection/v1",
            "tieBreak": [
                "score-desc",
                "workspace-identity-root",
                "finding-root",
            ],
        },
    }


def record_consideration(
    runtime_dir: str,
    current: WorkspaceIdentity,
    *,
    assignment: Mapping[str, Any],
    stage: str,
    actor: str,
    dispositions: Iterable[Mapping[str, Any]] = (),
    scope: str = "local",
    limit: int = 50,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    recorded_at: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    if stage not in CONSIDERATION_STAGES:
        raise ValueError("consideration stage is not in the declared vocabulary")
    assignment_root = _root(
        assignment.get("work_definition_root"), "work_definition_root"
    )
    assignment_id = _stable_id(
        assignment.get("assignment_id"),
        "assignment_id",
    )
    relevance = relevance_query(
        current,
        assignment=assignment,
        scope=scope,
        limit=limit,
        config_home=config_home,
        env=env,
    )
    dispositions_by_issue = {}
    for row in dispositions:
        issue_root = _root(row.get("issue_root"), "disposition issue_root")
        disposition = str(row.get("disposition") or "")
        if disposition not in ALLOWED_DISPOSITIONS:
            raise ValueError(f"unsupported Issue disposition: {disposition}")
        if issue_root in dispositions_by_issue:
            raise ValueError(f"duplicate Issue disposition: {issue_root}")
        dispositions_by_issue[issue_root] = {
            "issue_root": issue_root,
            "disposition": disposition,
            "reason": _text(row.get("reason"), "disposition reason"),
            "successor_assignment_root": (
                _root(
                    row.get("successor_assignment_root"),
                    "successor_assignment_root",
                )
                if row.get("successor_assignment_root")
                else ""
            ),
        }
    known_issue_roots = {
        str(issue.get("issue_root") or "")
        for candidate in relevance["candidates"]
        for issue in candidate["issues"]
    }
    unknown_dispositions = sorted(set(dispositions_by_issue) - known_issue_roots)
    if unknown_dispositions:
        raise ValueError(
            f"dispositions reference non-candidate Issues: {unknown_dispositions}"
        )
    candidates = []
    for candidate in relevance["candidates"]:
        issues = []
        for issue in candidate["issues"]:
            issue_root = str(issue.get("issue_root") or "")
            issues.append(
                {
                    "issue_id": issue.get("issue_id"),
                    "issue_root": issue_root,
                    "owner": issue.get("owner"),
                    "state": issue.get("state"),
                    "hard_class": issue.get("hard_class"),
                    "disposition": dispositions_by_issue.get(issue_root),
                }
            )
        candidates.append({**candidate, "issues": issues})
    at = recorded_at or _utc_now()
    _parse_time(at, "recorded_at")
    component_cuts = list(relevance["federation"]["proof"]["component_cuts"])
    body = {
        "schema": CONSIDERATION_SCHEMA,
        "assignment_id": assignment_id,
        "assignment_definition_root": assignment_root,
        "stage": stage,
        "scope": scope,
        "policy_version": POLICY_VERSION,
        "actor": _text(actor, "actor"),
        "recorded_at": at,
        "federation_proof_root": relevance["federation"]["proof"]["proof_root"],
        "component_cuts": component_cuts,
        "candidate_count": relevance["candidate_count"],
        "truncated": relevance["truncated"],
        "candidates": candidates,
        "unknowns": relevance["unknowns"],
        "dispositions": sorted(
            dispositions_by_issue.values(), key=lambda row: row["issue_root"]
        ),
        "writes": [],
    }
    receipt_root = _content_root(body)
    record = {**body, "receipt_root": receipt_root}
    payload = {
        "record": record,
        "source": _source(actor, at, receipt_root),
        "links": {
            "assignment_definition_root": assignment_root,
            "issue_roots": sorted(known_issue_roots),
        },
    }
    write = _put(
        runtime_dir,
        kind="consideration",
        surface_id=CONSIDERATION_SURFACE_ID,
        subject=f"consideration:{receipt_root}",
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.dogfood-feedback.consideration-write/v1",
        "status": "recorded",
        "consideration": record,
        "write": write,
    }


def consideration_gate(
    runtime_dir: str,
    *,
    assignment_definition_root: str,
    target: str = "closeout",
    required_stages: Iterable[str] = CONSIDERATION_STAGES,
    now: str = "",
) -> dict[str, Any]:
    assignment_root = _root(assignment_definition_root, "assignment_definition_root")
    required = list(required_stages)
    if any(stage not in CONSIDERATION_STAGES for stage in required):
        raise ValueError("required consideration stage is invalid")
    receipts = [
        row["record"]
        for row in _records(runtime_dir, CONSIDERATION_SURFACE_ID)
        if row["record"].get("assignment_definition_root") == assignment_root
    ]
    latest = {}
    for receipt in receipts:
        stage = str(receipt.get("stage") or "")
        if stage not in required:
            continue
        current = latest.get(stage)
        if current is None or str(receipt.get("recorded_at") or "") > str(
            current.get("recorded_at") or ""
        ):
            latest[stage] = receipt
    blockers = []
    for stage in required:
        if stage not in latest:
            blockers.append({"code": "consideration-missing", "stage": stage})
    for stage, receipt in sorted(latest.items()):
        if receipt.get("truncated"):
            blockers.append({"code": "candidate-set-truncated", "stage": stage})
        if receipt.get("unknowns"):
            blockers.append(
                {
                    "code": "federation-evidence-partial",
                    "stage": stage,
                    "unknowns": receipt["unknowns"],
                }
            )
        for candidate in receipt.get("candidates", []):
            for issue in candidate.get("issues", []):
                if issue.get("state") in {"resolved", "released"}:
                    continue
                if not issue.get("disposition"):
                    blockers.append(
                        {
                            "code": "relevant-issue-unaccounted",
                            "stage": stage,
                            "issue_root": issue.get("issue_root"),
                        }
                    )
    starvation = evaluate_starvation(runtime_dir, now=now)
    if target == "closeout":
        blockers.extend(
            {
                "code": "release-policy-blocked",
                "issue_root": row["issue_root"],
                "reasons": row["reasons"],
            }
            for row in starvation["release_blockers"]
        )
    proof = {
        "schema": GATE_SCHEMA,
        "target": target,
        "assignment_definition_root": assignment_root,
        "required_stages": required,
        "consideration_roots": {
            stage: latest[stage]["receipt_root"]
            for stage in required
            if stage in latest
        },
        "starvation_root": starvation["evaluation_root"],
        "blockers": blockers,
    }
    return {
        **proof,
        "ok": not blockers,
        "gate_root": _content_root(proof),
        "next_actions": [
            {
                "action": "record-or-repair-consideration",
                "description": "Record missing stages and account for every relevant Issue",
            }
        ]
        if blockers
        else [],
    }


def evaluate_starvation(
    runtime_dir: str,
    *,
    now: str = "",
    age_days: int = 14,
    recurrence_threshold: int = 3,
    maximum_deferrals: int = 2,
) -> dict[str, Any]:
    at = _parse_time(now or _utc_now(), "now")
    findings = {
        row["record"]["finding_root"]: row["record"]
        for row in _records(runtime_dir, FINDING_SURFACE_ID)
    }
    rows = []
    release_blockers = []
    for issue_row in _records(runtime_dir, ISSUE_SURFACE_ID):
        issue = issue_row["record"]
        if issue.get("state") in {"resolved", "released"}:
            continue
        admitted_at = _parse_time(issue.get("admitted_at"), "admitted_at")
        age = max(0, (at - admitted_at).days)
        linked = [
            findings[root]
            for root in issue.get("finding_roots", [])
            if root in findings
        ]
        recurrence = sum(int(row.get("recurrence") or 1) for row in linked) or 1
        hard_class = str(issue.get("hard_class") or "")
        impact_raw = str(issue.get("impact") or "")
        impact = _normalize_impact(impact_raw or "medium", write=False)
        reasons = []
        if age >= age_days:
            reasons.append("aged")
        if recurrence >= recurrence_threshold:
            reasons.append("recurrent")
        if int(issue.get("deferral_count") or 0) > maximum_deferrals:
            reasons.append("repeated-deferral")
        if hard_class:
            reasons.append(f"hard-class:{hard_class}")
        if impact == "blocker":
            reasons.append("impact:blocker")
        release_blocking = bool(
            impact == "blocker"
            or hard_class in HARD_CLASSES
            or issue.get("state") in {"accepted", "in-progress"}
            and "repeated-deferral" in reasons
        )
        row = {
            "issue_id": issue["issue_id"],
            "issue_root": issue["issue_root"],
            "owner": issue["owner"],
            "state": issue["state"],
            "age_days": age,
            "recurrence": recurrence,
            "deferral_count": int(issue.get("deferral_count") or 0),
            "hard_class": hard_class,
            "impact": impact,
            "impact_raw": impact_raw,
            "reasons": reasons,
            "initiative_review": bool(reasons),
            "release_blocking": release_blocking,
        }
        if reasons:
            rows.append(row)
        if release_blocking:
            release_blockers.append(row)
    body = {
        "schema": STARVATION_SCHEMA,
        "policy_version": POLICY_VERSION,
        "evaluated_at": at.isoformat().replace("+00:00", "Z"),
        "thresholds": {
            "age_days": age_days,
            "recurrence": recurrence_threshold,
            "maximum_deferrals": maximum_deferrals,
        },
        "attention": sorted(rows, key=lambda row: row["issue_root"]),
        "release_blockers": sorted(release_blockers, key=lambda row: row["issue_root"]),
        "automatic_closure": False,
    }
    return {**body, "evaluation_root": _content_root(body)}


def starvation_projection(
    current: WorkspaceIdentity,
    *,
    scope: str = "local",
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    now: str = "",
    age_days: int = 14,
    recurrence_threshold: int = 3,
    maximum_deferrals: int = 2,
) -> dict[str, Any]:
    """Evaluate starvation over independent component cuts."""

    query = federated_query(
        current,
        scope=scope,
        config_home=config_home,
        env=env,
        include_excluded=True,
    )
    at = _parse_time(now or _utc_now(), "now")
    rows = []
    release_blockers = []
    omissions = []
    issue_conflicts = []
    for component in query["components"]:
        workspace = component.get("workspace") or {}
        workspace_root = str(workspace.get("identity_root") or "")
        availability = str(component.get("availability") or "unknown")
        stale = bool(component.get("stale"))
        problems = list(component.get("problems") or [])
        if availability == "excluded":
            continue
        if availability != "available" or stale:
            omissions.append(
                {
                    "workspace_identity_root": workspace_root,
                    "availability": availability,
                    "stale": stale,
                    "problems": problems,
                    "cut_root": component.get("cut_root") or "",
                }
            )
            continue
        findings = {
            str(row["record"].get("finding_root") or ""): row["record"]
            for row in component.get("findings") or []
        }
        issues_by_id: dict[str, list[dict[str, Any]]] = {}
        for issue_row in component.get("issues") or []:
            issue = dict(issue_row["record"])
            issues_by_id.setdefault(str(issue.get("issue_id") or ""), []).append(issue)
        for issue_id, versions in sorted(issues_by_id.items()):
            maximum = max(int(row.get("version") or 0) for row in versions)
            candidates = [
                row for row in versions if int(row.get("version") or 0) == maximum
            ]
            roots = sorted({str(row.get("issue_root") or "") for row in candidates})
            if len(roots) > 1:
                issue_conflicts.append(
                    {
                        "workspace_identity_root": workspace_root,
                        "issue_id": issue_id,
                        "version": maximum,
                        "roots": roots,
                    }
                )
            issue = min(candidates, key=lambda row: str(row.get("issue_root") or ""))
            if issue.get("state") in {"resolved", "released"}:
                continue
            admitted_at = _parse_time(issue.get("admitted_at"), "admitted_at")
            age = max(0, (at - admitted_at).days)
            linked = [
                findings[root]
                for root in issue.get("finding_roots", [])
                if root in findings
            ]
            recurrence = sum(int(row.get("recurrence") or 1) for row in linked) or 1
            hard_class = str(issue.get("hard_class") or "")
            impact_raw = str(issue.get("impact") or "")
            impact = _normalize_impact(impact_raw or "medium", write=False)
            reasons = []
            if age >= age_days:
                reasons.append("aged")
            if recurrence >= recurrence_threshold:
                reasons.append("recurrent")
            if int(issue.get("deferral_count") or 0) > maximum_deferrals:
                reasons.append("repeated-deferral")
            if hard_class:
                reasons.append(f"hard-class:{hard_class}")
            if impact == "blocker":
                reasons.append("impact:blocker")
            release_blocking = bool(
                impact == "blocker"
                or hard_class in HARD_CLASSES
                or issue.get("state") in {"accepted", "in-progress"}
                and "repeated-deferral" in reasons
            )
            row = {
                "workspace_identity_root": workspace_root,
                "component_cut_root": component.get("cut_root") or "",
                "issue_id": issue_id,
                "issue_root": issue.get("issue_root"),
                "owner": issue.get("owner"),
                "state": issue.get("state"),
                "age_days": age,
                "recurrence": recurrence,
                "deferral_count": int(issue.get("deferral_count") or 0),
                "hard_class": hard_class,
                "impact": impact,
                "impact_raw": impact_raw,
                "reasons": reasons,
                "initiative_review": bool(reasons),
                "release_blocking": release_blocking,
            }
            if reasons:
                rows.append(row)
            if release_blocking:
                release_blockers.append(row)
    body = {
        "schema": STARVATION_SCHEMA,
        "policy_version": POLICY_VERSION,
        "scope": scope,
        "evaluated_at": at.isoformat().replace("+00:00", "Z"),
        "thresholds": {
            "age_days": age_days,
            "recurrence": recurrence_threshold,
            "maximum_deferrals": maximum_deferrals,
        },
        "federation_proof_root": query["proof"]["proof_root"],
        "component_cuts": query["proof"]["component_cuts"],
        "atomic_global_cut": False,
        "attention": sorted(
            rows,
            key=lambda row: (
                str(row["workspace_identity_root"]),
                str(row["issue_root"]),
            ),
        ),
        "release_blockers": sorted(
            release_blockers,
            key=lambda row: (
                str(row["workspace_identity_root"]),
                str(row["issue_root"]),
            ),
        ),
        "issue_conflicts": issue_conflicts,
        "omissions": omissions,
        "automatic_closure": False,
        "writes": [],
    }
    return {
        **body,
        "state": "partial" if omissions or issue_conflicts else "complete",
        "evaluation_root": _content_root(body),
        "next_actions": (
            [
                {
                    "action": "inspect-visible-starvation-omissions",
                    "description": "Repair or explicitly retire unavailable and stale component evidence.",
                }
            ]
            if omissions or issue_conflicts
            else []
        ),
    }
