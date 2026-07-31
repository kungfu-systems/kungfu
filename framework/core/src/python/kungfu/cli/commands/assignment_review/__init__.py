# SPDX-License-Identifier: Apache-2.0

"""Pure prompt and result parsing for independent Project Work review."""

from __future__ import annotations

import json


def review_agent_prompt(plan):
    criteria = "\n".join(f"- {value}" for value in plan["work"]["acceptanceChecks"])
    inputs = "\n".join(f"- {row['path']} ({row['root']})" for row in plan["inputs"])
    return (
        "Independently review the completed Starter Project deliverable. "
        "This is a fresh review process with no prior transcript. Stay read-only: "
        "do not edit, create, delete, rename, or format any project file.\n\n"
        f"Deliverable: {plan['deliverable']['path']} "
        f"({plan['deliverable']['root']})\n"
        f"Retained inputs:\n{inputs}\n\n"
        f"Acceptance criteria:\n{criteria}\n\n"
        "Read the deliverable and retained input files. Check every criterion "
        "against exact source evidence. Your final line must be exactly one line "
        "beginning with KUNGFU_REVIEW_RESULT followed by a JSON object with keys: "
        'verdict ("fit" or "revision-required"), summary (string), criteria '
        "(one object per exact criterion with criterion, passed, evidence), and "
        "evidenceRequests (array of strings). Do not wrap that final line in a "
        "code fence. Use fit only when every criterion passes."
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
