# SPDX-License-Identifier: Apache-2.0

from functools import partial
import json
import sys
from pathlib import Path

import click

from kungfu import agent as agent_pack
from kungfu import contract as contract_runtime
from kungfu import durability as durability_contract
from kungfu.agent import first_value as first_value_protocol
from kungfu.agent import context_surface
from kungfu.agent import session_surface as session_surface
from kungfu.agent.kfd3 import (
    api_help,
    kfd3_api,
    registry_summary,
    verify_agent_interface,
)
from kungfu.cli.commands import agent_first_value_entry
from kungfu.cli.commands import agent_docs
from kungfu.cli.commands import agent_work_lab as agent_work_lab_commands
from kungfu.cli.commands._agent.base import (
    _install_skill_file as _install_skill_file,
    _json as _json,
    _policy_dir as _policy_dir,
    _policy_path as _policy_path,
    _read_policy as _read_policy,
    _skill_dir as _skill_dir,
    _write_policy as _write_policy,
    agent as agent,
    agent_command_context as agent_command_context,
)


_context = partial(
    context_surface.project_agent_context,
    repo_root_finder=agent_work_lab_commands.find_repo_root,
)


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


@agent.group(name="first-value", help=api_help("kungfu.agent.first-value"))
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
    return {
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


from kungfu.cli.commands._agent.work import (  # noqa: E402
    work as work,
    work_capabilities as work_capabilities,
    work_session as work_session,
    work_inspect as work_inspect,
    work_action as work_action,
    work_export_authority as work_export_authority,
    work_import_authority as work_import_authority,
)
from kungfu.cli.commands._agent.hub import (  # noqa: E402
    hub as hub,
    hub_capabilities as hub_capabilities,
    hub_adapter as hub_adapter,
    hub_qualify as hub_qualify,
    hub_verify as hub_verify,
    hub_handle as hub_handle,
)
from kungfu.cli.commands._agent.runtime import (  # noqa: E402
    _runtime_config_homes as _runtime_config_homes,
    _runtime_error as _runtime_error,
    runtime as runtime,
    runtime_discover as runtime_discover,
    runtime_list as runtime_list,
    runtime_upsert as runtime_upsert,
    runtime_remove as runtime_remove,
    runtime_set_default as runtime_set_default,
    runtime_verify as runtime_verify,
)
from kungfu.cli.commands._agent.console import (  # noqa: E402
    console as console,
    console_current as console_current,
    console_bind_work as console_bind_work,
    session_action as session_action,
)


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


from kungfu.cli.commands._agent.provider import (  # noqa: E402
    install_skill as install_skill,
    status as status,
    bootstrap as bootstrap,
    mode as mode,
    set_mode as set_mode,
    unbootstrap as unbootstrap,
    uninstall as uninstall,
)


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
        click.echo(
            f"[agent] KFD-3 collaboration-interface verify: "
            f"{'ok' if payload['ok'] else 'failed'}"
        )
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
