# SPDX-License-Identifier: Apache-2.0
#
# Deterministic stand-in for an OpenAI-compatible provider, sized for a real
# LangChain tool-calling agent. Two turns:
#   1. the first request (no tool result yet) -> a tool_call for `lookup`;
#   2. the follow-up request (carrying the tool's result) -> a final answer.
# Branching on the presence of a tool-role message, not a call counter, keeps
# it robust to health checks or reordering at the proxy.
#
# Usage: mock_model.py <port-file>   (binds an ephemeral port, writes it there)

import http.server
import json
import sys

TOOL_CALL_TURN = {
    "id": "chatcmpl-fixture-1",
    "object": "chat.completion",
    "model": "fixture-model",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_lookup_1",
                        "type": "function",
                        "function": {
                            "name": "lookup",
                            "arguments": json.dumps({"query": "kungfu rewind"}),
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
        }
    ],
    "usage": {"prompt_tokens": 11, "completion_tokens": 5, "total_tokens": 16},
}

FINAL_TURN = {
    "id": "chatcmpl-fixture-2",
    "object": "chat.completion",
    "model": "fixture-model",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "done: KUNGFU REWIND"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 19, "completion_tokens": 4, "total_tokens": 23},
}


def _has_tool_result(body):
    try:
        messages = json.loads(body).get("messages", [])
    except (ValueError, AttributeError):
        return False
    return any(m.get("role") == "tool" for m in messages)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        turn = FINAL_TURN if _has_tool_result(raw) else TOOL_CALL_TURN
        body = json.dumps(turn).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
