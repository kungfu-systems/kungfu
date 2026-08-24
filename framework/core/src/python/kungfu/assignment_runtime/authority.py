# SPDX-License-Identifier: Apache-2.0

"""Embedded Local Assignment Runtime Profile.

The runtime owns transport fencing, idempotency, resumable events, and durable
receipts.  Assignment state remains owned by the active Work Control Profile;
this module never interprets its private storage layout or appends a Fact
directly.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from functools import partial
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol
from kungfu.canonical_json import canonical_json_text


PROTOCOL = "kungfu.assignment-runtime/v1"
PROFILE_ID = "kungfu.assignment-runtime.local"
PROFILE_VERSION = "1"
STATE_SCHEMA = "kungfu.assignment-runtime.local-state/v1"
REQUEST_SCHEMA = "kungfu.assignment-runtime.request/v1"
RESPONSE_SCHEMA = "kungfu.assignment-runtime.response/v1"
SNAPSHOT_SCHEMA = "kungfu.assignment-runtime.snapshot/v1"
EVENT_SCHEMA = "kungfu.assignment-runtime.event/v1"
RECEIPT_SCHEMA = "kungfu.assignment-runtime.receipt/v1"
RECOVERY_RESOLUTION_SCHEMA = "kungfu.assignment-runtime.recovery-resolution/v1"
DISCOVERY_SCHEMA = "kungfu.assignment-runtime.discovery/v1"
STREAM_ID = "assignment-events"

_STABLE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$")
_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_FORBIDDEN_ARGUMENT_KEYS = {
    "directStorageMutation",
    "electronChannel",
    "filesystemPath",
    "journalPath",
    "postgresTable",
    "sqliteTable",
    "storagePath",
}
_ERROR_RETRYABLE = {
    "stale-revision": True,
    "generation-fenced": True,
    "idempotency-conflict": False,
    "unsupported-capability": False,
    "malformed-identity": False,
    "ambiguous-identity": False,
    "backend-unavailable": True,
    "event-resume-gap": True,
    "authority-bypass": False,
    "lease-required": True,
    "warrant-invalid": False,
    "unauthorized": False,
    "invalid-command": False,
    "unknown-outcome": False,
    "internal": True,
}
_COMMAND_OPERATIONS = {
    "initiative.create": "create-initiative",
    "assignment.create": "create-assignment",
    "assignment.claim": "claim-assignment",
    "assignment.relation.append": "append-assignment-relation-event",
    "assignment.stage": "advance-assignment",
    "assignment.completion.claim": "claim-completion",
    "initiative.progress.assess": "assess-progress",
    "assignment.completion.review": "review-completion",
    "assignment.continuation.decide": "decide-continuation",
    "work.input.snapshot": "work-input-snapshot",
    "work.run.record": "work-managed-run",
    "work.effect.authorize": "work-effect-authorize",
    "work.effect.attempt": "work-effect-attempt",
    "work.effect.outcome": "work-effect-outcome",
    "assignment.atlas.import": "import-atlas",
    "assignment.authority.activate": "activate-work-control",
    "assignment.authority.restore": "restore-atlas-authority",
    "initiative.bundle.export": "export-initiative",
    "initiative.bundle.import": "import-initiative",
}
_LEASE_COMMANDS = {
    "assignment.claim",
    "assignment.stage",
    "work.input.snapshot",
    "work.run.record",
    "work.effect.authorize",
    "work.effect.attempt",
    "work.effect.outcome",
}
_ASSESSMENT_EXECUTOR_PROFILES = {"inline", "thread", "process"}
_PROCESS_WRITERS: set[str] = set()
_PROCESS_WRITERS_GUARD = threading.Lock()


def _root(value: Any) -> str:
    raw = canonical_json_text(value).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _stable(value: Any, field: str) -> str:
    text = str(value or "")
    if not _STABLE_ID.fullmatch(text):
        raise LocalRuntimeError(
            "malformed-identity",
            f"{field} must be a stable logical identity",
            details={"field": field},
        )
    return text


def _contains_forbidden_argument(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    for key, child in value.items():
        if str(key) in _FORBIDDEN_ARGUMENT_KEYS:
            return str(key)
        nested = _contains_forbidden_argument(child)
        if nested:
            return nested
    return ""


def _copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _find_values(value: Any, key: str) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, Mapping):
        for current, child in value.items():
            if current == key:
                found.append(child)
            found.extend(_find_values(child, key))
    elif isinstance(value, list):
        for child in value:
            found.extend(_find_values(child, key))
    return found


def _bind_command_lease(
    arguments: dict[str, Any], command: Mapping[str, Any], operation: str
) -> None:
    lease = command.get("lease")
    if not isinstance(lease, Mapping):
        return
    if str(command.get("type") or "") not in _LEASE_COMMANDS:
        return
    if operation == "claim-assignment":
        arguments.setdefault("leaseExpiresAt", lease.get("expiresAt"))
    if operation == "advance-assignment":
        return
    arguments.setdefault("leaseId", lease.get("leaseId"))
    attempt = command.get("attempt")
    if isinstance(attempt, Mapping):
        arguments.setdefault("attemptId", attempt.get("attemptId"))


def _claim_identity(value: Mapping[str, Any]) -> tuple[str, str]:
    return (
        str(value.get("attempt_id") or value.get("attemptId") or ""),
        str(value.get("claim_id") or value.get("claimId") or ""),
    )


def _claim_matches(active: Mapping[str, Any], candidate: Mapping[str, Any]) -> bool:
    active_attempt, active_claim = _claim_identity(active)
    candidate_attempt, candidate_claim = _claim_identity(candidate)
    return candidate_attempt == active_attempt and (
        not active_claim or candidate_claim == active_claim
    )


def _exact_active_claim(
    claims: list[Mapping[str, Any]], active: Mapping[str, Any]
) -> dict[str, Any]:
    matches = list(map(dict, filter(partial(_claim_matches, active), claims)))
    if len(matches) != 1:
        raise LocalRuntimeError(
            "ambiguous-identity",
            "Active Work lease does not bind exactly one execution Attempt",
        )
    return matches[0]


class LocalRuntimeError(RuntimeError):
    """Stable public Runtime error."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
        diagnostics: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})
        self.diagnostics = list(diagnostics or [])


def _validate_completion_evidence_row(index: int, row: Any) -> None:
    if not isinstance(row, Mapping):
        raise LocalRuntimeError(
            "invalid-command",
            "evidenceAvailability rows must be objects",
            details={"field": "evidenceAvailability", "index": index},
        )
    acceptance = str(row.get("acceptance") or "").strip()
    level = str(row.get("level") or "").strip()
    state = str(row.get("state") or "").strip()
    if (
        not acceptance
        or level not in {"thin", "full"}
        or state not in {"available", "unavailable", "missing"}
    ):
        raise LocalRuntimeError(
            "invalid-command",
            "evidenceAvailability requires acceptance, thin/full level, "
            "and available/unavailable/missing state",
            details={"field": "evidenceAvailability", "index": index},
        )


def _validate_completion_evidence_availability(
    command: Mapping[str, Any], arguments: Mapping[str, Any]
) -> None:
    if command.get("type") != "assignment.completion.claim":
        return
    evidence_availability = arguments.get("evidenceAvailability", [])
    if not isinstance(evidence_availability, list):
        raise LocalRuntimeError(
            "invalid-command",
            "evidenceAvailability must be an array",
            details={"field": "evidenceAvailability"},
        )
    for index, row in enumerate(evidence_availability):
        _validate_completion_evidence_row(index, row)


def _validate_command_arguments(command: Mapping[str, Any]) -> None:
    arguments = command.get("arguments")
    if not isinstance(arguments, Mapping):
        return
    executor_profile = str(arguments.get("executorProfile") or "")
    if executor_profile and executor_profile not in _ASSESSMENT_EXECUTOR_PROFILES:
        raise LocalRuntimeError(
            "invalid-command",
            "Assessment executor profile must be inline, thread, or process",
            details={"field": "executorProfile"},
        )
    _validate_completion_evidence_availability(command, arguments)


def _validate_assignment_create_references(
    command: Mapping[str, Any], snapshot: Mapping[str, Any]
) -> None:
    if command.get("type") != "assignment.create":
        return
    arguments = command.get("arguments")
    if not isinstance(arguments, Mapping):
        return
    parent_assignment_id = str(arguments.get("parentAssignmentId") or "")
    if not parent_assignment_id:
        return
    if arguments.get("parentAssignmentRef"):
        raise LocalRuntimeError(
            "invalid-command",
            "Pass parentAssignmentId shorthand or parentAssignmentRef, not both",
            details={"fields": ["parentAssignmentId", "parentAssignmentRef"]},
        )
    matches = [
        row
        for row in snapshot.get("assignments") or []
        if row.get("assignmentId") == parent_assignment_id
    ]
    if len(matches) != 1:
        raise LocalRuntimeError(
            "invalid-command",
            "Local parent Assignment shorthand must resolve exactly once",
            details={
                "field": "parentAssignmentId",
                "matches": len(matches),
            },
        )


def _normalize_completion_context_roots(
    operation: str, arguments: Mapping[str, Any]
) -> dict[str, Any]:
    normalized = dict(arguments)
    if operation != "claim-completion":
        return normalized
    for legacy, canonical in (
        ("inputAtlasRoot", "inputContextRoot"),
        ("resultAtlasRoot", "resultContextRoot"),
    ):
        if legacy not in normalized:
            continue
        if canonical in normalized and normalized[canonical] != normalized[legacy]:
            raise LocalRuntimeError(
                "invalid-command",
                f"Conflicting {legacy} and {canonical} values",
                details={"fields": [legacy, canonical]},
            )
        normalized.setdefault(canonical, normalized[legacy])
        normalized.pop(legacy)
    return normalized


def _interrupted_command_rejection(
    pending: Mapping[str, Any], error: LocalRuntimeError
) -> tuple[dict[str, Any], dict[str, Any]]:
    command = dict(pending["command"])
    details = {
        "commandId": str(command.get("commandId") or ""),
        "commandRoot": str(pending.get("commandRoot") or ""),
        "errorCode": error.code,
    }
    diagnostic = {
        "code": "interrupted-command-rejected",
        "message": (
            "An interrupted command failed deterministic validation before "
            "authority execution"
        ),
        "severity": "warning",
        "recovery": [],
        "details": {**details, **dict(error.details)},
    }
    return diagnostic, details


class AssignmentAuthority(Protocol):
    """Private adapter boundary to the one native transition authority."""

    def inspect(self) -> dict[str, Any]: ...

    def apply(self, command: Mapping[str, Any]) -> dict[str, Any]: ...

    def diagnostics(self) -> list[dict[str, Any]]: ...


class WorkControlAuthority:
    """Exact-root production adapter to the active Work Control Profile."""

    def __init__(self, runtime_dir: str | Path, *, source: str | Path | None = None):
        self.runtime_dir = Path(runtime_dir).expanduser().resolve()
        self._source = str(Path(source).resolve()) if source is not None else ""

    def _profile_source(self) -> str:
        from kungfu import profile_sdk

        if self._source:
            profile_sdk.validate_source(self._source, self.runtime_dir)
            return self._source
        discovered = profile_sdk.discover_source(
            "kungfu.work-control", self.runtime_dir
        )
        self._source = str(discovered["source"])
        return self._source

    def _invoke(
        self, operation: str, values: Mapping[str, Any], *, write: bool = False
    ) -> dict[str, Any]:
        from kungfu import profile_sdk

        adapter_values = _normalize_completion_context_roots(operation, values)
        try:
            return profile_sdk.invoke_member_adapter(
                self._profile_source(),
                self.runtime_dir,
                "work-control-actions",
                operation,
                adapter_values,
                authorized_action=write,
            )
        except profile_sdk.ProfileSdkError as error:
            code = str(error.diagnosis.get("code") or "")
            if code in {
                "member-resolution-failed",
                "profile-member-ambiguous",
                "profile-source-ambiguous",
            }:
                raise LocalRuntimeError(
                    "ambiguous-identity",
                    "Work Control authority does not resolve exactly once",
                ) from error
            raise LocalRuntimeError(
                "backend-unavailable",
                "Work Control authority is unavailable",
                diagnostics=[
                    {
                        "code": "work-control-unavailable",
                        "message": "The exact active Work Control Profile could not be invoked",
                        "severity": "error",
                        "recovery": ["diagnostics.get", "recovery.plan"],
                    }
                ],
            ) from error

    @staticmethod
    def _record(row: Mapping[str, Any]) -> dict[str, Any]:
        allowed = {
            "acceptance_root": "acceptanceRoot",
            "assignment_id": "assignmentId",
            "context_root": "contextRoot",
            "initiative_id": "initiativeId",
            "objective": "objective",
            "parent_assignment_id": "parentAssignmentId",
            "project_cut_root": "projectCutRoot",
            "request_root": "requestRoot",
            "responsibility": "responsibility",
            "status": "status",
            "subject_key": "subject",
            "title": "title",
        }
        projected = {
            public: row[private]
            for private, public in allowed.items()
            if row.get(private) not in {None, ""}
        }
        sealed = dict(row.get("sealed_identity") or {})
        if sealed:
            projected["sealedIdentity"] = {
                "contractWorldId": str(sealed.get("contract_world_id") or ""),
                "factSurfaceId": str(sealed.get("fact_surface_id") or ""),
                "observationId": str(sealed.get("observation_id") or ""),
                "payloadRoot": str(sealed.get("payload_hash") or ""),
                "sourceId": str(sealed.get("source_id") or ""),
                "subject": str(sealed.get("subject_key") or ""),
                "typeVersion": str(sealed.get("type_version") or ""),
            }
        return projected

    def inspect(self) -> dict[str, Any]:
        portfolio_receipt = self._invoke("portfolio", {})
        portfolio = dict(portfolio_receipt.get("result") or {})
        assignments = []
        fact_refs = []
        diagnostics = []
        for raw in portfolio.get("assignments") or []:
            row = dict(raw)
            projected = self._record(row)
            initiative_id = str(projected.get("initiativeId") or "")
            assignment_id = str(projected.get("assignmentId") or "")
            if not initiative_id or not assignment_id:
                diagnostics.append(
                    {
                        "code": "assignment-identity-incomplete",
                        "message": "An authority row has no canonical Assignment identity",
                        "severity": "error",
                        "recovery": ["diagnostics.get"],
                    }
                )
                continue
            try:
                status_receipt = self._invoke(
                    "assignment-status",
                    {
                        "initiativeId": initiative_id,
                        "assignmentId": assignment_id,
                        "source": "kungfu",
                    },
                )
                status = dict(status_receipt.get("result") or {})
                projected["lifecycle"] = _copy_json(status)
                projected["phase"] = str(status.get("phase") or "admitted")
                projected["attempt"] = self._attempt(status)
                projected["lease"] = self._lease(status)
                projected["queryProofRoot"] = str(
                    status.get("query_proof_root") or status.get("queryProofRoot") or ""
                )
            except LocalRuntimeError:
                projected["phase"] = "admitted"
                projected["attempt"] = None
                projected["lease"] = None
                diagnostics.append(
                    {
                        "code": "assignment-status-unavailable",
                        "message": "One Assignment status could not be folded at this cut",
                        "severity": "error",
                        "recovery": ["diagnostics.get", "recovery.plan"],
                    }
                )
            assignments.append(projected)
            sealed = projected.get("sealedIdentity") or {}
            fact_root = str(sealed.get("payloadRoot") or "")
            if _ROOT.fullmatch(fact_root):
                fact_refs.append(
                    {
                        "factRoot": fact_root,
                        "surfaceId": str(sealed.get("factSurfaceId") or ""),
                        "subjectKey": str(sealed.get("subject") or ""),
                    }
                )
        assignments.sort(
            key=lambda row: (
                str(row.get("initiativeId") or ""),
                str(row.get("assignmentId") or ""),
            )
        )
        fact_refs.sort(key=lambda row: (str(row["surfaceId"]), str(row["subjectKey"])))
        authority_receipt = self._invoke("runtime-authority-status", {})
        authority = dict(authority_receipt.get("result") or {}).get("authority") or {}
        write_authority = str(authority.get("write_authority") or "")
        if write_authority != "kungfu-native":
            raise LocalRuntimeError(
                "ambiguous-identity",
                "Work Control reports an ambiguous write authority",
            )
        return {
            "schema": SNAPSHOT_SCHEMA,
            "authority": {
                "profileId": "kungfu.work-control",
                "profileSuiteRoot": str(portfolio_receipt["profileSuiteRoot"]),
                "memberRoot": str(portfolio_receipt["memberRoot"]),
                "state": str(authority.get("state") or "unknown"),
                "writeAuthority": write_authority,
            },
            "assignments": assignments,
            "factRefs": fact_refs,
            "episodeRefs": [],
            "diagnostics": diagnostics,
        }

    @staticmethod
    def _attempt(status: Mapping[str, Any]) -> dict[str, Any] | None:
        claims = status.get("execution_claims") or status.get("executionClaims") or []
        if not claims:
            return None
        active_lease = status.get("active_lease") or status.get("activeLease")
        claim = (
            _exact_active_claim(list(claims), active_lease)
            if isinstance(active_lease, Mapping)
            else dict(claims[-1])
        )
        phase = str(status.get("phase") or "claimed")
        state = phase if phase in {"claimed", "executing", "settled"} else "claimed"
        return {
            "attemptId": str(
                claim.get("attempt_id")
                or claim.get("attemptId")
                or claim.get("claim_id")
                or claim.get("claimId")
                or ""
            ),
            "claimId": str(claim.get("claim_id") or claim.get("claimId") or ""),
            "state": state,
        }

    @staticmethod
    def _lease(status: Mapping[str, Any]) -> dict[str, Any] | None:
        lease = status.get("active_lease") or status.get("activeLease")
        if not isinstance(lease, Mapping):
            return None
        return {
            "leaseId": str(lease.get("lease_id") or lease.get("leaseId") or ""),
            "state": "active",
            "expiresAt": str(
                lease.get("lease_expires_at") or lease.get("leaseExpiresAt") or ""
            ),
        }

    def apply(self, command: Mapping[str, Any]) -> dict[str, Any]:
        operation = _COMMAND_OPERATIONS.get(str(command.get("type") or ""))
        if operation is None:
            raise LocalRuntimeError(
                "invalid-command",
                "Command type is not implemented by the Local Profile",
            )
        arguments = dict(command.get("arguments") or {})
        # These routing-only values satisfy the versioned Runtime command target
        # shape for Initiative-wide and authority-wide actions. They never
        # reach Work Control or become native Assignment identities.
        runtime_initiative_id = arguments.pop("_runtimeInitiativeId", None)
        runtime_assignment_id = arguments.pop("_runtimeAssignmentId", None)
        target = dict(command.get("target") or {})
        if runtime_initiative_id is None:
            arguments.setdefault("initiativeId", target.get("initiativeId"))
        elif runtime_initiative_id != target.get("initiativeId"):
            raise LocalRuntimeError(
                "malformed-identity", "Runtime Initiative routing identity drifted"
            )
        if runtime_assignment_id is None:
            arguments.setdefault("assignmentId", target.get("assignmentId"))
        elif runtime_assignment_id != target.get("assignmentId"):
            raise LocalRuntimeError(
                "malformed-identity", "Runtime Assignment routing identity drifted"
            )
        _bind_command_lease(arguments, command, operation)
        try:
            receipt = self._invoke(operation, arguments, write=True)
        except LocalRuntimeError:
            raise
        except (TypeError, ValueError) as error:
            message = str(error).lower()
            if "lease" in message:
                code = "lease-required"
            elif "warrant" in message:
                code = "warrant-invalid"
            elif "phase changed" in message or "transition" in message:
                code = "stale-revision"
            else:
                code = "invalid-command"
            raise LocalRuntimeError(
                code, "Native authority rejected the command"
            ) from error

        episode_refs = []
        from kungfu.storage import service as storage_service

        for episode_id in sorted(
            {str(value) for value in _find_values(receipt, "episode_id") if str(value)}
        ):
            try:
                inspected = storage_service.episode_inspect(
                    self.runtime_dir, episode_id=int(episode_id)
                )
            except (KeyError, OSError, RuntimeError, TypeError, ValueError):
                continue
            roots = _find_values(inspected, "root_value")
            episode_root = next(
                (
                    value if str(value).startswith("sha256:") else f"sha256:{value}"
                    for value in roots
                    if re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", str(value))
                ),
                "",
            )
            if episode_root:
                episode_refs.append({"episodeRoot": episode_root})
        return {
            "authorityReceipt": receipt,
            "episodeRefs": episode_refs,
        }

    def diagnostics(self) -> list[dict[str, Any]]:
        try:
            snapshot = self.inspect()
        except LocalRuntimeError as error:
            return error.diagnostics or [
                {
                    "code": error.code,
                    "message": error.message,
                    "severity": "error",
                    "recovery": ["recovery.plan"],
                }
            ]
        return list(snapshot.get("diagnostics") or [])
