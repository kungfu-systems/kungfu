# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import json
import os
import platform
import re
import shutil
import sys
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from kungfu import runtime_upgrade

release_cut = runtime_upgrade


CHECK_SCHEMA = "kungfu.product-update-check/v1"
DOWNLOAD_PLAN_SCHEMA = "kungfu.product-update-download-plan/v1"
DOWNLOAD_RECEIPT_SCHEMA = "kungfu.product-update-download-receipt/v1"
APPLY_SCHEMA = "kungfu.product-update-apply/v1"
ORCHESTRATION_PLAN_SCHEMA = "kungfu.product-update-orchestration-plan/v1"
ORCHESTRATION_RECEIPT_SCHEMA = "kungfu.product-update-orchestration-receipt/v1"
CLI_IMAGE_SCHEMA = "kungfu.product-cli-image/v1"
CLI_SELECTION_SCHEMA = "kungfu.product-cli-selection/v1"
CLI_INVENTORY_FSCK_SCHEMA = "kungfu.product-cli-inventory-fsck/v1"
CLI_ROLLBACK_SCHEMA = "kungfu.product-cli-rollback/v1"
UNQUALIFIED = "unqualified-local-build"
MAX_MANIFEST_BYTES = 1024 * 1024
_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
_MANAGER_COMMAND_TIMEOUT_SECONDS = 15 * 60
_VERIFICATION_COMMAND_TIMEOUT_SECONDS = 30
_MAX_ARCHIVE_ENTRIES = 100_000
_MIN_ARCHIVE_EXPANDED_BYTES = 64 * 1024 * 1024
_MAX_ARCHIVE_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024
_MAX_ARCHIVE_EXPANSION_RATIO = 200
_CONTENT_RANGE = re.compile(r"^bytes ([0-9]+)-([0-9]+)/([0-9]+)$")
_CLI_SELECTION_RECEIPT_NAME = re.compile(r"^generation-([0-9]{20})\.json$")
_CLI_DOWNLOAD_PROCESS_LOCK = threading.Lock()
_CLI_SELECTION_PROCESS_LOCK = threading.Lock()
_SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

_INSTALL_SOURCES = {
    "archive": {
        "frontendAuthority": "archive-updater",
        "selfUpdateAllowed": True,
        "managerCommand": None,
    },
    "desktop-companion": {
        "frontendAuthority": "desktop-updater",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
    "homebrew": {
        "frontendAuthority": "package-manager",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
    "winget": {
        "frontendAuthority": "package-manager",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
    "deb": {
        "frontendAuthority": "package-manager",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
    "rpm": {
        "frontendAuthority": "package-manager",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
    "native-installer": {
        "frontendAuthority": "external-installer",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
    "unknown": {
        "frontendAuthority": "user",
        "selfUpdateAllowed": False,
        "managerCommand": None,
    },
}

_PACKAGE_MANAGER_COMMANDS = {
    "homebrew": {
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    },
}


class DistributionUpdateError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.receipt: dict[str, Any] | None = None


def _command_argv(value: Any, label: str) -> list[str]:
    if not (
        isinstance(value, list)
        and value
        and all(isinstance(item, str) and item for item in value)
    ):
        raise DistributionUpdateError(
            f"{label}-invalid",
            f"{label.replace('-', ' ')} must be a non-empty string array",
        )
    return copy.deepcopy(value)


def _package_manager_commands(
    source: str,
    manager_command: Any,
    verification_command: Any,
) -> tuple[list[str] | None, list[str] | None]:
    if manager_command is None and verification_command is None:
        return None, None
    if manager_command is None or verification_command is None:
        raise DistributionUpdateError(
            "package-manager-contract-incomplete",
            "package-manager install metadata must declare both update and verification argv",
        )
    manager = _command_argv(manager_command, "manager-command")
    verification = _command_argv(verification_command, "verification-command")
    expected = _PACKAGE_MANAGER_COMMANDS.get(source)
    if expected is None:
        raise DistributionUpdateError(
            "package-manager-contract-unsupported",
            f"{source} has no locally allowlisted package-manager contract",
        )
    if (
        manager != expected["managerCommand"]
        or verification != expected["verificationCommand"]
    ):
        raise DistributionUpdateError(
            "package-manager-command-untrusted",
            f"{source} update metadata does not match the locally allowlisted exact argv",
        )
    return manager, verification


def _package_manager_failure_code(stderr: Any) -> tuple[str, str]:
    detail = str(stderr or "").lower()
    if any(
        marker in detail
        for marker in (
            "no available formula",
            "no formulae found",
            "formula unavailable",
            "not in a tap",
        )
    ):
        return (
            "package-manager-formula-unavailable",
            "the trusted Kungfu Formula is unavailable from the configured tap",
        )
    if any(
        marker in detail
        for marker in ("no such keg", "not installed", "formula is not installed")
    ):
        return (
            "package-manager-formula-not-installed",
            "the trusted Kungfu Formula is not installed in this Homebrew prefix",
        )
    if any(
        marker in detail
        for marker in (
            "could not resolve host",
            "failed to connect",
            "network is unreachable",
            "timed out",
            "offline",
        )
    ):
        return (
            "package-manager-offline",
            "Homebrew could not reach the trusted Formula source",
        )
    if any(
        marker in detail
        for marker in ("permission denied", "operation not permitted", "not writable")
    ):
        return (
            "package-manager-permission-denied",
            "Homebrew could not update its owned prefix with current permissions",
        )
    return (
        "update-command-failed",
        "package manager update command failed; existing work was not changed",
    )


def _parse_product_version(value: str, label: str) -> tuple[int, int, int, list[str]]:
    match = _SEMVER.fullmatch(value)
    if match is None:
        raise DistributionUpdateError(
            "product-version-invalid", f"{label} is not a valid SemVer version"
        )
    prerelease = match.group(4)
    prerelease_identifiers = prerelease.split(".") if prerelease is not None else []
    if any(
        identifier.isdigit() and len(identifier) > 1 and identifier.startswith("0")
        for identifier in prerelease_identifiers
    ):
        raise DistributionUpdateError(
            "product-version-invalid",
            f"{label} is not a valid SemVer version",
        )
    return (
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
        prerelease_identifiers,
    )


def compare_product_versions(left: str, right: str) -> int:
    """Compare SemVer product versions while ignoring build metadata."""

    left_major, left_minor, left_patch, left_pre = _parse_product_version(
        left, "target product version"
    )
    right_major, right_minor, right_patch, right_pre = _parse_product_version(
        right, "installed product version"
    )
    left_core = (left_major, left_minor, left_patch)
    right_core = (right_major, right_minor, right_patch)
    if left_core != right_core:
        return 1 if left_core > right_core else -1
    if not left_pre or not right_pre:
        if left_pre == right_pre:
            return 0
        return -1 if left_pre else 1
    for left_item, right_item in zip(left_pre, right_pre, strict=False):
        if left_item == right_item:
            continue
        left_numeric = left_item.isdigit()
        right_numeric = right_item.isdigit()
        if left_numeric and right_numeric:
            return 1 if int(left_item) > int(right_item) else -1
        if left_numeric != right_numeric:
            return -1 if left_numeric else 1
        return 1 if left_item > right_item else -1
    if len(left_pre) == len(right_pre):
        return 0
    return 1 if len(left_pre) > len(right_pre) else -1


def _downgrade_refusal(
    manifest: Mapping[str, Any], current_version: str
) -> dict[str, Any]:
    impact = {
        "activeWorkContinues": True,
        "activationTiming": "not-authorized",
        "userActionRequired": True,
    }
    return {
        "state": "action-required",
        "reasonCode": "downgrade-refused",
        "currentVersion": current_version,
        "targetVersion": manifest["productVersion"],
        "runtimeBuildId": manifest["runtimeBuildId"],
        "frontendAction": "none",
        "managerCommand": None,
        "documentationUrl": manifest["documentationUrl"],
        "message": runtime_upgrade.user_message(
            "downgrade-refused",
            documentation_url=manifest["documentationUrl"],
            impact=impact,
        ),
    }


def _canonical(value: Mapping[str, Any]) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def _stable_id(prefix: str, value: Mapping[str, Any]) -> str:
    return f"{prefix}-{hashlib.sha256(_canonical(value)).hexdigest()[:24]}"


def _content_root(value: Mapping[str, Any]) -> str:
    return f"sha256:{hashlib.sha256(_canonical(value)).hexdigest()}"


def _read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DistributionUpdateError(
            "metadata-unreadable", f"update metadata is unreadable: {path}"
        ) from error
    if not isinstance(value, dict):
        raise DistributionUpdateError(
            "metadata-invalid", f"update metadata is not an object: {path}"
        )
    return value


def _write_object(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _path_safe_id(value: str, label: str) -> str:
    if not value or any(
        char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        for char in value
    ):
        raise DistributionUpdateError(
            f"{label}-invalid", f"{label.replace('-', ' ')} is not path safe"
        )
    return value


def _cli_inventory_root(config_home: str | Path) -> Path:
    return Path(config_home).expanduser().resolve() / "product" / "cli"


def _cli_image_root(config_home: str | Path, frontend_build_id: str) -> Path:
    return (
        _cli_inventory_root(config_home)
        / "images"
        / _path_safe_id(frontend_build_id, "frontend-build-id")
    )


def _cli_selection_path(config_home: str | Path) -> Path:
    return _cli_inventory_root(config_home) / "current.json"


def _cli_selection_receipt_path(config_home: str | Path, generation: int) -> Path:
    receipts_root = _cli_inventory_root(config_home) / "receipts"
    return receipts_root / f"generation-{generation:020d}.json"


def _cli_selection_receipt_generations(config_home: str | Path) -> list[int]:
    receipts_root = _cli_inventory_root(config_home) / "receipts"
    try:
        entries = list(receipts_root.iterdir())
    except FileNotFoundError:
        return []
    except OSError as error:
        raise DistributionUpdateError(
            "cli-selection-receipt-io-failed",
            "CLI selection receipt journal could not be inspected",
        ) from error
    return sorted(
        int(match.group(1))
        for entry in entries
        if (match := _CLI_SELECTION_RECEIPT_NAME.fullmatch(entry.name)) is not None
    )


def _next_cli_generation(config_home: str | Path, current_generation: int) -> int:
    return (
        max([current_generation, *_cli_selection_receipt_generations(config_home)]) + 1
    )


def _persist_cli_selection_receipt(
    config_home: str | Path,
    selection: Mapping[str, Any],
    receipt: Mapping[str, Any],
) -> None:
    generation = int(selection.get("generation") or 0)
    receipt_value = copy.deepcopy(dict(receipt))
    receipt_root = receipt_value.get("receiptRoot")
    receipt_core = {
        key: value for key, value in receipt_value.items() if key != "receiptRoot"
    }
    if (
        generation < 1
        or receipt_value.get("frontendSelection") != selection
        or not isinstance(receipt_root, str)
        or receipt_root != _content_root(receipt_core)
    ):
        raise DistributionUpdateError(
            "cli-selection-receipt-invalid",
            "CLI selection receipt does not bind the exact selected generation",
        )
    path = _cli_selection_receipt_path(config_home, generation)
    if path.is_file():
        if _read_object(path) != receipt_value:
            raise DistributionUpdateError(
                "cli-selection-receipt-collision",
                "CLI selection generation already has different receipt evidence",
            )
        return
    try:
        _write_object(path, receipt_value)
    except OSError as error:
        raise DistributionUpdateError(
            "cli-selection-receipt-io-failed",
            "CLI selection receipt could not be persisted before activation",
        ) from error


def _read_cli_selection_receipt(
    config_home: str | Path, selection: Mapping[str, Any]
) -> dict[str, Any] | None:
    generation = int(selection.get("generation") or 0)
    if generation < 1:
        return None
    path = _cli_selection_receipt_path(config_home, generation)
    if not path.is_file():
        return None
    receipt = _read_object(path)
    receipt_selection = receipt.get("frontendSelection")
    receipt_root = receipt.get("receiptRoot")
    receipt_core = {
        key: value for key, value in receipt.items() if key != "receiptRoot"
    }
    if (
        not isinstance(receipt_selection, Mapping)
        or int(receipt_selection.get("generation") or 0) != generation
        or receipt_selection != selection
        or not isinstance(receipt_root, str)
        or receipt_root != _content_root(receipt_core)
    ):
        raise DistributionUpdateError(
            "cli-selection-receipt-invalid",
            "CLI selection receipt does not verify against the current generation",
        )
    return receipt


def _normalize_platform() -> tuple[str, str]:
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(
        platform.system(), platform.system().lower()
    )
    machine = platform.machine().lower()
    architecture = {
        "aarch64": "arm64",
        "arm64": "arm64",
        "amd64": "x64",
        "x86_64": "x64",
    }.get(machine, machine)
    return system, architecture


def install_source(
    env: Mapping[str, str] | None = None,
    *,
    product_manifest: str | Path | None = None,
) -> dict[str, Any]:
    env = os.environ if env is None else env
    manifest_path = product_manifest or env.get("KUNGFU_PRODUCT_MANIFEST")
    manifest = None
    if manifest_path:
        candidate = Path(manifest_path).expanduser().resolve()
        manifest = _read_object(candidate)
    source = str(env.get("KUNGFU_INSTALL_SOURCE") or "")
    if not source and manifest is not None:
        install = manifest.get("install")
        if isinstance(install, Mapping):
            source = str(install.get("source") or "")
    source = source or "unknown"
    if source not in _INSTALL_SOURCES:
        raise DistributionUpdateError(
            "install-source-unsupported", f"unsupported install source: {source}"
        )
    result = {
        "schema": "kungfu.product-install-source/v1",
        "source": source,
        **copy.deepcopy(_INSTALL_SOURCES[source]),
        "verificationCommand": None,
        "productManifest": str(Path(manifest_path).expanduser().resolve())
        if manifest_path
        else None,
        "selectedFrontendBuildId": env.get("KUNGFU_SELECTED_FRONTEND_BUILD_ID"),
        "selectedReleaseCutRoot": env.get("KUNGFU_SELECTED_RELEASE_CUT_ROOT"),
        "selectedPlatformSliceRoot": env.get("KUNGFU_SELECTED_PLATFORM_SLICE_ROOT"),
        "bootstrapReceipt": None,
    }
    if manifest is not None:
        result["selectedReleaseCutRoot"] = result[
            "selectedReleaseCutRoot"
        ] or manifest.get("releaseCutRoot")
        result["selectedPlatformSliceRoot"] = result[
            "selectedPlatformSliceRoot"
        ] or manifest.get("platformSliceRoot")
    if source == "archive" and manifest_path:
        receipt_path = (
            Path(manifest_path).expanduser().resolve().parent
            / "install"
            / "bootstrap-receipt.json"
        )
        if receipt_path.is_file():
            receipt = _read_object(receipt_path)
            receipt_root = receipt.get("receiptRoot")
            rooted = {
                key: value for key, value in receipt.items() if key != "receiptRoot"
            }
            if (
                receipt.get("schema") != "kungfu.bootstrap-verification-receipt/v1"
                or receipt.get("state") != "verified"
                or receipt_root != _content_root(rooted)
            ):
                raise DistributionUpdateError(
                    "bootstrap-receipt-invalid",
                    "archive bootstrap receipt is invalid",
                )
            result["bootstrapReceipt"] = receipt
            result["selectedFrontendBuildId"] = receipt.get("frontendBuildId")
    if manifest is not None:
        install = manifest.get("install")
        manager_command = (
            install.get("managerCommand") if isinstance(install, Mapping) else None
        )
        verification_command = (
            install.get("verificationCommand") if isinstance(install, Mapping) else None
        )
        if manager_command is not None or verification_command is not None:
            if result["frontendAuthority"] != "package-manager":
                raise DistributionUpdateError(
                    "manager-command-unowned",
                    "only package-manager installs may declare a manager command",
                )
            manager, verification = _package_manager_commands(
                source,
                manager_command,
                verification_command,
            )
            result["managerCommand"] = manager
            result["verificationCommand"] = verification
    return result


def local_dogfood_residency(
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Inspect Shifu's local dev Product residency without changing it."""

    env = os.environ if env is None else env
    os_name = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(
        platform.system(), platform.system().lower()
    )
    arch = {
        "arm64": "aarch64",
        "aarch64": "aarch64",
        "x86_64": "x86_64",
        "amd64": "x86_64",
    }.get(platform.machine().lower(), platform.machine().lower())
    home = Path(str(env.get("HOME") or Path.home()))
    cache_home = Path(str(env.get("XDG_CACHE_HOME") or home / ".cache"))
    registry = cache_home / "kungfu" / "product" / f"{os_name}-{arch}"
    installed_path = registry / "installed.meta.env"
    promotion_path = registry / "last-promotion.json"
    installed = _read_shifu_env(installed_path)
    promotion = _read_json_object(promotion_path)

    runtime_root_value = str(env.get("KUNGFU_DIR") or "")
    runtime_root = (
        Path(runtime_root_value).expanduser().resolve() if runtime_root_value else None
    )
    manifest_value = str(env.get("KUNGFU_UPGRADE_MANIFEST") or "")
    manifest_path = (
        Path(manifest_value).expanduser().resolve() if manifest_value else None
    )
    build_info = (
        _read_json_object(runtime_root / "kungfubuildinfo.json")
        if runtime_root is not None
        else {}
    )
    manifest = _read_json_object(manifest_path) if manifest_path is not None else {}
    profile_manifest_path = (
        runtime_root / "profile-kfd3.json" if runtime_root is not None else None
    )
    profile_manifest = (
        _read_json_object(profile_manifest_path)
        if profile_manifest_path is not None
        else {}
    )
    profile_roots = sorted(
        {
            str(row.get("profileSuiteRoot") or "")
            for row in profile_manifest.get("entries", [])
            if str(row.get("profileSuiteRoot") or "").startswith("sha256:")
        }
    )
    source_commit = str(build_info.get("git", {}).get("revision") or "")
    manifest_commit = str(manifest.get("sourceCommit") or "")
    installed_commit = str(installed.get("KUNGFU_INSTALLED_SHA") or "")
    mainline_commit = str(installed.get("KUNGFU_INSTALLED_MAINLINE_SHA") or "")
    artifact = Path(str(installed.get("KUNGFU_INSTALLED_ARTIFACT") or ""))
    entrypoint = str(
        env.get("KUNGFU_CONTROLLER_ENTRYPOINT") or shutil.which("kungfu") or sys.argv[0]
    )
    identity_matches = bool(
        re.fullmatch(r"[0-9a-f]{40}", source_commit)
        and source_commit == manifest_commit
        and source_commit == installed_commit
        and source_commit == mainline_commit
    )
    qualified = (
        installed.get("KUNGFU_INSTALLED_QUALIFIED") == "true"
        and installed.get("KUNGFU_INSTALLED_INTEGRATED") == "true"
        and installed.get("KUNGFU_INSTALLED_MAINLINE_REF") == "origin/HEAD"
    )
    artifact_matches = bool(
        artifact.is_dir()
        and runtime_root is not None
        and artifact.resolve() in runtime_root.parents
    )
    occurred_at = int(promotion.get("occurredAt") or 0)
    age_seconds = max(0, int(time.time()) - occurred_at) if occurred_at else None
    freshness = (
        "fresh"
        if identity_matches
        and qualified
        and age_seconds is not None
        and age_seconds <= 7 * 24 * 60 * 60
        else "stale"
        if occurred_at
        else "unknown"
    )
    rollback_id = str(installed.get("KUNGFU_ROLLBACK_BUILD_ID") or "")
    rollback_slot = registry / rollback_id if rollback_id else None
    rollback_available = bool(
        rollback_slot is not None
        and rollback_slot.is_dir()
        and (rollback_slot / "meta.env").is_file()
    )
    promotion_matches = bool(
        promotion.get("schema") == "shifu.local-promotion-receipt/v1"
        and promotion.get("product") == "kungfu"
        and promotion.get("action") in {"promote", "rollback"}
        and promotion.get("artifactId") == installed.get("KUNGFU_INSTALLED_BUILD_ID")
        and promotion.get("toCommit") == installed_commit
    )
    state = (
        "qualified"
        if identity_matches
        and qualified
        and artifact_matches
        and profile_roots
        and promotion_matches
        and rollback_available
        else "unqualified"
        if installed
        else "unavailable"
    )
    return {
        "schema": "kungfu.product-dogfood-residency/v1",
        "state": state,
        "controllerEntrypoint": entrypoint,
        "product": "kungfu",
        "artifactId": installed.get("KUNGFU_INSTALLED_BUILD_ID"),
        "artifactPath": str(artifact) if str(artifact) else None,
        "artifactDigest": installed.get("KUNGFU_INSTALLED_DIGEST"),
        "sourceCommit": source_commit or None,
        "sourceBranch": build_info.get("git", {}).get("branch"),
        "buildPristine": build_info.get("git", {}).get("pristine") is True,
        "productManifest": str(manifest_path) if manifest_path is not None else None,
        "productManifestDigest": _optional_file_digest(manifest_path),
        "controllerProfileRoots": profile_roots,
        "mainline": {
            "ref": installed.get("KUNGFU_INSTALLED_MAINLINE_REF"),
            "commit": mainline_commit or None,
            "integrated": installed.get("KUNGFU_INSTALLED_INTEGRATED") == "true",
        },
        "qualification": {
            "qualified": qualified,
            "identityMatches": identity_matches,
            "artifactMatchesRuntime": artifact_matches,
            "promotionMatches": promotion_matches,
            "rollbackAvailable": rollback_available,
        },
        "promotion": {
            **promotion,
            "receiptPath": str(promotion_path),
            "receiptDigest": _optional_file_digest(promotion_path),
        },
        "rollback": {
            "artifactId": rollback_id or None,
            "sourceCommit": installed.get("KUNGFU_ROLLBACK_SHA") or None,
            "available": rollback_available,
            "checkCommand": (
                ["shifu", "promote", "--rollback", "--check"] if rollback_id else None
            ),
        },
        "freshness": {
            "state": freshness,
            "promotionAgeSeconds": age_seconds,
            "maximumAgeSeconds": 7 * 24 * 60 * 60,
        },
        "registryPath": str(registry),
        "writes": [],
    }


def _read_shifu_env(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    result = {}
    for line in lines:
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z0-9_]+", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        result[key] = value
    return result


def _read_json_object(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _optional_file_digest(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _artifact(manifest: Mapping[str, Any], kind: str) -> dict[str, Any]:
    artifacts = [item for item in manifest["artifacts"] if item["kind"] == kind]
    if len(artifacts) != 1:
        raise DistributionUpdateError(
            "artifact-ambiguous", f"release manifest must declare one {kind} artifact"
        )
    return copy.deepcopy(dict(artifacts[0]))


def _assert_cli_publication(manifest: Mapping[str, Any]) -> None:
    evidence = str(manifest.get("qualificationEvidenceRef") or "")
    if not evidence or evidence.startswith(UNQUALIFIED):
        raise DistributionUpdateError(
            "release-unqualified", "release has no retained qualification evidence"
        )
    if not release_cut.is_public_release_cut(manifest.get("releaseCut")):
        raise DistributionUpdateError(
            "release-publication-policy-mismatch",
            "public update requires an eligible public Release Cut",
        )
    _artifact(manifest, "runtime")
    _artifact(manifest, "cli")
    for artifact in manifest["artifacts"]:
        kind = artifact["kind"]
        if not artifact["signature"] or artifact["signature"] == UNQUALIFIED:
            raise DistributionUpdateError(
                "signature-missing", f"{kind} artifact has no signing evidence"
            )
        if kind in {"cli", "desktop"} and not str(artifact["url"]).startswith(
            "https://"
        ):
            raise DistributionUpdateError(
                "artifact-transport-insecure",
                f"{kind} update artifact requires HTTPS",
            )


def _assert_release_target(
    manifest: Mapping[str, Any],
    *,
    expected_platform: str | None = None,
    expected_architecture: str | None = None,
) -> None:
    current_platform, current_architecture = _normalize_platform()
    expected_platform = expected_platform or current_platform
    expected_architecture = expected_architecture or current_architecture
    if (
        manifest["platform"] != expected_platform
        or manifest["architecture"] != expected_architecture
    ):
        raise DistributionUpdateError(
            "release-target-mismatch",
            "release platform or architecture does not match this CLI",
        )
