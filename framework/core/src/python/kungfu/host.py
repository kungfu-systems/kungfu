#  SPDX-License-Identifier: Apache-2.0
"""The host-neutral seam (ADR-0046 stage 2).

The product has three host forms, and code that needs "where is the product
root" or "how does a child re-enter kungfu" must ask this module instead of
deriving it from sys.executable, which points somewhere different in each:

- frozen    — a Nuitka/PyInstaller binary; sys.executable is the product
              entry itself, sitting at the dist root.
- assembled — the shipped python-build-standalone tree; sys.executable is
              a real interpreter deep inside <dist>/python/bin, and the
              dist root is where the tree's marker says it is.
- source    — a dev checkout on a managed interpreter; there is no product
              root, and each site falls back to its source-checkout scan.

The assembled form is declared by a marker the assembly step writes at the
tree prefix (next to python-build-standalone's own BUILD file):

    <prefix>/kungfu-host.json
    {"schema": "kungfu.host/v1", "form": "assembled", "product_root": ".."}

Inventory of host assumptions this seam collects (spike report Part 3.3):
the self-re-entry family (master_service.entry_command, the nuitka/pdm
bridges' [sys.executable, -m, kungfu] calls) is correct by construction
wherever sys.executable is a real interpreter and re-routes through
entry_command() where it is not; the product-root family (contract
registry/artifact discovery, the baked first-party manifest, the trunk
binary next to the entry, variants dist-module detection) resolves through
product_root(); the argv0 family that only names a process for libnode
(cockpit/sdk/kfd) keeps argv0 semantics untouched. Signal handlers
(master_service SIGTERM/SIGINT, apprentice os_signal) and the vendored
site.py atexit hook stay as they are: in stage 2 CPython still owns the
process main thread; the forwarding seam is stage 3 work.
"""

import json
import os
import sys
from pathlib import Path

FORM_FROZEN = "frozen"
FORM_ASSEMBLED = "assembled"
FORM_SOURCE = "source"

_MARKER_NAME = "kungfu-host.json"
_MARKER_SCHEMA = "kungfu.host/v1"


def is_frozen() -> bool:
    # Nuitka injects __compiled__ into every compiled module's globals;
    # PyInstaller sets sys.frozen. Same judgment the wrong-runtime guard uses.
    return "__compiled__" in globals() or bool(getattr(sys, "frozen", False))


def _assembled_marker() -> dict | None:
    marker = Path(sys.base_prefix) / _MARKER_NAME
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("schema") != _MARKER_SCHEMA:
        return None
    return data


def host_form() -> str:
    if is_frozen():
        return FORM_FROZEN
    if _assembled_marker() is not None:
        return FORM_ASSEMBLED
    return FORM_SOURCE


def product_root() -> Path | None:
    """The dist root (the directory the product image unpacks to) in product
    forms; None in a source checkout, where callers use their source scans."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    marker = _assembled_marker()
    if marker is not None:
        rel = str(marker.get("product_root", ".."))
        return (Path(sys.base_prefix) / rel).resolve()
    return None


def entry_command() -> list[str]:
    """The command a child process uses to re-enter kungfu.

    Prefer the invoked entry (the frozen binary, or the launch shim in the
    assembled form) when it is a real executable; otherwise re-enter through
    the running interpreter, which is a real python everywhere outside the
    frozen form.
    """
    argv0 = Path(sys.argv[0]) if sys.argv and sys.argv[0] else None
    if (
        argv0 is not None
        and argv0.is_file()
        and os.access(argv0, os.X_OK)
        and argv0.suffix != ".py"
        and not argv0.name.startswith("python")
    ):
        return [str(argv0.resolve())]
    return [sys.executable, "-m", "kungfu"]
