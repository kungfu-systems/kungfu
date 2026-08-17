# SPDX-License-Identifier: Apache-2.0

"""Fact-backed temporal release admission for Kungfu publication inputs."""

from __future__ import annotations

import hashlib
import re
from copy import deepcopy
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.release_provenance import semantic_root, verify as verify_provenance
from kungfu.storage.fact_root_canonical import (
    ROOT_PATTERN,
    TemporalRelationError,
    record_root,
    verify_path,
)

RECEIPT_SCHEMA = "kungfu.temporal-release-admission-receipt/v1"
PROOF_SCHEMA = "kungfu.buildchain.compatibility-proof/v1"
FACT_PROJECTION_SCHEMA = "kungfu.buildchain.compatibility-fact-projection/v1"
FACT_SCHEMA = "kungfu.buildchain.compatibility-fact/v1"
FACT_REGISTRY_SCHEMA = "kungfu.buildchain.compatibility-fact-registry/v1"
FACT_SET_SCHEMA = "kungfu.temporal-release-admission-fact-set/v1"
ADMISSION_PROOF_SCHEMA = "kungfu.temporal-release-admission-proof/v1"
ROLLBACK_CONTRACT_SCHEMA = "kungfu.temporal-release-admission-rollback/v1"
ROLLBACK_RECEIPT_SCHEMA = "kungfu.temporal-release-admission-rollback-receipt/v1"
FACT_SELECTION_RECEIPT_SCHEMA = (
    "kungfu.temporal-release-admission-fact-selection-receipt/v1"
)
_SHA1 = re.compile(r"[0-9a-f]{40}\Z")
_DEV_BASE = re.compile(r"dev/v([1-9][0-9]*)/v([1-9][0-9]*)\.[0-9]+\Z")
_MODES = {"fact-only"}


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


def _fact_record_root(value: Any, label: str, issues: list[str]) -> str:
    try:
        return record_root(value)
    except (TemporalRelationError, TypeError, ValueError):
        issues.append(f"invalid-fact-record:{label}")
        return semantic_root({"invalidFactRecord": label})


def _verify_admission_contract(
    contract: dict[str, Any], issues: list[str]
) -> dict[str, Any]:
    fact_authority = contract.get("factAuthority", {})
    if (
        contract.get("schema") != "kungfu.temporal-release-admission-contract/v1"
        or contract.get("defaultMode") != "fact-only"
        or contract.get("normalModes") != ["fact-only"]
        or "dualRead" in contract
        or "rollbackMode" in contract
        or not isinstance(fact_authority, dict)
        or set(fact_authority)
        != {
            "admissionFacts",
            "buildchainFacts",
            "buildchainFactRegistryRoot",
            "buildchainFactCutRoot",
            "buildchainFactProjectionRoot",
            "activeSelection",
            "admittedDigests",
            "orphanPolicy",
            "pathAuthority",
        }
        or fact_authority.get("admissionFacts")
        != "docs/qualification/evidence/kungfu-temporal-release-admission-facts.json"
        or fact_authority.get("buildchainFacts")
        != "docs/qualification/evidence/buildchain-compatibility-fact-projection.json"
        or fact_authority.get("activeSelection") != "activeProofRoots"
        or fact_authority.get("admittedDigests") != "derived-from-active-proof-records"
        or fact_authority.get("orphanPolicy") != "reject"
        or fact_authority.get("pathAuthority")
        != "exact-buildchain-Fact-roots-and-receipts"
    ):
        issues.append("unsupported-admission-contract")
        return fact_authority if isinstance(fact_authority, dict) else {}
    for field in (
        "buildchainFactRegistryRoot",
        "buildchainFactCutRoot",
        "buildchainFactProjectionRoot",
    ):
        _root(fact_authority.get(field), f"contract.factAuthority.{field}", issues)
    return fact_authority


def _verify_buildchain_facts(
    projection: Any, fact_authority: dict[str, Any], issues: list[str]
) -> tuple[str, dict[str, dict[str, Any]], dict[str, Any], str, list[str]]:
    """Verify the protected Buildchain Fact registry projection byte-for-byte."""

    expected_fields = {
        "schema",
        "source",
        "rootProtocol",
        "contractWorld",
        "currentCut",
        "supersessions",
        "revocations",
        "selectedFactRoots",
        "facts",
        "projectionRoot",
    }
    if (
        not isinstance(projection, dict)
        or set(projection) != expected_fields
        or projection.get("schema") != FACT_PROJECTION_SCHEMA
    ):
        issues.append("unsupported-buildchain-fact-projection")
        return semantic_root({"invalid": "buildchain-facts"}), {}, {}, "", []
    body = {key: value for key, value in projection.items() if key != "projectionRoot"}
    projection_root = _content_root(body)
    if projection.get("projectionRoot") != projection_root:
        issues.append("buildchain-fact-projection-root-mismatch")

    source = projection.get("source", {})
    if not isinstance(source, dict):
        issues.append("buildchain-fact-source-mismatch")
        source = {}
    if (
        set(source) != {"repository", "protectedBase", "sourceCommit", "mergeCommit"}
        or source.get("repository") != "kungfu-systems/buildchain"
        or source.get("protectedBase") != "dev/v3/v3.0"
    ):
        issues.append("buildchain-fact-source-mismatch")
    _sha(source.get("sourceCommit"), "buildchainFacts.sourceCommit", issues)
    _sha(source.get("mergeCommit"), "buildchainFacts.mergeCommit", issues)
    if projection.get("rootProtocol") != "kungfu.fact-root.canonical/v2":
        issues.append("buildchain-fact-root-protocol-mismatch")

    world = projection.get("contractWorld", {})
    if not isinstance(world, dict):
        issues.append("buildchain-fact-contract-world-mismatch")
        world = {}
    if set(world) != {
        "contractDigest",
        "compatibilityDigest",
        "factRegistryRoot",
        "factCutRoot",
        "proofRegistryRoot",
    }:
        issues.append("buildchain-fact-contract-world-mismatch")
        world = {}
    for field in world:
        _root(world.get(field), f"buildchainFacts.contractWorld.{field}", issues)

    facts = projection.get("facts", [])
    if not isinstance(facts, list):
        issues.append("invalid-buildchain-facts")
        facts = []
    by_root: dict[str, dict[str, Any]] = {}
    predicate_entries: dict[str, dict[str, Any]] = {}
    relation_entries: list[dict[str, Any]] = []
    proof_roots: list[str] = []
    for fact in facts:
        if not isinstance(fact, dict) or set(fact) != {
            "schema",
            "factId",
            "factRoot",
            "sourceRoot",
            "targetRoot",
            "predicate",
            "relation",
            "proof",
        }:
            issues.append("invalid-buildchain-fact")
            continue
        if fact.get("schema") != FACT_SCHEMA:
            issues.append("unsupported-buildchain-fact")
            continue
        proof = fact.get("proof", {})
        if not isinstance(proof, dict):
            issues.append("invalid-buildchain-proof")
            continue
        proof_root = _root(
            proof.get("proofRoot"), f"buildchainFact.{fact.get('factId')}.proof", issues
        )
        if proof_root != _content_root(_proof_body(proof)):
            issues.append("buildchain-proof-root-mismatch")
        for name in ("scope", "evidence", "authority", "cut"):
            if proof.get(f"{name}Root") != _content_root(proof.get(name)):
                issues.append(f"buildchain-proof-{name}-root-mismatch")
        proof_source = proof.get("source", {})
        proof_target = proof.get("target", {})
        proof_scope = proof.get("scope", {})
        if not isinstance(proof_source, dict):
            proof_source = {}
        if not isinstance(proof_target, dict):
            proof_target = {}
        if not isinstance(proof_scope, dict):
            proof_scope = {}
        major_lines = proof_scope.get("majorLines", [])
        if not isinstance(major_lines, list):
            major_lines = []
        if (
            proof.get("schema") != PROOF_SCHEMA
            or proof.get("predicate") != "compatible-breaking-digest"
            or proof.get("direction") != "source-to-target"
            or proof.get("operation") != "accept-contract-lock"
            or proof_source.get("contract")
            != "kungfu-buildchain-runtime-contract-world"
            or proof_target.get("contract")
            != "kungfu-buildchain-runtime-contract-world"
            or proof_source.get("surfaceId") != proof_target.get("surfaceId")
            or proof_source.get("surfaceKind") != proof_target.get("surfaceKind")
            or proof_scope.get("operation") != "accept-contract-lock"
            or "v3" not in major_lines
        ):
            issues.append("unscoped-buildchain-fact")
        if fact.get("sourceRoot") != _content_root(proof_source):
            issues.append("buildchain-fact-source-root-mismatch")
        if fact.get("targetRoot") != _content_root(proof_target):
            issues.append("buildchain-fact-target-root-mismatch")
        predicate = fact.get("predicate", {})
        relation = fact.get("relation", {})
        if not isinstance(predicate, dict):
            predicate = {}
            issues.append("invalid-buildchain-fact-predicate")
        if not isinstance(relation, dict):
            relation = {}
            issues.append("invalid-buildchain-fact-relation")
        predicate_record = predicate.get("record", {})
        relation_record = relation.get("record", {})
        if not isinstance(predicate_record, dict):
            predicate_record = {}
        if not isinstance(relation_record, dict):
            relation_record = {}
        predicate_root = _fact_record_root(
            predicate_record, f"{fact.get('factId')}.predicate", issues
        )
        relation_root = _fact_record_root(
            relation_record, f"{fact.get('factId')}.relation", issues
        )
        if predicate.get("root") != predicate_root:
            issues.append("buildchain-fact-predicate-root-mismatch")
        if relation.get("root") != relation_root:
            issues.append("buildchain-fact-relation-root-mismatch")
        if (
            fact.get("factRoot") != relation.get("root")
            or relation_record.get("predicateRoot") != predicate.get("root")
            or relation_record.get("sourceRoot") != fact.get("sourceRoot")
            or relation_record.get("targetRoot") != fact.get("targetRoot")
            or relation_record.get("scopeRoot") != proof.get("scopeRoot")
            or relation_record.get("authorityRoot") != proof.get("authorityRoot")
            or relation_record.get("validFromCutRoot") != proof.get("cutRoot")
            or relation_record.get("admissionRoots") != [proof.get("evidenceRoot")]
        ):
            issues.append("buildchain-fact-binding-mismatch")
        fact_root = _root(
            fact.get("factRoot"),
            f"buildchainFact.{fact.get('factId')}.factRoot",
            issues,
        )
        if fact_root in by_root:
            issues.append("ambiguous-buildchain-fact")
            continue
        by_root[fact_root] = fact
        predicate_entries[predicate_root] = {
            "root": predicate_root,
            "record": predicate_record,
        }
        relation_entries.append({"root": relation_root, "record": relation_record})
        proof_roots.append(proof_root)

    if list(by_root) != sorted(by_root):
        issues.append("buildchain-facts-not-canonical")
    selected_roots = projection.get("selectedFactRoots", [])
    if (
        not isinstance(selected_roots, list)
        or selected_roots != sorted(set(selected_roots))
        or any(root not in by_root for root in selected_roots)
    ):
        issues.append("invalid-selected-buildchain-fact-roots")

    current_cut = projection.get("currentCut", {})
    current_cut_root = _content_root(current_cut)
    if current_cut_root != world.get("factCutRoot"):
        issues.append("buildchain-fact-cut-root-mismatch")
    predicates = sorted(predicate_entries.values(), key=lambda row: row.get("root", ""))
    relations = sorted(relation_entries, key=lambda row: row.get("root", ""))
    leaf_cuts: dict[str, dict[str, Any]] = {}
    declaration_roots = [row.get("root") for row in predicates]
    for fact in by_root.values():
        cut_root = _root(
            fact.get("proof", {}).get("cutRoot"),
            f"buildchainFact.{fact.get('factId')}.cutRoot",
            issues,
        )
        cut = leaf_cuts.setdefault(
            cut_root,
            {
                "root": cut_root,
                "parentCutRoots": [],
                "activeRelationRoots": [],
                "declarationRoots": declaration_roots,
            },
        )
        cut["activeRelationRoots"].append(fact.get("factRoot"))
        cut["activeRelationRoots"].sort()
    cuts = sorted(leaf_cuts.values(), key=lambda row: row.get("root", ""))
    if current_cut_root in leaf_cuts:
        leaf_cuts[current_cut_root]["activeRelationRoots"] = sorted(by_root)
    else:
        cuts.append(
            {
                "root": current_cut_root,
                "parentCutRoots": sorted(leaf_cuts),
                "activeRelationRoots": sorted(by_root),
                "declarationRoots": declaration_roots,
            }
        )

    def lifecycle_entries(values: Any, kind: str) -> list[dict[str, Any]]:
        if not isinstance(values, list):
            issues.append(f"invalid-buildchain-{kind}")
            return []
        entries = [
            {
                "root": _fact_record_root(value, f"buildchain.{kind}", issues),
                "record": value,
            }
            for value in values
        ]
        return sorted(entries, key=lambda row: row["root"])

    supersessions = lifecycle_entries(projection.get("supersessions"), "supersessions")
    revocations = lifecycle_entries(projection.get("revocations"), "revocations")
    bundle = {
        "schema": "kungfu.fact.temporal-bundle/v1",
        "cuts": cuts,
        "predicates": predicates,
        "relations": relations,
        "supersessions": supersessions,
        "revocations": revocations,
        "authorityProofs": [],
        "provenanceObjects": [],
    }
    registry_identity = {
        "schema": FACT_REGISTRY_SCHEMA,
        "rootProtocol": projection.get("rootProtocol"),
        "currentCutRoot": current_cut_root,
        "predicateRoots": declaration_roots,
        "factRoots": sorted(by_root),
        "supersessionRoots": [row["root"] for row in supersessions],
        "revocationRoots": [row["root"] for row in revocations],
        "legacyProofRoots": sorted(proof_roots),
        "temporalBundleRoot": _content_root(bundle),
    }
    if _content_root(registry_identity) != world.get("factRegistryRoot"):
        issues.append("buildchain-fact-registry-root-mismatch")
    proof_registry = {
        "schema": "kungfu.buildchain.compatibility-proof-registry/v1",
        "proofRoots": sorted(proof_roots),
    }
    if _content_root(proof_registry) != world.get("proofRegistryRoot"):
        issues.append("buildchain-proof-registry-root-mismatch")
    if (
        fact_authority.get("buildchainFactRegistryRoot")
        != world.get("factRegistryRoot")
        or fact_authority.get("buildchainFactCutRoot") != current_cut_root
        or fact_authority.get("buildchainFactProjectionRoot") != projection_root
    ):
        issues.append("buildchain-fact-authority-root-mismatch")
    return projection_root, by_root, bundle, current_cut_root, selected_roots


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
    if not isinstance(source, dict):
        issues.append("admission-fact-source-mismatch")
        source = {}
    protected_base = source.get("protectedBase")
    if (
        set(source) != {"repository", "protectedBase", "sourceCommit", "mergeCommit"}
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
        "buildchainFactRoots",
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
        if not isinstance(scope, dict):
            scope = {}
        if not isinstance(authority, dict):
            authority = {}
        if not isinstance(cut, dict):
            cut = {}
        buildchain_roots = record.get("buildchainFactRoots")
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
            by_binding[binding] = {"proofRoot": proof_root, "record": record}
        generated.setdefault(str(channel), []).append(str(accepted_digest))
    if set(active_roots) != set(by_root):
        issues.append("orphan-admission-proof")
    for channel in generated:
        generated[channel] = sorted(set(generated[channel]))
    return observed_root, by_binding, generated


def _verify_compatibility_fact_paths(
    *,
    contract: dict[str, Any],
    current_contract_lock: dict[str, Any],
    fact_roots: list[str],
    selected_fact_roots: list[str],
    buildchain_facts: dict[str, dict[str, Any]],
    temporal_bundle: dict[str, Any],
    fact_cut_root: str,
    path_kind: str,
    issues: list[str],
) -> list[str]:
    """Verify the exact Buildchain Fact paths selected by one admission Fact."""

    if any(root not in selected_fact_roots for root in fact_roots):
        issues.append("unselected-compatibility-fact")
    current_surfaces = {
        row.get("id"): row.get("breakingDigest")
        for row in current_contract_lock.get("buildchain", {}).get("surfaces", [])
    }
    path_receipt_roots: list[str] = []
    observed_surfaces: set[str] = set()
    for fact_root in fact_roots:
        fact = buildchain_facts.get(fact_root)
        if fact is None:
            issues.append("orphan-compatibility-fact")
            continue
        buildchain_proof = fact.get("proof", {})
        if not isinstance(buildchain_proof, dict):
            buildchain_proof = {}
        target = buildchain_proof.get("target", {})
        if not isinstance(target, dict):
            target = {}
        surface_id = target.get("surfaceId")
        if isinstance(surface_id, str):
            observed_surfaces.add(surface_id)
        if current_surfaces.get(surface_id) != target.get("breakingDigest"):
            issues.append("compatibility-fact-target-mismatch")
        predicate = fact.get("predicate", {})
        predicate_root = predicate.get("root") if isinstance(predicate, dict) else None
        query = {
            "schema": "kungfu.fact.temporal-path-query/v1",
            "queryId": f"release-admission:buildchain-fact:{fact_root}",
            "operation": "accept-contract-lock",
            "predicateRoot": _root(
                predicate_root, f"compatibilityFact.{fact_root}.predicateRoot", issues
            ),
            "sourceRoot": _root(
                fact.get("sourceRoot"),
                f"compatibilityFact.{fact_root}.sourceRoot",
                issues,
            ),
            "targetRoot": _root(
                fact.get("targetRoot"),
                f"compatibilityFact.{fact_root}.targetRoot",
                issues,
            ),
            "cutRoot": fact_cut_root,
            "relationPathRoots": [fact_root],
            "requiredAuthorityRoot": _root(
                buildchain_proof.get("authorityRoot"),
                f"compatibilityFact.{fact_root}.authorityRoot",
                issues,
            ),
            "maxDepth": 1,
        }
        path_receipt = verify_path(temporal_bundle, query)
        path_receipt_roots.append(path_receipt["root"])
        if path_receipt["record"].get("status") != "accepted":
            issues.append(
                "compatibility-path:"
                + str(path_receipt["record"].get("failureCode") or "rejected")
            )
    required_surfaces = set(contract.get("requiredReleaseSurfaces", []))
    if path_kind == "composed" and observed_surfaces != required_surfaces:
        issues.append("compatibility-fact-scope-mismatch")
    return sorted(path_receipt_roots)


def verify_contract_selection(
    *,
    contract: dict[str, Any],
    admission_facts: dict[str, Any],
    compatibility_facts: dict[str, Any],
    current_contract_lock: dict[str, Any],
    channel: str,
    accepted_contract_digest: str,
    current_contract_digest: str,
) -> dict[str, Any]:
    """Select a contract only through one active admission Fact and exact Fact paths."""

    issues: list[str] = []
    fact_authority = _verify_admission_contract(contract, issues)
    policy_root = semantic_root(contract)
    fact_set_root, admission_proofs, _generated_digests = _verify_admission_facts(
        admission_facts, issues
    )
    (
        fact_projection_root,
        buildchain_facts,
        temporal_bundle,
        fact_cut_root,
        selected_fact_roots,
    ) = _verify_buildchain_facts(compatibility_facts, fact_authority, issues)
    if channel not in {"alpha", "release"}:
        issues.append("channel-mismatch")
    accepted_contract_digest = _root(
        accepted_contract_digest, "acceptedContractDigest", issues
    )
    current_contract_digest = _root(
        current_contract_digest, "currentContractDigest", issues
    )
    proof_row = admission_proofs.get((channel, accepted_contract_digest))
    if proof_row is None:
        issues.append("temporal-contract-not-admitted")
        proof_row = {
            "proofRoot": semantic_root({"invalid": "admission-proof"}),
            "record": {},
        }
    proof = proof_row["record"]
    if proof and proof.get("currentContractDigest") != current_contract_digest:
        issues.append("admission-proof-current-contract-mismatch")
    fact_roots = proof.get("buildchainFactRoots", [])
    path_kind = proof.get("pathKind", "composed")
    if path_kind not in {"direct", "composed"}:
        issues.append("unsupported-path-kind")
        path_kind = "composed"
    if path_kind == "direct" and (
        accepted_contract_digest != current_contract_digest or fact_roots != []
    ):
        issues.append("direct-path-not-exact")
    if path_kind == "composed" and (not fact_roots or len(fact_roots) > 3):
        issues.append("composed-path-bound-mismatch")
    path_receipt_roots = _verify_compatibility_fact_paths(
        contract=contract,
        current_contract_lock=current_contract_lock,
        fact_roots=fact_roots,
        selected_fact_roots=selected_fact_roots,
        buildchain_facts=buildchain_facts,
        temporal_bundle=temporal_bundle,
        fact_cut_root=fact_cut_root,
        path_kind=path_kind,
        issues=issues,
    )
    reason_codes = sorted(set(issues))
    body = {
        "schema": FACT_SELECTION_RECEIPT_SCHEMA,
        "status": "accepted" if not issues else "rejected",
        "channel": channel,
        "pathKind": path_kind,
        "acceptedContractDigest": accepted_contract_digest,
        "currentContractDigest": current_contract_digest,
        "policyRoot": policy_root,
        "admissionFactSetRoot": fact_set_root,
        "admissionProofRoot": proof_row["proofRoot"],
        "factProjectionRoot": fact_projection_root,
        "factCutRoot": fact_cut_root,
        "buildchainFactRoots": fact_roots,
        "compatibilityPathReceiptRoots": path_receipt_roots,
        "reasonCodes": reason_codes,
        "containsPrivatePayload": False,
    }
    receipt = {**body, "receiptRoot": semantic_root(body)}
    return {"ok": not issues, "receipt": receipt}


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
    admission_proof_root: str,
    fact_projection_root: str,
    fact_roots: list[str],
    compatibility_path_receipt_roots: list[str],
    binding_roots: dict[str, str],
    authority_root: str,
) -> dict[str, Any]:
    cut_root = semantic_root(
        {
            "schema": "kungfu.temporal-release-admission-cut/v1",
            "policyRoot": policy_root,
            "provenanceObjectRoot": provenance_root,
            "admissionFactSetRoot": admission_fact_set_root,
            "admissionProofRoot": admission_proof_root,
            "factProjectionRoot": fact_projection_root,
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
            "factProjectionRoot": fact_projection_root,
            "factRoots": fact_roots,
            "compatibilityPathReceiptRoots": compatibility_path_receipt_roots,
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
                        admission_proof_root,
                        fact_projection_root,
                        *fact_roots,
                        *compatibility_path_receipt_roots,
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
        "admissionProofRoot": admission_proof_root,
        "factProjectionRoot": fact_projection_root,
        "buildchainFactRoots": fact_roots,
        "compatibilityPathReceiptRoots": compatibility_path_receipt_roots,
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
    compatibility_facts: dict[str, Any],
    release_provenance_contract: dict[str, Any],
    release_provenance: dict[str, Any],
    current_contract_lock: dict[str, Any],
    current_contract_digest: str,
    bindings: dict[str, Any],
    mode: str = "fact-only",
) -> dict[str, Any]:
    """Verify one exact admission path and always return a rooted decision."""

    issues: list[str] = []
    if mode not in _MODES:
        issues.append("unsupported-admission-mode")
        mode = "fact-only"
    fact_authority = _verify_admission_contract(contract, issues)
    policy_root = semantic_root(contract)
    fact_set_root, admission_proofs, _generated_digests = _verify_admission_facts(
        admission_facts, issues
    )
    (
        fact_projection_root,
        buildchain_facts,
        temporal_bundle,
        fact_cut_root,
        selected_fact_roots,
    ) = _verify_buildchain_facts(compatibility_facts, fact_authority, issues)

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
    proof_row = admission_proofs.get((channel, accepted_digest))
    if proof_row is None:
        issues.append("temporal-contract-not-admitted")
        proof_row = {
            "proofRoot": semantic_root({"invalid": "admission-proof"}),
            "record": {},
        }
    proof = proof_row["record"]
    fact_roots = proof.get("buildchainFactRoots", [])
    path_kind = proof.get("pathKind", "composed")
    if proof and proof.get("currentContractDigest") != current_contract_digest:
        issues.append("admission-proof-current-contract-mismatch")
    evidence = proof.get("evidence", {})
    if not isinstance(evidence, dict):
        evidence = {}
    if evidence.get("kind") == "sealed-alpha-recovery-and-compatibility":
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
    if path_kind == "direct" and (
        bindings.get("acceptedContractDigest") != current_contract_digest
        or fact_roots != []
    ):
        issues.append("direct-path-not-exact")
    if path_kind == "composed" and (not fact_roots or len(fact_roots) > 3):
        issues.append("composed-path-bound-mismatch")

    compatibility_path_receipt_roots = _verify_compatibility_fact_paths(
        contract=contract,
        current_contract_lock=current_contract_lock,
        fact_roots=fact_roots,
        selected_fact_roots=selected_fact_roots,
        buildchain_facts=buildchain_facts,
        temporal_bundle=temporal_bundle,
        fact_cut_root=fact_cut_root,
        path_kind=path_kind,
        issues=issues,
    )

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

    accepted = not issues
    receipt = _temporal_receipt(
        accepted=accepted,
        issues=issues,
        mode=mode,
        path_kind=path_kind,
        policy_root=policy_root,
        provenance_root=provenance_root,
        admission_fact_set_root=fact_set_root,
        admission_proof_root=proof_row["proofRoot"],
        fact_projection_root=fact_projection_root,
        fact_roots=fact_roots,
        compatibility_path_receipt_roots=sorted(compatibility_path_receipt_roots),
        binding_roots=binding_roots,
        authority_root=_root(bindings.get("authorityRoot"), "authorityRoot", issues),
    )
    return {"ok": accepted, "receipt": receipt}


def verify_rollback(
    *,
    rollback_contract: dict[str, Any],
    admission_contract: dict[str, Any],
    admission_facts: dict[str, Any],
    release_provenance_contract: dict[str, Any],
    release_provenance: dict[str, Any],
    bindings: dict[str, Any],
) -> dict[str, Any]:
    """Reproduce the sealed exact-list rollback outside normal admission."""

    issues: list[str] = []
    if rollback_contract.get("schema") != ROLLBACK_CONTRACT_SCHEMA:
        issues.append("unsupported-rollback-contract")
    body = {key: value for key, value in rollback_contract.items() if key != "sealRoot"}
    if rollback_contract.get("sealRoot") != _content_root(body):
        issues.append("rollback-seal-root-mismatch")
    if (
        rollback_contract.get("status") != "sealed"
        or rollback_contract.get("normalAdmissionEligible") is not False
        or rollback_contract.get("invocation", {}).get("mode") != "offline-explicit"
        or rollback_contract.get("invocation", {}).get("environmentSelection")
        != "forbidden"
        or not rollback_contract.get("retirement", {}).get("decision")
    ):
        issues.append("rollback-boundary-mismatch")
    if admission_contract.get("rollback") != {
        "contract": "framework/release/kungfu-temporal-release-rollback.contract.json",
        "normalAdmissionEligible": False,
        "invocation": "offline-explicit-only",
    }:
        issues.append("rollback-admission-contract-mismatch")
    source_fact_set_root = _root(
        rollback_contract.get("sourceFactSetRoot"), "rollback.sourceFactSetRoot", issues
    )
    observed_fact_set_root, admission_proofs, _generated_digests = (
        _verify_admission_facts(admission_facts, issues)
    )
    if observed_fact_set_root != source_fact_set_root:
        issues.append("rollback-source-fact-set-mismatch")
    projections = rollback_contract.get("digestProjections", {})
    if not isinstance(projections, dict) or set(projections) != {"alpha", "release"}:
        issues.append("rollback-projections-mismatch")
        projections = {}
    for projection_channel, candidate in projections.items():
        if not isinstance(candidate, dict) or set(candidate) != {
            "schema",
            "authority",
            "sourceFactSetRoot",
            "entries",
            "projectionRoot",
        }:
            issues.append("rollback-projection-schema-mismatch")
            continue
        projection_body = {
            key: value for key, value in candidate.items() if key != "projectionRoot"
        }
        if (
            candidate.get("schema")
            != "kungfu.temporal-release-admission-digest-projection/v1"
            or candidate.get("authority") != "non-authoritative"
            or candidate.get("sourceFactSetRoot") != source_fact_set_root
            or candidate.get("projectionRoot") != _content_root(projection_body)
        ):
            issues.append("rollback-projection-root-mismatch")
        entries = candidate.get("entries", [])
        if (
            not isinstance(entries, list)
            or entries
            != sorted(entries, key=lambda entry: str(entry.get("contractDigest", "")))
            or len(entries)
            != len(
                {
                    entry.get("contractDigest")
                    for entry in entries
                    if isinstance(entry, dict)
                }
            )
        ):
            issues.append("rollback-projection-entries-mismatch")
            continue
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {
                "contractDigest",
                "sourceProofRoot",
            }:
                issues.append("rollback-projection-entry-mismatch")
                continue
            _root(
                entry.get("contractDigest"),
                f"rollback.{projection_channel}.contractDigest",
                issues,
            )
            _root(
                entry.get("sourceProofRoot"),
                f"rollback.{projection_channel}.sourceProofRoot",
                issues,
            )
    channel = str(bindings.get("channel"))
    accepted_digest = str(bindings.get("acceptedContractDigest"))
    projection = projections.get(channel, {})
    entries = projection.get("entries", []) if isinstance(projection, dict) else []
    matches = [
        entry
        for entry in entries
        if entry.get("contractDigest") == accepted_digest
        and isinstance(entry.get("sourceProofRoot"), str)
        and ROOT_PATTERN.fullmatch(entry["sourceProofRoot"])
    ]
    if len(matches) != 1:
        issues.append("rollback-contract-not-admitted")
    if projection.get("authority") != "non-authoritative":
        issues.append("rollback-projection-authority-mismatch")
    admission_proof = admission_proofs.get((channel, accepted_digest))
    if len(matches) == 1 and (
        admission_proof is None
        or admission_proof.get("proofRoot") != matches[0]["sourceProofRoot"]
    ):
        issues.append("rollback-source-proof-mismatch")

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
    provenance_root = _provenance_bindings(
        release_provenance,
        release_provenance_contract,
        admission_contract,
        bindings,
        issues,
    )
    reason_codes = sorted(set(issues))
    receipt_body = {
        "schema": ROLLBACK_RECEIPT_SCHEMA,
        "status": "verified" if not issues else "rejected",
        "mode": "offline-explicit",
        "normalAdmissionEligible": False,
        "externalPublicationClaimed": False,
        "rollbackSealRoot": rollback_contract.get("sealRoot"),
        "sourceFactSetRoot": rollback_contract.get("sourceFactSetRoot"),
        "sourceProofRoot": matches[0]["sourceProofRoot"] if len(matches) == 1 else "",
        "provenanceObjectRoot": provenance_root,
        "bindingRoot": semantic_root(
            {
                "schema": "kungfu.temporal-release-admission-binding/v1",
                "role": "sealed-offline-rollback",
                **bindings,
            }
        ),
        "reasonCodes": reason_codes,
        "containsPrivatePayload": False,
    }
    receipt = {**receipt_body, "receiptRoot": semantic_root(receipt_body)}
    return {"ok": not issues, "receipt": receipt}


def clone(value: Any) -> Any:
    """Return a deep copy for rollback immutability tests and consumers."""

    return deepcopy(value)
