# SPDX-License-Identifier: Apache-2.0
#
# Import assertions for the Atlas profile fixture (P7 dogfood slice: a
# control-plane tree becomes a queryable local projection while the source
# stays authoritative). Runs inside the dev kfc environment (needs pykungfu).
#
# Usage: check_import.py <runtime-dir> <latest-import-id>

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

from kungfu.atlas import (  # noqa: E402
    MSG_GOAL_SNAPSHOT,
    MSG_IMPORT_BEGIN,
    MSG_IMPORT_END,
    MSG_MARKER_SNAPSHOT,
    MSG_MISSION_SNAPSHOT,
)
from kungfu.atlas import store  # noqa: E402
from kungfu.atlas.fb.ImportEnd import ImportEnd  # noqa: E402

runtime_dir, latest_import_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


# ── journal: two complete batches, counts double the single batch ─────────
frames = store.read_frames(runtime_dir)
counts = {}
for _gen_time, msg_type, _payload in frames:
    counts[msg_type] = counts.get(msg_type, 0) + 1

expected = {
    MSG_IMPORT_BEGIN: 2,
    MSG_MISSION_SNAPSHOT: 2,  # 1 mission x 2 imports
    MSG_GOAL_SNAPSHOT: 4,  # 2 goals x 2 imports
    MSG_MARKER_SNAPSHOT: 2,  # 1 valid marker x 2 imports
    MSG_IMPORT_END: 2,
}
for msg_type, want in expected.items():
    check(
        f"{store.MSG_TYPE_NAMES[msg_type]} x{want}",
        counts.get(msg_type, 0) == want,
        f"got {counts.get(msg_type, 0)}",
    )

# warnings are diagnostic and counted: broken.json in the marker dir
ends = [
    ImportEnd.GetRootAs(payload, 0)
    for _gen_time, msg_type, payload in frames
    if msg_type == MSG_IMPORT_END
]
check(
    "each batch counted one warning (broken.json)",
    all(e.Warnings() == 1 for e in ends),
    f"got {[e.Warnings() for e in ends]}",
)

# ── projection: the fold picks the LATEST completed batch ─────────────────
projection = store.load(runtime_dir)
check("projection exists", projection is not None)
if projection:
    check(
        "projection is the latest batch",
        projection["import_id"] == latest_import_id,
        f"got {projection['import_id']}",
    )
    check("one mission folded", len(projection["missions"]) == 1)
    check("two goals folded", len(projection["goals"]) == 2)
    check("one marker folded", len(projection["markers"]) == 1)

    mission = projection["missions"].get("demo-platform", {})
    check("mission stage folded", mission.get("stage_name") == "demo-stage")
    check("mission next_review folded", mission.get("next_review") == "2026-01-15")

    goal = projection["goals"].get("2026-01-02-demo-importer", {})
    check("goal mission link folded", goal.get("mission_id") == "demo-platform")
    check(
        "goal external coords folded",
        goal.get("external_branch") == "feature/demo-slice"
        and goal.get("external_head") == "abc1234"
        and goal.get("external_ready_ref") == "https://example.invalid/pr/1",
    )
    check("goal not archived", goal.get("archived") is False)

    archived = projection["goals"].get("2026-01-01-demo-archived", {})
    check("archived goal folded with flag", archived.get("archived") is True)

    marker = projection["markers"].get("ai/demo/importer", {})
    check(
        "marker folded",
        marker.get("status") == "ready"
        and marker.get("ready") is True
        and marker.get("ready_scope") == "final",
    )
    check(
        "marker path is repo-relative",
        marker.get("marker_path") == "reviews/worktree-status/ai__demo__importer.json",
    )

# ── store manifest: schema bindings pinned, content-addressed ─────────────
store_dir = os.path.join(runtime_dir, "atlas", "store")
manifest_path = os.path.join(store_dir, "manifest.json")
check("store manifest exists", os.path.exists(manifest_path))
if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)
    bindings = manifest.get("schema_bindings", {})
    check("manifest binds all five event types", len(bindings) == 5)
    check(
        "manifest states the authority boundary",
        "authority_boundary" in manifest,
    )
    hashes = {binding["schema_hash"] for binding in bindings.values()}
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

print(f"[atlas-demo-import] {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
