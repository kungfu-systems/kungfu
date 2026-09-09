# SPDX-License-Identifier: Apache-2.0

"""Cost/state proof and read-only Work Control query profiles."""

import json
from pathlib import Path
from typing import Any

from kungfu.rewind import ACTION_COST_SNAPSHOT
from kungfu.rewind import replay as rewind_replay
from kungfu.storage import service as storage_service

from .work_control_runtime import (
    ATTRIBUTION_NAMES,
    COMPLETION_CLAIM,
    COST_STATE_PROOF_PROFILE_ID,
    COST_STATE_PROOF_PROFILE_VERSION,
    PROGRESS_POLICY,
    WORK_CONTROL_PROFILE_ID,
    WORK_CONTROL_PROFILE_VERSION,
    WORK_CONTROL_QUESTIONS,
    WORK_CONTROL_REDUCER,
    _profile_context,
    _runtime_query_definition,
    _sha256_root,
    _verified_episode,
    query_state,
)


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
