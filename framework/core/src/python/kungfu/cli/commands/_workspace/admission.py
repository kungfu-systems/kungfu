# SPDX-License-Identifier: Apache-2.0

import json
from functools import wraps

import click


def _validate_admission_input(options) -> None:
    starts_admission = options["action"] in {"plan", "execute", "resume"}
    if (
        starts_admission
        and options["transport"] == "local-direct"
        and (not options["source_runtime"] or not options["episode_ids"])
    ):
        raise click.UsageError(
            "--source-runtime and at least one --episode-id are required"
        )
    if (
        starts_admission
        and options["transport"] != "local-direct"
        and (not options["bundle_files"] or not options["source_id"])
    ):
        raise click.UsageError(
            "--bundle-file and --source-id are required for bundle and remote-stream"
        )
    if (
        options["action"] in {"inspect", "resume", "reconcile", "cancel"}
        and not options["plan_root"]
    ):
        raise click.UsageError(f"--plan-root is required for {options['action']}")


def _admission_values(initiator, options) -> dict:
    episode_bundles = []
    for bundle_file in options["bundle_files"]:
        with open(bundle_file, encoding="utf-8") as input_file:
            episode_bundles.append(json.load(input_file))
    source_id = options["source_id"]
    return {
        "source_runtime_dir": options["source_runtime"],
        "episode_ids": list(options["episode_ids"]),
        "transport": options["transport"],
        "initiator": initiator,
        "plan_root": options["plan_root"],
        "project_cut_roots": list(options["project_cut_root"]),
        "episode_bundles": episode_bundles or None,
        "source_identity": (
            {
                "schema": "kungfu.workspace.identity/v1",
                "kind": "declared",
                "id": source_id,
            }
            if source_id
            else None
        ),
    }


def _run_admission(initiator, options) -> None:
    from kungfu.storage import service

    _validate_admission_input(options)
    values = _admission_values(initiator, options)
    action = options["action"]
    destination = options["destination_runtime"]
    if action == "execute":
        plan = service.episode_admission(destination, action="plan", **values)
        payload = service.episode_admission(
            destination, action="execute", plan=plan, **values
        )
    else:
        payload = service.episode_admission(destination, action=action, **values)
    if options["as_json"]:
        click.echo(json.dumps(payload, indent=2, sort_keys=True))
        return
    click.echo(
        f"{initiator} {payload.get('status', 'planned')} "
        f"{payload.get('plan_root', options['plan_root'])}"
    )


def admission_command(initiator: str):
    def decorate(function):
        @click.option(
            "--source-runtime",
            type=click.Path(file_okay=False),
            help="source workspace runtime directory",
        )
        @click.option(
            "--destination-runtime",
            required=True,
            type=click.Path(file_okay=False),
            help="destination workspace runtime directory",
        )
        @click.option("--episode-id", "episode_ids", multiple=True, type=int)
        @click.option(
            "--transport",
            type=click.Choice(["local-direct", "bundle", "remote-stream"]),
            default="local-direct",
            show_default=True,
        )
        @click.option(
            "--action",
            type=click.Choice(
                ["plan", "execute", "inspect", "resume", "reconcile", "cancel"]
            ),
            default="plan",
            show_default=True,
        )
        @click.option(
            "--plan-root", default="", help="existing plan root for lifecycle actions"
        )
        @click.option(
            "--project-cut-root", multiple=True, help="related Project Cut root"
        )
        @click.option(
            "--bundle-file",
            "bundle_files",
            multiple=True,
            type=click.Path(exists=True, dir_okay=False),
            help="self-contained Episode bundle for bundle or remote-stream",
        )
        @click.option(
            "--source-id",
            default="",
            help="declared source identity for non-local transports",
        )
        @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
        @wraps(function)
        def wrapped(**options):
            _run_admission(initiator, options)

        return wrapped

    return decorate
