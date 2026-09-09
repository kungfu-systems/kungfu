# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
import json
from pathlib import Path

from kungfu.canonical_json import canonical_json_bytes
from kungfu.release_provenance import (
    build_candidate,
    build_candidate_v2,
    build_promotion,
    migrate_candidate_v1,
    verify,
    verify_migration,
)
from kungfu.storage.fact_root_canonical import record_root

ROOT = Path(__file__).resolve().parents[4]
FIXTURE = ROOT / "tests/fixtures/release-provenance-object/cases.json"
CONTRACT = ROOT / "product/release/kungfu-release-provenance.contract.json"


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


def _candidate_v2(**overrides):
    fixture = _fixture()
    values = deepcopy(fixture["candidate"])
    values.update(fixture["v2Candidate"])
    values.update(overrides)
    return build_candidate_v2(
        release_id=values["releaseId"],
        candidate_id=values["candidateId"],
        source_content_algorithm=values["sourceContentAlgorithm"],
        source_content_digest=values["sourceContentDigest"],
        candidate_commit=values["candidateCommit"],
        candidate_tree=values["candidateTree"],
        dev_cut_commit=values["devCutCommit"],
        dev_cut_tree=values["devCutTree"],
        previous_alpha_commit=values["previousAlphaCommit"],
        previous_alpha_tree=values["previousAlphaTree"],
        dev_cut_root=values["devCutRoot"],
        previous_alpha_root=values["previousAlphaRoot"],
        qualification_root=values["qualificationRoot"],
        approval_root=values["approvalRoot"],
        authority_root=values["authorityRoot"],
        contract_root=values["contractRoot"],
        admission_roots=values["admissionRoots"],
        observed_parents=values["observedParents"],
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


def test_v2_object_root_is_independent_of_zero_one_two_or_many_git_parents():
    fixture = _fixture()
    candidates = [
        _candidate_v2(observedParents=case["observedParents"])
        for case in fixture["topologyCases"]
    ]

    assert all(verify(candidate)["ok"] for candidate in candidates)
    assert {candidate["objectRoot"] for candidate in candidates} == {
        candidates[0]["objectRoot"]
    }
    assert len({candidate["gitProjectionRoot"] for candidate in candidates}) == len(
        candidates
    )


def test_v2_identical_semantics_are_deterministic_and_history_roots_distinguish():
    baseline = _candidate_v2()
    repeated = _candidate_v2()
    distinct_history = _candidate_v2(devCutRoot="sha256:" + "c" * 64)

    assert baseline["objectRoot"] == repeated["objectRoot"]
    assert baseline["gitProjectionRoot"] == repeated["gitProjectionRoot"]
    assert baseline["objectRoot"] != distinct_history["objectRoot"]
    assert (
        baseline["gitProjection"]["candidateTree"]
        == distinct_history["gitProjection"]["candidateTree"]
    )


def test_v2_projection_cannot_override_semantic_history_or_authority():
    baseline = _candidate_v2()
    transported = _candidate_v2(
        candidateCommit="f" * 40,
        devCutCommit="e" * 40,
        previousAlphaCommit="d" * 40,
        observedParents=["d" * 40, "e" * 40, "c" * 40],
    )

    assert verify(transported)["ok"] is True
    assert baseline["objectRoot"] == transported["objectRoot"]
    assert baseline["gitProjectionRoot"] != transported["gitProjectionRoot"]
    assert transported["gitProjection"]["semanticAuthority"] is False
    assert (
        transported["gitProjectionRoot"] not in transported["object"]["materialRoots"]
    )


def test_v2_relations_fail_closed_when_missing_ambiguous_or_conflicting():
    for mutation, expected in (
        ("missing", "approved-by-relation-count"),
        ("ambiguous", "ambiguous-authority"),
        ("conflicting", "derived-from-relation-mismatch"),
        ("reordered", "relation-order-mismatch"),
    ):
        envelope = deepcopy(_candidate_v2())
        if mutation == "missing":
            envelope["relations"] = [
                row
                for row in envelope["relations"]
                if not row["record"]["relationId"].endswith(":approved-by")
            ]
        elif mutation == "ambiguous":
            envelope["relations"].append(
                deepcopy(
                    next(
                        row
                        for row in envelope["relations"]
                        if row["record"]["relationId"].endswith(":authorized-by")
                    )
                )
            )
        else:
            if mutation == "conflicting":
                row = next(
                    row
                    for row in envelope["relations"]
                    if row["record"]["relationId"].endswith(":derived-from")
                )
                row["record"]["targetRoot"] = "sha256:" + "f" * 64
                row["root"] = record_root(row["record"])
            else:
                envelope["relations"] = list(reversed(envelope["relations"]))
                envelope["object"]["relationRoots"] = [
                    row["root"] for row in envelope["relations"]
                ]
                envelope["objectRoot"] = record_root(envelope["object"])
        report = verify(envelope)
        assert report["ok"] is False, mutation
        assert expected in report["issues"], (mutation, report)


def test_v1_migration_preserves_predecessor_and_emits_verified_successor_receipt():
    predecessor = _candidate()
    original_bytes = canonical_json_bytes(predecessor)
    values = _fixture()["v2Candidate"]
    bundle = migrate_candidate_v1(
        predecessor,
        source_content_algorithm=values["sourceContentAlgorithm"],
        source_content_digest=values["sourceContentDigest"],
        approval_root=values["approvalRoot"],
    )

    assert canonical_json_bytes(predecessor) == original_bytes
    assert verify(predecessor)["ok"] is True
    assert verify(bundle["successor"])["ok"] is True
    assert verify_migration(bundle)["ok"] is True
    assert (
        bundle["successorRelation"]["record"]["sourceRoot"]
        == bundle["successor"]["objectRoot"]
    )
    assert (
        bundle["successorRelation"]["record"]["targetRoot"] == predecessor["objectRoot"]
    )
    assert bundle["receipt"]["record"]["priorObjectMutated"] is False


def test_v2_malformed_content_and_projection_fail_closed():
    content = deepcopy(_candidate_v2())
    content["sourceContent"]["record"]["algorithm"] = "SHA 256"
    assert "invalid-content" in verify(content)["issues"]

    projection = deepcopy(_candidate_v2())
    projection["gitProjection"]["candidateTree"] = "not-an-oid"
    assert verify(projection)["ok"] is False

    tree_drift = _candidate_v2(candidateTree="c" * 40)
    assert "candidate-tree-mismatch" in verify(tree_drift)["issues"]
