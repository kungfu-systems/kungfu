# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from kungfu.release_provenance import build_candidate, build_promotion, semantic_root
from kungfu.canonical_json import canonical_json_bytes
from kungfu.temporal_release_admission import verify_admission

ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework/release/kungfu-temporal-release-admission.contract.json"
PROOF_PROJECTION = (
    ROOT / "docs/qualification/evidence/buildchain-compatibility-proof-projection.json"
)
ADMISSION_FACTS = (
    ROOT / "docs/qualification/evidence/kungfu-temporal-release-admission-facts.json"
)
PROVENANCE_CONTRACT = ROOT / "framework/release/kungfu-release-provenance.contract.json"
PROVENANCE_FIXTURE = ROOT / "tests/fixtures/release-provenance-object/cases.json"
ALPHA_LOCK = ROOT / ".buildchain/alpha-contract-lock.json"

CURRENT = "sha256:29f1218350d3cf49423ffc1b78e3328c3af554c21e8c3ffd31928ea9db51a404"
HISTORICAL = "sha256:13c4679c4ac8764c85e29693bfb59099e21e9786cc6082552198d39393467490"


def _json(path):
    return json.loads(path.read_text())


def _content_root(value):
    return "sha256:" + hashlib.sha256(canonical_json_bytes(value) + b"\n").hexdigest()


def _reroot_historical_fact(request, mutate):
    facts = request["admission_facts"]
    row = next(
        item
        for item in facts["proofs"]
        if item["record"]["proofId"] == "alpha-sealed-candidate-historical-contract"
    )
    old_root = row["proofRoot"]
    mutate(row["record"])
    row["proofRoot"] = _content_root(row["record"])
    facts["activeProofRoots"] = sorted(
        row["proofRoot"] if root == old_root else root
        for root in facts["activeProofRoots"]
    )
    body = {key: value for key, value in facts.items() if key != "factSetRoot"}
    facts["factSetRoot"] = _content_root(body)


def _case(contract_digest=CURRENT):
    source = _json(PROVENANCE_FIXTURE)
    candidate_values = deepcopy(source["candidate"])
    promotion_values = deepcopy(source["promotion"])
    artifact_root = "sha256:" + "a" * 64
    runtime_sha = "a5f43da50ea4ad5138ccf901135b89a711a1780c"
    approval_root = "sha256:" + "b" * 64
    if contract_digest == HISTORICAL:
        candidate_values.update(
            {
                "candidateCommit": "ad7c7db6df076f969c5939728bcbe70ccd4771b3",
                "candidateTree": "67a93b5831596555e7c29104421de3a0b97eb865",
                "devCutCommit": "f9e6b0e34bcdd6407b2a18206ace7982d64de2c8",
                "devCutTree": "67a93b5831596555e7c29104421de3a0b97eb865",
                "previousAlphaCommit": "5a3aea2d8f883b6ead343d43f2d34c574c08dc9e",
                "previousAlphaTree": "67a93b5831596555e7c29104421de3a0b97eb865",
                "qualificationRoot": "sha256:ada326ff2d09ea37a8751eccdb3e9e11ad8b56bc288b2e3378694494577166b0",
                "observedParents": [
                    "f9e6b0e34bcdd6407b2a18206ace7982d64de2c8",
                    "5a3aea2d8f883b6ead343d43f2d34c574c08dc9e",
                ],
            }
        )
        promotion_values.update(
            {
                "promotionCommit": "f9e6b0e34bcdd6407b2a18206ace7982d64de2c8",
                "promotionTree": "67a93b5831596555e7c29104421de3a0b97eb865",
            }
        )
        artifact_root = (
            "sha256:46169f7d385e5cc296352578cafd29f66762d73b6301f3180ce59560d9f5eef3"
        )
        runtime_sha = "1d9b35b75e16d492e6d8b18c32504e89f8806855"
        approval_root = (
            "sha256:2486aae3583e4a3df5ff11518f7881868dcd9f7aa65f6325390ecc7233eb1057"
        )
    provenance_contract = _json(PROVENANCE_CONTRACT)
    authority_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-external-identity/v1",
            "kind": "authority",
            "identity": "kungfu-systems/kungfu:.github/workflows/release-new-version.yml",
        }
    )
    candidate = build_candidate(
        release_id=candidate_values["releaseId"],
        candidate_id=candidate_values["candidateId"],
        candidate_commit=candidate_values["candidateCommit"],
        candidate_tree=candidate_values["candidateTree"],
        dev_cut_commit=candidate_values["devCutCommit"],
        dev_cut_tree=candidate_values["devCutTree"],
        previous_alpha_commit=candidate_values["previousAlphaCommit"],
        previous_alpha_tree=candidate_values["previousAlphaTree"],
        dev_cut_root=candidate_values["devCutRoot"],
        previous_alpha_root=candidate_values["previousAlphaRoot"],
        qualification_root=candidate_values["qualificationRoot"],
        authority_root=authority_root,
        contract_root=semantic_root(provenance_contract),
        admission_roots=candidate_values["admissionRoots"],
        observed_parents=candidate_values["observedParents"],
        legacy_projection=candidate_values["legacyProjection"],
    )
    promotion = build_promotion(
        candidate_envelope=candidate,
        promotion_id=(
            f"release-promotion:{candidate_values['releaseId']}:"
            f"{candidate_values['qualificationRoot']}"
        ),
        promotion_commit=promotion_values["promotionCommit"],
        promotion_tree=promotion_values["promotionTree"],
        qualification_root=candidate_values["qualificationRoot"],
        authority_root=authority_root,
        contract_root=semantic_root(provenance_contract),
        admission_roots=candidate_values["admissionRoots"],
        candidate_ancestry_observed=contract_digest != HISTORICAL,
        legacy_projection=promotion_values["legacyProjection"],
    )
    return {
        "contract": _json(CONTRACT),
        "admission_facts": _json(ADMISSION_FACTS),
        "proof_projection": _json(PROOF_PROJECTION),
        "release_provenance_contract": provenance_contract,
        "release_provenance": promotion,
        "current_contract_lock": _json(ALPHA_LOCK),
        "legacy_contract_digests": [CURRENT, HISTORICAL],
        "current_contract_digest": CURRENT,
        "bindings": {
            "repository": "kungfu-systems/kungfu",
            "channel": "alpha",
            "sourceSha": candidate_values["candidateCommit"],
            "sourceTree": candidate_values["candidateTree"],
            "promotionSha": promotion_values["promotionCommit"],
            "artifactRoot": artifact_root,
            "runtimeSha": runtime_sha,
            "acceptedContractDigest": contract_digest,
            "qualificationRoot": candidate_values["qualificationRoot"],
            "approvalRoot": approval_root,
            "authorityRoot": authority_root,
        },
    }


def test_direct_and_composed_paths_emit_deterministic_rooted_receipts():
    direct = verify_admission(**_case())
    assert direct["ok"], direct["receipt"]["reasonCodes"]
    assert direct["receipt"]["pathKind"] == "direct"
    assert direct["receipt"]["pathReceipt"]["status"] == "accepted"
    assert direct["receipt"]["maximumDepth"] == 2
    assert direct["receipt"]["containsPrivatePayload"] is False

    historical_input = _case(HISTORICAL)
    first = verify_admission(**historical_input)
    second = verify_admission(**deepcopy(historical_input))
    assert first == second
    assert first["ok"], first["receipt"]["reasonCodes"]
    assert first["receipt"]["pathKind"] == "composed"
    assert first["receipt"]["pathReceipt"]["status"] == "accepted"
    assert len(first["receipt"]["buildchainProofRoots"]) == 3
    assert first["receipt"]["receiptRoot"].startswith("sha256:")


def test_dual_read_mismatch_orphan_sha_and_provenance_drift_fail_closed():
    cases = []
    parity = _case(HISTORICAL)
    parity["legacy_contract_digests"] = [CURRENT]
    cases.append((parity, "legacy-generated-projection-mismatch"))

    orphan = _case(HISTORICAL)
    orphan["bindings"]["sourceSha"] = "not-a-sha"
    cases.append((orphan, "orphan-sha:sourceSha"))

    unprotected_cut = _case(HISTORICAL)
    unprotected_cut["admission_facts"]["source"]["protectedBase"] = "dev/v3/v3.0"
    facts_body = {
        key: value
        for key, value in unprotected_cut["admission_facts"].items()
        if key != "factSetRoot"
    }
    unprotected_cut["admission_facts"]["factSetRoot"] = _content_root(facts_body)
    cases.append((unprotected_cut, "admission-fact-source-mismatch"))

    source = _case(HISTORICAL)
    source["bindings"]["sourceSha"] = "0" * 40
    cases.append((source, "sealed-candidate-sourceSha-mismatch"))

    tree = _case(HISTORICAL)
    tree["bindings"]["sourceTree"] = "0" * 40
    cases.append((tree, "sealed-candidate-sourceTree-mismatch"))

    artifact = _case(HISTORICAL)
    artifact["bindings"]["artifactRoot"] = "sha256:" + "0" * 64
    cases.append((artifact, "sealed-candidate-artifactRoot-mismatch"))

    runtime = _case(HISTORICAL)
    runtime["bindings"]["runtimeSha"] = "0" * 40
    cases.append((runtime, "sealed-candidate-runtimeSha-mismatch"))

    contract = _case(HISTORICAL)
    contract["bindings"]["acceptedContractDigest"] = "sha256:" + "0" * 64
    cases.append((contract, "temporal-contract-not-admitted"))

    qualification = _case(HISTORICAL)
    qualification["bindings"]["qualificationRoot"] = "sha256:" + "c" * 64
    cases.append((qualification, "qualification-root-mismatch"))

    authority = _case(HISTORICAL)
    authority["bindings"]["authorityRoot"] = "sha256:" + "c" * 64
    cases.append((authority, "release-authority-identity-mismatch"))

    ancestry = _case(HISTORICAL)
    ancestry["release_provenance"]["gitProjection"]["candidateAncestryObserved"] = True
    cases.append((ancestry, "release-provenance:git-projection-root-mismatch"))

    projection = _case(HISTORICAL)
    projection["proof_projection"]["proofs"][0]["target"]["breakingDigest"] = (
        "sha256:" + "d" * 64
    )
    cases.append((projection, "compatibility-proof-root-mismatch"))

    proof = _case(HISTORICAL)
    proof["admission_facts"]["proofs"][0]["record"]["reason"] = "altered"
    cases.append((proof, "admission-proof-root-mismatch"))

    revoked = _case(HISTORICAL)
    _reroot_historical_fact(
        revoked, lambda record: record.__setitem__("status", "revoked")
    )
    cases.append((revoked, "unscoped-admission-proof"))

    implicit = _case(HISTORICAL)
    _reroot_historical_fact(
        implicit, lambda record: record.__setitem__("pathKind", "direct")
    )
    cases.append((implicit, "direct-path-not-exact"))

    for request, expected in cases:
        report = verify_admission(**request)
        assert not report["ok"], expected
        assert expected in report["receipt"]["reasonCodes"]
        assert report["receipt"]["pathReceipt"]["status"] == "rejected"
        assert report["receipt"]["receiptRoot"].startswith("sha256:")


def test_legacy_exact_rollback_preserves_all_historical_inputs():
    request = _case(HISTORICAL)
    provenance_before = deepcopy(request["release_provenance"])
    projection_before = deepcopy(request["proof_projection"])
    facts_before = deepcopy(request["admission_facts"])
    request["mode"] = "legacy-exact"
    report = verify_admission(**request)
    assert report["ok"]
    assert report["receipt"]["mode"] == "legacy-exact"
    assert report["receipt"]["pathKind"] == "direct"
    assert report["receipt"]["buildchainProofRoots"] == []
    assert report["receipt"]["admissionFactSetRoot"] == facts_before["factSetRoot"]
    assert request["release_provenance"] == provenance_before
    assert request["proof_projection"] == projection_before
    assert request["admission_facts"] == facts_before


def test_release_consumer_python_bridge_accepts_the_exact_json_protocol():
    request = _case(HISTORICAL)
    payload = {
        "contract": request["contract"],
        "admissionFacts": request["admission_facts"],
        "proofProjection": request["proof_projection"],
        "releaseProvenanceContract": request["release_provenance_contract"],
        "releaseProvenance": request["release_provenance"],
        "currentContractLock": request["current_contract_lock"],
        "legacyContractDigests": request["legacy_contract_digests"],
        "currentContractDigest": request["current_contract_digest"],
        "bindings": request["bindings"],
    }
    result = subprocess.run(
        [sys.executable, ROOT / "scripts/release-provenance-object.py", "admission"],
        cwd=ROOT,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert report["receipt"]["pathKind"] == "composed"
    assert report["receipt"]["containsPrivatePayload"] is False


def test_projection_contract_is_mirrored_and_bound_to_protected_buildchain_evidence():
    projection = _json(PROOF_PROJECTION)
    facts = _json(ADMISSION_FACTS)
    contract = _json(CONTRACT)
    mirror = _json(
        ROOT / "config/release/kungfu-temporal-release-admission.contract.json"
    )
    assert projection["source"] == {
        "repository": "kungfu-systems/buildchain",
        "protectedBase": "dev/v3/v3.0",
        "sourceCommit": "913b5d3fc486e225cf19f6e677129434db4850a6",
        "mergeCommit": "10745d50aa93192c06b13f76942c4c291b482518",
    }
    assert contract["maximumPathDepth"] == 2
    assert mirror == contract
    assert contract["factAuthority"]["projection"] == str(
        ADMISSION_FACTS.relative_to(ROOT)
    )
    assert len(facts["activeProofRoots"]) == len(facts["proofs"]) == 3
