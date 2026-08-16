# SPDX-License-Identifier: Apache-2.0

"""Dogfood Finding, Issue, federation, and Assignment consideration semantics.

Finding and receipt records are immutable content-addressed facts. Issue changes
are append-only successors with an exact predecessor root. The queue is only a
federated projection: each owning workspace retains its own Fact authority and
each query exposes independent component cuts.
"""

from __future__ import annotations

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
SOURCE_ID = "kungfu-agent"

FINDING_SCHEMA = "kungfu.dogfood-feedback.finding/v1"
ISSUE_SCHEMA = "kungfu.dogfood-feedback.issue/v1"
CONSIDERATION_SCHEMA = "kungfu.dogfood-feedback.consideration/v1"
QUERY_SCHEMA = "kungfu.dogfood-feedback.query/v1"
LOOKUP_SCHEMA = "kungfu.dogfood-feedback.lookup/v1"
ISSUE_PROPOSAL_SCHEMA = "kungfu.dogfood-feedback.issue-proposal/v1"
RECONCILIATION_SCHEMA = "kungfu.dogfood-feedback.issue-reconciliation/v1"
HEALTH_SCHEMA = "kungfu.dogfood-feedback.health/v1"
GATE_SCHEMA = "kungfu.dogfood-feedback.consideration-gate/v1"
STARVATION_SCHEMA = "kungfu.dogfood-feedback.starvation/v1"

POLICY_VERSION = "dogfood-policy/v2"
CANONICAL_IMPACTS = ("blocker", "high_friction", "medium", "low", "polish")
IMPACT_ALIASES = {
    "blocking": "blocker",
    "high-friction": "high_friction",
    "normal": "medium",
    "workflow-blocking": "blocker",
    "workflow_blocking": "blocker",
}
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
RUNTIME_SURFACES = {
    "installed-product",
    "source-checkout",
    "hybrid-boundary",
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
        },
        "finding": {
            "immutable": True,
            "evidence": "episode-root-and-bounded-pointers",
            "runtimeProvenance": {
                "required": True,
                "surfaces": sorted(RUNTIME_SURFACES),
                "receiptRoot": "kungfu.runtime-surface-receipt/v1",
            },
            "privacy": ["public", "internal", "private-metadata-only"],
            "impact": {
                "canonical": list(CANONICAL_IMPACTS),
                "legacyAliases": dict(sorted(IMPACT_ALIASES.items())),
                "unknownWrites": "rejected",
            },
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


def _normalize_impact(value: Any, *, write: bool = True) -> str:
    raw = _text(value, "impact").lower()
    canonical = IMPACT_ALIASES.get(raw, raw)
    if canonical in CANONICAL_IMPACTS:
        return canonical
    if write:
        raise ValueError(
            "impact must be one of the canonical values or a known legacy alias"
        )
    return ""


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
    runtime_surface: str,
    runtime_receipt_root: str,
    actor: str,
    observed_at: str = "",
    impact: str = "medium",
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
    runtime_surface = _text(runtime_surface, "runtime_surface")
    if runtime_surface not in RUNTIME_SURFACES:
        raise ValueError("runtime_surface is not contract-permitted")
    runtime_receipt_root = _root(runtime_receipt_root, "runtime_receipt_root")
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
        "runtime_surface": runtime_surface,
        "runtime_receipt_root": runtime_receipt_root,
        "impact": _normalize_impact(impact),
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
        "links": {
            "episode_root": body["episode_root"],
            "runtime_receipt_root": body["runtime_receipt_root"],
        },
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
    impact: str = "medium",
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
    selected_findings = [
        row["record"]
        for row in _records(runtime_dir, FINDING_SURFACE_ID)
        if str(row["record"].get("finding_root") or "") in finding_roots
    ]
    runtime_surfaces = sorted(
        {
            _text(row.get("runtime_surface"), "runtime_surface")
            for row in selected_findings
        }
    )
    runtime_receipt_roots = sorted(
        {
            _root(row.get("runtime_receipt_root"), "runtime_receipt_root")
            for row in selected_findings
        }
    )
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
        "runtime_surfaces": runtime_surfaces,
        "runtime_receipt_roots": runtime_receipt_roots,
        "impact": _normalize_impact(impact),
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
