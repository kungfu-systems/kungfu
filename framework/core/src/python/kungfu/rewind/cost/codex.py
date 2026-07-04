#  SPDX-License-Identifier: Apache-2.0
#
# Codex adapter — turn a `codex exec --json` run into a normalized CostSnapshot.
#
# `codex exec --json` streams JSONL events; the usage facts ride
# `turn.completed` events:
#
#   {"type":"turn.completed",
#    "usage":{"input_tokens":36419,"cached_input_tokens":4480,
#             "output_tokens":28,"reasoning_output_tokens":17}}
#
# This is a per-run structured surface, so the result is attributed EXACT_RUN.
# Codex reports token counts but no dollar cost, so `cost_usd` stays None — this
# layer does no pricing math and will not fabricate a 0.0.
#
# Honest gap: whether a multi-turn `codex exec` reports per-turn deltas or a
# running cumulative snapshot on each `turn.completed` is not pinned by the one
# smoke sample we have. `usage_mode` makes the assumption explicit and
# switchable; the default accumulates (treats each event as a delta). A managed
# run in a later slice should confirm this against a real multi-turn exec.

from __future__ import annotations

import json
from typing import Iterable, Optional

from kungfu.rewind.cost.model import AttributionLevel, CostSnapshot, TokenUsage

PROVIDER = "codex"
SURFACE = "exec_json"
SOURCE = "codex_exec_json"

_TURN_COMPLETED = "turn.completed"


def _usage_from(event_usage: dict) -> TokenUsage:
    """Map a codex usage object into the normalized TokenUsage.

    `or 0` guards missing/None fields; codex has no cache-creation dimension, so
    that stays 0. reasoning_output_tokens is a subset of output; it is recorded
    separately, not double-added into output_tokens.
    """
    return TokenUsage(
        input_tokens=int(event_usage.get("input_tokens") or 0),
        output_tokens=int(event_usage.get("output_tokens") or 0),
        cached_input_tokens=int(event_usage.get("cached_input_tokens") or 0),
        reasoning_tokens=int(event_usage.get("reasoning_output_tokens") or 0),
    )


def parse_codex_exec_jsonl(
    lines: Iterable[str],
    *,
    run_id: Optional[str] = None,
    work_id: Optional[str] = None,
    usage_mode: str = "accumulate",
) -> CostSnapshot:
    """Parse `codex exec --json` JSONL into one CostSnapshot for the run.

    `lines` is any iterable of raw JSONL lines (a file object, a list, a
    stream). Non-JSON / blank lines are skipped — the JSON events carry the
    facts, and codex may interleave other output. `usage_mode`:

      "accumulate"  sum usage across every turn.completed (per-turn deltas)
      "last"        take only the final turn.completed (cumulative snapshots)
    """
    if usage_mode not in ("accumulate", "last"):
        raise ValueError(f"usage_mode must be 'accumulate' or 'last', got {usage_mode}")

    total = TokenUsage()
    last: Optional[TokenUsage] = None
    turns = 0
    model: Optional[str] = None

    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            event = json.loads(raw)
        except (ValueError, TypeError):
            # not a JSON event line — skip, do not fail the whole parse
            continue
        if not isinstance(event, dict):
            continue
        # a model name may appear on any event; keep the most recent non-empty
        found_model = event.get("model")
        if isinstance(found_model, str) and found_model:
            model = found_model
        if event.get("type") != _TURN_COMPLETED:
            continue
        usage = event.get("usage")
        if not isinstance(usage, dict):
            continue
        turns += 1
        turn_usage = _usage_from(usage)
        total = total.add(turn_usage)
        last = turn_usage

    tokens = total if usage_mode == "accumulate" else (last or TokenUsage())

    return CostSnapshot(
        provider=PROVIDER,
        surface=SURFACE,
        attribution=AttributionLevel.EXACT_RUN,
        source=SOURCE,
        tokens=tokens,
        model=model,
        run_id=run_id,
        work_id=work_id,
        # codex exec has no session handle and reports tokens only
        session_id=None,
        cost_usd=None,
    )


def parse_codex_exec_json_text(text: str, **kwargs) -> CostSnapshot:
    """Convenience wrapper: parse a full JSONL blob (splitlines) in one call."""
    return parse_codex_exec_jsonl(text.splitlines(), **kwargs)
