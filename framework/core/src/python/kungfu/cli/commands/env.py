#  SPDX-License-Identifier: Apache-2.0

import os
import subprocess
import sys
from pathlib import Path

import click

from kungfu import host
from kungfu.cli.commands import kfc


def _resolve_trunk() -> str | None:
    """Locate the kungfu-trunk binary that owns the env semantics.

    Resolution order: explicit override, then the product layout (trunk ships
    at the dist root, next to the product entry), then the dev build under
    crates/target. Deliberately no PATH probing — the env surface must be the
    product's own trunk, not a foreign binary that happens to share the name.
    """
    exe = "kungfu-trunk.exe" if os.name == "nt" else "kungfu-trunk"
    override = os.environ.get("KUNGFU_TRUNK_BIN")
    if override:
        return override if Path(override).is_file() else None
    root = host.product_root()
    if root is not None:
        product = root / exe
        if product.is_file():
            return str(product)
    for parent in Path(__file__).resolve().parents:
        if (parent / "crates").is_dir():
            for profile in ("release", "debug"):
                dev = parent / "crates" / "target" / profile / exe
                if dev.is_file():
                    return str(dev)
            break
    return None


@kfc.command(
    help_priority=2,
    context_settings=dict(ignore_unknown_options=True, help_option_names=[]),
    help="manage python envs derived from the kungfu runtime (uv underneath)",
)
@click.argument("commands", nargs=-1, type=click.UNPROCESSED)
def env(commands):
    """Forward the env subtree to kungfu-trunk untouched.

    The trunk implements the env semantics, so the trunk parses the env
    arguments (including -h/--help); this wrapper only routes. Layering per
    ADR-0046: whoever implements the semantics parses the arguments.
    """
    trunk = _resolve_trunk()
    if not trunk:
        raise click.ClickException(
            "kungfu-trunk not found next to the kungfu binary; the install "
            "surface ships with the product dist (dev: cargo build --release "
            "-p kungfu-trunk, or set KUNGFU_TRUNK_BIN)"
        )
    argv = [trunk, "env", *commands]
    if os.name == "nt":
        sys.exit(subprocess.run(argv).returncode)
    os.execv(trunk, argv)
