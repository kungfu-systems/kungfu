# SPDX-License-Identifier: Apache-2.0

import importlib
import json
from types import SimpleNamespace

from kungfu.agent import run_agent
from kungfu.workspace import resolve_workspace_target
from agent_bootstrap_fixtures import verified_bootstrap_receipt


ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")
ROOT_HASH = "sha256:" + "a" * 64


def _sha256(marker):
    return "sha256:" + marker * 64


def test_kickoff_restores_work_control_after_dogfood_profile(monkeypatch, tmp_path):
    active_profile = {"id": ""}
    ensure_calls = []

    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_runtime",
        lambda *_args, **_kwargs: (
            SimpleNamespace(workspace_root=str(tmp_path)),
            str(tmp_path / "runtime"),
            {},
        ),
    )

    def ensure_profile(_runtime_dir, _actor):
        active_profile["id"] = "work-control"
        ensure_calls.append("work-control")
        return []

    monkeypatch.setattr(ASSIGNMENT_CLI, "_ensure_profile", ensure_profile)
    monkeypatch.setattr(
        ASSIGNMENT_CLI.run_agent,
        "bind_current_native_work",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Work kickoff must not bind Agent Session")
        ),
    )
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_status",
        lambda *_args: {
            "phase": "claimed",
            "assignment": {"assignment_id": "work-1"},
        },
    )

    def consider_assignment(*_args, **_kwargs):
        active_profile["id"] = "dogfood"
        return {"consideration": {"receipt_root": _sha256("d")}}

    monkeypatch.setattr(
        ASSIGNMENT_CLI.dogfood_api,
        "consider_assignment",
        consider_assignment,
    )

    def profile_action(*_args, **_kwargs):
        assert active_profile["id"] == "work-control"
        return {"receipt": {"payload_hash": _sha256("a")}}

    monkeypatch.setattr(ASSIGNMENT_CLI, "_profile_action", profile_action)

    result = ASSIGNMENT_CLI._advance(
        str(tmp_path),
        False,
        "initiative-1",
        "work-1",
        "executing",
        "test-owner",
        "test kickoff",
    )

    assert ensure_calls == ["work-control", "work-control"]
    assert result["dogfood_consideration_root"] == _sha256("d")


def test_claim_does_not_require_or_bind_agent_session(monkeypatch, tmp_path):
    runtime_dir = str(tmp_path / "runtime")
    profile_actions = []
    monkeypatch.setenv("KUNGFU_AGENT_ATTEMPT_ID", "ended:previous-work")
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_runtime",
        lambda *_args, **_kwargs: (
            SimpleNamespace(workspace_root=str(tmp_path)),
            runtime_dir,
            {},
        ),
    )
    monkeypatch.setattr(ASSIGNMENT_CLI, "_ensure_profile", lambda *_args: [])
    monkeypatch.setattr(
        ASSIGNMENT_CLI.run_agent,
        "bind_current_native_work",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("Work claim must not bind Agent Session")
        ),
    )

    def profile_action(observed_runtime, operation, values, actor):
        profile_actions.append((observed_runtime, operation, values, actor))
        return {"receipt": {"payload_hash": _sha256("c")}}

    monkeypatch.setattr(ASSIGNMENT_CLI, "_profile_action", profile_action)
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_status",
        lambda *_args: {"phase": "claimed", "assignment_id": "work-2"},
    )

    result = ASSIGNMENT_CLI.assignment_start.claim(
        workspace_root=str(tmp_path),
        home=False,
        initiative_id="initiative-1",
        assignment_id="work-2",
        owner="owner-1",
        agent="codex",
        slot="slot-1",
        lease_id="lease-1",
        lease_expires_at="2026-08-10T00:00:00Z",
        authorized_by="owner-1",
        grant_scope="assignment-execution",
        actor_type="agent",
        runtime=ASSIGNMENT_CLI._runtime,
        ensure_profile=ASSIGNMENT_CLI._ensure_profile,
        profile_action=profile_action,
        status=ASSIGNMENT_CLI._status,
    )

    assert result["status"]["phase"] == "claimed"
    assert len(profile_actions) == 1
    assert profile_actions[0][0:2] == (runtime_dir, "claim-assignment")
    assert profile_actions[0][2]["assignmentId"] == "work-2"


def test_assignment_profile_source_prefers_native_source_layout(tmp_path, monkeypatch):
    checkout = tmp_path / "checkout"
    native = checkout / "extensions" / "work-control"
    native.mkdir(parents=True)
    extension_root = checkout / "extensions"
    monkeypatch.setenv("KF_BUNDLED_EXTENSION_ROOT", str(extension_root))
    monkeypatch.delenv("KF_EXTENSION_PATH", raising=False)

    def discover(profile_id, *, search_roots):
        assert profile_id == "kungfu.work-control"
        assert search_roots == [extension_root]
        return {"source": str(native)}

    monkeypatch.setattr("kungfu.profile_sdk.discover_source", discover)

    assert ASSIGNMENT_CLI.profile_source() == native


def test_agent_session_can_observe_work_from_explicit_external_project_and_profile(
    monkeypatch, tmp_path
):
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
    work_profile_source = tmp_path / "retained-work-control"
    work_profile_source.mkdir()
    envelope = {
        "workspaceId": console_target.identity.workspace_id,
        "consoleId": f"assistant:{console_target.identity.workspace_id}:native:one",
        "attemptId": "native:one",
    }
    monkeypatch.setenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", json.dumps(envelope))
    monkeypatch.setenv(
        "KUNGFU_AGENT_BOOTSTRAP_RECEIPT",
        json.dumps(verified_bootstrap_receipt()),
    )
    monkeypatch.setenv("KUNGFU_AGENT_ATTEMPT_ID", "native:one")
    monkeypatch.setenv("KUNGFU_AGENT_SESSION_ACTOR", "native:codex:native:one")
    monkeypatch.setenv("KUNGFU_WORKSPACE_ROOT", str(console_project))
    monkeypatch.setenv("KUNGFU_AGENT_RUNTIME_DIR", str(console_runtime))

    def status(runtime_dir, *_args):
        observed_runtime_dirs.append(runtime_dir)
        return {
            "assignment": {"assignment_id": "assignment:external"},
            "query_proof_root": ROOT_HASH,
        }

    monkeypatch.setattr(ASSIGNMENT_CLI, "_status", status)
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "profile_source",
        lambda: (_ for _ in ()).throw(
            AssertionError("explicit recovery source must not be rediscovered")
        ),
    )

    def validate_source(source, runtime_dir):
        assert source == work_profile_source.resolve()
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
        str(work_runtime),
        "initiative:external",
        "assignment:external",
        work_workspace_root=str(work_project),
        work_profile_source=work_profile_source,
    )

    assert observed_runtime_dirs == [str(work_runtime), str(work_runtime)]
    assert result["workRef"]["workspaceId"] == work_target.identity.workspace_id
    assert result["session"]["workConsoleId"] == envelope["consoleId"]
    assert requests[0]["input"]["bindingScope"] == "explicit-external-project"
    assert requests[0]["input"]["sourceWorkspaceId"] == envelope["workspaceId"]
    assert [request["operation"] for request in requests] == [
        "plan-native-bind-work",
        "bind-native-work",
    ]
