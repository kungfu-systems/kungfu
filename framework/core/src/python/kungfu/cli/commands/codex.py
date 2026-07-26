# SPDX-License-Identifier: Apache-2.0
#
# Codex-specific adapter commands. These wrap the generic report/work facts in
# a receipt contract so an agent can close a native Codex goal only after Kungfu
# can verify the reported usage window and run linkage.

from __future__ import annotations

import json
import os
from typing import Any

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.rewind import reporting

codex_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="Codex-native adapters for reported goal usage and receipts",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def codex(ctx):
    pass


def _json(payload: dict[str, Any]) -> None:
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _read_json_file(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise click.ClickException(f"failed to read {path}: {e}") from e
    if not isinstance(value, dict):
        raise click.ClickException(f"expected JSON object: {path}")
    return value


def _has_goal_event(bundle_dir: str, run_id: str, goal_id: str) -> bool:
    event_file = os.path.join(bundle_dir, "report-events.jsonl")
    try:
        with open(event_file, encoding="utf-8") as f:
            for line in f:
                row = json.loads(line)
                if row.get("run_id") != run_id:
                    continue
                if row.get("type") != "codex_goal_usage_observed":
                    continue
                message = row.get("message") or ""
                if goal_id in message:
                    return True
    except (OSError, json.JSONDecodeError):
        return False
    return False


@codex.command(
    name="verify-goal-report",
    help="verify a Codex goal report receipt and its local Kungfu facts",
)
@click.option("--receipt", type=click.Path(dir_okay=False), required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@codex_command_context
def verify_goal_report(ctx, receipt, as_json):
    receipt_path = os.path.abspath(receipt)
    data = _read_json_file(receipt_path)
    errors = []
    if data.get("schema") != "kungfu.codex-goal-report/v1":
        errors.append("receipt schema mismatch")

    runtime_dir = data.get("runtime_dir") or ctx.runtime_dir
    run_id = data.get("run_id")
    work_id = data.get("work_id")
    goal_id = data.get("goal_id")
    manifest = data.get("manifest")
    if not run_id:
        errors.append("receipt missing run_id")
    if not work_id:
        errors.append("receipt missing work_id")
    if not goal_id:
        errors.append("receipt missing goal_id")

    if manifest and not os.path.exists(manifest):
        errors.append(f"manifest missing: {manifest}")
    bundle_dir = reporting.bundle_dir(runtime_dir, run_id) if run_id else ""
    if run_id and not os.path.isdir(bundle_dir):
        errors.append(f"bundle missing: {bundle_dir}")
    if run_id and goal_id and not _has_goal_event(bundle_dir, run_id, goal_id):
        errors.append("codex_goal_usage_observed event missing")

    payload = {
        "schema": "kungfu.codex-goal-report-verify/v1",
        "ok": not errors,
        "receipt": receipt_path,
        "run_id": run_id,
        "work_id": work_id,
        "goal_id": goal_id,
        "errors": errors,
    }
    if errors:
        if as_json:
            _json(payload)
        else:
            for error in errors:
                click.echo(f"[codex] verify failed: {error}", err=True)
        raise click.exceptions.Exit(1)
    if as_json:
        _json(payload)
    else:
        click.echo(f"[codex] verified goal report receipt: {receipt_path}")
