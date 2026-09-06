#  SPDX-License-Identifier: Apache-2.0
"""The host-neutral seam (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2).

The supported host forms are source and assembled. Code that needs "where is
the product root" or "how does a child re-enter kungfu" must ask this module
instead of deriving it from sys.executable, which points somewhere different
in each:

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
the self-re-entry family (runtime_service.entry_command, the nuitka/pdm
bridges' [sys.executable, -m, kungfu] calls) is correct by construction
wherever sys.executable is a real interpreter and re-routes through
entry_command() where it is not; the product-root family (contract
registry/artifact discovery, bundled assembly metadata, the trunk
binary next to the entry, variants dist-module detection) resolves through
product_root(); the argv0 family that only names a process for libnode
(tui/sdk/kfd) keeps argv0 semantics untouched. Signal handlers
(runtime_service SIGTERM/SIGINT, peer os_signal) and the vendored
site.py atexit hook stay as they are: in stage 2 CPython still owns the
process main thread; the forwarding seam is stage 3 work.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

FORM_ASSEMBLED = "assembled"
FORM_SOURCE = "source"

_MARKER_NAME = "kungfu-host.json"
_MARKER_SCHEMA = "kungfu.host/v1"
_NODE_PACKAGE_BASE = Path(__file__).resolve().parent


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
    if _assembled_marker() is not None:
        return FORM_ASSEMBLED
    return FORM_SOURCE


def product_root() -> Path | None:
    """The dist root (the directory the product image unpacks to) in product
    forms; None in a source checkout, where callers use their source scans."""
    marker = _assembled_marker()
    if marker is not None:
        rel = str(marker.get("product_root", ".."))
        return (Path(sys.base_prefix) / rel).resolve()
    return None


def entry_command() -> list[str]:
    """The command a child process uses to re-enter kungfu.

    Prefer the invoked Rust trunk entry in the assembled form when it is a real
    executable; otherwise re-enter through the running interpreter.
    """
    argv0 = Path(sys.argv[0]) if sys.argv and sys.argv[0] else None
    if (
        host_form() != FORM_SOURCE
        and argv0 is not None
        and argv0.is_file()
        and os.access(argv0, os.X_OK)
        and argv0.suffix != ".py"
        and not argv0.name.startswith("python")
    ):
        return [str(argv0.resolve())]
    return [sys.executable, "-m", "kungfu"]


def node_package_entry(specifier: str, base: Path = _NODE_PACKAGE_BASE) -> str | None:
    """Resolve a source-host Node entry using the installed package's exports."""
    try:
        return subprocess.check_output(
            ["node", "--print", "require.resolve(process.argv[1])", specifier],
            cwd=base,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
        ).removesuffix("\n")
    except (OSError, subprocess.SubprocessError):
        return None
