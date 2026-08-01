# SPDX-License-Identifier: Apache-2.0

import json
import os
import re
import sys
from pathlib import Path

import click

from kungfu import assignment_orchestration as orchestration
from kungfu.agent import run_agent
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.workspace import resolve_workspace_target


run_command_context = kfc.pass_context()


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
            projected = orchestration.atlas_assignment_projection(
                captured,
                initiative_id=str(definition.get("mission_id") or ""),
                assignment_id=str(definition.get("goal_id") or ""),
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
                f"{detail}. Review or close active Work before running another Agent."
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
    suffix = orchestration.semantic_root({"task": task})[-8:]
    request = {
        "schema": "kungfu.assignment-request/v1",
        "source": {"kind": "kungfu-run", "command": "run"},
        "retention": {
            "policy": "explicit-expiry-retain-bytes-v1",
            "expiresAt": None,
        },
        "workDefinition": {
            "goal_id": f"{slug}-{suffix}",
            "mission_id": "project-work",
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

    target = resolve_workspace_target(
        "read-only", workspace_root or None, cwd=os.getcwd()
    )
    if (
        target.identity.workspace_kind != "project"
        or not target.identity.workspace_root
    ):
        raise click.ClickException(
            "kungfu run requires a project; cd into one or pass --workspace"
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
            ctx=ctx,
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
            "Kungfu will retain the Agent run for independent review; "
            "process exit does not complete Work."
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
    if not as_json and not events_json:
        report = result.get("agentReport") or {}
        click.echo("Agent run retained · independent review required")
        click.echo(f"Project: {root}")
        click.echo(
            f"Work: {work['assignmentId']} · {result.get('workPhase', 'executing')}"
        )
        click.echo(f"Agent: {plan['agent']['label']}")
        if report.get("reportRoot"):
            click.echo(f"Evidence: {report['reportRoot']}")
        click.echo("Next: kungfu")
    return result


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
        return _run_provider(
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
        )

    return command


for _provider in ("codex", "claude", "opencode"):
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
@click.option("--prompt", required=True, help="bounded task for the fresh Agent")
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
    try:
        payload = run_agent.execute(
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
    if as_json:
        click.echo(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        click.echo(
            f"{payload['runId']}  {payload['runtimeProfile']['provider']}  "
            f"exit={payload['launch']['exitCode']}"
        )
        click.echo(f"proof: {payload['episode']['manifestPath']}")
        click.echo("Work settlement: independent assessment required")
    sys.exit(int(payload["launch"]["exitCode"]))
