# SPDX-License-Identifier: Apache-2.0

"""Workspace-qualified Assignment graph and read-only federation contracts.

Paths are machine-local locators only.  Portable WorkRef and relation roots
contain workspace identity roots plus immutable object/query coordinates.
Federated reads preserve one independently verifiable component cut per
workspace and never claim an atomic global snapshot.
"""

from __future__ import annotations

from datetime import datetime, timezone
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import multiprocessing
import os
from typing import Any, Callable, Iterable, Literal, Mapping

from kungfu.assignment_graph import (
    RELATION_QUALIFICATION_SCHEMA as RELATION_QUALIFICATION_SCHEMA,
    RELATION_SCHEMA as RELATION_SCHEMA,
    RELATION_TYPES as RELATION_TYPES,
    TRAVERSAL_SCHEMA as TRAVERSAL_SCHEMA,
    WORK_REF_SCHEMA as WORK_REF_SCHEMA,
    TraversalDirection as TraversalDirection,
    WorkRef as WorkRef,
    _ROOT as _ROOT,
    _SUBJECT as _SUBJECT,
    build_relation as build_relation,
    build_work_ref as build_work_ref,
    parse_work_ref as parse_work_ref,
    qualify_assignment_graph as qualify_assignment_graph,
    traverse_assignment_graph as traverse_assignment_graph,
)
from kungfu.workspace import (
    WorkspaceIdentity,
    inspect_workspace,
    load_workspace_catalog,
    semantic_root,
)
from kungfu import workspace_history as history_query
from kungfu.workspace_history import load_work_history_dispositions
from kungfu.workspace_federation_projection import (
    CANONICAL_WORK_IDENTITY_SCHEMA as CANONICAL_WORK_IDENTITY_SCHEMA,
    CANONICAL_WORK_SCHEMA as CANONICAL_WORK_SCHEMA,
    GLOBAL_WORK_PROJECTION_SCHEMA as GLOBAL_WORK_PROJECTION_SCHEMA,
    INITIATIVE_GROUP_SCHEMA as INITIATIVE_GROUP_SCHEMA,
    OUTCOME_HISTORY_SCHEMA as OUTCOME_HISTORY_SCHEMA,
    REFERENCE_RESOLUTION_SCHEMA as REFERENCE_RESOLUTION_SCHEMA,
    TERMINAL_SOURCE_STATUSES as TERMINAL_SOURCE_STATUSES,
    WORK_OBSERVATION_SCHEMA as WORK_OBSERVATION_SCHEMA,
    _compose_global_work as _compose_global_work,
    _compose_outcome_history as _compose_outcome_history,
    _retained_state_dominates as _retained_state_dominates,
)
from kungfu._workspace.federation import (
    COMPONENT_CUT_SCHEMA as COMPONENT_CUT_SCHEMA,
    COMPONENT_ENVELOPE_SCHEMA as COMPONENT_ENVELOPE_SCHEMA,
    _bind_component_envelope as _bind_component_envelope,
    _component_result_material as _component_result_material,
    _empty_profile_binding as _empty_profile_binding,
    _fact_profile_binding as _fact_profile_binding,
    _load_component as _load_component,
    _material_lifecycle as _material_lifecycle,
    _material_relations as _material_relations,
    _material_completion_phase as _material_completion_phase,
    _material_relation as _material_relation,
    _read_build_info as _read_build_info,
    _reader_runtime_identity as _reader_runtime_identity,
    _record_projection as _record_projection,
    _retained_state_projection_root as _retained_state_projection_root,
    _root as _root,
    _workspace_runtime_identity as _workspace_runtime_identity,
)


QUERY_SCHEMA = "kungfu.workspace-federation.query/v1"
QUERY_PROOF_SCHEMA = "kungfu.workspace-federation.query-proof/v1"
QUERY_VERIFICATION_SCHEMA = "kungfu.workspace-federation.query-verification/v1"
DOGFOOD_GATE_RECEIPT_SCHEMA = "kungfu.workspace-federation.dogfood-gate-receipt/v1"
DOGFOOD_GATE_VERIFICATION_SCHEMA = (
    "kungfu.workspace-federation.dogfood-gate-verification/v1"
)

QueryScope = Literal["local", "related", "all"]


WorkspaceLoader = Callable[[WorkspaceIdentity], dict[str, Any]]


def _load_parallel_component(identity: WorkspaceIdentity) -> dict[str, Any]:
    """Load one default component in an isolated POSIX reader process."""

    return _safe_component(identity, _load_component)


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
    max_workers: int = 1,
    component_cache: Mapping[str, Mapping[str, Any]] | None = None,
    refresh_identity_roots: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Read local, related, or all known work without mutating any workspace."""

    if scope not in {"local", "related", "all"}:
        raise ValueError("federation scope must be local, related, or all")
    loader = loader or _load_component
    cached = dict(component_cache or {})
    refresh_roots = set(refresh_identity_roots or ())
    if max_workers < 1 or max_workers > 16:
        raise ValueError("federation max_workers must be between 1 and 16")
    catalog = load_workspace_catalog(config_home, env=env)
    disposition_store = load_work_history_dispositions(config_home, env=env)
    identities: dict[str, WorkspaceIdentity] = {}
    reused_components: list[dict[str, Any]] = []

    def include(identity: WorkspaceIdentity | None) -> None:
        if identity is None:
            return
        key = identity.identity_root or identity.workspace_id
        identities.setdefault(key, identity)

    excluded_entries = [
        entry for entry in catalog["entries"] if not entry.get("required", True)
    ]
    history = history_query.bind_dispositions(
        catalog,
        disposition_store,
        lambda entry: _identity_from_catalog_entry(entry, env=env),
    )
    terminal_entries, terminal_keys = (
        history["terminal_entries"],
        history["terminal_keys"],
    )
    excluded_roots = {
        str(entry.get("identity_root") or "") for entry in excluded_entries
    }
    if scope != "all" or current.identity_root not in excluded_roots:
        include(current)
    if scope == "all":
        include(inspect_workspace(home=True, env=env))
        project_entries = [
            entry
            for entry in catalog["entries"]
            if entry.get("required", True)
            and entry.get("workspace_kind") != "home"
            and str(entry.get("identity_root") or entry.get("locator_key") or "")
            not in terminal_keys
        ]
        if cached:
            entries_to_resolve = []
            for entry in project_entries:
                identity_root = str(entry.get("identity_root") or "")
                if identity_root in identities:
                    continue
                if identity_root in cached and identity_root not in refresh_roots:
                    reused_components.append(dict(cached[identity_root]))
                    continue
                entries_to_resolve.append(entry)
            project_entries = entries_to_resolve
        if max_workers == 1:
            resolved = [
                _identity_from_catalog_entry(entry, env=env)
                for entry in project_entries
            ]
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as resolver_executor:
                resolved = list(
                    resolver_executor.map(
                        lambda entry: _identity_from_catalog_entry(entry, env=env),
                        project_entries,
                    )
                )
        for identity in resolved:
            include(identity)

    component_identities = list(identities.values())

    def load_or_reuse(identity: WorkspaceIdentity) -> dict[str, Any]:
        identity_root = identity.identity_root or identity.workspace_id
        if identity_root in cached and identity_root not in refresh_roots:
            return dict(cached[identity_root])
        return _safe_component(identity, loader)

    if cached:
        if max_workers == 1 or len(component_identities) < 2:
            components = [load_or_reuse(identity) for identity in component_identities]
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as component_executor:
                components = list(
                    component_executor.map(load_or_reuse, component_identities)
                )
    elif max_workers == 1 or len(component_identities) < 2:
        components = [
            _safe_component(identity, loader) for identity in component_identities
        ]
    elif loader is _load_component and os.name == "posix":
        # Default component readers perform substantial Python decoding. A
        # bounded fork pool avoids serializing that work behind the GIL while
        # retaining deterministic map order. The CLI process has not opened a
        # component runtime before this point.
        with ProcessPoolExecutor(
            max_workers=max_workers,
            mp_context=multiprocessing.get_context("fork"),
        ) as process_executor:
            components = list(
                process_executor.map(_load_parallel_component, component_identities)
            )
    else:
        component_loader = loader
        with ThreadPoolExecutor(max_workers=max_workers) as component_executor:
            components = list(
                component_executor.map(
                    lambda identity: _safe_component(identity, component_loader),
                    component_identities,
                )
            )
    components.extend(reused_components)
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
        components = [load_or_reuse(identity) for identity in identities.values()]

    if scope == "all":
        projected_roots = {
            component["workspace"].get("identity_root") for component in components
        }
        for entry in catalog["entries"]:
            if not entry.get("required", True):
                if include_excluded:
                    components.append(_history_component(entry, "excluded"))
                continue
            entry_key = str(
                entry.get("identity_root") or entry.get("locator_key") or ""
            )
            if entry_key in terminal_keys:
                continue
            if entry.get("identity_root") in projected_roots:
                continue
            components.append(_history_component(entry, "unavailable"))
        components.extend(
            _history_component(entry, "terminal-unavailable", disposition)
            for entry, disposition in terminal_entries
        )

    components.sort(
        key=lambda row: (
            str(row["workspace"].get("identity_root") or ""),
            str(row["workspace"].get("workspace_id") or ""),
        )
    )
    projection = _compose_global_work(
        components,
        include_settled=include_settled,
        reference_dispositions=disposition_store["reference_dispositions"],
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
    catalog_issues = [*catalog["issues"], *history["issues"]]
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
        **history_query.proof_fields(
            disposition_store, terminal_entries, projection["reference_resolution"]
        ),
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
    terminal_unavailable = sum(
        component.get("availability") == "terminal-unavailable"
        for component in components
    )
    stale = sum(
        bool(component.get("stale"))
        and component.get("availability") not in {"excluded", "terminal-unavailable"}
        for component in components
    )
    excluded = len(excluded_entries)
    retired = sum(
        str((entry.get("lifecycle") or {}).get("state") or "") == "retired"
        for entry in excluded_entries
    )
    tombstoned = sum(
        str((entry.get("lifecycle") or {}).get("state") or "")
        in {"retired", "test-only", "quarantined"}
        for entry in excluded_entries
    )
    unknown = sum(
        component.get("availability") in {"degraded", "unavailable"}
        or bool(component.get("stale"))
        for component in components
        if component.get("availability") not in {"excluded", "terminal-unavailable"}
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
        "outcome_history_root": projection["outcome_history"]["history_root"],
        "outcome_coverage": dict(projection["outcome_history"]["coverage"]),
        "available_component_count": available,
        "degraded_component_count": degraded,
        "unavailable_component_count": unavailable,
        "terminal_unavailable_component_count": terminal_unavailable,
        "stale_component_count": stale,
        "excluded_component_count": excluded,
        "retired_component_count": retired,
        "tombstoned_component_count": tombstoned,
        "unknown_component_count": unknown,
        "known_assignment_count": known_assignments,
        "unresolved_reference_count": len(unresolved),
        "terminal_reference_count": len(
            projection["reference_resolution"].get("terminal_dispositions") or []
        ),
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


def _verify_available_component(
    envelope: Mapping[str, Any], index: int, issues: list[dict[str, Any]]
) -> None:
    roots = (
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
    )
    for field, root in roots:
        if not _ROOT.fullmatch(str(root or "")):
            issues.append({"code": f"component-{field}-root-untrusted", "index": index})
    compatibility = envelope.get("compatibility") or {}
    if not str(compatibility.get("state") or "").startswith("compatible"):
        issues.append({"code": "component-runtime-incompatible", "index": index})


def _verify_component_identity(component, envelope, index, issues):
    declared = str(envelope.get("envelope_root") or "")
    body = {key: value for key, value in envelope.items() if key != "envelope_root"}
    if body.get("schema") != COMPONENT_ENVELOPE_SCHEMA:
        issues.append({"code": "component-envelope-schema", "index": index})
    elif not _ROOT.fullmatch(declared) or semantic_root(body) != declared:
        issues.append({"code": "component-envelope-root", "index": index})
    workspace = component.get("workspace") or {}
    for code, actual, expected in (
        (
            "component-workspace-root-mismatch",
            envelope.get("workspace_identity_root"),
            workspace.get("identity_root"),
        ),
        (
            "component-cut-root-mismatch",
            envelope.get("cut_root"),
            component.get("cut_root"),
        ),
        (
            "component-query-proof-root-mismatch",
            envelope.get("query_proof_root"),
            component.get("query_proof_root"),
        ),
        (
            "component-observation-mismatch",
            envelope.get("observed_at"),
            component.get("observed_at"),
        ),
    ):
        if actual != expected:
            issues.append({"code": code, "index": index})
    if envelope.get("component_result_root") != semantic_root(
        _component_result_material(component)
    ):
        issues.append({"code": "component-result-root-mismatch", "index": index})
    if component.get("availability") == "available":
        _verify_available_component(envelope, index, issues)


def _verify_component_retained(component, index, issues):
    retained_states = component.get("retained_assignment_states") or []
    retained_root = str(component.get("retained_state_index_root") or "")
    if retained_root and (
        not _ROOT.fullmatch(retained_root)
        or _retained_state_projection_root(retained_states) != retained_root
    ):
        issues.append({"code": "component-retained-state-index-root", "index": index})


def _verify_component_rows(component, index, issues):
    _verify_component_retained(component, index, issues)
    for kind in ("initiatives", "assignments"):
        rows = component.get(kind)
        if not isinstance(rows, list):
            issues.append({"code": f"component-{kind}-invalid", "index": index})
            continue
        for row in rows:
            try:
                parse_work_ref((row or {}).get("work_ref") or {})
            except (AttributeError, TypeError, ValueError):
                issues.append({"code": "component-work-ref-invalid", "index": index})
                break


def _verify_component(component: Mapping[str, Any], index, issues):
    envelope = component.get("envelope")
    if not isinstance(envelope, Mapping):
        issues.append({"code": "component-envelope-missing", "index": index})
        return
    _verify_component_identity(component, envelope, index, issues)
    _verify_component_rows(component, index, issues)


def _verify_global_work(value, issues):
    projection = value.get("global_work")
    if not isinstance(projection, Mapping):
        issues.append({"code": "global-work-projection-missing"})
        return
    declared = str(projection.get("projection_root") or "")
    body = dict(projection)
    body.pop("projection_root", None)
    if (
        projection.get("schema") != GLOBAL_WORK_PROJECTION_SCHEMA
        or not _ROOT.fullmatch(declared)
        or semantic_root(body) != declared
    ):
        issues.append({"code": "global-work-projection-root"})
    if (value.get("proof") or {}).get("global_work_projection_root") != declared:
        issues.append({"code": "query-proof-global-work-mismatch"})


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
        _verify_component(component, index, issues)
    _verify_global_work(value, issues)
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
    if not isinstance(locator, str) or not locator or not os.path.isdir(locator):
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
    return (
        identity
        if identity.identity_state == "locator-candidate"
        and identity.workspace_id == entry.get("workspace_id")
        and os.path.realpath(identity.data_home)
        == os.path.realpath(str(entry.get("data_home") or ""))
        else None
    )


def _safe_component(
    identity: WorkspaceIdentity,
    loader: WorkspaceLoader,
) -> dict[str, Any]:
    if identity.workspace_kind == "project" and (
        not identity.workspace_root or not os.path.isdir(identity.workspace_root)
    ):
        return _history_component(identity.as_dict(), "unavailable")
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


def _assignment_lifecycle(
    runtime_dir: str,
    record: Mapping[str, Any],
) -> dict[str, Any]:
    from kungfu import work_control

    status = work_control.assignment_orchestration_status(
        runtime_dir,
        initiative_id=str(record.get("initiative_id") or ""),
        assignment_id=str(record.get("assignment_id") or ""),
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


def _history_component(
    entry: Mapping[str, Any],
    availability: str,
    disposition: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return _bind_component_envelope(
        history_query.component_material(entry, availability, _now(), disposition)
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
