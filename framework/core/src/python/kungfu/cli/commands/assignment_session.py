# SPDX-License-Identifier: Apache-2.0

"""Native Work CLI composition for retained Agent Session evidence."""

from __future__ import annotations

from pathlib import Path

import click

from kungfu import assignment_evidence


def finalize_agent_session_result(
    *,
    agent_report_file,
    workspace_root,
    home,
    initiative_id,
    assignment_id,
    runtime,
    agent_report_summary,
):
    identity, runtime_dir, _receipt = runtime(workspace_root, home, "semantic-write")
    report_path, report = assignment_evidence.finalize_session_agent_report(
        agent_report_file,
        runtime_dir,
        initiative_id,
        assignment_id,
        workspace_root=identity.workspace_root or "",
    )
    return {
        "schema": "kungfu.work-start.agent-session-finalization/v1",
        "status": "agent-finished",
        "reportPath": str(report_path),
        "agentReport": agent_report_summary(report),
        "writeOccurred": True,
    }


def register_finalize_agent_session_command(
    command_group,
    *,
    assignment_context,
    runtime,
    emit,
    run_operation,
    agent_report_summary,
):
    @command_group.command(
        name="finalize-agent-session",
        help="retain the ended Agent Session as immutable independent-review evidence",
    )
    @click.argument(
        "agent_report_file",
        type=click.Path(exists=True, dir_okay=False, path_type=Path),
    )
    @click.option("--workspace", "workspace_root", type=click.Path(file_okay=False))
    @click.option("--home", is_flag=True)
    @click.option("--initiative-id", required=True)
    @click.option("--assignment-id", required=True)
    @assignment_context
    def finalize_agent_session(
        ctx,
        agent_report_file,
        workspace_root,
        home,
        initiative_id,
        assignment_id,
    ):
        _ = ctx
        emit(
            run_operation(
                lambda: finalize_agent_session_result(
                    agent_report_file=agent_report_file,
                    workspace_root=workspace_root,
                    home=home,
                    initiative_id=initiative_id,
                    assignment_id=assignment_id,
                    runtime=runtime,
                    agent_report_summary=agent_report_summary,
                )
            )
        )

    return finalize_agent_session
