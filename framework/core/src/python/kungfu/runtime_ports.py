# SPDX-License-Identifier: Apache-2.0

"""Typed runtime lifecycle ports shared without service/broker dependencies."""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any, Protocol


class RuntimeActivationClient(Protocol):
    def activate(
        self, requirement: Mapping[str, Any], request_source: str
    ) -> Mapping[str, Any]: ...


class RuntimeProcessHost(Protocol):
    def activate(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...

    def inspect(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...


class RuntimeDrainHost(Protocol):
    def drain(self, home: str, runtime_dir: str) -> Mapping[str, Any]: ...


class RuntimeReadinessAuthority(Protocol):
    def establish(
        self,
        requirement: Mapping[str, Any],
        generation: str,
        diagnostics: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...


class RuntimeLeaseClock(Protocol):
    def now_ns(self) -> int: ...


class SystemRuntimeLeaseClock:
    def now_ns(self) -> int:
        return time.time_ns()


class RuntimeLifecycleError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
