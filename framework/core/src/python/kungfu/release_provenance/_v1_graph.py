# SPDX-License-Identifier: Apache-2.0

"""Internal v1 predicate and relation graph validation."""

from __future__ import annotations

from typing import Any

from kungfu.storage.fact_root_canonical import record_root


_PREDICATE_FIELDS = {
    "schema",
    "predicateId",
    "operations",
    "direction",
    "pathPolicy",
    "cyclePolicy",
    "authorityRoot",
}
_RELATION_FIELDS = {
    "schema",
    "relationId",
    "predicateRoot",
    "sourceRoot",
    "targetRoot",
    "validFromCutRoot",
    "scopeRoot",
    "authorityRoot",
    "admissionRoots",
}


def _predicate_row(
    row: Any, identities: dict[str, Any], issues: list[str]
) -> tuple[str, str]:
    record = row["record"]
    if set(row) != {"root", "record"} or not isinstance(record, dict):
        raise TypeError
    if set(record) != _PREDICATE_FIELDS:
        issues.append("invalid-predicate")
    if row["root"] != record_root(record):
        issues.append("predicate-root-mismatch")
    if record.get("authorityRoot") != identities.get("authorityRoot"):
        issues.append("predicate-authority-mismatch")
    name = (
        record["predicateId"]
        .removeprefix("kungfu.release-provenance:")
        .removesuffix("/v1")
    )
    if (
        record.get("schema") != "kungfu.fact.temporal-predicate/v1"
        or record.get("predicateId") != f"kungfu.release-provenance:{name}/v1"
        or record.get("operations") != ["release-candidate", "release-promotion"]
        or record.get("direction") != "source-to-target"
        or record.get("pathPolicy") != "single-explicit-edge"
        or record.get("cyclePolicy") != "forbidden"
    ):
        issues.append("invalid-predicate")
    return name, row["root"]


def predicate_roots(
    envelope: dict[str, Any], identities: dict[str, Any], issues: list[str]
) -> dict[str, str]:
    roots: dict[str, str] = {}
    value = envelope.get("predicates")
    predicates = value if isinstance(value, list) else []
    if not isinstance(value, list):
        issues.append("invalid-predicate")
    for row in predicates:
        try:
            name, root = _predicate_row(row, identities, issues)
            if name in roots:
                issues.append("ambiguous-predicate")
            roots[name] = root
        except (AttributeError, ValueError, TypeError, KeyError):
            issues.append("invalid-predicate")
    return roots


def _relation_row(
    row: Any, object_record: dict[str, Any], issues: list[str]
) -> tuple[str, dict[str, Any]]:
    record = row["record"]
    if set(row) != {"root", "record"} or not isinstance(record, dict):
        raise TypeError
    if set(record) != _RELATION_FIELDS:
        issues.append("invalid-relation")
    if row["root"] != record_root(record):
        issues.append("relation-root-mismatch")
    name = record["relationId"].rsplit(":", 1)[-1]
    if (
        record.get("schema") != "kungfu.fact.temporal-relation/v1"
        or record.get("relationId") != f"{object_record.get('objectId')}:{name}"
    ):
        issues.append("invalid-relation")
    return name, row


def relation_rows(
    envelope: dict[str, Any], object_record: dict[str, Any], issues: list[str]
) -> tuple[list[Any], dict[str, list[dict[str, Any]]]]:
    rows_by_name: dict[str, list[dict[str, Any]]] = {}
    value = envelope.get("relations")
    relations = value if isinstance(value, list) else []
    if not isinstance(value, list):
        issues.append("invalid-relation")
    for row in relations:
        try:
            name, relation = _relation_row(row, object_record, issues)
            rows_by_name.setdefault(name, []).append(relation)
        except (AttributeError, ValueError, TypeError, KeyError):
            issues.append("invalid-relation")
    return relations, rows_by_name


def _relation_targets(
    envelope: dict[str, Any], identities: dict[str, Any]
) -> dict[str, Any]:
    return {
        "derived-from": identities.get("derivationRoot"),
        "acknowledges": identities.get("acknowledgementRoot"),
        "qualified-by": identities.get("qualificationRoot"),
        "authorized-by": identities.get("authorityRoot"),
        "implements-contract": identities.get("contractRoot"),
        "projected-as": envelope.get("gitProjectionRoot"),
    }


def _check_relation(
    name: str,
    rows: list[dict[str, Any]],
    predicate_roots: dict[str, str],
    identities: dict[str, Any],
    object_record: dict[str, Any],
    target: Any,
    issues: list[str],
) -> None:
    if len(rows) != 1:
        issues.append(
            "ambiguous-authority"
            if name == "authorized-by" and len(rows) > 1
            else f"{name}-relation-count"
        )
        return
    record = rows[0]["record"]
    expected_fields = (
        ("predicateRoot", predicate_roots.get(name), "predicate"),
        ("sourceRoot", identities.get("subjectRoot"), "source"),
        ("targetRoot", target, "target"),
        ("validFromCutRoot", identities.get("cutRoot"), "cut"),
        ("scopeRoot", identities.get("scopeRoot"), "scope"),
        ("authorityRoot", identities.get("authorityRoot"), "authority"),
        ("admissionRoots", object_record.get("admissionRoots"), "admission"),
    )
    for field, expected, suffix in expected_fields:
        if record.get(field) != expected:
            issues.append(f"{name}-{suffix}-mismatch")


def relation_issues(
    envelope: dict[str, Any],
    identities: dict[str, Any],
    object_record: dict[str, Any],
    predicate_roots: dict[str, str],
    relations: list[Any],
    rows_by_name: dict[str, list[dict[str, Any]]],
    required_relations: tuple[str, ...],
    issues: list[str],
) -> None:
    if set(predicate_roots) != set(required_relations):
        issues.append("predicate-set-mismatch")
    if set(rows_by_name) != set(required_relations):
        issues.append("relation-set-mismatch")
    targets = _relation_targets(envelope, identities)
    for name in required_relations:
        _check_relation(
            name,
            rows_by_name.get(name, []),
            predicate_roots,
            identities,
            object_record,
            targets[name],
            issues,
        )
    if object_record.get("relationRoots") != [
        row.get("root") if isinstance(row, dict) else None for row in relations
    ]:
        issues.append("object-relation-roots-mismatch")
