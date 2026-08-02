# SPDX-License-Identifier: Apache-2.0

"""Conservative global Work projection over workspace-qualified component cuts."""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from kungfu.assignment_graph import (
    WORK_REF_SCHEMA,
    WorkRef,
    _ROOT,
    parse_work_ref,
    qualify_assignment_graph,
)
from kungfu.workspace import semantic_root


GLOBAL_WORK_PROJECTION_SCHEMA = "kungfu.workspace-federation.global-work/v1"
OUTCOME_HISTORY_SCHEMA = "kungfu.workspace-federation.work-design-outcome-history/v1"
CANONICAL_WORK_SCHEMA = "kungfu.workspace-federation.canonical-work/v1"
INITIATIVE_GROUP_SCHEMA = "kungfu.workspace-federation.initiative-group/v1"
CANONICAL_WORK_IDENTITY_SCHEMA = (
    "kungfu.workspace-federation.canonical-work-identity/v1"
)
WORK_OBSERVATION_SCHEMA = "kungfu.workspace-federation.work-observation/v1"
REFERENCE_RESOLUTION_SCHEMA = "kungfu.workspace-federation.reference-resolution/v1"
TERMINAL_SOURCE_STATUSES = frozenset(
    {"archived", "closed", "complete", "completed", "merged"}
)


def _retained_state_dominates(
    candidate: Mapping[str, Any], predecessor: Mapping[str, Any]
) -> bool:
    candidate_counts = candidate.get("event_counts")
    predecessor_counts = predecessor.get("event_counts")
    if not isinstance(candidate_counts, Mapping) or not isinstance(
        predecessor_counts, Mapping
    ):
        return False
    if not candidate_counts or set(candidate_counts) != set(predecessor_counts):
        return False
    try:
        pairs = [
            (int(candidate_counts[key]), int(predecessor_counts[key]))
            for key in candidate_counts
        ]
    except (TypeError, ValueError):
        return False
    return all(current >= previous for current, previous in pairs) and any(
        current > previous for current, previous in pairs
    )


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
                    "source_status": str(record.get("status") or ""),
                    "orchestration_phase": str(
                        (record.get("lifecycle") or {}).get("orchestration_phase") or ""
                    ),
                    "portfolio_state": str(
                        (record.get("lifecycle") or {}).get("portfolio_state") or ""
                    ),
                    "next_actions": list(
                        (record.get("lifecycle") or {}).get("next_actions") or []
                    ),
                    "updated_at": str(
                        record.get("updated_at")
                        or record.get("completed_at")
                        or record.get("started_at")
                        or record.get("created_at")
                        or ""
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
    outcome_history = _compose_outcome_history(component_rows, retained_states)
    retained_subjects: dict[str, list[dict[str, Any]]] = {}
    retained_nodes: dict[str, dict[str, Any]] = {}
    for state in retained_states.values():
        if state.get("settled") is True:
            retained_subjects.setdefault(
                str(state.get("assignment_subject") or ""), []
            ).append(state)
            try:
                reference = WorkRef(
                    workspace_identity_root=str(
                        state.get("workspace_identity_root") or ""
                    ),
                    object_kind="assignment",
                    subject=str(state.get("assignment_subject") or ""),
                    version_root=str(state.get("state_root") or ""),
                    cut_root=str(state.get("query_proof_root") or ""),
                )
            except (TypeError, ValueError):
                continue
            retained_nodes[reference.node_key] = state
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
            retained_target = retained_nodes.get(reference.node_key)
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
            elif retained_target:
                resolved.append(
                    {
                        "kind": "typed-relation-endpoint",
                        "relation_root": relation.get("relation_root"),
                        "side": side,
                        "work_ref": reference.as_dict(),
                        "resolution": "retained-sealed-assignment-state",
                        "sealed_state_root": retained_target["state_root"],
                        "assignment_state_root": retained_target.get(
                            "assignment_state_root", ""
                        ),
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
            retained_candidate_groups: dict[str, list[dict[str, Any]]] = {}
            for retained in retained_candidates:
                assignment_state_root = str(retained.get("assignment_state_root") or "")
                group_key = (
                    assignment_state_root
                    if _ROOT.fullmatch(assignment_state_root)
                    else f"legacy:{retained['state_root']}"
                )
                retained_candidate_groups.setdefault(group_key, []).append(retained)
            selected_retained_group_root = ""
            if len(retained_candidate_groups) == 1:
                selected_retained_group_root = next(iter(retained_candidate_groups))
            elif len(retained_candidate_groups) > 1:
                dominant_roots = [
                    group_root
                    for group_root, group_rows in retained_candidate_groups.items()
                    if all(
                        other_root == group_root
                        or _retained_state_dominates(group_rows[0], other_rows[0])
                        for other_root, other_rows in retained_candidate_groups.items()
                    )
                ]
                if len(dominant_roots) == 1:
                    selected_retained_group_root = dominant_roots[0]
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
            elif not candidates and selected_retained_group_root:
                retained_group = retained_candidate_groups[selected_retained_group_root]
                retained_group.sort(key=lambda row: str(row["state_root"]))
                retained = retained_group[0]
                superseded_state_roots = sorted(
                    row["state_root"]
                    for group_root, rows in retained_candidate_groups.items()
                    if group_root != selected_retained_group_root
                    for row in rows
                )
                resolved.append(
                    {
                        **base,
                        "resolution": "retained-sealed-assignment-state",
                        "sealed_state_root": retained["state_root"],
                        "equivalent_sealed_state_roots": [
                            row["state_root"] for row in retained_group
                        ],
                        "superseded_sealed_state_roots": superseded_state_roots,
                        "assignment_state_root": retained.get(
                            "assignment_state_root", ""
                        ),
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
                        **(
                            {
                                "candidate_assignment_state_roots": sorted(
                                    {
                                        str(row.get("assignment_state_root") or "")
                                        for row in retained_candidates
                                        if row.get("assignment_state_root")
                                    }
                                )
                            }
                            if retained_candidates
                            else {}
                        ),
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
            and str(row["display"].get("source_status") or "").strip().lower()
            not in TERMINAL_SOURCE_STATUSES
        )
    ]
    visible_roots = {str(row["canonical_root"]) for row in visible_work}
    initiative_groups: list[dict[str, Any]] = []
    for (object_kind, subject), _rows in sorted(by_label.items()):
        if object_kind != "initiative":
            continue
        initiative_rows = [
            row
            for row in canonical_rows
            if row["object_kind"] == "initiative" and row["subject"] == subject
        ]
        if not initiative_rows:
            continue
        canonical_roots = sorted(str(row["canonical_root"]) for row in initiative_rows)
        authority_roots = sorted(
            {str(root) for row in initiative_rows for root in row["authority_roots"]}
        )
        statuses = sorted(
            {
                str(row["display"].get("source_status") or "")
                for row in initiative_rows
                if row["display"].get("source_status")
            }
        )
        phases = sorted(
            {
                str(row["display"].get("orchestration_phase") or "")
                for row in initiative_rows
                if row["display"].get("orchestration_phase")
            }
        )
        portfolio_states = sorted(
            {
                str(row["display"].get("portfolio_state") or "")
                for row in initiative_rows
                if row["display"].get("portfolio_state")
            }
        )
        titles = sorted(
            {str(row["display"].get("title") or subject) for row in initiative_rows}
        )
        group_body = {
            "schema": INITIATIVE_GROUP_SCHEMA,
            "object_kind": "initiative",
            "subject": subject,
            "authority_state": (
                "authority-distinct" if len(canonical_roots) > 1 else "single-authority"
            ),
            "canonical_roots": canonical_roots,
            "authority_roots": authority_roots,
            "canonical_count": len(canonical_roots),
            "authority_count": len(authority_roots),
            "observation_count": sum(
                int(row["observation_count"]) for row in initiative_rows
            ),
            "display": {
                "title": titles[0],
                "source_status": (
                    statuses[0] if len(statuses) == 1 else ("mixed" if statuses else "")
                ),
                "orchestration_phase": (
                    phases[0] if len(phases) == 1 else ("mixed" if phases else "")
                ),
                "portfolio_state": (
                    portfolio_states[0]
                    if len(portfolio_states) == 1
                    else ("mixed" if portfolio_states else "")
                ),
            },
        }
        initiative_groups.append(
            {**group_body, "group_root": semantic_root(group_body)}
        )
    visible_initiative_groups = [
        group
        for group in initiative_groups
        if any(root in visible_roots for root in group["canonical_roots"])
    ]
    body = {
        "schema": GLOBAL_WORK_PROJECTION_SCHEMA,
        "canonical_work": canonical_rows,
        "label_collisions": label_collisions,
        "initiative_groups": initiative_groups,
        "visible_initiative_groups": visible_initiative_groups,
        "retained_assignment_states": [
            retained_states[root] for root in sorted(retained_states)
        ],
        "unqualified_retained_assignment_states": [
            unqualified_retained_states[root]
            for root in sorted(unqualified_retained_states)
        ],
        "outcome_history": outcome_history,
        "visible_work": visible_work,
        "filter": {
            "include_settled": include_settled,
            "default": "active-and-attention",
        },
        "reference_resolution": reference_resolution,
        "canonical_work_count": len(canonical_rows),
        "visible_work_count": len(visible_work),
        "visible_initiative_group_count": len(visible_initiative_groups),
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
        "complete_outcome_count": outcome_history["coverage"]["complete"],
        "partial_outcome_count": outcome_history["coverage"]["partial"],
        "sealed_only_unknown_outcome_count": outcome_history["coverage"][
            "sealed_only_unknown"
        ],
        "writes": 0,
    }
    return {**body, "projection_root": semantic_root(body)}


def _compose_outcome_history(
    components: Iterable[Mapping[str, Any]],
    retained_states: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Join only verified component bindings to exact retained state roots."""

    grouped: dict[str, dict[str, dict[str, Any]]] = {}
    issues: list[dict[str, Any]] = []
    for component in components:
        workspace_root = str(
            (component.get("workspace") or {}).get("identity_root") or ""
        )
        for binding in component.get("retained_outcome_bindings") or []:
            state_root = str(binding.get("settled_state_root") or "")
            binding_root = str(binding.get("binding_root") or "")
            if state_root not in retained_states:
                issues.append(
                    {
                        "code": "outcome-binding-state-unavailable",
                        "workspace_identity_root": workspace_root,
                        "settled_state_root": state_root,
                        "binding_root": binding_root,
                    }
                )
                continue
            state = retained_states[state_root]
            outcome = binding.get("outcome") or {}
            if (
                binding.get("workspace_identity_root")
                != state.get("workspace_identity_root")
                or binding.get("state_query_proof_root")
                != state.get("query_proof_root")
                or binding.get("assignment_subject") != state.get("assignment_subject")
                or outcome.get("evidence", {}).get("settledStateRoot") != state_root
            ):
                issues.append(
                    {
                        "code": "outcome-binding-state-mismatch",
                        "workspace_identity_root": workspace_root,
                        "settled_state_root": state_root,
                        "binding_root": binding_root,
                    }
                )
                continue
            grouped.setdefault(state_root, {})[binding_root] = dict(binding)

    bindings: list[dict[str, Any]] = []
    for state_root, candidates in sorted(grouped.items()):
        outcome_roots = {
            str((candidate.get("outcome") or {}).get("outcomeRoot") or "")
            for candidate in candidates.values()
        }
        if len(candidates) != 1:
            issues.append(
                {
                    "code": "conflicting-replica-outcome-bindings",
                    "settled_state_root": state_root,
                    "binding_roots": sorted(candidates),
                    "outcome_roots": sorted(outcome_roots),
                }
            )
            continue
        bindings.append(candidates[sorted(candidates)[0]])

    bound_states = {str(row["settled_state_root"]) for row in bindings}
    complete = sum(bool(row["outcome"]["coverage"]["complete"]) for row in bindings)
    partial = len(bindings) - complete
    settled = {
        root for root, state in retained_states.items() if state.get("settled") is True
    }
    coverage = {
        "unique_settled_state_count": len(settled),
        "unique_assignment_count": len(
            {
                str(retained_states[root].get("assignment_subject") or "")
                for root in settled
            }
        ),
        "complete": complete,
        "partial": partial,
        "sealed_only_unknown": len(settled - bound_states),
        "unqualified_state_count": len(
            {
                str(state.get("state_root") or semantic_root(state))
                for component in components
                for state in component.get("unqualified_retained_assignment_states")
                or []
            }
        ),
    }
    body = {
        "schema": OUTCOME_HISTORY_SCHEMA,
        "bindings": sorted(bindings, key=lambda row: str(row["settled_state_root"])),
        "issues": sorted(issues, key=semantic_root),
        "coverage": coverage,
        "writes": 0,
    }
    return {**body, "history_root": semantic_root(body)}
