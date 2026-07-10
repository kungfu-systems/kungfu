# SPDX-License-Identifier: Apache-2.0
"""Independent model checks for Episode Qualification Semantic v1."""

from __future__ import annotations

from pathlib import Path
import sys

import pytest


QUALIFICATION_DIR = Path(__file__).resolve().parents[1] / "qualification" / "episode"
sys.path.insert(0, str(QUALIFICATION_DIR))

from semantic_oracle import (  # noqa: E402
    EpisodeOracle,
    Evidence,
    Lifecycle,
    exhaust_bounded_histories,
    repair_is_monotonic,
)


def test_open_missing_content_degrades_and_sealed_missing_content_fails():
    oracle = EpisodeOracle()
    oracle.begin()
    oracle.attach_payload("artifact", Evidence.MISSING)
    assert oracle.observe().status == "degraded"
    oracle.end()
    assert oracle.observe().status == "failed"


def test_repair_restores_useful_state_without_changing_episode_lifecycle():
    oracle = EpisodeOracle()
    oracle.begin()
    oracle.attach_payload("artifact", Evidence.MISSING)
    oracle.end()
    before = oracle.observe()
    oracle.restore_payload("artifact")
    after = oracle.observe()
    assert before.lifecycle == after.lifecycle == "ended"
    assert before.status == "failed"
    assert after.status == "ok"
    assert repair_is_monotonic(before, after)


def test_recovery_is_abort_and_idempotent():
    oracle = EpisodeOracle()
    oracle.begin()
    assert oracle.recover() is True
    assert oracle.lifecycle is Lifecycle.ABORTED
    assert oracle.recover() is False


def test_projection_is_derived_and_journal_change_marks_it_stale():
    oracle = EpisodeOracle()
    oracle.begin()
    oracle.rebuild_projection()
    assert oracle.projection == "current"
    oracle.end()
    assert oracle.projection == "stale"
    assert oracle.observe().status == "degraded"
    oracle.rebuild_projection()
    assert oracle.observe().status == "ok"


def test_bounded_payload_dependency_histories_preserve_core_invariants():
    assert exhaust_bounded_histories() == 48


def test_illegal_transitions_are_rejected_by_the_oracle():
    oracle = EpisodeOracle()
    with pytest.raises(ValueError, match="episode_not_open"):
        oracle.end()
    oracle.begin()
    oracle.end()
    with pytest.raises(ValueError, match="episode_not_open"):
        oracle.attach_payload("late", Evidence.PRESENT)
