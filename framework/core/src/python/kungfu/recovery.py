# SPDX-License-Identifier: Apache-2.0

"""Unified recovery planning over existing Kungfu authority surfaces."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from kungfu import contract as contract_runtime
from kungfu import diagnostics, peer_lifecycle, runtime_service
from kungfu.storage import episode_control
from kungfu.storage import service as storage_service


PLAN_SCHEMA = "kungfu.recovery-plan/v1"
RECEIPT_SCHEMA = "kungfu.recovery-receipt/v1"
ACTION_RECEIPT_SCHEMA = "kungfu.recovery-action-receipt/v1"
CLASS_AUTOMATIC = "automatic-safe"
CLASS_CONFIRM = "confirmation-required"
CLASS_MANUAL = "manual-blocked"


class RecoveryError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        plan: Mapping[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.plan = dict(plan) if plan is not None else None
        super().__init__(f"{code}: {message}")

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "schema": RECEIPT_SCHEMA,
            "ok": False,
            "status": "refused",
            "error": {"code": self.code, "message": self.message},
        }
        if self.plan is not None:
            result["plan"] = self.plan
        return result


def _contract() -> dict[str, Any]:
    return contract_runtime.load_contract("diagnostics")


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _root(value: Any) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _problem_identity(problem: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "code": str(problem.get("code") or "diagnostic_check_failed"),
        "sourceCode": str(
            problem.get("sourceCode") or problem.get("code") or "unknown"
        ),
        "area": str(problem.get("area") or "runtime"),
        "statusImpact": str(problem.get("statusImpact") or "blocked"),
        "subject": dict(problem.get("subject") or {}),
    }


def _action(
    problem: Mapping[str, Any],
    *,
    operation: str,
    classification: str,
    label: str,
    target: Mapping[str, Any] | None = None,
    expected: Mapping[str, Any] | None = None,
    preconditions: Sequence[str] = (),
    executable: bool = True,
) -> dict[str, Any]:
    identity: dict[str, Any] = {
        "problem": _problem_identity(problem),
        "operation": operation,
        "classification": classification,
        "target": dict(target or {}),
        "expected": dict(expected or {}),
        "preconditions": list(preconditions),
        "executable": executable,
    }
    suffix = _root(identity).removeprefix("sha256:")[:16]
    return {
        "actionId": f"{operation}:{suffix}",
        "problemCode": identity["problem"]["code"],
        "sourceCode": identity["problem"]["sourceCode"],
        "area": identity["problem"]["area"],
        "operation": operation,
        "classification": classification,
        "label": label,
        "target": identity["target"],
        "expected": identity["expected"],
        "preconditions": identity["preconditions"],
        "executable": executable,
    }


def _manual_action(problem: Mapping[str, Any]) -> dict[str, Any]:
    actions = list(problem.get("actions") or [])
    guidance = actions[0] if actions else {}
    return _action(
        problem,
        operation="manual-review",
        classification=CLASS_MANUAL,
        label=str(guidance.get("label") or problem.get("summary") or "Review evidence"),
        target=dict(problem.get("subject") or {}),
        expected={"suggestedCommand": list(guidance.get("command") or [])},
        preconditions=(
            "the underlying authority must provide a safe executable plan",
            "unknown ownership, writer, or authoritative data outcomes remain blocked",
        ),
        executable=False,
    )


def _runtime_action(
    home: str,
    runtime_dir: str,
    config_home: str,
    problem: Mapping[str, Any],
) -> dict[str, Any]:
    status = runtime_service.route_status(home, runtime_dir, config_home)
    route = status.get("route") or {}
    supervisor = status.get("supervisor") or {}
    coordinator = status.get("coordinator") or {}
    return _action(
        problem,
        operation="runtime.ensure",
        classification=CLASS_AUTOMATIC,
        label="Reactivate the workspace runtime through its fenced host",
        expected={
            "routeId": route.get("routeId"),
            "runtimeGeneration": route.get("runtimeGeneration"),
            "supervisorPid": supervisor.get("pid"),
            "supervisorStartIdentity": supervisor.get("startIdentity"),
            "coordinatorPid": coordinator.get("pid"),
            "coordinatorStartIdentity": coordinator.get("startIdentity"),
        },
        preconditions=(
            "no running runtime process has an unverified process-start identity",
            "ProcessRuntimeHost revalidates ownership before activation",
        ),
    )


def _peer_action(runtime_dir: str, problem: Mapping[str, Any]) -> dict[str, Any]:
    peer_id = str((problem.get("subject") or {}).get("peerId") or "")
    if not peer_id:
        return _manual_action(problem)
    status = peer_lifecycle.status(runtime_dir, peer_id)
    try:
        spec = peer_lifecycle.load_spec(peer_lifecycle.spec_path(runtime_dir, peer_id))
        peer_plan = peer_lifecycle.plan(spec, runtime_dir)
    except peer_lifecycle.PeerLifecycleError:
        return _manual_action(problem)
    state = str(status.get("lifecycleState") or "unknown")
    operation = "peer.restart" if state == "degraded" else "peer.ensure"
    return _action(
        problem,
        operation=operation,
        classification=CLASS_CONFIRM,
        label=(
            f"Restart Peer {peer_id} through its recorded process fences"
            if operation == "peer.restart"
            else f"Start or adopt Peer {peer_id} through its declaration"
        ),
        target={"peerId": peer_id},
        expected={
            "planId": peer_plan["planId"],
            "hostGeneration": status.get("host", {}).get("generation"),
            "peerGeneration": status.get("peer", {}).get("generation"),
            "lifecycleState": state,
        },
        preconditions=(
            "the saved Peer declaration still matches expected planId",
            "the host generation and process-start identities still pass the lifecycle fence",
        ),
    )


def _storage_action(problem: Mapping[str, Any]) -> dict[str, Any]:
    projection = str((problem.get("subject") or {}).get("projection") or "")
    if projection not in {"source-registry", "episode-manifest"}:
        return _manual_action(problem)
    return _action(
        problem,
        operation="storage.rebuild-projection",
        classification=CLASS_AUTOMATIC,
        label=f"Rebuild the derived {projection} projection from authoritative journals",
        target={"projection": projection},
        expected={"authority": "yijinjing-journal"},
        preconditions=(
            "the affected state is a declared rebuildable projection",
            "authoritative journals remain readable",
            "the storage service rebuilds from current authority facts",
        ),
    )


def _episode_action(runtime_dir: str, problem: Mapping[str, Any]) -> dict[str, Any]:
    episode_id = int((problem.get("subject") or {}).get("episodeId") or 0)
    if episode_id <= 0:
        return _manual_action(problem)
    episode_plan = episode_control.plan_episode_recovery(
        runtime_dir,
        episode_id=episode_id,
        stale_after_seconds=diagnostics.DEFAULT_STALE_AFTER_SECONDS,
    )
    if not episode_plan.get("eligible"):
        return _manual_action(problem)
    return _action(
        problem,
        operation="episode.abort-stale",
        classification=CLASS_CONFIRM,
        label=f"Append a fenced abort record for stale Episode {episode_id}",
        target={
            "episodeId": episode_id,
            "locationUid": int(episode_plan.get("locationUid") or 0),
        },
        expected={
            "episodePlanId": episode_plan.get("planId"),
            "manifestFrameUid": episode_plan.get("expectedManifestFrameUid"),
            "writerResourceId": (episode_plan.get("writer") or {}).get("resourceId"),
            "staleAfterSeconds": diagnostics.DEFAULT_STALE_AFTER_SECONDS,
        },
        preconditions=tuple(episode_plan.get("preconditions") or ()),
    )


def _actions_for_problem(
    home: str,
    runtime_dir: str,
    config_home: str,
    problem: Mapping[str, Any],
) -> list[dict[str, Any]]:
    code = str(problem.get("code") or "diagnostic_check_failed")
    if code in {"runtime_not_ready", "runtime_route_stale"}:
        return [_runtime_action(home, runtime_dir, config_home, problem)]
    if code in {"peer_not_ready", "peer_degraded", "peer_orphaned"}:
        return [_peer_action(runtime_dir, problem)]
    if code in {"projection_absent", "projection_drift"}:
        return [_storage_action(problem)]
    if code == "episode_stale_recoverable":
        return [_episode_action(runtime_dir, problem)]
    if str(problem.get("statusImpact")) in {"action-required", "blocked"}:
        return [_manual_action(problem)]
    return []


def plan_recovery(
    home: str,
    runtime_dir: str,
    config_home: str,
    *,
    now_ns: int | None = None,
) -> dict[str, Any]:
    """Create one deep, read-only plan without becoming a recovery authority."""

    health = diagnostics.collect_health(
        home,
        runtime_dir,
        config_home,
        deep=True,
        now_ns=now_ns,
    )
    diagnostics.validate_report(health)
    actions = [
        action
        for problem in health["problems"]
        for action in _actions_for_problem(home, runtime_dir, config_home, problem)
    ]
    counts = {
        classification: sum(
            1 for action in actions if action["classification"] == classification
        )
        for classification in (CLASS_AUTOMATIC, CLASS_CONFIRM, CLASS_MANUAL)
    }
    status = (
        "blocked" if counts[CLASS_MANUAL] else ("recoverable" if actions else "ready")
    )
    identity = {
        "schema": PLAN_SCHEMA,
        "home": str(Path(home).expanduser().resolve()),
        "runtimeDir": str(Path(runtime_dir).expanduser().resolve()),
        "healthStatus": health["status"],
        "actions": actions,
    }
    return {
        "schema": PLAN_SCHEMA,
        "planId": _root(identity),
        "status": status,
        "readOnly": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "home": identity["home"],
        "runtimeDir": identity["runtimeDir"],
        "healthStatus": health["status"],
        "healthExitCode": health["exitCode"],
        "summary": counts,
        "actions": actions,
        "health": health,
    }


def _load_peer_action(runtime_dir: str, action: Mapping[str, Any]):
    peer_id = str((action.get("target") or {}).get("peerId") or "")
    spec = peer_lifecycle.load_spec(peer_lifecycle.spec_path(runtime_dir, peer_id))
    expected = action.get("expected") or {}
    actual_plan = peer_lifecycle.plan(spec, runtime_dir)
    if actual_plan["planId"] != expected.get("planId"):
        raise RecoveryError(
            "recovery_action_stale",
            f"Peer {peer_id} declaration changed after planning",
        )
    return peer_id, spec, expected


def _execute_action(
    home: str,
    runtime_dir: str,
    config_home: str,
    log_level: str,
    action: Mapping[str, Any],
) -> dict[str, Any]:
    operation = str(action["operation"])
    if operation == "runtime.ensure":
        return runtime_service.ensure_coordinator(
            home,
            runtime_dir,
            log_level,
            config_home,
        )
    if operation in {"peer.ensure", "peer.restart"}:
        peer_id, spec, expected = _load_peer_action(runtime_dir, action)
        if operation == "peer.ensure":
            return peer_lifecycle.ensure(
                spec,
                runtime_dir,
                expected_plan_id=str(expected["planId"]),
            )
        return peer_lifecycle.restart(
            spec,
            runtime_dir,
            expected_host_generation=expected.get("hostGeneration"),
        )
    if operation == "storage.rebuild-projection":
        projection = str((action.get("target") or {}).get("projection") or "all")
        if projection == "episode-manifest":
            return storage_service.episode_projection_rebuild(runtime_dir)
        if projection == "source-registry":
            return storage_service.rebuild_index(runtime_dir, dry_run=False)
        raise RecoveryError(
            "recovery_projection_unsupported",
            f"projection is not declared rebuildable: {projection}",
        )
    if operation == "episode.abort-stale":
        target = action.get("target") or {}
        expected = action.get("expected") or {}
        return episode_control.execute_episode_recovery(
            runtime_dir,
            episode_id=int(target["episodeId"]),
            location_uid=int(target.get("locationUid") or 0),
            stale_after_seconds=float(expected["staleAfterSeconds"]),
            reason="unified recovery entry",
        )
    raise RecoveryError(
        "recovery_action_unsupported",
        f"recovery operation is not executable: {operation}",
    )


def execute_recovery(
    home: str,
    runtime_dir: str,
    config_home: str,
    *,
    log_level: str,
    expected_plan_id: str,
    action_ids: Sequence[str] = (),
    approvals: Sequence[str] = (),
    now_ns: int | None = None,
) -> dict[str, Any]:
    """Execute only a freshly regenerated plan and preserve per-action results."""

    current = plan_recovery(
        home,
        runtime_dir,
        config_home,
        now_ns=now_ns,
    )
    if current["planId"] != expected_plan_id:
        raise RecoveryError(
            "recovery_plan_stale",
            "workspace facts changed; generate and review a new recovery plan",
            plan=current,
        )
    available = {action["actionId"]: action for action in current["actions"]}
    requested = list(dict.fromkeys(action_ids)) or [
        action_id for action_id, action in available.items() if action.get("executable")
    ]
    unknown = [action_id for action_id in requested if action_id not in available]
    if unknown:
        raise RecoveryError(
            "recovery_action_unknown",
            "requested actions are not present in the current plan: "
            + ", ".join(unknown),
            plan=current,
        )
    selected = [available[action_id] for action_id in requested]
    blocked = [action for action in selected if not action.get("executable")]
    if blocked:
        raise RecoveryError(
            "recovery_action_blocked",
            "manual-blocked actions cannot be executed: "
            + ", ".join(action["actionId"] for action in blocked),
            plan=current,
        )
    approved = set(approvals)
    missing = [
        action["actionId"]
        for action in selected
        if action["classification"] == CLASS_CONFIRM
        and "all" not in approved
        and action["actionId"] not in approved
    ]
    if missing:
        raise RecoveryError(
            "recovery_confirmation_required",
            "confirmation-required actions need --approve <action-id> or --approve all: "
            + ", ".join(missing),
            plan=current,
        )

    action_receipts: list[dict[str, Any]] = []
    failed = False
    for action in selected:
        if failed:
            action_receipts.append(
                {
                    "schema": ACTION_RECEIPT_SCHEMA,
                    "actionId": action["actionId"],
                    "operation": action["operation"],
                    "status": "not-run",
                    "ok": False,
                    "result": None,
                    "error": {
                        "code": "recovery_stopped_after_failure",
                        "message": "an earlier action failed closed",
                    },
                }
            )
            continue
        try:
            result = _execute_action(
                home,
                runtime_dir,
                config_home,
                log_level,
                action,
            )
            action_receipts.append(
                {
                    "schema": ACTION_RECEIPT_SCHEMA,
                    "actionId": action["actionId"],
                    "operation": action["operation"],
                    "status": "succeeded",
                    "ok": True,
                    "result": result,
                    "error": None,
                }
            )
        except Exception as error:  # authority errors must remain visible
            failed = True
            action_receipts.append(
                {
                    "schema": ACTION_RECEIPT_SCHEMA,
                    "actionId": action["actionId"],
                    "operation": action["operation"],
                    "status": "failed",
                    "ok": False,
                    "result": None,
                    "error": {
                        "code": str(getattr(error, "code", "recovery_action_failed")),
                        "message": str(error),
                    },
                }
            )

    postflight = diagnostics.collect_health(
        home,
        runtime_dir,
        config_home,
        deep=True,
        now_ns=now_ns,
    )
    diagnostics.validate_report(postflight)
    remaining_manual = current["summary"][CLASS_MANUAL]
    ok = not failed and postflight["status"] in {"ready", "degraded"}
    status = (
        "failed"
        if failed
        else (
            "blocked"
            if postflight["status"] == "blocked" or remaining_manual
            else (
                "action-required"
                if postflight["status"] == "action-required"
                else "succeeded"
            )
        )
    )
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "planId": current["planId"],
        "ok": ok,
        "status": status,
        "executedAt": datetime.now(timezone.utc).isoformat(),
        "selectedActionIds": requested,
        "actions": action_receipts,
        "postflight": postflight,
    }
    validate_receipt(receipt)
    return receipt


def validate_plan(plan: Mapping[str, Any]) -> None:
    contract_runtime.validate_json_schema(
        plan,
        _contract()["recoveryPlanSchema"],
        "recovery plan",
    )


def validate_receipt(receipt: Mapping[str, Any]) -> None:
    contract_runtime.validate_json_schema(
        receipt,
        _contract()["recoveryReceiptSchema"],
        "recovery receipt",
    )
