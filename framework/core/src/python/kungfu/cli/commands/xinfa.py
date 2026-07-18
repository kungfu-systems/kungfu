# SPDX-License-Identifier: Apache-2.0

"""Public Kungfu adapter for the private, independently qualified Xinfa engine."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import click

import kungfu
from kungfu.cli.commands import kfc


_ATLAS_COMMANDS = {"compile", "diff", "impact", "inspect", "verify"}


def _resolve_xinfa_engine() -> str | None:
    override = os.environ.get("KUNGFU_XINFA_ENTRY")
    if override:
        return os.path.realpath(override) if os.path.isfile(override) else None

    binding_dir = Path(kungfu.__binding__.__file__).resolve().parent
    engine_name = "xinfa-engine.exe" if sys.platform == "win32" else "xinfa-engine"
    for candidate in (
        binding_dir.parent / "xinfa" / "engine" / engine_name,
        binding_dir / "xinfa" / "engine" / engine_name,
    ):
        if candidate.is_file():
            return str(candidate.resolve())

    source_entry = "source-xinfa.cmd" if sys.platform == "win32" else "source-xinfa"
    for directory in (binding_dir, *binding_dir.parents):
        candidate = directory / "xinfa" / "tooling" / source_entry
        if candidate.is_file():
            return str(candidate.resolve())
    return None


def _consume_workspace(commands: tuple[str, ...]) -> tuple[Path, tuple[str, ...]]:
    workspace = Path.cwd()
    forwarded: list[str] = []
    index = 0
    while index < len(commands):
        value = commands[index]
        if value == "--workspace":
            if index + 1 >= len(commands):
                raise click.UsageError("--workspace requires a path")
            workspace = Path(commands[index + 1])
            index += 2
            continue
        if value.startswith("--workspace="):
            workspace = Path(value.split("=", 1)[1])
            index += 1
            continue
        forwarded.append(value)
        index += 1
    return workspace.resolve(), tuple(forwarded)


def _normalize_commands(commands: tuple[str, ...]) -> tuple[str, ...]:
    if not commands or commands[0] not in _ATLAS_COMMANDS:
        return commands

    operation = commands[0]
    workspace, forwarded = _consume_workspace(commands[1:])
    if operation != "compile":
        return ("atlas", operation, *forwarded)

    has_project = "--project" in forwarded or any(
        value.startswith("--project=") for value in forwarded
    )
    has_pack = "--pack" in forwarded or any(
        value.startswith("--pack=") for value in forwarded
    )
    has_root = "--root" in forwarded or any(
        value.startswith("--root=") for value in forwarded
    )
    has_output = "--output" in forwarded or any(
        value.startswith("--output=") for value in forwarded
    )
    has_json = "--json" in forwarded
    normalized = list(forwarded)
    if not has_project and not has_pack:
        normalized[0:0] = ["--project", str(workspace / ".xinfa" / "project.json")]
        has_project = True
    if has_project and not has_root:
        normalized[0:0] = ["--root", str(workspace)]
    if not has_output:
        normalized.extend(["--output", str(workspace / ".xinfa" / "atlas")])
    if not has_json:
        normalized.append("--json")
    return ("atlas", "compile", *normalized)


def _run_xinfa(commands: tuple[str, ...]) -> int:
    engine = _resolve_xinfa_engine()
    if not engine:
        raise click.ClickException(
            "Kungfu Xinfa engine not found; installed products ship it privately "
            "under xinfa/engine, or set KUNGFU_XINFA_ENTRY for qualification"
        )
    completed = subprocess.run(  # noqa: S603 - exact resolved engine is intentional
        [engine, *_normalize_commands(commands)],
        check=False,
        shell=sys.platform == "win32" and engine.lower().endswith(".cmd"),
    )
    if completed.returncode:
        raise SystemExit(completed.returncode)
    return completed.returncode


@kfc.command(
    help_priority=2,
    context_settings={"ignore_unknown_options": True},
    help="compile workspace context into a verified Xinfa Atlas",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def xinfa(commands):
    """Run the private Xinfa engine through Kungfu's only public executable."""

    return _run_xinfa(commands)
