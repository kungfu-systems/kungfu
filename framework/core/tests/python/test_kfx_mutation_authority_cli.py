# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import click
import pytest

from kungfu.cli.commands import kfx


def test_authority_file_rejects_lifecycle_and_caller_verdict_fields(tmp_path):
    authority = tmp_path / "authority.json"
    authority.write_text(
        '{"packageKey":"spoofed","allowed":true,"authorizationTime":10}',
        encoding="utf-8",
    )

    with pytest.raises(click.BadParameter, match="non-authority fields"):
        kfx._native_authority_file(authority)


def test_native_mutation_transports_one_core_authority_plan(monkeypatch, tmp_path):
    calls = []
    authority = {
        "purpose": "install exact package",
        "authorizationTime": 10,
        "assessmentTime": 10,
        "policy": {"schema": "kungfu.kfx-admission-policy/v1"},
        "approvalRoots": [],
    }
    plan = {
        "cutRoot": None,
        "revision": 0,
        "registryRoot": "sha256:registry",
        "graphRoot": "sha256:graph",
        "planRoot": "sha256:plan",
        "authorizationPlanRoot": "sha256:authorization",
        "warrantRoot": "sha256:warrant",
        "packages": [
            {
                "key": "example",
                "trustRoot": "sha256:trust",
                "packageRoot": "sha256:package",
            }
        ],
    }

    def fake_registry(action, request, runtime_dir):
        calls.append((action, request, runtime_dir))
        if action == "plan":
            return plan
        return {"revision": 2}

    monkeypatch.setattr(kfx.storage_service, "kfx_registry", fake_registry)
    ctx = SimpleNamespace(runtime_dir=tmp_path / "runtime")

    result = kfx._native_mutation(
        ctx,
        tmp_path / "package",
        "example",
        "install",
        True,
        authority,
    )

    assert result == {"revision": 2}
    assert [call[0] for call in calls] == ["plan", "apply"]
    planned = calls[0][1]
    applied = calls[1][1]
    assert planned["purpose"] == authority["purpose"]
    assert planned["packageKey"] == "example"
    assert planned["operation"] == "install"
    assert planned["runtimeTiers"] == {"example": "first-party-pinned"}
    assert "allowed" not in planned
    assert applied["expectedAuthorizationPlanRoot"] == "sha256:authorization"
    assert applied["expectedWarrantRoot"] == "sha256:warrant"
    assert applied["actor"] == "kungfu-cli"
