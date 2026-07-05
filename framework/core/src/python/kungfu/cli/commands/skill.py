# SPDX-License-Identifier: Apache-2.0

import json
import os
import shutil
import sys

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.skill import (
    SkillError,
    build_catalog,
    build_context_envelope,
    discover_skills,
    find_skill,
    parse_skill,
    read_skill_markdown,
)

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


def _json(data):
    click.echo(json.dumps(data, indent=2, sort_keys=True))


def _extra_paths(paths):
    return [os.path.abspath(path) for path in paths]


@skill.command(help="validate a Kungfu Skill source directory")
@click.argument("path", type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def validate(ctx, path, as_json):
    try:
        parsed = parse_skill(path)
    except SkillError as e:
        if as_json:
            _json({"ok": False, "error": str(e)})
        else:
            click.echo(f"[skill] invalid: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json({"ok": True, "skill": parsed})
    else:
        click.echo(
            f"[skill] ok {parsed['key']} ({parsed['kind']}) "
            f"from {parsed['source']['path']}"
        )


@skill.command(help="install a Kungfu Skill source directory into this home")
@click.argument("source", type=click.Path(exists=True))
@click.option("--force", is_flag=True, help="replace an existing skill install")
@skill_command_context
def install(ctx, source, force):
    try:
        parsed = parse_skill(source)
    except SkillError as e:
        click.echo(f"[skill] invalid: {e}", err=True)
        sys.exit(1)
    root = os.path.join(ctx.home, "skills")
    dest = os.path.join(root, parsed["key"])
    if os.path.exists(dest):
        if not force:
            click.echo(
                f"[skill] {parsed['key']} is already installed "
                "(use --force to replace)",
                err=True,
            )
            sys.exit(1)
        shutil.rmtree(dest)
    os.makedirs(root, exist_ok=True)
    shutil.copytree(source, dest)
    click.echo(f"[skill] installed {parsed['key']} -> {dest}")


@skill.command(name="list", help="list installed or path-provided Kungfu Skills")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def list_skills(ctx, paths, as_json):
    rows = discover_skills(ctx.home, _extra_paths(paths))
    if as_json:
        _json(rows)
        return
    if not rows:
        click.echo(f"[skill] nothing found under {os.path.join(ctx.home, 'skills')}")
        return
    for row in rows:
        click.echo(f"{row['key']}  {row['title']}  ({row['kind']})")


@skill.command(help="print the compact agent-visible Kungfu Skill catalog")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def catalog(ctx, paths, as_json):
    data = build_catalog(discover_skills(ctx.home, _extra_paths(paths)))
    if as_json:
        _json(data)
        return
    if not data["skills"]:
        click.echo("[skill] catalog is empty")
        return
    for row in data["skills"]:
        triggers = ", ".join(row["triggers"]) if row["triggers"] else "manual"
        click.echo(f"{row['key']}: {row['description']} [use: {triggers}]")


@skill.command(help="print a skill context envelope for an agent invocation")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--source", default="cli", type=click.Choice(["cli", "gui", "test"]))
@click.option("--manager", default="python", type=click.Choice(["python", "node"]))
@click.option("--profile", default=None, type=str)
@click.option("--agent", default=None, type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def context(ctx, paths, source, manager, profile, agent, as_json):
    session = {"source": source, "manager": manager}
    if profile:
        session["profile"] = profile
    if agent:
        session["agent"] = agent
    data = build_context_envelope(
        build_catalog(discover_skills(ctx.home, _extra_paths(paths))),
        session,
    )
    _json(data)


@skill.command(help="load full SKILL.md by key or path")
@click.argument("key_or_path", type=str)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def read(ctx, key_or_path, paths, as_json):
    try:
        parsed, markdown = read_skill_markdown(
            ctx.home, key_or_path, _extra_paths(paths)
        )
    except SkillError as e:
        click.echo(f"[skill] {e}", err=True)
        sys.exit(1)
    if as_json:
        _json({"skill": parsed, "markdown": markdown})
    else:
        click.echo(markdown, nl=False)


@skill.command(help="explain a Kungfu Skill without granting runtime privileges")
@click.argument("key_or_path", type=str)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def explain(ctx, key_or_path, paths, as_json):
    try:
        parsed = find_skill(ctx.home, key_or_path, _extra_paths(paths))
    except SkillError as e:
        click.echo(f"[skill] {e}", err=True)
        sys.exit(1)
    explanation = {
        "key": parsed["key"],
        "title": parsed["title"],
        "kind": parsed["kind"],
        "sourceHash": parsed["source"]["hash"],
        "runtimePrivilege": "none"
        if parsed["kind"] == "instruction-only"
        else "requested-via-kfx-trust-gate",
        "kfx": parsed["kfx"],
        "capabilities": parsed["capabilities"],
        "trustBoundary": (
            "Skill instructions do not elevate permissions. Any executable "
            "dependency remains governed by the kfx trust gate."
        ),
    }
    if as_json:
        _json(explanation)
        return
    click.echo(f"{explanation['key']} — {explanation['title']}")
    click.echo(f"kind: {explanation['kind']}")
    click.echo(f"runtime privilege: {explanation['runtimePrivilege']}")
    click.echo(f"source hash: {explanation['sourceHash']}")
    click.echo(explanation["trustBoundary"])
