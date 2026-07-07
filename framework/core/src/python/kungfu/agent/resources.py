# SPDX-License-Identifier: Apache-2.0

import json
import sys
from importlib import resources
from pathlib import Path

_PACKAGE = "kungfu.agent"


def pack_root():
    frozen = _frozen_pack_root()
    if frozen is not None:
        return frozen
    return resources.files(_PACKAGE)


def _frozen_pack_root():
    candidates = []
    executable = getattr(sys, "executable", "")
    if executable:
        candidates.append(Path(executable).resolve().parent / "agent")
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
