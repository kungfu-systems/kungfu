# SPDX-License-Identifier: Apache-2.0

"""Protected Buildchain Fact projection verification for temporal admission."""

from __future__ import annotations

import hashlib
import re
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.release_provenance import semantic_root
from kungfu.storage.fact_root_canonical import (
    ROOT_PATTERN,
    TemporalRelationError,
    record_root,
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
