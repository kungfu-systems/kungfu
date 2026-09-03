# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _agent_console_contract_support import *


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
