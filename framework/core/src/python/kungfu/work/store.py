#  SPDX-License-Identifier: Apache-2.0
#
# The work store: one shared journal for all work items of a runtime home,
# short-lived single-writer appends, and the projection that folds the event
# stream into current items.
#
# Journal shape: standalone single-writer, same construction as the Rewind
# supervisor and the C++ slices — no coordinator, no-op publisher, private bus.
# Every `kungfu work` mutation opens the writer, appends, and exits; the
# journal remains the fact source and current state is always a fold.
#
# Store manifest: like the Rewind trace bundle, the store pins its schema as
# a content-addressed .bfbs plus action_type bindings (manifest.json), so the
# work journal decodes through FlatBuffers reflection without this runtime.

import os
import uuid
from typing import Any, cast

import kungfu

from kungfu.work import (
    ACTION_ARTIFACT_RECORDED,
    ACTION_CHECKPOINT_RECORDED,
    ACTION_DECISION_RECORDED,
    ACTION_NEXT_ACTION_SET,
    ACTION_RUN_LINKED,
    ACTION_TYPE_NAMES,
    ACTION_VALIDATION_RECORDED,
    ACTION_WORK_ITEM_CREATED,
    ACTION_WORK_STATUS_CHANGED,
    SCHEMA_VERSION,
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

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime

PUBLIC_DEST = 0
WORK_GROUP = "work"
WORK_NAME = "items"

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
        lf.enums.location_role.SYSTEM,
        WORK_GROUP,
        WORK_NAME,
        locator,
    )


def _text(value):
    return value.decode() if value is not None else None


def _event_fields(**values):
    """Match the legacy builders: omit absent and empty optional strings."""

    return {
        key: value
        for key, value in values.items()
        if value is not None and not (isinstance(value, str) and not value)
    }


class WorkStore:
    """Thin client for the native Agent Work journal byte owner."""

    def __init__(self, runtime_dir):
        self.runtime_dir = runtime_dir
        self.location = _location(runtime_dir)

    def _append(self, action_type, event):
        return yjj.run_storage_service_operation(
            "action_runtime",
            self.runtime_dir,
            {
                "action": "work_journal",
                "mode": "append",
                "actionType": action_type,
                "event": event,
            },
        )

    def _append_many(self, events):
        return yjj.run_storage_service_operation(
            "action_runtime",
            self.runtime_dir,
            {
                "action": "work_journal",
                "mode": "append_batch",
                "events": events,
            },
        )

    def create(self, title, kind, summary):
        work_id = new_work_id()
        self.create_with_id(work_id, title, kind, summary)
        return work_id

    def create_with_id(self, work_id, title, kind, summary):
        """Create an item with an already verified portable Work identity."""

        self._append(
            ACTION_WORK_ITEM_CREATED,
            _event_fields(
                work_id=work_id,
                title=title,
                kind=kind,
                summary=summary,
                schema_version=SCHEMA_VERSION,
            ),
        )

    def import_portable_item(self, existing, target):
        """Append only the missing verified prefix of a portable Work item."""

        from kungfu.work_facade import portable_import_delta

        actions = portable_import_delta(existing, target)
        events = []
        for action, value in actions:
            if action == "create":
                events.append(
                    {
                        "actionType": ACTION_WORK_ITEM_CREATED,
                        "event": _event_fields(
                            work_id=value["workId"],
                            title=value["title"],
                            kind=value["kind"],
                            summary=value["summary"],
                            schema_version=SCHEMA_VERSION,
                        ),
                    }
                )
            elif action == "nextAction":
                events.append(
                    {
                        "actionType": ACTION_NEXT_ACTION_SET,
                        "event": _event_fields(
                            work_id=target["workId"], next_action=value
                        ),
                    }
                )
            elif action == "checkpoints":
                events.append(
                    {
                        "actionType": ACTION_CHECKPOINT_RECORDED,
                        "event": _event_fields(
                            work_id=target["workId"], note=value["note"]
                        ),
                    }
                )
            elif action == "decisions":
                events.append(
                    {
                        "actionType": ACTION_DECISION_RECORDED,
                        "event": _event_fields(
                            work_id=target["workId"],
                            decision=value["decision"],
                            decided_by=value["decidedBy"],
                        ),
                    }
                )
            elif action == "validations":
                events.append(
                    {
                        "actionType": ACTION_VALIDATION_RECORDED,
                        "event": _event_fields(
                            work_id=target["workId"],
                            result=int(RESULT_BY_NAME[value["result"]]),
                            command=value["command"],
                            note=value["note"],
                        ),
                    }
                )
            elif action == "artifacts":
                events.append(
                    {
                        "actionType": ACTION_ARTIFACT_RECORDED,
                        "event": _event_fields(
                            work_id=target["workId"],
                            ref=value["ref"],
                            kind=value["kind"],
                        ),
                    }
                )
            elif action == "runs":
                events.append(
                    {
                        "actionType": ACTION_RUN_LINKED,
                        "event": _event_fields(
                            work_id=target["workId"], run_id=value["runId"]
                        ),
                    }
                )
            elif action == "status":
                events.append(
                    {
                        "actionType": ACTION_WORK_STATUS_CHANGED,
                        "event": _event_fields(
                            work_id=target["workId"],
                            status=int(STATUS_BY_NAME[value]),
                            reason="portable-import",
                        ),
                    }
                )
            else:  # pragma: no cover - delta owns this closed operation set
                raise ValueError(f"unsupported portable Work action: {action}")
        if events:
            self._append_many(events)
        return len(actions)

    def set_status(self, work_id, status, reason):
        self._append(
            ACTION_WORK_STATUS_CHANGED,
            _event_fields(work_id=work_id, status=int(status), reason=reason),
        )

    def set_next_action(self, work_id, next_action):
        self._append(
            ACTION_NEXT_ACTION_SET,
            _event_fields(work_id=work_id, next_action=next_action),
        )

    def checkpoint(self, work_id, note):
        self._append(
            ACTION_CHECKPOINT_RECORDED, _event_fields(work_id=work_id, note=note)
        )

    def decide(self, work_id, decision, decided_by):
        self._append(
            ACTION_DECISION_RECORDED,
            _event_fields(work_id=work_id, decision=decision, decided_by=decided_by),
        )

    def validate(self, work_id, result, command, note):
        self._append(
            ACTION_VALIDATION_RECORDED,
            _event_fields(
                work_id=work_id,
                result=int(result),
                command=command,
                note=note,
            ),
        )

    def artifact(self, work_id, ref, kind):
        self._append(
            ACTION_ARTIFACT_RECORDED,
            _event_fields(work_id=work_id, ref=ref, kind=kind),
        )

    def link_run(self, work_id, run_id):
        self._append(ACTION_RUN_LINKED, _event_fields(work_id=work_id, run_id=run_id))

    def store_dir(self):
        return os.path.join(self.runtime_dir, "work", "store")

    def emit_manifest(self):
        """Ask the native owner to publish the content-addressed schema manifest."""
        receipt = yjj.run_storage_service_operation(
            "action_runtime",
            self.runtime_dir,
            {"action": "work_journal", "mode": "emit_manifest"},
        )
        return receipt["manifestPath"]


def read_frames(runtime_dir):
    """All work frames in gen_time order: (gen_time, action_type, bytes)."""
    replay = yjj.run_storage_service_operation(
        "action_runtime",
        runtime_dir,
        {"action": "work_journal", "mode": "replay"},
    )
    frames = [
        (event["genTime"], event["actionType"], bytes.fromhex(event["payloadHex"]))
        for event in replay["events"]
        if event["actionType"] in ACTION_TYPE_NAMES
    ]
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
    items: dict[str, Any] = {}

    def item(work_id, gen_time):
        entry = cast(dict[str, Any], items.setdefault(work_id, _shell(work_id)))
        entry["updated_time"] = gen_time
        return entry

    for gen_time, action_type, payload in read_frames(runtime_dir):
        if action_type == ACTION_WORK_ITEM_CREATED:
            event = WorkItemCreated.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["title"] = _text(event.Title())
            entry["kind"] = _text(event.Kind())
            entry["summary"] = _text(event.Summary())
            entry["status"] = STATUS_NAMES[WorkStatus.Active]
            entry["created_time"] = gen_time
            entry["history"].append({"time": gen_time, "event": "created"})
        elif action_type == ACTION_WORK_STATUS_CHANGED:
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
        elif action_type == ACTION_NEXT_ACTION_SET:
            event = NextActionSet.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["next_action"] = _text(event.NextAction())
        elif action_type == ACTION_CHECKPOINT_RECORDED:
            event = CheckpointRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["checkpoints"].append({"time": gen_time, "note": _text(event.Note())})
        elif action_type == ACTION_DECISION_RECORDED:
            event = DecisionRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["decisions"].append(
                {
                    "time": gen_time,
                    "decision": _text(event.Decision()),
                    "decided_by": _text(event.DecidedBy()),
                }
            )
        elif action_type == ACTION_VALIDATION_RECORDED:
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
        elif action_type == ACTION_ARTIFACT_RECORDED:
            event = ArtifactRecorded.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["artifacts"].append(
                {
                    "time": gen_time,
                    "ref": _text(event.Ref()),
                    "kind": _text(event.Kind()),
                }
            )
        elif action_type == ACTION_RUN_LINKED:
            event = RunLinked.GetRootAs(payload, 0)
            entry = item(_text(event.WorkId()), gen_time)
            entry["runs"].append({"time": gen_time, "run_id": _text(event.RunId())})
    return items
