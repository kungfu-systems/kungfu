# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
import hashlib
import json
from pathlib import Path

from kungfu.storage import fact_root_canonical as temporal_relation

ROOT = Path(__file__).resolve().parents[4]
FIXTURE = ROOT / "tests/fixtures/temporal-relation-contract/cases.json"
CONTRACT = ROOT / "framework/core/fact/kungfu-fact-cut-kernel.contract.json"
KFR2 = ROOT / "framework/core/fact/kungfu-fact-root-canonical-v2.json"


def _root(label):
    return f"sha256:{hashlib.sha256(label.encode()).hexdigest()}"


def _replace(value, roots):
    if isinstance(value, str) and value.startswith("$"):
        return roots[value[1:]]
    if isinstance(value, list):
        return [_replace(item, roots) for item in value]
    if isinstance(value, dict):
        return {key: _replace(item, roots) for key, item in value.items()}
    return value


def _root_records(rows, roots):
    result = []
    for row in rows:
        record = _replace(row["record"], roots)
        record_root = temporal_relation.record_root(record)
        roots[row["id"]] = record_root
        result.append({"root": record_root, "record": record})
    return result


def _materialize():
    fixture = json.loads(FIXTURE.read_text())
    labels = {
        "governing-authority",
        "delegated-authority",
        "subject-a",
        "subject-b",
        "subject-c",
        "scope",
        "admission",
        "reason",
        "material",
        "orphan",
        "orphan-active",
        "unknown-predicate",
    }
    roots = {label: _root(label) for label in labels}
    roots.update({row["id"]: _root(row["id"]) for row in fixture["cuts"]})

    predicates = _root_records(fixture["predicates"], roots)
    relations = _root_records(fixture["relations"], roots)
    supersessions = _root_records(fixture["supersessions"], roots)
    revocations = _root_records(fixture["revocations"], roots)
    authority_proofs = _root_records(fixture["authorityProofs"], roots)
    provenance_objects = _root_records(fixture["provenanceObjects"], roots)
    cuts = [
        {
            "root": roots[row["id"]],
            "parentCutRoots": [roots[item] for item in row["parents"]],
            "activeRelationRoots": [roots[item] for item in row["activeRelations"]],
            "declarationRoots": [roots[item] for item in row["declarations"]],
        }
        for row in fixture["cuts"]
    ]
    bundle = {
        "schema": "kungfu.fact.temporal-bundle/v1",
        "cuts": cuts,
        "predicates": predicates,
        "relations": relations,
        "supersessions": supersessions,
        "revocations": revocations,
        "authorityProofs": authority_proofs,
        "provenanceObjects": provenance_objects,
    }
    return fixture, roots, bundle


def _query(case, roots):
    return {
        "schema": "kungfu.fact.temporal-path-query/v1",
        "queryId": f"query:{case['id']}",
        "operation": case["operation"],
        "predicateRoot": roots[case.get("predicate", "compatibility")],
        "sourceRoot": roots[case["source"]],
        "targetRoot": roots[case["target"]],
        "cutRoot": roots[case["cut"]],
        "relationPathRoots": [roots[item] for item in case["path"]],
        "requiredAuthorityRoot": roots["governing-authority"],
        "maxDepth": case.get("maxDepth", 8),
    }


def _mutate(bundle, mutation, roots):
    result = deepcopy(bundle)
    if mutation == "duplicate-authority":
        record = deepcopy(result["authorityProofs"][0]["record"])
        record["proofId"] = "authority-proof:delegation:v2"
        result["authorityProofs"].append(
            {"root": temporal_relation.record_root(record), "record": record}
        )
    elif mutation == "supersession-cycle":
        record = {
            "schema": "kungfu.fact.temporal-supersession/v1",
            "priorRelationRoot": roots["relation-a-b-v2"],
            "successorRelationRoot": roots["relation-a-b"],
            "effectiveCutRoot": roots["cut0"],
            "reasonRoot": roots["reason"],
            "authorityRoot": roots["governing-authority"],
            "admissionRoots": [roots["admission"]],
        }
        result["supersessions"].append(
            {"root": temporal_relation.record_root(record), "record": record}
        )
    elif mutation == "cut-orphan":
        result["cuts"][0]["activeRelationRoots"].append(roots["orphan-active"])
    return result


def test_temporal_schemas_are_welded_to_the_independent_kfr2_registry():
    contract = json.loads(CONTRACT.read_text())
    protocol = json.loads(KFR2.read_text())
    declared = set(contract["temporalRelations"]["schemas"])
    registered = {row["id"] for row in protocol["schemas"]}

    assert contract["temporalRelations"]["status"] == "implemented"
    assert declared == set(temporal_relation.SCHEMA_FIELDS)
    assert declared <= registered
    assert contract["temporalRelations"]["queryBoundary"] == {
        "mode": "explicit-path-verification-only",
        "maximumDepth": 32,
        "graphSearch": "forbidden",
        "mutableHead": "forbidden",
        "omissionPolicy": "explicit-rooted-only",
        "projectionAuthority": "none",
    }


def test_all_positive_and_negative_temporal_fixtures_return_rooted_receipts():
    fixture, roots, bundle = _materialize()
    for case in fixture["cases"]:
        candidate = _mutate(bundle, case.get("mutation"), roots)
        query = _query(case, roots)
        receipt = temporal_relation.verify_path(candidate, query)
        expected = case["expected"]

        assert receipt["root"] == temporal_relation.record_root(receipt["record"]), (
            case["id"]
        )
        assert receipt["record"]["queryRoot"] == temporal_relation.record_root(query)
        if expected == "accepted":
            assert receipt["record"]["status"] == "accepted", case["id"]
            assert receipt["record"]["failureCode"] == ""
            assert len(receipt["record"]["authorityProofRoots"]) == case.get(
                "expectedProofs", 1
            )
        else:
            assert receipt["record"]["status"] == "rejected", case["id"]
            assert receipt["record"]["failureCode"] == expected, case["id"]


def test_old_cut_receipt_is_byte_stable_after_later_append_only_facts():
    fixture, roots, bundle = _materialize()
    old_case = next(
        row
        for row in fixture["cases"]
        if row["id"] == "old-cut-remains-valid-after-supersession"
    )
    query = _query(old_case, roots)
    complete_history = temporal_relation.verify_path(bundle, query)

    old_history = deepcopy(bundle)
    old_history["cuts"] = old_history["cuts"][:1]
    old_history["relations"] = [
        row
        for row in old_history["relations"]
        if row["root"] in old_history["cuts"][0]["activeRelationRoots"]
    ]
    old_history["supersessions"] = []
    old_history["revocations"] = []
    old_history["provenanceObjects"] = []
    original_history = temporal_relation.verify_path(old_history, query)

    assert complete_history == original_history


def test_record_roots_bind_direction_scope_cut_and_path_order():
    fixture, roots, _bundle = _materialize()
    case = fixture["cases"][0]
    query = _query(case, roots)
    original = temporal_relation.record_root(query)

    for field, value in {
        "operation": "other-operation",
        "sourceRoot": roots["subject-b"],
        "cutRoot": roots["cut1"],
        "relationPathRoots": [roots["relation-b-c"], roots["relation-a-b"]],
    }.items():
        changed = deepcopy(query)
        changed[field] = value
        assert temporal_relation.record_root(changed) != original
