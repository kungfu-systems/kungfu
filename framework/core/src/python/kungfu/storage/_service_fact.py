# SPDX-License-Identifier: Apache-2.0

"""Fact, query, assessment, and trust storage operations."""

import time
from pathlib import Path
from typing import Any

from kungfu.storage._service_backend import _runtime_adapter as _runtime
from kungfu.storage.kfx_service import kfx_registry as _kfx_registry
from kungfu.storage.transfer import _binding_json, _u64


def build_fact_query_definition(
    *, episode_id: int = 0, cut: dict[str, Any] | None = None, limit: int = 100
) -> dict[str, Any]:
    """Build the canonical edge form consumed by the C++ query planner."""

    examples = _runtime().run_storage_service_operation(
        "query_plan", "", {"action": "examples"}
    )
    definition = dict(examples["examples"][0]["definition"])
    definition["basis"] = dict(definition["basis"])
    definition["basis"]["episode_id"] = _u64(episode_id)
    definition["basis"]["cut"] = cut or {"kind": "head"}
    definition["limit"] = limit
    return definition


def query_plan(
    runtime_dir: str | Path,
    *,
    action: str,
    definition: dict[str, Any] | None = None,
    object_name: str = "episodes",
    sql: str | None = None,
    engine: str = "authority",
) -> dict[str, Any]:
    """Use the C++-owned KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 planner and discovery contract."""

    options: dict[str, Any] = {
        "action": action,
        "object": object_name,
        "engine": engine,
    }
    if definition is not None:
        options["definition"] = definition
    if sql is not None:
        options["query"] = sql
    return dict(
        _runtime().run_storage_service_operation(
            "query_plan", str(runtime_dir), options
        )
    )


def fact_query_definition(
    runtime_dir: str | Path,
    definition: dict[str, Any],
    *,
    engine: str = "authority",
) -> dict[str, Any]:
    """Plan once and execute through the selected physical engine."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_query",
            str(runtime_dir),
            {"definition": definition, "engine": engine},
        )
    )


def fact_query(
    runtime_dir: str | Path,
    *,
    episode_id: int = 0,
    cut: dict[str, Any] | None = None,
    limit: int = 100,
    engine: str = "authority",
) -> dict[str, Any]:
    """Run the KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 Episode query through one declared engine."""

    return fact_query_definition(
        runtime_dir,
        build_fact_query_definition(episode_id=episode_id, cut=cut, limit=limit),
        engine=engine,
    )


def fact_changelog(
    runtime_dir: str | Path,
    definition: dict[str, Any],
    *,
    resume_token: dict[str, Any] | None = None,
    max_messages: int = 100,
) -> dict[str, Any]:
    """Read one deterministic page of the KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 proof changelog."""

    options: dict[str, Any] = {
        "definition": definition,
        "max_messages": max_messages,
    }
    if resume_token is not None:
        options["resume_token"] = resume_token
    return dict(
        _runtime().run_storage_service_operation(
            "fact_changelog", str(runtime_dir), options
        )
    )


def saved_query_catalog(
    runtime_dir: str | Path, action: str = "list", **kwargs: Any
) -> dict[str, Any]:
    """Operate the workspace-local journal-backed saved-query catalog."""
    return dict(
        _runtime().run_storage_service_operation(
            "saved_query_catalog", str(runtime_dir), {"action": action, **kwargs}
        )
    )


def profile_lifecycle(
    runtime_dir: str | Path, action: str = "list", **kwargs: Any
) -> dict[str, Any]:
    """Operate the Core-owned journal-backed Profile Suite lifecycle."""
    return dict(
        _runtime().run_storage_service_operation(
            "profile_lifecycle", str(runtime_dir), {"action": action, **kwargs}
        )
    )


def kfx_registry(
    action: str,
    request: dict[str, Any],
    runtime_dir: str | Path = "",
) -> dict[str, Any]:
    """Project one Core-native KFX registry or lifecycle operation."""

    return _kfx_registry(action, request, runtime_dir, runtime=_runtime())


def fact_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the C++-owned KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03 declaration/admission contract."""

    return dict(
        _runtime().run_storage_service_operation("fact_contract", str(runtime_dir), {})
    )


def fact_kernel(
    runtime_dir: str | Path,
    action: str,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Forward one generic Fact operation to the Core-owned native kernel."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_kernel", str(runtime_dir), {"action": action, **(request or {})}
        )
    )


def action_runtime(
    runtime_dir: str | Path,
    action: str,
    request: dict[str, Any] | None = None,
) -> Any:
    """Forward one Action Geometry / Domain Profile / Profile action to native.

    Most actions return a JSON object; ``session_valid_actions`` returns a JSON
    array, so the wrapper preserves non-object results instead of forcing dict().
    """

    operation_request = {"action": action, **(request or {})}
    if "search_base" not in operation_request:
        from kungfu import host

        product_root = host.product_root()
        if product_root is not None:
            operation_request["search_base"] = str(product_root)

    result = _runtime().run_storage_service_operation(
        "action_runtime", str(runtime_dir), operation_request
    )
    return dict(result) if isinstance(result, dict) else result


def fact_profile_shadow_project(
    runtime_dir: str | Path, document: dict[str, Any]
) -> dict[str, Any]:
    """Project Profile source material through the native Fact kernel."""

    from kungfu.storage import fact_profile_shadow

    return fact_profile_shadow.project(runtime_dir, document)


def fact_profile_shadow_inspect(
    runtime_dir: str | Path, *, cut_root: str = "", ref_name: str = ""
) -> dict[str, Any]:
    """Inspect one shadow Cut without selecting it as authority."""

    from kungfu.storage import fact_profile_shadow

    return fact_profile_shadow.inspect(
        runtime_dir, cut_root=cut_root, ref_name=ref_name
    )


def fact_profile_shadow_compare(
    expected: dict[str, Any], actual: dict[str, Any]
) -> dict[str, Any]:
    """Compare an authoritative source view with a shadow projection."""

    from kungfu.storage import fact_profile_shadow

    return fact_profile_shadow.compare(expected, actual)


def fact_kernel_fsck(runtime_dir: str | Path, *, cut_root: str = "") -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.fsck(runtime_dir, cut_root=cut_root)


def fact_kernel_export(
    runtime_dir: str | Path, *, cut_root: str = "", ref_name: str = ""
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.export_bundle(
        runtime_dir, cut_root=cut_root, ref_name=ref_name
    )


def fact_kernel_import(
    runtime_dir: str | Path, bundle: dict[str, Any], *, dry_run: bool = True
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.import_bundle(runtime_dir, bundle, dry_run=dry_run)


def fact_kernel_retention_plan(
    runtime_dir: str | Path, *, cut_roots: list[str] | None = None
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.retention_plan(runtime_dir, cut_roots=cut_roots)


def fact_kernel_rebuild_projections(runtime_dir: str | Path) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.rebuild_projections(runtime_dir)


def fact_kernel_backend_parity(
    runtime_dir: str | Path, *, target_provider: str
) -> dict[str, Any]:
    from kungfu.storage import fact_kernel_integrity

    return fact_kernel_integrity.qualify_backend_parity(
        runtime_dir, target_provider=target_provider
    )


def fact_declare_contract_world(
    runtime_dir: str | Path,
    declaration: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_declare_world",
            str(runtime_dir),
            {"declaration": declaration, "system_time": system_time},
        )
    )


def fact_declare_surface(
    runtime_dir: str | Path,
    declaration: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_declare_surface",
            str(runtime_dir),
            {"declaration": declaration, "system_time": system_time},
        )
    )


def fact_observe(
    runtime_dir: str | Path,
    observation: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_observe",
            str(runtime_dir),
            {"observation": observation, "system_time": system_time},
        )
    )


def fact_state(
    runtime_dir: str | Path,
    *,
    cut_system_time: int = 0,
    subject_key: str = "",
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_state",
            str(runtime_dir),
            {"cut_system_time": cut_system_time, "subject_key": subject_key},
        )
    )


def fact_library_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the supported end-user Fact Library contract."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_library_contract", str(runtime_dir), {}
        )
    )


def fact_type_create(
    runtime_dir: str | Path,
    definition: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    """Create or idempotently recover one versioned managed fact type."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_type_create",
            str(runtime_dir),
            {"definition": definition, "system_time": system_time},
        )
    )


def fact_type_list(
    runtime_dir: str | Path,
    *,
    cut_system_time: int = 0,
    scope: str = "selected-data-root",
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_type_list",
            str(runtime_dir),
            {"cut_system_time": cut_system_time, "scope": scope},
        )
    )


def fact_material_put(
    runtime_dir: str | Path,
    material: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    """Store JSON material and record its admitted observation in one intent."""

    return dict(
        _runtime().run_storage_service_operation(
            "fact_material_put",
            str(runtime_dir),
            {"material": material, "system_time": system_time},
        )
    )


def fact_material_list(
    runtime_dir: str | Path,
    *,
    type_id: str = "",
    subject_key: str = "",
    cut_system_time: int = 0,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_material_list",
            str(runtime_dir),
            {
                "type_id": type_id,
                "subject_key": subject_key,
                "cut_system_time": cut_system_time,
            },
        )
    )


def fact_library_export(
    runtime_dir: str | Path,
    *,
    thin: bool = False,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_library_export", str(runtime_dir), {"thin": thin}
        )
    )


def fact_library_import(
    runtime_dir: str | Path,
    library_bundle: dict[str, Any],
    *,
    dry_run: bool = True,
) -> dict[str, Any]:
    return dict(
        _runtime().run_storage_service_operation(
            "fact_library_import",
            str(runtime_dir),
            {"library_bundle": _binding_json(library_bundle), "dry_run": dry_run},
        )
    )


def assessment_contract(runtime_dir: str | Path = "") -> dict[str, Any]:
    """Return the C++-owned KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment contract."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_contract", str(runtime_dir), {}
        )
    )


def assessment_request(
    runtime_dir: str | Path,
    request: dict[str, Any],
    *,
    system_time: int = 0,
) -> dict[str, Any]:
    """Persist an assessment intent without blocking the work Episode seal."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_request",
            str(runtime_dir),
            {"request": request, "system_time": system_time},
        )
    )


def assessment_execute(
    runtime_dir: str | Path,
    assessment_key: str,
    *,
    executor_profile: str = "process",
    system_time: int = 0,
) -> dict[str, Any]:
    """Execute or deduplicate a durable assessment job."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_execute",
            str(runtime_dir),
            {
                "assessment_key": assessment_key,
                "executor_profile": executor_profile,
                "system_time": system_time,
            },
        )
    )


def assessment_status(runtime_dir: str | Path, assessment_key: str) -> dict[str, Any]:
    """Fold the durable lifecycle of one assessment key."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_status",
            str(runtime_dir),
            {"assessment_key": assessment_key},
        )
    )


def assessment_list(runtime_dir: str | Path) -> dict[str, Any]:
    """List durable assessment lifecycle folds for workspace scheduling."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_list", str(runtime_dir), {}
        )
    )


def assessment_invalidate(
    runtime_dir: str | Path,
    assessment_key: str,
    *,
    changed_root: str,
    reason: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    """Mark a report stale only when the changed root is one of its inputs."""

    return dict(
        _runtime().run_storage_service_operation(
            "assessment_invalidate",
            str(runtime_dir),
            {
                "assessment_key": assessment_key,
                "changed_root": changed_root,
                "reason": reason,
                "system_time": system_time,
            },
        )
    )


def trust_require(
    runtime_dir: str | Path, assessment_key: str, *, purpose: str
) -> dict[str, Any]:
    """Fail closed unless a fresh report is bound to the requested purpose."""

    return dict(
        _runtime().run_storage_service_operation(
            "trust_require",
            str(runtime_dir),
            {"assessment_key": assessment_key, "purpose": purpose},
        )
    )


def trust_await(
    runtime_dir: str | Path,
    assessment_key: str,
    *,
    purpose: str,
    timeout_seconds: float,
    poll_interval_seconds: float = 0.05,
) -> dict[str, Any]:
    """Wait a bounded time, then fail closed without changing Episode seal state."""

    deadline = time.monotonic() + max(timeout_seconds, 0.0)
    while True:
        result = trust_require(runtime_dir, assessment_key, purpose=purpose)
        if result["allowed"] or result["reason"] not in {
            "assessment-not-found",
            "assessment-not-fresh",
        }:
            return result
        status = assessment_status(runtime_dir, assessment_key)
        if status.get("state") not in {None, "pending", "running"}:
            return result
        if time.monotonic() >= deadline:
            return {
                "schema": "kungfu.trust.assessment/v1",
                "allowed": False,
                "reason": "trust-timeout",
                "assessment_key": assessment_key,
                "purpose": purpose,
                "state": status.get("state", "missing"),
            }
        time.sleep(max(poll_interval_seconds, 0.001))


def compile_fact_query_sql(
    runtime_dir: str | Path, *, sql: str, definition: dict[str, Any]
) -> dict[str, Any]:
    """Compile the bounded SQL subset into the canonical LogicalPlan."""

    return query_plan(
        runtime_dir,
        action="compile-sql",
        definition=definition,
        sql=sql,
    )


def fact_query_conformance(
    runtime_dir: str | Path, definition: dict[str, Any]
) -> dict[str, Any]:
    """Compare authority and SQLite execution at the public semantic seam."""

    authority = fact_query_definition(runtime_dir, definition, engine="authority")
    sqlite = fact_query_definition(runtime_dir, definition, engine="sqlite")
    authority_lineage = dict(authority["lineage"])
    sqlite_lineage = dict(sqlite["lineage"])
    authority_lineage.pop("execution", None)
    sqlite_lineage.pop("execution", None)
    checks = {
        "definition": authority["definition"] == sqlite["definition"],
        "logical_plan": authority["logical_plan"] == sqlite["logical_plan"],
        "result_schema": authority["result_schema"] == sqlite["result_schema"],
        "rows": authority["rows"] == sqlite["rows"],
        "result_hash": authority["result_hash"] == sqlite["result_hash"],
        "lineage_semantics": authority_lineage == sqlite_lineage,
        "lineage_authority": (
            authority["lineage"]["authority"] == sqlite["lineage"]["authority"]
        ),
        "lineage_cut": authority["lineage"]["cut"] == sqlite["lineage"]["cut"],
        "lineage_admission": (
            authority["lineage"]["admission_outcomes"]
            == sqlite["lineage"]["admission_outcomes"]
        ),
        "canonical_state": (
            authority["lineage"]["canonical_state"]
            == sqlite["lineage"]["canonical_state"]
        ),
    }
    return {
        "schema": "kungfu.query.conformance/v1",
        "ok": all(checks.values()),
        "checks": checks,
        "authority": authority,
        "sqlite": sqlite,
    }
