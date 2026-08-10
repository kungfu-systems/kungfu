# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
import json
from pathlib import Path

from kungfu.canonical_json import canonical_json_bytes
from kungfu.release_provenance import build_candidate, build_promotion, verify
from kungfu.storage.fact_root_canonical import record_root

ROOT = Path(__file__).resolve().parents[4]
FIXTURE = ROOT / "tests/fixtures/release-provenance-object/cases.json"
CONTRACT = ROOT / "framework/release/kungfu-release-provenance.contract.json"


def _fixture():
    return json.loads(FIXTURE.read_text())


def _candidate(**overrides):
    values = deepcopy(_fixture()["candidate"])
    values.update(overrides)
    return build_candidate(
        release_id=values["releaseId"],
        candidate_id=values["candidateId"],
        candidate_commit=values["candidateCommit"],
        candidate_tree=values["candidateTree"],
        dev_cut_commit=values["devCutCommit"],
        dev_cut_tree=values["devCutTree"],
        previous_alpha_commit=values["previousAlphaCommit"],
        previous_alpha_tree=values["previousAlphaTree"],
        dev_cut_root=values["devCutRoot"],
        previous_alpha_root=values["previousAlphaRoot"],
        qualification_root=values["qualificationRoot"],
        authority_root=values["authorityRoot"],
        contract_root=values["contractRoot"],
        admission_roots=values["admissionRoots"],
        observed_parents=values["observedParents"],
        legacy_projection=values["legacyProjection"],
        fail_closed_on=values.get("failClosedOn"),
    )


def _promotion(candidate=None, **overrides):
    fixture = _fixture()
    values = deepcopy(fixture["promotion"])
    values.update(overrides)
    source = fixture["candidate"]
    return build_promotion(
        candidate_envelope=candidate or _candidate(),
        promotion_id=values["promotionId"],
        promotion_commit=values["promotionCommit"],
        promotion_tree=values["promotionTree"],
        qualification_root=source["qualificationRoot"],
        authority_root=source["authorityRoot"],
        contract_root=source["contractRoot"],
        admission_roots=source["admissionRoots"],
        candidate_ancestry_observed=values["candidateAncestryObserved"],
        legacy_projection=values["legacyProjection"],
    )


def _reroot_relations_and_object(envelope):
    for row in envelope["relations"]:
        row["root"] = record_root(row["record"])
    envelope["object"]["relationRoots"] = [row["root"] for row in envelope["relations"]]
    envelope["objectRoot"] = record_root(envelope["object"])


def test_candidate_and_promotion_are_distinct_rooted_temporal_objects():
    candidate = _candidate()
    promotion = _promotion(candidate)

    assert verify(candidate)["ok"] is True
    assert verify(promotion)["ok"] is True
    assert (
        candidate["subject"]["sourceTreeRoot"] == promotion["subject"]["sourceTreeRoot"]
    )
    assert candidate["objectRoot"] != promotion["objectRoot"]
    assert promotion["identities"]["derivationRoot"] == candidate["objectRoot"]
    assert (
        promotion["identities"]["acknowledgementRoot"]
        == candidate["identities"]["acknowledgementRoot"]
    )
    assert {
        row["record"]["relationId"].rsplit(":", 1)[-1] for row in candidate["relations"]
    } == {
        "derived-from",
        "acknowledges",
        "qualified-by",
        "authorized-by",
        "implements-contract",
        "projected-as",
    }


def test_dual_write_preserves_legacy_projection_bytes():
    fixture = _fixture()
    candidate = _candidate()
    promotion = _promotion(candidate)

    assert canonical_json_bytes(candidate["legacyProjection"]) == canonical_json_bytes(
        fixture["candidate"]["legacyProjection"]
    )
    assert canonical_json_bytes(promotion["legacyProjection"]) == canonical_json_bytes(
        fixture["promotion"]["legacyProjection"]
    )


def test_git_parentage_can_be_visible_advisory_drift_without_becoming_authority():
    fixture = _fixture()["candidate"]
    candidate = _candidate(
        observedParents=list(reversed(fixture["observedParents"])),
        failClosedOn=["candidate-tree-mismatch"],
    )
    report = verify(candidate)

    assert report["ok"] is True
    assert report["projectionStatus"] == "drift"
    assert report["projectionDrift"] == ["parent-order-mismatch"]
    assert (
        verify(
            candidate,
            {
                "devCutCommit": fixture["devCutCommit"],
                "previousAlphaCommit": fixture["previousAlphaCommit"],
            },
        )["ok"]
        is True
    )


def test_semantic_history_roots_do_not_depend_on_git_topology():
    baseline = _candidate()
    changed_projection = _candidate(
        devCutCommit="d" * 40,
        previousAlphaCommit="e" * 40,
        observedParents=["d" * 40, "e" * 40],
    )

    assert (
        baseline["identities"]["derivationRoot"]
        == changed_projection["identities"]["derivationRoot"]
    )
    assert (
        baseline["identities"]["acknowledgementRoot"]
        == changed_projection["identities"]["acknowledgementRoot"]
    )
    assert baseline["gitProjectionRoot"] != changed_projection["gitProjectionRoot"]


def test_negative_fixtures_fail_closed_with_stable_diagnostics():
    fixture = _fixture()
    base = _candidate()
    expected = {
        "phase": "candidate",
        "releaseId": fixture["candidate"]["releaseId"],
        "devCutCommit": fixture["candidate"]["devCutCommit"],
        "previousAlphaCommit": fixture["candidate"]["previousAlphaCommit"],
    }

    for case in fixture["cases"]:
        mutation = case["mutation"]
        if mutation == "none":
            continue
        candidate = deepcopy(base)
        if mutation == "swap-cuts":
            projection = candidate["gitProjection"]
            projection["devCutCommit"], projection["previousAlphaCommit"] = (
                projection["previousAlphaCommit"],
                projection["devCutCommit"],
            )
        elif mutation == "remove-acknowledgement":
            removed = next(
                row
                for row in candidate["relations"]
                if row["record"]["relationId"].endswith(":acknowledges")
            )
            candidate["relations"].remove(removed)
        elif mutation == "duplicate-authority":
            candidate["relations"].append(
                deepcopy(
                    next(
                        row
                        for row in candidate["relations"]
                        if row["record"]["relationId"].endswith(":authorized-by")
                    )
                )
            )
        elif mutation == "candidate-tree":
            candidate["gitProjection"]["candidateTree"] = "c" * 40
        elif mutation == "projection-root":
            candidate["gitProjectionRoot"] = "sha256:" + "f" * 64
        report = verify(candidate, expected)
        assert report["ok"] is False, case["id"]
        assert case["expected"] in report["issues"], (case["id"], report)


def test_promotion_ancestry_drift_is_visible_but_tree_parity_is_required():
    promotion = _promotion()
    report = verify(promotion)
    assert report["ok"] is True
    assert report["projectionDrift"] == ["candidate-not-ancestor"]

    mismatched = _promotion(promotionTree="c" * 40)
    report = verify(mismatched)
    assert report["ok"] is False
    assert "promotion-tree-mismatch" in report["issues"]


def test_contract_and_fixture_enumerate_the_same_falsifiers():
    contract = json.loads(CONTRACT.read_text())
    fixture = _fixture()
    assert contract["rootProtocol"] == "kungfu.fact-root.canonical/v2"
    assert contract["dualWrite"]["publicationAuthority"] is False
    assert {row["id"] for row in contract["falsifiers"]} == {
        row["id"] for row in fixture["cases"]
    }


def test_fully_rerooted_cut_scope_and_relation_forgery_still_fail_closed():
    forged_cut = deepcopy(_candidate())
    forged_root = "sha256:" + "1" * 64
    forged_cut["identities"]["cutRoot"] = forged_root
    forged_cut["object"]["cutRoot"] = forged_root
    for row in forged_cut["relations"]:
        row["record"]["validFromCutRoot"] = forged_root
    _reroot_relations_and_object(forged_cut)
    assert "cut-root-mismatch" in verify(forged_cut)["issues"]

    forged_relation = deepcopy(_candidate())
    forged_relation["relations"][0]["record"]["extension"] = "not-closed"
    assert "invalid-relation" in verify(forged_relation)["issues"]


def test_malformed_container_shapes_return_diagnostics_instead_of_raising():
    for field, malformed in [
        ("identities", []),
        ("gitProjection", []),
        ("object", []),
        ("predicates", {}),
        ("relations", {}),
    ]:
        envelope = deepcopy(_candidate())
        envelope[field] = malformed
        report = verify(envelope)
        assert report["ok"] is False, field
        assert report["issues"], field
