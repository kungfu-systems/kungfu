# SPDX-License-Identifier: Apache-2.0

import json
import os
import sys
from pathlib import Path
from typing import Any

import click

from kungfu import agent as agent_pack
from kungfu import config as kungfu_config
from kungfu import contract as contract_runtime
from kungfu import durability as durability_contract
from kungfu.agent import runtime_profiles
from kungfu.agent import session_surface
from kungfu.agent import documentation as documentation_pack
from kungfu.agent.kfd3 import (
    api_help,
    kfd3_api,
    registry_summary,
    verify_agent_interface,
)
from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.config import resolve_config

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
            "collaborationInterface": registry_summary(),
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
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/guides/config.md",
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


@agent.command(help=api_help("kungfu.agent.brief"))
@kfd3_api("kungfu.agent.brief")
@agent_command_context
def brief(ctx):
    click.echo(agent_pack.document_text("brief.md"), nl=False)


@agent.command(help=api_help("kungfu.agent.docs"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option("--atlas", type=click.Path(file_okay=False, path_type=Path))
@click.option(
    "--verify", "verify_pack", is_flag=True, help="verify the packaged Xinfa Atlas"
)
@click.option(
    "--catalog",
    "show_catalog",
    is_flag=True,
    help="list exact packaged documentation surfaces",
)
@click.option("--read", "read_path", help="read one exact repository-relative surface")
@click.option(
    "--projection",
    type=click.Choice(["human", "agent"]),
    help="show a precompiled Xinfa projection",
)
@kfd3_api("kungfu.agent.docs")
@agent_command_context
def docs(ctx, as_json, atlas, verify_pack, show_catalog, read_path, projection):
    requested = sum(
        bool(value) for value in (verify_pack, show_catalog, read_path, projection)
    )
    if requested > 1:
        raise click.UsageError(
            "choose only one of --verify, --catalog, --read, or --projection"
        )
    try:
        if verify_pack:
            payload = documentation_pack.verify(atlas)
        elif show_catalog:
            payload = documentation_pack.catalog(atlas)
        elif read_path:
            payload = documentation_pack.read(read_path, atlas)
        elif projection:
            payload = documentation_pack.projection(projection, atlas)
        else:
            payload = None
    except (FileNotFoundError, KeyError, OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if payload is not None:
        if as_json:
            _json(payload)
        elif verify_pack:
            click.echo(
                f"Documentation Atlas: {'valid' if payload['valid'] else 'invalid'} "
                f"({payload.get('atlasRoot', 'unknown')})"
            )
        elif read_path:
            click.echo(payload["content"], nl=False)
        else:
            click.echo(json.dumps(payload, indent=2, sort_keys=True))
        if verify_pack and not payload["valid"]:
            raise click.ClickException("Documentation Atlas verification failed")
        return
    index = agent_pack.index()
    root = str(agent_pack.pack_root())
    payload = {
        "schema": "kungfu.agent-docs/v1",
        "packRoot": root,
        "documents": index["documents"],
        "skills": index["skills"],
        "contextCompiler": index["contextCompiler"],
    }
    if as_json:
        _json(payload)
        return
    click.echo(f"Agent pack: {root}")
    for row in index["documents"]:
        click.echo(f"- {row['path']} [{row['maturity']}]: {row['purpose']}")
    for row in index["skills"]:
        click.echo(f"- {row['path']} [{row['maturity']}]: {row['target']} skill")


@agent.command(help=api_help("kungfu.agent.capabilities"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.capabilities")
@agent_command_context
def capabilities(ctx, as_json):
    work_model = contract_runtime.contract_metadata("agent-work-state")
    payload = {
        "schema": "kungfu.agent-capabilities/v1",
        "index": agent_pack.index(),
        "commands": agent_pack.commands(),
        "collaborationInterface": registry_summary(),
        "durability": durability_contract.capabilities(),
        "workModel": {
            "command": "kungfu agent work-model --json",
            "contract": work_model,
        },
    }
    if as_json:
        _json(payload)
        return
    click.echo("Kungfu Agent Pack capabilities")
    for row in payload["commands"]["commands"]:
        click.echo(f"- {row['name']} [{row['maturity']}]: {row['purpose']}")


@agent.command(name="work-model", help=api_help("kungfu.agent.work-model"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work-model")
@agent_command_context
def work_model(ctx, as_json):
    """Inspect the public Pursuit, Atlas, Warrant, and Episode contract."""
    try:
        payload = contract_runtime.load_contract("agent-work-state")
        metadata = contract_runtime.contract_metadata("agent-work-state")
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as error:
        raise click.ClickException(str(error)) from error
    payload["path"] = metadata["path"]
    payload["hash"] = metadata["hash"]
    if as_json:
        _json(payload)
        return
    click.echo("Kungfu Agent Work model")
    for role in payload["roles"]:
        click.echo(f"- {role['name']}: {role['owns']}")
    click.echo(f"qualification: {payload['qualification']['status']}")


def _runtime_config_homes(ctx):
    resolved = resolve_config(runtime_home=ctx.home)
    return resolved["configHome"], resolved["runtimeHome"]


def _runtime_error(exc):
    raise click.ClickException(str(exc)) from exc


@agent.group(help=api_help("kungfu.agent.runtime"))
@kfd3_api("kungfu.agent.runtime")
@agent_command_context
def runtime(ctx):
    """Discover and configure machine-local Codex/Claude launch profiles."""


@runtime.command(name="discover", help=api_help("kungfu.agent.runtime.discover"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.discover")
@agent_command_context
def runtime_discover(ctx, as_json):
    payload = runtime_profiles.discover_catalog(
        resolved_config=resolve_config(runtime_home=ctx.home)
    )
    if as_json:
        _json(payload)
        return
    for row in payload["discovered"]:
        profile = row["profile"]
        click.echo(
            f"{profile['id']}  {profile['label']}  "
            f"{profile['launch']['executable']}  {row.get('version') or 'version unknown'}"
        )
    for row in payload["diagnostics"]:
        click.echo(f"{row['provider']}: {row['message']}")


@runtime.command(name="list", help=api_help("kungfu.agent.runtime.list"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.list")
@agent_command_context
def runtime_list(ctx, as_json):
    payload = runtime_profiles.discover_catalog(
        resolved_config=resolve_config(runtime_home=ctx.home)
    )
    if as_json:
        _json(payload)
        return
    click.echo(f"default: {payload['defaultProfileId'] or '<automatic>'}")
    click.echo(f"recommended: {payload['recommendedProfileId'] or '<none>'}")
    for profile in payload["configured"]:
        click.echo(f"configured  {profile['id']}  {profile['label']}")
    for row in payload["discovered"]:
        profile = row["profile"]
        click.echo(f"discovered  {profile['id']}  {profile['label']}")


@runtime.command(name="upsert", help=api_help("kungfu.agent.runtime.upsert"))
@click.option("--id", "profile_id", required=True, help="stable profile id")
@click.option("--label", required=True, help="user-visible profile label")
@click.option("--provider", required=True, type=click.Choice(["codex", "claude"]))
@click.option("--executable", required=True, help="executable path or PATH name")
@click.option("--arg", "argv", multiple=True, help="repeat for each launch argv")
@click.option("--shell-mode", is_flag=True, help="explicitly allow shell semantics")
@click.option(
    "--cwd-policy",
    type=click.Choice(["workspace-root", "home", "inherit"]),
    default="workspace-root",
    show_default=True,
)
@click.option(
    "--backend",
    type=click.Choice(["tmux", "direct"]),
    default="tmux",
    show_default=True,
)
@click.option(
    "--envelope",
    type=click.Choice(["required", "disabled"]),
    default="required",
    show_default=True,
)
@click.option("--execute", is_flag=True, help="write the reviewed profile")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.upsert")
@agent_command_context
def runtime_upsert(
    ctx,
    profile_id,
    label,
    provider,
    executable,
    argv,
    shell_mode,
    cwd_policy,
    backend,
    envelope,
    execute,
    as_json,
):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        plan = runtime_profiles.plan_upsert(
            profile_id=profile_id,
            label=label,
            provider=provider,
            executable=executable,
            argv=list(argv),
            shell_mode=shell_mode,
            cwd_policy=cwd_policy,
            backend=backend,
            envelope=envelope,
            config_home=config_home,
            runtime_home=runtime_home,
        )
        payload = (
            runtime_profiles.apply_upsert(
                plan, config_home=config_home, runtime_home=runtime_home
            )
            if execute
            else plan
        )
    except ValueError as exc:
        _runtime_error(exc)
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{payload['schema']}: {profile_id} "
        f"({'applied' if execute else 'preview only'})"
    )


@runtime.command(name="remove", help=api_help("kungfu.agent.runtime.remove"))
@click.argument("profile_id")
@click.option("--execute", is_flag=True, help="remove the reviewed profile")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.remove")
@agent_command_context
def runtime_remove(ctx, profile_id, execute, as_json):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        plan = runtime_profiles.plan_remove(
            profile_id, config_home=config_home, runtime_home=runtime_home
        )
        payload = (
            runtime_profiles.apply_remove(
                plan, config_home=config_home, runtime_home=runtime_home
            )
            if execute
            else plan
        )
    except ValueError as exc:
        _runtime_error(exc)
    if as_json:
        _json(payload)
        return
    click.echo(f"{profile_id}: {'removed' if execute else 'preview only'}")


@runtime.command(name="set-default", help=api_help("kungfu.agent.runtime.set-default"))
@click.argument("profile_id")
@click.option("--execute", is_flag=True, help="write the default selection")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.set-default")
@agent_command_context
def runtime_set_default(ctx, profile_id, execute, as_json):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        payload = runtime_profiles.set_default(
            profile_id,
            execute=execute,
            config_home=config_home,
            runtime_home=runtime_home,
        )
    except ValueError as exc:
        _runtime_error(exc)
    if as_json:
        _json(payload)
        return
    click.echo(f"default {profile_id}: {'set' if execute else 'preview only'}")


@runtime.command(name="verify", help=api_help("kungfu.agent.runtime.verify"))
@click.argument("profile_id")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.runtime.verify")
@agent_command_context
def runtime_verify(ctx, profile_id, as_json):
    config_home, runtime_home = _runtime_config_homes(ctx)
    try:
        profile = runtime_profiles.find_profile(
            profile_id, config_home=config_home, runtime_home=runtime_home
        )
    except ValueError as exc:
        _runtime_error(exc)
    payload = runtime_profiles.verify_profile(profile)
    if as_json:
        _json(payload)
        return
    click.echo(
        f"{profile_id}: {'ok' if payload['ok'] else 'unavailable'} "
        f"{payload.get('version') or payload.get('error') or ''}"
    )


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
        payload: dict[str, Any] = {
            "schema": "kungfu.agent-console-current/v1",
            "available": False,
            "reason": "not-running-inside-kungfu-agent-console",
        }
    else:
        try:
            envelope = json.loads(raw)
            kungfu_config.validate_value("agentConsoleEnvelope", envelope)
        except (ValueError, json.JSONDecodeError) as exc:
            raise click.ClickException(
                f"invalid Agent Console envelope: {exc}"
            ) from exc
        payload = {
            "schema": "kungfu.agent-console-current/v1",
            "available": True,
            "envelope": envelope,
            "workBound": envelope.get("workRef") is not None,
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
            "attach",
            "detach",
            "plan-control",
            "acquire-control",
            "release-control",
            "instruct",
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
        payload = session_surface.invoke(request, endpoint=endpoint)
    except (OSError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        _json(payload)
        return
    click.echo(f"{operation}: {payload.get('status') or payload.get('schema') or 'ok'}")


@agent.command(help=api_help("kungfu.agent.choose-mode"))
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
@kfd3_api("kungfu.agent.choose-mode")
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


@agent.command(help=api_help("kungfu.agent.install-skill"))
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
@kfd3_api("kungfu.agent.install-skill")
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


@agent.command(help=api_help("kungfu.agent.status"))
@click.option(
    "--target",
    required=True,
    type=click.Choice(["codex", "claude"]),
    help="provider skill target",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.status")
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
@kfd3_api("kungfu.agent.bootstrap")
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
    type=click.Choice(
        ["brief", "report", "atlas-projection", "trace", "managed-run", "remote-sync"]
    ),
    help="new mode",
)
@click.option("--execute", is_flag=True, help="write the mode switch")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.mode.set")
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


@agent.command(help=api_help("kungfu.agent.context"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.context")
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


@agent.command(help=api_help("kungfu.agent.verify"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.verify")
@agent_command_context
def verify(ctx, as_json):
    payload = verify_agent_interface(agent)
    if as_json:
        _json(payload)
    else:
        status_text = "ok" if payload["ok"] else "failed"
        click.echo(f"[agent] KFD-3 collaboration-interface verify: {status_text}")
        for section in ["registryErrors", "hiddenUsableApis"]:
            for failure in payload.get(section, []):
                click.echo(f"- {section}: {failure}")
        for section in ["runtimeAnchors", "commandCatalog"]:
            for key, values in payload.get(section, {}).items():
                if key.startswith("missing") or key.startswith("stale"):
                    for value in values:
                        click.echo(f"- {section}.{key}: {value}")
    if not payload["ok"]:
        sys.exit(1)
