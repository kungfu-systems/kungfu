# SPDX-License-Identifier: Apache-2.0

"""Rooted, read-only Skill runtime evidence shared by every product surface.

The projection intentionally owns no lifecycle, Work, KFX, Profile, trust, or
completion decision.  It folds receipts and reports produced by those
authorities into one inspectable identity and marks claims without roots as
unproved.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from kungfu.canonical_json import canonical_json_bytes

from .contract import (
    validate_dependency_plan_v2,
    validate_dependency_receipt_v2,
    validate_runtime_audit_v2,
)
from .registry import diagnose_registry, inspect_registry, registry_history


RUNTIME_AUDIT_SCHEMA = "kungfu.skill-runtime-audit/v2"
SURFACES = ("agent", "cli", "gui", "tui", "managed-run")


def build_skill_runtime_audit(
    home: str | Path,
    *,
    audit_documents: Iterable[Mapping[str, Any]] = (),
    dependency_documents: Iterable[Mapping[str, Any]] = (),
    run_id: str | None = None,
    work_ref: str | None = None,
) -> dict[str, Any]:
    """Join existing Skill authority evidence without creating new authority."""

    registry = inspect_registry(home)
    history = registry_history(home)
    diagnosis = diagnose_registry(home)
    audits = [copy.deepcopy(dict(value)) for value in audit_documents]
    dependencies = [copy.deepcopy(dict(value)) for value in dependency_documents]
    for value in dependencies:
        _validate_dependency_document(value)

    evidence = _registry_evidence(registry, history)
    evidence.extend(_audit_evidence(audits))
    evidence.extend(_dependency_evidence(dependencies))
    evidence.sort(key=_evidence_sort_key)

    skill_keys = set(registry["entries"])
    skill_keys.update(str(row["skillKey"]) for row in evidence if row.get("skillKey"))
    skills = [
        _skill_projection(key, registry, evidence)
        for key in sorted(skill_keys)
        if work_ref is None or _skill_matches_work(key, registry, evidence, work_ref)
    ]
    audit_roots = [_root(value) for value in audits]
    dependency_roots = [
        str(value.get("receiptRoot") or value.get("planRoot")) for value in dependencies
    ]
    base = {
        "schema": RUNTIME_AUDIT_SCHEMA,
        "authority": {
            "registry": "python-single-writer-skill-registry-fold",
            "projection": "read-only-evidence-join",
            "nonClaims": [
                "work-authority",
                "profile-authority",
                "fact-or-episode-authority",
                "kfx-package-trust-or-capability-authority",
                "run-or-work-completion-authority",
            ],
        },
        "scope": {"runId": run_id, "workRef": work_ref},
        "roots": {
            "registryStateRoot": registry["stateRoot"],
            "registryReportRoot": registry["reportRoot"],
            "historyRoot": history["historyRoot"],
            "diagnosisRoot": diagnosis["diagnosisRoot"],
            "auditRoots": audit_roots,
            "dependencyRoots": dependency_roots,
        },
        "skills": skills,
        "evidence": evidence,
        "recovery": {
            "verdict": diagnosis["verdict"],
            "issues": copy.deepcopy(diagnosis["issues"]),
            "recoverableStaging": copy.deepcopy(diagnosis["recoverableStaging"]),
            "guidance": diagnosis["recovery"],
            "historyPreserved": True,
        },
    }
    runtime_root = _root(base)
    document = {
        **base,
        "runtimeAuditRoot": runtime_root,
        "surfaceProjections": {
            surface: _surface_projection(surface, runtime_root, base["roots"])
            for surface in SURFACES
        },
    }
    document["documentRoot"] = _root(document)
    validate_runtime_audit_v2(document)
    return document


def project_skill_runtime_audit(
    document: Mapping[str, Any], surface: str
) -> dict[str, Any]:
    """Verify one surface keeps the exact rooted identity of the shared fold."""

    if document.get("schema") != RUNTIME_AUDIT_SCHEMA:
        raise ValueError("Kungfu Skill runtime audit schema is invalid")
    if surface not in SURFACES:
        raise ValueError(f"Kungfu Skill runtime audit surface is invalid: {surface}")
    rootless = {
        key: copy.deepcopy(value)
        for key, value in document.items()
        if key not in {"runtimeAuditRoot", "surfaceProjections", "documentRoot"}
    }
    expected_root = _root(rootless)
    if document.get("runtimeAuditRoot") != expected_root:
        raise ValueError("Kungfu Skill runtime audit root mismatch")
    document_root = _root(
        {
            key: copy.deepcopy(value)
            for key, value in document.items()
            if key != "documentRoot"
        }
    )
    if document.get("documentRoot") != document_root:
        raise ValueError("Kungfu Skill runtime audit document root mismatch")
    projections = document.get("surfaceProjections") or {}
    projection = projections.get(surface)
    if not isinstance(projection, Mapping):
        raise ValueError(f"Kungfu Skill {surface} runtime projection is absent")
    expected = _surface_projection(surface, expected_root, rootless["roots"])
    if dict(projection) != expected:
        raise ValueError(
            f"Kungfu Skill {surface} runtime projection changed rooted identity"
        )
    return copy.deepcopy(expected)


def write_skill_runtime_audit(path: str | Path, document: Mapping[str, Any]) -> str:
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return str(target)


def read_skill_runtime_audit(path: str | Path) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Kungfu Skill runtime audit must be a JSON object")
    validate_runtime_audit_v2(value)
    for surface in SURFACES:
        project_skill_runtime_audit(value, surface)
    return value


def _skill_projection(
    key: str, registry: Mapping[str, Any], evidence: list[dict[str, Any]]
) -> dict[str, Any]:
    entry = copy.deepcopy((registry.get("entries") or {}).get(key))
    matching = [row for row in evidence if row.get("skillKey") == key]
    observed_states = sorted({str(row["state"]) for row in matching})
    if entry is None:
        return {
            "identity": {"key": key, "revision": None, "contentRoot": None},
            "lifecycle": "unproved",
            "workBindings": [],
            "dependencies": None,
            "observedStates": observed_states,
            "historyPreserved": True,
            "proof": {"status": "unproved", "roots": []},
        }
    revision = entry.get("activeRevision")
    historical_revision = (
        max((int(value) for value in (entry.get("revisions") or {})), default=None)
        if revision is None
        else revision
    )
    record = (
        (entry.get("revisions") or {}).get(str(historical_revision))
        if historical_revision is not None
        else None
    )
    roots = [registry["stateRoot"]]
    if record:
        roots.extend([record["contentRoot"], record["definitionRoot"]])
    return {
        "identity": {
            "key": key,
            "revision": historical_revision,
            "active": revision is not None,
            "contentRoot": record.get("contentRoot") if record else None,
            "definitionRoot": record.get("definitionRoot") if record else None,
            "class": record.get("class") if record else None,
        },
        "lifecycle": entry["status"],
        "workBindings": copy.deepcopy(entry.get("workSelections") or []),
        "dependencies": copy.deepcopy(record.get("dependencies")) if record else None,
        "observedStates": observed_states,
        "historyPreserved": True,
        "proof": {"status": "rooted", "roots": _unique_roots(roots)},
    }


def _registry_evidence(
    registry: Mapping[str, Any], history: Mapping[str, Any]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for event in history.get("events") or []:
        roots = _roots_from(event)
        rows.append(
            _evidence_row(
                state=_registry_state(str(event.get("operation"))),
                skill_key=event.get("key"),
                work_ref=None,
                run_id=None,
                source_kind="registry-event",
                source_type=event.get("operation"),
                roots=roots,
                detail={"status": event.get("status")},
            )
        )
    for key, entry in (registry.get("entries") or {}).items():
        for binding in entry.get("workSelections") or []:
            if not binding.get("active"):
                continue
            rows.append(
                _evidence_row(
                    state="selected",
                    skill_key=key,
                    work_ref=binding.get("workRef"),
                    run_id=None,
                    source_kind="registry-fold",
                    source_type="active-work-selection",
                    roots=_roots_from(binding) + [registry["stateRoot"]],
                    detail={"revision": binding.get("revision")},
                )
            )
    for receipt in history.get("receipts") or []:
        if (receipt.get("result") or {}).get("recovered"):
            affected = receipt.get("affected") or {}
            rows.append(
                _evidence_row(
                    state="recovered",
                    skill_key=affected.get("key"),
                    work_ref=None,
                    run_id=None,
                    source_kind="lifecycle-receipt",
                    source_type=receipt.get("operation"),
                    roots=_roots_from(receipt),
                    detail={"changed": (receipt.get("result") or {}).get("changed")},
                )
            )
    return rows


def _audit_evidence(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for document in documents:
        for event in document.get("events") or []:
            state = _audit_state(event)
            skills = event.get("skills") if state == "advertised" else None
            if skills:
                for skill in skills:
                    rows.append(_audit_event_row(event, state, skill.get("key")))
            else:
                skill = event.get("skill") or {}
                rows.append(_audit_event_row(event, state, skill.get("key")))
    return rows


def _audit_event_row(
    event: Mapping[str, Any], state: str, skill_key: Any
) -> dict[str, Any]:
    roots = _roots_from(event)
    roots.extend(_roots_from(event.get("skill") or {}))
    decision = event.get("decision") or {}
    return _evidence_row(
        state=state,
        skill_key=skill_key,
        work_ref=(event.get("work") or {}).get("workRef") or event.get("work_id"),
        run_id=event.get("run_id"),
        source_kind="run-audit-event",
        source_type=event.get("type"),
        roots=roots,
        detail={
            "decision": decision.get("status"),
            "code": decision.get("code"),
        },
    )


def _dependency_evidence(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for value in documents:
        decision = value.get("decision") or {}
        if value.get("schema") == "kungfu.skill-dependency-invocation-receipt/v2":
            state = "invoked"
        elif decision.get("status") == "degraded":
            state = "degraded"
        elif decision.get("status") in {"refused", "blocked"}:
            state = "blocked"
        elif decision.get("status") == "ready":
            state = "resolved"
        else:
            state = "loaded"
        rows.append(
            _evidence_row(
                state=state,
                skill_key=(value.get("skill") or {}).get("key"),
                work_ref=(value.get("work") or {}).get("workRef"),
                run_id=None,
                source_kind="dependency-authority",
                source_type=value.get("schema"),
                roots=_roots_from(value),
                detail={
                    "decision": decision.get("status"),
                    "code": decision.get("code"),
                },
            )
        )
    return rows


def _evidence_row(
    *,
    state: str,
    skill_key: Any,
    work_ref: Any,
    run_id: Any,
    source_kind: str,
    source_type: Any,
    roots: Iterable[Any],
    detail: Mapping[str, Any],
) -> dict[str, Any]:
    proof_roots = _unique_roots(roots)
    return {
        "state": state,
        "skillKey": str(skill_key) if skill_key else None,
        "workRef": str(work_ref) if work_ref else None,
        "runId": str(run_id) if run_id else None,
        "source": {"kind": source_kind, "type": source_type},
        "proof": {
            "status": "rooted" if proof_roots else "unproved",
            "roots": proof_roots,
        },
        "detail": copy.deepcopy(dict(detail)),
    }


def _surface_projection(
    surface: str, runtime_root: str, roots: Mapping[str, Any]
) -> dict[str, Any]:
    return {
        "surface": surface,
        "runtimeAuditRoot": runtime_root,
        "registryStateRoot": roots["registryStateRoot"],
        "historyRoot": roots["historyRoot"],
        "diagnosisRoot": roots["diagnosisRoot"],
        "auditRoots": copy.deepcopy(roots["auditRoots"]),
        "dependencyRoots": copy.deepcopy(roots["dependencyRoots"]),
        "authority": "read-only-projection",
    }


def _audit_state(event: Mapping[str, Any]) -> str:
    event_type = str(event.get("type") or "")
    decision = event.get("decision") or {}
    status = decision.get("status")
    if status == "degraded":
        return "degraded"
    if status in {"refused", "blocked"} or event_type == "SkillTrustRefused":
        return "blocked"
    return {
        "SkillAdvertised": "advertised",
        "SkillSelected": "selected",
        "SkillLoaded": "loaded",
        "SkillDependenciesBound": (
            "blocked"
            if (event.get("summary") or {}).get("unresolved", 0)
            else "resolved"
        ),
        "SkillDependencyInvoked": "invoked",
        "SkillRecovered": "recovered",
        "SkillRetired": "retired",
    }.get(event_type, "unproved")


def _registry_state(operation: str) -> str:
    return {
        "install": "installed",
        "update": "installed",
        "enable": "enabled",
        "select": "selected",
        "load": "loaded",
        "invoke": "invoked",
        "suspend": "suspended",
        "retire": "retired",
        "remove": "historical",
        "rollback": "recovered",
    }.get(operation, "unproved")


def _roots_from(value: Mapping[str, Any]) -> list[str]:
    roots: list[str] = []
    for key, raw in value.items():
        if key.lower().endswith(("root", "hash")) and _is_root(raw):
            roots.append(str(raw))
        elif key.lower().endswith("roots") and isinstance(raw, list):
            roots.extend(str(item) for item in raw if _is_root(item))
    return roots


def _unique_roots(values: Iterable[Any]) -> list[str]:
    return sorted({str(value) for value in values if _is_root(value)})


def _is_root(value: Any) -> bool:
    text = str(value)
    return (
        len(text) == 71
        and text.startswith("sha256:")
        and all(character in "0123456789abcdef" for character in text[7:])
    )


def _skill_matches_work(
    key: str,
    registry: Mapping[str, Any],
    evidence: list[dict[str, Any]],
    work_ref: str,
) -> bool:
    entry = (registry.get("entries") or {}).get(key) or {}
    return any(
        row.get("workRef") == work_ref for row in entry.get("workSelections") or []
    ) or any(
        row.get("skillKey") == key and row.get("workRef") == work_ref
        for row in evidence
    )


def _evidence_sort_key(value: Mapping[str, Any]) -> tuple[str, ...]:
    return (
        str(value.get("skillKey") or ""),
        str(value.get("workRef") or ""),
        str(value.get("runId") or ""),
        str(value.get("state") or ""),
        str((value.get("source") or {}).get("kind") or ""),
        str((value.get("source") or {}).get("type") or ""),
    )


def _validate_dependency_document(value: dict[str, Any]) -> None:
    schema = value.get("schema")
    if schema == "kungfu.skill-dependency-plan/v2":
        validate_dependency_plan_v2(value)
    elif schema == "kungfu.skill-dependency-invocation-receipt/v2":
        validate_dependency_receipt_v2(value)
    else:
        raise ValueError(f"unsupported Skill dependency evidence schema: {schema!r}")


def _root(value: Any) -> str:
    import hashlib

    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"
