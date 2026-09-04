# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

from click.testing import CliRunner

from kungfu.cli.commands import primitive


REPO_ROOT = Path(__file__).parents[4]
CATALOG = json.loads(
    (
        REPO_ROOT / "framework/spec/primitive/kungfu-primitive-catalog.contract.json"
    ).read_text(encoding="utf-8")
)


def _invoke(monkeypatch, args):
    monkeypatch.setattr(primitive, "_catalog", lambda: CATALOG)
    return CliRunner().invoke(primitive.primitive, args)


def test_list_projects_the_exact_catalog_root(monkeypatch):
    result = _invoke(monkeypatch, ["list", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.primitive-list/v1"
    assert payload["catalogRoot"] == CATALOG["catalogRoot"]
    assert payload["count"] == len(CATALOG["primitives"])
    assert payload["primitives"] == CATALOG["primitives"]


def test_show_and_explain_share_the_same_primitive_authority(monkeypatch):
    expected = next(row for row in CATALOG["primitives"] if row["id"] == "fact")
    shown = _invoke(monkeypatch, ["show", "fact", "--json"])
    explained = _invoke(monkeypatch, ["explain", "fact", "--json"])
    assert shown.exit_code == 0, shown.output
    assert explained.exit_code == 0, explained.output
    assert json.loads(shown.output)["primitive"] == expected
    explanation = json.loads(explained.output)
    assert explanation["primitive"] == expected
    assert explanation["catalogRoot"] == CATALOG["catalogRoot"]
    assert explanation["boundaries"] == {
        "admissionLabelMutation": False,
        "availabilityInference": False,
        "catalogIsDerived": True,
        "intake": CATALOG["authority"]["intake"],
        "readOnly": True,
    }


def test_unknown_primitive_is_a_named_diagnostic(monkeypatch):
    result = _invoke(monkeypatch, ["show", "not-declared", "--json"])
    assert result.exit_code == 1
    assert "unknown Primitive id: not-declared" in result.output


def test_graph_projects_only_rooted_authority_relations(monkeypatch):
    result = _invoke(monkeypatch, ["graph", "--from", "assignment", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["catalogAuthoredEdges"] is False
    assert {row["target"] for row in payload["relations"]} == {
        "action-geometry",
        "initiative",
    }
    assert all(
        row["authority"]["root"].startswith("sha256:") for row in payload["relations"]
    )


def test_missing_availability_observation_is_unknown(monkeypatch):
    result = _invoke(monkeypatch, ["availability", "fact", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["state"] == "unknown"
    assert payload["reasonCodes"] == ["observation-missing"]
    assert payload["perspectiveBound"] is True
    assert payload["nonMonotonic"] is True


def test_availability_is_bound_to_catalog_runtime_cut_and_storage_owner(
    monkeypatch, tmp_path
):
    observation = {
        "schema": "kungfu.availability-observation/v1",
        "primitiveId": "fact",
        "catalogRoot": CATALOG["catalogRoot"],
        "runtime": {
            "id": "python-test",
            "workspace": "/fixture/workspace",
            "platform": "test-platform",
        },
        "profileRoots": ["sha256:" + "1" * 64],
        "boundary": {
            "authorityPresent": True,
            "capabilityPresent": True,
            "storageOwnerAvailable": False,
        },
        "cut": {
            "root": "sha256:" + "2" * 64,
            "observedAt": "2026-07-25T00:00:00Z",
        },
        "health": {"status": "healthy", "evidenceRoots": ["sha256:" + "3" * 64]},
    }
    path = tmp_path / "observation.json"
    path.write_text(json.dumps(observation), encoding="utf-8")
    result = _invoke(
        monkeypatch, ["availability", "fact", "--observation", str(path), "--json"]
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["state"] == "unavailable"
    assert payload["reasonCodes"] == ["storage-owner-unavailable"]
    assert payload["binding"]["cut"] == observation["cut"]


def test_stale_availability_observation_fails_closed(monkeypatch, tmp_path):
    observation = {
        "schema": "kungfu.availability-observation/v1",
        "primitiveId": "fact",
        "catalogRoot": "sha256:" + "0" * 64,
    }
    path = tmp_path / "stale.json"
    path.write_text(json.dumps(observation), encoding="utf-8")
    result = _invoke(
        monkeypatch, ["availability", "fact", "--observation", str(path), "--json"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["reasonCodes"] == ["observation-stale"]
