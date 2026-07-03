#  SPDX-License-Identifier: Apache-2.0

import click
import os
import sys

from kungfu.console.commands import kfc, PrioritizedCommandGroup

rewind_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=3,
    help="re-open recorded runs: forensic replay over the trace journal",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def rewind(ctx):
    pass


@rewind.command(help="reconstruct a run's causal tree from its journal")
@click.option("--run", "run_id", type=str, required=True, help="run id")
@rewind_command_context
def show(ctx, run_id):
    from kungfu.rewind import replay

    click.echo(replay.render_tree(ctx.runtime_dir, run_id))


@rewind.command(
    help="prove the record self-describes: diff the native decode against "
    "the bundle's reflection decode (no generated event code)"
)
@click.option("--run", "run_id", type=str, required=True, help="run id")
@click.option(
    "--bundle",
    "bundle_dir",
    type=str,
    default=None,
    help="bundle directory; defaults to the run's own bundle",
)
@rewind_command_context
def verify(ctx, run_id, bundle_dir):
    from kungfu.rewind import replay

    bundle_dir = bundle_dir or os.path.join(ctx.runtime_dir, "rewind", run_id, "bundle")
    try:
        frame_count, differences = replay.verify(ctx.runtime_dir, run_id, bundle_dir)
    except (ValueError, KeyError, FileNotFoundError) as e:
        click.echo(f"[rewind] verify failed: {e}", err=True)
        sys.exit(1)
    if differences:
        click.echo(
            f"[rewind] verify FAILED: {len(differences)} difference(s) over "
            f"{frame_count} frames",
            err=True,
        )
        for line in differences:
            click.echo(f"  {line}", err=True)
        sys.exit(1)
    click.echo(
        f"[rewind] verify passed: {frame_count} frames decode identically through "
        f"the native path and the bundle's reflection path"
    )


@rewind.command(
    name="export",
    help="pack a run (journal + self-describing bundle) into one portable "
    "file — offline, share it, open it anywhere",
)
@click.option("--run", "run_id", type=str, required=True, help="run id")
@click.option("-o", "--out", "out_path", type=str, default=None, help="output file")
@rewind_command_context
def export_cmd(ctx, run_id, out_path):
    from kungfu.rewind import export

    try:
        path = export.export_run(ctx.runtime_dir, run_id, out_path)
    except (FileNotFoundError, ValueError) as e:
        click.echo(f"[rewind] export failed: {e}", err=True)
        sys.exit(1)
    click.echo(f"[rewind] exported run {run_id} to {os.path.abspath(path)}")


@rewind.command(
    name="open",
    help="open an exported run: extract it, verify the record self-describes, "
    "and print the causal tree",
)
@click.argument("archive", type=str)
@click.option(
    "--dir",
    "target_dir",
    type=str,
    default=None,
    help="extract here (defaults to a fresh directory next to the archive)",
)
@rewind_command_context
def open_cmd(ctx, archive, target_dir):
    from kungfu.rewind import export, replay

    target_dir = target_dir or (os.path.abspath(archive) + ".opened")
    os.makedirs(target_dir, exist_ok=True)
    try:
        run_id, runtime_dir = export.open_export(archive, target_dir)
        bundle_dir = os.path.join(runtime_dir, "rewind", run_id, "bundle")
        frame_count, differences = replay.verify(runtime_dir, run_id, bundle_dir)
    except (ValueError, KeyError, FileNotFoundError) as e:
        click.echo(f"[rewind] open failed: {e}", err=True)
        sys.exit(1)
    if differences:
        click.echo(
            f"[rewind] open: record verification FAILED "
            f"({len(differences)} difference(s))",
            err=True,
        )
        sys.exit(1)
    click.echo(
        f"[rewind] opened run {run_id} at {runtime_dir} — {frame_count} frames verified"
    )
    click.echo(replay.render_tree(runtime_dir, run_id))
    click.echo(
        f"[rewind] inspect further: kungfu -H {os.path.dirname(runtime_dir)} "
        f"rewind show --run {run_id}"
    )
