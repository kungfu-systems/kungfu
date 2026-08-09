# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy

from kungfu.storage import fact_profile_shadow
from kungfu.storage import service as storage_service


def _root(label):
    return fact_profile_shadow.semantic_root("fixture/v1", label)


def _source(profile, source_id, payload):
    return {
        "profile": profile,
        "source_id": source_id,
        "source_cut_root": _root(f"{source_id}:cut"),
        "last_accepted_head": _root(f"{source_id}:head"),
        "authority_receipt_root": _root(f"{source_id}:authority"),
        "declaration_root": _root(f"{profile}:declaration"),
        "admission_root": _root(f"{profile}:admission"),
        "payload": payload,
        "loss": [],
    }


def _document():
    return {
        "sources": [
            _source(
                "initiative-assignment",
                "initiative:technical-stewardship/assignment:fact-kernel",
                {
                    "initiative_id": "technical-stewardship",
                    "assignment_id": "fact-kernel",
                },
            ),
            _source(
                "xinfa-atlas",
                "atlas:sha256:fixture",
                {"atlas_root": _root("atlas")},
            ),
            _source(
                "authority-receipt",
                "warrant:fact-kernel-review",
                {"receipt_root": _root("warrant")},
            ),
        ],
        "relations": [
            {
                "relation_type": "uses-context",
                "source_id": "initiative:technical-stewardship/assignment:fact-kernel",
                "target_id": "atlas:sha256:fixture",
                "attributes": {"inheriting": False},
            },
            {
                "relation_type": "explicitly-authorizes",
                "source_id": "warrant:fact-kernel-review",
                "target_id": "initiative:technical-stewardship/assignment:fact-kernel",
                "attributes": {"scope": "fixture-only", "inheriting": False},
            },
        ],
    }


def test_three_profiles_share_native_cut_without_identity_collapse(tmp_path):
    document = _document()
    receipt = storage_service.fact_profile_shadow_project(tmp_path, document)
    actual = storage_service.fact_profile_shadow_inspect(
        tmp_path, cut_root=receipt["cut_root"]
    )
    comparison = storage_service.fact_profile_shadow_compare(document, actual)

    assert receipt["mode"] == "shadow-read-only"
    assert len(set(receipt["objects"].values())) == 3
    assert len(receipt["relation_roots"]) == 2
    assert comparison["ok"] is True
    assert comparison["counts"] == {
        "missing": 0,
        "extra": 0,
        "mismatch": 0,
        "stale": 0,
        "divergent": 0,
    }
    assert {row["body_status"] for row in actual["objects"]} == {"available"}


def test_shadow_comparison_reports_typed_gaps_without_selecting_authority(tmp_path):
    document = _document()
    receipt = storage_service.fact_profile_shadow_project(tmp_path, document)
    actual = storage_service.fact_profile_shadow_inspect(
        tmp_path, cut_root=receipt["cut_root"]
    )

    stale = deepcopy(document)
    stale["sources"][0]["last_accepted_head"] = _root("new-head")
    stale_result = storage_service.fact_profile_shadow_compare(stale, actual)
    assert stale_result["ok"] is False
    assert stale_result["counts"]["stale"] == 1
    assert stale_result["mode"] == "compare-without-authority-selection"

    missing = deepcopy(document)
    missing["sources"].append(
        _source(
            "initiative-assignment",
            "initiative:missing/assignment:missing",
            {"status": "missing"},
        )
    )
    missing_result = storage_service.fact_profile_shadow_compare(missing, actual)
    assert missing_result["counts"]["missing"] == 1


def test_profile_identity_excludes_runtime_and_projection_paths():
    first = fact_profile_shadow.stable_object_id("xinfa-atlas", "atlas:stable")
    second = fact_profile_shadow.stable_object_id("xinfa-atlas", "atlas:stable")

    assert first == second
    assert first.startswith("fact:")
    assert len(first) == len("fact:") + 32
