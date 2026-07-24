# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kungfu.agent import agent_hub, agent_hub_qualification


REPO_ROOT = Path(__file__).resolve().parents[4]
KFD_ROOT = REPO_ROOT / "node_modules/@kungfu-tech/kfd"


def _requests():
    manifest = json.loads(
        (KFD_ROOT / "profiles/agent-hub/manifest.json").read_text(encoding="utf-8")
    )
    registry = json.loads(
        (KFD_ROOT / "profiles/agent-hub/vectors/hub-20.json").read_text(
            encoding="utf-8"
        )
    )
    yield (
        {
            "schemaVersion": 1,
            "contract": agent_hub.REQUEST_CONTRACT,
            "requestId": "handshake",
            "operation": "handshake",
            "input": {
                "profile": (
                    f"{manifest['protocol']['id']}@{manifest['protocol']['version']}"
                ),
                "profileManifestDigest": manifest["protocol"]["manifestDigest"],
                "suiteRoot": manifest["suite"]["vectorRoot"],
                "minimumHubCount": 2,
            },
        },
        {
            "status": "accepted",
            "code": "adapter-ready",
            "verdict": "not-applicable",
        },
    )
    for vector in registry["vectors"]:
        yield (
            {
                "schemaVersion": 1,
                "contract": agent_hub.REQUEST_CONTRACT,
                "requestId": vector["id"],
                "operation": "evaluate",
                "input": {
                    "category": vector["category"],
                    "scenario": vector["request"]["scenario"],
                    "input": vector["request"]["input"],
                },
            },
            vector["expect"],
        )


def test_product_owned_hub_semantics_match_exact_kfd_hub_20(tmp_path):
    source = tmp_path / "hub-alpha" / ".kungfu"
    target = tmp_path / "hub-beta" / ".kungfu"
    observed = []
    for request, expected in _requests():
        response = agent_hub.handle_request(
            request,
            source_home=source,
            target_home=target,
            qualification_root=tmp_path,
        )
        actual = {
            "status": response["status"],
            "code": response["code"],
            "verdict": response["verdict"],
        }
        observed.append((request["requestId"], actual))
        assert actual == expected
        assert response["observations"]["authorityDomainsDistinct"] is True
        assert response["observations"]["productSurface"] == ("kungfu agent hub handle")
    assert len(observed) == 21
    assert (target / "runtime/agent-hub/exchange-store.json").is_file()
    assert (source / "runtime/agent-hub/exchange-store.json").is_file()


def test_capability_roots_are_unique_and_content_bound(tmp_path):
    left = agent_hub.capabilities("kungfu-work/hub-alpha", tmp_path / "alpha")
    right = agent_hub.capabilities("kungfu-work/hub-beta", tmp_path / "beta")
    assert left["identity"]["hubId"] != right["identity"]["hubId"]
    assert left["authorityRoots"] != right["authorityRoots"]
    assert agent_hub.semantic_root(left) != agent_hub.semantic_root(right)


def test_qualification_refuses_real_home_and_escaped_roots(tmp_path):
    request, _ = next(_requests())
    with pytest.raises(ValueError, match="real ~/.kungfu"):
        agent_hub.handle_request(
            request,
            source_home=Path.home() / ".kungfu",
            target_home=tmp_path / "target",
            qualification_root=tmp_path,
        )
    with pytest.raises(ValueError, match="escaped"):
        agent_hub.handle_request(
            request,
            source_home=tmp_path / "source",
            target_home=tmp_path.parent / "escaped",
            qualification_root=tmp_path,
        )


def test_idempotency_is_scoped_to_the_target_hub_store(tmp_path):
    request = {
        "schemaVersion": 1,
        "contract": agent_hub.REQUEST_CONTRACT,
        "requestId": "first",
        "operation": "evaluate",
        "input": {
            "category": "delivery",
            "scenario": "generic-duplicate",
            "input": {
                "firstPayloadRoot": "sha256:" + "a" * 64,
                "duplicatePayloadRoot": "sha256:" + "a" * 64,
                "idempotencyKey": "stable-key",
            },
        },
    }
    source = tmp_path / "source" / ".kungfu"
    target = tmp_path / "target" / ".kungfu"
    accepted = agent_hub.handle_request(
        request,
        source_home=source,
        target_home=target,
        qualification_root=tmp_path,
    )
    request["requestId"] = "conflict"
    request["input"]["input"]["firstPayloadRoot"] = "sha256:" + "b" * 64
    request["input"]["input"]["duplicatePayloadRoot"] = "sha256:" + "b" * 64
    rejected = agent_hub.handle_request(
        request,
        source_home=source,
        target_home=target,
        qualification_root=tmp_path,
    )
    assert accepted["code"] == "duplicate-preserved"
    assert rejected["code"] == "idempotency-conflict"


def test_human_qualification_projection_answers_the_user_questions(tmp_path):
    payload = {
        "valid": True,
        "product": {
            "name": "Kungfu Work",
            "version": "4.0.0-alpha.1",
            "platform": {"os": "darwin", "arch": "arm64"},
            "provenance": "installed-product",
        },
        "testedResponsibilities": agent_hub_qualification.WHAT_WAS_TESTED,
        "coverage": {"total": 20, "passed": 20, "failed": 0},
        "meaning": agent_hub_qualification.MEANING,
        "nonClaims": agent_hub_qualification.NON_CLAIMS,
        "isolation": {"realHomeUnchanged": True},
        "evidence": {
            "directory": str(tmp_path),
            "reportDigest": "sha256:" + "a" * 64,
        },
        "next": {"verify": "kungfu agent hub verify --qualification-dir result"},
    }
    text = agent_hub_qualification.render_human(payload)
    assert "KFD Agent Hub Qualification  PASSED" in text
    assert "20 of 20 scenarios passed" in text
    assert "What was tested" in text
    assert "What this means" in text
    assert "What this does NOT mean" in text
    assert "Your real ~/.kungfu state was unchanged" in text
    assert "KFD certification" in text
    assert "kungfu agent hub verify" in text


def test_kfd_entry_resolves_from_an_explicit_regular_file(tmp_path):
    entry = tmp_path / "kfd.mjs"
    entry.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    assert agent_hub_qualification.resolve_kfd_entry(entry) == entry


def test_product_executable_resolves_from_installed_manifest(tmp_path, monkeypatch):
    executable = tmp_path / "kungfu"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    manifest = tmp_path / "product.json"
    manifest.write_text(
        json.dumps({"entries": {"kungfu": "kungfu"}}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("KUNGFU_EXECUTABLE", raising=False)
    monkeypatch.setenv("KUNGFU_PRODUCT_MANIFEST", str(manifest))
    assert agent_hub_qualification.resolve_product_executable() == executable


def test_kfd_steps_reenter_the_installed_product_in_fresh_processes(
    tmp_path, monkeypatch
):
    executable = tmp_path / "kungfu"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    entry = tmp_path / "kfd.mjs"
    entry.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr(agent_hub_qualification.subprocess, "run", run)
    agent_hub_qualification._run_kfd(executable, entry, "test", "agent-hub")
    agent_hub_qualification._run_kfd(
        executable, entry, "verify", "agent-hub-report", "report.json"
    )
    assert [call[0] for call in calls] == [
        [str(executable), "agent"],
        [str(executable), "agent"],
    ]
    assert [
        json.loads(call[1]["env"]["KUNGFU_INTERNAL_AGENT_HUB_KFD_STEP"])
        for call in calls
    ] == [
        {"entry": str(entry), "commands": ["test", "agent-hub"]},
        {
            "entry": str(entry),
            "commands": ["verify", "agent-hub-report", "report.json"],
        },
    ]
    assert all(call[1]["capture_output"] is True for call in calls)
