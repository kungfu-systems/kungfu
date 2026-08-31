# SPDX-License-Identifier: Apache-2.0

"""Independent Python projection of the Kungfu Fact Root KFR2 protocol.

This module intentionally does not call the native Fact kernel.  The checked-in
conformance corpus compares its preimage bytes with the C++ authority.
"""

from __future__ import annotations

import hashlib
import re
import struct
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, NoReturn

PROTOCOL = "kungfu.fact-root.canonical/v2"
MAGIC = b"KFR2"

_SCHEMA_FIELDS = {
    "kungfu.fact.object/v2": (1, 2, 3, 4),
    "kungfu.fact.version/v2": (1, 2, 3, 4, 5, 6, 7),
    "kungfu.fact.relation-endpoint/v2": (1, 2, 3),
    "kungfu.fact.relation-add/v2": (1, 2, 3, 4, 5, 6, 7),
    "kungfu.fact.relation-revoke/v2": (1, 2, 3),
    "kungfu.fact.cut/v2": (1, 2, 3, 4, 5, 6, 7, 8, 9),
    "kungfu.fact.ref-transition/v2": (1, 2, 3, 4, 5, 6, 7, 8),
    "kungfu.fact.operation-receipt/v2": (1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
    "kungfu.fact.operation-request/v2": (1, 2),
    "kungfu.fact.root-set/v2": (1, 2),
    "kungfu.fact.authority-bundle/v2": (1, 2, 3, 4),
    "kungfu.fact.temporal-predicate/v1": (1, 2, 3, 4, 5, 6, 7),
    "kungfu.fact.temporal-relation/v1": (1, 2, 3, 4, 5, 6, 7, 8, 9),
    "kungfu.fact.temporal-supersession/v1": (1, 2, 3, 4, 5, 6, 7),
    "kungfu.fact.temporal-revocation/v1": (1, 2, 3, 4, 5, 6),
    "kungfu.fact.temporal-authority-proof/v1": (1, 2, 3, 4, 5, 6, 7, 8),
    "kungfu.fact.provenance-object/v1": (1, 2, 3, 4, 5, 6, 7, 8),
    "kungfu.fact.temporal-path-query/v1": (1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
    "kungfu.fact.temporal-path-receipt/v1": (1, 2, 3, 4, 5, 6, 7, 8),
    "kungfu.fact.root-mapping-receipt/v1": (1, 2, 3, 4, 5, 6),
}

_SCHEMA_OPTIONAL_FIELDS = {"kungfu.fact.relation-endpoint/v2": frozenset({3})}

_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_SIGNED_DECIMAL = re.compile(r"(?:0|-?[1-9][0-9]*)\Z")


class CanonicalEncodingError(ValueError):
    """Stable KFR2 rejection with a machine-facing failure code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> NoReturn:
    raise CanonicalEncodingError(code, message)


def _u64(value: int) -> bytes:
    return value.to_bytes(8, "big", signed=False)


def _hex(value: Any, field: str) -> bytes:
    if (
        not isinstance(value, str)
        or len(value) % 2
        or not re.fullmatch(r"[0-9a-f]*", value)
    ):
        _fail("canonical-invalid-hex", f"{field} must be even lower-case hex")
    return bytes.fromhex(value)


def _valid_scalar_utf8(raw: bytes) -> None:
    try:
        value = raw.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        _fail("canonical-invalid-unicode", str(error))
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        _fail("canonical-invalid-unicode", "surrogate code points are forbidden")


def _text_bytes(value: dict[str, Any]) -> bytes:
    if "utf8_hex" in value:
        raw = _hex(value["utf8_hex"], "utf8_hex")
    else:
        text = value.get("value")
        if not isinstance(text, str):
            _fail("canonical-invalid-descriptor", "text value must be a string")
        try:
            raw = text.encode("utf-8", "strict")
        except UnicodeEncodeError as error:
            _fail("canonical-invalid-unicode", str(error))
    _valid_scalar_utf8(raw)
    return raw


def _typed_integer(value: dict[str, Any], kind: str) -> bytes:
    raw = value.get("value")
    pattern = _DECIMAL if kind == "u64" else _SIGNED_DECIMAL
    if not isinstance(raw, str) or not pattern.fullmatch(raw):
        _fail("canonical-invalid-descriptor", f"{kind} must use canonical decimal")
    number = int(raw)
    lower, upper = (0, 2**64 - 1) if kind == "u64" else (-(2**63), 2**63 - 1)
    if not lower <= number <= upper:
        _fail("canonical-integer-range", f"{kind} is out of range")
    if kind == "u64":
        return b"\x10" + _u64(number)
    return b"\x11" + number.to_bytes(8, "big", signed=True)


def _typed_float(value: dict[str, Any]) -> bytes:
    bits = _hex(value.get("bits"), "bits")
    if len(bits) != 8:
        _fail("canonical-invalid-hex", "f64 bits must contain 8 bytes")
    number = struct.unpack(">d", bits)[0]
    if number != number or number in {float("inf"), float("-inf")}:
        _fail("canonical-non-finite-float", "NaN and infinity are forbidden")
    return b"\x12" + bits


def _typed_scalar(value: dict[str, Any], kind: str) -> bytes:
    if kind in {"absent", "null"}:
        if kind == "absent":
            _fail("canonical-absent", "absent is a schema condition, not a value")
        return b"\x00"
    if kind == "bool":
        if not isinstance(value.get("value"), bool):
            _fail("canonical-invalid-descriptor", "bool value must be boolean")
        return b"\x02" if value["value"] else b"\x01"
    if kind in {"u64", "i64"}:
        return _typed_integer(value, kind)
    if kind == "f64":
        return _typed_float(value)
    if kind == "text":
        raw = _text_bytes(value)
        return b"\x20" + _u64(len(raw)) + raw
    if kind == "bytes":
        raw = _hex(value.get("hex"), "hex")
        return b"\x21" + _u64(len(raw)) + raw
    _fail("canonical-unsupported-type", f"unsupported canonical type: {kind}")


def _typed_sequence(value: dict[str, Any], kind: str) -> bytes:
    items = value.get("items")
    if not isinstance(items, list):
        _fail("canonical-invalid-descriptor", f"{kind} items must be an array")
    encoded_items = [_typed(item) for item in items]
    if kind == "set":
        encoded_items.sort()
        if any(left == right for left, right in zip(encoded_items, encoded_items[1:])):
            _fail("canonical-duplicate-item", "set contains equal canonical items")
    return (
        (b"\x30" if kind == "array" else b"\x31")
        + _u64(len(encoded_items))
        + b"".join(encoded_items)
    )


def _typed_map(value: dict[str, Any]) -> bytes:
    entries = value.get("entries")
    if not isinstance(entries, list):
        _fail("canonical-invalid-descriptor", "map entries must be an array")
    encoded_entries: list[tuple[bytes, bytes]] = []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"key", "value"}:
            _fail("canonical-invalid-descriptor", "map entry requires key and value")
        key = entry["key"]
        if not isinstance(key, dict) or key.get("type") != "text":
            _fail("canonical-invalid-descriptor", "map keys must be text")
        encoded_entries.append((_typed(key), _typed(entry["value"])))
    encoded_entries.sort(key=lambda pair: pair[0])
    if any(
        left[0] == right[0] for left, right in zip(encoded_entries, encoded_entries[1:])
    ):
        _fail("canonical-duplicate-key", "map contains equal canonical keys")
    return (
        b"\x32"
        + _u64(len(encoded_entries))
        + b"".join(key + child for key, child in encoded_entries)
    )


def _typed_record_field(field, allowed):
    if not isinstance(field, dict) or set(field) != {"id", "value"}:
        _fail("canonical-invalid-descriptor", "record field requires id and value")
    raw_id = field["id"]
    if not isinstance(raw_id, str) or not _DECIMAL.fullmatch(raw_id):
        _fail("canonical-invalid-descriptor", "field id must be canonical decimal")
    field_id = int(raw_id)
    if field_id not in allowed:
        _fail("canonical-unknown-field", f"field {field_id} is not registered")
    return field_id, _typed(field["value"])


def _typed_record_fields(fields, allowed):
    if not isinstance(fields, list):
        _fail("canonical-invalid-descriptor", "record fields must be an array")
    encoded_fields: list[tuple[int, bytes]] = []
    for field in fields:
        encoded_fields.append(_typed_record_field(field, allowed))
    encoded_fields.sort(key=lambda pair: pair[0])
    if any(
        left[0] == right[0] for left, right in zip(encoded_fields, encoded_fields[1:])
    ):
        _fail("canonical-duplicate-field", "record contains a duplicate field id")
    return encoded_fields


def _typed_record(value: dict[str, Any]) -> bytes:
    schema = value.get("schema")
    if not isinstance(schema, str):
        _fail("canonical-invalid-descriptor", "record schema must be a string")
    allowed = _SCHEMA_FIELDS.get(schema)
    if allowed is None:
        _fail("canonical-unknown-schema", "record schema is not registered")
    encoded_fields = _typed_record_fields(value.get("fields"), allowed)
    present = {field_id for field_id, _child in encoded_fields}
    missing = set(allowed) - _SCHEMA_OPTIONAL_FIELDS.get(schema, frozenset()) - present
    if missing:
        _fail("canonical-missing-field", "record is missing a required field")
    schema_value = _typed({"type": "text", "value": schema})
    return (
        b"\x40"
        + schema_value
        + _u64(len(encoded_fields))
        + b"".join(_u64(field_id) + child for field_id, child in encoded_fields)
    )


def _typed(value: Any) -> bytes:
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        _fail("canonical-invalid-descriptor", "typed value requires a type")
    kind = value["type"]
    if kind in {"absent", "null", "bool", "u64", "i64", "f64", "text", "bytes"}:
        return _typed_scalar(value, kind)
    if kind in {"array", "set"}:
        return _typed_sequence(value, kind)
    if kind == "map":
        return _typed_map(value)
    if kind == "record":
        return _typed_record(value)
    _fail("canonical-unsupported-type", f"unsupported canonical type: {kind}")


def canonical_bytes(value: Any) -> bytes:
    """Return the exact KFR2 preimage for one typed logical value."""

    return MAGIC + _typed(value)


def canonical_root(value: Any) -> str:
    """Return the lowercase SHA-256 content root for one KFR2 value."""

    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


ROOT_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_PATH_DEPTH = 32

SCHEMA_FIELDS: dict[str, tuple[str, ...]] = {
    "kungfu.fact.temporal-predicate/v1": (
        "schema",
        "predicateId",
        "operations",
        "direction",
        "pathPolicy",
        "cyclePolicy",
        "authorityRoot",
    ),
    "kungfu.fact.temporal-relation/v1": (
        "schema",
        "relationId",
        "predicateRoot",
        "sourceRoot",
        "targetRoot",
        "validFromCutRoot",
        "scopeRoot",
        "authorityRoot",
        "admissionRoots",
    ),
    "kungfu.fact.temporal-supersession/v1": (
        "schema",
        "priorRelationRoot",
        "successorRelationRoot",
        "effectiveCutRoot",
        "reasonRoot",
        "authorityRoot",
        "admissionRoots",
    ),
    "kungfu.fact.temporal-revocation/v1": (
        "schema",
        "relationRoot",
        "effectiveCutRoot",
        "reasonRoot",
        "authorityRoot",
        "admissionRoots",
    ),
    "kungfu.fact.temporal-authority-proof/v1": (
        "schema",
        "proofId",
        "subjectAuthorityRoot",
        "governingAuthorityRoot",
        "operations",
        "validFromCutRoot",
        "revokedAtCutRoot",
        "admissionRoots",
    ),
    "kungfu.fact.provenance-object/v1": (
        "schema",
        "objectId",
        "subjectRoot",
        "materialRoots",
        "relationRoots",
        "cutRoot",
        "authorityRoot",
        "admissionRoots",
    ),
    "kungfu.fact.temporal-path-query/v1": (
        "schema",
        "queryId",
        "operation",
        "predicateRoot",
        "sourceRoot",
        "targetRoot",
        "cutRoot",
        "relationPathRoots",
        "requiredAuthorityRoot",
        "maxDepth",
    ),
    "kungfu.fact.temporal-path-receipt/v1": (
        "schema",
        "queryRoot",
        "status",
        "failureCode",
        "cutRoot",
        "relationPathRoots",
        "authorityProofRoots",
        "omissionRoots",
    ),
}

SET_FIELDS = {
    "operations",
    "admissionRoots",
    "materialRoots",
    "relationRoots",
    "authorityProofRoots",
    "omissionRoots",
}
ARRAY_FIELDS = {"relationPathRoots"}
NULLABLE_ROOT_FIELDS = {"revokedAtCutRoot"}
U64_FIELDS = {"maxDepth"}


class TemporalRelationError(ValueError):
    """Stable rejection from the temporal relation verifier."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _temporal_fail(code: str, message: str) -> NoReturn:
    raise TemporalRelationError(code, message)


def _typed_text(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, str) or (not value and field != "failureCode"):
        _temporal_fail(
            "invalid-record",
            f"{field} must be a string with its declared identity semantics",
        )
    return {"type": "text", "value": value}


def _typed_root(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, str) or not ROOT_PATTERN.fullmatch(value):
        _temporal_fail("orphan-root", f"{field} must be a lowercase SHA-256 root")
    return {"type": "text", "value": value}


def _typed_set(values: Any, field: str) -> dict[str, Any]:
    if not isinstance(values, list) or any(
        not isinstance(item, str) for item in values
    ):
        _temporal_fail("invalid-record", f"{field} must be an array of strings")
    if len(values) != len(set(values)):
        _temporal_fail("invalid-record", f"{field} contains a duplicate")
    encoder = _typed_root if field.endswith("Roots") else _typed_text
    return {"type": "set", "items": [encoder(item, field) for item in values]}


def _typed_array(values: Any, field: str) -> dict[str, Any]:
    if not isinstance(values, list):
        _temporal_fail("invalid-record", f"{field} must be an array")
    return {"type": "array", "items": [_typed_root(item, field) for item in values]}


def record_descriptor(record: dict[str, Any]) -> dict[str, Any]:
    """Project a closed temporal record into the authoritative KFR2 protocol."""

    if not isinstance(record, dict):
        _temporal_fail("invalid-record", "record must be an object")
    schema = record.get("schema")
    if not isinstance(schema, str):
        _temporal_fail("unknown-schema", "temporal record schema is not registered")
    fields = SCHEMA_FIELDS.get(schema)
    if fields is None:
        _temporal_fail("unknown-schema", "temporal record schema is not registered")
    if set(record) != set(fields):
        _temporal_fail(
            "invalid-record", "temporal record fields do not match its closed schema"
        )

    children: list[dict[str, Any]] = []
    for field_id, field in enumerate(fields, 1):
        value = record[field]
        if field in SET_FIELDS:
            typed = _typed_set(value, field)
        elif field in ARRAY_FIELDS:
            typed = _typed_array(value, field)
        elif field in NULLABLE_ROOT_FIELDS and value is None:
            typed = {"type": "null"}
        elif field in U64_FIELDS:
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                _temporal_fail("invalid-record", f"{field} must be an unsigned integer")
            typed = {"type": "u64", "value": str(value)}
        elif field.endswith("Root"):
            typed = _typed_root(value, field)
        else:
            typed = _typed_text(value, field)
        children.append({"id": str(field_id), "value": typed})
    return {"type": "record", "schema": schema, "fields": children}


def record_root(record: dict[str, Any]) -> str:
    """Return the independently reproducible KFR2 root for a temporal record."""

    return canonical_root(record_descriptor(record))


def _index(records: Any, family: str) -> dict[str, dict[str, Any]]:
    if not isinstance(records, list):
        _temporal_fail("invalid-bundle", f"{family} must be an array")
    result: dict[str, dict[str, Any]] = {}
    for item in records:
        if not isinstance(item, dict) or set(item) != {"root", "record"}:
            _temporal_fail(
                "invalid-bundle", f"{family} entries require root and record"
            )
        root = item["root"]
        if root != record_root(item["record"]):
            _temporal_fail(
                "root-mismatch", f"{family} record root does not match its bytes"
            )
        if root in result:
            _temporal_fail("ambiguous-root", f"{family} contains a duplicate root")
        result[root] = item["record"]
    return result


@dataclass(frozen=True)
class _Bundle:
    cuts: dict[str, dict[str, Any]]
    predicates: dict[str, dict[str, Any]]
    relations: dict[str, dict[str, Any]]
    supersessions: dict[str, dict[str, Any]]
    revocations: dict[str, dict[str, Any]]
    authority_proofs: dict[str, dict[str, Any]]
    provenance_objects: dict[str, dict[str, Any]]

    def ancestor(self, earlier: str, later: str) -> bool:
        pending = [later]
        visited: set[str] = set()
        while pending:
            current = pending.pop()
            if current == earlier:
                return True
            if current in visited:
                continue
            visited.add(current)
            if len(visited) > len(self.cuts):
                _temporal_fail("forbidden-cycle", "Cut lineage is cyclic")
            cut = self.cuts.get(current)
            if cut is None:
                _temporal_fail("orphan-root", "Cut lineage references an unknown root")
            pending.extend(cut["parentCutRoots"])
        return False


def _assert_root(value: Any, field: str) -> str:
    if not isinstance(value, str) or not ROOT_PATTERN.fullmatch(value):
        _temporal_fail("orphan-root", f"{field} is not a content root")
    return value


def _load_bundle(document: dict[str, Any]) -> _Bundle:
    expected = {
        "schema",
        "cuts",
        "predicates",
        "relations",
        "supersessions",
        "revocations",
        "authorityProofs",
        "provenanceObjects",
    }
    if not isinstance(document, dict) or set(document) != expected:
        _temporal_fail("invalid-bundle", "bundle fields do not match the closed schema")
    if document["schema"] != "kungfu.fact.temporal-bundle/v1":
        _temporal_fail("unknown-schema", "bundle schema is not supported")

    cuts: dict[str, dict[str, Any]] = {}
    if not isinstance(document["cuts"], list):
        _temporal_fail("invalid-bundle", "cuts must be an array")
    for cut in document["cuts"]:
        if not isinstance(cut, dict) or set(cut) != {
            "root",
            "parentCutRoots",
            "activeRelationRoots",
            "declarationRoots",
        }:
            _temporal_fail("invalid-bundle", "Cut projection has unexpected fields")
        root = _assert_root(cut["root"], "cut.root")
        if root in cuts:
            _temporal_fail("ambiguous-root", "Cut projection contains a duplicate root")
        for field in ("parentCutRoots", "activeRelationRoots", "declarationRoots"):
            if not isinstance(cut[field], list) or len(cut[field]) != len(
                set(cut[field])
            ):
                _temporal_fail(
                    "invalid-bundle", f"{field} must be a duplicate-free array"
                )
            for value in cut[field]:
                _assert_root(value, field)
        cuts[root] = cut

    bundle = _Bundle(
        cuts=cuts,
        predicates=_index(document["predicates"], "predicates"),
        relations=_index(document["relations"], "relations"),
        supersessions=_index(document["supersessions"], "supersessions"),
        revocations=_index(document["revocations"], "revocations"),
        authority_proofs=_index(document["authorityProofs"], "authorityProofs"),
        provenance_objects=_index(document["provenanceObjects"], "provenanceObjects"),
    )
    _validate_bundle(bundle)
    return bundle


def _validate_bundle(bundle: _Bundle) -> None:
    visiting_cuts: set[str] = set()
    visited_cuts: set[str] = set()

    def visit_cut(root: str) -> None:
        if root in visiting_cuts:
            _temporal_fail("forbidden-cycle", "Cut lineage is cyclic")
        if root in visited_cuts:
            return
        cut = bundle.cuts.get(root)
        if cut is None:
            _temporal_fail("orphan-root", "Cut lineage references an unknown root")
        visiting_cuts.add(root)
        for parent in cut["parentCutRoots"]:
            visit_cut(parent)
        visiting_cuts.remove(root)
        visited_cuts.add(root)

    for cut in bundle.cuts.values():
        for parent in cut["parentCutRoots"]:
            if parent not in bundle.cuts:
                _temporal_fail(
                    "orphan-root", "Cut parent is not present in the bounded bundle"
                )
        for relation_root_value in cut["activeRelationRoots"]:
            if relation_root_value not in bundle.relations:
                _temporal_fail("orphan-root", "Cut contains an unknown active relation")
        for declaration in cut["declarationRoots"]:
            if declaration not in bundle.predicates:
                _temporal_fail(
                    "orphan-root", "Cut contains an unknown predicate declaration"
                )
        visit_cut(cut["root"])

    for relation in bundle.relations.values():
        if relation["predicateRoot"] not in bundle.predicates:
            _temporal_fail(
                "unknown-predicate", "relation references an unknown predicate"
            )
        if relation["validFromCutRoot"] not in bundle.cuts:
            _temporal_fail("orphan-root", "relation references an unknown validity Cut")

    for predicate in bundle.predicates.values():
        if predicate["direction"] != "source-to-target":
            _temporal_fail(
                "invalid-record", "temporal predicates must declare one-way direction"
            )
        if predicate["pathPolicy"] not in {"single-edge", "explicit-bounded"}:
            _temporal_fail("invalid-record", "predicate path policy is not supported")
        if predicate["cyclePolicy"] != "forbid":
            _temporal_fail(
                "invalid-record", "the first temporal contract forbids cycles"
            )
        if not predicate["operations"]:
            _temporal_fail(
                "invalid-record", "predicate must scope at least one operation"
            )

    supersession_edges: dict[str, list[str]] = {}
    for record in bundle.supersessions.values():
        prior = record["priorRelationRoot"]
        successor = record["successorRelationRoot"]
        if prior not in bundle.relations or successor not in bundle.relations:
            _temporal_fail("orphan-root", "supersession references an unknown relation")
        if record["effectiveCutRoot"] not in bundle.cuts:
            _temporal_fail("orphan-root", "supersession references an unknown Cut")
        supersession_edges.setdefault(prior, []).append(successor)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(root: str) -> None:
        if root in visiting:
            _temporal_fail("forbidden-cycle", "supersession records form a cycle")
        if root in visited:
            return
        visiting.add(root)
        for successor in supersession_edges.get(root, []):
            visit(successor)
        visiting.remove(root)
        visited.add(root)

    for root in supersession_edges:
        visit(root)

    for record in bundle.revocations.values():
        if record["relationRoot"] not in bundle.relations:
            _temporal_fail("orphan-root", "revocation references an unknown relation")
        if record["effectiveCutRoot"] not in bundle.cuts:
            _temporal_fail("orphan-root", "revocation references an unknown Cut")

    for record in bundle.authority_proofs.values():
        if record["validFromCutRoot"] not in bundle.cuts:
            _temporal_fail("orphan-root", "authority proof references an unknown Cut")
        revoked = record["revokedAtCutRoot"]
        if revoked is not None and revoked not in bundle.cuts:
            _temporal_fail("orphan-root", "authority proof revocation Cut is unknown")

    for record in bundle.provenance_objects.values():
        if record["cutRoot"] not in bundle.cuts:
            _temporal_fail("orphan-root", "provenance object references an unknown Cut")
        if any(root not in bundle.relations for root in record["relationRoots"]):
            _temporal_fail(
                "orphan-root", "provenance object references an unknown relation"
            )


def _relation_current(bundle: _Bundle, relation_root_value: str, cut_root: str) -> None:
    relation = bundle.relations[relation_root_value]
    if not bundle.ancestor(relation["validFromCutRoot"], cut_root):
        _temporal_fail(
            "relation-not-yet-valid", "relation is not valid at the requested Cut"
        )
    for record in bundle.supersessions.values():
        if record["priorRelationRoot"] == relation_root_value and bundle.ancestor(
            record["effectiveCutRoot"], cut_root
        ):
            _temporal_fail("relation-superseded", "relation was superseded at this Cut")
    for record in bundle.revocations.values():
        if record["relationRoot"] == relation_root_value and bundle.ancestor(
            record["effectiveCutRoot"], cut_root
        ):
            _temporal_fail("relation-revoked", "relation was revoked at this Cut")
    if relation_root_value not in bundle.cuts[cut_root]["activeRelationRoots"]:
        _temporal_fail(
            "relation-inactive-at-cut", "relation is not active at the requested Cut"
        )


def _authority_receipts(
    bundle: _Bundle,
    authority_root: str,
    governing_root: str,
    operation: str,
    cut_root: str,
) -> list[str]:
    if authority_root == governing_root:
        return []
    matches: list[str] = []
    for root, proof in bundle.authority_proofs.items():
        if (
            proof["subjectAuthorityRoot"] == authority_root
            and proof["governingAuthorityRoot"] == governing_root
            and operation in proof["operations"]
            and bundle.ancestor(proof["validFromCutRoot"], cut_root)
            and (
                proof["revokedAtCutRoot"] is None
                or not bundle.ancestor(proof["revokedAtCutRoot"], cut_root)
            )
        ):
            matches.append(root)
    if not matches:
        _temporal_fail(
            "authority-missing", "no exact authority proof applies at this Cut"
        )
    if len(matches) != 1:
        _temporal_fail("ambiguous-authority", "more than one authority proof applies")
    return matches


def _receipt(
    query: dict[str, Any], status: str, failure: str, proofs: Iterable[str]
) -> dict[str, Any]:
    record = {
        "schema": "kungfu.fact.temporal-path-receipt/v1",
        "queryRoot": record_root(query),
        "status": status,
        "failureCode": failure,
        "cutRoot": query["cutRoot"],
        "relationPathRoots": list(query["relationPathRoots"]),
        "authorityProofRoots": sorted(set(proofs)),
        "omissionRoots": [],
    }
    return {"record": record, "root": record_root(record)}


def verify_path(document: dict[str, Any], query: dict[str, Any]) -> dict[str, Any]:
    """Verify one explicit path at one immutable Cut and return a rooted receipt."""

    if query.get("schema") != "kungfu.fact.temporal-path-query/v1":
        _temporal_fail("unknown-schema", "query schema is not supported")
    # Root the query before semantic evaluation so every semantic rejection has
    # a stable subject and a reproducible negative receipt.
    record_root(query)
    proof_roots: list[str] = []
    try:
        bundle = _load_bundle(document)
        cut_root = query["cutRoot"]
        if cut_root not in bundle.cuts:
            _temporal_fail("orphan-root", "query Cut is absent from the bounded bundle")
        predicate = bundle.predicates.get(query["predicateRoot"])
        if predicate is None:
            _temporal_fail("unknown-predicate", "query predicate is not declared")
        if query["predicateRoot"] not in bundle.cuts[cut_root]["declarationRoots"]:
            _temporal_fail("unknown-predicate", "predicate is not declared at this Cut")
        if predicate["authorityRoot"] != query["requiredAuthorityRoot"]:
            _temporal_fail(
                "authority-missing",
                "query authority does not own the predicate declaration",
            )
        operation = query["operation"]
        if operation not in predicate["operations"]:
            _temporal_fail(
                "unscoped-compatibility", "operation is outside predicate scope"
            )

        path = query["relationPathRoots"]
        max_depth = query["maxDepth"]
        if not 1 <= max_depth <= MAX_PATH_DEPTH or len(path) > max_depth:
            _temporal_fail(
                "path-bound-exceeded", "path exceeds the declared verifier bound"
            )
        if not path:
            _temporal_fail("path-missing", "the verifier does not search for a path")
        if len(path) != len(set(path)):
            _temporal_fail(
                "forbidden-cycle", "a relation root repeats in the explicit path"
            )
        if len(path) > 1 and predicate["pathPolicy"] != "explicit-bounded":
            _temporal_fail(
                "implicit-transitive-acceptance", "predicate forbids composed paths"
            )

        cursor = query["sourceRoot"]
        visited_endpoints = {cursor}
        for relation_root_value in path:
            relation = bundle.relations.get(relation_root_value)
            if relation is None:
                _temporal_fail("orphan-root", "query path contains an unknown relation")
            if relation["predicateRoot"] != query["predicateRoot"]:
                _temporal_fail(
                    "predicate-mismatch", "query path crosses predicate declarations"
                )
            _relation_current(bundle, relation_root_value, cut_root)
            if relation["sourceRoot"] != cursor:
                _temporal_fail(
                    "direction-mismatch", "relation direction does not match the path"
                )
            cursor = relation["targetRoot"]
            if cursor in visited_endpoints and predicate["cyclePolicy"] == "forbid":
                _temporal_fail("forbidden-cycle", "explicit path repeats an endpoint")
            visited_endpoints.add(cursor)
            proof_roots.extend(
                _authority_receipts(
                    bundle,
                    relation["authorityRoot"],
                    query["requiredAuthorityRoot"],
                    operation,
                    cut_root,
                )
            )
        if cursor != query["targetRoot"]:
            _temporal_fail(
                "direction-mismatch", "explicit path does not reach the target"
            )
        return _receipt(query, "accepted", "", proof_roots)
    except TemporalRelationError as error:
        return _receipt(query, "rejected", error.code, proof_roots)
