# SPDX-License-Identifier: Apache-2.0
#
# KF-ADR-019f86da-4f90-7499-9152-520599d089ae Decision 3 equivalence net for
# generic native frame buffers and rewind bundle decoding.

from __future__ import annotations

import pytest

import kungfu
from kungfu.rewind import ACTION_TYPE_NAMES
from kungfu.rewind import replay as rewind_replay
from kungfu.rewind import reporting as rewind_reporting

yjj = kungfu.__binding__.runtime


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


def test_frame_header_exposes_readonly_buffer(captured_run):
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
