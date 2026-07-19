# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import pytest


if importlib.util.find_spec("pykungfu") is None:
    pytest.skip("native pykungfu binding is not built", allow_module_level=True)

from kungfu.storage import service  # noqa: E402


CHARACTERIZATION = json.loads(
    (
        Path(__file__).parents[4]
        / "tests/fixtures/fact-kernel-characterization/v1.json"
    ).read_text()
)


def _root(digit: str) -> str:
    return "sha256:" + digit * 64


def _accepted(response: dict) -> dict:
    assert response["ok"] is True, response
    assert response["status"] == "accepted", response
    assert response["write_occurred"] is True, response
    return response


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


def test_fact_kernel_v1_behavior_characterization(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    object_id = "fact:00000000000000000000000000000001"
    relation_id = "fact:00000000000000000000000000000002"

    capabilities = service.fact_kernel(source, "capabilities")
    assert capabilities["root_protocol"] == "sha256-length-framed-fields-v1"

    object_request = {
        "object_id": object_id,
        "object_type": "characterization",
        "created_by_receipt_root": _root("1"),
    }
    object_put = _accepted(service.fact_kernel(source, "object-put", object_request))
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
    assert invalid_relation["write_occurred"] is False

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
