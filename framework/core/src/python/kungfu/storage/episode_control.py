# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, TypeVar

import kungfu
from kungfu.storage import service

yjj = kungfu.__binding__.runtime

T = TypeVar("T")

MANIFEST_WRITER_BUSY = "manifest_writer_busy"
WRITE_RETRY_SCHEMA = "kungfu.episode.write-retry/v1"
RECOVERY_RECEIPT_SCHEMA = "kungfu.episode.recovery-receipt/v1"


@dataclass(frozen=True)
class EpisodeWriteRetryPolicy:
    timeout_seconds: float = 4.0
    initial_delay_seconds: float = 0.02
    max_delay_seconds: float = 0.25
    jitter_ratio: float = 0.2

    def validate(self) -> None:
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self.initial_delay_seconds <= 0:
            raise ValueError("initial_delay_seconds must be positive")
        if self.max_delay_seconds < self.initial_delay_seconds:
            raise ValueError("max_delay_seconds must be >= initial_delay_seconds")
        if not 0 <= self.jitter_ratio <= 1:
            raise ValueError("jitter_ratio must be between 0 and 1")

    def to_native_options(self) -> dict[str, Any]:
        self.validate()
        return {
            "timeout_ms": round(self.timeout_seconds * 1000),
            "initial_delay_ms": round(self.initial_delay_seconds * 1000),
            "max_delay_ms": round(self.max_delay_seconds * 1000),
            "jitter_ratio": self.jitter_ratio,
        }


DEFAULT_WRITE_RETRY_POLICY = EpisodeWriteRetryPolicy()
SIGNAL_ABORT_RETRY_POLICY = EpisodeWriteRetryPolicy(
    timeout_seconds=1.0,
    initial_delay_seconds=0.01,
    max_delay_seconds=0.1,
    jitter_ratio=0.1,
)


class EpisodeWriterBusyError(RuntimeError):
    code = "episode_writer_busy_timeout"

    def __init__(
        self, *, operation: str, attempts: int, busy_retries: int, elapsed_ms: int
    ) -> None:
        self.operation = operation
        self.attempts = attempts
        self.busy_retries = busy_retries
        self.elapsed_ms = elapsed_ms
        super().__init__(
            f"{self.code}: {operation} exhausted the bounded "
            f"{MANIFEST_WRITER_BUSY} retry after {attempts} attempts "
            f"({elapsed_ms} ms)"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": WRITE_RETRY_SCHEMA,
            "code": self.code,
            "cause": MANIFEST_WRITER_BUSY,
            "operation": self.operation,
            "attempts": self.attempts,
            "busyRetries": self.busy_retries,
            "elapsedMs": self.elapsed_ms,
            "exhausted": True,
            "retryable": False,
        }


class EpisodeRecoveryError(RuntimeError):
    def __init__(
        self, code: str, message: str, *, plan: dict[str, Any] | None = None
    ) -> None:
        self.code = code
        self.message = message
        self.plan = plan
        super().__init__(f"{code}: {message}")

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "schema": RECOVERY_RECEIPT_SCHEMA,
            "ok": False,
            "error": {"code": self.code, "message": self.message},
        }
        if self.plan is not None:
            result["plan"] = self.plan
        return result


def retry_episode_write(
    operation: str,
    action: Callable[[], T],
    *,
    policy: EpisodeWriteRetryPolicy = DEFAULT_WRITE_RETRY_POLICY,
    **_compatibility_hooks: Any,
) -> tuple[T, dict[str, Any]]:
    """Compatibility adapter for callers whose action is now retried in C++.

    The callable is invoked exactly once. Native Episode write operations attach
    their bounded contention receipt as write_retry.
    """

    policy.validate()
    value = action()
    receipt = dict(value.get("write_retry") or {}) if isinstance(value, dict) else {}
    if not receipt:
        receipt = {
            "schema": WRITE_RETRY_SCHEMA,
            "operation": operation,
            "attempts": 1,
            "busyRetries": 0,
            "elapsedMs": 0,
            "exhausted": False,
        }
    return value, receipt


def stream_writer_resource_id(location_uid: int, dest_id: int = 0) -> str:
    return f"{location_uid:08x}.{dest_id:08x}"


def _writer_evidence_path(runtime_dir: str | Path, resource_id: str) -> Path:
    return Path(runtime_dir) / "ownership" / "writers" / f"{resource_id}.lock"


def inspect_episode_writer(
    runtime_dir: str | Path, *, location_uid: int
) -> dict[str, Any]:
    resource_id = stream_writer_resource_id(location_uid)
    evidence_path = _writer_evidence_path(runtime_dir, resource_id)
    result: dict[str, Any] = {
        "resourceId": resource_id,
        "evidencePath": str(evidence_path),
        "active": False,
        "status": "absent",
        "evidence": None,
    }
    if not evidence_path.exists():
        return result
    try:
        evidence = dict(yjj.inspect_active_stream_writer(str(runtime_dir), resource_id))
    except RuntimeError as exc:
        message = str(exc)
        if message.startswith("ownership_not_active:"):
            result["status"] = "inactive"
            return result
        result.update(
            {
                "status": "unknown",
                "error": message,
            }
        )
        return result
    result.update(
        {
            "active": True,
            "status": "active",
            "evidence": evidence,
        }
    )
    return result


def plan_episode_recovery(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    now_ns: int | None = None,
) -> dict[str, Any]:
    """Return the recovery plan computed by the native storage service."""

    return service.episode_recovery_plan(
        runtime_dir,
        episode_id=episode_id,
        location_uid=location_uid,
        stale_after_seconds=stale_after_seconds,
        now_ns=now_ns,
    )


def execute_episode_recovery(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    reason: str = "operator recovery",
    now_ns: int | None = None,
) -> dict[str, Any]:
    """Execute native fenced recovery and preserve Python exception shape."""

    try:
        receipt = service.episode_recovery_execute(
            runtime_dir,
            episode_id=episode_id,
            location_uid=location_uid,
            stale_after_seconds=stale_after_seconds,
            reason=reason,
            now_ns=now_ns,
        )
    except RuntimeError as exc:
        if str(exc).startswith("episode_writer_busy_timeout:"):
            raise EpisodeWriterBusyError(
                operation="episode_recover",
                attempts=0,
                busy_retries=0,
                elapsed_ms=0,
            ) from exc
        raise
    if not receipt.get("ok", False):
        error = dict(receipt.get("error") or {})
        raise EpisodeRecoveryError(
            str(error.get("code") or "episode_recovery_failed"),
            str(error.get("message") or "native Episode recovery failed"),
            plan=dict(receipt.get("plan") or {}),
        )
    return receipt
