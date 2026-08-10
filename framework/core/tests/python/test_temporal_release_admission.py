# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys

from kungfu.release_provenance import build_candidate, build_promotion, semantic_root
from kungfu.temporal_release_admission import verify_admission

ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework/release/kungfu-temporal-release-admission.contract.json"
PROOF_PROJECTION = (
    ROOT / "docs/qualification/evidence/buildchain-compatibility-proof-projection.json"
)
PROVENANCE_CONTRACT = ROOT / "framework/release/kungfu-release-provenance.contract.json"
PROVENANCE_FIXTURE = ROOT / "tests/fixtures/release-provenance-object/cases.json"
ALPHA_LOCK = ROOT / ".buildchain/alpha-contract-lock.json"

CURRENT = "sha256:8e565f9ac5146d5dceafc3da6b267147fb412937db979bf35a0429966da82197"
HISTORICAL = "sha256:13c4679c4ac8764c85e29693bfb59099e21e9786cc6082552198d39393467490"


def _json(path):
    return json.loads(path.read_text())


def _case(contract_digest=CURRENT):
    source = _json(PROVENANCE_FIXTURE)
    candidate_values = source["candidate"]
    promotion_values = source["promotion"]
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
        candidate_ancestry_observed=True,
        legacy_projection=promotion_values["legacyProjection"],
    )
    return {
        "contract": _json(CONTRACT),
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
            "artifactRoot": "sha256:" + "a" * 64,
            "runtimeSha": "36b08dc7bf417e57bffcc3dc784a2473254fe4c1",
            "acceptedContractDigest": contract_digest,
            "qualificationRoot": candidate_values["qualificationRoot"],
            "approvalRoot": "sha256:" + "b" * 64,
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
    cases.append((parity, "legacy-proof-projection-mismatch"))

    orphan = _case(HISTORICAL)
    orphan["bindings"]["sourceSha"] = "not-a-sha"
    cases.append((orphan, "orphan-sha:sourceSha"))

    qualification = _case(HISTORICAL)
    qualification["bindings"]["qualificationRoot"] = "sha256:" + "c" * 64
    cases.append((qualification, "qualification-root-mismatch"))

    ancestry = _case(HISTORICAL)
    ancestry["release_provenance"]["gitProjection"]["candidateAncestryObserved"] = False
    cases.append((ancestry, "candidate-ancestry-mismatch"))

    projection = _case(HISTORICAL)
    projection["proof_projection"]["proofs"][0]["target"]["breakingDigest"] = (
        "sha256:" + "d" * 64
    )
    cases.append((projection, "compatibility-proof-root-mismatch"))

    for request, expected in cases:
        report = verify_admission(**request)
        assert not report["ok"]
        assert expected in report["receipt"]["reasonCodes"]
        assert report["receipt"]["pathReceipt"]["status"] == "rejected"
        assert report["receipt"]["receiptRoot"].startswith("sha256:")


def test_legacy_exact_rollback_preserves_all_historical_inputs():
    request = _case(HISTORICAL)
    provenance_before = deepcopy(request["release_provenance"])
    projection_before = deepcopy(request["proof_projection"])
    request["mode"] = "legacy-exact"
    report = verify_admission(**request)
    assert report["ok"]
    assert report["receipt"]["mode"] == "legacy-exact"
    assert report["receipt"]["pathKind"] == "direct"
    assert report["receipt"]["buildchainProofRoots"] == []
    assert request["release_provenance"] == provenance_before
    assert request["proof_projection"] == projection_before


def test_release_consumer_python_bridge_accepts_the_exact_json_protocol():
    request = _case(HISTORICAL)
    payload = {
        "contract": request["contract"],
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
