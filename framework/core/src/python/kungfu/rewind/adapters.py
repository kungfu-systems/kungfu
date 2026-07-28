#  SPDX-License-Identifier: Apache-2.0
#
# kfx adapter discovery — the supervisor side of the plugin bridge.
#
# Framework adapters are a kfx extension form (`kungfuConfig.config.adapter`),
# not core code. The supervisor has kungfu and reads manifests, so it does the
# discovery: it scans the same extension roots the GUI shell scans, finds
# packages whose manifest declares a python adapter, and announces their entry
# files to the child. The child-side hook stays dependency-free and only loads
# what it is told — see rewind_client._load_plugin_adapters.
#
# A manifest's adapter form:
#   "kungfuConfig": { "config": { "adapter": {
#       "targets": ["langchain_core.tools.base"],   # informative
#       "runtimes": ["python"],                      # forms this covers
#       "entry": { "python": "dist/adapter/python/index.py" }
#   } } }

from __future__ import annotations

import os
from collections.abc import Iterator

from kungfu import kfx_contract
from kungfu.storage import service as storage_service

ENV_EXTENSION_PATH = "KF_EXTENSION_PATH"
# shared contract strings with the child hooks (per runtime): the python hook
# reads ENV_PLUGIN_ADAPTERS, the node hook reads ENV_NODE_ADAPTERS.
ENV_PLUGIN_ADAPTERS = "KUNGFU_REWIND_ADAPTERS"
ENV_NODE_ADAPTERS = "KUNGFU_REWIND_NODE_ADAPTERS"


def _extension_roots(runtime_dir: str | None) -> list[str]:
    # priority order mirrors framework/gui kfx-loader: KF_EXTENSION_PATH entries
    # (dev override) then <home>/extensions next to the runtime dir.
    roots = []
    for entry in os.environ.get(ENV_EXTENSION_PATH, "").split(os.pathsep):
        if entry:
            roots.append(entry)
    if runtime_dir:
        roots.append(os.path.join(os.path.dirname(runtime_dir), "extensions"))
    return roots


def _scan_packages(root: str) -> Iterator[str]:
    # two levels deep, so suite members nested under a suite directory are found
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        pkg = os.path.join(root, name)
        if os.path.isfile(os.path.join(pkg, kfx_contract.PACKAGE_MANIFEST_FILE)):
            yield pkg
        elif os.path.isdir(pkg):
            for sub in sorted(os.listdir(pkg)):
                nested = os.path.join(pkg, sub)
                if os.path.isfile(
                    os.path.join(nested, kfx_contract.PACKAGE_MANIFEST_FILE)
                ):
                    yield nested


def discover_adapters(
    runtime_dir: str | None, runtime: str
) -> tuple[list[str], list[str], list[dict[str, str | None]]]:
    """Return (entry_files, package_dirs, refused) for kfx packages declaring an
    adapter form for `runtime` ('python' or 'node'). First occurrence of a
    package path wins; missing entry files are skipped.

    An adapter runs in-process inside the traced program and cannot be sandboxed,
    so injection requires the exact native host authorization from the current
    KFX Fact Cut. The discovered closure must match that authorization before
    native ``authorize-host`` revalidates its generation and roots. Discovery
    origin, caller-provided descriptors, and package identity carry no authority.
    """
    descriptor = None
    if runtime_dir:
        try:
            descriptor = storage_service.kfx_registry("plan", {}, runtime_dir).get(
                "hostContract"
            )
        except (OSError, RuntimeError, ValueError):
            descriptor = None
    entries: list[str] = []
    dirs: list[str] = []
    refused: list[dict[str, str | None]] = []
    seen: set[str] = set()
    for root in _extension_roots(runtime_dir):
        for pkg in _scan_packages(root):
            try:
                manifest = kfx_contract.read_manifest_from_dir(pkg)
            except (OSError, ValueError):
                continue
            kfx = manifest.get("kungfuConfig") or {}
            adapter = (kfx.get("config") or {}).get("adapter") or {}
            if runtime not in (adapter.get("runtimes") or []):
                continue
            entry = (adapter.get("entry") or {}).get(runtime)
            if not entry:
                continue
            path = os.path.abspath(os.path.join(pkg, entry))
            if path in seen or not os.path.exists(path):
                continue
            seen.add(path)
            key = kfx.get("key")
            authorization = None
            if descriptor is not None and key:
                observed = None
                try:
                    observed = storage_service.kfx_registry(
                        "inspect",
                        {
                            "roots": [{"kind": "workspace", "path": pkg}],
                            "packageKey": key,
                        },
                        "",
                    ).get("package")
                except (OSError, RuntimeError, ValueError):
                    observed = None
                for candidate in descriptor.get("runtimeAuthorizations", []):
                    if (
                        candidate.get("packageKey") == key
                        and candidate.get("host") == f"adapter-{runtime}"
                        and isinstance(observed, dict)
                        and observed.get("packageRoot") == candidate.get("packageRoot")
                        and observed.get("manifestRoot")
                        == candidate.get("manifestRoot")
                    ):
                        try:
                            launch = storage_service.kfx_registry(
                                "authorize-host",
                                {
                                    "packageKey": key,
                                    "host": f"adapter-{runtime}",
                                    "expectedCutRoot": descriptor.get("cutRoot"),
                                    "expectedRevision": descriptor.get("revision"),
                                    "expectedGenerationRoot": descriptor.get(
                                        "generationRoot"
                                    ),
                                    "expectedPackageRoot": candidate.get("packageRoot"),
                                    "expectedCapabilityGrantRoot": candidate.get(
                                        "capabilityGrantRoot"
                                    ),
                                    "expectedAuthorizationRoot": candidate.get(
                                        "authorizationRoot"
                                    ),
                                    "expectedGrantedCapabilities": candidate.get(
                                        "grantedCapabilities", []
                                    ),
                                },
                                runtime_dir,
                            )
                            authorization = launch.get("authorization")
                            if (
                                launch.get("executionAllowed") is not True
                                or not isinstance(authorization, dict)
                                or authorization.get("authorizationRoot")
                                != candidate.get("authorizationRoot")
                            ):
                                authorization = None
                        except (OSError, RuntimeError, ValueError):
                            authorization = None
                        break
            if authorization is None:
                refused.append({"key": kfx.get("key"), "package": os.path.abspath(pkg)})
                continue
            entries.append(path)
            dirs.append(os.path.abspath(pkg))
    return entries, dirs, refused
