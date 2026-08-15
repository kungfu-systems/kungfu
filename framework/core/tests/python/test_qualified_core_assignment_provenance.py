# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

import kungfu

from kungfu import assignment_orchestration


def _sha256(marker):
    return "sha256:" + marker * 64


def _qualified_core_fixture(tmp_path):
    checkout = tmp_path / "kungfu"
    (checkout / ".git").mkdir(parents=True)
    binding = checkout / "framework" / "core" / "dist" / "kungfu" / "pykungfu.so"
    binding.parent.mkdir(parents=True)
    binding.touch()
    verifier = (
        checkout
        / "framework"
        / "assignment-capture"
        / "qualified-assignment-core-consumer.mjs"
    )
    verifier.parent.mkdir(parents=True)
    verifier.touch()
    return checkout, binding


def test_binding_provenance_accepts_verified_compatible_qualified_core(
    tmp_path, monkeypatch
):
    checkout, binding = _qualified_core_fixture(tmp_path)
    producer = "a" * 40
    consumer = "b" * 40
    tree = "c" * 40
    build_info = {
        "version": "4.0.0-alpha.1",
        "git": {"revision": producer, "pristine": True},
    }
    (binding.parent / "kungfubuildinfo.json").write_text(
        json.dumps(build_info), encoding="utf-8"
    )
    proof = {
        "schema": "shifu.qualified-assignment-core-admission-proof/v1",
        "repository": "kungfu-systems/kungfu",
        "consumingCommit": consumer,
        "consumingTree": tree,
        "producerCommit": producer,
        "qualifiedTargetCommit": "d" * 40,
        "compatibilityRoot": _sha256("1"),
        "objectRoot": _sha256("2"),
        "manifestRoot": _sha256("3"),
        "artifactRoot": _sha256("4"),
        "qualificationReceiptRoot": _sha256("5"),
        "promotionAuthorityRoot": _sha256("6"),
        "materializationReceiptRoot": _sha256("7"),
        "targetRoot": "framework/core/dist/kungfu",
    }
    proof["proofRoot"] = assignment_orchestration.semantic_root(proof)

    def run(command, **_kwargs):
        if command[0] == "node":
            return SimpleNamespace(stdout=json.dumps(proof))
        revision = tree if command[-1] == "HEAD^{tree}" else consumer
        return SimpleNamespace(stdout=revision + "\n")

    monkeypatch.setattr(kungfu, "_binding", SimpleNamespace(__file__=str(binding)))
    monkeypatch.setattr(assignment_orchestration.subprocess, "run", run)

    provenance = assignment_orchestration.binding_provenance()

    assert provenance["ok"] is True
    assert provenance["state"] == "qualified-core-materialization"
    assert provenance["checkout"] == str(checkout)
    assert provenance["source_revision"] == producer
    assert provenance["qualified_core_proof_root"] == proof["proofRoot"]
    assert provenance["materialization_receipt_root"] == _sha256("7")
    assert provenance["override"] is False


def test_binding_provenance_rejects_forged_qualified_core_proof(tmp_path, monkeypatch):
    _checkout, binding = _qualified_core_fixture(tmp_path)
    producer = "a" * 40
    consumer = "b" * 40
    (binding.parent / "kungfubuildinfo.json").write_text(
        json.dumps(
            {
                "version": "4.0.0-alpha.1",
                "git": {"revision": producer, "pristine": True},
            }
        ),
        encoding="utf-8",
    )
    forged = {
        "schema": "shifu.qualified-assignment-core-admission-proof/v1",
        "repository": "kungfu-systems/kungfu",
        "consumingCommit": consumer,
        "consumingTree": "c" * 40,
        "producerCommit": "d" * 40,
        "qualifiedTargetCommit": "e" * 40,
        "compatibilityRoot": _sha256("1"),
        "objectRoot": _sha256("2"),
        "manifestRoot": _sha256("3"),
        "artifactRoot": _sha256("4"),
        "qualificationReceiptRoot": _sha256("5"),
        "promotionAuthorityRoot": _sha256("6"),
        "materializationReceiptRoot": _sha256("7"),
        "targetRoot": "framework/core/dist/kungfu",
    }
    forged["proofRoot"] = assignment_orchestration.semantic_root(forged)

    def run(command, **_kwargs):
        if command[0] == "node":
            return SimpleNamespace(stdout=json.dumps(forged))
        revision = "c" * 40 if command[-1] == "HEAD^{tree}" else consumer
        return SimpleNamespace(stdout=revision + "\n")

    monkeypatch.setattr(kungfu, "_binding", SimpleNamespace(__file__=str(binding)))
    monkeypatch.setattr(assignment_orchestration.subprocess, "run", run)

    provenance = assignment_orchestration.binding_provenance()

    assert provenance["ok"] is False
    assert provenance["state"] == "degraded"
    assert provenance["fail_closed"] is True
