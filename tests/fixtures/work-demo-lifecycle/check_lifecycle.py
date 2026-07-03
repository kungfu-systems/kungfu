# SPDX-License-Identifier: Apache-2.0
#
# Lifecycle assertions for the work profile fixture (gates P1/P2 slice: the
# default vocabulary exists and the lifecycle runs end to end). Runs inside
# the dev kfc environment (needs pykungfu).
#
# Usage: check_lifecycle.py <runtime-dir> <work-id>

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

from kungfu.work import (  # noqa: E402
    MSG_ARTIFACT_RECORDED,
    MSG_CHECKPOINT_RECORDED,
    MSG_DECISION_RECORDED,
    MSG_NEXT_ACTION_SET,
    MSG_RUN_LINKED,
    MSG_VALIDATION_RECORDED,
    MSG_WORK_ITEM_CREATED,
    MSG_WORK_STATUS_CHANGED,
)
from kungfu.work import store  # noqa: E402

runtime_dir, work_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


# ── journal: every event family present with the expected count ──────────
frames = store.read_frames(runtime_dir)
counts = {}
for _gen_time, msg_type, _payload in frames:
    counts[msg_type] = counts.get(msg_type, 0) + 1

expected_counts = {
    MSG_WORK_ITEM_CREATED: 1,
    MSG_WORK_STATUS_CHANGED: 7,  # start/pause/resume/block/resume/ready/done
    MSG_NEXT_ACTION_SET: 1,
    MSG_CHECKPOINT_RECORDED: 1,
    MSG_DECISION_RECORDED: 1,
    MSG_VALIDATION_RECORDED: 1,
    MSG_ARTIFACT_RECORDED: 1,
    MSG_RUN_LINKED: 1,
}
for msg_type, expected in expected_counts.items():
    check(
        f"{store.MSG_TYPE_NAMES[msg_type]} x{expected}",
        counts.get(msg_type, 0) == expected,
        f"got {counts.get(msg_type, 0)}",
    )

# frames arrive in event-time order
gen_times = [frame[0] for frame in frames]
check("frames ordered by gen_time", gen_times == sorted(gen_times))

# ── projection: the fold carries every fact of the vocabulary ─────────────
items = store.load(runtime_dir)
check("projection contains the item", work_id in items)
item = items.get(work_id, {})

check("status folded to done", item.get("status") == "done")
check("title folded", item.get("title") == "Fixture lifecycle item")
check("kind folded", item.get("kind") == "task")
check("summary folded", item.get("summary") == "work profile lifecycle fixture")
check("created_time set", bool(item.get("created_time")))
check("next action folded", item.get("next_action") == "wire the projection")
check("checkpoint folded", len(item.get("checkpoints", [])) == 1)
check("decision folded", len(item.get("decisions", [])) == 1)
check(
    "decision fields folded",
    item.get("decisions", [{}])[0].get("decided_by") == "fixture",
)
check("validation folded", len(item.get("validations", [])) == 1)
check(
    "validation result folded",
    item.get("validations", [{}])[0].get("result") == "pass",
)
check("artifact folded", len(item.get("artifacts", [])) == 1)
check("linked run folded", len(item.get("runs", [])) == 1)
check(
    "linked run id folded",
    item.get("runs", [{}])[0].get("run_id") == "runfixture01",
)

status_history = [
    row["status"] for row in item.get("history", []) if row["event"] == "status"
]
check(
    "lifecycle transitions in order",
    status_history
    == ["active", "waiting", "active", "blocked", "active", "ready", "done"],
    f"got {status_history}",
)

# ── store manifest: schema bindings pinned, content-addressed ─────────────
store_dir = os.path.join(runtime_dir, "work", "store")
manifest_path = os.path.join(store_dir, "manifest.json")
check("store manifest exists", os.path.exists(manifest_path))
if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)
    bindings = manifest.get("schema_bindings", {})
    check("manifest binds all eight event types", len(bindings) == 8)
    hashes = {binding["schema_hash"] for binding in bindings.values()}
    check("manifest binds a single schema", len(hashes) == 1)
    if len(hashes) == 1:
        schema_hash = hashes.pop()
        blob_path = os.path.join(store_dir, "schemas", schema_hash + ".bfbs")
        check("schema blob exists", os.path.exists(blob_path))
        if os.path.exists(blob_path):
            with open(blob_path, "rb") as f:
                blob = f.read()
            check(
                "schema blob content-addressed",
                hashlib.sha256(blob).hexdigest() == schema_hash,
            )

print(f"[work-demo-lifecycle] {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
