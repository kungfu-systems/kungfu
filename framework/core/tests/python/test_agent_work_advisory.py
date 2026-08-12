# SPDX-License-Identifier: Apache-2.0

import json
import os
import sys

import pytest
from jsonschema import Draft202012Validator

from kungfu.agent import run_agent
from kungfu.agent import assess_work_advisory
from kungfu.agent import resources as agent_resources
from kungfu.cli.commands import assignment as work_commands
from kungfu.workspace import resolve_workspace_target


def test_run_process_retains_undecodable_output_without_crashing(tmp_path):
    script = tmp_path / "non_utf8.py"
    script.write_text(
        "import sys\n"
        "sys.stdout.buffer.write(b'out\\xff\\n')\n"
        "sys.stderr.buffer.write(b'err\\xfe\\n')\n",
        encoding="utf-8",
    )
    streamed = []
    result = run_agent.run_process(
        [sys.executable, str(script)],
        cwd=str(tmp_path),
        env=os.environ,
        timeout_seconds=5,
        output_sink=lambda stream, line: streamed.append((stream, line)),
    )

    assert result.exit_code == 0
    assert result.stdout == "out\ufffd\n"
    assert result.stderr == "err\ufffd\n"
    assert set(streamed) == {
        ("stdout", "out\ufffd\n"),
        ("stderr", "err\ufffd\n"),
    }


def test_managed_agent_environment_preserves_windows_process_coordinates(tmp_path):
    windows_coordinates = {
        "APPDATA": r"C:\\Users\\test\\AppData\\Roaming",
        "LOCALAPPDATA": r"C:\\Users\\test\\AppData\\Local",
        "USERPROFILE": r"C:\\Users\\test",
        "SYSTEMROOT": r"C:\\Windows",
        "COMSPEC": r"C:\\Windows\\System32\\cmd.exe",
        "PATHEXT": ".COM;.EXE;.BAT;.CMD",
        "TEMP": r"C:\\Users\\test\\AppData\\Local\\Temp",
        "TMP": r"C:\\Users\\test\\AppData\\Local\\Temp",
    }
    env, environment_keys = run_agent._environment(
        "codex",
        runtime_dir=str(tmp_path / "runtime"),
        run_id="agent-windows-environment",
        workspace_root=str(tmp_path / "project"),
        work_ref=None,
        continuation=None,
        source={
            "HOME": r"C:\\Users\\test",
            "PATH": r"C:\\Windows\\System32",
            **windows_coordinates,
            "UNDECLARED_SECRET": "blocked",
        },
    )

    assert {key: env[key] for key in windows_coordinates} == windows_coordinates
    assert "UNDECLARED_SECRET" not in env
    assert environment_keys == sorted(env)


def test_managed_agent_environment_uses_standard_macos_tls_trust(tmp_path, monkeypatch):
    cert_file = tmp_path / "cert.pem"
    cert_file.write_text("test certificate bundle\n", encoding="utf-8")
    monkeypatch.setattr(run_agent, "_DARWIN_DEFAULT_SSL_CERT_FILE", cert_file)
    env = {}

    run_agent._apply_platform_tls_trust(env, platform="darwin")

    assert env["SSL_CERT_FILE"] == str(cert_file)


def test_managed_agent_environment_preserves_explicit_tls_trust(tmp_path):
    explicit = str(tmp_path / "private-ca.pem")
    env, environment_keys = run_agent._environment(
        "codex",
        runtime_dir=str(tmp_path / "runtime"),
        run_id="agent-explicit-tls",
        workspace_root=str(tmp_path / "project"),
        work_ref=None,
        continuation=None,
        source={
            "HOME": "/Users/test",
            "PATH": "/usr/bin",
            "SSL_CERT_FILE": explicit,
        },
    )

    assert env["SSL_CERT_FILE"] == explicit
    assert "SSL_CERT_FILE" in environment_keys


def _signals(**overrides):
    value = {
        "taskId": "upgrade-runtime",
        "expectedDuration": "multi-session",
        "backgroundWaits": True,
        "crossAgentHandoff": False,
        "verificationEvidenceNeeded": True,
        "retryDuplicationRisk": True,
        "highRiskExternalWrites": False,
        "acceptanceCriteria": ["Tests pass", "The exact receipt is reported"],
        "title": "Upgrade the runtime",
        "objective": "Upgrade the runtime without losing evidence",
        "nextAction": "Inspect the current runtime",
    }
    value.update(overrides)
    return value


def test_recommendation_is_rooted_preview_first_and_authority_free():
    result = assess_work_advisory(_signals())
    assert result["decision"] == "recommend"
    assert result["confirmation"] == {
        "required": True,
        "count": 1,
        "prompt": "Create and bind this durable Work, then continue?",
    }
    assert result["publicActionPath"] == [
        "kungfu.work.capture",
        "kungfu.work.admit",
        "kungfu.agent.console.bind-work",
    ]
    assert result["preview"]["acceptanceCriteria"] == [
        "Tests pass",
        "The exact receipt is reported",
    ]
    assert result["decisionRoot"].startswith("sha256:")
    assert "advice-does-not-grant-external-write-authority" in result["nonClaims"]


def test_trivial_one_shot_task_is_not_promoted():
    result = assess_work_advisory(
        _signals(
            expectedDuration="one-shot",
            backgroundWaits=False,
            verificationEvidenceNeeded=False,
            retryDuplicationRisk=False,
            acceptanceCriteria=[],
        )
    )
    assert result["decision"] == "not-needed"
    assert result["reasonCodes"] == ["bounded-one-shot-task"]
    assert result["preview"] is None


def test_decline_is_suppressed_until_structured_evidence_changes():
    first = assess_work_advisory(_signals())
    same = assess_work_advisory(
        _signals(
            suppression={
                "declined": True,
                "evidenceRoot": first["suppression"]["evidenceRoot"],
            }
        )
    )
    assert same["decision"] == "not-needed"
    assert same["reasonCodes"] == ["declined-same-evidence"]

    changed = assess_work_advisory(
        _signals(
            crossAgentHandoff=True,
            suppression={
                "declined": True,
                "evidenceRoot": first["suppression"]["evidenceRoot"],
            },
        )
    )
    assert changed["decision"] == "recommend"


@pytest.mark.parametrize(
    "forbidden", ["rawTranscript", "hiddenReasoning", "credentials"]
)
def test_private_or_unbounded_signal_fields_fail_closed(forbidden):
    with pytest.raises(ValueError, match="unsupported Work-value signals"):
        assess_work_advisory({**_signals(), forbidden: "secret"})


def test_bootstrap_status_exposes_pending_without_granting_mutation(monkeypatch):
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "assistant:workspace:test:native:pending",
        "attemptId": "native:pending",
        "runtimeProfileId": "kungfu.agent-runtime.codex.test",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["kungfu", "agent", "context", "--json"],
            "capabilities": ["kungfu", "agent", "capabilities", "--json"],
            "profiles": ["kungfu", "profile", "manager", "--json"],
        },
        "knownLimits": [],
    }
    envelope = {**body, "envelopeRoot": run_agent.canonical_root(body)}
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.delenv("KUNGFU_AGENT_BOOTSTRAP_RECEIPT", raising=False)

    status = agent_resources.bootstrap_status()

    assert status["state"] == "pending"
    assert status["mutationsAllowed"] is False
    assert status["attemptId"] == "native:pending"


def test_native_environment_publishes_attempt_bound_bootstrap_receipt(
    monkeypatch, tmp_path
):
    skill_file = tmp_path / "runtime" / "SKILL.md"
    skill_file.parent.mkdir()
    skill_file.write_text("---\nname: kungfu\n---\n", encoding="utf-8")
    docs_roots = {
        "atlasRoot": "sha256:" + "1" * 64,
        "packRoot": "sha256:" + "2" * 64,
        "manifestRoot": "sha256:" + "3" * 64,
        "receiptRoot": "sha256:" + "4" * 64,
    }
    monkeypatch.setattr(
        agent_resources.documentation_pack,
        "verify",
        lambda: {"valid": True, "diagnostics": [], **docs_roots},
    )

    env = run_agent.native_environment(
        "codex",
        runtime_dir=str(tmp_path / "runtime"),
        config_home=str(tmp_path / "config"),
        runtime_home=str(tmp_path / "home"),
        workspace_root=str(tmp_path / "project"),
        work_ref=None,
        work_selection={"schema": "kungfu.native-work-selection/v1", "state": "none"},
        profile={"id": "kungfu.agent-runtime.codex.test", "provider": "codex"},
        session_ref={
            "workConsoleId": "assistant:workspace:test:native:one",
            "sessionAttemptId": "native:one",
        },
        adapter={"skillFile": str(skill_file)},
        source={"PATH": "/usr/bin"},
    )

    receipt = json.loads(env["KUNGFU_AGENT_BOOTSTRAP_RECEIPT"])
    context = json.loads(env["KUNGFU_AGENT_CONTEXT"])
    envelope = json.loads(env["KUNGFU_AGENT_CONSOLE_ENVELOPE"])
    body = dict(receipt)
    receipt_root = body.pop("receiptRoot")
    assert receipt["state"] == "verified"
    assert receipt["attemptId"] == "native:one"
    assert receipt["deliveredBeforeProviderStart"] is True
    assert receipt["roots"]["documentationPack"] == docs_roots["packRoot"]
    assert receipt_root == run_agent.canonical_root(body)
    Draft202012Validator(agent_resources.bootstrap_receipt_schema()).validate(receipt)
    assert context["bootstrap"]["receiptRoot"] == receipt_root
    assert context["workBinding"]["mutationsAllowed"] is True
    assert envelope["bootstrap"] == context["bootstrap"]
    monkeypatch.setenv(
        "KUNGFU_AGENT_CONSOLE_ENVELOPE", env["KUNGFU_AGENT_CONSOLE_ENVELOPE"]
    )
    monkeypatch.setenv(
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT", env["KUNGFU_AGENT_BOOTSTRAP_RECEIPT"]
    )
    assert agent_resources.bootstrap_status()["state"] == "verified"


def test_bootstrap_status_is_a_read_only_exact_kfd3_surface():
    surface = next(
        row
        for row in agent_resources.cli_surface_catalog()["surfaces"]
        if row["canonical_path"] == "kungfu agent bootstrap-status"
    )
    api = next(
        row
        for row in agent_resources.registry()["apis"]
        if row["id"] == "kungfu.agent.bootstrap-status"
    )

    assert surface["mutation_class"] == "read"
    assert api["anchor"] == {
        "kind": "runtime-click",
        "symbol": "bootstrap_status",
    }


def test_degraded_bootstrap_keeps_ui_but_blocks_all_work_mutation(
    monkeypatch, tmp_path
):
    project = tmp_path / "project"
    project_runtime = project / ".kungfu" / "runtime"
    project_runtime.mkdir(parents=True)
    skill_file = tmp_path / "runtime" / "SKILL.md"
    skill_file.parent.mkdir()
    skill_file.write_text("---\nname: kungfu\n---\n", encoding="utf-8")
    target = resolve_workspace_target("read-only", str(project), cwd=str(project))
    monkeypatch.setattr(
        agent_resources.documentation_pack,
        "verify",
        lambda: {
            "valid": False,
            "diagnostics": [{"code": "missing-artifact", "path": "atlas.json"}],
        },
    )
    env = run_agent.native_environment(
        "codex",
        runtime_dir=str(project_runtime),
        config_home=str(tmp_path / "config"),
        runtime_home=str(tmp_path / "home"),
        workspace_root=str(project),
        work_ref=None,
        work_selection={
            "schema": "kungfu.native-work-selection/v1",
            "state": "none",
            "workspaceId": target.identity.workspace_id,
        },
        profile={"id": "kungfu.agent-runtime.codex.test", "provider": "codex"},
        session_ref={
            "workConsoleId": f"assistant:{target.identity.workspace_id}:native:one",
            "sessionAttemptId": "native:one",
        },
        adapter={"skillFile": str(skill_file)},
        source={"PATH": "/usr/bin"},
    )
    for key in (
        "KUNGFU_AGENT_ATTEMPT_ID",
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT",
        "KUNGFU_AGENT_CONSOLE_ENVELOPE",
        "KUNGFU_AGENT_RUNTIME_DIR",
        "KUNGFU_WORKSPACE_ROOT",
    ):
        monkeypatch.setenv(key, env[key])

    assert json.loads(env["KUNGFU_AGENT_BOOTSTRAP_RECEIPT"])["state"] == "degraded"
    assert agent_resources.bootstrap_status()["state"] == "degraded"
    with pytest.raises(ValueError, match="bootstrap is degraded"):
        run_agent.bind_current_native_work(
            str(project_runtime), "initiative:test", "assignment:test"
        )
    blocked_project = tmp_path / "blocked-project"
    with pytest.raises(ValueError, match="bootstrap is degraded"):
        work_commands._runtime(str(blocked_project), operation_class="semantic-write")
    assert not blocked_project.exists()
