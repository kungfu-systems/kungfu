# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path
import sys
import types

import click
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

from kungfu import contract, diagnostics  # noqa: E402
from kungfu.cli.commands import kfc  # noqa: E402
from kungfu.cli.commands import health as health_cli  # noqa: E402  # registers command
from kungfu.cli import preflight as cli_preflight  # noqa: E402


def _runtime_ready():
    return {
        "product": {
            "availability": "available",
            "liveState": "inactive",
            "error": None,
        },
        "route": {"registered": False, "stale": False},
        "lifecycle": {"state": "stopped"},
        "supervisor": {"running": False, "identityVerified": False},
        "coordinator": {"running": False, "identityVerified": False},
    }


def _install_ready_facts(monkeypatch, *, runtime_dir_exists=True):
    monkeypatch.setattr(
        diagnostics.runtime_service, "route_status", lambda *_: _runtime_ready()
    )
    monkeypatch.setattr(
        diagnostics.peer_lifecycle,
        "list_status",
        lambda *_: {"items": []},
    )
    monkeypatch.setattr(
        diagnostics.storage_service,
        "status",
        lambda *_: {
            "ok": True,
            "provider": "content-addressed-file",
            "sources": [],
            "source_status": [],
        },
    )
    monkeypatch.setattr(
        diagnostics.storage_service,
        "episode_list",
        lambda *_args, **_kwargs: {"episodes": [], "unknown_record_count": 0},
    )


def _tree_fingerprint(root: Path):
    if not root.exists():
        return []
    return sorted(
        (
            str(path.relative_to(root)),
            path.stat().st_size if path.is_file() else None,
            path.read_bytes() if path.is_file() else None,
        )
        for path in root.rglob("*")
    )


def test_diagnostics_contract_is_registered_and_self_validating():
    value = contract.load_contract("diagnostics")

    assert value["schema"] == "kungfu.diagnostics.contract/v1"
    assert value["exitCodes"] == {
        "ready": 0,
        "degraded": 1,
        "action-required": 2,
        "blocked": 3,
    }
    assert "episode_writer_busy_timeout" in value["problemCatalog"]


def test_empty_workspace_is_ready_without_creating_runtime_state(tmp_path, monkeypatch):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    config_home = tmp_path / "config"
    monkeypatch.setattr(
        diagnostics.runtime_service, "route_status", lambda *_: _runtime_ready()
    )
    monkeypatch.setattr(
        diagnostics.peer_lifecycle,
        "list_status",
        lambda *_: {"items": []},
    )
    before = _tree_fingerprint(tmp_path)

    report = diagnostics.collect_health(
        str(home), str(runtime_dir), str(config_home), now_ns=10_000_000_000
    )

    assert report["status"] == "ready"
    assert report["exitCode"] == 0
    assert report["readOnly"] is True
    assert not runtime_dir.exists()
    assert _tree_fingerprint(tmp_path) == before
    diagnostics.validate_report(report)


def test_fast_mode_never_invokes_storage_fsck(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    _install_ready_facts(monkeypatch)
    monkeypatch.setattr(
        diagnostics.storage_service,
        "fsck",
        lambda *_: (_ for _ in ()).throw(AssertionError("fast mode called fsck")),
    )

    report = diagnostics.collect_health(
        str(tmp_path), str(runtime_dir), str(tmp_path / "config"), now_ns=1
    )

    assert report["mode"] == "fast"
    assert report["status"] == "ready"


def test_deep_mode_invokes_storage_fsck_and_validates_report(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    _install_ready_facts(monkeypatch)
    calls = []
    monkeypatch.setattr(
        diagnostics.storage_service,
        "fsck",
        lambda *_: (
            calls.append("fsck")
            or {"ok": True, "issues": [], "checked": {"episodes": 0}}
        ),
    )

    report = diagnostics.collect_health(
        str(tmp_path),
        str(runtime_dir),
        str(tmp_path / "config"),
        deep=True,
        now_ns=1,
    )

    assert calls == ["fsck"]
    assert report["mode"] == "deep"
    diagnostics.validate_report(report)


def test_deep_mode_translates_storage_issues(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    _install_ready_facts(monkeypatch)
    monkeypatch.setattr(
        diagnostics.storage_service,
        "fsck",
        lambda *_: {
            "ok": False,
            "issues": [
                {
                    "code": "projection_digest_mismatch",
                    "projection": "episodes",
                }
            ],
            "checked": {"episodes": 1},
        },
    )

    report = diagnostics.collect_health(
        str(tmp_path),
        str(runtime_dir),
        str(tmp_path / "config"),
        deep=True,
        now_ns=1,
    )

    issue = next(item for item in report["problems"] if item["area"] == "storage")
    assert report["status"] == "blocked"
    assert issue["sourceCode"] == "projection_digest_mismatch"
    assert issue["subject"]["projection"] == "episodes"
    diagnostics.validate_report(report)


def test_running_process_without_identity_fails_closed(tmp_path, monkeypatch):
    payload = _runtime_ready()
    payload["supervisor"] = {"running": True, "identityVerified": False}
    monkeypatch.setattr(diagnostics.runtime_service, "route_status", lambda *_: payload)
    monkeypatch.setattr(
        diagnostics.peer_lifecycle, "list_status", lambda *_: {"items": []}
    )

    report = diagnostics.collect_health(
        str(tmp_path), str(tmp_path / "missing"), str(tmp_path / "config")
    )

    assert report["status"] == "blocked"
    problem = report["problems"][0]
    assert problem["code"] == "runtime_identity_unverified"
    assert problem["retryable"] is False


def test_peer_problem_preserves_identity_and_action(tmp_path, monkeypatch):
    monkeypatch.setattr(
        diagnostics.runtime_service, "route_status", lambda *_: _runtime_ready()
    )
    monkeypatch.setattr(
        diagnostics.peer_lifecycle,
        "list_status",
        lambda *_: {
            "items": [
                {
                    "peerId": "agent-a",
                    "healthy": False,
                    "desiredState": "running",
                    "lifecycleState": "crash-loop",
                    "error": "fixture exit",
                }
            ]
        },
    )

    report = diagnostics.collect_health(
        str(tmp_path), str(tmp_path / "missing"), str(tmp_path / "config")
    )

    problem = next(item for item in report["problems"] if item["area"] == "peer")
    assert problem["code"] == "peer_crash_loop"
    assert problem["subject"]["peerId"] == "agent-a"
    assert "agent-a" in problem["actions"][0]["command"]


def test_stale_open_episode_offers_plan_but_never_executes(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    _install_ready_facts(monkeypatch)
    monkeypatch.setattr(
        diagnostics.storage_service,
        "episode_list",
        lambda *_args, **_kwargs: {
            "episodes": [
                {
                    "episode_id": 41,
                    "opened": True,
                    "closed": False,
                    "heartbeat_seen": False,
                    "update_time": 0,
                    "open_manifest_gen_time": 1_000_000_000,
                    "open": {"location_uid": 17, "begin_time": 1_000_000_000},
                }
            ],
            "unknown_record_count": 0,
        },
    )
    monkeypatch.setattr(
        diagnostics.episode_control,
        "inspect_episode_writer",
        lambda *_args, **_kwargs: {"active": False, "status": "absent"},
    )
    monkeypatch.setattr(
        diagnostics.episode_control,
        "execute_episode_recovery",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("health wrote recovery")
        ),
    )

    report = diagnostics.collect_health(
        str(tmp_path),
        str(runtime_dir),
        str(tmp_path / "config"),
        now_ns=1_000_000_000_000,
    )

    assert report["status"] == "action-required"
    problem = next(item for item in report["problems"] if item["area"] == "episode")
    assert problem["code"] == "episode_stale_recoverable"
    assert problem["actions"][0]["command"][-2:] == ["--plan", "--json"]
    assert "--execute" not in problem["actions"][0]["command"]


def test_unknown_episode_writer_is_blocked_not_retryable(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    _install_ready_facts(monkeypatch)
    monkeypatch.setattr(
        diagnostics.storage_service,
        "episode_list",
        lambda *_args, **_kwargs: {
            "episodes": [
                {
                    "episode_id": 42,
                    "opened": True,
                    "closed": False,
                    "open": {"location_uid": 18, "begin_time": 1},
                }
            ],
            "unknown_record_count": 0,
        },
    )
    monkeypatch.setattr(
        diagnostics.episode_control,
        "inspect_episode_writer",
        lambda *_args, **_kwargs: {"active": False, "status": "unknown"},
    )

    report = diagnostics.collect_health(
        str(tmp_path), str(runtime_dir), str(tmp_path / "config"), now_ns=10
    )

    problem = next(item for item in report["problems"] if item["area"] == "episode")
    assert report["status"] == "blocked"
    assert problem["code"] == "episode_writer_liveness_unknown"
    assert problem["retryable"] is False


def test_cli_json_and_exit_code_are_stable(tmp_path, monkeypatch):
    payload = {
        "schema": "kungfu.health-report/v1",
        "mode": "fast",
        "status": "action-required",
        "exitCode": 2,
        "readOnly": True,
        "generatedAt": "2026-07-16T00:00:00+00:00",
        "home": str(tmp_path),
        "runtimeDir": str(tmp_path / "runtime"),
        "checks": [],
        "problemCount": 0,
        "problems": [],
    }
    monkeypatch.setattr(
        health_cli.diagnostics, "collect_health", lambda *_args, **_kwargs: payload
    )
    monkeypatch.setattr(health_cli.diagnostics, "validate_report", lambda *_: None)

    result = CliRunner().invoke(kfc, ["--home", str(tmp_path), "health", "--json"])

    assert result.exit_code == 2
    assert json.loads(result.output)["status"] == "action-required"


def test_contract_translates_existing_episode_error_code():
    translated = diagnostics.problem(
        "episode_writer_busy_timeout",
        technical_detail="manifest_writer_busy fixture",
    )

    assert translated["sourceCode"] == "episode_writer_busy_timeout"
    assert translated["retryable"] is False
    assert "bounded retry window" in translated["message"]


def test_preflight_collects_only_declared_fast_areas(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    calls = []
    monkeypatch.setattr(
        diagnostics.storage_service,
        "status",
        lambda *_: (
            calls.append("storage")
            or {
                "ok": True,
                "provider": "content-addressed-file",
                "sources": [],
                "source_status": [],
            }
        ),
    )
    monkeypatch.setattr(
        diagnostics.storage_service,
        "fsck",
        lambda *_: (_ for _ in ()).throw(AssertionError("preflight called fsck")),
    )
    monkeypatch.setattr(
        diagnostics.runtime_service,
        "route_status",
        lambda *_: (_ for _ in ()).throw(
            AssertionError("irrelevant runtime collector ran")
        ),
    )
    monkeypatch.setattr(
        diagnostics.peer_lifecycle,
        "list_status",
        lambda *_: (_ for _ in ()).throw(AssertionError("irrelevant Peer ran")),
    )

    report = diagnostics.collect_preflight(
        str(tmp_path),
        str(runtime_dir),
        str(tmp_path / "config"),
        "episode-write",
    )

    assert calls == ["storage"]
    assert report["areas"] == ["storage"]
    assert report["mode"] == "fast"
    assert report["freshness"] == "command"
    assert report["cacheAllowed"] is False
    assert report["cached"] is False
    assert report["decision"] == "allow"
    diagnostics.validate_preflight(report)


def test_preflight_profile_maps_relevant_failure_to_block(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    monkeypatch.setattr(
        diagnostics.storage_service,
        "status",
        lambda *_: {
            "ok": False,
            "provider": "content-addressed-file",
            "sources": [],
            "source_status": [],
        },
    )

    report = diagnostics.collect_preflight(
        str(tmp_path),
        str(runtime_dir),
        str(tmp_path / "config"),
        "episode-write",
    )

    assert report["status"] == "action-required"
    assert report["decision"] == "block"
    assert report["problems"][0]["sourceCode"] == "storage_status_failed"


def test_ready_command_preflight_is_silent(tmp_path, monkeypatch, capsys):
    report = {
        "decision": "allow",
        "status": "ready",
        "problems": [],
    }
    monkeypatch.setattr(
        cli_preflight.diagnostics,
        "collect_preflight",
        lambda *_args, **_kwargs: report,
    )
    monkeypatch.setattr(
        cli_preflight.diagnostics, "validate_preflight", lambda *_: None
    )
    ctx = types.SimpleNamespace(
        home=str(tmp_path),
        runtime_dir=str(tmp_path / "runtime"),
        config_home=str(tmp_path / "config"),
    )

    assert cli_preflight.run_command_preflight(ctx, "episode-write") is report
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_blocked_command_preflight_reuses_actionable_problem(tmp_path, monkeypatch):
    item = diagnostics.problem("storage_status_failed", area="storage")
    report = {
        "decision": "block",
        "status": "action-required",
        "exitCode": 2,
        "problems": [item],
    }
    monkeypatch.setattr(
        cli_preflight.diagnostics,
        "collect_preflight",
        lambda *_args, **_kwargs: report,
    )
    monkeypatch.setattr(
        cli_preflight.diagnostics, "validate_preflight", lambda *_: None
    )
    ctx = types.SimpleNamespace(
        home=str(tmp_path),
        runtime_dir=str(tmp_path / "runtime"),
        config_home=str(tmp_path / "config"),
    )

    with pytest.raises(click.ClickException) as raised:
        cli_preflight.run_command_preflight(ctx, "episode-write")

    assert raised.value.exit_code == 2
    assert "storage_status_failed" in raised.value.format_message()
    assert "Next:" in raised.value.format_message()


def test_each_preflight_recollects_fresh_facts(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    calls = []
    monkeypatch.setattr(
        diagnostics.storage_service,
        "status",
        lambda *_: (
            calls.append("storage")
            or {
                "ok": True,
                "provider": "content-addressed-file",
                "sources": [],
                "source_status": [],
            }
        ),
    )

    for _ in range(2):
        diagnostics.collect_preflight(
            str(tmp_path),
            str(runtime_dir),
            str(tmp_path / "config"),
            "episode-write",
        )

    assert calls == ["storage", "storage"]


def test_episode_write_fence_still_rejects_after_preflight(
    tmp_path, monkeypatch, capsys
):
    from kungfu.cli.commands import storage as storage_cli

    order = []
    monkeypatch.setattr(
        storage_cli,
        "run_command_preflight",
        lambda *_: order.append("preflight"),
    )

    def reject_at_write():
        order.append("authoritative-fence")
        raise RuntimeError(
            "episode_writer_busy_timeout: episode_begin exhausted manifest_writer_busy"
        )

    class _Context:
        def exit(self, code):
            raise click.exceptions.Exit(code)

    with pytest.raises(click.exceptions.Exit) as raised:
        storage_cli._run_episode_write(
            _Context(), False, "episode_begin", reject_at_write
        )

    assert raised.value.exit_code == 1
    assert order == ["preflight", "authoritative-fence"]
    assert "episode_writer_busy_timeout" in capsys.readouterr().err
