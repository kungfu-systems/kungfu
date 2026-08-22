# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable, Mapping


class OutcomeBindings:
    OUTCOME_SCHEMA = "kungfu.work-design.outcome/v1"
    BINDING_SCHEMA = "kungfu.assignment-orchestration.work-design-outcome-binding/v1"
    INDEX_SCHEMA = "kungfu.assignment-orchestration.work-design-outcome-index/v1"
    ROOT_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
    METRIC_NAMES = {
        "acceptanceFailure",
        "dependencyCorrection",
        "rework",
        "timeout",
    }
    EXPECTED_AUTHORITY = {
        "mode": "settled-work-observation",
        "factAuthority": False,
        "episodeAuthority": False,
        "assignmentAuthority": False,
        "workControlAuthority": False,
        "policyAuthority": False,
        "mayMutate": False,
    }

    def __init__(
        self,
        canonical: Any,
        storage_resolver: Callable[[Path], tuple[Path, str]],
    ) -> None:
        self._canonical = canonical
        self._storage_resolver = storage_resolver

    def _root(self, value: Any, label: str) -> str:
        if not isinstance(value, str) or not self.ROOT_PATTERN.fullmatch(value):
            raise ValueError(f"{label} is invalid")
        return value

    def _rooted_object(
        self,
        value: Any,
        fields: set[str],
        label: str,
        root_field: str,
    ) -> dict[str, Any]:
        document = self._canonical._strict_object(value, fields, label)
        preimage = {key: item for key, item in document.items() if key != root_field}
        if self._canonical.semantic_root(preimage) != document.get(root_field):
            raise ValueError(f"{label} root mismatch")
        return document

    def _validate_bindings(self, value: Any) -> None:
        bindings = self._canonical._strict_object(
            value,
            {"workDefinitionRoot", "adviceRoot", "policyRoot"},
            "Work Design outcome bindings",
        )
        for field, root in bindings.items():
            self._root(root, f"Work Design outcome bindings.{field}")

    def _validate_coverage(self, value: Any) -> tuple[set[str], set[str]]:
        coverage = self._rooted_object(
            value,
            {"qualifiedMetrics", "unknownMetrics", "complete", "coverageRoot"},
            "Work Design outcome coverage",
            "coverageRoot",
        )
        if not isinstance(coverage.get("complete"), bool):
            raise ValueError("Work Design outcome coverage.complete must be boolean")
        qualified = set(
            self._canonical._sorted_unique_strings(
                coverage.get("qualifiedMetrics"),
                "Work Design outcome coverage.qualifiedMetrics",
                allow_empty=True,
            )
        )
        unknown = set(
            self._canonical._sorted_unique_strings(
                coverage.get("unknownMetrics"),
                "Work Design outcome coverage.unknownMetrics",
                allow_empty=True,
            )
        )
        if qualified | unknown != self.METRIC_NAMES or qualified & unknown:
            raise ValueError(
                "Work Design outcome coverage must classify every metric once"
            )
        if coverage["complete"] is not (not unknown):
            raise ValueError(
                "Work Design outcome coverage.complete contradicts unknown metrics"
            )
        return qualified, unknown

    def _validate_window(self, value: Any) -> None:
        window = self._canonical._strict_object(
            value,
            {
                "admittedAt",
                "settledAt",
                "attributableActiveSeconds",
                "excludedWaitSeconds",
            },
            "Work Design outcome window",
        )
        admitted = self._canonical._timestamp(
            window.get("admittedAt"), "Work Design outcome admittedAt"
        )
        settled = self._canonical._timestamp(
            window.get("settledAt"), "Work Design outcome settledAt"
        )
        if settled < admitted:
            raise ValueError("Work Design outcome settledAt precedes admittedAt")
        active = window.get("attributableActiveSeconds")
        if not isinstance(active, int) or isinstance(active, bool) or active < 0:
            raise ValueError("Work Design outcome attributableActiveSeconds is invalid")
        waits = self._canonical._strict_object(
            window.get("excludedWaitSeconds"),
            {"ci-queue", "external-review", "human-decision", "platform-approval"},
            "Work Design outcome excluded waits",
        )
        if any(
            not isinstance(seconds, int) or isinstance(seconds, bool) or seconds < 0
            for seconds in waits.values()
        ):
            raise ValueError("Work Design outcome excluded wait seconds are invalid")

    def _validate_count_metric(
        self,
        name: str,
        metric: Mapping[str, Any],
        expected_status: str,
        root_field: str,
    ) -> None:
        count = metric.get("count")
        if expected_status == "qualified":
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise ValueError(f"Work Design outcome {name} count is invalid")
        elif count is not None:
            raise ValueError(f"Work Design outcome {name} unknown count must be null")
        roots = self._canonical._sorted_unique_strings(
            metric.get(root_field),
            f"Work Design outcome {name}.{root_field}",
            allow_empty=True,
        )
        if not all(self.ROOT_PATTERN.fullmatch(root) for root in roots):
            raise ValueError(f"Work Design outcome {name}.{root_field} is invalid")

    def _validate_timeout_metric(
        self, metric: Mapping[str, Any], expected_status: str
    ) -> None:
        for field in (
            "plannedBudgetSeconds",
            "attributableActiveSeconds",
            "overrunSeconds",
        ):
            number = metric.get(field)
            if expected_status == "qualified":
                if (
                    not isinstance(number, int)
                    or isinstance(number, bool)
                    or number < 0
                ):
                    raise ValueError(f"Work Design outcome timeout.{field} is invalid")
            elif number is not None:
                raise ValueError(f"Work Design outcome timeout.{field} must be null")
        exceeded = metric.get("exceeded")
        if expected_status == "qualified" and not isinstance(exceeded, bool):
            raise ValueError("Work Design outcome timeout.exceeded is invalid")
        if expected_status == "unknown" and exceeded is not None:
            raise ValueError("Work Design outcome timeout.exceeded must be null")

    def _validate_metrics(self, value: Any, qualified: set[str]) -> None:
        metrics = self._canonical._strict_object(
            value, self.METRIC_NAMES, "Work Design outcome metrics"
        )
        field_sets = {
            "acceptanceFailure": {"status", "count", "assessmentRoots"},
            "dependencyCorrection": {"status", "count", "revisionRoots"},
            "rework": {"status", "count", "eventRoots"},
            "timeout": {
                "status",
                "plannedBudgetSeconds",
                "attributableActiveSeconds",
                "overrunSeconds",
                "exceeded",
            },
        }
        for name, fields in field_sets.items():
            metric = self._canonical._strict_object(
                metrics.get(name), fields, f"Work Design outcome {name}"
            )
            expected_status = "qualified" if name in qualified else "unknown"
            if metric.get("status") != expected_status:
                raise ValueError(
                    f"Work Design outcome {name} status contradicts coverage"
                )
            if name == "timeout":
                self._validate_timeout_metric(metric, expected_status)
            else:
                root_field = next(field for field in fields if field.endswith("Roots"))
                self._validate_count_metric(name, metric, expected_status, root_field)

    def _validate_evidence(self, value: Any) -> None:
        evidence = self._canonical._strict_object(
            value,
            {"settledStateRoot", "queryProofRoot", "sourceEvidenceRoots"},
            "Work Design outcome evidence",
        )
        for field in ("settledStateRoot", "queryProofRoot"):
            self._root(evidence.get(field), f"Work Design outcome evidence.{field}")
        roots = self._canonical._sorted_unique_strings(
            evidence.get("sourceEvidenceRoots"),
            "Work Design outcome sourceEvidenceRoots",
        )
        if not all(self.ROOT_PATTERN.fullmatch(root) for root in roots):
            raise ValueError("Work Design outcome sourceEvidenceRoots are invalid")

    def validate_artifact(self, value: Any) -> dict[str, Any]:
        outcome = self._rooted_object(
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
            "outcomeRoot",
        )
        if outcome.get("schema") != self.OUTCOME_SCHEMA:
            raise ValueError("unsupported Work Design outcome schema")
        self._validate_bindings(outcome.get("bindings"))
        self._rooted_object(
            outcome.get("cohort"),
            {"deliveryClass", "workClass", "repositoryClass", "cohortRoot"},
            "Work Design outcome cohort",
            "cohortRoot",
        )
        qualified, _unknown = self._validate_coverage(outcome.get("coverage"))
        self._validate_window(outcome.get("window"))
        self._validate_metrics(outcome.get("metrics"), qualified)
        self._validate_evidence(outcome.get("evidence"))
        if outcome.get("authority") != self.EXPECTED_AUTHORITY:
            raise ValueError("Work Design outcome authority boundary is invalid")
        assignment_id = outcome.get("assignmentId")
        if not isinstance(assignment_id, str) or not assignment_id:
            raise ValueError("Work Design outcome assignmentId is invalid")
        self._canonical._timestamp(outcome.get("asOf"), "Work Design outcome asOf")
        return outcome

    def _coordinate(self, sealed_state: Mapping[str, Any]) -> dict[str, Any]:
        coordinate = self._canonical._strict_object(
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
        return coordinate

    def plan(
        self,
        workspace_root: str | Path,
        sealed_state: Mapping[str, Any],
        outcome: Any,
        *,
        opening_estimate_root: str | None = None,
        published_at: str,
    ) -> dict[str, Any]:
        root = Path(workspace_root).expanduser().resolve()
        coordinate = self._coordinate(sealed_state)
        artifact = self.validate_artifact(outcome)
        evidence = artifact["evidence"]
        if evidence["settledStateRoot"] != coordinate.get("state_root"):
            raise ValueError("outcome settled state root mismatch")
        if evidence["queryProofRoot"] != coordinate.get("query_proof_root"):
            raise ValueError("outcome query proof root mismatch")
        if f"kungfu:{artifact['assignmentId']}" != coordinate.get("assignment_subject"):
            raise ValueError("outcome Assignment subject mismatch")
        if opening_estimate_root is not None:
            self._root(opening_estimate_root, "opening estimate root")
        published = self._canonical._timestamp(published_at, "published_at")
        if self._canonical._timestamp(artifact["asOf"], "outcome asOf") > published:
            raise ValueError("outcome publication cannot precede outcome asOf")
        binding = {
            "schema": self.BINDING_SCHEMA,
            "assignment_subject": coordinate["assignment_subject"],
            "workspace_identity_root": coordinate["workspace_identity_root"],
            "settled_state_root": coordinate["state_root"],
            "state_query_proof_root": coordinate["query_proof_root"],
            "opening_estimate_root": opening_estimate_root,
            "published_at": published_at,
            "outcome": artifact,
        }
        binding_root = self._canonical.semantic_root(binding)
        storage_root, storage_kind = self._storage_resolver(root)
        digest = binding_root.removeprefix(self._canonical.ROOT)
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

    def _binding(self, value: Any) -> dict[str, Any]:
        binding = self._canonical._strict_object(
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
        if binding.get("schema") != self.BINDING_SCHEMA:
            raise ValueError("unsupported Work Design outcome binding schema")
        for field in (
            "workspace_identity_root",
            "settled_state_root",
            "state_query_proof_root",
            "binding_root",
        ):
            self._root(binding.get(field), f"outcome binding {field}")
        if binding.get("opening_estimate_root") is not None:
            self._root(
                binding["opening_estimate_root"],
                "outcome binding opening_estimate_root",
            )
        published = self._canonical._timestamp(
            binding.get("published_at"), "outcome binding published_at"
        )
        outcome = self.validate_artifact(binding.get("outcome"))
        if self._canonical._timestamp(outcome["asOf"], "outcome asOf") > published:
            raise ValueError("outcome publication precedes outcome asOf")
        if binding["settled_state_root"] != outcome["evidence"]["settledStateRoot"]:
            raise ValueError("outcome binding settled state root mismatch")
        if binding["state_query_proof_root"] != outcome["evidence"]["queryProofRoot"]:
            raise ValueError("outcome binding query proof root mismatch")
        if binding["assignment_subject"] != f"kungfu:{outcome['assignmentId']}":
            raise ValueError("outcome binding Assignment subject mismatch")
        preimage = {key: item for key, item in binding.items() if key != "binding_root"}
        if self._canonical.semantic_root(preimage) != binding["binding_root"]:
            raise ValueError("outcome binding root mismatch")
        return binding

    def verify(self, value: Any) -> dict[str, Any]:
        try:
            binding = self._binding(value)
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

    def apply(
        self, plan: Mapping[str, Any], expected_binding_root: str
    ) -> dict[str, Any]:
        if plan.get("binding_root") != expected_binding_root:
            raise ValueError("outcome binding changed before execution")
        binding = plan.get("binding")
        verification = self.verify(binding)
        if not verification["ok"]:
            raise ValueError(verification["issues"][0]["message"])
        path = Path(str(plan["storage_root"])) / str(plan["binding_path"])
        content = (self._canonical.canonical_json(binding) + "\n").encode("utf-8")
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

    def list(self, workspace_root: str | Path) -> dict[str, Any]:
        root = Path(workspace_root).expanduser().resolve()
        storage_root, storage_kind = self._storage_resolver(root)
        index_root = storage_root / "work-design-outcomes" / "sha256"
        by_state: dict[str, list[dict[str, Any]]] = {}
        issues: list[dict[str, Any]] = []
        for binding_path in sorted(index_root.glob("*/*/binding.json")):
            try:
                binding = json.loads(binding_path.read_text(encoding="utf-8"))
                verification = self.verify(binding)
                if not verification["ok"]:
                    raise ValueError(verification["issues"][0]["message"])
                by_state.setdefault(str(binding["settled_state_root"]), []).append(
                    binding
                )
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
            "schema": self.INDEX_SCHEMA,
            "bindings": bindings,
            "issues": sorted(issues, key=self._canonical.semantic_root),
            "storage_kind": storage_kind,
            "writes": [],
        }
        return {**body, "index_root": self._canonical.semantic_root(body)}
