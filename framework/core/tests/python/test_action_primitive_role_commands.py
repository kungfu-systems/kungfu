# SPDX-License-Identifier: Apache-2.0

import importlib.util
import sys
import types
from pathlib import Path

import pytest


CORE = Path(__file__).resolve().parents[2]
COMMAND = CORE / "src/python/kungfu/cli/commands/primitive_role.py"


class FakeWorkProfile:
    def __init__(self):
        self.applied = []

    def capabilities(self):
        operations = {
            "atlas": "refresh",
            "pursuit": "continue",
            "warrant": "attenuate",
            "episode": "seal",
        }
        return {
            "profile": "kungfu-kfd-7-action-profile",
            "actionSchema": "kungfu.kfd7.profile-action/v1",
            "receiptSchema": "kungfu.kfd7.profile-action-receipt/v1",
            "actionGeometryRoot": "sha256:" + "a" * 64,
            "domainProfileRoot": "sha256:" + "b" * 64,
            "roleSchemaRoots": {
                role: "sha256:" + str(index) * 64
                for index, role in enumerate(operations, start=1)
            },
            "roleBodySchemas": {
                role: f"kungfu.agent-work.{role}-role/v2" for role in operations
            },
            "transitions": {
                role: [{"operation": operation, "from": "before", "to": "after"}]
                for role, operation in operations.items()
            },
            "denials": ["invalid-request"],
            "authority": {"kernel": "Fact"},
            "nonClaims": ["not completion proof"],
        }

    def inspect(self, runtime_dir, ref_name):
        return {"runtimeDir": runtime_dir, "refName": ref_name}

    def apply_action(self, runtime_dir, request, *, execute=False):
        self.applied.append((runtime_dir, request, execute))
        return {"status": "planned"}


def load_primitive_role(monkeypatch):
    work_profile = FakeWorkProfile()
    kungfu = types.ModuleType("kungfu")
    agent = types.ModuleType("kungfu.agent")
    agent.work_profile = work_profile
    monkeypatch.setitem(sys.modules, "kungfu", kungfu)
    monkeypatch.setitem(sys.modules, "kungfu.agent", agent)
    spec = importlib.util.spec_from_file_location("primitive_role_under_test", COMMAND)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, work_profile


def test_each_public_role_projects_only_its_declared_transitions(monkeypatch):
    module, _work_profile = load_primitive_role(monkeypatch)
    expected = {
        "atlas": "refresh",
        "pursuit": "continue",
        "warrant": "attenuate",
        "episode": "seal",
    }
    for role, operation in expected.items():
        payload = module.role_capabilities(role)
        assert payload["schema"] == "kungfu.action-primitive-role-capabilities/v1"
        assert payload["role"] == role
        assert payload["transitions"] == [
            {"operation": operation, "from": "before", "to": "after"}
        ]
        assert payload["actionGeometryRoot"] == "sha256:" + "a" * 64
        assert payload["domainProfileRoot"] == "sha256:" + "b" * 64
        assert payload["roleBodySchema"] == f"kungfu.agent-work.{role}-role/v2"


def test_role_action_rejects_cross_role_requests_before_kernel(monkeypatch):
    module, work_profile = load_primitive_role(monkeypatch)
    with pytest.raises(Exception, match="subject.role='atlas'"):
        module.apply_role_action(
            "/runtime",
            "atlas",
            {"subject": {"role": "pursuit"}},
            False,
        )
    assert work_profile.applied == []


def test_role_action_delegates_to_existing_profile_engine(monkeypatch):
    module, work_profile = load_primitive_role(monkeypatch)
    request = {"subject": {"role": "episode"}}
    assert module.apply_role_action("/runtime", "episode", request, True) == {
        "status": "planned"
    }
    assert work_profile.applied == [("/runtime", request, True)]
