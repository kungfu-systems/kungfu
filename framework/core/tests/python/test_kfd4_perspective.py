# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy

import pytest

from kungfu.rewind import perspective


def _source(source_id: str, first: int, last: int) -> dict:
    return {
        "sourceId": source_id,
        "sourceKind": "remote-runtime",
        "location": source_id,
        "coordinate": f"kungfu://{source_id}",
        "head": f"head-{source_id}",
        "registered": True,
        "acceptedRange": {
            "manifestId": f"manifest-{source_id}",
            "firstFrameUid": first,
            "lastFrameUid": last,
            "status": "ok",
        },
    }


def _facts() -> list[dict]:
    return [
        {
            "id": "a1",
            "sourceId": "a",
            "frameUid": 10,
            "sourceLocalOrder": 1,
            "causalParents": [],
            "naturalObject": "assignment",
            "consequence": "admitted",
            "evidenceRoot": "sha256:" + "a" * 64,
        },
        {
            "id": "b1",
            "sourceId": "b",
            "frameUid": 20,
            "sourceLocalOrder": 1,
            "causalParents": [],
            "naturalObject": "review",
            "consequence": "accepted",
            "evidenceRoot": "sha256:" + "b" * 64,
        },
        {
            "id": "a2",
            "sourceId": "a",
            "frameUid": 30,
            "sourceLocalOrder": 2,
            "causalParents": ["b1"],
            "naturalObject": "gate",
            "consequence": "unblocked",
            "evidenceRoot": "sha256:" + "c" * 64,
        },
    ]


def _projection(observer: str, priority: list[str]) -> dict:
    return perspective.project(
        observer={"id": observer, "location": observer},
        accepted_sources=[_source("a", 10, 30), _source("b", 20, 40)],
        facts=_facts(),
        source_priority=priority,
        replay_loss=["display state"],
    )


def test_projection_is_observer_relative_but_causally_stable():
    a = _projection("observer-a", ["a", "b"])
    b = _projection("observer-b", ["b", "a"])

    assert a["order"] == ["a1", "b1", "a2"]
    assert b["order"] == ["b1", "a1", "a2"]
    assert a["perspective"]["verification"]["result"] == "pass"
    assert a["fsck"]["status"] == "passed"
    assert perspective.fsck_projection(a)["status"] == "passed"
    assert a["viewRoot"] != b["viewRoot"]


def test_projection_fsck_rejects_causal_inversion_and_root_drift():
    value = _projection("observer-a", ["a", "b"])
    value["order"] = ["a2", "b1", "a1"]

    checked = perspective.fsck_projection(value)

    assert checked["status"] == "failed"
    assert {issue["code"] for issue in checked["issues"]} >= {
        "causal-inversion",
        "view-root-drift",
    }


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (lambda facts, sources: facts[0].update(frameUid=99), "undeclared-fact-cut"),
        (lambda facts, sources: facts[0].update(evidenceRoot=""), "missing-evidence"),
        (
            lambda facts, sources: sources[0]["acceptedRange"].update(status="stale"),
            "stale-or-unaccepted-cut",
        ),
    ],
)
def test_projection_rejects_unqualified_inputs(mutation, code):
    facts = _facts()
    sources = [_source("a", 10, 30), _source("b", 20, 40)]
    mutation(facts, sources)

    with pytest.raises(perspective.PerspectiveError) as failure:
        perspective.project(
            observer={"id": "observer-a", "location": "a"},
            accepted_sources=sources,
            facts=facts,
            source_priority=["a", "b"],
        )

    assert failure.value.code == code


def test_projection_rejects_unknown_policy_and_causal_cycle():
    with pytest.raises(perspective.PerspectiveError) as unknown:
        perspective.project(
            observer={"id": "observer-a", "location": "a"},
            accepted_sources=[_source("a", 10, 30), _source("b", 20, 40)],
            facts=_facts(),
            source_priority=["a", "b"],
            policy_version="unknown/v2",
        )
    assert unknown.value.code == "unknown-policy-version"

    facts = _facts()
    facts[1]["causalParents"] = ["a2"]
    with pytest.raises(perspective.PerspectiveError) as cycle:
        perspective.project(
            observer={"id": "observer-a", "location": "a"},
            accepted_sources=[_source("a", 10, 30), _source("b", 20, 40)],
            facts=facts,
            source_priority=["a", "b"],
        )
    assert cycle.value.code == "causal-cycle"


def test_replay_preserves_observer_cuts_and_declared_loss():
    a = _projection("observer-a", ["a", "b"])
    b = _projection("observer-b", ["b", "a"])
    result = perspective.replay(
        [a, b],
        mode="contrastive",
        replay_observer={"id": "buildchain", "kind": "service"},
        declared_loss=["display state"],
    )

    assert result["fsck"]["status"] == "passed"
    assert result["document"]["verification"]["result"] == "pass"
    assert [view["observer"] for view in result["document"]["sourceViews"]] == [
        "observer-a",
        "observer-b",
    ]

    flattened = copy.deepcopy(result["document"])
    flattened["sourceViews"][1]["observer"] = "observer-a"
    checked = perspective.fsck_replay(flattened, [a, b])
    assert checked["status"] == "failed"
    assert {issue["code"] for issue in checked["issues"]} >= {
        "observer-substitution",
        "observer-flattened",
    }

    lossless = copy.deepcopy(result["document"])
    lossless["reconstruction"].pop("declaredLoss")
    checked = perspective.fsck_replay(lossless, [a, b])
    assert checked["status"] == "failed"
    assert "undeclared-loss" in {issue["code"] for issue in checked["issues"]}


def test_native_qualification_uses_journal_projection_and_fact_admission(tmp_path):
    report = perspective.qualify(
        tmp_path / "runtime",
        native_build_info={"git": {"revision": "1" * 40, "pristine": True}},
    )

    assert report["native"]["authority"] == "yijinjing-journal"
    assert report["native"]["sourceRegistryFsck"]["projectionStatus"] == "ok"
    assert len(report["native"]["factAdmissions"]) == 3
    assert {item["outcome"] for item in report["native"]["factAdmissions"]} == {
        "admitted"
    }
    assert report["perspectives"][0]["order"] != report["perspectives"][1]["order"]
    assert report["perspectivePreservingReplay"]["fsck"]["status"] == "passed"
    assert report["contrastiveReplay"]["fsck"]["status"] == "passed"
    assert {case["observed"] for case in report["negativeCases"]} == {"failed"}
    assert report["verdict"] == {
        "status": "passed",
        "qualifying": False,
        "selfCertified": False,
        "releaseQualification": "not-qualified",
        "shippedSupport": False,
    }
