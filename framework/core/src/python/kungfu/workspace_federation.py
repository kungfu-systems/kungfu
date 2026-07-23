# SPDX-License-Identifier: Apache-2.0

"""Workspace-qualified Assignment graph and read-only federation contracts.

Paths are machine-local locators only.  Portable WorkRef and relation roots
contain workspace identity roots plus immutable object/query coordinates.
Federated reads preserve one independently verifiable component cut per
workspace and never claim an atomic global snapshot.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
import re
from typing import Any, Callable, Iterable, Literal, Mapping

from kungfu.workspace import (
    WorkspaceIdentity,
    inspect_workspace,
    load_workspace_catalog,
    semantic_root,
)


WORK_REF_SCHEMA = "kungfu.assignment-graph.work-ref/v1"
RELATION_SCHEMA = "kungfu.assignment-graph.relation/v1"
RELATION_QUALIFICATION_SCHEMA = "kungfu.assignment-graph.qualification/v1"
COMPONENT_CUT_SCHEMA = "kungfu.workspace-federation.component-cut/v1"
QUERY_SCHEMA = "kungfu.workspace-federation.query/v1"
QUERY_PROOF_SCHEMA = "kungfu.workspace-federation.query-proof/v1"
TRAVERSAL_SCHEMA = "kungfu.assignment-graph.traversal/v1"

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_SUBJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")

ObjectKind = Literal["initiative", "assignment"]
QueryScope = Literal["local", "related", "all"]
TraversalDirection = Literal["forward", "backward", "both"]

# Acyclicity is relation-specific.  Symmetric descriptive relations may form
# arbitrary graphs and must never be rejected by a generic DAG rule.
RELATION_TYPES: dict[str, dict[str, Any]] = {
    "delegates-to": {
        "directed": True,
        "symmetric": False,
        "transitive": False,
        "revocable": True,
        "acyclic": True,
    },
    "decomposes-into": {
        "directed": True,
        "symmetric": False,
        "transitive": True,
        "revocable": True,
        "acyclic": True,
    },
    "depends-on": {
        "directed": True,
        "symmetric": False,
        "transitive": True,
        "revocable": True,
        "acyclic": True,
    },
    "continues-as": {
        "directed": True,
        "symmetric": False,
        "transitive": True,
        "revocable": False,
        "acyclic": True,
    },
    "supersedes": {
        "directed": True,
        "symmetric": False,
        "transitive": True,
        "revocable": False,
        "acyclic": True,
    },
    "contributes-to": {
        "directed": True,
        "symmetric": False,
        "transitive": False,
        "revocable": True,
        "acyclic": False,
    },
    "related-to": {
        "directed": False,
        "symmetric": True,
        "transitive": False,
        "revocable": True,
        "acyclic": False,
    },
    "conflicts-with": {
        "directed": False,
        "symmetric": True,
        "transitive": False,
        "revocable": True,
        "acyclic": False,
    },
    "shares-evidence-with": {
        "directed": False,
        "symmetric": True,
        "transitive": False,
        "revocable": True,
        "acyclic": False,
    },
}


@dataclass(frozen=True)
class WorkRef:
    workspace_identity_root: str
    object_kind: ObjectKind
    subject: str
    version_root: str
    cut_root: str

    def as_dict(self) -> dict[str, str]:
        return {
            "schema": WORK_REF_SCHEMA,
            "workspace_identity_root": self.workspace_identity_root,
            "object_kind": self.object_kind,
            "subject": self.subject,
            "version_root": self.version_root,
            "cut_root": self.cut_root,
        }

    @property
    def node_key(self) -> str:
        """Stable graph-node identity; version and cut remain edge evidence."""

        return f"{self.workspace_identity_root}|{self.object_kind}|{self.subject}"


def _root(value: Any, field: str) -> str:
    text = str(value or "")
    if not _ROOT.fullmatch(text):
        raise ValueError(f"{field} must be a sha256 content root")
    return text


def build_work_ref(
    identity: WorkspaceIdentity,
    *,
    object_kind: ObjectKind,
    subject: str,
    version_root: str,
    cut_root: str,
) -> WorkRef:
    if identity.identity_state != "qualified" or not identity.identity_root:
        raise ValueError("WorkRef requires a qualified owning workspace")
    if object_kind not in {"initiative", "assignment"}:
        raise ValueError("WorkRef object_kind must be initiative or assignment")
    subject = subject.strip()
    if not _SUBJECT.fullmatch(subject):
        raise ValueError("WorkRef subject is not canonical")
    return WorkRef(
        workspace_identity_root=_root(
            identity.identity_root, "workspace_identity_root"
        ),
        object_kind=object_kind,
        subject=subject,
        version_root=_root(version_root, "version_root"),
        cut_root=_root(cut_root, "cut_root"),
    )


def parse_work_ref(value: Mapping[str, Any]) -> WorkRef:
    if (
        set(value)
        != {
            "schema",
            "workspace_identity_root",
            "object_kind",
            "subject",
            "version_root",
            "cut_root",
        }
        or value.get("schema") != WORK_REF_SCHEMA
    ):
        raise ValueError("WorkRef must contain the exact v1 field set")
    kind = str(value["object_kind"])
    if kind not in {"initiative", "assignment"}:
        raise ValueError("WorkRef object_kind must be initiative or assignment")
    subject = str(value["subject"]).strip()
    if not _SUBJECT.fullmatch(subject):
        raise ValueError("WorkRef subject is not canonical")
    return WorkRef(
        workspace_identity_root=_root(
            value["workspace_identity_root"], "workspace_identity_root"
        ),
        object_kind=kind,  # type: ignore[arg-type]
        subject=subject,
        version_root=_root(value["version_root"], "version_root"),
        cut_root=_root(value["cut_root"], "cut_root"),
    )


def build_relation(
    relation_type: str,
    source: WorkRef | Mapping[str, Any],
    target: WorkRef | Mapping[str, Any],
    *,
    evidence_roots: Iterable[str] = (),
    state: Literal["proposed", "accepted", "revoked"] = "accepted",
) -> dict[str, Any]:
    if relation_type not in RELATION_TYPES:
        raise ValueError(f"unknown Assignment relation type: {relation_type}")
    left = source if isinstance(source, WorkRef) else parse_work_ref(source)
    right = target if isinstance(target, WorkRef) else parse_work_ref(target)
    if left.node_key == right.node_key:
        raise ValueError("Assignment graph relations cannot be self-referential")
    if state not in {"proposed", "accepted", "revoked"}:
        raise ValueError("relation state is not in the v1 vocabulary")
    specification = RELATION_TYPES[relation_type]
    if specification["symmetric"] and right.node_key < left.node_key:
        left, right = right, left
    evidence = sorted({_root(value, "evidence_root") for value in evidence_roots})
    body = {
        "schema": RELATION_SCHEMA,
        "relation_type": relation_type,
        "source": left.as_dict(),
        "target": right.as_dict(),
        "state": state,
        "evidence_roots": evidence,
        "semantics": dict(specification),
    }
    return {**body, "relation_root": semantic_root(body)}


def qualify_assignment_graph(
    relations: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    normalized: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    seen_roots: set[str] = set()
    for index, relation in enumerate(relations):
        try:
            body = build_relation(
                str(relation.get("relation_type") or ""),
                relation.get("source") or {},
                relation.get("target") or {},
                evidence_roots=relation.get("evidence_roots") or [],
                state=str(relation.get("state") or "accepted"),  # type: ignore[arg-type]
            )
            declared_root = str(relation.get("relation_root") or "")
            if declared_root and declared_root != body["relation_root"]:
                raise ValueError("relation_root does not verify")
            if body["relation_root"] in seen_roots:
                raise ValueError("duplicate relation")
            seen_roots.add(body["relation_root"])
            normalized.append(body)
        except (TypeError, ValueError) as error:
            issues.append(
                {
                    "code": "relation-invalid",
                    "index": index,
                    "message": str(error),
                }
            )

    for relation_type, specification in RELATION_TYPES.items():
        if not specification["acyclic"]:
            continue
        adjacency: dict[str, set[str]] = {}
        for relation in normalized:
            if (
                relation["relation_type"] != relation_type
                or relation["state"] == "revoked"
            ):
                continue
            source = parse_work_ref(relation["source"]).node_key
            target = parse_work_ref(relation["target"]).node_key
            adjacency.setdefault(source, set()).add(target)
        cycle = _find_cycle(adjacency)
        if cycle:
            issues.append(
                {
                    "code": "relation-cycle",
                    "relation_type": relation_type,
                    "nodes": cycle,
                }
            )

    proof = {
        "schema": RELATION_QUALIFICATION_SCHEMA,
        "relation_roots": sorted(row["relation_root"] for row in normalized),
        "issues": issues,
    }
    return {
        **proof,
        "ok": not issues,
        "qualification_root": semantic_root(proof),
    }


def _find_cycle(adjacency: Mapping[str, set[str]]) -> list[str]:
    visiting: set[str] = set()
    visited: set[str] = set()
    trail: list[str] = []

    def visit(node: str) -> list[str]:
        if node in visiting:
            start = trail.index(node)
            return trail[start:] + [node]
        if node in visited:
            return []
        visiting.add(node)
        trail.append(node)
        for target in sorted(adjacency.get(node, set())):
            cycle = visit(target)
            if cycle:
                return cycle
        trail.pop()
        visiting.remove(node)
        visited.add(node)
        return []

    for node in sorted(adjacency):
        cycle = visit(node)
        if cycle:
            return cycle
    return []


WorkspaceLoader = Callable[[WorkspaceIdentity], dict[str, Any]]


def query_federation(
    current: WorkspaceIdentity,
    *,
    scope: QueryScope = "local",
    start_ref: WorkRef | Mapping[str, Any] | None = None,
    direction: TraversalDirection = "both",
    relation_types: Iterable[str] | None = None,
    config_home: str | None = None,
    env: Mapping[str, str] | None = None,
    loader: WorkspaceLoader | None = None,
) -> dict[str, Any]:
    """Read local, related, or all known work without mutating any workspace."""

    if scope not in {"local", "related", "all"}:
        raise ValueError("federation scope must be local, related, or all")
    loader = loader or _load_component
    catalog = load_workspace_catalog(config_home, env=env)
    identities: dict[str, WorkspaceIdentity] = {}

    def include(identity: WorkspaceIdentity | None) -> None:
        if identity is None:
            return
        key = identity.identity_root or identity.workspace_id
        identities.setdefault(key, identity)

    include(current)
    if scope == "all":
        include(inspect_workspace(home=True, env=env))
        for entry in catalog["entries"]:
            if entry.get("workspace_kind") == "home":
                include(inspect_workspace(home=True, env=env))
            else:
                include(_identity_from_catalog_entry(entry, env=env))

    components = [_safe_component(identity, loader) for identity in identities.values()]
    if scope == "related":
        related_roots = {
            str(endpoint.get("workspace_identity_root") or "")
            for component in components
            for relation in component.get("relations", [])
            for endpoint in (relation.get("source", {}), relation.get("target", {}))
        }
        for entry in catalog["entries"]:
            if entry.get("identity_root") not in related_roots:
                continue
            include(_identity_from_catalog_entry(entry, env=env))
        components = [
            _safe_component(identity, loader) for identity in identities.values()
        ]

    known_roots = {
        component["workspace"]["identity_root"]
        for component in components
        if component["workspace"].get("identity_root")
    }
    unresolved: list[dict[str, Any]] = []
    for component in components:
        for relation in component.get("relations", []):
            for side in ("source", "target"):
                endpoint = relation.get(side) or {}
                root = str(endpoint.get("workspace_identity_root") or "")
                if root and root not in known_roots:
                    unresolved.append(
                        {
                            "relation_root": relation.get("relation_root"),
                            "side": side,
                            "workspace_identity_root": root,
                        }
                    )

    if scope == "all":
        projected_roots = {
            component["workspace"].get("identity_root") for component in components
        }
        for entry in catalog["entries"]:
            if entry["identity_root"] in projected_roots:
                continue
            components.append(_unavailable_component(entry))

    components.sort(
        key=lambda row: (
            str(row["workspace"].get("identity_root") or ""),
            str(row["workspace"].get("workspace_id") or ""),
        )
    )
    observed_at = _now()
    proof = {
        "schema": QUERY_PROOF_SCHEMA,
        "scope": scope,
        "component_cuts": [
            {
                "workspace_identity_root": row["workspace"].get("identity_root"),
                "availability": row["availability"],
                "observed_at": row["observed_at"],
                "cut_root": row.get("cut_root"),
                "query_proof_root": row.get("query_proof_root"),
            }
            for row in components
        ],
        "catalog_issues": catalog["issues"],
        "unresolved_references": unresolved,
        "atomic_global_cut": False,
    }
    return {
        "schema": QUERY_SCHEMA,
        "scope": scope,
        "observed_at": observed_at,
        "components": components,
        "proof": {**proof, "proof_root": semantic_root(proof)},
        "authority": "component-workspace-authorities",
        "atomic_global_cut": False,
        "writes": [],
        **(
            {
                "traversal": traverse_assignment_graph(
                    components,
                    start_ref,
                    direction=direction,
                    relation_types=relation_types,
                )
            }
            if start_ref is not None
            else {}
        ),
    }


def _identity_from_catalog_entry(
    entry: Mapping[str, Any],
    *,
    env: Mapping[str, str] | None,
) -> WorkspaceIdentity | None:
    """Resolve a locator only when it still names the Catalog identity."""

    locator = entry.get("locator")
    if not isinstance(locator, str) or not locator:
        return None
    try:
        identity = inspect_workspace(locator, env=env)
    except (OSError, ValueError):
        return None
    if identity is None:
        return None
    expected_state = str(entry.get("identity_state") or "qualified")
    if expected_state == "qualified":
        return (
            identity
            if identity.identity_state == "qualified"
            and identity.identity_root == entry.get("identity_root")
            else None
        )
    return identity if identity.identity_state == "locator-candidate" else None


def traverse_assignment_graph(
    components: Iterable[Mapping[str, Any]],
    start_ref: WorkRef | Mapping[str, Any],
    *,
    direction: TraversalDirection = "both",
    relation_types: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Traverse verified relation endpoints without resolving paths or writing."""

    if direction not in {"forward", "backward", "both"}:
        raise ValueError("traversal direction must be forward, backward, or both")
    start = start_ref if isinstance(start_ref, WorkRef) else parse_work_ref(start_ref)
    selected_types = set(relation_types or RELATION_TYPES)
    unknown_types = selected_types - set(RELATION_TYPES)
    if unknown_types:
        raise ValueError(
            f"unknown Assignment relation type: {sorted(unknown_types)[0]}"
        )

    relations: dict[str, dict[str, Any]] = {}
    for component in components:
        for relation in component.get("relations", []):
            verified = build_relation(
                str(relation.get("relation_type") or ""),
                relation.get("source") or {},
                relation.get("target") or {},
                evidence_roots=relation.get("evidence_roots") or [],
                state=str(relation.get("state") or "accepted"),  # type: ignore[arg-type]
            )
            if verified["relation_root"] != relation.get("relation_root"):
                raise ValueError("traversed Assignment relation root does not verify")
            if (
                verified["relation_type"] in selected_types
                and verified["state"] != "revoked"
            ):
                relations[verified["relation_root"]] = verified

    adjacency: dict[str, list[tuple[str, str, WorkRef]]] = {}
    for relation_root, relation in relations.items():
        source = parse_work_ref(relation["source"])
        target = parse_work_ref(relation["target"])
        if direction in {"forward", "both"}:
            adjacency.setdefault(source.node_key, []).append(
                (target.node_key, relation_root, target)
            )
        if direction in {"backward", "both"}:
            adjacency.setdefault(target.node_key, []).append(
                (source.node_key, relation_root, source)
            )

    references = {start.node_key: start}
    visited = {start.node_key}
    relation_roots: set[str] = set()
    pending = [start.node_key]
    while pending:
        node = pending.pop(0)
        for target_key, relation_root, target in sorted(
            adjacency.get(node, []),
            key=lambda row: (row[0], row[1]),
        ):
            relation_roots.add(relation_root)
            references.setdefault(target_key, target)
            if target_key not in visited:
                visited.add(target_key)
                pending.append(target_key)

    return {
        "schema": TRAVERSAL_SCHEMA,
        "start": start.as_dict(),
        "direction": direction,
        "relation_types": sorted(selected_types),
        "nodes": [
            references[node].as_dict() for node in sorted(visited) if node in references
        ],
        "relation_roots": sorted(relation_roots),
        "writes": [],
    }


def _safe_component(
    identity: WorkspaceIdentity,
    loader: WorkspaceLoader,
) -> dict[str, Any]:
    if identity.workspace_kind == "project" and (
        not identity.workspace_root or not os.path.isdir(identity.workspace_root)
    ):
        return _unavailable_component(identity.as_dict())
    try:
        component = loader(identity)
        return {
            **component,
            "workspace": identity.as_dict(),
            "availability": component.get("availability", "available"),
            "observed_at": _now(),
        }
    except (OSError, RuntimeError, ValueError) as error:
        return {
            "workspace": identity.as_dict(),
            "availability": "degraded",
            "observed_at": _now(),
            "stale": True,
            "cut_root": "",
            "query_proof_root": "",
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [{"code": "component-query-failed", "message": str(error)}],
        }


def _load_component(identity: WorkspaceIdentity) -> dict[str, Any]:
    """Load one Mission Control component through its own runtime authority."""

    runtime_dir = os.path.join(identity.data_home, "runtime")
    if not os.path.isdir(runtime_dir):
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
        return {
            "availability": "available",
            "stale": False,
            "cut_root": root,
            "query_proof_root": root,
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [],
        }

    from kungfu.atlas import mission_control
    from kungfu.storage import service as storage_service

    initiatives = mission_control.list_initiatives(runtime_dir)
    assignments = mission_control.list_assignments(runtime_dir)
    relations = mission_control.assignment_relations(runtime_dir)
    materials = storage_service.fact_material_list(runtime_dir)
    fact_versions = sorted(
        str(row.get("payload_hash") or "")
        for row in materials.get("state", {}).get("canonical_facts", [])
    )
    initiative_versions = sorted(
        str(row.get("sealed_identity", {}).get("payload_hash") or "")
        for row in initiatives
    )
    assignment_versions = sorted(
        str(row.get("sealed_identity", {}).get("payload_hash") or "")
        for row in assignments
    )
    relation_roots = sorted(str(row.get("relation_root") or "") for row in relations)
    body = {
        "schema": COMPONENT_CUT_SCHEMA,
        "workspace_identity_root": identity.identity_root,
        "state": "live-runtime",
        "initiative_versions": initiative_versions,
        "assignment_versions": assignment_versions,
        "relation_roots": relation_roots,
        "fact_versions": fact_versions,
    }
    root = semantic_root(body)
    return {
        "availability": "available",
        "stale": False,
        "cut_root": root,
        "query_proof_root": root,
        "initiatives": [
            _record_projection(identity, "initiative", row, root) for row in initiatives
        ],
        "assignments": [
            _record_projection(
                identity,
                "assignment",
                row,
                root,
                lifecycle=_assignment_lifecycle(runtime_dir, row),
            )
            for row in assignments
        ],
        "relations": relations,
        "problems": [],
    }


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


def _assignment_lifecycle(
    runtime_dir: str,
    record: Mapping[str, Any],
) -> dict[str, Any]:
    from kungfu.atlas import mission_control

    status = mission_control.assignment_orchestration_status(
        runtime_dir,
        initiative_id=str(record.get("initiative_id") or ""),
        assignment_id=str(record.get("assignment_id") or record.get("goal_id") or ""),
        storage_source_id="atlas",
    )
    return assignment_lifecycle_projection(record, status)


def assignment_lifecycle_projection(
    record: Mapping[str, Any],
    status: Mapping[str, Any],
) -> dict[str, Any]:
    """Project Portfolio completion without promoting a claim into authority."""

    from kungfu import assignment_orchestration

    decisions = list(status.get("continuation_decisions") or [])
    completion_claims = list(status.get("completion_claims") or [])
    accepted = bool(
        decisions and str(decisions[-1].get("action") or "") in {"approve", "close"}
    )
    settled_cut_roots = {
        str(row.get("project_cut_root") or "")
        for row in completion_claims
        if str(row.get("project_cut_root") or "")
        and str(row.get("project_cut_receipt_root") or "")
    }
    pending_cut_roots = {
        str(row.get("project_cut_root") or "")
        for row in completion_claims
        if str(row.get("project_cut_root") or "")
        and not str(row.get("project_cut_receipt_root") or "")
    }
    settlement_satisfied = bool(settled_cut_roots)
    globally_completed = accepted and settlement_satisfied
    return {
        "orchestration_phase": status["phase"],
        "portfolio_state": portfolio_state(
            record,
            status,
            accepted=accepted,
            settlement_satisfied=settlement_satisfied,
        ),
        "completion_claim_count": status["completion_claim_count"],
        "independent_review_count": status["independent_review_count"],
        "continuation_decision_count": status["continuation_decision_count"],
        "decision_action": (
            str(decisions[-1].get("action") or "") if decisions else ""
        ),
        "project_cut_settlement": (
            "satisfied"
            if settlement_satisfied
            else ("pending-receipt" if pending_cut_roots else "not-established")
        ),
        "settled_project_cut_roots": sorted(settled_cut_roots),
        "pending_project_cut_roots": sorted(pending_cut_roots),
        "globally_completed": globally_completed,
        "last_verified_cut": status["query_proof_root"],
        "next_actions": assignment_orchestration.next_actions(status),
    }


def portfolio_state(
    record: Mapping[str, Any],
    status: Mapping[str, Any],
    *,
    accepted: bool,
    settlement_satisfied: bool,
) -> str:
    if str(record.get("status") or "").lower() == "blocked":
        return "blocked"
    if accepted and settlement_satisfied:
        return "completed"
    if accepted:
        return "awaiting-settlement"
    if int(status.get("independent_review_count") or 0):
        return "awaiting-decision"
    if int(status.get("completion_claim_count") or 0):
        return "awaiting-review"
    return "open"


def _unavailable_component(entry: Mapping[str, Any]) -> dict[str, Any]:
    workspace = {
        "schema": "kungfu.workspace.identity/v1",
        "workspace_id": entry.get("workspace_id"),
        "identity_root": entry.get("identity_root"),
        "identity_state": entry.get("identity_state") or "qualified",
        "workspace_kind": entry.get("workspace_kind"),
        "workspace_root": entry.get("locator"),
        "display_path": entry.get("locator") or "Home",
        "data_home": entry.get("data_home"),
        "initialized": False,
        "state": "unavailable",
        "resolution_reason": "catalog-locator-unavailable",
    }
    return {
        "workspace": workspace,
        "availability": "unavailable",
        "observed_at": _now(),
        "catalog_observed_at": entry.get("observed_at"),
        "stale": True,
        "cut_root": "",
        "query_proof_root": "",
        "initiatives": [],
        "assignments": [],
        "relations": [],
        "problems": [
            {
                "code": "workspace-unavailable",
                "locator": entry.get("locator"),
            }
        ],
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
