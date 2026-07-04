# SPDX-License-Identifier: Apache-2.0
#
# Parse-layer assertions for the cost adapters. Proves three things without a
# journal or the native binding:
#   1. provider discovery locates Codex (PATH + macOS app bundle) and Claude and
#      records misses diagnosably, touching no credential;
#   2. the Codex `exec --json` adapter accumulates turn.completed usage into an
#      EXACT_RUN snapshot with no fabricated dollar cost;
#   3. the Claude `--print --output-format json` adapter carries the real
#      total_cost_usd, session id, and cache-split tokens;
# plus the normalized contract's honesty invariants (attribution -> confidence,
# window levels are ambiguous, no negative/absurd values).
#
# Usage: check_cost_adapter.py <fixture-dir>

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

# Stub the heavy package parents. kungfu/__init__.py imports the native pykungfu
# binding; the cost subpackage does not need it. Giving each stub a real
# __path__ lets Python still resolve the real cost/ subpackage on disk, so this
# fixture stays pure-stdlib and fast while importing the actual product code.
for _name in ("kungfu", "kungfu.rewind"):
    if _name not in sys.modules:
        _m = types.ModuleType(_name)
        _m.__path__ = [os.path.join(core_src, *_name.split("."))]
        sys.modules[_name] = _m

from kungfu.rewind.cost import (
    AttributionLevel,
    CostSnapshot,
    COST_SCHEMA_VERSION,
    ProviderDiscovery,
    TokenUsage,
    confidence_for,
    discover_provider,
    discover_providers,
    parse_claude_print_json,
    parse_codex_exec_json_text,
    parse_codex_exec_jsonl,
)
from kungfu.rewind.cost.discovery import CODEX_APP_BUNDLE

failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


def raises(exc, fn):
    try:
        fn()
    except exc:
        return True
    except Exception:  # noqa: BLE001 — wrong exception type is still a failure
        return False
    return False


def which_from(table):
    return lambda name: table.get(name)


# ── 1. provider discovery (injected resolvers — no real binary needed) ───────
print("[discovery]")

# a probe that records whether it ran, to prove discovery never execs when a
# stub is supplied and that it does capture the version string.
probe_calls = []


def fake_probe(path):
    probe_calls.append(path)
    return "codex-cli 0.142.5"


d = discover_provider(
    "codex",
    which=which_from({"codex": "/usr/local/bin/codex"}),
    version_probe=fake_probe,
    platform="linux",
)
check("codex found on PATH", d.found and d.path == "/usr/local/bin/codex")
check("codex path_class == path", d.path_class == "path")
check("codex version captured", d.version == "codex-cli 0.142.5")
check("version probe was called for the hit", probe_calls == ["/usr/local/bin/codex"])

# codex missing from PATH but present in the macOS app bundle
d = discover_provider(
    "codex",
    which=which_from({}),
    version_probe=lambda p: "codex-cli 0.142.5",
    platform="darwin",
    exists=lambda p: p == CODEX_APP_BUNDLE,
)
check(
    "codex found in macOS app bundle when off PATH",
    d.found and d.path == CODEX_APP_BUNDLE,
)
check("codex app-bundle path_class", d.path_class == "codex_app_bundle")

# app bundle only tried on darwin — a linux box with no PATH hit finds nothing
d = discover_provider("codex", which=which_from({}), platform="linux")
check("codex not found on linux without PATH -> found False", not d.found)
check("codex miss records an error", bool(d.error))
check(
    "codex miss lists no false candidate", CODEX_APP_BUNDLE not in d.candidates_checked
)

# claude on PATH
d = discover_provider(
    "claude",
    which=which_from({"claude": "/opt/claude/bin/claude"}),
    version_probe=lambda p: "2.1.201 (Claude Code)",
    platform="darwin",
)
check("claude found on PATH", d.found and d.path == "/opt/claude/bin/claude")
check("claude version captured", d.version == "2.1.201 (Claude Code)")

# unknown provider is a diagnosable miss, not a crash
d = discover_provider("bogus", which=which_from({}))
check("unknown provider -> found False + error", (not d.found) and bool(d.error))

# discover_providers over the default set, no execution
res = discover_providers(
    which=which_from({"codex": "/c/codex", "claude": "/c/claude"}),
    version_probe=lambda p: None,
    platform="linux",
)
check(
    "discover_providers returns both defaults",
    set(res) == {"codex", "claude"}
    and all(isinstance(v, ProviderDiscovery) for v in res.values()),
)
check("both defaults found with injected PATH", all(v.found for v in res.values()))


# ── 2. Codex exec --json adapter ─────────────────────────────────────────────
print("[codex]")

with open(os.path.join(fixture_dir, "samples", "codex-exec.jsonl")) as f:
    codex_text = f.read()

snap = parse_codex_exec_json_text(codex_text, run_id="run-codex-1", work_id="work-7")
check("codex attribution == exact_run", snap.attribution is AttributionLevel.EXACT_RUN)
check("codex source label", snap.source == "codex_exec_json")
check("codex surface label", snap.surface == "exec_json")
check(
    "codex accumulates input_tokens",
    snap.tokens.input_tokens == 37619,
    str(snap.tokens.input_tokens),
)
check(
    "codex accumulates output_tokens",
    snap.tokens.output_tokens == 73,
    str(snap.tokens.output_tokens),
)
check("codex accumulates cached_input_tokens", snap.tokens.cached_input_tokens == 5280)
check("codex accumulates reasoning_tokens", snap.tokens.reasoning_tokens == 27)
check(
    "codex billable input = total - cached", snap.tokens.billable_input_tokens == 32339
)
check("codex has no fabricated cost (tokens only)", snap.cost_usd is None)
check("codex model captured from session event", snap.model == "gpt-5-codex")
check(
    "codex run_id/work_id threaded",
    snap.run_id == "run-codex-1" and snap.work_id == "work-7",
)
check("codex confidence high", snap.confidence == "high")
check("codex not ambiguous (per-run)", snap.ambiguous_attribution is False)

# usage_mode="last" takes only the final turn.completed (cumulative-snapshot mode)
snap_last = parse_codex_exec_json_text(codex_text, usage_mode="last")
check("codex last-mode input == final turn", snap_last.tokens.input_tokens == 1200)
check("codex last-mode output == final turn", snap_last.tokens.output_tokens == 45)

# robustness: blank and non-JSON lines are skipped, not fatal
messy = [
    "",
    "not json at all",
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    "   ",
]
snap_messy = parse_codex_exec_jsonl(messy)
check("codex skips blank/garbage lines", snap_messy.tokens.input_tokens == 10)

# no turns at all -> zero usage, still a valid exact_run snapshot
snap_empty = parse_codex_exec_jsonl([])
check("codex empty stream -> zero tokens", snap_empty.tokens.input_tokens == 0)
check(
    "codex empty stream still exact_run",
    snap_empty.attribution is AttributionLevel.EXACT_RUN,
)

check(
    "codex bad usage_mode rejected",
    raises(ValueError, lambda: parse_codex_exec_jsonl([], usage_mode="bogus")),
)


# ── 3. Claude --print --output-format json adapter ───────────────────────────
print("[claude]")

with open(os.path.join(fixture_dir, "samples", "claude-print.json")) as f:
    claude_text = f.read()

snap = parse_claude_print_json(claude_text, run_id="run-claude-1")
check(
    "claude carries real total_cost_usd", snap.cost_usd == 0.15698, str(snap.cost_usd)
)
check(
    "claude session_id captured",
    snap.session_id == "00000000-0000-4000-8000-000000000000",
)
check("claude input_tokens", snap.tokens.input_tokens == 1)
check(
    "claude cache_creation_input_tokens",
    snap.tokens.cache_creation_input_tokens == 15605,
)
check("claude output_tokens", snap.tokens.output_tokens == 13)
check("claude model = dominant-cost model", snap.model == "claude-fable-5")
check("claude source label", snap.source == "claude_print_json")
check(
    "claude default attribution exact_run",
    snap.attribution is AttributionLevel.EXACT_RUN,
)
check("claude confidence high", snap.confidence == "high")
check("claude not ambiguous", snap.ambiguous_attribution is False)
check("claude run_id threaded", snap.run_id == "run-claude-1")

# a resumed session is the caller's call — exact_session is accepted
snap_sess = parse_claude_print_json(
    json.loads(claude_text), attribution=AttributionLevel.EXACT_SESSION
)
check(
    "claude accepts exact_session from caller",
    snap_sess.attribution is AttributionLevel.EXACT_SESSION,
)
check("claude exact_session still high confidence", snap_sess.confidence == "high")

# claude adapter refuses an attribution it cannot honestly claim
check(
    "claude rejects observed_window attribution",
    raises(
        ValueError,
        lambda: parse_claude_print_json(
            claude_text, attribution=AttributionLevel.OBSERVED_WINDOW
        ),
    ),
)
check(
    "claude rejects non-object payload",
    raises(TypeError, lambda: parse_claude_print_json("[1,2,3]")),
)


# ── 4. normalized contract honesty invariants ───────────────────────────────
print("[contract]")

# attribution -> confidence mapping is shared, not re-derived
check("exact_run -> high", confidence_for(AttributionLevel.EXACT_RUN) == "high")
check(
    "observed_session_delta -> medium",
    confidence_for(AttributionLevel.OBSERVED_SESSION_DELTA) == "medium",
)
check(
    "observed_window -> low", confidence_for(AttributionLevel.OBSERVED_WINDOW) == "low"
)

# window / manual levels are ambiguous by construction — the caller cannot
# accidentally present an account-window number as clean per-run truth
win = CostSnapshot(
    provider="codex",
    surface="usage",
    attribution=AttributionLevel.OBSERVED_WINDOW,
    source="codex_usage",
    cost_usd=1.23,
)
check(
    "observed_window auto-sets ambiguous_attribution", win.ambiguous_attribution is True
)
manual = CostSnapshot(
    provider="manual",
    surface="paste",
    attribution=AttributionLevel.MANUAL_ESTIMATE,
    source="manual",
)
check("manual_estimate is ambiguous", manual.ambiguous_attribution is True)

# TokenUsage math
t = TokenUsage(input_tokens=100, output_tokens=20, cached_input_tokens=30)
check("billable = input - cached", t.billable_input_tokens == 70)
check(
    "billable floors at 0 when cache >= input",
    TokenUsage(input_tokens=10, cached_input_tokens=25).billable_input_tokens == 0,
)
summed = TokenUsage(input_tokens=5, output_tokens=3).add(
    TokenUsage(input_tokens=7, output_tokens=1)
)
check(
    "TokenUsage.add sums fields",
    summed.input_tokens == 12 and summed.output_tokens == 4,
)

# type/value guards
check(
    "negative tokens rejected", raises(ValueError, lambda: TokenUsage(input_tokens=-1))
)
check(
    "bool token rejected (not silently int)",
    raises(TypeError, lambda: TokenUsage(input_tokens=True)),
)
check(
    "negative cost rejected",
    raises(
        ValueError,
        lambda: CostSnapshot(
            provider="p",
            surface="s",
            attribution=AttributionLevel.EXACT_RUN,
            source="x",
            cost_usd=-0.5,
        ),
    ),
)
check(
    "non-enum attribution rejected",
    raises(
        TypeError,
        lambda: CostSnapshot(
            provider="p", surface="s", attribution="exact_run", source="x"
        ),
    ),
)

# to_dict is self-describing: value label, confidence, and contract version
d = win.to_dict()
check("to_dict emits attribution value string", d["attribution"] == "observed_window")
check("to_dict emits confidence", d["confidence"] == "low")
check("to_dict emits schema_version", d["schema_version"] == COST_SCHEMA_VERSION)
check(
    "to_dict nests tokens dict",
    isinstance(d["tokens"], dict) and "input_tokens" in d["tokens"],
)


# ── verdict ──────────────────────────────────────────────────────────────────
if failures:
    print(f"\ncost-adapter check failed: {failures}")
    sys.exit(1)
print("\ncost-adapter check passed")
