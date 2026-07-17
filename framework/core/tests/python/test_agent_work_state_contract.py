# SPDX-License-Identifier: Apache-2.0

import copy
import hashlib
import json
import sys
import types

from click.testing import CliRunner
from jsonschema import Draft202012Validator
import pytest

fake = types.ModuleType("pykungfu")
fake.__file__ = "/nonexistent/pykungfu.so"
fake.yijinjing = types.SimpleNamespace(
    enums=types.SimpleNamespace(
        mode=types.SimpleNamespace(LIVE="LIVE", BACKTEST="BACKTEST"),
        location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
    )
)
runtime = types.ModuleType("pykungfu.runtime")
runtime.coordinator = object
runtime.locator = lambda value: {"value": value}
runtime.location = lambda *args: {"args": args}
runtime.compute_content_hash = lambda payload, algorithm: (
    f"{algorithm}:{hashlib.sha256(payload).hexdigest()}"
)
runtime.compute_content_hash_value = lambda payload, algorithm: hashlib.sha256(
    payload
).hexdigest()
runtime.format_content_hash = lambda algorithm, value: f"{algorithm}:{value}"
fake.runtime = runtime
sys.modules.setdefault("pykungfu", fake)
sys.modules.setdefault("pykungfu.runtime", runtime)

import kungfu  # noqa: E402

kungfu._build_info = {"version": "test"}

from kungfu import contract, durability  # noqa: E402
from kungfu.cli.commands import __registry__  # noqa: E402, F401
from kungfu.cli.commands import kfc  # noqa: E402


ROLE_IDS = ["pursuit", "atlas", "warrant", "episode"]
INVALID_INFERENCES = {
    "goal-is-authority",
    "context-is-reality",
    "plan-is-occurrence",
    "occurrence-is-completion",
    "parent-warrant-authorizes-descendant",
}


def contract_schema_errors(value):
    return list(Draft202012Validator(value["contractSchema"]).iter_errors(value))


def test_agent_work_state_contract_is_registered_and_self_validating():
    value = contract.load_contract("agent-work-state")

    assert value["schema"] == "kungfu.agent-work-state.contract/v1"
    assert value["weldedSurface"] == "agent-work-state-contract"
    assert value["roleOrder"] == ROLE_IDS
    assert [role["id"] for role in value["roles"]] == ROLE_IDS
    assert {row["id"] for row in value["invalidInferences"]} == INVALID_INFERENCES
    assert value["relations"]["inheritance"] == "none"
    assert value["qualification"]["gate"] == "P17"
    assert value["qualification"]["status"] == "not-qualified"
    assert [row["id"] for row in value["qualification"]["checks"]] == [
        f"FO{index}" for index in range(1, 9)
    ]
    assert value["publicSurfaces"]["governance"] == {
        "contract": "kfd-1-generic-query",
        "agent": "kfd-3-collaboration-interface",
        "agentDiscovery": "kfd-3-collaboration-interface",
        "human": "documentation",
        "decision": "architecture-decision",
        "register": "kfd-1-register",
    }


def test_agent_work_state_contract_fails_closed_on_qualification_and_surfaces():
    value = contract.load_contract("agent-work-state")
    mutations = []

    release_qualified = copy.deepcopy(value)
    release_qualified["status"]["releaseQualification"] = "qualified"
    mutations.append(release_qualified)

    p17_qualified = copy.deepcopy(value)
    p17_qualified["qualification"]["status"] = "qualified"
    mutations.append(p17_qualified)

    missing_check = copy.deepcopy(value)
    missing_check["qualification"]["checks"].pop()
    mutations.append(missing_check)

    missing_surface_governance = copy.deepcopy(value)
    del missing_surface_governance["publicSurfaces"]["governance"]
    mutations.append(missing_surface_governance)

    for mutation in mutations:
        assert contract_schema_errors(mutation)


def test_agent_work_state_contract_cannot_replace_its_schema_authority(tmp_path):
    value = contract.load_contract("agent-work-state")
    value["contractSchema"] = {}
    value["status"]["releaseQualification"] = "qualified"
    value["qualification"]["status"] = "qualified"
    candidate = tmp_path / "agent-work-state.json"
    candidate.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(ValueError, match="contract schema authority mismatch"):
        contract.load_contract("agent-work-state", str(candidate))


def test_agent_work_model_and_generic_contract_query_share_one_hash(tmp_path):
    runner = CliRunner()
    agent_result = runner.invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "agent", "work-model", "--json"],
    )
    generic_result = runner.invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "contract",
            "show",
            "agent-work-state",
            "--json",
        ],
    )

    assert agent_result.exit_code == 0, agent_result.output
    assert generic_result.exit_code == 0, generic_result.output
    agent_value = json.loads(agent_result.output)
    generic_value = json.loads(generic_result.output)
    assert agent_value["hash"] == generic_value["hash"]
    assert agent_value["roleOrder"] == generic_value["roleOrder"] == ROLE_IDS
    assert agent_value["qualification"] == generic_value["qualification"]


def test_agent_capabilities_discovers_the_same_work_model(tmp_path, monkeypatch):
    monkeypatch.setattr(durability, "capabilities", lambda: {"status": "test"})
    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "agent", "capabilities", "--json"],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    metadata = contract.contract_metadata("agent-work-state")
    assert payload["workModel"] == {
        "command": "kungfu agent work-model --json",
        "contract": metadata,
    }
    assert any(
        row["apiId"] == "kungfu.agent.work-model"
        and row["name"] == "kungfu agent work-model --json"
        for row in payload["commands"]["commands"]
    )


def test_agent_work_model_closes_the_kfd3_runtime_interface(tmp_path):
    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "agent", "verify", "--json"],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["runtimeAnchors"]["missingRuntimeAnchors"] == []
    assert payload["commandCatalog"]["missingRegistryEntries"] == []
    assert payload["commandCatalog"]["missingCatalogEntries"] == []
