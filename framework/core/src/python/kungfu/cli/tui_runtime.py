#  SPDX-License-Identifier: Apache-2.0

# The reference TUI (Ink) runs through kungfu's own embedded Node runtime
# (libnode), the same bridge `kungfu sdk` uses — no separate node install. The
# TUI bundle is shipped next to the runtime (packaged app: Resources/tui/tui.mjs)
# and loads the kungfu_node binding at runtime from KUNGFU_DIR.
#
# This module deliberately lives outside cli.commands: interactive bare
# `kungfu` is the sole terminal-product entry and there is no `kungfu tui`
# command, alias, or compatibility shim.

import os
import sys

import click

import kungfu
from kungfu.skill import build_skill_runtime_audit, write_skill_runtime_audit


def _resolve_tui_entry():
    override = os.environ.get("KUNGFU_TUI_ENTRY")
    if override and os.path.exists(override):
        return os.path.abspath(override)
    # Packaged app: the assembled runtime is Resources/kungfu; the TUI bundle is
    # shipped as a sibling Resources/tui/tui.mjs.
    binding_dir = os.path.dirname(kungfu.__binding__.__file__)
    candidates = [
        os.path.join(binding_dir, "..", "tui", "tui.mjs"),
        os.path.join(binding_dir, "tui.mjs"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return None


def _configure_tui_environment(binding_file, runtime_dir):
    os.environ["KUNGFU_AS_VARIANT"] = "node"
    os.environ.setdefault("KUNGFU_DIR", os.path.dirname(binding_file))
    os.environ.setdefault(
        "KF_BUNDLED_EXTENSION_ROOT",
        os.path.abspath(os.path.join(os.environ["KUNGFU_DIR"], "..", "extensions")),
    )
    os.environ.setdefault(
        "KUNGFU_KFX_CONTRACT",
        os.path.join(os.environ["KUNGFU_DIR"], "config", "kungfu-kfx.contract.json"),
    )
    os.environ.setdefault("KF_RUNTIME_DIR", runtime_dir)


def _configure_tui_skill_runtime_audit(home, runtime_dir):
    output = os.path.join(runtime_dir, "skill-manager", "tui-runtime-audit.json")
    document = build_skill_runtime_audit(home)
    write_skill_runtime_audit(output, document)
    os.environ["KF_SKILL_RUNTIME_AUDIT_FILE"] = output
    return output


def run_tui(ctx, commands=()):
    """Launch the shipped TUI without creating a second command authority."""

    _configure_tui_environment(kungfu.__binding__.__file__, ctx.runtime_dir)
    _configure_tui_skill_runtime_audit(ctx.home, ctx.runtime_dir)
    entry = _resolve_tui_entry()
    if not entry:
        raise click.ClickException(
            "kungfu TUI bundle not found; the packaged app ships it under "
            "Resources/tui, or set KUNGFU_TUI_ENTRY to a built tui.mjs"
        )
    argv = [sys.argv[0], entry, *commands]
    return kungfu.__binding__.libnode.run(*argv)
