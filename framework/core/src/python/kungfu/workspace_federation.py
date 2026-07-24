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
import json
import os
import re
from pathlib import Path
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
COMPONENT_ENVELOPE_SCHEMA = "kungfu.workspace-federation.component-envelope/v1"
QUERY_SCHEMA = "kungfu.workspace-federation.query/v1"
QUERY_PROOF_SCHEMA = "kungfu.workspace-federation.query-proof/v1"
QUERY_VERIFICATION_SCHEMA = "kungfu.workspace-federation.query-verification/v1"
GLOBAL_WORK_PROJECTION_SCHEMA = "kungfu.workspace-federation.global-work/v1"
CANONICAL_WORK_SCHEMA = "kungfu.workspace-federation.canonical-work/v1"
CANONICAL_WORK_IDENTITY_SCHEMA = (
    "kungfu.workspace-federation.canonical-work-identity/v1"
)
WORK_OBSERVATION_SCHEMA = "kungfu.workspace-federation.work-observation/v1"
REFERENCE_RESOLUTION_SCHEMA = "kungfu.workspace-federation.reference-resolution/v1"
DOGFOOD_GATE_RECEIPT_SCHEMA = "kungfu.workspace-federation.dogfood-gate-receipt/v1"
DOGFOOD_GATE_VERIFICATION_SCHEMA = (
    "kungfu.workspace-federation.dogfood-gate-verification/v1"
)
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
    include_excluded: bool = False,
    include_settled: bool = False,
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

    excluded_entries = [
        entry for entry in catalog["entries"] if not entry.get("required", True)
    ]
    excluded_roots = {
        str(entry.get("identity_root") or "") for entry in excluded_entries
    }
    if scope != "all" or current.identity_root not in excluded_roots:
        include(current)
    if scope == "all":
        include(inspect_workspace(home=True, env=env))
        for entry in catalog["entries"]:
            if not entry.get("required", True):
                continue
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
            if not entry.get("required", True):
                continue
            if entry.get("identity_root") not in related_roots:
                continue
            include(_identity_from_catalog_entry(entry, env=env))
        components = [
            _safe_component(identity, loader) for identity in identities.values()
        ]

    if scope == "all":
        projected_roots = {
            component["workspace"].get("identity_root") for component in components
        }
        for entry in catalog["entries"]:
            if not entry.get("required", True):
                if include_excluded:
                    components.append(_excluded_component(entry))
                continue
            if entry.get("identity_root") in projected_roots:
                continue
            components.append(_unavailable_component(entry))

    components.sort(
        key=lambda row: (
            str(row["workspace"].get("identity_root") or ""),
            str(row["workspace"].get("workspace_id") or ""),
        )
    )
    projection = _compose_global_work(
        components,
        include_settled=include_settled,
    )
    unresolved = projection["reference_resolution"]["unresolved"]
    component_problems = [
        {
            "workspace_identity_root": (component.get("workspace") or {}).get(
                "identity_root"
            ),
            **dict(problem),
        }
        for component in components
        for problem in component.get("problems") or []
        if problem.get("code") != "unresolved-assignment-dependency"
        and component.get("availability") != "excluded"
    ]
    catalog_after = load_workspace_catalog(config_home, env=env)
    catalog_changed = catalog_after["catalog_cut"] != catalog["catalog_cut"]
    catalog_issues = list(catalog["issues"])
    if catalog_changed:
        catalog_issues.append(
            {
                "code": "catalog-changed-during-query",
                "catalog_cut_before": catalog["catalog_cut"],
                "catalog_cut_after": catalog_after["catalog_cut"],
                "next_action": "retry against a fresh Catalog cut",
            }
        )
    observed_at = _now()
    proof = {
        "schema": QUERY_PROOF_SCHEMA,
        "scope": scope,
        "catalog_cut": catalog["catalog_cut"],
        "catalog_cut_after": catalog_after["catalog_cut"],
        "catalog_epoch": catalog["epoch"],
        "catalog_epoch_after": catalog_after["epoch"],
        "catalog_changed_during_query": catalog_changed,
        "component_cuts": [
            {
                "workspace_identity_root": row["workspace"].get("identity_root"),
                "availability": row["availability"],
                "observed_at": row["observed_at"],
                "cut_root": row.get("cut_root"),
                "query_proof_root": row.get("query_proof_root"),
                "component_result_root": row["envelope"].get("component_result_root"),
                "component_envelope_root": row["envelope"].get("envelope_root"),
            }
            for row in components
        ],
        "catalog_issues": catalog_issues,
        "component_problems": component_problems,
        "excluded_entries": [
            {
                "entry_key": str(
                    entry.get("identity_root") or entry.get("locator_key") or ""
                ),
                "identity_root": entry.get("identity_root"),
                "workspace_id": entry.get("workspace_id"),
                "lifecycle": entry.get("lifecycle"),
                "exclusion_policy": entry.get("exclusion_policy"),
                "observed_at": entry.get("observed_at"),
            }
            for entry in excluded_entries
        ],
        "global_work_projection_root": projection["projection_root"],
        "unresolved_references": unresolved,
        "atomic_global_cut": False,
    }
    result = {
        "schema": QUERY_SCHEMA,
        "scope": scope,
        "observed_at": observed_at,
        "components": components,
        "global_work": projection,
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
    verification = verify_federation_query(result)
    observation_count = projection["observation_count"]
    known_assignments = projection["assignment_observation_count"]
    canonical_count = projection["canonical_work_count"]
    replica_count = projection["replica_count"]
    conflict_count = projection["conflict_count"]
    label_collision_count = projection["label_collision_count"]
    available = sum(
        component.get("availability") == "available" for component in components
    )
    degraded = sum(
        component.get("availability") == "degraded" for component in components
    )
    unavailable = sum(
        component.get("availability") == "unavailable" for component in components
    )
    stale = sum(
        bool(component.get("stale"))
        and component.get("availability") not in {"excluded"}
        for component in components
    )
    excluded = len(excluded_entries)
    tombstoned = sum(
        str((entry.get("lifecycle") or {}).get("state") or "")
        in {"retired", "test-only", "quarantined"}
        for entry in excluded_entries
    )
    unknown = sum(
        component.get("availability") in {"degraded", "unavailable"}
        or bool(component.get("stale"))
        for component in components
        if component.get("availability") != "excluded"
    )
    residual = (
        len(catalog_issues)
        + len(component_problems)
        + len(unresolved)
        + conflict_count
        + len(verification["issues"])
    )
    complete = unknown == 0 and residual == 0
    state = "complete" if complete else "partial" if components else "unavailable"
    next_actions: list[str] = []
    if degraded:
        next_actions.append(
            "inspect degraded component errors and runtime compatibility"
        )
    if unavailable:
        next_actions.append(
            "restore or explicitly rebind unavailable workspace locators"
        )
    if unresolved:
        next_actions.append("resolve retained cross-workspace Work references")
    if component_problems:
        next_actions.append("repair or explicitly exclude invalid component evidence")
    if conflict_count:
        next_actions.append(
            "resolve ambiguous or conflicting canonical Work identities"
        )
    if catalog_changed:
        next_actions.append("retry against a stable Catalog cut")
    if verification["issues"]:
        next_actions.append(
            "reject unverified component envelopes and re-run strict mode"
        )
    result["aggregate"] = {
        "state": state,
        "complete": complete,
        "component_count": len(components),
        "component_observation_count": len(components),
        "work_observation_count": observation_count,
        "canonical_work_count": canonical_count,
        "replica_count": replica_count,
        "conflict_count": conflict_count,
        "label_collision_count": label_collision_count,
        "retained_assignment_state_count": projection[
            "retained_assignment_state_count"
        ],
        "unqualified_retained_assignment_state_count": projection[
            "unqualified_retained_assignment_state_count"
        ],
        "available_component_count": available,
        "degraded_component_count": degraded,
        "unavailable_component_count": unavailable,
        "stale_component_count": stale,
        "excluded_component_count": excluded,
        "tombstoned_component_count": tombstoned,
        "unknown_component_count": unknown,
        "known_assignment_count": known_assignments,
        "unresolved_reference_count": len(unresolved),
        "component_problem_count": len(component_problems),
        "proof_ok": verification["ok"],
        "writes": 0,
        "residual_error_count": residual,
        "false_zero_guard": (
            "unknown-not-empty"
            if known_assignments == 0 and (unknown > 0 or residual > 0)
            else "not-applicable"
        ),
        "next_actions": next_actions,
    }
    result["verification"] = verification
    return result


def _compose_global_work(
    components: Iterable[Mapping[str, Any]],
    *,
    include_settled: bool = False,
) -> dict[str, Any]:
    """Compose root-bound observations into conservative canonical Work rows."""

    component_rows = list(components)
    observations: list[dict[str, Any]] = []
    authority_nodes: dict[str, list[dict[str, Any]]] = {}
    for component in component_rows:
        workspace = component.get("workspace") or {}
        envelope = component.get("envelope") or {}
        for kind, field in (
            ("initiative", "initiatives"),
            ("assignment", "assignments"),
        ):
            for record in component.get(field) or []:
                reference = parse_work_ref((record or {}).get("work_ref") or {})
                display = {
                    "title": str(
                        record.get("title")
                        or record.get("assignment_id")
                        or record.get("initiative_id")
                        or reference.subject
                    ),
                    "status": str(record.get("status") or ""),
                    "portfolio_state": str(
                        (record.get("lifecycle") or {}).get("portfolio_state") or ""
                    ),
                    "next_actions": list(
                        (record.get("lifecycle") or {}).get("next_actions") or []
                    ),
                }
                body = {
                    "schema": WORK_OBSERVATION_SCHEMA,
                    "work_ref": reference.as_dict(),
                    "workspace_id": workspace.get("workspace_id"),
                    "workspace_identity_root": reference.workspace_identity_root,
                    "component_cut_root": component.get("cut_root"),
                    "component_envelope_root": envelope.get("envelope_root"),
                    "profile_root": envelope.get("profile_root"),
                    "availability": component.get("availability"),
                    "stale": bool(component.get("stale")),
                    "display": display,
                }
                observation = {**body, "observation_root": semantic_root(body)}
                observations.append(observation)
                authority_nodes.setdefault(reference.node_key, []).append(observation)

    fold_groups: dict[str, list[dict[str, Any]]] = {}
    for node_key, rows in authority_nodes.items():
        versions = sorted(
            {str(row["work_ref"].get("version_root") or "") for row in rows}
        )
        reference = rows[0]["work_ref"]
        fold_key = (
            f"replica|{reference['object_kind']}|{reference['subject']}|{versions[0]}"
            if len(versions) == 1
            else f"authority|{node_key}"
        )
        fold_groups.setdefault(fold_key, []).extend(rows)

    provisional: list[dict[str, Any]] = []
    for rows in fold_groups.values():
        rows.sort(key=lambda row: row["observation_root"])
        references = [parse_work_ref(row["work_ref"]) for row in rows]
        authority_roots = sorted(
            {reference.workspace_identity_root for reference in references}
        )
        version_roots = sorted({reference.version_root for reference in references})
        reference = references[0]
        provisional.append(
            {
                "schema": CANONICAL_WORK_SCHEMA,
                "object_kind": reference.object_kind,
                "subject": reference.subject,
                "authority_roots": authority_roots,
                "version_roots": version_roots,
                "equivalence": (
                    {
                        "state": "proven-replica",
                        "witness": "shared-version-root",
                        "version_root": version_roots[0],
                    }
                    if len(authority_roots) > 1 and len(version_roots) == 1
                    else {
                        "state": "authority-qualified",
                        "witness": "workspace-identity-root",
                    }
                ),
                "observation_roots": [str(row["observation_root"]) for row in rows],
                "observations": rows,
                "observation_count": len(rows),
                "replica_count": max(0, len(rows) - len(version_roots)),
                "display": rows[0]["display"],
                "conflict": len(version_roots) > 1,
                "conflict_reasons": (
                    ["same-authority-divergent-version"]
                    if len(version_roots) > 1
                    else []
                ),
            }
        )

    by_label: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in provisional:
        by_label.setdefault((row["object_kind"], row["subject"]), []).append(row)

    canonical_rows: list[dict[str, Any]] = []
    node_to_canonical: dict[str, str] = {}
    subject_to_canonical: dict[tuple[str, str], set[str]] = {}
    for row in provisional:
        identity_body = {
            "schema": CANONICAL_WORK_IDENTITY_SCHEMA,
            "object_kind": row["object_kind"],
            "subject": row["subject"],
            "authority_roots": row["authority_roots"],
            "version_roots": row["version_roots"],
            "equivalence": row["equivalence"],
        }
        canonical_root = semantic_root(identity_body)
        canonical_body = {
            **dict(row),
            "canonical_root": canonical_root,
        }
        canonical = {
            **canonical_body,
            "canonical_projection_root": semantic_root(canonical_body),
        }
        canonical_rows.append(canonical)
        subject_to_canonical.setdefault(
            (canonical["object_kind"], canonical["subject"]), set()
        ).add(canonical_root)
        for observation in canonical["observations"]:
            node_to_canonical[parse_work_ref(observation["work_ref"]).node_key] = (
                canonical_root
            )
    canonical_rows.sort(
        key=lambda row: (
            row["object_kind"],
            row["subject"],
            row["canonical_root"],
        )
    )
    canonical_by_root = {str(row["canonical_root"]): row for row in canonical_rows}
    label_collisions = [
        {
            "object_kind": object_kind,
            "subject": subject,
            "canonical_roots": sorted(
                row["canonical_root"]
                for row in canonical_rows
                if row["object_kind"] == object_kind and row["subject"] == subject
            ),
            "state": "authority-distinct",
            "strict_effect": "ambiguous-only-when-used-by-unqualified-reference",
        }
        for (object_kind, subject), rows in sorted(by_label.items())
        if len(rows) > 1
    ]
    retained_states = {
        str(state.get("state_root") or ""): dict(state)
        for component in component_rows
        for state in component.get("retained_assignment_states") or []
        if state.get("state_root")
    }
    unqualified_retained_states = {
        str(state.get("state_root") or ""): dict(state)
        for component in component_rows
        for state in component.get("unqualified_retained_assignment_states") or []
        if state.get("state_root")
    }
    retained_subjects: dict[str, list[dict[str, Any]]] = {}
    for state in retained_states.values():
        if state.get("settled") is True:
            retained_subjects.setdefault(
                str(state.get("assignment_subject") or ""), []
            ).append(state)
    for rows in retained_subjects.values():
        rows.sort(key=lambda row: str(row.get("state_root") or ""))

    resolved: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    relations = [
        relation
        for component in component_rows
        for relation in component.get("relations") or []
    ]
    for relation in relations:
        for side in ("source", "target"):
            reference = parse_work_ref((relation or {}).get(side) or {})
            target_root = node_to_canonical.get(reference.node_key)
            if target_root:
                resolved.append(
                    {
                        "kind": "typed-relation-endpoint",
                        "relation_root": relation.get("relation_root"),
                        "side": side,
                        "work_ref": reference.as_dict(),
                        "canonical_root": target_root,
                    }
                )
            else:
                unresolved.append(
                    {
                        "code": "missing-reference",
                        "kind": "typed-relation-endpoint",
                        "relation_root": relation.get("relation_root"),
                        "side": side,
                        "work_ref": reference.as_dict(),
                        "next_action": "register and read the referenced workspace authority",
                    }
                )

    for component in component_rows:
        workspace = component.get("workspace") or {}
        for problem in component.get("problems") or []:
            if problem.get("code") != "unresolved-assignment-dependency":
                continue
            dependency_id = str(problem.get("dependency_id") or "")
            dependency_subject = (
                dependency_id
                if dependency_id.startswith("kungfu:")
                else f"kungfu:{dependency_id}"
            )
            candidates = sorted(
                subject_to_canonical.get(("assignment", dependency_subject), set())
            )
            retained_candidates = retained_subjects.get(dependency_subject, [])
            unqualified_candidates = [
                row
                for row in unqualified_retained_states.values()
                if row.get("assignment_subject") == dependency_subject
            ]
            base = {
                "kind": "legacy-assignment-dependency",
                "workspace_identity_root": workspace.get("identity_root"),
                "assignment_subject": problem.get("assignment_subject"),
                "dependency_id": dependency_id,
                "dependency_subject": dependency_subject,
            }
            if (
                len(candidates) == 1
                and not canonical_by_root[candidates[0]]["conflict"]
            ):
                resolved.append({**base, "canonical_root": candidates[0]})
            elif not candidates and len(retained_candidates) == 1:
                retained = retained_candidates[0]
                resolved.append(
                    {
                        **base,
                        "resolution": "retained-sealed-assignment-state",
                        "sealed_state_root": retained["state_root"],
                        "work_ref": {
                            "schema": WORK_REF_SCHEMA,
                            "workspace_identity_root": retained[
                                "workspace_identity_root"
                            ],
                            "object_kind": "assignment",
                            "subject": dependency_subject,
                            "version_root": retained["state_root"],
                            "cut_root": retained["query_proof_root"],
                        },
                    }
                )
            else:
                code = (
                    "missing-reference"
                    if not candidates
                    and not retained_candidates
                    and not unqualified_candidates
                    else (
                        "conflicting-reference"
                        if len(candidates) == 1 and not retained_candidates
                        else (
                            "incompatible-retained-reference"
                            if not candidates
                            and not retained_candidates
                            and unqualified_candidates
                            else "ambiguous-reference"
                        )
                    )
                )
                unresolved.append(
                    {
                        **base,
                        "code": code,
                        "candidate_canonical_roots": candidates,
                        "candidate_sealed_state_roots": [
                            row["state_root"] for row in retained_candidates
                        ],
                        "candidate_unqualified_state_roots": [
                            row["state_root"] for row in unqualified_candidates
                        ],
                        "next_action": (
                            "register the dependency authority"
                            if code == "missing-reference"
                            else "replace the legacy dependency id with one exact WorkRef"
                        ),
                    }
                )

    relation_qualification = qualify_assignment_graph(relations)
    for issue in relation_qualification["issues"]:
        unresolved.append(
            {
                "code": (
                    "cyclic-reference"
                    if issue.get("code") == "relation-cycle"
                    else "invalid-reference"
                ),
                "qualification_issue": issue,
                "next_action": "repair the source relation and publish a new component cut",
            }
        )
    resolved.sort(key=lambda row: semantic_root(row))
    unresolved.sort(key=lambda row: semantic_root(row))
    resolution_body = {
        "schema": REFERENCE_RESOLUTION_SCHEMA,
        "resolved": resolved,
        "unresolved": unresolved,
        "relation_qualification_root": relation_qualification["qualification_root"],
    }
    reference_resolution = {
        **resolution_body,
        "resolution_root": semantic_root(resolution_body),
    }
    visible_work = [
        row
        for row in canonical_rows
        if include_settled
        or (
            str(row["display"].get("portfolio_state") or "") != "completed"
            and str(row["display"].get("status") or "").lower()
            not in {"completed", "archived", "closed"}
        )
    ]
    body = {
        "schema": GLOBAL_WORK_PROJECTION_SCHEMA,
        "canonical_work": canonical_rows,
        "label_collisions": label_collisions,
        "retained_assignment_states": [
            retained_states[root] for root in sorted(retained_states)
        ],
        "unqualified_retained_assignment_states": [
            unqualified_retained_states[root]
            for root in sorted(unqualified_retained_states)
        ],
        "visible_work": visible_work,
        "filter": {
            "include_settled": include_settled,
            "default": "active-and-attention",
        },
        "reference_resolution": reference_resolution,
        "canonical_work_count": len(canonical_rows),
        "visible_work_count": len(visible_work),
        "initiative_count": sum(
            row["object_kind"] == "initiative" for row in canonical_rows
        ),
        "assignment_count": sum(
            row["object_kind"] == "assignment" for row in canonical_rows
        ),
        "observation_count": len(observations),
        "assignment_observation_count": sum(
            row["work_ref"]["object_kind"] == "assignment" for row in observations
        ),
        "replica_count": sum(row["replica_count"] for row in canonical_rows),
        "conflict_count": sum(bool(row["conflict"]) for row in canonical_rows),
        "label_collision_count": len(label_collisions),
        "retained_assignment_state_count": len(retained_states),
        "unqualified_retained_assignment_state_count": len(unqualified_retained_states),
        "writes": 0,
    }
    return {**body, "projection_root": semantic_root(body)}


def verify_federation_query(value: Mapping[str, Any]) -> dict[str, Any]:
    """Verify root-bound component envelopes before global composition."""

    issues: list[dict[str, Any]] = []
    components = value.get("components")
    if not isinstance(components, list):
        components = []
        issues.append(
            {"code": "components-invalid", "message": "components must be an array"}
        )
    for index, component in enumerate(components):
        if not isinstance(component, Mapping):
            issues.append({"code": "component-invalid", "index": index})
            continue
        envelope = component.get("envelope")
        if not isinstance(envelope, Mapping):
            issues.append({"code": "component-envelope-missing", "index": index})
            continue
        declared = str(envelope.get("envelope_root") or "")
        body = dict(envelope)
        body.pop("envelope_root", None)
        if body.get("schema") != COMPONENT_ENVELOPE_SCHEMA:
            issues.append({"code": "component-envelope-schema", "index": index})
        elif not _ROOT.fullmatch(declared) or semantic_root(body) != declared:
            issues.append({"code": "component-envelope-root", "index": index})
        workspace = component.get("workspace") or {}
        if envelope.get("workspace_identity_root") != workspace.get("identity_root"):
            issues.append({"code": "component-workspace-root-mismatch", "index": index})
        if envelope.get("cut_root") != component.get("cut_root"):
            issues.append({"code": "component-cut-root-mismatch", "index": index})
        if envelope.get("query_proof_root") != component.get("query_proof_root"):
            issues.append(
                {"code": "component-query-proof-root-mismatch", "index": index}
            )
        result_body = _component_result_material(component)
        if envelope.get("component_result_root") != semantic_root(result_body):
            issues.append({"code": "component-result-root-mismatch", "index": index})
        if envelope.get("observed_at") != component.get("observed_at"):
            issues.append({"code": "component-observation-mismatch", "index": index})
        if component.get("availability") == "available":
            for field, root in (
                ("profile", envelope.get("profile_root")),
                (
                    "reader-runtime",
                    (envelope.get("reader_runtime") or {}).get("runtime_root"),
                ),
                (
                    "workspace-runtime",
                    (envelope.get("workspace_runtime") or {}).get("runtime_root"),
                ),
                ("cut", envelope.get("cut_root")),
                ("query-proof", envelope.get("query_proof_root")),
            ):
                if not _ROOT.fullmatch(str(root or "")):
                    issues.append(
                        {
                            "code": f"component-{field}-root-untrusted",
                            "index": index,
                        }
                    )
            compatibility = envelope.get("compatibility") or {}
            if not str(compatibility.get("state") or "").startswith("compatible"):
                issues.append(
                    {"code": "component-runtime-incompatible", "index": index}
                )
        retained_states = component.get("retained_assignment_states") or []
        retained_root = str(component.get("retained_state_index_root") or "")
        if retained_root and (
            not _ROOT.fullmatch(retained_root)
            or _retained_state_projection_root(retained_states) != retained_root
        ):
            issues.append(
                {"code": "component-retained-state-index-root", "index": index}
            )
        for kind in ("initiatives", "assignments"):
            rows = component.get(kind)
            if not isinstance(rows, list):
                issues.append({"code": f"component-{kind}-invalid", "index": index})
                continue
            for row in rows:
                try:
                    parse_work_ref((row or {}).get("work_ref") or {})
                except (AttributeError, TypeError, ValueError):
                    issues.append(
                        {"code": "component-work-ref-invalid", "index": index}
                    )
                    break
    projection = value.get("global_work")
    if not isinstance(projection, Mapping):
        issues.append({"code": "global-work-projection-missing"})
    else:
        declared_projection_root = str(projection.get("projection_root") or "")
        projection_body = dict(projection)
        projection_body.pop("projection_root", None)
        if (
            projection.get("schema") != GLOBAL_WORK_PROJECTION_SCHEMA
            or not _ROOT.fullmatch(declared_projection_root)
            or semantic_root(projection_body) != declared_projection_root
        ):
            issues.append({"code": "global-work-projection-root"})
        if (value.get("proof") or {}).get(
            "global_work_projection_root"
        ) != declared_projection_root:
            issues.append({"code": "query-proof-global-work-mismatch"})
    proof_components = (value.get("proof") or {}).get("component_cuts")
    expected_proof_components = [
        {
            "workspace_identity_root": component.get("workspace", {}).get(
                "identity_root"
            ),
            "availability": component.get("availability"),
            "observed_at": component.get("observed_at"),
            "cut_root": component.get("cut_root"),
            "query_proof_root": component.get("query_proof_root"),
            "component_result_root": (component.get("envelope") or {}).get(
                "component_result_root"
            ),
            "component_envelope_root": (component.get("envelope") or {}).get(
                "envelope_root"
            ),
        }
        for component in components
        if isinstance(component, Mapping)
    ]
    if proof_components != expected_proof_components:
        issues.append({"code": "query-proof-component-mismatch"})
    proof = {
        "schema": QUERY_VERIFICATION_SCHEMA,
        "component_count": len(components),
        "issues": issues,
    }
    return {**proof, "ok": not issues, "verification_root": semantic_root(proof)}


def build_dogfood_gate_receipt(
    query: Mapping[str, Any],
    controller: Mapping[str, Any],
    phase: Literal["kickoff", "stage-ready", "closeout"],
) -> dict[str, Any]:
    """Bind one installed-controller dogfood phase to exact component proofs."""

    if phase not in {"kickoff", "stage-ready", "closeout"}:
        raise ValueError(f"unsupported dogfood gate phase: {phase}")
    verification = verify_federation_query(query)
    components = []
    for component in query.get("components") or []:
        envelope = component.get("envelope") or {}
        workspace = component.get("workspace") or {}
        components.append(
            {
                "workspace_identity_root": workspace.get("identity_root"),
                "reader_runtime_root": (envelope.get("reader_runtime") or {}).get(
                    "runtime_root"
                ),
                "workspace_runtime_root": (envelope.get("workspace_runtime") or {}).get(
                    "runtime_root"
                ),
                "profile_root": envelope.get("profile_root"),
                "component_cut_root": envelope.get("cut_root"),
                "component_query_proof_root": envelope.get("query_proof_root"),
                "component_envelope_root": envelope.get("envelope_root"),
                "availability": envelope.get("availability"),
                "compatibility": envelope.get("compatibility"),
                "stale": envelope.get("stale"),
                "errors": envelope.get("errors") or [],
            }
        )
    controller_body = dict(controller)
    controller_body.pop("writes", None)
    body = {
        "schema": DOGFOOD_GATE_RECEIPT_SCHEMA,
        "phase": phase,
        "observed_at": query.get("observed_at"),
        "controller": controller_body,
        "controller_identity_root": semantic_root(controller_body),
        "query_contract": {
            "schema": query.get("schema"),
            "scope": query.get("scope"),
            "atomic_global_cut": query.get("atomic_global_cut"),
        },
        "query_proof_root": (query.get("proof") or {}).get("proof_root"),
        "query_verification_root": verification.get("verification_root"),
        "components": components,
        "coverage": dict(query.get("aggregate") or {}),
        "residual_unknowns": list(
            (query.get("proof") or {}).get("unresolved_references") or []
        ),
        "writes": [],
    }
    receipt = {**body, "receipt_root": semantic_root(body)}
    gate_verification = verify_dogfood_gate_receipt(receipt, query)
    return {**receipt, "verification": gate_verification}


def verify_dogfood_gate_receipt(
    receipt: Mapping[str, Any], query: Mapping[str, Any]
) -> dict[str, Any]:
    """Verify a gate receipt against the query it claims to retain."""

    issues: list[dict[str, Any]] = []
    body = dict(receipt)
    body.pop("receipt_root", None)
    body.pop("verification", None)
    declared = str(receipt.get("receipt_root") or "")
    if receipt.get("schema") != DOGFOOD_GATE_RECEIPT_SCHEMA:
        issues.append({"code": "gate-receipt-schema"})
    if not _ROOT.fullmatch(declared) or semantic_root(body) != declared:
        issues.append({"code": "gate-receipt-root"})
    query_verification = verify_federation_query(query)
    if receipt.get("query_proof_root") != (query.get("proof") or {}).get("proof_root"):
        issues.append({"code": "gate-query-proof-mismatch"})
    if receipt.get("query_verification_root") != query_verification.get(
        "verification_root"
    ):
        issues.append({"code": "gate-query-verification-mismatch"})
    expected_envelopes = [
        (component.get("envelope") or {}).get("envelope_root")
        for component in query.get("components") or []
    ]
    observed_envelopes = [
        component.get("component_envelope_root")
        for component in receipt.get("components") or []
    ]
    if expected_envelopes != observed_envelopes:
        issues.append({"code": "gate-component-envelope-mismatch"})
    qualification = receipt.get("controller", {}).get("qualification") or {}
    rollback = receipt.get("controller", {}).get("rollback") or {}
    if (
        receipt.get("controller", {}).get("state") != "qualified"
        or qualification.get("qualified") is not True
        or qualification.get("identityMatches") is not True
        or qualification.get("artifactMatchesRuntime") is not True
        or qualification.get("promotionMatches") is not True
        or qualification.get("rollbackAvailable") is not True
    ):
        issues.append({"code": "gate-controller-unqualified"})
    if not receipt.get("controller", {}).get("productManifestDigest"):
        issues.append({"code": "gate-controller-manifest-unbound"})
    if rollback.get("available") is not True or not rollback.get("artifactId"):
        issues.append({"code": "gate-controller-rollback-unavailable"})
    proof = {
        "schema": DOGFOOD_GATE_VERIFICATION_SCHEMA,
        "issues": issues,
    }
    return {**proof, "ok": not issues, "verification_root": semantic_root(proof)}


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
        result = {
            **component,
            "workspace": identity.as_dict(),
            "availability": component.get("availability", "available"),
            "observed_at": _now(),
        }
        return _bind_component_envelope(result)
    except (OSError, RuntimeError, ValueError) as error:
        result = {
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
        return _bind_component_envelope(result)


def _load_component(identity: WorkspaceIdentity) -> dict[str, Any]:
    """Read one component through the root-bound Fact material protocol.

    Mission Control's high-level query correctly requires its exact active
    Profile.  A global controller must not activate or replace that Profile just
    to inspect another workspace, so federation uses the lower, read-only Fact
    material contract and binds the observed contract roots into the component
    envelope.  This is the equivalent root-bound projection: it reads no
    workspace through the controller's active Mission Control Profile.
    """

    from kungfu import assignment_orchestration

    sealed_index = (
        assignment_orchestration.list_sealed_assignment_states(identity.workspace_root)
        if identity.workspace_root
        else {
            "schema": "kungfu.assignment-orchestration.sealed-work-index/v1",
            "states": [],
            "unqualified_states": [],
            "issues": [],
            "storage_kind": "none",
            "writes": [],
            "index_root": semantic_root(
                {
                    "schema": "kungfu.assignment-orchestration.sealed-work-index/v1",
                    "states": [],
                    "unqualified_states": [],
                    "issues": [],
                    "storage_kind": "none",
                    "writes": [],
                }
            ),
        }
    )
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
            "problems": list(sealed_index["issues"]),
            "retained_assignment_states": sealed_index["states"],
            "unqualified_retained_assignment_states": sealed_index[
                "unqualified_states"
            ],
            "retained_state_index_root": _retained_state_projection_root(
                sealed_index["states"]
            ),
            "reader_runtime": _reader_runtime_identity(),
            "workspace_runtime": _workspace_runtime_identity(identity),
            "profile_binding": _empty_profile_binding(),
            "profile_root": _empty_profile_binding()["profile_root"],
            "compatibility": {
                "state": "compatible-empty",
                "protocol": "kungfu.fact-material-read/v1",
                "reason": "workspace runtime is uninitialized",
            },
        }

    from kungfu.storage import service as storage_service
    from kungfu.atlas import mission_control

    materials = storage_service.fact_material_list(runtime_dir)
    if materials.get("schema") != "kungfu.facts.material-catalog/v1":
        raise ValueError("unsupported Fact material catalog")
    canonical_facts = list(materials.get("state", {}).get("canonical_facts", []))
    payloads = materials.get("payloads")
    if not isinstance(payloads, Mapping):
        raise ValueError("Fact material payload map is absent")
    initiatives: list[dict[str, Any]] = []
    assignments: list[dict[str, Any]] = []
    phase_by_assignment: dict[str, tuple[int, str]] = {}
    for fact in canonical_facts:
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
        if surface == "kungfu.initiative-assignment.initiative":
            initiatives.append(record)
        elif surface == "kungfu.initiative-assignment.assignment":
            assignments.append(record)
        elif surface == "kungfu.initiative-assignment.completion-claim":
            assignment_id = str(
                record.get("assignment_id") or record.get("assignment_subject") or ""
            ).removeprefix("kungfu:")
            phase = str(record.get("to_phase") or "")
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
    stored_relations = mission_control.assignment_relations(runtime_dir)
    derived_relations = _material_relations(projected_assignments)
    relations = {
        str(row.get("relation_root") or ""): row
        for row in [*stored_relations, *derived_relations]
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
        "problems": [*problems, *sealed_index["issues"]],
        "retained_assignment_states": sealed_index["states"],
        "unqualified_retained_assignment_states": sealed_index["unqualified_states"],
        "retained_state_index_root": _retained_state_projection_root(
            sealed_index["states"]
        ),
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
    assignment_id = str(record.get("assignment_id") or record.get("goal_id") or "")
    phase = phase_by_assignment.get(assignment_id, (0, ""))[1] or str(
        record.get("orchestration_phase") or "admitted"
    )
    return {
        "orchestration_phase": phase,
        "portfolio_state": "completed" if phase == "continuation-decided" else "open",
        "globally_completed": phase == "continuation-decided",
        "projection": "root-bound-fact-material",
    }


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
        "retained_assignment_states": list(
            component.get("retained_assignment_states") or []
        ),
        "unqualified_retained_assignment_states": list(
            component.get("unqualified_retained_assignment_states") or []
        ),
        "retained_state_index_root": component.get("retained_state_index_root") or "",
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
    return _bind_component_envelope(
        {
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
    )


def _excluded_component(entry: Mapping[str, Any]) -> dict[str, Any]:
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
        "state": "excluded",
        "resolution_reason": "catalog-lifecycle-policy",
    }
    return _bind_component_envelope(
        {
            "workspace": workspace,
            "availability": "excluded",
            "observed_at": _now(),
            "catalog_observed_at": entry.get("observed_at"),
            "stale": not bool(entry.get("available")),
            "cut_root": "",
            "query_proof_root": "",
            "initiatives": [],
            "assignments": [],
            "relations": [],
            "problems": [
                {
                    "code": "workspace-excluded",
                    "lifecycle": entry.get("lifecycle"),
                    "exclusion_policy": entry.get("exclusion_policy"),
                    "locator": entry.get("locator"),
                }
            ],
        }
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
