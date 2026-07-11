# SPDX-License-Identifier: Apache-2.0

import json
import sys
from pathlib import Path
from typing import Any

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

facts_command_context = kfc.pass_context()


def _load_object(file_path: str) -> dict[str, Any]:
    text = (
        sys.stdin.read()
        if file_path == "-"
        else Path(file_path).read_text(encoding="utf-8")
    )
    value = json.loads(text)
    if not isinstance(value, dict):
        raise click.BadParameter("input must be a JSON object", param_hint="--file")
    return value


def _emit(value: dict[str, Any]) -> None:
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _runtime_dir(ctx: click.Context) -> str:
    return str(getattr(ctx, "runtime_dir"))


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=4,
    help="declare, admit, and replay user or domain facts",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def facts(ctx: click.Context) -> None:
    del ctx
    pass


@facts.command(help="show the C++-owned declaration and admission contract")
@facts_command_context
def capabilities(ctx: click.Context) -> None:
    from kungfu.storage import service

    _emit(service.fact_contract(_runtime_dir(ctx)))


@facts.command(
    "declare-world", help="append one effective-time contract-world declaration"
)
@click.option("--file", "file_path", required=True, help="declaration JSON path or -")
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@facts_command_context
def declare_world(ctx: click.Context, file_path: str, system_time: int) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_declare_contract_world(
            _runtime_dir(ctx), _load_object(file_path), system_time=system_time
        )
    )


@facts.command(
    "declare-surface", help="append one effective-time fact-surface declaration"
)
@click.option("--file", "file_path", required=True, help="declaration JSON path or -")
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@facts_command_context
def declare_surface(ctx: click.Context, file_path: str, system_time: int) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_declare_surface(
            _runtime_dir(ctx), _load_object(file_path), system_time=system_time
        )
    )


@facts.command(help="record one observation and its replayable admission decision")
@click.option("--file", "file_path", required=True, help="observation JSON path or -")
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@facts_command_context
def observe(ctx: click.Context, file_path: str, system_time: int) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_observe(
            _runtime_dir(ctx), _load_object(file_path), system_time=system_time
        )
    )


@facts.command(help="fold admitted facts at head or an exact system-time cut")
@click.option("--cut-system-time", type=click.IntRange(min=0), default=0)
@click.option("--subject-key", default="")
@facts_command_context
def state(ctx: click.Context, cut_system_time: int, subject_key: str) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_state(
            _runtime_dir(ctx),
            cut_system_time=cut_system_time,
            subject_key=subject_key,
        )
    )
