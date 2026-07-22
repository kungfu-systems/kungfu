# SPDX-License-Identifier: Apache-2.0

import json
import os
import socket


MAX_RESPONSE_BYTES = 1024 * 1024


def invoke(request, endpoint=None, timeout=5.0):
    """Invoke the runtime-scoped Agent Session surface without a second API."""
    target = endpoint or os.environ.get("KUNGFU_AGENT_SESSION_ENDPOINT", "")
    if not target:
        raise ValueError(
            "Agent Session surface is unavailable; open the Kungfu product or "
            "run inside a Kungfu Agent Console"
        )
    if not hasattr(socket, "AF_UNIX"):
        raise ValueError(
            "Agent Session local actions are currently supported on macOS/Linux"
        )
    payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError("Agent Session request exceeds 1 MiB")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        client.connect(target)
        client.sendall(payload)
        response = bytearray()
        while b"\n" not in response:
            chunk = client.recv(65536)
            if not chunk:
                raise ValueError("Agent Session surface closed without a response")
            response.extend(chunk)
            if len(response) > MAX_RESPONSE_BYTES:
                raise ValueError("Agent Session response exceeds 1 MiB")
    decoded = json.loads(bytes(response).split(b"\n", 1)[0])
    if not decoded.get("ok"):
        error = decoded.get("error") or {}
        raise ValueError(
            f"{error.get('code', 'agent_session_error')}: "
            f"{error.get('message', 'Agent Session action failed')}"
        )
    return decoded["value"]
