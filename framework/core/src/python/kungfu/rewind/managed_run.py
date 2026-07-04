#  SPDX-License-Identifier: Apache-2.0
#
# A managed provider run: the seam that turns the cost parse layer and the cost
# wire event into one real act — launch a provider CLI in a structured-output
# mode, capture its output, parse it into a CostSnapshot, and emit that fact as
# a CostSnapshot journal event (msg_type 30008).
#
# Everything that touches the outside world is injected so the wiring is
# testable without a real CLI or the native journal writer:
#   - `runner`  launches the process and returns (exit_code, stdout, stderr).
#               Production uses subprocess; tests pass canned provider output.
#   - `emit`    takes (msg_type, event_bytes). Its signature is exactly
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
import subprocess
from typing import Callable, List, Optional

from kungfu.rewind import cost_wire
from kungfu.rewind.cost.claude import parse_claude_print_json
from kungfu.rewind.cost.codex import parse_codex_exec_json_text
from kungfu.rewind.cost.model import CostSnapshot
from kungfu.rewind.fb.CaptureLayer import CaptureLayer

# Provider -> how to invoke it for structured output and how to parse it back.
# argv keeps the provider's own structured-output flags; the prompt is the last
# positional. The two structured-output paths a managed run supports:
#   codex exec --json <prompt>              -> turn.completed.usage (tokens only)
#   claude --print --output-format json ... -> usage + total_cost_usd + session
_SPECS = {
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


def _subprocess_runner(argv, env=None):
    proc = subprocess.run(argv, capture_output=True, text=True, env=env)
    return proc.returncode, proc.stdout, proc.stderr


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
    emit: Callable[[int, bytes], None],
    run_id: str,
    work_id: Optional[str] = None,
    usage_mode: str = "accumulate",
    runner: Callable = _subprocess_runner,
    env=None,
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
    exit_code, stdout, stderr = runner(argv, env=env)

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
        msg_type, payload = cost_wire.snapshot_to_event(
            snapshot, layer=CaptureLayer.Supervisor
        )
        emit(msg_type, payload)
        emitted = True

    return ManagedRunResult(
        provider=provider,
        exit_code=exit_code,
        snapshot=snapshot,
        emitted=emitted,
        stdout=stdout,
        stderr=stderr,
        error=error,
    )


def managed_providers() -> List[str]:
    return sorted(_SPECS)
