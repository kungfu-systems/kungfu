# SPDX-License-Identifier: Apache-2.0
"""Native Agent Console and Session commands."""

import json
import os
from typing import Any

import click

from kungfu import agent as agent_pack
from kungfu import config as kungfu_config
from kungfu.agent import run_agent, session_surface
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands._agent.base import _json, agent, agent_command_context


@agent.group(help=api_help("kungfu.agent.console"))
@kfd3_api("kungfu.agent.console")
@agent_command_context
def console(ctx):
    """Inspect the content-bound envelope of this Agent Console attempt."""


@console.command(name="current", help=api_help("kungfu.agent.console.current"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.console.current")
@agent_command_context
def console_current(ctx, as_json):
    raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if not raw:
        try:
            current = session_surface.current_native_console(
                str(ctx.runtime_dir), adopt=False
            )
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
            raise click.ClickException(str(exc)) from exc
        if current is None:
            payload: dict[str, Any] = {
                "schema": "kungfu.agent-console-current/v1",
                "available": False,
                "reason": "not-running-inside-kungfu-agent-console",
            }
        else:
            envelope = current["envelope"]
            status = current["status"] or {}
            binding = status.get("binding") or {}
            effective_work_ref = (
                binding.get("workRef") if binding.get("kind") == "work" else None
            )
            payload = {
                "schema": "kungfu.agent-console-current/v1",
                "available": True,
                "envelope": envelope,
                "bootstrap": (status.get("attempt") or {}).get("bootstrap"),
                "workBound": effective_work_ref is not None,
                "workRef": effective_work_ref,
                "knownLimits": envelope.get("knownLimits", []),
            }
    else:
        try:
            envelope = json.loads(raw)
            kungfu_config.validate_value("agentConsoleEnvelope", envelope)
        except (ValueError, json.JSONDecodeError) as exc:
            raise click.ClickException(
                f"invalid Agent Console envelope: {exc}"
            ) from exc
        effective_work_ref = session_surface.effective_work_ref(envelope)
        payload = {
            "schema": "kungfu.agent-console-current/v1",
            "available": True,
            "envelope": envelope,
            "bootstrap": agent_pack.bootstrap_status(),
            "workBound": effective_work_ref is not None,
            "workRef": effective_work_ref,
            "knownLimits": envelope.get("knownLimits", []),
        }
    if as_json:
        _json(payload)
        return
    if not payload["available"]:
        click.echo("not running inside a Kungfu Agent Console")
        return
    envelope = payload["envelope"]
    click.echo(
        f"{envelope['consoleId']} attempt {envelope['attemptId']} "
        f"root {envelope['envelopeRoot']}"
    )


@console.command(
    name="bind-work",
    help="atomically bind this native Agent attempt to one Assignment",
)
@click.option("--initiative-id", required=True)
@click.option("--assignment-id", required=True)
@click.option(
    "--workspace",
    "workspace_root",
    type=click.Path(file_okay=False),
    help="exact Project workspace that owns the Assignment",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.console.bind-work")
@agent_command_context
def console_bind_work(ctx, initiative_id, assignment_id, workspace_root, as_json):
    raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    try:
        current = session_surface.current_native_console(
            str(ctx.runtime_dir), adopt=not bool(raw)
        )
        if current is None:
            raise ValueError(
                "bind-work requires an injected native Console or an exact "
                "current Codex process identity"
            )
        envelope = current["envelope"]
        kungfu_config.validate_value("agentConsoleEnvelope", envelope)
        binding = run_agent.bind_current_native_work(
            str(ctx.runtime_dir),
            initiative_id,
            assignment_id,
            work_workspace_root=workspace_root,
            **(
                {}
                if raw
                else {
                    "envelope_override": envelope,
                    "console_workspace_root": current["workspaceRoot"],
                }
            ),
        )
        if binding is None:
            raise ValueError("native Agent Console binding is unavailable")
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        raise click.ClickException(str(exc)) from exc
    payload = {
        "schema": "kungfu.agent-console.work-binding/v1",
        "status": "bound",
        **binding,
        "next": "continue-this-Assignment-in-this-terminal",
    }
    if as_json:
        _json(payload)
        return
    click.echo(
        f"bound {assignment_id} to {envelope['consoleId']} "
        f"attempt {envelope['attemptId']}"
    )


@agent.command(name="session", help=api_help("kungfu.agent.session"))
@click.argument(
    "operation",
    type=click.Choice(
        [
            "capabilities",
            "list",
            "show",
            "status",
            "snapshot",
            "plan-start",
            "start",
            "plan-native-start",
            "start-native",
            "plan-native-bind-work",
            "bind-native-work",
            "heartbeat-native",
            "end-native",
            "attach",
            "detach",
            "plan-control",
            "acquire-control",
            "release-control",
            "instruct",
            "respond-control",
            "send-key",
            "interrupt",
            "end",
        ]
    ),
)
@click.option(
    "--input",
    "input_file",
    type=click.File("r", encoding="utf-8"),
    help="JSON request fields; use - for stdin",
)
@click.option("--endpoint", type=click.Path(), help="explicit local surface endpoint")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.session")
@agent_command_context
def session_action(ctx, operation, input_file, endpoint, as_json):
    """Use the same Agent Session action/plan/status/receipt port as the GUI."""
    try:
        request = json.load(input_file) if input_file is not None else {}
    except json.JSONDecodeError as exc:
        raise click.ClickException(f"invalid Agent Session JSON input: {exc}") from exc
    if not isinstance(request, dict):
        raise click.ClickException("Agent Session input must be a JSON object")
    request = {
        **request,
        "operation": operation,
        "client": request.get(
            "client",
            "kfd3-agent" if os.environ.get("KUNGFU_AGENT_CONSOLE_ID") else "cli",
        ),
        "actorId": request.get(
            "actorId",
            os.environ.get("KUNGFU_AGENT_SESSION_ACTOR", f"cli:{os.getpid()}"),
        ),
    }
    try:
        payload = session_surface.invoke_for_project(
            request,
            fallback_runtime_dir=ctx.runtime_dir,
            endpoint=endpoint,
            cwd=os.getcwd(),
        )
    except (OSError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        _json(payload)
        return
    click.echo(f"{operation}: {payload.get('status') or payload.get('schema') or 'ok'}")


for _symbol in ("console", "console_current", "console_bind_work", "session_action"):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.agent"
    globals()[_symbol].callback.__qualname__ = _symbol
