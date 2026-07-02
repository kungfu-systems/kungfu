# SPDX-License-Identifier: Apache-2.0
#
# Deterministic stand-in for a model provider: an openai-compatible chat
# completions endpoint with fixed content and usage, so the fixture asserts
# capture facts without network or keys.
#
# Usage: mock_model.py <port-file>   (binds an ephemeral port, writes it there)

import http.server
import json
import sys

CANNED = {
    "id": "chatcmpl-fixture",
    "object": "chat.completion",
    "model": "demo-model",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "the demo answer"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        body = json.dumps(CANNED).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
