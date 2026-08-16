# SPDX-License-Identifier: Apache-2.0

import json
import re
import sys
from pathlib import Path

import click

from kungfu import assignment_orchestration as orchestration
from kungfu.initiative_family.canonical import semantic_root
from kungfu.agent import run_agent
from kungfu.agent import first_value as onboarding
from kungfu.agent import native_launch
from kungfu.agent.run_intent import RunIntentDispatcher
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.workspace import (
    WorkspaceTargetRequired,
    resolve_workspace_target,
)


run_command_context = kfc.pass_context()
_RUN_INTENTS = RunIntentDispatcher()


def _json_file(handle, label):
    if handle is None:
        return None
    try:
        value = json.load(handle)
    except json.JSONDecodeError as error:
        raise click.ClickException(f"invalid {label} JSON: {error}") from error
    if not isinstance(value, dict):
        raise click.ClickException(f"{label} must be a JSON object")
    return value


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=1,
    help="run the next project Work with a verified Agent",
)
@kfd3_api("kungfu.run")
def run():
    """Run governed project Work; low-level runtime launch remains under agent."""


def _captured_work(workspace_root):
    root = (
        Path(workspace_root).expanduser().resolve()
        / ".kungfu"
        / "inbox"
        / "assignment-requests"
        / "sha256"
    )
    result = []
    for request_path in sorted(root.glob("*/*/request.json")):
        try:
            captured = orchestration.load_captured_request(request_path)
            definition = captured["request"].get("workDefinition") or {}
            projected = orchestration.assignment_projection(
                captured,
                initiative_id=str(definition.get("initiative_id") or ""),
                assignment_id=str(definition.get("assignment_id") or ""),
            )
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        result.append(
            {
                "requestPath": str(request_path),
                "requestRoot": projected["request_root"],
                "initiativeId": projected["initiative_id"],
                "assignmentId": projected["assignment_id"],
                "title": projected["title"],
                "objective": projected["objective"],
            }
        )
    return result


def _work_phase(workspace_root, work):
    from kungfu.cli.commands import assignment as work_commands

    runtime_dir = Path(workspace_root) / ".kungfu" / "runtime"
    if not runtime_dir.is_dir():
        return "captured"
    try:
        return work_commands._status(
            str(runtime_dir), work["initiativeId"], work["assignmentId"]
        )["phase"]
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
        return "captured"


def _choose_work(workspace_root, work_selector=None):
    rows = [
        {**row, "phase": _work_phase(workspace_root, row)}
        for row in _captured_work(workspace_root)
    ]
    if work_selector:
        selected = [
            row
            for row in rows
            if work_selector
            in {
                row["assignmentId"],
                row["requestRoot"],
                row["requestPath"],
            }
        ]
        if not selected:
            raise ValueError(f"Work is not captured in this project: {work_selector}")
        if len(selected) != 1:
            raise ValueError(f"Work selector is ambiguous: {work_selector}")
        row = selected[0]
        # An explicit selection is allowed to reach the native start plan even
        # when it is settled. The plan remains non-executable and explains the
        # authoritative phase in GUI/CLI confirmation; execution rechecks the
        # same exact plan and fails closed before any write.
        return row
    else:
        actionable = [
            row for row in rows if row["phase"] in {"captured", "ready", "planned"}
        ]
        if not actionable:
            blocked = [f"{row['assignmentId']} [{row['phase']}]" for row in rows]
            detail = "; ".join(blocked) or "no captured Work"
            raise ValueError(
                "no Work can start in this project; "
                f'{detail}. Pass a task to `kungfu run <agent> "<task>"`, or run '
                "`kungfu agent brief` for the guided first entry. Review or close "
                "active Work before running another Agent."
            )
        if len(actionable) != 1:
            choices = ", ".join(row["assignmentId"] for row in actionable)
            raise ValueError(
                f"multiple Work items can start ({choices}); pass --work <work>"
            )
        row = actionable[0]
    if row["phase"] not in {"captured", "ready", "planned", "executing"}:
        next_step = (
            "review and close it"
            if row["phase"] in {"executing", "stage-ready", "completion-claimed"}
            else "inspect its current Work status"
        )
        raise ValueError(
            f"{row['assignmentId']} is {row['phase']}; {next_step} before another run"
        )
    return row


def _provider_profile(provider, *, config_home, runtime_home, mock_scenario=None):
    if provider == "synthetic":
        return run_agent.runtime_profiles.deterministic_mock_profile(
            mock_scenario or "multi-step"
        )
    catalog = run_agent.runtime_profiles.discover_catalog(
        resolved_config=run_agent.runtime_profiles.kungfu_config.resolve_config(
            config_home=config_home,
            runtime_home=runtime_home,
        )
    )
    candidates = [
        dict(row)
        for row in catalog.get("configured", [])
        if row.get("provider") == provider
    ] + [
        dict(row["profile"])
        for row in catalog.get("discovered", [])
        if (row.get("profile") or {}).get("provider") == provider
    ]
    if not candidates:
        raise ValueError(
            f"no verified {provider} Agent is available; install its CLI or run "
            "`kungfu agent runtime discover`"
        )
    preferred = {
        catalog.get("defaultProfileId"),
        catalog.get("recommendedProfileId"),
    }
    selected = next(
        (row for row in candidates if row.get("id") in preferred), candidates[0]
    )
    verification = run_agent.runtime_profiles.verify_profile(selected)
    if verification.get("ok") is not True:
        raise ValueError(
            f"{selected.get('label') or provider} failed verification: "
            f"{verification.get('error') or 'unavailable'}"
        )
    return selected


def _capture_task(workspace_root, task):
    target = resolve_workspace_target(
        "capture-only", workspace_root, cwd=workspace_root
    )
    slug = re.sub(r"[^a-z0-9]+", "-", task.lower()).strip("-")[:48] or "agent-task"
    suffix = semantic_root({"task": task})[-8:]
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "kungfu-run", "command": "run"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "assignment_id": f"{slug}-{suffix}",
            "initiative_id": "project-work",
            "title": task,
            "objective": task,
            "acceptance_criteria": [
                "The requested outcome is present in the project workspace",
                "Validation evidence and unresolved risks are reported",
            ],
        },
    }
    captured = orchestration.capture_assignment_request(request, target)
    return {
        "requestPath": captured["requestPath"],
        "requestRoot": captured["requestRoot"],
        "initiativeId": "project-work",
        "assignmentId": f"{slug}-{suffix}",
        "title": task,
        "objective": task,
        "phase": "captured",
    }


def _native_work_binding(workspace_root, workspace_id, runtime_dir):
    """Describe current Work without creating, choosing, or advancing it."""

    rows = [
        {**row, "phase": _work_phase(workspace_root, row)}
        for row in _captured_work(workspace_root)
    ]
    active_phases = {*orchestration.PHASES, "captured", "ready", "planned"}
    active = [row for row in rows if row["phase"] in active_phases]
    continuation_decided = [
        row for row in active if row["phase"] == "continuation-decided"
    ]
    settled_subjects = set()
    if continuation_decided:
        try:
            sealed = orchestration.list_sealed_assignment_states(workspace_root)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            return None, {
                "schema": "kungfu.native-work-selection/v1",
                "workspaceId": workspace_id,
                "state": "degraded",
                "candidateAssignmentIds": sorted(row["assignmentId"] for row in active),
                "selectionAuthority": "kungfu-work-cli",
                "entrypoint": "kungfu work status",
                "diagnostic": f"sealed Work index is unavailable: {error}",
            }
        undecidable_subjects = {
            str(row.get("assignment_subject") or "")
            for row in sealed.get("unqualified_states") or []
        }
        if sealed.get("issues") or any(
            f"kungfu:{row['assignmentId']}" in undecidable_subjects
            for row in continuation_decided
        ):
            return None, {
                "schema": "kungfu.native-work-selection/v1",
                "workspaceId": workspace_id,
                "state": "degraded",
                "candidateAssignmentIds": sorted(row["assignmentId"] for row in active),
                "selectionAuthority": "kungfu-work-cli",
                "entrypoint": "kungfu work status",
                "diagnostic": "sealed Work index cannot prove the current continuation boundary",
            }
        settled_subjects = {
            str(row.get("assignment_subject") or "")
            for row in sealed.get("states") or []
            if row.get("settled") is True
        }
    eligible = sorted(
        (
            row
            for row in active
            if f"kungfu:{row['assignmentId']}" not in settled_subjects
        ),
        key=lambda row: row["assignmentId"],
    )
    selection = {
        "schema": "kungfu.native-work-selection/v1",
        "workspaceId": workspace_id,
        "state": "none"
        if not eligible
        else "ambiguous"
        if len(eligible) > 1
        else "single",
        "candidateAssignmentIds": [row["assignmentId"] for row in eligible],
        "settledAssignmentIds": sorted(
            row["assignmentId"]
            for row in active
            if f"kungfu:{row['assignmentId']}" in settled_subjects
        ),
        "selectionAuthority": "kungfu-work-cli",
        "entrypoint": "kungfu work status",
    }
    if len(eligible) == 1:
        row = eligible[0]
        selection.update(
            {
                "state": "single",
                "initiativeId": row["initiativeId"],
                "assignmentId": row["assignmentId"],
                "phase": row["phase"],
            }
        )
    return None, selection


def _native_work_observer(runtime_dir, work_selection, bound_work_ref=None):
    """Build a fresh, read-only Core Work projection for a native attempt."""

    selection = dict(work_selection)
    if bound_work_ref is not None:
        selection.update(
            {
                "state": "bound",
                "initiativeId": str(bound_work_ref.get("initiativeId") or ""),
                "assignmentId": str(bound_work_ref.get("entityId") or ""),
            }
        )
    selection_state = str(selection.get("state") or "unknown")
    initiative_id = str(selection.get("initiativeId") or "")
    assignment_id = str(selection.get("assignmentId") or "")

    def empty_observation(state):
        return {
            "schema": "kungfu.native-work-observation/v1",
            "state": state,
            "initiativeId": initiative_id,
            "assignmentId": assignment_id,
            "title": "",
            "objective": "",
            "acceptanceChecks": [],
            "phase": selection.get("phase"),
            "queryProofRoot": None,
            "nextActions": [],
            "evidenceEpisodeRoots": [],
            "continuation": {
                "completionClaimCount": 0,
                "independentReviewCount": 0,
                "continuationDecisionCount": 0,
            },
            "remainingObligation": None,
            "nextAction": None,
        }

    if selection_state == "none":
        return {"state": "fresh", "work": empty_observation("none")}
    if selection_state == "ambiguous":
        return {"state": "fresh", "work": empty_observation("ambiguous")}
    if selection_state == "single":
        return {"state": "fresh", "work": empty_observation("available")}
    if selection_state != "bound":
        observation = empty_observation("degraded")
        return {
            "state": "degraded",
            "work": observation,
            "diagnostic": str(
                selection.get("diagnostic") or "exact Work binding is unavailable"
            ),
        }
    # Import the Work authority only when this attempt owns an exact WorkRef.
    # Unbound provider-native UIs heartbeat from a background observer thread;
    # loading the complete Work CLI/storage graph there is unnecessary and can
    # interfere with a provider TUI that is still establishing its terminal.
    from kungfu.cli.commands import assignment as work_commands

    try:
        status = work_commands._status(str(runtime_dir), initiative_id, assignment_id)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        observation = empty_observation("degraded")
        return {
            "state": "degraded",
            "work": observation,
            "diagnostic": str(error),
        }
    assignment = dict(status.get("assignment") or {})
    work_definition = dict(assignment.get("work_definition") or {})
    acceptance_checks = [
        str(value).strip()
        for value in list(work_definition.get("acceptance_criteria") or [])
        if str(value).strip()
    ]
    next_action_rows = list(status.get("next_actions") or [])
    next_actions = []
    for row in next_action_rows:
        if isinstance(row, dict):
            action = str(row.get("action") or "").strip()
            description = str(row.get("description") or "").strip()
            next_actions.append(
                ": ".join(value for value in (action, description) if value)
            )
        elif str(row).strip():
            next_actions.append(str(row).strip())
    evidence_roots = assignment.get("evidenceEpisodeRoots")
    if evidence_roots is None:
        evidence_roots = assignment.get("evidence_episode_roots")
    evidence_roots = [
        str(root)
        for root in list(evidence_roots or [])
        if re.fullmatch(r"sha256:[a-f0-9]{64}", str(root))
    ]
    work = {
        "schema": "kungfu.native-work-observation/v1",
        "state": "available",
        "initiativeId": initiative_id,
        "assignmentId": assignment_id,
        "title": str(
            work_definition.get("title") or assignment.get("title") or ""
        ).strip(),
        "objective": str(
            work_definition.get("objective") or assignment.get("objective") or ""
        ).strip(),
        "acceptanceChecks": acceptance_checks,
        "phase": str(status.get("phase") or selection.get("phase") or "") or None,
        "queryProofRoot": status.get("query_proof_root"),
        "nextActions": next_actions,
        "evidenceEpisodeRoots": evidence_roots,
        "continuation": {
            "completionClaimCount": int(status.get("completion_claim_count") or 0),
            "independentReviewCount": int(status.get("independent_review_count") or 0),
            "continuationDecisionCount": int(
                status.get("continuation_decision_count") or 0
            ),
        },
        "remainingObligation": (
            status.get("remainingObligation")
            or status.get("remaining_obligation")
            or (assignment.get("work_definition") or {}).get("remaining_obligation")
            or None
        ),
        "nextAction": next_actions[0] if next_actions else None,
    }
    return {"state": "fresh", "work": work}


def _run_native_provider(ctx, *, provider=None, profile_id=None, workspace_root=None):
    try:
        if profile_id is not None:
            profile, _selection = run_agent.select_profile(
                profile_id,
                config_home=ctx.config_home,
                runtime_home=ctx.home,
            )
        elif provider is not None:
            profile = _provider_profile(
                provider,
                config_home=ctx.config_home,
                runtime_home=ctx.home,
            )
        else:
            profile, _selection = run_agent.select_interactive_profile(
                config_home=ctx.config_home,
                runtime_home=ctx.home,
            )
        target, launch_root, work_ref, work_selection, notices = (
            native_launch.prepare_native_launch(
                ctx,
                workspace_root,
                str(profile.get("provider") or "agent"),
                _native_work_binding,
            )
        )
        for notice in notices:
            click.echo(notice, err=True)
        session_endpoint = run_agent.session_surface.ensure(str(target.runtime_dir))

        def invoke_native_session(request):
            nonlocal session_endpoint
            try:
                return run_agent.session_surface.invoke(
                    request, endpoint=session_endpoint
                )
            except (OSError, ValueError):
                session_endpoint = run_agent.session_surface.ensure(
                    str(target.runtime_dir)
                )
                return run_agent.session_surface.invoke(
                    request, endpoint=session_endpoint
                )

        onboarding_observer = onboarding.AgentRouteCompletionObserver(
            lambda bound_work_ref: _native_work_observer(
                target.runtime_dir, work_selection, bound_work_ref
            ),
            config_home=ctx.config_home,
            runtime_home=ctx.home,
        )

        exit_code = run_agent.run_native_interactive(
            profile,
            runtime_dir=str(target.runtime_dir),
            config_home=ctx.config_home,
            runtime_home=ctx.home,
            workspace_root=launch_root,
            work_ref=work_ref,
            work_selection=work_selection,
            session_endpoint=session_endpoint,
            session_invoker=invoke_native_session,
            work_observer=onboarding_observer,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if onboarding_observer.error is not None:
        click.echo(
            "Warning: Work was bound, but Getting Started state was not saved: "
            f"{onboarding_observer.error}",
            err=True,
        )
    if exit_code != 0:
        provider_name = str(profile.get("provider") or "agent")
        click.echo(
            "Error: provider-native UI "
            f"'{provider_name}' exited with status {exit_code}. "
            "Kungfu ended this SessionAttempt but did not change Work completion. "
            "Run `kungfu agent session list --json` to inspect the attempt; "
            "then retry `kungfu run "
            f"{provider_name}` in the same terminal.",
            err=True,
        )
    ctx.exit(exit_code)


def _run_provider(
    ctx,
    provider,
    task,
    work_selector,
    workspace_root,
    plan_only,
    as_json,
    events_json,
    expected_plan_root,
    allow_foreign_binding,
    mock_scenario=None,
):
    from kungfu.cli.commands import assignment as work_commands

    try:
        target, _launch_root, _resolution = native_launch.resolve_native_launch_target(
            ctx, workspace_root
        )
    except WorkspaceTargetRequired as error:
        raise click.ClickException(
            onboarding.project_required_message(f"kungfu run {provider}")
        ) from error
    if (
        target.identity.workspace_kind != "project"
        or not target.identity.workspace_root
    ):
        raise click.ClickException(
            onboarding.project_required_message(f"kungfu run {provider}")
        )
    root = target.identity.workspace_root
    try:
        work = (
            _capture_task(root, task)
            if task
            else _choose_work(root, work_selector=work_selector)
        )
        profile = _provider_profile(
            provider,
            config_home=ctx.config_home,
            runtime_home=ctx.home,
            mock_scenario=mock_scenario,
        )
        plan = work_commands._work_start_plan(
            config_home=ctx.config_home,
            runtime_home=ctx.home,
            request_file=Path(work["requestPath"]),
            workspace_root=root,
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            profile_id=profile["id"],
            actor="local-user",
            allow_foreign_binding=allow_foreign_binding,
        )
        if expected_plan_root and plan["planRoot"] != expected_plan_root:
            raise ValueError(
                "Work-start plan changed after confirmation; inspect and confirm "
                "the current plan again"
            )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if plan_only:
        click.echo(json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True))
        return
    if not as_json and not events_json:
        click.echo(f"Project: {plan['workspace']['root']}")
        click.echo(f"Work: {plan['work']['assignmentId']} · {plan['work']['title']}")
        click.echo(
            f"Agent: {plan['agent']['label']} · "
            f"{plan['agent']['verification']['version'] or 'verified'}"
        )
        click.echo(f"Plan: {plan['planRoot']}")
        for index, effect in enumerate(plan["effects"], start=1):
            click.echo(f"{index}. {effect['label']}")
        click.echo(
            "Kungfu will retain Agent session activity for independent review; "
            "protected Work history begins only with an accepted domain receipt."
        )
    # Call the same implementation behind `kungfu work start`, with the exact
    # content-bound plan just shown. The wrapped callback returns its receipt.
    result = work_commands.start_work.callback.__wrapped__(
        ctx,
        Path(work["requestPath"]),
        root,
        False,
        work["initiativeId"],
        work["assignmentId"],
        profile["id"],
        "local-user",
        plan["planRoot"],
        True,
        events_json,
        allow_foreign_binding,
        as_json or events_json,
    )
    if result.get("ok") is not True:
        if not as_json and not events_json:
            click.echo(
                f"Work start needs attention · {result.get('status', 'failed')}",
                err=True,
            )
            click.echo(
                f"Next: kungfu work status --workspace {root} "
                f"--initiative-id {work['initiativeId']} "
                f"--assignment-id {work['assignmentId']}",
                err=True,
            )
        raise click.exceptions.Exit(1)
    try:
        onboarding.complete_agent_route(
            config_home=ctx.config_home, runtime_home=ctx.home
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        if not as_json and not events_json:
            click.echo(
                f"Warning: Work started, but Getting Started state was not saved: {error}",
                err=True,
            )
    if not as_json and not events_json:
        report = result.get("agentReport") or {}
        click.echo("Agent session activity retained · independent review required")
        click.echo(f"Project: {root}")
        click.echo(
            f"Work: {work['assignmentId']} · {result.get('workPhase', 'executing')}"
        )
        click.echo(f"Agent: {plan['agent']['label']}")
        if report.get("reportRoot"):
            click.echo(f"Evidence: {report['reportRoot']}")
        click.echo("Next: kungfu")
    return result


def _native_provider_request(
    *,
    task,
    work_selector,
    workspace_root,
    plan_only,
    as_json,
    events_json,
    expected_plan_root,
    allow_foreign_binding,
):
    return _RUN_INTENTS.provider_mode(locals()) == "native"


def _provider_command(provider):
    @run.command(
        name=provider,
        help=f"run the next Project Work with {provider.title()}",
    )
    @click.argument("task", required=False)
    @click.option("--work", "work_selector", default=None)
    @click.option(
        "--workspace",
        "workspace_root",
        type=click.Path(exists=True, file_okay=False, resolve_path=True),
        default=None,
    )
    @click.option("--plan", "plan_only", is_flag=True)
    @click.option("--json", "as_json", is_flag=True)
    @click.option(
        "--events-json",
        is_flag=True,
        help="stream public Work and Agent activity as JSON Lines",
    )
    @click.option("--expected-plan-root", default=None)
    @click.option("--allow-foreign-binding", is_flag=True, hidden=True)
    @run_command_context
    def command(
        ctx,
        task,
        work_selector,
        workspace_root,
        plan_only,
        as_json,
        events_json,
        expected_plan_root,
        allow_foreign_binding,
    ):
        request = {
            "task": task,
            "work_selector": work_selector,
            "workspace_root": workspace_root,
            "plan_only": plan_only,
            "as_json": as_json,
            "events_json": events_json,
            "expected_plan_root": expected_plan_root,
            "allow_foreign_binding": allow_foreign_binding,
        }
        return _RUN_INTENTS.dispatch_provider(
            request=request,
            native=lambda: _run_native_provider(ctx, provider=provider),
            managed=lambda: _run_provider(
                ctx,
                provider,
                task,
                work_selector,
                workspace_root,
                plan_only,
                as_json,
                events_json,
                expected_plan_root,
                allow_foreign_binding,
            ),
        )

    return command


for _provider in ("codex", "claude", "amp", "opencode"):
    _provider_command(_provider)


@run.command(name="mock", help="run deterministic Project Work scenarios", hidden=True)
@click.argument("task", required=False)
@click.option("--work", "work_selector", default=None)
@click.option(
    "--workspace",
    "workspace_root",
    type=click.Path(exists=True, file_okay=False, resolve_path=True),
    default=None,
)
@click.option(
    "--scenario",
    type=click.Choice(run_agent.runtime_profiles.MOCK_SCENARIOS),
    default="multi-step",
    show_default=True,
)
@click.option("--plan", "plan_only", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
@click.option("--events-json", is_flag=True)
@click.option("--expected-plan-root", default=None)
@click.option("--allow-foreign-binding", is_flag=True, hidden=True)
@run_command_context
def mock(
    ctx,
    task,
    work_selector,
    workspace_root,
    scenario,
    plan_only,
    as_json,
    events_json,
    expected_plan_root,
    allow_foreign_binding,
):
    return _run_provider(
        ctx,
        "synthetic",
        task,
        work_selector,
        workspace_root,
        plan_only,
        as_json,
        events_json,
        expected_plan_root,
        allow_foreign_binding,
        mock_scenario=scenario,
    )


@run.command(name="agent", help=api_help("kungfu.run.agent"))
@click.option("--prompt", required=False, help="bounded task for the fresh Agent")
@click.option(
    "--agent",
    "profile_id",
    default=None,
    help="Agent Runtime Profile id; defaults to the verified configured selection",
)
@click.option(
    "--workspace",
    "workspace_root",
    type=click.Path(exists=True, file_okay=False, resolve_path=True),
    default=None,
    help="project working directory for workspace-root profiles",
)
@click.option(
    "--work-ref",
    type=click.File("r", encoding="utf-8"),
    default=None,
    help="exact kungfu.work-ref/v1 JSON",
)
@click.option(
    "--continuation",
    type=click.File("r", encoding="utf-8"),
    default=None,
    help="exact transcript-free continuation envelope JSON",
)
@click.option(
    "--timeout",
    "timeout_seconds",
    type=click.FloatRange(min=1),
    default=900.0,
    show_default=True,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.run.agent")
@run_command_context
def agent(
    ctx,
    prompt,
    profile_id,
    workspace_root,
    work_ref,
    continuation,
    timeout_seconds,
    as_json,
):
    timeout_is_explicit = (
        ctx.get_parameter_source("timeout_seconds")
        == click.core.ParameterSource.COMMANDLINE
    )

    def managed():
        try:
            return run_agent.execute(
                prompt=prompt,
                runtime_dir=ctx.runtime_dir,
                config_home=ctx.config_home,
                profile_id=profile_id,
                workspace_root=workspace_root,
                home=ctx.home,
                work_ref=_json_file(work_ref, "WorkRef"),
                continuation=_json_file(continuation, "continuation envelope"),
                timeout_seconds=timeout_seconds,
            )
        except (OSError, ValueError) as error:
            raise click.ClickException(str(error)) from error

    try:
        payload = _RUN_INTENTS.dispatch_agent(
            prompt=prompt,
            has_managed_options=(
                work_ref is not None
                or continuation is not None
                or as_json
                or timeout_is_explicit
            ),
            native=lambda: _run_native_provider(
                ctx, profile_id=profile_id, workspace_root=workspace_root
            ),
            managed=managed,
        )
    except ValueError as error:
        raise click.UsageError(str(error)) from error
    if prompt is None:
        return payload
    if as_json:
        click.echo(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        click.echo(
            f"{payload['runId']}  {payload['runtimeProfile']['provider']}  "
            f"exit={payload['launch']['exitCode']}"
        )
        click.echo(f"proof: {payload['episode']['manifestPath']}")
        click.echo("History: session activity only; no semantic admission receipt")
        click.echo("Work settlement: independent assessment required")
    sys.exit(int(payload["launch"]["exitCode"]))
