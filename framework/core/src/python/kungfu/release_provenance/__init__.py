# SPDX-License-Identifier: Apache-2.0

"""KFR2 release provenance with Git retained as an evidence projection."""

from __future__ import annotations

import hashlib
import re
from copy import deepcopy
from typing import Any

from kungfu.canonical_json import canonical_json_bytes
from kungfu.release_provenance import _v1_graph
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


_V1_ENVELOPE_FIELDS = {
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
_V1_IDENTITY_FIELDS = {
    "subjectRoot",
    "derivationRoot",
    "acknowledgementRoot",
    "qualificationRoot",
    "authorityRoot",
    "contractRoot",
    "scopeRoot",
    "cutRoot",
}


def _v1_identities(envelope: dict[str, Any], issues: list[str]) -> dict[str, Any]:
    value = envelope.get("identities")
    identities = value if isinstance(value, dict) else {}
    if not isinstance(value, dict) or set(identities) != _V1_IDENTITY_FIELDS:
        issues.append("invalid-envelope")
    for field, root in identities.items():
        try:
            _require_root(root, f"identities.{field}")
        except ReleaseProvenanceError:
            issues.append("orphan-root")
    return identities


def _v1_root_issues(envelope: dict[str, Any], issues: list[str]) -> None:
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


def _v1_subject_issues(
    subject: Any,
    projection: dict[str, Any],
    phase: str,
    release_id: Any,
    issues: list[str],
) -> None:
    if (
        not isinstance(subject, dict)
        or set(subject) != {"schema", "kind", "releaseId", "identity", "sourceTreeRoot"}
        or subject.get("schema") != "kungfu.release-provenance-identity/v1"
        or subject.get("kind") != phase
        or subject.get("releaseId") != release_id
        or not isinstance(subject.get("identity"), str)
        or not subject.get("identity")
    ):
        issues.append("invalid-identity")
    tree_field = {"candidate": "candidateTree", "promotion": "promotionTree"}.get(phase)
    if tree_field is None:
        issues.append("invalid-git-projection")
        return
    try:
        if subject.get("sourceTreeRoot") != _source_tree_root(projection[tree_field]):
            issues.append("source-tree-root-mismatch")
    except (KeyError, TypeError, ReleaseProvenanceError):
        issues.append("invalid-git-projection")


def _v1_scope_issues(
    phase: str, release_id: Any, identities: dict[str, Any], issues: list[str]
) -> None:
    if not isinstance(release_id, str) or phase not in {"candidate", "promotion"}:
        return
    expected_scope_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-scope/v1",
            "releaseId": release_id,
            "phase": phase,
        }
    )
    cut_members = (
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
    )
    expected_cut_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-cut/v1",
            "releaseId": release_id,
            **cut_members,
        }
    )
    if identities.get("scopeRoot") != expected_scope_root:
        issues.append("scope-root-mismatch")
    if identities.get("cutRoot") != expected_cut_root:
        issues.append("cut-root-mismatch")


def _v1_object(
    envelope: dict[str, Any],
    phase: str,
    subject: Any,
    identities: dict[str, Any],
    issues: list[str],
) -> dict[str, Any]:
    value = envelope.get("object", {})
    record = value if isinstance(value, dict) else {}
    fields = {
        "schema",
        "objectId",
        "subjectRoot",
        "materialRoots",
        "relationRoots",
        "cutRoot",
        "authorityRoot",
        "admissionRoots",
    }
    if not isinstance(value, dict) or set(record) != fields:
        issues.append("invalid-object")
        return record
    if record.get("schema") != "kungfu.fact.provenance-object/v1":
        issues.append("invalid-object")
    expected_id = (
        f"release-provenance:{phase}:{subject.get('identity')}"
        if isinstance(subject, dict)
        else None
    )
    for field, expected, code in (
        ("objectId", expected_id, "object-identity-mismatch"),
        ("subjectRoot", identities.get("subjectRoot"), "object-subject-root-mismatch"),
        ("cutRoot", identities.get("cutRoot"), "object-cut-root-mismatch"),
        (
            "authorityRoot",
            identities.get("authorityRoot"),
            "object-authority-root-mismatch",
        ),
    ):
        if record.get(field) != expected:
            issues.append(code)
    admission_roots = record.get("admissionRoots")
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
    if record.get("materialRoots") != expected_material_roots:
        issues.append("object-material-roots-mismatch")
    return record


def _v1_projection_shape(
    projection: dict[str, Any], phase: str, issues: list[str]
) -> list[str]:
    expected_kind = {
        "candidate": "candidate-parentage",
        "promotion": "promotion-topology",
    }.get(phase)
    expected_fields = {
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
            else {"promotionCommit", "promotionTree", "candidateAncestryObserved"}
        ),
    }
    if projection.get("kind") != expected_kind or set(projection) != expected_fields:
        issues.append("invalid-git-projection")
    if projection.get("schema") != PROJECTION_SCHEMA:
        issues.append("invalid-git-projection")
    return (
        [
            "candidateCommit",
            "candidateTree",
            "devCutCommit",
            "devCutTree",
            "previousAlphaCommit",
            "previousAlphaTree",
        ]
        if phase == "candidate"
        else ["candidateCommit", "candidateTree", "promotionCommit", "promotionTree"]
    )


def _v1_projection_topology(
    projection: dict[str, Any], phase: str, issues: list[str]
) -> None:
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


def _v1_projection_policy(
    projection: dict[str, Any], phase: str, drift: list[str], issues: list[str]
) -> None:
    policy = projection.get("policy")
    if not isinstance(policy, dict) or set(policy) != {"failClosedOn"}:
        issues.append("projection-policy-mismatch")
        values: list[Any] = []
    else:
        value = policy.get("failClosedOn")
        values = value if isinstance(value, list) else []
        if (
            not isinstance(value, list)
            or len(values) != len(set(values))
            or any(not isinstance(code, str) for code in values)
        ):
            issues.append("projection-policy-mismatch")
    fail_closed = set(values)
    mandatory = {
        "candidate": "candidate-tree-mismatch",
        "promotion": "promotion-tree-mismatch",
    }.get(phase)
    if mandatory not in fail_closed:
        issues.append("projection-policy-mismatch")
    issues.extend(code for code in drift if code in fail_closed)


def _v1_projection_issues(
    projection: dict[str, Any], phase: str, issues: list[str]
) -> None:
    try:
        for field in _v1_projection_shape(projection, phase, issues):
            _require_oid(projection[field], f"gitProjection.{field}")
        _v1_projection_topology(projection, phase, issues)
        status, drift = _projection_status(projection)
        if status != projection.get("status") or drift != projection.get("drift"):
            issues.append("git-projection-status-mismatch")
        _v1_projection_policy(projection, phase, drift, issues)
    except (ReleaseProvenanceError, KeyError, TypeError):
        issues.append("invalid-git-projection")


def _v1_expected_issues(
    envelope: dict[str, Any],
    projection: dict[str, Any],
    expected: dict[str, Any] | None,
    issues: list[str],
) -> None:
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
    }
    for key, value in (expected or {}).items():
        if observed.get(key) != value:
            issues.append(f"expected-{key}-mismatch")


def _verify_v1(envelope: Any, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Verify roots, relation roles, projection policy, and optional exact inputs."""

    if not isinstance(envelope, dict) or envelope.get("schema") != ENVELOPE_SCHEMA:
        return {"ok": False, "issues": ["unknown-schema"]}
    if set(envelope) != _V1_ENVELOPE_FIELDS:
        return {"ok": False, "issues": ["invalid-envelope"]}
    issues: list[str] = []
    phase_value = envelope.get("phase")
    phase = phase_value if isinstance(phase_value, str) else ""
    if phase not in {"candidate", "promotion"}:
        issues.append("invalid-envelope")
    release_id = envelope.get("releaseId")
    if not isinstance(release_id, str) or not release_id:
        issues.append("invalid-envelope")
    identities = _v1_identities(envelope, issues)
    _v1_root_issues(envelope, issues)
    projection_value = envelope.get("gitProjection")
    projection = projection_value if isinstance(projection_value, dict) else {}
    if not isinstance(projection_value, dict):
        issues.append("invalid-git-projection")
    subject = envelope.get("subject", {})
    _v1_subject_issues(subject, projection, phase, release_id, issues)
    _v1_scope_issues(phase, release_id, identities, issues)
    object_record = _v1_object(envelope, phase, subject, identities, issues)
    predicate_roots = _v1_graph.predicate_roots(envelope, identities, issues)
    relations, relation_rows = _v1_graph.relation_rows(envelope, object_record, issues)
    _v1_graph.relation_issues(
        envelope,
        identities,
        object_record,
        predicate_roots,
        relations,
        relation_rows,
        REQUIRED_RELATIONS,
        issues,
    )
    _v1_projection_issues(projection, phase, issues)
    _v1_expected_issues(envelope, projection, expected, issues)
    return {
        "schema": "kungfu.release-provenance-verification/v1",
        "ok": not issues,
        "issues": sorted(set(issues)),
        "objectRoot": envelope.get("objectRoot"),
        "phase": envelope.get("phase"),
        "projectionStatus": projection.get("status"),
        "projectionDrift": projection.get("drift", []),
    }


# fmt: off
ENVELOPE_SCHEMA_V2 = "kungfu.release-provenance-envelope/v2"
PROJECTION_SCHEMA_V2 = "kungfu.release-provenance-git-projection/v2"
MIGRATION_SCHEMA = "kungfu.release-provenance-migration/v1"
CONTENT_SCHEMA = "kungfu.release-source-content/v1"
SEMANTIC_RELATIONS_V2 = ("derived-from", "acknowledges", "has-content", "qualified-by", "approved-by", "authorized-by", "implements-contract")
_V2_ALGORITHM = re.compile(r"[a-z0-9][a-z0-9._/-]{0,63}")
_V2_DIGEST = re.compile(r"[0-9a-f]{32,256}")


def _v2_content(algorithm: str, digest: str) -> tuple[str, dict[str, str]]:
    if not isinstance(algorithm, str) or not _V2_ALGORITHM.fullmatch(algorithm):
        _fail("invalid-content", "sourceContent.algorithm is invalid")
    if not isinstance(digest, str) or not _V2_DIGEST.fullmatch(digest):
        _fail("invalid-content", "sourceContent.digest must be lowercase hex")
    record = {"schema": CONTENT_SCHEMA, "algorithm": algorithm, "digest": digest}
    return semantic_root(record), record


def build_candidate_v2(*, release_id: str, candidate_id: str, source_content_algorithm: str, source_content_digest: str,
                       candidate_commit: str, candidate_tree: str, dev_cut_commit: str, dev_cut_tree: str,
                       previous_alpha_commit: str, previous_alpha_tree: str, dev_cut_root: str,
                       previous_alpha_root: str, qualification_root: str, approval_root: str, authority_root: str,
                       contract_root: str, admission_roots: list[str], observed_parents: list[str]) -> dict[str, Any]:
    """Build a candidate whose semantic object root contains no Git OID."""
    content_root, content = _v2_content(source_content_algorithm, source_content_digest)
    if not release_id or not candidate_id:
        _fail("invalid-identity", "releaseId and candidate identity are required")
    subject = {"schema": "kungfu.release-provenance-identity/v2", "kind": "candidate",
               "releaseId": release_id, "identity": candidate_id, "contentRoot": content_root}
    subject_root = semantic_root(subject)
    identities = {"subjectRoot": subject_root, "contentRoot": content_root,
                  "derivationRoot": _require_root(dev_cut_root, "devCutRoot"),
                  "acknowledgementRoot": _require_root(previous_alpha_root, "previousAlphaRoot"),
                  "qualificationRoot": _require_root(qualification_root, "qualificationRoot"),
                  "approvalRoot": _require_root(approval_root, "approvalRoot"),
                  "authorityRoot": _require_root(authority_root, "authorityRoot"),
                  "contractRoot": _require_root(contract_root, "contractRoot")}
    identities["scopeRoot"] = semantic_root({"schema": "kungfu.release-provenance-scope/v2", "releaseId": release_id, "phase": "candidate"})
    identities["cutRoot"] = semantic_root({"schema": "kungfu.release-provenance-cut/v2", "releaseId": release_id,
                                            "candidateRoot": subject_root, "contentRoot": content_root,
                                            "devCutRoot": identities["derivationRoot"],
                                            "previousAlphaRoot": identities["acknowledgementRoot"]})
    admitted = [_require_root(root, "admissionRoots") for root in admission_roots]
    if len(admitted) != len(set(admitted)):
        _fail("ambiguous-admission", "admissionRoots must be unique")
    targets = dict(zip(SEMANTIC_RELATIONS_V2, (identities["derivationRoot"], identities["acknowledgementRoot"],
                   content_root, identities["qualificationRoot"], identities["approvalRoot"],
                   identities["authorityRoot"], identities["contractRoot"])))
    object_id = f"release-provenance:candidate:{candidate_id}:v2"
    predicates, relations = [], []
    for name in SEMANTIC_RELATIONS_V2:
        predicate_root, predicate = _predicate(name, identities["authorityRoot"])
        relation_root, relation = _relation(object_id=object_id, relation=name, predicate_root=predicate_root,
            source_root=subject_root, target_root=targets[name], cut_root=identities["cutRoot"],
            scope_root=identities["scopeRoot"], authority_root=identities["authorityRoot"], admission_roots=admitted)
        predicates.append({"root": predicate_root, "record": predicate})
        relations.append({"root": relation_root, "record": relation})
    obj = {"schema": "kungfu.fact.provenance-object/v1", "objectId": object_id, "subjectRoot": subject_root,
           "materialRoots": [subject_root, content_root, identities["qualificationRoot"], identities["approvalRoot"], identities["contractRoot"]],
           "relationRoots": [row["root"] for row in relations], "cutRoot": identities["cutRoot"],
           "authorityRoot": identities["authorityRoot"], "admissionRoots": admitted}
    object_root = record_root(obj)
    projection = {"schema": PROJECTION_SCHEMA_V2, "kind": "candidate-transport", "subjectRoot": subject_root,
                  "candidateCommit": _require_oid(candidate_commit, "candidateCommit"),
                  "candidateTree": _require_oid(candidate_tree, "candidateTree"),
                  "devCutCommit": _require_oid(dev_cut_commit, "devCutCommit"), "devCutTree": _require_oid(dev_cut_tree, "devCutTree"),
                  "previousAlphaCommit": _require_oid(previous_alpha_commit, "previousAlphaCommit"),
                  "previousAlphaTree": _require_oid(previous_alpha_tree, "previousAlphaTree"),
                  "observedParents": [_require_oid(value, "observedParents") for value in observed_parents], "semanticAuthority": False}
    projection_root = semantic_root(projection)
    pp_root, pp = _predicate("projected-as", identities["authorityRoot"])
    pr_root, pr = _relation(object_id=object_id, relation="projected-as", predicate_root=pp_root,
        source_root=object_root, target_root=projection_root, cut_root=identities["cutRoot"],
        scope_root=identities["scopeRoot"], authority_root=identities["authorityRoot"], admission_roots=admitted)
    return {"schema": ENVELOPE_SCHEMA_V2, "phase": "candidate", "releaseId": release_id, "objectRoot": object_root,
            "object": obj, "subject": subject, "sourceContent": {"root": content_root, "record": content},
            "identities": identities, "predicates": predicates, "relations": relations, "gitProjection": projection,
            "gitProjectionRoot": projection_root, "projectionPredicate": {"root": pp_root, "record": pp},
            "projectionRelation": {"root": pr_root, "record": pr}}


def _v2_rebuild(envelope: dict[str, Any]) -> dict[str, Any]:
    i, p, c, s, o = envelope["identities"], envelope["gitProjection"], envelope["sourceContent"]["record"], envelope["subject"], envelope["object"]
    return build_candidate_v2(release_id=envelope["releaseId"], candidate_id=s["identity"],
        source_content_algorithm=c["algorithm"], source_content_digest=c["digest"], candidate_commit=p["candidateCommit"],
        candidate_tree=p["candidateTree"], dev_cut_commit=p["devCutCommit"], dev_cut_tree=p["devCutTree"],
        previous_alpha_commit=p["previousAlphaCommit"], previous_alpha_tree=p["previousAlphaTree"],
        dev_cut_root=i["derivationRoot"], previous_alpha_root=i["acknowledgementRoot"],
        qualification_root=i["qualificationRoot"], approval_root=i["approvalRoot"], authority_root=i["authorityRoot"],
        contract_root=i["contractRoot"], admission_roots=o["admissionRoots"], observed_parents=p["observedParents"])


def verify_v2(envelope: Any, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    issues: list[str] = []
    required = {"schema", "phase", "releaseId", "objectRoot", "object", "subject", "sourceContent", "identities",
                "predicates", "relations", "gitProjection", "gitProjectionRoot", "projectionPredicate", "projectionRelation"}
    if not isinstance(envelope, dict) or envelope.get("schema") != ENVELOPE_SCHEMA_V2:
        return {"ok": False, "issues": ["unknown-schema"]}
    if set(envelope) != required or envelope.get("phase") != "candidate":
        return {"ok": False, "issues": ["invalid-envelope"]}
    raw_relations = envelope.get("relations")
    relations: list[Any] = raw_relations if isinstance(raw_relations, list) else []
    names = [row.get("record", {}).get("relationId", "").rsplit(":", 1)[-1] for row in relations if isinstance(row, dict)]
    for name in SEMANTIC_RELATIONS_V2:
        count = names.count(name)
        if count != 1:
            issues.append("ambiguous-authority" if name == "authorized-by" and count > 1 else f"{name}-relation-count")
    if names != list(SEMANTIC_RELATIONS_V2):
        issues.append("relation-order-mismatch")
    try:
        rebuilt = _v2_rebuild(envelope)
        if envelope["gitProjection"]["candidateTree"] != envelope["gitProjection"]["devCutTree"]:
            issues.append("candidate-tree-mismatch")
        if envelope["gitProjection"].get("semanticAuthority") is not False:
            issues.append("projection-semantic-authority")
        for name, row in zip(SEMANTIC_RELATIONS_V2, relations):
            if row != rebuilt["relations"][list(SEMANTIC_RELATIONS_V2).index(name)]:
                issues.append(f"{name}-relation-mismatch")
        for field, code in (("sourceContent", "content-root-mismatch"), ("subject", "subject-root-mismatch"),
                            ("object", "object-root-mismatch"), ("gitProjection", "git-projection-root-mismatch"),
                            ("projectionRelation", "projected-as-relation-mismatch")):
            if envelope[field] != rebuilt[field]:
                issues.append(code)
        if envelope != rebuilt:
            issues.append("invalid-envelope")
        observed = {"objectRoot": envelope["objectRoot"], **envelope["identities"], **envelope["gitProjection"]}
        for field, value in (expected or {}).items():
            if observed.get(field) != value:
                issues.append(f"expected-{field}-mismatch")
    except (KeyError, TypeError, ValueError, ReleaseProvenanceError):
        issues.append("invalid-content" if isinstance(envelope.get("sourceContent"), dict) else "invalid-envelope")
    projection = envelope.get("gitProjection", {})
    return {"schema": "kungfu.release-provenance-verification/v2", "ok": not issues, "issues": sorted(set(issues)),
            "objectRoot": envelope.get("objectRoot"), "phase": "candidate", "projectionRoot": envelope.get("gitProjectionRoot"),
            "observedParentCount": len(projection.get("observedParents", [])) if isinstance(projection, dict) and isinstance(projection.get("observedParents"), list) else None}


def migrate_candidate_v1(envelope: dict[str, Any], *, source_content_algorithm: str,
                         source_content_digest: str, approval_root: str) -> dict[str, Any]:
    old = deepcopy(envelope)
    if not _verify_v1(old)["ok"] or old.get("phase") != "candidate":
        _fail("invalid-predecessor", "migration requires a verified v1 candidate")
    p, i, o = old["gitProjection"], old["identities"], old["object"]
    successor = build_candidate_v2(release_id=old["releaseId"], candidate_id=old["subject"]["identity"],
        source_content_algorithm=source_content_algorithm, source_content_digest=source_content_digest,
        candidate_commit=p["candidateCommit"], candidate_tree=p["candidateTree"], dev_cut_commit=p["devCutCommit"],
        dev_cut_tree=p["devCutTree"], previous_alpha_commit=p["previousAlphaCommit"], previous_alpha_tree=p["previousAlphaTree"],
        dev_cut_root=i["derivationRoot"], previous_alpha_root=i["acknowledgementRoot"], qualification_root=i["qualificationRoot"],
        approval_root=approval_root, authority_root=i["authorityRoot"], contract_root=i["contractRoot"],
        admission_roots=o["admissionRoots"], observed_parents=p["observedParents"])
    si, so = successor["identities"], successor["object"]
    predicate_root, predicate = _predicate("succeeds", si["authorityRoot"])
    relation_root, relation = _relation(object_id=f"release-provenance:migration:{old['objectRoot']}", relation="succeeds",
        predicate_root=predicate_root, source_root=successor["objectRoot"], target_root=old["objectRoot"],
        cut_root=si["cutRoot"], scope_root=si["scopeRoot"], authority_root=si["authorityRoot"], admission_roots=so["admissionRoots"])
    receipt = {"schema": "kungfu.release-provenance-migration-receipt/v1", "predecessorSchema": old["schema"],
        "predecessorObjectRoot": old["objectRoot"], "predecessorProjectionRoot": old["gitProjectionRoot"],
        "successorSchema": successor["schema"], "successorObjectRoot": successor["objectRoot"],
        "successorProjectionRoot": successor["gitProjectionRoot"], "successorRelationRoot": relation_root,
        "authorityRoot": si["authorityRoot"], "cutRoot": si["cutRoot"], "priorObjectMutated": False}
    return {"schema": MIGRATION_SCHEMA, "predecessor": old, "successor": successor,
            "successorPredicate": {"root": predicate_root, "record": predicate},
            "successorRelation": {"root": relation_root, "record": relation},
            "receipt": {"root": semantic_root(receipt), "record": receipt}}


def verify_migration(bundle: Any) -> dict[str, Any]:
    issues: list[str] = []
    try:
        successor, predecessor = bundle["successor"], bundle["predecessor"]
        content = successor["sourceContent"]["record"]
        rebuilt = migrate_candidate_v1(predecessor, source_content_algorithm=content["algorithm"],
                                       source_content_digest=content["digest"], approval_root=successor["identities"]["approvalRoot"])
        if bundle != rebuilt:
            issues.append("migration-receipt-mismatch")
        if not _verify_v1(predecessor)["ok"]:
            issues.append("invalid-predecessor")
        if not verify_v2(successor)["ok"]:
            issues.append("invalid-successor")
    except (KeyError, TypeError, ValueError, ReleaseProvenanceError):
        issues.append("invalid-migration")
    predecessor = bundle.get("predecessor", {}) if isinstance(bundle, dict) else {}
    successor = bundle.get("successor", {}) if isinstance(bundle, dict) else {}
    return {"schema": "kungfu.release-provenance-migration-verification/v1", "ok": not issues, "issues": sorted(set(issues)),
            "predecessorObjectRoot": predecessor.get("objectRoot"), "successorObjectRoot": successor.get("objectRoot")}
# fmt: on
def verify(envelope: Any, expected: dict[str, Any] | None = None) -> dict[str, Any]:
    """Verify either the historical v1 envelope or topology-independent v2."""

    schema = envelope.get("schema") if isinstance(envelope, dict) else None
    if schema == ENVELOPE_SCHEMA:
        return _verify_v1(envelope, expected)
    if schema == ENVELOPE_SCHEMA_V2:
        return verify_v2(envelope, expected)
    return {"ok": False, "issues": ["unknown-schema"]}
