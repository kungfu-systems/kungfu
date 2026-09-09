# SPDX-License-Identifier: Apache-2.0
"""Cohesive agent work state contract cases."""
# ruff: noqa: F401,F403

from _agent_work_state_support import *
from _agent_work_state_support import (
    _MemoryFactKernel,
    _profile_request,
    _role_transition_request,
    _root,
    _session_fixture,
    _successor_request,
)


def test_agent_work_state_contract_is_registered_and_self_validating():
    value = contract.load_contract("agent-work-state")

    assert value["schema"] == "kungfu.agent-work-state.contract/v2"
    assert value["version"] == 2
    assert value["weldedSurface"] == "agent-work-state-contract"
    assert value["roleOrder"] == ROLE_IDS
    assert [role["id"] for role in value["roles"]] == ROLE_IDS
    assert {row["id"] for row in value["invalidInferences"]} == INVALID_INFERENCES
    assert value["relations"]["inheritance"] == "none"
    assert value["qualification"]["gate"] == "P17"
    assert value["qualification"]["status"] == "not-qualified"
    assert value["formalModel"]["version"] == 1
    assert value["actionBinding"]["primitive"] is False
    assert value["actionBinding"]["requiredRoots"] == [
        "fact_cut_root",
        "pursuit_root",
        "atlas_root",
        "warrant_root",
    ]
    Draft202012Validator.check_schema(value["profileSchema"])
    assert [row["id"] for row in value["qualification"]["checks"]] == [
        f"FO{index}" for index in range(1, 11)
    ]
    Draft202012Validator.check_schema(value["continuityValidation"]["evidenceSchema"])
    assert (
        value["continuityValidation"]["publicOutcome"]
        == "Keep the work when the chat ends."
    )
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

    missing_profile_schema = copy.deepcopy(value)
    del missing_profile_schema["profileSchema"]
    mutations.append(missing_profile_schema)

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
    assert payload["actionGeometry"] == contract.contract_metadata("action-geometry")
    assert payload["workDomainProfile"] == contract.contract_metadata(
        "agent-work-domain-profile"
    )
    assert payload["workLoop"] == first_value.work_authority_capabilities()
    assert any(
        row["apiId"] == "kungfu.agent.work-model"
        and row["name"] == "kungfu agent work-model --json"
        for row in payload["commands"]["commands"]
    )
    assert payload["workLoop"]["commandFamily"] == "kungfu work"
    assert payload["workLoop"]["legacyStore"] is False


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


def test_kfd7_authority_bundle_cli_exports_and_imports_the_same_public_shape(
    tmp_path, monkeypatch
):
    bundle = {
        "schema": work_profile.AUTHORITY_BUNDLE_SCHEMA,
        "bundleRoot": "sha256:" + "a" * 64,
    }
    exported = {
        "ok": True,
        "status": "exported",
        "result": {"bundle": bundle},
    }
    observed = {}
    monkeypatch.setattr(work_profile, "export_authority", lambda runtime_dir: exported)

    def import_authority(runtime_dir, candidate, *, execute=False):
        observed.update(
            {"runtimeDir": str(runtime_dir), "bundle": candidate, "execute": execute}
        )
        return {"ok": True, "status": "imported" if execute else "planned"}

    monkeypatch.setattr(work_profile, "import_authority", import_authority)
    runner = CliRunner()
    home = tmp_path / "home"
    export_result = runner.invoke(
        kfc,
        ["--home", str(home), "agent", "work", "export-authority", "--json"],
    )
    encoded = base64.b64encode(json.dumps(bundle).encode()).decode()
    import_result = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "agent",
            "work",
            "import-authority",
            "--input-base64",
            encoded,
            "--execute",
            "--json",
        ],
    )

    assert export_result.exit_code == 0, export_result.output
    assert json.loads(export_result.output) == exported
    assert import_result.exit_code == 0, import_result.output
    assert json.loads(import_result.output)["status"] == "imported"
    assert observed == {
        "runtimeDir": str(home / "runtime"),
        "bundle": bundle,
        "execute": True,
    }
