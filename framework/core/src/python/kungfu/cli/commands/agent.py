# SPDX-License-Identifier: Apache-2.0

import json
import sys
from pathlib import Path

import click

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.config import resolve_config

agent_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="agent-facing local Kungfu discovery entrypoint",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def agent(ctx):
    pass


def _context(ctx):
    config = resolve_config(runtime_home=ctx.home)
    return {
        "schema": "kungfu.agent-context/v1",
        "entrypoint": "kungfu agent",
        "config": config,
        "runtime": {
            "home": ctx.home,
            "runtimeDir": ctx.runtime_dir,
        },
        "interfaces": {
            "config": "kungfu config show --json",
            "skills": "kungfu skill list --json",
            "skillCatalog": "kungfu skill catalog --json",
            "kfx": "kungfu kfx list --json",
        },
        "docs": _docs_context(),
    }


def _docs_context():
    repo_root = _find_repo_root()
    local_docs = []
    if repo_root is not None:
        local_docs.append(
            {
                "name": "documentation map",
                "path": str(repo_root / "docs" / "MAP.md"),
            }
        )
        local_docs.append(
            {
                "name": "agent-first global config",
                "path": str(repo_root / "docs" / "config.md"),
            }
        )
    return {
        "local": local_docs,
        "public": [
            {
                "name": "documentation map",
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/MAP.md",
            },
            {
                "name": "agent-first global config",
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/config.md",
            },
        ],
    }


def _find_repo_root():
    candidates = [Path.cwd(), Path(__file__).resolve()]
    for candidate in candidates:
        for directory in [candidate, *candidate.parents]:
            if (directory / "docs" / "MAP.md").is_file() and (
                directory / "framework"
            ).is_dir():
                return directory
    return None


def _json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


@agent.command(help="print a short agent-facing brief")
@agent_command_context
def brief(ctx):
    try:
        data = _context(ctx)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[agent] failed to load context: {e}", err=True)
        sys.exit(1)
    click.echo(
        "Kungfu is available locally. Use `kungfu agent context --json` as the "
        "single source for local config, runtime paths, skills, kfx, and docs."
    )
    click.echo(f"Config: {data['config']['configPath']}")


@agent.command(help="print the canonical agent context")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def context(ctx, as_json):
    try:
        data = _context(ctx)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[agent] failed to load context: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))
