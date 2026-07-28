# SPDX-License-Identifier: Apache-2.0

"""Deterministic checked-in projection of the complete CLI surface graph."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from kungfu.cli import surface_contract


_CATALOG_FILE = "cli_surface.catalog.json"
_REGISTRY_FILE = "surface_contract.registry.json"


def catalog_path() -> Path:
    return Path(__file__).resolve().parents[1] / "agent" / _CATALOG_FILE


def registry_path() -> Path:
    return Path(surface_contract.__file__).resolve().with_name(_REGISTRY_FILE)


def _kfd3_linkage(row: dict[str, Any]) -> dict[str, Any]:
    api_ids = row.get("kfd3_api_ids", [])
    if api_ids:
        return {
            "surfaceId": row["id"],
            "state": "linked",
            "apiIds": api_ids,
            "reason": None,
        }
    if row.get("kind") in {"root", "family", "group"}:
        reason = "navigation-only"
    elif "agent" not in row.get("audience", []):
        reason = "not-agent-visible"
    else:
        reason = "no-agent-first-api-declared"
    return {
        "surfaceId": row["id"],
        "state": "unlinked",
        "apiIds": [],
        "reason": reason,
    }


def build(contract: dict[str, Any]) -> dict[str, Any]:
    registry = surface_contract.registry()
    payload = {
        "schema": "kungfu.cli-surface-catalog/v1",
        "contractId": contract["contractId"],
        "version": contract["version"],
        "contractRoot": contract["contractRoot"],
        "registryRoot": contract["registryRoot"],
        "schemaRoot": contract["schemaRoot"],
        "surfaceRoot": contract["surfaceRoot"],
        "source": contract["source"],
        "projection": registry["catalogProjection"],
        "surfaces": contract["surfaces"],
        "kfd3Linkage": [_kfd3_linkage(row) for row in contract["surfaces"]],
        "nonClaims": contract["nonClaims"],
    }
    payload["catalogRoot"] = surface_contract.content_root(payload)
    return payload


def render(payload: dict[str, Any]) -> str:
    # The surface graph and linkage index are tabular generated data. Keep one
    # complete record per line so adding a CLI surface does not inflate this
    # projection by formatting-only lines.
    projected = dict(payload)
    projected["kfd3Linkage"] = "__KUNGFU_KFD3_LINKAGE__"
    projected["surfaces"] = "__KUNGFU_SURFACES__"
    rendered = json.dumps(projected, indent=2, sort_keys=True)
    marker = '  "kfd3Linkage": "__KUNGFU_KFD3_LINKAGE__",'
    linkage = ",\n".join(
        f"    {json.dumps(row, sort_keys=True, separators=(',', ':'))}"
        for row in payload["kfd3Linkage"]
    )
    replacement = f'  "kfd3Linkage": [\n{linkage}\n  ],'
    surface_marker = '  "surfaces": "__KUNGFU_SURFACES__",'
    surfaces = ",\n".join(
        f"    {json.dumps(row, sort_keys=True, separators=(',', ':'))}"
        for row in payload["surfaces"]
    )
    surface_replacement = f'  "surfaces": [\n{surfaces}\n  ],'
    return (
        rendered.replace(marker, replacement, 1).replace(
            surface_marker, surface_replacement, 1
        )
        + "\n"
    )


def current() -> dict[str, Any]:
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    contract = surface_contract.fold(kfc)
    if not contract["diagnostics"]["ok"]:
        errors = json.dumps(contract["diagnostics"]["errors"], sort_keys=True)
        raise ValueError(f"CLI surface contract is invalid: {errors}")
    return build(contract)


def check(path: Path | None = None) -> tuple[bool, str]:
    target = path or catalog_path()
    expected = render(current())
    try:
        actual = target.read_text(encoding="utf-8")
    except OSError as error:
        return False, f"cannot read {target}: {error}"
    if actual != expected:
        return False, f"stale generated catalog: {target}"
    return True, f"current {target}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="check or regenerate the complete Kungfu CLI surface catalog"
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    target = catalog_path()
    if args.write:
        contract = current()
        if surface_contract.refresh_expected_surface_root(contract, registry_path()):
            print(f"refreshed {registry_path()}")
        target.write_text(render(current()), encoding="utf-8")
        print(f"wrote {target}")
        return 0
    ok, message = check(target)
    print(message)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
