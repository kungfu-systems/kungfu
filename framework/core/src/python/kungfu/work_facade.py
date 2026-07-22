"""Pure Cut/Work projection and recovery classification."""

from __future__ import annotations

from typing import Any


OPEN_STATES = {"active", "waiting", "blocked", "ready"}
READ_ONLY_FACADE_ACTIONS = frozenset(
    {"capabilities", "inspect", "recover", "complete", "settle"}
)


def work_loop_capabilities() -> dict[str, Any]:
    """Describe the shared Work/Cut loop without claiming missing authority."""

    operations = [
        {
            "id": "inspect",
            "availability": "available",
            "command": "kungfu work inspect --repo <path> --json",
            "resultSchema": "kungfu.work.inspect/v1",
            "authority": "read-only-projection",
        },
        {
            "id": "begin",
            "availability": "unavailable",
            "command": None,
            "resultSchema": None,
            "authority": "mission-control.assignment.create",
            "reason": "native-assignment-orchestration-not-admitted",
        },
        {
            "id": "checkpoint",
            "availability": "degraded",
            "command": "kungfu work checkpoint <work-id> <note>",
            "resultSchema": None,
            "authority": "kungfu-work-journal",
            "reason": "legacy-work-receipt-not-yet-projected",
        },
        {
            "id": "complete",
            "availability": "plan-only",
            "command": "kungfu work complete <work-id> --repo <path> --json",
            "resultSchema": "kungfu.work.completion-candidate/v1",
            "authority": "completion-candidate-planner",
        },
        {
            "id": "settle",
            "availability": "plan-only",
            "command": "kungfu work settle <work-id> --claim-root <root> --review-root <root> --decision-root <root> --project-cut-root <root> --json",
            "resultSchema": "kungfu.work.settlement-plan/v1",
            "authority": "settlement-planner",
        },
        {
            "id": "resume",
            "availability": "degraded",
            "command": "kungfu work resume <work-id> --json",
            "resultSchema": None,
            "authority": "kungfu-work-journal",
            "reason": "assignment-and-cut-binding-not-yet-enforced",
        },
        {
            "id": "recover",
            "availability": "available",
            "command": "kungfu work recover --repo <path> --json",
            "resultSchema": "kungfu.work.recovery-plan/v1",
            "authority": "read-only-projection",
        },
        {
            "id": "export",
            "availability": "unavailable",
            "command": None,
            "resultSchema": None,
            "authority": "work-loop-portability",
            "reason": "portable-work-loop-contract-not-admitted",
        },
        {
            "id": "import",
            "availability": "unavailable",
            "command": None,
            "resultSchema": None,
            "authority": "work-loop-portability",
            "reason": "portable-work-loop-contract-not-admitted",
        },
    ]
    return {
        "schema": "kungfu.work-loop-capabilities/v1",
        "mentalModel": ["current Cut", "work in progress", "next Cut"],
        "operations": operations,
        "surfaces": {
            "cli": {
                "availability": "available",
                "entrypoint": "kungfu work capabilities --json",
            },
            "agent": {
                "availability": "available",
                "entrypoint": "kungfu agent capabilities --json",
                "projection": "workLoop",
            },
            "gui": {
                "availability": "available",
                "entrypoint": "@kungfu-tech/api.openWorkLoop",
                "projection": "work-dashboard",
            },
            "tui": {
                "availability": "available",
                "entrypoint": "@kungfu-tech/api.openWorkLoop",
                "projection": "mission-control-profile-shell",
            },
        },
        "domainProfile": {
            "availability": "unavailable",
            "reason": "domain-profile-authoring-contract-not-admitted",
        },
        "authority": {
            "projection": "non-authoritative",
            "writesRequireDeclaredOperation": True,
            "settlementRequiresIndependentReview": True,
        },
    }


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


def plan_managed_run_link(
    items: dict[str, dict[str, Any]], work_id: str, run_id: str
) -> dict[str, Any]:
    item = items.get(work_id)
    if item is None:
        return {"ok": False, "code": "work-missing", "writeOccurred": False}
    existing = {row.get("run_id") for row in item.get("runs", []) if row.get("run_id")}
    return {
        "ok": True,
        "code": "run-link-current" if run_id in existing else "run-link-required",
        "workId": work_id,
        "runId": run_id,
        "reused": run_id in existing,
        "writeOccurred": False,
    }


def plan_completion(projection: dict[str, Any], work_id: str) -> dict[str, Any]:
    item = next(
        (
            row
            for row in projection.get("openWork", [])
            if row.get("work_id") == work_id
        ),
        None,
    )
    missing = []
    if item is None:
        missing.append("work-missing")
    elif item.get("status") != "ready":
        missing.append("work-not-ready")
    if item is not None and not any(
        row.get("result") == "pass" for row in item.get("validations", [])
    ):
        missing.append("passing-validation-missing")
    if projection.get("cut") is None:
        missing.append("current-project-cut-missing")
    return {
        "schema": "kungfu.work.completion-candidate/v1",
        "status": "blocked" if missing else "plan",
        "workId": work_id,
        "projectCutRoot": (projection.get("cut") or {}).get("cutRoot"),
        "missingEvidence": missing,
        "authorityOperations": ["episode.seal", "mission-control.claim-completion"],
        "requiresIndependentReview": True,
        "nextActions": ["checkpoint"] if missing else ["settle"],
        "writeOccurred": False,
    }


def plan_settlement(
    work_id: str,
    *,
    claim_root: str,
    review_root: str,
    decision_root: str,
    project_cut_root: str,
) -> dict[str, Any]:
    roots = {
        "claimRoot": claim_root,
        "reviewRoot": review_root,
        "decisionRoot": decision_root,
        "projectCutRoot": project_cut_root,
    }
    missing = [
        name for name, value in roots.items() if not str(value).startswith("sha256:")
    ]
    return {
        "schema": "kungfu.work.settlement-plan/v1",
        "status": "blocked" if missing else "plan",
        "workId": work_id,
        **roots,
        "missingRoots": missing,
        "authorityOperations": [
            "mission-control.decide",
            "project-cut.prepare",
            "project-cut.publish",
        ],
        "nextActions": ["request-evidence"] if missing else ["settle"],
        "writeOccurred": False,
    }
