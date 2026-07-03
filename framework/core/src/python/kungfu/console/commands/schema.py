#  SPDX-License-Identifier: Apache-2.0

import click
import sys

import kungfu

from kungfu.console.commands import kfc, PrioritizedCommandGroup


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=4,
    help="compile kfx FlatBuffers schemas into open-layer .bfbs (in-process, no flatc)",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def schema(ctx):
    pass


@schema.command(
    name="compile",
    help="compile a .fbs text schema to a .bfbs reflection binary in-process",
)
@click.argument("fbs_path", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--out", "out_path", default=None, help="output .bfbs path; default alongside the input")
@click.option("--sandboxed", is_flag=True, help="apply the untrusted-kfx compilation bounds")
@kfc.pass_context()
def compile_cmd(ctx, fbs_path, out_path, sandboxed):
    with open(fbs_path, "r", encoding="utf-8") as f:
        fbs_text = f.read()

    bfbs, error = kungfu.__binding__.yijinjing.compile_schema(fbs_text, sandboxed)
    if error:
        click.echo(f"[schema] compile failed: {error}", err=True)
        sys.exit(1)

    out = out_path or (fbs_path.rsplit(".", 1)[0] + ".bfbs")
    with open(out, "wb") as f:
        f.write(bfbs)
    click.echo(f"[schema] compiled {fbs_path} -> {out} ({len(bfbs)} bytes)")
