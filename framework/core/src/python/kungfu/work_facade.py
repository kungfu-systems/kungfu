"""Pure Cut/Work projection and recovery classification."""

from __future__ import annotations

from typing import Any


OPEN_STATES = {"active", "waiting", "blocked", "ready"}


def inspect_work(
    cut: dict[str, Any], items: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    open_items = [item for item in items.values() if item.get("status") in OPEN_STATES]
    open_items.sort(key=lambda item: item.get("updated_time") or 0, reverse=True)
    gaps = list(cut.get("gaps") or [])
    current_work = open_items[0] if len(open_items) == 1 else None

    if len(open_items) > 1:
        gaps.append("multiple-open-work-items")
        next_actions = ["select-work"]
        status = "ambiguous"
    elif current_work is None:
        next_actions = ["begin"]
        status = "idle"
    elif current_work["status"] == "blocked":
        next_actions = ["recover"]
        status = "blocked"
    elif current_work["status"] == "ready":
        next_actions = ["complete", "settle"]
        status = "completion-pending"
    elif current_work["status"] == "waiting":
        next_actions = ["resume", "recover"]
        status = "paused"
    else:
        next_actions = ["checkpoint", "complete"]
        status = "active"

    if current_work is not None:
        gaps.extend(
            ["initiative-binding-unavailable", "assignment-binding-unavailable"]
        )
    confidence = cut.get("confidence", "none")
    if gaps and confidence == "high":
        confidence = "medium"
    return {
        "schema": "kungfu.work.inspect/v1",
        "status": status,
        "confidence": confidence,
        "cut": cut.get("current"),
        "cutStatus": cut.get("status"),
        "work": current_work,
        "openWork": open_items,
        "gaps": sorted(set(gaps)),
        "nextActions": next_actions,
        "authority": {
            "cut": cut.get("authority"),
            "work": "kungfu-work-journal",
            "projection": "non-authoritative",
        },
    }


def recover_work(projection: dict[str, Any]) -> dict[str, Any]:
    """Classify recovery without changing Work, runtime, or Git state."""

    work = projection.get("work")
    if projection.get("status") == "ambiguous":
        action = "select-work"
        code = "work-ambiguous"
    elif work is None:
        action = "begin"
        code = "work-missing"
    elif projection.get("cutStatus") in {"conflicted", "thin"}:
        action = "recover-project-cut"
        code = f"project-cut-{projection['cutStatus']}"
    elif work.get("status") == "ready":
        action = "complete"
        code = "completion-evidence-required"
    elif work.get("status") in {"waiting", "blocked"}:
        action = "resume"
        code = f"work-{work['status']}"
    else:
        action = "checkpoint"
        code = "work-current"
    return {
        "schema": "kungfu.work.recovery-plan/v1",
        "status": "plan",
        "code": code,
        "workId": work.get("work_id") if work else None,
        "action": action,
        "gaps": list(projection.get("gaps") or []),
        "writeOccurred": False,
    }
