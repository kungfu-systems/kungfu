# SPDX-License-Identifier: Apache-2.0

"""Integrity, portable bundle, and retention planning for the native Fact kernel.

The yijinjing journal remains authoritative.  This module consumes the native
opt-in authority inventory and never repairs, deletes, compacts, or chooses a
Profile authority.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

INTEGRITY_SCHEMA = "kungfu.fact-kernel.integrity/v1"
BUNDLE_SCHEMA = "kungfu.fact-kernel.portable-bundle/v1"
IMPORT_SCHEMA = "kungfu.fact-kernel.import-receipt/v1"
RETENTION_SCHEMA = "kungfu.fact-kernel.retention-plan/v1"
REBUILD_SCHEMA = "kungfu.fact-kernel.projection-rebuild/v1"
PARITY_SCHEMA = "kungfu.fact-kernel.backend-parity/v1"
_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def semantic_root(domain: str, value: Any) -> str:
    raw = f"kungfu.fact-kernel.integrity-root/v1\0{domain}\0{_canonical(value)}"
    return f"sha256:{hashlib.sha256(raw.encode()).hexdigest()}"


def _content_root(raw: str) -> str:
    return f"sha256:{hashlib.sha256(raw.encode()).hexdigest()}"


def _kernel(
    runtime_dir: str | Path, action: str, request: dict[str, Any]
) -> dict[str, Any]:
    from kungfu.storage import service

    result = service.fact_kernel(runtime_dir, action, request)
    if not result.get("ok", False):
        raise RuntimeError(
            f"fact kernel {action} failed: {result.get('failure_code', 'unknown')}: "
            f"{result.get('message', 'unknown error')}"
        )
    return result


def _inventory(runtime_dir: str | Path, *, bodies: bool = True) -> dict[str, Any]:
    result = _kernel(
        runtime_dir,
        "query",
        {"include_inventory": True, "include_bodies": bodies},
    )
    inventory = result.get("inventory")
    if not isinstance(inventory, Mapping):
        raise RuntimeError("native Fact authority inventory is unavailable")
    return {
        "counts": result.get("counts", {}),
        "refs": result.get("refs", {}),
        "fold_issues": result.get("issues", []),
        **dict(inventory),
    }


def _root_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _episode_frontier_requests(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("episodeFrontier must be an array")
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, list) or len(item) != 3:
            raise ValueError("episodeFrontier entries must be folded triples")
        result.append(
            {
                "episode_id": item[0],
                "sealed_content_root": item[1],
                "accepted_manifest_frame_uid": item[2],
            }
        )
    return result


def _fsck_versions(objects, versions, bodies, issue):
    for version_root, version in versions.items():
        object_id = version.get("objectId", "")
        if object_id not in objects:
            issue("orphan-version", version_root, object_id=object_id)
        for parent in _root_list(version.get("parentVersionRoots")):
            if parent not in versions:
                issue("missing-parent-version", version_root, parent_root=parent)
        if not _root_list(version.get("declarationRoots")):
            issue("declaration-root-missing", version_root)
        if not _root_list(version.get("admissionRoots")):
            issue("admission-root-missing", version_root)
        body = bodies.get(version_root, {})
        if body.get("status") != "available" or not isinstance(body.get("body"), str):
            issue("missing-body", version_root, body_root=version.get("bodyRoot"))
        elif _content_root(body["body"]) != version.get("bodyRoot"):
            issue("body-root-mismatch", version_root, body_root=version.get("bodyRoot"))


def _fsck_relations(objects, versions, relations, issue):
    for relation_root, relation in relations.items():
        for side in ("source", "target"):
            endpoint = relation.get(side, {})
            kind = endpoint.get("kind")
            identity = endpoint.get("id")
            if kind == "logical-object" and identity not in objects:
                issue("relation-endpoint-missing", relation_root, side=side)
            if kind == "pinned-version" and identity not in versions:
                issue("relation-endpoint-missing", relation_root, side=side)
        if not _root_list(relation.get("admissionRoots")):
            issue("relation-admission-missing", relation_root)


def _fsck_cut(current_root, cut, cuts, versions, relations, revoked, issue):
    for parent in _root_list(cut.get("parentCutRoots")):
        if parent not in cuts:
            issue("missing-parent-cut", current_root, parent_root=parent)
    for member in cut.get("objectVersions", []):
        if not isinstance(member, list) or len(member) != 2:
            issue("invalid-cut-member", current_root, member=member)
            continue
        object_id, version_root = member
        version = versions.get(version_root)
        if not isinstance(version, Mapping):
            issue("missing-cut-version", current_root, version_root=version_root)
        elif version.get("objectId") != object_id:
            issue(
                "cut-member-identity-mismatch", current_root, version_root=version_root
            )
    for relation_root in _root_list(cut.get("activeRelationRoots")):
        if relation_root not in relations:
            issue("missing-active-relation", current_root, relation_root=relation_root)
        elif relation_root in revoked:
            issue("revoked-relation-active", current_root, relation_root=relation_root)
    if not _root_list(cut.get("declarationRoots")):
        issue("cut-declaration-root-missing", current_root)
    if not _root_list(cut.get("admissionRoots")):
        issue("cut-admission-root-missing", current_root)
    for frontier in cut.get("episodeFrontier", []):
        valid_frontier = (
            isinstance(frontier, list)
            and len(frontier) == 3
            and isinstance(frontier[0], int)
            and frontier[0] >= 0
            and isinstance(frontier[1], str)
            and bool(_ROOT.fullmatch(frontier[1]))
            and isinstance(frontier[2], str)
            and bool(frontier[2])
        )
        if not valid_frontier:
            issue("episode-frontier-invalid", current_root, frontier=frontier)


def fsck(runtime_dir: str | Path, *, cut_root: str = "") -> dict[str, Any]:
    """Verify the folded authority and every closed root reference, read-only."""

    issues: list[dict[str, Any]] = []

    def issue(code: str, subject: str, **details: Any) -> None:
        issues.append(
            {"severity": "error", "code": code, "subject": subject, **details}
        )

    try:
        inventory = _inventory(runtime_dir)
    except Exception as error:
        issue("authority-unreadable", "fact-kernel", message=str(error))
        return {
            "schema": INTEGRITY_SCHEMA,
            "ok": False,
            "issue_count": 1,
            "issues": issues,
        }

    objects = inventory.get("objects", {})
    versions = inventory.get("versions", {})
    relations = inventory.get("relations", {})
    revoked = set(inventory.get("revoked_relation_roots", []))
    cuts = inventory.get("cuts", {})
    refs = inventory.get("refs", {})
    transitions = inventory.get("transitions", {})
    bodies = inventory.get("bodies", {})

    if inventory.get("counts", {}).get("unknown_records", 0):
        fold_issues = inventory.get("fold_issues", [])
        if fold_issues:
            for fold_issue in fold_issues:
                issue(
                    fold_issue.get("failure_code", "torn-or-unknown-authority-record"),
                    fold_issue.get("record_root") or "facts/kernel",
                    sequence=fold_issue.get("sequence"),
                    frame_tag=fold_issue.get("frame_tag"),
                    phase=fold_issue.get("phase"),
                    recovery=fold_issue.get("recovery"),
                    message=fold_issue.get("message", "Fact authority fold failed"),
                )
        else:
            issue(
                "torn-or-unknown-authority-record",
                "facts/kernel",
                count=inventory["counts"]["unknown_records"],
            )

    for object_id, document in objects.items():
        if document.get("objectId") != object_id:
            issue("object-identity-mismatch", object_id)

    _fsck_versions(objects, versions, bodies, issue)
    _fsck_relations(objects, versions, relations, issue)

    selected_cuts = {cut_root} if cut_root else set(cuts)
    for current_root in sorted(selected_cuts):
        cut = cuts.get(current_root)
        if not isinstance(cut, Mapping):
            issue("missing-cut", current_root)
            continue
        _fsck_cut(current_root, cut, cuts, versions, relations, revoked, issue)

    for ref_name, ref in refs.items():
        if ref.get("cut_root") not in cuts:
            issue("stale-ref-target", ref_name, cut_root=ref.get("cut_root"))
        if ref.get("transition_id") not in transitions:
            issue("ref-transition-missing", ref_name)

    report = {
        "schema": INTEGRITY_SCHEMA,
        "ok": not issues,
        "authority": "yijinjing-hana-pod-journal",
        "checked": {
            "objects": len(objects),
            "versions": len(versions),
            "relations": len(relations),
            "cuts": len(selected_cuts),
            "refs": len(refs),
        },
        "issue_count": len(issues),
        "issues": sorted(issues, key=lambda item: (item["code"], item["subject"])),
    }
    report["report_root"] = semantic_root("fsck-report/v1", report)
    return report


def _reachable(inventory: Mapping[str, Any], roots: set[str]) -> dict[str, set[str]]:
    cuts = inventory.get("cuts", {})
    versions = inventory.get("versions", {})
    reachable_cuts: set[str] = set()
    reachable_versions: set[str] = set()
    reachable_objects: set[str] = set()
    reachable_relations: set[str] = set()
    pending_cuts = list(roots)
    while pending_cuts:
        root = pending_cuts.pop()
        if root in reachable_cuts or root not in cuts:
            continue
        reachable_cuts.add(root)
        cut = cuts[root]
        pending_cuts.extend(_root_list(cut.get("parentCutRoots")))
        reachable_relations.update(_root_list(cut.get("activeRelationRoots")))
        for member in cut.get("objectVersions", []):
            if isinstance(member, list) and len(member) == 2:
                reachable_objects.add(member[0])
                reachable_versions.add(member[1])
    pending_versions = list(reachable_versions)
    while pending_versions:
        root = pending_versions.pop()
        version = versions.get(root)
        if not isinstance(version, Mapping):
            continue
        reachable_objects.add(version.get("objectId", ""))
        for parent in _root_list(version.get("parentVersionRoots")):
            if parent not in reachable_versions:
                reachable_versions.add(parent)
                pending_versions.append(parent)
    return {
        "cuts": reachable_cuts,
        "versions": reachable_versions,
        "objects": reachable_objects - {""},
        "relations": reachable_relations,
    }


def export_bundle(
    runtime_dir: str | Path, *, cut_root: str = "", ref_name: str = ""
) -> dict[str, Any]:
    if bool(cut_root) == bool(ref_name):
        raise ValueError("provide exactly one of cut_root or ref_name")
    report = fsck(runtime_dir, cut_root=cut_root)
    if not report["ok"]:
        raise RuntimeError("Fact kernel fsck must pass before export")
    inventory = _inventory(runtime_dir)
    refs = inventory.get("refs", {})
    if ref_name:
        if ref_name not in refs:
            raise ValueError(f"unknown ref: {ref_name}")
        cut_root = refs[ref_name]["cut_root"]
    reachable = _reachable(inventory, {cut_root})
    bodies = inventory.get("bodies", {})
    body_documents = {
        inventory["versions"][root]["bodyRoot"]: bodies[root]["body"]
        for root in reachable["versions"]
        if bodies.get(root, {}).get("status") == "available"
    }
    transitions = [
        value
        for value in inventory.get("transitions", {}).values()
        if value.get("newCutRoot") in reachable["cuts"]
    ]
    document = {
        "schema": BUNDLE_SCHEMA,
        "capabilities": {
            "identities": "exact",
            "cuts": "exact",
            "relations": "active-closure",
            "refs": "reachable-transition-chain",
            "bodies": "included",
        },
        "loss": [],
        "target": {"cut_root": cut_root, "ref_name": ref_name or None},
        "records": {
            "objects": [
                inventory["objects"][key] for key in sorted(reachable["objects"])
            ],
            "versions": [
                {"version_root": key, "document": inventory["versions"][key]}
                for key in sorted(reachable["versions"])
            ],
            "relations": [
                {"relation_root": key, "document": inventory["relations"][key]}
                for key in sorted(reachable["relations"])
            ],
            "cuts": [
                {"cut_root": key, "document": inventory["cuts"][key]}
                for key in sorted(reachable["cuts"])
            ],
            "transitions": sorted(
                transitions,
                key=lambda item: (item.get("refName", ""), item.get("revision", 0)),
            ),
        },
        "bodies": body_documents,
        "source_fsck_root": report["report_root"],
    }
    document["bundle_root"] = semantic_root("portable-bundle/v1", document)
    return document


def _verify_bundle(bundle: Mapping[str, Any]) -> None:
    if bundle.get("schema") != BUNDLE_SCHEMA:
        raise ValueError("unsupported Fact portable bundle schema")
    expected = bundle.get("bundle_root")
    unsigned = {key: value for key, value in bundle.items() if key != "bundle_root"}
    if expected != semantic_root("portable-bundle/v1", unsigned):
        raise ValueError("Fact portable bundle root mismatch")
    if bundle.get("loss") != []:
        raise ValueError("lossy Fact portable bundles are not importable")


def import_bundle(
    runtime_dir: str | Path, bundle: Mapping[str, Any], *, dry_run: bool = True
) -> dict[str, Any]:
    _verify_bundle(bundle)
    records = bundle.get("records", {})
    target_root = bundle["target"]["cut_root"]
    receipt: dict[str, Any] = {
        "schema": IMPORT_SCHEMA,
        "ok": True,
        "dry_run": dry_run,
        "bundle_root": bundle["bundle_root"],
        "target_cut_root": target_root,
        "counts": {
            key: len(records.get(key, []))
            for key in ("objects", "versions", "relations", "cuts", "transitions")
        },
    }
    if dry_run:
        return receipt

    for item in records.get("objects", []):
        _kernel(
            runtime_dir,
            "object-put",
            {
                "object_id": item["objectId"],
                "object_type": item["objectType"],
                "created_by_receipt_root": item["createdByReceiptRoot"],
            },
        )

    pending = list(records.get("versions", []))
    admitted_versions: set[str] = set()
    while pending:
        progressed = False
        for item in pending[:]:
            document = item["document"]
            parents = document.get("parentVersionRoots", [])
            if any(parent not in admitted_versions for parent in parents):
                continue
            body = bundle.get("bodies", {}).get(document["bodyRoot"])
            if not isinstance(body, str):
                raise ValueError(f"bundle body missing: {document['bodyRoot']}")
            result = _kernel(
                runtime_dir,
                "version-put",
                {
                    "object_id": document["objectId"],
                    "body": body,
                    "schema_root": document["schemaRoot"],
                    "parent_version_roots": parents,
                    "declaration_roots": document["declarationRoots"],
                    "admission_roots": document["admissionRoots"],
                },
            )
            root = result.get("result", {}).get("version_root") or result.get(
                "result", {}
            ).get("record_root")
            expected = item["version_root"]
            if root != expected:
                raise RuntimeError(
                    f"version-put root mismatch: expected {expected}, got {root}"
                )
            admitted_versions.add(root)
            pending.remove(item)
            progressed = True
        if not progressed:
            raise ValueError("bundle version graph is not closed or acyclic")

    for item in records.get("relations", []):
        document = item["document"]
        result = _kernel(
            runtime_dir,
            "relation-add",
            {
                "relation_id": document["relationId"],
                "relation_type": document["relationType"],
                "source": document["source"],
                "target": document["target"],
                "attributes_root": document["attributesRoot"],
                "admission_roots": document["admissionRoots"],
            },
        )
        root = result.get("result", {}).get("relation_root") or result.get(
            "result", {}
        ).get("record_root")
        if root != item["relation_root"]:
            raise RuntimeError(
                f"relation-add root mismatch: expected {item['relation_root']}, got {root}"
            )
    pending_cuts = list(records.get("cuts", []))
    admitted_cuts: set[str] = set()
    while pending_cuts:
        progressed = False
        for item in pending_cuts[:]:
            document = item["document"]
            if any(
                parent not in admitted_cuts
                for parent in document.get("parentCutRoots", [])
            ):
                continue
            result = _kernel(
                runtime_dir,
                "cut-put",
                {
                    "parent_cut_roots": document["parentCutRoots"],
                    "object_versions": [
                        {"object_id": member[0], "version_root": member[1]}
                        for member in document["objectVersions"]
                    ],
                    "active_relation_roots": document["activeRelationRoots"],
                    "declaration_roots": document["declarationRoots"],
                    "admission_roots": document["admissionRoots"],
                    "episode_frontier": _episode_frontier_requests(
                        document["episodeFrontier"]
                    ),
                    "omission_roots": document["omissionRoots"],
                    "conflict_roots": document["conflictRoots"],
                },
            )
            root = result.get("result", {}).get("cut_root") or result.get(
                "result", {}
            ).get("record_root")
            if root != item["cut_root"]:
                raise RuntimeError(
                    f"cut-put root mismatch: expected {item['cut_root']}, got {root}"
                )
            admitted_cuts.add(root)
            pending_cuts.remove(item)
            progressed = True
        if not progressed:
            raise ValueError("bundle Cut graph is not closed or acyclic")

    for item in records.get("transitions", []):
        result = _kernel(
            runtime_dir,
            "ref-cas",
            {
                "transition_id": item["transitionId"],
                "ref_name": item["refName"],
                "expected_old_cut_root": item["expectedOldCutRoot"] or None,
                "expected_old_revision": item["expectedOldRevision"],
                "new_cut_root": item["newCutRoot"],
                "kind": item["kind"],
                "reason_root": item["reasonRoot"],
            },
        )
        root = result.get("result", {}).get("transition_root")
        if root != item["transition_root"]:
            raise RuntimeError(
                f"ref-cas root mismatch: expected {item['transition_root']}, got {root}"
            )

    verified = fsck(runtime_dir, cut_root=target_root)
    if not verified["ok"]:
        raise RuntimeError("imported Fact kernel failed fsck")
    receipt["imported_fsck_root"] = verified["report_root"]
    receipt["observed_cut_root"] = _kernel(
        runtime_dir, "query", {"cut_root": target_root}
    )["cut_root"]
    return receipt


def retention_plan(
    runtime_dir: str | Path, *, cut_roots: list[str] | None = None
) -> dict[str, Any]:
    inventory = _inventory(runtime_dir, bodies=False)
    roots = set(
        cut_roots or [item["cut_root"] for item in inventory.get("refs", {}).values()]
    )
    reachable = _reachable(inventory, roots)
    plan = {
        "schema": RETENTION_SCHEMA,
        "ok": True,
        "mode": "plan-only",
        "destructive_execution": False,
        "roots": sorted(roots),
        "reachable": {key: sorted(value) for key, value in reachable.items()},
        "unreachable": {
            "objects": sorted(set(inventory.get("objects", {})) - reachable["objects"]),
            "versions": sorted(
                set(inventory.get("versions", {})) - reachable["versions"]
            ),
            "relations": sorted(
                set(inventory.get("relations", {})) - reachable["relations"]
            ),
            "cuts": sorted(set(inventory.get("cuts", {})) - reachable["cuts"]),
        },
    }
    plan["plan_root"] = semantic_root("retention-plan/v1", plan)
    return plan


def rebuild_projections(runtime_dir: str | Path) -> dict[str, Any]:
    before = _inventory(runtime_dir, bodies=False)
    after = _inventory(runtime_dir, bodies=False)
    before_root = semantic_root("authority-inventory/v1", before)
    after_root = semantic_root("authority-inventory/v1", after)
    return {
        "schema": REBUILD_SCHEMA,
        "ok": before_root == after_root,
        "mode": "authority-replay",
        "projection_count": 0,
        "before_root": before_root,
        "after_root": after_root,
        "write_occurred": False,
    }


def qualify_backend_parity(
    runtime_dir: str | Path, *, target_provider: str
) -> dict[str, Any]:
    from kungfu.storage import service

    before = _inventory(runtime_dir, bodies=False)
    before_root = semantic_root("authority-inventory/v1", before)
    switch = service.backend_switch(runtime_dir, target_provider=target_provider)
    after = _inventory(runtime_dir, bodies=False)
    after_root = semantic_root("authority-inventory/v1", after)
    return {
        "schema": PARITY_SCHEMA,
        "ok": before_root == after_root and switch.get("ok", False),
        "semantic_roots_match": before_root == after_root,
        "before_root": before_root,
        "after_root": after_root,
        "source_provider": switch.get("source_provider"),
        "target_provider": switch.get("target_provider"),
        "provider_semantic_root": switch.get("post_cut", {}).get("semantic_root"),
        "durability": service.backend_status(runtime_dir).get("durability"),
        "switch_receipt": switch,
    }
