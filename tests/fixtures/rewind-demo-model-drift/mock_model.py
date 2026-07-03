# SPDX-License-Identifier: Apache-2.0
#
# Drift stand-in: the "model" confidently selects a tool that does not exist
# in the agent's registry. The wrongness lives in the model output itself —
# exactly the class of failure that is invisible in exception logs and obvious
# in a trace that shows the model node's actual response.
#
# Usage: mock_model.py <port-file>

import http.server
import json
import sys

CANNED = {
    "id": "chatcmpl-fixture-drift",
    "object": "chat.completion",
    "model": "demo-model",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "use tool: web-search with query 'demo answer'",
            },
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 9, "completion_tokens": 8, "total_tokens": 17},
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
