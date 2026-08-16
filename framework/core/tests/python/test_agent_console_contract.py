# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import json
import os
import select
import subprocess
from types import SimpleNamespace
import sys
import time
import tomllib

from click.testing import CliRunner
import pytest
from jsonschema import Draft202012Validator

from kungfu import config
from kungfu.agent import native_launch
from kungfu.agent import run_agent
from kungfu.agent import runtime_profiles
from kungfu.agent import session_contract
from kungfu.cli.commands import agent as agent_commands, kfc
from kungfu.rewind.cost.discovery import discover_provider_candidates
from kungfu.workspace import resolve_workspace_target
from agent_bootstrap_fixtures import verified_bootstrap_receipt


ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework" / "config" / "kungfu-config.contract.json"
ROOT_HASH = "sha256:" + "a" * 64


def _contract():
    return config.load_contract(str(CONTRACT))


def _work_ref():
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": ROOT_HASH,
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": ROOT_HASH,
        "purpose": "delegated-work",
        "systemTimeCut": "2026-07-13T00:00:00Z",
        "initiativeId": "initiative:test",
    }


def _skill_runtime_pointer():
    return {
        "schema": "kungfu.skill-runtime-audit-pointer/v1",
        "path": "/runtime/skill-manager/agent-console-attempt-1.json",
        "runtimeAuditRoot": ROOT_HASH,
        "registryStateRoot": ROOT_HASH,
        "historyRoot": ROOT_HASH,
        "diagnosisRoot": ROOT_HASH,
        "catalogRoot": ROOT_HASH,
        "decisionPolicyRoot": ROOT_HASH,
        "workRefRoot": ROOT_HASH,
        "kfxDependencyRoots": [ROOT_HASH],
        "receiptRoots": [ROOT_HASH],
        "recoveryRoot": ROOT_HASH,
        "entrypoints": {
            "catalog": ["kungfu", "skill", "catalog", "--json"],
            "advise": ["kungfu", "agent", "skill-advisory", "--json"],
            "read": ["kungfu", "skill", "read", "<key>", "--json"],
            "audit": ["kungfu", "skill", "audit", "--json"],
            "explain": ["kungfu", "skill", "explain", "<key>", "--json"],
            "diagnose": ["kungfu", "skill", "diagnose", "--json"],
            "kfx": ["kungfu", "kfx", "native", "status", "--json"],
        },
        "authority": "read-only-projection",
    }


def test_agent_session_cli_exposes_structured_control_response():
    result = CliRunner().invoke(kfc, ["agent", "session", "--help"])

    assert result.exit_code == 0
    assert "respond-control" in result.output


def test_agent_session_core_contract_matches_cross_language_golden():
    schema = json.loads(
        (
            ROOT
            / "framework"
            / "agent-session"
            / "schemas"
            / "agent-session-core.schema.json"
        ).read_text(encoding="utf-8")
    )
    fixture = json.loads(
        (
            ROOT
            / "framework"
            / "agent-session"
            / "tests"
            / "fixtures"
            / "agent-session-core-golden.json"
        ).read_text(encoding="utf-8")
    )
    envelope = {**fixture["envelopeBody"], "envelopeRoot": fixture["envelopeRoot"]}
    definitions = schema["$defs"]

    Draft202012Validator(
        {**schema, "$ref": "#/$defs/workRef", "$defs": definitions}
    ).validate(fixture["workRef"])
    Draft202012Validator(
        {**schema, "$ref": "#/$defs/agentConsoleEnvelope", "$defs": definitions}
    ).validate(envelope)
    for profile in fixture["runtimeProfiles"]:
        Draft202012Validator(
            {**schema, "$ref": "#/$defs/runtimeProfile", "$defs": definitions}
        ).validate(profile)

    assert session_contract.semantic_root(fixture["workRef"]) == fixture["workRefRoot"]
    assert (
        session_contract.semantic_root(fixture["envelopeBody"])
        == fixture["envelopeRoot"]
    )
    assert session_contract.validate_work_ref(fixture["workRef"]) == fixture["workRef"]
    assert session_contract.validate_agent_console_envelope(envelope) == envelope


def test_agent_session_core_contract_legacy_read_is_explicit():
    legacy = dict(_work_ref())
    legacy.pop("initiativeId")
    assert session_contract.validate_work_ref(legacy, compatibility=True) == legacy
    with pytest.raises(ValueError, match="initiativeId"):
        session_contract.validate_work_ref(legacy)
    with pytest.raises(ValueError, match="unknown runtimeRouting"):
        envelope = {
            **json.loads(
                (
                    ROOT
                    / "framework"
                    / "agent-session"
                    / "tests"
                    / "fixtures"
                    / "agent-session-core-golden.json"
                ).read_text(encoding="utf-8")
            )["envelopeBody"],
            "runtimeRouting": {},
            "envelopeRoot": ROOT_HASH,
        }
        session_contract.validate_agent_console_envelope(envelope)


def _third_party_adapter(skill_source, *, provider="termagent"):
    return {
        "schema": "kungfu.native-provider-adapter/v1",
        "id": provider,
        "label": "Terminal Agent",
        "discovery": {
            "executableNames": [provider],
            "knownPaths": [],
            "versionArgv": ["--version"],
        },
        "credentialEnvironment": ["TERMAGENT_API_KEY"],
        "skill": {
            "source": str(skill_source),
            "argv": ["--instructions", "{skill_file}"],
            "environment": {"TERMAGENT_SKILL": "{skill_file}"},
            "environmentJson": {
                "TERMAGENT_CONTEXT": {
                    "skill": "{skill_file}",
                    "root": "{adapter_root}",
                }
            },
            "files": [
                {
                    "path": "settings.json",
                    "content": {"skills": ["{skills_root}"]},
                }
            ],
        },
        "knownLimits": ["synthetic third-party qualification adapter"],
    }


def test_agent_runtime_profile_is_part_of_the_global_config_contract():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "codex-app",
            "label": "Codex App CLI",
            "provider": "codex",
            "launch": {
                "executable": "/Applications/Codex.app/Contents/Resources/codex",
                "argv": [],
                "shellMode": False,
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "tmux",
            "bootstrap": {"adapter": "codex", "envelope": "required"},
            "source": "discovered",
            "lastVerified": None,
        }
    ]
    value["agent"]["defaultRuntimeProfile"] = "codex-app"
    config.validate_config(value, contract=_contract())


def test_opencode_runtime_profile_is_native_config_contract_member():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "opencode-free",
            "label": "OpenCode free",
            "provider": "opencode",
            "launch": {
                "executable": "/usr/local/bin/opencode",
                "argv": [
                    "run",
                    "--pure",
                    "--model",
                    "opencode/north-mini-code-free",
                    "--format",
                    "json",
                ],
                "shellMode": False,
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "direct",
            "bootstrap": {"adapter": "opencode", "envelope": "required"},
            "source": "user",
            "lastVerified": None,
        }
    ]
    value["agent"]["defaultRuntimeProfile"] = "opencode-free"
    config.validate_config(value, contract=_contract())


def test_amp_runtime_profile_and_interactive_argv_are_config_contract_members():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "amp.path",
            "label": "Amp PATH CLI",
            "provider": "amp",
            "launch": {
                "executable": "/usr/local/bin/amp",
                "argv": ["--execute"],
                "interactiveArgv": ["--no-ide"],
                "shellMode": False,
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "direct",
            "bootstrap": {"adapter": "amp", "envelope": "required"},
            "source": "user",
            "lastVerified": None,
        }
    ]
    value["agent"]["defaultRuntimeProfile"] = "amp.path"
    config.validate_config(value, contract=_contract())


def test_registered_third_party_provider_is_a_config_contract_member(tmp_path):
    skill = tmp_path / "SKILL.md"
    skill.write_text("---\nname: terminal-agent\n---\n", encoding="utf-8")
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["nativeProviderAdapters"] = [_third_party_adapter(skill)]
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "termagent.path.test",
            "label": "Terminal Agent PATH CLI",
            "provider": "termagent",
            "launch": {
                "executable": "/usr/local/bin/termagent",
                "argv": [],
                "interactiveArgv": ["--native"],
                "versionArgv": ["--version"],
                "shellMode": False,
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "direct",
            "bootstrap": {"adapter": "termagent", "envelope": "required"},
            "source": "user",
            "lastVerified": None,
        }
    ]
    value["agent"]["defaultRuntimeProfile"] = "termagent.path.test"

    config.validate_config(value, contract=_contract())
    envelope = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "console:go-test",
        "attemptId": "attempt:1",
        "runtimeProfileId": "termagent.path.test",
        "provider": "termagent",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["kungfu", "agent", "context", "--json"],
            "capabilities": ["kungfu", "agent", "capabilities", "--json"],
            "profiles": ["kungfu", "profile", "manager", "--json"],
            "bindWork": ["kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": [],
        "envelopeRoot": ROOT_HASH,
    }
    config.validate_value("agentConsoleEnvelope", envelope, contract=_contract())


def test_agent_runtime_profile_rejects_opaque_extra_fields():
    value = config.raw_default_config(str(CONTRACT))
    value["agent"]["runtimeProfiles"] = [
        {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": "unsafe",
            "label": "Unsafe",
            "provider": "codex",
            "launch": {
                "executable": "/bin/sh",
                "argv": ["-lc", "codex"],
                "shellMode": True,
                "secret": "must-not-be-stored",
            },
            "cwdPolicy": "workspace-root",
            "backendDefault": "direct",
            "bootstrap": {"adapter": "codex", "envelope": "required"},
            "source": "user",
        }
    ]
    with pytest.raises(ValueError):
        config.validate_config(value, contract=_contract())


def test_work_console_requires_a_bound_work_ref_for_work_bindings():
    value = {
        "schema": "kungfu.work-console-registry/v1",
        "workspaceId": "workspace:test",
        "consoles": [
            {
                "consoleId": "console:go-test",
                "bindingKind": "work",
                "workRef": _work_ref(),
                "runtimeProfileId": "codex-app",
                "backend": "tmux",
                "attempts": [
                    {
                        "attemptId": "attempt:1",
                        "runId": "run:1",
                        "status": "running",
                        "startedAt": 1,
                    }
                ],
                "createdAt": 1,
                "updatedAt": 1,
            }
        ],
        "presentation": {"tabs": [], "splits": [], "drawer": None, "windows": []},
    }
    config.validate_value("workConsoleRegistry", value, contract=_contract())
    del value["consoles"][0]["workRef"]
    with pytest.raises(ValueError):
        config.validate_value("workConsoleRegistry", value, contract=_contract())


def test_agent_console_envelope_binds_work_and_discovery_entrypoints():
    value = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "console:go-test",
        "attemptId": "attempt:1",
        "runtimeProfileId": "codex-app",
        "provider": "codex",
        "activeProfiles": [{"id": "kungfu.work-control", "root": ROOT_HASH}],
        "workRef": _work_ref(),
        "entrypoints": {
            "context": ["kungfu", "agent", "context", "--json"],
            "capabilities": ["kungfu", "agent", "capabilities", "--json"],
            "profiles": ["kungfu", "profile", "manager", "--json"],
            "bindWork": ["kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": ["terminal transcript is not proof"],
        "skillRuntimeAudit": {
            **_skill_runtime_pointer(),
            "workRefRoot": session_contract.semantic_root(_work_ref()),
        },
        "envelopeRoot": ROOT_HASH,
    }
    config.validate_value("agentConsoleEnvelope", value, contract=_contract())
    assert value["skillRuntimeAudit"]["workRefRoot"] == session_contract.semantic_root(
        value["workRef"]
    )
    value["workRef"]["profileRoot"] = "latest"
    with pytest.raises(ValueError):
        config.validate_value("agentConsoleEnvelope", value, contract=_contract())


def test_agent_console_envelope_accepts_opencode_provider():
    value = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "console:go-test",
        "attemptId": "attempt:1",
        "runtimeProfileId": "opencode-free",
        "provider": "opencode",
        "activeProfiles": [{"id": "kungfu.work-control", "root": ROOT_HASH}],
        "workRef": _work_ref(),
        "entrypoints": {
            "context": ["kungfu", "agent", "context", "--json"],
            "capabilities": ["kungfu", "agent", "capabilities", "--json"],
            "profiles": ["kungfu", "profile", "manager", "--json"],
            "bindWork": ["kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": ["terminal transcript is not proof"],
        "envelopeRoot": ROOT_HASH,
    }
    config.validate_value("agentConsoleEnvelope", value, contract=_contract())


def test_discovery_returns_path_and_app_candidates_without_first_hit_collapse():
    rows = discover_provider_candidates(
        "codex",
        which=lambda name: "/usr/local/bin/codex" if name == "codex" else None,
        platform="darwin",
        exists=lambda path: path.startswith("/Applications/Codex.app/"),
        version_probe=lambda path: f"version:{path}",
    )
    assert [row.path_class for row in rows] == ["path", "codex_app_bundle"]
    assert all(row.found for row in rows)
    assert rows[0].path == "/usr/local/bin/codex"
    assert rows[1].path.endswith("/Contents/Resources/codex")


def test_opencode_discovery_is_path_only_and_privacy_bounded():
    rows = discover_provider_candidates(
        "opencode",
        which=lambda name: "/opt/opencode/bin/opencode" if name == "opencode" else None,
        platform="darwin",
        exists=lambda path: True,
        version_probe=lambda path: "1.18.3",
    )
    assert len(rows) == 1
    assert rows[0].provider == "opencode"
    assert rows[0].path == "/opt/opencode/bin/opencode"
    assert rows[0].path_class == "path"
    assert rows[0].version == "1.18.3"


def test_registered_third_party_provider_is_discovered_without_core_branch(
    tmp_path,
):
    skill = tmp_path / "SKILL.md"
    executable = tmp_path / "termagent"
    skill.write_text("---\nname: terminal-agent\n---\n", encoding="utf-8")
    executable.write_text("synthetic executable", encoding="utf-8")
    resolved = {
        "configPath": str(tmp_path / "config.json"),
        "config": config.raw_default_config(str(CONTRACT)),
    }
    resolved["config"]["agent"]["nativeProviderAdapters"] = [
        _third_party_adapter(skill)
    ]

    catalog = runtime_profiles.discover_catalog(
        resolved_config=resolved,
        discovery_kwargs={
            "which": lambda name: str(executable) if name == "termagent" else None,
            "exists": lambda path: path == str(executable),
            "version_probe": lambda path: "termagent 9.8.7",
            "platform": "darwin",
        },
    )

    row = next(
        row
        for row in catalog["discovered"]
        if row["profile"]["provider"] == "termagent"
    )
    assert row["version"] == "termagent 9.8.7"
    assert row["profile"]["launch"]["executable"] == str(executable)
    assert row["profile"]["launch"]["versionArgv"] == ["--version"]
    assert row["profile"]["label"] == "Terminal Agent · PATH CLI"


def test_amp_discovery_is_path_only_and_privacy_bounded():
    rows = discover_provider_candidates(
        "amp",
        which=lambda name: "/opt/amp/bin/amp" if name == "amp" else None,
        platform="darwin",
        exists=lambda path: True,
        version_probe=lambda path: "0.0.1785488326",
    )
    assert len(rows) == 1
    assert rows[0].provider == "amp"
    assert rows[0].path == "/opt/amp/bin/amp"
    assert rows[0].path_class == "path"
    assert rows[0].version == "0.0.1785488326"


@pytest.mark.parametrize(
    ("provider_output", "expected"),
    [
        ("codex-cli 0.144.3\n", "0.144.3"),
        ("2.1.209 (Claude Code)\n", "2.1.209"),
        ("1.18.3\n", "1.18.3"),
    ],
)
def test_runtime_profile_verification_returns_a_semantic_provider_version(
    monkeypatch, provider_output, expected
):
    monkeypatch.setattr(
        runtime_profiles.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0, stdout=provider_output, stderr=""
        ),
    )
    result = runtime_profiles.verify_profile(
        {
            "id": "provider.path.test",
            "provider": "codex",
            "launch": {"executable": sys.executable},
        }
    )
    assert result["ok"] is True
    assert result["version"] == expected


def test_amp_runtime_profile_verification_allows_a_bounded_cold_start(
    monkeypatch,
):
    observed = {}

    def probe(*args, **kwargs):
        observed["timeout"] = kwargs["timeout"]
        return SimpleNamespace(returncode=0, stdout="0.0.1785586633\n", stderr="")

    monkeypatch.setattr(runtime_profiles.subprocess, "run", probe)

    result = runtime_profiles.verify_profile(
        {
            "id": "amp.path.test",
            "provider": "amp",
            "launch": {"executable": sys.executable},
        }
    )

    assert result["ok"] is True
    assert observed["timeout"] == 15.0


def test_third_party_runtime_verification_accepts_bounded_opaque_version(
    monkeypatch,
):
    monkeypatch.setattr(
        runtime_profiles.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="termagent edge-build-2026\nignored details\n",
            stderr="",
        ),
    )

    result = runtime_profiles.verify_profile(
        {
            "id": "termagent.path.test",
            "provider": "termagent",
            "launch": {
                "executable": sys.executable,
                "versionArgv": ["version"],
            },
        }
    )

    assert result["ok"] is True
    assert result["version"] == "termagent edge-build-2026"
    assert result["argv"] == ["version"]


@pytest.mark.parametrize("provider", ["codex", "claude", "opencode", "cursor"])
def test_runtime_version_probe_failure_warns_but_never_blocks_available_agent(
    monkeypatch, provider
):
    monkeypatch.setattr(
        runtime_profiles.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=17, stdout="", stderr="version unavailable"
        ),
    )

    result = runtime_profiles.verify_profile(
        {
            "id": f"{provider}.path.test",
            "provider": provider,
            "launch": {"executable": sys.executable},
        }
    )

    assert result["available"] is True
    assert result["ok"] is True
    assert result["version"] is None
    assert result["error"] is None
    assert result["warning"] == "version probe exited 17"
    assert result["versionAdmission"] == "diagnostic-only"


def test_runtime_version_probe_exception_warns_but_never_blocks_available_agent(
    monkeypatch,
):
    def unavailable(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(runtime_profiles.subprocess, "run", unavailable)
    result = runtime_profiles.verify_profile(
        {
            "id": "codex.path.test",
            "provider": "codex",
            "launch": {"executable": sys.executable},
        }
    )

    assert result["available"] is True
    assert result["ok"] is True
    assert result["error"] is None
    assert result["warning"]
    assert result["versionAdmission"] == "diagnostic-only"


def test_runtime_profile_plan_apply_default_and_remove_are_preview_first(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "kungfu.contract.contract_hash", lambda *args, **kwargs: ROOT_HASH
    )
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "runtime"
    plan = runtime_profiles.plan_upsert(
        profile_id="codex-python-wrapper",
        label="Codex test wrapper",
        provider="codex",
        executable=sys.executable,
        argv=["-c", "print('codex')"],
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert plan["requiresExecute"] is True
    assert not (config_home / "config.json").exists()

    receipt = runtime_profiles.apply_upsert(
        plan, config_home=str(config_home), runtime_home=str(runtime_home)
    )
    assert receipt["changed"] is True
    assert (
        runtime_profiles.configured_profiles(
            config_home=str(config_home), runtime_home=str(runtime_home)
        )[0]["id"]
        == "codex-python-wrapper"
    )

    default_plan = runtime_profiles.set_default(
        "codex-python-wrapper",
        execute=False,
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert default_plan["changed"] is False
    default_receipt = runtime_profiles.set_default(
        "codex-python-wrapper",
        execute=True,
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert default_receipt["changed"] is True

    remove_plan = runtime_profiles.plan_remove(
        "codex-python-wrapper",
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert runtime_profiles.configured_profiles(
        config_home=str(config_home), runtime_home=str(runtime_home)
    )
    runtime_profiles.apply_remove(
        remove_plan, config_home=str(config_home), runtime_home=str(runtime_home)
    )
    resolved = config.resolve_config(
        config_home=str(config_home), runtime_home=str(runtime_home)
    )
    assert resolved["config"]["agent"]["runtimeProfiles"] == []
    assert resolved["config"]["agent"]["defaultRuntimeProfile"] is None


def test_runtime_profile_upsert_accepts_only_registered_third_party_provider(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "kungfu.contract.contract_hash", lambda *args, **kwargs: ROOT_HASH
    )
    skill = tmp_path / "SKILL.md"
    skill.write_text("---\nname: terminal-agent\n---\n", encoding="utf-8")
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "runtime"
    config.set_user_config_value(
        "agent.nativeProviderAdapters",
        [_third_party_adapter(skill)],
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )

    plan = runtime_profiles.plan_upsert(
        profile_id="termagent.path.test",
        label="Terminal Agent",
        provider="termagent",
        executable=sys.executable,
        interactive_argv=["-c", "print('native')"],
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )

    assert plan["profile"]["provider"] == "termagent"
    assert plan["profile"]["launch"]["versionArgv"] == ["--version"]
    with pytest.raises(ValueError, match="not registered"):
        runtime_profiles.plan_upsert(
            profile_id="unknown.path.test",
            label="Unknown",
            provider="unknown",
            executable=sys.executable,
            config_home=str(config_home),
            runtime_home=str(runtime_home),
        )


def test_run_agent_default_and_explicit_profiles_resolve_the_same_executable(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "kungfu.contract.contract_hash", lambda *args, **kwargs: ROOT_HASH
    )
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "runtime"
    for profile_id, agent_name in (
        ("opencode.free.plan", "plan"),
        ("opencode.free.build", "build"),
    ):
        plan = runtime_profiles.plan_upsert(
            profile_id=profile_id,
            label=profile_id,
            provider="opencode",
            executable=sys.executable,
            argv=["run", "--pure", "--agent", agent_name, "--format", "json"],
            backend="direct",
            config_home=str(config_home),
            runtime_home=str(runtime_home),
        )
        runtime_profiles.apply_upsert(
            plan, config_home=str(config_home), runtime_home=str(runtime_home)
        )
    runtime_profiles.set_default(
        "opencode.free.plan",
        execute=True,
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    default, default_source = run_agent.select_profile(
        None, config_home=str(config_home), runtime_home=str(runtime_home)
    )
    explicit, explicit_source = run_agent.select_profile(
        "opencode.free.build",
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    assert default_source == "default"
    assert explicit_source == "explicit"
    assert default["launch"]["executable"] == explicit["launch"]["executable"]
    assert default["launch"]["executable"] == sys.executable


def test_native_interactive_profile_uses_the_verified_default(monkeypatch):
    default = {"id": "codex-default", "provider": "codex"}
    monkeypatch.setattr(
        runtime_profiles.kungfu_config,
        "resolve_config",
        lambda **_kwargs: {"agent": {}},
    )
    monkeypatch.setattr(
        runtime_profiles,
        "discover_catalog",
        lambda **_kwargs: {
            "defaultProfileId": "codex-default",
            "configured": [],
            "discovered": [],
        },
    )
    monkeypatch.setattr(
        runtime_profiles,
        "find_profile",
        lambda profile_id, **_kwargs: (
            default if profile_id == "codex-default" else None
        ),
    )

    profile, source = run_agent.select_interactive_profile()

    assert profile == default
    assert source == "default"


def test_native_interactive_profile_selects_only_available_candidate(monkeypatch):
    only = {"id": "amp-only", "provider": "amp"}
    monkeypatch.setattr(
        runtime_profiles.kungfu_config,
        "resolve_config",
        lambda **_kwargs: {"agent": {}},
    )
    monkeypatch.setattr(
        runtime_profiles,
        "discover_catalog",
        lambda **_kwargs: {
            "defaultProfileId": None,
            "configured": [only],
            "discovered": [],
        },
    )

    profile, source = run_agent.select_interactive_profile()

    assert profile == only
    assert source == "only-available"


@pytest.mark.parametrize(
    ("catalog", "message"),
    [
        (
            {"defaultProfileId": None, "configured": [], "discovered": []},
            "kungfu agent runtime discover",
        ),
        (
            {
                "defaultProfileId": None,
                "configured": [
                    {"id": "codex-one", "provider": "codex"},
                    {"id": "claude-two", "provider": "claude"},
                ],
                "discovered": [],
            },
            "runtime set-default",
        ),
    ],
)
def test_native_interactive_profile_never_guesses_without_one_choice(
    monkeypatch, catalog, message
):
    monkeypatch.setattr(
        runtime_profiles.kungfu_config,
        "resolve_config",
        lambda **_kwargs: {"agent": {}},
    )
    monkeypatch.setattr(
        runtime_profiles,
        "discover_catalog",
        lambda **_kwargs: catalog,
    )

    with pytest.raises(ValueError, match=message):
        run_agent.select_interactive_profile()


def test_run_agent_parses_opencode_jsonl_without_using_session_history():
    output = "\n".join(
        [
            json.dumps(
                {
                    "type": "step_start",
                    "sessionID": "ses-fresh",
                    "part": {"type": "step-start"},
                }
            ),
            json.dumps(
                {
                    "type": "text",
                    "sessionID": "ses-fresh",
                    "part": {"type": "text", "text": "OPENCODE_OK"},
                }
            ),
            json.dumps(
                {
                    "type": "step_finish",
                    "sessionID": "ses-fresh",
                    "part": {
                        "type": "step-finish",
                        "tokens": {"total": 12},
                        "cost": 0,
                    },
                }
            ),
        ]
    )
    parsed = run_agent.parse_provider_output("opencode", output)
    assert parsed["providerSessionIds"] == ["ses-fresh"]
    assert parsed["text"] == "OPENCODE_OK"
    assert parsed["usage"] == {"total": 12}
    assert parsed["cost"] == 0


def test_run_agent_projects_credential_safe_workspace_command_preview():
    activities = run_agent.public_activities_from_provider_line(
        "codex",
        json.dumps(
            {
                "type": "item.started",
                "item": {
                    "type": "command_execution",
                    "command": "curl https://example.invalid/?token=secret",
                },
            }
        ),
    )
    assert activities == [
        {
            "schema": "kungfu.agent-run.activity/v1",
            "kind": "tool",
            "phase": "started",
            "text": (
                "Workspace command started. "
                "curl https://example.invalid/?token=<redacted>"
            ),
            "commandPreview": "curl https://example.invalid/?token=<redacted>",
            "rawToolArgumentsExposed": False,
        }
    ]
    assert "secret" not in json.dumps(activities)

    safe = run_agent.public_activities_from_provider_line(
        "codex",
        json.dumps(
            {
                "type": "item.started",
                "item": {
                    "type": "command_execution",
                    "command": "pnpm test --filter @kungfu-tech/product-kungfu",
                },
            }
        ),
    )
    assert safe[0]["commandPreview"] == (
        "pnpm test --filter @kungfu-tech/product-kungfu"
    )


def test_run_agent_default_codex_launch_supports_non_git_project_writes():
    argv = run_agent.launch_argv(
        {
            "provider": "codex",
            "launch": {
                "executable": "/usr/bin/codex",
                "argv": [],
                "shellMode": False,
            },
        },
        "Complete the project deliverable.",
        workspace_root="/tmp/starter-project",
    )
    assert argv[:-1] == [
        "/usr/bin/codex",
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
    ]

    review_argv = run_agent.launch_argv(
        {
            "provider": "codex",
            "launch": {
                "executable": "/usr/bin/codex",
                "argv": [],
                "shellMode": False,
            },
        },
        "Review the project deliverable.",
        workspace_root="/tmp/starter-project",
        permission_mode="read-only",
    )
    assert review_argv[review_argv.index("--sandbox") + 1] == "read-only"


def test_native_interactive_argv_is_distinct_from_managed_argv():
    profile = {
        "provider": "codex",
        "launch": {
            "executable": "/usr/bin/codex",
            "argv": ["exec", "--json"],
            "interactiveArgv": ["--no-alt-screen"],
            "shellMode": False,
        },
    }

    assert run_agent.interactive_launch_argv(profile) == [
        "/usr/bin/codex",
        "--no-alt-screen",
    ]
    assert run_agent.launch_argv(profile, "bounded task")[:-1] == [
        "/usr/bin/codex",
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
    ]


def test_windows_codex_runtime_health_uses_capability_not_version():
    calls = []

    def probe(argv, **kwargs):
        calls.append((argv, kwargs))
        if argv[-1] == "--help":
            return subprocess.CompletedProcess(
                argv, 0, stdout="  sandbox  Run commands within a sandbox\n", stderr=""
            )
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    result = native_launch.provider_runtime_health(
        {
            "provider": "codex",
            "launch": {"executable": "C:\\Agent\\codex.exe"},
        },
        cwd="C:\\project",
        env={"PATH": "C:\\Windows\\System32"},
        platform="win32",
        run=probe,
    )

    assert result["ok"] is True
    assert result["status"] == "ready"
    assert result["modelInvoked"] is False
    assert calls[1][0][-8:] == [
        "sandbox",
        "windows",
        "--",
        "cmd.exe",
        "/d",
        "/c",
        "exit",
        "0",
    ]


def test_windows_codex_runtime_health_fails_closed_before_model_launch():
    def probe(argv, **_kwargs):
        if argv[-1] == "--help":
            return subprocess.CompletedProcess(
                argv, 0, stdout="  sandbox  Run commands within a sandbox\n", stderr=""
            )
        return subprocess.CompletedProcess(
            argv,
            1,
            stdout="",
            stderr=(
                "windows sandbox failed: timed out after 15000ms connecting "
                "runner pipe-in\n"
            ),
        )

    result = native_launch.provider_runtime_health(
        {
            "provider": "codex",
            "launch": {"executable": "C:\\Agent\\codex.exe"},
        },
        cwd="C:\\project",
        env={"PATH": "C:\\Windows\\System32"},
        platform="win32",
        run=probe,
    )

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert "runner pipe-in" in result["diagnostic"]
    assert result["permissionsWidened"] is False


def test_windows_codex_without_sandbox_helper_is_not_version_blocked():
    result = native_launch.provider_runtime_health(
        {
            "provider": "codex",
            "launch": {"executable": "C:\\Agent\\codex.exe"},
        },
        cwd="C:\\project",
        env={"PATH": "C:\\Windows\\System32"},
        platform="win32",
        run=lambda argv, **_kwargs: subprocess.CompletedProcess(
            argv, 0, stdout="Codex legacy help\n", stderr=""
        ),
    )

    assert result["ok"] is True
    assert result["status"] == "capability-unverified"
    assert "version-based" in result["warning"]


def test_broken_windows_codex_sandbox_blocks_before_session_or_provider(
    monkeypatch, tmp_path
):
    profile = {
        "id": "kungfu.agent-runtime.codex.windows-broken",
        "provider": "codex",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "C:\\Agent\\codex.exe",
            "interactiveArgv": [],
            "shellMode": False,
        },
        "bootstrap": {"adapter": "codex", "envelope": "required"},
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda _profile: {"ok": True, "error": None, "version": "arbitrary"},
    )
    monkeypatch.setattr(
        run_agent,
        "_provider_runtime_health",
        lambda _profile, **_kwargs: {
            "ok": False,
            "diagnostic": (
                "windows sandbox failed: timed out connecting runner pipe-in"
            ),
        },
    )
    launches = []
    session_requests = []

    with pytest.raises(ValueError, match="did not launch the Agent"):
        run_agent.run_native_interactive(
            profile,
            runtime_dir=str(tmp_path / "runtime"),
            config_home=str(tmp_path / "config"),
            runtime_home=str(tmp_path / "home"),
            workspace_root=str(tmp_path),
            work_ref=None,
            work_selection={
                "schema": "kungfu.native-work-selection/v1",
                "state": "none",
            },
            process_runner=lambda *args, **kwargs: launches.append((args, kwargs)),
            session_invoker=lambda request: session_requests.append(request),
        )

    assert launches == []
    assert session_requests == []


@pytest.mark.parametrize("provider", ["codex", "claude", "amp", "opencode"])
def test_native_provider_adapter_advertises_session_skill_without_provider_writes(
    tmp_path, provider
):
    runtime_dir = tmp_path / "runtime"
    adapter = run_agent.native_provider_adapter(
        provider,
        runtime_dir=str(runtime_dir),
        session_id="native:00000000-0000-4000-8000-000000000001",
    )

    skill_file = Path(adapter["skillFile"])
    assert skill_file.is_relative_to(runtime_dir)
    assert "name: kungfu-agent-onboarding" in skill_file.read_text(encoding="utf-8")
    assert not (tmp_path / ".codex").exists()
    assert not (tmp_path / ".claude").exists()
    assert not (tmp_path / ".config").exists()
    if provider == "codex":
        assert adapter["argv"][0] == "-c"
        assert adapter["argv"][1].startswith("log_dir=")
        log_value = adapter["argv"][1].removeprefix("log_dir=")
        assert (
            tomllib.loads(f"value = {log_value}")["value"] == adapter["providerLogDir"]
        )
        assert Path(adapter["providerLogDir"]).is_relative_to(runtime_dir)
        assert adapter["argv"][2] == "--no-alt-screen"
        assert adapter["argv"][3] == "-c"
        assert adapter["argv"][4].startswith("skills.config=")
        config_value = adapter["argv"][4].removeprefix("skills.config=")
        assert tomllib.loads(f"value = {config_value}")["value"] == [
            {"path": str(skill_file.parent), "enabled": True}
        ]
        assert "trust prompts" in adapter["knownLimits"][0]
    elif provider == "claude":
        assert adapter["argv"] == [
            "--append-system-prompt-file",
            str(skill_file),
        ]
    elif provider == "amp":
        assert adapter["argv"][0] == "--settings-file"
        settings = json.loads(Path(adapter["argv"][1]).read_text(encoding="utf-8"))
        assert settings == {"amp.skills.path": str(skill_file.parents[1])}
        assert adapter["knownLimits"]
    else:
        config = json.loads(adapter["environment"]["OPENCODE_CONFIG_CONTENT"])
        assert config == {"instructions": [str(skill_file)]}


def test_codex_native_attempts_use_distinct_runtime_log_directories(tmp_path):
    runtime_dir = tmp_path / "runtime"
    first = run_agent.native_provider_adapter(
        "codex",
        runtime_dir=str(runtime_dir),
        session_id="native:00000000-0000-4000-8000-000000000001",
    )
    second = run_agent.native_provider_adapter(
        "codex",
        runtime_dir=str(runtime_dir),
        session_id="native:00000000-0000-4000-8000-000000000002",
    )

    assert first["providerLogDir"] != second["providerLogDir"]
    assert Path(first["providerLogDir"]).is_dir()
    assert Path(second["providerLogDir"]).is_dir()
    assert first["argv"][1] != second["argv"][1]


def test_registered_third_party_adapter_materializes_only_bounded_runtime_state(
    tmp_path,
):
    source = tmp_path / "source" / "SKILL.md"
    source.parent.mkdir()
    source.write_text("---\nname: terminal-agent\n---\n", encoding="utf-8")
    resolved = {"config": config.raw_default_config(str(CONTRACT))}
    resolved["config"]["agent"]["nativeProviderAdapters"] = [
        _third_party_adapter(source)
    ]
    runtime_dir = tmp_path / "runtime"

    adapter = runtime_profiles.materialize_adapter(
        "termagent",
        runtime_dir=str(runtime_dir),
        resolved_config=resolved,
    )

    skill_file = Path(adapter["skillFile"])
    assert skill_file.is_relative_to(runtime_dir)
    assert adapter["argv"] == ["--instructions", str(skill_file)]
    assert adapter["credentialEnvironment"] == ["TERMAGENT_API_KEY"]
    assert adapter["processEnvironment"] == ["TMUX", "TMUX_PANE"]
    assert adapter["environment"]["TERMAGENT_SKILL"] == str(skill_file)
    context = json.loads(adapter["environment"]["TERMAGENT_CONTEXT"])
    assert context["skill"] == str(skill_file)
    settings = json.loads(
        (skill_file.parents[2] / "settings.json").read_text(encoding="utf-8")
    )
    assert settings == {"skills": [str(skill_file.parents[1])]}
    assert not (tmp_path / ".termagent").exists()

    env = run_agent.native_environment(
        "termagent",
        runtime_dir=str(runtime_dir),
        config_home=str(tmp_path / "config"),
        runtime_home=str(tmp_path / "home"),
        workspace_root=str(tmp_path),
        work_ref=None,
        work_selection={"schema": "kungfu.native-work-selection/v1", "state": "none"},
        adapter=adapter,
        source={
            "PATH": "/usr/bin",
            "TERMAGENT_API_KEY": "admitted",
            "UNDECLARED_SECRET": "blocked",
        },
    )
    assert env["TERMAGENT_API_KEY"] == "admitted"
    assert "UNDECLARED_SECRET" not in env


def test_native_environment_publishes_exact_cli_and_canonical_bind_argv(tmp_path):
    cli_bin = tmp_path / "bin" / "kungfu"
    cli_bin.parent.mkdir()
    cli_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    cli_bin.chmod(0o700)
    stale_cli = tmp_path / "stale-bin" / "kungfu"
    stale_cli.parent.mkdir()
    stale_cli.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    stale_cli.chmod(0o700)
    runtime_dir = tmp_path / "project" / ".kungfu" / "runtime"

    env = run_agent.native_environment(
        "termagent",
        runtime_dir=str(runtime_dir),
        config_home=str(tmp_path / "config"),
        runtime_home=str(tmp_path / "home"),
        workspace_root=str(tmp_path / "project"),
        work_ref=None,
        work_selection={"schema": "kungfu.native-work-selection/v1", "state": "none"},
        source={"PATH": str(stale_cli.parent), "KUNGFU_CLI_BIN": str(cli_bin)},
    )

    context = json.loads(env["KUNGFU_AGENT_CONTEXT"])
    assert env["KUNGFU_CLI_BIN"] == str(cli_bin)
    assert env["KUNGFU_AGENT_RUNTIME_DIR"] == str(runtime_dir)
    assert context["entrypoints"]["bindWork"] == [
        str(cli_bin),
        "agent",
        "console",
        "bind-work",
        "--initiative-id",
        "<id>",
        "--assignment-id",
        "<id>",
        "--json",
    ]
    assert context["workBinding"]["internalSessionOperationsAreCliEntrypoints"] is False


def test_native_environment_recovers_dumb_term_only_for_real_terminal(tmp_path):
    common = {
        "runtime_dir": str(tmp_path / "runtime"),
        "config_home": str(tmp_path / "config"),
        "runtime_home": str(tmp_path / "home"),
        "workspace_root": str(tmp_path / "project"),
        "work_ref": None,
        "work_selection": {
            "schema": "kungfu.native-work-selection/v1",
            "state": "none",
        },
    }

    recovered = run_agent.native_environment(
        "termagent",
        **common,
        source={"PATH": "/usr/bin", "TERM": "dumb"},
        stdio_is_tty=True,
    )
    recovered_context = json.loads(recovered["KUNGFU_AGENT_CONTEXT"])
    assert recovered["TERM"] == "xterm"
    assert recovered["KUNGFU_AGENT_TERMINAL_RECOVERY"] == "dumb->xterm"
    assert recovered_context["terminal"] == {
        "stdioAttached": True,
        "ambientTerm": "dumb",
        "effectiveTerm": "xterm",
        "program": None,
        "programVersion": None,
        "recovered": True,
    }

    non_interactive = run_agent.native_environment(
        "termagent",
        **common,
        source={"PATH": "/usr/bin", "TERM": "dumb"},
        stdio_is_tty=False,
    )
    assert non_interactive["TERM"] == "dumb"
    assert "KUNGFU_AGENT_TERMINAL_RECOVERY" not in non_interactive

    valid = run_agent.native_environment(
        "termagent",
        **common,
        source={"PATH": "/usr/bin", "TERM": "xterm-256color"},
        stdio_is_tty=True,
    )
    assert valid["TERM"] == "xterm-256color"
    assert "KUNGFU_AGENT_TERMINAL_RECOVERY" not in valid


def test_native_environment_preserves_terminal_capability_metadata(tmp_path):
    env = run_agent.native_environment(
        "termagent",
        runtime_dir=str(tmp_path / "runtime"),
        config_home=str(tmp_path / "config"),
        runtime_home=str(tmp_path / "home"),
        workspace_root=str(tmp_path / "project"),
        work_ref=None,
        work_selection={
            "schema": "kungfu.native-work-selection/v1",
            "state": "none",
        },
        source={
            "PATH": "/usr/bin",
            "TERM": "xterm-256color",
            "TERM_PROGRAM": "iTerm.app",
            "TERM_PROGRAM_VERSION": "3.6.11",
            "TERMINFO_DIRS": "/Applications/iTerm.app/Contents/Resources/terminfo",
            "LC_TERMINAL": "iTerm2",
            "LC_TERMINAL_VERSION": "3.6.11",
            "UNDECLARED_TERMINAL_SECRET": "blocked",
        },
        stdio_is_tty=True,
    )

    assert env["TERM_PROGRAM"] == "iTerm.app"
    assert env["TERM_PROGRAM_VERSION"] == "3.6.11"
    assert env["LC_TERMINAL"] == "iTerm2"
    assert "UNDECLARED_TERMINAL_SECRET" not in env
    assert json.loads(env["KUNGFU_AGENT_CONTEXT"])["terminal"] == {
        "stdioAttached": True,
        "ambientTerm": "xterm-256color",
        "effectiveTerm": "xterm-256color",
        "program": "iTerm.app",
        "programVersion": "3.6.11",
        "recovered": False,
    }


def test_agent_context_returns_native_canonical_entrypoints(monkeypatch, tmp_path):
    native = {
        "schema": "kungfu.native-agent-context/v1",
        "environment": "native-interactive",
        "entrypoints": {"bindWork": ["/exact/kungfu", "agent", "console", "bind-work"]},
    }
    monkeypatch.setenv("KUNGFU_AGENT_CONTEXT", json.dumps(native))
    monkeypatch.delenv("KUNGFU_WORK_REF", raising=False)
    monkeypatch.delenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", raising=False)

    assert (
        agent_commands._context(
            SimpleNamespace(
                home=str(tmp_path / "home"), runtime_dir=str(tmp_path / "runtime")
            )
        )
        == native
    )


def test_agent_context_refreshes_native_work_binding_from_live_session(
    monkeypatch, tmp_path
):
    work_ref = {
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": ROOT_HASH,
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityVersionRoot": ROOT_HASH,
        "systemTimeCut": ROOT_HASH,
        "purpose": "continue-project-assignment",
    }
    native = {
        "schema": "kungfu.native-agent-context/v1",
        "environment": "native-interactive",
        "workBinding": {"launchState": "unbound"},
    }
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": "workspace:test",
        "consoleId": "assistant:workspace:test:native:one",
        "attemptId": "native:one",
        "runtimeProfileId": "kungfu.agent-runtime.codex.test",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["/exact/kungfu", "agent", "context", "--json"],
            "capabilities": ["/exact/kungfu", "agent", "capabilities", "--json"],
            "profiles": ["/exact/kungfu", "profile", "manager", "--json"],
            "bindWork": ["/exact/kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": [],
    }
    envelope = {**body, "envelopeRoot": run_agent.canonical_root(body)}
    monkeypatch.setenv("KUNGFU_AGENT_CONTEXT", json.dumps(native))
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.setattr(
        agent_commands.session_surface,
        "invoke",
        lambda request: {
            "binding": {"kind": "work", "workRef": work_ref},
            "request": request,
        },
    )

    context = agent_commands._context(
        SimpleNamespace(
            home=str(tmp_path / "home"), runtime_dir=str(tmp_path / "runtime")
        )
    )

    assert context["workBinding"]["launchState"] == "bound"
    assert context["workBinding"]["workRef"] == work_ref


def test_third_party_adapter_rejects_builtin_replacement_and_unsafe_templates(
    tmp_path,
):
    source = tmp_path / "SKILL.md"
    source.write_text("---\nname: terminal-agent\n---\n", encoding="utf-8")
    defaults = config.raw_default_config(str(CONTRACT))
    replacement = _third_party_adapter(source, provider="codex")
    defaults["agent"]["nativeProviderAdapters"] = [replacement]
    with pytest.raises(ValueError, match="cannot replace built-in"):
        runtime_profiles.adapter_catalog(resolved_config={"config": defaults})

    unsafe = _third_party_adapter(source)
    unsafe["skill"]["argv"] = ["--instructions", "{provider_home}"]
    defaults["agent"]["nativeProviderAdapters"] = [unsafe]
    with pytest.raises(ValueError, match="invalid template"):
        runtime_profiles.adapter_catalog(resolved_config={"config": defaults})

    unsafe = _third_party_adapter(source)
    unsafe["skill"]["files"] = [{"path": "../settings.json", "content": {}}]
    defaults["agent"]["nativeProviderAdapters"] = [unsafe]
    with pytest.raises(ValueError, match="unsafe runtime file path"):
        runtime_profiles.adapter_catalog(resolved_config={"config": defaults})


def test_native_interactive_runner_inherits_terminal_descriptors(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setenv("TMUX", "/private/tmp/tmux-501/agentctl,12345,7")
    monkeypatch.setenv("TMUX_PANE", "%42")
    profile = {
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "argv": ["--execute"],
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None},
    )

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=7)

    exit_code = run_agent.run_native_interactive(
        profile,
        runtime_dir=str(tmp_path / "runtime"),
        config_home=str(tmp_path / "config"),
        runtime_home=str(tmp_path / "home"),
        workspace_root=str(tmp_path),
        work_ref=None,
        work_selection={
            "schema": "kungfu.native-work-selection/v1",
            "state": "none",
        },
        process_runner=runner,
    )

    assert exit_code == 7
    assert calls[0][0][0] == "/usr/bin/amp"
    assert calls[0][0][1] == "--settings-file"
    assert Path(calls[0][0][2]).is_relative_to(tmp_path / "runtime")
    assert set(calls[0][1]) == {"cwd", "env", "check"}
    assert calls[0][1]["check"] is False
    assert calls[0][1]["env"]["KUNGFU_AGENT_ENVIRONMENT"] == "native-interactive"
    assert calls[0][1]["env"]["TMUX"] == "/private/tmp/tmux-501/agentctl,12345,7"
    assert calls[0][1]["env"]["TMUX_PANE"] == "%42"
    assert "stdin" not in calls[0][1]
    assert "stdout" not in calls[0][1]
    assert "stderr" not in calls[0][1]
    assert "capture_output" not in calls[0][1]


def test_native_interactive_spawns_provider_before_observer_thread(
    monkeypatch, tmp_path
):
    events = []
    process_calls = []
    profile = {
        "id": "kungfu.agent-runtime.amp.native",
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None, "version": "1.2.3"},
    )
    monkeypatch.setattr(
        run_agent,
        "build_skill_context",
        lambda *_args, **_kwargs: {
            "schema": "kungfu.skill-context/v1",
            "catalog": [],
        },
    )

    class ProviderProcess:
        def __init__(self, argv, **kwargs):
            events.append("provider-spawn")
            process_calls.append((argv, kwargs))

        def wait(self):
            return 0

    class ObserverThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            events.append("observer-start")

        def join(self, timeout=None):
            pass

    def invoke(request):
        if request["operation"] == "plan-native-start":
            return {**request["input"], "root": ROOT_HASH}
        return {"status": "ok"}

    monkeypatch.setattr(run_agent.subprocess, "Popen", ProviderProcess)
    monkeypatch.setattr(run_agent.threading, "Thread", ObserverThread)
    monkeypatch.setattr(native_launch, "_native_terminal_route", lambda _provider: None)

    assert (
        run_agent.run_native_interactive(
            profile,
            runtime_dir=str(tmp_path / "runtime"),
            config_home=str(tmp_path / "config"),
            runtime_home=str(tmp_path / "home"),
            workspace_root=str(tmp_path),
            work_ref=None,
            work_selection={
                "schema": "kungfu.native-work-selection/v1",
                "workspaceId": "workspace:test",
                "state": "none",
            },
            session_invoker=invoke,
            session_endpoint="/tmp/kungfu-test.sock",
        )
        == 0
    )

    assert events == ["provider-spawn", "observer-start"]
    assert process_calls[0][0][0] == "/usr/bin/amp"
    assert "stdin" not in process_calls[0][1]
    assert "stdout" not in process_calls[0][1]
    assert "stderr" not in process_calls[0][1]


def test_bare_native_launches_get_unique_workspace_consoles(monkeypatch, tmp_path):
    requests = []
    profile = {
        "id": "kungfu.agent-runtime.amp.native",
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "argv": ["--execute"],
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None, "version": "1.2.3"},
    )
    monkeypatch.setattr(
        run_agent,
        "build_skill_context",
        lambda *_args, **_kwargs: {
            "schema": "kungfu.skill-context/v1",
            "catalog": [],
        },
    )

    def invoke(request):
        requests.append(request)
        if request["operation"] == "plan-native-start":
            return {**request["input"], "root": ROOT_HASH}
        if request["operation"] == "show":
            return {"binding": {"kind": "workspace-assistant", "workRef": None}}
        return {"status": "ok"}

    for _index in range(2):
        assert (
            run_agent.run_native_interactive(
                profile,
                runtime_dir=str(tmp_path / "runtime"),
                config_home=str(tmp_path / "config"),
                runtime_home=str(tmp_path / "home"),
                workspace_root=str(tmp_path),
                work_ref=None,
                work_selection={
                    "schema": "kungfu.native-work-selection/v1",
                    "workspaceId": "workspace:test",
                    "state": "none",
                },
                process_runner=lambda *_args, **_kwargs: SimpleNamespace(returncode=0),
                session_invoker=invoke,
                session_endpoint="/tmp/kungfu-test.sock",
            )
            == 0
        )

    plans = [
        request["input"]
        for request in requests
        if request["operation"] == "plan-native-start"
    ]
    assert len(plans) == 2
    assert plans[0]["workConsoleId"] != plans[1]["workConsoleId"]
    assert all(
        plan["workConsoleId"].startswith("assistant:workspace:test:native:")
        for plan in plans
    )
    assert all(
        plan["binding"] == {"kind": "workspace-assistant", "workRef": None}
        for plan in plans
    )
    assert all(plan["bootstrap"]["state"] in {"verified", "degraded"} for plan in plans)
    assert all(
        plan["bootstrap"]["attemptId"] == plan["sessionAttemptId"] for plan in plans
    )
    assert all(
        plan["bootstrap"]["mutationsAllowed"]
        is (plan["bootstrap"]["state"] == "verified")
        for plan in plans
    )


def test_unbound_native_attempt_heartbeats_session_without_work_observation(
    monkeypatch, tmp_path
):
    requests = []
    profile = {
        "id": "kungfu.agent-runtime.amp.native",
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None, "version": "1.2.3"},
    )
    monkeypatch.setattr(
        run_agent,
        "build_skill_context",
        lambda *_args, **_kwargs: {
            "schema": "kungfu.skill-context/v1",
            "catalog": [],
        },
    )

    def invoke(request):
        requests.append(request)
        if request["operation"] == "plan-native-start":
            return {**request["input"], "root": ROOT_HASH}
        if request["operation"] == "show":
            return {"binding": {"kind": "workspace-assistant", "workRef": None}}
        return {"status": "ok"}

    def runner(*_args, **_kwargs):
        time.sleep(0.03)
        return SimpleNamespace(returncode=0)

    assert (
        run_agent.run_native_interactive(
            profile,
            runtime_dir=str(tmp_path / "runtime"),
            config_home=str(tmp_path / "config"),
            runtime_home=str(tmp_path / "home"),
            workspace_root=str(tmp_path),
            work_ref=None,
            work_selection={
                "schema": "kungfu.native-work-selection/v1",
                "workspaceId": "workspace:test",
                "state": "single",
            },
            process_runner=runner,
            session_invoker=invoke,
            session_endpoint="/tmp/kungfu-test.sock",
            work_observer=lambda _work_ref: {
                "state": "fresh",
                "work": {"state": "available"},
            },
            heartbeat_seconds=0.005,
        )
        == 0
    )

    operations = [request["operation"] for request in requests]
    assert operations.count("show") >= 2
    heartbeats = [
        request for request in requests if request["operation"] == "heartbeat-native"
    ]
    assert len(heartbeats) >= 2
    assert all(
        heartbeat["observation"]
        == {
            "schema": "kungfu.attempt-heartbeat/v1",
            "state": "fresh",
            "staleAfterMs": 5000,
            "workRefRoot": None,
            "diagnostic": None,
        }
        for heartbeat in heartbeats
    )
    assert operations.count("end-native") == 1


def test_native_interactive_runner_rejects_profile_adapter_identity_drift(
    monkeypatch, tmp_path
):
    profile = {
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "interactiveArgv": [],
            "shellMode": False,
        },
        "bootstrap": {"adapter": "opencode", "envelope": "required"},
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None},
    )

    with pytest.raises(ValueError, match="adapter must match provider"):
        run_agent.run_native_interactive(
            profile,
            runtime_dir=str(tmp_path / "runtime"),
            config_home=str(tmp_path / "config"),
            runtime_home=str(tmp_path / "home"),
            workspace_root=str(tmp_path),
            work_ref=None,
            work_selection={
                "schema": "kungfu.native-work-selection/v1",
                "state": "none",
            },
        )


def test_current_native_console_uses_project_runtime_when_cli_context_is_home(
    monkeypatch, tmp_path
):
    requests = []
    observed_runtime_dirs = []
    project = tmp_path / "project"
    project_runtime = project / ".kungfu" / "runtime"
    project_runtime.mkdir(parents=True)
    target = resolve_workspace_target("read-only", str(project), cwd=str(project))
    envelope = {
        "workspaceId": target.identity.workspace_id,
        "consoleId": f"assistant:{target.identity.workspace_id}:native:one",
        "attemptId": "native:one",
    }
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.setenv(
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT",
        json.dumps(verified_bootstrap_receipt()),
    )
    monkeypatch.setenv("KUNGFU_AGENT_ATTEMPT_ID", "native:one")
    monkeypatch.setenv("KUNGFU_AGENT_SESSION_ACTOR", "native:codex:native:one")
    monkeypatch.setenv("KUNGFU_WORKSPACE_ROOT", str(project))
    monkeypatch.setenv("KUNGFU_AGENT_RUNTIME_DIR", str(project_runtime))
    monkeypatch.setenv("KF_RUNTIME_DIR", str(tmp_path / "kungfu-home" / "runtime"))

    def status(runtime_dir, *_args):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "assignment": {"assignment_id": "assignment:test"},
            "query_proof_root": ROOT_HASH,
        }

    monkeypatch.setattr(
        "kungfu.cli.commands.assignment._status",
        status,
    )
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment.profile_source", lambda: tmp_path
    )

    def validate_source(_source, runtime_dir):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": ROOT_HASH,
            }
        }

    monkeypatch.setattr("kungfu.profile_sdk.validate_source", validate_source)

    def invoke(request, **_kwargs):
        requests.append(request)
        if request["operation"] == "plan-native-bind-work":
            return {
                "operation": "native-bind-work",
                "root": ROOT_HASH,
                **request["input"]["session"],
                "workRef": request["input"]["workRef"],
            }
        return {"status": "bound", "receiptRoot": ROOT_HASH}

    monkeypatch.setattr(run_agent.session_surface, "invoke", invoke)
    result = run_agent.bind_current_native_work(
        str(tmp_path / "kungfu-home" / "runtime"),
        "initiative:test",
        "assignment:test",
    )

    assert result["workRef"]["initiativeId"] == "initiative:test"
    assert result["workRef"]["entityId"] == "assignment:test"
    assert observed_runtime_dirs == [str(project_runtime), str(project_runtime)]
    assert [request["operation"] for request in requests] == [
        "plan-native-bind-work",
        "bind-native-work",
    ]
    assert requests[1]["expectedPlanRoot"] == ROOT_HASH


def test_public_bind_work_cli_preserves_stable_project_runtime_under_home(
    monkeypatch, tmp_path
):
    project = tmp_path / "project"
    project_runtime = project / ".kungfu" / "runtime"
    project_runtime.mkdir(parents=True)
    target = resolve_workspace_target("read-only", str(project), cwd=str(project))
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": target.identity.workspace_id,
        "consoleId": f"assistant:{target.identity.workspace_id}:native:one",
        "attemptId": "native:one",
        "runtimeProfileId": "kungfu.agent-runtime.codex.test",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["/exact/kungfu", "agent", "context", "--json"],
            "capabilities": ["/exact/kungfu", "agent", "capabilities", "--json"],
            "profiles": ["/exact/kungfu", "profile", "manager", "--json"],
            "bindWork": ["/exact/kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": [],
    }
    envelope = {**body, "envelopeRoot": run_agent.canonical_root(body)}
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.setenv(
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT",
        json.dumps(verified_bootstrap_receipt()),
    )
    monkeypatch.setenv("KUNGFU_AGENT_ATTEMPT_ID", "native:one")
    monkeypatch.setenv("KUNGFU_WORKSPACE_ROOT", str(project))
    monkeypatch.setenv("KUNGFU_AGENT_RUNTIME_DIR", str(project_runtime))
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment._status",
        lambda runtime_dir, *_args: {
            "assignment": {
                "assignment_id": "assignment:test",
                "observed_runtime_dir": runtime_dir,
            },
            "query_proof_root": ROOT_HASH,
        },
    )
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment.profile_source", lambda: tmp_path
    )
    monkeypatch.setattr(
        "kungfu.profile_sdk.validate_source",
        lambda _source, runtime_dir: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": ROOT_HASH,
                "observedRuntimeDir": runtime_dir,
            }
        },
    )

    def invoke(request, **_kwargs):
        if request["operation"] == "plan-native-bind-work":
            return {
                "operation": "native-bind-work",
                "root": ROOT_HASH,
                **request["input"]["session"],
                "workRef": request["input"]["workRef"],
            }
        return {"status": "bound", "receiptRoot": ROOT_HASH}

    monkeypatch.setattr(run_agent.session_surface, "invoke", invoke)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "kungfu-home"),
            "agent",
            "console",
            "bind-work",
            "--initiative-id",
            "initiative:test",
            "--assignment-id",
            "assignment:test",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "bound"
    assert payload["workRef"]["workspaceId"] == target.identity.workspace_id
    assert payload["workRef"]["entityId"] == "assignment:test"


def test_public_bind_work_cli_selects_explicit_external_project(monkeypatch, tmp_path):
    requests = []
    observed_runtime_dirs = []
    console_project = tmp_path / "console-project"
    console_runtime = console_project / ".kungfu" / "runtime"
    console_runtime.mkdir(parents=True)
    console_target = resolve_workspace_target(
        "read-only", str(console_project), cwd=str(console_project)
    )
    work_project = tmp_path / "work-project"
    work_runtime = work_project / ".kungfu" / "runtime"
    work_runtime.mkdir(parents=True)
    work_target = resolve_workspace_target(
        "read-only", str(work_project), cwd=str(work_project)
    )
    body = {
        "schema": "kungfu.agent-console-envelope/v1",
        "workspaceId": console_target.identity.workspace_id,
        "consoleId": f"assistant:{console_target.identity.workspace_id}:native:one",
        "attemptId": "native:one",
        "runtimeProfileId": "kungfu.agent-runtime.codex.test",
        "provider": "codex",
        "activeProfiles": [],
        "workRef": None,
        "entrypoints": {
            "context": ["/exact/kungfu", "agent", "context", "--json"],
            "capabilities": [
                "/exact/kungfu",
                "agent",
                "capabilities",
                "--json",
            ],
            "profiles": ["/exact/kungfu", "profile", "manager", "--json"],
            "bindWork": ["/exact/kungfu", "agent", "console", "bind-work"],
        },
        "knownLimits": [],
    }
    envelope = {**body, "envelopeRoot": run_agent.canonical_root(body)}
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.setenv(
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT",
        json.dumps(verified_bootstrap_receipt()),
    )
    monkeypatch.setenv("KUNGFU_AGENT_ATTEMPT_ID", "native:one")
    monkeypatch.setenv("KUNGFU_WORKSPACE_ROOT", str(console_project))
    monkeypatch.setenv("KUNGFU_AGENT_RUNTIME_DIR", str(console_runtime))

    def status(runtime_dir, *_args):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "assignment": {"assignment_id": "assignment:external"},
            "query_proof_root": ROOT_HASH,
        }

    monkeypatch.setattr("kungfu.cli.commands.assignment._status", status)
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment.profile_source", lambda: tmp_path
    )

    def validate_source(_source, runtime_dir):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": ROOT_HASH,
            }
        }

    monkeypatch.setattr("kungfu.profile_sdk.validate_source", validate_source)

    def invoke(request, **_kwargs):
        requests.append(request)
        if request["operation"] == "plan-native-bind-work":
            return {
                "operation": "native-bind-work",
                "root": ROOT_HASH,
                **request["input"]["session"],
                "workRef": request["input"]["workRef"],
            }
        return {"status": "bound", "receiptRoot": ROOT_HASH}

    monkeypatch.setattr(run_agent.session_surface, "invoke", invoke)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "kungfu-home"),
            "agent",
            "console",
            "bind-work",
            "--initiative-id",
            "initiative:external",
            "--assignment-id",
            "assignment:external",
            "--workspace",
            str(work_project),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["status"] == "bound"
    assert payload["workRef"]["workspaceId"] == work_target.identity.workspace_id
    assert payload["session"]["workConsoleId"] == envelope["consoleId"]
    assert observed_runtime_dirs == [str(work_runtime), str(work_runtime)]
    assert requests[0]["input"]["bindingScope"] == "explicit-external-project"
    assert requests[0]["input"]["sourceWorkspaceId"] == envelope["workspaceId"]
    assert [request["operation"] for request in requests] == [
        "plan-native-bind-work",
        "bind-native-work",
    ]


def test_current_native_console_rejects_injected_project_runtime_drift(
    monkeypatch, tmp_path
):
    project = tmp_path / "project"
    project_runtime = project / ".kungfu" / "runtime"
    project_runtime.mkdir(parents=True)
    target = resolve_workspace_target("read-only", str(project), cwd=str(project))
    monkeypatch.setenv(
        "KUNGFU_AGENT_CONSOLE_ENVELOPE",
        json.dumps(
            {
                "workspaceId": target.identity.workspace_id,
                "consoleId": f"assistant:{target.identity.workspace_id}:native:one",
                "attemptId": "native:one",
            }
        ),
    )
    monkeypatch.setenv("KUNGFU_WORKSPACE_ROOT", str(project))
    monkeypatch.setenv("KUNGFU_AGENT_RUNTIME_DIR", str(tmp_path / "other" / "runtime"))

    with pytest.raises(ValueError, match="runtime does not match its Kungfu Project"):
        run_agent.bind_current_native_work(
            str(tmp_path / "kungfu-home" / "runtime"),
            "initiative:test",
            "assignment:test",
        )


def test_native_interactive_runner_reuses_work_console_with_fresh_attempts(
    monkeypatch, tmp_path
):
    requests = []
    launches = []
    profile = {
        "id": "kungfu.agent-runtime.amp.native",
        "provider": "amp",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": "/usr/bin/amp",
            "argv": ["--execute"],
            "interactiveArgv": [],
            "shellMode": False,
        },
    }
    work_ref = _work_ref()
    work_ref["entityId"] = "assignment:continuity"
    work_selection = {
        "schema": "kungfu.native-work-selection/v1",
        "workspaceId": work_ref["workspaceId"],
        "state": "bound",
        "initiativeId": "initiative:continuity",
        "assignmentId": work_ref["entityId"],
        "phase": "executing",
    }
    work_observation = {
        "schema": "kungfu.native-work-observation/v1",
        "state": "available",
        "initiativeId": "initiative:continuity",
        "assignmentId": work_ref["entityId"],
        "title": "Native continuity",
        "objective": "Keep Work visible across native UIs",
        "acceptanceChecks": ["Rediscover the same Work"],
        "phase": "executing",
        "queryProofRoot": ROOT_HASH,
        "nextActions": ["stage: Record the stage-ready boundary"],
        "evidenceEpisodeRoots": [],
        "continuation": {
            "completionClaimCount": 0,
            "independentReviewCount": 0,
            "continuationDecisionCount": 0,
        },
        "remainingObligation": None,
        "nextAction": "stage: Record the stage-ready boundary",
    }
    monkeypatch.setattr(
        runtime_profiles,
        "verify_profile",
        lambda selected: {"ok": True, "error": None, "version": "1.2.3"},
    )
    monkeypatch.setattr(
        run_agent,
        "build_skill_context",
        lambda *_args, **_kwargs: {
            "schema": "kungfu.skill-context/v1",
            "catalog": [{"key": "kungfu-agent"}],
        },
    )

    def invoke(request):
        requests.append(request)
        if request["operation"] == "plan-native-start":
            return {**request["input"], "root": ROOT_HASH}
        if request["operation"] == "show":
            return {"binding": {"kind": "work", "workRef": work_ref}}
        return {"status": "ok"}

    def runner(argv, **kwargs):
        launches.append((argv, kwargs))
        time.sleep(0.03)
        return SimpleNamespace(returncode=0)

    for _index in range(2):
        assert (
            run_agent.run_native_interactive(
                profile,
                runtime_dir=str(tmp_path / "runtime"),
                config_home=str(tmp_path / "config"),
                runtime_home=str(tmp_path / "home"),
                workspace_root=str(tmp_path),
                work_ref=work_ref,
                work_selection=work_selection,
                process_runner=runner,
                session_invoker=invoke,
                session_endpoint="/tmp/kungfu-test.sock",
                work_observer=lambda _work_ref: {
                    "state": "fresh",
                    "work": work_observation,
                },
                heartbeat_seconds=0.01,
            )
            == 0
        )

    plans = [
        request["input"]
        for request in requests
        if request["operation"] == "plan-native-start"
    ]
    assert len(plans) == 2
    assert plans[0]["workConsoleId"] == plans[1]["workConsoleId"]
    assert plans[0]["workConsoleId"] == (
        "work:kungfu.work-control:assignment:initiative:test:assignment:continuity"
    )
    assert plans[0]["sessionAttemptId"] != plans[1]["sessionAttemptId"]
    assert [request["operation"] for request in requests].count("heartbeat-native") >= 2
    assert [request["operation"] for request in requests].count(
        "project-native-work"
    ) == 2
    assert [request["operation"] for request in requests].count("end-native") == 2
    for _argv, kwargs in launches:
        envelope = json.loads(kwargs["env"]["KUNGFU_AGENT_CONSOLE_ENVELOPE"])
        skill_context = json.loads(kwargs["env"]["KUNGFU_SKILL_CONTEXT"])
        assert envelope["consoleId"] == plans[0]["workConsoleId"]
        assert envelope["workRef"] == work_ref
        assert skill_context["catalog"] == [{"key": "kungfu-agent"}]
        skill_pointer = envelope["skillRuntimeAudit"]
        assert skill_pointer["catalogRoot"] == session_contract.semantic_root(
            skill_context["catalog"]
        )
        assert skill_pointer["decisionPolicyRoot"].startswith("sha256:")
        assert skill_pointer["workRefRoot"] == session_contract.semantic_root(work_ref)
        assert skill_pointer["kfxDependencyRoots"] == []
        assert skill_pointer["receiptRoots"]
        assert skill_pointer["recoveryRoot"].startswith("sha256:")
        assert set(skill_pointer["entrypoints"]) == {
            "catalog",
            "advise",
            "read",
            "audit",
            "explain",
            "diagnose",
            "kfx",
        }
        assert kwargs["env"]["KUNGFU_PRIOR_TRANSCRIPT_BYTES"] == "0"
        assert "stdin" not in kwargs
        assert "stdout" not in kwargs
        assert "stderr" not in kwargs


@pytest.mark.skipif(not hasattr(os, "openpty"), reason="requires a POSIX PTY")
def test_registered_third_party_agent_preserves_real_pty_and_skill_injection(
    tmp_path,
):
    skill = tmp_path / "third-party-skill.md"
    skill.write_text("---\nname: terminal-agent\n---\n", encoding="utf-8")
    config_home = tmp_path / "config"
    runtime_home = tmp_path / "home"
    config.set_user_config_value(
        "agent.nativeProviderAdapters",
        [_third_party_adapter(skill)],
        config_home=str(config_home),
        runtime_home=str(runtime_home),
    )
    probe = (
        "import json,os,sys;"
        "print(json.dumps({"
        "'stdin':sys.stdin.isatty(),"
        "'stdout':sys.stdout.isatty(),"
        "'stderr':sys.stderr.isatty(),"
        "'environment':os.environ.get('KUNGFU_AGENT_ENVIRONMENT'),"
        "'skill':os.environ.get('TERMAGENT_SKILL'),"
        "'context':bool(os.environ.get('TERMAGENT_CONTEXT'))}),flush=True)"
    )
    profile = {
        "id": "termagent.path.pty-probe",
        "provider": "termagent",
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": sys.executable,
            "argv": [],
            "interactiveArgv": ["-c", probe],
            "versionArgv": ["--version"],
            "shellMode": False,
        },
        "bootstrap": {"adapter": "termagent", "envelope": "required"},
    }
    wrapper = (
        "from kungfu.agent import run_agent;"
        f"profile={profile!r};"
        "raise SystemExit(run_agent.run_native_interactive("
        "profile,"
        f"runtime_dir={str(tmp_path / 'runtime')!r},"
        f"config_home={str(config_home)!r},"
        f"runtime_home={str(runtime_home)!r},"
        f"workspace_root={str(tmp_path)!r},"
        "work_ref=None,"
        "work_selection={'schema':'kungfu.native-work-selection/v1','state':'none'}))"
    )
    master_fd, slave_fd = os.openpty()
    process = subprocess.Popen(
        [sys.executable, "-c", wrapper],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)
    chunks = []
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master_fd], [], [], 0.1)
            if ready:
                try:
                    chunks.append(os.read(master_fd, 65536))
                except OSError:
                    break
            if process.poll() is not None and not ready:
                break
        return_code = process.wait(timeout=1)
    finally:
        os.close(master_fd)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=1)

    assert return_code == 0
    output = b"".join(chunks).decode("utf-8").replace("\r", "")
    payload = json.loads(
        next(line for line in output.splitlines() if line.startswith("{"))
    )
    assert payload["stdin"] is True
    assert payload["stdout"] is True
    assert payload["stderr"] is True
    assert payload["environment"] == "native-interactive"
    assert payload["context"] is True
    assert Path(payload["skill"]).is_relative_to(tmp_path / "runtime")
