# SPDX-License-Identifier: Apache-2.0
#
# Codex-specific adapter commands. These wrap the generic report/work facts in
# a receipt contract so an agent can close a native Codex goal only after Kungfu
# can verify the reported usage window and run linkage.

from __future__ import annotations

import json
import os
import sys
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


def _load_work(runtime_dir: str) -> dict[str, Any]:
    from kungfu.work import store

    return store.load(runtime_dir)


def _require_work(runtime_dir: str, work_id: str) -> dict[str, Any]:
    items = _load_work(runtime_dir)
    if work_id not in items:
        click.echo(f"[codex] unknown work item: {work_id}", err=True)
        sys.exit(1)
    return items[work_id]


def _write_receipt(runtime_dir: str, run_id: str, receipt: dict[str, Any]) -> str:
    target = reporting.bundle_dir(runtime_dir, run_id)
    os.makedirs(target, exist_ok=True)
    path = os.path.join(target, "codex-goal-receipt.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(receipt, f, indent=2, sort_keys=True)
        f.write("\n")
    return path


def _read_json_file(path: str) -> dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        click.echo(f"[codex] failed to read {path}: {e}", err=True)
        sys.exit(1)


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
    name="report-goal",
    help="report a native Codex goal into Kungfu and emit a verifiable receipt",
)
@click.option("--work", "work_id", type=str, default=None, help="existing work item id")
@click.option("--title", type=str, default=None, help="title when creating work")
@click.option("--goal-id", required=True, type=str, help="Codex native goal id")
@click.option("--objective", type=str, default=None, help="Codex goal objective")
@click.option(
    "--status",
    required=True,
    type=click.Choice(["succeeded", "failed", "blocked", "interrupted"]),
    help="terminal goal status",
)
@click.option("--tokens-used", type=int, default=None, help="native total token usage")
@click.option(
    "--time-used-seconds", type=int, default=None, help="native elapsed seconds"
)
@click.option("--run-id", type=str, default=None, help="stable Kungfu run id")
@click.option("--provider", type=str, default="codex", help="provider label")
@click.option("--model", type=str, default=None, help="model name when known")
@click.option("--session-id", type=str, default=None, help="provider session id")
@click.option("--input-tokens", type=int, default=None)
@click.option("--output-tokens", type=int, default=None)
@click.option("--cached-input-tokens", type=int, default=None)
@click.option("--reasoning-tokens", type=int, default=None)
@click.option("--usd", "cost_usd", type=float, default=None)
@click.option(
    "--source",
    type=str,
    default="codex_native_goal",
    help="source label for the usage observation",
)
@click.option(
    "--attribution",
    type=click.Choice(sorted(reporting.ATTRIBUTION_BY_NAME)),
    default="observed_window",
    help="cost/usage attribution level",
)
@click.option("--cwd", type=str, default=None, help="reported working directory")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@codex_command_context
def report_goal(
    ctx,
    work_id,
    title,
    goal_id,
    objective,
    status,
    tokens_used,
    time_used_seconds,
    run_id,
    provider,
    model,
    session_id,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    reasoning_tokens,
    cost_usd,
    source,
    attribution,
    cwd,
    as_json,
):
    from kungfu.work.store import WorkStore

    store = WorkStore(ctx.runtime_dir)
    created_work = False
    actual_work_id = work_id
    if actual_work_id:
        _require_work(ctx.runtime_dir, actual_work_id)
    else:
        actual_work_id = store.create(
            title or objective or f"Codex goal {goal_id}",
            "codex-goal",
            objective or f"Codex native goal {goal_id}",
        )
        created_work = True

    actual_run_id = run_id or reporting.new_run_id()
    command = f"codex native goal {goal_id}"
    manifest = reporting.begin_run(
        ctx.runtime_dir,
        run_id=actual_run_id,
        provider=provider,
        cwd=cwd or os.getcwd(),
        work_id=actual_work_id,
        command=command,
    )
    store.link_run(actual_work_id, actual_run_id)

    usage = {
        "schema": "kungfu.codex-goal-usage/v1",
        "goal_id": goal_id,
        "objective": objective,
        "status": status,
        "tokens_used": tokens_used,
        "time_used_seconds": time_used_seconds,
        "source": source,
        "attribution": attribution,
    }
    manifest = reporting.report_event(
        ctx.runtime_dir,
        run_id=actual_run_id,
        event_type="codex_goal_usage_observed",
        message=json.dumps(usage, sort_keys=True),
        severity="info" if status == "succeeded" else "warning",
    )

    cost_snapshot_written = any(
        value is not None
        for value in (
            input_tokens,
            output_tokens,
            cached_input_tokens,
            reasoning_tokens,
            cost_usd,
        )
    )
    if cost_snapshot_written:
        manifest = reporting.report_cost(
            ctx.runtime_dir,
            run_id=actual_run_id,
            work_id=actual_work_id,
            provider=provider,
            surface="codex_native_goal",
            model=model,
            session_id=session_id,
            source=source,
            attribution=attribution,
            input_tokens=input_tokens or 0,
            output_tokens=output_tokens or 0,
            cached_input_tokens=cached_input_tokens or 0,
            reasoning_tokens=reasoning_tokens or 0,
            cost_usd=cost_usd,
            raw_ref=goal_id,
        )

    exit_code = 0 if status == "succeeded" else 1
    manifest = reporting.end_run(
        ctx.runtime_dir, run_id=actual_run_id, status=status, exit_code=exit_code
    )

    receipt = {
        "schema": "kungfu.codex-goal-report/v1",
        "work_id": actual_work_id,
        "run_id": actual_run_id,
        "goal_id": goal_id,
        "objective": objective,
        "status": status,
        "tokens_used": tokens_used,
        "time_used_seconds": time_used_seconds,
        "provider": provider,
        "model": model,
        "session_id": session_id,
        "source": source,
        "attribution": attribution,
        "cost_snapshot_written": cost_snapshot_written,
        "cost_usd_known": cost_usd is not None,
        "runtime_dir": ctx.runtime_dir,
        "manifest": manifest,
    }
    receipt_path = _write_receipt(ctx.runtime_dir, actual_run_id, receipt)
    manifest = reporting.emit_manifest(
        ctx.runtime_dir,
        actual_run_id,
        extra={
            "codex_goal_receipt": {
                "path": "codex-goal-receipt.json",
                "goal_id": goal_id,
                "verified_by": "kungfu codex verify-goal-report",
            }
        },
    )
    receipt["manifest"] = manifest
    receipt["receipt"] = receipt_path
    _write_receipt(ctx.runtime_dir, actual_run_id, receipt)

    payload = dict(receipt)
    payload["created_work"] = created_work
    if as_json:
        _json(payload)
    else:
        click.echo(
            f"[codex] goal {goal_id} reported as run {actual_run_id}; "
            f"receipt: {receipt_path}"
        )


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

    try:
        item = _require_work(runtime_dir, work_id) if work_id else None
        if item and run_id:
            linked = any(row.get("run_id") == run_id for row in item.get("runs", []))
            if not linked:
                errors.append("work item does not link run_id")
    except SystemExit:
        errors.append(f"work item missing: {work_id}")

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
        sys.exit(1)
    if as_json:
        _json(payload)
    else:
        click.echo(f"[codex] verified goal report receipt: {receipt_path}")
