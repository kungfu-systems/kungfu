# SPDX-License-Identifier: Apache-2.0
#
# Wiring assertions for a managed provider run. Proves the seam that joins the
# cost parse layer and the cost wire event into one act: launch a provider,
# parse its structured output into a CostSnapshot, and emit a CostSnapshot
# journal event (msg_type 30008) bound to the run.
#
# It drives run_managed with an injected fake process runner and a
# list-collecting emit sink, so nothing here spawns a real CLI or needs the
# native journal writer. The emit sink's (msg_type, bytes) signature is exactly
# Supervisor.enqueue, so this is the same seam production wires the supervisor
# into. It asserts:
#   1. codex exec --json is invoked and accumulated into an EXACT_RUN cost event
#      with no fabricated dollar cost, at Supervisor-layer provenance;
#   2. claude --print --output-format json carries total_cost_usd + session;
#   3. a run that reported no usage emits nothing (silence is not zero cost);
#   4. a malformed payload fails soft — no event, an error on the result;
#   5. run_id / work_id bind the fact back to the run/work item.
#
# Needs flatbuffers (run under `uv run --frozen python`), not pykungfu: it stubs
# only the top-level kungfu package, like the cost-wire fixture.
#
# Usage: check_managed_run.py <fixture-dir>

import json
import os
import sys
import types

fixture_dir = (
    sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
)
core_src = os.path.abspath(
    os.path.join(fixture_dir, "..", "..", "..", "framework", "core", "src", "python")
)
sys.path.insert(0, core_src)

if "kungfu" not in sys.modules:
    _m = types.ModuleType("kungfu")
    _m.__path__ = [os.path.join(core_src, "kungfu")]
    _m.schema_data_path = lambda module_file, name: os.path.join(
        os.path.dirname(module_file), name
    )
    sys.modules["kungfu"] = _m

from kungfu.rewind import MSG_COST_SNAPSHOT, managed_run  # noqa: E402
from kungfu.rewind.fb.Attribution import Attribution as FbAttribution  # noqa: E402
from kungfu.rewind.fb.CaptureLayer import CaptureLayer as FbCaptureLayer  # noqa: E402
from kungfu.rewind.fb.CostSnapshot import CostSnapshot as FbCostSnapshot  # noqa: E402

failures = []


def check(name, ok, detail=""):
    if not ok:
        failures.append(name + (f" ({detail})" if detail else ""))


def fake_runner(exit_code, stdout, stderr=""):
    """A process runner that records its argv and returns canned output."""
    seen = {}

    def run(argv, env=None):
        seen["argv"] = argv
        seen["env"] = env
        return exit_code, stdout, stderr

    return run, seen


def sink():
    events = []

    def emit(msg_type, data):
        events.append((msg_type, bytes(data)))

    return emit, events


def decode(events):
    assert len(events) == 1, f"expected 1 event, got {len(events)}"
    msg_type, payload = events[0]
    assert msg_type == MSG_COST_SNAPSHOT
    return FbCostSnapshot.GetRootAs(payload, 0)


# --- provider registry ------------------------------------------------------
check(
    "managed providers are codex + claude",
    managed_run.managed_providers() == ["claude", "codex"],
)

# --- codex: two turns accumulate into one EXACT_RUN, tokens-only ------------
codex_jsonl = "\n".join(
    [
        json.dumps(
            {
                "type": "turn.completed",
                "model": "gpt-5-codex",
                "usage": {
                    "input_tokens": 1000,
                    "cached_input_tokens": 200,
                    "output_tokens": 300,
                    "reasoning_output_tokens": 50,
                },
            }
        ),
        json.dumps(
            {
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 500,
                    "cached_input_tokens": 100,
                    "output_tokens": 120,
                    "reasoning_output_tokens": 30,
                },
            }
        ),
    ]
)
run, seen = fake_runner(0, codex_jsonl)
emit, events = sink()
result = managed_run.run_managed(
    "codex",
    "/opt/codex",
    "summarize the diff",
    emit=emit,
    run_id="run-codex-1",
    work_id="work-42",
    runner=run,
)
check(
    "codex argv is exec --json <prompt>",
    seen["argv"] == ["/opt/codex", "exec", "--json", "summarize the diff"],
    str(seen["argv"]),
)
check("codex run exit 0", result.exit_code == 0)
check("codex run emitted", result.emitted is True)
ev = decode(events)
check(
    "codex event input_tokens accumulated",
    ev.InputTokens() == 1500,
    str(ev.InputTokens()),
)
check("codex event cached accumulated", ev.CachedInputTokens() == 300)
check("codex event output accumulated", ev.OutputTokens() == 420)
check("codex event reasoning accumulated", ev.ReasoningTokens() == 80)
check("codex event attribution ExactRun", ev.Attribution() == FbAttribution.ExactRun)
check("codex managed layer is Supervisor", ev.Layer() == FbCaptureLayer.Supervisor)
check("codex event run_id bound", ev.RunId() == b"run-codex-1")
check("codex event work_id bound", ev.WorkId() == b"work-42")
check("codex event model", ev.Model() == b"gpt-5-codex")
check("codex cost stays unknown", not ev.CostUsdKnown())

# --- claude: print json carries dollar cost + session ----------------------
claude_json = json.dumps(
    {
        "session_id": "sess-77",
        "total_cost_usd": 0.0231,
        "usage": {
            "input_tokens": 800,
            "output_tokens": 500,
            "cache_read_input_tokens": 128,
            "cache_creation_input_tokens": 64,
        },
        "modelUsage": {"claude-sonnet-5": {"inputTokens": 800, "outputTokens": 500}},
    }
)
run, seen = fake_runner(0, claude_json)
emit, events = sink()
result = managed_run.run_managed(
    "claude", "/opt/claude", "review this", emit=emit, run_id="run-claude-1", runner=run
)
check(
    "claude argv is --print --output-format json <prompt>",
    seen["argv"]
    == ["/opt/claude", "--print", "--output-format", "json", "review this"],
    str(seen["argv"]),
)
check("claude run emitted", result.emitted is True)
ev = decode(events)
check("claude cost known", bool(ev.CostUsdKnown()))
check("claude cost value", abs(ev.CostUsd() - 0.0231) < 1e-9, str(ev.CostUsd()))
check("claude session_id", ev.SessionId() == b"sess-77")
check("claude cache_read -> cached", ev.CachedInputTokens() == 128)
check("claude cache_creation carried", ev.CacheCreationInputTokens() == 64)
check("claude managed layer is Supervisor", ev.Layer() == FbCaptureLayer.Supervisor)

# --- no usage reported: silence must not become a zero-cost event ----------
run, _ = fake_runner(0, "hello, no json here\n")
emit, events = sink()
result = managed_run.run_managed(
    "codex", "/opt/codex", "noop", emit=emit, run_id="run-empty", runner=run
)
check("no-usage run does not emit", result.emitted is False)
check("no-usage sink stays empty", events == [])
check("no-usage still returns a snapshot", result.snapshot is not None)

# --- malformed payload fails soft: no event, error recorded ----------------
run, _ = fake_runner(1, "not json {", "boom")
emit, events = sink()
result = managed_run.run_managed(
    "claude", "/opt/claude", "bad", emit=emit, run_id="run-bad", runner=run
)
check("malformed run does not emit", result.emitted is False)
check(
    "malformed run records error",
    result.error is not None and "parse failed" in result.error,
)
check("malformed run keeps exit code", result.exit_code == 1)

# --- unknown provider is a hard error --------------------------------------
try:
    managed_run.run_managed(
        "gemini",
        "/opt/gemini",
        "x",
        emit=lambda *a: None,
        run_id="r",
        runner=fake_runner(0, "")[0],
    )
    check("unknown provider raises", False, "no error")
except ValueError:
    check("unknown provider raises", True)

if failures:
    print(f"managed run check failed: {failures}")
    sys.exit(1)
print("managed run check passed")
