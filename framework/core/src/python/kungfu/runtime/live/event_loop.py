# SPDX-License-Identifier: Apache-2.0

"""Public-API bridge between the Kungfu reactor and CPython asyncio.

The reactor remains authoritative for journal ordering and replay time.
``asyncio`` remains authoritative for live service scheduling and monotonic
timeouts.  This module coordinates the two; it does not implement an event
loop or reach into CPython's private scheduling state.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any, TypeVar


_T = TypeVar("_T")


class JournalAsyncioBridge:
    """Drive a Kungfu reactor alongside a standard CPython event loop.

    A bridge owns a normal loop created by :func:`asyncio.new_event_loop`
    unless one is supplied.  Reactor callbacks enter that loop through
    ``call_soon`` or ``call_soon_threadsafe``.  Asyncio time never substitutes
    for journal time: callers that need an event timestamp use
    :meth:`journal_time_ns`.
    """

    def __init__(
        self,
        ctx: Any,
        reactor: Any,
        *,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._ctx = ctx
        self._reactor = reactor
        self._loop = loop or asyncio.new_event_loop()
        self._owns_loop = loop is None
        self._stop_requested = False
        self._failure: BaseException | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self.home = self._reactor.home

    @property
    def loop(self) -> asyncio.AbstractEventLoop:
        """The standard event loop used for live-service scheduling."""

        return self._loop

    def journal_time_ns(self) -> int:
        """Return reactor time without changing asyncio's monotonic clock."""

        return int(self._reactor.now())

    def get_home_uid(self) -> int:
        return int(self._reactor.get_home_uid())

    def get_home_uname(self) -> str:
        return str(self._reactor.get_home_uname())

    def get_begin_time(self) -> int:
        return int(self._reactor.get_begin_time())

    def get_end_time(self) -> int:
        return int(self._reactor.get_end_time())

    def pre_setup(self) -> None:
        self._reactor.pre_setup()

    def setup(self) -> None:
        self._reactor.setup()

    def on_exit(self) -> None:
        self._reactor.on_exit()

    def is_live(self) -> bool:
        return bool(self._reactor.live) and not self._stop_requested

    def is_running(self) -> bool:
        return self._loop.is_running()

    def is_closed(self) -> bool:
        return self._loop.is_closed()

    def stop(self) -> None:
        self._stop_requested = True

    def call_soon(
        self,
        callback: Callable[..., Any],
        *args: Any,
        context: Any = None,
    ) -> asyncio.Handle:
        return self._loop.call_soon(callback, *args, context=context)

    def call_soon_threadsafe(
        self, callback: Callable[..., Any], *args: Any, context: Any = None
    ) -> asyncio.Handle:
        return self._loop.call_soon_threadsafe(callback, *args, context=context)

    def call_later(
        self,
        delay: float,
        callback: Callable[..., Any],
        *args: Any,
        context: Any = None,
    ) -> asyncio.TimerHandle:
        return self._loop.call_later(delay, callback, *args, context=context)

    def call_at(
        self,
        when: float,
        callback: Callable[..., Any],
        *args: Any,
        context: Any = None,
    ) -> asyncio.TimerHandle:
        return self._loop.call_at(when, callback, *args, context=context)

    def create_future(self) -> asyncio.Future[Any]:
        return self._loop.create_future()

    def create_task(
        self,
        coro: Coroutine[Any, Any, _T],
        *,
        name: str | None = None,
        context: Any = None,
    ) -> asyncio.Task[_T]:
        task = self._loop.create_task(coro, name=name, context=context)
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def submit_journal_callback(
        self,
        callback: Callable[..., Any],
        *args: Any,
        thread_safe: bool = False,
    ) -> asyncio.Handle:
        """Schedule one journal callback on the asyncio thread.

        If the callback returns an awaitable, it becomes a tracked task whose
        failure stops the bridge and is re-raised by :meth:`run`.
        """

        scheduler = (
            self._loop.call_soon_threadsafe if thread_safe else self._loop.call_soon
        )
        return scheduler(self._dispatch_callback, callback, args)

    def _dispatch_callback(
        self, callback: Callable[..., Any], args: tuple[Any, ...]
    ) -> None:
        try:
            result = callback(*args)
            if inspect.isawaitable(result):
                self.create_task(self._await_result(result))
        except BaseException as error:
            self._failure = error
            self.stop()

    @staticmethod
    async def _await_result(awaitable: Awaitable[Any]) -> Any:
        return await awaitable

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._failure = error
            self.stop()

    async def pump(self, step_limit: int = 0) -> None:
        """Pump reactor steps while the standard loop schedules live work."""

        self.setup()
        try:
            while self.is_live():
                self._reactor.step(step_limit)
                await asyncio.sleep(0)
                if self._failure is not None:
                    raise self._failure
        finally:
            self.on_exit()

    def step(self, num: int = 0) -> None:
        """Run one reactor step and one public asyncio scheduling checkpoint."""

        if self._loop.is_running():
            raise RuntimeError("step() cannot run while the asyncio loop is running")
        self._reactor.step(num)
        self._loop.run_until_complete(asyncio.sleep(0))
        if self._failure is not None:
            raise self._failure

    def run(self, step_limit: int = 0) -> None:
        """Run until the reactor stops, then cancel and drain live tasks."""

        if self._loop.is_running():
            raise RuntimeError("run() cannot nest inside a running asyncio loop")
        self._stop_requested = False
        self._ctx.logger.info(
            "[%08x] %s running", self._reactor.home.uid, self._reactor.home.uname
        )
        try:
            previous = asyncio.get_running_loop()
        except RuntimeError:
            previous = None
        asyncio.set_event_loop(self._loop)
        try:
            try:
                self._loop.run_until_complete(self.pump(step_limit))
            finally:
                self._loop.run_until_complete(self._shutdown_tasks())
            if self._failure is not None:
                raise self._failure
        finally:
            asyncio.set_event_loop(previous)
            self._ctx.logger.info(
                "[%08x] %s done", self._reactor.home.uid, self._reactor.home.uname
            )

    async def _shutdown_tasks(self) -> None:
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._loop.shutdown_asyncgens()
        if self._owns_loop:
            await self._loop.shutdown_default_executor()

    def close(self) -> None:
        if self._loop.is_running():
            raise RuntimeError("cannot close a running asyncio loop")
        if self._owns_loop and not self._loop.is_closed():
            self._loop.close()


# Compatibility name for source consumers. It is a bridge, not an
# asyncio.AbstractEventLoop. The runtime contract removes this alias after the
# first stable v4 Python KFX SDK line has no recorded imports.
LiveEventLoop = JournalAsyncioBridge


__all__ = ["JournalAsyncioBridge", "LiveEventLoop"]
