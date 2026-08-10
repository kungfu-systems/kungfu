# SPDX-License-Identifier: Apache-2.0

"""Immutable release provenance package built on KFR2 temporal relation roots.

Git object ids are retained as an exact transport projection.  They are never
used as the identity of a release history edge or as a substitute for the
rooted semantic relation.
"""

from __future__ import annotations

import hashlib
from copy import deepcopy
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.storage.fact_root_canonical import ROOT_PATTERN, record_root

ENVELOPE_SCHEMA = "kungfu.release-provenance-envelope/v1"
PROJECTION_SCHEMA = "kungfu.release-provenance-git-projection/v1"
SEMANTIC_DOMAIN = b"kungfu.release-provenance.semantic/v1\0"
REQUIRED_RELATIONS = (
    "derived-from",
    "acknowledges",
    "qualified-by",
    "authorized-by",
    "implements-contract",
    "projected-as",
)


class ReleaseProvenanceError(ValueError):
    """Stable fail-closed release provenance rejection."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise ReleaseProvenanceError(code, message)


def semantic_root(value: Any) -> str:
    """Root a release semantic value independently of Git topology."""

    digest = hashlib.sha256(SEMANTIC_DOMAIN + canonical_json_bytes(value)).hexdigest()
    return f"sha256:{digest}"


def _require_root(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ROOT_PATTERN.fullmatch(value):
        _fail("orphan-root", f"{field} must be a lowercase SHA-256 root")
    return value


def _require_oid(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(char not in "0123456789abcdef" for char in value)
    ):
        _fail("invalid-git-projection", f"{field} must be a lowercase Git SHA-1")
    return value


def _source_tree_root(tree: str) -> str:
    return semantic_root(
        {
            "schema": "kungfu.release-source-tree/v1",
            "digestAlgorithm": "git-sha1",
            "digest": _require_oid(tree, "sourceTree.digest"),
        }
    )


def _identity(
    kind: str, release_id: str, identity: str, source_tree_root: str
) -> dict[str, str]:
    if not identity:
        _fail("invalid-identity", f"{kind}.identity is required")
    return {
        "schema": "kungfu.release-provenance-identity/v1",
        "kind": kind,
        "releaseId": release_id,
        "identity": identity,
        "sourceTreeRoot": _require_root(source_tree_root, f"{kind}.sourceTreeRoot"),
    }


def _predicate(relation: str, authority_root: str) -> tuple[str, dict[str, Any]]:
    record = {
        "schema": "kungfu.fact.temporal-predicate/v1",
        "predicateId": f"kungfu.release-provenance:{relation}/v1",
        "operations": ["release-candidate", "release-promotion"],
        "direction": "source-to-target",
        "pathPolicy": "single-explicit-edge",
        "cyclePolicy": "forbidden",
        "authorityRoot": authority_root,
    }
    return record_root(record), record


def _relation(
    *,
    object_id: str,
    relation: str,
    predicate_root: str,
    source_root: str,
    target_root: str,
    cut_root: str,
    scope_root: str,
    authority_root: str,
    admission_roots: list[str],
) -> tuple[str, dict[str, Any]]:
    record = {
        "schema": "kungfu.fact.temporal-relation/v1",
        "relationId": f"{object_id}:{relation}",
        "predicateRoot": predicate_root,
        "sourceRoot": source_root,
        "targetRoot": target_root,
        "validFromCutRoot": cut_root,
        "scopeRoot": scope_root,
        "authorityRoot": authority_root,
        "admissionRoots": admission_roots,
    }
    return record_root(record), record


def _projection_root(projection: dict[str, Any]) -> str:
    return semantic_root(projection)


def _projection_status(projection: dict[str, Any]) -> tuple[str, list[str]]:
    drift: list[str] = []
    if projection["kind"] == "candidate-parentage":
        if projection["candidateTree"] != projection["devCutTree"]:
            drift.append("candidate-tree-mismatch")
        if projection["observedParents"] != projection["expectedParents"]:
            drift.append("parent-order-mismatch")
    elif projection["kind"] == "promotion-topology":
        if projection["promotionTree"] != projection["candidateTree"]:
            drift.append("promotion-tree-mismatch")
        if not projection["candidateAncestryObserved"]:
            drift.append("candidate-not-ancestor")
    else:
        _fail("invalid-git-projection", "unsupported Git projection kind")
    return ("exact" if not drift else "drift"), drift


def _make_envelope(
    *,
    phase: str,
    release_id: str,
    object_id: str,
    subject: dict[str, str],
    derivation_root: str,
    acknowledgement_root: str,
    qualification_root: str,
    authority_root: str,
    contract_root: str,
    cut_root: str,
    projection: dict[str, Any],
    fail_closed_on: list[str],
    admission_roots: list[str],
    legacy_projection: Any,
) -> dict[str, Any]:
    if phase not in {"candidate", "promotion"}:
        _fail("invalid-envelope", "phase must be candidate or promotion")
    subject_root = semantic_root(subject)
    scope_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-scope/v1",
            "releaseId": release_id,
            "phase": phase,
        }
    )
    projection = deepcopy(projection)
    projection["schema"] = PROJECTION_SCHEMA
    projection["status"], projection["drift"] = _projection_status(projection)
    projection["policy"] = {"failClosedOn": sorted(set(fail_closed_on))}
    git_projection_root = _projection_root(projection)

    predicate_rows: list[dict[str, Any]] = []
    relation_rows: list[dict[str, Any]] = []
    targets = {
        "derived-from": derivation_root,
        "acknowledges": acknowledgement_root,
        "qualified-by": qualification_root,
        "authorized-by": authority_root,
        "implements-contract": contract_root,
        "projected-as": git_projection_root,
    }
    for relation_name in REQUIRED_RELATIONS:
        predicate_root, predicate_record = _predicate(relation_name, authority_root)
        predicate_rows.append({"root": predicate_root, "record": predicate_record})
        relation_root, relation_record = _relation(
            object_id=object_id,
            relation=relation_name,
            predicate_root=predicate_root,
            source_root=subject_root,
            target_root=targets[relation_name],
            cut_root=cut_root,
            scope_root=scope_root,
            authority_root=authority_root,
            admission_roots=admission_roots,
        )
        relation_rows.append({"root": relation_root, "record": relation_record})

    provenance_object = {
        "schema": "kungfu.fact.provenance-object/v1",
        "objectId": object_id,
        "subjectRoot": subject_root,
        "materialRoots": [
            subject_root,
            qualification_root,
            contract_root,
            git_projection_root,
        ],
        "relationRoots": [row["root"] for row in relation_rows],
        "cutRoot": cut_root,
        "authorityRoot": authority_root,
        "admissionRoots": admission_roots,
    }
    object_root = record_root(provenance_object)
    legacy_projection = deepcopy(legacy_projection)
    return {
        "schema": ENVELOPE_SCHEMA,
        "phase": phase,
        "releaseId": release_id,
        "objectRoot": object_root,
        "object": provenance_object,
        "subject": subject,
        "identities": {
            "subjectRoot": subject_root,
            "derivationRoot": derivation_root,
            "acknowledgementRoot": acknowledgement_root,
            "qualificationRoot": qualification_root,
            "authorityRoot": authority_root,
            "contractRoot": contract_root,
            "scopeRoot": scope_root,
            "cutRoot": cut_root,
        },
        "predicates": predicate_rows,
        "relations": relation_rows,
        "gitProjection": projection,
        "gitProjectionRoot": git_projection_root,
        "legacyProjection": legacy_projection,
        "legacyProjectionRoot": semantic_root(legacy_projection),
    }


def build_candidate(
    *,
    release_id: str,
    candidate_id: str,
    candidate_commit: str,
    candidate_tree: str,
    dev_cut_commit: str,
    dev_cut_tree: str,
    previous_alpha_commit: str,
    previous_alpha_tree: str,
    dev_cut_root: str,
    previous_alpha_root: str,
    qualification_root: str,
    authority_root: str,
    contract_root: str,
    admission_roots: list[str],
    observed_parents: list[str],
    legacy_projection: Any,
    fail_closed_on: list[str] | None = None,
) -> dict[str, Any]:
    """Produce one candidate provenance object without deriving history from Git."""

    for field, value in {
        "qualificationRoot": qualification_root,
        "authorityRoot": authority_root,
        "contractRoot": contract_root,
    }.items():
        _require_root(value, field)
    admission_roots = [
        _require_root(root, "admissionRoots") for root in admission_roots
    ]
    candidate = _identity(
        "candidate", release_id, candidate_id, _source_tree_root(candidate_tree)
    )
    dev_cut_root = _require_root(dev_cut_root, "devCutRoot")
    previous_alpha_root = _require_root(previous_alpha_root, "previousAlphaRoot")
    cut_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-cut/v1",
            "releaseId": release_id,
            "candidateRoot": semantic_root(candidate),
            "devCutRoot": dev_cut_root,
            "previousAlphaRoot": previous_alpha_root,
        }
    )
    projection = {
        "kind": "candidate-parentage",
        "candidateCommit": candidate_commit,
        "candidateTree": candidate_tree,
        "devCutCommit": dev_cut_commit,
        "devCutTree": dev_cut_tree,
        "previousAlphaCommit": previous_alpha_commit,
        "previousAlphaTree": previous_alpha_tree,
        "expectedParents": [dev_cut_commit, previous_alpha_commit],
        "observedParents": [
            _require_oid(value, "observedParents") for value in observed_parents
        ],
    }
    return _make_envelope(
        phase="candidate",
        release_id=release_id,
        object_id=f"release-provenance:candidate:{candidate_id}",
        subject=candidate,
        derivation_root=dev_cut_root,
        acknowledgement_root=previous_alpha_root,
        qualification_root=qualification_root,
        authority_root=authority_root,
        contract_root=contract_root,
        cut_root=cut_root,
        projection=projection,
        fail_closed_on=fail_closed_on
        or ["candidate-tree-mismatch", "parent-order-mismatch"],
        admission_roots=admission_roots,
        legacy_projection=legacy_projection,
    )


def build_promotion(
    *,
    candidate_envelope: dict[str, Any],
    promotion_id: str,
    promotion_commit: str,
    promotion_tree: str,
    qualification_root: str,
    authority_root: str,
    contract_root: str,
    admission_roots: list[str],
    candidate_ancestry_observed: bool,
    legacy_projection: Any,
    fail_closed_on: list[str] | None = None,
) -> dict[str, Any]:
    """Produce a distinct promotion object for the same admitted candidate tree."""

    candidate_report = verify(candidate_envelope)
    if not candidate_report["ok"]:
        _fail("candidate-invalid", "promotion requires a verified candidate envelope")
    release_id = candidate_envelope["releaseId"]
    candidate_projection = candidate_envelope["gitProjection"]
    promotion = _identity(
        "promotion", release_id, promotion_id, _source_tree_root(promotion_tree)
    )
    acknowledgement_root = candidate_envelope["identities"]["acknowledgementRoot"]
    cut_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-cut/v1",
            "releaseId": release_id,
            "candidateObjectRoot": candidate_envelope["objectRoot"],
            "promotionSubjectRoot": semantic_root(promotion),
        }
    )
    projection = {
        "kind": "promotion-topology",
        "candidateCommit": candidate_projection["candidateCommit"],
        "candidateTree": candidate_projection["candidateTree"],
        "promotionCommit": _require_oid(promotion_commit, "promotionCommit"),
        "promotionTree": _require_oid(promotion_tree, "promotionTree"),
        "candidateAncestryObserved": bool(candidate_ancestry_observed),
    }
    return _make_envelope(
        phase="promotion",
        release_id=release_id,
        object_id=f"release-provenance:promotion:{promotion_id}",
        subject=promotion,
        derivation_root=candidate_envelope["objectRoot"],
        acknowledgement_root=acknowledgement_root,
        qualification_root=_require_root(qualification_root, "qualificationRoot"),
        authority_root=_require_root(authority_root, "authorityRoot"),
        contract_root=_require_root(contract_root, "contractRoot"),
        cut_root=cut_root,
        projection=projection,
        fail_closed_on=fail_closed_on or ["promotion-tree-mismatch"],
        admission_roots=[
            _require_root(root, "admissionRoots") for root in admission_roots
        ],
        legacy_projection=legacy_projection,
    )


def verify(envelope: Any, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Verify roots, relation roles, projection policy, and optional exact inputs."""

    issues: list[str] = []
    if not isinstance(envelope, dict) or envelope.get("schema") != ENVELOPE_SCHEMA:
        return {"ok": False, "issues": ["unknown-schema"]}
    required = {
        "schema",
        "phase",
        "releaseId",
        "objectRoot",
        "object",
        "subject",
        "identities",
        "predicates",
        "relations",
        "gitProjection",
        "gitProjectionRoot",
        "legacyProjection",
        "legacyProjectionRoot",
    }
    if set(envelope) != required:
        return {"ok": False, "issues": ["invalid-envelope"]}
    phase_value = envelope.get("phase")
    phase = phase_value if isinstance(phase_value, str) else ""
    if phase not in {"candidate", "promotion"}:
        issues.append("invalid-envelope")
    release_id = envelope.get("releaseId")
    if not isinstance(release_id, str) or not release_id:
        issues.append("invalid-envelope")
    identities_value = envelope.get("identities")
    identities = identities_value if isinstance(identities_value, dict) else {}
    if not isinstance(identities_value, dict) or set(identities) != {
        "subjectRoot",
        "derivationRoot",
        "acknowledgementRoot",
        "qualificationRoot",
        "authorityRoot",
        "contractRoot",
        "scopeRoot",
        "cutRoot",
    }:
        issues.append("invalid-envelope")
    for field, value in identities.items():
        try:
            _require_root(value, f"identities.{field}")
        except ReleaseProvenanceError:
            issues.append("orphan-root")
    try:
        if semantic_root(envelope["subject"]) != envelope["identities"]["subjectRoot"]:
            issues.append("subject-root-mismatch")
        if record_root(envelope["object"]) != envelope["objectRoot"]:
            issues.append("object-root-mismatch")
        if _projection_root(envelope["gitProjection"]) != envelope["gitProjectionRoot"]:
            issues.append("git-projection-root-mismatch")
        if (
            semantic_root(envelope["legacyProjection"])
            != envelope["legacyProjectionRoot"]
        ):
            issues.append("legacy-projection-root-mismatch")
    except (ReleaseProvenanceError, ValueError, TypeError, KeyError):
        issues.append("invalid-envelope")

    projection_value = envelope.get("gitProjection")
    projection = projection_value if isinstance(projection_value, dict) else {}
    if not isinstance(projection_value, dict):
        issues.append("invalid-git-projection")
    subject = envelope.get("subject", {})
    expected_projection_kind = {
        "candidate": "candidate-parentage",
        "promotion": "promotion-topology",
    }.get(phase)
    expected_subject_kind = phase
    expected_tree_field = {
        "candidate": "candidateTree",
        "promotion": "promotionTree",
    }.get(phase)
    if (
        not isinstance(subject, dict)
        or set(subject) != {"schema", "kind", "releaseId", "identity", "sourceTreeRoot"}
        or subject.get("schema") != "kungfu.release-provenance-identity/v1"
        or subject.get("kind") != expected_subject_kind
        or subject.get("releaseId") != release_id
        or not isinstance(subject.get("identity"), str)
        or not subject.get("identity")
    ):
        issues.append("invalid-identity")
    try:
        if subject.get("sourceTreeRoot") != _source_tree_root(
            projection[expected_tree_field]
        ):
            issues.append("source-tree-root-mismatch")
    except (KeyError, TypeError, ReleaseProvenanceError):
        issues.append("invalid-git-projection")

    if isinstance(release_id, str) and phase in {"candidate", "promotion"}:
        expected_scope_root = semantic_root(
            {
                "schema": "kungfu.release-provenance-scope/v1",
                "releaseId": release_id,
                "phase": phase,
            }
        )
        expected_cut_root = semantic_root(
            {
                "schema": "kungfu.release-provenance-cut/v1",
                "releaseId": release_id,
                **(
                    {
                        "candidateRoot": identities.get("subjectRoot"),
                        "devCutRoot": identities.get("derivationRoot"),
                        "previousAlphaRoot": identities.get("acknowledgementRoot"),
                    }
                    if phase == "candidate"
                    else {
                        "candidateObjectRoot": identities.get("derivationRoot"),
                        "promotionSubjectRoot": identities.get("subjectRoot"),
                    }
                ),
            }
        )
        if identities.get("scopeRoot") != expected_scope_root:
            issues.append("scope-root-mismatch")
        if identities.get("cutRoot") != expected_cut_root:
            issues.append("cut-root-mismatch")

    object_value = envelope.get("object", {})
    object_record = object_value if isinstance(object_value, dict) else {}
    if not isinstance(object_value, dict) or set(object_record) != {
        "schema",
        "objectId",
        "subjectRoot",
        "materialRoots",
        "relationRoots",
        "cutRoot",
        "authorityRoot",
        "admissionRoots",
    }:
        issues.append("invalid-object")
    else:
        if object_record.get("schema") != "kungfu.fact.provenance-object/v1":
            issues.append("invalid-object")
        expected_object_id = (
            f"release-provenance:{phase}:{subject.get('identity')}"
            if isinstance(subject, dict)
            else None
        )
        if object_record.get("objectId") != expected_object_id:
            issues.append("object-identity-mismatch")
        if object_record.get("subjectRoot") != identities.get("subjectRoot"):
            issues.append("object-subject-root-mismatch")
        if object_record.get("cutRoot") != identities.get("cutRoot"):
            issues.append("object-cut-root-mismatch")
        if object_record.get("authorityRoot") != identities.get("authorityRoot"):
            issues.append("object-authority-root-mismatch")
        admission_roots = object_record.get("admissionRoots")
        try:
            if not isinstance(admission_roots, list) or len(admission_roots) != len(
                set(admission_roots)
            ):
                raise TypeError
            for root in admission_roots:
                _require_root(root, "object.admissionRoots")
        except (ReleaseProvenanceError, TypeError):
            issues.append("orphan-root")
        expected_material_roots = [
            identities.get("subjectRoot"),
            identities.get("qualificationRoot"),
            identities.get("contractRoot"),
            envelope.get("gitProjectionRoot"),
        ]
        if object_record.get("materialRoots") != expected_material_roots:
            issues.append("object-material-roots-mismatch")

    predicate_roots: dict[str, str] = {}
    predicates_value = envelope.get("predicates")
    predicates = predicates_value if isinstance(predicates_value, list) else []
    if not isinstance(predicates_value, list):
        issues.append("invalid-predicate")
    for row in predicates:
        try:
            record = row["record"]
            if set(row) != {"root", "record"} or not isinstance(record, dict):
                raise TypeError
            if set(record) != {
                "schema",
                "predicateId",
                "operations",
                "direction",
                "pathPolicy",
                "cyclePolicy",
                "authorityRoot",
            }:
                issues.append("invalid-predicate")
            if row["root"] != record_root(record):
                issues.append("predicate-root-mismatch")
            if record.get("authorityRoot") != identities.get("authorityRoot"):
                issues.append("predicate-authority-mismatch")
            relation_name = (
                record["predicateId"]
                .removeprefix("kungfu.release-provenance:")
                .removesuffix("/v1")
            )
            if (
                record.get("schema") != "kungfu.fact.temporal-predicate/v1"
                or record.get("predicateId")
                != f"kungfu.release-provenance:{relation_name}/v1"
                or record.get("operations")
                != ["release-candidate", "release-promotion"]
                or record.get("direction") != "source-to-target"
                or record.get("pathPolicy") != "single-explicit-edge"
                or record.get("cyclePolicy") != "forbidden"
            ):
                issues.append("invalid-predicate")
            if relation_name in predicate_roots:
                issues.append("ambiguous-predicate")
            predicate_roots[relation_name] = row["root"]
        except (AttributeError, ValueError, TypeError, KeyError):
            issues.append("invalid-predicate")

    relation_rows: dict[str, list[dict[str, Any]]] = {}
    relations_value = envelope.get("relations")
    relations = relations_value if isinstance(relations_value, list) else []
    if not isinstance(relations_value, list):
        issues.append("invalid-relation")
    for row in relations:
        try:
            record = row["record"]
            if set(row) != {"root", "record"} or not isinstance(record, dict):
                raise TypeError
            if set(record) != {
                "schema",
                "relationId",
                "predicateRoot",
                "sourceRoot",
                "targetRoot",
                "validFromCutRoot",
                "scopeRoot",
                "authorityRoot",
                "admissionRoots",
            }:
                issues.append("invalid-relation")
            if row["root"] != record_root(record):
                issues.append("relation-root-mismatch")
            relation_name = record["relationId"].rsplit(":", 1)[-1]
            if (
                record.get("schema") != "kungfu.fact.temporal-relation/v1"
                or record.get("relationId")
                != f"{object_record.get('objectId')}:{relation_name}"
            ):
                issues.append("invalid-relation")
            relation_rows.setdefault(relation_name, []).append(row)
        except (AttributeError, ValueError, TypeError, KeyError):
            issues.append("invalid-relation")

    if set(predicate_roots) != set(REQUIRED_RELATIONS):
        issues.append("predicate-set-mismatch")
    if set(relation_rows) != set(REQUIRED_RELATIONS):
        issues.append("relation-set-mismatch")
    expected_targets = {
        "derived-from": identities.get("derivationRoot"),
        "acknowledges": identities.get("acknowledgementRoot"),
        "qualified-by": identities.get("qualificationRoot"),
        "authorized-by": identities.get("authorityRoot"),
        "implements-contract": identities.get("contractRoot"),
        "projected-as": envelope.get("gitProjectionRoot"),
    }
    for relation_name in REQUIRED_RELATIONS:
        rows = relation_rows.get(relation_name, [])
        if len(rows) != 1:
            issues.append(
                "ambiguous-authority"
                if relation_name == "authorized-by" and len(rows) > 1
                else f"{relation_name}-relation-count"
            )
            continue
        record = rows[0]["record"]
        if record.get("predicateRoot") != predicate_roots.get(relation_name):
            issues.append(f"{relation_name}-predicate-mismatch")
        if record.get("sourceRoot") != identities.get("subjectRoot"):
            issues.append(f"{relation_name}-source-mismatch")
        if record.get("targetRoot") != expected_targets[relation_name]:
            issues.append(f"{relation_name}-target-mismatch")
        if record.get("validFromCutRoot") != identities.get("cutRoot"):
            issues.append(f"{relation_name}-cut-mismatch")
        if record.get("scopeRoot") != identities.get("scopeRoot"):
            issues.append(f"{relation_name}-scope-mismatch")
        if record.get("authorityRoot") != identities.get("authorityRoot"):
            issues.append(f"{relation_name}-authority-mismatch")
        if record.get("admissionRoots") != object_record.get("admissionRoots"):
            issues.append(f"{relation_name}-admission-mismatch")

    if object_record.get("relationRoots") != [
        row.get("root") if isinstance(row, dict) else None for row in relations
    ]:
        issues.append("object-relation-roots-mismatch")
    try:
        if projection.get("kind") != expected_projection_kind:
            issues.append("invalid-git-projection")
        expected_projection_fields = {
            "schema",
            "kind",
            "candidateCommit",
            "candidateTree",
            "status",
            "drift",
            "policy",
            *(
                {
                    "devCutCommit",
                    "devCutTree",
                    "previousAlphaCommit",
                    "previousAlphaTree",
                    "expectedParents",
                    "observedParents",
                }
                if phase == "candidate"
                else {
                    "promotionCommit",
                    "promotionTree",
                    "candidateAncestryObserved",
                }
            ),
        }
        if set(projection) != expected_projection_fields:
            issues.append("invalid-git-projection")
        if projection.get("schema") != PROJECTION_SCHEMA:
            issues.append("invalid-git-projection")
        oid_fields = (
            [
                "candidateCommit",
                "candidateTree",
                "devCutCommit",
                "devCutTree",
                "previousAlphaCommit",
                "previousAlphaTree",
            ]
            if phase == "candidate"
            else [
                "candidateCommit",
                "candidateTree",
                "promotionCommit",
                "promotionTree",
            ]
        )
        for field in oid_fields:
            _require_oid(projection[field], f"gitProjection.{field}")
        if phase == "candidate":
            if projection.get("expectedParents") != [
                projection.get("devCutCommit"),
                projection.get("previousAlphaCommit"),
            ]:
                issues.append("git-projection-parent-mismatch")
            observed_parents = projection.get("observedParents")
            if not isinstance(observed_parents, list):
                issues.append("invalid-git-projection")
            else:
                for parent in observed_parents:
                    _require_oid(parent, "gitProjection.observedParents")
        elif not isinstance(projection.get("candidateAncestryObserved"), bool):
            issues.append("invalid-git-projection")
        status, drift = _projection_status(projection)
        if status != projection.get("status") or drift != projection.get("drift"):
            issues.append("git-projection-status-mismatch")
        policy = projection.get("policy")
        if not isinstance(policy, dict) or set(policy) != {"failClosedOn"}:
            issues.append("projection-policy-mismatch")
            fail_closed_values: list[Any] = []
        else:
            fail_closed_value = policy.get("failClosedOn")
            fail_closed_values = (
                fail_closed_value if isinstance(fail_closed_value, list) else []
            )
            if (
                not isinstance(fail_closed_value, list)
                or len(fail_closed_values) != len(set(fail_closed_values))
                or any(not isinstance(code, str) for code in fail_closed_values)
            ):
                issues.append("projection-policy-mismatch")
        fail_closed = set(fail_closed_values)
        mandatory_failure = {
            "candidate": "candidate-tree-mismatch",
            "promotion": "promotion-tree-mismatch",
        }.get(phase)
        if mandatory_failure not in fail_closed:
            issues.append("projection-policy-mismatch")
        issues.extend(code for code in drift if code in fail_closed)
    except (ReleaseProvenanceError, KeyError, TypeError):
        issues.append("invalid-git-projection")

    for key, value in (expected or {}).items():
        observed = {
            "phase": envelope.get("phase"),
            "releaseId": envelope.get("releaseId"),
            "candidateCommit": projection.get("candidateCommit"),
            "candidateTree": projection.get("candidateTree"),
            "devCutCommit": projection.get("devCutCommit"),
            "devCutTree": projection.get("devCutTree"),
            "previousAlphaCommit": projection.get("previousAlphaCommit"),
            "previousAlphaTree": projection.get("previousAlphaTree"),
            "promotionCommit": projection.get("promotionCommit"),
            "promotionTree": projection.get("promotionTree"),
        }.get(key)
        if observed != value:
            issues.append(f"expected-{key}-mismatch")

    return {
        "schema": "kungfu.release-provenance-verification/v1",
        "ok": not issues,
        "issues": sorted(set(issues)),
        "objectRoot": envelope.get("objectRoot"),
        "phase": envelope.get("phase"),
        "projectionStatus": projection.get("status"),
        "projectionDrift": projection.get("drift", []),
    }
