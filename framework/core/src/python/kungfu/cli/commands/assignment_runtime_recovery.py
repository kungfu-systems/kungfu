# SPDX-License-Identifier: Apache-2.0

"""Public `kungfu work` recovery commands for the Assignment Runtime."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import click

from kungfu.assignment_runtime import LocalAssignmentRuntimeApplication


def assignment_workspace_options(command: Callable[..., Any]) -> Callable[..., Any]:
    """Attach a fresh workspace selector to one public recovery command."""

    for decorator in reversed(
        (
            click.option(
                "--workspace",
                "workspace_root",
                type=click.Path(file_okay=False),
            ),
            click.option("--home", is_flag=True),
        )
    ):
        command = decorator(command)
    return command


def create_runtime_recovery_commands(
    resolve_runtime: Callable[..., tuple[Any, Path, dict[str, Any]]],
    emit: Callable[[dict[str, Any]], None],
    run: Callable[[Callable[[], dict[str, Any]]], dict[str, Any]],
    write_immutable_json: Callable[[Path | None, dict[str, Any]], str | None],
) -> tuple[click.Command, click.Command]:
    """Build the plan and execute commands over the shared Work runtime edge."""

    @click.command(
        name="runtime-recovery-plan",
        help="inspect one interrupted Assignment Runtime command without mutation",
    )
    @assignment_workspace_options
    @click.option("--out", type=click.Path(dir_okay=False, path_type=Path))
    def recovery_plan(workspace_root: str, home: bool, out: Path | None) -> None:
        def operation() -> dict[str, Any]:
            _, runtime_dir, _ = resolve_runtime(workspace_root, home, "read-only")
            application = LocalAssignmentRuntimeApplication(
                runtime_dir,
                client_id="kungfu.cli.runtime-recovery-plan",
                kind="cli",
            )
            plan = application.recovery_plan()
            return {**plan, "outputPath": write_immutable_json(out, plan)}

        emit(run(operation))

    @click.command(
        name="runtime-recovery-resolve",
        help=(
            "abandon one exact local pending projection while preserving unknown "
            "authority outcome"
        ),
    )
    @assignment_workspace_options
    @click.option(
        "--plan",
        "plan_file",
        required=True,
        type=click.Path(exists=True, dir_okay=False, path_type=Path),
    )
    @click.option("--expected-plan-root", required=True)
    @click.option("--authorized-by", required=True)
    @click.option("--reason", required=True)
    @click.option("--evidence-root", "evidence_roots", multiple=True, required=True)
    def recovery_resolve(
        workspace_root: str,
        home: bool,
        plan_file: Path,
        expected_plan_root: str,
        authorized_by: str,
        reason: str,
        evidence_roots: tuple[str, ...],
    ) -> None:
        def operation() -> dict[str, Any]:
            _, runtime_dir, _ = resolve_runtime(workspace_root, home, "semantic-write")
            plan = json.loads(plan_file.read_text(encoding="utf-8"))
            application = LocalAssignmentRuntimeApplication(
                runtime_dir,
                client_id="kungfu.cli.runtime-recovery-resolve",
                kind="cli",
            )
            return application.resolve_interrupted(
                plan=plan,
                expected_basis_root=expected_plan_root,
                authorized_by=authorized_by,
                reason=reason,
                evidence_roots=list(evidence_roots),
            )

        emit(run(operation))

    return recovery_plan, recovery_resolve
