# SPDX-License-Identifier: Apache-2.0

"""Release-owned shared-API evidence for Profile SDK KFD-3 qualification."""

from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu import kfx_contract
from kungfu.profile_sdk_support import ProfileSdkError, _root, _sha256


def _source_view_export_closure(package: Path, entry: Path) -> list[tuple[Path, bytes]]:
    """Load an entry and only its explicit, package-confined relative re-exports."""

    if not entry.is_file():
        return []
    package_root = package.resolve()
    modules = [(entry.resolve(), entry.read_bytes())]
    export_pattern = re.compile(
        rb"export\s*\{[^}]+\}\s*from\s*['\"](\.[^'\"]+)['\"]\s*;"
    )
    for match in export_pattern.finditer(modules[0][1]):
        source = match.group(1).decode("utf-8")
        unresolved = modules[0][0].parent / source
        candidates = [
            unresolved,
            *(
                unresolved.with_suffix(suffix)
                for suffix in (".ts", ".tsx", ".js", ".jsx")
            ),
            *(
                unresolved / f"index{suffix}"
                for suffix in (".ts", ".tsx", ".js", ".jsx")
            ),
        ]
        for candidate in candidates:
            resolved_candidate = candidate.resolve()
            try:
                resolved_candidate.relative_to(package_root)
            except ValueError:
                continue
            if not resolved_candidate.is_file():
                continue
            if all(path != resolved_candidate for path, _data in modules):
                modules.append((resolved_candidate, resolved_candidate.read_bytes()))
            break
    return modules


def _shared_api_release_audit(
    projection: Mapping[str, Any], resolved: Mapping[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Prove bundled GUI/Agent parity through the installed API authority."""

    from kungfu.agent.kfd3 import registry

    apis = {row.get("id"): row for row in registry().get("apis", [])}
    probes = []
    failures = []
    for intent in projection["intents"]:
        protocol = intent.get("protocol") or {}
        api_id = protocol.get("apiId") if protocol.get("mode") == "shared-api" else None
        api = apis.get(api_id)
        projections = set((api or {}).get("projections") or [])
        gui_member = str(protocol.get("guiMember") or "")
        gui_method = str(protocol.get("guiMethod") or "")
        gui_package = Path(
            str((resolved.get("memberPackages") or {}).get(gui_member, ""))
        )
        gui_manifest = (
            kfx_contract.read_manifest_from_dir(str(gui_package))
            if gui_package.is_dir()
            else {}
        )
        view = ((gui_manifest.get("kungfuConfig") or {}).get("config") or {}).get(
            "view"
        ) or {}
        bundle = gui_package / str(view.get("entry") or "dist/view/index.js")
        source_view = gui_package / "src" / "view" / "index.tsx"
        if bundle.is_file():
            projection_kind = "built-view-bundle"
            projection_modules = [(bundle, bundle.read_bytes())]
            projection_root = "sha256:" + _sha256(projection_modules[0][1])
        else:
            projection_modules = _source_view_export_closure(gui_package, source_view)
            projection_kind = "source-view"
            projection_root = _root(
                {
                    "entry": str(source_view.relative_to(gui_package)),
                    "modules": [
                        {
                            "path": str(path.relative_to(gui_package)),
                            "sha256": _sha256(data),
                        }
                        for path, data in projection_modules
                    ],
                }
            )
        gui_bound = bool(
            projection_modules
            and any(
                re.search(
                    rb"\." + re.escape(gui_method.encode("utf-8")) + rb"\s*\(",
                    data,
                )
                for _path, data in projection_modules
            )
        )
        matched = bool(
            api
            and api.get("surface") == "cli-api-gui"
            and "work-dashboard-gui" in projections
            and "provider-skill" in projections
            and gui_bound
        )
        if not matched:
            failures.append(
                {
                    "intentId": intent["id"],
                    "apiId": api_id,
                    "guiMember": gui_member,
                    "guiMethod": gui_method,
                    "reason": "shared API lacks a bound GUI method or matching Agent projection",
                }
            )
            continue
        probes.append(
            {
                "intentId": intent["id"],
                "apiId": api_id,
                "surface": "cli-api-gui",
                "humanProjection": "work-dashboard-gui",
                "agentProjection": "provider-skill",
                "guiMember": gui_member,
                "guiMethod": gui_method,
                "guiProjectionRoot": projection_root,
                "guiProjectionKind": projection_kind,
                "matched": True,
            }
        )
    if failures:
        raise ProfileSdkError(
            "kfd3-release-api-parity-failed",
            "one or more bundled intents lack the same GUI and Agent API surface",
            failures=failures,
        )
    facets = []
    executable_count = 0
    for key, package_dir in sorted(
        {
            "suite": Path(str(resolved["source"])),
            **{
                str(key): Path(str(path))
                for key, path in (resolved.get("memberPackages") or {}).items()
            },
        }.items()
    ):
        manifest = kfx_contract.read_manifest_from_dir(str(package_dir))
        config = (manifest.get("kungfuConfig") or {}).get("config") or {}
        for facet in ("view", "adapter", "service", "wasm"):
            if config.get(facet) is not None:
                executable_count += 1
                facets.append({"packageKey": key, "facet": facet})
    return (
        {
            "passed": True,
            "policy": "release-owned-shared-api-parity/v1",
            "customViews": facets,
            "executableFacetCount": executable_count,
        },
        probes,
    )
