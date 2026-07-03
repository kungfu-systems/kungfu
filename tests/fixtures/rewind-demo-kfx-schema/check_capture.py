# SPDX-License-Identifier: Apache-2.0
#
# Assertions for the kfx open-layer fixture: a run in which a kfx compiled its
# own schema, registered it, and emitted an event of its own msg_type. Proves
# the run-internal loop — the event lands in the journal, the schema binds into
# the bundle under the kfx band, and the event decodes by reflection with no
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
sys.path.insert(0, os.path.join(_core, "dist", "kfc"))

import kungfu

from kungfu.rewind import MSG_RUN_END
from kungfu.rewind.fb.RunEnd import RunEnd
from kungfu.rewind.replay import BundleDecoder

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

runtime_dir, run_id = sys.argv[1], sys.argv[2]
KFX_MSG_TYPE = 40001
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


locator = yjj.locator(runtime_dir)
location = yjj.location(
    lf.enums.mode.LIVE, lf.enums.category.SYSTEM, "rewind", run_id, locator
)

# the kfx event frame landed in the journal under its own msg_type
kfx_frames = yjj.assemble(location, 0).read_bytes(KFX_MSG_TYPE)
check("one kfx event frame in the journal", len(kfx_frames) == 1)
check("kfx msg_type is in the third-party band", 40000 <= KFX_MSG_TYPE <= 49999)

bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
with open(os.path.join(bundle_dir, "manifest.json")) as f:
    manifest = json.load(f)
binding = manifest["schema_bindings"].get(str(KFX_MSG_TYPE))
check("kfx schema bound in the run manifest", binding is not None)
if binding:
    check("binding marked origin=kfx", binding.get("origin") == "kfx", str(binding.get("origin")))
    check("binding table name qualified", (binding.get("name") or "").endswith("KfxEvent"),
          binding.get("name"))
    # first-party Rewind bindings still present alongside the kfx one
    check("first-party Rewind bindings preserved",
          "30001" in manifest["schema_bindings"])
    blob = os.path.join(bundle_dir, "schemas", binding["schema_hash"] + ".bfbs")
    check("kfx schema blob content-addressed",
          os.path.exists(blob)
          and hashlib.sha256(open(blob, "rb").read()).hexdigest() == binding["schema_hash"])

# the event decodes by reflection over the kfx .bfbs — no generated accessor
if kfx_frames and binding:
    _, payload = kfx_frames[0]
    facts = BundleDecoder(bundle_dir).decode(KFX_MSG_TYPE, bytes(payload))
    check(
        "kfx event decodes by reflection",
        facts == {"id": 42, "label": "kfx-live", "score": 3.5, "tags": ["p", "q"]},
        str(facts),
    )

# the run bracket is intact and clean
end_frames = yjj.assemble(location, 0).read_bytes(MSG_RUN_END)
check("RunEnd present", len(end_frames) == 1)
if end_frames:
    end = RunEnd.GetRootAs(bytes(end_frames[0][1]), 0)
    check("RunEnd exit_code == 0", end.ExitCode() == 0)

if failures:
    print(f"kfx capture check failed: {failures}")
    sys.exit(1)
print("kfx capture check passed")
