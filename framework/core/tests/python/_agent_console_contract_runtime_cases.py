# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _agent_console_contract_support import *


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
