# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F403,F405

from _agent_console_contract_support import *


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
    observed_endpoints = []
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

    def resolve_profile(runtime_dir, **_kwargs):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "id": "kungfu.work-control",
            "root": ROOT_HASH,
            "source": str(tmp_path / "exact-work-control"),
        }

    monkeypatch.setattr(
        "kungfu.assignment_runtime.profile_lifecycle.resolve_qualified_work_profile",
        resolve_profile,
    )

    def invoke(request, **_kwargs):
        requests.append(request)
        observed_endpoints.append(_kwargs.get("endpoint"))
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
    assert observed_endpoints == [
        run_agent.session_surface.endpoint_for_runtime(project_runtime),
        run_agent.session_surface.endpoint_for_runtime(project_runtime),
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
        "kungfu.assignment_runtime.profile_lifecycle.resolve_qualified_work_profile",
        lambda runtime_dir, **_kwargs: {
            "id": "kungfu.work-control",
            "root": ROOT_HASH,
            "source": str(tmp_path / "exact-work-control"),
            "observedRuntimeDir": runtime_dir,
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
    monkeypatch.setattr(
        "kungfu.assignment_runtime.profile_lifecycle.resolve_qualified_work_profile",
        lambda *_args, **_kwargs: {
            "id": "kungfu.work-control",
            "root": work_ref["profileRoot"],
            "source": str(tmp_path / "exact-work-control"),
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
