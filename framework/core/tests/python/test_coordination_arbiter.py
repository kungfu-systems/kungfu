#  SPDX-License-Identifier: Apache-2.0
#
# Unit tests for the arbiter lock table (ADR-0077 next increment). `LockTable`
# is the pure contention logic behind the journal-native arbiter; it depends
# only on the standard library, so these tests load it by file path and run
# without the native runtime binding — the same pattern as
# `test_coordination_locks.py`. The live journal wiring is exercised separately
# by the cross-process arbiter harness.

import importlib.util
from pathlib import Path

_ARBITER_PATH = (
    Path(__file__).resolve().parents[2]
    / "src"
    / "python"
    / "kungfu"
    / "coordination"
    / "arbiter.py"
)


def _load_arbiter():
    spec = importlib.util.spec_from_file_location("adr0077_arbiter", _ARBITER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


arbiter = _load_arbiter()
LockTable = arbiter.LockTable


def test_free_lock_is_granted_immediately():
    table = LockTable()
    assert table.request("L", 1) == 1
    assert table.holder("L") == 1
    assert table.waiters("L") == []


def test_second_requester_is_queued_not_granted():
    table = LockTable()
    assert table.request("L", 1) == 1
    assert table.request("L", 2) is None
    assert table.holder("L") == 1
    assert table.waiters("L") == [2]


def test_release_grants_next_waiter_fifo():
    table = LockTable()
    table.request("L", 1)
    table.request("L", 2)
    table.request("L", 3)
    assert table.waiters("L") == [2, 3]
    # Holder releases -> lock passes to the FIFO head, others stay queued.
    assert table.release("L", 1) == 2
    assert table.holder("L") == 2
    assert table.waiters("L") == [3]
    assert table.release("L", 2) == 3
    assert table.holder("L") == 3
    assert table.waiters("L") == []


def test_release_of_last_holder_frees_lock():
    table = LockTable()
    table.request("L", 1)
    assert table.release("L", 1) is None
    assert table.holder("L") is None
    # Freed lock is grantable again to a fresh requester.
    assert table.request("L", 9) == 9
    assert table.holder("L") == 9


def test_reentrant_request_regrants_without_enqueue():
    table = LockTable()
    assert table.request("L", 1) == 1
    # The holder re-requesting (e.g. it missed the grant frame) is re-granted
    # and must not enqueue itself as its own waiter.
    assert table.request("L", 1) == 1
    assert table.waiters("L") == []


def test_duplicate_wait_is_idempotent():
    table = LockTable()
    table.request("L", 1)
    assert table.request("L", 2) is None
    assert table.request("L", 2) is None
    assert table.waiters("L") == [2]


def test_release_by_non_holder_cancels_pending_wait():
    table = LockTable()
    table.request("L", 1)
    table.request("L", 2)
    table.request("L", 3)
    # A queued waiter withdraws; the holder and the rest of the queue are intact.
    assert table.release("L", 2) is None
    assert table.holder("L") == 1
    assert table.waiters("L") == [3]


def test_release_by_stranger_is_noop():
    table = LockTable()
    table.request("L", 1)
    assert table.release("L", 42) is None
    assert table.holder("L") == 1


def test_forget_reassigns_held_lock_to_next_waiter():
    table = LockTable()
    table.request("L", 1)
    table.request("L", 2)
    transitions = table.forget(1)
    assert transitions == [("L", 2)]
    assert table.holder("L") == 2


def test_forget_frees_held_lock_with_no_waiters():
    table = LockTable()
    table.request("L", 1)
    assert table.forget(1) == [("L", None)]
    assert table.holder("L") is None


def test_forget_removes_uid_from_other_waiter_queues():
    table = LockTable()
    table.request("A", 1)
    table.request("A", 2)  # 2 waits on A
    table.request("B", 2)  # 2 holds B
    # 2 dies: it must be dropped from A's queue AND B handed off / freed.
    transitions = dict(table.forget(2))
    assert transitions == {"B": None}
    assert table.waiters("A") == []
    assert table.holder("A") == 1
    assert table.holder("B") is None


def test_forget_holder_with_multiple_locks():
    table = LockTable()
    table.request("A", 1)
    table.request("A", 2)
    table.request("B", 1)
    transitions = dict(table.forget(1))
    assert transitions == {"A": 2, "B": None}
    assert table.holder("A") == 2
    assert table.holder("B") is None


def test_independent_locks_do_not_interfere():
    table = LockTable()
    assert table.request("A", 1) == 1
    assert table.request("B", 2) == 2
    assert table.request("A", 3) is None
    assert table.snapshot() == {
        "A": {"holder": 1, "waiters": [3]},
        "B": {"holder": 2, "waiters": []},
    }


def test_payload_helpers_roundtrip():
    assert arbiter.parse_name(arbiter.request_payload("L")) == "L"
    assert arbiter.parse_name(arbiter.grant_payload("L", 7)) == "L"
    assert arbiter.parse_name(b"not json") is None
    assert arbiter.parse_name(b"[1,2,3]") is None


if __name__ == "__main__":
    import sys

    failures = 0
    for entry in sorted(dict(globals()).items()):
        entry_name, fn = entry
        if entry_name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {entry_name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {entry_name}: {exc}")
    sys.exit(1 if failures else 0)
