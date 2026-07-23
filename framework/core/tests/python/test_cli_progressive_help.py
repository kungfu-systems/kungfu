# SPDX-License-Identifier: Apache-2.0

import copy
import importlib.util
import json
from pathlib import Path

import click
import pytest
from click.testing import CliRunner


MODULE_PATH = (
    Path(__file__).parents[2]
    / "src"
    / "python"
    / "kungfu"
    / "cli"
    / "help_projection.py"
)
SPEC = importlib.util.spec_from_file_location("kungfu_help_projection", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
help_projection = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(help_projection)


@click.group(name="kungfu")
@click.option("--home", help="runtime home")
@click.help_option("-h", "--help")
def sample(home):
    del home


def _registry():
    return {
        "helpProjection": {
            "schema": "kungfu.cli-help-projection/v1",
            "defaultVisibilities": ["start-here", "public"],
            "sections": [
                {"id": "start-here", "title": "START HERE", "summary": "Begin."},
                {
                    "id": "action-model",
                    "title": "ACTION MODEL",
                    "summary": "Govern action objects.",
                },
                {
                    "id": "system-maintenance",
                    "title": "SYSTEM & MAINTENANCE",
                    "summary": "Maintain the runtime.",
                },
            ],
        }
    }


def _surface(name, section, visibility, *, availability=None):
    return {
        "id": f"fixture.{name}",
        "canonical_path": f"kungfu {name}",
        "path_depth": 2,
        "summary": f"operate {name}",
        "section": section,
        "visibility": visibility,
        "availability": availability
        or {"state": "available", "conditions": ["fixture"]},
        "maturity": "stable",
        "owner": "core",
        "audience": ["human", "agent"],
        "source": {"kind": "runtime-click"},
    }


def _contract():
    return {
        "version": "1.2.3",
        "contractRoot": "sha256:contract",
        "registryRoot": "sha256:registry",
        "diagnostics": {"ok": True, "errors": []},
        "surfaces": [
            _surface("cockpit", "start-here", "start-here"),
            _surface("pursuit", "action-model", "public"),
            _surface("atlas", "action-model", "public"),
            _surface("warrant", "action-model", "public"),
            _surface("episode", "action-model", "public"),
            _surface("runtime", "system-maintenance", "advanced"),
            _surface(
                "remote-profile",
                "system-maintenance",
                "advanced",
                availability={
                    "state": "degraded",
                    "reason": "profile-not-active",
                    "conditions": ["profile-activation"],
                },
            ),
        ],
    }


def test_projection_is_contract_bound_and_json_is_stable():
    projection = help_projection.build(
        sample, metadata_registry=_registry(), contract=_contract()
    )

    assert projection["contractRoot"] == "sha256:contract"
    assert projection["registryRoot"] == "sha256:registry"
    assert projection["projectionRoot"].startswith("sha256:")
    assert json.loads(help_projection.render_json(projection)) == projection
    assert (
        help_projection.build(
            sample, metadata_registry=_registry(), contract=_contract()
        )["projectionRoot"]
        == projection["projectionRoot"]
    )


def test_default_help_expands_public_objects_and_collapses_advanced_sections():
    projection = help_projection.build(
        sample, metadata_registry=_registry(), contract=_contract()
    )
    output = help_projection.render_human(projection, sample, version="4.0.0", width=80)

    for name in ("pursuit", "atlas", "warrant", "episode"):
        assert f"  {name}" in output
    assert "SYSTEM & MAINTENANCE  [system-maintenance]" in output
    assert "2 command families; expand with" in output
    assert "profile-not-active" not in output
    assert "\x1b[" not in output
    assert all(len(line) <= 80 for line in output.splitlines())

    expanded = help_projection.render_human(
        projection,
        sample,
        version="4.0.0",
        mode="section",
        section="system-maintenance",
        width=80,
    )
    assert "[degraded: profile-not-active]" in expanded
    assert "ACTION MODEL" not in expanded


def test_projection_fails_closed_for_unknown_or_duplicate_sections():
    contract = _contract()
    contract["surfaces"][0]["section"] = "not-governed"
    with pytest.raises(help_projection.ProjectionError, match="unknown help section"):
        help_projection.build(sample, metadata_registry=_registry(), contract=contract)

    registry = copy.deepcopy(_registry())
    registry["helpProjection"]["sections"].append(
        copy.deepcopy(registry["helpProjection"]["sections"][0])
    )
    with pytest.raises(help_projection.ProjectionError, match="duplicate ids"):
        help_projection.build(sample, metadata_registry=registry, contract=_contract())


def test_live_root_discovery_never_materializes_runtime(monkeypatch):
    pytest.importorskip("pykungfu")
    from kungfu.cli import commands
    from kungfu.cli.commands import __registry__  # noqa: F401

    def fail(_ctx):
        raise AssertionError("help initialized the runtime")

    monkeypatch.setattr(commands, "initialize_runtime_context", fail)
    runner = CliRunner()
    for args in ([], ["--help"], ["--help-all"], ["--help-section", "action-model"]):
        result = runner.invoke(commands.kfc, args, color=False, terminal_width=80)
        assert result.exit_code == 0, result.output
        assert "ACTION MODEL" in result.output

    result = runner.invoke(commands.kfc, ["--help-json"], color=False)
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.cli-help-projection/v1"
    assert payload["contractRoot"].startswith("sha256:")


def test_live_unknown_section_is_a_named_usage_error():
    pytest.importorskip("pykungfu")
    from kungfu.cli.commands import kfc
    from kungfu.cli.commands import __registry__  # noqa: F401

    result = CliRunner().invoke(kfc, ["--help-section", "missing"])
    assert result.exit_code == 2
    assert "unknown help section 'missing'" in result.output
