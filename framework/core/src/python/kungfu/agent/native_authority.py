# SPDX-License-Identifier: Apache-2.0

"""Fail-visible guard for product paths owned by native Action Runtime."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import kungfu
from kungfu import profile_sdk
from kungfu.storage import service as storage_service


class NativeActionRuntimeUnavailable(RuntimeError):
    pass


class ConformanceOracleDisabled(RuntimeError):
    pass


def profile_adapter_runtime_failure(
    error: profile_sdk.ProfileSdkError,
    *,
    write: bool,
    operation: str,
    retained_codes: set[str],
) -> dict[str, Any]:
    """Normalize a Profile adapter failure without importing its caller runtime."""

    code = str(error.diagnosis.get("code") or "")
    if (
        write
        and code == "member-adapter-invoke-failed"
        and isinstance(error.__cause__, ValueError)
    ):
        return {
            "code": "invalid-command",
            "message": str(error.__cause__),
            "details": {"operation": operation},
        }
    if code in {
        "member-resolution-failed",
        "profile-member-ambiguous",
        "profile-source-ambiguous",
    }:
        return {
            "code": "ambiguous-identity",
            "message": "Work Control authority does not resolve exactly once",
        }
    retained = code in retained_codes
    message = str(error) if retained else "Work Control authority is unavailable"
    return {
        "code": "backend-unavailable",
        "message": message,
        "diagnostics": [
            {
                "code": code or "work-control-unavailable",
                "message": (
                    message
                    if retained
                    else "The exact active Work Control Profile could not be invoked"
                ),
                "severity": "error",
                "recovery": [
                    "kungfu profile manager --json",
                    "kungfu profile history kungfu.work-control --json",
                ],
            }
        ],
    }


def _file_root(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def inspect_native_authority(
    runtime_dir: str | Path, expected: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Bind one process to its loaded native binary and active Profile root."""

    binding_path = Path(kungfu.__binding__.__file__).resolve()
    binding_root = _file_root(binding_path)
    discovered = profile_sdk.discover_source("kungfu.work-control", runtime_dir)
    application = profile_sdk.application(
        discovered["source"], runtime_dir, include_qualification=False
    )
    profile_root = str(application["profileSuiteRoot"])
    identity = {
        "bindingPath": str(binding_path),
        "bindingRoot": binding_root,
        "profileId": str(application["profileId"]),
        "profileRoot": profile_root,
    }
    current = {
        "schema": "kungfu.action-loop.native-authority/v0",
        "id": f"native:{_semantic_root(identity)[7:31]}",
        "root": _semantic_root(identity),
        "state": "current" if application["activeExactRoot"] else "inactive",
        "binding": {"path": str(binding_path), "root": binding_root},
        "profile": {
            "id": str(application["profileId"]),
            "root": profile_root,
        },
    }
    if current["state"] != "current":
        return {
            "status": "denied",
            "code": "native-authority-inactive",
            "message": "Work Control Profile is not active at this exact root",
            "current": current,
            "writeOccurred": False,
        }
    if expected is not None and (
        expected.get("id") != current["id"]
        or expected.get("root") != current["root"]
        or expected.get("binding") != current["binding"]
        or expected.get("profile") != current["profile"]
    ):
        return {
            "status": "denied",
            "code": "native-authority-drift",
            "message": "the active native binding or Profile exact root changed",
            "current": current,
            "writeOccurred": False,
        }
    return {"status": "current", "binding": current, "writeOccurred": False}


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


def _semantic_root(value: Any) -> str:
    import json

    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()
