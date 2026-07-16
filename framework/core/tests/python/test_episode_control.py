# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from contextlib import contextmanager
import signal
from types import SimpleNamespace

import pytest

from kungfu.rewind import managed_cli
from kungfu.storage import episode_control
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle


class _FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


def _open_episode(*, location_uid: int = 17, begin_time: int = 1_000_000_000):
    return {
        "ok": True,
        "episode": {
            "episode_id": 41,
            "opened": True,
            "closed": False,
            "close_count": 0,
            "heartbeat_seen": False,
            "update_time": 0,
            "open_manifest_gen_time": begin_time,
            "open": {
                "episode_id": 41,
                "location_uid": location_uid,
                "begin_time": begin_time,
            },
            "records": [{"manifest_frame_uid": 101}],
        },
    }


def test_retry_absorbs_only_manifest_writer_busy():
    clock = _FakeClock()
    calls = 0

    def action():
        nonlocal calls
        calls += 1
        if calls < 3:
            raise RuntimeError("manifest_writer_busy: held by fixture")
        return {"ok": True}

    result, receipt = episode_control.retry_episode_write(
        "episode_begin",
        action,
        policy=episode_control.EpisodeWriteRetryPolicy(
            timeout_seconds=1,
            initial_delay_seconds=0.01,
            max_delay_seconds=0.02,
            jitter_ratio=0,
        ),
        clock=clock.now,
        sleep=clock.sleep,
        random_value=lambda: 0.5,
    )

    assert result == {"ok": True}
    assert receipt["attempts"] == 3
    assert receipt["busyRetries"] == 2
    assert receipt["elapsedMs"] == 30


def test_retry_never_replays_unknown_or_non_busy_failures():
    calls = 0

    def action():
        nonlocal calls
        calls += 1
        raise RuntimeError("storage_io_error: append outcome unknown")

    with pytest.raises(RuntimeError, match="append outcome unknown"):
        episode_control.retry_episode_write("episode_end", action)
    assert calls == 1


def test_retry_exhaustion_is_machine_readable():
    clock = _FakeClock()

    with pytest.raises(episode_control.EpisodeWriterBusyError) as raised:
        episode_control.retry_episode_write(
            "episode_abort",
            lambda: (_ for _ in ()).throw(
                RuntimeError("manifest_writer_busy: held by fixture")
            ),
            policy=episode_control.EpisodeWriteRetryPolicy(
                timeout_seconds=0.05,
                initial_delay_seconds=0.02,
                max_delay_seconds=0.02,
                jitter_ratio=0,
            ),
            clock=clock.now,
            sleep=clock.sleep,
            random_value=lambda: 0.5,
        )

    assert raised.value.to_dict()["code"] == "episode_writer_busy_timeout"
    assert raised.value.to_dict()["exhausted"] is True


def test_recovery_plan_requires_stale_inactive_owned_location(tmp_path, monkeypatch):
    monkeypatch.setattr(
        episode_control.service,
        "episode_inspect",
        lambda *_args, **_kwargs: _open_episode(),
    )

    eligible = episode_control.plan_episode_recovery(
        tmp_path,
        episode_id=41,
        stale_after_seconds=5,
        now_ns=10_000_000_000,
    )
    assert eligible["eligible"] is True
    assert eligible["writer"]["status"] == "absent"

    evidence_path = tmp_path / "ownership" / "writers" / "00000011.00000000.lock"
    evidence_path.parent.mkdir(parents=True)
    evidence_path.write_text("owned", encoding="utf-8")
    monkeypatch.setattr(
        episode_control.yjj,
        "inspect_active_stream_writer",
        lambda *_args: {"ownerPid": 99, "owned": True},
        raising=False,
    )
    active = episode_control.plan_episode_recovery(
        tmp_path,
        episode_id=41,
        stale_after_seconds=5,
        now_ns=10_000_000_000,
    )
    assert active["eligible"] is False
    assert [item["code"] for item in active["blockers"]] == ["episode_writer_active"]


def test_native_writer_inspection_reports_the_live_lease(tmp_path):
    resource_id = "00000011.00000000"
    lease = episode_control.yjj.durability_writer_lease(str(tmp_path), resource_id)

    evidence = dict(
        episode_control.yjj.inspect_active_stream_writer(str(tmp_path), resource_id)
    )

    assert evidence["owned"] is True
    assert evidence["resourceId"] == resource_id
    assert evidence["generation"] == lease.status["generation"]


def test_recovery_execute_fences_writer_and_revalidates(tmp_path, monkeypatch):
    monkeypatch.setattr(
        episode_control.service,
        "episode_inspect",
        lambda *_args, **_kwargs: _open_episode(),
    )
    recovery_calls = []
    monkeypatch.setattr(
        episode_control.service,
        "episode_recover",
        lambda *args, **kwargs: (
            recovery_calls.append((args, kwargs))
            or {
                "recovered": [
                    {"close": {"episode_id": 41, "status": 3}, "content_root": {}}
                ],
                "skipped_open": [],
            }
        ),
    )

    class FakeLease:
        def __init__(self, data_root, resource_id):
            self.status = {
                "dataRoot": data_root,
                "resourceId": resource_id,
                "generation": 2,
                "owned": True,
            }

    monkeypatch.setattr(episode_control.yjj, "durability_writer_lease", FakeLease)

    receipt = episode_control.execute_episode_recovery(
        tmp_path,
        episode_id=41,
        stale_after_seconds=5,
        now_ns=10_000_000_000,
        reason="fixture recovery",
    )

    assert receipt["ok"] is True
    assert receipt["fence"]["resourceId"] == "00000011.00000000"
    assert recovery_calls[0][1]["location_uid"] == 17
    assert recovery_calls[0][1]["reason"] == "fixture recovery"
    assert recovery_calls[0][1]["expected_manifest_frame_uid"] == 101


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
        lambda *_args, **_kwargs: {"episode_id": 41},
    )
    monkeypatch.setattr(
        episode_lifecycle.service,
        "episode_abort",
        lambda *_args, **kwargs: aborts.append(kwargs) or {"ok": True},
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
        lambda *_args, **_kwargs: {"episode_id": 41},
    )
    monkeypatch.setattr(
        episode_lifecycle.service,
        "episode_abort",
        lambda *_args, **kwargs: aborts.append(kwargs) or {"ok": True},
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
