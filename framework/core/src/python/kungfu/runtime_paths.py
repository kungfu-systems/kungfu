# SPDX-License-Identifier: Apache-2.0

"""Canonical runtime and configuration paths shared by runtime owners."""

from __future__ import annotations

import os
from pathlib import Path


def canonical_path(value: str) -> str:
    return str(Path(value).expanduser().resolve())


def resolve_config_home(config_home: str | None = None) -> str:
    return canonical_path(
        config_home or os.environ.get("KF_CONFIG_HOME") or "~/.kungfu-config"
    )


def resolve_runtime_home(home: str) -> str:
    return canonical_path(home)


def resolve_runtime_dir(home: str, runtime_dir: str | None = None) -> str:
    return canonical_path(runtime_dir or str(Path(home).expanduser() / "runtime"))
