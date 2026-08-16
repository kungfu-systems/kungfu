# SPDX-License-Identifier: Apache-2.0

"""Read-only Profile projections over the native generic Fact kernel.

This module owns projection manifests and comparison diagnostics only. Object,
version, relation, Cut, ref, CAS, receipt, and persistence semantics remain in
``libkungfu`` through :func:`kungfu.storage.service.fact_kernel`.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

PROFILE_KINDS = frozenset({"initiative-assignment", "xinfa-atlas", "authority-receipt"})
MANIFEST_SCHEMA = "kungfu.fact-profile-shadow.manifest/v1"
BUNDLE_SCHEMA = "kungfu.fact-profile-shadow.bundle/v1"
COMPARISON_SCHEMA = "kungfu.fact-profile-shadow.comparison/v1"
_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def semantic_root(domain: str, value: Any) -> str:
    preimage = f"kungfu.fact-profile-shadow.root/v1\0{domain}\0{_canonical(value)}"
    return f"sha256:{hashlib.sha256(preimage.encode('utf-8')).hexdigest()}"


def _required_text(value: Mapping[str, Any], field: str) -> str:
    result = value.get(field)
    if not isinstance(result, str) or not result:
        raise ValueError(f"{field} must be a non-empty string")
    return result


def _required_root(value: Mapping[str, Any], field: str) -> str:
    result = _required_text(value, field)
    if not _ROOT.fullmatch(result):
        raise ValueError(f"{field} must be a sha256 root")
    return result


def stable_object_id(profile: str, source_id: str) -> str:
    if profile not in PROFILE_KINDS:
        raise ValueError(f"unsupported profile: {profile}")
    digest = hashlib.sha256(f"{profile}\0{source_id}".encode()).hexdigest()[:32]
    return f"fact:{digest}"


def normalize_manifest(source: Mapping[str, Any]) -> dict[str, Any]:
    profile = _required_text(source, "profile")
    source_id = _required_text(source, "source_id")
    if profile not in PROFILE_KINDS:
        raise ValueError(f"unsupported profile: {profile}")
    payload = source.get("payload")
    if not isinstance(payload, Mapping):
        raise ValueError("payload must be an object")
    loss = source.get("loss", [])
    if not isinstance(loss, list) or any(
        not isinstance(item, Mapping) for item in loss
    ):
        raise ValueError("loss must be an array of objects")
    normalized_loss = sorted(
        (dict(item) for item in loss), key=lambda item: _canonical(item)
    )
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "profile": profile,
        "source_id": source_id,
        "source_cut_root": _required_root(source, "source_cut_root"),
        "last_accepted_head": _required_root(source, "last_accepted_head"),
        "authority_receipt_root": _required_root(source, "authority_receipt_root"),
        "declaration_root": _required_root(source, "declaration_root"),
        "admission_root": _required_root(source, "admission_root"),
        "payload_root": semantic_root("profile-payload/v1", dict(payload)),
        "loss": normalized_loss,
        "loss_root": semantic_root("profile-loss/v1", normalized_loss),
    }
    manifest["manifest_root"] = semantic_root("profile-manifest/v1", manifest)
    return manifest


def _kernel(
    runtime_dir: str | Path, action: str, request: dict[str, Any]
) -> dict[str, Any]:
    from kungfu.storage import service

    result = service.fact_kernel(runtime_dir, action, request)
    if not result.get("ok", False):
        raise RuntimeError(
            f"fact kernel {action} failed: "
            f"{result.get('failure_code', 'unknown')}: "
            f"{result.get('message', 'unknown error')}"
        )
    return result


def project(
    runtime_dir: str | Path,
    document: Mapping[str, Any],
) -> dict[str, Any]:
    sources = document.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("sources must be a non-empty array")
    manifests = [normalize_manifest(source) for source in sources]
    if len({item["source_id"] for item in manifests}) != len(manifests):
        raise ValueError("source_id values must be unique")

    source_by_id = {
        _required_text(source, "source_id"): dict(source) for source in sources
    }
    members: list[dict[str, str]] = []
    object_ids: dict[str, str] = {}
    declaration_roots: set[str] = set()
    admission_roots: set[str] = set()
    omission_roots: set[str] = set()

    for manifest in manifests:
        source_id = manifest["source_id"]
        object_id = stable_object_id(manifest["profile"], source_id)
        object_ids[source_id] = object_id
        _kernel(
            runtime_dir,
            "object-put",
            {
                "object_id": object_id,
                "object_type": f"profile-shadow/{manifest['profile']}",
                "created_by_receipt_root": manifest["authority_receipt_root"],
            },
        )
        body = _canonical(
            {
                "schema": BUNDLE_SCHEMA,
                "manifest": manifest,
                "payload": source_by_id[source_id]["payload"],
            }
        )
        parent_roots = source_by_id[source_id].get("parent_version_roots", [])
        version = _kernel(
            runtime_dir,
            "version-put",
            {
                "object_id": object_id,
                "body": body,
                "schema_root": semantic_root("profile-shadow-schema/v1", BUNDLE_SCHEMA),
                "parent_version_roots": parent_roots,
                "declaration_roots": [manifest["declaration_root"]],
                "admission_roots": [manifest["admission_root"]],
            },
        )
        members.append(
            {
                "object_id": object_id,
                "version_root": version["result"]["version_root"],
            }
        )
        declaration_roots.add(manifest["declaration_root"])
        admission_roots.add(manifest["admission_root"])
        if manifest["loss"]:
            omission_roots.add(manifest["loss_root"])

    relation_roots: list[str] = []
    relations = document.get("relations", [])
    if not isinstance(relations, list):
        raise ValueError("relations must be an array")
    for relation in relations:
        if not isinstance(relation, Mapping):
            raise ValueError("relation entries must be objects")
        source_id = _required_text(relation, "source_id")
        target_id = _required_text(relation, "target_id")
        if source_id not in object_ids or target_id not in object_ids:
            raise ValueError("relation endpoints must name projected sources")
        relation_type = _required_text(relation, "relation_type")
        attributes = relation.get("attributes", {})
        if not isinstance(attributes, Mapping):
            raise ValueError("relation attributes must be an object")
        identity = {
            "relation_type": relation_type,
            "source": object_ids[source_id],
            "target": object_ids[target_id],
            "attributes": dict(attributes),
        }
        result = _kernel(
            runtime_dir,
            "relation-add",
            {
                "relation_id": f"fact:{semantic_root('relation-id/v1', identity)[7:39]}",
                "relation_type": relation_type,
                "source": {"kind": "logical-object", "id": object_ids[source_id]},
                "target": {"kind": "logical-object", "id": object_ids[target_id]},
                "attributes_root": semantic_root(
                    "relation-attributes/v1", dict(attributes)
                ),
                "admission_roots": sorted(admission_roots),
            },
        )
        relation_roots.append(result["result"]["relation_root"])

    cut = _kernel(
        runtime_dir,
        "cut-put",
        {
            "parent_cut_roots": document.get("parent_cut_roots", []),
            "object_versions": members,
            "active_relation_roots": relation_roots,
            "declaration_roots": sorted(declaration_roots),
            "admission_roots": sorted(admission_roots),
            "episode_frontier": document.get("episode_frontier", []),
            "omission_roots": sorted(omission_roots),
            "conflict_roots": document.get("conflict_roots", []),
        },
    )
    cut_root = cut["result"]["cut_root"]
    ref_receipt: dict[str, Any] | None = None
    ref = document.get("ref")
    if ref is not None:
        if not isinstance(ref, Mapping):
            raise ValueError("ref must be an object")
        ref_receipt = _kernel(
            runtime_dir,
            "ref-cas",
            {
                "transition_id": _required_text(ref, "transition_id"),
                "ref_name": _required_text(ref, "name"),
                "expected_old_cut_root": ref.get("expected_old_cut_root"),
                "expected_old_revision": ref.get("expected_old_revision", 0),
                "new_cut_root": cut_root,
                "kind": ref.get("kind", "create"),
                "reason_root": _required_root(ref, "reason_root"),
            },
        )
    return {
        "schema": "kungfu.fact-profile-shadow.projection-receipt/v1",
        "ok": True,
        "mode": "shadow-read-only",
        "cut_root": cut_root,
        "objects": object_ids,
        "manifests": manifests,
        "relation_roots": relation_roots,
        "ref_receipt": ref_receipt,
    }


def inspect(
    runtime_dir: str | Path, *, cut_root: str = "", ref_name: str = ""
) -> dict[str, Any]:
    query: dict[str, Any] = {"include_bodies": True}
    if cut_root:
        query["cut_root"] = cut_root
    if ref_name:
        query["ref_name"] = ref_name
    result = _kernel(runtime_dir, "query", query)
    decoded: list[dict[str, Any]] = []
    for row in result.get("objects", []):
        item = dict(row)
        if item.get("body_status") == "present":
            item["body_status"] = "available"
        body = item.get("body")
        if isinstance(body, str):
            try:
                item["projection"] = json.loads(body)
            except json.JSONDecodeError:
                item["projection_error"] = "invalid-json-body"
        decoded.append(item)
    result["objects"] = decoded
    result["projection_mode"] = "shadow-read-only"
    return result


def _manifest_map(sources: Iterable[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        stable_object_id(item["profile"], item["source_id"]): normalize_manifest(item)
        for item in sources
    }


def compare(expected: Mapping[str, Any], actual: Mapping[str, Any]) -> dict[str, Any]:
    sources = expected.get("sources")
    if not isinstance(sources, list):
        raise ValueError("expected sources must be an array")
    expected_by_id = _manifest_map(sources)
    actual_by_id: dict[str, dict[str, Any]] = {}
    invalid: list[str] = []
    for row in actual.get("objects", []):
        member = row.get("member", [])
        projection = row.get("projection")
        object_id = member[0] if isinstance(member, list) and member else ""
        manifest = (
            projection.get("manifest") if isinstance(projection, Mapping) else None
        )
        if object_id and isinstance(manifest, Mapping):
            actual_by_id[object_id] = dict(manifest)
        elif object_id:
            invalid.append(object_id)

    diagnostics: list[dict[str, Any]] = []
    for object_id in sorted(expected_by_id.keys() - actual_by_id.keys()):
        diagnostics.append({"kind": "missing", "object_id": object_id})
    for object_id in sorted(actual_by_id.keys() - expected_by_id.keys()):
        diagnostics.append({"kind": "extra", "object_id": object_id})
    for object_id in sorted(expected_by_id.keys() & actual_by_id.keys()):
        wanted = expected_by_id[object_id]
        found = actual_by_id[object_id]
        if found.get("source_cut_root") != wanted["source_cut_root"]:
            kind = "divergent"
        elif found.get("last_accepted_head") != wanted["last_accepted_head"]:
            kind = "stale"
        elif found != wanted:
            kind = "mismatch"
        else:
            continue
        diagnostics.append(
            {
                "kind": kind,
                "object_id": object_id,
                "expected_manifest_root": wanted["manifest_root"],
                "actual_manifest_root": found.get("manifest_root"),
            }
        )
    diagnostics.extend({"kind": "mismatch", "object_id": item} for item in invalid)
    counts = {
        kind: sum(item["kind"] == kind for item in diagnostics)
        for kind in ("missing", "extra", "mismatch", "stale", "divergent")
    }
    return {
        "schema": COMPARISON_SCHEMA,
        "ok": not diagnostics,
        "mode": "compare-without-authority-selection",
        "counts": counts,
        "diagnostics": diagnostics,
    }
