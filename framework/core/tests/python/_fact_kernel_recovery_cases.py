# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

from __future__ import annotations

import multiprocessing
import os

from _fact_kernel_characterization_support import (
    CHARACTERIZATION,
    KFR2_CORPUS,
    Path,
    _accepted,
    _authority_import_recovery_worker,
    _canonical_json,
    _collect_process_results,
    _concurrent_ref_cas_worker,
    _durability_reconcile_worker,
    _durable_fact_cut,
    _durable_ref_request,
    _fact_query_worker,
    _legacy_atoms_root,
    _root,
    hashlib,
    json,
    pytest,
    service,
    struct,
)

__all__ = [
    "test_fact_kernel_ref_cas_converges_under_multiprocess_contention",
    "test_fact_kernel_v1_authority_import_fault_recovers_at_every_append_boundary",
]


def test_fact_kernel_ref_cas_converges_under_multiprocess_contention(tmp_path):
    runtime = tmp_path / "runtime"
    initial_cut = _accepted(
        service.fact_kernel(
            runtime,
            "cut-put",
            {
                "parent_cut_roots": [],
                "object_versions": [],
                "active_relation_roots": [],
                "declaration_roots": [],
                "admission_roots": [],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )["result"]["cut_root"]
    candidate_cuts = [
        _accepted(
            service.fact_kernel(
                runtime,
                "cut-put",
                {
                    "parent_cut_roots": [initial_cut],
                    "object_versions": [],
                    "active_relation_roots": [],
                    "declaration_roots": [],
                    "admission_roots": [],
                    "episode_frontier": [],
                    "omission_roots": [],
                    "conflict_roots": [_root(digit)],
                },
            )
        )["result"]["cut_root"]
        for digit in "234567"
    ]
    _accepted(
        service.fact_kernel(
            runtime,
            "ref-cas",
            {
                "transition_id": "multiprocess-cas-create",
                "ref_name": "facts/multiprocess-cas",
                "expected_old_cut_root": None,
                "expected_old_revision": 0,
                "new_cut_root": initial_cut,
                "kind": "create",
                "reason_root": _root("8"),
            },
        )
    )
    before_query = service.fact_kernel(runtime, "query", {"include_inventory": True})
    before_bundle = service.fact_kernel(runtime, "authority-export")["result"]["bundle"]

    context = multiprocessing.get_context("spawn")
    ready_queue = context.Queue()
    result_queue = context.Queue()
    start_event = context.Event()
    requests = [
        {
            "transition_id": f"multiprocess-cas-contender-{index}",
            "ref_name": "facts/multiprocess-cas",
            "expected_old_cut_root": initial_cut,
            "expected_old_revision": 1,
            "new_cut_root": cut_root,
            "kind": "advance",
            "reason_root": _root("9"),
        }
        for index, cut_root in enumerate(candidate_cuts)
    ]
    processes = [
        context.Process(
            target=_concurrent_ref_cas_worker,
            args=(str(runtime), request, ready_queue, start_event, result_queue),
        )
        for request in requests
    ]
    for process in processes:
        process.start()
    assert {ready_queue.get(timeout=15) for _ in processes} == {
        request["transition_id"] for request in requests
    }
    start_event.set()
    responses = _collect_process_results(processes, result_queue)
    assert not [response for response in responses if "worker_error" in response]
    winners = [response for response in responses if response.get("ok") is True]
    losers = [response for response in responses if response.get("ok") is False]
    assert len(winners) == 1, responses
    assert len(losers) == len(processes) - 1, responses
    assert {
        (response["failure_category"], response["failure_code"]) for response in losers
    } == {("stale-ref", "stale-ref")}
    assert all(response["write_occurred"] is False for response in losers)

    verifier_queue = context.Queue()
    verifier = context.Process(
        target=_fact_query_worker, args=(str(runtime), verifier_queue)
    )
    verifier.start()
    replayed = _collect_process_results([verifier], verifier_queue)[0]
    assert replayed["ok"] is True, replayed

    after_bundle = service.fact_kernel(runtime, "authority-export")["result"]["bundle"]
    before_inventory = before_query["inventory"]
    after_inventory = replayed["inventory"]
    winner = winners[0]
    winner_result = winner["result"]
    winner_receipt = winner["receipt"]
    resolved = replayed["refs"]["facts/multiprocess-cas"]
    assert resolved["cut_root"] == winner_result["current_cut_root"]
    assert resolved["cut_root"] == winner_receipt["currentCutRoot"]
    assert resolved["revision"] == winner_result["current_revision"] == 2
    assert (
        len(after_inventory["transitions"]) == len(before_inventory["transitions"]) + 1
    )
    assert len(after_inventory["receipts"]) == len(before_inventory["receipts"]) + 1
    assert set(after_inventory["transitions"]) - set(
        before_inventory["transitions"]
    ) == {winner_result["transition_id"]}
    assert len(after_bundle["recordRoots"]) == len(before_bundle["recordRoots"]) + 1


def test_fact_kernel_v1_authority_import_fault_recovers_at_every_append_boundary(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("KUNGFU_FACT_QUALIFICATION_FAULTS", "1")
    source = tmp_path / "source"
    object_id = "fact:10000000000000000000000000000001"
    relation_id = "fact:10000000000000000000000000000002"
    _accepted(
        service.fact_kernel(
            source,
            "object-put",
            {
                "object_id": object_id,
                "object_type": "import-fault-qualification",
                "created_by_receipt_root": _root("1"),
            },
        )
    )
    version_put = _accepted(
        service.fact_kernel(
            source,
            "version-put",
            {
                "object_id": object_id,
                "body": '{"fault":"recoverable"}',
                "schema_root": _root("2"),
                "parent_version_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
            },
        )
    )
    relation_put = _accepted(
        service.fact_kernel(
            source,
            "relation-add",
            {
                "relation_id": relation_id,
                "relation_type": "qualifies-recovery",
                "source": {"kind": "logical-object", "id": object_id},
                "target": {
                    "kind": "pinned-version",
                    "id": version_put["result"]["version_root"],
                },
                "attributes_root": _root("5"),
                "admission_roots": [_root("6")],
            },
        )
    )
    cut_put = _accepted(
        service.fact_kernel(
            source,
            "cut-put",
            {
                "parent_cut_roots": [],
                "object_versions": [
                    {
                        "object_id": object_id,
                        "version_root": version_put["result"]["version_root"],
                    }
                ],
                "active_relation_roots": [relation_put["result"]["relation_root"]],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )
    _accepted(
        service.fact_kernel(
            source,
            "ref-cas",
            {
                "transition_id": "import-fault-qualification-create",
                "ref_name": "facts/import-fault-qualification",
                "expected_old_cut_root": None,
                "expected_old_revision": 0,
                "new_cut_root": cut_put["result"]["cut_root"],
                "kind": "create",
                "reason_root": _root("7"),
            },
        )
    )
    bundle = service.fact_kernel(source, "authority-export")["result"]["bundle"]
    record_roots = bundle["recordRoots"]
    assert len(record_roots) == 5

    context = multiprocessing.get_context("spawn")
    for fail_after in range(len(record_roots)):
        target = tmp_path / f"target-{fail_after}"
        interrupted = service.fact_kernel(
            target,
            "authority-import",
            {
                "bundle": bundle,
                "execute": True,
                "qualification_fault": {
                    "schema": "kungfu.fact-authority-import-fault/v1",
                    "fail_after_logical_appends": fail_after,
                },
            },
        )

        assert interrupted["ok"] is False
        assert (
            interrupted["failure_category"],
            interrupted["failure_code"],
        ) == (
            "backend-failure",
            "import-interrupted" if fail_after else "backend-failure",
        )
        assert interrupted["status"] == "interrupted"
        assert interrupted["write_occurred"] is (fail_after > 0)
        assert interrupted["details"]["next_operation_index"] == fail_after
        assert interrupted["details"]["completed_operation_count"] == fail_after
        assert (
            interrupted["details"]["remaining_operation_count"]
            == len(record_roots) - fail_after
        )
        assert (
            interrupted["details"]["committed_prefix_record_roots"]
            == record_roots[:fail_after]
        )
        assert (
            interrupted["details"]["observed_record_roots"] == record_roots[:fail_after]
        )
        receipt = interrupted["receipt"]
        assert receipt["schema"] == "kungfu.fact-authority-import-interruption/v1"
        assert receipt["bundleRoot"] == bundle["bundleRoot"]
        assert receipt["committedPrefixRecordRoots"] == record_roots[:fail_after]
        assert receipt["observedRecordRoots"] == record_roots[:fail_after]
        assert receipt["foldIssues"] == []
        assert receipt["recovery"] == "restart-and-retry-same-bundle"
        assert interrupted["receipt_root"] == receipt["receiptRoot"]

        result_queue = context.Queue()
        verifier = context.Process(
            target=_authority_import_recovery_worker,
            args=(str(target), bundle, result_queue),
        )
        verifier.start()
        recovered = _collect_process_results([verifier], result_queue)[0]
        assert "worker_error" not in recovered, recovered
        assert recovered["before"]["issues"] == []
        assert recovered["before"]["counts"]["unknown_records"] == 0
        assert recovered["fsck"]["ok"] is True, recovered["fsck"]
        assert recovered["retry"]["ok"] is True, recovered["retry"]
        assert recovered["retry"]["status"] == "imported"
        assert recovered["exported"]["ok"] is True
        recovered_bundle = recovered["exported"]["result"]["bundle"]
        assert recovered_bundle["recordRoots"] == record_roots
        assert recovered_bundle["finalState"] == bundle["finalState"]
