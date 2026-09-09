# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

from datetime import UTC, datetime
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

from click.testing import CliRunner

from kungfu import (
    assignment_close,
    assignment_evidence,
    assignment_review_lifecycle,
    work_authority,
)
from kungfu.assignment_runtime import fresh_recovery as assignment_fresh_recovery
from kungfu.assignment_runtime import fresh_recovery_authority
from kungfu.assignment_runtime import profile_lifecycle
from kungfu.assignment_runtime.authority import LocalRuntimeError, WorkControlAuthority
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import assignment_review
from kungfu.cli.commands import kfc
from kungfu.agent import planned_work_binding, run_agent, session_contract

assignment_command = importlib.import_module("kungfu.cli.commands.assignment")
