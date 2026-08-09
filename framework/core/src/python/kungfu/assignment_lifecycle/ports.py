# SPDX-License-Identifier: Apache-2.0

"""Typed application ports shared by Assignment lifecycle services."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from kungfu.workspace import WorkspaceIdentity

JsonObject = dict[str, Any]


@dataclass(frozen=True)
class AssignmentRuntime:
    """Named runtime coordinate returned to Assignment domain services."""

    identity: WorkspaceIdentity
    runtime_dir: str
    receipt: JsonObject


class AssignmentEventSink(Protocol):
    def __call__(
        self,
        stage: str,
        status: str,
        text: str,
        root: str | None = None,
        activity: JsonObject | None = None,
    ) -> None: ...


class AssignmentRuntimePort(Protocol):
    def __call__(
        self,
        workspace_root: str | None,
        home: bool,
        operation_class: str,
    ) -> AssignmentRuntime: ...


class AssignmentAdvancePort(Protocol):
    def __call__(
        self,
        workspace_root: str | None,
        home: bool,
        initiative_id: str,
        assignment_id: str,
        to_phase: str,
        actor: str,
        reason: str,
    ) -> JsonObject: ...
