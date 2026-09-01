# SPDX-License-Identifier: Apache-2.0

"""Shared command group and provider-policy seams for ``kungfu agent``."""

import json
import os
import sys
from pathlib import Path

import click

from kungfu import agent as agent_pack
from kungfu.agent.kfd3 import api_help, kfd3_api
from kungfu.cli.commands import agent_work_lab as agent_work_lab_commands
from kungfu.cli.commands import kfc, PrioritizedCommandGroup


agent_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help=api_help("kungfu.agent"),
)
@click.help_option("-h", "--help")
@kfd3_api("kungfu.agent")
@kfc.pass_context()
def agent(ctx):
    pass


_json = agent_work_lab_commands.agent_json_output


def _policy_dir(ctx):
    return os.path.join(ctx.runtime_dir, "agent")


def _policy_path(ctx, target):
    return os.path.join(_policy_dir(ctx), f"{target}-policy.json")


def _read_policy(ctx, target):
    path = _policy_path(ctx, target)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        click.echo(f"[agent] failed to read policy {path}: {error}", err=True)
        sys.exit(1)


def _write_policy(ctx, target, policy):
    os.makedirs(_policy_dir(ctx), exist_ok=True)
    path = _policy_path(ctx, target)
    temporary_path = path + ".tmp"
    with open(temporary_path, "w", encoding="utf-8") as file:
        json.dump(policy, file, indent=2, sort_keys=True)
        file.write("\n")
    os.replace(temporary_path, path)
    return path


def _install_skill_file(target, out_dir, force):
    source = agent_pack.skill_path(target)
    destination = os.path.join(out_dir, "SKILL.md")
    os.makedirs(out_dir, exist_ok=True)
    if os.path.exists(destination) and not force:
        click.echo(f"[agent] {destination} exists (use --force to replace)", err=True)
        sys.exit(1)
    with open(destination, "wb") as file:
        file.write(source.read_bytes())
    return str(source), destination


def _skill_dir(target, scope):
    root = Path.cwd() if scope == "project" else Path.home()
    provider_root = ".agents" if target == "codex" else ".claude"
    return root / provider_root / "skills" / "kungfu-agent-onboarding"
