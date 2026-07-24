# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kungfu.agent import agent_hub


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
