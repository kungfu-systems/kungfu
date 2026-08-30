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
    "test_fact_kernel_ref_cas_durable_admission_closes_and_reconciles",
    "test_release_provenance_ref_defaults_to_production_durable_sync",
    "test_non_provenance_ref_preserves_explicit_durability_boundary",
    "test_fact_kernel_ref_cas_rejects_unqualified_durability_before_write",
    "test_fact_kernel_ref_cas_rejects_buffered_rocks_provider_before_write",
    "test_fact_kernel_qualification_faults_are_not_request_enabled",
    "test_fact_kernel_ref_cas_durable_fault_frontier",
]


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
