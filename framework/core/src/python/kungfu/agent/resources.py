# SPDX-License-Identifier: Apache-2.0

import json
import sys
from importlib import resources
from pathlib import Path

from kungfu import host

_PACKAGE = "kungfu.agent"


def pack_root():
    shipped = _shipped_pack_root()
    if shipped is not None:
        return shipped
    return resources.files(_PACKAGE)


def _shipped_pack_root():
    # A product build ships the pack at the dist root; argv0 stays as a
    # fallback for entries relocated next to the pack (app Resources).
    candidates = []
    root = host.product_root()
    if root is not None:
        candidates.append(root / "agent")
    argv0 = sys.argv[0] if sys.argv else ""
    if argv0:
        candidates.append(Path(argv0).resolve().parent / "agent")
    for candidate in candidates:
        if (candidate / "index.json").is_file():
            return candidate
    return None


def _read_json(name):
    return json.loads((pack_root() / name).read_text(encoding="utf-8"))


def index():
    return _read_json("index.json")


def commands():
    return _read_json("commands.json")


def registry():
    return _read_json("kfd3_api.registry.json")


def registry_schema():
    return _read_json("kfd3_api.schema.json")


def profile_sdk_contract():
    return _read_json("profile-sdk.contract.json")


def document_text(name):
    return (pack_root() / name).read_text(encoding="utf-8")


def skill_path(target):
    return pack_root() / "skills" / target / "SKILL.md"


def choose_mode(
    *,
    command=None,
    needs_supervision=False,
    has_existing_run=False,
    needs_structured_work=False,
    needs_atlas_projection=False,
    remote_runtime=False,
):
    if remote_runtime:
        mode = "remote-sync"
        reason = "Remote/runtime boundary is the primary constraint."
    elif needs_atlas_projection:
        mode = "atlas-projection"
        reason = (
            "An Atlas-style control-plane repo should be imported as a local "
            "read-only projection."
        )
    elif has_existing_run or command:
        mode = "trace"
        reason = "There is an existing command or run to capture without rewriting it."
    elif needs_supervision:
        mode = "managed-run"
        reason = (
            "A provider CLI should run under Kungfu supervision and cost/audit capture."
        )
    elif needs_structured_work:
        mode = "report"
        reason = "The task mainly needs structured work facts rather than a captured process."
    else:
        mode = "brief"
        reason = "No runtime action is required; read the local pack first."
    return {
        "schema": "kungfu.agent-mode-choice/v1",
        "mode": mode,
        "reason": reason,
        "command": command,
        "maturity": commands()["modes"][mode]["maturity"],
        "next": commands()["modes"][mode]["next"],
    }
