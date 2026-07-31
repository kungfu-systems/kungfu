"""Python KFX service fixture exercising the supported asyncio surface."""

from __future__ import annotations

import asyncio
import sys


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

    async def handle(reader, writer):
        await reader.readexactly(4)
        writer.write(b"pong")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"ping")
    await writer.drain()
    network_result = (await reader.readexactly(4)).decode()
    writer.close()
    await writer.wait_closed()
    server.close()
    await server.wait_closed()

    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "print('subprocess-ok')",
        stdout=asyncio.subprocess.PIPE,
    )
    stdout, _stderr = await child.communicate()
    process_result = stdout.decode().strip()

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
