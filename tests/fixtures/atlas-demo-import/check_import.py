# SPDX-License-Identifier: Apache-2.0
#
# Import assertions for the Atlas profile fixture (P7 dogfood slice: a
# control-plane tree becomes a queryable local projection while the source
# stays authoritative). Runs inside the dev kfc environment (needs pykungfu).
#
# Usage: check_import.py <runtime-dir> <latest-import-id>
#
# The episode section is destructive at its end (it deletes the import event
# journal to prove sealed-episode fsck catches the loss), so it must stay the
# last section and the fixture must not reuse the runtime afterwards.

import glob
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
    CARRIER_ATLAS_ACTION,
)
from kungfu.atlas import store  # noqa: E402

runtime_dir, latest_import_id = sys.argv[1], sys.argv[2]
failures = []


def check(name, ok, detail=""):
    print(f"  {'ok' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
    if not ok:
        failures.append(name)


# ── journal: two complete batches, one v4 action envelope carrier ─────────
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
        "manifest uses the action envelope carrier",
        str(CARRIER_ATLAS_ACTION) in bindings,
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
            f"action journal uses envelope carrier for {entry.get('kind')}:{entry.get('source_id')}",
            journal.get("carrier_type") == CARRIER_ATLAS_ACTION,
        )

    fsck = store.fsck(runtime_dir)
    check("atlas store fsck passes", fsck.get("ok"), json.dumps(fsck.get("errors")))

# ── episode: one import batch = one sealed Episode ────────────────────────
from kungfu.storage import service as storage_service  # noqa: E402

listed = storage_service.episode_list(runtime_dir, limit=0).get("episodes", [])
atlas_episodes = [
    row
    for row in listed
    if str(row.get("open", {}).get("source") or "").startswith("atlas:imp")
]
check(
    "one sealed episode per import batch",
    len(atlas_episodes) == 2
    and all(row.get("closed") is True for row in atlas_episodes),
    f"got {[(row.get('episode_id'), row.get('closed')) for row in atlas_episodes]}",
)

episode_id = 0
if os.path.exists(payload_manifest_path):
    episode_id = int(payload_manifest.get("episode_id") or 0)
    check("manifest names the sealing episode", episode_id > 0, f"got {episode_id}")
check(
    "store status names the sealing episode",
    store.status(runtime_dir).get("episode_id") == episode_id,
)

if episode_id:
    inspected = storage_service.episode_inspect(runtime_dir, episode_id=episode_id)
    episode = inspected.get("episode", {})
    check(
        "episode source names the import",
        episode.get("open", {}).get("source") == f"atlas:{latest_import_id}",
        f"got {episode.get('open', {}).get('source')}",
    )
    records = episode.get("records", [])
    attached = [
        records[index]
        for index in episode.get("frame_indices", [])
        if 0 <= index < len(records)
    ]
    check(
        "episode frames == batch frames (begin + snapshots + end)",
        len(attached) == len(entries) + 2,
        f"got {len(attached)}, want {len(entries) + 2}",
    )
    payload_refs = [
        records[index]
        for index in episode.get("ref_indices", [])
        if 0 <= index < len(records)
        and records[index].get("body", {}).get("ref_kind") == 2
    ]
    present_hashes = {
        entry.get("payload_hash")
        for entry in entries
        if entry.get("payload_state") == "present" and entry.get("payload_hash")
    }
    check(
        "episode payload refs cover distinct present payloads",
        len(payload_refs) == len(present_hashes),
        f"got {len(payload_refs)}, want {len(present_hashes)}",
    )

    report = storage_service.fsck(
        runtime_dir, episode_id=episode_id, verify_frames=True
    )
    check(
        "episode fsck verify_frames green",
        report.get("ok") is True and report.get("degraded") is False,
        json.dumps(report.get("errors", []) + report.get("warnings", []))[:300],
    )
    check(
        "every batch frame receipt verified",
        report.get("checked", {}).get("episode_frames_verified") == len(entries) + 2,
        f"got {report.get('checked', {}).get('episode_frames_verified')}",
    )
    qualification = report.get("qualification", {})
    safe_capabilities = {
        capability.get("name")
        for capability in qualification.get("capabilities", [])
        if capability.get("safe") is True
    }
    check(
        "sealed batch qualifies for replay/depend_on",
        "replay" in safe_capabilities and "depend_on" in safe_capabilities,
        f"got {sorted(safe_capabilities)}",
    )

    # ── negative (destructive, keep last): losing the event journal must ──
    # fail the sealed episode instead of passing silently — the exact P10
    # blind spot: manifest present, projected journal page gone.
    pages = glob.glob(
        os.path.join(
            runtime_dir, "journal", "**", "atlas", "import", "**", "*.journal"
        ),
        recursive=True,
    )
    check("import event journal pages found", len(pages) > 0)
    for page in pages:
        os.remove(page)
    report = storage_service.fsck(
        runtime_dir, episode_id=episode_id, verify_frames=True
    )
    codes = {
        issue.get("code")
        for issue in report.get("issues", [])
        if issue.get("severity") == "error"
    }
    check(
        "sealed episode fails fsck after journal loss",
        report.get("ok") is False and "episode_attached_frame_missing" in codes,
        f"ok={report.get('ok')} codes={sorted(codes)}",
    )

print(f"[atlas-demo-import] {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
