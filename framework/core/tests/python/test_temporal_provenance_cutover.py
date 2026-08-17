# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
from pathlib import Path

from kungfu.canonical_json import canonical_json_bytes

ROOT = Path(__file__).resolve().parents[4]
FACTS = (
    ROOT / "docs/qualification/evidence/kungfu-temporal-release-admission-facts.json"
)
QUALIFICATION = (
    ROOT / "docs/qualification/evidence/kungfu-temporal-provenance-cutover.json"
)
FACT_ONLY_QUALIFICATION = (
    ROOT
    / "docs/qualification/evidence/kungfu-fact-only-temporal-admission-cutover.json"
)
BUILDCHAIN_FACTS = (
    ROOT / "docs/qualification/evidence/buildchain-compatibility-fact-projection.json"
)
ROLLBACK = ROOT / "framework/release/kungfu-temporal-release-rollback.contract.json"
ADR = ROOT / "docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md"


def _json(path):
    return json.loads(path.read_text())


def _content_root(value):
    return "sha256:" + hashlib.sha256(canonical_json_bytes(value) + b"\n").hexdigest()


def test_cutover_evidence_is_rooted_and_preserved_as_source_qualification():
    facts = _json(FACTS)
    qualification = _json(QUALIFICATION)
    qualification_body = {
        key: value for key, value in qualification.items() if key != "qualificationRoot"
    }
    assert qualification["qualificationRoot"] == _content_root(qualification_body)
    assert qualification["status"] == "passed"
    assert qualification["artifactCount"] == 44
    assert qualification["candidateRegularFileCount"] == 14
    assert qualification["candidateAncestryObserved"] is False
    assert qualification["ancestrySemanticAuthority"] is False
    assert qualification["inputUnchanged"] is True
    assert qualification["heavyRebuildPerformed"] is False
    assert qualification["externalPublicationClaimed"] is False
    fact_only = _json(FACT_ONLY_QUALIFICATION)
    fact_only_body = {
        key: value for key, value in fact_only.items() if key != "qualificationRoot"
    }
    assert fact_only["qualificationRoot"] == _content_root(fact_only_body)
    assert fact_only["sourceQualificationRoot"] == qualification["qualificationRoot"]
    assert (
        fact_only["sourceAdmissionFactSetRoot"] == qualification["admissionFactSetRoot"]
    )
    assert (
        fact_only["sourceAdmissionReceiptRoot"] == qualification["admissionReceiptRoot"]
    )
    assert fact_only["admissionFactSetRoot"] == facts["factSetRoot"]
    buildchain_facts = _json(BUILDCHAIN_FACTS)
    assert fact_only["factProjectionRoot"] == buildchain_facts["projectionRoot"]
    assert (
        fact_only["factRegistryRoot"]
        == buildchain_facts["contractWorld"]["factRegistryRoot"]
    )
    assert fact_only["factCutRoot"] == buildchain_facts["contractWorld"]["factCutRoot"]
    rollback = _json(ROLLBACK)
    rollback_body = {key: value for key, value in rollback.items() if key != "sealRoot"}
    assert rollback["sealRoot"] == _content_root(rollback_body)
    assert fact_only["rollbackSealRoot"] == rollback["sealRoot"]

    active = set(facts["activeProofRoots"])
    proofs = {row["proofRoot"]: row["record"] for row in facts["proofs"]}
    assert active == set(proofs)
    historical = next(
        record
        for record in proofs.values()
        if record["proofId"] == "alpha-sealed-candidate-historical-contract"
    )
    assert (
        historical["acceptedContractDigest"] == qualification["acceptedContractDigest"]
    )
    assert (
        historical["evidence"]["candidateInputRoot"] == qualification["artifactSetRoot"]
    )
    assert (
        historical["evidence"]["candidateInventoryRoot"]
        == qualification["candidateInventoryRoot"]
    )
    assert historical["evidence"]["capsuleRoot"] == qualification["capsuleRoot"]
    assert historical["buildchainFactRoots"] == fact_only["buildchainFactRoots"]
    assert fact_only["normalAdmissionMode"] == "fact-only"
    assert fact_only["digestProjectionAuthority"] == "non-authoritative"
    assert fact_only["rollbackNormalAdmissionEligible"] is False
    assert fact_only["externalPublicationClaimed"] is False


def test_cutover_contract_has_no_hand_maintained_digest_path_map():
    contract = _json(
        ROOT / "framework/release/kungfu-temporal-release-admission.contract.json"
    )
    policy = _json(ROOT / "docs/qualification/gates/release-admission-policy.json")
    assert "paths" not in contract
    assert contract["factAuthority"] == {
        "admissionFacts": str(FACTS.relative_to(ROOT)),
        "buildchainFacts": "docs/qualification/evidence/buildchain-compatibility-fact-projection.json",
        "buildchainFactRegistryRoot": "sha256:232fd556a2372b29db586bbc2acbdfce6464a68c93902797ff527f75f7816c42",
        "buildchainFactCutRoot": "sha256:f61b975d4a96c921cc4bd37fb3ed9a0596b47004fe34dc7219979d697e3707f9",
        "buildchainFactProjectionRoot": "sha256:b275910c8047541ff2e0292a4ba7611ca8cd7905934eb7e05d3aa44db1e0bba6",
        "activeSelection": "activeProofRoots",
        "admittedDigests": "derived-from-active-proof-records",
        "orphanPolicy": "reject",
        "pathAuthority": "exact-buildchain-Fact-roots-and-receipts",
    }
    assert policy["temporalAdmission"]["admissionFacts"] == str(FACTS.relative_to(ROOT))
    assert contract["defaultMode"] == "fact-only"
    assert contract["normalModes"] == ["fact-only"]
    assert "dualRead" not in contract
    assert "rollbackMode" not in contract


def test_cutover_delivery_repair_requires_a_fresh_project_cut_proof():
    decision = ADR.read_text()
    assert decision.count("a dequeued source identity is never reused") == 1
    assert "recompute its Project Cut replay proof" in decision
