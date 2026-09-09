# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _agent_console_contract_support import *


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
