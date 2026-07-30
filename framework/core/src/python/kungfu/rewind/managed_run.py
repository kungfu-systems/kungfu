#  SPDX-License-Identifier: Apache-2.0
#
# A managed provider run: the seam that turns the cost parse layer and the cost
# wire event into one real act — launch a provider CLI in a structured-output
# mode, capture its output, parse it into a CostSnapshot, and emit that fact as
# a CostSnapshot action-envelope event.
#
# Everything that touches the outside world is injected so the wiring is
# testable without a real CLI or the native journal writer:
#   - `runner`  launches the process and returns (exit_code, stdout, stderr).
#               Production uses subprocess; tests pass canned provider output.
#   - `emit`    takes (action_type, event_bytes). Its signature is exactly
#               Supervisor.enqueue, so a Kungfu-managed run wires the supervisor
#               in with one argument; tests pass a list-collecting sink.
#
# Honesty: a cost event is emitted only when the provider actually reported
# usage or a dollar cost. A crashed or silent run yields a result with the exit
# code and reason but no fabricated exact-run-zero event. Because the supervisor
# launched and parsed its own child here, the fact is Supervisor-layer
# provenance, not a third-party Adapter.

from __future__ import annotations

import dataclasses
import json
import subprocess
import time
from typing import Any, Callable, List, Optional, TypedDict

from kungfu.rewind import ACTION_MODEL_RESPONSE, events
from kungfu.rewind import cost_wire
from kungfu.rewind.cost.claude import parse_claude_print_json
from kungfu.rewind.cost.codex import parse_codex_exec_json_text
from kungfu.rewind.cost.model import CostSnapshot
from kungfu.rewind.fb.CallStatus import CallStatus
from kungfu.rewind.fb.CaptureLayer import CaptureLayer


# Provider -> how to invoke it for structured output and how to parse it back.
# argv keeps the provider's own structured-output flags; the prompt is the last
# positional. The two structured-output paths a managed run supports:
#   codex exec --json <prompt>              -> turn.completed.usage (tokens only)
#   claude --print --output-format json ... -> usage + total_cost_usd + session
class _ProviderSpec(TypedDict):
    surface: str
    argv: Callable[[str, str], list[str]]
    parse: Callable[..., CostSnapshot]


_SPECS: dict[str, _ProviderSpec] = {
    "codex": {
        "surface": "exec_json",
        "argv": lambda binary, prompt: [binary, "exec", "--json", prompt],
        "parse": lambda text, **kw: parse_codex_exec_json_text(text, **kw),
    },
    "claude": {
        "surface": "print_json",
        "argv": lambda binary, prompt: [
            binary,
            "--print",
            "--output-format",
            "json",
            prompt,
        ],
        "parse": lambda text, **kw: parse_claude_print_json(text, **kw),
    },
}


@dataclasses.dataclass
class ManagedRunResult:
    """Outcome of one managed provider run.

    `snapshot` is the parsed cost fact (None if parsing failed). `emitted` says
    whether a CostSnapshot event was put on the sink — false when the run
    reported no usage, so a consumer never mistakes silence for a zero-cost run.
    """

    provider: str
    exit_code: int
    snapshot: Optional[CostSnapshot]
    emitted: bool
    stdout: str
    stderr: str
    error: Optional[str] = None
    response_text: Optional[str] = None
    response_body: Optional[str] = None
    response_error: Optional[str] = None
    response_emitted: bool = False


def _subprocess_runner(
    argv: list[str], env: dict[str, str] | None = None
) -> tuple[int, str, str]:
    proc = subprocess.run(argv, capture_output=True, text=True, env=env)
    return proc.returncode, proc.stdout, proc.stderr


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _codex_assistant_text(event: dict[str, Any]) -> Optional[str]:
    candidates = []
    if isinstance(event.get("item"), dict):
        candidates.append(event["item"])
    if isinstance(event.get("message"), dict):
        candidates.append(event["message"])
    candidates.append(event)

    for candidate in candidates:
        if candidate.get("role") not in (None, "assistant"):
            continue
        text = _content_text(candidate.get("content"))
        if text:
            return text
        text = candidate.get("text") or candidate.get("output_text")
        if isinstance(text, str) and text:
            return text
    return None


def _extract_codex_response(
    stdout: str,
) -> tuple[Optional[str], Optional[dict[str, Any]], Optional[str]]:
    texts = []
    raw = None
    error = None
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type in {"turn.failed", "error"}:
            found = event.get("error") or event.get("message")
            if isinstance(found, str):
                error = found
        text = _codex_assistant_text(event)
        if text:
            texts.append(text)
            raw = event
    return "\n".join(texts) if texts else None, raw, error


def _extract_claude_response(
    stdout: str,
) -> tuple[Optional[str], dict[str, Any], Optional[str]]:
    payload = json.loads(stdout)
    if not isinstance(payload, dict):
        raise TypeError("claude response payload must be a JSON object")
    text = payload.get("result")
    if not isinstance(text, str):
        text = (
            payload.get("message") if isinstance(payload.get("message"), str) else None
        )
    error = payload.get("error")
    if not isinstance(error, str):
        error = None
    if bool(payload.get("is_error")) and error is None and text:
        error = text
    return text, payload, error


def _extract_response(
    provider: str, surface: str, stdout: str, stderr: str, exit_code: int
) -> tuple[Optional[str], str, Optional[str]]:
    text = None
    raw = None
    error = None
    try:
        if provider == "claude":
            text, raw, error = _extract_claude_response(stdout)
        elif provider == "codex":
            text, raw, error = _extract_codex_response(stdout)
    except Exception as exc:
        error = f"response parse failed: {exc}"

    if error is None and exit_code != 0 and stderr:
        error = stderr.strip()
    body = {
        "provider": provider,
        "surface": surface,
        "text": text,
        "raw": raw,
    }
    if error:
        body["error"] = error
    return text, json.dumps(body, ensure_ascii=False, sort_keys=True), error


def _has_usage(snapshot: CostSnapshot) -> bool:
    t = snapshot.tokens
    return bool(
        t.input_tokens
        or t.output_tokens
        or t.cached_input_tokens
        or t.cache_creation_input_tokens
        or t.reasoning_tokens
        or snapshot.cost_usd is not None
    )


def run_managed(
    provider: str,
    binary: str,
    prompt: str,
    *,
    emit: Callable[[str, bytes], None],
    run_id: str,
    work_id: Optional[str] = None,
    usage_mode: str = "accumulate",
    runner: Callable[..., tuple[int, str, str]] = _subprocess_runner,
    env: dict[str, str] | None = None,
) -> ManagedRunResult:
    """Run a provider under Kungfu management and emit its cost fact.

    Returns a ManagedRunResult; emits a CostSnapshot event through `emit` only
    when the run reported real usage. `run_id` binds the fact back to the
    supervisor's journal run; `work_id` links it to a work item when known.
    """
    spec = _SPECS.get(provider)
    if spec is None:
        raise ValueError(f"unknown managed provider: {provider!r}")

    argv = spec["argv"](binary, prompt)
    started_ns = time.monotonic_ns()
    exit_code, stdout, stderr = runner(argv, env=env)
    latency_ns = max(0, time.monotonic_ns() - started_ns)

    snapshot: Optional[CostSnapshot] = None
    error: Optional[str] = None
    parse_kwargs = {"run_id": run_id, "work_id": work_id}
    if provider == "codex":
        parse_kwargs["usage_mode"] = usage_mode
    try:
        snapshot = spec["parse"](stdout, **parse_kwargs)
    except Exception as exc:  # a malformed provider payload must not crash the run
        error = f"cost parse failed: {exc}"

    emitted = False
    if snapshot is not None and _has_usage(snapshot):
        action_type, payload = cost_wire.snapshot_to_event(
            snapshot, layer=CaptureLayer.Supervisor
        )
        emit(action_type, payload)
        emitted = True

    response_text, response_body, response_error = _extract_response(
        provider, spec["surface"], stdout, stderr, exit_code
    )
    status = CallStatus.Error if exit_code != 0 or response_error else CallStatus.Ok
    input_tokens = output_tokens = 0
    if snapshot is not None:
        input_tokens = snapshot.tokens.input_tokens
        output_tokens = snapshot.tokens.output_tokens
    emit(
        ACTION_MODEL_RESPONSE,
        events.model_response(
            run_id=run_id,
            span_id=f"{run_id}:managed-provider",
            layer=CaptureLayer.Supervisor,
            status=status,
            response_body=response_body,
            error=response_error,
            finish_reason="provider_exit",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ns=latency_ns,
        ),
    )

    return ManagedRunResult(
        provider=provider,
        exit_code=exit_code,
        snapshot=snapshot,
        emitted=emitted,
        stdout=stdout,
        stderr=stderr,
        error=error,
        response_text=response_text,
        response_body=response_body,
        response_error=response_error,
        response_emitted=True,
    )


def managed_providers() -> List[str]:
    return sorted(_SPECS)
