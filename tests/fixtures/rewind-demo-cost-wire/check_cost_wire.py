# SPDX-License-Identifier: Apache-2.0
#
# Wire assertions for the cost open-layer event (msg_type 30008). Proves the
# step the parse-layer cost fixture deferred: a normalized CostSnapshot becomes
# a rewind journal event that decodes without the runtime that wrote it.
#
# It asserts four things, no native binding and no journal writer required:
#   1. cost_wire.snapshot_to_event maps the parse-layer CostSnapshot onto the
#      wire form field-for-field, and the honesty invariant survives the trip —
#      a tokens-only provider lands cost_usd_known=False with a 0.0 placeholder,
#      never a fabricated cost; a window-level source stays ambiguous;
#   2. the attribution label and capture layer ride the event correctly;
#   3. the checked-in rewind_events.bfbs — the blob the bundle content-addresses
#      and pins per run — carries the CostSnapshot table's shape, so a reader
#      with only the bundle decodes it through reflection (the moat property);
#   4. bundle.emit binds msg_type 30008 -> CostSnapshot at SCHEMA_VERSION 2.
#
# Needs flatbuffers (run under `uv run --frozen python`), but not pykungfu: it
# stubs only the top-level kungfu package so kungfu/__init__.py's native import
# is skipped while the real kungfu.rewind.* modules load from disk.
#
# Usage: check_cost_wire.py <fixture-dir>

import hashlib
import json
import os
import sys
import tempfile
import types

fixture_dir = (
    sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
)
core_src = os.path.abspath(
    os.path.join(fixture_dir, "..", "..", "..", "framework", "core", "src", "python")
)
sys.path.insert(0, core_src)

# Stub ONLY the top-level kungfu package. kungfu/__init__.py imports the native
# pykungfu binding this wire test does not need; a stub with a real __path__ lets
# the real kungfu.rewind, kungfu.rewind.events, kungfu.rewind.fb.*,
# kungfu.rewind.cost.* and kungfu.rewind.cost_wire still import from disk (none
# of them touch the native binding). bundle.py calls kungfu.schema_data_path at
# import time, so the stub provides the source-layout resolver.
if "kungfu" not in sys.modules:
    _m = types.ModuleType("kungfu")
    _m.__path__ = [os.path.join(core_src, "kungfu")]
    _m.schema_data_path = lambda module_file, name: os.path.join(
        os.path.dirname(module_file), name
    )
    sys.modules["kungfu"] = _m

from kungfu.rewind import (  # noqa: E402
    MSG_COST_SNAPSHOT,
    MSG_TYPE_NAMES,
    SCHEMA_VERSION,
    bundle,
    cost_wire,
    reflection_fb,
)
from kungfu.rewind.cost.model import (  # noqa: E402
    AttributionLevel,
    CostSnapshot,
    TokenUsage,
)
from kungfu.rewind.fb.Attribution import Attribution as FbAttribution  # noqa: E402
from kungfu.rewind.fb.CaptureLayer import CaptureLayer as FbCaptureLayer  # noqa: E402
from kungfu.rewind.fb.CostSnapshot import CostSnapshot as FbCostSnapshot  # noqa: E402

failures = []


def check(name, ok, detail=""):
    if not ok:
        failures.append(name + (f" ({detail})" if detail else ""))


def decode(payload):
    return FbCostSnapshot.GetRootAs(bytes(payload), 0)


# --- msg_type allocation and version bump -----------------------------------
check("MSG_COST_SNAPSHOT is 30008", MSG_COST_SNAPSHOT == 30008, str(MSG_COST_SNAPSHOT))
check(
    "30008 registered as CostSnapshot",
    MSG_TYPE_NAMES.get(MSG_COST_SNAPSHOT) == "CostSnapshot",
)
# CostSnapshot was added at SCHEMA_VERSION 2; later additive events bump it
# further, so assert the floor, not an exact value that a new event would break.
check("SCHEMA_VERSION >= 2", SCHEMA_VERSION >= 2, str(SCHEMA_VERSION))

# --- exact_run, tokens-only (Codex exec): cost stays unknown, never 0.0 ------
codex = CostSnapshot(
    provider="codex",
    surface="exec_json",
    attribution=AttributionLevel.EXACT_RUN,
    source="codex_exec_json",
    tokens=TokenUsage(
        input_tokens=1200,
        output_tokens=340,
        cached_input_tokens=200,
        reasoning_tokens=64,
    ),
    model="gpt-5-codex",
    run_id="run-abc",
    work_id="work-1",
    cost_usd=None,
)
msg_type, payload = cost_wire.snapshot_to_event(codex)
ev = decode(payload)
check("codex event msg_type is 30008", msg_type == MSG_COST_SNAPSHOT)
check("codex run_id", ev.RunId() == b"run-abc")
check("codex work_id", ev.WorkId() == b"work-1")
check("codex provider", ev.Provider() == b"codex")
check("codex surface", ev.Surface() == b"exec_json")
check("codex model", ev.Model() == b"gpt-5-codex")
check("codex source", ev.Source() == b"codex_exec_json")
check("codex attribution=ExactRun", ev.Attribution() == FbAttribution.ExactRun)
check("codex layer defaults to Adapter", ev.Layer() == FbCaptureLayer.Adapter)
check("codex input_tokens", ev.InputTokens() == 1200)
check("codex output_tokens", ev.OutputTokens() == 340)
check("codex cached_input_tokens", ev.CachedInputTokens() == 200)
check("codex reasoning_tokens", ev.ReasoningTokens() == 64)
check("codex cost_usd_known is False", not ev.CostUsdKnown())
check("codex cost_usd placeholder 0.0", ev.CostUsd() == 0.0)
check("codex not ambiguous", not ev.AmbiguousAttribution())

# --- exact_session with a real dollar cost (Claude print) -------------------
claude = CostSnapshot(
    provider="claude",
    surface="print_json",
    attribution=AttributionLevel.EXACT_SESSION,
    source="claude_print_json",
    tokens=TokenUsage(
        input_tokens=800, output_tokens=500, cache_creation_input_tokens=128
    ),
    model="claude-sonnet-5",
    run_id="run-xyz",
    session_id="sess-9",
    work_id="work-1",
    cost_usd=0.0123,
)
_, payload = cost_wire.snapshot_to_event(claude)
ev = decode(payload)
check("claude attribution=ExactSession", ev.Attribution() == FbAttribution.ExactSession)
check("claude session_id", ev.SessionId() == b"sess-9")
check("claude cache_creation_input_tokens", ev.CacheCreationInputTokens() == 128)
check("claude cost_usd_known is True", bool(ev.CostUsdKnown()))
check("claude cost_usd carried", abs(ev.CostUsd() - 0.0123) < 1e-9, str(ev.CostUsd()))

# --- observed window: ambiguous by nature, must survive to the wire ---------
window = CostSnapshot(
    provider="claude",
    surface="usage",
    attribution=AttributionLevel.OBSERVED_WINDOW,
    source="claude_usage",
    cost_usd=None,
)
_, payload = cost_wire.snapshot_to_event(window)
ev = decode(payload)
check(
    "window attribution=ObservedWindow",
    ev.Attribution() == FbAttribution.ObservedWindow,
)
check("window is ambiguous", bool(ev.AmbiguousAttribution()))

# --- layer override: a supervisor-parsed run is not adapter evidence --------
_, payload = cost_wire.snapshot_to_event(codex, layer=FbCaptureLayer.Supervisor)
check(
    "layer override reaches the wire",
    decode(payload).Layer() == FbCaptureLayer.Supervisor,
)

# --- moat: the pinned bfbs carries the CostSnapshot shape (schema-only) ------
blob = bundle.read_schema_blob()
schema = reflection_fb.Schema.GetRootAs(blob, 0)
objects = {
    schema.Objects(i).Name().decode(): schema.Objects(i)
    for i in range(schema.ObjectsLength())
}
cost_obj = objects.get("kungfu.rewind.fb.CostSnapshot")
check("bfbs carries CostSnapshot table", cost_obj is not None)
if cost_obj is not None:
    field_names = {
        cost_obj.Fields(i).Name().decode() for i in range(cost_obj.FieldsLength())
    }
    for required in (
        "run_id",
        "work_id",
        "session_id",
        "layer",
        "attribution",
        "input_tokens",
        "cached_input_tokens",
        "cache_creation_input_tokens",
        "reasoning_tokens",
        "cost_usd",
        "cost_usd_known",
        "ambiguous_attribution",
        "raw_ref",
    ):
        check(f"bfbs CostSnapshot.{required}", required in field_names)

# --- bundle binds 30008 into the run manifest at version 2 ------------------
bundle_dir = tempfile.mkdtemp(prefix="cost-wire-")
manifest_path = bundle.emit(
    bundle_dir,
    "/fake/journal/root",
    {
        "mode": "LIVE",
        "category": "SYSTEM",
        "group": "rewind",
        "name": "run-abc",
        "dest": 0,
    },
)
with open(manifest_path) as f:
    manifest = json.load(f)
binding = manifest.get("schema_bindings", {}).get(str(MSG_COST_SNAPSHOT), {})
check("manifest binds 30008 -> CostSnapshot", binding.get("name") == "CostSnapshot")
check(
    "manifest binding schema_version matches",
    binding.get("schema_version") == SCHEMA_VERSION,
)
check(
    "manifest binding hash matches blob",
    binding.get("schema_hash") == hashlib.sha256(blob).hexdigest(),
)

if failures:
    print(f"cost wire check failed: {failures}")
    sys.exit(1)
print("cost wire check passed")
