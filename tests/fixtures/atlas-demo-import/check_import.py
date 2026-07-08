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
# wires the core python package and the built dist/kungfu (pykungfu) itself.
_core = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "framework", "core")
)
sys.path.insert(0, os.path.join(_core, "src", "python"))
sys.path.insert(0, os.path.join(_core, "dist", "kungfu"))

from kungfu.atlas import (  # noqa: E402
    ACTION_GOAL_SNAPSHOT,
    ACTION_IMPORT_BEGIN,
    ACTION_IMPORT_END,
    ACTION_MARKER_SNAPSHOT,
    ACTION_MISSION_SNAPSHOT,
    ACTION_TYPE_NAMES,
    MSG_ACTION_ENVELOPE,
)
from kungfu.atlas import store  # noqa: E402

runtime_dir, latest_import_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


# ── journal: two complete batches, one v4 envelope msg_type ───────────────
frames = store.read_frames(runtime_dir)
counts = {}
for _gen_time, action_type, _payload in frames:
    counts[action_type] = counts.get(action_type, 0) + 1

expected = {
    ACTION_IMPORT_BEGIN: 2,
    ACTION_MISSION_SNAPSHOT: 2,  # 1 mission x 2 imports
    ACTION_GOAL_SNAPSHOT: 4,  # 2 goals x 2 imports
    ACTION_MARKER_SNAPSHOT: 2,  # 1 valid marker x 2 imports
    ACTION_IMPORT_END: 2,
}
for action_type, want in expected.items():
    check(
        f"{ACTION_TYPE_NAMES[action_type]} x{want}",
        counts.get(action_type, 0) == want,
        f"got {counts.get(action_type, 0)}",
    )

# warnings are diagnostic and counted: broken.json in the marker dir
ends = [
    envelope
    for _gen_time, action_type, envelope in frames
    if action_type == ACTION_IMPORT_END
]
check(
    "each batch counted one warning (broken.json)",
    all(e.get("batch", {}).get("warnings") == 1 for e in ends),
    f"got {[e.get('batch', {}).get('warnings') for e in ends]}",
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
    check("manifest binds the v4 action envelope", len(bindings) == 1)
    check(
        "manifest uses the reset envelope msg_type",
        str(MSG_ACTION_ENVELOPE) in bindings,
    )
    check(
        "manifest states the authority boundary",
        "authority_boundary" in manifest,
    )
    check(
        "manifest dispatches business semantics by action_type",
        manifest.get("semantic_dispatch") == "action_type",
    )

# ── payload manifest: every imported source record is an action envelope ──
payload_manifest_path = os.path.join(store_dir, "imports", "latest.json")
check("payload manifest exists", os.path.exists(payload_manifest_path))
if os.path.exists(payload_manifest_path):
    with open(payload_manifest_path) as f:
        payload_manifest = json.load(f)
    entries = payload_manifest.get("entries", [])
    action_entries = [
        entry for entry in entries if isinstance(entry.get("action"), dict)
    ]
    check(
        "all source records have action envelopes", len(action_entries) == len(entries)
    )

    frame_index = store.read_action_frame_index(runtime_dir)
    check("journal action frame index is populated", len(frame_index) >= len(entries))
    for entry in action_entries:
        action = entry["action"]
        journal = action.get("journal", {})
        frame = frame_index.get(
            (
                journal.get("frame_uid"),
                journal.get("gen_time"),
            )
        )
        check(
            f"action frame exists for {entry.get('kind')}:{entry.get('source_id')}",
            frame is not None,
        )
        if frame is not None:
            payload = frame.get("_payload", b"")
            payload = payload[: journal.get("data_length", len(payload))]
            check(
                f"action frame hash matches {entry.get('kind')}:{entry.get('source_id')}",
                hashlib.sha256(payload).hexdigest()
                == journal.get("journal_payload_hash"),
            )
        check(
            f"action payload hash matches {entry.get('kind')}:{entry.get('source_id')}",
            action.get("payload", {}).get("hash") == entry.get("payload_hash"),
        )
        check(
            f"action journal uses envelope msg_type for {entry.get('kind')}:{entry.get('source_id')}",
            journal.get("msg_type") == MSG_ACTION_ENVELOPE,
        )

    fsck = store.fsck(runtime_dir)
    check("atlas store fsck passes", fsck.get("ok"), json.dumps(fsck.get("errors")))

print(f"[atlas-demo-import] {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
