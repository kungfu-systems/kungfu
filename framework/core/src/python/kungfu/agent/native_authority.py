# SPDX-License-Identifier: Apache-2.0

"""Fail-visible guard for product paths owned by native Action Runtime."""

from __future__ import annotations

from typing import Any

from kungfu.storage import service as storage_service


class NativeActionRuntimeUnavailable(RuntimeError):
    pass


class ConformanceOracleDisabled(RuntimeError):
    pass


def require_action_runtime() -> Any:
    try:
        runtime = storage_service._runtime()
    except Exception as error:  # noqa: BLE001 - normalize missing bindings
        raise NativeActionRuntimeUnavailable(_message()) from error
    if not callable(getattr(runtime, "run_storage_service_operation", None)):
        raise NativeActionRuntimeUnavailable(_message())
    return runtime


def require_conformance_oracle(*, conformance: bool) -> None:
    if not conformance:
        raise ConformanceOracleDisabled(
            "Python Action semantics are a conformance-only oracle; "
            "call with `conformance=True` from qualification or test code"
        )


def _message() -> str:
    return (
        "native Action Runtime is required; install a Kungfu distribution with "
        "libkungfu or build it with `./shifu build:core`. Conformance tests must "
        "call the explicit *_python oracle."
    )
