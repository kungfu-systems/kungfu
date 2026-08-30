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
    "test_fact_kernel_v2_native_canonical_conformance",
    "test_fact_kernel_v1_rejected_object_does_not_materialize_metadata",
    "test_fact_kernel_v1_rejects_unknown_request_fields_before_identity",
    "test_fact_kernel_rejects_each_malformed_root_list_member",
    "test_fact_kernel_v1_exposes_stable_failure_taxonomy",
]


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
