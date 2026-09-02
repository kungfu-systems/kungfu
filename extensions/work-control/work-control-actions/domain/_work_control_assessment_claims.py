# SPDX-License-Identifier: Apache-2.0

"""Purpose-bound Work Control progress and completion assessments."""

from typing import Any

from kungfu import profile_composition, profile_sdk
from kungfu.storage import service as storage_service

from ._work_control_assessment_profile import (
    _progress_fitness,
    build_cost_state_proof_profile,
    build_work_control_query_profile,
)
from .work_control_runtime import (
    AGENT_FACT_SOURCE_ID,
    ASSIGNMENT_SURFACE_ID,
    COMPLETION_CLAIM,
    COMPLETION_PURPOSE,
    PROGRESS_CLAIM,
    PROGRESS_PURPOSE,
    ROOT_ID,
    USER_FACT_SOURCE_ID,
    _profile_context,
    _sha256_root,
    _stable_id,
    _verified_episode,
    query_state,
)


def _assessment_conflicts(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Retain raw lineage while excluding one exact native Assignment definition."""

    rows = {str(row.get("observation_id") or ""): row for row in state.get("rows", [])}
    unresolved = []
    for conflict in state["lineage"].get("conflicts", []):
        admitted = [
            rows.get(str(observation_id or ""))
            for observation_id in conflict.get("observation_ids", [])
        ]
        if len(admitted) != 2 or any(row is None for row in admitted):
            unresolved.append(conflict)
            continue
        versions = []
        for row in admitted:
            if row is None:
                continue
            record = dict(row.get("payload", {}).get("record", {}))
            roots = (
                str(record.get("request_root") or ""),
                str(record.get("work_definition_root") or ""),
            )
            record.pop("actor", None)
            record.pop("actor_type", None)
            versions.append(
                (
                    str(row.get("fact_surface_id") or ""),
                    str(row.get("source_id") or ""),
                    *roots,
                    _sha256_root(record),
                )
            )
        equivalent = (
            len(versions) == 2
            and {row[0] for row in versions} == {ASSIGNMENT_SURFACE_ID}
            and {row[1] for row in versions}
            == {AGENT_FACT_SOURCE_ID, USER_FACT_SOURCE_ID}
            and all(ROOT_ID.fullmatch(root) for row in versions for root in row[2:4])
            and len({row[2:] for row in versions}) == 1
        )
        if not equivalent:
            unresolved.append(conflict)
    return unresolved


def _assessment_evidence(state: dict[str, Any]) -> dict[str, int]:
    lineage = state["lineage"]
    counts = {
        "admitted": 0,
        "unregistered-surface": 0,
        "incompatible-schema": 0,
        "ambiguous-authority": 0,
        "unverifiable": 0,
    }
    for row in lineage.get("admission_outcomes", []):
        outcome = str(row.get("outcome") or "unverifiable")
        if outcome in counts:
            counts[outcome] += int(row.get("record_count") or 0)
    return {
        "canonical_fact_count": len(state["rows"]),
        "conflict_count": len(_assessment_conflicts(state)),
        "admitted_count": counts["admitted"],
        "unregistered_surface_count": counts["unregistered-surface"],
        "incompatible_schema_count": counts["incompatible-schema"],
        "ambiguous_authority_count": counts["ambiguous-authority"],
        "unverifiable_count": counts["unverifiable"]
        + len(lineage.get("unverifiable_inputs", [])),
    }


def _execute_profile_assessment(
    runtime_dir: str,
    *,
    source: str,
    query_receipt: dict[str, Any],
    claim_type_id: str,
    claim_instance_id: str,
    policy_id: str,
    purpose: str,
    work_episode_id: int,
    independent_observation: dict[str, Any],
    executor_profile: str,
    authorized_by: str,
    assessment_conflicts: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if assessment_conflicts is not None:
        result = dict(query_receipt["result"])
        lineage = dict(result["lineage"])
        lineage["conflicts"] = assessment_conflicts
        result["lineage"] = lineage
        query_receipt = {**query_receipt, "result": result}
    plan = profile_composition.assessment_plan(
        source,
        runtime_dir,
        query_receipt,
        claim_id=claim_type_id,
        claim_instance_id=claim_instance_id,
        policy_id=policy_id,
        purpose=purpose,
        work_episode_id=work_episode_id,
        independent_observation=independent_observation,
        executor_profile=executor_profile,
    )
    authorization = profile_sdk.answer_decision(
        plan["decisionCard"], "approve", authorized_by
    )
    receipt = profile_composition.authorized_assessment_execute(
        runtime_dir, plan, authorization
    )
    return plan, authorization, receipt


def assess_progress(
    runtime_dir: str,
    *,
    initiative_id: str,
    storage_source_id: str = "kungfu",
    purpose: str = PROGRESS_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
    authorized_by: str = "kungfu-work-control",
) -> dict[str, Any]:
    """Persist and expose the first purpose-bound Initiative progress report."""

    state = query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    if not state["rows"]:
        raise ValueError("Initiative progress assessment requires admitted facts")
    context = _profile_context(runtime_dir)
    work_row = max(state["rows"], key=lambda row: int(row["system_time"]))
    work_episode_id = str(work_row["episode_id"])
    root_rows = {
        str(row.get("episode_id")): str(row.get("computed") or "")
        for row in state["lineage"].get("episode_content_roots", [])
    }
    work_episode_root = root_rows.get(work_episode_id, "")
    if not work_episode_root:
        raise RuntimeError(
            "selected Initiative/Assignment fact Episode has no verified root"
        )
    claim_basis = {
        "claim_type": PROGRESS_CLAIM,
        "initiative_subject": state["initiative_subject"],
        "purpose": purpose,
        "query_result_hash": state["result_hash"],
    }
    claim_instance_id = f"initiative-progress-{_sha256_root(claim_basis)[7:31]}"
    plan, authorization, receipt = _execute_profile_assessment(
        runtime_dir,
        source=context["source"],
        query_receipt=state["profile_query_receipt"],
        claim_type_id=PROGRESS_CLAIM,
        claim_instance_id=claim_instance_id,
        policy_id="initiative-progress-policy",
        purpose=purpose,
        work_episode_id=int(work_episode_id),
        independent_observation={
            "episodeRoot": work_episode_root,
            "authority": "admitted-source",
            "relation": "admitted-source",
        },
        executor_profile=executor_profile,
        authorized_by=authorized_by,
    )
    assessed = receipt["assessment"]
    request = plan["request"]
    fitness, findings = _progress_fitness(state, assessed["state"])
    report_hash = assessed.get("report", {}).get("report_hash")
    query_profile = build_work_control_query_profile(
        runtime_dir,
        state,
        fitness=fitness,
        assessment_state=assessed["state"],
        findings=findings,
        known_limits=request["residual_risks"],
    )
    return {
        "schema": "kungfu.work-control.trust-report/v1",
        "claim": {
            "id": claim_instance_id,
            "type": PROGRESS_CLAIM,
            "purpose": purpose,
        },
        "fitness": fitness,
        "findings": findings,
        "known_limits": request["residual_risks"],
        "state": state,
        "assessment": assessed,
        "assessment_plan": plan,
        "assessment_authorization": authorization,
        "assessment_receipt": receipt,
        "assessment_key": assessed["assessment_key"],
        "report_hash": report_hash,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "query_profile": query_profile,
        "profile": build_cost_state_proof_profile(
            runtime_dir,
            state,
            assessment_state=assessed["state"],
            report_hash=report_hash,
        ),
    }


def assess_completion(
    runtime_dir: str,
    *,
    initiative_id: str,
    assignment_id: str,
    storage_source_id: str = "kungfu",
    purpose: str = COMPLETION_PURPOSE,
    cut_system_time: int = 0,
    executor_profile: str = "thread",
    authorized_by: str = "kungfu-work-control",
) -> dict[str, Any]:
    """Assess one explicit completion claim against independent Episode proof."""

    state = query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    assignment_id = _stable_id(assignment_id, "assignment_id")
    assignments = [
        row
        for row in state["assignments"]
        if row.get("subject_key") == assignment_id
        or row.get("subject_key") == f"kungfu:{assignment_id}"
        or row.get("payload", {}).get("record", {}).get("assignment_id")
        == assignment_id
    ]
    assignment_subjects = {str(row.get("subject_key") or "") for row in assignments}
    if len(assignment_subjects) != 1 or "" in assignment_subjects:
        raise ValueError(
            f"Assignment is missing or ambiguous under Initiative: {assignment_id}"
        )
    assignment_subject = next(iter(assignment_subjects))
    claims = [
        row
        for row in state["claims"]
        if row.get("payload", {}).get("record", {}).get("claim_type")
        == COMPLETION_CLAIM
        and row.get("payload", {}).get("links", {}).get("assignment_id")
        == assignment_subject
    ]
    if not claims:
        raise ValueError(f"completion claim not found for Assignment: {assignment_id}")
    context = _profile_context(runtime_dir)
    claim = max(claims, key=lambda row: int(row["system_time"]))
    claim_record = claim["payload"]["record"]
    verified_evidence = []
    invalid_evidence = []
    for reference in claim_record.get("evidence_episodes", []):
        episode_id = int(reference["episode_id"])
        try:
            current = _verified_episode(runtime_dir, episode_id)
        except ValueError as error:
            invalid_evidence.append(
                {"episode_id": str(episode_id), "reason": str(error)}
            )
            continue
        if current["episode_root"] != reference.get("episode_root"):
            invalid_evidence.append(
                {
                    "episode_id": str(episode_id),
                    "reason": "content root changed since the claim",
                }
            )
            continue
        verified_evidence.append(current)

    root_rows = {
        str(row.get("episode_id")): str(row.get("computed") or "")
        for row in state["lineage"].get("episode_content_roots", [])
    }
    claim_episode_id = str(claim["episode_id"])
    claim_episode_root = root_rows.get(claim_episode_id, "")
    if verified_evidence:
        work_episode_id = verified_evidence[0]["episode_id"]
        work_episode_root = verified_evidence[0]["episode_root"]
    else:
        work_episode_id = claim_episode_id
        work_episode_root = claim_episode_root
    if not work_episode_root:
        raise RuntimeError("completion claim has no verified work or claim Episode")

    evidence = _assessment_evidence(state)
    if not verified_evidence:
        evidence["unverifiable_count"] += 1
    evidence["unverifiable_count"] += len(invalid_evidence)
    composite_proof = {
        "state_query_proof_root": state["query_proof_root"],
        "completion_claim_observation_id": claim["observation_id"],
        "verified_evidence": verified_evidence,
        "invalid_evidence": invalid_evidence,
    }
    assessment_plan = None
    assessment_authorization = None
    assessment_receipt = None
    if verified_evidence:
        assessment_plan, assessment_authorization, assessment_receipt = (
            _execute_profile_assessment(
                runtime_dir,
                source=context["source"],
                query_receipt=state["profile_query_receipt"],
                claim_type_id=COMPLETION_CLAIM,
                claim_instance_id=claim_record["claim_id"],
                policy_id="task-completion-policy",
                purpose=purpose,
                work_episode_id=int(work_episode_id),
                independent_observation={
                    "episodeRoot": work_episode_root,
                    "authority": "sealed-work-episode",
                    "relation": "observed-work",
                },
                executor_profile=executor_profile,
                authorized_by=authorized_by,
                assessment_conflicts=_assessment_conflicts(state),
            )
        )
        assessed = assessment_receipt["assessment"]
        request = assessment_plan["request"]
    else:
        # Preserve an explicitly insufficient assessment when independent proof
        # is absent; never manufacture evidence or a successful verdict.
        declared_claim = next(
            row for row in context["catalog"]["claims"] if row["id"] == COMPLETION_CLAIM
        )
        declared_policy = next(
            row
            for row in context["catalog"]["policies"]
            if row["id"] == "task-completion-policy"
        )
        request = {
            "claim_id": claim_record["claim_id"],
            "claim_type": declared_claim["type"],
            "purpose": purpose,
            "work_episode_id": work_episode_id,
            "work_episode_root": work_episode_root,
            "query_definition_root": state["query_definition_root"],
            "query_proof_root": _sha256_root(composite_proof),
            "contract_world": state["definition"]["basis"]["contract_world"],
            "fact_surfaces": state["definition"]["basis"]["fact_surfaces"],
            "policy": {
                "id": declared_policy["id"],
                "version": declared_policy["version"],
                "root": _sha256_root(declared_policy),
            },
            "evidence": evidence,
            "deadline": 0,
            "responsibility": declared_policy["responsibility"],
            "residual_risks": declared_policy["residualRisks"],
        }
        requested = storage_service.assessment_request(runtime_dir, request)
        assessed = storage_service.assessment_execute(
            runtime_dir,
            requested["assessment_key"],
            executor_profile=executor_profile,
        )
    if not verified_evidence:
        fitness = "insufficient"
    else:
        fitness = (
            "fit"
            if assessed["state"] == "fresh"
            else {
                "insufficient-evidence": "insufficient",
                "conflicted": "conflicted",
                "stale": "stale",
                "unverifiable": "unverifiable",
            }.get(assessed["state"], "warning")
        )
    findings = [
        f"verified completion evidence Episodes: {len(verified_evidence)}",
        f"invalid completion evidence Episodes: {len(invalid_evidence)}",
    ]
    report_hash = assessed.get("report", {}).get("report_hash")
    return {
        "schema": "kungfu.work-control.trust-report/v1",
        "claim": {
            "id": claim_record["claim_id"],
            "type": COMPLETION_CLAIM,
            "purpose": purpose,
            "assignment_subject": assignment_subject,
        },
        "fitness": fitness,
        "findings": findings,
        "known_limits": request["residual_risks"],
        "state": state,
        "assessment": assessed,
        "assessment_plan": assessment_plan,
        "assessment_authorization": assessment_authorization,
        "assessment_receipt": assessment_receipt,
        "assessment_key": assessed["assessment_key"],
        "report_hash": report_hash,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": request["query_proof_root"],
        "composite_proof": composite_proof,
        "profile": build_cost_state_proof_profile(
            runtime_dir,
            state,
            assessment_state=assessed["state"],
            report_hash=report_hash,
            assignment_subject=assignment_subject,
        ),
    }
