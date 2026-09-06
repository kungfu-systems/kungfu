# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
import hashlib
import json
import struct
from pathlib import Path
import pytest


if importlib.util.find_spec("pykungfu") is None:
    pytest.skip("native pykungfu binding is not built", allow_module_level=True)

from kungfu.storage import service  # noqa: E402


CHARACTERIZATION = json.loads(
    (
        Path(__file__).parents[4]
        / "tests/fixtures/fact-kernel-characterization/v1.json"
    ).read_text(encoding="utf-8")
)
KFR2_CORPUS = json.loads(
    (
        Path(__file__).parents[4] / "tests/fixtures/fact-root-canonical/vectors.json"
    ).read_text(encoding="utf-8")
)


def _root(digit: str) -> str:
    return "sha256:" + digit * 64


def _legacy_atoms_root(atoms: list[str]) -> str:
    raw = struct.pack(">Q", len(atoms)) + b"".join(
        struct.pack(">Q", len(atom.encode())) + atom.encode() for atom in atoms
    )
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _accepted(response: dict) -> dict:
    assert response["ok"] is True, response
    assert response["status"] == "accepted", response
    assert response["write_occurred"] is True, response
    return response


def _concurrent_ref_cas_worker(
    runtime_dir: str,
    request: dict,
    ready_queue,
    start_event,
    result_queue,
) -> None:
    try:
        ready_queue.put(request["transition_id"])
        if not start_event.wait(timeout=15):
            raise TimeoutError("concurrent Fact CAS start signal was not released")
        result_queue.put(service.fact_kernel(runtime_dir, "ref-cas", request))
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {
                "ok": False,
                "worker_error": f"{type(error).__name__}: {error}",
                "transition_id": request["transition_id"],
            }
        )


def _fact_query_worker(runtime_dir: str, result_queue) -> None:
    try:
        result_queue.put(
            service.fact_kernel(
                runtime_dir,
                "query",
                {"include_inventory": True},
            )
        )
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {"ok": False, "worker_error": f"{type(error).__name__}: {error}"}
        )


def _durability_reconcile_worker(
    runtime_dir: str, operation_id: str, result_queue
) -> None:
    try:
        result_queue.put(
            service.fact_kernel(
                runtime_dir,
                "durability-reconcile",
                {"operation_id": operation_id},
            )
        )
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {"ok": False, "worker_error": f"{type(error).__name__}: {error}"}
        )


def _authority_import_recovery_worker(
    runtime_dir: str, bundle: dict, result_queue
) -> None:
    try:
        before = service.fact_kernel(runtime_dir, "query", {"include_inventory": True})
        fsck = service.fact_kernel_fsck(runtime_dir)
        retry = service.fact_kernel(
            runtime_dir, "authority-import", {"bundle": bundle, "execute": True}
        )
        exported = service.fact_kernel(runtime_dir, "authority-export")
        result_queue.put(
            {"before": before, "fsck": fsck, "retry": retry, "exported": exported}
        )
    except BaseException as error:  # pragma: no cover - parent renders child failure
        result_queue.put(
            {"ok": False, "worker_error": f"{type(error).__name__}: {error}"}
        )


def _collect_process_results(processes, result_queue, *, timeout: int = 30):
    """Drain Queue payloads before join so Windows feeder threads can exit."""
    try:
        results = [result_queue.get(timeout=timeout) for _ in processes]
        for process in processes:
            process.join(timeout=5)
        assert [process.exitcode for process in processes] == [0] * len(processes)
        return results
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
        for process in processes:
            process.join(timeout=5)


def _durable_fact_cut(runtime: Path) -> str:
    object_id = "fact:dddddddddddddddddddddddddddddddd"
    _accepted(
        service.fact_kernel(
            runtime,
            "object-put",
            {
                "object_id": object_id,
                "object_type": "durable-admission-characterization",
                "created_by_receipt_root": _root("1"),
            },
        )
    )
    initial_version = _accepted(
        service.fact_kernel(
            runtime,
            "version-put",
            {
                "object_id": object_id,
                "body": '{"durable":true}',
                "schema_root": _root("2"),
                "parent_version_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
            },
        )
    )
    initial_cut = _accepted(
        service.fact_kernel(
            runtime,
            "cut-put",
            {
                "parent_cut_roots": [],
                "object_versions": [
                    {
                        "object_id": object_id,
                        "version_root": initial_version["result"]["version_root"],
                    }
                ],
                "active_relation_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )["result"]["cut_root"]
    current_version = _accepted(
        service.fact_kernel(
            runtime,
            "version-put",
            {
                "object_id": object_id,
                "body": '{"durable":"transitive"}',
                "schema_root": _root("2"),
                "parent_version_roots": [initial_version["result"]["version_root"]],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
            },
        )
    )
    return _accepted(
        service.fact_kernel(
            runtime,
            "cut-put",
            {
                "parent_cut_roots": [initial_cut],
                "object_versions": [
                    {
                        "object_id": object_id,
                        "version_root": current_version["result"]["version_root"],
                    }
                ],
                "active_relation_roots": [],
                "declaration_roots": [_root("3")],
                "admission_roots": [_root("4")],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )
    )["result"]["cut_root"]


def _durable_ref_request(
    cut_root: str,
    transition_id: str,
    *,
    requested_profile: str = "durable_sync",
    fault: str | None = None,
) -> dict:
    durability = {
        "requested_profile": requested_profile,
        "admission_profile": "fact-durable-admission/release-provenance-v1",
    }
    if fault is not None:
        durability["qualification_fault"] = {
            "schema": "kungfu.fact.durable-admission-fault/v1",
            "point": fault,
        }
    return {
        "transition_id": transition_id,
        "ref_name": f"facts/{transition_id}",
        "expected_old_cut_root": None,
        "expected_old_revision": 0,
        "new_cut_root": cut_root,
        "kind": "create",
        "reason_root": _root("5"),
        "durability": durability,
    }
