"""Qualification for the public-API Kungfu journal/asyncio bridge."""

from __future__ import annotations

import asyncio
import importlib.util
import pathlib
import threading

import pytest


_EVENT_LOOP = (
    pathlib.Path(__file__).resolve().parents[2]
    / "src/python/kungfu/runtime/live/event_loop.py"
)


def _load():
    spec = importlib.util.spec_from_file_location(
        "kungfu_event_loop_under_test", _EVENT_LOOP
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


event_loop = _load()
JournalAsyncioBridge = event_loop.JournalAsyncioBridge


class _NullLogger:
    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


class _Home:
    uid = 0x12345678
    uname = "test.bridge"


class _Reactor:
    def __init__(self) -> None:
        self._now = 0
        self.live = True
        self.home = _Home()
        self.steps = 0
        self.setup_calls = 0
        self.exit_calls = 0
        self.on_step = None

    def now(self):
        return self._now

    def step(self, num=0):
        self.steps += 1
        if self.on_step is not None:
            self.on_step(self.steps, num)

    def pre_setup(self):
        pass

    def setup(self):
        self.setup_calls += 1

    def on_exit(self):
        self.exit_calls += 1

    def get_home_uid(self):
        return self.home.uid

    def get_home_uname(self):
        return self.home.uname

    def get_begin_time(self):
        return 0

    def get_end_time(self):
        return 0


class _Context:
    logger = _NullLogger()


def _bridge():
    reactor = _Reactor()
    bridge = JournalAsyncioBridge(_Context(), reactor)
    return bridge, reactor


def test_bridge_is_not_an_event_loop_implementation():
    bridge, _reactor = _bridge()
    try:
        assert not isinstance(bridge, asyncio.AbstractEventLoop)
        assert bridge.loop.__class__.__module__.startswith("asyncio")
        assert event_loop.LiveEventLoop is JournalAsyncioBridge
    finally:
        bridge.close()


def test_journal_time_and_asyncio_monotonic_time_are_distinct():
    bridge, reactor = _bridge()
    try:
        monotonic_before = bridge.loop.time()
        reactor._now = 9_000_000_000_000
        assert bridge.journal_time_ns() == 9_000_000_000_000
        assert bridge.loop.time() >= monotonic_before
        assert bridge.loop.time() != bridge.journal_time_ns()
    finally:
        bridge.close()


def test_standard_tasks_futures_timeouts_and_cancellation():
    bridge, _reactor = _bridge()
    events = []

    async def qualify():
        future = bridge.create_future()
        bridge.call_soon(future.set_result, "future")
        events.append(await future)

        async with asyncio.timeout(0.05):
            await asyncio.sleep(0)
            events.append("timeout-context")

        pending = bridge.create_task(asyncio.sleep(60), name="cancel-me")
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        events.append("cancelled")

    try:
        bridge.loop.run_until_complete(qualify())
        assert events == ["future", "timeout-context", "cancelled"]
    finally:
        bridge.close()


def test_async_journal_callbacks_are_concurrent_and_tracked():
    bridge, _reactor = _bridge()
    entered = asyncio.Event()
    release = asyncio.Event()
    completed = []

    async def callback(tag):
        entered.set()
        await release.wait()
        completed.append(tag)

    async def qualify():
        bridge.submit_journal_callback(callback, "A")
        bridge.submit_journal_callback(callback, "B")
        await entered.wait()
        await asyncio.sleep(0)
        assert len(bridge._tasks) == 2
        release.set()
        await asyncio.gather(*tuple(bridge._tasks))

    try:
        bridge.loop.run_until_complete(qualify())
        assert sorted(completed) == ["A", "B"]
    finally:
        bridge.close()


def test_exact_due_timer_uses_standard_loop_clock():
    bridge, _reactor = _bridge()
    fired = []
    try:
        bridge.call_at(bridge.loop.time(), fired.append, "due")
        bridge.step()
        assert fired == ["due"]
    finally:
        bridge.close()


def test_threadsafe_journal_handoff_runs_on_loop_thread():
    bridge, _reactor = _bridge()
    loop_thread = threading.get_ident()
    observed = []

    def worker():
        bridge.submit_journal_callback(
            lambda: observed.append(threading.get_ident()), thread_safe=True
        )

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()
    try:
        bridge.loop.run_until_complete(asyncio.sleep(0))
        assert observed == [loop_thread]
    finally:
        bridge.close()


def test_run_preserves_reactor_lifecycle_and_propagates_task_failure():
    bridge, reactor = _bridge()

    async def fail():
        await asyncio.sleep(0)
        raise ValueError("journal callback failed")

    reactor.on_step = lambda steps, _num: (
        bridge.submit_journal_callback(fail) if steps == 1 else None
    )
    try:
        with pytest.raises(ValueError, match="journal callback failed"):
            bridge.run()
        assert reactor.setup_calls == 1
        assert reactor.exit_calls == 1
    finally:
        bridge.close()


def test_production_bridge_has_no_private_asyncio_scheduler_coupling():
    source = _EVENT_LOOP.read_text()
    for forbidden in (
        "asyncio.Handle(",
        "asyncio.TimerHandle(",
        "._scheduled",
        "._ready",
        "._when",
        "._run_once",
    ):
        assert forbidden not in source
