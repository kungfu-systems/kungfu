# SPDX-License-Identifier: Apache-2.0

"""Read-only product diagnostics over existing Kungfu authority surfaces."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from kungfu import contract as contract_runtime
from kungfu import peer_lifecycle, runtime_service
from kungfu.storage import episode_control
from kungfu.storage import service as storage_service


PROBLEM_SCHEMA = "kungfu.diagnostic.problem/v1"
REPORT_SCHEMA = "kungfu.health-report/v1"
PREFLIGHT_SCHEMA = "kungfu.health-preflight/v1"
STATUS_ORDER = {
    "ready": 0,
    "degraded": 1,
    "action-required": 2,
    "blocked": 3,
}
FAST_EPISODE_LIMIT = 100
DEFAULT_STALE_AFTER_SECONDS = 300.0
HEALTH_AREAS = ("runtime", "peer", "storage", "episode")


def exit_code(status: str) -> int:
    return STATUS_ORDER.get(status, STATUS_ORDER["blocked"])


def _contract() -> dict[str, Any]:
    return contract_runtime.load_contract("diagnostics")


def _format_value(value: Any, variables: Mapping[str, Any]) -> Any:
    if isinstance(value, str):
        try:
            return value.format_map(_SafeFormat(variables))
        except (ValueError, TypeError):
            return value
    if isinstance(value, list):
        return [_format_value(item, variables) for item in value]
    if isinstance(value, dict):
        return {key: _format_value(item, variables) for key, item in value.items()}
    return value


class _SafeFormat(dict[str, Any]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def problem(
    code: str,
    *,
    area: str | None = None,
    technical_detail: str | None = None,
    subject: Mapping[str, Any] | None = None,
    variables: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Translate one stable technical code into an actionable problem."""

    catalog = _contract()["problemCatalog"]
    template = copy.deepcopy(catalog.get(code) or catalog["diagnostic_check_failed"])
    actual_code = code if code in catalog else "diagnostic_check_failed"
    values = {**dict(subject or {}), **dict(variables or {}), "code": code}
    rendered = _format_value(template, values)
    return {
        "schema": PROBLEM_SCHEMA,
        "code": actual_code,
        "sourceCode": code,
        "area": area or str(rendered["area"]),
        "severity": rendered["severity"],
        "statusImpact": rendered["statusImpact"],
        "summary": rendered["summary"],
        "message": rendered["message"],
        "retryable": bool(rendered["retryable"]),
        "actionRequired": bool(rendered["actionRequired"]),
        "technicalDetail": technical_detail,
        "subject": dict(subject or {}),
        "actions": rendered.get("actions", []),
    }


def problem_from_exception(error: BaseException, *, area: str) -> dict[str, Any]:
    code = str(getattr(error, "code", "diagnostic_check_failed"))
    return problem(code, area=area, technical_detail=str(error))


def actionable_text(item: Mapping[str, Any], *, include_technical: bool = False) -> str:
    lines = [
        f"{item['sourceCode']}: {item['summary']}",
        str(item["message"]),
    ]
    for action in item.get("actions", []):
        command = " ".join(str(value) for value in action.get("command", []))
        suffix = f" ({command})" if command else ""
        lines.append(f"Next: {action['label']}{suffix}")
    if include_technical and item.get("technicalDetail"):
        lines.append(f"Technical detail: {item['technicalDetail']}")
    return "\n".join(lines)


def _check(area: str, summary: str, problems: list[dict[str, Any]], **facts: Any):
    status = _aggregate_status(problems)
    return {
        "area": area,
        "status": status,
        "summary": summary,
        "facts": facts,
        "problems": problems,
    }


def _aggregate_status(problems: Sequence[Mapping[str, Any]]) -> str:
    if not problems:
        return "ready"
    return max(
        (str(item.get("statusImpact") or "blocked") for item in problems),
        key=lambda item: STATUS_ORDER.get(item, STATUS_ORDER["blocked"]),
    )


def _runtime_check(home: str, runtime_dir: str, config_home: str):
    payload = runtime_service.route_status(home, runtime_dir, config_home)
    problems: list[dict[str, Any]] = []
    product = payload.get("product") or {}
    error = product.get("error") or {}
    if error:
        problems.append(
            problem(
                str(error.get("code") or "runtime_not_ready"),
                area="runtime",
                technical_detail=str(error.get("message") or error),
            )
        )
    route = payload.get("route") or {}
    lifecycle = payload.get("lifecycle") or {}
    if route.get("registered") and route.get("stale"):
        problems.append(problem("runtime_route_stale", area="runtime"))
    for process_name in ("supervisor", "coordinator"):
        process = payload.get(process_name) or {}
        if process.get("running") and not process.get("identityVerified"):
            problems.append(
                problem(
                    "runtime_identity_unverified",
                    area="runtime",
                    subject={"process": process_name},
                    variables={"process": process_name},
                )
            )
    return _check(
        "runtime",
        "Runtime authority and process fences are consistent."
        if not problems
        else "Runtime needs attention.",
        problems,
        productAvailability=product.get("availability", "unknown"),
        liveState=product.get("liveState", "unknown"),
        lifecycle=lifecycle.get("state", "unknown"),
        routeRegistered=bool(route.get("registered")),
    )


def _peer_check(runtime_dir: str):
    payload = peer_lifecycle.list_status(runtime_dir)
    problems: list[dict[str, Any]] = []
    for item in payload.get("items", []):
        if item.get("healthy") or (
            item.get("desiredState") == "stopped"
            and item.get("lifecycleState") in {"stopped", "ended"}
        ):
            continue
        state = str(item.get("lifecycleState") or "unknown")
        code = {
            "ownership-unknown": "peer_ownership_unknown",
            "lost-control": "peer_lost_control",
            "crash-loop": "peer_crash_loop",
            "degraded": "peer_degraded",
            "orphaned": "peer_orphaned",
        }.get(state, "peer_not_ready")
        peer_id = str(item.get("peerId") or "unknown")
        problems.append(
            problem(
                code,
                area="peer",
                technical_detail=str(item.get("error") or state),
                subject={"peerId": peer_id, "lifecycleState": state},
                variables={"peerId": peer_id, "state": state},
            )
        )
    return _check(
        "peer",
        "All declared Peers are ready or intentionally stopped."
        if not problems
        else "One or more declared Peers need attention.",
        problems,
        declaredCount=len(payload.get("items", [])),
    )


def _storage_fast_check(runtime_dir: str):
    runtime_path = Path(runtime_dir)
    if not runtime_path.exists():
        return _check(
            "storage",
            "Storage has not been initialized yet.",
            [],
            initialized=False,
        )
    payload = storage_service.status(runtime_dir)
    problems: list[dict[str, Any]] = []
    if not payload.get("ok", False):
        problems.append(problem("storage_status_failed", area="storage"))
    for source in payload.get("source_status", []):
        if source.get("ok"):
            continue
        source_id = str(source.get("source_id") or "unknown")
        reason = str(source.get("reason") or "storage_status_failed")
        problems.append(
            problem(
                reason,
                area="storage",
                technical_detail=reason,
                subject={"sourceId": source_id},
                variables={"sourceId": source_id},
            )
        )
    return _check(
        "storage",
        "Storage metadata is readable."
        if not problems
        else "Storage metadata needs attention.",
        problems,
        initialized=True,
        provider=payload.get("provider"),
        sourceCount=len(payload.get("sources", [])),
    )


def _storage_deep_check(runtime_dir: str):
    runtime_path = Path(runtime_dir)
    if not runtime_path.exists():
        return _check(
            "storage",
            "Storage has not been initialized yet.",
            [],
            initialized=False,
            integrityScan="skipped",
        )
    payload = storage_service.fsck(runtime_dir)
    problems: list[dict[str, Any]] = []
    for issue in payload.get("issues", []):
        code = str(issue.get("code") or "storage_integrity_failed")
        problems.append(
            problem(
                code,
                area="storage",
                technical_detail=str(issue),
                subject={"projection": issue.get("projection")},
            )
        )
    if not payload.get("ok", False) and not problems:
        problems.append(problem("storage_integrity_failed", area="storage"))
    return _check(
        "storage",
        "Storage integrity scan passed."
        if not problems
        else "Storage integrity scan found issues.",
        problems,
        initialized=True,
        integrityScan="complete",
        checked=payload.get("checked", {}),
    )


def _episode_age(item: Mapping[str, Any], now_ns: int) -> float | None:
    open_record = item.get("open") or {}
    anchors = [
        item.get("update_time") if item.get("heartbeat_seen") else None,
        open_record.get("begin_time"),
        item.get("open_manifest_gen_time"),
    ]
    anchor = next(
        (int(value) for value in anchors if isinstance(value, (int, float)) and value),
        0,
    )
    return (now_ns - anchor) / 1_000_000_000 if anchor > 0 else None


def _episode_problem_from_plan(plan: Mapping[str, Any]) -> dict[str, Any] | None:
    episode_id = int(plan.get("episodeId") or 0)
    blockers = [str(item.get("code")) for item in plan.get("blockers", [])]
    subject = {"episodeId": episode_id}
    variables = {"episodeId": episode_id}
    if plan.get("eligible"):
        return problem(
            "episode_stale_recoverable",
            area="episode",
            subject=subject,
            variables=variables,
        )
    if "episode_writer_liveness_unknown" in blockers:
        return problem(
            "episode_writer_liveness_unknown",
            area="episode",
            subject=subject,
            variables=variables,
        )
    if "episode_age_unknown" in blockers:
        return problem(
            "episode_age_unknown",
            area="episode",
            subject=subject,
            variables=variables,
        )
    if "episode_writer_active" in blockers:
        return None
    if "episode_not_stale" in blockers:
        return problem(
            "episode_open_recent",
            area="episode",
            subject=subject,
            variables=variables,
        )
    terminal = {"episode_not_opened", "episode_terminal_record_present"}
    if blockers and set(blockers).issubset(terminal):
        return None
    return problem(
        blockers[0] if blockers else "episode_state_inconsistent",
        area="episode",
        technical_detail=str(plan.get("blockers", [])),
        subject=subject,
        variables=variables,
    )


def _episode_check(runtime_dir: str, *, deep: bool, now_ns: int):
    runtime_path = Path(runtime_dir)
    if not runtime_path.exists():
        return _check(
            "episode",
            "No Episodes have been recorded yet.",
            [],
            episodeCount=0,
            inspectedOpenCount=0,
        )
    limit = 0 if deep else FAST_EPISODE_LIMIT
    payload = storage_service.episode_list(runtime_dir, limit=limit)
    problems: list[dict[str, Any]] = []
    episodes = payload.get("episodes", [])
    open_items = [
        item for item in episodes if item.get("opened") and not item.get("closed")
    ]
    for item in open_items:
        episode_id = int(item.get("episode_id") or 0)
        open_record = item.get("open") or {}
        location_uid = int(open_record.get("location_uid") or 0)
        if deep:
            plan = episode_control.plan_episode_recovery(
                runtime_dir,
                episode_id=episode_id,
                stale_after_seconds=DEFAULT_STALE_AFTER_SECONDS,
                now_ns=now_ns,
            )
            translated = _episode_problem_from_plan(plan)
        else:
            writer = (
                episode_control.inspect_episode_writer(
                    runtime_dir, location_uid=location_uid
                )
                if location_uid
                else {"status": "unknown", "active": False}
            )
            age = _episode_age(item, now_ns)
            variables = {"episodeId": episode_id}
            subject = {"episodeId": episode_id}
            if writer.get("active"):
                translated = None
            elif writer.get("status") == "unknown":
                translated = problem(
                    "episode_writer_liveness_unknown",
                    area="episode",
                    subject=subject,
                    variables=variables,
                )
            elif age is None or age < 0:
                translated = problem(
                    "episode_age_unknown",
                    area="episode",
                    subject=subject,
                    variables=variables,
                )
            elif age >= DEFAULT_STALE_AFTER_SECONDS:
                translated = problem(
                    "episode_stale_recoverable",
                    area="episode",
                    subject=subject,
                    variables=variables,
                )
            else:
                translated = problem(
                    "episode_open_recent",
                    area="episode",
                    subject=subject,
                    variables=variables,
                )
        if translated is not None:
            problems.append(translated)
    if not deep and len(episodes) == FAST_EPISODE_LIMIT:
        problems.append(problem("episode_scan_truncated", area="episode"))
    if int(payload.get("unknown_record_count") or 0) > 0:
        problems.append(problem("episode_unknown_records", area="episode"))
    return _check(
        "episode",
        "Episodes are closed or have a live writer."
        if not problems
        else "One or more Episodes need attention.",
        problems,
        episodeCount=len(episodes),
        inspectedOpenCount=len(open_items),
        complete=deep,
    )


def _collect_checks(
    home: str,
    runtime_dir: str,
    config_home: str,
    *,
    areas: Sequence[str],
    deep: bool,
    now_ns: int | None = None,
) -> list[dict[str, Any]]:
    requested = tuple(dict.fromkeys(areas))
    unknown = set(requested).difference(HEALTH_AREAS)
    if unknown:
        raise ValueError(f"unknown diagnostic areas: {', '.join(sorted(unknown))}")
    effective_now_ns = (
        int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)
        if now_ns is None
        else now_ns
    )
    collectors = {
        "runtime": lambda: _runtime_check(home, runtime_dir, config_home),
        "peer": lambda: _peer_check(runtime_dir),
        "storage": lambda: (
            _storage_deep_check(runtime_dir)
            if deep
            else _storage_fast_check(runtime_dir)
        ),
        "episode": lambda: _episode_check(
            runtime_dir,
            deep=deep,
            now_ns=effective_now_ns,
        ),
    }
    checks = []
    for area in requested:
        try:
            checks.append(collectors[area]())
        except Exception as error:
            translated = problem_from_exception(error, area=area)
            checks.append(
                _check(
                    area,
                    f"{area.capitalize()} could not be checked safely.",
                    [translated],
                )
            )
    return checks


def collect_health(
    home: str,
    runtime_dir: str,
    config_home: str,
    *,
    deep: bool = False,
    now_ns: int | None = None,
) -> dict[str, Any]:
    """Collect a bounded, read-only health projection.

    Fast mode deliberately does not call storage fsck. Deep mode adds the
    existing read-only integrity scan and complete open-Episode recovery plans.
    """

    checks = _collect_checks(
        home,
        runtime_dir,
        config_home,
        areas=HEALTH_AREAS,
        deep=deep,
        now_ns=now_ns,
    )
    problems = [item for check in checks for item in check["problems"]]
    status = _aggregate_status(problems)
    return {
        "schema": REPORT_SCHEMA,
        "mode": "deep" if deep else "fast",
        "status": status,
        "exitCode": exit_code(status),
        "readOnly": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "home": str(Path(home).expanduser().resolve()),
        "runtimeDir": str(Path(runtime_dir).expanduser().resolve()),
        "checks": checks,
        "problemCount": len(problems),
        "problems": problems,
    }


def collect_preflight(
    home: str,
    runtime_dir: str,
    config_home: str,
    profile_id: str,
    *,
    now_ns: int | None = None,
) -> dict[str, Any]:
    """Collect the fresh, bounded areas declared by one command profile.

    Preflight is deliberately uncached and always fast. It is a diagnostic
    projection before a command, never the authoritative fence at its write
    point.
    """

    profiles = _contract().get("preflightProfiles") or {}
    if profile_id not in profiles:
        raise ValueError(f"unknown diagnostic preflight profile: {profile_id}")
    profile = copy.deepcopy(profiles[profile_id])
    if profile.get("mode") != "fast" or profile.get("cacheAllowed") is not False:
        raise ValueError(f"unsafe diagnostic preflight profile: {profile_id}")
    checks = _collect_checks(
        home,
        runtime_dir,
        config_home,
        areas=profile["areas"],
        deep=False,
        now_ns=now_ns,
    )
    problems = [item for check in checks for item in check["problems"]]
    status = _aggregate_status(problems)
    decision = str(profile["statusPolicy"].get(status) or "block")
    return {
        "schema": PREFLIGHT_SCHEMA,
        "profile": profile_id,
        "mode": "fast",
        "areas": list(profile["areas"]),
        "freshness": profile["freshness"],
        "cacheAllowed": False,
        "cached": False,
        "status": status,
        "decision": decision,
        "exitCode": exit_code(status),
        "readOnly": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "problemCount": len(problems),
        "problems": problems,
    }


def validate_report(report: Mapping[str, Any]) -> None:
    contract = _contract()
    schema = copy.deepcopy(contract["reportSchema"])
    problem_schema = contract["problemSchema"]
    schema["properties"]["problems"]["items"] = problem_schema
    schema["properties"]["checks"]["items"]["properties"]["problems"]["items"] = (
        problem_schema
    )
    contract_runtime.validate_json_schema(report, schema, "health report")


def validate_preflight(report: Mapping[str, Any]) -> None:
    contract = _contract()
    schema = copy.deepcopy(contract["preflightSchema"])
    problem_schema = contract["problemSchema"]
    schema["properties"]["problems"]["items"] = problem_schema
    schema["properties"]["checks"]["items"]["properties"]["problems"]["items"] = (
        problem_schema
    )
    contract_runtime.validate_json_schema(report, schema, "health preflight")
