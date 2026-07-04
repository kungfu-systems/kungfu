#  SPDX-License-Identifier: Apache-2.0
#
# The normalized cost contract — the language-layer shape every provider adapter
# produces, before any of it becomes a journal event.
#
# Layering: this is the parse-layer contract — a plain dataclass shape, NOT a
# wire event: no flatbuffers, no msg_type, no journal. Its job is to prove a
# run's cost/usage facts can be parsed out of a provider CLI's structured output
# honestly and completely. When a later slice puts these facts on the journal,
# this contract is the draft the rewind open-layer event (msg_type 30008+) is
# pinned from — one place decides the fields.
#
# Honesty is the whole product promise here. Every snapshot carries an
# `attribution` level and, when the source cannot separate concurrent work, an
# `ambiguous_attribution` flag. A number without its attribution level is a lie
# this contract refuses to represent.

from __future__ import annotations

import dataclasses
import enum
from typing import Optional

# Language-layer contract version. This is not the wire SCHEMA_VERSION (that
# lives beside the .fbs and is minted when these facts become journal events
# later); it just lets fixtures and callers detect contract drift.
COST_SCHEMA_VERSION = 1


class AttributionLevel(enum.Enum):
    """How trustworthy the join between a cost number and a unit of work is.

    Ordered strongest to weakest. The label travels with every snapshot so the
    UI never has to guess whether a number is billing-grade or a rough window
    delta.
    """

    # Usage belongs to one Kungfu-managed run, from structured per-run output.
    # (codex `exec --json` turn.completed.usage; claude `--print` result usage)
    EXACT_RUN = "exact_run"
    # Usage belongs to one session, possibly spanning turns/internal calls.
    # (claude session_id-keyed usage; future Codex session event stream)
    EXACT_SESSION = "exact_session"
    # Kungfu owns the session window and computes a before/after delta, but the
    # metric is not a native per-run usage event.
    OBSERVED_SESSION_DELTA = "observed_session_delta"
    # Account/product-surface snapshot delta; concurrent work may be mixed in.
    OBSERVED_WINDOW = "observed_window"
    # User-entered or imported approximate value.
    MANUAL_ESTIMATE = "manual_estimate"


# Attribution level -> a coarse confidence label, so callers/tests share one
# mapping instead of re-deriving it. exact_* is provider-structured truth;
# observed_* and manual are progressively softer.
_CONFIDENCE_BY_LEVEL = {
    AttributionLevel.EXACT_RUN: "high",
    AttributionLevel.EXACT_SESSION: "high",
    AttributionLevel.OBSERVED_SESSION_DELTA: "medium",
    AttributionLevel.OBSERVED_WINDOW: "low",
    AttributionLevel.MANUAL_ESTIMATE: "low",
}

# Levels whose source cannot, on its own, separate concurrent work on the same
# account/window. A snapshot at one of these levels is ambiguous whenever more
# than one unit of work could share the window.
_WINDOW_LEVELS = frozenset(
    {AttributionLevel.OBSERVED_WINDOW, AttributionLevel.MANUAL_ESTIMATE}
)


def confidence_for(level: AttributionLevel) -> str:
    return _CONFIDENCE_BY_LEVEL[level]


@dataclasses.dataclass
class TokenUsage:
    """Token counts for one run/session, normalized across providers.

    Providers spell these differently (OpenAI `prompt_tokens`, Anthropic
    `input_tokens`, Codex `cached_input_tokens`, Claude
    `cache_creation_input_tokens`); the adapters map into these fields so
    downstream code sees one shape. All counts are non-negative; 0 means the
    provider did not report that dimension, not "free".
    """

    input_tokens: int = 0
    output_tokens: int = 0
    # portion of input served from cache (Codex `cached_input_tokens`; Anthropic
    # cache-read). A subset of input_tokens, kept separate for cost weighting.
    cached_input_tokens: int = 0
    # tokens spent writing to the cache (Anthropic/Claude
    # `cache_creation_input_tokens`); billed distinctly from plain input.
    cache_creation_input_tokens: int = 0
    # reasoning/thinking tokens (Codex `reasoning_output_tokens`); a subset of
    # output_tokens on providers that separate it.
    reasoning_tokens: int = 0

    def __post_init__(self) -> None:
        for name in (
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "cache_creation_input_tokens",
            "reasoning_tokens",
        ):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool):
                raise TypeError(f"{name} must be int, got {type(value).__name__}")
            if value < 0:
                raise ValueError(f"{name} must be non-negative, got {value}")

    @property
    def billable_input_tokens(self) -> int:
        """Fresh (non-cached) input tokens — total input minus the cached read.

        Never negative even if a provider double-counts cache reads outside the
        input total; that is the honest floor, not an assertion the provider is
        consistent.
        """
        return max(self.input_tokens - self.cached_input_tokens, 0)

    def add(self, other: "TokenUsage") -> "TokenUsage":
        """Accumulate another usage into a new TokenUsage (for JSONL streams
        that report usage per turn)."""
        return TokenUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cached_input_tokens=self.cached_input_tokens + other.cached_input_tokens,
            cache_creation_input_tokens=(
                self.cache_creation_input_tokens + other.cache_creation_input_tokens
            ),
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
        )

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class ProviderRunMetadata:
    """Identity of the provider process that produced a cost snapshot.

    `run_id` is the join key back to the rewind run (supervisor-assigned at capture);
    `session_id` is the provider's own session handle when it exposes one
    (Claude does, Codex `exec` does not). `surface` names the invocation shape
    so the UI can tell an exec run from an interactive session.
    """

    provider: str  # "codex" | "claude" | ...
    surface: str  # "exec_json" | "print_json" | "interactive" | "usage" | ...
    model: Optional[str] = None
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    cli_version: Optional[str] = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class CostSnapshot:
    """One normalized cost/usage fact tied to a unit of work.

    This is the parse-layer output: what an adapter returns after reading a
    provider CLI's structured output. `cost_usd` is None when the provider
    reports tokens only (Codex exec) — this layer does no pricing math, so an
    unknown cost stays None rather than a fabricated 0.0.
    """

    provider: str
    surface: str
    attribution: AttributionLevel
    source: str  # e.g. "codex_exec_json", "claude_print_json"
    tokens: TokenUsage = dataclasses.field(default_factory=TokenUsage)
    model: Optional[str] = None
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    work_id: Optional[str] = None
    cost_usd: Optional[float] = None
    # True when the source cannot separate concurrent work sharing this
    # account/window. Auto-set for window/manual levels unless the caller has
    # proven isolation; exact_run/exact_session default False.
    ambiguous_attribution: bool = False
    # opaque reference to the redacted raw payload kept under the local ledger
    # boundary (never the raw bytes here) — populated in later slices.
    raw_ref: Optional[str] = None

    def __post_init__(self) -> None:
        if not isinstance(self.attribution, AttributionLevel):
            raise TypeError("attribution must be an AttributionLevel")
        if self.cost_usd is not None and self.cost_usd < 0:
            raise ValueError(f"cost_usd must be non-negative, got {self.cost_usd}")
        # window/manual levels are ambiguous by nature; only an explicit
        # isolation claim (caller passing ambiguous_attribution=False AND a
        # session/run key) would narrow it, which this layer never asserts.
        if self.attribution in _WINDOW_LEVELS:
            self.ambiguous_attribution = True

    @property
    def confidence(self) -> str:
        return confidence_for(self.attribution)

    def to_dict(self) -> dict:
        d = dataclasses.asdict(self)
        d["attribution"] = self.attribution.value
        d["confidence"] = self.confidence
        d["schema_version"] = COST_SCHEMA_VERSION
        return d
