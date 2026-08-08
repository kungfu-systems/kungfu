# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from jsonschema import Draft202012Validator

from kungfu import contract as contract_registry
from kungfu.canonical_json import canonical_json_text
from kungfu.coordination import locks

PROTOCOL = "kungfu.assignment-runtime/v1"
PROFILE_ID = "kungfu.assignment-runtime.local"
PROFILE_VERSION = "1"
STATE_SCHEMA = "kungfu.assignment-runtime.local-state/v1"
REQUEST_SCHEMA = "kungfu.assignment-runtime.request/v1"
RESPONSE_SCHEMA = "kungfu.assignment-runtime.response/v1"
SNAPSHOT_SCHEMA = "kungfu.assignment-runtime.snapshot/v1"
EVENT_SCHEMA = "kungfu.assignment-runtime.event/v1"
RECEIPT_SCHEMA = "kungfu.assignment-runtime.receipt/v1"
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
    "internal": True,
}
_COMMAND_OPERATIONS = {
    "assignment.create": "create-assignment",
    "assignment.claim": "claim-assignment",
    "assignment.stage": "advance-assignment",
    "assignment.completion.claim": "claim-completion",
    "assignment.completion.review": "review-completion",
    "assignment.continuation.decide": "decide-continuation",
}
_LEASE_COMMANDS = {"assignment.claim", "assignment.stage"}
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


class EmbeddedLocalAssignmentRuntime:
    """One embedded Runtime writer for one logical realm generation."""

    def __init__(
        self,
        runtime_dir: str | Path,
        *,
        realm_id: str,
        generation: str,
        authority: AssignmentAuthority | None = None,
        profile_source: str | Path | None = None,
        contract: Mapping[str, Any] | None = None,
        request_schema: Mapping[str, Any] | None = None,
        event_retention: int = 128,
        fault_hook: Callable[[str], None] | None = None,
    ) -> None:
        self.runtime_dir = Path(runtime_dir).expanduser().resolve()
        self.realm = {
            "realmId": _stable(realm_id, "realmId"),
            "realmKind": "local",
            "generation": _stable(generation, "generation"),
        }
        self.authority = authority or WorkControlAuthority(
            self.runtime_dir, source=profile_source
        )
        self.event_retention = max(1, int(event_retention))
        self.fault_hook = fault_hook
        self._state_dir = self.runtime_dir / "assignment-runtime" / "local-v1"
        self._state_path = self._state_dir / "state.json"
        self._lock_root = self._state_dir / "coordination"
        self._lock_name = f"writer:{self.realm['realmId']}:{self.realm['generation']}"
        self._writer_key = (
            f"{self.runtime_dir}:{self.realm['realmId']}:{self.realm['generation']}"
        )
        self._request_guard = threading.RLock()
        self._started = False
        self._state: dict[str, Any] = {}
        self.contract = (
            _copy_json(contract)
            if contract is not None
            else contract_registry.load_contract("assignment-runtime")
        )
        self._request_validator = (
            Draft202012Validator(_copy_json(request_schema))
            if request_schema is not None
            else self._load_request_validator()
        )
        self._operations = {
            str(row["id"]): str(row["capability"])
            for row in self.contract["operations"]
        }
        self._capabilities = list(self.contract["capabilities"])

    def _load_request_validator(self) -> Draft202012Validator:
        contract_path = Path(
            contract_registry.resolve_contract_path("assignment-runtime")
        )
        schema_path = (
            contract_path.parent
            / "schema"
            / ("assignment-runtime-envelope-v1.schema.json")
        )
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise LocalRuntimeError(
                "backend-unavailable", "Assignment Runtime schema is unavailable"
            ) from error
        return Draft202012Validator(schema)

    @staticmethod
    def genesis_cursor(generation: str) -> dict[str, str]:
        basis = {
            "streamId": STREAM_ID,
            "generation": generation,
            "sequence": "0",
        }
        return {**basis, "eventRoot": _root(basis)}

    def start(self) -> "EmbeddedLocalAssignmentRuntime":
        if self._started:
            return self
        with _PROCESS_WRITERS_GUARD:
            if self._writer_key in _PROCESS_WRITERS:
                raise LocalRuntimeError(
                    "ambiguous-identity",
                    "A Local Assignment Runtime writer is already active for this realm",
                )
            _PROCESS_WRITERS.add(self._writer_key)
        acquired = False
        try:
            acquired = locks.try_acquire(
                self._lock_root,
                self._lock_name,
                label=f"{PROFILE_ID}:{self.realm['realmId']}",
            )
            if not acquired:
                raise LocalRuntimeError(
                    "ambiguous-identity",
                    "A Local Assignment Runtime writer is already active for this realm",
                )
            self._state = self._load_state()
            self._started = True
            self._recover_pending_on_start()
            self._observe_snapshot(record_event=True)
            return self
        except BaseException:
            if acquired:
                locks.release(self._lock_root, self._lock_name)
            with _PROCESS_WRITERS_GUARD:
                _PROCESS_WRITERS.discard(self._writer_key)
            self._started = False
            raise

    def close(self) -> None:
        if not self._started:
            return
        locks.release(self._lock_root, self._lock_name)
        with _PROCESS_WRITERS_GUARD:
            _PROCESS_WRITERS.discard(self._writer_key)
        self._started = False

    def __enter__(self) -> "EmbeddedLocalAssignmentRuntime":
        return self.start()

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def _empty_state(self) -> dict[str, Any]:
        return {
            "schema": STATE_SCHEMA,
            "protocol": PROTOCOL,
            "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
            "realm": dict(self.realm),
            "revision": None,
            "commands": {},
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
        if isinstance(pending.get("authorityResult"), Mapping):
            snapshot, revision = self._observe_snapshot(record_event=False)
            self._finalize_pending(dict(pending), snapshot, revision, recovered=True)
            return
        snapshot, revision = self._observe_snapshot(record_event=False)
        before = dict(pending.get("beforeRevision") or {})
        if revision.get("root") == before.get("root"):
            authority_result = self.authority.apply(dict(pending["command"]))
            pending = {**dict(pending), "authorityResult": authority_result}
            self._state["pending"] = pending
            self._save_state()
            snapshot, revision = self._observe_snapshot(record_event=False)
            self._finalize_pending(pending, snapshot, revision, recovered=True)
            return
        diagnostic = {
            "code": "interrupted-write-ambiguous",
            "message": "Authority changed after an interrupted command without a durable result receipt",
            "severity": "error",
            "recovery": ["diagnostics.get", "recovery.plan"],
        }
        diagnostics = list(self._state.get("diagnostics") or [])
        if diagnostic not in diagnostics:
            diagnostics.append(diagnostic)
        self._state["diagnostics"] = diagnostics
        self._save_state()

    def handle(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Handle one envelope atomically within the single embedded writer."""

        with self._request_guard:
            return self._handle(request)

    def _handle(self, request: Mapping[str, Any]) -> dict[str, Any]:
        self._require_started()
        request_value = _copy_json(request)
        request_id = str(request_value.get("requestId") or "invalid-request")
        try:
            self._validate_request(request_value)
            operation = str(request_value["operation"])
            self._check_realm(dict(request_value["realm"]))
            selected = self._negotiate(dict(request_value["client"]))
            if self._state.get("pending") and operation not in {
                "diagnostics.get",
                "recovery.plan",
            }:
                raise LocalRuntimeError(
                    "backend-unavailable",
                    "An interrupted write requires recovery before further operations",
                    diagnostics=list(self._state.get("diagnostics") or []),
                )
            if operation == "capabilities.discover":
                snapshot, revision = self._observe_snapshot(record_event=True)
                result = self._discovery(snapshot)
                return self._ok(request_id, revision, selected, result)
            if operation in {
                "assignment.snapshot",
                "assignment.list",
                "assignment.get",
                "assignment.query",
            }:
                return self._read(request_value, selected)
            if operation == "events.watch":
                return self._watch(request_value, selected)
            if operation == "command.submit":
                return self._submit(request_value, selected)
            if operation == "command.get":
                return self._command_get(request_value, selected)
            if operation == "diagnostics.get":
                return self._diagnostics(request_value, selected)
            if operation == "recovery.plan":
                return self._recovery_plan(request_value, selected)
            if operation == "recovery.execute":
                return self._recovery_execute(request_value, selected)
            raise LocalRuntimeError(
                "invalid-command", "Operation is not implemented by the Local Profile"
            )
        except LocalRuntimeError as error:
            revision = dict(
                self._state.get("revision")
                or {
                    "value": "revision-unavailable",
                    "root": _root({"status": "unavailable", "realm": self.realm}),
                    "parentRoot": None,
                }
            )
            return self._error(request_id, revision, error)

    def _validate_request(self, request: Mapping[str, Any]) -> None:
        realm = request.get("realm")
        if isinstance(realm, Mapping):
            _stable(realm.get("realmId"), "realmId")
            _stable(realm.get("generation"), "generation")
        errors = sorted(
            self._request_validator.iter_errors(request), key=lambda row: list(row.path)
        )
        if errors:
            raise LocalRuntimeError(
                "invalid-command",
                "Request does not match kungfu.assignment-runtime/v1",
                details={"field": "/" + "/".join(str(part) for part in errors[0].path)},
            )
        if request.get("schema") != REQUEST_SCHEMA:
            raise LocalRuntimeError("invalid-command", "Request schema is unsupported")

    def _check_realm(self, realm: Mapping[str, Any]) -> None:
        if realm.get("realmId") != self.realm["realmId"]:
            raise LocalRuntimeError(
                "ambiguous-identity", "Request names another logical realm"
            )
        if realm.get("realmKind") != "local":
            raise LocalRuntimeError(
                "unsupported-capability", "Only the Local Runtime Profile is active"
            )
        if realm.get("generation") != self.realm["generation"]:
            raise LocalRuntimeError(
                "generation-fenced", "Request belongs to a stale realm generation"
            )

    def _negotiate(self, client: Mapping[str, Any]) -> list[str]:
        requested = [str(value) for value in client.get("requestedCapabilities") or []]
        unsupported = [value for value in requested if value not in self._capabilities]
        if unsupported:
            raise LocalRuntimeError(
                "unsupported-capability",
                "Requested capability is not available in this Runtime Profile",
                details={"unsupported": unsupported},
            )
        return requested

    def _discovery(self, snapshot: Mapping[str, Any]) -> dict[str, Any]:
        authority = dict(snapshot.get("authority") or {})
        return {
            "schema": DISCOVERY_SCHEMA,
            "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
            "protocol": {
                "id": PROTOCOL,
                "minimumVersion": 1,
                "maximumVersion": 1,
                "stability": self.contract["protocol"]["stability"],
            },
            "transports": {
                "supported": ["embedded"],
                "unavailable": ["loopback"],
                "outOfScope": ["cluster"],
            },
            "capabilities": list(self._capabilities),
            "bounds": {
                "eventRetention": self.event_retention,
                "idempotencyRetention": "realm-generation",
            },
            "compatibility": {
                "mode": "read-only-where-declared",
                "readers": list(self.contract["compatibility"]["legacyReaders"]),
                "dualWrite": self.contract["compatibility"]["dualWrite"],
                "removalGate": self.contract["compatibility"]["deletionGate"],
            },
            "authority": authority,
        }

    def _read(self, request: Mapping[str, Any], selected: list[str]) -> dict[str, Any]:
        snapshot, revision = self._observe_snapshot(record_event=True)
        operation = str(request["operation"])
        payload = dict(request.get("payload") or {})
        assignments = list(snapshot.get("assignments") or [])
        if operation == "assignment.snapshot":
            result = snapshot
        elif operation == "assignment.list":
            result = {"assignments": self._filter_assignments(assignments, payload)}
        elif operation == "assignment.query":
            result = {
                "assignments": self._filter_assignments(assignments, payload),
                "queryRoot": _root(payload),
            }
        else:
            initiative_id = _stable(payload.get("initiativeId"), "initiativeId")
            assignment_id = _stable(payload.get("assignmentId"), "assignmentId")
            matches = [
                row
                for row in assignments
                if row.get("initiativeId") == initiative_id
                and row.get("assignmentId") == assignment_id
            ]
            if len(matches) != 1:
                code = "ambiguous-identity" if len(matches) > 1 else "invalid-command"
                raise LocalRuntimeError(
                    code, "Assignment identity does not resolve exactly once"
                )
            result = {"assignment": matches[0]}
        return self._ok(
            str(request["requestId"]),
            revision,
            selected,
            result,
            fact_refs=list(snapshot.get("factRefs") or []),
            episode_refs=list(snapshot.get("episodeRefs") or []),
            diagnostics=list(snapshot.get("diagnostics") or []),
        )

    @staticmethod
    def _filter_assignments(
        assignments: list[dict[str, Any]], payload: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        initiative_id = str(payload.get("initiativeId") or "")
        phase = str(payload.get("phase") or payload.get("status") or "")
        return [
            row
            for row in assignments
            if (not initiative_id or row.get("initiativeId") == initiative_id)
            and (not phase or row.get("phase") == phase or row.get("status") == phase)
        ]

    def _watch(self, request: Mapping[str, Any], selected: list[str]) -> dict[str, Any]:
        _snapshot, revision = self._observe_snapshot(record_event=True)
        cursor = dict(request.get("cursor") or {})
        if cursor.get("generation") != self.realm["generation"]:
            raise LocalRuntimeError(
                "generation-fenced", "Event cursor belongs to a stale generation"
            )
        if cursor.get("streamId") != STREAM_ID:
            raise LocalRuntimeError("malformed-identity", "Event stream is unknown")
        sequence = int(cursor.get("sequence") or 0)
        events = list(self._state.get("events") or [])
        if sequence == 0:
            if cursor != self.genesis_cursor(self.realm["generation"]):
                raise LocalRuntimeError(
                    "malformed-identity", "Genesis cursor root is invalid"
                )
        else:
            match = next(
                (
                    event
                    for event in events
                    if int(event["cursor"]["sequence"]) == sequence
                ),
                None,
            )
            if match is None or match["eventRoot"] != cursor.get("eventRoot"):
                raise LocalRuntimeError(
                    "event-resume-gap",
                    "Cursor is outside retained event history",
                    details={"recoverySnapshotRevision": revision["value"]},
                )
        resumed = [
            event for event in events if int(event["cursor"]["sequence"]) > sequence
        ]
        next_cursor = resumed[-1]["cursor"] if resumed else cursor
        return self._ok(
            str(request["requestId"]),
            revision,
            selected,
            {"events": resumed},
            cursor=next_cursor,
        )

    def _validate_command(
        self,
        command: Mapping[str, Any],
        snapshot: Mapping[str, Any],
        revision: Mapping[str, Any],
    ) -> None:
        if command.get("expectedRevision") != revision:
            raise LocalRuntimeError(
                "stale-revision",
                "Expected revision is no longer current",
                details={"currentRevision": revision["value"]},
            )
        command_type = str(command.get("type") or "")
        if command_type not in _COMMAND_OPERATIONS:
            raise LocalRuntimeError(
                "invalid-command", "Command type is not supported by the Local Profile"
            )
        target = dict(command.get("target") or {})
        _stable(target.get("initiativeId"), "initiativeId")
        _stable(target.get("assignmentId"), "assignmentId")
        forbidden = _contains_forbidden_argument(command.get("arguments"))
        if forbidden:
            raise LocalRuntimeError(
                "authority-bypass",
                "Caller attempted to name or mutate backend implementation state",
                details={"field": forbidden},
            )
        attempt = command.get("attempt")
        lease = command.get("lease")
        warrant = command.get("warrant")
        if command_type in _LEASE_COMMANDS:
            if not isinstance(attempt, Mapping) or not isinstance(lease, Mapping):
                raise LocalRuntimeError(
                    "lease-required", "Command requires an exact attempt and lease"
                )
            if lease.get("state") != "active":
                raise LocalRuntimeError("lease-required", "Command lease is not active")
            try:
                expires_at = datetime.fromisoformat(
                    str(lease.get("expiresAt") or "").replace("Z", "+00:00")
                )
            except ValueError as error:
                raise LocalRuntimeError(
                    "lease-required", "Command lease expiry is invalid"
                ) from error
            if expires_at.tzinfo is None or expires_at <= datetime.now(UTC):
                raise LocalRuntimeError("lease-required", "Command lease is expired")
            if command_type == "assignment.stage":
                matches = [
                    row
                    for row in snapshot.get("assignments") or []
                    if row.get("initiativeId") == target.get("initiativeId")
                    and row.get("assignmentId") == target.get("assignmentId")
                ]
                if len(matches) != 1:
                    raise LocalRuntimeError(
                        "ambiguous-identity",
                        "Command target does not resolve exactly once",
                    )
                current = matches[0]
                current_attempt = current.get("attempt") or {}
                if (
                    current_attempt.get("attemptId") != attempt.get("attemptId")
                    or current.get("lease") != lease
                ):
                    raise LocalRuntimeError(
                        "lease-required",
                        "Command attempt and lease do not match the active authority state",
                    )
        if warrant is not None:
            if not isinstance(warrant, Mapping) or warrant.get("state") != "active":
                raise LocalRuntimeError(
                    "warrant-invalid", "Command Warrant is not active"
                )
            scope = set(str(value) for value in warrant.get("scope") or [])
            if not ({command_type, "assignment-execution", "*"} & scope):
                raise LocalRuntimeError(
                    "warrant-invalid", "Command Warrant scope is insufficient"
                )

    def _submit(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        snapshot, revision = self._observe_snapshot(record_event=True)
        command = dict(request["payload"])
        idempotency_key = str(command["idempotencyKey"])
        command_root = _root(command)
        commands = dict(self._state.get("commands") or {})
        previous = commands.get(idempotency_key)
        if isinstance(previous, Mapping):
            if previous.get("commandRoot") != command_root:
                raise LocalRuntimeError(
                    "idempotency-conflict",
                    "Idempotency key was already used for another command body",
                )
            return self._replay(str(request["requestId"]), selected, dict(previous))
        if any(
            record.get("commandId") == command.get("commandId")
            for record in commands.values()
        ):
            raise LocalRuntimeError(
                "idempotency-conflict",
                "Command identity was already used with another idempotency key",
            )
        if any(
            row.get("severity") == "error" for row in snapshot.get("diagnostics") or []
        ):
            raise LocalRuntimeError(
                "backend-unavailable",
                "Assignment authority snapshot is incomplete",
                diagnostics=list(snapshot.get("diagnostics") or []),
            )
        self._validate_command(command, snapshot, revision)
        pending = self._state.get("pending")
        if isinstance(pending, Mapping):
            raise LocalRuntimeError(
                "backend-unavailable", "Another command is awaiting recovery"
            )
        pending = {
            "commandRoot": command_root,
            "command": command,
            "beforeRevision": revision,
            "requestId": str(request["requestId"]),
        }
        self._state["pending"] = pending
        self._save_state()
        self._fault("after-intent")
        authority_result = self.authority.apply(command)
        self._fault("after-authority")
        pending["authorityResult"] = authority_result
        self._state["pending"] = pending
        self._save_state()
        self._fault("after-authority-result")
        snapshot, revision = self._observe_snapshot(record_event=False)
        record = self._finalize_pending(pending, snapshot, revision, recovered=False)
        return self._command_response(str(request["requestId"]), selected, record)

    def _finalize_pending(
        self,
        pending: Mapping[str, Any],
        snapshot: Mapping[str, Any],
        revision: Mapping[str, Any],
        *,
        recovered: bool,
    ) -> dict[str, Any]:
        command = dict(pending["command"])
        authority_result = dict(pending.get("authorityResult") or {})
        receipt_preimage = {
            "schema": RECEIPT_SCHEMA,
            "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
            "realm": dict(self.realm),
            "commandRoot": str(pending["commandRoot"]),
            "beforeRevision": dict(pending["beforeRevision"]),
            "afterRevision": dict(revision),
            "authorityReceiptRoot": _root(authority_result),
        }
        receipt_root = _root(receipt_preimage)
        episode_refs = list(authority_result.get("episodeRefs") or [])
        record = {
            "commandId": str(command["commandId"]),
            "idempotencyKey": str(command["idempotencyKey"]),
            "commandRoot": str(pending["commandRoot"]),
            "receiptRoot": receipt_root,
            "receipt": {**receipt_preimage, "receiptRoot": receipt_root},
            "revision": dict(revision),
            "attempt": command.get("attempt"),
            "lease": command.get("lease"),
            "warrant": command.get("warrant"),
            "factRefs": list(snapshot.get("factRefs") or []),
            "episodeRefs": episode_refs,
            "recovered": recovered,
        }
        commands = dict(self._state.get("commands") or {})
        commands[str(command["idempotencyKey"])] = record
        self._state["commands"] = commands
        self._state["pending"] = None
        self._state["revision"] = dict(revision)
        self._append_event(
            "command-recovered" if recovered else "command-applied",
            revision,
            {
                "commandId": record["commandId"],
                "commandRoot": record["commandRoot"],
                "receiptRoot": receipt_root,
            },
        )
        self._save_state()
        return record

    def _command_response(
        self,
        request_id: str,
        selected: list[str],
        record: Mapping[str, Any],
        *,
        disposition: str = "applied",
    ) -> dict[str, Any]:
        result = {
            "command": {
                "commandId": record["commandId"],
                "disposition": disposition,
                "originalReceiptRoot": record["receiptRoot"],
                "commandRoot": record["commandRoot"],
            }
        }
        return self._ok(
            request_id,
            dict(record["revision"]),
            selected,
            result,
            attempt=record.get("attempt"),
            lease=record.get("lease"),
            warrant=record.get("warrant"),
            fact_refs=list(record.get("factRefs") or []),
            episode_refs=list(record.get("episodeRefs") or []),
            receipts=[{"receiptRoot": record["receiptRoot"], "kind": "command"}],
        )

    def _replay(
        self, request_id: str, selected: list[str], record: Mapping[str, Any]
    ) -> dict[str, Any]:
        return self._command_response(
            request_id, selected, record, disposition="replayed"
        )

    def _command_get(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        payload = dict(request.get("payload") or {})
        command_id = str(payload.get("commandId") or "")
        idempotency_key = str(payload.get("idempotencyKey") or "")
        matches = [
            dict(record)
            for key, record in (self._state.get("commands") or {}).items()
            if (idempotency_key and key == idempotency_key)
            or (command_id and record.get("commandId") == command_id)
        ]
        if len(matches) != 1:
            raise LocalRuntimeError(
                "ambiguous-identity", "Command identity does not resolve exactly once"
            )
        record = matches[0]
        return self._ok(
            str(request["requestId"]),
            dict(record["revision"]),
            selected,
            {
                "command": {
                    "commandId": record["commandId"],
                    "commandRoot": record["commandRoot"],
                    "receiptRoot": record["receiptRoot"],
                    "recovered": record["recovered"],
                }
            },
            receipts=[{"receiptRoot": record["receiptRoot"], "kind": "command"}],
        )

    def _diagnostics(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        _snapshot, revision = self._observe_snapshot(record_event=True)
        diagnostics = list(self._state.get("diagnostics") or [])
        diagnostics.extend(self.authority.diagnostics())
        return self._ok(
            str(request["requestId"]),
            revision,
            selected,
            {
                "writer": "active",
                "pendingCommand": bool(self._state.get("pending")),
                "diagnostics": diagnostics,
            },
            diagnostics=diagnostics,
        )

    def _recovery_plan(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        _snapshot, revision = self._observe_snapshot(record_event=True)
        pending = self._state.get("pending")
        if isinstance(pending, Mapping):
            automatic = isinstance(pending.get("authorityResult"), Mapping)
            basis = {
                "commandRoot": pending.get("commandRoot"),
                "beforeRevision": pending.get("beforeRevision"),
                "currentRevision": revision,
                "automatic": automatic,
            }
            result = {
                "planId": f"recovery-{_root(basis)[7:31]}",
                "status": "executable" if automatic else "manual-review-required",
                "automatic": automatic,
                "basisRoot": _root(basis),
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

    def _recovery_execute(
        self, request: Mapping[str, Any], selected: list[str]
    ) -> dict[str, Any]:
        payload = dict(request.get("payload") or {})
        pending = self._state.get("pending")
        if not isinstance(pending, Mapping) or not isinstance(
            pending.get("authorityResult"), Mapping
        ):
            raise LocalRuntimeError(
                "backend-unavailable",
                "No deterministic automatic recovery is available",
                diagnostics=list(self._state.get("diagnostics") or []),
            )
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

    def _capability_envelope(self, selected: list[str]) -> dict[str, list[str]]:
        return {
            "supported": list(self._capabilities),
            "selected": list(selected),
            "unsupported": [],
        }

    def _ok(
        self,
        request_id: str,
        revision: Mapping[str, Any],
        selected: list[str],
        result: Mapping[str, Any],
        *,
        attempt: Any = None,
        lease: Any = None,
        warrant: Any = None,
        fact_refs: list[dict[str, Any]] | None = None,
        episode_refs: list[dict[str, Any]] | None = None,
        receipts: list[dict[str, Any]] | None = None,
        diagnostics: list[dict[str, Any]] | None = None,
        cursor: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "schema": RESPONSE_SCHEMA,
            "requestId": request_id,
            "realm": dict(self.realm),
            "revision": dict(revision),
            "capabilities": self._capability_envelope(selected),
            "status": "ok",
            "result": dict(result),
            "attempt": _copy_json(attempt) if attempt is not None else None,
            "lease": _copy_json(lease) if lease is not None else None,
            "warrant": _copy_json(warrant) if warrant is not None else None,
            "factRefs": list(fact_refs or []),
            "episodeRefs": list(episode_refs or []),
            "receipts": list(receipts or []),
            "diagnostics": list(diagnostics or []),
            "cursor": dict(cursor) if cursor is not None else None,
            "error": None,
        }

    def _error(
        self,
        request_id: str,
        revision: Mapping[str, Any],
        error: LocalRuntimeError,
    ) -> dict[str, Any]:
        return {
            "schema": RESPONSE_SCHEMA,
            "requestId": request_id,
            "realm": dict(self.realm),
            "revision": dict(revision),
            "capabilities": self._capability_envelope([]),
            "status": "error",
            "result": None,
            "attempt": None,
            "lease": None,
            "warrant": None,
            "factRefs": [],
            "episodeRefs": [],
            "receipts": [],
            "diagnostics": list(error.diagnostics),
            "cursor": None,
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": _ERROR_RETRYABLE.get(error.code, False),
                "details": dict(error.details),
            },
        }
