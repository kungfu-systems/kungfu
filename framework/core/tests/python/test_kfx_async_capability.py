"""Async Python KFX capability relay qualification."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import pathlib
import socket
import sys
import threading
import time

import pytest


_GUEST = (
    pathlib.Path(__file__).resolve().parents[2]
    / "src/python/kungfu/capability/guest.py"
)


def _load_guest():
    name = "kungfu_capability_guest_under_test"
    spec = importlib.util.spec_from_file_location(name, _GUEST)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


guest = _load_guest()


def _write(stream, payload):
    stream.write(json.dumps(payload) + "\n")
    stream.flush()


def test_async_relay_correlates_callbacks_cancellation_shutdown_and_close():
    guest_socket, host_socket = socket.socketpair()
    guest_read = guest_socket.makefile("r", encoding="utf-8", newline="\n")
    guest_write = guest_socket.makefile("w", encoding="utf-8", newline="\n")
    host_read = host_socket.makefile("r", encoding="utf-8", newline="\n")
    host_write = host_socket.makefile("w", encoding="utf-8", newline="\n")
    host_errors = []

    def read_invoke():
        frame = json.loads(host_read.readline())
        assert frame["t"] == "invoke"
        return frame

    def host():
        try:
            first = read_invoke()
            second = read_invoke()
            _write(
                host_write,
                {"t": "result", "id": second["id"], "ok": True, "value": "B"},
            )
            _write(
                host_write,
                {"t": "result", "id": first["id"], "ok": True, "value": "A"},
            )

            callback_call = read_invoke()
            callback_id = callback_call["args"][0]["__sandboxCallback"]
            _write(
                host_write,
                {
                    "t": "event",
                    "callback": callback_id,
                    "args": ["event-value"],
                },
            )
            _write(
                host_write,
                {
                    "t": "result",
                    "id": callback_call["id"],
                    "ok": True,
                    "value": "subscribed",
                },
            )

            cancelled = read_invoke()
            time.sleep(0.05)
            _write(
                host_write,
                {
                    "t": "result",
                    "id": cancelled["id"],
                    "ok": True,
                    "value": "late",
                },
            )
            _write(host_write, {"t": "control", "action": "shutdown"})

            read_invoke()
        except BaseException as error:
            host_errors.append(error)
        finally:
            host_write.close()
            host_read.close()
            host_socket.close()

    host_thread = threading.Thread(target=host)
    host_thread.start()

    async def qualify():
        session = guest.open_async_session(
            ["ledger"], read_stream=guest_read, write_stream=guest_write
        )
        first = asyncio.create_task(session.caps["ledger"].lookup("A"))
        second = asyncio.create_task(session.caps["ledger"].lookup("B"))
        assert await asyncio.gather(first, second) == ["A", "B"]

        callback_value = asyncio.Future()

        async def callback(value):
            await asyncio.sleep(0)
            callback_value.set_result(value)

        assert await session.caps["ledger"].subscribe(callback) == "subscribed"
        assert await asyncio.wait_for(callback_value, timeout=1) == "event-value"

        cancelled = asyncio.create_task(session.caps["ledger"].slow())
        await asyncio.sleep(0.01)
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled

        await asyncio.wait_for(session.shutdown_requested.wait(), timeout=1)
        with pytest.raises(guest.CapabilityChannelClosed):
            await session.caps["ledger"].never()

    try:
        asyncio.run(qualify())
    finally:
        try:
            guest_socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        host_thread.join(timeout=2)
        guest_write.close()
        guest_read.close()
        guest_socket.close()

    assert not host_thread.is_alive()
    assert host_errors == []
