# SPDX-License-Identifier: Apache-2.0
#
# Assertions for the kfx action-envelope fixture: a run in which a kfx compiled its
# own schema, registered it, and emitted an event of its own action_type. Proves
# the run-internal loop — the event lands in the journal, the schema binds into
# the bundle under the action type, and the event decodes by reflection with no
# generated accessor. Runs inside the dev kfc environment (needs pykungfu).
#
# Usage: check_capture.py <runtime-dir> <run-id>

import hashlib
import json
import os
import sys

_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kungfu"))

import kungfu  # noqa: E402

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE  # noqa: E402
from kungfu.rewind import ACTION_RUN_BEGIN, ACTION_RUN_END  # noqa: E402
from kungfu.rewind.fb.RunEnd import RunEnd  # noqa: E402
from kungfu.rewind.replay import BundleDecoder  # noqa: E402
from kungfu.rewind.wire import unwrap_event  # noqa: E402

schema = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime

runtime_dir, run_id = sys.argv[1], sys.argv[2]
KFX_ACTION_TYPE = "kfx.fixture.event"
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


locator = yjj.locator(runtime_dir)
location = yjj.location(
    schema.enums.mode.LIVE, schema.enums.location_role.SYSTEM, "rewind", run_id, locator
)

# the kfx event landed in the journal under the generic action carrier
all_frames = []
for header, frame_payload in yjj.assemble(location, 0).read_bytes(
    CARRIER_ACTION_ENVELOPE
):
    event = unwrap_event(frame_payload)
    if event is not None:
        action_type, payload = event
        all_frames.append((action_type, payload))
kfx_frames = [
    payload for action_type, payload in all_frames if action_type == KFX_ACTION_TYPE
]
check("one kfx event frame in the journal", len(kfx_frames) == 1)

bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
with open(os.path.join(bundle_dir, "manifest.json")) as f:
    manifest = json.load(f)
binding = manifest["schema_bindings"].get(KFX_ACTION_TYPE)
check("kfx schema bound in the run manifest", binding is not None)
if binding:
    check(
        "binding marked origin=kfx",
        binding.get("origin") == "kfx",
        str(binding.get("origin")),
    )
    check(
        "binding table name qualified",
        (binding.get("name") or "").endswith("KfxEvent"),
        binding.get("name"),
    )
    # first-party Rewind bindings still present alongside the kfx one
    check(
        "first-party Rewind bindings preserved",
        ACTION_RUN_BEGIN in manifest["schema_bindings"],
    )
    blob = os.path.join(bundle_dir, "schemas", binding["schema_hash"] + ".bfbs")
    check(
        "kfx schema blob content-addressed",
        os.path.exists(blob)
        and hashlib.sha256(open(blob, "rb").read()).hexdigest()
        == binding["schema_hash"],
    )

# the event decodes by reflection over the kfx .bfbs — no generated accessor
if kfx_frames and binding:
    payload = kfx_frames[0]
    facts = BundleDecoder(bundle_dir).decode(KFX_ACTION_TYPE, bytes(payload))
    check(
        "kfx event decodes by reflection",
        facts == {"id": 42, "label": "kfx-live", "score": 3.5, "tags": ["p", "q"]},
        str(facts),
    )

# the run bracket is intact and clean
end_frames = [
    payload for action_type, payload in all_frames if action_type == ACTION_RUN_END
]
check("RunEnd present", len(end_frames) == 1)
if end_frames:
    end = RunEnd.GetRootAs(bytes(end_frames[0]), 0)
    check("RunEnd exit_code == 0", end.ExitCode() == 0)

if failures:
    print(f"kfx capture check failed: {failures}")
    sys.exit(1)
print("kfx capture check passed")
