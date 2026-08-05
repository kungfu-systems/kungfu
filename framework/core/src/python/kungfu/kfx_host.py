# SPDX-License-Identifier: Apache-2.0

"""KFX host projection and process-isolated Python service bootstrap."""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import os
import signal
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from kungfu.capability import open_async_session


HOSTS = frozenset({"gui", "tui", "cli", "agent"})
STATUS_SCHEMA = "kungfu.kfx.python-service-status/v1"
DEFAULT_SHUTDOWN_TIMEOUT_SECONDS = 5.0
SUPPORTED_PYTHON = (3, 13)

_NETWORK_AUDIT_EVENTS = {
    "socket.bind",
    "socket.connect",
    "socket.getaddrinfo",
    "socket.gethostbyaddr",
    "socket.gethostbyname",
    "socket.gethostname",
    "socket.sendto",
}
_PROCESS_AUDIT_PREFIXES = ("os.exec", "os.posix_spawn", "os.spawn")
_PROCESS_AUDIT_EVENTS = {"os.system", "subprocess.Popen"}
_STORAGE_MUTATION_EVENTS = {
    "os.chdir",
    "os.chmod",
    "os.chown",
    "os.link",
    "os.mkdir",
    "os.remove",
    "os.rename",
    "os.rmdir",
    "os.symlink",
    "os.truncate",
}
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def project_control_suite_host(status: dict[str, Any], host: str) -> dict[str, Any]:
    """Retain the exact Core Control status across every presentation host."""

    if host not in HOSTS:
        raise ValueError(f"unsupported KFX host: {host}")
    if (
        status.get("schema") != "kungfu.kfx.control-suite-status/v1"
        or status.get("controllerId") != "kungfu-kfx-control-suite"
        or not str(status.get("statusRoot") or "").startswith("sha256:")
        or (status.get("mode") == "active") != bool(status.get("executionAllowed"))
        or (status.get("cutRoot") is None) != (status.get("revision") == 0)
    ):
        raise ValueError("KFX Control status identity does not match")
    return {
        "schema": "kungfu.kfx.control-host-projection/v1",
        "host": host,
        "controllerId": status["controllerId"],
        "statusRoot": status["statusRoot"],
        "cutRoot": status["cutRoot"],
        "revision": status["revision"],
        "mode": status["mode"],
        "executionAllowed": status["executionAllowed"],
        "diagnostics": status["diagnostics"],
    }


def project_experience_flow_host(
    descriptor: dict[str, Any], host: str
) -> dict[str, Any]:
    """Retain Core identities while adding only host-native availability."""

    if descriptor.get("schema") != "kungfu.kfx.experience-flow-host/v3":
        raise ValueError("unsupported KFX Experience/Flow host descriptor")
    if host not in HOSTS:
        raise ValueError(f"unsupported KFX host: {host}")
    for field in (
        "descriptorRoot",
        "registryRoot",
        "graphRoot",
        "planRoot",
        "receiptDependencyRoot",
        "cutRoot",
        "revision",
        "generation",
        "generationRoot",
        "admission",
        "runtimeAuthorizations",
        "contributions",
    ):
        if field not in descriptor:
            raise ValueError(f"KFX host descriptor is missing {field}")

    admission = descriptor["admission"]
    generation = descriptor["generation"]
    if (
        admission.get("schema") != "kungfu.kfx.host-admission/v2"
        or admission.get("exactRootRequired") is not True
        or admission.get("registryRoot") != descriptor["registryRoot"]
        or admission.get("graphRoot") != descriptor["graphRoot"]
        or admission.get("planRoot") != descriptor["planRoot"]
        or admission.get("cutRoot") != descriptor["cutRoot"]
        or admission.get("revision") != descriptor["revision"]
        or admission.get("generationRoot") != descriptor["generationRoot"]
        or generation.get("registryRoot") != descriptor["registryRoot"]
        or generation.get("graphRoot") != descriptor["graphRoot"]
        or generation.get("cutRoot") != descriptor["cutRoot"]
        or generation.get("revision") != descriptor["revision"]
        or len(admission.get("runtimeAuthorizationRoots", []))
        != len(descriptor["runtimeAuthorizations"])
        or (admission.get("state") == "admitted") != (descriptor["cutRoot"] is not None)
    ):
        raise ValueError("KFX host descriptor admission identity does not match")
    for index, authorization in enumerate(descriptor["runtimeAuthorizations"]):
        if (
            admission["runtimeAuthorizationRoots"][index]
            != authorization.get("authorizationRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
            or authorization.get("generationRoot") != descriptor["generationRoot"]
        ):
            raise ValueError("KFX runtime authorization identity does not match")

    diagnostics = []
    if admission["state"] != "admitted":
        diagnostics.append(
            {
                "code": "KF_KFX_HOST_NOT_ADMITTED",
                "recoveryGuidance": ["settle-exact-kfx-fact-cut"],
            }
        )
    contributions = []
    for contribution in descriptor["contributions"]:
        try:
            index = admission["contributionRoots"].index(
                contribution["contributionRoot"]
            )
        except (KeyError, ValueError) as error:
            raise ValueError(
                "KFX host contribution admission identity does not match"
            ) from error
        authorization = contribution.get("authorization") or {}
        if (
            admission["facetRoots"][index] != contribution.get("facetRoot")
            or admission["capabilityRoots"][index] != contribution.get("capabilityRoot")
            or admission["authorizationRoots"][index]
            != authorization.get("authorizationRoot")
            or authorization.get("ownerProviderRoot")
            != contribution.get("ownerProviderRoot")
            or authorization.get("trustRoot") != contribution.get("ownerTrustRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
            or authorization.get("generationRoot") != descriptor["generationRoot"]
            or (
                admission["state"] == "admitted"
                and (
                    not authorization.get("capabilityDeclarationRoot")
                    or not authorization.get("capabilityGrantRoot")
                    or not authorization.get("corePolicyRoot")
                    or not authorization.get("requestedPolicyRoot")
                    or not authorization.get("policyRoot")
                    or not authorization.get("warrantRoot")
                    or not set(authorization.get("requiredCapabilities", []))
                    <= set(authorization.get("grantedCapabilities", []))
                )
            )
        ):
            raise ValueError("KFX host contribution admission identity does not match")
        projection = dict(contribution)
        presentation = contribution.get("presentation") or {}
        supported = host in presentation.get("hosts", [])
        optional = presentation.get("optional") is True
        projection["semanticState"] = contribution["state"]
        projection["presentationState"] = (
            "active" if supported else "dormant" if optional else "degraded"
        )
        projection["executionEligible"] = (
            admission["state"] == "admitted"
            and authorization.get("executionAllowed") is True
            and contribution["state"] == "active"
            and projection["presentationState"] == "active"
        )
        if projection["presentationState"] == "dormant":
            diagnostics.append(
                {
                    "code": "KF_KFX_PRESENTATION_DORMANT",
                    "contributionRoot": contribution["contributionRoot"],
                    "recoveryGuidance": [f"install-optional-{host}-presentation"],
                }
            )
        contributions.append(projection)

    return {
        "schema": "kungfu.kfx.host-projection/v1",
        "host": host,
        "descriptorRoot": descriptor["descriptorRoot"],
        "graphRoot": descriptor["graphRoot"],
        "planRoot": descriptor["planRoot"],
        "receiptDependencyRoot": descriptor["receiptDependencyRoot"],
        "cutRoot": descriptor["cutRoot"],
        "revision": descriptor["revision"],
        "generationRoot": descriptor["generationRoot"],
        "admissionState": admission["state"],
        "diagnostics": diagnostics,
        "contributions": contributions,
    }


def project_cli_experience_flow_host(
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    return project_experience_flow_host(descriptor, "cli")


def project_agent_experience_flow_host(
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    return project_experience_flow_host(descriptor, "agent")


def authorize_host_launch(
    descriptor: dict[str, Any],
    package_key: str,
    host: str,
    expected_authorization_root: str,
) -> dict[str, Any]:
    """Validate the exact Core authorization before any physical host launch."""

    project_experience_flow_host(descriptor, "cli")
    admission = descriptor["admission"]
    for authorization in descriptor["runtimeAuthorizations"]:
        if (
            authorization.get("packageKey") != package_key
            or authorization.get("host") != host
        ):
            continue
        if (
            admission["state"] != "admitted"
            or expected_authorization_root not in admission["runtimeAuthorizationRoots"]
            or authorization.get("authorizationRoot") != expected_authorization_root
            or not authorization.get("capabilityDeclarationRoot")
            or not authorization.get("capabilityGrantRoot")
            or not authorization.get("corePolicyRoot")
            or not authorization.get("requestedPolicyRoot")
            or not authorization.get("policyRoot")
            or not authorization.get("warrantRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
            or authorization.get("generationRoot") != descriptor["generationRoot"]
            or not set(authorization.get("requiredCapabilities", []))
            <= set(authorization.get("grantedCapabilities", []))
            or authorization.get("executionAllowed") is not True
        ):
            raise ValueError("KFX host launch authorization does not match")
        return authorization
    raise ValueError("KFX host launch authorization does not match")


class AmbientCapabilityDenied(PermissionError):
    """A standard-library operation lacked its exact KFX capability grant."""


def _status(state: str, **details: Any) -> None:
    payload = {
        "schema": STATUS_SCHEMA,
        "state": state,
        "packageKey": os.environ.get("KFX_SERVICE_PACKAGE_KEY", ""),
        "authorizationRoot": os.environ.get("KFX_SERVICE_AUTHORIZATION_ROOT", ""),
        "capabilityGrantRoot": os.environ.get("KFX_SERVICE_CAPABILITY_GRANT_ROOT", ""),
        "generationRoot": os.environ.get("KFX_SERVICE_GENERATION_ROOT", ""),
        **details,
    }
    sys.stderr.write(
        "[kfx-python-service] "
        + json.dumps(payload, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    sys.stderr.flush()


def _write_open(mode: Any, flags: Any) -> bool:
    if isinstance(mode, str) and any(value in mode for value in ("w", "a", "x", "+")):
        return True
    return isinstance(flags, int) and bool(flags & _WRITE_FLAGS)


def install_ambient_capability_audit(declared: set[str]) -> None:
    """Install the supported Python audit gate before importing service code."""

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event in _NETWORK_AUDIT_EVENTS and "network" not in declared:
            raise AmbientCapabilityDenied(
                "KF_KFX_CAPABILITY_DENIED: network capability is not granted"
            )
        if (
            event in _PROCESS_AUDIT_EVENTS or event.startswith(_PROCESS_AUDIT_PREFIXES)
        ) and "process" not in declared:
            raise AmbientCapabilityDenied(
                "KF_KFX_CAPABILITY_DENIED: process capability is not granted"
            )
        if event == "open":
            target = args[0] if args else None
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else None
            if (
                not isinstance(target, int)
                and _write_open(mode, flags)
                and "storage" not in declared
            ):
                raise AmbientCapabilityDenied(
                    "KF_KFX_CAPABILITY_DENIED: storage capability is not granted"
                )
        if event in _STORAGE_MUTATION_EVENTS and "storage" not in declared:
            raise AmbientCapabilityDenied(
                "KF_KFX_CAPABILITY_DENIED: storage capability is not granted"
            )

    sys.addaudithook(audit)


def _load_service(entry: Path) -> ModuleType:
    if not entry.is_file():
        raise RuntimeError(f"service entry is not a file: {entry}")
    spec = importlib.util.spec_from_file_location("kungfu_kfx_service_entry", entry)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"service entry is not importable: {entry}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _install_shutdown_signals(event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()

    def request_shutdown(*_ignored: Any) -> None:
        loop.call_soon_threadsafe(event.set)

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, event.set)
        except (NotImplementedError, RuntimeError):
            signal.signal(signum, request_shutdown)


async def run_service(
    entry: Path,
    declared: set[str],
    *,
    shutdown_timeout: float = DEFAULT_SHUTDOWN_TIMEOUT_SECONDS,
) -> None:
    """Run one admitted service until completion or host shutdown."""

    session = open_async_session(sorted(declared))
    _install_shutdown_signals(session.shutdown_requested)
    install_ambient_capability_audit(declared)
    module = _load_service(entry)
    run = getattr(module, "run", None)
    if not callable(run):
        raise RuntimeError("service entry does not export run(caps)")
    result = run(session.caps)
    if not inspect.isawaitable(result):
        raise RuntimeError("Python KFX service run(caps) must be async")

    service_task = asyncio.ensure_future(result)
    service_task.set_name("kungfu-kfx-service")
    shutdown_task = asyncio.create_task(
        session.shutdown_requested.wait(), name="kungfu-kfx-service-shutdown"
    )
    _status("running")
    done, _pending = await asyncio.wait(
        {service_task, shutdown_task}, return_when=asyncio.FIRST_COMPLETED
    )
    if service_task in done:
        shutdown_task.cancel()
        await asyncio.gather(shutdown_task, return_exceptions=True)
        await service_task
        _status("stopped", reason="service-returned")
        return

    _status("stopping", reason="host-shutdown")
    service_task.cancel()
    try:
        async with asyncio.timeout(shutdown_timeout):
            await service_task
    except asyncio.CancelledError:
        pass
    except TimeoutError as error:
        raise RuntimeError(
            "service did not stop within the shutdown deadline"
        ) from error
    finally:
        shutdown_task.cancel()
        await asyncio.gather(shutdown_task, return_exceptions=True)
    _status("stopped", reason="host-shutdown")


def main() -> int:
    raw_declared = os.environ.get("KFX_DECLARED", "[]")
    entry_text = os.environ.get("KFX_SERVICE_ENTRY", "")
    try:
        if sys.version_info[:2] != SUPPORTED_PYTHON:
            raise RuntimeError(
                "Python KFX services require CPython >=3.13,<3.14; "
                f"running {sys.version_info.major}.{sys.version_info.minor}"
            )
        declared_value = json.loads(raw_declared)
        if not isinstance(declared_value, list) or not all(
            isinstance(item, str) and item for item in declared_value
        ):
            raise ValueError("KFX_DECLARED must be an array of capability names")
        if not entry_text:
            raise ValueError("KFX_SERVICE_ENTRY is not set")
        timeout = float(
            os.environ.get(
                "KFX_SERVICE_SHUTDOWN_TIMEOUT",
                str(DEFAULT_SHUTDOWN_TIMEOUT_SECONDS),
            )
        )
        if timeout <= 0:
            raise ValueError("KFX_SERVICE_SHUTDOWN_TIMEOUT must be positive")
        _status("starting")
        asyncio.run(
            run_service(
                Path(entry_text).expanduser().resolve(),
                set(declared_value),
                shutdown_timeout=timeout,
            )
        )
        return 0
    except BaseException as error:
        _status("failed", errorType=type(error).__name__, error=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "AmbientCapabilityDenied",
    "authorize_host_launch",
    "install_ambient_capability_audit",
    "main",
    "project_agent_experience_flow_host",
    "project_cli_experience_flow_host",
    "project_control_suite_host",
    "project_experience_flow_host",
    "run_service",
]
