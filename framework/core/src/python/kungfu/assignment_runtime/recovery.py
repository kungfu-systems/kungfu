# SPDX-License-Identifier: Apache-2.0

"""Fail-closed recovery for interrupted Local Assignment Runtime writes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .authority import (
    PROFILE_ID,
    PROFILE_VERSION,
    RECOVERY_RESOLUTION_SCHEMA,
    _ROOT,
    LocalRuntimeError,
    _copy_json,
    _root,
    _stable,
)


class AssignmentRuntimeRecoveryMixin:
    """Recovery operations shared by the embedded Local Runtime writer."""

    def _recovery_plan(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        _snapshot, revision = self._observe_snapshot(record_event=True)
        pending = self._state.get("pending")
        if isinstance(pending, Mapping):
            automatic = isinstance(pending.get("authorityResult"), Mapping)
            basis = self._recovery_basis(pending, revision, automatic=automatic)
            result = {
                "planId": f"recovery-{_root(basis)[7:31]}",
                "status": "executable" if automatic else "manual-review-required",
                "automatic": automatic,
                "basisRoot": _root(basis),
            }
            if not automatic:
                command = dict(pending["command"])
                result["operatorResolution"] = {
                    "resolution": "abandon-local-pending",
                    "authorityOutcome": "unknown",
                    "commandId": str(command["commandId"]),
                    "commandRoot": str(pending["commandRoot"]),
                    "beforeRevision": dict(pending["beforeRevision"]),
                    "currentRevision": dict(revision),
                    "requiredEvidence": [
                        "expectedBasisRoot",
                        "expectedCommandRoot",
                        "expectedRevision",
                        "idempotencyKey",
                        "authorizedBy",
                        "reason",
                        "evidenceRoots",
                    ],
                }
        else:
            basis = {"revision": revision, "pending": False}
            result = {
                "planId": f"recovery-{_root(basis)[7:31]}",
                "status": "not-required",
                "automatic": False,
                "basisRoot": _root(basis),
            }
        return self._ok(str(request["requestId"]), revision, selected, result)

    @staticmethod
    def _recovery_basis(
        pending: Mapping[str, Any],
        revision: Mapping[str, Any],
        *,
        automatic: bool,
    ) -> dict[str, Any]:
        return {
            "commandRoot": pending.get("commandRoot"),
            "beforeRevision": pending.get("beforeRevision"),
            "currentRevision": dict(revision),
            "automatic": automatic,
        }

    def _recovery_execute(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        payload = dict(request.get("payload") or {})
        if payload.get("resolution") == "abandon-local-pending":
            idempotency_key = str(payload.get("idempotencyKey") or "")
            previous = (self._state.get("recoveryResolutions") or {}).get(
                idempotency_key
            )
            if isinstance(previous, Mapping):
                if previous.get("requestRoot") != _root(payload):
                    raise LocalRuntimeError(
                        "idempotency-conflict",
                        "Recovery idempotency key was used for another resolution body",
                    )
                return self._recovery_resolution_response(
                    str(request["requestId"]),
                    selected,
                    previous,
                    disposition="replayed",
                )
        pending = self._state.get("pending")
        if not isinstance(pending, Mapping):
            raise LocalRuntimeError(
                "backend-unavailable",
                "No interrupted command is awaiting recovery",
                diagnostics=list(self._state.get("diagnostics") or []),
            )
        if not isinstance(pending.get("authorityResult"), Mapping):
            return self._resolve_unknown_outcome(request, selected, pending, payload)
        _snapshot, current = self._observe_snapshot(record_event=False)
        if payload.get("expectedRevision") != current:
            raise LocalRuntimeError("stale-revision", "Recovery plan revision is stale")
        command = dict(pending["command"])
        if payload.get("idempotencyKey") != command.get("idempotencyKey"):
            raise LocalRuntimeError(
                "idempotency-conflict", "Recovery key does not match pending command"
            )
        snapshot, revision = self._observe_snapshot(record_event=False)
        record = self._finalize_pending(pending, snapshot, revision, recovered=True)
        return self._command_response(
            str(request["requestId"]), selected, record, disposition="recovered"
        )

    def _resolve_unknown_outcome(
        self,
        request: Mapping[str, Any],
        selected: list[str],
        pending: Mapping[str, Any],
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        if payload.get("resolution") != "abandon-local-pending":
            raise LocalRuntimeError(
                "invalid-command",
                "Unknown authority outcomes require abandon-local-pending resolution",
            )
        _snapshot, revision = self._observe_snapshot(record_event=False)
        basis = self._recovery_basis(pending, revision, automatic=False)
        basis_root = _root(basis)
        if payload.get("expectedBasisRoot") != basis_root:
            raise LocalRuntimeError("stale-revision", "Recovery plan basis is stale")
        if payload.get("expectedRevision") != revision:
            raise LocalRuntimeError("stale-revision", "Recovery plan revision is stale")
        command_root = str(pending["commandRoot"])
        if payload.get("expectedCommandRoot") != command_root:
            raise LocalRuntimeError(
                "idempotency-conflict",
                "Recovery command root does not match the pending command",
            )
        authorized_by = _stable(payload.get("authorizedBy"), "authorizedBy")
        reason = str(payload.get("reason") or "").strip()
        if not reason:
            raise LocalRuntimeError(
                "invalid-command", "Recovery resolution reason is required"
            )
        evidence_roots = sorted(
            {str(value) for value in payload.get("evidenceRoots") or []}
        )
        if not evidence_roots or any(
            not _ROOT.fullmatch(value) for value in evidence_roots
        ):
            raise LocalRuntimeError(
                "invalid-command", "Recovery evidence roots are required"
            )

        command = dict(pending["command"])
        receipt_preimage = {
            "schema": RECOVERY_RESOLUTION_SCHEMA,
            "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
            "realm": dict(self.realm),
            "resolution": "abandon-local-pending",
            "authorityOutcome": "unknown",
            "commandId": str(command["commandId"]),
            "commandRoot": command_root,
            "idempotencyKey": str(command["idempotencyKey"]),
            "recoveryIdempotencyKey": str(payload["idempotencyKey"]),
            "beforeRevision": dict(pending["beforeRevision"]),
            "observedRevision": dict(revision),
            "basisRoot": basis_root,
            "authorizedBy": authorized_by,
            "reason": reason,
            "evidenceRoots": evidence_roots,
        }
        receipt_root = _root(receipt_preimage)
        record = {
            "commandId": str(command["commandId"]),
            "idempotencyKey": str(command["idempotencyKey"]),
            "commandRoot": command_root,
            "authorityOutcome": "unknown",
            "resolutionReceiptRoot": receipt_root,
            "resolutionReceipt": {
                **receipt_preimage,
                "receiptRoot": receipt_root,
            },
            "revision": dict(revision),
            "requestRoot": _root(payload),
        }
        commands = dict(self._state.get("commands") or {})
        commands[str(command["idempotencyKey"])] = record
        self._state["commands"] = commands
        recovery_resolutions = dict(self._state.get("recoveryResolutions") or {})
        recovery_resolutions[str(payload["idempotencyKey"])] = record
        self._state["recoveryResolutions"] = recovery_resolutions
        self._state["pending"] = None
        self._state["diagnostics"] = [
            row
            for row in self._state.get("diagnostics") or []
            if row.get("code") != "interrupted-write-ambiguous"
        ]
        self._state["diagnostics"].append(
            {
                "code": "interrupted-write-resolved-outcome-unknown",
                "message": (
                    "Local pending state was abandoned without asserting the "
                    "authoritative command outcome"
                ),
                "severity": "warning",
                "recovery": [],
            }
        )
        self._append_event(
            "command-outcome-unknown-resolved",
            revision,
            {
                "commandId": record["commandId"],
                "commandRoot": command_root,
                "resolutionReceiptRoot": receipt_root,
                "authorityOutcome": "unknown",
            },
        )
        self._save_state()
        return self._recovery_resolution_response(
            str(request["requestId"]), selected, record, disposition="applied"
        )

    def _recovery_resolution_response(
        self,
        request_id: str,
        selected: list[str],
        record: Mapping[str, Any],
        *,
        disposition: str,
    ) -> dict[str, Any]:
        receipt = _copy_json(record["resolutionReceipt"])
        return self._ok(
            request_id,
            dict(record["revision"]),
            selected,
            {
                "resolution": {
                    "disposition": disposition,
                    "localDisposition": "local-pending-abandoned",
                    "authorityOutcome": "unknown",
                    "commandId": record["commandId"],
                    "commandRoot": record["commandRoot"],
                    "resolutionReceiptRoot": record["resolutionReceiptRoot"],
                },
                "resolutionReceipt": receipt,
            },
            receipts=[
                {
                    "receiptRoot": record["resolutionReceiptRoot"],
                    "kind": "recovery-resolution",
                }
            ],
        )
