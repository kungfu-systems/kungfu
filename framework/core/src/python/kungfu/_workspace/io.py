# SPDX-License-Identifier: Apache-2.0

"""Own shared machine-local path and atomic I/O services for workspaces."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Mapping, Protocol

from kungfu.canonical_json import WORKSPACE_CANONICAL_JSON_V1, canonical_json_text
from kungfu.config import load_contract as load_config_contract


class WorkspaceAvailabilityView(Protocol):
    workspace_kind: str
    workspace_root: str | None
    data_home: str


def _canonical_json(value: Any) -> str:
    return canonical_json_text(value, protocol=WORKSPACE_CANONICAL_JSON_V1)


def _semantic_root(value: Any) -> str:
    digest = hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _canonical_path(value: str) -> str:
    return os.path.realpath(os.path.abspath(os.path.expanduser(value)))


def _workspace_config_home(env: Mapping[str, str] | None = None) -> str:
    """Resolve config Home against the supplied environment mapping.

    ``os.path.expanduser`` only observes the process environment. Workspace
    APIs deliberately accept isolated environment mappings, so a contract
    default beginning with ``~`` must instead use that mapping's ``HOME``.
    """

    process_environment = env is None
    env = os.environ if env is None else env
    resolution = load_config_contract(env=env)["resolution"]
    config_home_env = str(resolution["configHomeEnv"])
    configured_value = env.get(config_home_env)
    if (
        process_environment
        and not configured_value
        and os.environ.get("PYTEST_CURRENT_TEST")
    ):
        configured_value = os.environ.get("KF_PYTEST_CONFIG_HOME") or os.path.join(
            tempfile.gettempdir(),
            f"kungfu-pytest-config-{os.getpid()}",
        )
    configured = str(configured_value or resolution["defaultConfigHome"])
    mapped_home = env.get("HOME")
    if mapped_home and (configured == "~" or configured.startswith("~/")):
        configured = (
            os.path.join(mapped_home, configured[2:])
            if configured != "~"
            else mapped_home
        )
    else:
        configured = os.path.expanduser(configured)
    return _canonical_path(configured)


def _workspace_available(identity: WorkspaceAvailabilityView) -> bool:
    if identity.workspace_kind == "project":
        return bool(identity.workspace_root and os.path.isdir(identity.workspace_root))
    return os.path.isdir(os.path.dirname(identity.data_home))


def _write_json_atomic(path: str, payload: dict[str, Any]) -> None:
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".workspaces-", suffix=".json", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
