# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import kungfu
from kungfu.work import (
    ACTION_ARTIFACT_RECORDED,
    ACTION_CHECKPOINT_RECORDED,
    ACTION_DECISION_RECORDED,
    ACTION_NEXT_ACTION_SET,
    ACTION_RUN_LINKED,
    ACTION_VALIDATION_RECORDED,
    ACTION_WORK_ITEM_CREATED,
    ACTION_WORK_STATUS_CHANGED,
    events,
    record_root,
)
from kungfu.work.wire import wrap_event

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "tests/fixtures/native-admission/work-journal-v1.json"


CASES = [
    (
        "created",
        ACTION_WORK_ITEM_CREATED,
        {
            "work_id": "w1234abcd",
            "title": "native",
            "kind": "test",
            "summary": "parity",
            "schema_version": 1,
        },
        events.work_item_created("w1234abcd", "native", "test", "parity", 1),
    ),
    (
        "status-changed",
        ACTION_WORK_STATUS_CHANGED,
        {"work_id": "w1234abcd", "status": 1, "reason": "pause"},
        events.work_status_changed("w1234abcd", 1, "pause"),
    ),
    (
        "next-action",
        ACTION_NEXT_ACTION_SET,
        {"work_id": "w1234abcd", "next_action": "resume"},
        events.next_action_set("w1234abcd", "resume"),
    ),
    (
        "checkpoint",
        ACTION_CHECKPOINT_RECORDED,
        {"work_id": "w1234abcd", "note": "checkpoint"},
        events.checkpoint_recorded("w1234abcd", "checkpoint"),
    ),
    (
        "decision",
        ACTION_DECISION_RECORDED,
        {
            "work_id": "w1234abcd",
            "decision": "continue",
            "decided_by": "reviewer",
        },
        events.decision_recorded("w1234abcd", "continue", "reviewer"),
    ),
    (
        "validation",
        ACTION_VALIDATION_RECORDED,
        {
            "work_id": "w1234abcd",
            "result": 1,
            "command": "check",
            "note": "failed",
        },
        events.validation_recorded("w1234abcd", 1, "check", "failed"),
    ),
    (
        "artifact",
        ACTION_ARTIFACT_RECORDED,
        {"work_id": "w1234abcd", "ref": "commit:abc", "kind": "commit"},
        events.artifact_recorded("w1234abcd", "commit:abc", "commit"),
    ),
    (
        "run-linked",
        ACTION_RUN_LINKED,
        {"work_id": "w1234abcd", "run_id": "run-1"},
        events.run_linked("w1234abcd", "run-1"),
    ),
]


def main() -> None:
    vectors = []
    with tempfile.TemporaryDirectory(prefix="kungfu-work-vectors-") as runtime_dir:
        for vector_id, action_type, event, legacy_payload in CASES:
            native = kungfu.__binding__.runtime.run_storage_service_operation(
                "action_runtime",
                runtime_dir,
                {
                    "action": "work_journal",
                    "mode": "encode",
                    "actionType": action_type,
                    "event": event,
                },
            )
            _carrier, legacy_envelope = wrap_event(action_type, legacy_payload)
            if bytes.fromhex(native["payloadHex"]) != legacy_payload:
                raise RuntimeError(f"{vector_id}: native payload differs from legacy")
            if bytes.fromhex(native["envelopeHex"]) != legacy_envelope:
                raise RuntimeError(f"{vector_id}: native envelope differs from legacy")
            if bytes.fromhex(native["recordRootPreimageHex"]) != record_root.preimage(
                legacy_envelope
            ):
                raise RuntimeError(
                    f"{vector_id}: native Root preimage differs from Python"
                )
            if native["recordRoot"] != record_root.root(legacy_envelope):
                raise RuntimeError(f"{vector_id}: native Root differs from Python")
            vectors.append(
                {
                    "id": vector_id,
                    "actionType": action_type,
                    "event": event,
                    "expected": {
                        "payloadHex": native["payloadHex"],
                        "envelopeHex": native["envelopeHex"],
                        "recordRootPreimageHex": native["recordRootPreimageHex"],
                        "recordRoot": native["recordRoot"],
                    },
                }
            )
        capabilities = kungfu.__binding__.runtime.run_storage_service_operation(
            "action_runtime",
            runtime_dir,
            {"action": "work_journal", "mode": "capabilities"},
        )

    document = {
        "schema": "kungfu.native-admission.vectors/v1",
        "subjectId": "kungfu.work-journal",
        "protocolId": capabilities["recordRootProtocol"],
        "schemaSourceRoot": capabilities["schemaSourceRoot"],
        "schemaBfbsRoot": capabilities["schemaBfbsRoot"],
        "compatibilityReader": "framework/core/src/python/kungfu/work/store.py",
        "independentImplementations": [
            "framework/core/src/libkungfu/src/runtime/action/work_journal.cpp",
            "framework/core/src/python/kungfu/work/events.py",
        ],
        "vectors": vectors,
    }
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    DESTINATION.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(DESTINATION.relative_to(ROOT))


if __name__ == "__main__":
    main()
