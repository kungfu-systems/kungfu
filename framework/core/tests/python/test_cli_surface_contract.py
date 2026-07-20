# SPDX-License-Identifier: Apache-2.0

import copy
import importlib.util
import json
from pathlib import Path

import click
import pytest
from click.testing import CliRunner

REPO_ROOT = Path(__file__).parents[4]
FIXTURE_ROOT = Path(__file__).parents[1] / "fixtures" / "cli-surface-contract"
MODULE_PATH = REPO_ROOT / "framework/core/src/python/kungfu/cli/surface_contract.py"
SPEC = importlib.util.spec_from_file_location(
    "kungfu_cli_surface_contract", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
surface_contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(surface_contract)
SCHEMA = json.loads(
    MODULE_PATH.with_name("surface_contract.schema.json").read_text(encoding="utf-8")
)
BASE_REGISTRY = json.loads(
    MODULE_PATH.with_name("surface_contract.registry.json").read_text(encoding="utf-8")
)
EMPTY_KFD3 = {"apis": []}
EMPTY_CATALOG = {"commands": []}
ALIAS_FIXTURE = json.loads(
    (
        REPO_ROOT / "framework/core/tests/fixtures/cli-canonical-alias-migration.json"
    ).read_text(encoding="utf-8")
)


@click.group(name="kungfu")
def sample_root():
    pass


@sample_root.group()
def sample():
    pass


@sample.command()
def read():
    pass


@sample.command()
@click.option("--execute", is_flag=True)
def mutate(execute):
    del execute


def _sample_registry():
    value = copy.deepcopy(BASE_REGISTRY)
    value["familyPolicies"] = {
        "sample": {
            "owner": "core",
            "audience": ["human", "agent"],
            "visibility": "public",
            "section": "fixture",
        }
    }
    value["aliases"] = []
    value["contributions"] = []
    return value


def _sample_contract():
    return surface_contract.fold(
        sample_root,
        metadata_registry=_sample_registry(),
        schema=SCHEMA,
        kfd3_registry=EMPTY_KFD3,
        command_catalog=EMPTY_CATALOG,
    )


def _observed_paths():
    return [
        "kungfu",
        "kungfu sample",
        "kungfu sample read",
        "kungfu sample mutate",
    ]


def _surface(rows, path):
    return next(row for row in rows if row["canonical_path"] == path)


def _click_path(root, path):
    command = root
    for token in path.split()[1:]:
        command = command.commands[token]
    return command


def test_fold_keeps_stable_identity_separate_from_path_and_projects_risk():
    contract = _sample_contract()
    assert contract["diagnostics"]["ok"] is True
    assert set(SCHEMA["requiredTopLevel"]) <= contract.keys()
    assert contract["contractRoot"].startswith("sha256:")
    assert contract["surfaceRoot"] == _sample_contract()["surfaceRoot"]

    read_surface = _surface(contract["surfaces"], "kungfu sample read")
    mutate_surface = _surface(contract["surfaces"], "kungfu sample mutate")
    assert read_surface["id"] != read_surface["canonical_path"]
    assert read_surface["owner"] == "core"
    assert read_surface["mutation_class"] == "read"
    assert mutate_surface["mutation_class"] == "write"
    assert mutate_surface["approval_policy"]["mode"] == "explicit-execute"


def test_fold_preserves_system_and_profile_kfx_ownership_and_availability():
    contribution_base = {
        "aliases": [],
        "audience": ["human", "agent"],
        "maturity": "preview",
        "visibility": "public",
        "section": "extensions",
        "kfd3_api_id": None,
        "mutation_class": "read",
        "approval_policy": {"mode": "none", "preconditions": []},
        "schema_refs": [],
        "replacement": None,
        "removal_gate": None,
        "source": {"kind": "kfx-contribution"},
    }
    system = {
        **contribution_base,
        "id": "fixture.system.command",
        "canonical_path": "kungfu system-fixture inspect",
        "owner": "system-kfx",
        "availability": {"state": "available", "conditions": ["system-profile"]},
    }
    profile = {
        **contribution_base,
        "id": "fixture.profile.command",
        "canonical_path": "kungfu profile-fixture inspect",
        "owner": "profile-kfx",
        "availability": {
            "state": "degraded",
            "reason": "profile-not-active",
            "conditions": ["profile-activation"],
        },
    }
    contract = surface_contract.fold(
        sample_root,
        metadata_registry=_sample_registry(),
        schema=SCHEMA,
        kfd3_registry=EMPTY_KFD3,
        command_catalog=EMPTY_CATALOG,
        contributions=[system, profile],
    )
    assert contract["diagnostics"]["ok"] is True
    assert contract["diagnostics"]["contributionCount"] == 2
    assert _surface(contract["surfaces"], system["canonical_path"])["owner"] == (
        "system-kfx"
    )
    assert (
        _surface(contract["surfaces"], profile["canonical_path"])["availability"][
            "state"
        ]
        == "degraded"
    )


@pytest.mark.parametrize("fixture_path", sorted(FIXTURE_ROOT.glob("*.json")))
def test_negative_contract_fixtures_fail_closed(fixture_path):
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    contract = _sample_contract()
    rows = copy.deepcopy(contract["surfaces"])
    metadata_registry = _sample_registry()
    operation = fixture["operation"]

    if operation == "drop-surface":
        rows = [row for row in rows if row["canonical_path"] != fixture["path"]]
    elif operation == "duplicate-surface":
        duplicate = copy.deepcopy(_surface(rows, fixture["path"]))
        duplicate["id"] = fixture["id"]
        duplicate["owner"] = fixture["owner"]
        rows.append(duplicate)
    elif operation == "aliases":
        metadata_registry["aliases"] = fixture["aliases"]
    elif operation == "set-field":
        _surface(rows, fixture["path"])[fixture["field"]] = fixture["value"]
    elif operation == "add-contribution":
        rows.append(fixture["surface"])
    else:
        raise AssertionError(f"unknown fixture operation {operation}")

    diagnostics = surface_contract.validate(
        rows,
        metadata_registry=metadata_registry,
        schema=SCHEMA,
        kfd3_registry=EMPTY_KFD3,
        command_catalog=EMPTY_CATALOG,
        observed_paths=_observed_paths(),
    )
    codes = {error["code"] for error in diagnostics["errors"]}
    assert diagnostics["ok"] is False
    assert fixture["expectedCode"] in codes


def test_live_click_tree_has_complete_contract_and_action_topology_parity():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    contract = surface_contract.fold(kfc, schema=SCHEMA)
    diagnostics = contract["diagnostics"]
    assert diagnostics["ok"] is True, diagnostics["errors"]
    assert diagnostics["familyCount"] >= 30
    assert diagnostics["leafCount"] >= 250
    assert all(
        set(SCHEMA["surfaceRequiredFields"]) <= row.keys()
        for row in contract["surfaces"]
    )

    action_topology = json.loads(
        (REPO_ROOT / "framework/action/cli-topology.contract.json").read_text(
            encoding="utf-8"
        )
    )
    parity = surface_contract.validate_action_topology(contract, action_topology)
    assert parity["ok"] is True, parity["missing"]


def test_surface_discovery_command_emits_the_same_valid_fold(tmp_path):
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path), "contract", "surface", "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.cli-surface-contract/v1"
    assert payload["diagnostics"]["ok"] is True
    assert any(
        row["canonical_path"] == "kungfu contract surface"
        for row in payload["surfaces"]
    )


def test_checked_in_catalog_is_the_deterministic_complete_projection(tmp_path):
    pytest.importorskip("pykungfu")
    from kungfu.cli import catalog_projection
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    contract = surface_contract.fold(kfc, schema=SCHEMA)
    first = catalog_projection.build(contract)
    second = catalog_projection.build(contract)
    assert first == second
    assert first["catalogRoot"].startswith("sha256:")
    assert first["surfaces"] == contract["surfaces"]
    assert len(first["kfd3Linkage"]) == len(first["surfaces"])
    assert all(
        row["reason"] for row in first["kfd3Linkage"] if row["state"] == "unlinked"
    )
    assert first["projection"]["consumers"]["agentCapabilities"] == ("embed-complete")
    assert first == json.loads(catalog_projection.catalog_path().read_text("utf-8"))

    stale = tmp_path / "cli_surface.catalog.json"
    stale.write_text("{}\n", encoding="utf-8")
    ok, message = catalog_projection.check(stale)
    assert ok is False
    assert message == f"stale generated catalog: {stale}"


def test_agent_capabilities_embeds_the_exact_offline_surface_catalog(tmp_path):
    pytest.importorskip("pykungfu")
    from kungfu import agent as agent_pack
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path), "agent", "capabilities", "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["cliSurface"] == agent_pack.cli_surface_catalog()
    assert (
        payload["cliSurface"]["surfaceRoot"]
        == surface_contract.fold(kfc, schema=SCHEMA)["surfaceRoot"]
    )


def test_canonical_aliases_share_handlers_and_publish_structured_diagnostics():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    contract = surface_contract.fold(kfc, schema=SCHEMA)
    rows = contract["surfaces"]
    registry_aliases = {row["path"]: row for row in BASE_REGISTRY.get("aliases", [])}

    for fixture in ALIAS_FIXTURE["scripts"]:
        legacy = fixture["legacy"]
        canonical = fixture["canonical"]
        assert registry_aliases[legacy]["replacement"] == canonical
        assert _click_path(kfc, legacy) is _click_path(kfc, canonical)

        surface = next(row for row in rows if legacy in row["aliases"])
        assert surface["canonical_path"] == canonical
        diagnostic = next(
            row for row in surface["alias_diagnostics"] if row["path"] == legacy
        )
        assert diagnostic == {
            "path": legacy,
            "status": "deprecated",
            "replacement": canonical,
            "supported_window": "v4 pre-release",
            "removal_gate": "separate major release gate plus usage evidence",
            "warning_channel": "stderr",
        }


def test_all_registry_aliases_are_live_identity_preserving_delegations():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    for alias in BASE_REGISTRY.get("aliases", []):
        assert _click_path(kfc, alias["path"]) is _click_path(kfc, alias["replacement"])


def test_legacy_warning_stays_off_stdout_and_canonical_path_is_quiet(tmp_path):
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    runner = CliRunner(mix_stderr=False)
    legacy = runner.invoke(kfc, ["--home", str(tmp_path), "sdk", "--help"])
    canonical = runner.invoke(kfc, ["--home", str(tmp_path), "dev", "sdk", "--help"])

    assert legacy.exit_code == canonical.exit_code == 0
    assert "compatibility alias" not in legacy.stdout
    assert "use `kungfu dev sdk`" in legacy.stderr
    assert "compatibility alias" not in canonical.stderr


def test_adr_0118_atlas_primitives_and_non_equivalent_families_stay_canonical():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    contract = surface_contract.fold(kfc, schema=SCHEMA)
    rows = contract["surfaces"]
    canonical_paths = {row["canonical_path"] for row in rows}
    for path in (
        "kungfu atlas capabilities",
        "kungfu atlas inspect",
        "kungfu atlas action",
        "kungfu atlas import",
        "kungfu atlas verify",
        "kungfu source",
        "kungfu remote",
        "kungfu profile",
        "kungfu kfx",
        "kungfu work",
        "kungfu agent work",
    ):
        assert path in canonical_paths
