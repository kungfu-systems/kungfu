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
from kungfu.agent import documentation, first_value, resources  # noqa: E402
from kungfu.cli.commands import agent as agent_command  # noqa: E402


def test_brief_and_intent_map_enforce_complete_bounded_first_entry():
    brief = resources.document_text("brief.md")
    intent_map = agent_pack.intent_map()

    assert len(brief.encode("utf-8")) <= 8192
    assert len(brief.splitlines()) <= 120
    assert "kungfu xinfa compile" in brief
    assert "merely printing or reading it is not\ncompletion" in brief
    assert "run exactly one\n   `kungfu agent first-value receipt`" in brief
    assert "Cite the CLI-returned `receiptRoot`" in brief
    assert "never reconstruct or recompute" in brief
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
    assert agent_pack.skill_state(target, destination) == "absent"

    destination.mkdir(parents=True)
    source = resources.skill_path(target).read_bytes()
    (destination / "SKILL.md").write_bytes(source)
    assert agent_pack.skill_state(target, destination) == "current"

    (destination / "SKILL.md").write_bytes(source + b"\n# local note\n")
    assert agent_pack.skill_state(target, destination) == "stale"

    (destination / "SKILL.md").write_text("no frontmatter\n", encoding="utf-8")
    assert agent_pack.skill_state(target, destination) == "incompatible"


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


def test_first_value_contract_binds_exact_prompt_and_packaged_roots():
    view = first_value.contract_view()

    assert view["contract"]["prompt"] == {
        "text": "请运行 kungfu agent brief，不要在打印 brief 后停止，请继续按 First response protocol 依次验证文档、读取 intent map 与 first-value contract、执行一次安全发现并调用 first-value receipt 固化结果，最后结合你对我的了解，用最适合我的方式解释 Kungfu 并给我一个可验证的上手结果。",
        "root": "sha256:c5e6c02d553e1addd4db51a573c54af86346b7ca55ee0b4778b80582cb56fee2",
        "encoding": "utf-8",
    }
    assert view["contract"]["result"]["maximumQuestionCount"] == 1
    assert view["contract"]["result"]["exactPromptDefault"] == {
        "intentId": "onboarding",
        "questionCount": 0,
        "discoveryCommand": "kungfu agent status --target codex --scope project --json",
        "outcomeKind": "verified-discovery",
    }
    assert view["contract"]["qualification"]["requiredLocalCodexTrials"] == 3
    assert view["productIdentity"]["candidateRoot"].startswith("sha256:")
    assert view["receiptSchema"]["properties"]["verdict"] == {
        "type": "string",
        "const": "verified",
    }


def test_first_value_receipt_schema_is_structured_output_compatible():
    schema = first_value.contract_view()["receiptSchema"]

    def assert_compatible(node):
        if isinstance(node, dict):
            if "const" in node or "enum" in node:
                assert "type" in node
            if node.get("type") == "array":
                assert "items" in node
            for value in node.values():
                assert_compatible(value)
        elif isinstance(node, list):
            for value in node:
                assert_compatible(value)

    assert_compatible(schema)


def test_first_value_source_revision_prefers_intrinsic_build_info(monkeypatch):
    revision = "a" * 40
    monkeypatch.setattr(
        kungfu, "_build_info", {"version": "test", "git": {"revision": revision}}
    )
    monkeypatch.delenv("KUNGFU_FIRST_VALUE_SOURCE_REVISION", raising=False)

    assert first_value.contract_view()["productIdentity"]["sourceRevision"] == revision


def test_first_value_source_revision_rejects_external_mismatch(monkeypatch):
    monkeypatch.setattr(
        kungfu, "_build_info", {"version": "test", "git": {"revision": "a" * 40}}
    )
    monkeypatch.setenv("KUNGFU_FIRST_VALUE_SOURCE_REVISION", "b" * 40)

    with pytest.raises(ValueError, match="does not match kungfu build-info"):
        first_value.contract_view()


def test_first_value_receipt_reruns_declared_discovery_and_verifies():
    calls = []

    def runner(argv, timeout, maximum):
        calls.append((argv, timeout, maximum))
        return 0, b'{"schema":"kungfu.agent-capabilities/v1"}\n', b""

    receipt = first_value.create_receipt(
        intent_id="onboarding",
        discovery_command="kungfu agent capabilities --json",
        question_count=0,
        outcome_summary="Verified the installed Agent capability envelope.",
        runner=runner,
        observed_at="2026-08-02T00:00:00Z",
        attempt_id="fixture-codex-1",
    )

    assert calls == [
        (
            ["kungfu", "agent", "capabilities", "--json"],
            30,
            4194304,
        )
    ]
    assert receipt["verdict"] == "verified"
    assert receipt["questionCount"] == 0
    assert receipt["intentId"] == "onboarding"
    assert receipt["discovery"]["safetyClass"] == "read-only"
    assert receipt["discovery"]["outputBytes"] > 0
    assert first_value.verify_receipt(receipt)["verified"] is True


@pytest.mark.parametrize(
    "intent_id,command,question_count,error",
    [
        ("missing", "kungfu agent capabilities --json", 0, "not uniquely declared"),
        ("onboarding", "kungfu agent capabilities --execute", 0, "--execute"),
        ("onboarding", "sh -c whoami", 0, "current kungfu CLI"),
        ("onboarding", "kungfu agent capabilities --json", 2, "must be 0..1"),
    ],
)
def test_first_value_receipt_rejects_unsafe_or_unbounded_results(
    intent_id, command, question_count, error
):
    with pytest.raises(ValueError, match=error):
        first_value.create_receipt(
            intent_id=intent_id,
            discovery_command=command,
            question_count=question_count,
            outcome_summary="bounded",
            runner=lambda argv, timeout, maximum: (0, b"ok\n", b""),
        )


def test_first_value_receipt_fails_closed_on_tampering():
    receipt = first_value.create_receipt(
        intent_id="onboarding",
        discovery_command="kungfu agent capabilities --json",
        question_count=1,
        outcome_summary="Verified the installed Agent capability envelope.",
        runner=lambda argv, timeout, maximum: (0, b"ok\n", b""),
        observed_at="2026-08-02T00:00:00Z",
        attempt_id="fixture-codex-2",
    )
    receipt["questionCount"] = 0

    with pytest.raises(ValueError, match="receipt root mismatch"):
        first_value.verify_receipt(receipt)
