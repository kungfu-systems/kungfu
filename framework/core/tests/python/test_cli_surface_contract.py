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


def test_standalone_catalog_route_binds_to_one_live_click_authority():
    registry = _sample_registry()
    registry["standaloneCatalogRoutes"] = [
        {
            "prefix": "python -m kungfu.sample",
            "target": "kungfu sample read",
            "source": "kungfu/sample.py",
        }
    ]
    contract = surface_contract.fold(
        sample_root,
        metadata_registry=registry,
        schema=SCHEMA,
        kfd3_registry={
            "apis": [
                {
                    "id": "kungfu.sample.read",
                    "name": "kungfu sample read",
                    "maturity": "experimental",
                    "visibility": "public-agent",
                }
            ]
        },
        command_catalog={
            "commands": [
                {
                    "apiId": "kungfu.sample.read",
                    "name": "python -m kungfu.sample --json",
                }
            ]
        },
    )

    assert contract["diagnostics"]["ok"] is True
    assert (
        _surface(contract["surfaces"], "kungfu sample read")["kfd3_api_id"]
        == "kungfu.sample.read"
    )


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


def test_catalog_regeneration_refreshes_only_the_expected_surface_root(tmp_path):
    target = tmp_path / "surface_contract.registry.json"
    source = MODULE_PATH.with_name("surface_contract.registry.json").read_text(
        encoding="utf-8"
    )
    registry = json.loads(source)
    old_root = registry["catalogProjection"]["expectedSurfaceRoot"]
    new_root = "sha256:" + "a" * 64
    assert old_root != new_root
    target.write_text(source, encoding="utf-8")

    changed = surface_contract.refresh_expected_surface_root(
        {"surfaceRoot": new_root}, target
    )
    assert changed is True
    updated = target.read_text(encoding="utf-8")
    assert updated == source.replace(json.dumps(old_root), json.dumps(new_root), 1)
    assert (
        surface_contract.refresh_expected_surface_root(
            {"surfaceRoot": new_root}, target
        )
        is False
    )


def test_catalog_regeneration_fails_closed_on_ambiguous_registry_root(tmp_path):
    target = tmp_path / "surface_contract.registry.json"
    old_root = "sha256:" + "b" * 64
    target.write_text(
        json.dumps(
            {
                "catalogProjection": {"expectedSurfaceRoot": old_root},
                "duplicate": old_root,
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="not uniquely writable"):
        surface_contract.refresh_expected_surface_root(
            {"surfaceRoot": "sha256:" + "c" * 64}, target
        )


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
        alias_path = fixture["alias"]
        canonical = fixture["canonical"]
        assert registry_aliases[alias_path]["replacement"] == canonical
        assert _click_path(kfc, alias_path) is _click_path(kfc, canonical)

        surface = next(row for row in rows if alias_path in row["aliases"])
        assert surface["canonical_path"] == canonical
        diagnostic = next(
            row for row in surface["alias_diagnostics"] if row["path"] == alias_path
        )
        registry_row = registry_aliases[alias_path]
        profile = BASE_REGISTRY["aliasDispositionProfiles"][
            registry_row["evidence_profile"]
        ]
        assert diagnostic["path"] == alias_path
        assert diagnostic["status"] == registry_row["status"]
        assert diagnostic["replacement"] == canonical
        assert diagnostic["supported_window"] == registry_row["supported_window"]
        assert diagnostic["removal_gate"] == registry_row["removal_gate"]
        assert diagnostic["disposition"] == profile["disposition"]
        assert diagnostic["gate_status"] == profile["gate_status"]
        assert diagnostic["evidence_profile"] == registry_row["evidence_profile"]
        assert diagnostic["evidence"] == profile["evidence"]
        assert diagnostic["next_gate"] == profile["next_gate"]
        assert diagnostic["warning_channel"] == (
            "stderr" if registry_row["status"] == "deprecated" else None
        )


def test_all_registry_aliases_are_live_identity_preserving_delegations():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    for alias in BASE_REGISTRY.get("aliases", []):
        assert _click_path(kfc, alias["path"]) is _click_path(kfc, alias["replacement"])


def test_deprecation_warning_stays_off_stdout_and_corrected_canonical_is_quiet(
    tmp_path,
):
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    runner = CliRunner(mix_stderr=False)
    deprecated = runner.invoke(kfc, ["--home", str(tmp_path), "schema", "--help"])
    canonical = runner.invoke(kfc, ["--home", str(tmp_path), "dev", "schema", "--help"])

    assert deprecated.exit_code == canonical.exit_code == 0
    assert "compatibility alias" not in deprecated.stdout
    assert "use `kungfu dev schema`" in deprecated.stderr
    assert "compatibility alias" not in canonical.stderr

    # The installed binary dispatches root `env` to kungfu-trunk before Python;
    # the direct Click test shell deliberately has no product-side trunk. SDK
    # exercises the same quiet compatibility status without crossing that
    # installed-runtime boundary.
    for args in (["sdk", "--help"], ["dev", "sdk", "--help"]):
        result = runner.invoke(kfc, ["--home", str(tmp_path), *args])
        assert result.exit_code == 0, (args, result.output, result.stderr)
        assert "compatibility alias" not in result.stdout
        assert "compatibility alias" not in result.stderr


def test_every_deprecated_alias_has_a_blocked_machine_reviewable_disposition():
    for alias in BASE_REGISTRY["aliases"]:
        profile = BASE_REGISTRY["aliasDispositionProfiles"][alias["evidence_profile"]]
        if alias["status"] == "deprecated":
            assert alias["removal_gate"]
            assert profile["disposition"] == "retained-deprecated"
            assert profile["gate_status"] == "blocked"
            assert profile["evidence"]
            assert profile["next_gate"]
        else:
            assert alias["status"] == "compatibility"
            assert alias["removal_gate"] is None
            assert profile["disposition"] == "corrected-canonical-path"
            assert profile["gate_status"] == "not-applicable"


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
