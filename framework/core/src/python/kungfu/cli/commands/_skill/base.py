# SPDX-License-Identifier: Apache-2.0

"""Shared command group and presentation seams for ``kungfu skill``."""

import json
import os

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc


skill_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="manage Kungfu Skills and build agent context catalogs",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def skill(ctx):
    pass


def _skill_json(data):
    click.echo(json.dumps(data, indent=2, sort_keys=True))


def _extra_paths(paths):
    return [os.path.abspath(path) for path in paths]


def _json_file(path):
    if not path:
        return None
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def _default_skill_audit_log(ctx):
    return os.environ.get("KUNGFU_SKILL_AUDIT_FILE") or os.path.join(
        ctx.runtime_dir, "skill-audit.jsonl"
    )
