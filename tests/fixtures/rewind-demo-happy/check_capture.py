# SPDX-License-Identifier: Apache-2.0
#
# Capture assertions for the happy-path fixture (gate G2: one command produces
# a local run store). Runs inside the dev kfc environment (needs pykungfu).
#
# Usage: check_capture.py <runtime-dir> <run-id>

import hashlib
import json
import os
import sys

# Self-contained path bootstrap: the fixture runs outside the dev entry, so it
# wires the core python package and the built dist/kfc (pykungfu) itself.
_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kfc"))

import kungfu

from kungfu.rewind import MSG_RUN_BEGIN, MSG_RUN_END, MSG_TYPE_NAMES
from kungfu.rewind.fb.RunBegin import RunBegin
from kungfu.rewind.fb.RunEnd import RunEnd

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

runtime_dir, run_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


locator = yjj.locator(runtime_dir)
location = yjj.location(
    lf.enums.mode.LIVE, lf.enums.category.SYSTEM, "rewind", run_id, locator
)
asm = yjj.assemble(location, 0)

begin_frames = asm.read_bytes(MSG_RUN_BEGIN)
check("RunBegin frame present", len(begin_frames) == 1)
if begin_frames:
    header, payload = begin_frames[0]
    begin = RunBegin.GetRootAs(bytes(payload), 0)
    check(
        "RunBegin.run_id matches",
        (begin.RunId() or b"").decode() == run_id,
        (begin.RunId() or b"").decode(),
    )
    check("RunBegin.gen_time set", header.gen_time > 0)

asm2 = yjj.assemble(location, 0)
end_frames = asm2.read_bytes(MSG_RUN_END)
check("RunEnd frame present", len(end_frames) == 1)
if end_frames:
    _, payload = end_frames[0]
    end = RunEnd.GetRootAs(bytes(payload), 0)
    check("RunEnd.run_id matches", (end.RunId() or b"").decode() == run_id)
    check("RunEnd.exit_code == 0", end.ExitCode() == 0)

bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
manifest_path = os.path.join(bundle_dir, "manifest.json")
check("bundle manifest exists", os.path.exists(manifest_path), manifest_path)
if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)
    bindings = manifest.get("schema_bindings", {})
    check(
        "all rewind msg_types bound",
        set(bindings.keys()) == {str(t) for t in MSG_TYPE_NAMES},
    )
    hashes = {b["schema_hash"] for b in bindings.values()}
    check("single schema hash across bindings", len(hashes) == 1)
    if len(hashes) == 1:
        schema_hash = hashes.pop()
        blob_path = os.path.join(bundle_dir, "schemas", schema_hash + ".bfbs")
        check("schema blob exists", os.path.exists(blob_path))
        if os.path.exists(blob_path):
            with open(blob_path, "rb") as f:
                check(
                    "schema blob content-addressed",
                    hashlib.sha256(f.read()).hexdigest() == schema_hash,
                )

if failures:
    print(f"capture check failed: {failures}")
    sys.exit(1)
print("capture check passed")
