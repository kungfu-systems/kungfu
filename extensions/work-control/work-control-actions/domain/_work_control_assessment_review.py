# SPDX-License-Identifier: Apache-2.0

"""Independent completion review and continuation decisions."""

import time
from typing import Any

from ._work_control_assessment_claims import assess_completion
from .work_control_runtime import (
    AGENT_FACT_SOURCE_ID,
    COMPLETION_PURPOSE,
    CONTINUATION_ACTIONS,
    CONTINUATION_DECISION,
    INDEPENDENT_REVIEW,
    REVIEW_SURFACE_ID,
    REVIEW_VERDICTS,
    _ensure_native_write_allowed,
    _native_source,
    _put_native_fact,
    _root_id,
    _sha256_root,
    _stable_id,
    _tracked_completion_evidence,
    create_assignment,
    query_state,
)


def _review_verdict(
    report: dict[str, Any], claim_record: dict[str, Any]
) -> tuple[str, list[str], list[dict[str, str]]]:
    fitness = str(report.get("fitness") or "unverifiable")
    verdict = {
        "fit": "fit",
        "insufficient": "insufficient",
        "conflicted": "conflicted",
        "stale": "stale",
        "unverifiable": "unverifiable",
    }.get(fitness, "unverifiable")
    findings = list(report.get("findings") or [])
    requests = []
    for row in claim_record.get("evidence_availability", []):
        state = str(row.get("state") or "")
        if state == "available":
            continue
        request = {
            "acceptance": str(row.get("acceptance") or ""),
            "level": str(row.get("level") or ""),
            "state": state,
            "action": "request-evidence",
        }
        if request["level"] == "full":
            request["command"] = (
                "./shifu workspace request-full-evidence <checkout> --json"
            )
        requests.append(request)
        findings.append(
            f"{request['level']} evidence is {state} for {request['acceptance']}"
        )
        if request["level"] == "thin" or state == "missing":
            verdict = "insufficient"
        elif verdict == "fit":
            verdict = "partial"
    gaps = [str(row) for row in claim_record.get("known_gaps", []) if str(row)]
    if gaps and verdict == "fit":
        verdict = "partial"
    findings.extend(f"known gap: {row}" for row in gaps)
    if verdict not in REVIEW_VERDICTS:
        verdict = "unverifiable"
    return verdict, findings, requests


def _continuation_actions(verdict: str) -> list[str]:
    return {
        "fit": ["approve", "close"],
        "partial": ["adjust", "request-evidence", "create-follow-up"],
        "insufficient": ["request-evidence", "reopen", "create-follow-up"],
        "conflicted": ["request-evidence", "reopen"],
        "stale": ["request-evidence", "reopen"],
        "unverifiable": ["request-evidence", "reopen", "create-follow-up"],
    }[verdict]


def _bounded_followups(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if len(rows or []) > 6:
        raise ValueError(
            "continuation plans may contain at most six follow-up Assignment rows"
        )
    result: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            raise ValueError(  # noqa: TRY004 - stable public validation surface
                "follow-up Assignment rows must be objects"
            )
        assignment_id = _stable_id(
            str(row.get("assignment_id") or ""), "followup.assignment_id"
        )
        title = str(row.get("title") or "").strip()
        objective = str(row.get("objective") or "").strip()
        why_created = str(row.get("why_created") or "").strip()
        if not title or not objective or not why_created:
            raise ValueError(
                "follow-up Assignment title, objective, and why_created are required"
            )
        result.append(
            {
                "assignment_id": assignment_id,
                "title": title,
                "objective": objective,
                "why_created": why_created,
                "depends_on": sorted(
                    {
                        _stable_id(str(value), "followup.depends_on")
                        for value in row.get("depends_on", [])
                    }
                ),
                "acceptance_root": _root_id(
                    str(row.get("acceptance_root") or ""),
                    "followup.acceptance_root",
                ),
            }
        )
    if len({row["assignment_id"] for row in result}) != len(result):
        raise ValueError("continuation plan follow-up assignment ids must be unique")
    result.sort(key=lambda row: row["assignment_id"])
    return result


def _tracked_empty_delta_closes_episode_gap(
    report: dict[str, Any],
    claim_record: dict[str, Any],
    tracked_evidence: dict[str, Any],
) -> bool:
    """Admit exact empty-delta proof only when Episode absence is the sole gap."""

    composite = report.get("composite_proof") or {}
    assessment = report.get("assessment") or {}
    assessment_report = assessment.get("report") or {}
    assessment_evidence = assessment_report.get("evidence") or {}
    return (
        report.get("fitness") == "insufficient"
        and assessment.get("state") == "unverifiable"
        and assessment_report.get("state") == "unverifiable"
        and assessment_evidence.get("conflict_count") == 0
        and assessment_evidence.get("unregistered_surface_count") == 0
        and assessment_evidence.get("incompatible_schema_count") == 0
        and assessment_evidence.get("ambiguous_authority_count") == 0
        and assessment_evidence.get("unverifiable_count") == 1
        and tracked_evidence.get("valid") is True
        and (
            (tracked_evidence.get("cut") or {}).get("episodes") == []
            or (
                tracked_evidence.get("authority") == "kungfu-assignment-request"
                and tracked_evidence.get("cut") == {}
            )
        )
        and claim_record.get("evidence_episodes", []) == []
        and composite.get("verified_evidence", []) == []
        and composite.get("invalid_evidence", []) == []
        and not claim_record.get("known_gaps")
        and all(
            str(row.get("state") or "") == "available"
            for row in claim_record.get("evidence_availability", [])
        )
    )


def review_completion(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    reviewer: str,
    reviewer_source: str,
    storage_source_id: str = "kungfu",
    purpose: str = COMPLETION_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
    proposed_followups: list[dict[str, Any]] | None = None,
    checkout_path: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    """Write an independent exact-cut review and deterministic continuation plan."""

    _ensure_native_write_allowed(runtime_dir)
    reviewer = reviewer.strip()
    reviewer_source = reviewer_source.strip()
    if not reviewer or not reviewer_source:
        raise ValueError("reviewer and reviewer_source are required")
    report = assess_completion(
        runtime_dir,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
        storage_source_id=storage_source_id,
        purpose=purpose,
        cut_system_time=cut_system_time,
        executor_profile=executor_profile,
        authorized_by=reviewer,
    )
    claim_id = str(report["claim"]["id"])
    claim_rows = [
        row
        for row in report["state"]["claims"]
        if row.get("payload", {}).get("record", {}).get("claim_id") == claim_id
    ]
    if len(claim_rows) != 1:
        raise ValueError("review requires one exact completion claim")
    claim_row = claim_rows[0]
    claim_record = dict(claim_row["payload"]["record"])
    claimant = str(claim_record.get("asserted_by") or "")
    if not claimant or claimant == reviewer:
        raise ValueError("independent reviewer identity must differ from claimant")
    claimant_source = str(
        claim_row.get("payload", {}).get("source", {}).get("source_id") or ""
    )
    if reviewer_source in {claimant, claimant_source}:
        raise ValueError("independent reviewer source must differ from claimant source")
    verdict, findings, evidence_requests = _review_verdict(report, claim_record)
    tracked_evidence = None
    if checkout_path.strip():
        tracked_evidence = _tracked_completion_evidence(
            checkout_path, report["state"], assignment_id, claim_record
        )
        findings.extend(
            f"tracked checkout: {row['code']}: {row['detail']}"
            for row in tracked_evidence["diagnostics"]
        )
        if not tracked_evidence["valid"]:
            verdict = "unverifiable"
        elif _tracked_empty_delta_closes_episode_gap(
            report, claim_record, tracked_evidence
        ):
            verdict = "fit"
            findings.append(
                "tracked Project Cut proves an explicit empty Episode delta"
            )
    followups = _bounded_followups(proposed_followups)
    trust_basis = {
        "schema": "kungfu.work-control.review-trust-basis/v1",
        "claim_id": claim_id,
        "claim_payload_hash": claim_row["payload_hash"],
        "assessment_key": report["assessment_key"],
        "assessment_report_hash": report.get("report_hash") or "",
        "query_definition_root": report["query_definition_root"],
        "query_proof_root": report["query_proof_root"],
        "reviewer": reviewer,
        "reviewer_source": reviewer_source,
        "verdict": verdict,
        "findings": findings,
        "evidence_requests": evidence_requests,
        "tracked_evidence_root": (
            tracked_evidence.get("evidence_root") if tracked_evidence else None
        ),
    }
    trust_report_root = _sha256_root(trust_basis)
    plan = {
        "schema": "kungfu.work-control.continuation-plan/v1",
        "claim_id": claim_id,
        "verdict": verdict,
        "allowed_actions": _continuation_actions(verdict),
        "evidence_requests": evidence_requests,
        "followups": followups,
        "authority_gate": (
            "mechanical-only; initiative, authority, privacy, security, public-claim, "
            "and irreversible changes require a human actor"
        ),
    }
    plan_root = _sha256_root(plan)
    review_basis = {
        "schema": "kungfu.work-control.independent-review-basis/v1",
        "initiative_subject": report["state"]["initiative_subject"],
        "assignment_subject": report["claim"]["assignment_subject"],
        "trust_report_root": trust_report_root,
        "plan_root": plan_root,
    }
    review_id = f"review-{_sha256_root(review_basis)[7:31]}"
    record = {
        "review_id": review_id,
        "review_type": INDEPENDENT_REVIEW,
        "claim_id": claim_id,
        "claimant": claimant,
        "reviewer": reviewer,
        "reviewer_source": reviewer_source,
        "purpose": purpose,
        "verdict": verdict,
        "findings": findings,
        "trust_report_root": trust_report_root,
        "assessment_key": report["assessment_key"],
        "assessment_report_hash": report.get("report_hash") or "",
        "query_definition_root": report["query_definition_root"],
        "query_proof_root": report["query_proof_root"],
        "claim_payload_hash": claim_row["payload_hash"],
        "tracked_evidence": tracked_evidence,
        "continuation_plan": plan,
        "continuation_plan_root": plan_root,
    }
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": AGENT_FACT_SOURCE_ID,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": reviewer,
        },
        "links": {
            "initiative_id": report["state"]["initiative_subject"],
            "assignment_id": report["claim"]["assignment_subject"],
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="independent-review",
        surface_id=REVIEW_SURFACE_ID,
        subject_key=f"kungfu:review:{review_id}",
        source_id=AGENT_FACT_SOURCE_ID,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    return {
        "schema": "kungfu.work-control.independent-review/v1",
        "review": record,
        "review_root": _sha256_root(record),
        "continuation_plan_root": plan_root,
        "trust_report": report,
        "receipt": receipt,
    }


def decide_continuation(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    review_id: str,
    expected_review_root: str,
    expected_plan_root: str,
    action: str,
    actor: str,
    actor_type: str = "agent",
    change_class: str = "mechanical",
    storage_source_id: str = "kungfu",
    reason: str = "",
    system_time: int = 0,
) -> dict[str, Any]:
    """Append an exact-review continuation decision and materialize bounded follow-ups."""

    _ensure_native_write_allowed(runtime_dir)
    action = action.strip()
    actor = actor.strip()
    reason = reason.strip()
    if action not in CONTINUATION_ACTIONS or not actor or not reason:
        raise ValueError("valid action, actor, and reason are required")
    if change_class != "mechanical" and actor_type != "user":
        raise ValueError(f"human-decision-required for change class {change_class}")
    if action == "stop" and actor_type != "user":
        raise ValueError("stop requires a human actor")
    state = query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
    )
    assignment_id = _stable_id(assignment_id, "assignment_id")
    review_id = _stable_id(review_id, "review_id")
    rows = [
        row
        for row in state["reviews"]
        if row.get("payload", {}).get("record", {}).get("review_id") == review_id
        and row.get("payload", {}).get("record", {}).get("review_type")
        == INDEPENDENT_REVIEW
    ]
    if len(rows) != 1:
        raise ValueError("continuation decision requires one exact independent review")
    review_row = rows[0]
    review = dict(review_row["payload"]["record"])
    review_root = _sha256_root(review)
    if review_root != _root_id(
        expected_review_root, "expected_review_root", required=True
    ):
        raise ValueError("independent review changed before continuation decision")
    if review["continuation_plan_root"] != _root_id(
        expected_plan_root, "expected_plan_root", required=True
    ):
        raise ValueError("continuation plan changed before decision")
    if action not in review["continuation_plan"]["allowed_actions"]:
        raise ValueError(
            f"continuation action {action} is not allowed for verdict {review['verdict']}"
        )
    decision_basis = {
        "schema": "kungfu.work-control.continuation-decision-basis/v1",
        "review_id": review_id,
        "review_root": review_root,
        "plan_root": expected_plan_root,
        "action": action,
        "actor": actor,
        "actor_type": actor_type,
        "change_class": change_class,
        "reason": reason,
    }
    decision_id = f"decision-{_sha256_root(decision_basis)[7:31]}"
    record = {
        "decision_id": decision_id,
        "review_type": CONTINUATION_DECISION,
        "review_id": review_id,
        "review_root": review_root,
        "continuation_plan_root": expected_plan_root,
        "action": action,
        "actor": actor,
        "actor_type": actor_type,
        "change_class": change_class,
        "reason": reason,
    }
    assignment_subject = next(
        (
            str(row["subject_key"])
            for row in state["assignments"]
            if row.get("subject_key") in {assignment_id, f"kungfu:{assignment_id}"}
            or row.get("payload", {}).get("record", {}).get("assignment_id")
            == assignment_id
        ),
        "",
    )
    if not assignment_subject:
        raise ValueError(f"Assignment not found under Initiative: {assignment_id}")
    source_id = _native_source(actor_type)
    payload = {
        "record": record,
        "source": {
            "authority_mode": "kungfu-native",
            "source_id": source_id,
            "source_time": "journal-system-time",
            "payload_hash": _sha256_root(record),
            "actor": actor,
        },
        "links": {
            "initiative_id": state["initiative_subject"],
            "assignment_id": assignment_subject,
        },
    }
    receipt = _put_native_fact(
        runtime_dir,
        kind="continuation-decision",
        surface_id=REVIEW_SURFACE_ID,
        subject_key=f"kungfu:decision:{decision_id}",
        source_id=source_id,
        payload=payload,
        system_time=system_time or time.time_ns(),
    )
    created = []
    if action == "create-follow-up":
        parent_record = next(
            row["payload"]["record"]
            for row in state["assignments"]
            if row.get("subject_key") == assignment_subject
        )
        owning_workspace_identity_root = str(
            parent_record.get("owning_workspace_identity_root") or ""
        )
        for followup in review["continuation_plan"]["followups"]:
            created.append(
                create_assignment(
                    runtime_dir,
                    initiative_id=str(state["initiative_subject"]).split(":", 1)[-1],
                    assignment_id=followup["assignment_id"],
                    title=followup["title"],
                    objective=followup["objective"],
                    actor=actor,
                    actor_type=actor_type,
                    storage_source_id=storage_source_id,
                    parent_assignment_id=assignment_id,
                    depends_on=followup["depends_on"],
                    owning_workspace_identity_root=owning_workspace_identity_root,
                    responsibility=followup["why_created"],
                    acceptance_root=followup["acceptance_root"],
                )
            )
    return {
        "schema": "kungfu.work-control.continuation-decision/v1",
        "decision": record,
        "receipt": receipt,
        "created_followups": created,
    }
