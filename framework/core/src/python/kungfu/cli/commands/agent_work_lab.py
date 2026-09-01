# SPDX-License-Identifier: Apache-2.0

import json
import os
import tempfile
from pathlib import Path

import click

from kungfu import agent as agent_pack
from kungfu import agent_work_lab as lab
from kungfu import assignment_orchestration as orchestration
from kungfu import config as kungfu_config
from kungfu import project_template
from kungfu.project_tour import orchestration as project_tour_runtime
from kungfu import projects as project_registry
from kungfu.agent.kfd3 import kfd3_api
from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.cli.surface_contract import surface as surface
from kungfu.workspace import resolve_workspace_target


def _json(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _event_json(value):
    click.echo(json.dumps(value, sort_keys=True))
    click.get_text_stream("stdout").flush()


def find_repo_root():
    candidates = [Path.cwd(), Path(__file__).resolve()]
    for candidate in candidates:
        for directory in [candidate, *candidate.parents]:
            if (directory / "docs" / "MAP.md").is_file() and (
                directory / "framework"
            ).is_dir():
                return directory
    return None


def agent_json_output(payload):
    _json(payload)


def agent_bootstrap_status_payload():
    envelope_raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if envelope_raw:
        kungfu_config.validate_value("agentConsoleEnvelope", json.loads(envelope_raw))
    return agent_pack.bootstrap_status()


def emit_agent_bootstrap_status(as_json):
    try:
        payload = agent_bootstrap_status_payload()
    except (ValueError, json.JSONDecodeError) as exc:
        raise click.ClickException(f"invalid Agent bootstrap state: {exc}") from exc
    if as_json:
        agent_json_output(payload)
        return
    click.echo(
        f"bootstrap {payload['state']}"
        + (f" for attempt {payload['attemptId']}" if payload.get("attemptId") else "")
    )


def emit_agent_work_advisory(signals_file, as_json):
    try:
        payload = agent_pack.assess_work_advisory(json.load(signals_file))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        agent_json_output(payload)
        return
    click.echo(f"{payload['decision']} · {', '.join(payload['reasonCodes'])}")
    if payload["preview"] is not None:
        click.echo(f"Work: {payload['preview']['title']}")
    if payload["confirmation"]["required"]:
        click.echo(payload["confirmation"]["prompt"])
    click.echo(f"Decision: {payload['decisionRoot']}")


def emit_agent_skill_advisory(signals_file, as_json):
    try:
        payload = agent_pack.assess_skill_decision(json.load(signals_file))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        agent_json_output(payload)
        return
    click.echo(f"{payload['decision']} · {', '.join(payload['reasonCodes'])}")
    click.echo(f"Next: {payload['nextAction']}")
    click.echo(f"Decision: {payload['decisionRoot']}")


@kfd3_api("kungfu.agent.work-advisory")
def work_advisory_command(ctx, signals_file, as_json):
    del ctx
    emit_agent_work_advisory(signals_file, as_json)


@kfd3_api("kungfu.agent.skill-advisory")
def skill_advisory_command(ctx, signals_file, as_json):
    del ctx
    emit_agent_skill_advisory(signals_file, as_json)


def _advisory_signals_option(command):
    return click.option(
        "--signals",
        "signals_file",
        type=click.File("r", encoding="utf-8"),
        required=True,
        help="bounded structured signals; prompt text and transcripts are rejected",
    )(command)


def register_advisories(agent, command_context) -> None:
    """Register bounded advisory commands outside the oversized Agent root."""

    work_command = command_context(work_advisory_command)
    work_command = click.option(
        "--json", "as_json", is_flag=True, help="machine-readable output"
    )(work_command)
    work_command = _advisory_signals_option(work_command)
    work_command = click.command(
        name="work-advisory",
        help="assess bounded structured signals before proposing durable Work",
    )(work_command)
    agent.add_command(work_command)

    skill_command = command_context(skill_advisory_command)
    skill_command = click.option(
        "--json", "as_json", is_flag=True, help="machine-readable output"
    )(skill_command)
    skill_command = _advisory_signals_option(skill_command)
    skill_command = click.command(
        name="skill-advisory",
        help="choose one rooted Skill reuse, creation, draft, plan, or none outcome",
    )(skill_command)
    agent.add_command(skill_command)


@kfc.group(
    name="agent-work-lab",
    cls=PrioritizedCommandGroup,
    invoke_without_command=True,
    help_priority=1,
    help="learn, try, and verify durable Agent Work continuity",
)
@click.help_option("-h", "--help")
@kfd3_api("kungfu.agent-work-lab")
@kfc.pass_context()
def agent_work_lab(ctx):
    """The shared, boot-safe Agent Work Lab authority."""

    if ctx.invoked_subcommand is not None:
        return
    if _interactive_terminal():
        return _open_lab(ctx)
    click.echo(
        "Agent Work Lab\n\n"
        "  open    Enter the interactive Lab\n"
        "  watch   Watch the playback-only continuity demo\n"
        "  tour    Watch the playback-only Project recovery story\n"
        "  try     Create a reviewed Starter Project and keep it\n"
        "  test    Verify continuity with a local Agent\n"
        "  report  Reopen the latest retained test result\n\n"
        "Run `kungfu agent-work-lab --help` for options or "
        "`kungfu agent-work-lab catalog --json` for the complete surface."
    )


def _interactive_terminal():
    return (
        click.get_text_stream("stdin").isatty()
        and click.get_text_stream("stdout").isatty()
    )


def _open_lab(ctx):
    from kungfu.cli.tui_runtime import run_tui

    return run_tui(ctx, ("--agent-work-lab-open",))


@agent_work_lab.command(
    help="enter the interactive Agent Work Lab",
    help_priority=1,
)
@surface(mutation_class="read")
@kfd3_api("kungfu.agent-work-lab.open")
@kfc.pass_context()
def open(ctx):
    if not _interactive_terminal():
        raise click.ClickException(
            "open requires an interactive terminal; use `watch` or `tour` in a "
            "terminal, or `test --json` for scripted qualification"
        )
    return _open_lab(ctx)


@agent_work_lab.command(
    help="watch the playback-only continuity demo",
    help_priority=2,
)
@surface(mutation_class="read")
@kfd3_api("kungfu.agent-work-lab.watch")
@kfc.pass_context()
def watch(ctx):
    """Launch playback; it does not test an installed Agent."""

    from kungfu.cli.tui_runtime import run_tui

    return run_tui(ctx, ("--agent-work-lab-autoplay",))


@agent_work_lab.command(
    help="resolve the boot route without writing state", help_priority=-1
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.inspect")
@kfc.pass_context()
def inspect(ctx, as_json):
    payload = lab.inspect_startup(ctx.runtime_dir, config_home=ctx.config_home)
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['route']}: {payload['message']}")


@agent_work_lab.command(
    help="list the complete canonical Lab surface and startup state",
    help_priority=-1,
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.catalog")
@kfc.pass_context()
def catalog(ctx, as_json):
    payload = lab.catalog(ctx.runtime_dir, config_home=ctx.config_home)
    if as_json:
        _json(payload)
        return
    click.echo("Agent Work Lab")
    click.echo(f"  startup: {payload['startup']['route']}")
    for action in payload["actions"]:
        click.echo(f"  {action['id']} ({action['mutation']})")


@agent_work_lab.command(
    help="discover local agent launchers without credentials", help_priority=-1
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.agents")
@kfc.pass_context()
def agents(ctx, as_json):
    payload = lab.human_agent_catalog(
        config_home=ctx.config_home, runtime_home=ctx.home
    )
    if as_json:
        _json(payload)
        return
    if not payload["agents"]:
        click.echo("No local Agent is available.")
        click.echo("Next: install an Agent CLI or run `kungfu agent runtime discover`.")
        return
    for row in payload["agents"]:
        markers = [
            name
            for name, present in (
                ("default", row["default"]),
                ("recommended", row["recommended"]),
                ("configured", row["configured"]),
                ("discovered", row["discovered"]),
            )
            if present
        ]
        version = f" · {row['version']}" if row.get("version") else ""
        click.echo(
            f"{row['label']} · {row['provider']}{version} · "
            f"{'available' if row['available'] else 'unavailable'} "
            f"[{', '.join(markers)}]"
        )
        click.echo(f"  exact id: {row['id']}")


@agent_work_lab.command(help="preview the deterministic offline demo", help_priority=-1)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.plan")
def plan(as_json):
    payload = lab.demo_plan()
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent Work Lab demo plan: {payload['planRoot']}")


@agent_work_lab.command(
    help="run the isolated two-session offline demo", help_priority=-1
)
@click.option(
    "--output",
    type=click.Path(path_type=Path),
    help="new discardable evidence directory; defaults to an OS temporary root",
)
@click.option(
    "--events-json",
    is_flag=True,
    help="emit stable event boundaries followed by the final report",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.demo")
def demo(output, events_json, as_json):
    try:
        payload = lab.run_demo(
            output,
            on_event=_event_json if events_json else None,
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if events_json:
        _event_json(payload)
        return
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent Work Lab demo: {payload['status']} ({payload['reportRoot']})")


@agent_work_lab.command(
    help="launch the guided offline autoplay in the shipped TUI",
    help_priority=-1,
)
@kfd3_api("kungfu.agent-work-lab.autoplay")
@kfc.pass_context()
def autoplay(ctx):
    from kungfu.cli.tui_runtime import run_tui

    return run_tui(ctx, ("--agent-work-lab-autoplay",))


@agent_work_lab.command(
    name="project-tour",
    help="play a disposable Project Work failure-and-recovery story",
    help_priority=-1,
)
@click.option(
    "--episode",
    type=click.Choice(("1", "2", "all"), case_sensitive=False),
    default="1",
    show_default=True,
    help="play failure retention, recovery and settlement, or both episodes",
)
@click.option(
    "--speed",
    type=click.FloatRange(min=0.25, max=4.0),
    default=1.0,
    show_default=True,
    help="playback speed multiplier; 0.5 doubles the reading time",
)
@kfd3_api("kungfu.agent-work-lab")
@kfc.pass_context()
def project_tour(ctx, episode, speed):
    return _run_project_tour(ctx, episode, speed)


def _run_project_tour(ctx, episode, speed):
    from kungfu.cli.tui_runtime import run_tui

    with tempfile.TemporaryDirectory(prefix="kungfu-project-tour-") as temporary:
        destination = Path(temporary) / "my-first-kungfu-project"
        return run_tui(
            ctx,
            (
                "--project-work-tour-root",
                str(destination),
                "--project-tour-speed",
                f"{speed:g}",
                "--project-tour-episode",
                episode,
            ),
        )


@agent_work_lab.command(
    help="watch the playback-only Project recovery story",
    help_priority=3,
)
@click.option(
    "--episode",
    type=click.Choice(("1", "2", "all"), case_sensitive=False),
    default="1",
    show_default=True,
)
@click.option(
    "--speed",
    type=click.FloatRange(min=0.25, max=4.0),
    default=1.0,
    show_default=True,
)
@surface(mutation_class="read")
@kfd3_api("kungfu.agent-work-lab.tour")
@kfc.pass_context()
def tour(ctx, episode, speed):
    """Launch playback; it creates no Project that is kept afterward."""

    return _run_project_tour(ctx, episode, speed)


class _NativeProjectTourOperations:
    def __init__(self, ctx, allow_foreign_binding):
        self.ctx = ctx
        self.allow_foreign_binding = allow_foreign_binding

    @staticmethod
    def _work(project):
        work = project.get("initialWork")
        if not isinstance(work, dict):
            raise ValueError("Project Tour Starter Project has no initial Work")
        return work

    def create_or_resume(self, destination, resume):
        if resume:
            receipt = project_template.resume_project_template(destination)
        else:
            plan = lab.plan_project_template(lab.DEFAULT_TEMPLATE_ID, destination)
            receipt = lab.create_project_template(
                lab.DEFAULT_TEMPLATE_ID,
                destination,
                expected_plan_root=plan["planRoot"],
                actor="project-tour",
            )
        initial = dict(receipt["initialWork"])
        if resume:
            retained = next(
                (
                    row
                    for row in receipt.get("works") or []
                    if row.get("assignmentId") == initial["assignmentId"]
                ),
                None,
            )
            if retained:
                initial = dict(retained)
        else:
            captured = orchestration.load_captured_request(initial["requestPath"])
            definition = captured["request"].get("workDefinition") or {}
            initial.update(
                title=str(definition.get("title") or initial["assignmentId"]),
                objective=str(definition.get("objective") or ""),
                acceptanceChecks=list(definition.get("acceptance_criteria") or []),
            )
        selection = project_registry.select_project(
            destination, config_home=self.ctx.config_home
        )
        return {
            "schema": "kungfu.project-tour.project/v1",
            "status": "resumed" if resume else "created",
            "destination": str(Path(destination).expanduser().resolve()),
            "receipt": receipt,
            "initialWork": initial,
            "selection": selection,
        }

    def start_attempt(self, project, scenario, on_event):
        from kungfu.cli.commands import assignment as work_commands
        from kungfu.cli.commands import run as run_commands

        work = self._work(project)
        profile = run_commands._provider_profile(
            "synthetic",
            config_home=self.ctx.config_home,
            runtime_home=self.ctx.home,
            mock_scenario=scenario,
        )
        plan = work_commands._work_start_plan(
            config_home=self.ctx.config_home,
            runtime_home=self.ctx.home,
            request_file=Path(work["requestPath"]),
            workspace_root=project["destination"],
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            profile_id=profile["id"],
            actor="local-user",
            allow_foreign_binding=self.allow_foreign_binding,
        )
        if plan.get("executable") is not True:
            raise ValueError("Mock Agent start plan is not executable")
        return work_commands.start_work.callback.__wrapped__(
            self.ctx,
            Path(work["requestPath"]),
            project["destination"],
            False,
            work["initiativeId"],
            work["assignmentId"],
            profile["id"],
            "local-user",
            plan["planRoot"],
            True,
            False,
            self.allow_foreign_binding,
            False,
            on_event,
        )

    def review(self, receipt, on_event):
        from kungfu.cli.commands import assignment as work_commands

        report = receipt.get("agentReport") or {}
        report_path = (report.get("episode") or {}).get("reportPath")
        workspace = (receipt.get("workspace") or {}).get("workspace_root")
        work = receipt.get("work") or {}
        if not report_path or not workspace or not work:
            raise ValueError("Project Tour Agent receipt is not reviewable")
        reviewer = "kungfu.mock-agent.review-fit"
        plan = work_commands._work_review_plan(
            config_home=self.ctx.config_home,
            runtime_home=self.ctx.home,
            agent_report_file=Path(report_path),
            workspace_root=workspace,
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            reviewer_profile_id=reviewer,
            allow_foreign_binding=self.allow_foreign_binding,
        )
        if plan.get("executable") is not True:
            raise ValueError("Mock Reviewer plan is not executable")
        return work_commands.review_agent_run.callback.__wrapped__(
            self.ctx,
            Path(report_path),
            workspace,
            False,
            work["initiativeId"],
            work["assignmentId"],
            reviewer,
            plan["planRoot"],
            True,
            False,
            self.allow_foreign_binding,
            False,
            on_event,
        )

    def close(self, project):
        from kungfu.cli.commands import assignment as work_commands

        work = self._work(project)
        services = work_commands._close_services()
        plan = work_commands.assignment_close.build_plan(
            workspace_root=project["destination"],
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            services=services,
        )
        if plan.get("executable") is not True:
            raise ValueError("Project Tour native settlement plan is not executable")
        request = work_commands.assignment_close.CloseRequest(
            workspace_root=project["destination"],
            home=False,
            initiative_id=work["initiativeId"],
            assignment_id=work["assignmentId"],
            actor="local-user",
            expected_plan_root=plan["planRoot"],
            execute=True,
        )
        return work_commands.assignment_close.execute(request, services)

    def capture_followup(self, destination):
        assignment_id = "assignment-prepare-launch-handoff-project-tour"
        request = {
            "schema": "kungfu.assignment-request/v1",
            "source": {
                "kind": "kungfu-product",
                "surface": "project-tour-next-work",
            },
            "retention": {
                "policy": "explicit-expiry-retain-bytes-v1",
                "expiresAt": None,
            },
            "workDefinition": {
                "assignment_id": assignment_id,
                "initiative_id": "project-work-tour-next",
                "title": "Prepare the launch handoff for the next operator",
                "objective": "Prepare the launch handoff for the next operator",
                "acceptance_criteria": [
                    "A new business outcome remains visible beside the settled launch-brief Work",
                    "Validation evidence and unresolved risks are reported",
                ],
            },
        }
        target = resolve_workspace_target("capture-only", destination, cwd=destination)
        return orchestration.capture_assignment_request(request, target)

    def inventory(self, destination):
        return project_registry.work_inventory(destination)


@agent_work_lab.command(
    name="project-tour-run",
    help="run one Project Tour episode through one native controller process",
    hidden=True,
)
@click.option(
    "--destination",
    required=True,
    type=click.Path(path_type=Path),
)
@click.option("--episode", type=click.Choice(("1", "2")), required=True)
@click.option("--resume", is_flag=True)
@click.option("--guide-dwell-ms", type=click.IntRange(min=0), default=8000)
@click.option("--guide-gap-ms", type=click.IntRange(min=0), default=400)
@click.option("--episode-two-guide-dwell-ms", type=click.IntRange(min=0), default=7000)
@click.option(
    "--episode-two-final-guide-dwell-ms",
    type=click.IntRange(min=0),
    default=6400,
)
@click.option("--events-json", is_flag=True)
@click.option("--json", "as_json", is_flag=True)
@click.option("--allow-foreign-binding", is_flag=True, hidden=True)
@kfd3_api("kungfu.agent-work-lab")
@kfc.pass_context()
def project_tour_run(
    ctx,
    destination,
    episode,
    resume,
    guide_dwell_ms,
    guide_gap_ms,
    episode_two_guide_dwell_ms,
    episode_two_final_guide_dwell_ms,
    events_json,
    as_json,
    allow_foreign_binding,
):
    try:
        report = project_tour_runtime.run_project_tour_episode(
            project_tour_runtime.ProjectTourEpisodeRequest(
                destination=str(destination.expanduser().resolve()),
                episode=episode,
                resume=resume,
                guide_dwell_ms=guide_dwell_ms,
                guide_gap_ms=guide_gap_ms,
                episode_two_guide_dwell_ms=episode_two_guide_dwell_ms,
                episode_two_final_guide_dwell_ms=episode_two_final_guide_dwell_ms,
            ),
            _NativeProjectTourOperations(ctx, allow_foreign_binding),
            _event_json if events_json else lambda _event: None,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if events_json:
        _event_json(report)
    elif as_json:
        _json(report)
    else:
        click.echo(
            f"Project Tour episode {episode}: {report['status']} "
            f"({report['reportRoot']})"
        )


@agent_work_lab.command(
    name="try",
    help="preview or create a persistent Starter Project",
    help_priority=4,
)
@click.option("--destination", type=click.Path(path_type=Path))
@click.option("--parent", type=click.Path(path_type=Path))
@click.option("--expected-plan-root")
@click.option("--actor", default="local-user", show_default=True)
@click.option(
    "--execute",
    is_flag=True,
    help="create the reviewed Project, select it, and open the TUI",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@surface(mutation_class="write")
@kfd3_api("kungfu.agent-work-lab.try")
@kfc.pass_context()
def try_starter(ctx, destination, parent, expected_plan_root, actor, execute, as_json):
    """Keep the result; unlike tour, this is the user's real Starter Project."""

    try:
        plan = lab.plan_project_template(
            lab.DEFAULT_TEMPLATE_ID,
            destination,
            parent=parent,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if not execute:
        if as_json:
            _json(plan)
            return
        click.echo(f"Starter Project: {plan['destination']}")
        click.echo(f"  reviewed plan: {plan['planRoot']}")
        click.echo("  no files written")
        click.echo(
            "Next: run `kungfu agent-work-lab try "
            f"--destination {json.dumps(plan['destination'])} "
            f"--expected-plan-root {plan['planRoot']} --execute`"
        )
        return
    if not _interactive_terminal():
        raise click.ClickException(
            "try --execute opens the created Project and requires an interactive "
            "terminal; scripted callers can use starter-create"
        )
    if as_json:
        raise click.ClickException(
            "try --json is a plan-only interface; use starter-create for scripted creation"
        )
    if not expected_plan_root:
        raise click.ClickException(
            "try --execute requires --expected-plan-root from the reviewed preview"
        )
    try:
        receipt = lab.create_project_template(
            lab.DEFAULT_TEMPLATE_ID,
            plan["destination"],
            expected_plan_root=expected_plan_root,
            actor=actor,
        )
        project_registry.select_project(
            receipt["destination"], config_home=ctx.config_home
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(receipt)
    click.echo(f"Created Starter Project: {receipt['destination']}")
    click.echo("Opening the retained Project and its first governed Work.")
    os.chdir(receipt["destination"])
    from kungfu.cli.tui_runtime import run_tui

    return run_tui(ctx)


@agent_work_lab.command(
    help="preview or run a same-Agent or cross-Agent continuity test",
    help_priority=5,
)
@click.argument("agent", required=False, default="default")
@click.option(
    "--target-agent",
    help="different Agent label, provider, default/recommended name, or exact id",
)
@click.option(
    "--execute",
    is_flag=True,
    help="authorize two fresh local Agent processes in an isolated result directory",
)
@click.option("--output", type=click.Path(path_type=Path))
@click.option(
    "--timeout",
    "timeout_seconds",
    type=click.IntRange(min=1, max=3600),
    default=300,
    show_default=True,
)
@click.option("--events-json", is_flag=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@surface(mutation_class="write")
@kfd3_api("kungfu.agent-work-lab.test")
@kfc.pass_context()
def test(
    ctx,
    agent,
    target_agent,
    execute,
    output,
    timeout_seconds,
    events_json,
    as_json,
):
    try:
        source_id, catalog = lab.resolve_agent_selector(
            agent, config_home=ctx.config_home, runtime_home=ctx.home
        )
        target_id = None
        if target_agent:
            target_id, _ = lab.resolve_agent_selector(
                target_agent, config_home=ctx.config_home, runtime_home=ctx.home
            )
        source_plan = lab.agent_plan(
            source_id, config_home=ctx.config_home, runtime_home=ctx.home
        )
        target_plan = (
            lab.agent_plan(
                target_id, config_home=ctx.config_home, runtime_home=ctx.home
            )
            if target_id and target_id != source_id
            else None
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    preview = {
        "schema": "kungfu.agent-work-lab.test-plan/v1",
        "mode": "cross-agent" if target_plan else "same-agent",
        "source": source_plan,
        "target": target_plan or source_plan,
        "selectedBy": {
            "source": agent,
            "target": target_agent or agent,
        },
        "credentialContentsRead": catalog.get("credentialContentsRead", False),
        "requiresExecute": True,
        "writeOccurred": False,
    }
    labels = {row["id"]: row["label"] for row in catalog["agents"]}
    if not execute:
        if events_json:
            raise click.UsageError("--events-json requires --execute")
        if as_json:
            _json(preview)
            return
        click.echo(
            f"{preview['mode']}: {labels.get(source_id, source_id)} → "
            f"{labels.get(target_id or source_id, target_id or source_id)}"
        )
        click.echo("  two fresh processes; no copied chat; credentials are not read")
        click.echo("Next: repeat this command with --execute.")
        return
    result_dir = output or lab.next_result_directory(ctx.runtime_dir)
    try:
        report = lab.run_agent(
            source_id,
            target_profile_id=target_id,
            config_home=ctx.config_home,
            runtime_home=ctx.home,
            output_dir=result_dir,
            timeout_seconds=timeout_seconds,
            on_event=_event_json if events_json else None,
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if events_json:
        _event_json(report)
    elif as_json:
        _json(report)
    else:
        click.echo(f"Agent Work Lab test: {report['status']}")
        click.echo(f"  report: {Path(report['evidenceDirectory']) / 'report.json'}")
        click.echo("Next: `kungfu agent-work-lab report`.")


@agent_work_lab.command(
    help="reopen the latest retained test result or one exact report",
    help_priority=6,
)
@click.argument("result", required=False, type=click.Path(path_type=Path))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@surface(mutation_class="read")
@kfd3_api("kungfu.agent-work-lab.report")
@kfc.pass_context()
def report(ctx, result, as_json):
    try:
        payload = lab.load_report(result, runtime_dir=ctx.runtime_dir)
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent Work Lab result: {payload['status']}")
    click.echo(f"  mode: {payload.get('runMode', 'offline-demo')}")
    click.echo(f"  report root: {payload['reportRoot']}")
    click.echo(f"  report: {payload['reportPath']}")
    for check in payload.get("assessment", {}).get("oracleChecks", []):
        click.echo(f"  {'PASS' if check.get('passed') else 'FAIL'}  {check['id']}")


@agent_work_lab.command(
    name="starter-plan",
    help="preview the Agent Work Starter project without writing",
    help_priority=-1,
)
@click.option("--destination", type=click.Path(path_type=Path))
@click.option("--parent", type=click.Path(path_type=Path))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab")
def starter_plan(destination, parent, as_json):
    try:
        payload = lab.plan_project_template(
            lab.DEFAULT_TEMPLATE_ID,
            destination,
            parent=parent,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Starter Project: {payload['destination']}")
    click.echo(f"  plan: {payload['planRoot']}")
    click.echo("  no files written; run starter-create after reviewing this plan")


@agent_work_lab.command(
    name="starter-create",
    help="create the exact reviewed Agent Work Starter project",
    help_priority=-1,
)
@click.option(
    "--destination",
    required=True,
    type=click.Path(path_type=Path),
)
@click.option("--expected-plan-root", required=True)
@click.option("--actor", required=True)
@click.option(
    "--execute",
    is_flag=True,
    help="confirm creation of the reviewed project and captured Work request",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab")
def starter_create(destination, expected_plan_root, actor, execute, as_json):
    if not execute:
        raise click.ClickException(
            "starter-create requires --execute after reviewing starter-plan"
        )
    try:
        payload = lab.create_project_template(
            lab.DEFAULT_TEMPLATE_ID,
            destination,
            expected_plan_root=expected_plan_root,
            actor=actor,
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Created Starter Project: {payload['destination']}")
    click.echo(
        "  initial Work captured and pending explicit admission: "
        f"{payload['initialWork']['requestRoot']}"
    )


@agent_work_lab.command(
    name="starter-resume",
    help="resume one exact retained Agent Work Starter project without writing",
    help_priority=-1,
)
@click.option(
    "--workspace",
    required=True,
    type=click.Path(path_type=Path),
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@surface(mutation_class="read")
@kfd3_api("kungfu.agent-work-lab.starter-resume")
def starter_resume(workspace, as_json):
    try:
        payload = project_template.resume_project_template(workspace)
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"Resumed Starter Project: {payload['destination']}")
    click.echo(f"  retained Work request: {payload['initialWork']['requestRoot']}")


@agent_work_lab.command(
    name="agent-plan", help="preview one exact local agent run", help_priority=-1
)
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.agent-plan")
@kfc.pass_context()
def agent_plan(ctx, profile_id, as_json):
    try:
        payload = lab.agent_plan(
            profile_id, config_home=ctx.config_home, runtime_home=ctx.home
        )
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo("Command preview:")
    click.echo(
        "  " + " ".join(json.dumps(value) for value in payload["commandPreview"])
    )


@agent_work_lab.command(
    name="agent-run",
    help="run two fresh sessions of one exact local agent after confirmation",
    help_priority=-1,
)
@click.argument("profile_id")
@click.option(
    "--execute",
    is_flag=True,
    help="authorize local provider execution in a discardable directory",
)
@click.option(
    "--target-profile",
    help="use a different discovered profile for the fresh continuation session",
)
@click.option(
    "--output",
    type=click.Path(path_type=Path),
    help="new discardable evidence directory; defaults to an OS temporary root",
)
@click.option(
    "--timeout",
    "timeout_seconds",
    type=click.IntRange(min=1, max=3600),
    default=300,
    show_default=True,
)
@click.option(
    "--events-json",
    is_flag=True,
    help="stream stable event boundaries followed by the final report",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent-work-lab.agent-run")
@kfc.pass_context()
def agent_run(
    ctx,
    profile_id,
    execute,
    target_profile,
    output,
    timeout_seconds,
    events_json,
    as_json,
):
    if not execute:
        raise click.UsageError(
            "agent-run requires --execute; inspect agent-plan before authorizing "
            "provider execution"
        )
    try:
        payload = lab.run_agent(
            profile_id,
            target_profile_id=target_profile,
            config_home=ctx.config_home,
            runtime_home=ctx.home,
            output_dir=output,
            timeout_seconds=timeout_seconds,
            on_event=_event_json if events_json else None,
        )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if events_json:
        _event_json(payload)
        return
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent Work Lab run: {payload['status']} ({payload['reportRoot']})")
