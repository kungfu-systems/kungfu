#  SPDX-License-Identifier: Apache-2.0
#
# The one place a parsed cost fact becomes a journal event.
#
# cost/ is the parse layer — pure-stdlib dataclasses with no journal and no
# flatbuffers (see cost/__init__.py). This module is the wire-side bridge that
# crosses that boundary: it takes a cost/model.CostSnapshot and produces the
# (msg_type, bytes) an open-layer CostSnapshot event rides on. Keeping the bridge
# here, not inside cost/, is deliberate — the parse layer must stay importable
# and testable without flatbuffers or the native binding.
#
# "One place decides the fields": cost/model.py drafts the contract, and this
# bridge is the single mapping from that dataclass to the wire event. The two
# CostSnapshot names are intentionally the same fact at two layers; do not let
# them drift.

from kungfu.rewind import MSG_COST_SNAPSHOT, events
from kungfu.rewind.cost.model import AttributionLevel, CostSnapshot
from kungfu.rewind.fb.Attribution import Attribution
from kungfu.rewind.fb.CaptureLayer import CaptureLayer

# Explicit map, not positional reliance: the wire enum and the parse enum happen
# to share ordinals today, but pinning the mapping means a future reorder on
# either side fails loudly here instead of silently mislabeling a cost fact.
_ATTRIBUTION_TO_FB = {
    AttributionLevel.EXACT_RUN: Attribution.ExactRun,
    AttributionLevel.EXACT_SESSION: Attribution.ExactSession,
    AttributionLevel.OBSERVED_SESSION_DELTA: Attribution.ObservedSessionDelta,
    AttributionLevel.OBSERVED_WINDOW: Attribution.ObservedWindow,
    AttributionLevel.MANUAL_ESTIMATE: Attribution.ManualEstimate,
}


def attribution_to_fb(level: AttributionLevel) -> int:
    try:
        return _ATTRIBUTION_TO_FB[level]
    except KeyError as exc:  # pragma: no cover - guards an unmapped future level
        raise ValueError(f"no wire Attribution for {level!r}") from exc


def snapshot_to_event(snapshot: CostSnapshot, layer: int = CaptureLayer.Adapter):
    """Serialize a parse-layer CostSnapshot into a journal event.

    Returns (msg_type, event_bytes) ready for the supervisor's
    writer.write_bytes(...). `layer` records which capture layer produced the
    fact; cost adapters default to Adapter, a supervisor that parsed a run it
    launched can pass Supervisor.

    cost_usd is None on tokens-only providers (Codex exec reports no dollars).
    That None becomes cost_usd_known=False with a 0.0 placeholder — the honesty
    invariant from cost/model.py carried onto the wire, never a fabricated cost.
    """
    tokens = snapshot.tokens
    cost_known = snapshot.cost_usd is not None
    payload = events.cost_snapshot(
        run_id=snapshot.run_id,
        work_id=snapshot.work_id,
        session_id=snapshot.session_id,
        layer=layer,
        provider=snapshot.provider,
        surface=snapshot.surface,
        model=snapshot.model,
        source=snapshot.source,
        attribution=attribution_to_fb(snapshot.attribution),
        input_tokens=tokens.input_tokens,
        output_tokens=tokens.output_tokens,
        cached_input_tokens=tokens.cached_input_tokens,
        cache_creation_input_tokens=tokens.cache_creation_input_tokens,
        reasoning_tokens=tokens.reasoning_tokens,
        cost_usd=snapshot.cost_usd if cost_known else 0.0,
        cost_usd_known=cost_known,
        ambiguous_attribution=snapshot.ambiguous_attribution,
        raw_ref=snapshot.raw_ref,
    )
    return MSG_COST_SNAPSHOT, payload
