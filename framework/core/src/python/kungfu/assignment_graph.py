# SPDX-License-Identifier: Apache-2.0

"""Portable Assignment graph identities, relations, qualification, and traversal."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable, Literal, Mapping

from kungfu.workspace import WorkspaceIdentity, semantic_root


WORK_REF_SCHEMA = "kungfu.assignment-graph.work-ref/v1"
RELATION_SCHEMA = "kungfu.assignment-graph.relation/v1"
RELATION_QUALIFICATION_SCHEMA = "kungfu.assignment-graph.qualification/v1"
TRAVERSAL_SCHEMA = "kungfu.assignment-graph.traversal/v1"

_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_SUBJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")

ObjectKind = Literal["initiative", "assignment"]
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
