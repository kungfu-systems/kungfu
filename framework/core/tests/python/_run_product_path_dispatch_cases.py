# SPDX-License-Identifier: Apache-2.0
"""Provider dispatch and managed execution cases."""
# ruff: noqa: F401,F403

from _run_product_path_support import *
from _run_product_path_support import _capture


def test_only_bare_provider_invocation_selects_native_interactive_mode():
    defaults = {
        "task": None,
        "work_selector": None,
        "workspace_root": None,
        "plan_only": False,
        "as_json": False,
        "events_json": False,
        "expected_plan_root": None,
        "allow_foreign_binding": False,
    }
    assert run._native_provider_request(**defaults) is True
    for field, value in (
        ("task", "bounded task"),
        ("work_selector", "work-1"),
        ("workspace_root", "/project"),
        ("plan_only", True),
        ("as_json", True),
        ("events_json", True),
        ("expected_plan_root", "sha256:" + "a" * 64),
        ("allow_foreign_binding", True),
    ):
        request = {**defaults, field: value}
        assert run._native_provider_request(**request) is False, field


@pytest.mark.parametrize("provider", ["codex", "claude", "amp", "opencode"])
def test_bare_provider_cli_dispatches_native_without_managed_work(
    tmp_path, monkeypatch, provider
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda ctx, **kwargs: calls.append((ctx, kwargs)),
    )
    monkeypatch.setattr(
        run,
        "_run_provider",
        lambda *_args, **_kwargs: pytest.fail("managed Work path was selected"),
    )

    result = CliRunner().invoke(
        kfc, ["--home", str(tmp_path / "home"), "run", provider]
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1] == {"provider": provider}


def test_native_provider_failure_leaves_actionable_terminal_error(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.chdir(project)
    target = SimpleNamespace(
        identity=SimpleNamespace(
            workspace_kind="project",
            workspace_root=str(project),
            workspace_id="workspace:test",
        ),
        runtime_dir=project / ".kungfu" / "runtime",
    )
    monkeypatch.setattr(
        run, "resolve_workspace_target", lambda *_args, **_kwargs: target
    )
    monkeypatch.setattr(
        run,
        "_provider_profile",
        lambda *_args, **_kwargs: {"provider": "codex"},
    )
    monkeypatch.setattr(
        run,
        "_native_work_binding",
        lambda *_args, **_kwargs: (
            None,
            {
                "schema": "kungfu.native-work-selection/v1",
                "workspaceId": "workspace:test",
                "state": "none",
            },
        ),
    )
    monkeypatch.setattr(run.run_agent.session_surface, "ensure", lambda *_args: "sock")
    completed = []
    monkeypatch.setattr(
        onboarding,
        "complete_agent_route",
        lambda **kwargs: completed.append(kwargs) or {"state": {"status": "completed"}},
    )
    monkeypatch.setattr(
        run,
        "_native_work_observer",
        lambda *_args: {"state": "active"},
    )

    def fail_after_binding(*_args, **kwargs):
        bound_work_ref = {
            "initiativeId": "project-work",
            "entityId": "assignment:first",
        }
        kwargs["work_observer"](bound_work_ref)
        kwargs["work_observer"](bound_work_ref)
        return 7

    monkeypatch.setattr(
        run.run_agent,
        "run_native_interactive",
        fail_after_binding,
    )

    result = CliRunner().invoke(kfc, ["--home", str(tmp_path / "home"), "run", "codex"])

    assert result.exit_code == 7
    assert "Error: provider-native UI 'codex' exited with status 7." in result.output
    assert "did not change Work completion" in result.output
    assert "kungfu agent session list --json" in result.output
    assert len(completed) == 1
    assert completed[0]["runtime_home"] == str(tmp_path / "home")


@pytest.mark.parametrize("provider", ["codex", "claude", "amp", "opencode"])
def test_parameterized_provider_cli_preserves_managed_path(
    tmp_path, monkeypatch, provider
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda *_args, **_kwargs: pytest.fail("native UI path was selected"),
    )
    monkeypatch.setattr(
        run,
        "_run_provider",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "run", provider, "bounded task"],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][0][1:3] == (provider, "bounded task")


@pytest.mark.parametrize(
    ("option", "value"),
    [
        ("--work", "assignment:alpha"),
        ("--workspace", "{project}"),
        ("--plan", None),
        ("--json", None),
        ("--events-json", None),
        ("--expected-plan-root", "sha256:" + "1" * 64),
    ],
)
def test_every_provider_control_option_preserves_managed_dispatch(
    tmp_path, monkeypatch, option, value
):
    project = tmp_path / "project"
    project.mkdir()
    calls = []
    monkeypatch.chdir(project)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda *_args, **_kwargs: pytest.fail("native UI path was selected"),
    )
    monkeypatch.setattr(
        run,
        "_run_provider",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    argument = str(project) if value == "{project}" else value
    argv = ["--home", str(tmp_path / "home"), "run", "codex", option]
    if argument is not None:
        argv.append(argument)

    result = CliRunner().invoke(kfc, argv)

    assert result.exit_code == 0, result.output
    assert len(calls) == 1


def test_bare_run_agent_dispatches_native_default(tmp_path, monkeypatch):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda ctx, **kwargs: calls.append((ctx, kwargs)),
    )

    result = CliRunner().invoke(kfc, ["--home", str(tmp_path / "home"), "run", "agent"])

    assert result.exit_code == 0, result.output
    assert calls[0][1] == {"profile_id": None, "workspace_root": None}


def test_bare_run_agent_dispatches_registered_third_party_profile(
    tmp_path, monkeypatch
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        run,
        "_run_native_provider",
        lambda ctx, **kwargs: calls.append((ctx, kwargs)),
    )

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "run",
            "agent",
            "--agent",
            "termagent.path.local",
        ],
    )

    assert result.exit_code == 0, result.output
    assert calls[0][1] == {
        "profile_id": "termagent.path.local",
        "workspace_root": None,
    }


def test_run_agent_managed_controls_still_require_prompt(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "run", "agent", "--json"],
    )

    assert result.exit_code == 2
    assert "--work-ref, --continuation, --timeout, and --json require --prompt" in (
        result.output
    )


def test_run_agent_prompt_and_explicit_profile_preserve_managed_execution(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    calls = []
    monkeypatch.chdir(project)

    def execute(**kwargs):
        calls.append(kwargs)
        return {
            "runId": "run:test",
            "runtimeProfile": {"provider": "codex"},
            "launch": {"exitCode": 0},
            "episode": {"manifestPath": str(tmp_path / "episode.json")},
        }

    monkeypatch.setattr(run.run_agent, "execute", execute)
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "run",
            "agent",
            "--prompt",
            "bounded task",
            "--agent",
            "codex-explicit",
            "--workspace",
            str(project),
        ],
    )

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    assert calls[0]["prompt"] == "bounded task"
    assert calls[0]["profile_id"] == "codex-explicit"
    assert calls[0]["workspace_root"] == str(project)
    assert calls[0]["work_ref"] is None
    assert calls[0]["continuation"] is None
    assert calls[0]["timeout_seconds"] == 900.0
