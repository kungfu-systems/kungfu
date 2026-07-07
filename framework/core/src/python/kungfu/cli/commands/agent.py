# SPDX-License-Identifier: Apache-2.0

import json
import os
import sys
from pathlib import Path

import click

from kungfu import agent as agent_pack
from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.config import resolve_config

agent_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="agent-facing local Kungfu discovery entrypoint",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def agent(ctx):
    pass


def _context(ctx):
    config = resolve_config(runtime_home=ctx.home)
    index = agent_pack.index()
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
        "agentPack": {
            "packRoot": str(agent_pack.pack_root()),
            "documents": index["documents"],
            "skills": index["skills"],
            "commands": agent_pack.commands(),
        },
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


def _policy_dir(ctx):
    return os.path.join(ctx.runtime_dir, "agent")


def _policy_path(ctx, target):
    return os.path.join(_policy_dir(ctx), f"{target}-policy.json")


def _read_policy(ctx, target):
    path = _policy_path(ctx, target)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        click.echo(f"[agent] failed to read policy {path}: {e}", err=True)
        sys.exit(1)


def _write_policy(ctx, target, policy):
    os.makedirs(_policy_dir(ctx), exist_ok=True)
    path = _policy_path(ctx, target)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(policy, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
    return path


def _policy_payload(ctx, target, mode, enabled=True):
    closeout_gate = enabled and mode in {"report", "managed-run"}
    return {
        "schema": "kungfu.agent-policy/v1",
        "target": target,
        "mode": mode,
        "enabled": enabled,
        "reportCloseoutGate": closeout_gate,
        "reportAdapter": "kungfu codex report-goal"
        if target == "codex"
        else "kungfu report run begin",
        "receiptVerifier": "kungfu codex verify-goal-report"
        if target == "codex"
        else "kungfu report run end",
        "runtimeDir": ctx.runtime_dir,
    }


def _install_skill_file(target, out_dir, force):
    src = agent_pack.skill_path(target)
    dest = os.path.join(out_dir, "SKILL.md")
    os.makedirs(out_dir, exist_ok=True)
    if os.path.exists(dest) and not force:
        click.echo(f"[agent] {dest} exists (use --force to replace)", err=True)
        sys.exit(1)
    with open(dest, "wb") as f:
        f.write(src.read_bytes())
    return str(src), dest


@agent.command(help="print the local onboarding brief")
@agent_command_context
def brief(ctx):
    click.echo(agent_pack.document_text("brief.md"), nl=False)


@agent.command(help="show the installed pack path and document list")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def docs(ctx, as_json):
    index = agent_pack.index()
    root = str(agent_pack.pack_root())
    payload = {
        "schema": "kungfu.agent-docs/v1",
        "packRoot": root,
        "documents": index["documents"],
        "skills": index["skills"],
    }
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent pack: {root}")
    for row in index["documents"]:
        click.echo(f"- {row['path']} [{row['maturity']}]: {row['purpose']}")
    for row in index["skills"]:
        click.echo(f"- {row['path']} [{row['maturity']}]: {row['target']} skill")


@agent.command(help="print machine-readable agent capabilities")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def capabilities(ctx, as_json):
    payload = {
        "schema": "kungfu.agent-capabilities/v1",
        "index": agent_pack.index(),
        "commands": agent_pack.commands(),
    }
    if as_json:
        _json(payload)
        return
    click.echo("Kungfu Agent Pack capabilities")
    for row in payload["commands"]["commands"]:
        click.echo(f"- {row['name']} [{row['maturity']}]: {row['purpose']}")


@agent.command(help="choose the right agent operating mode")
@click.option("--command", type=str, default=None, help="existing command to capture")
@click.option(
    "--needs-supervision",
    is_flag=True,
    help="Kungfu should launch and supervise the provider CLI",
)
@click.option(
    "--has-existing-run",
    is_flag=True,
    help="there is already a process or run to inspect",
)
@click.option(
    "--needs-structured-work",
    is_flag=True,
    help="the useful fact is work state, not process capture",
)
@click.option(
    "--needs-atlas-projection",
    is_flag=True,
    help="an Atlas-style control-plane repo should be imported for inspection",
)
@click.option(
    "--remote-runtime",
    is_flag=True,
    help="evidence crosses a machine or runtime boundary",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def choose_mode(
    ctx,
    command,
    needs_supervision,
    has_existing_run,
    needs_structured_work,
    needs_atlas_projection,
    remote_runtime,
    as_json,
):
    payload = agent_pack.choose_mode(
        command=command,
        needs_supervision=needs_supervision,
        has_existing_run=has_existing_run,
        needs_structured_work=needs_structured_work,
        needs_atlas_projection=needs_atlas_projection,
        remote_runtime=remote_runtime,
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"{payload['mode']} [{payload['maturity']}]: {payload['reason']}")
    click.echo(f"next: {payload['next']}")


@agent.command(help="preview or copy a provider skill file")
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="which provider skill to install",
)
@click.option(
    "--out",
    "out_dir",
    type=click.Path(file_okay=False, dir_okay=True),
    default=None,
    help="destination directory; required with --execute",
)
@click.option("--execute", is_flag=True, help="copy the file after preview")
@click.option("--force", is_flag=True, help="replace an existing SKILL.md")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def install_skill(ctx, target, out_dir, execute, force, as_json):
    src = agent_pack.skill_path(target)
    dest = os.path.join(out_dir, "SKILL.md") if out_dir else None
    payload = {
        "schema": "kungfu.agent-skill-install/v1",
        "target": target,
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


@agent.command(help="show the local agent bootstrap and report gate status")
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def status(ctx, target, as_json):
    policy = _read_policy(ctx, target)
    payload = {
        "schema": "kungfu.agent-status/v1",
        "target": target,
        "configured": policy is not None,
        "policyPath": _policy_path(ctx, target),
        "policy": policy,
        "skillSource": str(agent_pack.skill_path(target)),
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


@agent.command(help="preview or apply local agent bootstrap policy")
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option(
    "--mode",
    required=True,
    type=click.Choice(
        ["brief", "report", "atlas-projection", "trace", "managed-run", "remote-sync"]
    ),
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
@agent_command_context
def bootstrap(ctx, target, mode, skill_dir, execute, force, as_json):
    policy = _policy_payload(ctx, target, mode, enabled=True)
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


@agent.group(help="preview or apply an agent mode switch")
@agent_command_context
def mode(ctx):
    pass


@mode.command(name="set", help="set the local agent operating mode")
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
    type=click.Choice(
        ["brief", "report", "atlas-projection", "trace", "managed-run", "remote-sync"]
    ),
    help="new mode",
)
@click.option("--execute", is_flag=True, help="write the mode switch")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def set_mode(ctx, target, mode_name, execute, as_json):
    previous = _read_policy(ctx, target)
    policy = dict(previous or _policy_payload(ctx, target, mode_name, enabled=True))
    policy.update(_policy_payload(ctx, target, mode_name, enabled=True))
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


@agent.command(help="disable local bootstrap policy without deleting user data")
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option("--execute", is_flag=True, help="write disabled policy")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def unbootstrap(ctx, target, execute, as_json):
    previous = _read_policy(ctx, target)
    disabled = _policy_payload(ctx, target, "brief", enabled=False)
    payload = {
        "schema": "kungfu.agent-unbootstrap/v1",
        "target": target,
        "execute": execute,
        "changed": False,
        "previous": previous,
        "policy": disabled,
        "policyPath": _policy_path(ctx, target),
        "note": "Does not delete receipts, work items, rewind bundles, or copied skills.",
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


@agent.command(help="show complete uninstall steps; defaults to dry-run")
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option("--execute", is_flag=True, help="disable local policy")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@agent_command_context
def uninstall(ctx, target, execute, as_json):
    previous = _read_policy(ctx, target)
    disabled = _policy_payload(ctx, target, "brief", enabled=False)
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
            "Keep KF_HOME/runtime receipts unless the user explicitly archives or deletes Kungfu data.",
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
