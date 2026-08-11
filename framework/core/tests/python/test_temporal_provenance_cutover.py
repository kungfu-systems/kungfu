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
ADR = ROOT / "docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md"


def _json(path):
    return json.loads(path.read_text())


def _content_root(value):
    return "sha256:" + hashlib.sha256(canonical_json_bytes(value) + b"\n").hexdigest()


def test_cutover_evidence_is_rooted_and_binds_the_active_historical_proof():
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
    assert qualification["admissionFactSetRoot"] == facts["factSetRoot"]

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
    assert historical["buildchainProofRoots"] == qualification["buildchainProofRoots"]


def test_cutover_contract_has_no_hand_maintained_digest_path_map():
    contract = _json(
        ROOT / "framework/release/kungfu-temporal-release-admission.contract.json"
    )
    policy = _json(ROOT / "docs/qualification/gates/release-admission-policy.json")
    assert "paths" not in contract
    assert contract["factAuthority"] == {
        "projection": str(FACTS.relative_to(ROOT)),
        "activeSelection": "activeProofRoots",
        "admittedDigests": "derived-from-active-proof-records",
        "orphanPolicy": "reject",
    }
    assert policy["temporalAdmission"]["admissionFacts"] == str(FACTS.relative_to(ROOT))


def test_cutover_delivery_repair_requires_a_fresh_project_cut_proof():
    decision = ADR.read_text()
    assert decision.count("a dequeued source identity is never reused") == 1
    assert "recompute its Project Cut replay proof" in decision
