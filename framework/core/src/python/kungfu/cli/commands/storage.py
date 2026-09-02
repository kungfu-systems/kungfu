# SPDX-License-Identifier: Apache-2.0

import json
import sys
import tempfile
import click

from kungfu.cli.commands import PrioritizedCommandGroup, initialize_runtime_context, kfc
from kungfu.storage.cli_episode import (
    _run_episode_write,
    attach_frame,
    attach_payload,
    attach_ref,
    begin,
    episode,
    episode_abort,
    episode_end,
    episode_inspect,
    episode_list,
    episode_rebuild_projection,
    episode_recover,
    heartbeat,
)
from kungfu.cli.preflight import run_command_preflight  # noqa: F401
from kungfu.workspace import (
    WorkspaceTargetRequired,
    prepare_workspace_write,
    record_workspace_capture,
    resolve_workspace_target,
)

storage_command_context = kfc.pass_context()


def _echo_json(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def _require_source(source_id):
    if not source_id:
        click.echo("[storage] --source is required for --scope source", err=True)
        sys.exit(2)


def _range_filter(since, from_time, until):
    from kungfu.storage import build_range_filter

    try:
        return build_range_filter(since=since, from_time=from_time, until=until)
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)


def _source_for_scope(scope, storage_source_id):
    if scope == "source":
        _require_source(storage_source_id)
        return storage_source_id
    return None


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="inspect and maintain runtime fact storage",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def storage(ctx):
    if ctx.invoked_subcommand != "import":
        initialize_runtime_context(ctx)


@storage.group(
    name="backend", help="inspect or change the authoritative content provider"
)
@click.help_option("-h", "--help")
@storage_command_context
def backend(ctx):
    pass


@backend.command(name="status", help="show the authoritative provider binding")
@click.option(
    "--provider",
    type=click.Choice(["content-addressed-file", "rocksdb"]),
    default=None,
    help="assert that the configured provider matches authority",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def backend_status(ctx, provider, as_json):
    from kungfu.storage import service

    try:
        result = service.backend_status(ctx.runtime_dir, provider=provider)
    except (RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] authoritative provider: {result['provider']}")
    if result["binding"]:
        click.echo(f"[storage] generation: {result['binding']['generation']}")
    if result["migration"]:
        click.echo(f"[storage] migration phase: {result['migration']['phase']}")


@backend.command(
    name="switch", help="copy, verify, and atomically switch provider authority"
)
@click.option(
    "--to",
    "target_provider",
    type=click.Choice(["content-addressed-file", "rocksdb"]),
    required=True,
)
@click.option("--expected-generation", type=int, default=None)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def backend_switch(ctx, target_provider, expected_generation, as_json):
    from kungfu.storage import service

    try:
        result = service.backend_switch(
            ctx.runtime_dir,
            target_provider=target_provider,
            expected_generation=expected_generation,
        )
    except (RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] switched {result['source_provider']} -> "
        f"{result['target_provider']} at generation {result['target_generation']}"
    )


@backend.command(
    name="rollback", help="reverse-sync and atomically restore the retained provider"
)
@click.option("--expected-generation", type=int, default=None)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def backend_rollback(ctx, expected_generation, as_json):
    from kungfu.storage import service

    try:
        result = service.backend_rollback(
            ctx.runtime_dir, expected_generation=expected_generation
        )
    except (RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] rolled back {result['source_provider']} -> "
        f"{result['target_provider']} at generation {result['target_generation']}"
    )


@storage.command(
    name="durability-reconcile",
    help="reconcile a durability request against checkpoint-covered receipts",
)
@click.option("--data-root", type=click.Path(file_okay=False), required=True)
@click.option("--request-id", type=int, required=True)
@click.option("--stream-id", type=int, required=True)
@click.option("--container-epoch", type=int, required=True)
@click.option("--sequence", type=int, required=True)
@click.option("--frame-uid", type=int, required=True)
@click.option(
    "--requested-profile",
    type=click.Choice(["visible", "durable_group", "durable_sync", "replicated"]),
    required=True,
)
@click.option("--writer-resource-id", type=str, required=True)
@click.option("--qualification-profile", type=str, required=True)
@storage_command_context
def durability_reconcile(
    ctx,
    data_root,
    request_id,
    stream_id,
    container_epoch,
    sequence,
    frame_uid,
    requested_profile,
    writer_resource_id,
    qualification_profile,
):
    """Print the native reconciliation state without inferring an outcome."""

    from kungfu import durability

    _echo_json(
        durability.reconcile(
            data_root=data_root,
            request_id=request_id,
            stream_id=stream_id,
            container_epoch=container_epoch,
            sequence=sequence,
            frame_uid=frame_uid,
            requested_profile=requested_profile,
            writer_resource_id=writer_resource_id,
            qualification_profile=qualification_profile,
        )
    )


@storage.command(
    name="projection-candidate-status",
    help="inspect the default-off typed peer-bootstrap candidate",
)
@click.option("--data-root", type=click.Path(file_okay=False), required=True)
@click.option("--stream-id", type=int, required=True)
@click.option("--container-epoch", type=int, required=True)
@click.option("--writer-resource-id", type=str, required=True)
@click.option("--qualification-profile", type=str, required=True)
@click.option(
    "--projection-name", type=str, default="typed-peer-state", show_default=True
)
@click.option(
    "--requirement",
    type=click.Choice(["required", "optional", "none"]),
    default="required",
    show_default=True,
)
@storage_command_context
def projection_candidate_status(
    ctx,
    data_root,
    stream_id,
    container_epoch,
    writer_resource_id,
    qualification_profile,
    projection_name,
    requirement,
):
    """Print the native candidate status; production eligibility stays false."""

    from kungfu import projection

    _echo_json(
        projection.candidate_status(
            data_root=data_root,
            stream_id=stream_id,
            container_epoch=container_epoch,
            writer_resource_id=writer_resource_id,
            qualification_profile=qualification_profile,
            projection_name=projection_name,
            requirement=requirement,
        )
    )


@storage.command(help="show the resolved workspace Episode storage layout")
@click.option(
    "--provider", type=click.Choice(["content-addressed-file", "rocksdb"]), default=None
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@click.option(
    "--verify",
    is_flag=True,
    help="fail if an observed home path has no persistence declaration",
)
@storage_command_context
def layout(ctx, provider, as_json, verify):
    from kungfu.storage import service

    result = service.layout(
        ctx.runtime_dir,
        runtime_home=ctx.home,
        config_home=ctx.config_home,
        provider=provider,
    )
    if as_json:
        _echo_json(result)
        if verify and not result["coverage"]["complete"]:
            sys.exit(1)
        return
    click.echo(f"[storage] data home: {result['workspace_data_home']}")
    click.echo(f"[storage] runtime dir: {result['runtime_dir']}")
    click.echo(
        f"[storage] episode manifest: {result['paths']['episode_manifest_journal']}"
    )
    click.echo(f"[storage] provider: {result['provider']}")
    click.echo(
        "[storage] layout coverage: "
        + ("complete" if result["coverage"]["complete"] else "incomplete")
    )
    if verify and not result["coverage"]["complete"]:
        for path in result["coverage"]["unclassified_durable_candidates"]:
            click.echo(f"[storage] unclassified durable candidate: {path}", err=True)
        sys.exit(1)


@storage.command(help="summarize a storage scope")
@click.option("--scope", type=click.Choice(["source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def status(ctx, scope, storage_source_id, as_json):
    from kungfu.storage import service

    result = service.status(
        ctx.runtime_dir,
        source_id=storage_source_id if scope == "source" else None,
    )
    if as_json:
        _echo_json(result)
        return
    for key, value in result.items():
        click.echo(f"  {key}: {value}")


@storage.command(help="verify runtime storage integrity for a scope")
@click.option("--scope", type=click.Choice(["source", "episode", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--episode-id", type=int, default=0)
@click.option(
    "--verify-frames",
    is_flag=True,
    help="episode scope only: re-read claimed event journals and verify each "
    "attached frame receipt (presence, header, checksums)",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def fsck(ctx, scope, storage_source_id, episode_id, verify_frames, as_json):
    from kungfu.storage import service

    if scope == "episode" and not episode_id:
        click.echo("[storage] --episode-id is required for --scope episode", err=True)
        sys.exit(2)
    if verify_frames and scope != "episode":
        click.echo("[storage] --verify-frames requires --scope episode", err=True)
        sys.exit(2)
    result = service.fsck(
        ctx.runtime_dir,
        source_id=storage_source_id if scope == "source" else None,
        episode_id=episode_id if scope == "episode" else None,
        verify_frames=verify_frames,
    )
    if as_json:
        _echo_json(result)
    else:
        click.echo(f"[storage] {scope} fsck {'ok' if result['ok'] else 'failed'}")
        for error in result["errors"]:
            click.echo(f"  error: {error}", err=True)
        for warning in result["warnings"]:
            click.echo(f"  warning: {warning}", err=True)
    if not result["ok"]:
        sys.exit(1)


@storage.command(
    help="plan, fetch, or apply local repairs for degraded runtime storage"
)
@click.option("--scope", type=click.Choice(["source", "episode", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--episode-id", type=int, default=0)
@click.option("--plan", "plan_only", is_flag=True, help="emit a read-only repair plan")
@click.option(
    "--fetch",
    "fetch_requested",
    is_flag=True,
    help="collect local repair material from runtime mirrors",
)
@click.option(
    "--apply",
    "apply_requested",
    is_flag=True,
    help="validate or apply local repair material",
)
@click.option(
    "--from", "from_path", type=str, default=None, help="repair material JSON path"
)
@click.option(
    "--out",
    "out_path",
    type=str,
    default=None,
    help="write fetched repair material JSON",
)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="do not fetch, delete, compact, or mutate storage",
)
@click.option(
    "--execute", "execute", is_flag=True, help="write validated local repair material"
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def repair(
    ctx,
    scope,
    storage_source_id,
    episode_id,
    plan_only,
    fetch_requested,
    apply_requested,
    from_path,
    out_path,
    dry_run,
    execute,
    as_json,
):
    from kungfu.storage import service

    selected = sum(1 for item in (plan_only, fetch_requested, apply_requested) if item)
    if selected > 1:
        click.echo("[storage] choose only one of --plan, --fetch, or --apply", err=True)
        sys.exit(2)
    if selected == 0:
        click.echo("[storage] repair v1 requires --plan, --fetch, or --apply", err=True)
        sys.exit(2)
    if scope == "source":
        _require_source(storage_source_id)
    if scope == "episode" and not episode_id:
        click.echo("[storage] --episode-id is required for --scope episode", err=True)
        sys.exit(2)
    if plan_only:
        if not dry_run:
            click.echo("[storage] repair plan requires --dry-run", err=True)
            sys.exit(2)
        result = service.repair_plan(
            ctx.runtime_dir,
            source_id=storage_source_id if scope == "source" else None,
            episode_id=episode_id if scope == "episode" else None,
            dry_run=True,
        )
    elif fetch_requested:
        if execute:
            click.echo(
                "[storage] repair fetch is read-only; --execute is not supported",
                err=True,
            )
            sys.exit(2)
        if not dry_run:
            click.echo("[storage] repair fetch requires --dry-run", err=True)
            sys.exit(2)
        result = service.repair_fetch(
            ctx.runtime_dir,
            source_id=storage_source_id if scope == "source" else None,
            episode_id=episode_id if scope == "episode" else None,
            out_path=out_path,
            dry_run=True,
        )
    else:
        if not from_path:
            click.echo("[storage] repair apply requires --from <json>", err=True)
            sys.exit(2)
        if dry_run and execute:
            click.echo("[storage] choose either --dry-run or --execute", err=True)
            sys.exit(2)
        try:
            with open(from_path, encoding="utf-8") as f:
                repair_input = json.load(f)
        except (OSError, ValueError) as e:
            click.echo(f"[storage] {e}", err=True)
            sys.exit(1)
        result = service.repair_apply(
            ctx.runtime_dir,
            repair_input,
            source_id=storage_source_id if scope == "source" else None,
            episode_id=episode_id if scope == "episode" else None,
            dry_run=not execute,
        )
    if as_json:
        _echo_json(result)
        return
    if plan_only:
        click.echo(
            f"[storage] repair plan {scope}: "
            f"{result.get('candidate_count', 0)} candidates, status={result.get('status')}"
        )
        for candidate in result.get("candidates", []):
            click.echo(
                "  candidate: "
                f"{candidate.get('code')} -> {candidate.get('suggested_action')}"
            )
    elif fetch_requested:
        out = result.get("artifact_uri") or "<memory>"
        click.echo(
            f"[storage] repair fetch {scope}: "
            f"matched={result.get('matched_count', 0)} "
            f"missing={result.get('missing_count', 0)} out={out}"
        )
    else:
        click.echo(
            f"[storage] repair apply {scope}: "
            f"applied={result.get('applied_count', 0)} "
            f"skipped={result.get('skipped_count', 0)} "
            f"rejected={result.get('rejected_count', 0)} "
            f"status={result.get('status')}"
        )
    if not result["ok"]:
        sys.exit(1)


@storage.command(help="export a storage scope")
@click.option("--scope", type=click.Choice(["source", "episode"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--episode-id", type=int, default=0)
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option(
    "--format",
    "format_",
    type=click.Choice(["jsonl", "bundle-json"]),
    default="jsonl",
    help="export format; bundle-json is available for --scope source",
)
@click.option(
    "--thin",
    "thin",
    is_flag=True,
    help="episode scope only: receipt-only bundle without owned frame and "
    "payload bytes",
)
@click.option("--out", "out_path", type=str, required=True, help="output path")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def export(
    ctx,
    scope,
    storage_source_id,
    episode_id,
    since,
    from_time,
    until,
    format_,
    thin,
    out_path,
    as_json,
):
    if scope == "episode" and format_ != "bundle-json":
        click.echo(
            "[storage] --scope episode supports only --format bundle-json", err=True
        )
        sys.exit(1)
    try:
        from kungfu.storage import service

        if scope == "episode":
            if not episode_id:
                click.echo(
                    "[storage] --episode-id is required for --scope episode",
                    err=True,
                )
                sys.exit(2)
            result = service.export_bundle_json(
                ctx.runtime_dir,
                out_path,
                episode_id=episode_id,
                range_filter=_range_filter(since, from_time, until),
                thin=thin,
            )
        elif format_ == "bundle-json":
            _require_source(storage_source_id)
            result = service.export_bundle_json(
                ctx.runtime_dir,
                out_path,
                source_id=storage_source_id,
                range_filter=_range_filter(since, from_time, until),
            )
        else:
            _require_source(storage_source_id)
            result = service.export_jsonl(
                ctx.runtime_dir,
                out_path,
                source_id=storage_source_id,
                range_filter=_range_filter(since, from_time, until),
            )
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    click.echo(f"[storage] exported {result['records']} {scope} records to {out_path}")


@storage.command(name="import", help="import a manifest-backed storage bundle")
@click.option("--from", "from_path", type=str, required=True, help="bundle JSON path")
@click.option(
    "--no-verify", "no_verify", is_flag=True, help="skip manifest verification"
)
@click.option(
    "--execute",
    "execute",
    is_flag=True,
    help="episode bundles only: materialize owned frames and payloads, then "
    "replay manifest records; default validates without writing",
)
@click.option(
    "--workspace",
    "workspace_root",
    type=click.Path(file_okay=False),
    default=None,
    help="explicit project workspace root for an executed Episode import",
)
@click.option(
    "--home-workspace",
    is_flag=True,
    help="explicitly execute the Episode import in the Home Workspace",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def import_cmd(
    ctx,
    from_path,
    no_verify,
    execute,
    workspace_root,
    home_workspace,
    as_json,
):
    from kungfu.storage import service

    try:
        with open(from_path, encoding="utf-8") as f:
            bundle = json.load(f)
        episode_bundle = bundle.get("schema") == "kungfu.storage.episode-bundle/v1"
        if execute and not episode_bundle:
            click.echo("[storage] --execute applies to episode bundles only", err=True)
            sys.exit(1)
        workspace_receipt = None
        if execute:
            with tempfile.TemporaryDirectory(prefix="kungfu-episode-validate-") as root:
                validation = service.import_bundle(
                    root,
                    bundle,
                    verify=not no_verify,
                    execute=False,
                )
            if not validation.get("ok"):
                result = validation
                if as_json:
                    _echo_json(result)
                    return
                click.echo(
                    f"[storage] episode {result.get('episode_id')} import failed: "
                    f"{result.get('status', 'invalid')}"
                )
                sys.exit(1)
            target = resolve_workspace_target(
                "capture-only",
                workspace_root,
                home=home_workspace,
            )
            workspace_receipt = prepare_workspace_write(target, "episode-import")
            result = service.import_bundle(
                target.runtime_dir,
                bundle,
                verify=not no_verify,
                execute=True,
            )
            workspace_receipt = record_workspace_capture(
                target,
                workspace_receipt,
                [{"kind": "episode", "id": str(result.get("episode_id"))}],
            )
            result["workspace"] = workspace_receipt
        else:
            with tempfile.TemporaryDirectory(prefix="kungfu-episode-validate-") as root:
                result = service.import_bundle(
                    root,
                    bundle,
                    verify=not no_verify,
                    execute=False,
                )
    except WorkspaceTargetRequired as e:
        if as_json:
            _echo_json(e.diagnosis)
            raise click.exceptions.Exit(2) from e
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)
    except (OSError, ValueError) as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
        return
    if episode_bundle:
        status = result.get("status", "unknown")
        click.echo(
            f"[storage] episode {result.get('episode_id')} import "
            f"{'ok' if result.get('ok') else 'failed'}: {status}"
        )
        if not result.get("ok"):
            sys.exit(1)
        return
    click.echo(
        f"[storage] imported {result['records']} records for {result['source_id']}"
    )


@storage.command(name="rebuild-index", help="rebuild derived storage indexes")
@click.option("--scope", type=click.Choice(["source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="show registry changes without writing the derived index",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def rebuild_index(ctx, scope, storage_source_id, dry_run, as_json):
    from kungfu.storage import service

    result = service.rebuild_index(
        ctx.runtime_dir,
        source_id=_source_for_scope(scope, storage_source_id),
        dry_run=dry_run,
    )
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] rebuild-index {scope}: "
        f"{'would write' if result.get('would_write') else 'up to date'}"
    )
    for error in result.get("errors", []):
        click.echo(f"  error: {error}", err=True)
    if not result["ok"]:
        sys.exit(1)


@storage.command(help="query the rebuildable SQLite storage projection")
@click.option(
    "--table",
    "query_table",
    type=click.Choice(
        [
            "sources",
            "manifests",
            "entries",
            "episodes",
            "episode_records",
            "episode_frames",
            "episode_refs",
        ]
    ),
    default="entries",
    show_default=True,
)
@click.option("--scope", type=click.Choice(["source", "episode", "all"]), default="all")
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option("--episode-id", type=int, default=0)
@click.option("--kind", type=str, default=None, help="filter entry rows by kind")
@click.option("--since", type=str, default=None, help="relative window such as 3d/12h")
@click.option(
    "--from", "from_time", type=str, default=None, help="inclusive start time"
)
@click.option("--until", type=str, default=None, help="inclusive end time")
@click.option("--limit", type=click.IntRange(min=0), default=100, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def query(
    ctx,
    query_table,
    scope,
    storage_source_id,
    episode_id,
    kind,
    since,
    from_time,
    until,
    limit,
    as_json,
):
    from kungfu.storage import service

    if scope == "source":
        _require_source(storage_source_id)
    if scope == "episode" and query_table != "episodes" and not episode_id:
        click.echo(
            f"[storage] --episode-id is required for --table {query_table}",
            err=True,
        )
        sys.exit(2)
    result = service.query_projection(
        ctx.runtime_dir,
        query=query_table,
        source_id=storage_source_id if scope == "source" else None,
        episode_id=episode_id if scope == "episode" else None,
        kind=kind,
        range_filter=_range_filter(since, from_time, until),
        limit=limit,
    )
    if as_json:
        _echo_json(result)
        return
    if not result["ok"]:
        for error in result.get("errors", []):
            click.echo(f"  error: {error}", err=True)
        sys.exit(1)
    click.echo(
        f"[storage] query {query_table}: {result['row_count']} rows "
        f"from {result['projection']['path']}"
    )
    for row in result["rows"]:
        click.echo(json.dumps(row, sort_keys=True))


storage.add_command(episode)

for _episode_command in (
    episode,
    begin,
    heartbeat,
    attach_frame,
    attach_ref,
    attach_payload,
    episode_end,
    episode_abort,
    episode_recover,
    episode_list,
    episode_inspect,
    episode_rebuild_projection,
):
    _episode_command.callback.__module__ = __name__
_run_episode_write.__module__ = __name__
del _episode_command


@storage.command(help="plan unreachable payload garbage collection")
@click.option("--scope", type=click.Choice(["source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="required; no payloads are deleted",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def gc(ctx, scope, storage_source_id, dry_run, as_json):
    from kungfu.storage import service

    if not dry_run:
        click.echo("[storage] gc requires --dry-run in this release", err=True)
        sys.exit(2)
    try:
        result = service.gc_plan(
            ctx.runtime_dir,
            source_id=_source_for_scope(scope, storage_source_id),
            dry_run=True,
        )
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] gc dry-run {scope}: {result['candidate_count']} candidates, "
        f"{result['candidate_bytes']} bytes"
    )


@storage.command(help="plan fact-ledger compaction without rewriting storage")
@click.option("--scope", type=click.Choice(["source", "all"]), required=True)
@click.option("--source", "storage_source_id", type=str, default=None)
@click.option(
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="required; no storage files are rewritten",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def compact(ctx, scope, storage_source_id, dry_run, as_json):
    from kungfu.storage import service

    if not dry_run:
        click.echo("[storage] compact requires --dry-run in this release", err=True)
        sys.exit(2)
    try:
        result = service.compact_plan(
            ctx.runtime_dir,
            source_id=_source_for_scope(scope, storage_source_id),
            dry_run=True,
        )
    except ValueError as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(2)
    if as_json:
        _echo_json(result)
        return
    click.echo(
        f"[storage] compact dry-run {scope}: "
        f"{len(result['retained_manifests'])} retained manifests, "
        f"{result['gc']['candidate_count']} gc candidates"
    )
    if not result["ok"]:
        sys.exit(1)


@storage.command(name="verify-sync", help="simulate local bundle export/import/fsck")
@click.option("--source", "storage_source_id", type=str, required=True)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@storage_command_context
def verify_sync(ctx, storage_source_id, as_json):
    from kungfu.storage import service

    try:
        result = service.verify_local_sync(ctx.runtime_dir, source_id=storage_source_id)
    except (FileNotFoundError, ValueError) as e:
        click.echo(f"[storage] {e}", err=True)
        sys.exit(1)
    if as_json:
        _echo_json(result)
    else:
        click.echo(
            f"[storage] verify-sync {storage_source_id} "
            f"{'ok' if result['ok'] else 'failed'}"
        )
    if not result["ok"]:
        sys.exit(1)
