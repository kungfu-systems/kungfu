# SPDX-License-Identifier: Apache-2.0

"""Cost/state profiles, assessments, reviews, and continuation decisions."""

import json
import time
from pathlib import Path
from typing import Any

from kungfu import profile_composition, profile_sdk
from kungfu.rewind import ACTION_COST_SNAPSHOT
from kungfu.rewind import replay as rewind_replay
from kungfu.storage import service as storage_service

from .work_control_runtime import (
    AGENT_FACT_SOURCE_ID,
    ASSIGNMENT_SURFACE_ID,
    ATTRIBUTION_NAMES,
    COMPLETION_CLAIM,
    COMPLETION_PURPOSE,
    CONTINUATION_ACTIONS,
    CONTINUATION_DECISION,
    COST_STATE_PROOF_PROFILE_ID,
    COST_STATE_PROOF_PROFILE_VERSION,
    INDEPENDENT_REVIEW,
    PROGRESS_CLAIM,
    PROGRESS_POLICY,
    PROGRESS_PURPOSE,
    REVIEW_SURFACE_ID,
    REVIEW_VERDICTS,
    ROOT_ID,
    USER_FACT_SOURCE_ID,
    WORK_CONTROL_PROFILE_ID,
    WORK_CONTROL_PROFILE_VERSION,
    WORK_CONTROL_QUESTIONS,
    WORK_CONTROL_REDUCER,
    _ensure_native_write_allowed,
    _native_source,
    _profile_context,
    _put_native_fact,
    _root_id,
    _runtime_query_definition,
    _sha256_root,
    _stable_id,
    _tracked_completion_evidence,
    _verified_episode,
    create_assignment,
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


def _responsibility_state(state: dict[str, Any]) -> dict[str, Any]:
    source_statuses = [
        str(row.get("payload", {}).get("record", {}).get("status") or "unknown")
        for row in state.get("assignments", [])
    ]
    normalized = []
    for status in source_statuses:
        if status in {"blocked", "paused"}:
            normalized.append("blocked")
        elif status in {"waiting", "waiting-for-decision"}:
            normalized.append("waiting-for-decision")
        elif status in {"claimed-complete", "completed", "merged", "closed"}:
            normalized.append("claimed-complete")
        elif status in {"active", "reviewing", "stage-ready", "ready"}:
            normalized.append("active")
        else:
            normalized.append("proposed")
    has_completion_claim = any(
        row.get("payload", {}).get("record", {}).get("claim_type") == COMPLETION_CLAIM
        for row in state.get("claims", [])
    )
    if has_completion_claim:
        normalized.append("claimed-complete")
    selected = "proposed"
    for candidate in (
        "blocked",
        "waiting-for-decision",
        "claimed-complete",
        "active",
    ):
        if candidate in normalized:
            selected = candidate
            break
    return {
        "value": selected,
        "source_statuses": source_statuses,
        "mapping_policy": "kungfu.profile.responsibility-state/v1",
        "assignment_subjects": [
            str(row.get("subject_key") or "") for row in state.get("assignments", [])
        ],
        "completion_claim_count": len(state.get("claims", [])),
    }


def _cost_work_ids(state: dict[str, Any]) -> set[str]:
    work_ids = {
        str(row.get("subject_key") or "") for row in state.get("assignments", [])
    }
    work_ids.update(
        str(row.get("payload", {}).get("record", {}).get("assignment_id") or "")
        for row in state.get("assignments", [])
    )
    work_ids.discard("")
    return work_ids


def _cost_episode_rows(runtime_dir: str) -> list[dict[str, Any]]:
    # Open the Episode fold before Rewind readers. Both are journal-backed, and
    # this pins one visibility frontier for the profile instead of letting a
    # later reader construction observe a different filesystem snapshot.
    first_rows = storage_service.episode_list(runtime_dir).get("episodes", [])
    refreshed_rows = storage_service.episode_list(runtime_dir).get("episodes", [])
    return list(
        {
            str(row.get("episode_id") or ""): row
            for row in [*first_rows, *refreshed_rows]
        }.values()
    )


def _cost_run_index(
    runtime_dir: str, episode_rows: list[dict[str, Any]]
) -> tuple[Path, list[str], dict[str, dict[str, Any]]]:
    episode_by_run = {
        source.removeprefix("rewind:"): episode
        for episode in episode_rows
        if (source := str(episode.get("open", {}).get("source") or "")).startswith(
            "rewind:"
        )
    }
    rewind_root = Path(runtime_dir) / "rewind"
    run_ids = set(episode_by_run)
    if rewind_root.is_dir():
        run_ids.update(path.name for path in rewind_root.iterdir() if path.is_dir())
    return rewind_root, sorted(run_ids), episode_by_run


def _cost_manifest_episode_id(run_dir: Path) -> str:
    if not run_dir.is_dir():
        return ""
    manifest_path = run_dir / "bundle" / "manifest.json"
    if not manifest_path.is_file():
        return ""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        episode_id = manifest.get("fact_bridge", {}).get("episode_id") or ""
        return str(episode_id) if str(episode_id).isdigit() else ""
    except (OSError, ValueError, TypeError):
        return ""


def _cost_fact_text(fact: dict[str, Any], key: str, default: str = "") -> str:
    return str(fact.get(key) or default)


def _cost_fact_int(fact: dict[str, Any], key: str) -> int:
    return int(fact.get(key) or 0)


def _cost_fact_usd(fact: dict[str, Any]) -> float | None:
    return float(fact.get("cost_usd") or 0.0) if fact.get("cost_usd_known") else None


def _cost_observation(run_id: str, header: Any, fact: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": _cost_fact_text(fact, "run_id", run_id),
        "work_id": _cost_fact_text(fact, "work_id"),
        "system_time": str(header.gen_time),
        "provider": _cost_fact_text(fact, "provider"),
        "surface": _cost_fact_text(fact, "surface"),
        "model": _cost_fact_text(fact, "model"),
        "source": _cost_fact_text(fact, "source"),
        "attribution": ATTRIBUTION_NAMES.get(
            _cost_fact_int(fact, "attribution"), "unknown"
        ),
        "attribution_rank": _cost_fact_int(fact, "attribution"),
        "ambiguous": bool(fact.get("ambiguous_attribution")),
        "input_tokens": _cost_fact_int(fact, "input_tokens"),
        "output_tokens": _cost_fact_int(fact, "output_tokens"),
        "cached_input_tokens": _cost_fact_int(fact, "cached_input_tokens"),
        "cache_creation_input_tokens": _cost_fact_int(
            fact, "cache_creation_input_tokens"
        ),
        "reasoning_tokens": _cost_fact_int(fact, "reasoning_tokens"),
        "cost_usd": _cost_fact_usd(fact),
    }


def _cost_run_observations(
    runtime_dir: str,
    run_id: str,
    work_ids: set[str],
    cost_cut: int,
) -> list[dict[str, Any]]:
    observations = []
    for action_type, header, payload in rewind_replay.read_frames(runtime_dir, run_id):
        if action_type != ACTION_COST_SNAPSHOT:
            continue
        if cost_cut and int(header.gen_time) > cost_cut:
            continue
        fact = rewind_replay.decode_native(action_type, payload)
        if str(fact.get("work_id") or "") in work_ids:
            observations.append(_cost_observation(run_id, header, fact))
    return observations


def _cost_observations(
    runtime_dir: str,
    rewind_root: Path,
    run_ids: list[str],
    work_ids: set[str],
    cost_cut: int,
) -> tuple[list[dict[str, Any]], dict[str, str], list[dict[str, str]]]:
    observations: list[dict[str, Any]] = []
    episode_id_by_run = {}
    unreadable_runs = []
    for run_id in run_ids:
        episode_id = _cost_manifest_episode_id(rewind_root / run_id)
        if episode_id:
            episode_id_by_run[run_id] = episode_id
        try:
            observations.extend(
                _cost_run_observations(runtime_dir, run_id, work_ids, cost_cut)
            )
        except (FileNotFoundError, RuntimeError, ValueError) as error:
            unreadable_runs.append({"run_id": run_id, "error": type(error).__name__})
    return observations, episode_id_by_run, unreadable_runs


def _cost_proof_episodes(
    runtime_dir: str,
    observations: list[dict[str, Any]],
    episode_id_by_run: dict[str, str],
    episode_by_run: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, str]], list[str]]:
    proof_episodes = []
    unsealed_runs = []
    for run_id in sorted({row["run_id"] for row in observations}):
        episode_id = episode_id_by_run.get(run_id)
        episode = episode_by_run.get(run_id)
        if episode_id is None and episode is not None:
            episode_id = str(episode["episode_id"])
        if episode_id is None:
            unsealed_runs.append(run_id)
            continue
        try:
            verified = _verified_episode(runtime_dir, int(episode_id))
        except ValueError:
            unsealed_runs.append(run_id)
            continue
        proof_episodes.append(
            {
                "run_id": run_id,
                "episode_id": episode_id,
                "episode_root": verified["episode_root"],
            }
        )
    return proof_episodes, unsealed_runs


def _cost_profile(runtime_dir: str, state: dict[str, Any]) -> dict[str, Any]:
    work_ids = _cost_work_ids(state)
    declared_cut = state.get("cut", {}).get("declared", {})
    cost_cut = (
        int(declared_cut.get("system_time") or 0)
        if declared_cut.get("kind") == "system_time"
        else 0
    )
    rewind_root, run_ids, episode_by_run = _cost_run_index(
        runtime_dir, _cost_episode_rows(runtime_dir)
    )
    observations, episode_id_by_run, unreadable_runs = _cost_observations(
        runtime_dir, rewind_root, run_ids, work_ids, cost_cut
    )
    proof_episodes, unsealed_runs = _cost_proof_episodes(
        runtime_dir, observations, episode_id_by_run, episode_by_run
    )

    tokens = {
        name: sum(int(row[name]) for row in observations)
        for name in (
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "cache_creation_input_tokens",
            "reasoning_tokens",
        )
    }
    known_costs = [
        float(row["cost_usd"])
        for row in observations
        if row.get("cost_usd") is not None
    ]
    ambiguous = any(bool(row["ambiguous"]) for row in observations)
    if not observations:
        status = "missing"
    elif ambiguous:
        status = "ambiguous"
    elif len(known_costs) != len(observations) or unsealed_runs:
        status = "partial"
    else:
        status = "attributed"
    ranks = [int(row["attribution_rank"]) for row in observations]
    return {
        "status": status,
        "observation_count": len(observations),
        "linked_run_count": len({row["run_id"] for row in observations}),
        "tokens": tokens,
        "cost_usd": round(sum(known_costs), 12) if known_costs else None,
        "cost_usd_known": bool(observations) and len(known_costs) == len(observations),
        "attribution": {
            "best": ATTRIBUTION_NAMES.get(min(ranks), "unknown")
            if ranks
            else "missing",
            "worst": ATTRIBUTION_NAMES.get(max(ranks), "unknown")
            if ranks
            else "missing",
            "ambiguous": ambiguous,
        },
        "observations": observations,
        "proof_episodes": proof_episodes,
        "missing": {
            "unsealed_runs": unsealed_runs,
            "unreadable_runs": unreadable_runs,
            "no_linked_cost_fact": not observations,
        },
    }


def build_cost_state_proof_profile(
    runtime_dir: str,
    state: dict[str, Any],
    *,
    assessment_state: str,
    report_hash: str | None,
    assignment_subject: str | None = None,
) -> dict[str, Any]:
    """Compose the first commercial profile without creating new authorities."""

    profile_state = state
    if assignment_subject:
        profile_state = {
            **state,
            "assignments": [
                row
                for row in state.get("assignments", [])
                if row["subject_key"] == assignment_subject
            ],
            "claims": [
                row
                for row in state.get("claims", [])
                if row.get("payload", {}).get("links", {}).get("assignment_id")
                == assignment_subject
            ],
        }
    cost = _cost_profile(runtime_dir, profile_state)
    proof = {
        "canonical_state": bool(state.get("canonical_state")),
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "query_result_hash": state["result_hash"],
        "verified_fact_episode_roots": state["lineage"].get(
            "episode_content_roots", []
        ),
        "cost_episode_roots": cost["proof_episodes"],
        "assessment_state": assessment_state,
        "assessment_report_hash": report_hash,
        "conflicts": state["lineage"].get("conflicts", []),
        "unverifiable_inputs": state["lineage"].get("unverifiable_inputs", []),
    }
    profile = {
        "schema": "kungfu.profile.delegated-work-cost-state-proof/v1",
        "profile": {
            "id": COST_STATE_PROOF_PROFILE_ID,
            "version": COST_STATE_PROOF_PROFILE_VERSION,
        },
        "initiative_subject": state["initiative_subject"],
        "assignment_subject": assignment_subject,
        "cost": cost,
        "state": _responsibility_state(profile_state),
        "proof": proof,
    }
    profile["profile_hash"] = _sha256_root(profile)
    return profile


def _work_control_answers(
    state: dict[str, Any],
    *,
    fitness: str,
    assessment_state: str,
    findings: list[str],
    known_limits: list[str],
) -> list[dict[str, Any]]:
    initiative = (state.get("initiative") or {}).get("payload", {}).get("record", {})
    assignments = [
        row.get("payload", {}).get("record", {}) for row in state.get("assignments", [])
    ]
    statuses: dict[str, int] = {}
    for assignment in assignments:
        status = str(assignment.get("status") or "unknown")
        statuses[status] = statuses.get(status, 0) + 1
    status_summary = " · ".join(
        f"{status}={statuses[status]}" for status in sorted(statuses)
    )

    intent = "Not yet declared. Create or import a Initiative."
    if initiative:
        identity = str(
            initiative.get("title") or initiative.get("initiative_id") or "Initiative"
        )
        intent = f"{identity} — {initiative.get('intent') or 'intent not declared'}"
        if initiative.get("stage_name"):
            intent += f" · stage {initiative['stage_name']}"

    actual = "No admitted Assignment activity is visible at this cut."
    if assignments:
        actual = f"{len(assignments)} Assignment(s) at this cut"
        if status_summary:
            actual += f" · {status_summary}"

    declared_actions = []
    for assignment in assignments:
        if str(assignment.get("next_action") or "").strip():
            declared_actions.append(
                {
                    "actor": str(
                        assignment.get("owner_agent") or assignment.get("actor") or ""
                    ),
                    "subject": str(assignment.get("assignment_id") or ""),
                    "action": str(assignment["next_action"]),
                    "source": "go.next_action",
                }
            )
    if str(initiative.get("next_action") or "").strip():
        declared_actions.append(
            {
                "actor": str(initiative.get("owner") or ""),
                "subject": str(initiative.get("initiative_id") or ""),
                "action": str(initiative["next_action"]),
                "source": "initiative.next_action",
            }
        )
    if declared_actions:
        next_summary = " · ".join(
            f"{item['actor'] or item['subject'] or 'declared actor'}: {item['action']}"
            for item in declared_actions
        )
        responsibility_state = "declared"
    elif fitness == "fit":
        next_summary = "No next action or responsible actor is declared at this cut."
        responsibility_state = "undeclared"
    else:
        next_summary = (
            "A decision or additional evidence is required, but no responsible "
            "actor is declared at this cut."
        )
        responsibility_state = "needs-decision"

    proof_suffix = str(state.get("query_proof_root") or "")[-12:]
    answers_by_id: dict[str, dict[str, Any]] = {
        "initiative-intent": {
            "status": "declared" if initiative else "missing",
            "summary": intent,
            "data": {"initiative": initiative},
        },
        "observed-progress": {
            "status": "observed" if assignments else "missing",
            "summary": actual,
            "data": {"assignment_count": len(assignments), "status_counts": statuses},
        },
        "evidence-at-cut": {
            "status": "established" if state.get("canonical_state") else "degraded",
            "summary": (
                f"{'canonical' if state.get('canonical_state') else 'degraded'} cut"
                f" · {len(findings)} finding(s) · proof {proof_suffix or '-'}"
            ),
            "data": {
                "canonical_state": bool(state.get("canonical_state")),
                "cut": state.get("cut", {}),
                "findings": findings,
                "query_definition_root": state.get("query_definition_root", ""),
                "query_proof_root": state.get("query_proof_root", ""),
            },
        },
        "fitness-for-purpose": {
            "status": fitness,
            "summary": (
                f"{fitness} · assessment {assessment_state}"
                f" · residual limits {len(known_limits)}"
            ),
            "data": {
                "fitness": fitness,
                "assessment_state": assessment_state,
                "known_limits": known_limits,
            },
        },
        "next-responsibility": {
            "status": responsibility_state,
            "summary": next_summary,
            "data": {"declared_actions": declared_actions},
        },
    }
    return [
        {"question_id": question_id, "question": question, **answers_by_id[question_id]}
        for question_id, question in WORK_CONTROL_QUESTIONS
    ]


def build_work_control_query_profile(
    runtime_dir: str,
    state: dict[str, Any],
    *,
    fitness: str,
    assessment_state: str,
    findings: list[str],
    known_limits: list[str],
) -> dict[str, Any]:
    """Reduce one public Profile query receipt into the five Initiative questions."""

    definition = _runtime_query_definition(state["definition"])
    if definition.get("schema") != "kungfu.query.definition/v1":
        raise RuntimeError("Work Control profile requires one portable QueryDefinition")
    context = _profile_context(runtime_dir)
    catalog = context["catalog"]
    views = [
        {
            "view_id": row["id"],
            "title": row["title"],
            "fact_surfaces": row["factSurfaces"],
            "query_family": row.get("queryFamily"),
            "view": row["view"],
        }
        for row in catalog["views"]
    ]
    profile = {
        "schema": "kungfu.work-control.query-profile/v1",
        "profile": {
            "id": WORK_CONTROL_PROFILE_ID,
            "version": WORK_CONTROL_PROFILE_VERSION,
            "reducer": WORK_CONTROL_REDUCER,
            "profile_suite_root": catalog["profileSuiteRoot"],
            "catalog_root": catalog["catalogRoot"],
            "member_roots": catalog["memberRoots"],
        },
        "initiative_subject": state["initiative_subject"],
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "result_hash": state["result_hash"],
        "query_receipt": state["profile_query_receipt"],
        "views": views,
        "answers": _work_control_answers(
            state,
            fitness=fitness,
            assessment_state=assessment_state,
            findings=findings,
            known_limits=known_limits,
        ),
    }
    profile["profile_hash"] = _sha256_root(profile)
    return profile


def query_initiative_home(
    runtime_dir: str,
    *,
    initiative_id: str,
    storage_source_id: str = "kungfu",
    cut_system_time: int = 0,
) -> dict[str, Any]:
    """Return the five-question Initiative Home without persisting an assessment.

    This is the read-only surface for presentation hosts.  It deliberately
    reuses the exact public state query and Profile reducer used by
    ``assess_progress`` while keeping assessment authorization and Episode
    creation out of a refresh path.
    """

    state = query_state(
        runtime_dir,
        initiative_id=initiative_id,
        storage_source_id=storage_source_id,
        cut_system_time=cut_system_time,
    )
    if not state["rows"]:
        raise ValueError(
            "Initiative Home requires admitted Initiative or Assignment facts"
        )
    fitness, findings = _progress_fitness(state, "fresh")
    known_limits = ["read-only snapshot; no purpose-bound assessment was executed"]
    query_profile = build_work_control_query_profile(
        runtime_dir,
        state,
        fitness=fitness,
        assessment_state="not-assessed",
        findings=findings,
        known_limits=known_limits,
    )
    return {
        "schema": "kungfu.work-control.initiative-home/v1",
        "mode": "read-only",
        "fitness": fitness,
        "findings": findings,
        "known_limits": known_limits,
        "state": state,
        "query_definition_root": state["query_definition_root"],
        "query_proof_root": state["query_proof_root"],
        "query_profile": query_profile,
    }


def _progress_fitness(
    state: dict[str, Any], assessment_state: str
) -> tuple[str, list[str]]:
    if assessment_state != "fresh":
        mapped = {
            "insufficient-evidence": "insufficient",
            "conflicted": "conflicted",
            "stale": "stale",
            "unverifiable": "unverifiable",
        }
        return mapped.get(assessment_state, "warning"), [
            f"assessment state is {assessment_state}"
        ]
    if not state.get("canonical_state"):
        return "unverifiable", ["query lineage is not canonical"]
    if state.get("initiative") is None:
        return "insufficient", ["Initiative fact is missing"]
    assignments = state.get("assignments", [])
    if not assignments:
        return "insufficient", ["no linked Assignment facts are admitted"]
    statuses = [
        str(row.get("payload", {}).get("record", {}).get("status") or "unknown")
        for row in assignments
    ]
    warning_statuses = set(PROGRESS_POLICY["rules"]["warning_statuses"])
    progress_statuses = set(PROGRESS_POLICY["rules"]["progress_statuses"])
    findings = [f"linked Assignment statuses: {', '.join(statuses)}"]
    if any(status in warning_statuses for status in statuses):
        return "warning", findings
    if any(status in progress_statuses for status in statuses):
        return "fit", findings
    return "warning", findings + ["no Assignment carries a recognized progress state"]


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
