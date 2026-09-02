# SPDX-License-Identifier: Apache-2.0

"""Work Control Initiative, Assignment, relation, and execution-lease records."""

import time
from datetime import datetime
from typing import Any, Literal, cast

from ._work_control_state import (
    ASSIGNMENT_EXECUTION_CLAIM,
    ASSIGNMENT_RELATION_EVENT,
    ASSIGNMENT_RELATION_EVENTS,
    ASSIGNMENT_SURFACE_ID,
    CLAIM_SURFACE_ID,
    FACT_SURFACES,
    INITIATIVE_SURFACE_ID,
    RELATION_SURFACE_ID,
    _ensure_contract,
    _ensure_native_write_allowed,
    _native_source,
    _put_native_fact,
    _root_id,
    _selected_subjects,
    _sha256_root,
    _stable_id,
    list_assignments,
    list_domain_records,
    list_initiatives,
    query_state,
)


def create_initiative(
    runtime_dir: str,
    *,
    initiative_id: str,
    title: str,
    intent: str,
    actor: str,
    actor_type: str = "agent",
    status: str = "active",
    horizon: str = "long-term",
    source_identity: dict[str, Any] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Initiative in the shared Fact Library."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    system_time += len(FACT_SURFACES) + 1
    initiative_id = _stable_id(initiative_id, "initiative_id")
    existing = [
        row
        for row in list_initiatives(runtime_dir)
        if row.get("initiative_id") == initiative_id
    ]
    if any(row.get("subject_key") != f"kungfu:{initiative_id}" for row in existing):
        raise ValueError(
            f"initiative_id already belongs to another source authority: {initiative_id}"
        )
    if status not in {"proposed", "active", "paused"}:
        raise ValueError("native Initiative status must be proposed, active, or paused")
    source_id = _native_source(actor_type)
    record: dict[str, Any] = {
        "initiative_id": initiative_id,
        "title": title.strip(),
        "intent": intent.strip(),
        "status": status,
        "horizon": horizon.strip() or "long-term",
        "owner": actor.strip(),
        "actor_type": actor_type,
    }
    if not record["title"] or not record["intent"] or not record["owner"]:
        raise ValueError("title, intent, and actor are required")
    from . import native_state

    source_identity = native_state.validate_source_identity(
        source_identity, initiative_id
    )
    if source_identity:
        record["source_identity"] = source_identity
    subject_key = f"kungfu:{initiative_id}"
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": record["owner"],
        },
        "links": {"initiative_id": subject_key},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="initiative",
        surface_id=INITIATIVE_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.initiative-write/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": subject_key,
        "receipt": receipt,
    }


def _local_work_ref(
    runtime_dir: str,
    *,
    workspace_identity_root: str,
    object_kind: str,
    object_id: str,
    records: list[dict[str, Any]],
    cut_root: str,
) -> dict[str, Any]:
    from kungfu.workspace_federation import WorkRef

    identity_field = "initiative_id" if object_kind == "initiative" else "assignment_id"
    matches = [
        row
        for row in records
        if str(row.get(identity_field) or row.get("assignment_id") or "") == object_id
    ]
    if len(matches) != 1:
        raise ValueError(
            f"local {object_kind} shorthand must resolve exactly once: {object_id}"
        )
    sealed = matches[0].get("sealed_identity") or {}
    return WorkRef(
        workspace_identity_root=_root_id(
            workspace_identity_root,
            "owning_workspace_identity_root",
            required=True,
        ),
        object_kind=object_kind,  # type: ignore[arg-type]
        subject=str(sealed.get("subject_key") or ""),
        version_root=_root_id(
            str(sealed.get("payload_hash") or ""),
            f"{object_kind}_version_root",
            required=True,
        ),
        cut_root=_root_id(cut_root, "workspace_cut_root", required=True),
    ).as_dict()


def _validated_work_ref(
    value: dict[str, Any] | None,
    *,
    object_kind: str,
    field: str,
) -> dict[str, Any]:
    from kungfu.workspace_federation import parse_work_ref

    if not value:
        return {}
    reference = parse_work_ref(value)
    if reference.object_kind != object_kind:
        raise ValueError(f"{field} must reference an {object_kind}")
    return reference.as_dict()


def create_assignment(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    title: str,
    objective: str,
    actor: str,
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    status: str = "active",
    parent_assignment_id: str = "",
    depends_on: list[str] | None = None,
    owning_workspace_identity_root: str = "",
    initiative_ref: dict[str, Any] | None = None,
    parent_assignment_ref: dict[str, Any] | None = None,
    dependency_refs: list[dict[str, Any]] | None = None,
    responsibility: str = "",
    acceptance_root: str = "",
    context_root: str = "",
    context_binding: dict[str, Any] | None = None,
    project_cut_root: str = "",
    evidence_episode_roots: list[str] | None = None,
    request_root: str = "",
    capture_receipt_roots: list[str] | None = None,
    work_definition: dict[str, Any] | None = None,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create one Kungfu-native Assignment linked to an admitted Initiative."""

    _ensure_native_write_allowed(runtime_dir)
    system_time = system_time or time.time_ns()
    _ensure_contract(runtime_dir, system_time)
    explicit_initiative_ref = _validated_work_ref(
        initiative_ref,
        object_kind="initiative",
        field="initiative_ref",
    )
    if explicit_initiative_ref:
        initiative_subject = str(explicit_initiative_ref["subject"])
        declared_initiative_id = initiative_subject.split(":", 1)[-1]
        if declared_initiative_id != _stable_id(initiative_id, "initiative_id"):
            raise ValueError("initiative_ref subject does not match initiative_id")
        state_for_refs: dict[str, Any] = {}
    else:
        initiative_subject, _, _ = _selected_subjects(
            runtime_dir,
            initiative_id=initiative_id,
            storage_source_id=storage_source_id,
            cut_system_time=0,
        )
        state_for_refs = query_state(
            runtime_dir,
            initiative_id=initiative_id,
            storage_source_id=storage_source_id,
        )
    assignment_id = _stable_id(assignment_id, "assignment_id")
    existing_assignments = list_assignments(runtime_dir)
    conflicting = [
        row
        for row in existing_assignments
        if row.get("payload", {}).get("record", {}).get("assignment_id")
        == assignment_id
        and row.get("subject_key") != f"kungfu:{assignment_id}"
    ]
    if conflicting:
        raise ValueError(
            f"assignment_id already belongs to another source authority: {assignment_id}"
        )
    if status not in {"proposed", "active", "blocked", "waiting-for-decision"}:
        raise ValueError(
            "native Assignment status is not in the v1 responsibility vocabulary"
        )
    parent_assignment_id = (
        _stable_id(parent_assignment_id, "parent_assignment_id")
        if parent_assignment_id.strip()
        else ""
    )
    dependencies = sorted(
        {_stable_id(str(dependency), "depends_on") for dependency in (depends_on or [])}
    )
    if assignment_id in dependencies:
        raise ValueError("an Assignment cannot depend on itself")
    owning_workspace_identity_root = _root_id(
        owning_workspace_identity_root,
        "owning_workspace_identity_root",
    )
    if (parent_assignment_id or dependencies) and not owning_workspace_identity_root:
        raise ValueError(
            "local parent/dependency shorthand requires owning_workspace_identity_root"
        )
    workspace_cut_root = str(
        state_for_refs.get("query_proof_root")
        or _sha256_root(
            {
                "schema": "kungfu.assignment-graph.local-cut/v1",
                "assignment_versions": sorted(
                    str(row.get("sealed_identity", {}).get("payload_hash") or "")
                    for row in existing_assignments
                ),
            }
        )
    )
    local_initiative_ref = explicit_initiative_ref
    if not local_initiative_ref and owning_workspace_identity_root:
        local_initiative_ref = _local_work_ref(
            runtime_dir,
            workspace_identity_root=owning_workspace_identity_root,
            object_kind="initiative",
            object_id=_stable_id(initiative_id, "initiative_id"),
            records=list_initiatives(runtime_dir),
            cut_root=workspace_cut_root,
        )
    explicit_parent_ref = _validated_work_ref(
        parent_assignment_ref,
        object_kind="assignment",
        field="parent_assignment_ref",
    )
    if parent_assignment_id and explicit_parent_ref:
        raise ValueError(
            "pass parent_assignment_id shorthand or parent_assignment_ref, not both"
        )
    resolved_parent_ref = explicit_parent_ref
    if parent_assignment_id:
        resolved_parent_ref = _local_work_ref(
            runtime_dir,
            workspace_identity_root=owning_workspace_identity_root,
            object_kind="assignment",
            object_id=parent_assignment_id,
            records=existing_assignments,
            cut_root=workspace_cut_root,
        )
    resolved_dependency_refs = [
        _validated_work_ref(
            dict(value),
            object_kind="assignment",
            field="dependency_refs",
        )
        for value in (dependency_refs or [])
    ]
    if dependencies and resolved_dependency_refs:
        raise ValueError("pass depends_on shorthand or dependency_refs, not both")
    unresolved_dependency_ids: list[str] = []
    if dependencies:
        for dependency in dependencies:
            matches = [
                row
                for row in existing_assignments
                if str(row.get("assignment_id") or row.get("assignment_id") or "")
                == dependency
            ]
            if len(matches) > 1:
                raise ValueError(
                    f"local assignment shorthand resolves more than once: {dependency}"
                )
            if not matches:
                unresolved_dependency_ids.append(dependency)
                continue
            resolved_dependency_refs.append(
                _local_work_ref(
                    runtime_dir,
                    workspace_identity_root=owning_workspace_identity_root,
                    object_kind="assignment",
                    object_id=dependency,
                    records=matches,
                    cut_root=workspace_cut_root,
                )
            )
    dependency_keys = {
        (
            row["workspace_identity_root"],
            row["object_kind"],
            row["subject"],
        )
        for row in resolved_dependency_refs
    }
    if len(dependency_keys) != len(resolved_dependency_refs):
        raise ValueError("dependency_refs must be unique")
    acceptance_root = _root_id(acceptance_root, "acceptance_root")
    context_root = _root_id(context_root, "context_root")
    context_binding = dict(context_binding or {})
    if context_binding:
        required_context_fields = {
            "schema",
            "status",
            "context_root",
            "cut_root",
            "route_id",
            "route_root",
            "authority_root",
            "task_envelope_root",
            "route_receipt_root",
            "chart_root",
            "policy_root",
            "omissions_root",
            "budget",
        }
        if set(context_binding) != required_context_fields:
            raise ValueError("context_binding must contain the exact v1 field set")
        if (
            context_binding.get("schema") != "xinfa.go-context-binding/v1"
            or context_binding.get("status") != "complete"
        ):
            raise ValueError("context_binding must be a complete Xinfa v1 binding")
        for field in (
            "context_root",
            "cut_root",
            "route_root",
            "authority_root",
            "task_envelope_root",
            "route_receipt_root",
            "chart_root",
            "policy_root",
            "omissions_root",
        ):
            context_binding[field] = _root_id(
                str(context_binding.get(field) or ""),
                f"context_binding.{field}",
                required=True,
            )
        if context_binding["context_root"] != context_root:
            raise ValueError("context_binding.context_root must equal context_root")
        if not str(context_binding.get("route_id") or "").strip():
            raise ValueError("context_binding.route_id is required")
        budget = context_binding.get("budget")
        if not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0:
            raise ValueError("context_binding.budget must be a positive integer")
    project_cut_root = _root_id(project_cut_root, "project_cut_root")
    episode_roots = sorted(
        {
            _root_id(str(root), "evidence_episode_root", required=True)
            for root in (evidence_episode_roots or [])
        }
    )
    request_root = _root_id(request_root, "request_root")
    capture_roots = sorted(
        {
            _root_id(str(root), "capture_receipt_root", required=True)
            for root in (capture_receipt_roots or [])
        }
    )
    work_definition = dict(work_definition or {})
    source_id = _native_source(actor_type)
    subject_key = f"kungfu:{assignment_id}"
    record = {
        "assignment_id": assignment_id,
        "title": title.strip(),
        "objective": objective.strip(),
        "status": status,
        "initiative_id": initiative_subject.split(":", 1)[-1],
        "initiative_subject": initiative_subject,
        "initiative_ref": local_initiative_ref,
        "owning_workspace_identity_root": owning_workspace_identity_root,
        "actor": actor.strip(),
        "actor_type": actor_type,
        "parent_assignment_id": "",
        "parent_assignment_ref": resolved_parent_ref,
        "depends_on": [],
        "unresolved_dependency_ids": unresolved_dependency_ids,
        "dependency_refs": sorted(
            resolved_dependency_refs,
            key=lambda row: (
                row["workspace_identity_root"],
                row["subject"],
                row["version_root"],
            ),
        ),
        "responsibility": responsibility.strip() or actor.strip(),
        "acceptance_root": acceptance_root,
        "input_context_root": context_root,
        "context_binding": context_binding,
        "context_binding_root": _sha256_root(context_binding)
        if context_binding
        else "",
        "project_cut_root": project_cut_root,
        "evidence_episode_roots": episode_roots,
        "request_root": request_root,
        "capture_receipt_roots": capture_roots,
        "work_definition": work_definition,
        "work_definition_root": _sha256_root(work_definition)
        if work_definition
        else "",
        "orchestration_phase": "admitted",
    }
    if not record["title"] or not record["objective"] or not record["actor"]:
        raise ValueError("title, objective, and actor are required")
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": record["actor"],
        },
        "links": {"initiative_id": initiative_subject},
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment",
        surface_id=ASSIGNMENT_SURFACE_ID,
        subject_key=subject_key,
        source_id=source_id,
        payload=payload,
        system_time=system_time,
    )
    return {
        "schema": "kungfu.initiative-assignment.assignment-write/v1",
        "authority_mode": "kungfu-native",
        "initiative_subject": initiative_subject,
        "assignment_subject": subject_key,
        "receipt": receipt,
    }


def list_assignment_relation_events(
    runtime_dir: str,
    *,
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    """List domain relation events without projecting them as Assignments."""

    return [
        record
        for record in list_domain_records(
            runtime_dir,
            surface_ids={RELATION_SURFACE_ID},
            cut_system_time=cut_system_time,
        )
        if record.get("claim_type") == ASSIGNMENT_RELATION_EVENT
    ]


def assignment_relations(
    runtime_dir: str,
    *,
    cut_system_time: int = 0,
) -> list[dict[str, Any]]:
    """Return unique verified relation bodies observed in this workspace."""

    from kungfu.workspace_federation import build_relation

    relations: dict[str, dict[str, Any]] = {}
    for event in list_assignment_relation_events(
        runtime_dir, cut_system_time=cut_system_time
    ):
        relation = event.get("relation")
        if not isinstance(relation, dict):
            continue
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
        relations[verified["relation_root"]] = verified
    return [relations[root] for root in sorted(relations)]


def append_assignment_relation_event(
    runtime_dir: str,
    *,
    workspace_identity_root: str,
    relation: dict[str, Any],
    event_type: str,
    actor: str,
    predecessor_event_roots: list[str] | None = None,
    evidence_roots: list[str] | None = None,
    known_relations: list[dict[str, Any]] | None = None,
    actor_type: str = "agent",
    system_time: int = 0,
) -> dict[str, Any]:
    """Append one independently retryable cross-workspace relation fact."""

    from kungfu.workspace_federation import (
        build_relation,
        parse_work_ref,
        qualify_assignment_graph,
    )

    _ensure_native_write_allowed(runtime_dir)
    _ensure_contract(runtime_dir, system_time or time.time_ns())
    workspace_identity_root = _root_id(
        workspace_identity_root,
        "workspace_identity_root",
        required=True,
    )
    if event_type not in ASSIGNMENT_RELATION_EVENTS:
        raise ValueError("unknown Assignment relation event type")
    actor = actor.strip()
    if not actor:
        raise ValueError("relation event actor is required")
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
        raise ValueError("Assignment relation root does not verify")
    source = parse_work_ref(verified["source"])
    target = parse_work_ref(verified["target"])
    source_events = {
        "delegation-offer",
        "source-observation",
        "parent-admission",
        "parent-assessment",
        "parent-decision",
    }
    local = source if event_type in source_events else target
    if local.workspace_identity_root != workspace_identity_root:
        raise ValueError("relation event is routed to the wrong owning workspace")
    predecessor_roots = sorted(
        {
            _root_id(str(root), "predecessor_event_root", required=True)
            for root in (predecessor_event_roots or [])
        }
    )
    required_predecessor = {
        "destination-acceptance",
        "source-observation",
        "child-contribution",
        "parent-admission",
        "parent-assessment",
        "parent-decision",
    }
    if event_type in required_predecessor and not predecessor_roots:
        raise ValueError(f"{event_type} requires a predecessor event root")
    event_evidence = sorted(
        {
            _root_id(str(root), "relation_event_evidence_root", required=True)
            for root in (evidence_roots or [])
        }
    )
    if event_type == "delegation-offer":
        graph_relations = {
            str(row.get("relation_root") or ""): row
            for row in (known_relations or assignment_relations(runtime_dir))
        }
        graph_relations[verified["relation_root"]] = verified
        qualification = qualify_assignment_graph(
            [graph_relations[root] for root in sorted(graph_relations)]
        )
        if not qualification["ok"]:
            issue = qualification["issues"][0]
            raise ValueError(
                f"Assignment relation qualification failed: {issue['code']}"
            )
    else:
        qualification = qualify_assignment_graph([verified])
        if not qualification["ok"]:
            raise ValueError("Assignment relation does not qualify")
    relation_qualification = qualify_assignment_graph([verified])
    if not relation_qualification["ok"]:
        raise ValueError("Assignment relation does not qualify")
    basis = {
        "claim_type": ASSIGNMENT_RELATION_EVENT,
        "event_type": event_type,
        "workspace_identity_root": workspace_identity_root,
        "relation_root": verified["relation_root"],
        "predecessor_event_roots": predecessor_roots,
        "evidence_roots": event_evidence,
        "actor": actor,
    }
    event_root = _sha256_root(basis)
    record = {
        **basis,
        "event_root": event_root,
        "relation": verified,
        # Persist only the stable qualification of this relation. The broader
        # graph qualification can evolve as other relations become visible and
        # therefore belongs in the write receipt, not in retry identity.
        "qualification_root": relation_qualification["qualification_root"],
    }
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor,
        },
        "links": {
            "assignment_id": local.subject,
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment-relation",
        surface_id=RELATION_SURFACE_ID,
        subject_key=f"kungfu:assignment-relation:{event_root[7:]}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.assignment-graph.event-write/v1",
        "event": record,
        "receipt": receipt,
        "graph_qualification": qualification,
        "next_action": {
            "delegation-offer": "destination-acceptance",
            "destination-acceptance": "source-observation",
            "source-observation": "child-contribution",
            "child-contribution": "parent-admission",
            "parent-admission": "parent-assessment",
            "parent-assessment": "parent-decision",
            "parent-decision": None,
        }[event_type],
    }


def claim_assignment_execution(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    owner: str,
    agent: str,
    slot: str,
    lease_id: str,
    lease_expires_at: str,
    authorized_by: str,
    attempt_id: str = "",
    grant_scope: str = "assignment-execution",
    actor_type: str = "agent",
    storage_source_id: str = "kungfu",
    system_time: int = 0,
) -> dict[str, Any]:
    """Append a bounded execution lease; slot identity never grants authority."""

    _ensure_native_write_allowed(runtime_dir)
    from . import native_state

    state = native_state.query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment = native_state.assignment_row(state, assignment_id)
    values = {
        "owner": owner.strip(),
        "agent": agent.strip(),
        "slot": slot.strip(),
        "lease_id": lease_id.strip(),
        "authorized_by": authorized_by.strip(),
        "grant_scope": grant_scope.strip(),
    }
    if not all(values.values()):
        raise ValueError(
            "owner, agent, slot, lease_id, authorized_by, and grant_scope are required"
        )
    _stable_id(values["lease_id"], "lease_id")
    expiry = native_state.parse_lease_expiry(lease_expires_at)
    now = datetime.now(expiry.tzinfo)
    if expiry <= now:
        raise ValueError("execution lease must expire in the future")
    claim_id = f"execution-{_sha256_root({**values, 'assignment': assignment_id, 'expires': lease_expires_at})[7:31]}"
    record = {
        "claim_id": claim_id,
        "attempt_id": _stable_id(attempt_id or claim_id, "attempt_id"),
        "claim_type": ASSIGNMENT_EXECUTION_CLAIM,
        "assignment_id": _stable_id(assignment_id, "assignment_id"),
        **values,
        "lease_expires_at": expiry.isoformat().replace("+00:00", "Z"),
        "authority_semantics": {
            "owner": "accountability-and-cost-principal",
            "agent": "acting-runtime-identity",
            "slot": "execution-lane-not-authority",
            "lease": "bounded-task-authorization",
        },
    }
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": values["agent"],
        },
        "links": {
            "initiative_id": state["initiative_subject"],
            "assignment_id": str(assignment["subject_key"]),
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="assignment-execution-claim",
        surface_id=CLAIM_SURFACE_ID,
        subject_key=f"kungfu:assignment-execution:{record['claim_id']}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.assignment-orchestration.execution-claim/v1",
        "claim": record,
        "receipt": receipt,
    }
