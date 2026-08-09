"""Python KFX service fixture exercising the supported asyncio surface."""

from __future__ import annotations

import asyncio
import sys


async def close_stream(writer):
    """Bound platform-specific pipe/socket shutdown without hiding body errors."""

    writer.close()
    try:
        async with asyncio.timeout(2):
            await writer.wait_closed()
    except (TimeoutError, ConnectionError, OSError):
        pass


async def run(caps):
    future = asyncio.get_running_loop().create_future()
    asyncio.get_running_loop().call_soon(future.set_result, "future")
    future_result = await future

    timeout_result = "missing"
    try:
        async with asyncio.timeout(0.01):
            await asyncio.Event().wait()
    except TimeoutError:
        timeout_result = "timed-out"

    cancelled = asyncio.create_task(asyncio.sleep(60))
    cancelled.cancel()
    try:
        await cancelled
    except asyncio.CancelledError:
        cancellation_result = "cancelled"

    print("[python-asyncio-fixture] network-start", file=sys.stderr, flush=True)
    async with asyncio.timeout(5):

        async def handle(reader, writer):
            await reader.readexactly(4)
            writer.write(b"pong")
            await writer.drain()
            await close_stream(writer)

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        try:
            port = server.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"ping")
            await writer.drain()
            network_result = (await reader.readexactly(4)).decode()
            await close_stream(writer)
        finally:
            server.close()
            await server.wait_closed()
    print("[python-asyncio-fixture] network-done", file=sys.stderr, flush=True)

    print("[python-asyncio-fixture] process-start", file=sys.stderr, flush=True)
    child = None
    try:
        async with asyncio.timeout(15):
            child = await asyncio.create_subprocess_exec(
                sys.executable,
                "-I",
                "-S",
                "-c",
                "raise SystemExit(0)",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await child.communicate()
            return_code = child.returncode
    finally:
        if child is not None and child.returncode is None:
            child.kill()
            try:
                async with asyncio.timeout(2):
                    await child.wait()
            except (TimeoutError, ProcessLookupError):
                pass
    if return_code != 0:
        raise RuntimeError(f"subprocess probe exited with {return_code}")
    process_result = "subprocess-ok"
    print("[python-asyncio-fixture] process-done", file=sys.stderr, flush=True)

    records_a, records_b = await asyncio.gather(
        caps["ledger"].records({"limit": 1}),
        caps["ledger"].records({"limit": 2}),
    )
    await caps["ledger"].result(
        {
            "phase": "running",
            "future": future_result,
            "timeout": timeout_result,
            "cancellation": cancellation_result,
            "network": network_result,
            "process": process_result,
            "concurrentRelayCounts": [len(records_a), len(records_b)],
        }
    )

    try:
        await asyncio.Event().wait()
    except asyncio.CancelledError:
        await caps["ledger"].result({"phase": "stopped"})
        raise
