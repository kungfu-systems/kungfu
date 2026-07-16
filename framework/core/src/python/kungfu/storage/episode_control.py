# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from dataclasses import dataclass
import random
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

import kungfu
from kungfu.storage import service

yjj = kungfu.__binding__.runtime

T = TypeVar("T")

MANIFEST_WRITER_BUSY = "manifest_writer_busy"
WRITE_RETRY_SCHEMA = "kungfu.episode.write-retry/v1"
RECOVERY_PLAN_SCHEMA = "kungfu.episode.recovery-plan/v1"
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


def _is_manifest_writer_busy(exc: BaseException) -> bool:
    if not isinstance(exc, RuntimeError):
        return False
    code, separator, _ = str(exc).partition(":")
    return bool(separator) and code == MANIFEST_WRITER_BUSY


def retry_episode_write(
    operation: str,
    action: Callable[[], T],
    *,
    policy: EpisodeWriteRetryPolicy = DEFAULT_WRITE_RETRY_POLICY,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    random_value: Callable[[], float] = random.random,
) -> tuple[T, dict[str, Any]]:
    """Retry only the manifest guard's pre-append contention error.

    Any other exception is propagated after one call. The native store remains
    acquire-or-fail; this high-level edge absorbs only bounded, known-safe lock
    contention and returns an observable receipt.
    """

    policy.validate()
    started = clock()
    deadline = started + policy.timeout_seconds
    delay = policy.initial_delay_seconds
    attempts = 0
    busy_retries = 0

    while True:
        attempts += 1
        try:
            value = action()
        except BaseException as exc:
            if not _is_manifest_writer_busy(exc):
                raise
            busy_retries += 1
            now = clock()
            remaining = deadline - now
            if remaining <= 0:
                raise EpisodeWriterBusyError(
                    operation=operation,
                    attempts=attempts,
                    busy_retries=busy_retries,
                    elapsed_ms=max(0, round((now - started) * 1000)),
                ) from exc
            jitter = delay * policy.jitter_ratio * ((random_value() * 2.0) - 1.0)
            wait_seconds = min(remaining, max(0.0, delay + jitter))
            if wait_seconds <= 0:
                raise EpisodeWriterBusyError(
                    operation=operation,
                    attempts=attempts,
                    busy_retries=busy_retries,
                    elapsed_ms=max(0, round((now - started) * 1000)),
                ) from exc
            sleep(wait_seconds)
            delay = min(delay * 2.0, policy.max_delay_seconds)
            continue

        elapsed_ms = max(0, round((clock() - started) * 1000))
        return value, {
            "schema": WRITE_RETRY_SCHEMA,
            "operation": operation,
            "attempts": attempts,
            "busyRetries": busy_retries,
            "elapsedMs": elapsed_ms,
            "exhausted": False,
        }


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


def _episode_age(
    episode: dict[str, Any], *, now_ns: int, stale_after_seconds: float
) -> dict[str, Any]:
    open_record = dict(episode.get("open") or {})
    heartbeat_seen = bool(episode.get("heartbeat_seen"))
    heartbeat_time = int(episode.get("update_time") or 0)
    begin_time = int(open_record.get("begin_time") or 0)
    open_manifest_time = int(episode.get("open_manifest_gen_time") or 0)
    if heartbeat_seen and heartbeat_time > 0:
        anchor_kind = "heartbeat"
        anchor_ns = heartbeat_time
    elif begin_time > 0:
        anchor_kind = "begin"
        anchor_ns = begin_time
    else:
        anchor_kind = "manifest-open"
        anchor_ns = open_manifest_time
    age_seconds = (now_ns - anchor_ns) / 1_000_000_000 if anchor_ns > 0 else None
    return {
        "heartbeatSeen": heartbeat_seen,
        "heartbeatTime": heartbeat_time or None,
        "beginTime": begin_time or None,
        "anchorKind": anchor_kind,
        "anchorTime": anchor_ns or None,
        "ageSeconds": age_seconds,
        "staleAfterSeconds": stale_after_seconds,
        "stale": age_seconds is not None and age_seconds >= stale_after_seconds,
    }


def plan_episode_recovery(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    now_ns: int | None = None,
) -> dict[str, Any]:
    if episode_id <= 0:
        raise ValueError("episode_id must be positive")
    if stale_after_seconds < 0:
        raise ValueError("stale_after_seconds must be non-negative")

    inspected = service.episode_inspect(runtime_dir, episode_id=episode_id)
    episode = dict(inspected.get("episode") or {})
    opened = bool(episode.get("opened"))
    closed = bool(episode.get("closed"))
    close_count = int(episode.get("close_count") or 0)
    open_record = dict(episode.get("open") or {})
    owner_location_uid = int(open_record.get("location_uid") or 0)
    age = _episode_age(
        episode,
        now_ns=time.time_ns() if now_ns is None else now_ns,
        stale_after_seconds=stale_after_seconds,
    )
    writer = (
        inspect_episode_writer(runtime_dir, location_uid=owner_location_uid)
        if owner_location_uid
        else {
            "resourceId": None,
            "evidencePath": None,
            "active": False,
            "status": "unknown",
            "evidence": None,
            "error": "episode location_uid is zero",
        }
    )

    blockers: list[dict[str, str]] = []
    if not bool(inspected.get("ok", True)) or not opened:
        blockers.append(
            {"code": "episode_not_opened", "message": "Episode has no open record"}
        )
    if closed or close_count > 0:
        blockers.append(
            {
                "code": "episode_terminal_record_present",
                "message": "Episode already has a terminal record",
            }
        )
    if owner_location_uid == 0:
        blockers.append(
            {
                "code": "episode_location_unknown",
                "message": "Episode does not identify a recoverable writer location",
            }
        )
    if location_uid and location_uid != owner_location_uid:
        blockers.append(
            {
                "code": "episode_location_mismatch",
                "message": "requested location does not own the Episode open record",
            }
        )
    if writer.get("active"):
        blockers.append(
            {
                "code": "episode_writer_active",
                "message": "the Episode event-stream writer lease is live",
            }
        )
    elif writer.get("status") == "unknown":
        blockers.append(
            {
                "code": "episode_writer_liveness_unknown",
                "message": "writer liveness could not be proven inactive",
            }
        )
    if age["ageSeconds"] is None or age["ageSeconds"] < 0:
        blockers.append(
            {
                "code": "episode_age_unknown",
                "message": "Episode age cannot be established from its manifest facts",
            }
        )
    elif not age["stale"]:
        blockers.append(
            {
                "code": "episode_not_stale",
                "message": "Episode is newer than the declared stale threshold",
            }
        )

    return {
        "schema": RECOVERY_PLAN_SCHEMA,
        "ok": True,
        "action": "abort-open-episode",
        "runtimeDir": str(runtime_dir),
        "episodeId": episode_id,
        "locationUid": owner_location_uid,
        "terminalRecordPresent": closed or close_count > 0,
        "age": age,
        "writer": writer,
        "eligible": not blockers,
        "blockers": blockers,
        "preconditions": [
            "Episode remains open and has no terminal record",
            "the exact event-stream writer lease can be acquired",
            "the Episode remains older than staleAfterSeconds",
            "native manifest recovery acquires the data-root writer guard",
        ],
    }


def execute_episode_recovery(
    runtime_dir: str | Path,
    *,
    episode_id: int,
    location_uid: int = 0,
    stale_after_seconds: float = 300.0,
    reason: str = "operator recovery",
    now_ns: int | None = None,
) -> dict[str, Any]:
    plan = plan_episode_recovery(
        runtime_dir,
        episode_id=episode_id,
        location_uid=location_uid,
        stale_after_seconds=stale_after_seconds,
        now_ns=now_ns,
    )
    if not plan["eligible"]:
        raise EpisodeRecoveryError(
            "episode_recovery_not_eligible",
            "recovery preconditions are not satisfied",
            plan=plan,
        )

    resource_id = str(plan["writer"]["resourceId"])
    try:
        recovery_lease = yjj.durability_writer_lease(str(runtime_dir), resource_id)
    except RuntimeError as exc:
        raise EpisodeRecoveryError(
            "episode_recovery_writer_active",
            "the event-stream writer lease became active before execute",
            plan=plan,
        ) from exc

    inspected = service.episode_inspect(runtime_dir, episode_id=episode_id)
    episode = dict(inspected.get("episode") or {})
    current_location_uid = int(dict(episode.get("open") or {}).get("location_uid") or 0)
    current_age = _episode_age(
        episode,
        now_ns=time.time_ns() if now_ns is None else now_ns,
        stale_after_seconds=stale_after_seconds,
    )
    current_records = list(episode.get("records") or [])
    expected_manifest_frame_uid = (
        int(current_records[-1].get("manifest_frame_uid") or 0)
        if current_records
        else 0
    )
    if (
        not bool(episode.get("opened"))
        or bool(episode.get("closed"))
        or int(episode.get("close_count") or 0) > 0
        or current_location_uid != plan["locationUid"]
        or not current_age["stale"]
        or expected_manifest_frame_uid == 0
    ):
        raise EpisodeRecoveryError(
            "episode_recovery_state_changed",
            "Episode facts changed after planning; generate a new plan",
            plan=plan,
        )

    recovered, write_retry = retry_episode_write(
        "episode_recover",
        lambda: service.episode_recover(
            runtime_dir,
            episode_id=episode_id,
            location_uid=current_location_uid,
            reason=reason,
            expected_manifest_frame_uid=expected_manifest_frame_uid,
        ),
    )
    recovered_ids = [
        int(item["close"]["episode_id"]) for item in recovered.get("recovered", [])
    ]
    if episode_id not in recovered_ids:
        raise EpisodeRecoveryError(
            "episode_recovery_not_applied",
            "native recovery did not append the expected terminal record",
            plan=plan,
        )
    return {
        "schema": RECOVERY_RECEIPT_SCHEMA,
        "ok": True,
        "plan": plan,
        "fence": dict(recovery_lease.status),
        "writeRetry": write_retry,
        "recovery": recovered,
    }
