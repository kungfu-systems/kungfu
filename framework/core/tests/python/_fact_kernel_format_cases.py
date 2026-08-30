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
    "test_fact_kernel_kfr2_writer_behavior_characterization",
    "test_legacy_v1_bundle_replays_exactly_and_remains_readable",
]


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
