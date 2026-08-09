# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from contextlib import contextmanager
import signal
from types import SimpleNamespace

import pytest

from kungfu.rewind import managed_cli
from kungfu.storage import episode_control
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle


def _native_write(**result):
    return {
        **result,
        "write_retry": {
            "schema": "kungfu.episode.write-retry/v1",
            "operation": "fixture",
            "attempts": 1,
            "busyRetries": 0,
            "elapsedMs": 0,
            "exhausted": False,
        },
    }


def test_retry_adapter_consumes_native_receipt_without_replaying():
    calls = 0
    native_receipt = {
        "schema": "kungfu.episode.write-retry/v1",
        "operation": "episode_begin",
        "attempts": 3,
        "busyRetries": 2,
        "elapsedMs": 30,
        "exhausted": False,
    }

    def action():
        nonlocal calls
        calls += 1
        return {"ok": True, "write_retry": native_receipt}

    result, receipt = episode_control.retry_episode_write("episode_begin", action)

    assert calls == 1
    assert result["ok"] is True
    assert receipt == native_receipt


def test_retry_never_replays_unknown_or_non_busy_failures():
    calls = 0

    def action():
        nonlocal calls
        calls += 1
        raise RuntimeError("storage_io_error: append outcome unknown")

    with pytest.raises(RuntimeError, match="append outcome unknown"):
        episode_control.retry_episode_write("episode_end", action)
    assert calls == 1


def test_retry_policy_projects_to_native_milliseconds():
    policy = episode_control.EpisodeWriteRetryPolicy(
        timeout_seconds=0.05,
        initial_delay_seconds=0.02,
        max_delay_seconds=0.03,
        jitter_ratio=0.1,
    )

    assert policy.to_native_options() == {
        "timeout_ms": 50,
        "initial_delay_ms": 20,
        "max_delay_ms": 30,
        "jitter_ratio": 0.1,
    }


def test_recovery_plan_delegates_to_native_service(tmp_path, monkeypatch):
    calls = []
    native_plan = {
        "schema": "kungfu.episode.recovery-plan/v1",
        "eligible": True,
        "planId": "sha256:native",
    }
    monkeypatch.setattr(
        episode_control.service,
        "episode_recovery_plan",
        lambda *args, **kwargs: calls.append((args, kwargs)) or native_plan,
    )

    result = episode_control.plan_episode_recovery(
        tmp_path,
        episode_id=41,
        location_uid=17,
        stale_after_seconds=5,
        now_ns=10_000_000_000,
    )

    assert result == native_plan
    assert calls == [
        (
            (tmp_path,),
            {
                "episode_id": 41,
                "location_uid": 17,
                "stale_after_seconds": 5,
                "now_ns": 10_000_000_000,
            },
        )
    ]


def test_native_writer_inspection_reports_the_live_lease(tmp_path):
    resource_id = "00000011.00000000"
    lease = episode_control.yjj.durability_writer_lease(str(tmp_path), resource_id)

    evidence = dict(
        episode_control.yjj.inspect_active_stream_writer(str(tmp_path), resource_id)
    )

    assert evidence["owned"] is True
    assert evidence["resourceId"] == resource_id
    assert evidence["generation"] == lease.status["generation"]


def test_recovery_execute_delegates_to_native_service(tmp_path, monkeypatch):
    calls = []
    native_receipt = {
        "schema": "kungfu.episode.recovery-receipt/v1",
        "ok": True,
        "fence": {"resourceId": "00000011.00000000"},
    }
    monkeypatch.setattr(
        episode_control.service,
        "episode_recovery_execute",
        lambda *args, **kwargs: calls.append((args, kwargs)) or native_receipt,
    )

    receipt = episode_control.execute_episode_recovery(
        tmp_path,
        episode_id=41,
        location_uid=17,
        stale_after_seconds=5,
        now_ns=10_000_000_000,
        reason="fixture recovery",
    )

    assert receipt == native_receipt
    assert calls[0][1]["location_uid"] == 17
    assert calls[0][1]["reason"] == "fixture recovery"


def test_recovery_execute_preserves_native_error_shape(tmp_path, monkeypatch):
    monkeypatch.setattr(
        episode_control.service,
        "episode_recovery_execute",
        lambda *_args, **_kwargs: {
            "schema": "kungfu.episode.recovery-receipt/v1",
            "ok": False,
            "error": {
                "code": "episode_recovery_state_changed",
                "message": "Episode facts changed after planning; generate a new plan",
            },
            "plan": {"planId": "sha256:native"},
        },
    )

    with pytest.raises(
        episode_control.EpisodeRecoveryError,
        match="Episode facts changed after planning",
    ) as raised:
        episode_control.execute_episode_recovery(
            tmp_path,
            episode_id=41,
            stale_after_seconds=5,
            now_ns=10_000_000_000,
        )

    assert raised.value.code == "episode_recovery_state_changed"
    assert raised.value.plan == {"planId": "sha256:native"}


def test_lifecycle_guard_aborts_keyboard_interrupt(tmp_path, monkeypatch):
    from kungfu.storage import episode_lifecycle

    aborts = []
    monkeypatch.setattr(episode_lifecycle, "_location_uid", lambda *_args: 17)
    monkeypatch.setattr(
        episode_lifecycle.yjj,
        "action_recorder",
        lambda *_args: SimpleNamespace(last_frame_uid=0),
    )
    monkeypatch.setattr(
        episode_lifecycle.service,
        "episode_begin",
        lambda *_args, **_kwargs: _native_write(episode_id=41),
    )
    monkeypatch.setattr(
        episode_lifecycle.service,
        "episode_abort",
        lambda *_args, **kwargs: aborts.append(kwargs) or _native_write(ok=True),
    )

    lifecycle = RuntimeEpisodeLifecycle(
        runtime_dir=str(tmp_path),
        namespace="test",
        name="interrupt",
        title="interrupt",
        actor="pytest",
        source="fixture",
    )
    with pytest.raises(KeyboardInterrupt):
        with lifecycle.guard():
            raise KeyboardInterrupt

    assert lifecycle.closed is True
    assert len(aborts) == 1
    assert aborts[0]["reason"] == "episode scope interrupted: KeyboardInterrupt"


def test_lifecycle_guard_aborts_sigterm(tmp_path, monkeypatch):
    from kungfu.storage import episode_lifecycle

    aborts = []
    monkeypatch.setattr(episode_lifecycle, "_location_uid", lambda *_args: 17)
    monkeypatch.setattr(
        episode_lifecycle.yjj,
        "action_recorder",
        lambda *_args: SimpleNamespace(last_frame_uid=0),
    )
    monkeypatch.setattr(
        episode_lifecycle.service,
        "episode_begin",
        lambda *_args, **_kwargs: _native_write(episode_id=41),
    )
    monkeypatch.setattr(
        episode_lifecycle.service,
        "episode_abort",
        lambda *_args, **kwargs: aborts.append(kwargs) or _native_write(ok=True),
    )

    lifecycle = RuntimeEpisodeLifecycle(
        runtime_dir=str(tmp_path),
        namespace="test",
        name="sigterm",
        title="sigterm",
        actor="pytest",
        source="fixture",
    )
    with pytest.raises(SystemExit, match=str(128 + signal.SIGTERM)):
        with lifecycle.guard():
            handler = signal.getsignal(signal.SIGTERM)
            assert callable(handler)
            handler(signal.SIGTERM, None)

    assert lifecycle.closed is True
    assert len(aborts) == 1
    assert aborts[0]["reason"] == f"terminated by signal {signal.SIGTERM}"


def test_managed_run_postprocessing_failure_is_inside_episode_guard(
    tmp_path, monkeypatch
):
    state = {"aborted": False}

    class FakeEpisode:
        def __init__(self, **_kwargs):
            self.episode_id = 41

        def record_event(self, *_args, **_kwargs):
            return None

        def attach_payload_ref(self, *_args, **_kwargs):
            return None

        def close(self, **_kwargs):
            return None

        @contextmanager
        def guard(self):
            try:
                yield self
            except BaseException:
                state["aborted"] = True
                raise

    monkeypatch.setattr(managed_cli, "RuntimeEpisodeLifecycle", FakeEpisode)
    monkeypatch.setattr(
        managed_cli,
        "discover_provider",
        lambda _provider: SimpleNamespace(
            found=True,
            path="/fixture/provider",
            path_class="fixture",
            version="1",
            error=None,
        ),
    )
    monkeypatch.setattr(
        managed_cli.managed_run,
        "run_managed",
        lambda *_args, **_kwargs: SimpleNamespace(
            exit_code=0,
            response_text="ok",
            response_body=None,
            response_error=None,
            snapshot=None,
            emitted=False,
        ),
    )
    monkeypatch.setattr(
        managed_cli.bundle,
        "emit",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("bundle failed")),
    )

    with pytest.raises(RuntimeError, match="bundle failed"):
        managed_cli.run_and_report(
            "fixture",
            "prompt",
            runtime_dir=str(tmp_path),
            run_id="postprocess",
            quiet=True,
            skill_context=False,
        )
    assert state["aborted"] is True
