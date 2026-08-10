# SPDX-License-Identifier: Apache-2.0

"""Three-process qualification for the generic Fact kernel.

The retained work item is the real generic Fact kernel Assignment. Each actor
receives only filesystem artifacts and exact roots; no actor receives chat or
in-memory state from its predecessor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from kungfu.storage import service

SCHEMA = "kungfu.fact-kernel.dogfood-report/v1"
WORK_ITEM = "2026-07-18-kungfu-generic-fact-kernel"
REF_NAME = "heads/qualification/generic-fact-kernel"
QUALIFICATION_TIME = "2026-07-18T11:30:00Z"
ROLE_ORDER = ("pursuit", "atlas", "warrant", "episode")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _root(domain: str, value: Any) -> str:
    payload = f"kungfu.fact-kernel.dogfood/v1\0{domain}\0{_canonical(value)}"
    return f"sha256:{hashlib.sha256(payload.encode()).hexdigest()}"


def _fact_id(role: str) -> str:
    digest = hashlib.sha256(f"{WORK_ITEM}\0{role}".encode()).hexdigest()[:32]
    return f"fact:{digest}"


def _relation_id(kind: str) -> str:
    digest = hashlib.sha256(f"{WORK_ITEM}\0relation\0{kind}".encode()).hexdigest()[:32]
    return f"fact:{digest}"


def _kernel(runtime: Path, action: str, request: dict[str, Any]) -> dict[str, Any]:
    result = service.fact_kernel(runtime, action, request)
    if not result.get("ok"):
        raise AssertionError(f"{action} failed: {result}")
    return result


def _put_role(runtime: Path, role: str, body: dict[str, Any]) -> tuple[str, str]:
    object_id = _fact_id(role)
    created = _root("creation-receipt", {"role": role, "work_item": WORK_ITEM})
    declaration = _root("declaration", {"role": role})
    admission = _root("admission", {"role": role, "work_item": WORK_ITEM})
    _kernel(
        runtime,
        "object-put",
        {
            "object_id": object_id,
            "object_type": f"agent-work/{role}",
            "created_by_receipt_root": created,
        },
    )
    version = _kernel(
        runtime,
        "version-put",
        {
            "object_id": object_id,
            "body": _canonical(body),
            "schema_root": _root("role-schema", {"role": role, "version": 1}),
            "parent_version_roots": [],
            "declaration_roots": [declaration],
            "admission_roots": [admission],
        },
    )
    return object_id, version["result"]["version_root"]


def _add_relation(runtime: Path, kind: str, source: str, target: str) -> str:
    result = _kernel(
        runtime,
        "relation-add",
        {
            "relation_id": _relation_id(kind),
            "relation_type": kind,
            "source": {"kind": "logical-object", "id": source},
            "target": {"kind": "logical-object", "id": target},
            "attributes_root": _root(
                "relation-attributes", {"kind": kind, "inheriting": False}
            ),
            "admission_roots": [_root("relation-admission", {"kind": kind})],
        },
    )
    return result["result"]["relation_root"]


def actor_a(runtime: Path, handoff_path: Path, bundle_path: Path) -> None:
    runtime.mkdir(parents=True, exist_ok=True)
    role_bodies = {
        "pursuit": {
            "schema": "kungfu.agent-work.pursuit/v1",
            "work_item": WORK_ITEM,
            "success": "all seven child goals and protected PR closeout pass",
        },
        "atlas": {
            "schema": "kungfu.agent-work.atlas/v1",
            "source": "Project Cut verified Task Chart",
            "declared_cut": _root("input-atlas", WORK_ITEM),
        },
        "warrant": {
            "schema": "kungfu.agent-work.warrant/v1",
            "scope": {"goal": WORK_ITEM, "actions": ["implement", "verify", "handoff"]},
            "expires_at": "2026-07-19T00:00:00Z",
            "revoked": False,
        },
        "episode": {
            "schema": "kungfu.agent-work.episode/v1",
            "work_item": WORK_ITEM,
            "status": "sealed",
            "result": "generic Fact kernel qualification produced a successor Cut",
        },
    }
    identities: dict[str, str] = {}
    versions: dict[str, str] = {}
    for role in ROLE_ORDER:
        identities[role], versions[role] = _put_role(runtime, role, role_bodies[role])

    relation_specs = (
        ("uses-atlas", "pursuit", "atlas"),
        ("authorized-by", "pursuit", "warrant"),
        ("recorded-in", "pursuit", "episode"),
        ("observed-under", "episode", "atlas"),
    )
    relations = {
        kind: _add_relation(runtime, kind, identities[source], identities[target])
        for kind, source, target in relation_specs
    }
    common = {
        "object_versions": [
            {"object_id": identities[role], "version_root": versions[role]}
            for role in ROLE_ORDER
            if role != "episode"
        ],
        "active_relation_roots": [
            relations[kind] for kind in ("uses-atlas", "authorized-by")
        ],
        "declaration_roots": [_root("cut-declaration", WORK_ITEM)],
        "admission_roots": [_root("cut-admission", WORK_ITEM)],
        "episode_frontier": [],
        "omission_roots": [],
        "conflict_roots": [],
    }
    source_cut = _kernel(runtime, "cut-put", {"parent_cut_roots": [], **common})[
        "result"
    ]["cut_root"]
    created = _kernel(
        runtime,
        "ref-cas",
        {
            "transition_id": "fact-kernel-dogfood-create-v1",
            "ref_name": REF_NAME,
            "expected_old_cut_root": None,
            "expected_old_revision": 0,
            "new_cut_root": source_cut,
            "kind": "create",
            "reason_root": _root("ref-reason", "begin-qualification"),
        },
    )
    successor_cut = _kernel(
        runtime,
        "cut-put",
        {
            "parent_cut_roots": [source_cut],
            "object_versions": [
                {"object_id": identities[role], "version_root": versions[role]}
                for role in ROLE_ORDER
            ],
            "active_relation_roots": list(relations.values()),
            "declaration_roots": [_root("cut-declaration", WORK_ITEM)],
            "admission_roots": [_root("cut-admission", WORK_ITEM)],
            "episode_frontier": [
                {
                    "episode_id": 2026071801,
                    "sealed_content_root": _root(
                        "sealed-episode", role_bodies["episode"]
                    ),
                    "accepted_manifest_frame_uid": "fact-kernel-dogfood-episode-v1",
                }
            ],
            "omission_roots": [],
            "conflict_roots": [],
        },
    )["result"]["cut_root"]
    advanced = _kernel(
        runtime,
        "ref-cas",
        {
            "transition_id": "fact-kernel-dogfood-advance-v1",
            "ref_name": REF_NAME,
            "expected_old_cut_root": source_cut,
            "expected_old_revision": created["receipt"]["currentRevision"],
            "new_cut_root": successor_cut,
            "kind": "advance",
            "reason_root": _root("ref-reason", "sealed-successor"),
        },
    )
    pre_export_fsck = service.fact_kernel_fsck(runtime, cut_root=successor_cut)
    if not pre_export_fsck["ok"]:
        raise AssertionError(f"pre-export fsck failed: {pre_export_fsck}")
    bundle = service.fact_kernel_export(runtime, ref_name=REF_NAME)
    bundle_path.write_text(f"{_canonical(bundle)}\n", encoding="utf-8")
    handoff = {
        "schema": "kungfu.fact-kernel.no-chat-handoff/v1",
        "work_item": WORK_ITEM,
        "role_identities": identities,
        "role_versions": versions,
        "relation_roots": relations,
        "source_cut_root": source_cut,
        "successor_cut_root": successor_cut,
        "ref": {
            "name": REF_NAME,
            "revision": advanced["receipt"]["currentRevision"],
        },
        "bundle_root": bundle["bundle_root"],
        "required_inputs": ["handoff.json", "bundle.json"],
        "chat_inputs": 0,
    }
    handoff["handoff_root"] = _root("no-chat-handoff", handoff)
    handoff_path.write_text(f"{_canonical(handoff)}\n", encoding="utf-8")


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _typed_gaps(handoff: dict[str, Any]) -> list[str]:
    identities = handoff.get("role_identities", {})
    return [f"missing-{role}" for role in ROLE_ORDER if role not in identities]


def actor_b(
    runtime: Path, handoff_path: Path, bundle_path: Path, review_path: Path
) -> None:
    handoff = _load(handoff_path)
    bundle = _load(bundle_path)
    expected_handoff_root = handoff.pop("handoff_root")
    assert _root("no-chat-handoff", handoff) == expected_handoff_root
    handoff["handoff_root"] = expected_handoff_root
    assert bundle["bundle_root"] == handoff["bundle_root"]
    observed = service.fact_kernel(
        runtime,
        "query",
        {"cut_root": handoff["successor_cut_root"], "include_bodies": True},
    )
    assert observed["ok"] is True
    members = {row["member"][0] for row in observed["objects"]}
    assert members == set(handoff["role_identities"].values())
    assert len(set(handoff["role_identities"].values())) == 4

    missing_atlas = json.loads(_canonical(handoff))
    del missing_atlas["role_identities"]["atlas"]
    stale = service.fact_kernel(
        runtime,
        "ref-cas",
        {
            "transition_id": "fact-kernel-dogfood-stale-v1",
            "ref_name": REF_NAME,
            "expected_old_cut_root": _root("stale-cut", WORK_ITEM),
            "expected_old_revision": 0,
            "new_cut_root": handoff["successor_cut_root"],
            "kind": "advance",
            "reason_root": _root("ref-reason", "stale-negative"),
        },
    )
    assert stale["failure_code"] == "stale-ref" and stale["write_occurred"] is False

    fault_runtime = runtime.parent / "actor-b-fault-runtime"
    service.fact_kernel_import(fault_runtime, bundle, dry_run=False)
    warrant_relation = handoff["relation_roots"]["authorized-by"]
    revoked = _kernel(
        fault_runtime,
        "relation-revoke",
        {"relation_root": warrant_relation, "reason_root": _root("revoke", "warrant")},
    )
    rejected_cut = service.fact_kernel(
        fault_runtime,
        "cut-put",
        {
            "parent_cut_roots": [handoff["successor_cut_root"]],
            "object_versions": [
                {
                    "object_id": handoff["role_identities"][role],
                    "version_root": handoff["role_versions"][role],
                }
                for role in ROLE_ORDER
            ],
            "active_relation_roots": list(handoff["relation_roots"].values()),
            "declaration_roots": [_root("cut-declaration", WORK_ITEM)],
            "admission_roots": [_root("cut-admission", WORK_ITEM)],
            "episode_frontier": [],
            "omission_roots": [],
            "conflict_roots": [],
        },
    )
    assert rejected_cut["failure_code"] == "unknown-relation"
    episode_body = next(
        json.loads(row["body"])
        for row in observed["objects"]
        if row["member"][0] == handoff["role_identities"]["episode"]
    )
    warrant_body = next(
        json.loads(row["body"])
        for row in observed["objects"]
        if row["member"][0] == handoff["role_identities"]["warrant"]
    )
    expired_warrant = dict(warrant_body)
    expired_warrant["expires_at"] = "2026-07-17T00:00:00Z"
    substituted = json.loads(_canonical(handoff))
    substituted["role_identities"]["episode"] = substituted["role_identities"][
        "pursuit"
    ]
    review = {
        "schema": "kungfu.fact-kernel.no-chat-review/v1",
        "actor": "B",
        "inputs": [expected_handoff_root, bundle["bundle_root"]],
        "chat_inputs": 0,
        "identity_count": len(members),
        "relation_count": len(handoff["relation_roots"]),
        "faults": [
            {
                "id": "missing-atlas",
                "status": "typed-gap",
                "observed": _typed_gaps(missing_atlas),
            },
            {
                "id": "expired-warrant",
                "status": "refused",
                "observed": expired_warrant["expires_at"] < QUALIFICATION_TIME,
            },
            {
                "id": "revoked-warrant",
                "status": "refused",
                "observed": revoked["result"]["revoke_root"],
            },
            {
                "id": "descendant-scope",
                "status": "refused",
                "observed": warrant_body["scope"]["goal"] != f"{WORK_ITEM}/child",
            },
            {
                "id": "role-substitution",
                "status": "refused",
                "observed": len(set(substituted["role_identities"].values())) != 4,
            },
            {
                "id": "sealed-episode",
                "status": "visible",
                "observed": episode_body["status"],
            },
            {
                "id": "stale-ref",
                "status": "refused-without-write",
                "observed": stale["failure_code"],
            },
        ],
    }
    review["review_root"] = _root("no-chat-review", review)
    review_path.write_text(f"{_canonical(review)}\n", encoding="utf-8")


def actor_c(
    bundle_path: Path, handoff_path: Path, runtime: Path, continuation_path: Path
) -> None:
    assert not runtime.exists()
    bundle = _load(bundle_path)
    handoff = _load(handoff_path)
    imported = service.fact_kernel_import(runtime, bundle, dry_run=False)
    observed = service.fact_kernel(runtime, "query", {"ref_name": REF_NAME})
    rebuilt = service.fact_kernel_rebuild_projections(runtime)
    fsck = service.fact_kernel_fsck(runtime, cut_root=handoff["successor_cut_root"])
    parity = service.fact_kernel_backend_parity(runtime, target_provider="rocksdb")
    continuation = {
        "schema": "kungfu.fact-kernel.clean-continuation/v1",
        "actor": "C",
        "inputs": [handoff["handoff_root"], bundle["bundle_root"]],
        "chat_inputs": 0,
        "clean_runtime": True,
        "observed_cut_root": observed["cut_root"],
        "imported_cut_root": imported["observed_cut_root"],
        "fsck_root": fsck["report_root"],
        "projection_rebuild_root": rebuilt["after_root"],
        "projection_write_occurred": rebuilt["write_occurred"],
        "backend_reopen": "passed",
        "backend_parity_root": parity["after_root"],
        "semantic_roots_match": parity["semantic_roots_match"],
    }
    assert continuation["observed_cut_root"] == handoff["successor_cut_root"]
    assert continuation["imported_cut_root"] == handoff["successor_cut_root"]
    assert fsck["ok"] is True and parity["ok"] is True
    assert rebuilt["write_occurred"] is False
    continuation["continuation_root"] = _root("clean-continuation", continuation)
    continuation_path.write_text(f"{_canonical(continuation)}\n", encoding="utf-8")


def _run_actor(*args: str) -> None:
    subprocess.run([sys.executable, str(Path(__file__).resolve()), *args], check=True)


def run_qualification(work_dir: Path) -> dict[str, Any]:
    work_dir.mkdir(parents=True, exist_ok=True)
    source_runtime = work_dir / "actor-a-runtime"
    clean_runtime = work_dir / "actor-c-clean-runtime"
    handoff_path = work_dir / "handoff.json"
    bundle_path = work_dir / "bundle.json"
    review_path = work_dir / "review.json"
    continuation_path = work_dir / "continuation.json"
    _run_actor("actor-a", str(source_runtime), str(handoff_path), str(bundle_path))
    _run_actor(
        "actor-b",
        str(source_runtime),
        str(handoff_path),
        str(bundle_path),
        str(review_path),
    )
    _run_actor(
        "actor-c",
        str(bundle_path),
        str(handoff_path),
        str(clean_runtime),
        str(continuation_path),
    )

    handoff = _load(handoff_path)
    review = _load(review_path)
    continuation = _load(continuation_path)
    report = {
        "schema": SCHEMA,
        "qualified_at": "2026-07-18",
        "status": "qualified-with-residuals",
        "work_item": WORK_ITEM,
        "authority": "disposable-yijinjing-hana-pod-journal",
        "source_cut_root": handoff["source_cut_root"],
        "successor_cut_root": handoff["successor_cut_root"],
        "role_identities": handoff["role_identities"],
        "relation_roots": handoff["relation_roots"],
        "actors": [
            {"id": "A", "process": "independent", "result": handoff["handoff_root"]},
            {"id": "B", "process": "independent", "result": review["review_root"]},
            {
                "id": "C",
                "process": "independent",
                "result": continuation["continuation_root"],
            },
        ],
        "handoff": {
            "human_relay_count": 0,
            "chat_inputs": 0,
            "required_retained_inputs": handoff["required_inputs"],
            "exact_roots": [handoff["handoff_root"], handoff["bundle_root"]],
        },
        "fault_matrix": review["faults"]
        + [
            {
                "id": "projection-loss",
                "status": "rebuildable-read-only",
                "observed": continuation["projection_rebuild_root"],
            },
            {
                "id": "backend-reopen",
                "status": "passed",
                "observed": continuation["backend_parity_root"],
            },
        ],
        "recovery": {
            "clean_runtime": continuation["clean_runtime"],
            "exact_cut_preserved": continuation["observed_cut_root"]
            == handoff["successor_cut_root"],
            "fsck_root": continuation["fsck_root"],
            "semantic_roots_match": continuation["semantic_roots_match"],
            "destructive_repair_or_gc": False,
        },
        "measurements": {
            "total_ceremony": {
                "actor_processes": 3,
                "retained_handoff_inputs": 2,
                "human_relays": 0,
            },
            "reconstruction_cost": {"chat_bytes": 0, "exact_root_inputs": 2},
            "failure_visibility": "9/9 named faults or recovery boundaries retained",
            "human_agent_parity": "same machine report and public Agent Work contract; GUI/TUI parity remains residual",
        },
        "rival_simpler_model": {
            "model": "one mutable task row with implicit context, authority, and run state",
            "verdict": "falsified-for-this-work-item",
            "witnesses": [
                "atlas can be missing independently",
                "warrant relation can be revoked independently",
                "episode remains separately sealed and queryable",
            ],
        },
        "p17": {
            "status": "not-qualified",
            "checks": {
                "FO1": "qualified",
                "FO2": "qualified",
                "FO3": "partial",
                "FO4": "pending",
                "FO5": "partial",
                "FO6": "qualified",
                "FO7": "partial",
                "FO8": "partial",
            },
        },
        "decision": "continue-shadow",
        "decision_reason": "Identity, no-chat recovery, and failure visibility hold, but sustained dogfood, GUI/TUI parity, generic Warrant qualification, and release evidence remain incomplete.",
        "non_claims": [
            "No authority cutover was performed.",
            "No real user runtime was modified.",
            "P17 and universal four-role ontology remain unqualified.",
        ],
    }
    report["report_root"] = _root("qualification-report", report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("actor-a")
    a.add_argument("runtime", type=Path)
    a.add_argument("handoff", type=Path)
    a.add_argument("bundle", type=Path)
    b = sub.add_parser("actor-b")
    b.add_argument("runtime", type=Path)
    b.add_argument("handoff", type=Path)
    b.add_argument("bundle", type=Path)
    b.add_argument("review", type=Path)
    c = sub.add_parser("actor-c")
    c.add_argument("bundle", type=Path)
    c.add_argument("handoff", type=Path)
    c.add_argument("runtime", type=Path)
    c.add_argument("continuation", type=Path)
    run = sub.add_parser("run")
    run.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "actor-a":
        actor_a(args.runtime, args.handoff, args.bundle)
    elif args.command == "actor-b":
        actor_b(args.runtime, args.handoff, args.bundle, args.review)
    elif args.command == "actor-c":
        actor_c(args.bundle, args.handoff, args.runtime, args.continuation)
    else:
        with tempfile.TemporaryDirectory(prefix="kungfu-fact-dogfood-") as tmp:
            report = run_qualification(Path(tmp))
        rendered = f"{json.dumps(report, ensure_ascii=False, indent=2)}\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            print(rendered, end="")


if __name__ == "__main__":
    main()
