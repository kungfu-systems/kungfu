# SPDX-License-Identifier: Apache-2.0

"""Persisted state and interrupted-command recovery for the Local Runtime."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from kungfu.coordination import locks

from .authority import (
    EVENT_SCHEMA,
    PROFILE_ID,
    PROFILE_VERSION,
    PROTOCOL,
    SNAPSHOT_SCHEMA,
    STATE_SCHEMA,
    STREAM_ID,
    LocalRuntimeError,
    _copy_json,
    _interrupted_command_rejection,
    _root,
    _validate_assignment_create_references,
    _validate_command_arguments,
)

_RETRY_FAILED = {
    "code": "interrupted-write-retry-failed",
    "message": (
        "The interrupted command could not be replayed; its authority outcome "
        "remains unknown"
    ),
    "severity": "error",
    "recovery": ["diagnostics.get", "recovery.plan"],
}


class LocalAssignmentStateMixin:
    """Own Local Runtime persistence, observations, events, and startup recovery."""

    realm: dict[str, str]
    event_retention: int
    fault_hook: Any
    authority: Any
    _state: dict[str, Any]
    _state_path: Any

    def _empty_state(self) -> dict[str, Any]:
        return {
            "schema": STATE_SCHEMA,
            "protocol": PROTOCOL,
            "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
            "realm": dict(self.realm),
            "revision": None,
            "commands": {},
            "recoveryResolutions": {},
            "events": [],
            "pending": None,
            "diagnostics": [],
        }

    def _load_state(self) -> dict[str, Any]:
        if not self._state_path.exists():
            state = self._empty_state()
            self._save_state(state)
            return state
        try:
            state = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise LocalRuntimeError(
                "backend-unavailable",
                "Local Runtime metadata is unreadable",
                diagnostics=[
                    {
                        "code": "runtime-state-corrupt",
                        "message": "Local Runtime metadata requires operator recovery",
                        "severity": "error",
                        "recovery": ["recovery.plan"],
                    }
                ],
            ) from error
        if state.get("schema") != STATE_SCHEMA or state.get("realm") != self.realm:
            raise LocalRuntimeError(
                "generation-fenced",
                "Local Runtime metadata belongs to another realm generation",
            )
        return state

    def _save_state(self, state: Mapping[str, Any] | None = None) -> None:
        value = dict(state or self._state)
        locks.write_json(self._state_path, value)

    def _fault(self, point: str) -> None:
        if self.fault_hook is not None:
            self.fault_hook(point)

    def _require_started(self) -> None:
        if not self._started:
            raise LocalRuntimeError(
                "backend-unavailable", "Local Assignment Runtime is not active"
            )

    def _snapshot_revision(self, snapshot: Mapping[str, Any]) -> dict[str, str | None]:
        state_root = _root(snapshot)
        current = self._state.get("revision") or {}
        return {
            "value": f"revision-{state_root[7:31]}",
            "root": state_root,
            "parentRoot": (
                str(current.get("root"))
                if current and current.get("root") != state_root
                else current.get("parentRoot")
                if current
                else None
            ),
        }

    def _observe_snapshot(
        self, *, record_event: bool
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            snapshot = self.authority.inspect()
        except LocalRuntimeError:
            raise
        except (KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
            raise LocalRuntimeError(
                "backend-unavailable", "Assignment authority is unavailable"
            ) from error
        public_snapshot = _copy_json(snapshot)
        if public_snapshot.get("schema") != SNAPSHOT_SCHEMA:
            raise LocalRuntimeError(
                "backend-unavailable",
                "Assignment authority returned an invalid snapshot",
            )
        revision = self._snapshot_revision(public_snapshot)
        previous = self._state.get("revision") or {}
        if previous.get("root") != revision["root"]:
            self._state["revision"] = revision
            if record_event:
                self._append_event(
                    "authority-observed",
                    revision,
                    {"stateRoot": revision["root"]},
                )
            self._save_state()
        else:
            revision = dict(previous)
        return public_snapshot, revision

    def _append_event(
        self,
        kind: str,
        revision: Mapping[str, Any],
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        events = list(self._state.get("events") or [])
        sequence = int(events[-1]["cursor"]["sequence"]) + 1 if events else 1
        basis = {
            "schema": EVENT_SCHEMA,
            "kind": kind,
            "realm": dict(self.realm),
            "revision": dict(revision),
            "sequence": str(sequence),
            "payload": dict(payload),
        }
        event_root = _root(basis)
        event = {
            **basis,
            "eventRoot": event_root,
            "cursor": {
                "streamId": STREAM_ID,
                "generation": self.realm["generation"],
                "sequence": str(sequence),
                "eventRoot": event_root,
            },
        }
        events.append(event)
        self._state["events"] = events[-self.event_retention :]
        return event

    def _recover_pending_on_start(self) -> None:
        pending = self._state.get("pending")
        if not isinstance(pending, Mapping):
            return
        command = dict(pending["command"])
        try:
            _validate_command_arguments(command)
        except LocalRuntimeError as error:
            if error.code != "invalid-command":
                raise
            self._reject_pending_before_authority(pending, error)
            return
        if isinstance(pending.get("authorityResult"), Mapping):
            snapshot, revision = self._observe_snapshot(record_event=False)
            self._finalize_pending(dict(pending), snapshot, revision, recovered=True)
            return
        snapshot, revision = self._observe_snapshot(record_event=False)
        self._resume_unapplied_pending(pending, command, snapshot, revision)

    def _resume_unapplied_pending(
        self,
        pending: Mapping[str, Any],
        command: Mapping[str, Any],
        snapshot: Mapping[str, Any],
        revision: Mapping[str, Any],
    ) -> None:
        try:
            _validate_assignment_create_references(command, snapshot)
            before = dict(pending.get("beforeRevision") or {})
            if revision.get("root") == before.get("root"):
                authority_result = self.authority.apply(dict(pending["command"]))
                pending = {**dict(pending), "authorityResult": authority_result}
                self._state["pending"] = pending
                self._save_state()
                snapshot, revision = self._observe_snapshot(record_event=False)
                self._finalize_pending(pending, snapshot, revision, recovered=True)
                return
        except LocalRuntimeError as error:
            self._reject_pending_before_authority(pending, error)
            return
        diagnostic = {
            "code": "interrupted-write-ambiguous",
            "message": "Authority changed after an interrupted command without a durable result receipt",
            "severity": "error",
            "recovery": ["diagnostics.get", "recovery.plan"],
        }
        diagnostics = list(self._state.get("diagnostics") or [])
        diagnostics_by_root = dict(
            map(lambda item: (_root(item), item), [*diagnostics, diagnostic])
        )
        self._state["diagnostics"] = list(diagnostics_by_root.values())
        self._save_state()

    def _reject_pending_before_authority(
        self, pending: Mapping[str, Any], error: LocalRuntimeError
    ) -> None:
        if error.code != "invalid-command":
            diagnostic = dict(_RETRY_FAILED, details={"causeCode": error.code})
            self._state["diagnostics"].append(diagnostic)
            return self._save_state()
        revision = dict(
            pending.get("beforeRevision") or self._state.get("revision", {})
        )
        diagnostic, event_details = _interrupted_command_rejection(pending, error)
        self._state["diagnostics"].append(diagnostic)
        self._state["pending"] = None
        self._append_event("command-rejected", revision, event_details)
        self._save_state()
