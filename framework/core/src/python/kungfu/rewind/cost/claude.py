#  SPDX-License-Identifier: Apache-2.0
#
# Claude adapter — turn a `claude --print --output-format json` run into a
# normalized CostSnapshot.
#
# `claude --print --output-format json` emits ONE JSON object with structured
# usage AND a dollar cost the CLI computed itself:
#
#   {"session_id":"969ea637-…",
#    "total_cost_usd":0.15698,
#    "usage":{"input_tokens":1,"cache_creation_input_tokens":15605,
#             "output_tokens":13},
#    "modelUsage":{"claude-…":{"costUSD":0.15638}}}
#
# Because Claude reports total_cost_usd, this adapter carries a real cost_usd
# (no pricing math needed). session_id is Claude's own handle.
#
# Attribution: a single `--print` invocation is one run → EXACT_RUN by default.
# When the caller resumed a persistent session (so the usage spans turns keyed
# by session_id), it should pass attribution=EXACT_SESSION. This parser cannot
# tell these apart from the payload alone, so the honest default is EXACT_RUN
# and the caller narrows it.

from __future__ import annotations

import json
from typing import Optional, Union

from kungfu.rewind.cost.model import AttributionLevel, CostSnapshot, TokenUsage

PROVIDER = "claude"
SURFACE = "print_json"
SOURCE = "claude_print_json"

_ALLOWED_ATTRIBUTION = (AttributionLevel.EXACT_RUN, AttributionLevel.EXACT_SESSION)


def _usage_from(usage: dict) -> TokenUsage:
    """Map Claude's usage object into the normalized TokenUsage.

    Claude splits cache into creation vs read: `cache_creation_input_tokens`
    is billed distinctly, `cache_read_input_tokens` is the cached portion of
    input. Both map to their normalized slots; `or 0` guards absence.
    """
    return TokenUsage(
        input_tokens=int(usage.get("input_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or 0),
        cached_input_tokens=int(usage.get("cache_read_input_tokens") or 0),
        cache_creation_input_tokens=int(usage.get("cache_creation_input_tokens") or 0),
    )


def _primary_model(model_usage) -> Optional[str]:
    """Pick the model that carried most of the cost as the snapshot's model.

    `modelUsage` maps model name -> {costUSD, tokens…}. A `--print` run is
    usually one model, but a run that fell back across models still gets a
    single honest headline: the one that dominated the bill.
    """
    if not isinstance(model_usage, dict) or not model_usage:
        return None
    best, best_cost = None, -1.0
    for name, info in model_usage.items():
        cost = 0.0
        if isinstance(info, dict):
            try:
                cost = float(info.get("costUSD") or 0.0)
            except (TypeError, ValueError):
                cost = 0.0
        if cost > best_cost:
            best, best_cost = name, cost
    return best


def parse_claude_print_json(
    payload: Union[str, dict],
    *,
    run_id: Optional[str] = None,
    work_id: Optional[str] = None,
    attribution: AttributionLevel = AttributionLevel.EXACT_RUN,
) -> CostSnapshot:
    """Parse a `claude --print --output-format json` object into a CostSnapshot.

    `payload` is the JSON text or an already-parsed dict. `attribution` must be
    EXACT_RUN (default) or EXACT_SESSION — a Claude print result is always at
    least session-attributed truth; the caller says which when it resumed a
    session.
    """
    if attribution not in _ALLOWED_ATTRIBUTION:
        raise ValueError(
            f"claude attribution must be EXACT_RUN or EXACT_SESSION, got {attribution}"
        )
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict):
        raise TypeError("claude payload must be a JSON object")

    usage = payload.get("usage")
    tokens = _usage_from(usage) if isinstance(usage, dict) else TokenUsage()

    cost_usd = payload.get("total_cost_usd")
    if cost_usd is not None:
        cost_usd = float(cost_usd)

    session_id = payload.get("session_id")
    model = _primary_model(payload.get("modelUsage"))

    return CostSnapshot(
        provider=PROVIDER,
        surface=SURFACE,
        attribution=attribution,
        source=SOURCE,
        tokens=tokens,
        model=model,
        session_id=session_id if isinstance(session_id, str) else None,
        run_id=run_id,
        work_id=work_id,
        cost_usd=cost_usd,
    )
