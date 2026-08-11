# SPDX-License-Identifier: Apache-2.0

"""Proof-backed temporal release admission for Kungfu publication inputs."""

from __future__ import annotations

import hashlib
import re
from copy import deepcopy
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.release_provenance import semantic_root, verify as verify_provenance
from kungfu.storage.fact_root_canonical import ROOT_PATTERN, record_root, verify_path

RECEIPT_SCHEMA = "kungfu.temporal-release-admission-receipt/v1"
PROJECTION_SCHEMA = "kungfu.buildchain.compatibility-proof-projection/v1"
PROOF_SCHEMA = "kungfu.buildchain.compatibility-proof/v1"
FACT_SET_SCHEMA = "kungfu.temporal-release-admission-fact-set/v1"
ADMISSION_PROOF_SCHEMA = "kungfu.temporal-release-admission-proof/v1"
_SHA1 = re.compile(r"[0-9a-f]{40}\Z")
_DEV_BASE = re.compile(r"dev/v([1-9][0-9]*)/v([1-9][0-9]*)\.[0-9]+\Z")
_MODES = {"dual-read", "legacy-exact"}


def _content_root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value) + b'\n').hexdigest()}"


def _root(value: Any, label: str, issues: list[str]) -> str:
    if not isinstance(value, str) or not ROOT_PATTERN.fullmatch(value):
        issues.append(f"orphan-root:{label}")
        return semantic_root({"invalidRoot": label})
    return value


def _sha(value: Any, label: str, issues: list[str]) -> str:
    if not isinstance(value, str) or not _SHA1.fullmatch(value):
        issues.append(f"orphan-sha:{label}")
        return "0" * 40
    return value


def _protected_dev_base(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    match = _DEV_BASE.fullmatch(value)
    return bool(match and match.group(1) == match.group(2) and int(match.group(1)) >= 4)


def _proof_body(proof: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in proof.items() if key != "proofRoot"}


def _verify_projection(
    projection: Any, issues: list[str]
) -> tuple[str, dict[str, Any]]:
    if (
        not isinstance(projection, dict)
        or projection.get("schema") != PROJECTION_SCHEMA
    ):
        issues.append("unsupported-proof-projection")
        return semantic_root({"invalid": "proof-projection"}), {}
    body = {key: value for key, value in projection.items() if key != "projectionRoot"}
    observed_projection_root = _content_root(body)
    if projection.get("projectionRoot") != observed_projection_root:
        issues.append("proof-projection-root-mismatch")
    registry = projection.get("registry", {})
    proof_roots = registry.get("proofRoots", [])
    registry_identity = {
        "schema": "kungfu.buildchain.compatibility-proof-registry/v1",
        "proofRoots": proof_roots,
    }
    if (
        not isinstance(proof_roots, list)
        or proof_roots != sorted(set(proof_roots))
        or registry.get("registryRoot") != _content_root(registry_identity)
    ):
        issues.append("compatibility-proof-registry-mismatch")
    proofs_by_root: dict[str, Any] = {}
    for proof in projection.get("proofs", []):
        if not isinstance(proof, dict) or proof.get("schema") != PROOF_SCHEMA:
            issues.append("invalid-compatibility-proof")
            continue
        proof_root = proof.get("proofRoot")
        if proof_root != _content_root(_proof_body(proof)):
            issues.append("compatibility-proof-root-mismatch")
            continue
        if proof_root not in proof_roots or proof_root in proofs_by_root:
            issues.append("orphan-or-ambiguous-compatibility-proof")
            continue
        for name in ("scope", "evidence", "authority", "cut"):
            if proof.get(f"{name}Root") != _content_root(proof.get(name)):
                issues.append(f"compatibility-proof-{name}-root-mismatch")
        source = proof.get("source", {})
        target = proof.get("target", {})
        scope = proof.get("scope", {})
        if (
            proof.get("predicate") != "compatible-breaking-digest"
            or proof.get("direction") != "source-to-target"
            or proof.get("operation") != "accept-contract-lock"
            or source.get("contract") != "kungfu-buildchain-runtime-contract-world"
            or target.get("contract") != source.get("contract")
            or target.get("surfaceId") != source.get("surfaceId")
            or target.get("surfaceKind") != source.get("surfaceKind")
            or scope.get("surfaceId") != source.get("surfaceId")
            or scope.get("surfaceKind") != source.get("surfaceKind")
            or scope.get("operation") != proof.get("operation")
            or "v3" not in scope.get("majorLines", [])
        ):
            issues.append("unscoped-compatibility-proof")
        proofs_by_root[proof_root] = proof
    source = projection.get("source", {})
    if (
        source.get("repository") != "kungfu-systems/buildchain"
        or source.get("sourceCommit") != "913b5d3fc486e225cf19f6e677129434db4850a6"
        or source.get("mergeCommit") != "10745d50aa93192c06b13f76942c4c291b482518"
    ):
        issues.append("compatibility-proof-source-mismatch")
    return observed_projection_root, proofs_by_root


def _verify_admission_facts(
    document: Any, issues: list[str]
) -> tuple[str, dict[tuple[str, str], dict[str, Any]], dict[str, list[str]]]:
    if (
        not isinstance(document, dict)
        or set(document)
        != {"schema", "source", "activeProofRoots", "proofs", "factSetRoot"}
        or document.get("schema") != FACT_SET_SCHEMA
    ):
        issues.append("unsupported-admission-fact-set")
        return semantic_root({"invalid": "admission-fact-set"}), {}, {}
    body = {key: value for key, value in document.items() if key != "factSetRoot"}
    observed_root = _content_root(body)
    if document.get("factSetRoot") != observed_root:
        issues.append("admission-fact-set-root-mismatch")
    source = document.get("source", {})
    protected_base = source.get("protectedBase")
    if (
        not isinstance(source, dict)
        or set(source) != {"repository", "protectedBase", "sourceCommit", "mergeCommit"}
        or source.get("repository") != "kungfu-systems/kungfu"
        or not _protected_dev_base(protected_base)
        or not _SHA1.fullmatch(str(source.get("sourceCommit", "")))
        or not _SHA1.fullmatch(str(source.get("mergeCommit", "")))
    ):
        issues.append("admission-fact-source-mismatch")
    active_roots = document.get("activeProofRoots", [])
    if not isinstance(active_roots, list) or active_roots != sorted(set(active_roots)):
        issues.append("invalid-active-admission-proof-roots")
        active_roots = []
    proofs = document.get("proofs", [])
    if not isinstance(proofs, list):
        issues.append("invalid-admission-proofs")
        proofs = []
    by_root: dict[str, dict[str, Any]] = {}
    by_binding: dict[tuple[str, str], dict[str, Any]] = {}
    generated: dict[str, list[str]] = {}
    expected_fields = {
        "schema",
        "proofId",
        "status",
        "channel",
        "acceptedContractDigest",
        "currentContractDigest",
        "pathKind",
        "buildchainProofRoots",
        "reason",
        "scope",
        "scopeRoot",
        "evidence",
        "evidenceRoot",
        "authority",
        "authorityRoot",
        "cut",
        "cutRoot",
    }
    for row in proofs:
        if not isinstance(row, dict) or set(row) != {"proofRoot", "record"}:
            issues.append("invalid-admission-proof")
            continue
        record = row.get("record")
        proof_root = row.get("proofRoot")
        if not isinstance(record, dict) or set(record) != expected_fields:
            issues.append("invalid-admission-proof")
            continue
        if proof_root != _content_root(record):
            issues.append("admission-proof-root-mismatch")
            continue
        if proof_root in by_root:
            issues.append("ambiguous-admission-proof")
            continue
        by_root[proof_root] = record
        for name in ("scope", "evidence", "authority", "cut"):
            if record.get(f"{name}Root") != _content_root(record.get(name)):
                issues.append(f"admission-proof-{name}-root-mismatch")
        channel = record.get("channel")
        accepted_digest = record.get("acceptedContractDigest")
        current_digest = record.get("currentContractDigest")
        for label, value in (
            ("accepted-contract", accepted_digest),
            ("current-contract", current_digest),
        ):
            _root(value, f"admissionProof.{label}", issues)
        scope = record.get("scope", {})
        authority = record.get("authority", {})
        cut = record.get("cut", {})
        buildchain_roots = record.get("buildchainProofRoots")
        if (
            record.get("schema") != ADMISSION_PROOF_SCHEMA
            or record.get("status") != "active"
            or channel not in {"alpha", "release"}
            or record.get("pathKind") not in {"direct", "composed"}
            or not isinstance(record.get("reason"), str)
            or not record.get("reason")
            or not isinstance(buildchain_roots, list)
            or buildchain_roots != sorted(set(buildchain_roots))
            or scope
            != {
                "repository": source.get("repository"),
                "channel": channel,
                "operation": "release-admission",
                "maximumPathDepth": 2,
            }
            or authority
            != {
                "kind": "protected-release-admission-authority",
                "repository": source.get("repository"),
                "protectedBase": protected_base,
            }
            or cut.get("kind") != "protected-git-cut"
            or cut.get("repository") != source.get("repository")
            or cut.get("protectedBase") != protected_base
            or cut.get("commit") != source.get("mergeCommit")
        ):
            issues.append("unscoped-admission-proof")
        binding = (str(channel), str(accepted_digest))
        if binding in by_binding:
            issues.append("ambiguous-admission-binding")
        else:
            by_binding[binding] = record
        generated.setdefault(str(channel), []).append(str(accepted_digest))
    if set(active_roots) != set(by_root):
        issues.append("orphan-admission-proof")
    for channel in generated:
        generated[channel] = sorted(set(generated[channel]))
    return observed_root, by_binding, generated


def _provenance_bindings(
    envelope: Any,
    release_provenance_contract: dict[str, Any],
    admission_contract: dict[str, Any],
    bindings: dict[str, Any],
    issues: list[str],
) -> str:
    report = verify_provenance(
        envelope,
        {
            "phase": "promotion",
            "candidateCommit": bindings.get("sourceSha"),
            "candidateTree": bindings.get("sourceTree"),
            "promotionCommit": bindings.get("promotionSha"),
            "promotionTree": bindings.get("sourceTree"),
        },
    )
    if not report.get("ok"):
        issues.extend(f"release-provenance:{code}" for code in report.get("issues", []))
    if not isinstance(envelope, dict):
        return semantic_root({"invalid": "release-provenance"})
    identities = envelope.get("identities", {})
    if identities.get("contractRoot") != semantic_root(release_provenance_contract):
        issues.append("sealed-contract-root-mismatch")
    if identities.get("qualificationRoot") != bindings.get("qualificationRoot"):
        issues.append("qualification-root-mismatch")
    if identities.get("authorityRoot") != bindings.get("authorityRoot"):
        issues.append("authority-root-mismatch")
    expected_authority_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-external-identity/v1",
            "kind": "authority",
            "identity": admission_contract.get("releaseAuthorityIdentity"),
        }
    )
    if bindings.get("authorityRoot") != expected_authority_root:
        issues.append("release-authority-identity-mismatch")
    if envelope.get("subject", {}).get("identity") != (
        f"release-promotion:{envelope.get('releaseId')}:{bindings.get('qualificationRoot')}"
    ):
        issues.append("qualification-identity-mismatch")
    # Ancestry remains a rooted Git observation, not semantic release
    # authority. Changing it without re-rooting the envelope still fails the
    # release-provenance verifier above.
    return _root(envelope.get("objectRoot"), "releaseProvenance.objectRoot", issues)


def _temporal_receipt(
    *,
    accepted: bool,
    issues: list[str],
    mode: str,
    path_kind: str,
    policy_root: str,
    provenance_root: str,
    admission_fact_set_root: str,
    proof_projection_root: str,
    proof_roots: list[str],
    binding_roots: dict[str, str],
    authority_root: str,
) -> dict[str, Any]:
    cut_root = semantic_root(
        {
            "schema": "kungfu.temporal-release-admission-cut/v1",
            "policyRoot": policy_root,
            "provenanceObjectRoot": provenance_root,
            "admissionFactSetRoot": admission_fact_set_root,
            "proofProjectionRoot": proof_projection_root,
            "bindingRoots": binding_roots,
        }
    )
    predicate = {
        "schema": "kungfu.fact.temporal-predicate/v1",
        "predicateId": "kungfu.release-admission:exact-temporal-path/v1",
        "operations": ["release-admission"],
        "direction": "source-to-target",
        "pathPolicy": "explicit-bounded",
        "cyclePolicy": "forbid",
        "authorityRoot": authority_root,
    }
    predicate_root = record_root(predicate)
    source_root = binding_roots["accepted"]
    target_root = binding_roots["admitted"]
    midpoint_root = semantic_root(
        {
            "schema": "kungfu.temporal-release-admission-proof-set/v1",
            "proofProjectionRoot": proof_projection_root,
            "proofRoots": proof_roots,
        }
    )
    endpoints = (
        [(source_root, target_root)]
        if path_kind == "direct"
        else [(source_root, midpoint_root), (midpoint_root, target_root)]
    )
    relations = []
    for index, (source, target) in enumerate(endpoints, 1):
        relation = {
            "schema": "kungfu.fact.temporal-relation/v1",
            "relationId": f"temporal-release-admission:{path_kind}:{index}",
            "predicateRoot": predicate_root,
            "sourceRoot": source,
            "targetRoot": target if accepted else semantic_root({"rejectedAt": index}),
            "validFromCutRoot": cut_root,
            "scopeRoot": policy_root,
            "authorityRoot": authority_root,
            "admissionRoots": sorted(
                set(
                    [
                        provenance_root,
                        admission_fact_set_root,
                        proof_projection_root,
                        *proof_roots,
                    ]
                )
            ),
        }
        relations.append({"root": record_root(relation), "record": relation})
    bundle = {
        "schema": "kungfu.fact.temporal-bundle/v1",
        "cuts": [
            {
                "root": cut_root,
                "parentCutRoots": [],
                "activeRelationRoots": [row["root"] for row in relations],
                "declarationRoots": [predicate_root],
            }
        ],
        "predicates": [{"root": predicate_root, "record": predicate}],
        "relations": relations,
        "supersessions": [],
        "revocations": [],
        "authorityProofs": [],
        "provenanceObjects": [],
    }
    query = {
        "schema": "kungfu.fact.temporal-path-query/v1",
        "queryId": f"release-admission:{path_kind}:{mode}",
        "operation": "release-admission",
        "predicateRoot": predicate_root,
        "sourceRoot": source_root,
        "targetRoot": target_root,
        "cutRoot": cut_root,
        "relationPathRoots": [row["root"] for row in relations],
        "requiredAuthorityRoot": authority_root,
        "maxDepth": 2,
    }
    path_receipt = verify_path(bundle, query)
    reason_codes = sorted(set(issues))
    diagnostics_root = semantic_root(
        {
            "schema": "kungfu.temporal-release-admission-diagnostics/v1",
            "reasonCodes": reason_codes,
        }
    )
    body = {
        "schema": RECEIPT_SCHEMA,
        "status": "accepted" if accepted else "rejected",
        "mode": mode,
        "pathKind": path_kind,
        "maximumDepth": 2,
        "policyRoot": policy_root,
        "provenanceObjectRoot": provenance_root,
        "admissionFactSetRoot": admission_fact_set_root,
        "proofProjectionRoot": proof_projection_root,
        "buildchainProofRoots": proof_roots,
        "bindingRoots": binding_roots,
        "pathReceiptRoot": path_receipt["root"],
        "pathReceipt": path_receipt["record"],
        "reasonCodes": reason_codes,
        "diagnosticsRoot": diagnostics_root,
        "containsPrivatePayload": False,
    }
    return {**body, "receiptRoot": semantic_root(body)}


def verify_admission(
    *,
    contract: dict[str, Any],
    admission_facts: dict[str, Any],
    proof_projection: dict[str, Any],
    release_provenance_contract: dict[str, Any],
    release_provenance: dict[str, Any],
    current_contract_lock: dict[str, Any],
    legacy_contract_digests: list[str],
    current_contract_digest: str,
    bindings: dict[str, Any],
    mode: str = "dual-read",
) -> dict[str, Any]:
    """Verify one exact admission path and always return a rooted decision."""

    issues: list[str] = []
    if mode not in _MODES:
        issues.append("unsupported-admission-mode")
        mode = "dual-read"
    if contract.get("schema") != "kungfu.temporal-release-admission-contract/v1":
        issues.append("unsupported-admission-contract")
    policy_root = semantic_root(contract)
    fact_set_root, admission_proofs, generated_digests = _verify_admission_facts(
        admission_facts, issues
    )
    if mode == "dual-read":
        projection_root, proofs_by_root = _verify_projection(proof_projection, issues)
    else:
        projection_body = {
            key: value
            for key, value in proof_projection.items()
            if key != "projectionRoot"
        }
        projection_root = _content_root(projection_body)
        proofs_by_root = {}

    expected_binding_fields = {
        "repository",
        "channel",
        "sourceSha",
        "sourceTree",
        "promotionSha",
        "artifactRoot",
        "runtimeSha",
        "acceptedContractDigest",
        "qualificationRoot",
        "approvalRoot",
        "authorityRoot",
    }
    if set(bindings) != expected_binding_fields:
        issues.append("exact-binding-field-mismatch")
    if bindings.get("repository") != "kungfu-systems/kungfu":
        issues.append("repository-mismatch")
    if bindings.get("channel") not in {"alpha", "release"}:
        issues.append("channel-mismatch")
    for field in ("sourceSha", "sourceTree", "promotionSha", "runtimeSha"):
        _sha(bindings.get(field), field, issues)
    for field in (
        "artifactRoot",
        "acceptedContractDigest",
        "qualificationRoot",
        "approvalRoot",
        "authorityRoot",
    ):
        _root(bindings.get(field), field, issues)
    current_contract_digest = _root(
        current_contract_digest, "currentContractDigest", issues
    )
    channel = str(bindings.get("channel"))
    accepted_digest = str(bindings.get("acceptedContractDigest"))
    generated_for_channel = generated_digests.get(channel, [])
    if sorted(set(legacy_contract_digests)) != generated_for_channel:
        issues.append("legacy-generated-projection-mismatch")
    proof = admission_proofs.get((channel, accepted_digest))
    if mode == "dual-read" and proof is None:
        issues.append("temporal-contract-not-admitted")
    if proof is None:
        proof = {}
    if mode == "legacy-exact" and accepted_digest not in legacy_contract_digests:
        issues.append("legacy-contract-not-admitted")
    proof_roots = proof.get("buildchainProofRoots", [])
    path_kind = proof.get("pathKind", "composed")
    if proof and proof.get("currentContractDigest") != current_contract_digest:
        issues.append("admission-proof-current-contract-mismatch")
    evidence = proof.get("evidence", {})
    if mode == "dual-read" and evidence.get("kind") == (
        "sealed-alpha-recovery-and-compatibility"
    ):
        sealed_bindings = {
            "sourceSha": "sourceSha",
            "sourceTree": "sourceTree",
            "artifactRoot": "artifactRoot",
            "runtimeSha": "runtimeSha",
            "qualificationRoot": "qualificationRoot",
            "approvalRoot": "approvalRoot",
        }
        for binding_field, evidence_field in sealed_bindings.items():
            if bindings.get(binding_field) != evidence.get(evidence_field):
                issues.append(f"sealed-candidate-{binding_field}-mismatch")
    if path_kind not in {"direct", "composed"}:
        issues.append("unsupported-path-kind")
        path_kind = "composed"
    if (
        mode == "dual-read"
        and path_kind == "direct"
        and (
            bindings.get("acceptedContractDigest") != current_contract_digest
            or proof_roots != []
        )
    ):
        issues.append("direct-path-not-exact")
    if (
        mode == "dual-read"
        and path_kind == "composed"
        and (not proof_roots or len(proof_roots) > 3)
    ):
        issues.append("composed-path-bound-mismatch")

    current_surfaces = {
        row.get("id"): row.get("breakingDigest")
        for row in current_contract_lock.get("buildchain", {}).get("surfaces", [])
    }
    if mode == "dual-read":
        for proof_root in proof_roots:
            proof = proofs_by_root.get(proof_root)
            if proof is None:
                issues.append("orphan-compatibility-proof")
            elif (
                current_surfaces.get(proof["target"]["surfaceId"])
                != proof["target"]["breakingDigest"]
            ):
                issues.append("compatibility-proof-target-mismatch")
    required_surfaces = set(contract.get("requiredReleaseSurfaces", []))
    observed_surfaces = {
        proofs_by_root[root]["target"]["surfaceId"]
        for root in proof_roots
        if root in proofs_by_root
    }
    if (
        mode == "dual-read"
        and path_kind == "composed"
        and observed_surfaces != required_surfaces
    ):
        issues.append("compatibility-proof-scope-mismatch")

    provenance_root = _provenance_bindings(
        release_provenance,
        release_provenance_contract,
        contract,
        bindings,
        issues,
    )
    accepted_binding = {
        "repository": bindings.get("repository"),
        "channel": bindings.get("channel"),
        "sourceSha": bindings.get("sourceSha"),
        "sourceTree": bindings.get("sourceTree"),
        "candidateObjectRoot": provenance_root,
        "artifactRoot": bindings.get("artifactRoot"),
        "runtimeSha": bindings.get("runtimeSha"),
        "contractDigest": bindings.get("acceptedContractDigest"),
        "qualificationRoot": bindings.get("qualificationRoot"),
        "approvalRoot": bindings.get("approvalRoot"),
        "authorityRoot": bindings.get("authorityRoot"),
    }
    admitted_binding = {**accepted_binding, "contractDigest": current_contract_digest}
    binding_roots = {
        "accepted": semantic_root(
            {
                "schema": "kungfu.temporal-release-admission-binding/v1",
                "role": "request",
                **accepted_binding,
            }
        ),
        "admitted": semantic_root(
            {
                "schema": "kungfu.temporal-release-admission-binding/v1",
                "role": "current-admission",
                **admitted_binding,
            }
        ),
    }

    if mode == "legacy-exact":
        path_kind = "direct"
        proof_roots = []
        # Rollback preserves the prior exact whitelist semantics. It does not
        # rewrite the provenance object, proof registry, or any historical Cut.
        binding_roots["admitted"] = semantic_root(
            {
                "schema": "kungfu.temporal-release-admission-binding/v1",
                "role": "legacy-exact-rollback",
                **accepted_binding,
            }
        )
    accepted = not issues
    receipt = _temporal_receipt(
        accepted=accepted,
        issues=issues,
        mode=mode,
        path_kind=path_kind,
        policy_root=policy_root,
        provenance_root=provenance_root,
        admission_fact_set_root=fact_set_root,
        proof_projection_root=projection_root,
        proof_roots=proof_roots,
        binding_roots=binding_roots,
        authority_root=_root(bindings.get("authorityRoot"), "authorityRoot", issues),
    )
    return {"ok": accepted, "receipt": receipt}


def clone(value: Any) -> Any:
    """Return a deep copy for rollback immutability tests and consumers."""

    return deepcopy(value)
