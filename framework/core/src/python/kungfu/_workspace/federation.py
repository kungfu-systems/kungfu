# SPDX-License-Identifier: Apache-2.0

"""Own root-bound component materialization for workspace federation.

This module owns Fact material decoding, runtime/profile bindings, component
envelopes, and record projections. The public federation module retains query
composition and verification.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping, cast

from kungfu.assignment_graph import (
    ObjectKind,
    _ROOT,
    _root,
    build_relation,
    build_work_ref,
)
from kungfu.workspace import WorkspaceIdentity, semantic_root


COMPONENT_CUT_SCHEMA = "kungfu.workspace-federation.component-cut/v1"
COMPONENT_ENVELOPE_SCHEMA = "kungfu.workspace-federation.component-envelope/v1"


def _empty_component(
    identity, sealed_index, sealed_states, outcome_index, outcome_bindings
):
    body = {
        "schema": COMPONENT_CUT_SCHEMA,
        "workspace_identity_root": identity.identity_root,
        "state": identity.as_dict()["state"],
        "initiative_versions": [],
        "assignment_versions": [],
        "relation_roots": [],
        "fact_versions": [],
    }
    root = semantic_root(body)
    profile_binding = _empty_profile_binding()
    return {
        "availability": "available",
        "stale": False,
        "cut_root": root,
        "query_proof_root": root,
        "initiatives": [],
        "assignments": [],
        "relations": [],
        "problems": [*sealed_index["issues"], *outcome_index["issues"]],
        "retained_assignment_states": sealed_states,
        "unqualified_retained_assignment_states": sealed_index["unqualified_states"],
        "retained_state_index_root": _retained_state_projection_root(sealed_states),
        "retained_outcome_bindings": outcome_bindings,
        "outcome_binding_index_root": outcome_index["index_root"],
        "reader_runtime": _reader_runtime_identity(),
        "workspace_runtime": _workspace_runtime_identity(identity),
        "profile_binding": profile_binding,
        "profile_root": profile_binding["profile_root"],
        "compatibility": {
            "state": "compatible-empty",
            "protocol": "kungfu.fact-material-read/v1",
            "reason": "workspace runtime is uninitialized",
        },
    }


def _material_record(fact, payloads):
    surface = str(fact.get("fact_surface_id") or "")
    payload_hash = _root(fact.get("payload_hash"), "Fact payload_hash")
    payload = payloads.get(payload_hash)
    if not isinstance(payload, Mapping) or not isinstance(
        payload.get("record"), Mapping
    ):
        raise ValueError(f"Fact payload body is unavailable: {payload_hash}")
    record = dict(payload["record"])
    sealed = {
        "contract_world_id": str(fact.get("contract_world_id") or ""),
        "fact_surface_id": surface,
        "observation_id": str(fact.get("observation_id") or ""),
        "payload_hash": payload_hash,
        "source_id": str(fact.get("source_id") or ""),
        "subject_key": str(fact.get("subject_key") or ""),
        "type_version": "1",
    }
    record["sealed_identity"] = sealed
    record.setdefault("subject_key", sealed["subject_key"])
    return surface, payload, record


def _component_indexes(identity, assignment_orchestration):
    sealed_empty = {
        "schema": "kungfu.assignment-orchestration.sealed-work-index/v1",
        "states": [],
        "unqualified_states": [],
        "issues": [],
        "storage_kind": "none",
        "writes": [],
    }
    sealed_index = (
        assignment_orchestration.list_sealed_assignment_states(identity.workspace_root)
        if identity.workspace_root
        else {**sealed_empty, "index_root": semantic_root(sealed_empty)}
    )
    outcome_empty = {
        "schema": assignment_orchestration.OUTCOME_INDEX_SCHEMA,
        "bindings": [],
        "issues": [],
        "storage_kind": "none",
        "writes": [],
    }
    outcome_index = (
        assignment_orchestration.list_outcome_bindings(identity.workspace_root)
        if identity.workspace_root
        else {**outcome_empty, "index_root": semantic_root(outcome_empty)}
    )
    return sealed_index, outcome_index


def _load_component(identity: WorkspaceIdentity) -> dict[str, Any]:
    """Read one component through the root-bound Fact material protocol.

    Work Control's high-level query correctly requires its exact active
    Profile.  A global controller must not activate or replace that Profile just
    to inspect another workspace, so federation uses the lower, read-only Fact
    material contract and binds the observed contract roots into the component
    envelope.  This is the equivalent root-bound projection: it reads no
    workspace through the controller's active Work Control Profile.
    """

    from kungfu import assignment_orchestration

    sealed_index, outcome_index = _component_indexes(identity, assignment_orchestration)
    sealed_states = cast(list[dict[str, Any]], sealed_index["states"])
    outcome_bindings = cast(list[dict[str, Any]], outcome_index["bindings"])
    runtime_dir = os.path.join(identity.data_home, "runtime")
    if not os.path.isdir(runtime_dir):
        return _empty_component(
            identity, sealed_index, sealed_states, outcome_index, outcome_bindings
        )

    from kungfu.storage import service as storage_service

    materials = storage_service.fact_material_list(runtime_dir)
    if materials.get("schema") != "kungfu.facts.material-catalog/v1":
        raise ValueError("unsupported Fact material catalog")
    canonical_facts = list(materials.get("state", {}).get("canonical_facts", []))
    payloads = materials.get("payloads")
    if not isinstance(payloads, Mapping):
        raise ValueError("Fact material payload map is absent")
    initiatives: list[dict[str, Any]] = []
    assignments: list[dict[str, Any]] = []
    stored_relations: dict[str, dict[str, Any]] = {}
    phase_by_assignment: dict[str, tuple[int, str]] = {}
    for fact in canonical_facts:
        surface, payload, record = _material_record(fact, payloads)
        if surface == "kungfu.initiative-assignment.initiative":
            initiatives.append(record)
        elif surface == "kungfu.initiative-assignment.assignment":
            assignments.append(record)
        elif surface == "kungfu.initiative-assignment.completion-claim":
            stored_relation = _material_relation(record)
            if stored_relation is not None:
                stored_relations[stored_relation["relation_root"]] = stored_relation
            links = payload.get("links")
            linked_assignment = (
                str(links.get("assignment_id") or "")
                if isinstance(links, Mapping)
                else ""
            )
            assignment_id = str(
                record.get("assignment_id")
                or record.get("assignment_subject")
                or linked_assignment
            ).removeprefix("kungfu:")
            phase = _material_completion_phase(record)
            system_time = int(fact.get("system_time") or 0)
            if (
                assignment_id
                and phase
                and system_time >= phase_by_assignment.get(assignment_id, (0, ""))[0]
            ):
                phase_by_assignment[assignment_id] = (system_time, phase)
    initiatives.sort(key=lambda row: str(row.get("subject_key") or ""))
    assignments.sort(key=lambda row: str(row.get("subject_key") or ""))
    fact_versions = sorted(
        str(row.get("payload_hash") or "") for row in canonical_facts
    )
    initiative_versions = sorted(
        str(row["sealed_identity"]["payload_hash"]) for row in initiatives
    )
    assignment_versions = sorted(
        str(row["sealed_identity"]["payload_hash"]) for row in assignments
    )
    body = {
        "schema": COMPONENT_CUT_SCHEMA,
        "workspace_identity_root": identity.identity_root,
        "state": "live-runtime",
        "initiative_versions": initiative_versions,
        "assignment_versions": assignment_versions,
        "relation_roots": [],
        "fact_versions": fact_versions,
    }
    root = semantic_root(body)
    problems = [
        {
            "code": "unresolved-assignment-dependency",
            "assignment_subject": str(
                row.get("sealed_identity", {}).get("subject_key")
                or row.get("subject_key")
                or ""
            ),
            "dependency_id": dependency,
        }
        for row in assignments
        for dependency in row.get("unresolved_dependency_ids", [])
    ]
    projected_initiatives = [
        _record_projection(identity, "initiative", row, root) for row in initiatives
    ]
    projected_assignments = [
        _record_projection(
            identity,
            "assignment",
            row,
            root,
            lifecycle=_material_lifecycle(row, phase_by_assignment),
        )
        for row in assignments
    ]
    derived_relations = _material_relations(projected_assignments)
    relations = {
        str(row.get("relation_root") or ""): row
        for row in [*stored_relations.values(), *derived_relations]
        if row.get("relation_root")
    }
    profile_binding = _fact_profile_binding(materials)
    return {
        "availability": "available",
        "stale": False,
        "cut_root": root,
        "query_proof_root": root,
        "initiatives": projected_initiatives,
        "assignments": projected_assignments,
        "relations": [relations[root] for root in sorted(relations)],
        "problems": [*problems, *sealed_index["issues"], *outcome_index["issues"]],
        "retained_assignment_states": sealed_states,
        "unqualified_retained_assignment_states": sealed_index["unqualified_states"],
        "retained_state_index_root": _retained_state_projection_root(sealed_states),
        "retained_outcome_bindings": outcome_bindings,
        "outcome_binding_index_root": outcome_index["index_root"],
        "reader_runtime": _reader_runtime_identity(),
        "workspace_runtime": _workspace_runtime_identity(identity),
        "profile_binding": profile_binding,
        "profile_root": profile_binding["profile_root"],
        "compatibility": {
            "state": "compatible",
            "protocol": "kungfu.fact-material-read/v1",
            "reason": "canonical Fact material and exact contract roots verified",
        },
    }


def _material_lifecycle(
    record: Mapping[str, Any],
    phase_by_assignment: Mapping[str, tuple[int, str]],
) -> dict[str, Any]:
    assignment_id = str(record.get("assignment_id") or "")
    phase = phase_by_assignment.get(assignment_id, (0, ""))[1] or str(
        record.get("orchestration_phase") or "admitted"
    )
    return {
        "orchestration_phase": phase,
        "portfolio_state": "completed" if phase == "continuation-decided" else "open",
        "globally_completed": phase == "continuation-decided",
        "projection": "root-bound-fact-material",
    }


def _material_relation(record: Mapping[str, Any]) -> dict[str, Any] | None:
    """Verify one relation event directly from root-bound Fact material."""

    if record.get("claim_type") != "assignment-relation-event":
        return None
    relation = record.get("relation")
    if not isinstance(relation, Mapping):
        return None
    verified = build_relation(
        str(relation.get("relation_type") or ""),
        relation.get("source") or {},
        relation.get("target") or {},
        evidence_roots=relation.get("evidence_roots") or [],
        state=cast(
            Literal["proposed", "accepted", "revoked"],
            str(relation.get("state") or "accepted"),
        ),
    )
    if verified["relation_root"] != relation.get("relation_root"):
        raise ValueError("stored Assignment relation root does not verify")
    return verified


def _material_completion_phase(record: Mapping[str, Any]) -> str:
    """Project the same latest completion-cycle phase as Work Control status."""

    if record.get("claim_type") == "assignment-phase-transition":
        return str(record.get("to_phase") or "")
    if record.get("claim_type") == "task-completed":
        return "completion-claimed"
    if record.get("review_type") == "independent-completion-review":
        return "independently-reviewed"
    if record.get("review_type") == "continuation-decision":
        return (
            "stage-ready"
            if record.get("action") in {"reopen", "request-evidence"}
            else "continuation-decided"
        )
    return ""


def _material_relations(
    assignments: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    relations: dict[str, dict[str, Any]] = {}
    for assignment in assignments:
        source = assignment.get("work_ref") or {}
        for target in assignment.get("dependency_refs") or []:
            try:
                relation = build_relation("depends-on", source, target)
            except (TypeError, ValueError):
                continue
            relations[relation["relation_root"]] = relation
        parent = assignment.get("parent_assignment_ref")
        if parent:
            try:
                relation = build_relation("decomposes-into", parent, source)
            except (TypeError, ValueError):
                continue
            relations[relation["relation_root"]] = relation
    return [relations[root] for root in sorted(relations)]


def _fact_profile_binding(materials: Mapping[str, Any]) -> dict[str, Any]:
    catalog = materials.get("state", {}).get("catalog", {})
    worlds = [
        row
        for row in catalog.get("contract_worlds", [])
        if row.get("id") == "kungfu.initiative-assignment"
    ]
    surfaces = [
        row
        for row in catalog.get("fact_surfaces", [])
        if str(row.get("id") or "").startswith("kungfu.initiative-assignment.")
    ]
    body = {
        "schema": "kungfu.workspace-federation.fact-profile-binding/v1",
        "contract_world_roots": sorted(str(row.get("root") or "") for row in worlds),
        "surface_roots": sorted(str(row.get("root") or "") for row in surfaces),
        "schema_owner_roots": sorted(
            str(row.get("schema_owner_root") or "") for row in surfaces
        ),
    }
    for field in ("contract_world_roots", "surface_roots", "schema_owner_roots"):
        if any(not _ROOT.fullmatch(root) for root in body[field]):
            raise ValueError(f"Fact profile {field} contains an invalid root")
    return {**body, "profile_root": semantic_root(body)}


def _empty_profile_binding() -> dict[str, Any]:
    return _fact_profile_binding(
        {"state": {"catalog": {"contract_worlds": [], "fact_surfaces": []}}}
    )


def _reader_runtime_identity() -> dict[str, Any]:
    import kungfu

    binding = Path(str(getattr(kungfu.__binding__, "__file__", ""))).resolve()
    build_info = _read_build_info(binding.parent / "kungfubuildinfo.json")
    body = {
        "schema": "kungfu.workspace-federation.reader-runtime/v1",
        "protocol": "kungfu.fact-material-read/v1",
        "version": str(build_info.get("version") or kungfu.__version__),
        "source_revision": str(build_info.get("git", {}).get("revision") or ""),
        "source_branch": str(build_info.get("git", {}).get("branch") or ""),
        "pristine": build_info.get("git", {}).get("pristine") is True,
    }
    return {**body, "runtime_root": semantic_root(body)}


def _workspace_runtime_identity(identity: WorkspaceIdentity) -> dict[str, Any]:
    candidates = []
    if identity.workspace_root:
        root = Path(identity.workspace_root)
        candidates = [
            root / "framework/core/build/Release/kungfubuildinfo.json",
            root / "framework/core/dist/kungfu/kungfubuildinfo.json",
        ]
    build_info = next(
        (value for path in candidates if (value := _read_build_info(path))),
        {},
    )
    body = {
        "schema": "kungfu.workspace-federation.workspace-runtime/v1",
        "state": "identified" if build_info else "unknown",
        "version": str(build_info.get("version") or ""),
        "source_revision": str(build_info.get("git", {}).get("revision") or ""),
        "source_branch": str(build_info.get("git", {}).get("branch") or ""),
        "pristine": build_info.get("git", {}).get("pristine") is True,
    }
    return {**body, "runtime_root": semantic_root(body)}


def _read_build_info(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _bind_component_envelope(component: dict[str, Any]) -> dict[str, Any]:
    workspace = component.get("workspace") or {}
    errors = list(component.get("problems") or [])
    body = {
        "schema": COMPONENT_ENVELOPE_SCHEMA,
        "workspace_identity_root": workspace.get("identity_root"),
        "reader_runtime": component.get("reader_runtime") or _reader_runtime_identity(),
        "workspace_runtime": component.get("workspace_runtime")
        or {
            "schema": "kungfu.workspace-federation.workspace-runtime/v1",
            "state": "unknown",
        },
        "profile_root": component.get("profile_root") or "",
        "cut_root": component.get("cut_root") or "",
        "query_proof_root": component.get("query_proof_root") or "",
        "availability": component.get("availability"),
        "compatibility": component.get("compatibility")
        or {
            "state": "unknown",
            "protocol": "kungfu.fact-material-read/v1",
            "reason": "component was not readable",
        },
        "stale": bool(component.get("stale")),
        "disposition": component.get("disposition"),
        "errors": errors,
        "known_initiative_count": len(component.get("initiatives") or []),
        "known_assignment_count": len(component.get("assignments") or []),
        "retained_assignment_state_count": len(
            component.get("retained_assignment_states") or []
        ),
        "unqualified_retained_assignment_state_count": len(
            component.get("unqualified_retained_assignment_states") or []
        ),
        "retained_state_index_root": component.get("retained_state_index_root") or "",
        "retained_outcome_binding_count": len(
            component.get("retained_outcome_bindings") or []
        ),
        "outcome_binding_index_root": component.get("outcome_binding_index_root") or "",
        "relation_roots": sorted(
            str(row.get("relation_root") or "")
            for row in component.get("relations") or []
        ),
        "component_result_root": semantic_root(_component_result_material(component)),
        "observed_at": component.get("observed_at"),
    }
    return {
        **component,
        "envelope": {**body, "envelope_root": semantic_root(body)},
    }


def _component_result_material(component: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "workspace_identity_root": (component.get("workspace") or {}).get(
            "identity_root"
        ),
        "initiatives": list(component.get("initiatives") or []),
        "assignments": list(component.get("assignments") or []),
        "relations": list(component.get("relations") or []),
        "problems": list(component.get("problems") or []),
        "disposition": component.get("disposition"),
        "retained_assignment_states": list(
            component.get("retained_assignment_states") or []
        ),
        "unqualified_retained_assignment_states": list(
            component.get("unqualified_retained_assignment_states") or []
        ),
        "retained_state_index_root": component.get("retained_state_index_root") or "",
        "retained_outcome_bindings": list(
            component.get("retained_outcome_bindings") or []
        ),
        "outcome_binding_index_root": component.get("outcome_binding_index_root") or "",
    }


def _retained_state_projection_root(states: Iterable[Mapping[str, Any]]) -> str:
    return semantic_root(
        {
            "schema": "kungfu.workspace-federation.retained-assignment-states/v1",
            "states": [dict(row) for row in states],
        }
    )


def _record_projection(
    identity: WorkspaceIdentity,
    kind: ObjectKind,
    record: Mapping[str, Any],
    cut_root: str,
    lifecycle: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    sealed = record.get("sealed_identity") or {}
    subject = str(sealed.get("subject_key") or record.get("subject_key") or "")
    version_root = _root(sealed.get("payload_hash"), "record payload_hash")
    work_ref = build_work_ref(
        identity,
        object_kind=kind,
        subject=subject,
        version_root=version_root,
        cut_root=cut_root,
    )
    return {
        **dict(record),
        "work_ref": work_ref.as_dict(),
        **({"lifecycle": dict(lifecycle)} if lifecycle is not None else {}),
    }
