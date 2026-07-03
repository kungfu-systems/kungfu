#  SPDX-License-Identifier: Apache-2.0
#
# The work store: one shared journal for all work items of a runtime home,
# short-lived single-writer appends, and the projection that folds the event
# stream into current items.
#
# Journal shape: standalone single-writer, same construction as the Rewind
# supervisor and the C++ slices — no master, no-op publisher, private bus.
# Every `kungfu work` mutation opens the writer, appends, and exits; the
# journal remains the fact source and current state is always a fold.
#
# Store manifest: like the Rewind trace bundle, the store pins its schema as
# a content-addressed .bfbs plus msg_type bindings (manifest.json), so the
# work journal decodes through FlatBuffers reflection without this runtime.

import hashlib
import json
import os
import uuid

import kungfu

from kungfu.work import (
    MSG_ARTIFACT_RECORDED,
    MSG_CHECKPOINT_RECORDED,
    MSG_DECISION_RECORDED,
    MSG_NEXT_ACTION_SET,
    MSG_RUN_LINKED,
    MSG_TYPE_NAMES,
    MSG_VALIDATION_RECORDED,
    MSG_WORK_ITEM_CREATED,
    MSG_WORK_STATUS_CHANGED,
    SCHEMA_VERSION,
    events,
)
from kungfu.work.fb.ArtifactRecorded import ArtifactRecorded
from kungfu.work.fb.CheckpointRecorded import CheckpointRecorded
from kungfu.work.fb.DecisionRecorded import DecisionRecorded
from kungfu.work.fb.NextActionSet import NextActionSet
from kungfu.work.fb.RunLinked import RunLinked
from kungfu.work.fb.ValidationRecorded import ValidationRecorded
from kungfu.work.fb.ValidationResult import ValidationResult
from kungfu.work.fb.WorkItemCreated import WorkItemCreated
from kungfu.work.fb.WorkStatus import WorkStatus
from kungfu.work.fb.WorkStatusChanged import WorkStatusChanged

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

PUBLIC_DEST = 0
WORK_GROUP = "work"
WORK_NAME = "items"

_BFBS_FILE = os.path.join(os.path.dirname(__file__), "work_events.bfbs")

STATUS_NAMES = {
    WorkStatus.Active: "active",
    WorkStatus.Waiting: "waiting",
    WorkStatus.Blocked: "blocked",
    WorkStatus.Ready: "ready",
    WorkStatus.Done: "done",
}
STATUS_BY_NAME = {name: value for value, name in STATUS_NAMES.items()}

RESULT_NAMES = {
    ValidationResult.Pass: "pass",
    ValidationResult.Fail: "fail",
}
RESULT_BY_NAME = {name: value for value, name in RESULT_NAMES.items()}


def new_work_id():
    return "w" + uuid.uuid4().hex[:8]


def _location(runtime_dir):
    locator = yjj.locator(runtime_dir)
    return yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.category.SYSTEM,
        WORK_GROUP,
        WORK_NAME,
        locator,
    )


def _text(value):
    return value.decode() if value is not None else None


class WorkStore:
    """Append side. One instance = one short-lived writer."""

    def __init__(self, runtime_dir):
        self.runtime_dir = runtime_dir
        self.location = _location(runtime_dir)
        # keep every piece alive on self — the writer borrows them without
        # owning their lifetime (same as the Rewind supervisor)
        self.publisher = yjj.noop_publisher()
        self.bus = yjj.bus(False)
        self.writer = yjj.writer(
            self.location, PUBLIC_DEST, True, self.publisher, False, self.bus, 0
        )

    def _append(self, msg_type, data):
        # the binding takes the payload as a byte sequence (list[int])
        self.writer.write_bytes(0, msg_type, list(data), len(data))

    def create(self, title, kind, summary):
        work_id = new_work_id()
        self._append(
            MSG_WORK_ITEM_CREATED,
            events.work_item_created(work_id, title, kind, summary, SCHEMA_VERSION),
        )
        self.emit_manifest()
        return work_id

    def set_status(self, work_id, status, reason):
        self._append(
            MSG_WORK_STATUS_CHANGED,
            events.work_status_changed(work_id, status, reason),
        )

    def set_next_action(self, work_id, next_action):
        self._append(MSG_NEXT_ACTION_SET, events.next_action_set(work_id, next_action))

    def checkpoint(self, work_id, note):
        self._append(MSG_CHECKPOINT_RECORDED, events.checkpoint_recorded(work_id, note))

    def decide(self, work_id, decision, decided_by):
        self._append(
            MSG_DECISION_RECORDED,
            events.decision_recorded(work_id, decision, decided_by),
        )

    def validate(self, work_id, result, command, note):
        self._append(
            MSG_VALIDATION_RECORDED,
            events.validation_recorded(work_id, result, command, note),
        )

    def artifact(self, work_id, ref, kind):
        self._append(
            MSG_ARTIFACT_RECORDED, events.artifact_recorded(work_id, ref, kind)
        )

    def link_run(self, work_id, run_id):
        self._append(MSG_RUN_LINKED, events.run_linked(work_id, run_id))

    def store_dir(self):
        return os.path.join(self.runtime_dir, "work", "store")

    def emit_manifest(self):
        """Pin the store's schema bindings (content-addressed .bfbs + manifest)."""
        with open(_BFBS_FILE, "rb") as f:
            blob = f.read()
        schema_hash = hashlib.sha256(blob).hexdigest()

        schemas_dir = os.path.join(self.store_dir(), "schemas")
        os.makedirs(schemas_dir, exist_ok=True)
        blob_path = os.path.join(schemas_dir, schema_hash + ".bfbs")
        if not os.path.exists(blob_path):
            with open(blob_path, "wb") as f:
                f.write(blob)

        manifest = {
            "spec_version": "0.1",
            "source": {
                "root": self.runtime_dir,
                "mode": "live",
                "category": "system",
                "group": WORK_GROUP,
                "name": WORK_NAME,
                "dest": PUBLIC_DEST,
            },
            "hash_algorithm": "sha256",
            "schema_bindings": {
                str(msg_type): {
                    "schema_kind": "flatbuffers",
                    "name": name,
                    "schema_version": SCHEMA_VERSION,
                    "schema_hash": schema_hash,
                }
                for msg_type, name in MSG_TYPE_NAMES.items()
            },
            "capture_boundary": "schema bindings cover work-item events only; "
            "frames of other msg_types in the same journal are out of scope "
            "for this manifest",
        }
        manifest_path = os.path.join(self.store_dir(), "manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2, sort_keys=True)
        return manifest_path


def read_frames(runtime_dir):
    """All work frames in gen_time order: (gen_time, msg_type, bytes)."""
    location = _location(runtime_dir)
    frames = []
    for msg_type in MSG_TYPE_NAMES:
        try:
            for header, payload in yjj.assemble(location, 0).read_bytes(msg_type):
                frames.append((header.gen_time, msg_type, bytes(payload)))
        except (RuntimeError, ValueError, FileNotFoundError):
            # no journal yet (or none for this type) simply means no events
            continue
    frames.sort(key=lambda f: f[0])
    return frames


def _shell(work_id):
    return {
        "work_id": work_id,
        "title": None,
        "kind": None,
        "summary": None,
        "status": None,
        "next_action": None,
        "created_time": None,
        "updated_time": None,
        "checkpoints": [],
        "decisions": [],
        "validations": [],
        "artifacts": [],
        "runs": [],
        "history": [],
    }


def load(runtime_dir):
    """Fold the event stream into {work_id: item} (the projection)."""
    items = {}

    def item(work_id, gen_time):
        entry = items.setdefault(work_id, _shell(work_id))
        entry["updated_time"] = gen_time
        return entry

    for gen_time, msg_type, payload in read_frames(runtime_dir):
        if msg_type == MSG_WORK_ITEM_CREATED:
            event = WorkItemCreated.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["title"] = _text(event.Title())
            entry["kind"] = _text(event.Kind())
            entry["summary"] = _text(event.Summary())
            entry["status"] = STATUS_NAMES[WorkStatus.Active]
            entry["created_time"] = gen_time
            entry["history"].append({"time": gen_time, "event": "created"})
        elif msg_type == MSG_WORK_STATUS_CHANGED:
            event = WorkStatusChanged.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            status = STATUS_NAMES.get(event.Status())
            entry["status"] = status
            entry["history"].append(
                {
                    "time": gen_time,
                    "event": "status",
                    "status": status,
                    "reason": _text(event.Reason()),
                }
            )
        elif msg_type == MSG_NEXT_ACTION_SET:
            event = NextActionSet.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["next_action"] = _text(event.NextAction())
        elif msg_type == MSG_CHECKPOINT_RECORDED:
            event = CheckpointRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["checkpoints"].append({"time": gen_time, "note": _text(event.Note())})
        elif msg_type == MSG_DECISION_RECORDED:
            event = DecisionRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["decisions"].append(
                {
                    "time": gen_time,
                    "decision": _text(event.Decision()),
                    "decided_by": _text(event.DecidedBy()),
                }
            )
        elif msg_type == MSG_VALIDATION_RECORDED:
            event = ValidationRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["validations"].append(
                {
                    "time": gen_time,
                    "result": RESULT_NAMES.get(event.Result()),
                    "command": _text(event.Command()),
                    "note": _text(event.Note()),
                }
            )
        elif msg_type == MSG_ARTIFACT_RECORDED:
            event = ArtifactRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["artifacts"].append(
                {
                    "time": gen_time,
                    "ref": _text(event.Ref()),
                    "kind": _text(event.Kind()),
                }
            )
        elif msg_type == MSG_RUN_LINKED:
            event = RunLinked.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["runs"].append({"time": gen_time, "run_id": _text(event.RunId())})
    return items
