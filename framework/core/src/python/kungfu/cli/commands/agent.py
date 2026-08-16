# SPDX-License-Identifier: Apache-2.0

import base64
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
from kungfu.agent import agent_hub
from kungfu.agent import agent_hub_qualification
from kungfu.agent import first_value as first_value_protocol
from kungfu.agent import runtime_profiles
from kungfu.agent import run_agent
from kungfu.agent import session_surface
from kungfu.agent import work_profile
from kungfu.agent import documentation as documentation_pack
from kungfu.agent.kfd3 import (
    api_help,
    kfd3_api,
    registry_summary,
    verify_agent_interface,
)
from kungfu.cli.commands import agent_first_value_entry
from kungfu.cli.commands import agent_docs
from kungfu.cli.commands import agent_work_lab as agent_work_lab_commands
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
    native_raw = os.environ.get("KUNGFU_AGENT_CONTEXT", "").strip()
    if native_raw:
        native = json.loads(native_raw)
        if (
            not isinstance(native, dict)
            or native.get("schema") != "kungfu.native-agent-context/v1"
            or native.get("environment") != "native-interactive"
        ):
            raise ValueError("invalid native Agent context envelope")
        console_raw = os.environ.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
        if console_raw:
            envelope = json.loads(console_raw)
            kungfu_config.validate_value("agentConsoleEnvelope", envelope)
            work_binding = dict(native.get("workBinding") or {})
            effective_work_ref = session_surface.effective_work_ref(envelope)
            work_binding["launchState"] = (
                "bound" if effective_work_ref is not None else "unbound"
            )
            work_binding["workRef"] = effective_work_ref
            native["workBinding"] = work_binding
        return native
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
            "skillRegistry": "kungfu skill inspect --json",
            "kfx": "kungfu kfx list --json",
        },
        "skillRegistry": agent_pack.skill_registry(ctx.home),
        "docs": documentation_pack.discovery_context(
            agent_work_lab_commands.find_repo_root()
        ),
        "agentPack": {
            "packRoot": str(agent_pack.pack_root()),
            "documents": index["documents"],
            "skills": index["skills"],
            "commands": agent_pack.commands(),
            "collaborationInterface": registry_summary(),
        },
    }


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


def _skill_dir(target, scope):
    root = Path.cwd() if scope == "project" else Path.home()
    provider_root = ".agents" if target == "codex" else ".claude"
    return root / provider_root / "skills" / "kungfu-agent-onboarding"


@agent.command(help=api_help("kungfu.agent.brief"))
@kfd3_api("kungfu.agent.brief")
@agent_command_context
def brief(ctx):
    try:
        click.echo(
            first_value_protocol.validate_brief(agent_pack.document_text("brief.md")),
            nl=False,
        )
    except ValueError as error:
        raise click.ClickException(str(error)) from error


@agent.command(
    name="bootstrap-status",
    help="Inspect this native attempt's Agent Brief bootstrap.",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.bootstrap-status")
@agent_work_lab_commands.surface(mutation_class="read")
@agent_command_context
def bootstrap_status(ctx, as_json):
    del ctx
    agent_work_lab_commands.emit_agent_bootstrap_status(as_json)


@agent.command(name="map", help="Print the stable first-entry intent map.")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.map")
@agent_command_context
def intent_map(ctx, as_json):
    try:
        payload = first_value_protocol.intent_map_view()
    except ValueError as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    for row in payload["intents"]:
        click.echo(f"{row['id']} [{row['maturity']}]: {row['summary']}")


agent_work_lab_commands.register_advisories(agent, agent_command_context)


@agent.group(
    name="first-value",
    help=api_help("kungfu.agent.first-value"),
)
@kfd3_api("kungfu.agent.first-value")
@agent_command_context
def first_value(ctx):
    pass


agent_first_value_entry.register(first_value, agent_command_context)


@first_value.command(name="receipt", help=api_help("kungfu.agent.first-value.receipt"))
@click.option("--intent", "intent_id", required=True, help="one declared intent id")
@click.option(
    "--discovery",
    "--discovery-command",
    "discovery",
    required=True,
    help="one declared safe discovery command",
)
@click.option("--question-count", required=True, type=click.IntRange(0, 1))
@click.option("--outcome", required=True, help="bounded human outcome summary")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.first-value.receipt")
@agent_command_context
def first_value_receipt(ctx, intent_id, discovery, question_count, outcome, as_json):
    try:
        payload = first_value_protocol.create_receipt(
            intent_id=intent_id,
            discovery_command=discovery,
            question_count=question_count,
            outcome_summary=outcome,
        )
    except (OSError, ValueError, first_value_protocol.SubprocessError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"verified first value: {payload['receiptRoot']}")


@first_value.command(name="verify", help=api_help("kungfu.agent.first-value.verify"))
@click.argument(
    "receipt_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.first-value.verify")
@agent_command_context
def first_value_verify(ctx, receipt_file, as_json):
    try:
        payload = first_value_protocol.verify_receipt(
            first_value_protocol.read_receipt(receipt_file)
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
        return
    click.echo(f"verified first-value receipt: {payload['receiptRoot']}")


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
@click.option(
    "--bundle",
    "show_bundle",
    is_flag=True,
    help="show the verified Portable Kungfu Atlas Bundle contract",
)
@click.option("--read", "read_path", help="read one exact repository-relative surface")
@click.option(
    "--projection",
    type=click.Choice(["human", "agent"]),
    help="show a precompiled Xinfa projection",
)
@kfd3_api("kungfu.agent.docs")
@agent_command_context
def docs(
    ctx,
    as_json,
    atlas,
    verify_pack,
    show_catalog,
    show_bundle,
    read_path,
    projection,
):
    return agent_docs.run(
        as_json=as_json,
        atlas=atlas,
        verify_pack=verify_pack,
        show_catalog=show_catalog,
        show_bundle=show_bundle,
        read_path=read_path,
        projection=projection,
        emit_json=_json,
    )


def _capabilities_payload():
    work_model = contract_runtime.contract_metadata("agent-work-state")
    action_geometry = contract_runtime.contract_metadata("action-geometry")
    work_domain_profile = contract_runtime.contract_metadata(
        "agent-work-domain-profile"
    )
    payload = {
        "schema": "kungfu.agent-capabilities/v1",
        "index": agent_pack.index(),
        "commands": agent_pack.commands(),
        "cliSurface": agent_pack.cli_surface_catalog(),
        "collaborationInterface": registry_summary(),
        "durability": durability_contract.capabilities(),
        "workModel": {
            "command": "kungfu agent work-model --json",
            "contract": work_model,
        },
        "actionGeometry": action_geometry,
        "workDomainProfile": work_domain_profile,
        "workLoop": first_value_protocol.work_authority_capabilities(),
        "workspaceGit": first_value_protocol.workspace_git_policy_view(),
    }
    return payload


@agent.command(help=api_help("kungfu.agent.capabilities"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.capabilities")
@agent_command_context
def capabilities(ctx, as_json):
    payload = _capabilities_payload()
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


@agent.group(name="work", help=api_help("kungfu.agent.work"))
@kfd3_api("kungfu.agent.work")
@agent_command_context
def work(ctx):
    """Inspect and apply the KFD-7 Kungfu Product Profile."""


@work.command(name="capabilities", help=api_help("kungfu.agent.work.capabilities"))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.capabilities")
@agent_command_context
def work_capabilities(ctx, as_json):
    payload = work_profile.capabilities()
    if as_json:
        _json(payload)
        return
    click.echo("Kungfu KFD-7 Profile capabilities")
    for role in payload["roles"]:
        click.echo(f"- {role}")


@work.command(name="session", help=api_help("kungfu.agent.work.session"))
@click.option(
    "--operation",
    type=click.Choice(["compressibility", "expand", "project"]),
    required=True,
)
@click.option("--file", "file_path", help="session or expansion JSON path or -")
@click.option(
    "--input-base64",
    help="base64-encoded session or expansion JSON for SDK and GUI adapters",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.session")
@agent_command_context
def work_session(ctx, operation, file_path, input_base64, as_json):
    """Expand, project, or test the complexity boundary of one session."""

    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("session input must be a JSON object")
        handlers = {
            "compressibility": work_profile.session_compressibility,
            "expand": work_profile.expand_session,
            "project": work_profile.project_session,
        }
        payload = handlers[operation](value)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))


@work.command(name="inspect", help=api_help("kungfu.agent.work.inspect"))
@click.option("--ref", "ref_name", required=True, help="exact Fact ref name")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.inspect")
@agent_command_context
def work_inspect(ctx, ref_name, as_json):
    payload = work_profile.inspect(ctx.runtime_dir, ref_name)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("status") == "denied":
        ctx.exit(2)


@work.command(name="action", help=api_help("kungfu.agent.work.action"))
@click.option("--file", "file_path", help="Profile action request JSON path or -")
@click.option(
    "--input-base64",
    help="base64-encoded Profile action JSON for SDK and GUI adapters",
)
@click.option("--execute", is_flag=True, help="append and CAS the action")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.action")
@agent_command_context
def work_action(ctx, file_path, input_base64, execute, as_json):
    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("Profile action request must be a JSON object")
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    payload = work_profile.apply_action(ctx.runtime_dir, request, execute=execute)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("status") == "denied":
        ctx.exit(2)


@work.command(
    name="export-authority", help=api_help("kungfu.agent.work.export-authority")
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.export-authority")
@agent_command_context
def work_export_authority(ctx, as_json):
    """Export the native Fact authority required for exact continuation."""

    payload = work_profile.export_authority(ctx.runtime_dir)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("ok") is not True:
        ctx.exit(2)


@work.command(
    name="import-authority", help=api_help("kungfu.agent.work.import-authority")
)
@click.option("--file", "file_path", help="authority bundle JSON path or -")
@click.option(
    "--input-base64",
    help="base64-encoded authority bundle JSON for SDK and GUI adapters",
)
@click.option("--execute", is_flag=True, help="replay the validated bundle")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.work.import-authority")
@agent_command_context
def work_import_authority(ctx, file_path, input_base64, execute, as_json):
    """Validate or replay one qualified Fact authority bundle."""

    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        bundle = json.loads(raw)
        if not isinstance(bundle, dict):
            raise ValueError("authority bundle must be a JSON object")
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    payload = work_profile.import_authority(ctx.runtime_dir, bundle, execute=execute)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
    if payload.get("ok") is not True:
        ctx.exit(2)


@agent.group(name="hub", help=api_help("kungfu.agent.hub"))
@kfd3_api("kungfu.agent.hub")
@agent_command_context
def hub(ctx):
    """Operate the product-owned KFD Agent Hub profile projection."""


@hub.command(name="capabilities", help=api_help("kungfu.agent.hub.capabilities"))
@click.option("--hub-id", required=True, help="receiver-owned Hub identity")
@click.option(
    "--runtime-home",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="exact Hub authority home",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.hub.capabilities")
@agent_command_context
def hub_capabilities(ctx, hub_id, runtime_home, as_json):
    payload = agent_hub.capabilities(hub_id, runtime_home)
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))


@hub.command(name="adapter", help=api_help("kungfu.agent.hub.adapter"))
@click.option(
    "--qualification-root",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="containment root for the two isolated Hub authority homes",
)
@kfd3_api("kungfu.agent.hub.adapter")
@agent_command_context
def hub_adapter(ctx, qualification_root):
    """Serve the product-owned Hub profile over the KFD JSONL binding."""

    source_home = qualification_root / "hub-alpha" / ".kungfu"
    target_home = qualification_root / "hub-beta" / ".kungfu"
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("KFD adapter request must be a JSON object")
            payload = agent_hub.handle_request(
                request,
                source_home=source_home,
                target_home=target_home,
                qualification_root=qualification_root,
            )
            click.echo(json.dumps(payload, sort_keys=True))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error


@hub.command(name="qualify", help=api_help("kungfu.agent.hub.qualify"))
@click.option(
    "--output-dir",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="new directory for rooted qualification evidence",
)
@click.option(
    "--timeout-ms",
    default=30_000,
    show_default=True,
    type=click.IntRange(min=100),
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--kfd-entry",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@click.option(
    "--product-executable",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@kfd3_api("kungfu.agent.hub.qualify")
@agent_command_context
def hub_qualify(ctx, output_dir, timeout_ms, as_json, kfd_entry, product_executable):
    """Run Hub 20 and explain the exact installed-product result."""

    try:
        payload = agent_hub_qualification.qualify(
            output_dir,
            kfd_entry=kfd_entry,
            product_executable=product_executable,
            timeout_ms=timeout_ms,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(agent_hub_qualification.render_human(payload), nl=False)
    if not payload["valid"]:
        ctx.exit(1)


@hub.command(name="verify", help=api_help("kungfu.agent.hub.verify"))
@click.option(
    "--qualification-dir",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
    help="retained qualification evidence directory",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--kfd-entry",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@click.option(
    "--product-executable",
    type=click.Path(dir_okay=False, path_type=Path),
    hidden=True,
)
@kfd3_api("kungfu.agent.hub.verify")
@agent_command_context
def hub_verify(ctx, qualification_dir, as_json, kfd_entry, product_executable):
    """Independently recheck retained Hub qualification evidence offline."""

    try:
        payload = agent_hub_qualification.verify(
            qualification_dir,
            kfd_entry=kfd_entry,
            product_executable=product_executable,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(
            agent_hub_qualification.render_human(payload, verification=True),
            nl=False,
        )
    if not payload["valid"]:
        ctx.exit(1)


@hub.command(name="handle", help=api_help("kungfu.agent.hub.handle"))
@click.option("--file", "file_path", help="KFD adapter request JSON path or -")
@click.option("--input-base64", help="base64-encoded KFD adapter request JSON")
@click.option(
    "--source-home",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
)
@click.option(
    "--target-home",
    required=True,
    type=click.Path(file_okay=False, path_type=Path),
)
@click.option(
    "--qualification-root",
    type=click.Path(file_okay=False, path_type=Path),
    help="optional containment root for isolated qualification",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.hub.handle")
@agent_command_context
def hub_handle(
    ctx,
    file_path,
    input_base64,
    source_home,
    target_home,
    qualification_root,
    as_json,
):
    try:
        if bool(file_path) == bool(input_base64):
            raise ValueError("exactly one of --file or --input-base64 is required")
        if input_base64:
            raw = base64.b64decode(input_base64, validate=True).decode("utf-8")
        else:
            raw = (
                sys.stdin.read()
                if file_path == "-"
                else Path(file_path).read_text(encoding="utf-8")
            )
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("KFD adapter request must be a JSON object")
        payload = agent_hub.handle_request(
            request,
            source_home=source_home,
            target_home=target_home,
            qualification_root=qualification_root,
        )
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _json(payload)
    else:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _runtime_config_homes(ctx):
    resolved = resolve_config(runtime_home=ctx.home)
    return resolved["configHome"], resolved["runtimeHome"]


def _runtime_error(exc):
    raise click.ClickException(str(exc)) from exc


@agent.group(help=api_help("kungfu.agent.runtime"))
@kfd3_api("kungfu.agent.runtime")
@agent_command_context
def runtime(ctx):
    """Discover and configure machine-local Agent launch profiles."""


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
@click.option(
    "--provider",
    required=True,
    help="built-in or registered native Provider adapter id",
)
@click.option("--executable", required=True, help="executable path or PATH name")
@click.option("--arg", "argv", multiple=True, help="repeat for each launch argv")
@click.option(
    "--interactive-arg",
    "interactive_argv",
    multiple=True,
    help="repeat for each provider-native interactive argv",
)
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
    interactive_argv,
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
            interactive_argv=list(interactive_argv),
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
    remote_runtime,
    as_json,
):
    payload = agent_pack.choose_mode(
        command=command,
        needs_supervision=needs_supervision,
        has_existing_run=has_existing_run,
        needs_structured_work=needs_structured_work,
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
@click.option("--task", help="exact task for verified Xinfa context")
@click.option("--role", help="task role; required with --task")
@click.option("--budget", type=click.IntRange(min=1), help="context token budget")
@click.option("--route", help="exact route id; required with --task")
@kfd3_api("kungfu.agent.context")
@agent_command_context
def context(ctx, as_json, task, role, budget, route):
    return agent_docs.run_context(
        ctx=ctx,
        task=task,
        role=role,
        budget=budget,
        route=route,
        as_json=as_json,
        default_context=_context,
        emit_json=_json,
    )


@agent.command(name="expand", help="Expand one verified Xinfa context handle.")
@click.option("--view", type=click.Choice(["agent", "human"]), default="agent")
@click.option("--handle", required=True)
@click.option("--budget", required=True, type=click.IntRange(min=1))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfd3_api("kungfu.agent.expand")
@agent_command_context
def expand(ctx, view, handle, budget, as_json):
    return agent_docs.run_expand(
        view=view,
        handle=handle,
        budget=budget,
        as_json=as_json,
        emit_json=_json,
    )


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
