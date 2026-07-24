# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

from click.testing import CliRunner

from kungfu.cli.commands import primitive


REPO_ROOT = Path(__file__).parents[4]
CATALOG = json.loads(
    (
        REPO_ROOT / "framework/primitive/kungfu-primitive-catalog.contract.json"
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
        "catalogIsDerived": True,
        "intake": CATALOG["authority"]["intake"],
        "maturityMutation": False,
        "readOnly": True,
    }


def test_unknown_primitive_is_a_named_diagnostic(monkeypatch):
    result = _invoke(monkeypatch, ["show", "not-declared", "--json"])
    assert result.exit_code == 1
    assert "unknown Primitive id: not-declared" in result.output
