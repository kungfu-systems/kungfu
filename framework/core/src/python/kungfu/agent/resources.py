# SPDX-License-Identifier: Apache-2.0

import json
from importlib import resources

_PACKAGE = "kungfu.agent"


def pack_root():
    return resources.files(_PACKAGE)


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
    remote_runtime=False,
):
    if remote_runtime:
        mode = "remote-sync"
        reason = "Remote/runtime boundary is the primary constraint."
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
