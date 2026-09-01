# SPDX-License-Identifier: Apache-2.0
"""Provider policy, bootstrap, and Skill installation commands."""

import os
import sys

import click

from kungfu import agent as agent_pack
from kungfu.agent import runtime_profiles
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands._agent.base import (
    _install_skill_file,
    _json,
    _policy_path,
    _read_policy,
    _skill_dir,
    _write_policy,
    agent,
    agent_command_context,
)


@agent.command(help=api_help("kungfu.agent.install-skill"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude", "amp", "opencode"]),
    help="which provider skill to install",
)
@click.option(
    "--out",
    "out_dir",
    type=click.Path(file_okay=False, dir_okay=True),
    default=None,
    help="destination directory; required with --execute",
)
@click.option(
    "--scope",
    type=click.Choice(["project", "user"]),
    default=None,
    help="provider-supported destination scope; mutually exclusive with --out",
)
@click.option("--execute", is_flag=True, help="copy the file after preview")
@click.option("--force", is_flag=True, help="replace an existing SKILL.md")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.install-skill")
@agent_command_context
def install_skill(ctx, target, out_dir, scope, execute, force, as_json):
    if out_dir and scope:
        raise click.UsageError("choose --scope or --out, not both")
    if not out_dir and scope:
        out_dir = str(_skill_dir(target, scope))
    src = agent_pack.skill_path(target)
    dest = os.path.join(out_dir, "SKILL.md") if out_dir else None
    payload = {
        "schema": "kungfu.agent-skill-install/v1",
        "target": target,
        "scope": scope,
        "source": str(src),
        "destination": dest,
        "execute": execute,
        "force": force,
        "changed": False,
    }
    if execute:
        if not out_dir:
            click.echo("[agent] --execute requires --out <directory>", err=True)
            sys.exit(1)
        _install_skill_file(target, out_dir, force)
        payload["changed"] = True
    if as_json:
        _json(payload)
        return
    action = "copied" if payload["changed"] else "preview"
    click.echo(f"[agent] {action}: {target} skill")
    click.echo(f"[agent] source: {src}")
    click.echo(f"[agent] destination: {dest or '<choose with --out>'}")
    if not execute:
        click.echo("[agent] no files changed; add --execute --out <directory> to copy")


@agent.command(help=api_help("kungfu.agent.status"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option(
    "--scope",
    type=click.Choice(["project", "user"]),
    default="project",
    show_default=True,
    help="provider Skill discovery scope",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.status")
@agent_command_context
def status(ctx, target, scope, as_json):
    policy = _read_policy(ctx, target)
    skill_dir = _skill_dir(target, scope)
    payload = {
        "schema": "kungfu.agent-status/v1",
        "target": target,
        "scope": scope,
        "configured": policy is not None,
        "policyPath": _policy_path(ctx, target),
        "policy": policy,
        "skillSource": str(agent_pack.skill_path(target)),
        "skillDestination": str(skill_dir / "SKILL.md"),
        "skillState": agent_pack.skill_state(target, skill_dir),
        "commands": {
            "bootstrap": f"kungfu agent bootstrap --target {target} --mode report",
            "mode": f"kungfu agent mode set --target {target} --mode managed-run",
            "unbootstrap": f"kungfu agent unbootstrap --target {target}",
            "uninstall": f"kungfu agent uninstall --target {target}",
        },
    }
    if as_json:
        _json(payload)
        return
    if policy is None:
        click.echo(f"[agent] {target}: not bootstrapped")
    else:
        gate = "on" if policy.get("reportCloseoutGate") else "off"
        click.echo(f"[agent] {target}: {policy.get('mode')} (report gate: {gate})")
    click.echo(f"[agent] skill {scope}: {payload['skillState']}")


@agent.command(help=api_help("kungfu.agent.bootstrap"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option(
    "--mode",
    required=True,
    type=click.Choice(["brief", "report", "trace", "managed-run", "remote-sync"]),
    help="initial operating mode",
)
@click.option(
    "--skill-dir",
    type=click.Path(file_okay=False, dir_okay=True),
    default=None,
    help="optional destination for SKILL.md",
)
@click.option("--execute", is_flag=True, help="write policy/copy skill")
@click.option("--force", is_flag=True, help="replace an existing SKILL.md")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.bootstrap")
@agent_command_context
def bootstrap(ctx, target, mode, skill_dir, execute, force, as_json):
    policy = runtime_profiles.policy_payload(
        ctx.runtime_dir, target, mode, enabled=True
    )
    skill_destination = os.path.join(skill_dir, "SKILL.md") if skill_dir else None
    payload = {
        "schema": "kungfu.agent-bootstrap/v1",
        "target": target,
        "mode": mode,
        "execute": execute,
        "changed": False,
        "policyPath": _policy_path(ctx, target),
        "policy": policy,
        "skillSource": str(agent_pack.skill_path(target)),
        "skillDestination": skill_destination,
    }
    if execute:
        _write_policy(ctx, target, policy)
        payload["changed"] = True
        if skill_dir:
            _install_skill_file(target, skill_dir, force)
    if as_json:
        _json(payload)
        return
    action = "applied" if execute else "preview"
    click.echo(f"[agent] bootstrap {action}: {target} mode={mode}")
    click.echo(f"[agent] policy: {_policy_path(ctx, target)}")
    if skill_destination:
        click.echo(f"[agent] skill: {skill_destination}")
    if not execute:
        click.echo("[agent] no files changed; add --execute to apply")


@agent.group(help=api_help("kungfu.agent.mode"))
@kfd3_api("kungfu.agent.mode")
@agent_command_context
def mode(ctx):
    pass


@mode.command(name="set", help=api_help("kungfu.agent.mode.set"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option(
    "--mode",
    "mode_name",
    required=True,
    type=click.Choice(["brief", "report", "trace", "managed-run", "remote-sync"]),
    help="new mode",
)
@click.option("--execute", is_flag=True, help="write the mode switch")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.mode.set")
@agent_command_context
def set_mode(ctx, target, mode_name, execute, as_json):
    previous = _read_policy(ctx, target)
    policy = dict(
        previous
        or runtime_profiles.policy_payload(
            ctx.runtime_dir, target, mode_name, enabled=True
        )
    )
    policy.update(
        runtime_profiles.policy_payload(
            ctx.runtime_dir, target, mode_name, enabled=True
        )
    )
    payload = {
        "schema": "kungfu.agent-mode-set/v1",
        "target": target,
        "mode": mode_name,
        "execute": execute,
        "changed": False,
        "previous": previous,
        "policy": policy,
        "policyPath": _policy_path(ctx, target),
    }
    if execute:
        _write_policy(ctx, target, policy)
        payload["changed"] = True
    if as_json:
        _json(payload)
        return
    action = "set" if execute else "preview"
    click.echo(f"[agent] mode {action}: {target} -> {mode_name}")
    if not execute:
        click.echo("[agent] no files changed; add --execute to apply")


@agent.command(help=api_help("kungfu.agent.unbootstrap"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option("--execute", is_flag=True, help="write disabled policy")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.unbootstrap")
@agent_command_context
def unbootstrap(ctx, target, execute, as_json):
    previous = _read_policy(ctx, target)
    disabled = runtime_profiles.policy_payload(
        ctx.runtime_dir, target, "brief", enabled=False
    )
    payload = {
        "schema": "kungfu.agent-unbootstrap/v1",
        "target": target,
        "execute": execute,
        "changed": False,
        "previous": previous,
        "policy": disabled,
        "policyPath": _policy_path(ctx, target),
        "note": (
            "Does not delete receipts, work items, rewind bundles, or copied skills."
        ),
    }
    if execute:
        _write_policy(ctx, target, disabled)
        payload["changed"] = True
    if as_json:
        _json(payload)
        return
    action = "disabled" if execute else "preview"
    click.echo(f"[agent] unbootstrap {action}: {target}")
    click.echo("[agent] no user data or receipts are deleted")
    if not execute:
        click.echo("[agent] add --execute to write the disabled policy")


@agent.command(help=api_help("kungfu.agent.uninstall"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option("--execute", is_flag=True, help="disable local policy")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.uninstall")
@agent_command_context
def uninstall(ctx, target, execute, as_json):
    previous = _read_policy(ctx, target)
    disabled = runtime_profiles.policy_payload(
        ctx.runtime_dir, target, "brief", enabled=False
    )
    payload = {
        "schema": "kungfu.agent-uninstall/v1",
        "target": target,
        "execute": execute,
        "changed": False,
        "policyPath": _policy_path(ctx, target),
        "previous": previous,
        "willDeleteData": False,
        "steps": [
            "Run kungfu agent unbootstrap --target <target> --execute.",
            "Remove any copied SKILL.md from the agent skill root you chose.",
            "Keep KF_HOME/runtime receipts unless the user explicitly archives or "
            "deletes Kungfu data.",
        ],
    }
    if execute:
        _write_policy(ctx, target, disabled)
        payload["changed"] = True
    if as_json:
        _json(payload)
        return
    action = "disabled policy" if execute else "dry-run"
    click.echo(f"[agent] uninstall {action}: {target}")
    for step in payload["steps"]:
        click.echo(f"- {step}")


for _symbol in (
    "install_skill",
    "status",
    "bootstrap",
    "mode",
    "set_mode",
    "unbootstrap",
    "uninstall",
):
    globals()[_symbol].callback.__module__ = "kungfu.cli.commands.agent"
    globals()[_symbol].callback.__qualname__ = _symbol
