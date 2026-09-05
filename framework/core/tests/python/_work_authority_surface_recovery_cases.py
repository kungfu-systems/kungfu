# SPDX-License-Identifier: Apache-2.0

from _work_authority_surface_support import *  # noqa: F401,F403

from _work_authority_surface_recovery_plan_cases import (
    _fresh_recovery_fixture,
)


def test_fresh_recovery_separates_retained_authority_from_target_profile(
    tmp_path, monkeypatch
):
    retained = tmp_path / "retained"
    retained.mkdir()
    (retained / "profile.json").write_text("{}", encoding="utf-8")
    target = tmp_path / "target"
    target.mkdir()
    retained_root = f"sha256:{'a' * 64}"
    target_root = f"sha256:{'b' * 64}"
    source_contract_root = f"sha256:{'c' * 64}"

    def lifecycle(_runtime, operation, **_values):
        assert operation == "get"
        return {
            "profile_suite_root": retained_root,
            "latest_event": {
                "closure": {"profile_path": str(retained / "profile.json")}
            },
        }

    def validate(source, _runtime):
        resolved = source.resolve()
        if resolved == retained.resolve():
            return {"inspection": {"profile_suite_root": retained_root}}
        assert resolved == target.resolve()
        return {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": target_root,
                "closure": {"source_contract": {"root": source_contract_root}},
            }
        }

    monkeypatch.setattr(
        assignment_fresh_recovery.storage_service, "profile_lifecycle", lifecycle
    )
    monkeypatch.setattr(
        assignment_fresh_recovery.profile_sdk, "validate_source", validate
    )

    assert assignment_fresh_recovery._retained_profile_source(tmp_path) == retained
    validated = assignment_fresh_recovery._validated_recovery_profile(target, tmp_path)
    assert validated["schema"] == "kungfu.work.planned-profile-source/v1"
    assert validated["profileId"] == "kungfu.work-control"
    assert validated["profileRoot"] == target_root
    assert validated["sourceContractRoot"] == source_contract_root
    assert validated["sourceLocator"] == str(target.resolve())
    assert validated["sourceRoot"] == assignment_fresh_recovery._root(
        {key: value for key, value in validated.items() if key != "sourceRoot"}
    )


def test_resume_prepare_reconciles_the_explicit_recovery_source(tmp_path, monkeypatch):
    source = tmp_path / "historical-work-control"
    source.mkdir()
    desired_root = f"sha256:{'d' * 64}"
    previous_root = f"sha256:{'e' * 64}"
    reconciled = []

    monkeypatch.setattr(
        assignment_command.profile_sdk,
        "validate_source",
        lambda actual, _runtime: (
            {
                "inspection": {
                    "profile": {"id": "kungfu.work-control"},
                    "profile_suite_root": desired_root,
                }
            }
            if actual == source.resolve()
            else (_ for _ in ()).throw(AssertionError("unexpected Profile source"))
        ),
    )

    def lifecycle(_runtime, operation, **_values):
        if operation == "list":
            return {
                "profiles": [
                    {
                        "profile_id": "kungfu.work-control",
                        "profile_suite_root": previous_root,
                        "removed": False,
                    }
                ]
            }
        assert operation == "get"
        return {
            "profile_suite_root": desired_root,
            "qualified": True,
            "activated": True,
        }

    monkeypatch.setattr(
        assignment_command.storage_service, "profile_lifecycle", lifecycle
    )
    monkeypatch.setattr(
        assignment_command.profile_lifecycle,
        "ensure_work_profile",
        lambda actual, runtime, actor: (
            reconciled.append((actual, runtime, actor)) or [{"status": "activated"}]
        ),
    )

    receipt = assignment_command._prepare_resume_profile(
        tmp_path / "runtime", "maintainer:test", source
    )

    assert reconciled == [(source.resolve(), tmp_path / "runtime", "maintainer:test")]
    assert receipt["previousProfileSuiteRoot"] == previous_root
    assert receipt["profileSuiteRoot"] == desired_root


def test_fresh_recovery_prepare_does_not_require_newer_profile_work_hooks(
    tmp_path, monkeypatch
):
    source = tmp_path / "historical-work-control"
    source.mkdir()
    desired_root = f"sha256:{'d' * 64}"
    reconciled = []

    monkeypatch.setattr(
        assignment_command.profile_sdk,
        "validate_source",
        lambda actual, _runtime: {
            "inspection": {
                "profile": {"id": "kungfu.work-control"},
                "profile_suite_root": desired_root,
            }
        },
    )

    def lifecycle(_runtime, operation, **_values):
        if operation == "list":
            return {"profiles": []}
        assert operation == "get"
        return {
            "profile_suite_root": desired_root,
            "qualified": True,
            "activated": True,
        }

    monkeypatch.setattr(
        assignment_command.storage_service, "profile_lifecycle", lifecycle
    )
    monkeypatch.setattr(
        assignment_command.profile_lifecycle,
        "ensure_profile_lifecycle",
        lambda actual, runtime, actor: (
            reconciled.append((actual, runtime, actor)) or [{"status": "activated"}]
        ),
    )
    monkeypatch.setattr(
        assignment_command.profile_lifecycle,
        "ensure_work_profile",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("fresh recovery must not invoke newer Profile Work hooks")
        ),
    )

    receipt = assignment_command.profile_lifecycle.prepare_fresh_recovery_profile(
        tmp_path / "runtime", "maintainer:test", source
    )

    assert reconciled == [(source.resolve(), tmp_path / "runtime", "maintainer:test")]
    assert receipt["profileSuiteRoot"] == desired_root
    assert receipt["profileContractMutation"] == "not-permitted"


def test_fresh_recovery_apply_uses_only_planned_authority_ports(tmp_path, monkeypatch):
    status, binding, plan = _fresh_recovery_fixture()
    plan["generatedAt"] = "2099-01-01T00:00:00Z"
    plan["expiresAt"] = "2099-01-01T00:10:00Z"
    plan["planRoot"] = assignment_fresh_recovery._root(
        {key: value for key, value in plan.items() if key != "planRoot"}
    )
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(plan), encoding="utf-8")
    observed = {}
    profile_source = Path(plan["plannedProfileSource"]["sourceLocator"])
    runtime_dir = tmp_path / "project" / ".kungfu" / "runtime"

    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_verify_planned_workspace",
        lambda *_args: (
            runtime_dir,
            {
                "workspaceId": plan["workspace"]["id"],
                "identityRoot": plan["workspace"]["identityRoot"],
                "runtimeRoot": str(runtime_dir),
                "available": True,
            },
        ),
    )
    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_verify_recovery_profile_source",
        lambda *_args: None,
    )
    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_observe_planned_console",
        lambda *_args: (
            dict(binding["session"]),
            {
                **binding["session"],
                "lifecycleState": "running",
                "live": True,
            },
        ),
    )
    monkeypatch.setattr(
        assignment_fresh_recovery,
        "_status_from_planned_source",
        lambda *_args: json.loads(json.dumps(status)),
    )

    def bind_planned_native_work(*args, **kwargs):
        observed["args"] = args
        observed.update(kwargs)
        return {
            "workRef": dict(plan["workRef"]),
            "session": dict(binding["session"]),
            "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
        }

    monkeypatch.setattr(
        assignment_fresh_recovery.planned_work_binding,
        "bind_planned_native_work",
        bind_planned_native_work,
    )

    def poison(*_args, **_kwargs):
        raise AssertionError("post-plan authority rediscovery")

    receipt = assignment_fresh_recovery._apply_from_ports(
        ctx=SimpleNamespace(runtime_dir=tmp_path / "console-runtime"),
        plan_file=plan_file,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        recovery_profile_source=profile_source,
        runtime=poison,
        status=poison,
        prepare_resume_profile=lambda *_args: {
            "status": "ready",
            "profileSuiteRoot": plan["workRef"]["profileRoot"],
        },
    )

    assert receipt["ok"] is True
    assert observed["args"] == (plan["plannedConsoleBinding"]["consoleRuntimeRoot"],)
    assert observed["work_ref"] == plan["workRef"]
    assert observed["session"] == binding["session"]
    assert observed["binding_scope"] == "same-project"
    assert observed["source_workspace_id"] == plan["workspace"]["id"]


def test_fresh_recovery_failure_keeps_public_executable_next_actions(
    tmp_path, monkeypatch
):
    emitted = []
    source = tmp_path / "missing-profile-source"
    failure = assignment_fresh_recovery.FreshRecoveryError(
        "WorkRef is unavailable",
        assignment_fresh_recovery._profile_recovery_actions(source),
    )
    monkeypatch.setattr(assignment_command, "_emit", emitted.append)

    with __import__("pytest").raises(__import__("click").exceptions.Exit):
        assignment_command._run(lambda: (_ for _ in ()).throw(failure))

    assert emitted[0]["ok"] is False
    assert emitted[0]["message"] == "WorkRef is unavailable"
    assert emitted[0]["next_actions"] == failure.next_actions
    assert emitted[0]["next_actions"][0]["command"] == [
        "kungfu",
        "profile",
        "history",
        "kungfu.work-control",
        "--json",
    ]
    assert emitted[0]["next_actions"][1]["command"] == [
        "kungfu",
        "profile",
        "validate",
        str(source),
        "--json",
    ]


def test_fresh_recovery_apply_preserves_complete_lifecycle_state():
    status, binding, plan = _fresh_recovery_fixture()
    events = []

    receipt = assignment_fresh_recovery.apply_plan(
        plan,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        status_reader=lambda: json.loads(json.dumps(status)),
        session_reader=lambda: dict(binding["session"]),
        prepare_profile=lambda actor: (
            events.append(("profile", actor))
            or {
                "status": "reconciled",
                "profileSuiteRoot": plan["workRef"]["profileRoot"],
            }
        ),
        bind_work=lambda expected: (
            events.append(("bind", expected))
            or {
                "workRef": dict(expected["workRef"]),
                "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
            }
        ),
        now="2026-08-25T09:01:00Z",
    )

    assert receipt["ok"] is True
    assert receipt["continuationMode"] == "resume/new-attempt"
    assert receipt["assignmentWrites"] == []
    assert receipt["preservation"]["phase"] == "completion-claimed"
    assert [event[0] for event in events] == ["profile", "bind"]


def test_fresh_recovery_ignores_profile_reader_work_semantics_projection():
    status, binding, plan = _fresh_recovery_fixture()
    projected = json.loads(json.dumps(status))
    projected["work_semantics"] = {
        "schema": "kungfu.work-semantics.status/v1",
        "phase": "completion-claimed",
        "next_actions": [{"action": "record-input-snapshot"}],
    }
    observations = iter(
        [
            projected,
            json.loads(json.dumps(status)),
            json.loads(json.dumps(status)),
        ]
    )

    receipt = assignment_fresh_recovery.apply_plan(
        plan,
        expected_plan_root=plan["planRoot"],
        authorized_by="maintainer:test",
        status_reader=lambda: next(observations),
        session_reader=lambda: dict(binding["session"]),
        prepare_profile=lambda _actor: {},
        bind_work=lambda expected: {
            "workRef": dict(expected["workRef"]),
            "receipt": {"receiptRoot": f"sha256:{'8' * 64}"},
        },
        now="2026-08-25T09:01:00Z",
    )

    assert receipt["ok"] is True
    assert receipt["assignmentWrites"] == []
    assert (
        receipt["preservation"]["beforeLifecycleStateRoot"]
        == plan["work"]["lifecycleStateRoot"]
    )


def test_fresh_recovery_fails_closed_on_attempt_plan_or_state_drift():
    status, binding, plan = _fresh_recovery_fixture()
    with __import__("pytest").raises(ValueError, match="new SessionAttempt"):
        assignment_fresh_recovery.build_plan(
            workspace=plan["workspace"],
            status=status,
            binding=binding,
            previous_attempt_id="native:new",
            expected_request_root=status["assignment"]["request_root"],
            expected_work_definition_root=status["assignment"]["work_definition_root"],
            expected_profile_root=plan["workRef"]["profileRoot"],
            recovery_profile=plan["recoveryProfile"],
            profile_active=True,
        )
    drifted = json.loads(json.dumps(status))
    drifted["completion_claim_count"] = 2
    with __import__("pytest").raises(ValueError, match="lifecycle state changed"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            authorized_by="maintainer:test",
            status_reader=lambda: drifted,
            session_reader=lambda: dict(binding["session"]),
            prepare_profile=lambda _actor: {},
            bind_work=lambda expected: {"workRef": dict(expected["workRef"])},
            now="2026-08-25T09:01:00Z",
        )
    forged = {**plan, "continuationMode": "first-attempt"}
    with __import__("pytest").raises(ValueError, match="root does not verify"):
        assignment_fresh_recovery.apply_plan(
            forged,
            expected_plan_root=plan["planRoot"],
            authorized_by="maintainer:test",
            status_reader=lambda: status,
            session_reader=lambda: dict(binding["session"]),
            prepare_profile=lambda _actor: {},
            bind_work=lambda expected: {"workRef": dict(expected["workRef"])},
            now="2026-08-25T09:01:00Z",
        )


def test_fresh_recovery_rejects_expiry_attempt_drift_and_unknown_effects():
    status, binding, plan = _fresh_recovery_fixture()
    mutations = []
    common = {
        "authorized_by": "maintainer:test",
        "status_reader": lambda: status,
        "prepare_profile": lambda _actor: mutations.append("profile") or {},
        "bind_work": lambda expected: (
            mutations.append("bind") or {"workRef": dict(expected["workRef"])}
        ),
    }
    with __import__("pytest").raises(ValueError, match="expired"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            session_reader=lambda: dict(binding["session"]),
            now="2026-08-25T09:11:00Z",
            **common,
        )
    with __import__("pytest").raises(ValueError, match="another current"):
        assignment_fresh_recovery.apply_plan(
            plan,
            expected_plan_root=plan["planRoot"],
            session_reader=lambda: {
                **binding["session"],
                "sessionAttemptId": "native:other",
            },
            now="2026-08-25T09:01:00Z",
            **common,
        )
    forged_body = {
        **{key: value for key, value in plan.items() if key != "planRoot"},
        "effects": [*plan["effects"], {"stage": "admit"}],
    }
    forged = {
        **forged_body,
        "planRoot": assignment_fresh_recovery._root(forged_body),
    }
    with __import__("pytest").raises(ValueError, match="effect sequence"):
        assignment_fresh_recovery.apply_plan(
            forged,
            expected_plan_root=forged["planRoot"],
            session_reader=lambda: dict(binding["session"]),
            now="2026-08-25T09:01:00Z",
            **common,
        )
    assert mutations == []
