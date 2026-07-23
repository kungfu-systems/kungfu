# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path
import sys
import types

from click.testing import CliRunner
import pytest


class _FakeCoordinator:
    pass


def _install_fake_pykungfu():
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.yijinjing = types.SimpleNamespace(
        enums=types.SimpleNamespace(
            mode=types.SimpleNamespace(LIVE="LIVE", BACKTEST="BACKTEST"),
            location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
        )
    )
    runtime = types.ModuleType("pykungfu.runtime")
    runtime.coordinator = _FakeCoordinator
    fake.runtime = runtime
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", runtime)


_install_fake_pykungfu()

import kungfu  # noqa: E402

kungfu._build_info = {"version": "test"}

from kungfu import contract, diagnostics, recovery  # noqa: E402
from kungfu.cli.commands import kfc  # noqa: E402
from kungfu.cli.commands import recover as recover_cli  # noqa: E402  # register


def _health(status="ready", problems=None):
    problems = list(problems or [])
    return {
        "schema": diagnostics.REPORT_SCHEMA,
        "mode": "deep",
        "status": status,
        "exitCode": diagnostics.exit_code(status),
        "readOnly": True,
        "generatedAt": "2026-07-17T00:00:00+00:00",
        "home": "/tmp/home",
        "runtimeDir": "/tmp/home/runtime",
        "checks": [],
        "problemCount": len(problems),
        "problems": problems,
    }


def _problem(code, area, impact, *, subject=None, action_required=True):
    return {
        "schema": diagnostics.PROBLEM_SCHEMA,
        "code": code,
        "sourceCode": code,
        "area": area,
        "severity": "error",
        "statusImpact": impact,
        "summary": code,
        "message": code,
        "retryable": False,
        "actionRequired": action_required,
        "technicalDetail": None,
        "subject": dict(subject or {}),
        "actions": [],
    }


def _runtime_status():
    return {
        "route": {"routeId": "fixture", "runtimeGeneration": "7"},
        "supervisor": {"pid": None, "startIdentity": None},
        "coordinator": {"pid": None, "startIdentity": None},
    }


@pytest.fixture(autouse=True)
def _skip_nested_health_validation(monkeypatch):
    monkeypatch.setattr(recovery.diagnostics, "validate_report", lambda *_: None)


def test_recovery_contract_is_registered_and_self_validating():
    value = contract.load_contract("diagnostics")

    assert value["version"] == 2
    assert value["recoveryClassifications"] == [
        "automatic-safe",
        "confirmation-required",
        "manual-blocked",
    ]
    assert value["recoveryActions"]["episode.abort-stale"]["authority"] == (
        "EpisodeRecoveryPlanner"
    )


def test_ready_plan_is_stable_and_valid(tmp_path, monkeypatch):
    monkeypatch.setattr(
        recovery.diagnostics,
        "collect_health",
        lambda *_args, **_kwargs: _health(),
    )

    first = recovery.plan_recovery(
        str(tmp_path), str(tmp_path / "runtime"), str(tmp_path / "config")
    )
    second = recovery.plan_recovery(
        str(tmp_path), str(tmp_path / "runtime"), str(tmp_path / "config")
    )

    assert first["status"] == "ready"
    assert first["readOnly"] is True
    assert first["actions"] == []
    assert first["planId"] == second["planId"]
    recovery.validate_plan(first)


def test_unknown_authority_is_manual_blocked(tmp_path, monkeypatch):
    item = _problem("runtime_identity_unverified", "runtime", "blocked")
    monkeypatch.setattr(
        recovery.diagnostics,
        "collect_health",
        lambda *_args, **_kwargs: _health("blocked", [item]),
    )

    plan = recovery.plan_recovery(
        str(tmp_path), str(tmp_path / "runtime"), str(tmp_path / "config")
    )

    assert plan["status"] == "blocked"
    assert plan["summary"]["manual-blocked"] == 1
    assert plan["actions"][0]["operation"] == "manual-review"
    assert plan["actions"][0]["executable"] is False
    recovery.validate_plan(plan)


def test_unknown_projection_is_never_rebuilt_automatically(tmp_path, monkeypatch):
    item = _problem(
        "projection_drift",
        "storage",
        "degraded",
        subject={"projection": "future-authority"},
        action_required=False,
    )
    monkeypatch.setattr(
        recovery.diagnostics,
        "collect_health",
        lambda *_args, **_kwargs: _health("degraded", [item]),
    )

    plan = recovery.plan_recovery(
        str(tmp_path), str(tmp_path / "runtime"), str(tmp_path / "config")
    )

    assert plan["status"] == "blocked"
    assert plan["actions"][0]["operation"] == "manual-review"
    assert plan["actions"][0]["executable"] is False


def test_runtime_recovery_executes_exact_plan_and_postflights(tmp_path, monkeypatch):
    item = _problem(
        "runtime_route_stale",
        "runtime",
        "degraded",
        action_required=False,
    )
    recoverable = _health("degraded", [item])
    ready = _health()
    monkeypatch.setattr(
        recovery.diagnostics,
        "collect_health",
        lambda *_args, **_kwargs: recoverable,
    )
    monkeypatch.setattr(
        recovery.runtime_service, "route_status", lambda *_: _runtime_status()
    )
    plan = recovery.plan_recovery(
        str(tmp_path), str(tmp_path / "runtime"), str(tmp_path / "config")
    )
    reports = iter([recoverable, ready])
    monkeypatch.setattr(
        recovery.diagnostics,
        "collect_health",
        lambda *_args, **_kwargs: next(reports),
    )
    calls = []
    monkeypatch.setattr(
        recovery.runtime_service,
        "ensure_coordinator",
        lambda *args: calls.append(args) or {"changed": True, "schema": "fixture"},
    )

    receipt = recovery.execute_recovery(
        str(tmp_path),
        str(tmp_path / "runtime"),
        str(tmp_path / "config"),
        log_level="warning",
        expected_plan_id=plan["planId"],
    )

    assert len(calls) == 1
    assert receipt["ok"] is True
    assert receipt["status"] == "succeeded"
    assert receipt["actions"][0]["status"] == "succeeded"
    assert receipt["postflight"]["status"] == "ready"
    recovery.validate_receipt(receipt)


def test_confirmation_is_checked_before_any_peer_write(tmp_path, monkeypatch):
    item = _problem(
        "peer_orphaned",
        "peer",
        "action-required",
        subject={"peerId": "agent-a"},
    )
    report = _health("action-required", [item])
    status = {
        "lifecycleState": "orphaned",
        "host": {"generation": 7},
        "peer": {"generation": 11},
    }
    spec = {"peerId": "agent-a"}
    monkeypatch.setattr(
        recovery.diagnostics, "collect_health", lambda *_args, **_kwargs: report
    )
    monkeypatch.setattr(recovery.peer_lifecycle, "status", lambda *_: status)
    monkeypatch.setattr(recovery.peer_lifecycle, "spec_path", lambda *_: Path("spec"))
    monkeypatch.setattr(recovery.peer_lifecycle, "load_spec", lambda *_: spec)
    monkeypatch.setattr(
        recovery.peer_lifecycle,
        "plan",
        lambda *_: {"planId": "sha256:" + "a" * 64},
    )
    calls = []
    monkeypatch.setattr(
        recovery.peer_lifecycle,
        "ensure",
        lambda *_args, **_kwargs: calls.append("ensure") or {},
    )
    plan = recovery.plan_recovery(
        str(tmp_path), str(tmp_path / "runtime"), str(tmp_path / "config")
    )

    with pytest.raises(recovery.RecoveryError) as raised:
        recovery.execute_recovery(
            str(tmp_path),
            str(tmp_path / "runtime"),
            str(tmp_path / "config"),
            log_level="warning",
            expected_plan_id=plan["planId"],
        )

    assert raised.value.code == "recovery_confirmation_required"
    assert calls == []


def test_stale_plan_is_rejected_before_runtime_write(tmp_path, monkeypatch):
    item = _problem(
        "runtime_route_stale",
        "runtime",
        "degraded",
        action_required=False,
    )
    monkeypatch.setattr(
        recovery.diagnostics,
        "collect_health",
        lambda *_args, **_kwargs: _health("degraded", [item]),
    )
    monkeypatch.setattr(
        recovery.runtime_service, "route_status", lambda *_: _runtime_status()
    )
    calls = []
    monkeypatch.setattr(
        recovery.runtime_service,
        "ensure_coordinator",
        lambda *_args: calls.append("ensure") or {},
    )

    with pytest.raises(recovery.RecoveryError) as raised:
        recovery.execute_recovery(
            str(tmp_path),
            str(tmp_path / "runtime"),
            str(tmp_path / "config"),
            log_level="warning",
            expected_plan_id="sha256:" + "0" * 64,
        )

    assert raised.value.code == "recovery_plan_stale"
    assert calls == []


def test_cli_plan_does_not_initialize_first_use_runtime(tmp_path, monkeypatch):
    home = tmp_path / "home"
    payload = {
        "schema": recovery.PLAN_SCHEMA,
        "planId": "sha256:" + "1" * 64,
        "status": "ready",
        "readOnly": True,
        "generatedAt": "2026-07-17T00:00:00+00:00",
        "home": str(home),
        "runtimeDir": str(home / "runtime"),
        "healthStatus": "ready",
        "healthExitCode": 0,
        "summary": {
            "automatic-safe": 0,
            "confirmation-required": 0,
            "manual-blocked": 0,
        },
        "actions": [],
        "health": {},
    }
    monkeypatch.setattr(
        recover_cli.recovery,
        "plan_recovery",
        lambda *_args, **_kwargs: payload,
    )
    monkeypatch.setattr(recover_cli.recovery, "validate_plan", lambda *_: None)

    result = CliRunner().invoke(kfc, ["--home", str(home), "recover", "--json"])

    assert result.exit_code == 0
    assert json.loads(result.output)["status"] == "ready"
    assert not (home / "runtime").exists()
