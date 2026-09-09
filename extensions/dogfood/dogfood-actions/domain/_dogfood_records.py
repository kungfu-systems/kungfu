# SPDX-License-Identifier: Apache-2.0

"""Shared Dogfood contracts plus Finding and Issue lifecycle writes."""

from __future__ import annotations

import re
import time
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from kungfu.storage import service as storage_service
from kungfu.workspace import semantic_root


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
