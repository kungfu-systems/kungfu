# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

import kungfu
from kungfu.action_envelope import (
    CARRIER_ACTION_ENVELOPE,
    build_action_envelope,
    decode_action_envelope,
    decode_flatbuffer_payload,
    encode_action_envelope,
    flatbuffer_payload,
    parse_action_envelope_edge_json,
    render_action_envelope_edge_json,
)
from kungfu.rewind.wire import unwrap_event as unwrap_rewind_event
from kungfu.rewind.wire import wrap_event as wrap_rewind_event
from kungfu.rewind import replay as rewind_replay
from kungfu.rewind import reporting as rewind_reporting
from kungfu.rewind.export import export_run, open_export
from kungfu.storage import service as storage_service
from kungfu.work import (
    ACTION_ARTIFACT_RECORDED,
    ACTION_CHECKPOINT_RECORDED,
    ACTION_DECISION_RECORDED,
    ACTION_NEXT_ACTION_SET,
    ACTION_RUN_LINKED,
    ACTION_VALIDATION_RECORDED,
    ACTION_WORK_ITEM_CREATED,
    ACTION_WORK_STATUS_CHANGED,
    events as work_events,
)
from kungfu.work import store as work_store
from kungfu.work import record_root as work_record_root
from kungfu.work.store import WorkStore, load as load_work
from kungfu.work.wire import unwrap_event as unwrap_work_event
from kungfu.work.wire import wrap_event as wrap_work_event


def _fixture(payload: bytes = b"payload") -> dict:
    return build_action_envelope(
        action_type="rewind.model.response",
        schema_ref={"id": "kungfu.rewind.ModelResponse", "version": 3},
        actor={"id": "agent-1", "kind": "agent"},
        session={"run_id": "run-1"},
        source={"kind": "trace", "source_id": "source-1", "schema_version": 2},
        batch={"repo_head": "abc123", "goals": 2},
        payload=flatbuffer_payload(payload),
    )


def test_binary_action_envelope_roundtrip_uses_declared_identifier():
    encoded = encode_action_envelope(_fixture())
    assert encoded[:1] != b"{"
    assert encoded[4:8] == b"KFAE"

    decoded = decode_action_envelope(encoded)
    assert decoded is not None
    assert decoded["schema"] == "kungfu.action-envelope/v1"
    assert decoded["action_type"] == "rewind.model.response"
    assert decoded["schema_ref"] == {
        "id": "kungfu.rewind.ModelResponse",
        "version": 3,
    }
    assert decoded["actor"]["id"] == "agent-1"
    assert decoded["session"]["run_id"] == "run-1"
    assert decoded["source"]["schema_version"] == 2
    assert decoded["batch"]["goals"] == 2
    assert decode_flatbuffer_payload(decoded["payload"]) == b"payload"
    schema_path = Path(__file__).parents[2] / "src/libkungfu/schema/ActionEnvelope.bfbs"
    schema_bfbs = schema_path.read_bytes()
    runtime = kungfu.__binding__.runtime
    assert runtime.verify_flatbuffer_payload(schema_bfbs, encoded)
    assert not runtime.verify_flatbuffer_payload(schema_bfbs, encoded[:16])


def test_action_envelope_schema_artifact_and_additive_evolution():
    schema_dir = Path(__file__).parents[2] / "src/libkungfu/schema"
    fbs_text = (schema_dir / "ActionEnvelope.fbs").read_text()
    compiled, error = kungfu.__binding__.runtime.compile_schema(fbs_text, False)
    assert error == ""
    assert bytes(compiled) == (schema_dir / "ActionEnvelope.bfbs").read_bytes()

    encoded = encode_action_envelope(_fixture())
    evolved_text = fbs_text.replace(
        "  payload:Payload;\n}", "  payload:Payload;\n  extension:string;\n}"
    )
    evolved, error = kungfu.__binding__.runtime.compile_schema(evolved_text, False)
    assert error == ""
    assert kungfu.__binding__.runtime.verify_flatbuffer_payload(evolved, encoded)


def test_binary_action_envelope_rejects_corruption_and_hash_mismatch():
    encoded = bytearray(encode_action_envelope(_fixture()))
    encoded[encoded.index(b"payload")] ^= 0xFF
    assert decode_action_envelope(encoded) is None

    invalid = _fixture()
    invalid["payload"]["hash"] = "0" * 64
    with pytest.raises(ValueError, match="payload hash mismatch"):
        encode_action_envelope(invalid)


def test_json_is_an_explicit_verified_edge_projection_only():
    encoded = encode_action_envelope(_fixture())
    rendered = render_action_envelope_edge_json(encoded)
    edge = json.loads(rendered)

    assert edge["schema"] == "kungfu.action-envelope/v1"
    assert edge["payload"]["content_transfer_encoding"] == "base64"
    assert edge["payload"]["data"] == "cGF5bG9hZA=="
    assert parse_action_envelope_edge_json(rendered) == encoded

    edge["payload"]["data"] = "not-base64!"
    with pytest.raises(ValueError, match="base64"):
        parse_action_envelope_edge_json(json.dumps(edge))


@pytest.mark.parametrize(
    ("wrap", "unwrap", "action_type"),
    [
        (wrap_rewind_event, unwrap_rewind_event, "rewind.model.response"),
        (wrap_work_event, unwrap_work_event, "work.item.created"),
    ],
)
def test_first_party_wire_helpers_use_binary_envelope(wrap, unwrap, action_type):
    carrier_type, encoded = wrap(action_type, b"domain-fb")
    assert carrier_type == CARRIER_ACTION_ENVELOPE
    assert encoded[4:8] == b"KFAE"
    assert unwrap(encoded) == (action_type, b"domain-fb")


def test_cpp_action_recorder_writes_binary_raw_carrier(tmp_path):
    runtime = kungfu.__binding__.runtime
    yijinjing = kungfu.__binding__.yijinjing
    recorder = runtime.action_recorder(str(tmp_path), "action", "binary")
    receipt = recorder.record_action(_fixture())

    assert receipt.carrier_type == CARRIER_ACTION_ENVELOPE
    assert int(receipt.data_type) == 0
    location = runtime.location(
        yijinjing.enums.mode.LIVE,
        yijinjing.enums.location_role.SYSTEM,
        "action",
        "binary",
        runtime.locator(str(tmp_path)),
    )
    frames = list(runtime.assemble(location, 0).read_bytes(CARRIER_ACTION_ENVELOPE))
    assert len(frames) == 1
    decoded = decode_action_envelope(frames[0][1])
    assert decoded is not None
    assert decoded["action_type"] == "rewind.model.response"


@pytest.mark.parametrize(
    ("action_type", "event", "legacy_payload"),
    [
        (
            ACTION_WORK_ITEM_CREATED,
            {
                "work_id": "w1234abcd",
                "title": "native",
                "kind": "test",
                "summary": "parity",
                "schema_version": 1,
            },
            work_events.work_item_created("w1234abcd", "native", "test", "parity", 1),
        ),
        (
            ACTION_WORK_STATUS_CHANGED,
            {"work_id": "w1234abcd", "status": 1, "reason": "pause"},
            work_events.work_status_changed("w1234abcd", 1, "pause"),
        ),
        (
            ACTION_NEXT_ACTION_SET,
            {"work_id": "w1234abcd", "next_action": "resume"},
            work_events.next_action_set("w1234abcd", "resume"),
        ),
        (
            ACTION_CHECKPOINT_RECORDED,
            {"work_id": "w1234abcd", "note": "checkpoint"},
            work_events.checkpoint_recorded("w1234abcd", "checkpoint"),
        ),
        (
            ACTION_DECISION_RECORDED,
            {
                "work_id": "w1234abcd",
                "decision": "continue",
                "decided_by": "reviewer",
            },
            work_events.decision_recorded("w1234abcd", "continue", "reviewer"),
        ),
        (
            ACTION_VALIDATION_RECORDED,
            {
                "work_id": "w1234abcd",
                "result": 1,
                "command": "check",
                "note": "failed",
            },
            work_events.validation_recorded("w1234abcd", 1, "check", "failed"),
        ),
        (
            ACTION_ARTIFACT_RECORDED,
            {"work_id": "w1234abcd", "ref": "commit:abc", "kind": "commit"},
            work_events.artifact_recorded("w1234abcd", "commit:abc", "commit"),
        ),
        (
            ACTION_RUN_LINKED,
            {"work_id": "w1234abcd", "run_id": "run-1"},
            work_events.run_linked("w1234abcd", "run-1"),
        ),
    ],
)
def test_native_work_service_matches_legacy_event_and_envelope_bytes(
    tmp_path, action_type, event, legacy_payload
):
    native = kungfu.__binding__.runtime.run_storage_service_operation(
        "action_runtime",
        str(tmp_path),
        {
            "action": "work_journal",
            "mode": "encode",
            "actionType": action_type,
            "event": event,
        },
    )
    _carrier, legacy_envelope = wrap_work_event(action_type, legacy_payload)
    assert bytes.fromhex(native["payloadHex"]) == legacy_payload
    assert bytes.fromhex(native["envelopeHex"]) == legacy_envelope
    assert native["recordRoot"].startswith("sha256:")


def _legacy_work_payload(action_type, event):
    if action_type == ACTION_WORK_ITEM_CREATED:
        return work_events.work_item_created(
            event["work_id"],
            event["title"],
            event["kind"],
            event["summary"],
            event["schema_version"],
        )
    if action_type == ACTION_WORK_STATUS_CHANGED:
        return work_events.work_status_changed(
            event["work_id"], event["status"], event["reason"]
        )
    if action_type == ACTION_NEXT_ACTION_SET:
        return work_events.next_action_set(event["work_id"], event["next_action"])
    if action_type == ACTION_CHECKPOINT_RECORDED:
        return work_events.checkpoint_recorded(event["work_id"], event["note"])
    if action_type == ACTION_DECISION_RECORDED:
        return work_events.decision_recorded(
            event["work_id"], event["decision"], event["decided_by"]
        )
    if action_type == ACTION_VALIDATION_RECORDED:
        return work_events.validation_recorded(
            event["work_id"],
            event["result"],
            event["command"],
            event["note"],
        )
    if action_type == ACTION_ARTIFACT_RECORDED:
        return work_events.artifact_recorded(
            event["work_id"], event["ref"], event["kind"]
        )
    if action_type == ACTION_RUN_LINKED:
        return work_events.run_linked(event["work_id"], event["run_id"])
    raise AssertionError(f"unknown Work fixture action: {action_type}")


_WORK_GOLDEN = json.loads(
    (
        Path(__file__).parents[4]
        / "tests"
        / "fixtures"
        / "native-admission"
        / "work-journal-v1.json"
    ).read_text()
)


@pytest.mark.parametrize(
    "vector", _WORK_GOLDEN["vectors"], ids=lambda vector: vector["id"]
)
def test_work_native_admission_golden_replay(tmp_path, vector):
    action_type = vector["actionType"]
    event = vector["event"]
    expected = vector["expected"]
    native = kungfu.__binding__.runtime.run_storage_service_operation(
        "action_runtime",
        str(tmp_path),
        {
            "action": "work_journal",
            "mode": "encode",
            "actionType": action_type,
            "event": event,
        },
    )
    legacy_payload = _legacy_work_payload(action_type, event)
    _carrier, legacy_envelope = wrap_work_event(action_type, legacy_payload)
    assert native["payloadHex"] == expected["payloadHex"] == legacy_payload.hex()
    assert native["envelopeHex"] == expected["envelopeHex"] == legacy_envelope.hex()
    assert native["recordRootPreimageHex"] == expected["recordRootPreimageHex"]
    assert (
        native["recordRoot"]
        == expected["recordRoot"]
        == work_record_root.root(legacy_envelope)
    )
    assert bytes.fromhex(expected["recordRootPreimageHex"]) == (
        work_record_root.preimage(legacy_envelope)
    )
    assert unwrap_work_event(legacy_envelope) == (action_type, legacy_payload)


@pytest.mark.parametrize(
    "operation_request",
    [
        {
            "action": "work_journal",
            "mode": "append",
            "actionType": ACTION_WORK_ITEM_CREATED,
            "event": {
                "work_id": "w1234abcd",
                "schema_version": 1,
                "unknown": "must fail",
            },
        },
        {
            "action": "work_journal",
            "mode": "append",
            "actionType": ACTION_WORK_STATUS_CHANGED,
            "event": {"work_id": "w1234abcd", "status": 99},
        },
        {
            "action": "work_journal",
            "mode": "append",
            "actionType": "work.unknown",
            "event": {"work_id": "w1234abcd"},
        },
    ],
)
def test_native_work_append_fails_before_writing_invalid_events(
    tmp_path, operation_request
):
    with pytest.raises((RuntimeError, ValueError)):
        kungfu.__binding__.runtime.run_storage_service_operation(
            "action_runtime", str(tmp_path), operation_request
        )
    assert not (tmp_path / "journal" / "system" / "work" / "items").exists()


def test_native_work_batch_validates_every_event_before_writing(tmp_path):
    valid = _WORK_GOLDEN["vectors"][0]
    invalid = _WORK_GOLDEN["vectors"][1]
    with pytest.raises((RuntimeError, ValueError), match="genTime"):
        kungfu.__binding__.runtime.run_storage_service_operation(
            "action_runtime",
            str(tmp_path),
            {
                "action": "work_journal",
                "mode": "append_batch",
                "events": [
                    {
                        "actionType": valid["actionType"],
                        "event": valid["event"],
                    },
                    {
                        "actionType": invalid["actionType"],
                        "event": invalid["event"],
                        "genTime": "invalid",
                    },
                ],
            },
        )
    assert not (tmp_path / "journal" / "system" / "work" / "items").exists()


def test_native_work_append_publishes_authority_before_writing(tmp_path):
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "store").write_text("path conflict")
    with pytest.raises(RuntimeError):
        WorkStore(str(tmp_path)).create("must not write", "test", "manifest failure")
    assert not (tmp_path / "journal" / "system" / "work" / "items").exists()


def test_native_work_append_rejects_corrupt_content_addressed_schema(tmp_path):
    store = WorkStore(str(tmp_path))
    manifest_path = Path(store.emit_manifest())
    manifest = json.loads(manifest_path.read_text())
    schema_hash = manifest["schema_bindings"][ACTION_WORK_ITEM_CREATED]["schema_hash"]
    (manifest_path.parent / "schemas" / f"{schema_hash}.bfbs").write_bytes(b"corrupt")
    with pytest.raises(RuntimeError, match="do not match their content address"):
        store.create("must not write", "test", "schema corruption")
    assert not (tmp_path / "journal" / "system" / "work" / "items").exists()


def test_work_store_uses_native_work_service_and_binary_fold(tmp_path):
    store = WorkStore(str(tmp_path))
    work_id = store.create("typed envelope", "test", "native recorder")
    store.checkpoint(work_id, "binary")

    item = load_work(str(tmp_path))[work_id]
    assert item["title"] == "typed envelope"
    assert item["checkpoints"][0]["note"] == "binary"
    replay = kungfu.__binding__.runtime.run_storage_service_operation(
        "action_runtime",
        str(tmp_path),
        {"action": "work_journal", "mode": "replay"},
    )
    assert [event["actionType"] for event in replay["events"]] == [
        ACTION_WORK_ITEM_CREATED,
        ACTION_CHECKPOINT_RECORDED,
    ]
    manifest = json.loads((tmp_path / "work" / "store" / "manifest.json").read_text())
    schema_hash = manifest["schema_bindings"][ACTION_WORK_ITEM_CREATED]["schema_hash"]
    assert f"sha256:{schema_hash}" == _WORK_GOLDEN["schemaBfbsRoot"]
    assert (tmp_path / "work" / "store" / "schemas" / f"{schema_hash}.bfbs").exists()


def test_work_store_empty_runtime_does_not_open_a_missing_native_journal(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        work_store.yjj,
        "assemble",
        lambda *_args, **_kwargs: pytest.fail("native reader should not open"),
    )
    assert load_work(str(tmp_path)) == {}


def test_work_store_surfaces_corrupt_native_frames(tmp_path):
    kungfu.__binding__.runtime.action_recorder(
        str(tmp_path), "work", "items"
    ).record_bytes(CARRIER_ACTION_ENVELOPE, b"corrupt")
    with pytest.raises(RuntimeError, match="cannot decode Agent Work action envelope"):
        load_work(str(tmp_path))


def test_work_store_portable_import_replays_only_the_missing_prefix(tmp_path):
    target = {
        "workId": "w1234abcd",
        "title": "portable",
        "kind": "test",
        "summary": "verified prefix",
        "status": "waiting",
        "nextAction": "resume",
        "checkpoints": [{"note": "checkpoint"}],
        "decisions": [{"decision": "continue", "decidedBy": "reviewer"}],
        "validations": [{"result": "pass", "command": "check", "note": None}],
        "artifacts": [{"ref": "commit:abc", "kind": "commit"}],
        "runs": [{"runId": "run-1"}],
    }
    store = WorkStore(str(tmp_path))
    assert store.import_portable_item(None, target) == 8
    item = load_work(str(tmp_path))[target["workId"]]
    assert item["title"] == "portable"
    assert item["status"] == "waiting"
    assert item["next_action"] == "resume"
    assert item["checkpoints"][0]["note"] == "checkpoint"
    assert item["decisions"][0]["decision"] == "continue"
    assert item["validations"][0]["result"] == "pass"
    assert item["artifacts"][0]["ref"] == "commit:abc"
    assert item["runs"][0]["run_id"] == "run-1"
    replay = kungfu.__binding__.runtime.run_storage_service_operation(
        "action_runtime",
        str(tmp_path),
        {"action": "work_journal", "mode": "replay"},
    )
    assert len(replay["events"]) == 8
    for previous, current in zip(replay["events"], replay["events"][1:]):
        assert current["triggerFrameUid"] == previous["frameUid"]
    assert store.import_portable_item(item, target) == 0


def test_rewind_replay_export_and_fsck_accept_binary_envelopes(tmp_path):
    runtime_dir = str(tmp_path / "runtime")
    run_id = "binary-rewind"
    rewind_reporting.begin_run(
        runtime_dir,
        run_id=run_id,
        provider="test",
        cwd=None,
        work_id=None,
    )
    rewind_reporting.end_run(
        runtime_dir,
        run_id=run_id,
        status="succeeded",
        exit_code=0,
    )

    count, differences = rewind_replay.verify(
        runtime_dir,
        run_id,
        rewind_reporting.bundle_dir(runtime_dir, run_id),
    )
    assert count == 2
    assert differences == []

    episodes = storage_service.episode_list(runtime_dir)["episodes"]
    episode = next(
        row for row in episodes if row["open"]["source"] == f"rewind:{run_id}"
    )
    report = storage_service.fsck(
        runtime_dir, episode_id=int(episode["episode_id"]), verify_frames=True
    )
    assert report["ok"] is True

    archive = export_run(runtime_dir, run_id, str(tmp_path / "run.rewind.zip"))
    opened_run_id, opened_runtime = open_export(archive, str(tmp_path / "opened"))
    opened_count, opened_differences = rewind_replay.verify(
        opened_runtime,
        opened_run_id,
        rewind_reporting.bundle_dir(opened_runtime, opened_run_id),
    )
    assert opened_count == 2
    assert opened_differences == []
