#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu lock` — same-host named locks for agent coordination (ADR-0077, first
# slice). A lock is held by a live process for the duration of a wrapped
# command: `kungfu lock run NAME -- <command>` acquires NAME (blocking, with no
# busy-wait spent by the agent's model), runs the command, and releases on exit
# or crash. A crashed holder's lock is reclaimed automatically because the
# holder pid is no longer alive — so a dead agent never deadlocks the workspace.
#
# The lock table is workspace-scoped (under the runtime dir), so every agent
# run in the same workspace contends on the same NAME.

import json
import subprocess
import sys
from pathlib import Path

import click

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.coordination import locks

lock_command_context = kfc.pass_context()


def _lock_root(ctx):
    return Path(ctx.runtime_dir) / "coordination"


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=5,
    help="same-host named locks for agent coordination",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def lock(ctx):
    pass


@lock.command(
    "run",
    context_settings={"ignore_unknown_options": True},
    help="run a command while holding NAME: kungfu lock run NAME -- <command>",
)
@click.argument("name", type=str)
@click.argument("command", nargs=-1, type=click.UNPROCESSED, required=True)
@lock_command_context
def lock_run(ctx, name, command):
    root = _lock_root(ctx)

    def _waiting():
        click.echo(f"[lock] {name!r} held by another run; waiting …", err=True)

    with locks.held(root, name, label=f"lock-run:{name}", on_wait=_waiting):
        click.echo(f"[lock] {name!r} acquired", err=True)
        rc = subprocess.call(list(command))
    click.echo(f"[lock] {name!r} released", err=True)
    sys.exit(rc)


@lock.command("status", help="show current locks and holder liveness")
@lock_command_context
def lock_status(ctx):
    click.echo(json.dumps(locks.status(_lock_root(ctx)), indent=2, sort_keys=True))
