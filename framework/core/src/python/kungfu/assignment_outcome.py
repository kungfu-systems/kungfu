# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Mapping, cast

OUTCOME_SCHEMA = "kungfu.work-design.outcome/v1"
OUTCOME_BINDING_SCHEMA = (
    "kungfu.assignment-orchestration.work-design-outcome-binding/v1"
)
OUTCOME_INDEX_SCHEMA = "kungfu.assignment-orchestration.work-design-outcome-index/v1"

_canonical: Any = None
_storage_resolver = cast(Callable[[Path], tuple[Path, str]], None)


def validate_artifact(value: Any) -> dict[str, Any]:
    outcome = _canonical._strict_object(
        value,
        {
            "schema",
            "assignmentId",
            "asOf",
            "bindings",
            "cohort",
            "window",
            "metrics",
            "coverage",
            "evidence",
            "authority",
            "outcomeRoot",
        },
        "Work Design outcome",
    )
    if outcome.get("schema") != OUTCOME_SCHEMA:
        raise ValueError("unsupported Work Design outcome schema")
    if _canonical.semantic_root(
        {key: value for key, value in outcome.items() if key != "outcomeRoot"}
    ) != outcome.get("outcomeRoot"):
        raise ValueError("Work Design outcome root mismatch")
    bindings = _canonical._strict_object(
        outcome.get("bindings"),
        {"workDefinitionRoot", "adviceRoot", "policyRoot"},
        "Work Design outcome bindings",
    )
    for field, root in bindings.items():
        if not isinstance(root, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", root):
            raise ValueError(f"Work Design outcome bindings.{field} is invalid")
    cohort = _canonical._strict_object(
        outcome.get("cohort"),
        {"deliveryClass", "workClass", "repositoryClass", "cohortRoot"},
        "Work Design outcome cohort",
    )
    if _canonical.semantic_root(
        {key: value for key, value in cohort.items() if key != "cohortRoot"}
    ) != cohort.get("cohortRoot"):
        raise ValueError("Work Design outcome cohort root mismatch")
    coverage = _canonical._strict_object(
        outcome.get("coverage"),
        {"qualifiedMetrics", "unknownMetrics", "complete", "coverageRoot"},
        "Work Design outcome coverage",
    )
    if _canonical.semantic_root(
        {key: value for key, value in coverage.items() if key != "coverageRoot"}
    ) != coverage.get("coverageRoot"):
        raise ValueError("Work Design outcome coverage root mismatch")
    if not isinstance(coverage.get("complete"), bool):
        raise ValueError("Work Design outcome coverage.complete must be boolean")
    qualified = _canonical._sorted_unique_strings(
        coverage.get("qualifiedMetrics"),
        "Work Design outcome coverage.qualifiedMetrics",
        allow_empty=True,
    )
    unknown = _canonical._sorted_unique_strings(
        coverage.get("unknownMetrics"),
        "Work Design outcome coverage.unknownMetrics",
        allow_empty=True,
    )
    metric_names = {"acceptanceFailure", "dependencyCorrection", "rework", "timeout"}
    if set(qualified) | set(unknown) != metric_names or set(qualified) & set(unknown):
        raise ValueError("Work Design outcome coverage must classify every metric once")
    if coverage["complete"] is not (not unknown):
        raise ValueError(
            "Work Design outcome coverage.complete contradicts unknown metrics"
        )
    window = _canonical._strict_object(
        outcome.get("window"),
        {"admittedAt", "settledAt", "attributableActiveSeconds", "excludedWaitSeconds"},
        "Work Design outcome window",
    )
    admitted = _canonical._timestamp(
        window.get("admittedAt"), "Work Design outcome admittedAt"
    )
    settled = _canonical._timestamp(
        window.get("settledAt"), "Work Design outcome settledAt"
    )
    if settled < admitted:
        raise ValueError("Work Design outcome settledAt precedes admittedAt")
    if (
        not isinstance(window.get("attributableActiveSeconds"), int)
        or isinstance(window.get("attributableActiveSeconds"), bool)
        or window["attributableActiveSeconds"] < 0
    ):
        raise ValueError("Work Design outcome attributableActiveSeconds is invalid")
    waits = _canonical._strict_object(
        window.get("excludedWaitSeconds"),
        {"ci-queue", "external-review", "human-decision", "platform-approval"},
        "Work Design outcome excluded waits",
    )
    if any(
        not isinstance(seconds, int) or isinstance(seconds, bool) or seconds < 0
        for seconds in waits.values()
    ):
        raise ValueError("Work Design outcome excluded wait seconds are invalid")
    metrics = _canonical._strict_object(
        outcome.get("metrics"), metric_names, "Work Design outcome metrics"
    )
    count_metrics = {
        "acceptanceFailure": "assessmentRoots",
        "dependencyCorrection": "revisionRoots",
        "rework": "eventRoots",
    }
    for name, root_field in count_metrics.items():
        metric = _canonical._strict_object(
            metrics.get(name),
            {"status", "count", root_field},
            f"Work Design outcome {name}",
        )
        expected_status = "qualified" if name in qualified else "unknown"
        if metric.get("status") != expected_status:
            raise ValueError(f"Work Design outcome {name} status contradicts coverage")
        count = metric.get("count")
        if expected_status == "qualified" and (
            not isinstance(count, int) or isinstance(count, bool) or count < 0
        ):
            raise ValueError(f"Work Design outcome {name} count is invalid")
        if expected_status == "unknown" and count is not None:
            raise ValueError(f"Work Design outcome {name} unknown count must be null")
        roots = _canonical._sorted_unique_strings(
            metric.get(root_field),
            f"Work Design outcome {name}.{root_field}",
            allow_empty=True,
        )
        if not all(re.fullmatch(r"sha256:[0-9a-f]{64}", root) for root in roots):
            raise ValueError(f"Work Design outcome {name}.{root_field} is invalid")
    timeout_fields = {
        "status",
        "plannedBudgetSeconds",
        "attributableActiveSeconds",
        "overrunSeconds",
        "exceeded",
    }
    timeout = _canonical._strict_object(
        metrics.get("timeout"), timeout_fields, "Work Design outcome timeout"
    )
    timeout_status = "qualified" if "timeout" in qualified else "unknown"
    if timeout.get("status") != timeout_status:
        raise ValueError("Work Design outcome timeout status contradicts coverage")
    for field in (
        "plannedBudgetSeconds",
        "attributableActiveSeconds",
        "overrunSeconds",
    ):
        number = timeout.get(field)
        if timeout_status == "qualified" and (
            not isinstance(number, int) or isinstance(number, bool) or number < 0
        ):
            raise ValueError(f"Work Design outcome timeout.{field} is invalid")
        if timeout_status == "unknown" and number is not None:
            raise ValueError(f"Work Design outcome timeout.{field} must be null")
    if timeout_status == "qualified" and not isinstance(timeout.get("exceeded"), bool):
        raise ValueError("Work Design outcome timeout.exceeded is invalid")
    if timeout_status == "unknown" and timeout.get("exceeded") is not None:
        raise ValueError("Work Design outcome timeout.exceeded must be null")
    evidence = _canonical._strict_object(
        outcome.get("evidence"),
        {"settledStateRoot", "queryProofRoot", "sourceEvidenceRoots"},
        "Work Design outcome evidence",
    )
    for field in ("settledStateRoot", "queryProofRoot"):
        if not isinstance(evidence.get(field), str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", evidence[field]
        ):
            raise ValueError(f"Work Design outcome evidence.{field} is invalid")
    _canonical._sorted_unique_strings(
        evidence.get("sourceEvidenceRoots"), "Work Design outcome sourceEvidenceRoots"
    )
    if not all(
        re.fullmatch(r"sha256:[0-9a-f]{64}", root)
        for root in evidence["sourceEvidenceRoots"]
    ):
        raise ValueError("Work Design outcome sourceEvidenceRoots are invalid")
    expected_authority = {
        "mode": "settled-work-observation",
        "factAuthority": False,
        "episodeAuthority": False,
        "assignmentAuthority": False,
        "workControlAuthority": False,
        "policyAuthority": False,
        "mayMutate": False,
    }
    if outcome.get("authority") != expected_authority:
        raise ValueError("Work Design outcome authority boundary is invalid")
    if not isinstance(outcome.get("assignmentId"), str) or not outcome["assignmentId"]:
        raise ValueError("Work Design outcome assignmentId is invalid")
    _canonical._timestamp(outcome.get("asOf"), "Work Design outcome asOf")
    return outcome


def plan(
    workspace_root: str | Path,
    sealed_state: Mapping[str, Any],
    outcome: Any,
    *,
    opening_estimate_root: str | None = None,
    published_at: str,
) -> dict[str, Any]:
    """Plan an additive immutable outcome binding beside portable Work seals."""

    root = Path(workspace_root).expanduser().resolve()
    coordinate = _canonical._strict_object(
        sealed_state,
        {
            "schema",
            "assignment_subject",
            "workspace_identity_root",
            "state_root",
            "query_proof_root",
            "phase",
            "settled",
            "storage_kind",
        },
        "sealed Work coordinate",
    )
    if (
        coordinate.get("schema")
        != "kungfu.assignment-orchestration.sealed-work-coordinate/v1"
    ):
        raise ValueError("unsupported sealed Work coordinate schema")
    if (
        coordinate.get("settled") is not True
        or coordinate.get("phase") != "continuation-decided"
    ):
        raise ValueError("outcome binding requires a settled Assignment state")
    artifact = validate_artifact(outcome)
    evidence = artifact["evidence"]
    if evidence["settledStateRoot"] != coordinate.get("state_root"):
        raise ValueError("outcome settled state root mismatch")
    if evidence["queryProofRoot"] != coordinate.get("query_proof_root"):
        raise ValueError("outcome query proof root mismatch")
    expected_subject = f"kungfu:{artifact['assignmentId']}"
    if expected_subject != coordinate.get("assignment_subject"):
        raise ValueError("outcome Assignment subject mismatch")
    if opening_estimate_root is not None and not re.fullmatch(
        r"sha256:[0-9a-f]{64}", opening_estimate_root
    ):
        raise ValueError("opening estimate root is invalid")
    published = _canonical._timestamp(published_at, "published_at")
    if _canonical._timestamp(artifact["asOf"], "outcome asOf") > published:
        raise ValueError("outcome publication cannot precede outcome asOf")
    binding = {
        "schema": OUTCOME_BINDING_SCHEMA,
        "assignment_subject": coordinate["assignment_subject"],
        "workspace_identity_root": coordinate["workspace_identity_root"],
        "settled_state_root": coordinate["state_root"],
        "state_query_proof_root": coordinate["query_proof_root"],
        "opening_estimate_root": opening_estimate_root,
        "published_at": published_at,
        "outcome": artifact,
    }
    binding_root = _canonical.semantic_root(binding)
    storage_root, storage_kind = _storage_resolver(root)
    digest = binding_root.removeprefix(_canonical.ROOT)
    return {
        "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-plan/v1",
        "binding": {**binding, "binding_root": binding_root},
        "binding_root": binding_root,
        "binding_path": str(
            Path("work-design-outcomes")
            / "sha256"
            / digest[:2]
            / digest
            / "binding.json"
        ),
        "storage_kind": storage_kind,
        "storage_root": str(storage_root),
        "workspace_root": str(root),
        "writes": ["immutable-content-addressed-outcome-binding"],
    }


def verify(value: Any) -> dict[str, Any]:
    try:
        binding = _canonical._strict_object(
            value,
            {
                "schema",
                "assignment_subject",
                "workspace_identity_root",
                "settled_state_root",
                "state_query_proof_root",
                "opening_estimate_root",
                "published_at",
                "outcome",
                "binding_root",
            },
            "Work Design outcome binding",
        )
        if binding.get("schema") != OUTCOME_BINDING_SCHEMA:
            raise ValueError("unsupported Work Design outcome binding schema")
        for field in (
            "workspace_identity_root",
            "settled_state_root",
            "state_query_proof_root",
            "binding_root",
        ):
            if not isinstance(binding.get(field), str) or not re.fullmatch(
                r"sha256:[0-9a-f]{64}", binding[field]
            ):
                raise ValueError(f"outcome binding {field} is invalid")
        if binding.get("opening_estimate_root") is not None and not re.fullmatch(
            r"sha256:[0-9a-f]{64}", str(binding["opening_estimate_root"])
        ):
            raise ValueError("outcome binding opening_estimate_root is invalid")
        published = _canonical._timestamp(
            binding.get("published_at"), "outcome binding published_at"
        )
        outcome = validate_artifact(binding.get("outcome"))
        if _canonical._timestamp(outcome["asOf"], "outcome asOf") > published:
            raise ValueError("outcome publication precedes outcome asOf")
        if binding["settled_state_root"] != outcome["evidence"]["settledStateRoot"]:
            raise ValueError("outcome binding settled state root mismatch")
        if binding["state_query_proof_root"] != outcome["evidence"]["queryProofRoot"]:
            raise ValueError("outcome binding query proof root mismatch")
        if binding["assignment_subject"] != f"kungfu:{outcome['assignmentId']}":
            raise ValueError("outcome binding Assignment subject mismatch")
        preimage = {key: item for key, item in binding.items() if key != "binding_root"}
        if _canonical.semantic_root(preimage) != binding["binding_root"]:
            raise ValueError("outcome binding root mismatch")
        return {
            "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-verification/v1",
            "ok": True,
            "binding_root": binding["binding_root"],
            "issues": [],
            "writes": [],
        }
    except (TypeError, ValueError) as error:
        return {
            "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-verification/v1",
            "ok": False,
            "binding_root": value.get("binding_root")
            if isinstance(value, Mapping)
            else None,
            "issues": [{"code": "outcome-binding-invalid", "message": str(error)}],
            "writes": [],
        }


def apply(plan: Mapping[str, Any], expected_binding_root: str) -> dict[str, Any]:
    if plan.get("binding_root") != expected_binding_root:
        raise ValueError("outcome binding changed before execution")
    binding = plan.get("binding")
    verification = verify(binding)
    if not verification["ok"]:
        raise ValueError(verification["issues"][0]["message"])
    path = Path(str(plan["storage_root"])) / str(plan["binding_path"])
    content = (_canonical.canonical_json(binding) + "\n").encode("utf-8")
    if path.exists() and path.read_bytes() != content:
        raise ValueError(f"immutable outcome-binding collision: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(content)
    return {
        "schema": "kungfu.assignment-orchestration.work-design-outcome-binding-receipt/v1",
        "bindingRoot": expected_binding_root,
        "bindingPath": str(path),
        "storageKind": str(plan["storage_kind"]),
        "portable": True,
        "writes": [str(path)],
        "next_actions": [],
    }


def list_bindings(workspace_root: str | Path) -> dict[str, Any]:
    """Read and fail closed over additive rooted outcome bindings."""

    root = Path(workspace_root).expanduser().resolve()
    storage_root, storage_kind = _storage_resolver(root)
    index_root = storage_root / "work-design-outcomes" / "sha256"
    by_state: dict[str, list[dict[str, Any]]] = {}
    issues: list[dict[str, Any]] = []
    for binding_path in sorted(index_root.glob("*/*/binding.json")):
        try:
            binding = json.loads(binding_path.read_text(encoding="utf-8"))
            verification = verify(binding)
            if not verification["ok"]:
                raise ValueError(verification["issues"][0]["message"])
            by_state.setdefault(str(binding["settled_state_root"]), []).append(binding)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            issues.append(
                {
                    "code": "outcome-binding-invalid",
                    "path": str(binding_path.relative_to(storage_root)),
                    "message": str(error),
                }
            )
    bindings: list[dict[str, Any]] = []
    for state_root, rows in sorted(by_state.items()):
        unique = {str(row["binding_root"]): row for row in rows}
        if len(unique) != 1:
            issues.append(
                {
                    "code": "conflicting-outcome-bindings",
                    "settled_state_root": state_root,
                    "binding_roots": sorted(unique),
                    "message": "one settled state has multiple distinct outcome bindings",
                }
            )
            continue
        bindings.append(next(iter(unique.values())))
    body = {
        "schema": OUTCOME_INDEX_SCHEMA,
        "bindings": bindings,
        "issues": sorted(issues, key=_canonical.semantic_root),
        "storage_kind": storage_kind,
        "writes": [],
    }
    return {**body, "index_root": _canonical.semantic_root(body)}
