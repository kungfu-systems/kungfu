# SPDX-License-Identifier: Apache-2.0

"""Read-only, packaged verification entrypoint for Kungfu Exit packages.

This verifier deliberately reuses the Core-owned Exit Bundle and member
verifiers.  It is an independently invocable installed-artifact boundary, not
an independently authored implementation of the domain protocols.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import copy
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Mapping, Sequence


CONTRACT_FILE = "exit_verifier.contract.json"
CORPUS_FILE = "exit_verifier.corpus.json"
EXIT_CONTRACT_FILE = "exit_bundle.contract.json"
REPORT_SCHEMA = "kungfu.exit-verification-report/v1"
INFO_SCHEMA = "kungfu.exit-verifier-info/v1"
VERIFIER_ID = "kungfu-exit-verifier"
VERIFIER_VERSION = 1
_ROOT_PREFIX = b"kungfu.exit-verifier.root/v1\0"
STATUS_SCHEMA = "kungfu.exit-history.status/v1"
EXPORT_OBSERVER_SCHEMA = "kungfu.exit-history.export-observer/v1"
REBUILD_SCHEMA = "kungfu.exit-history.projection-rebuild/v1"
_THIN_CAPABILITIES = ["inspect", "verify-inventory"]


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(payload: bytes) -> str:
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _root(domain: str, value: Any) -> str:
    return _sha256(_ROOT_PREFIX + domain.encode("utf-8") + b"\0" + _canonical(value))


def _asset(name: str) -> Path:
    candidate = Path(__file__).resolve().with_name(name)
    if candidate.is_file():
        return candidate
    if name == EXIT_CONTRACT_FILE:
        for directory in [
            Path(__file__).resolve().parent,
            *Path(__file__).resolve().parents,
        ]:
            source = (
                directory / "framework" / "exit" / "kungfu-exit-bundle.contract.json"
            )
            if source.is_file():
                return source
    raise FileNotFoundError(f"packaged Exit verifier asset is missing: {name}")


def _load_asset(name: str) -> dict[str, Any]:
    value = json.loads(_asset(name).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"packaged Exit verifier asset must be an object: {name}")
    return value


def _product_identity() -> dict[str, Any]:
    """Read product identity without importing the native binding."""

    module_path = Path(__file__).resolve()
    directories = [module_path.parent, *module_path.parents]
    for directory in directories:
        build_info = directory / "kungfubuildinfo.json"
        if not build_info.is_file():
            continue
        try:
            value = json.loads(build_info.read_text(encoding="utf-8"))
            version = str(value["version"])
        except (KeyError, OSError, TypeError, ValueError):
            continue
        return {
            "version": version,
            "channel": "pre-release" if "-" in version else "stable",
            "source": "kungfubuildinfo.json",
        }
    for directory in directories:
        package = directory / "package.json"
        if directory.name != "core" or not package.is_file():
            continue
        try:
            value = json.loads(package.read_text(encoding="utf-8"))
            version = str(value["version"])
        except (KeyError, OSError, TypeError, ValueError):
            continue
        return {
            "version": version,
            "channel": "pre-release" if "-" in version else "stable",
            "source": "source-package-json",
        }
    return {"version": None, "channel": "unknown", "source": "unavailable"}


def _contract() -> dict[str, Any]:
    value = _load_asset(CONTRACT_FILE)
    if value.get("schema") != "kungfu.exit-verifier.contract/v1":
        raise ValueError("packaged Exit verifier contract schema mismatch")
    return value


def _corpus() -> dict[str, Any]:
    value = _load_asset(CORPUS_FILE)
    if value.get("schema") != "kungfu.exit-verifier.corpus/v1":
        raise ValueError("packaged Exit verifier corpus schema mismatch")
    return value


def _identity() -> dict[str, Any]:
    contract_bytes = _asset(CONTRACT_FILE).read_bytes()
    corpus_bytes = _asset(CORPUS_FILE).read_bytes()
    exit_contract_bytes = _asset(EXIT_CONTRACT_FILE).read_bytes()
    value = {
        "id": VERIFIER_ID,
        "version": VERIFIER_VERSION,
        "contractRoot": _sha256(contract_bytes),
        "corpusRoot": _sha256(corpus_bytes),
        "exitBundleContractRoot": _sha256(exit_contract_bytes),
        "implementation": "shared-core-python",
        "independentImplementation": False,
        "runtimeMutation": False,
        "networkRequired": False,
    }
    value["manifestRoot"] = _root("manifest", value)
    return value


def info() -> dict[str, Any]:
    """Return stable installed discovery without touching a runtime."""

    contract = _contract()
    corpus = _corpus()
    exit_contract = _load_asset(EXIT_CONTRACT_FILE)
    verifier = _identity()
    support_policy = dict(exit_contract["supportPolicy"])
    value = {
        "schema": INFO_SCHEMA,
        "product": _product_identity(),
        "verifier": verifier,
        "exitContract": {
            "schema": exit_contract["schema"],
            "version": exit_contract["version"],
            "weldedSurface": exit_contract["weldedSurface"],
            "contractRoot": verifier["exitBundleContractRoot"],
            "manifestSchemaRoot": _sha256(_canonical(exit_contract["manifestSchema"])),
            "topLevelProtocol": support_policy["protocolVersioning"][
                "topLevelProtocol"
            ],
        },
        "supportPolicy": support_policy,
        "qualification": dict(support_policy["qualification"]),
        "contractNonClaims": list(exit_contract["nonClaims"]),
        "supportedPackageSchemas": list(contract["supportedPackageSchemas"]),
        "supportedManifestSchemas": list(contract["supportedManifestSchemas"]),
        "supportedMemberProtocols": list(contract["supportedMemberProtocols"]),
        "bounds": dict(contract["bounds"]),
        "exitCodes": dict(contract["exitCodes"]),
        "reportSchema": dict(contract["reportSchema"]),
        "corpus": {
            "schema": corpus["schema"],
            "caseIds": [str(row["id"]) for row in corpus["cases"]],
            "root": verifier["corpusRoot"],
        },
        "independence": dict(contract["independence"]),
    }
    value["infoRoot"] = _root("info", value)
    return value


def _shape_failure(value: Any, contract: Mapping[str, Any]) -> tuple[str, str] | None:
    bounds = contract["bounds"]
    maximum_depth = int(bounds["maximumJsonDepth"])
    maximum_nodes = int(bounds["maximumJsonNodes"])
    maximum_string_bytes = int(bounds["maximumStringBytes"])
    nodes = 0
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > maximum_nodes:
            return (
                "package-node-limit-exceeded",
                "JSON node count exceeds verifier limit",
            )
        if depth > maximum_depth:
            return ("package-depth-limit-exceeded", "JSON depth exceeds verifier limit")
        if isinstance(current, str):
            if len(current.encode("utf-8")) > maximum_string_bytes:
                return (
                    "package-string-limit-exceeded",
                    "JSON string exceeds verifier limit",
                )
        elif isinstance(current, Mapping):
            stack.extend((key, depth + 1) for key in current)
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
    if not isinstance(value, Mapping):
        return ("package-schema-invalid", "Exit package must be a JSON object")
    manifest = value.get("manifest")
    members = manifest.get("members") if isinstance(manifest, Mapping) else None
    materials = value.get("materials")
    if isinstance(members, list) and len(members) > int(bounds["maximumMembers"]):
        return ("package-member-limit-exceeded", "member count exceeds verifier limit")
    if isinstance(manifest, Mapping) and isinstance(members, list):
        member_ids = [
            str(row.get("memberId") or "")
            for row in members
            if isinstance(row, Mapping)
        ]
        if len(member_ids) != len(set(member_ids)):
            return (
                "duplicate-member-identity",
                "Exit package contains a duplicate member identity",
            )
        requirements = manifest.get("requirements")
        required = (
            requirements.get("requiredMembers")
            if isinstance(requirements, Mapping)
            else None
        )
        if isinstance(required, list):
            missing = sorted(set(str(value) for value in required) - set(member_ids))
            if missing:
                return (
                    "required-member-missing",
                    f"required members are missing: {', '.join(missing)}",
                )
    if isinstance(materials, Mapping) and len(materials) > int(
        bounds["maximumMembers"]
    ):
        return (
            "package-material-limit-exceeded",
            "material count exceeds verifier limit",
        )
    if isinstance(materials, Mapping):
        maximum_material_bytes = int(bounds["maximumMaterialBytes"])
        for member_id, material in materials.items():
            if len(_canonical(material)) > maximum_material_bytes:
                return (
                    "member-material-limit-exceeded",
                    f"material exceeds verifier limit: {member_id}",
                )
    if len(_canonical(value)) > int(bounds["maximumPackageBytes"]):
        return ("package-size-limit-exceeded", "package exceeds verifier byte limit")
    return None


def _report(
    *,
    verdict: str,
    package: Mapping[str, Any] | None,
    failure: dict[str, Any] | None,
    inspection: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    package = package or {}
    manifest = package.get("manifest")
    manifest = manifest if isinstance(manifest, Mapping) else {}
    inspection = inspection or {}
    full = verdict == "verified"
    degraded = verdict == "degraded"
    verified_dimensions = [
        "package-root",
        "bundle-root",
        "contract-schema",
        "member-inventory",
        "compatibility",
    ]
    if full:
        verified_dimensions.extend(
            ["material-bytes", "member-domain-roots", "scope-closure"]
        )
    unverified_dimensions = (
        []
        if full
        else (
            [
                "material-bytes",
                "member-domain-roots",
                "scope-closure",
                "materialization",
                "continuation",
            ]
            if degraded
            else ["package-integrity", "member-integrity", "safe-capabilities"]
        )
    )
    value = {
        "schema": REPORT_SCHEMA,
        "ok": full,
        "verdict": verdict,
        "bundleId": manifest.get("bundleId"),
        "bundleRoot": manifest.get("bundleRoot"),
        "packageRoot": package.get("packageRoot"),
        "verifier": _identity(),
        "verifiedDimensions": verified_dimensions if verdict != "rejected" else [],
        "unverifiedDimensions": unverified_dimensions,
        "verifiedMembers": list(inspection.get("verifiedMembers") or []),
        "safeCapabilities": list(inspection.get("capabilities") or []),
        "omissions": list(
            inspection.get("omissions") or manifest.get("omissions") or []
        ),
        "loss": list(inspection.get("loss") or manifest.get("loss") or []),
        "failureCodes": [failure["code"]] if failure else [],
        "failure": failure,
        "residualRisk": (
            [
                "Top-level verification reuses the installed Core Python and domain verifier implementation; it is not an independent implementation.",
                "KFR2 cross-language conformance and the no-Kungfu-import Episode oracle are separate qualification evidence, not re-executed by this entrypoint.",
            ]
            if verdict != "rejected"
            else ["No capability claim is safe until the reported failure is resolved."]
        ),
        "requiredNextActions": (
            ["none"]
            if full
            else (
                [
                    "provide the exact full package before materialization or continuation"
                ]
                if degraded
                else ["resolve the failure and rerun the same read-only verifier"]
            )
        ),
    }
    value["reportRoot"] = _root("report", value)
    return value


def _rejected(
    code: str,
    message: str,
    *,
    package: Mapping[str, Any] | None = None,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return _report(
        verdict="rejected",
        package=package,
        failure={
            "code": code,
            "message": message,
            "details": dict(details or {}),
        },
    )


def verify(package: Mapping[str, Any]) -> dict[str, Any]:
    """Verify one in-memory package without mutating or initializing a runtime."""

    try:
        contract = _contract()
        shape_failure = _shape_failure(package, contract)
        if shape_failure is not None:
            return _rejected(*shape_failure, package=package)
        from kungfu import exit_bundle

        exit_contract = _load_asset(EXIT_CONTRACT_FILE)
        if exit_contract.get("schema") != "kungfu.exit-bundle.contract/v1":
            return _rejected(
                "verifier-asset-missing",
                "packaged Exit Bundle contract schema mismatch",
                package=package,
            )
        inspection = exit_bundle.inspect(package, _contract_value=exit_contract)
        verdict = "degraded" if inspection.get("status") == "degraded" else "verified"
        return _report(
            verdict=verdict,
            package=package,
            failure=None,
            inspection=inspection,
        )
    except FileNotFoundError as error:
        return _rejected("verifier-asset-missing", str(error), package=package)
    except (ValueError, TypeError, KeyError) as error:
        code = getattr(error, "code", "package-schema-invalid")
        details = getattr(error, "details", {})
        return _rejected(str(code), str(error), package=package, details=details)


def verify_bytes(raw: bytes) -> dict[str, Any]:
    """Parse and verify bounded UTF-8 JSON bytes."""

    try:
        contract = _contract()
    except (OSError, ValueError) as error:
        return _rejected("verifier-asset-missing", str(error))
    maximum = int(contract["bounds"]["maximumPackageBytes"])
    if len(raw) > maximum:
        return _rejected(
            "package-size-limit-exceeded",
            "package exceeds verifier byte limit",
            details={"maximumBytes": maximum, "actualBytes": len(raw)},
        )
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return _rejected("package-json-invalid", str(error))
    if not isinstance(value, dict):
        return _rejected("package-schema-invalid", "Exit package must be an object")
    return verify(value)


def verify_file(path: str | Path) -> dict[str, Any]:
    """Verify a local file with a pre-read byte limit."""

    candidate = Path(path).expanduser()
    try:
        contract = _contract()
        maximum = int(contract["bounds"]["maximumPackageBytes"])
        size = candidate.stat().st_size
        if size > maximum:
            return _rejected(
                "package-size-limit-exceeded",
                "package exceeds verifier byte limit",
                details={"maximumBytes": maximum, "actualBytes": size},
            )
        return verify_bytes(candidate.read_bytes())
    except OSError as error:
        return _rejected("package-read-failed", str(error))


def _export_observer_path(runtime_dir: str | Path) -> Path:
    return Path(runtime_dir).expanduser() / "exit" / "history-export-observer.json"


def record_verified_export(
    runtime_dir: str | Path, package: Mapping[str, Any]
) -> dict[str, Any]:
    """Record a disposable observer projection after full package verification."""

    from kungfu import exit_bundle

    inspection = exit_bundle.inspect(package)
    manifest = package["manifest"]
    body = {
        "schema": EXPORT_OBSERVER_SCHEMA,
        "bundleId": manifest["bundleId"],
        "mode": manifest["mode"],
        "bundleRoot": manifest["bundleRoot"],
        "packageRoot": package["packageRoot"],
        "memberCount": len(manifest["members"]),
        "verifiedMembers": list(inspection["verifiedMembers"]),
        "loss": list(manifest["loss"]),
        "authority": "disposable-observer-projection",
    }
    body["observerRoot"] = exit_bundle._root("history-export-observer", body)
    path = _export_observer_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(body, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return body


def _read_verified_export(runtime_dir: str | Path) -> dict[str, Any] | None:
    from kungfu import exit_bundle

    path = _export_observer_path(runtime_dir)
    if not path.is_file():
        return None
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise exit_bundle.ExitBundleError(
            "history-export-observer-invalid",
            "history export observer projection is unreadable",
        ) from error
    if not isinstance(body, dict) or body.get("schema") != EXPORT_OBSERVER_SCHEMA:
        raise exit_bundle.ExitBundleError(
            "history-export-observer-invalid",
            "history export observer projection schema is invalid",
        )
    expected = exit_bundle._root(
        "history-export-observer",
        {key: value for key, value in body.items() if key != "observerRoot"},
    )
    if body.get("observerRoot") != expected:
        raise exit_bundle.ExitBundleError(
            "history-export-observer-root-mismatch",
            "history export observer projection root does not match",
        )
    return body


def status(
    runtime_dir: str | Path,
    request: Mapping[str, Any] | None = None,
    *,
    config_home: str | Path | None = None,
) -> dict[str, Any]:
    """Project the governed history contract without becoming data authority."""

    from kungfu import exit_bundle

    contract = exit_bundle._contract()
    inventory: list[dict[str, Any]] = [
        {
            "kind": str(row["id"]),
            "authority": str(row["owner"]),
            "protocol": str(row["protocol"]),
            "modes": list(row["modes"]),
        }
        for row in contract.get("memberInventory") or []
        if row.get("eligibleMember") is True
    ]
    inventory.sort(key=lambda row: row["kind"])
    last_export = _read_verified_export(runtime_dir)
    body: dict[str, Any] = {
        "schema": STATUS_SCHEMA,
        "ok": True,
        "state": "contract-ready",
        "coverage": "not-evaluated",
        "authority": {
            "composition": "kungfu.exit-bundle",
            "memberDomainsRemainAuthoritative": True,
            "observerMutation": False,
        },
        "contractRoot": exit_bundle._schema_root(contract),
        "runtimeInitialized": Path(runtime_dir).expanduser().exists(),
        "eligibleMembers": inventory,
        "selectedScope": None,
        "lastVerifiedExport": last_export,
        "nextActions": [
            "kungfu exit history status --file <request.json> --json",
            "kungfu exit history export --file <request.json> --out <exit.json> --json",
        ],
        "nonClaims": [
            "contract-ready-does-not-prove-selected-scope-coverage",
            "software-portability-does-not-prove-off-host-backup",
            "observer-state-does-not-settle-or-mutate-member-work",
        ],
    }
    if last_export is not None:
        body.update(
            {
                "state": "degraded" if last_export["loss"] else "verified",
                "coverage": (
                    "last-export-explicit-loss"
                    if last_export["loss"]
                    else "last-export-content-verified"
                ),
                "nextActions": [
                    "kungfu exit history export --file <request.json> --out <exit.json> --json",
                    "kungfu exit history verify --file <exit.json> --json",
                ],
            }
        )
    if request is not None:
        thin_request = copy.deepcopy(dict(request))
        thin_request["mode"] = "thin"
        thin_request["requiredCapabilities"] = list(_THIN_CAPABILITIES)
        thin_request["equivalenceLevels"] = ["exact-record-roots"]
        package = exit_bundle.build(runtime_dir, thin_request, config_home=config_home)
        inspection = exit_bundle.inspect(package)
        manifest = package["manifest"]
        body.update(
            {
                "state": "inventory-verified",
                "coverage": "selected-scope-inventory",
                "selectedScope": {
                    "id": manifest["scope"]["id"],
                    "root": manifest["scope"]["root"],
                    "bundleId": manifest["bundleId"],
                    "bundleRoot": manifest["bundleRoot"],
                    "inventoryMembers": [
                        {
                            "memberId": row["memberId"],
                            "identityRoot": row["identityRoot"],
                            "contentRoot": row["contentRoot"],
                        }
                        for row in manifest["members"]
                    ],
                    "contentVerifiedMembers": list(inspection["verifiedMembers"]),
                    "intentionalThinLoss": list(manifest["loss"]),
                },
                "nextActions": [
                    "kungfu exit history export --file <request.json> --out <exit.json> --json",
                    "kungfu exit history verify --file <exit.json> --json",
                ],
            }
        )
    body["statusRoot"] = exit_bundle._root("history-status", body)
    return body


def rebuild_projections(
    runtime_dir: str | Path,
    *,
    projections: Sequence[str] | None = None,
    execute: bool = False,
    authorized_by: str = "",
) -> dict[str, Any]:
    """Rebuild declared projections from local authorities, never from UI state."""

    from kungfu import exit_bundle

    selected = sorted(set(projections or ("episode", "fact-kernel")))
    unknown = sorted(set(selected) - {"episode", "fact-kernel"})
    if unknown:
        raise exit_bundle.ExitBundleError(
            "history-projection-unsupported",
            "unsupported history projection selection",
            projections=unknown,
        )
    operations = [
        {
            "projection": projection,
            "authority": (
                "yijinjing-journal" if projection == "episode" else "native-fact-kernel"
            ),
            "mutation": "rebuildable-projection-only",
        }
        for projection in selected
    ]
    body: dict[str, Any] = {
        "schema": REBUILD_SCHEMA,
        "ok": True,
        "status": "planned" if not execute else "rebuilt",
        "execute": execute,
        "operations": operations,
        "receipts": [],
        "authorityMutation": False,
        "nextActions": (
            ["kungfu exit history rebuild --execute --authorized-by <actor> --json"]
            if not execute
            else []
        ),
    }
    if not execute:
        body["receiptRoot"] = exit_bundle._root("history-projection-rebuild", body)
        return body
    actor = authorized_by.strip()
    if not actor:
        raise exit_bundle.ExitBundleError(
            "authorization-actor-required",
            "projection rebuild requires authorized_by",
        )

    from kungfu.storage import service as storage_service

    receipts = []
    for projection in selected:
        if projection == "episode":
            result = storage_service.episode_projection_rebuild(runtime_dir)
            receipt = {
                "projection": projection,
                "schema": result.get("schema"),
                "ok": result.get("ok") is True,
                "authority": result.get("authority"),
                "queryRecords": int(result.get("query_records") or 0),
                "journalRecords": sum(
                    int(row.get("count") or 0)
                    for row in result.get("journal_records") or []
                ),
            }
        else:
            result = storage_service.fact_kernel_rebuild_projections(runtime_dir)
            receipt = {
                "projection": projection,
                "schema": result.get("schema"),
                "ok": result.get("ok") is True,
                "beforeRoot": result.get("before_root"),
                "afterRoot": result.get("after_root"),
                "projectionCount": int(result.get("projection_count") or 0),
                "writeOccurred": result.get("write_occurred") is True,
            }
        receipts.append(receipt)
    body["receipts"] = receipts
    body["ok"] = all(row["ok"] is True for row in receipts)
    body["status"] = "rebuilt" if body["ok"] else "rejected"
    body["authorizedBy"] = actor
    body["receiptRoot"] = exit_bundle._root("history-projection-rebuild", body)
    return body


def _cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="kungfu-exit-verify",
        description=(
            "Verify a Kungfu Exit package without initializing a Kungfu runtime."
        ),
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--file",
        help="Exit package JSON path, or - for bounded stdin",
    )
    source.add_argument(
        "--input-base64",
        help="base64-encoded Exit package JSON",
    )
    source.add_argument(
        "--info",
        action="store_true",
        help="show verifier identity, bounds, corpus, and independence",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit the stable machine-readable report (the default)",
    )
    return parser


def _stdin_bytes(maximum: int) -> bytes:
    return sys.stdin.buffer.read(maximum + 1)


def main(argv: list[str] | None = None) -> int:
    """Run the registry-free installed verifier process boundary."""

    parser = _cli_parser()
    args = parser.parse_args(argv)
    if args.info:
        result = info()
        exit_code = 0
    elif args.input_base64:
        maximum = int(_contract()["bounds"]["maximumPackageBytes"])
        maximum_encoded = maximum * 4 // 3 + 8
        if len(args.input_base64) > maximum_encoded:
            parser.error("base64 input exceeds Exit verifier byte limit")
        try:
            raw = base64.b64decode(args.input_base64, validate=True)
        except (ValueError, binascii.Error) as error:
            parser.error(f"invalid base64 input: {error}")
        result = verify_bytes(raw)
        exit_code = int(_contract()["exitCodes"][result["verdict"]])
    elif args.file == "-":
        maximum = int(_contract()["bounds"]["maximumPackageBytes"])
        result = verify_bytes(_stdin_bytes(maximum))
        exit_code = int(_contract()["exitCodes"][result["verdict"]])
    else:
        result = verify_file(args.file)
        exit_code = int(_contract()["exitCodes"][result["verdict"]])
    print(json.dumps(result, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
