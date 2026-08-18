# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
from pathlib import Path

import pytest

from kungfu.storage import fact_profile_shadow
from kungfu.storage import service


def _root(label: str) -> str:
    return fact_profile_shadow.semantic_root("integrity-fixture/v1", label)


def _source(profile: str, source_id: str) -> dict:
    return {
        "profile": profile,
        "source_id": source_id,
        "source_cut_root": _root(f"{source_id}:cut"),
        "last_accepted_head": _root(f"{source_id}:head"),
        "authority_receipt_root": _root(f"{source_id}:authority"),
        "declaration_root": _root(f"{profile}:declaration"),
        "admission_root": _root(f"{profile}:admission"),
        "payload": {"source": source_id},
        "loss": [],
    }


def _fixture(runtime_dir: Path) -> dict:
    document = {
        "sources": [
            _source(
                "initiative-assignment",
                "initiative:fixture/assignment:integrity",
            ),
            _source("xinfa-atlas", "atlas:fixture"),
        ],
        "relations": [
            {
                "relation_type": "uses-context",
                "source_id": "initiative:fixture/assignment:integrity",
                "target_id": "atlas:fixture",
                "attributes": {"inheriting": False},
            }
        ],
        "ref": {
            "transition_id": "integrity-fixture-create",
            "name": "heads/integrity",
            "expected_old_cut_root": None,
            "expected_old_revision": 0,
            "kind": "create",
            "reason_root": _root("fixture-ref-reason"),
        },
    }
    return service.fact_profile_shadow_project(runtime_dir, document)


def test_fsck_export_import_preserves_exact_cut_and_ref(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "clean-clone"
    projected = _fixture(source)

    report = service.fact_kernel_fsck(source, cut_root=projected["cut_root"])
    bundle = service.fact_kernel_export(source, ref_name="heads/integrity")
    preview = service.fact_kernel_import(target, bundle, dry_run=True)
    assert preview["dry_run"] is True
    assert not (target / "storage").exists()

    imported = service.fact_kernel_import(target, bundle, dry_run=False)
    observed = service.fact_kernel(target, "query", {"ref_name": "heads/integrity"})

    assert report["ok"] is True
    assert bundle["loss"] == []
    assert imported["observed_cut_root"] == projected["cut_root"]
    assert observed["cut_root"] == projected["cut_root"]
    assert service.fact_kernel_fsck(target)["ok"] is True


def test_missing_and_torn_body_fail_visible_without_repair(tmp_path):
    projected = _fixture(tmp_path)
    inspected = service.fact_profile_shadow_inspect(
        tmp_path, cut_root=projected["cut_root"]
    )
    body_root = inspected["objects"][0]["version"]["bodyRoot"]
    digest = body_root.removeprefix("sha256:")
    body_path = tmp_path / "storage" / "fact-bodies" / digest[:2] / digest
    body_path.write_bytes(b"torn-body")

    report = service.fact_kernel_fsck(tmp_path, cut_root=projected["cut_root"])

    assert report["ok"] is False
    assert {issue["code"] for issue in report["issues"]} & {
        "missing-body",
        "authority-unreadable",
    }


def test_fold_issues_identify_record_phase_and_recovery(tmp_path):
    object_id = f"fact:{'1' * 32}"
    recorded = service.fact_kernel(
        tmp_path,
        "object-put",
        {
            "object_id": object_id,
            "object_type": "fold-diagnostic",
            "created_by_receipt_root": _root("fold-diagnostic-receipt"),
        },
    )
    object_root = recorded["result"]["object_root"]
    digest = object_root.removeprefix("sha256:")
    metadata = tmp_path / "storage" / "fact-kernel-metadata" / digest[:2] / digest
    metadata.unlink()

    query = service.fact_kernel(tmp_path, "query", {"include_inventory": True})
    issue = next(
        row
        for row in query["issues"]
        if row["failure_code"] == "record-materialization-failed"
    )
    assert query["counts"]["unknown_records"] == len(query["issues"])
    assert issue == {
        "sequence": 1,
        "frame_tag": issue["frame_tag"],
        "record_root": object_root,
        "failure_code": "record-materialization-failed",
        "message": "Fact record metadata could not be verified",
        "phase": "materialize",
        "recovery": "preserve-authority-and-restore-content",
    }
    assert isinstance(issue["frame_tag"], int) and issue["frame_tag"] > 0

    report = service.fact_kernel_fsck(tmp_path)
    projected = next(
        row
        for row in report["issues"]
        if row["code"] == "record-materialization-failed"
    )
    assert projected["subject"] == object_root
    assert projected["sequence"] == 1
    assert projected["frame_tag"] == issue["frame_tag"]
    assert projected["phase"] == "materialize"
    assert projected["recovery"] == "preserve-authority-and-restore-content"


def test_bundle_tamper_and_stale_ref_fail_closed(tmp_path):
    projected = _fixture(tmp_path / "source")
    bundle = service.fact_kernel_export(
        tmp_path / "source", cut_root=projected["cut_root"]
    )
    tampered = deepcopy(bundle)
    tampered["target"]["cut_root"] = _root("tampered")

    with pytest.raises(ValueError, match="bundle root mismatch"):
        service.fact_kernel_import(tmp_path / "target", tampered, dry_run=True)

    stale = service.fact_kernel(
        tmp_path / "source",
        "ref-cas",
        {
            "transition_id": "stale-integrity-fixture",
            "ref_name": "heads/integrity",
            "expected_old_cut_root": _root("stale"),
            "expected_old_revision": 0,
            "new_cut_root": projected["cut_root"],
            "kind": "advance",
            "reason_root": _root("stale-reason"),
        },
    )
    assert stale["failure_code"] == "stale-ref"
    assert stale["write_occurred"] is False


def test_rebuild_retention_and_backend_switch_preserve_semantic_roots(tmp_path):
    projected = _fixture(tmp_path)
    orphan = service.fact_kernel(
        tmp_path,
        "object-put",
        {
            "object_id": f"fact:{'f' * 32}",
            "object_type": "orphan-fixture",
            "created_by_receipt_root": _root("orphan"),
        },
    )
    assert orphan["ok"] is True

    rebuild = service.fact_kernel_rebuild_projections(tmp_path)
    retention = service.fact_kernel_retention_plan(tmp_path)
    parity = service.fact_kernel_backend_parity(tmp_path, target_provider="rocksdb")

    assert rebuild["ok"] is True
    assert rebuild["write_occurred"] is False
    assert retention["mode"] == "plan-only"
    assert retention["destructive_execution"] is False
    assert f"fact:{'f' * 32}" in retention["unreachable"]["objects"]
    assert projected["cut_root"] in retention["reachable"]["cuts"]
    assert parity["ok"] is True
    assert parity["semantic_roots_match"] is True
    assert parity["target_provider"] == "rocksdb"
