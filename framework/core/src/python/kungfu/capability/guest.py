#  SPDX-License-Identifier: Apache-2.0
#
# Python port of the guest half of framework/api/src/capability/sandbox.ts. A
# sandboxed Python child builds a capability object from its declared set alone
# and forwards each call to the trusted host over a newline-delimited JSON
# channel; the host resolves it against the real capabilities and rejects an
# undeclared one. A callback argument is replaced on the wire by a
# {"__sandboxCallback": id} marker; when the host bridges it back as an event,
# the registered callback fires.

from __future__ import annotations

import asyncio
import inspect
import json
import sys
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, TextIO


class CapabilityChannelClosed(RuntimeError):
    """Raised when the trusted host closes a capability relay."""


class _Channel:
    """Reads host->guest frames on a background thread: results wake the
    invoke() that is waiting on their id; events fire registered callbacks."""

    def __init__(self, read_stream: TextIO, write_stream: TextIO) -> None:
        self._read = read_stream
        self._write = write_stream
        self._write_lock = threading.Lock()
        self._cond = threading.Condition()
        self._results: dict[int, dict[str, Any]] = {}
        self._async_waiters: dict[
            int, tuple[asyncio.AbstractEventLoop, asyncio.Future[dict[str, Any]]]
        ] = {}
        self._abandoned_async_ids: set[int] = set()
        self._seq = 0
        self._callbacks: dict[
            int, tuple[Callable[..., Any], asyncio.AbstractEventLoop | None]
        ] = {}
        self._shutdown_waiters: list[
            tuple[asyncio.AbstractEventLoop, asyncio.Event]
        ] = []
        self._closed = False
        self._close_error = "capability host closed the relay"
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _next_id(self) -> int:
        with self._cond:
            self._seq += 1
            return self._seq

    def _send(self, msg: dict[str, Any]) -> None:
        line = json.dumps(msg) + "\n"
        with self._write_lock:
            if self._closed:
                raise CapabilityChannelClosed(self._close_error)
            try:
                self._write.write(line)
                self._write.flush()
            except (OSError, ValueError) as error:
                self._close_error = f"capability relay write failed: {error}"
                self._mark_closed()
                raise CapabilityChannelClosed(self._close_error) from error

    def _read_loop(self) -> None:
        try:
            while True:
                line = self._read.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                kind = msg.get("t")
                if kind == "result":
                    self._accept_result(msg)
                elif kind == "event":
                    self._accept_event(msg)
                elif kind == "control" and msg.get("action") == "shutdown":
                    self._request_shutdown()
        finally:
            self._mark_closed()

    def _accept_result(self, msg: dict[str, Any]) -> None:
        ident = msg.get("id")
        if isinstance(ident, bool) or not isinstance(ident, int):
            return
        with self._cond:
            waiter = self._async_waiters.pop(ident, None)
            if waiter is None:
                if ident in self._abandoned_async_ids:
                    self._abandoned_async_ids.discard(ident)
                    return
                self._results[ident] = msg
                self._cond.notify_all()
                return
        loop, future = waiter
        loop.call_soon_threadsafe(self._deliver_async_result, future, msg)

    @staticmethod
    def _deliver_async_result(
        future: asyncio.Future[dict[str, Any]], msg: dict[str, Any]
    ) -> None:
        if not future.done():
            future.set_result(msg)

    def _accept_event(self, msg: dict[str, Any]) -> None:
        callback_id = msg.get("callback")
        if isinstance(callback_id, bool) or not isinstance(callback_id, int):
            return
        with self._cond:
            registered = self._callbacks.get(callback_id)
        if registered is None:
            return
        callback, loop = registered
        args = tuple(msg.get("args", []))
        if loop is None:
            callback(*args)
            return
        loop.call_soon_threadsafe(self._run_async_callback, loop, callback, args)

    @staticmethod
    def _run_async_callback(
        loop: asyncio.AbstractEventLoop,
        callback: Callable[..., Any],
        args: tuple[Any, ...],
    ) -> None:
        try:
            result = callback(*args)
            if inspect.isawaitable(result):
                asyncio.ensure_future(result, loop=loop)
        except BaseException as error:
            loop.call_exception_handler(
                {
                    "message": "KFX capability callback failed",
                    "exception": error,
                    "callback": callback,
                }
            )

    def _request_shutdown(self) -> None:
        with self._cond:
            waiters = list(self._shutdown_waiters)
        for loop, event in waiters:
            loop.call_soon_threadsafe(event.set)

    def _mark_closed(self) -> None:
        with self._cond:
            if self._closed:
                return
            self._closed = True
            async_waiters = list(self._async_waiters.values())
            self._async_waiters.clear()
            shutdown_waiters = list(self._shutdown_waiters)
            self._cond.notify_all()
        for loop, future in async_waiters:
            loop.call_soon_threadsafe(
                self._deliver_async_close,
                future,
                self._close_error,
            )
        for loop, event in shutdown_waiters:
            loop.call_soon_threadsafe(event.set)

    @staticmethod
    def _deliver_async_close(
        future: asyncio.Future[dict[str, Any]], message: str
    ) -> None:
        if not future.done():
            future.set_exception(CapabilityChannelClosed(message))

    def _marshal(
        self,
        args: list[Any],
        callback_loop: asyncio.AbstractEventLoop | None = None,
    ) -> list[Any]:
        out: list[Any] = []
        for arg in args:
            if callable(arg):
                callback_id = self._next_id()
                with self._cond:
                    self._callbacks[callback_id] = (arg, callback_loop)
                out.append({"__sandboxCallback": callback_id})
            else:
                out.append(arg)
        return out

    def invoke(self, cap: str, method: str, args: list[Any]) -> Any:
        ident = self._next_id()
        self._send(
            {
                "t": "invoke",
                "id": ident,
                "cap": cap,
                "method": method,
                "args": self._marshal(args),
            }
        )
        with self._cond:
            while ident not in self._results and not self._closed:
                self._cond.wait()
            if ident not in self._results:
                raise CapabilityChannelClosed(self._close_error)
            result = self._results.pop(ident)
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "capability call failed")
        return result.get("value")

    async def invoke_async(self, cap: str, method: str, args: list[Any]) -> Any:
        loop = asyncio.get_running_loop()
        ident = self._next_id()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        with self._cond:
            if self._closed:
                raise CapabilityChannelClosed(self._close_error)
            self._async_waiters[ident] = (loop, future)
        try:
            self._send(
                {
                    "t": "invoke",
                    "id": ident,
                    "cap": cap,
                    "method": method,
                    "args": self._marshal(args, loop),
                }
            )
            result = await future
        except BaseException:
            with self._cond:
                if self._async_waiters.pop(ident, None) is not None:
                    self._abandoned_async_ids.add(ident)
            raise
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "capability call failed")
        return result.get("value")

    def register_shutdown_waiter(
        self,
        loop: asyncio.AbstractEventLoop,
        event: asyncio.Event,
    ) -> None:
        with self._cond:
            self._shutdown_waiters.append((loop, event))
            closed = self._closed
        if closed:
            loop.call_soon(event.set)


class _Capability:
    def __init__(self, channel: _Channel, cap: str) -> None:
        self._channel = channel
        self._cap = cap

    def __getattr__(self, method: str) -> Callable[..., Any]:
        def call(*args: Any) -> Any:
            return self._channel.invoke(self._cap, method, list(args))

        return call


class _AsyncCapability:
    def __init__(self, channel: _Channel, cap: str) -> None:
        self._channel = channel
        self._cap = cap

    def __getattr__(self, method: str) -> Callable[..., Any]:
        async def call(*args: Any) -> Any:
            return await self._channel.invoke_async(self._cap, method, list(args))

        return call


@dataclass(frozen=True)
class AsyncCapabilitySession:
    """Async capability surface plus a host-driven graceful-shutdown event."""

    caps: dict[str, _AsyncCapability]
    shutdown_requested: asyncio.Event


def connect(
    declared: Iterable[str],
    read_stream: TextIO | None = None,
    write_stream: TextIO | None = None,
) -> dict[str, _Capability]:
    """Build the capability object a sandboxed Python child receives: exactly the
    declared capabilities, each forwarded to the host over the channel (the
    child's stdio by default)."""
    channel = _Channel(read_stream or sys.stdin, write_stream or sys.stdout)
    return {cap: _Capability(channel, cap) for cap in declared}


def connect_async(
    declared: Iterable[str],
    read_stream: TextIO | None = None,
    write_stream: TextIO | None = None,
) -> dict[str, _AsyncCapability]:
    """Build a non-blocking capability surface for a standard asyncio loop."""

    channel = _Channel(read_stream or sys.stdin, write_stream or sys.stdout)
    return {cap: _AsyncCapability(channel, cap) for cap in declared}


def open_async_session(
    declared: Iterable[str],
    read_stream: TextIO | None = None,
    write_stream: TextIO | None = None,
) -> AsyncCapabilitySession:
    """Open the asyncio service session used by the Python KFX bootstrap."""

    loop = asyncio.get_running_loop()
    channel = _Channel(read_stream or sys.stdin, write_stream or sys.stdout)
    shutdown_requested = asyncio.Event()
    channel.register_shutdown_waiter(loop, shutdown_requested)
    return AsyncCapabilitySession(
        caps={cap: _AsyncCapability(channel, cap) for cap in declared},
        shutdown_requested=shutdown_requested,
    )


__all__ = [
    "AsyncCapabilitySession",
    "CapabilityChannelClosed",
    "connect",
    "connect_async",
    "open_async_session",
]
