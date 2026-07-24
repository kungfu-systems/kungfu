# SPDX-License-Identifier: Apache-2.0

"""Dogfood Finding, Issue, federation, and Assignment consideration semantics.

Finding and receipt records are immutable content-addressed facts. Issue changes
are append-only successors with an exact predecessor root. The queue is only a
federated projection: each owning workspace retains its own Fact authority and
each query exposes independent component cuts.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from kungfu import workspace_federation
from kungfu.storage import service as storage_service
from kungfu.workspace import WorkspaceIdentity, semantic_root

PROFILE_ID = "kungfu.dogfood-feedback"
CONTRACT_WORLD_ID = "kungfu.dogfood-feedback"
CONTRACT_VERSION = "1"
FINDING_SURFACE_ID = "kungfu.dogfood-feedback.finding"
ISSUE_SURFACE_ID = "kungfu.dogfood-feedback.issue"
CONSIDERATION_SURFACE_ID = "kungfu.dogfood-feedback.consideration"
MIGRATION_SURFACE_ID = "kungfu.dogfood-feedback.migration"
SOURCE_ID = "kungfu-agent"
MIGRATION_SOURCE_ID = "atlas-migration"

FINDING_SCHEMA = "kungfu.dogfood-feedback.finding/v1"
ISSUE_SCHEMA = "kungfu.dogfood-feedback.issue/v1"
CONSIDERATION_SCHEMA = "kungfu.dogfood-feedback.consideration/v1"
MIGRATION_SCHEMA = "kungfu.dogfood-feedback.migration/v1"
QUERY_SCHEMA = "kungfu.dogfood-feedback.query/v1"
GATE_SCHEMA = "kungfu.dogfood-feedback.consideration-gate/v1"
STARVATION_SCHEMA = "kungfu.dogfood-feedback.starvation/v1"
MIGRATION_PLAN_SCHEMA = "kungfu.dogfood-feedback.migration-plan/v1"
MIGRATION_VERIFY_SCHEMA = "kungfu.dogfood-feedback.migration-verification/v1"

POLICY_VERSION = "dogfood-policy/v1"
CONSIDERATION_STAGES = ("design", "admission", "kickoff", "closeout")
ALLOWED_DISPOSITIONS = {
    "addresses",
    "blocked-by",
    "related-to",
    "spawn-child",
    "deferred",
    "not-relevant",
}
HARD_CLASSES = {
    "data-loss",
    "fact-corruption",
    "security",
    "current-assignment-blocker",
}
ISSUE_TRANSITIONS = {
    "open": {"triaged", "accepted", "deferred", "released"},
    "triaged": {"accepted", "deferred", "released"},
    "accepted": {"in-progress", "deferred", "released"},
    "in-progress": {"resolved", "deferred", "released"},
    "deferred": {"triaged", "accepted", "released"},
    "resolved": set(),
    "released": set(),
}
DIMENSIONS = (
    "repository",
    "component",
    "path",
    "capability",
    "schema",
    "contract",
    "command",
    "error",
    "build",
    "platform",
    "tag",
    "history",
    "evidence",
)
DIMENSION_WEIGHTS = {
    "error": 8,
    "contract": 7,
    "schema": 7,
    "component": 6,
    "repository": 6,
    "path": 5,
    "capability": 5,
    "command": 4,
    "build": 4,
    "platform": 3,
    "tag": 2,
    "history": 2,
    "evidence": 2,
}

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_SENSITIVE_KEY = re.compile(
    r"(secret|password|passwd|token|credential|private[_-]?key|signed[_-]?url)",
    re.IGNORECASE,
)


def capabilities() -> dict[str, Any]:
    return {
        "schema": "kungfu.dogfood-feedback.capabilities/v1",
        "profileId": PROFILE_ID,
        "contractWorld": {"id": CONTRACT_WORLD_ID, "version": CONTRACT_VERSION},
        "factSurfaces": {
            "finding": FINDING_SURFACE_ID,
            "issue": ISSUE_SURFACE_ID,
            "consideration": CONSIDERATION_SURFACE_ID,
            "migration": MIGRATION_SURFACE_ID,
        },
        "finding": {
            "immutable": True,
            "evidence": "episode-root-and-bounded-pointers",
            "privacy": ["public", "internal", "private-metadata-only"],
        },
        "issue": {
            "transitions": {
                key: sorted(value) for key, value in ISSUE_TRANSITIONS.items()
            },
            "resolutionRequires": [
                "independent_assessment_root",
                "authorized_decision_root",
                "successor_fact_root",
            ],
        },
        "consideration": {
            "stages": list(CONSIDERATION_STAGES),
            "dispositions": sorted(ALLOWED_DISPOSITIONS),
            "policyVersion": POLICY_VERSION,
        },
        "federation": {
            "authority": "component-workspace-authorities",
            "atomicGlobalCut": False,
        },
    }


def _root(value: Any, field: str) -> str:
    text = str(value or "")
    if not _ROOT.fullmatch(text):
        raise ValueError(f"{field} must be a sha256 content root")
    return text


def _stable_id(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not _STABLE_ID.fullmatch(text):
        raise ValueError(f"{field} must be a stable identifier")
    return text


def _text(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} must not be empty")
    return text


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any, field: str) -> datetime:
    text = _text(value, field)
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        result = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{field} must be ISO-8601") from error
    if result.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return result.astimezone(timezone.utc)


def _content_root(body: Mapping[str, Any]) -> str:
    return semantic_root(dict(body))


def _source(actor: str, recorded_at: str, payload_root: str) -> dict[str, str]:
    return {
        "authority_mode": "owning-workspace",
        "actor": _text(actor, "actor"),
        "recorded_at": recorded_at,
        "payload_root": payload_root,
    }


def _observation_id(kind: str, subject: str, payload: Mapping[str, Any]) -> str:
    digest = _content_root(
        {"kind": kind, "subject": subject, "payload": dict(payload)}
    )[7:]
    return f"dogfood-{kind}-{digest[:32]}"


def _put(
    runtime_dir: str,
    *,
    kind: str,
    surface_id: str,
    subject: str,
    payload: dict[str, Any],
    source_id: str = SOURCE_ID,
    system_time: int = 0,
) -> dict[str, Any]:
    observation_id = _observation_id(kind, subject, payload)
    state = storage_service.fact_state(runtime_dir)
    existing = next(
        (
            row
            for row in state.get("observation_history", [])
            if str(row.get("observation_id") or "") == observation_id
        ),
        None,
    )
    if existing is not None:
        return {
            "schema": "kungfu.dogfood-feedback.write-receipt/v1",
            "status": "already-present",
            "reused": True,
            "observation_id": observation_id,
            "subject_key": subject,
            "episode_id": str(existing.get("episode_id") or ""),
            "payload_hash": str(existing.get("payload_hash") or ""),
        }
    tick = int(system_time or time.time_ns())
    written = storage_service.fact_material_put(
        runtime_dir,
        {
            "type_id": surface_id,
            "type_version": CONTRACT_VERSION,
            "source_id": source_id,
            "subject_key": subject,
            "payload": payload,
            "observation_id": observation_id,
            "action": "assert",
            "valid_from": tick,
            "valid_until": 0,
        },
        system_time=tick,
    )
    return {
        "schema": "kungfu.dogfood-feedback.write-receipt/v1",
        "status": written["receipt"]["admission"]["outcome"],
        "reused": False,
        "observation_id": observation_id,
        "subject_key": subject,
        "episode_id": str(written["receipt"]["episode_id"]),
        "payload_hash": written["payload_hash"],
    }


def _records(
    runtime_dir: str,
    surface_id: str,
    *,
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    materials = storage_service.fact_material_list(
        runtime_dir, cut_system_time=cut_system_time
    )
    payloads = materials.get("payloads", {})
    result = []
    for row in materials.get("state", {}).get("canonical_facts", []):
        if str(row.get("fact_surface_id") or "") != surface_id:
            continue
        payload_hash = str(row.get("payload_hash") or "")
        payload = payloads.get(payload_hash)
        if not isinstance(payload, Mapping):
            continue
        result.append(
            {
                "record": dict(payload.get("record") or {}),
                "source": dict(payload.get("source") or {}),
                "links": dict(payload.get("links") or {}),
                "sealed_identity": {
                    "contract_world_id": str(row.get("contract_world_id") or ""),
                    "fact_surface_id": surface_id,
                    "payload_hash": payload_hash,
                    "observation_id": str(row.get("observation_id") or ""),
                    "source_id": str(row.get("source_id") or ""),
                    "subject_key": str(row.get("subject_key") or ""),
                    "system_time": str(row.get("system_time") or ""),
                },
            }
        )
    return sorted(
        result,
        key=lambda row: (
            str(row["sealed_identity"]["subject_key"]),
            str(row["sealed_identity"]["payload_hash"]),
        ),
    )


def _one_record(
    runtime_dir: str, surface_id: str, identity_field: str, identity: str
) -> dict[str, Any] | None:
    matches = [
        row
        for row in _records(runtime_dir, surface_id)
        if str(row["record"].get(identity_field) or "") == identity
    ]
    if len(matches) > 1:
        raise RuntimeError(f"{identity_field} is ambiguous: {identity}")
    return matches[0] if matches else None


def _dimension_map(value: Any) -> dict[str, list[str]]:
    if value is None:
        return {key: [] for key in DIMENSIONS}
    if not isinstance(value, Mapping):
        raise TypeError("dimensions must be an object")
    unknown = set(value) - set(DIMENSIONS)
    if unknown:
        raise ValueError(f"unknown dimensions: {sorted(unknown)}")
    result = {}
    for key in DIMENSIONS:
        raw = value.get(key, [])
        values = [raw] if isinstance(raw, str) else list(raw or [])
        normalized = sorted(
            {str(item).strip().lower() for item in values if str(item).strip()}
        )
        result[key] = normalized
    return result


def _privacy_safe(value: Any, path: str = "record") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if _SENSITIVE_KEY.search(str(key)):
                raise ValueError(f"sensitive field is not allowed: {path}.{key}")
            _privacy_safe(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _privacy_safe(child, f"{path}[{index}]")


def capture_finding(
    runtime_dir: str,
    *,
    finding_id: str,
    title: str,
    summary: str,
    episode_root: str,
    evidence_roots: Iterable[str] = (),
    dimensions: Mapping[str, Any] | None = None,
    privacy: str = "internal",
    actor: str,
    observed_at: str = "",
    impact: str = "normal",
    hard_class: str = "",
    recurrence: int = 1,
    system_time: int = 0,
) -> dict[str, Any]:
    finding_id = _stable_id(finding_id, "finding_id")
    if privacy not in {"public", "internal", "private-metadata-only"}:
        raise ValueError("privacy must be public, internal, or private-metadata-only")
    if hard_class and hard_class not in HARD_CLASSES:
        raise ValueError("hard_class is not in the declared policy vocabulary")
    if int(recurrence) < 1:
        raise ValueError("recurrence must be at least one")
    existing = _one_record(runtime_dir, FINDING_SURFACE_ID, "finding_id", finding_id)
    recorded_at = observed_at or (
        str(existing["record"].get("observed_at") or "") if existing else ""
    )
    recorded_at = recorded_at or _utc_now()
    _parse_time(recorded_at, "observed_at")
    body = {
        "schema": FINDING_SCHEMA,
        "finding_id": finding_id,
        "title": _text(title, "title"),
        "summary": _text(summary, "summary"),
        "episode_root": _root(episode_root, "episode_root"),
        "evidence_roots": sorted(
            {_root(value, "evidence_root") for value in evidence_roots}
        ),
        "dimensions": _dimension_map(dimensions),
        "privacy": privacy,
        "impact": _text(impact, "impact"),
        "hard_class": hard_class,
        "recurrence": int(recurrence),
        "observed_at": recorded_at,
        "state": "recorded",
        "immutable": True,
    }
    _privacy_safe(body)
    finding_root = _content_root(body)
    if existing is not None:
        if existing["record"].get("finding_root") != finding_root:
            raise ValueError(
                "Finding identity is immutable and already has other bytes"
            )
        return {
            "schema": "kungfu.dogfood-feedback.capture-receipt/v1",
            "status": "already-present",
            "finding": existing["record"],
            "write": None,
        }
    record = {**body, "finding_root": finding_root}
    payload = {
        "record": record,
        "source": _source(actor, recorded_at, finding_root),
        "links": {"episode_root": body["episode_root"]},
    }
    write = _put(
        runtime_dir,
        kind="finding",
        surface_id=FINDING_SURFACE_ID,
        subject=f"finding:{finding_id}",
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.dogfood-feedback.capture-receipt/v1",
        "status": "captured",
        "finding": record,
        "write": write,
    }


def admit_issue(
    runtime_dir: str,
    *,
    issue_id: str,
    title: str,
    owner: str,
    finding_roots: Iterable[str],
    impact: str = "normal",
    hard_class: str = "",
    verification_criteria: Iterable[str] = (),
    actor: str,
    admitted_at: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    issue_id = _stable_id(issue_id, "issue_id")
    owner = _stable_id(owner, "owner")
    finding_roots = sorted({_root(value, "finding_root") for value in finding_roots})
    if not finding_roots:
        raise ValueError("Issue admission requires at least one Finding root")
    known_findings = {
        str(row["record"].get("finding_root") or "")
        for row in _records(runtime_dir, FINDING_SURFACE_ID)
    }
    missing = sorted(set(finding_roots) - known_findings)
    if missing:
        raise ValueError(f"Issue references unknown Finding roots: {missing}")
    if hard_class and hard_class not in HARD_CLASSES:
        raise ValueError("hard_class is not in the declared policy vocabulary")
    existing = _one_record(runtime_dir, ISSUE_SURFACE_ID, "issue_id", issue_id)
    at = admitted_at or (
        str(existing["record"].get("admitted_at") or "") if existing else ""
    )
    at = at or _utc_now()
    _parse_time(at, "admitted_at")
    body = {
        "schema": ISSUE_SCHEMA,
        "issue_id": issue_id,
        "title": _text(title, "title"),
        "owner": owner,
        "state": "open",
        "version": 1,
        "predecessor_root": "",
        "finding_roots": finding_roots,
        "impact": _text(impact, "impact"),
        "hard_class": hard_class,
        "verification_criteria": [
            _text(value, "verification_criterion") for value in verification_criteria
        ],
        "deferral_count": 0,
        "admitted_at": at,
        "updated_at": at,
        "resolution": {},
    }
    issue_root = _content_root(body)
    if existing is not None:
        current = existing["record"]
        admission_fields = {
            "issue_id",
            "title",
            "owner",
            "finding_roots",
            "impact",
            "hard_class",
            "verification_criteria",
            "admitted_at",
        }
        if any(current.get(key) != body.get(key) for key in admission_fields):
            raise ValueError("Issue identity already names a different admission")
        return {
            "schema": "kungfu.dogfood-feedback.issue-admission/v1",
            "status": "already-present",
            "issue": existing["record"],
            "write": None,
        }
    record = {**body, "issue_root": issue_root}
    payload = {
        "record": record,
        "source": _source(actor, at, issue_root),
        "links": {"finding_roots": finding_roots},
    }
    write = _put(
        runtime_dir,
        kind="issue",
        surface_id=ISSUE_SURFACE_ID,
        subject=f"issue:{issue_id}",
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.dogfood-feedback.issue-admission/v1",
        "status": "admitted",
        "issue": record,
        "write": write,
    }


def transition_issue(
    runtime_dir: str,
    *,
    issue_id: str,
    expected_issue_root: str,
    to_state: str,
    actor: str,
    reason: str,
    owner: str = "",
    independent_assessment_root: str = "",
    authorized_decision_root: str = "",
    successor_fact_root: str = "",
    product_root: str = "",
    verification_evidence_roots: Iterable[str] = (),
    transitioned_at: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    issue_id = _stable_id(issue_id, "issue_id")
    current = _one_record(runtime_dir, ISSUE_SURFACE_ID, "issue_id", issue_id)
    if current is None:
        raise ValueError(f"Issue does not exist: {issue_id}")
    record = dict(current["record"])
    current_root = _root(record.get("issue_root"), "current issue_root")
    if _root(expected_issue_root, "expected_issue_root") != current_root:
        raise ValueError("Issue predecessor root is stale")
    current_state = str(record.get("state") or "")
    if to_state not in ISSUE_TRANSITIONS.get(current_state, set()):
        raise ValueError(f"illegal Issue transition: {current_state} -> {to_state}")
    at = transitioned_at or _utc_now()
    _parse_time(at, "transitioned_at")
    resolution = {}
    if to_state == "resolved":
        resolution = {
            "independent_assessment_root": _root(
                independent_assessment_root, "independent_assessment_root"
            ),
            "authorized_decision_root": _root(
                authorized_decision_root, "authorized_decision_root"
            ),
            "successor_fact_root": _root(successor_fact_root, "successor_fact_root"),
            "product_root": _root(product_root, "product_root"),
            "verification_evidence_roots": sorted(
                {
                    _root(value, "verification_evidence_root")
                    for value in verification_evidence_roots
                }
            ),
        }
        if not resolution["verification_evidence_roots"]:
            raise ValueError("resolution requires independent verification evidence")
    elif to_state == "released":
        resolution = {
            "authorized_decision_root": _root(
                authorized_decision_root, "authorized_decision_root"
            ),
            "reason": _text(reason, "reason"),
        }
    next_body = {
        **{
            key: value
            for key, value in record.items()
            if key not in {"issue_root", "resolution"}
        },
        "owner": _stable_id(owner, "owner") if owner else record["owner"],
        "state": to_state,
        "version": int(record.get("version") or 0) + 1,
        "predecessor_root": current_root,
        "updated_at": at,
        "deferral_count": int(record.get("deferral_count") or 0)
        + (1 if to_state == "deferred" else 0),
        "transition_reason": _text(reason, "reason"),
        "resolution": resolution,
    }
    next_root = _content_root(next_body)
    successor = {**next_body, "issue_root": next_root}
    payload = {
        "record": successor,
        "source": _source(actor, at, next_root),
        "links": {
            "predecessor_root": current_root,
            "finding_roots": successor["finding_roots"],
        },
    }
    write = _put(
        runtime_dir,
        kind="issue-successor",
        surface_id=ISSUE_SURFACE_ID,
        subject=f"issue:{issue_id}",
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.dogfood-feedback.issue-transition/v1",
        "status": "transitioned",
        "from_state": current_state,
        "to_state": to_state,
        "issue": successor,
        "write": write,
    }


def local_projection(runtime_dir: str, *, cut_system_time: int = 0) -> dict[str, Any]:
    findings = _records(
        runtime_dir, FINDING_SURFACE_ID, cut_system_time=cut_system_time
    )
    issues = _records(runtime_dir, ISSUE_SURFACE_ID, cut_system_time=cut_system_time)
    considerations = _records(
        runtime_dir, CONSIDERATION_SURFACE_ID, cut_system_time=cut_system_time
    )
    migrations = _records(
        runtime_dir, MIGRATION_SURFACE_ID, cut_system_time=cut_system_time
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
        "migration_versions": sorted(
            row["sealed_identity"]["payload_hash"] for row in migrations
        ),
    }
    cut_root = _content_root(cut_body)
    return {
        "cut_root": cut_root,
        "query_proof_root": cut_root,
        "findings": findings,
        "issues": issues,
        "considerations": considerations,
        "migrations": migrations,
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
            "migrations": [],
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
) -> dict[str, Any]:
    query = workspace_federation.query_federation(
        current,
        scope=scope,  # type: ignore[arg-type]
        config_home=config_home,
        env=env,
        loader=_component,
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
                    "impact": finding["record"].get("impact"),
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
        assignment.get("assignment_id") or assignment.get("goal_id"),
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
        recurrence = max([int(row.get("recurrence") or 1) for row in linked] or [1])
        hard_class = str(issue.get("hard_class") or "")
        reasons = []
        if age >= age_days:
            reasons.append("aged")
        if recurrence >= recurrence_threshold:
            reasons.append("recurrent")
        if int(issue.get("deferral_count") or 0) > maximum_deferrals:
            reasons.append("repeated-deferral")
        if hard_class:
            reasons.append(f"hard-class:{hard_class}")
        release_blocking = bool(
            hard_class in HARD_CLASSES
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


def _atlas_lines(
    source_path: str | Path,
) -> tuple[bytes, list[dict[str, Any]], list[str]]:
    path = Path(source_path).expanduser().resolve()
    raw = path.read_bytes()
    revisions = []
    line_roots = []
    for line_number, raw_line in enumerate(raw.splitlines(keepends=True), 1):
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSONL at line {line_number}: {error}") from error
        if not isinstance(value, Mapping):
            raise TypeError(f"Atlas JSONL line {line_number} must be an object")
        _privacy_safe(value, f"line[{line_number}]")
        revisions.append(dict(value))
        line_roots.append("sha256:" + hashlib.sha256(raw_line).hexdigest())
    return raw, revisions, line_roots


def _title_fingerprint(value: Any) -> str:
    tokens = re.findall(r"[a-z0-9]+", str(value or "").lower())
    return "-".join(tokens)


def atlas_migration_plan(source_path: str | Path) -> dict[str, Any]:
    path = Path(source_path).expanduser().resolve()
    raw, revisions, line_roots = _atlas_lines(path)
    current = {}
    for index, revision in enumerate(revisions, 1):
        item_id = _stable_id(revision.get("id"), f"line {index} id")
        current[item_id] = {**revision, "_source_line": index}
    clusters: dict[str, list[str]] = {}
    for item_id, revision in current.items():
        fingerprint = _title_fingerprint(revision.get("title"))
        if fingerprint:
            clusters.setdefault(fingerprint, []).append(item_id)
    candidates = [
        {"fingerprint": key, "item_ids": sorted(values)}
        for key, values in sorted(clusters.items())
        if len(values) > 1
    ]
    body = {
        "schema": MIGRATION_PLAN_SCHEMA,
        "source": {
            "kind": "atlas-dogfood-jsonl",
            "path": str(path),
            "byte_count": len(raw),
            "revision_count": len(revisions),
            "source_root": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "line_roots": line_roots,
        },
        "current_item_count": len(current),
        "current_states": {
            key: sum(
                1 for row in current.values() if str(row.get("status") or "") == key
            )
            for key in sorted(
                {str(row.get("status") or "") for row in current.values()}
            )
        },
        "candidate_duplicate_clusters": candidates,
        "automatic_deduplication": False,
        "automatic_resolution": False,
        "source_authority_after_import": "retained-read-only",
        "writes": [
            {
                "surface": FINDING_SURFACE_ID,
                "count": len(revisions),
                "mode": "one-immutable-source-revision-per-fact",
            },
            {"surface": MIGRATION_SURFACE_ID, "count": 1},
        ],
    }
    return {**body, "plan_root": _content_root(body)}


def import_atlas_jsonl(
    runtime_dir: str,
    *,
    source_path: str | Path,
    expected_source_root: str,
    actor: str,
    imported_at: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    plan = atlas_migration_plan(source_path)
    source = plan["source"]
    if _root(expected_source_root, "expected_source_root") != source["source_root"]:
        raise ValueError("Atlas source root changed after migration planning")
    raw, revisions, line_roots = _atlas_lines(source_path)
    existing_migration = next(
        (
            row["record"]
            for row in _records(runtime_dir, MIGRATION_SURFACE_ID)
            if row["record"].get("source", {}).get("source_root")
            == source["source_root"]
        ),
        None,
    )
    at = (
        imported_at
        or str((existing_migration or {}).get("imported_at") or "")
        or _utc_now()
    )
    _parse_time(at, "imported_at")
    writes = []
    next_time = int(system_time or time.time_ns())
    current_roots = {}
    for index, (revision, line_root) in enumerate(
        zip(revisions, line_roots, strict=True), 1
    ):
        item_id = _stable_id(revision.get("id"), f"line {index} id")
        revision_number = int(revision.get("revision") or index)
        body = {
            "schema": FINDING_SCHEMA,
            "finding_id": f"atlas:{item_id}:r{revision_number}",
            "title": _text(revision.get("title"), f"line {index} title"),
            "summary": str(
                revision.get("notes")
                or revision.get("actual_behavior")
                or revision.get("title")
            ).strip(),
            "episode_root": line_root,
            "evidence_roots": [line_root],
            "dimensions": _dimension_map(
                {
                    "repository": ["kungfu"],
                    "component": [revision.get("category") or "unknown"],
                    "path": [],
                    "capability": [],
                    "schema": [],
                    "contract": [],
                    "command": [],
                    "error": [],
                    "build": [],
                    "platform": [],
                    "tag": [
                        revision.get("status") or "captured",
                        revision.get("impact") or "normal",
                    ],
                    "history": [item_id],
                    "evidence": [line_root],
                }
            ),
            "privacy": (
                "private-metadata-only"
                if revision.get("privacy_class") == "private"
                else "internal"
            ),
            "impact": str(revision.get("impact") or "normal"),
            "hard_class": "",
            "recurrence": 1,
            "observed_at": str(
                revision.get("updated_at") or revision.get("created_at") or at
            ),
            "state": "recorded",
            "immutable": True,
            "migration": {
                "source_root": source["source_root"],
                "source_line": index,
                "source_line_root": line_root,
                "source_item_id": item_id,
                "source_revision": revision_number,
                "source_status": str(revision.get("status") or ""),
                "source_record_root": _content_root(revision),
            },
        }
        finding_root = _content_root(body)
        record = {**body, "finding_root": finding_root}
        payload = {
            "record": record,
            "source": {
                "authority_mode": "atlas-migration",
                "actor": _text(actor, "actor"),
                "recorded_at": at,
                "payload_root": finding_root,
                "source_root": source["source_root"],
                "source_line_root": line_root,
            },
            "links": {"source_item_id": item_id, "source_line_root": line_root},
        }
        write = _put(
            runtime_dir,
            kind="atlas-revision",
            surface_id=FINDING_SURFACE_ID,
            subject=f"atlas-revision:{index}:{line_root}",
            payload=payload,
            source_id=MIGRATION_SOURCE_ID,
            system_time=next_time + index,
        )
        writes.append(write)
        current_roots[item_id] = finding_root
    manifest_body = {
        "schema": MIGRATION_SCHEMA,
        "migration_id": f"atlas-jsonl:{source['source_root']}",
        "source": source,
        "plan_root": plan["plan_root"],
        "imported_at": at,
        "revision_count": len(revisions),
        "current_item_count": plan["current_item_count"],
        "current_finding_roots": dict(sorted(current_roots.items())),
        "candidate_duplicate_clusters": plan["candidate_duplicate_clusters"],
        "automatic_deduplication": False,
        "automatic_resolution": False,
        "source_authority": "retained-read-only",
        "rollback": {
            "authority_bytes_path": source["path"],
            "expected_source_root": source["source_root"],
            "native_records_are_additive": True,
        },
    }
    migration_root = _content_root(manifest_body)
    manifest = {**manifest_body, "migration_root": migration_root}
    manifest_payload = {
        "record": manifest,
        "source": {
            "authority_mode": "atlas-migration",
            "actor": _text(actor, "actor"),
            "recorded_at": at,
            "payload_root": migration_root,
            "source_root": source["source_root"],
        },
        "links": {"finding_roots": sorted(current_roots.values())},
    }
    manifest_write = _put(
        runtime_dir,
        kind="migration",
        surface_id=MIGRATION_SURFACE_ID,
        subject=f"migration:{source['source_root']}",
        payload=manifest_payload,
        source_id=MIGRATION_SOURCE_ID,
        system_time=next_time + len(revisions) + 1,
    )
    admitted = sum(
        1 for write in writes if write["status"] in {"admitted", "already-present"}
    )
    return {
        "schema": "kungfu.dogfood-feedback.migration-receipt/v1",
        "status": "imported" if admitted == len(revisions) else "degraded",
        "source_root": source["source_root"],
        "source_byte_count": len(raw),
        "source_revision_count": len(revisions),
        "admitted_revision_count": admitted,
        "migration": manifest,
        "migration_write": manifest_write,
        "writes": writes,
    }


def verify_atlas_migration(
    runtime_dir: str, *, source_path: str | Path
) -> dict[str, Any]:
    plan = atlas_migration_plan(source_path)
    source_root = plan["source"]["source_root"]
    matches = [
        row["record"]
        for row in _records(runtime_dir, MIGRATION_SURFACE_ID)
        if row["record"].get("source", {}).get("source_root") == source_root
    ]
    blockers = []
    if len(matches) != 1:
        blockers.append(
            {
                "code": "migration-manifest-count",
                "expected": 1,
                "actual": len(matches),
            }
        )
    manifest = matches[0] if len(matches) == 1 else {}
    for field, expected in (
        ("revision_count", plan["source"]["revision_count"]),
        ("current_item_count", plan["current_item_count"]),
    ):
        if manifest.get(field) != expected:
            blockers.append(
                {
                    "code": "migration-count-mismatch",
                    "field": field,
                    "expected": expected,
                    "actual": manifest.get(field),
                }
            )
    imported_lines = {
        row["record"].get("migration", {}).get("source_line_root")
        for row in _records(runtime_dir, FINDING_SURFACE_ID)
        if row["record"].get("migration", {}).get("source_root") == source_root
    }
    expected_lines = set(plan["source"]["line_roots"])
    if imported_lines != expected_lines:
        blockers.append(
            {
                "code": "migration-revision-roots-mismatch",
                "missing": sorted(expected_lines - imported_lines),
                "extra": sorted(imported_lines - expected_lines),
            }
        )
    body = {
        "schema": MIGRATION_VERIFY_SCHEMA,
        "source_root": source_root,
        "source_path": plan["source"]["path"],
        "source_bytes_retained": True,
        "revision_count": plan["source"]["revision_count"],
        "imported_revision_count": len(imported_lines),
        "candidate_duplicate_clusters": plan["candidate_duplicate_clusters"],
        "automatic_resolution": False,
        "blockers": blockers,
    }
    return {**body, "ok": not blockers, "verification_root": _content_root(body)}
