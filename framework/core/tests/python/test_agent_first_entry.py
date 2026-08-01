# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import sys
import types

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

from kungfu import agent as agent_pack  # noqa: E402
from kungfu.agent import documentation, resources  # noqa: E402
from kungfu.cli.commands import agent as agent_command  # noqa: E402


def test_brief_and_intent_map_enforce_complete_bounded_first_entry():
    brief = resources.document_text("brief.md")
    intent_map = agent_pack.intent_map()

    assert len(brief.encode("utf-8")) <= 8192
    assert len(brief.splitlines()) <= 120
    assert "kungfu xinfa compile" in brief
    assert set(intent_map["requiredIntentIds"]) == {
        row["id"] for row in intent_map["intents"]
    }
    assert len(intent_map["intents"]) == 12
    for row in intent_map["intents"]:
        assert row["authorityRoots"]
        assert row["authorization"]
        assert row["nonClaims"]
        assert row["discoveryCommands"]
        assert row["expansionHandles"]


@pytest.mark.parametrize(
    "target,provider_root", [("codex", ".agents"), ("claude", ".claude")]
)
def test_provider_skill_state_is_separate_and_exact(
    tmp_path, monkeypatch, target, provider_root
):
    monkeypatch.chdir(tmp_path)
    destination = agent_command._skill_dir(target, "project")
    assert (
        destination == tmp_path / provider_root / "skills" / "kungfu-agent-onboarding"
    )
    assert agent_command._skill_state(target, destination) == "absent"

    destination.mkdir(parents=True)
    source = resources.skill_path(target).read_bytes()
    (destination / "SKILL.md").write_bytes(source)
    assert agent_command._skill_state(target, destination) == "current"

    (destination / "SKILL.md").write_bytes(source + b"\n# local note\n")
    assert agent_command._skill_state(target, destination) == "stale"

    (destination / "SKILL.md").write_text("no frontmatter\n", encoding="utf-8")
    assert agent_command._skill_state(target, destination) == "incompatible"


def _verification():
    return {
        "atlasRoot": "sha256:atlas",
        "packRoot": "sha256:pack",
        "cutRoot": "sha256:cut",
        "manifestRoot": "sha256:manifest",
        "receiptRoot": "sha256:receipt",
    }


def test_task_context_hides_pack_path_and_preserves_handles(tmp_path, monkeypatch):
    monkeypatch.setattr(
        documentation,
        "_verified_pack",
        lambda root=None: (tmp_path, {}, _verification()),
    )
    monkeypatch.setattr(
        documentation,
        "_xinfa",
        lambda arguments: {
            "projection": {
                "schema": "xinfa.task-chart/v1",
                "status": "complete",
                "roots": {"atlas": "sha256:atlas"},
                "omissions": [],
                "expansion_handles": [{"id": "more-project"}],
            }
        },
    )

    payload = documentation.task_context(
        "start a project", "guide", 2048, "route", tmp_path
    )
    encoded = json.dumps(payload)
    assert payload["internalPathsExposed"] is False
    assert payload["expansionHandles"] == [{"id": "more-project"}]
    assert str(tmp_path) not in encoded


def test_task_context_fails_closed_on_required_omission(tmp_path, monkeypatch):
    monkeypatch.setattr(
        documentation,
        "_verified_pack",
        lambda root=None: (tmp_path, {}, _verification()),
    )
    monkeypatch.setattr(
        documentation,
        "_xinfa",
        lambda arguments: {
            "projection": {
                "status": "degraded",
                "roots": {"atlas": "sha256:atlas"},
                "omissions": [{"id": "required", "required": True}],
            }
        },
    )

    with pytest.raises(ValueError, match="incomplete"):
        documentation.task_context("task", "guide", 64, "route", tmp_path)
