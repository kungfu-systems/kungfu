# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .common import (
    SNAPSHOT_SCHEMA,
    _COMMAND_OPERATIONS,
    _ROOT,
    _find_values,
    LocalRuntimeError,
)


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

        try:
            return profile_sdk.invoke_member_adapter(
                self._profile_source(),
                self.runtime_dir,
                "work-control-actions",
                operation,
                dict(values),
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
            "atlas_root": "atlasRoot",
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
                        "source": "atlas",
                    },
                )
                status = dict(status_receipt.get("result") or {})
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
        if write_authority not in {"atlas-adapter", "kungfu-native"}:
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
                "migrationId": str(authority.get("migration_id") or ""),
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
        claim = dict(claims[-1])
        phase = str(status.get("phase") or "claimed")
        state = phase if phase in {"claimed", "executing", "settled"} else "claimed"
        return {
            "attemptId": str(claim.get("attempt_id") or claim.get("claim_id") or ""),
            "claimId": str(claim.get("claim_id") or ""),
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
        target = dict(command.get("target") or {})
        arguments.setdefault("initiativeId", target.get("initiativeId"))
        arguments.setdefault("assignmentId", target.get("assignmentId"))
        lease = command.get("lease")
        if operation == "claim-assignment" and isinstance(lease, Mapping):
            arguments.setdefault("leaseId", lease.get("leaseId"))
            arguments.setdefault("leaseExpiresAt", lease.get("expiresAt"))
            attempt = command.get("attempt")
            if isinstance(attempt, Mapping):
                arguments.setdefault("attemptId", attempt.get("attemptId"))
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
