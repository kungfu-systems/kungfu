# SPDX-License-Identifier: Apache-2.0

"""Shared contracts, suite discovery, and immutable Agent Work Lab evidence."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, Mapping

import kungfu
from kungfu.rewind import (
    ACTION_RUN_BEGIN,
    ACTION_RUN_END,
    SCHEMA_VERSION,
    events as rewind_events,
)
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.storage import service as storage_service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

SUITE_ID = "kungfu.agent-work-lab"
FIXTURE_ID = "partial-claim-fresh-session"
CATALOG_SCHEMA = "kungfu.agent-work-lab.catalog/v1"
DEMO_PLAN_SCHEMA = "kungfu.agent-work-lab.demo-plan/v1"
DEMO_REPORT_SCHEMA = "kungfu.agent-work-lab.report/v1"
AGENT_PLAN_SCHEMA = "kungfu.agent-work-lab.agent-plan/v1"
AGENT_REPORT_SCHEMA = "kungfu.agent-work-lab.agent-report/v1"
PUBLIC_ACTIVITY_SCHEMA = "kungfu.agent-work-lab.public-activity/v1"
PUBLIC_OUTPUT_SCHEMA = "kungfu.agent-work-lab.public-output/v1"
TEMPLATE_SCHEMA = "kungfu.project-template/v1"
PLAN_SCHEMA = "kungfu.project-template.plan/v1"
RECEIPT_SCHEMA = "kungfu.project-template.creation-receipt/v1"
DEFAULT_TEMPLATE_ID = "kungfu.agent-work-starter"
FORBIDDEN_TEMPLATE_ROOTS = {".git", ".kungfu"}
CONTENT_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
ANSI_ESCAPE = re.compile(r"\x1b(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
PUBLIC_OUTPUT_MESSAGES = {
    1: "Recorded the bounded partial result and stopped.",
    2: "Found the prior governed state and completed only the remaining step.",
}
PUBLIC_PROGRESS_MESSAGES = {
    1: (
        "I’m starting fresh, so I’ll inspect the governed task state first.",
        "I found an unstarted task. I’ll record only the bounded first step.",
    ),
    2: (
        "I’m starting fresh, so I’ll recover the governed task state before acting.",
        "I found Session 1’s partial result and the same Work identity.",
    ),
}
DEMO_AGENT_IDENTITY = {
    "provider": "kungfu-demo-agent",
    "executableDigest": "sha256:" + hashlib.sha256(b"kungfu-demo-agent/v1").hexdigest(),
    "version": "1",
    "model": "deterministic-state-machine",
    "runtimeProfileRoot": "sha256:"
    + hashlib.sha256(b"kungfu-demo-agent-profile/v1").hexdigest(),
    "argv": ["bundled", "agent-work-lab-demo"],
}

AgentWorkLabEventSink = Callable[[Mapping[str, Any]], None]
EventSink = AgentWorkLabEventSink


def content_root(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


_content_root = content_root


def _catalog_paths() -> list[Path]:
    roots = [
        value
        for value in (
            os.environ.get("KF_BUNDLED_EXTENSION_ROOT"),
            *os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep),
        )
        if value
    ]
    candidates = [
        Path(root).expanduser() / "agent-work-lab" / "experience" / "catalog.json"
        for root in roots
    ]
    candidates.append(
        Path(__file__).resolve().parents[5]
        / "extensions"
        / "agent-work-lab"
        / "experience"
        / "catalog.json"
    )
    return candidates


def load_suite_catalog() -> tuple[dict[str, Any], Path, str]:
    for path in _catalog_paths():
        if not path.is_file():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        valid = (
            payload.get("schema") == "kungfu.agent-work-lab.suite-catalog/v1"
            and payload.get("id") == SUITE_ID
            and payload.get("collection", {}).get("id") == "work-continuity"
            and [row.get("id") for row in payload.get("cases", [])]
            == ["offline-demo", "same-agent", "cross-agent"]
            and payload.get("capabilityDeclarations") == ["agentRuntime", "work"]
        )
        if not valid:
            raise RuntimeError(f"invalid Agent Work Lab Suite catalog: {path}")
        return payload, path.resolve(), _content_root(payload)
    raise RuntimeError(
        "Agent Work Lab Suite catalog is unavailable; install the first-party "
        "KFX Suite or set a valid bundled extension root"
    )


def work_reference(plan_root: str) -> dict[str, Any]:
    suite_catalog, _, suite_catalog_root = load_suite_catalog()
    entity = {
        "suite": SUITE_ID,
        "collection": suite_catalog["collection"]["id"],
        "fixture": FIXTURE_ID,
        "catalogRoot": suite_catalog_root,
        "planRoot": plan_root,
    }
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": f"agent-work-lab:{suite_catalog_root[7:23]}",
        "profileId": SUITE_ID,
        "profileRoot": suite_catalog_root,
        "entityType": "suite-case",
        "entityId": FIXTURE_ID,
        "entityRoot": _content_root(entity),
        "purpose": "work-continuity",
        "systemTimeCut": plan_root,
    }


def _verified_episode_root(runtime_dir: Path, episode_id: int) -> str:
    verified = storage_service.fsck(
        runtime_dir, episode_id=episode_id, verify_frames=True
    )
    if verified.get("ok") is not True:
        raise RuntimeError("Agent Work Lab Episode failed Core frame verification")
    inspected = storage_service.episode_inspect(runtime_dir, episode_id=episode_id)
    candidates = [
        inspected.get("content_root") or {},
        ((inspected.get("episode") or {}).get("root") or {}),
    ]
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        raw = str(
            candidate.get("computed")
            or candidate.get("root_value")
            or candidate.get("value")
            or ""
        )
        if CONTENT_ROOT.fullmatch(raw):
            return raw
        if re.fullmatch(r"[0-9a-f]{64}", raw):
            return f"sha256:{raw}"
    raise RuntimeError("Agent Work Lab Episode has no verified content root")


def open_episode(
    runtime_dir: Path, attempt_index: int, actor: str
) -> RuntimeEpisodeLifecycle:
    run_id = f"agent-work-lab-session-{attempt_index}"
    episode = RuntimeEpisodeLifecycle(
        runtime_dir=str(runtime_dir),
        namespace="agent-work-lab",
        name=run_id,
        title=f"Agent Work Lab Session {attempt_index}",
        actor=actor,
        source=f"agent-work-lab:{attempt_index}",
    )
    episode.record_event(
        ACTION_RUN_BEGIN,
        rewind_events.run_begin(
            run_id=run_id,
            command="Agent Work Lab governed Session",
            runtime=platform.system().lower(),
            supervisor_version=kungfu.__version__,
            schema_version=SCHEMA_VERSION,
        ),
        run_id=run_id,
    )
    return episode


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def close_episode(
    episode: RuntimeEpisodeLifecycle,
    runtime_dir: Path,
    evidence_root: Path,
    attempt_index: int,
    receipt: Mapping[str, Any],
    *,
    ok: bool,
) -> dict[str, Any]:
    run_id = f"agent-work-lab-session-{attempt_index}"
    immutable_receipt = {
        "schema": "kungfu.agent-work-lab.session-receipt/v1",
        "attemptIndex": attempt_index,
        **dict(receipt),
    }
    receipt_root = _content_root(immutable_receipt)
    receipt_path = evidence_root / f"session-{attempt_index}-receipt.json"
    _write_json(receipt_path, immutable_receipt)
    episode.attach_payload_ref(str(receipt_path))
    episode.record_event(
        ACTION_RUN_END,
        rewind_events.run_end(
            run_id,
            RunStatus.Succeeded if ok else RunStatus.Failed,
            0 if ok else 1,
        ),
        run_id=run_id,
    )
    episode.close(
        ok=ok,
        reason=(
            "Agent Work Lab Session evidence admitted"
            if ok
            else "Agent Work Lab Session evidence failed admission"
        ),
    )
    return {
        "episodeId": str(episode.episode_id),
        "episodeRoot": _verified_episode_root(runtime_dir, episode.episode_id),
        "receiptRoot": receipt_root,
        "receiptPath": str(receipt_path),
    }


def publish_event(
    events: list[dict[str, Any]], event: dict[str, Any], on_event: EventSink | None
) -> None:
    events.append(event)
    if on_event is not None:
        on_event(event)
