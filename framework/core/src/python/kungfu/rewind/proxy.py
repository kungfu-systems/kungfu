#  SPDX-License-Identifier: Apache-2.0
#
# Capture layer L1 — the model-wire proxy.
#
# The supervisor points the child's model SDKs at this local endpoint via
# base-url environment variables; every request is forwarded to the real
# upstream and captured as a ModelRequest/ModelResponse pair at the wire.
# Wire truth: bodies exactly as sent and received, provenance CaptureLayer
# ModelWire. Request/response HEADERS are never captured — that is where API
# keys live; capture takes JSON bodies only.
#
# Upstream resolution: the parent environment's own base urls (the ones the
# run would have used untraced), falling back to the providers' defaults.
# Routing: anthropic paths (/v1/messages) go to the anthropic upstream,
# everything else to the openai-compatible upstream.

import http.server
import json
import threading
import time
import urllib.error
import urllib.request
import uuid

from kungfu.rewind import MSG_MODEL_REQUEST, MSG_MODEL_RESPONSE
from kungfu.rewind import events
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.CaptureLayer import CaptureLayer

DEFAULT_OPENAI_UPSTREAM = "https://api.openai.com/v1"
DEFAULT_ANTHROPIC_UPSTREAM = "https://api.anthropic.com/v1"

# headers that must not be forwarded verbatim (hop-by-hop / recomputed)
_SKIP_FORWARD = {"host", "content-length", "connection", "accept-encoding"}


def _provider_for(path):
    return "anthropic" if path.rstrip("/").endswith("/messages") else "openai"


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # the proxy is capture infrastructure; stay quiet on the child's stderr
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        proxy = self.server.rewind_proxy
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        provider = _provider_for(self.path)
        span_id = uuid.uuid4().hex

        model = None
        try:
            model = json.loads(body).get("model")
        except (ValueError, AttributeError):
            pass

        proxy.sink(
            MSG_MODEL_REQUEST,
            events.model_request(
                run_id=proxy.run_id,
                span_id=span_id,
                parent_span_id=None,
                layer=CaptureLayer.ModelWire,
                provider=provider,
                model=model,
                request_body=body.decode("utf-8", errors="replace"),
            ),
        )

        upstream = proxy.upstreams[provider]
        url = (
            upstream.rstrip("/") + self.path[len("/v1") :]
            if self.path.startswith("/v1")
            else upstream.rstrip("/") + self.path
        )
        request = urllib.request.Request(url, data=body, method="POST")
        for name, value in self.headers.items():
            if name.lower() not in _SKIP_FORWARD:
                request.add_header(name, value)

        started = time.monotonic_ns()
        status, response_body, error = CallStatus.Ok, b"", None
        http_status = 502
        try:
            with urllib.request.urlopen(request, timeout=proxy.timeout) as response:
                response_body = response.read()
                http_status = response.status
        except urllib.error.HTTPError as e:
            response_body = e.read()
            http_status = e.code
            status, error = CallStatus.Error, f"upstream http {e.code}"
        except Exception as e:  # noqa: BLE001 — the child must get an answer
            status, error = CallStatus.Error, str(e)
        latency_ns = time.monotonic_ns() - started

        finish_reason, input_tokens, output_tokens = None, 0, 0
        try:
            parsed = json.loads(response_body)
            usage = parsed.get("usage") or {}
            input_tokens = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            output_tokens = (
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            )
            choices = parsed.get("choices") or []
            if choices:
                finish_reason = choices[0].get("finish_reason")
            finish_reason = finish_reason or parsed.get("stop_reason")
        except ValueError:
            pass

        proxy.sink(
            MSG_MODEL_RESPONSE,
            events.model_response(
                run_id=proxy.run_id,
                span_id=span_id,
                layer=CaptureLayer.ModelWire,
                status=status,
                response_body=response_body.decode("utf-8", errors="replace"),
                error=error,
                finish_reason=finish_reason,
                input_tokens=int(input_tokens),
                output_tokens=int(output_tokens),
                latency_ns=latency_ns,
            ),
        )

        payload = response_body or (error or "").encode()
        self.send_response(http_status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ModelWireProxy:
    def __init__(self, run_id, sink, upstreams=None, timeout=600):
        self.run_id = run_id
        self.sink = sink
        self.timeout = timeout
        self.upstreams = {
            "openai": DEFAULT_OPENAI_UPSTREAM,
            "anthropic": DEFAULT_ANTHROPIC_UPSTREAM,
            **(upstreams or {}),
        }
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.rewind_proxy = self
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self):
        host, port = self._server.server_address
        return f"http://{host}:{port}/v1"

    def start(self):
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
