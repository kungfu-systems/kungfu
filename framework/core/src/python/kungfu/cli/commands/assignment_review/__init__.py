# SPDX-License-Identifier: Apache-2.0

"""Pure planning, prompt, and receipt helpers for native Project Work."""

from __future__ import annotations

import json
import os
from pathlib import Path

from kungfu import assignment_orchestration as orchestration
from kungfu.initiative_family.canonical import semantic_root
from kungfu import profile_sdk
from kungfu.agent import run_agent
from kungfu.workspace import resolve_workspace_target


def review_work_ref(plan):
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": plan["workspace"]["id"],
        "profileId": "kungfu.work-control",
        "profileRoot": plan["execution"]["workRef"]["profileRoot"],
        "entityType": "assignment",
        "entityId": plan["work"]["assignmentId"],
        "entityRoot": plan["work"]["assignmentRoot"],
        "purpose": "independent-completion-review",
        "systemTimeCut": plan["work"]["queryProofRoot"],
        "initiativeId": plan["work"]["initiativeId"],
    }


def review_intake_assessment(plan):
    remaining_obligation = (
        "Independently assess every exact acceptance criterion against the "
        "retained Project evidence."
    )
    next_action = (
        "Inspect the retained evidence read-only and return the exact "
        "KUNGFU_REVIEW_RESULT line."
    )
    return {
        "schema": "kungfu.review-intake-assessment/v1",
        "state": "independent-review-required",
        "currentCutRoot": plan["work"]["queryProofRoot"],
        "priorClaimRoot": plan["execution"]["reportRoot"],
        "primaryEvidence": dict(plan["deliverable"]),
        "supportingEvidence": [dict(row) for row in plan["inputs"]],
        "acceptanceChecks": list(plan["work"]["acceptanceChecks"]),
        "remainingObligation": remaining_obligation,
        "nextAction": next_action,
    }


def review_continuation(plan):
    assessment = review_intake_assessment(plan)
    return {
        "schema": run_agent.CONTINUATION_SCHEMA,
        "workRef": review_work_ref(plan),
        "currentCutRoot": plan["work"]["queryProofRoot"],
        "priorClaimRoot": plan["execution"]["reportRoot"],
        "assessmentRoot": run_agent.canonical_root(assessment),
        "remainingObligation": assessment["remainingObligation"],
        "nextAction": assessment["nextAction"],
    }


def review_agent_prompt(plan):
    acceptance_checks = plan["work"]["acceptanceChecks"]
    criteria = "\n".join(f"- {value}" for value in acceptance_checks)
    criterion_fields = "\n".join(
        f"{index}. criterion must equal {json.dumps(value, ensure_ascii=False)}"
        for index, value in enumerate(acceptance_checks, start=1)
    )
    inputs = "\n".join(f"- {row['path']} ({row['root']})" for row in plan["inputs"])
    intake_assessment = review_intake_assessment(plan)
    admission_context = {
        "schema": "kungfu.review-context/v1",
        "workRef": review_work_ref(plan),
        "continuation": review_continuation(plan),
        "assessment": intake_assessment,
        "execution": {
            "mode": "fresh-independent-review",
            "permissionMode": "read-only",
            "priorTranscriptBytes": 0,
        },
    }
    return (
        "Independently review the retained Project Work evidence. "
        "This is a fresh review process with no prior transcript. Stay read-only: "
        "do not edit, create, delete, rename, or format any project file.\n\n"
        "Admitted WorkRef and continuation (machine-readable; this prompt is "
        "self-contained):\n"
        f"{json.dumps(admission_context, ensure_ascii=False, sort_keys=True)}\n\n"
        f"Primary evidence: {plan['deliverable']['path']} "
        f"({plan['deliverable']['root']})\n"
        f"Supporting evidence:\n{inputs or '- none'}\n\n"
        f"Acceptance criteria:\n{criteria}\n\n"
        "Read the primary and supporting evidence. Evidence objects with a "
        "content field already contain the exact root-bound source bytes: assess "
        "that admitted content directly and do not invoke a workspace command to "
        "reread its path. Use a workspace tool only for evidence rows that do not "
        "contain content. Check every criterion against exact source evidence. "
        "Your final line must be exactly one line "
        "beginning with KUNGFU_REVIEW_RESULT followed by a JSON object with keys: "
        'verdict ("fit" or "revision-required"), summary (string), criteria '
        "(one object per exact criterion with criterion, passed, evidence), and "
        "evidenceRequests (array of strings). The criteria array must contain "
        f"exactly {len(acceptance_checks)} objects in the listed order. Preserve "
        "these criterion fields exactly:\n"
        f"{criterion_fields}\n"
        "Set passed to a boolean and evidence to a non-empty source citation for "
        "every object. A statement in summary does not count as criterion coverage. "
        "Do not merge or omit criteria. Do not wrap the final line in a code fence. "
        "Use fit only when every criterion passes."
    )


def parse_reviewer_result(report, acceptance_checks):
    text = str((report.get("providerObservation") or {}).get("text") or "")
    marker = "KUNGFU_REVIEW_RESULT "
    candidates = [
        line.split(marker, 1)[1].strip() for line in text.splitlines() if marker in line
    ]
    if not candidates:
        raise ValueError("Reviewer did not return KUNGFU_REVIEW_RESULT")
    try:
        value = json.loads(candidates[-1])
    except json.JSONDecodeError as error:
        raise ValueError("Reviewer result JSON is invalid") from error
    if not isinstance(value, dict):
        raise ValueError("Reviewer result must be a JSON object")
    criteria = value.get("criteria")
    if not isinstance(criteria, list) or len(criteria) != len(acceptance_checks):
        raise ValueError("Reviewer result must cover every acceptance criterion")
    normalized = []
    observed = set()
    for row in criteria:
        if not isinstance(row, dict):
            raise ValueError("Reviewer criterion result must be an object")
        criterion = str(row.get("criterion") or "")
        if criterion not in acceptance_checks or criterion in observed:
            raise ValueError("Reviewer criterion identity is missing or duplicated")
        if not isinstance(row.get("passed"), bool):
            raise ValueError("Reviewer criterion passed must be boolean")
        evidence = str(row.get("evidence") or "").strip()
        if not evidence:
            raise ValueError("Reviewer criterion evidence is required")
        observed.add(criterion)
        normalized.append(
            {
                "criterion": criterion,
                "passed": row["passed"],
                "evidence": evidence,
            }
        )
    if observed != set(acceptance_checks):
        raise ValueError("Reviewer result does not cover the exact criteria")
    passed = all(row["passed"] for row in normalized)
    verdict = str(value.get("verdict") or "")
    if verdict not in {"fit", "revision-required"}:
        raise ValueError("Reviewer verdict is not supported")
    if (verdict == "fit") != passed:
        raise ValueError("Reviewer verdict conflicts with criterion results")
    requests = value.get("evidenceRequests")
    if not isinstance(requests, list) or not all(
        isinstance(row, str) and row.strip() for row in requests
    ):
        raise ValueError("Reviewer evidenceRequests must be an array of strings")
    summary = str(value.get("summary") or "").strip()
    if not summary:
        raise ValueError("Reviewer summary is required")
    return {
        "verdict": verdict,
        "summary": summary,
        "criteria": normalized,
        "evidenceRequests": [row.strip() for row in requests],
    }


def exact_pending_fit_review(current, *, missing_message, conflicting_message):
    reviews = list(current.get("independent_reviews") or [])
    decisions = list(current.get("continuation_decisions") or [])
    decided_review_ids = {str(row.get("review_id") or "") for row in decisions}
    pending = [
        row
        for row in reviews
        if str(row.get("review_id") or "") not in decided_review_ids
        and row.get("verdict") == "fit"
    ]
    if not pending:
        raise ValueError(missing_message)
    exact_fit_roots = {
        (
            str(row.get("claim_id") or ""),
            str(row.get("claim_payload_hash") or ""),
            str(row.get("continuation_plan_root") or ""),
        )
        for row in pending
    }
    if len(exact_fit_roots) != 1:
        raise ValueError(conflicting_message)
    # Repeated requests may retain equivalent reviews for one exact claim.
    return pending[-1]


def build_plan(
    *,
    config_home,
    runtime_home,
    request_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    profile_id,
    actor,
    allow_foreign_binding,
    profile_source,
    status_reader,
):
    captured = orchestration.load_captured_request(request_file)
    projected = orchestration.assignment_projection(
        captured,
        initiative_id=initiative_id,
        assignment_id=assignment_id,
    )
    target = resolve_workspace_target(
        "capture-only",
        workspace_root or None,
        home=home,
        cwd=os.getcwd(),
    )
    selected, selection = run_agent.select_profile(
        profile_id,
        config_home=config_home,
        runtime_home=runtime_home,
    )
    verification = run_agent.runtime_profiles.verify_profile(selected)
    binding = orchestration.binding_provenance(allow_foreign=allow_foreign_binding)
    work_control = profile_sdk.validate_source(
        profile_source(), str(target.runtime_dir)
    )["inspection"]
    current_phase = "captured"
    if Path(target.runtime_dir).is_dir():
        try:
            current_phase = status_reader(
                str(target.runtime_dir),
                projected["initiative_id"],
                projected["assignment_id"],
            )["phase"]
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            current_phase = "captured"
    continuation_mode, effects, phase_blocked_reason = phase_plan(current_phase)
    project_trust = provider_project_trust(
        str(selected["provider"]), target.identity.workspace_root
    )
    effects = effects_with_project_trust(effects, project_trust)
    stable_verification = {
        "ok": verification["ok"],
        "available": verification["available"],
        "version": verification["version"],
        "error": verification["error"],
    }
    blocked_reason = phase_blocked_reason
    if blocked_reason is None and not binding["ok"]:
        blocked_reason = "Native Work admission binding did not verify."
    if blocked_reason is None and not stable_verification["ok"]:
        blocked_reason = "The selected Agent runtime did not verify."
    body = {
        "schema": "kungfu.work-start.plan/v1",
        "workspace": {
            "id": target.identity.workspace_id,
            "root": target.identity.workspace_root,
            "identityRoot": target.identity.identity_root,
            "initialized": target.identity.initialized,
        },
        "work": {
            "requestPath": str(Path(request_file).expanduser().resolve()),
            "requestRoot": projected["request_root"],
            "initiativeId": projected["initiative_id"],
            "assignmentId": projected["assignment_id"],
            "title": projected["title"],
            "objective": projected["objective"],
            "acceptanceChecks": list(
                projected["work_definition"].get("acceptance_criteria") or []
            ),
            "phase": current_phase,
        },
        "agent": {
            "id": selected["id"],
            "label": selected["label"],
            "provider": selected["provider"],
            "profileRoot": run_agent.canonical_root(selected),
            "selection": selection,
            "verification": stable_verification,
            "projectTrust": project_trust,
        },
        "workControl": {
            "profileId": work_control["profile"]["id"],
            "profileRoot": work_control["profile_suite_root"],
        },
        "admissionBinding": {
            "ok": binding["ok"],
            "state": binding["state"],
            "override": binding["override"],
            "provenanceRoot": binding["provenance_root"],
            "sourceRevision": binding["source_revision"],
        },
        "actor": actor,
        "continuationMode": continuation_mode,
        "effects": effects,
        "skippedEffects": [
            "completion-claim",
            "independent-review",
            "continuation-decision",
            "git-init",
            "git-commit",
            "git-push",
            "publish",
        ],
        "confirmationRequired": True,
        "blockedReason": blocked_reason,
        "executable": bool(
            continuation_mode is not None
            and binding["ok"]
            and stable_verification["ok"]
        ),
        "writeOccurred": False,
    }
    return {**body, "planRoot": semantic_root(body)}


def provider_project_trust(provider, workspace_root):
    if provider != "codex":
        return None
    return {
        "schema": "kungfu.agent-project-trust/v1",
        "provider": "codex",
        "workspaceRoot": workspace_root,
        "scope": "single-invocation",
        "allows": [
            "project-local-config",
            "project-local-hooks",
            "project-local-exec-policies",
        ],
        "persistent": False,
    }


def effects_with_project_trust(effects, project_trust):
    if project_trust is None:
        return effects
    trust_effect = {
        "stage": "project-trust",
        "label": (
            "Trust only this exact Project for this Codex invocation: "
            f"{project_trust['workspaceRoot']} (admits project-local config, "
            "hooks, and exec policies)"
        ),
    }
    result = list(effects)
    run_index = next(
        (index for index, effect in enumerate(result) if effect["stage"] == "run"),
        len(result),
    )
    result.insert(run_index, trust_effect)
    return result


def phase_plan(phase):
    retain = {
        "stage": "retain",
        "label": "Retain the Agent Episode and report without claiming completion",
    }
    if phase == "captured":
        return (
            "first-attempt",
            [
                {
                    "stage": "admit",
                    "label": "Admit the captured Initiative and Assignment into Work Control",
                },
                {
                    "stage": "claim",
                    "label": "Mint a two-hour execution lease for the selected Agent",
                },
                {
                    "stage": "kickoff",
                    "label": "Enter the executing phase under that exact lease",
                },
                {
                    "stage": "run",
                    "label": "Launch one fresh Agent process in this project workspace",
                },
                retain,
            ],
            None,
        )
    if phase == "admitted":
        return (
            "existing-admitted-work",
            [
                {
                    "stage": "claim",
                    "label": "Mint a two-hour execution lease for the admitted Work",
                },
                {
                    "stage": "kickoff",
                    "label": "Enter the executing phase under that exact lease",
                },
                {
                    "stage": "run",
                    "label": "Launch one fresh Agent process in this project workspace",
                },
                retain,
            ],
            None,
        )
    if phase == "claimed":
        return (
            "existing-claimed-work",
            [
                {
                    "stage": "kickoff",
                    "label": "Enter the executing phase under the active Work lease",
                },
                {
                    "stage": "run",
                    "label": "Launch one fresh Agent process in this project workspace",
                },
                retain,
            ],
            None,
        )
    if phase == "executing":
        return (
            "existing-executing-work",
            [
                {
                    "stage": "run",
                    "label": "Launch one fresh Agent attempt under the active Work lease",
                },
                {
                    **retain,
                    "label": "Retain the new Agent Episode without repeating admission",
                },
            ],
            None,
        )
    if phase == "stage-ready":
        reason = (
            "This Work is stage-ready. Review or settle it before creating "
            "follow-up Work."
        )
    elif phase == "completion-claimed":
        reason = (
            "This Work is completion-claimed and awaiting independent review; "
            "another execution attempt is not allowed."
        )
    elif phase == "independently-reviewed":
        reason = (
            "This Work is independently-reviewed. Decide continuation before "
            "creating follow-up Work."
        )
    elif phase == "continuation-decided":
        reason = (
            "This Work is settled (continuation-decided). Create follow-up Work "
            "to run another Agent."
        )
    else:
        reason = f"Work phase {phase!r} cannot start an Agent attempt."
    return None, [], reason


def project_prompt(plan):
    work = plan["work"]
    checks = "\n".join(f"- {value}" for value in work["acceptanceChecks"])
    return (
        "Work on the admitted Kungfu Assignment in this project.\n\n"
        "Kungfu checked native authority immediately before this process launch. "
        "The admitted WorkRef in your context envelope is the exact executing "
        "status cut for this run; use it to satisfy the Work-state check and do "
        "not locate or invoke another Kungfu executable.\n\n"
        "Read AGENTS.md when present, then inspect the project files relevant to "
        "the objective before editing. Follow project-local instructions and use "
        "only supported facts. Do not edit .kungfu, initialize Git, commit, push, "
        "publish, or claim that Work is complete.\n\n"
        f"Objective:\n{work['objective']}\n\n"
        f"Acceptance checks:\n{checks}\n\n"
        "When the file is ready, report what changed, the source file behind each "
        "claim, every acceptance check you verified, and any unresolved question. "
        "Kungfu will retain this run as evidence; independent assessment remains "
        "required."
    )


def receipt(body):
    return {**body, "receiptRoot": semantic_root(body)}


def native_receipt_root(payload):
    value = payload.get("receipt") if isinstance(payload, dict) else None
    if not isinstance(value, dict):
        return None
    root = value.get("payload_hash")
    return root if isinstance(root, str) and root else None


def admission_summary(admission, status):
    initiative = admission.get("initiative_receipt") or {}
    assignment = admission.get("assignment_receipt") or {}
    workspace = admission["workspace"]
    return {
        "schema": "kungfu.work-start.authority-effect/v1",
        "stage": "admit",
        "phase": admission["phase"],
        "requestRoot": admission["request_root"],
        "initiativeReceiptRoot": native_receipt_root(initiative),
        "assignmentReceiptRoot": native_receipt_root(assignment),
        "queryProofRoot": status["query_proof_root"],
        "workspaceId": workspace["workspace_id"],
        "workspaceIdentityRoot": workspace["identity_root"],
        "binding": {
            "state": admission["binding"]["state"],
            "provenanceRoot": admission["binding"]["provenance_root"],
            "override": admission["binding"]["override"],
        },
    }


def claim_summary(claim_receipt, status):
    claim = claim_receipt["claim"]
    return {
        "schema": "kungfu.work-start.authority-effect/v1",
        "stage": "claim",
        "claimId": claim["claim_id"],
        "leaseId": claim["lease_id"],
        "leaseExpiresAt": claim["lease_expires_at"],
        "agent": claim["agent"],
        "receiptRoot": native_receipt_root(claim_receipt),
        "queryProofRoot": status["query_proof_root"],
    }


def kickoff_summary(kickoff_receipt):
    transition = kickoff_receipt["transition"]
    status = kickoff_receipt["status"]
    return {
        "schema": "kungfu.work-start.authority-effect/v1",
        "stage": "kickoff",
        "transitionId": transition["claim_id"],
        "leaseId": transition["lease_id"],
        "fromPhase": transition["from_phase"],
        "toPhase": transition["to_phase"],
        "receiptRoot": native_receipt_root(kickoff_receipt),
        "queryProofRoot": status["query_proof_root"],
    }


def agent_report_summary(agent_report):
    observation = agent_report.get("providerObservation") or {}
    return {
        "schema": "kungfu.work-start.agent-report-ref/v1",
        "runId": agent_report["runId"],
        "reportRoot": agent_report["reportRoot"],
        "runtimeProfile": agent_report["runtimeProfile"],
        "launch": {
            "exitCode": agent_report["launch"]["exitCode"],
            "interrupted": agent_report["launch"]["interrupted"],
            "timedOut": agent_report["launch"]["timedOut"],
            "wallTimeNs": agent_report["launch"]["wallTimeNs"],
        },
        "providerSessionIds": list(observation.get("providerSessionIds") or []),
        "work": agent_report["work"],
        "episode": agent_report["episode"],
        "session": agent_report.get("session"),
    }
