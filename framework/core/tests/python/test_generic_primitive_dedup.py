# SPDX-License-Identifier: Apache-2.0
#
# ADR-0078 Decision 3 equivalence net. The outer rings (kungfu.atlas.store
# checksums, kungfu.rewind.replay bundle decode) now call the generic C++
# primitives instead of re-implementing them. These tests pin the migration:
# the native-backed paths must reproduce, byte for byte and field for field,
# what the removed hand-rolled Python produced.

from __future__ import annotations

import struct

import pytest

import kungfu
from kungfu.atlas import payloads
from kungfu.atlas import store as atlas_store
from kungfu.rewind import ACTION_TYPE_NAMES
from kungfu.rewind import replay as rewind_replay
from kungfu.rewind import reporting as rewind_reporting

yjj = kungfu.__binding__.runtime


# --- Reference (pre-ADR-0078) hand-rolled checksum, kept only for this net. ---


def _ref_fnv1a64_update(state, data):
    for value in bytes(data):
        state ^= value
        state = (state * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return state


def _ref_crc32c_table():
    table = []
    for i in range(256):
        crc = i
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
        table.append(crc & 0xFFFFFFFF)
    return table


_REF_CRC32C_TABLE = _ref_crc32c_table()


def _ref_crc32c_update(state, data):
    for value in bytes(data):
        state = (state >> 8) ^ _REF_CRC32C_TABLE[(state ^ value) & 0xFF]
    return state & 0xFFFFFFFF


def _ref_checksum_payload(data, algorithm):
    if algorithm == payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C:
        return _ref_crc32c_update(0xFFFFFFFF, data) ^ 0xFFFFFFFF
    return _ref_fnv1a64_update(14695981039346656037, data)


def _ref_pack_scalar(fmt, value):
    return struct.pack("<" + fmt, value)


def _ref_frame_data_type_value(header):
    value = getattr(header, "data_type", 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        name = str(value).split(".")[-1].lower()
        return 0 if name == "raw" else str(value)


def _ref_checksum_frame(header, data, payload_length, algorithm):
    fields = [
        ("I", int(getattr(header, "length", 0))),
        ("I", int(getattr(header, "header_length", 0))),
        ("q", int(header.gen_time)),
        ("q", int(header.trigger_time)),
        ("i", int(header.carrier_type)),
        ("I", int(header.source)),
        ("I", int(header.dest)),
        ("b", int(_ref_frame_data_type_value(header))),
        ("I", int(header.initial_source)),
        ("Q", int(header.journal_frame_uid)),
        ("Q", int(header.trigger_frame_uid)),
        ("Q", int(header.stream_id)),
        ("I", int(payload_length)),
    ]
    if algorithm == payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C:
        state = 0xFFFFFFFF
        for fmt, value in fields:
            state = _ref_crc32c_update(state, _ref_pack_scalar(fmt, value))
        return _ref_crc32c_update(state, data[:payload_length]) ^ 0xFFFFFFFF
    state = 14695981039346656037
    for fmt, value in fields:
        state = _ref_fnv1a64_update(state, _ref_pack_scalar(fmt, value))
    return _ref_fnv1a64_update(state, data[:payload_length])


# --- Fixtures. ---


@pytest.fixture
def captured_run(tmp_path):
    """A rewind run spanning every enum and both present/absent string fields."""
    runtime_dir = str(tmp_path / "runtime")
    run_id = "dedup-equivalence"
    rewind_reporting.begin_run(
        runtime_dir,
        run_id=run_id,
        provider="anthropic",
        cwd="/tmp/work",
        work_id="w-1",
    )
    # CostSnapshot: CaptureLayer + Attribution enums, a float, present strings
    # (provider/surface/source/model/session_id) and absent ones (raw_ref).
    rewind_reporting.report_cost(
        runtime_dir,
        run_id=run_id,
        provider="anthropic",
        surface="cli",
        source="adapter",
        attribution="exact_run",
        model="claude-opus-4-8",
        session_id="s-1",
        input_tokens=100,
        output_tokens=42,
        cost_usd=0.25,
    )
    # ApprovalDecision: Decision enum, present decided_by/detail and absent
    # request_id/surface/reason.
    rewind_reporting.report_approval(
        runtime_dir,
        run_id=run_id,
        decision="approve",
        decided_by="keren",
        detail="looks good",
    )
    rewind_reporting.end_run(
        runtime_dir, run_id=run_id, status="succeeded", exit_code=0
    )
    return runtime_dir, run_id, rewind_reporting.bundle_dir(runtime_dir, run_id)


# --- atlas checksum de-dup: native path reproduces the reference values. ---


@pytest.mark.parametrize(
    "algorithm",
    [
        payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C,
        payloads.FRAME_CHECKSUM_ALGORITHM_FNV1A64,
    ],
)
def test_atlas_checksum_matches_reference(captured_run, algorithm):
    runtime_dir, run_id, _ = captured_run
    frames = rewind_replay.read_frames(runtime_dir, run_id)
    assert frames, "expected recorded frames to checksum against"

    payloads_seen = [b"", b"\x00", b"payload-bytes-\xff\x01\x02", bytes(range(64))]
    checked = 0
    for _action_type, header, _event_payload in frames:
        for data in payloads_seen:
            # payload_length may be shorter than the buffer, exactly as the
            # atlas store slices it before checksumming.
            for payload_length in {0, len(data), max(0, len(data) - 3)}:
                assert atlas_store._checksum_payload(
                    data[:payload_length], algorithm
                ) == _ref_checksum_payload(data[:payload_length], algorithm)
                assert atlas_store._checksum_frame(
                    header, data, payload_length, algorithm
                ) == _ref_checksum_frame(header, data, payload_length, algorithm)
                checked += 1
    assert checked > 0


def test_atlas_checksum_frame_uses_readonly_header_buffer(captured_run):
    """The frame_header buffer is exposed read-only (checksum never writes it)."""
    runtime_dir, run_id, _ = captured_run
    _action_type, header, _payload = rewind_replay.read_frames(runtime_dir, run_id)[0]
    view = memoryview(header)
    assert view.readonly is True
    assert len(view) == header.__sizeof__()
    with pytest.raises((TypeError, ValueError)):
        view[0] = 0


# --- rewind decode de-dup: native bundle decode matches the generated oracle. ---


def test_rewind_bundle_decode_matches_generated(captured_run):
    runtime_dir, run_id, bundle_dir = captured_run
    count, differences = rewind_replay.verify(runtime_dir, run_id, bundle_dir)
    assert count == 4
    assert differences == []


def test_rewind_bundle_decode_field_by_field(captured_run):
    runtime_dir, run_id, bundle_dir = captured_run
    decoder = rewind_replay.BundleDecoder(bundle_dir)
    frames = rewind_replay.read_frames(runtime_dir, run_id)

    saw_enum_int = False
    saw_absent_none = False
    for action_type, _header, payload in frames:
        native = rewind_replay.decode_native(action_type, payload)
        bundle = decoder.decode(action_type, payload)
        # Field-by-field equivalence against the generated-accessor oracle,
        # i.e. the exact contract the removed Python reflection produced.
        assert bundle == native, action_type
        name = ACTION_TYPE_NAMES[action_type]
        if name == "RunEnd":
            # enum rendered as its underlying int, never the identifier string.
            assert bundle["status"] == 1
            assert isinstance(bundle["status"], int)
            saw_enum_int = True
        if name == "ApprovalDecision":
            assert bundle["decision"] == 0  # Approve
            assert isinstance(bundle["decision"], int)
            saw_enum_int = True
            # request_id was not supplied -> absent string decodes to None.
            assert bundle["request_id"] is None
            saw_absent_none = True
    assert saw_enum_int
    assert saw_absent_none
