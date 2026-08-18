# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
import hashlib
import json
import multiprocessing
import os
import struct
from pathlib import Path
import pytest


if importlib.util.find_spec("pykungfu") is None:
    pytest.skip("native pykungfu binding is not built", allow_module_level=True)

from kungfu.storage import service  # noqa: E402


CHARACTERIZATION = json.loads(
    (
        Path(__file__).parents[4]
        / "tests/fixtures/fact-kernel-characterization/v1.json"
    ).read_text(encoding="utf-8")
)
KFR2_CORPUS = json.loads(
    (
        Path(__file__).parents[4] / "tests/fixtures/fact-root-canonical/vectors.json"
    ).read_text(encoding="utf-8")
)


def _root(digit: str) -> str:
    return "sha256:" + digit * 64


def _legacy_atoms_root(atoms: list[str]) -> str:
    raw = struct.pack(">Q", len(atoms)) + b"".join(
        struct.pack(">Q", len(atom.encode())) + atom.encode() for atom in atoms
    )
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _accepted(response: dict) -> dict:
    assert response["ok"] is True, response
    assert response["status"] == "accepted", response
    assert response["write_occurred"] is True, response
    return response


def _concurrent_ref_cas_worker(
    runtime_dir: str,
    request: dict,
    ready_queue,
    start_event,
    result_queue,
) -> None:
    try:
        ready_queue.put(request["transition_id"])
        if not start_event.wait(timeout=15):
            raise TimeoutError("concurrent Fact CAS start signal was not released")
        result_queue.put(service.fact_kernel(runtime_dir, "ref-cas", request))
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {
                "ok": False,
                "worker_error": f"{type(error).__name__}: {error}",
                "transition_id": request["transition_id"],
            }
        )


def _fact_query_worker(runtime_dir: str, result_queue) -> None:
    try:
        result_queue.put(
            service.fact_kernel(
                runtime_dir,
                "query",
                {"include_inventory": True},
            )
        )
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {"ok": False, "worker_error": f"{type(error).__name__}: {error}"}
        )


def _durability_reconcile_worker(
    runtime_dir: str, operation_id: str, result_queue
) -> None:
    try:
        result_queue.put(
            service.fact_kernel(
                runtime_dir,
                "durability-reconcile",
                {"operation_id": operation_id},
            )
        )
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {"ok": False, "worker_error": f"{type(error).__name__}: {error}"}
        )


def _authority_import_recovery_worker(
    runtime_dir: str, bundle: dict, result_queue
) -> None:
    try:
        before = service.fact_kernel(runtime_dir, "query", {"include_inventory": True})
        fsck = service.fact_kernel_fsck(runtime_dir)
        retry = service.fact_kernel(
            runtime_dir, "authority-import", {"bundle": bundle, "execute": True}
        )
        exported = service.fact_kernel(runtime_dir, "authority-export")
        result_queue.put(
            {"before": before, "fsck": fsck, "retry": retry, "exported": exported}
        )
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {"ok": False, "worker_error": f"{type(error).__name__}: {error}"}
        )


def _collect_process_results(processes, result_queue, *, timeout: int = 30):
    """Drain Queue payloads before join so Windows feeder threads can exit."""
    try:
        results = [result_queue.get(timeout=timeout) for _ in processes]
        for process in processes:
            process.join(timeout=5)
        assert [process.exitcode for process in processes] == [0] * len(processes)
        return results
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
        for process in processes:
            process.join(timeout=5)


def _durable_fact_cut(runtime: Path) -> str:
    object_id = "fact:dddddddddddddddddddddddddddddddd"
    _accepted(
        service.fact_kernel(
            runtime,
            "object-put",
            {
                "object_id": object_id,
                "object_type": "durable-admission-characterization",
                "created_by_receipt_root": _root("1"),
            },
        )
    )
    initial_version = _accepted(
        service.fact_kernel(
            runtime,
            "version-put",
            {
                "object_id": object_id,
                "body": '{"durable":true}',
                "schema_root": _root("2"),
                "parent_version_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
            },
        )
    )
    initial_cut = _accepted(
        service.fact_kernel(
            runtime,
            "cut-put",
            {
                "parent_cut_roots": [],
                "object_versions": [
                    {
                        "object_id": object_id,
                        "version_root": initial_version["result"]["version_root"],
                    }
                ],
                "active_relation_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )["result"]["cut_root"]
    current_version = _accepted(
        service.fact_kernel(
            runtime,
            "version-put",
            {
                "object_id": object_id,
                "body": '{"durable":"transitive"}',
                "schema_root": _root("2"),
                "parent_version_roots": [initial_version["result"]["version_root"]],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
            },
        )
    )
    return _accepted(
        service.fact_kernel(
            runtime,
            "cut-put",
            {
                "parent_cut_roots": [initial_cut],
                "object_versions": [
                    {
                        "object_id": object_id,
                        "version_root": current_version["result"]["version_root"],
                    }
                ],
                "active_relation_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )["result"]["cut_root"]


def _durable_ref_request(
    cut_root: str,
    transition_id: str,
    *,
    requested_profile: str = "durable_sync",
    fault: str | None = None,
) -> dict:
    durability = {
        "requested_profile": requested_profile,
        "admission_profile": "fact-durable-admission/release-provenance-v1",
    }
    if fault is not None:
        durability["qualification_fault"] = {
            "schema": "kungfu.fact.durable-admission-fault/v1",
            "point": fault,
        }
    return {
        "transition_id": transition_id,
        "ref_name": f"facts/{transition_id}",
        "expected_old_cut_root": None,
        "expected_old_revision": 0,
        "new_cut_root": cut_root,
        "kind": "create",
        "reason_root": _root("5"),
        "durability": durability,
    }


@pytest.mark.parametrize("requested_profile", ["durable_group", "durable_sync"])
def test_fact_kernel_ref_cas_durable_admission_closes_and_reconciles(
    tmp_path, requested_profile
):
    runtime = tmp_path / "runtime"
    capability = service.fact_kernel(runtime, "capabilities")["durable_admission"]
    assert capability["profile"] == "fact-durable-admission/release-provenance-v1"
    assert capability["default_enabled"] is True
    assert capability["production_eligible"] is True
    assert capability["default_ref_prefix"] == "release-provenance/"
    assert capability["release_gate"] == "durability.contracts"
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(
        cut_root,
        f"durable-admission-success-{requested_profile}",
        requested_profile=requested_profile,
    )

    accepted = _accepted(service.fact_kernel(runtime, "ref-cas", request))
    durability = accepted["durability"]
    assert durability["requested_profile"] == requested_profile
    assert durability["admitted_profile"] == requested_profile
    assert durability["effective_profile"] == requested_profile
    assert durability["achieved_profile"] == requested_profile
    assert durability["content_provider"]["profile"] == "yijinjing-file/v1"
    assert durability["content_provider"]["durability"] == "fsync-on-publish"
    assert durability["evidence"]["production_eligible"] is True
    assert (
        durability["evidence"]["production_eligibility_scope"]
        == "release-provenance-fact-cut-authority"
    )
    assert durability["content_closure_root"].startswith("sha256:")
    assert durability["authority_bundle_root"].startswith("sha256:")
    assert durability["content_closure"]["target_cut_root"] == cut_root
    assert len(durability["content_closure"]["cut_roots"]) == 2
    assert len(durability["content_closure"]["version_roots"]) == 2
    assert len(durability["content_closure"]["body_roots"]) == 2
    assert (
        durability["journal_pair"]["record_sequence"] + 1
        == durability["journal_pair"]["receipt_sequence"]
    )
    assert (
        durability["journal_pair"]["record_root"]
        == accepted["result"]["transition_root"]
    )
    assert durability["journal_pair"]["receipt_root"] == accepted["receipt_root"]
    assert durability["journal_pair"]["durable_sync"]["directory_synced"] is (
        os.name != "nt"
    )
    assert durability["durability_receipt"]["status"] == "succeeded"
    operation_id = accepted["receipt"]["operationId"]
    durable_request_id = int(hashlib.sha256(operation_id.encode()).hexdigest()[:16], 16)
    legacy_request_id = int(operation_id.removeprefix("op:")[:16], 16)
    assert durability["durability_receipt"]["request_id"] == str(durable_request_id)
    assert durable_request_id != legacy_request_id

    replay = service.fact_kernel(runtime, "ref-cas", request)
    assert replay["ok"] is True, replay
    assert replay["status"] == "idempotent-durable-replay"
    assert replay["write_occurred"] is False
    assert replay["receipt"] == accepted["receipt"]

    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()
    verifier = context.Process(
        target=_durability_reconcile_worker,
        args=(str(runtime), accepted["receipt"]["operationId"], result_queue),
    )
    verifier.start()
    reconciled = _collect_process_results([verifier], result_queue)[0]
    assert reconciled["ok"] is True, reconciled
    assert reconciled["status"] == "reconciled"
    assert reconciled["receipt"] == accepted["receipt"]
    assert reconciled["durability"]["achieved_profile"] == requested_profile


def test_release_provenance_ref_defaults_to_production_durable_sync(tmp_path):
    runtime = tmp_path / "runtime"
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(cut_root, "alpha-2-production-default")
    request["ref_name"] = "release-provenance/v4.0.0-alpha.2"
    request.pop("durability")

    accepted = _accepted(service.fact_kernel(runtime, "ref-cas", request))

    assert accepted["durability"]["requested_profile"] == "durable_sync"
    assert (
        accepted["durability"]["admission_profile"]
        == "fact-durable-admission/release-provenance-v1"
    )
    assert accepted["durability"]["evidence"]["production_eligible"] is True


def test_non_provenance_ref_preserves_explicit_durability_boundary(tmp_path):
    runtime = tmp_path / "runtime"
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(cut_root, "ordinary-visible-ref")
    request.pop("durability")

    accepted = _accepted(service.fact_kernel(runtime, "ref-cas", request))

    assert "durability" not in accepted


def test_fact_kernel_ref_cas_rejects_unqualified_durability_before_write(tmp_path):
    runtime = tmp_path / "runtime"
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(cut_root, "durable-admission-unqualified")
    request["durability"]["admission_profile"] = "unqualified/future-profile"

    rejected = service.fact_kernel(runtime, "ref-cas", request)

    assert rejected["ok"] is False
    assert rejected["status"] == "rejected"
    assert rejected["failure_code"] == "durability-unqualified"
    assert rejected["write_occurred"] is False
    query = service.fact_kernel(runtime, "query", {"include_inventory": True})
    assert "facts/durable-admission-unqualified" not in query["refs"]
    assert query["inventory"]["transitions"] == {}


def test_fact_kernel_ref_cas_rejects_buffered_rocks_provider_before_write(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", "rocksdb")
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(cut_root, "durable-admission-rocks-buffered")

    rejected = service.fact_kernel(runtime, "ref-cas", request)

    assert rejected["ok"] is False
    assert rejected["failure_code"] == "durability-unqualified"
    assert rejected["write_occurred"] is False
    query = service.fact_kernel(runtime, "query", {"include_inventory": True})
    assert "facts/durable-admission-rocks-buffered" not in query["refs"]
    assert query["inventory"]["transitions"] == {}


def test_fact_kernel_qualification_faults_are_not_request_enabled(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("KUNGFU_FACT_QUALIFICATION_FAULTS", raising=False)
    runtime = tmp_path / "runtime"
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(
        cut_root,
        "durable-fault-production-gate",
        fault="before-journal-sync",
    )

    durable_rejected = service.fact_kernel(runtime, "ref-cas", request)
    import_rejected = service.fact_kernel(
        tmp_path / "import-target",
        "authority-import",
        {
            "qualification_fault": {
                "schema": "kungfu.fact-authority-import-fault/v1",
                "fail_after_logical_appends": 0,
            }
        },
    )

    for rejected in (durable_rejected, import_rejected):
        assert rejected["ok"] is False
        assert rejected["failure_code"] == "invalid-field"
        assert rejected["failure_category"] == "invalid-field"
        assert "KUNGFU_FACT_QUALIFICATION_FAULTS=1" in rejected["message"]
        assert rejected["write_occurred"] is False
    query = service.fact_kernel(runtime, "query", {"include_inventory": True})
    assert "facts/durable-fault-production-gate" not in query["refs"]
    assert (
        service.fact_kernel(runtime, "capabilities")["qualification_fault_gate"][
            "enabled"
        ]
        is False
    )


@pytest.mark.parametrize(
    ("fault", "expected_reconciled"),
    [
        ("before-journal-sync", False),
        ("after-journal-sync", False),
        ("before-record-write", False),
        ("after-record-write", False),
        ("before-data-sync", False),
        ("after-data-sync", False),
        ("before-checkpoint-write", False),
        ("before-checkpoint-rename", False),
        ("after-checkpoint-rename", True),
        ("before-directory-sync", True),
        ("after-directory-sync", True),
    ],
)
def test_fact_kernel_ref_cas_durable_fault_frontier(
    tmp_path, monkeypatch, fault, expected_reconciled
):
    monkeypatch.setenv("KUNGFU_FACT_QUALIFICATION_FAULTS", "1")
    runtime = tmp_path / fault
    cut_root = _durable_fact_cut(runtime)
    request = _durable_ref_request(cut_root, f"durable-fault-{fault}", fault=fault)

    interrupted = service.fact_kernel(runtime, "ref-cas", request)

    assert interrupted["ok"] is False
    assert interrupted["status"] == "unknown"
    assert interrupted["failure_code"] == "outcome-unknown"
    assert interrupted["failure_category"] == "backend-failure"
    assert interrupted["write_occurred"] is True
    operation_id = interrupted["operation_id"]
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()
    verifier = context.Process(
        target=_durability_reconcile_worker,
        args=(str(runtime), operation_id, result_queue),
    )
    verifier.start()
    reconciled = _collect_process_results([verifier], result_queue)[0]
    assert reconciled["ok"] is expected_reconciled, reconciled
    if expected_reconciled:
        assert reconciled["status"] == "reconciled"
        retry = service.fact_kernel(runtime, "ref-cas", request)
        assert retry["ok"] is True, retry
        assert retry["status"] == "idempotent-durable-replay"
    else:
        assert reconciled["status"] == "unknown"
        assert reconciled["failure_code"] == "outcome-unknown"
        assert reconciled["failure_category"] == "backend-failure"


def test_fact_kernel_v2_native_canonical_conformance(tmp_path):
    runtime = tmp_path / "runtime"
    for vector in KFR2_CORPUS["accepted"]:
        response = service.fact_kernel(
            runtime, "canonical-root", {"value": vector["value"]}
        )
        assert response["ok"] is True, vector["id"]
        assert response["canonical_bytes_hex"] == vector["canonicalBytesHex"], vector[
            "id"
        ]
        assert response["root"] == vector["root"], vector["id"]
    for vector in KFR2_CORPUS["rejected"]:
        response = service.fact_kernel(
            runtime, "canonical-root", {"value": vector["value"]}
        )
        assert response["ok"] is False, vector["id"]
        assert response["failure_code"] == vector["failureCode"], vector["id"]


def test_fact_kernel_v1_rejected_object_does_not_materialize_metadata(tmp_path):
    runtime = tmp_path / "runtime"
    object_id = "fact:00000000000000000000000000000001"
    _accepted(
        service.fact_kernel(
            runtime,
            "object-put",
            {
                "object_id": object_id,
                "object_type": "first-type",
                "created_by_receipt_root": _root("1"),
            },
        )
    )
    metadata_dir = runtime / "storage/fact-kernel-metadata"
    before = {
        path.relative_to(metadata_dir)
        for path in metadata_dir.rglob("*")
        if path.is_file()
    }

    rejected = service.fact_kernel(
        runtime,
        "object-put",
        {
            "object_id": object_id,
            "object_type": "conflicting-type",
            "created_by_receipt_root": _root("1"),
        },
    )
    after = {
        path.relative_to(metadata_dir)
        for path in metadata_dir.rglob("*")
        if path.is_file()
    }

    assert rejected["failure_code"] == "invalid-identity"
    assert rejected["write_occurred"] is False
    assert after == before


def test_fact_kernel_v1_rejects_unknown_request_fields_before_identity(tmp_path):
    runtime = tmp_path / "runtime"
    rejected = service.fact_kernel(
        runtime,
        "object-put",
        {
            "object_id": "fact:00000000000000000000000000000001",
            "object_type": "closed-request",
            "created_by_receipt_root": _root("1"),
            "future_extension": "must-not-be-ignored",
        },
    )

    assert rejected["failure_code"] == "invalid-field"
    assert rejected["failure_category"] == "invalid-field"
    assert rejected["write_occurred"] is False
    metadata_dir = runtime / "storage/fact-kernel-metadata"
    assert not metadata_dir.exists() or not any(metadata_dir.rglob("*"))


@pytest.mark.parametrize(
    ("action", "field"),
    [
        ("version-put", "parent_version_roots"),
        ("version-put", "declaration_roots"),
        ("version-put", "admission_roots"),
        ("relation-add", "admission_roots"),
        ("cut-put", "parent_cut_roots"),
        ("cut-put", "active_relation_roots"),
        ("cut-put", "declaration_roots"),
        ("cut-put", "admission_roots"),
        ("cut-put", "omission_roots"),
        ("cut-put", "conflict_roots"),
    ],
)
def test_fact_kernel_rejects_each_malformed_root_list_member(tmp_path, action, field):
    if action == "version-put":
        request = {
            "object_id": f"fact:{'1' * 32}",
            "body": "root-list-validation",
            "schema_root": _root("2"),
            "parent_version_roots": [],
            "declaration_roots": [_root("3")],
            "admission_roots": [_root("4")],
        }
    elif action == "relation-add":
        request = {
            "relation_id": f"fact:{'2' * 32}",
            "relation_type": "root-list-validation",
            "source": {"kind": "logical-object", "id": f"fact:{'3' * 32}"},
            "target": {"kind": "logical-object", "id": f"fact:{'4' * 32}"},
            "attributes_root": _root("5"),
            "admission_roots": [_root("6")],
        }
    else:
        request = {
            "parent_cut_roots": [],
            "object_versions": [],
            "active_relation_roots": [],
            "declaration_roots": [],
            "admission_roots": [],
            "episode_frontier": [],
            "omission_roots": [],
            "conflict_roots": [],
        }
    request[field] = ["not-a-content-root"]

    rejected = service.fact_kernel(tmp_path / field, action, request)

    assert rejected["failure_code"] == "invalid-field"
    assert rejected["failure_category"] == "invalid-field"
    assert f"{field}[0]" in rejected["message"]
    assert rejected["write_occurred"] is False


def test_fact_kernel_v1_exposes_stable_failure_taxonomy(tmp_path):
    runtime = tmp_path / "runtime"
    capabilities = service.fact_kernel(runtime, "capabilities")
    taxonomy = capabilities["failure_taxonomy"]
    assert taxonomy["automation_field"] == "failure_category"
    assert taxonomy["detail_field"] == "failure_code"
    assert taxonomy["categories"] == [
        "invalid-request",
        "invalid-action",
        "invalid-field",
        "invalid-identity",
        "stale-ref",
        "integrity-failure",
        "backend-failure",
    ]
    assert capabilities["qualification_fault_gate"] == {
        "kind": "environment",
        "variable": "KUNGFU_FACT_QUALIFICATION_FAULTS",
        "required_value": "1",
        "default_enabled": False,
        "enabled": False,
        "request_controlled": False,
    }
    assert capabilities["cas"]["contention"] == "serialized-stale-ref"
    assert capabilities["authority_import"] == {
        "batch_atomicity": "accepted-logical-append-prefix",
        "interruption": "truthful-prefix-restart-and-retry",
        "qualification_fault": "test-only-logical-append-boundary",
        "qualification_fault_gate_required": True,
    }

    wrong_type = service.fact_kernel(runtime, 7)  # type: ignore[arg-type]
    unknown = service.fact_kernel(runtime, "future-action")
    missing_field = service.fact_kernel(runtime, "object-put", {})
    invalid_identity = service.fact_kernel(
        runtime,
        "object-put",
        {
            "object_id": "not-a-fact-id",
            "object_type": "diagnostic",
            "created_by_receipt_root": _root("1"),
        },
    )

    assert (wrong_type["failure_code"], wrong_type["failure_category"]) == (
        "invalid-field",
        "invalid-field",
    )
    assert (unknown["failure_code"], unknown["failure_category"]) == (
        "invalid-action",
        "invalid-action",
    )
    assert (missing_field["failure_code"], missing_field["failure_category"]) == (
        "invalid-field",
        "invalid-field",
    )
    assert (
        invalid_identity["failure_code"],
        invalid_identity["failure_category"],
    ) == ("invalid-identity", "invalid-identity")
    assert all(
        response["write_occurred"] is False
        for response in (wrong_type, unknown, missing_field, invalid_identity)
    )


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


def test_fact_kernel_kfr2_writer_behavior_characterization(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    object_id = "fact:00000000000000000000000000000001"
    relation_id = "fact:00000000000000000000000000000002"

    capabilities = service.fact_kernel(source, "capabilities")
    assert capabilities["root_protocol"] == "kungfu.fact-root.canonical/v2"
    assert capabilities["writer_authority"]["downgrade_write"] == "fail-closed"

    object_request = {
        "object_id": object_id,
        "object_type": "characterization",
        "created_by_receipt_root": _root("1"),
    }
    object_put = _accepted(service.fact_kernel(source, "object-put", object_request))
    assert object_put["writer_protocol"] == "kungfu.fact-root.canonical/v2"
    assert object_put["root_mapping_receipt"]["legacyProtocol"] == (
        "sha256-length-framed-fields-v1"
    )
    assert (
        object_put["root_mapping_receipt"]["successorRoot"]
        == object_put["result"]["object_root"]
    )
    version_put = _accepted(
        service.fact_kernel(
            source,
            "version-put",
            {
                "object_id": object_id,
                "body": '{"value":"caf\u00e9"}',
                "schema_root": _root("2"),
                "parent_version_roots": [],
                "declaration_roots": [_root("4"), _root("3")],
                "admission_roots": [_root("6"), _root("5")],
            },
        )
    )
    relation_put = _accepted(
        service.fact_kernel(
            source,
            "relation-add",
            {
                "relation_id": relation_id,
                "relation_type": "characterizes",
                "source": {"kind": "logical-object", "id": object_id},
                "target": {
                    "kind": "pinned-version",
                    "id": version_put["result"]["version_root"],
                },
                "attributes_root": _root("7"),
                "admission_roots": [_root("8")],
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
                "admission_roots": [_root("5")],
                "episode_frontier": [
                    {
                        "episode_id": 7,
                        "sealed_content_root": _root("9"),
                        "accepted_manifest_frame_uid": "frame:characterization",
                    }
                ],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )
    ref_put = _accepted(
        service.fact_kernel(
            source,
            "ref-cas",
            {
                "transition_id": "characterization-create",
                "ref_name": "facts/characterization",
                "expected_old_cut_root": None,
                "expected_old_revision": 0,
                "new_cut_root": cut_put["result"]["cut_root"],
                "kind": "create",
                "reason_root": _root("a"),
            },
        )
    )

    replay = service.fact_kernel(source, "object-put", object_request)
    assert replay["status"] == "idempotent-replay"
    assert replay["write_occurred"] is False
    stale = service.fact_kernel(
        source,
        "ref-cas",
        {
            "transition_id": "characterization-stale",
            "ref_name": "facts/characterization",
            "expected_old_cut_root": None,
            "expected_old_revision": 0,
            "new_cut_root": cut_put["result"]["cut_root"],
            "kind": "advance",
            "reason_root": _root("b"),
        },
    )
    assert stale["failure_code"] == "expected-old-required"
    assert stale["failure_category"] == "stale-ref"
    assert stale["write_occurred"] is False
    invalid_relation = service.fact_kernel(
        source,
        "relation-add",
        {
            "relation_id": "fact:00000000000000000000000000000003",
            "relation_type": "invalid",
            "source": {"kind": "logical-object", "id": object_id},
            "target": {
                "kind": "logical-object",
                "id": "fact:ffffffffffffffffffffffffffffffff",
            },
            "attributes_root": _root("c"),
            "admission_roots": [_root("d")],
        },
    )
    assert invalid_relation["failure_code"] == "relation-endpoint-invalid"
    assert invalid_relation["failure_category"] == "invalid-identity"
    assert invalid_relation["write_occurred"] is False
    downgrade = service.fact_kernel(
        source,
        "object-put",
        {**object_request, "root_protocol": "sha256-length-framed-fields-v1"},
    )
    assert downgrade["failure_code"] == "invalid-field"
    assert downgrade["write_occurred"] is False

    revoke = _accepted(
        service.fact_kernel(
            source,
            "relation-revoke",
            {
                "relation_root": relation_put["result"]["relation_root"],
                "reason_root": _root("e"),
            },
        )
    )
    query = service.fact_kernel(
        source,
        "query",
        {"ref_name": "facts/characterization", "include_bodies": True},
    )
    assert query["ok"] is True
    assert query["objects"][0]["body"] == '{"value":"caf\u00e9"}'
    assert query["relations"][0]["relation"]["relationId"] == relation_id

    exported = service.fact_kernel(source, "authority-export")
    assert exported["ok"] is True
    bundle = exported["result"]["bundle"]
    assert bundle["schema"] == "kungfu.fact-authority-bundle/v2"
    assert {operation["rootProtocol"] for operation in bundle["operations"]} == {
        "kungfu.fact-root.canonical/v2"
    }
    planned = service.fact_kernel(destination, "authority-import", {"bundle": bundle})
    assert planned["status"] == "planned"
    assert planned["write_occurred"] is False
    imported = service.fact_kernel(
        destination, "authority-import", {"bundle": bundle, "execute": True}
    )
    assert imported["status"] == "imported"
    assert imported["result"]["record_roots_preserved"] is True
    destination_bundle = service.fact_kernel(destination, "authority-export")["result"][
        "bundle"
    ]
    assert destination_bundle["recordRoots"] == bundle["recordRoots"]
    assert destination_bundle["finalState"] == bundle["finalState"]

    snapshot = {
        "object_root": object_put["result"]["object_root"],
        "object_receipt_root": object_put["receipt_root"],
        "version_root": version_put["result"]["version_root"],
        "version_body_root": version_put["result"]["body_root"],
        "relation_root": relation_put["result"]["relation_root"],
        "cut_root": cut_put["result"]["cut_root"],
        "transition_root": ref_put["result"]["transition_root"],
        "revoke_root": revoke["result"]["revoke_root"],
        "bundle_root": bundle["bundleRoot"],
        "imported_bundle_root": destination_bundle["bundleRoot"],
        "record_roots": bundle["recordRoots"],
        "final_counts": bundle["finalState"]["counts"],
    }
    assert snapshot == CHARACTERIZATION["expected"]


def test_legacy_v1_bundle_replays_exactly_and_remains_readable(tmp_path):
    object_id = "fact:0000000000000000000000000000000f"
    request = {
        "action": "object-put",
        "object_id": object_id,
        "object_type": "legacy-reader-fixture",
        "created_by_receipt_root": _root("f"),
    }
    document = {
        "schema": "kungfu.fact.object/v1",
        "objectId": object_id,
        "objectType": request["object_type"],
        "createdByReceiptRoot": request["created_by_receipt_root"],
    }
    record_root = _legacy_atoms_root(
        [
            "kungfu.fact.object/v1",
            *(
                _canonical_json(document[field])
                for field in (
                    "schema",
                    "objectId",
                    "objectType",
                    "createdByReceiptRoot",
                )
            ),
        ]
    )
    bundle = {
        "schema": "kungfu.fact-authority-bundle/v1",
        "authority": "yijinjing-hana-pod-journal",
        "rootProtocol": "sha256-length-framed-fields-v1",
        "operations": [
            {
                "sequence": 1,
                "action": "object-put",
                "request": request,
                "recordRoot": record_root,
                "sourceReceiptRoot": _root("e"),
            }
        ],
        "recordRoots": [record_root],
        "finalState": {
            "refs": {},
            "counts": {
                "objects": 1,
                "versions": 0,
                "relations": 0,
                "revocations": 0,
                "cuts": 0,
                "transitions": 0,
            },
        },
    }
    bundle["bundleRoot"] = (
        "sha256:" + hashlib.sha256(_canonical_json(bundle).encode()).hexdigest()
    )

    imported = service.fact_kernel(
        tmp_path, "authority-import", {"bundle": bundle, "execute": True}
    )
    assert imported["ok"] is True, imported
    repeated = service.fact_kernel(
        tmp_path, "authority-import", {"bundle": bundle, "execute": True}
    )
    assert repeated["ok"] is True, repeated
    assert repeated["write_occurred"] is False
    exported = service.fact_kernel(tmp_path, "authority-export")["result"]["bundle"]
    assert exported["recordRoots"] == [record_root]
    assert exported["operations"][0]["rootProtocol"] == (
        "sha256-length-framed-fields-v1"
    )
    inventory = service.fact_kernel(tmp_path, "query", {"include_inventory": True})[
        "inventory"
    ]
    assert inventory["objects"][object_id]["objectType"] == "legacy-reader-fixture"
