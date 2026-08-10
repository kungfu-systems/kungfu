# SPDX-License-Identifier: Apache-2.0

import copy
import importlib.util
import json
import re
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
REMOVED_ALIAS_FIXTURE = json.loads(
    (REPO_ROOT / "framework/core/tests/fixtures/cli-removed-aliases.json").read_text(
        encoding="utf-8"
    )
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
    rendered = catalog_projection.render(first)
    assert rendered.count("\n") < len(first["surfaces"]) * 3

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


def test_live_registry_and_runtime_are_canonical_only():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    contract = surface_contract.fold(kfc, schema=SCHEMA)
    rows = contract["surfaces"]
    canonical_paths = [row["canonical_path"] for row in rows]

    assert BASE_REGISTRY["aliases"] == []
    assert "aliasDispositionProfiles" not in BASE_REGISTRY
    assert all(row["aliases"] == [] for row in rows)
    assert len(canonical_paths) == len(set(canonical_paths))
    assert all(row["maturity"] not in {"deprecated", "compatibility"} for row in rows)
    assert contract["diagnostics"]["ok"] is True


def test_every_removed_path_is_unknown_and_every_canonical_path_is_live(tmp_path):
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    runner = CliRunner()
    for fixture in REMOVED_ALIAS_FIXTURE["scripts"]:
        removed = fixture["removed"]
        canonical = fixture["canonical"]
        result = runner.invoke(
            kfc,
            ["--home", str(tmp_path), *removed.split()[1:], "--help"],
        )
        assert result.exit_code == 2, (removed, result.output)
        assert "No such command" in result.output
        assert _click_path(kfc, canonical) is not None


def test_internal_engage_subprocesses_use_the_only_canonical_path():
    sources = {
        "SDK Python-AOT builder": (
            REPO_ROOT / "developer/sdk/src/sdk-contract.js"
        ).read_text(encoding="utf-8"),
        "Nuitka bridge": (
            REPO_ROOT
            / "framework/core/src/python/kungfu/cli/bridging/nuitka/__init__.py"
        ).read_text(encoding="utf-8"),
    }
    removed_path = re.compile(
        r'["\']-m["\']\s*,\s*["\']kungfu["\']\s*,\s*["\']engage["\']'
    )
    canonical_path = re.compile(
        r'["\']-m["\']\s*,\s*["\']kungfu["\']\s*,\s*'
        r'["\']dev["\']\s*,\s*["\']engage["\']'
    )

    for owner, source in sources.items():
        assert removed_path.search(source) is None, owner
        assert canonical_path.search(source) is not None, owner


def test_python_wheel_does_not_publish_the_kfc_executable_alias():
    setup_source = (REPO_ROOT / "framework/core/src/python/setup.py").read_text(
        encoding="utf-8"
    )
    assert '"kfc = kungfu.__main__:main"' not in setup_source
    assert '"kungfu-exit-verify = kungfu.exit_verifier:main"' in setup_source


def test_native_primitives_and_non_equivalent_families_stay_canonical():
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
        "kungfu remote",
        "kungfu profile",
        "kungfu kfx",
        "kungfu work",
        "kungfu agent work",
    ):
        assert path in canonical_paths
