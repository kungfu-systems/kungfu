# SPDX-License-Identifier: Apache-2.0

"""Admit exact post-merge delivery evidence into native Fact and Episode state.

GitHub and Buildchain are evidence producers and transports.  This adapter
verifies their already-sanitized coordinates; only the owning Kungfu runtime
writes the admission Fact and the unique delivery Episode.
"""

from __future__ import annotations

from datetime import datetime, timezone
import re
import time
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.content_hash import compute_content_hash_value
from kungfu.storage import service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle


ENVELOPE_SCHEMA = "kungfu.delivery-evidence.envelope/v1"
EXPECTATION_SCHEMA = "kungfu.delivery-evidence.expectation/v1"
STATE_SCHEMA = "kungfu.delivery-evidence.admission-state/v1"
RESULT_SCHEMA = "kungfu.delivery-evidence.ingestion-result/v1"
EVENT_SCHEMA = "kungfu.delivery-evidence.episode-event/v1"
FACT_TYPE_ID = "delivery-evidence-admission"
FACT_TYPE_VERSION = "1"
FACT_SOURCE_ID = "delivery-evidence-adapter"
EVENT_TYPE = "kungfu.delivery-evidence.admitted"
ROOT_PREFIX = "sha256:"
ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY_NAME = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
STATUSES = {
    "admitted",
    "duplicate",
    "retryable-failure",
    "terminal-failure",
}


class EvidenceValidationError(ValueError):
    """Stable, sanitized verification failure."""

    def __init__(self, code: str, field: str, *, retryable: bool) -> None:
        self.code = code
        self.field = field
        self.retryable = retryable
        super().__init__(f"{code}: {field}")


def _root(value: Any) -> str:
    return ROOT_PREFIX + compute_content_hash_value(canonical_json_bytes(value))


def _exact_object(
    value: Any, required: set[str], field: str, *, retryable_missing: bool = True
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    missing = required - set(value)
    if missing:
        raise EvidenceValidationError(
            "delivery-evidence-missing",
            f"{field}.{sorted(missing)[0]}",
            retryable=retryable_missing,
        )
    extra = set(value) - required
    if extra:
        raise EvidenceValidationError(
            "delivery-evidence-unknown-field",
            f"{field}.{sorted(extra)[0]}",
            retryable=False,
        )
    return value


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    return value


def _sha(value: Any, field: str) -> str:
    value = _text(value, field)
    if GIT_SHA.fullmatch(value) is None:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    return value


def _content_root(value: Any, field: str) -> str:
    value = _text(value, field)
    if ROOT.fullmatch(value) is None:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    return value


def _root_set(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    roots = [
        _content_root(item, f"{field}[{index}]") for index, item in enumerate(value)
    ]
    if len(roots) != len(set(roots)):
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    return sorted(roots)


def _positive_integer(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    return value


def _timestamp(value: Any, field: str) -> datetime:
    value = _text(value, field)
    if not value.endswith("Z"):
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        ) from error
    if parsed.tzinfo is None:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", field, retryable=False
        )
    return parsed.astimezone(timezone.utc)


def _normalize_coordinates(
    value: Any, *, schema: str, retryable_missing: bool
) -> dict[str, Any]:
    root = _exact_object(
        value,
        {
            "schema",
            "repository",
            "pullRequest",
            "githubRun",
            "buildchain",
            "mergeQueue",
        },
        "$",
        retryable_missing=retryable_missing,
    )
    if root["schema"] != schema:
        raise EvidenceValidationError(
            "delivery-evidence-schema-mismatch", "$.schema", retryable=False
        )
    repository = _exact_object(
        root["repository"],
        {"id", "fullName"},
        "$.repository",
        retryable_missing=retryable_missing,
    )
    repository_id = _text(repository["id"], "$.repository.id")
    full_name = _text(repository["fullName"], "$.repository.fullName")
    if REPOSITORY_NAME.fullmatch(full_name) is None:
        raise EvidenceValidationError(
            "delivery-evidence-malformed", "$.repository.fullName", retryable=False
        )
    pull_request = _exact_object(
        root["pullRequest"],
        {"number", "headSha", "mergeCommitSha"},
        "$.pullRequest",
        retryable_missing=retryable_missing,
    )
    github_run = _exact_object(
        root["githubRun"],
        {"workflow", "runId", "attempt"},
        "$.githubRun",
        retryable_missing=retryable_missing,
    )
    buildchain = _exact_object(
        root["buildchain"],
        {"receiptRoot", "artifactRoots", "schemaRoots"},
        "$.buildchain",
        retryable_missing=retryable_missing,
    )
    merge_queue = _exact_object(
        root["mergeQueue"],
        {"attemptRoot"},
        "$.mergeQueue",
        retryable_missing=retryable_missing,
    )
    return {
        "repository": {"id": repository_id, "fullName": full_name},
        "pullRequest": {
            "number": _positive_integer(pull_request["number"], "$.pullRequest.number"),
            "headSha": _sha(pull_request["headSha"], "$.pullRequest.headSha"),
            "mergeCommitSha": _sha(
                pull_request["mergeCommitSha"], "$.pullRequest.mergeCommitSha"
            ),
        },
        "githubRun": {
            "workflow": _text(github_run["workflow"], "$.githubRun.workflow"),
            "runId": _text(github_run["runId"], "$.githubRun.runId"),
            "attempt": _positive_integer(github_run["attempt"], "$.githubRun.attempt"),
        },
        "buildchain": {
            "receiptRoot": _content_root(
                buildchain["receiptRoot"], "$.buildchain.receiptRoot"
            ),
            "artifactRoots": _root_set(
                buildchain["artifactRoots"], "$.buildchain.artifactRoots"
            ),
            "schemaRoots": _root_set(
                buildchain["schemaRoots"], "$.buildchain.schemaRoots"
            ),
        },
        "mergeQueue": {
            "attemptRoot": _content_root(
                merge_queue["attemptRoot"], "$.mergeQueue.attemptRoot"
            )
        },
    }


def normalize_expectation(value: Any) -> dict[str, Any]:
    """Validate the caller-owned exact coordinates used for idempotency."""

    return _normalize_coordinates(
        value, schema=EXPECTATION_SCHEMA, retryable_missing=False
    )


def coordinate_root(expectation: Any) -> str:
    return _root(normalize_expectation(expectation))


def _mismatch(
    actual: dict[str, Any],
    expected: dict[str, Any],
    section: str,
    code: str,
) -> None:
    if actual[section] != expected[section]:
        raise EvidenceValidationError(code, f"$.{section}", retryable=False)


def verify_envelope(
    value: Any,
    expectation: Any,
    *,
    now: datetime | None = None,
    max_age_seconds: int = 7 * 24 * 60 * 60,
) -> dict[str, Any]:
    """Fail closed and return the normalized, raw-payload-free evidence."""

    expected = normalize_expectation(expectation)
    envelope = _exact_object(
        value,
        {
            "schema",
            "repository",
            "pullRequest",
            "githubRun",
            "buildchain",
            "mergeQueue",
            "timestamps",
        },
        "$",
    )
    coordinates = _normalize_coordinates(
        {key: envelope[key] for key in envelope if key != "timestamps"},
        schema=ENVELOPE_SCHEMA,
        retryable_missing=True,
    )
    timestamps = _exact_object(
        envelope["timestamps"],
        {"mergedAt", "runCompletedAt", "observedAt"},
        "$.timestamps",
    )
    parsed = {
        key: _timestamp(timestamps[key], f"$.timestamps.{key}")
        for key in ("mergedAt", "runCompletedAt", "observedAt")
    }
    if parsed["mergedAt"] > parsed["runCompletedAt"]:
        raise EvidenceValidationError(
            "delivery-evidence-malformed",
            "$.timestamps",
            retryable=False,
        )
    if parsed["runCompletedAt"] > parsed["observedAt"]:
        raise EvidenceValidationError(
            "delivery-evidence-malformed",
            "$.timestamps.observedAt",
            retryable=False,
        )
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if max_age_seconds <= 0:
        raise ValueError("max_age_seconds must be positive")
    if (current - parsed["runCompletedAt"]).total_seconds() > max_age_seconds:
        raise EvidenceValidationError(
            "delivery-evidence-stale",
            "$.timestamps.runCompletedAt",
            retryable=False,
        )
    _mismatch(
        coordinates,
        expected,
        "repository",
        "delivery-evidence-repository-mismatch",
    )
    if coordinates["pullRequest"]["number"] != expected["pullRequest"]["number"]:
        raise EvidenceValidationError(
            "delivery-evidence-pr-mismatch",
            "$.pullRequest.number",
            retryable=False,
        )
    if coordinates["pullRequest"]["headSha"] != expected["pullRequest"]["headSha"]:
        raise EvidenceValidationError(
            "delivery-evidence-pr-head-mismatch",
            "$.pullRequest.headSha",
            retryable=False,
        )
    if (
        coordinates["pullRequest"]["mergeCommitSha"]
        != expected["pullRequest"]["mergeCommitSha"]
    ):
        raise EvidenceValidationError(
            "delivery-evidence-merge-mismatch",
            "$.pullRequest.mergeCommitSha",
            retryable=False,
        )
    _mismatch(coordinates, expected, "githubRun", "delivery-evidence-run-mismatch")
    if (
        coordinates["buildchain"]["receiptRoot"]
        != expected["buildchain"]["receiptRoot"]
    ):
        raise EvidenceValidationError(
            "delivery-evidence-receipt-mismatch",
            "$.buildchain.receiptRoot",
            retryable=False,
        )
    if (
        coordinates["buildchain"]["artifactRoots"]
        != expected["buildchain"]["artifactRoots"]
    ):
        raise EvidenceValidationError(
            "delivery-evidence-artifact-mismatch",
            "$.buildchain.artifactRoots",
            retryable=False,
        )
    if (
        coordinates["buildchain"]["schemaRoots"]
        != expected["buildchain"]["schemaRoots"]
    ):
        raise EvidenceValidationError(
            "delivery-evidence-schema-root-mismatch",
            "$.buildchain.schemaRoots",
            retryable=False,
        )
    _mismatch(
        coordinates,
        expected,
        "mergeQueue",
        "delivery-evidence-queue-mismatch",
    )
    normalized_timestamps = {
        key: timestamps[key] for key in ("mergedAt", "runCompletedAt", "observedAt")
    }
    normalized = {
        "schema": ENVELOPE_SCHEMA,
        **coordinates,
        "timestamps": normalized_timestamps,
    }
    return {
        "schema": "kungfu.delivery-evidence.verification/v1",
        "ok": True,
        "coordinateRoot": _root(expected),
        "evidenceRoot": _root(normalized),
        "envelope": normalized,
    }


def _fact_definition() -> dict[str, Any]:
    properties = {
        "schema": {"type": "string"},
        "ingestionId": {"type": "string"},
        "idempotencyKey": {"type": "string"},
        "coordinateRoot": {"type": "string"},
        "evidenceRoot": {"type": "string"},
        "status": {"type": "string"},
        "retryCount": {"type": "integer"},
        "firstSeenAt": {"type": "string"},
        "latestAttemptAt": {"type": "string"},
        "admittedAt": {"type": "string"},
        "lagSeconds": {"type": "integer"},
        "latestErrorCode": {"type": "string"},
        "latestErrorRoot": {"type": "string"},
        "episodeId": {"type": "string"},
        "episodeRoot": {"type": "string"},
        "unpublishedDownstream": {"type": "boolean"},
    }
    return {
        "id": FACT_TYPE_ID,
        "version": FACT_TYPE_VERSION,
        "source_authorities": [FACT_SOURCE_ID],
        "schema": {
            "type": "object",
            "properties": properties,
            "required": sorted(properties),
            "additionalProperties": False,
        },
    }


def _ensure_fact_type(runtime_dir: str, system_time: int) -> None:
    catalog = service.fact_type_list(runtime_dir)
    if any(
        row.get("id") == FACT_TYPE_ID
        and str(row.get("version") or "") == FACT_TYPE_VERSION
        for row in catalog.get("fact_types", [])
    ):
        return
    service.fact_type_create(
        runtime_dir, _fact_definition(), system_time=max(1, system_time - 1)
    )


def _latest_state(runtime_dir: str, ingestion_id: str) -> dict[str, Any] | None:
    material = service.fact_material_list(
        runtime_dir, type_id=FACT_TYPE_ID, subject_key=ingestion_id
    )
    payloads = material.get("payloads") or {}
    candidates = [
        dict(payload)
        for payload in payloads.values()
        if isinstance(payload, dict) and payload.get("ingestionId") == ingestion_id
    ]
    if not candidates:
        return None
    status_order = {
        "retryable-failure": 1,
        "admitted": 2,
        "terminal-failure": 3,
    }
    return max(
        candidates,
        key=lambda payload: (
            str(payload.get("latestAttemptAt") or ""),
            status_order.get(str(payload.get("status") or ""), 0),
            int(payload.get("retryCount") or 0),
        ),
    )


def _write_state(
    runtime_dir: str,
    state: dict[str, Any],
    *,
    system_time: int,
) -> dict[str, Any]:
    observation_id = (
        f"{state['ingestionId']}:{state['status']}:{state['retryCount']}:"
        f"{state['latestAttemptAt']}"
    )
    return service.fact_material_put(
        runtime_dir,
        {
            "type_id": FACT_TYPE_ID,
            "type_version": FACT_TYPE_VERSION,
            "source_id": FACT_SOURCE_ID,
            "subject_key": state["ingestionId"],
            "payload": state,
            "observation_id": observation_id,
            "action": "assert",
            "valid_from": system_time,
            "valid_until": 0,
        },
        system_time=system_time,
    )


def _verified_episode_root(runtime_dir: str, episode_id: int) -> str:
    checked = service.fsck(runtime_dir, episode_id=episode_id, verify_frames=True)
    if checked.get("ok") is not True:
        raise RuntimeError("delivery evidence Episode failed frame verification")
    inspected = service.episode_inspect(runtime_dir, episode_id=episode_id)
    candidates = [
        inspected.get("content_root") or {},
        (inspected.get("episode") or {}).get("root") or {},
    ]
    for candidate in candidates:
        value = str(
            candidate.get("computed")
            or candidate.get("root_value")
            or candidate.get("value")
            or ""
        )
        if ROOT.fullmatch(value):
            return value
        if re.fullmatch(r"[0-9a-f]{64}", value):
            return ROOT_PREFIX + value
    raise RuntimeError("delivery evidence Episode has no verified root")


def _admit_episode(
    runtime_dir: str,
    verification: dict[str, Any],
    *,
    actor: str,
) -> tuple[int, str]:
    key = verification["coordinateRoot"]
    # Episode source is a bounded edge label; the event and Fact retain the
    # complete coordinate root.
    source = f"delivery-evidence:{key[7:31]}"
    matches = [
        row
        for row in service.episode_list(runtime_dir, limit=0).get("episodes", [])
        if (row.get("open") or {}).get("source") == source
    ]
    if len(matches) > 1:
        raise RuntimeError("delivery evidence idempotency source is not unique")
    if matches and bool(matches[0].get("closed")):
        episode_id = int(matches[0]["episode_id"])
        return episode_id, _verified_episode_root(runtime_dir, episode_id)
    lifecycle = RuntimeEpisodeLifecycle(
        runtime_dir=runtime_dir,
        namespace="delivery-evidence",
        name=key[7:31],
        title=(
            "Post-merge delivery "
            f"{verification['envelope']['repository']['fullName']}#"
            f"{verification['envelope']['pullRequest']['number']}"
        ),
        actor=actor,
        source=source,
        episode_id=int(matches[0]["episode_id"]) if matches else 0,
        begin=not matches,
    )
    if lifecycle.frame_count == 0:
        event = {
            "schema": EVENT_SCHEMA,
            "coordinateRoot": key,
            "evidenceRoot": verification["evidenceRoot"],
            "delivery": verification["envelope"],
        }
        lifecycle.record_event(
            EVENT_TYPE,
            canonical_json_bytes(event),
            run_id=key[7:31],
        )
    elif lifecycle.frame_count != 1:
        raise RuntimeError("delivery evidence Episode contains unexpected frames")
    lifecycle.close(ok=True, reason="verified post-merge evidence admitted")
    return lifecycle.episode_id, _verified_episode_root(
        runtime_dir, lifecycle.episode_id
    )


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def ingest(
    runtime_dir: str,
    envelope: Any,
    expectation: Any,
    *,
    actor: str,
    now: datetime | None = None,
    max_age_seconds: int = 7 * 24 * 60 * 60,
) -> dict[str, Any]:
    """Verify and idempotently admit one sanitized delivery evidence envelope."""

    if not actor.strip():
        raise ValueError("actor is required")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    # Native journal ordering follows the runtime clock. ``now`` is a
    # deterministic verification input, not authority to rewind that clock.
    system_time = time.time_ns()
    expected = normalize_expectation(expectation)
    key = _root(expected)
    ingestion_id = f"delivery-evidence-{key[7:31]}"
    previous = _latest_state(runtime_dir, ingestion_id)
    if previous and previous["status"] == "admitted":
        duplicate = {**previous, "status": "duplicate"}
        return {
            "schema": RESULT_SCHEMA,
            "ok": True,
            "status": "duplicate",
            "writeOccurred": False,
            "state": duplicate,
            "factReceipt": None,
        }
    if previous and previous["status"] == "terminal-failure":
        return {
            "schema": RESULT_SCHEMA,
            "ok": False,
            "status": "terminal-failure",
            "writeOccurred": False,
            "state": previous,
            "factReceipt": None,
        }
    if previous is None:
        _ensure_fact_type(runtime_dir, system_time)
    try:
        verification = verify_envelope(
            envelope,
            expectation,
            now=current,
            max_age_seconds=max_age_seconds,
        )
    except EvidenceValidationError as error:
        status = "retryable-failure" if error.retryable else "terminal-failure"
        retry_count = int((previous or {}).get("retryCount") or 0) + 1
        error_record = {
            "schema": "kungfu.delivery-evidence.error/v1",
            "code": error.code,
            "field": error.field,
            "retryable": error.retryable,
        }
        state = {
            "schema": STATE_SCHEMA,
            "ingestionId": ingestion_id,
            "idempotencyKey": key,
            "coordinateRoot": key,
            "evidenceRoot": "",
            "status": status,
            "retryCount": retry_count,
            "firstSeenAt": (previous or {}).get("firstSeenAt") or _iso(current),
            "latestAttemptAt": _iso(current),
            "admittedAt": "",
            "lagSeconds": 0,
            "latestErrorCode": error.code,
            "latestErrorRoot": _root(error_record),
            "episodeId": "",
            "episodeRoot": "",
            "unpublishedDownstream": True,
        }
        receipt = _write_state(runtime_dir, state, system_time=system_time)
        return {
            "schema": RESULT_SCHEMA,
            "ok": False,
            "status": status,
            "writeOccurred": True,
            "retryAction": (
                {
                    "action": "retry-delivery-evidence-ingestion",
                    "idempotencyKey": key,
                }
                if error.retryable
                else None
            ),
            "state": state,
            "factReceipt": receipt,
        }
    episode_id, episode_root = _admit_episode(
        runtime_dir, verification, actor=actor.strip()
    )
    completed_at = _timestamp(
        verification["envelope"]["timestamps"]["runCompletedAt"],
        "$.timestamps.runCompletedAt",
    )
    state = {
        "schema": STATE_SCHEMA,
        "ingestionId": ingestion_id,
        "idempotencyKey": key,
        "coordinateRoot": key,
        "evidenceRoot": verification["evidenceRoot"],
        "status": "admitted",
        "retryCount": int((previous or {}).get("retryCount") or 0),
        "firstSeenAt": (previous or {}).get("firstSeenAt") or _iso(current),
        "latestAttemptAt": _iso(current),
        "admittedAt": _iso(current),
        "lagSeconds": max(0, int((current - completed_at).total_seconds())),
        "latestErrorCode": "",
        "latestErrorRoot": "",
        "episodeId": str(episode_id),
        "episodeRoot": episode_root,
        "unpublishedDownstream": True,
    }
    receipt = _write_state(runtime_dir, state, system_time=system_time)
    return {
        "schema": RESULT_SCHEMA,
        "ok": True,
        "status": "admitted",
        "writeOccurred": True,
        "state": state,
        "factReceipt": receipt,
    }


def status(runtime_dir: str, expectation: Any) -> dict[str, Any]:
    """Return the latest native admission state for exact expected coordinates."""

    key = coordinate_root(expectation)
    ingestion_id = f"delivery-evidence-{key[7:31]}"
    latest = _latest_state(runtime_dir, ingestion_id)
    return {
        "schema": "kungfu.delivery-evidence.status/v1",
        "found": latest is not None,
        "ingestionId": ingestion_id,
        "state": latest,
    }
