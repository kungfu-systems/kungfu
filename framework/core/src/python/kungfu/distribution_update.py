# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from kungfu import runtime_upgrade
from kungfu.coordination import locks as coordination_locks


CHECK_SCHEMA = "kungfu.product-update-check/v1"
DOWNLOAD_PLAN_SCHEMA = "kungfu.product-update-download-plan/v1"
DOWNLOAD_RECEIPT_SCHEMA = "kungfu.product-update-download-receipt/v1"
APPLY_SCHEMA = "kungfu.product-update-apply/v1"
ORCHESTRATION_PLAN_SCHEMA = "kungfu.product-update-orchestration-plan/v1"
ORCHESTRATION_RECEIPT_SCHEMA = "kungfu.product-update-orchestration-receipt/v1"
CLI_IMAGE_SCHEMA = "kungfu.product-cli-image/v1"
CLI_SELECTION_SCHEMA = "kungfu.product-cli-selection/v1"
CLI_INVENTORY_FSCK_SCHEMA = "kungfu.product-cli-inventory-fsck/v1"
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
        "bootstrapReceipt": None,
    }
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
        and installed.get("KUNGFU_INSTALLED_MAINLINE_REF") == "origin/dev/v4/v4.0"
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


def _assert_https_response(
    response: Any,
    *,
    code: str,
    message: str,
) -> None:
    final_url = str(response.geturl())
    if urllib.parse.urlparse(final_url).scheme.lower() != "https":
        raise DistributionUpdateError(code, message)


class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, *, code: str, message: str) -> None:
        super().__init__()
        self._code = code
        self._message = message

    def redirect_request(
        self,
        request: Any,
        file_pointer: Any,
        response_code: int,
        response_message: str,
        headers: Any,
        new_url: str,
    ) -> Any:
        target = urllib.parse.urljoin(request.full_url, new_url)
        if urllib.parse.urlparse(target).scheme.lower() != "https":
            raise DistributionUpdateError(self._code, self._message)
        return super().redirect_request(
            request,
            file_pointer,
            response_code,
            response_message,
            headers,
            target,
        )


def _open_https(
    request: str | urllib.request.Request,
    *,
    timeout: int,
    code: str,
    message: str,
) -> Any:
    opener = urllib.request.build_opener(
        _HttpsOnlyRedirectHandler(code=code, message=message)
    )
    return opener.open(request, timeout=timeout)


def load_release_manifest(reference: str | Path) -> tuple[dict[str, Any], bool]:
    text_reference = str(reference)
    parsed = urllib.parse.urlparse(text_reference)
    remote = parsed.scheme in {"http", "https"}
    if remote:
        if parsed.scheme != "https":
            raise DistributionUpdateError(
                "manifest-transport-insecure", "release manifests require HTTPS"
            )
        try:
            with _open_https(
                text_reference,
                timeout=30,
                code="manifest-transport-insecure",
                message="release manifest redirect requires HTTPS",
            ) as response:
                _assert_https_response(
                    response,
                    code="manifest-transport-insecure",
                    message="release manifest redirect requires HTTPS",
                )
                payload = response.read(MAX_MANIFEST_BYTES + 1)
        except OSError as error:
            raise DistributionUpdateError(
                "manifest-download-failed", "could not download release manifest"
            ) from error
        if len(payload) > MAX_MANIFEST_BYTES:
            raise DistributionUpdateError(
                "manifest-too-large", "release manifest exceeds the size limit"
            )
        try:
            value = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DistributionUpdateError(
                "manifest-invalid", "release manifest is invalid JSON"
            ) from error
    else:
        path = (
            Path(urllib.request.url2pathname(parsed.path))
            if parsed.scheme == "file"
            else Path(text_reference)
        )
        value = _read_object(path.expanduser().resolve())
    if not isinstance(value, dict):
        raise DistributionUpdateError(
            "manifest-invalid", "release manifest is not an object"
        )
    return runtime_upgrade.validate_manifest(value), remote


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


def check_release(
    manifest: Mapping[str, Any],
    *,
    current_version: str,
    source: Mapping[str, Any],
    require_publication: bool = True,
    expected_platform: str | None = None,
    expected_architecture: str | None = None,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(
        value,
        expected_platform=expected_platform,
        expected_architecture=expected_architecture,
    )
    if require_publication:
        _assert_cli_publication(value)
    version_order = compare_product_versions(value["productVersion"], current_version)
    if version_order < 0:
        return {
            "schema": CHECK_SCHEMA,
            **_downgrade_refusal(value, current_version),
            "installSource": copy.deepcopy(dict(source)),
            "manifest": value,
        }
    manager_action = source.get("managerCommand")
    available = version_order > 0
    reason_code = "new-product-version" if available else "already-current"
    impact = {
        "activeWorkContinues": True,
        "activationTiming": "after-core-readiness",
        "userActionRequired": False,
    }
    return {
        "schema": CHECK_SCHEMA,
        "state": "available" if available else "current",
        "reasonCode": reason_code,
        "currentVersion": current_version,
        "targetVersion": value["productVersion"],
        "runtimeBuildId": value["runtimeBuildId"],
        "installSource": copy.deepcopy(dict(source)),
        "frontendAction": "download"
        if source.get("selfUpdateAllowed")
        else "package-manager"
        if manager_action
        else "external-installer",
        "managerCommand": copy.deepcopy(manager_action),
        "documentationUrl": value["documentationUrl"],
        "message": runtime_upgrade.user_message(
            reason_code,
            documentation_url=value["documentationUrl"],
            impact=impact,
        ),
        "manifest": value,
    }


def plan_download(
    manifest: Mapping[str, Any],
    *,
    current_version: str,
    source: Mapping[str, Any],
    cache_root: str | Path,
    allow_local_artifact: bool = False,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(value)
    if compare_product_versions(value["productVersion"], current_version) < 0:
        return {
            "schema": DOWNLOAD_PLAN_SCHEMA,
            "planId": _stable_id(
                "product-download-plan",
                {
                    "currentVersion": current_version,
                    "targetVersion": value["productVersion"],
                    "reasonCode": "downgrade-refused",
                },
            ),
            **_downgrade_refusal(value, current_version),
        }
    if not source.get("selfUpdateAllowed"):
        reason_code = "frontend-authority-external"
        return {
            "schema": DOWNLOAD_PLAN_SCHEMA,
            "planId": _stable_id(
                "product-download-plan",
                {
                    "runtimeBuildId": value["runtimeBuildId"],
                    "source": str(source.get("source")),
                },
            ),
            "state": "action-required",
            "reasonCode": reason_code,
            "managerCommand": copy.deepcopy(source.get("managerCommand")),
            "documentationUrl": value["documentationUrl"],
            "message": runtime_upgrade.user_message(
                reason_code,
                documentation_url=value["documentationUrl"],
                impact={
                    "activeWorkContinues": True,
                    "activationTiming": "owned-by-install-source",
                    "userActionRequired": True,
                },
            ),
        }
    artifact = _artifact(value, "cli")
    if not allow_local_artifact:
        _assert_cli_publication(value)
    parsed = urllib.parse.urlparse(artifact["url"])
    name = Path(parsed.path).name
    if not name or name in {".", ".."}:
        raise DistributionUpdateError(
            "artifact-url-invalid", "CLI artifact URL has no safe filename"
        )
    target = Path(cache_root).expanduser().resolve() / value["runtimeBuildId"] / name
    identity = {
        "runtimeBuildId": value["runtimeBuildId"],
        "artifactUrl": artifact["url"],
        "artifactSize": artifact["size"],
        "artifactDigest": artifact["digest"],
        "target": str(target),
    }
    return {
        "schema": DOWNLOAD_PLAN_SCHEMA,
        "planId": _stable_id("product-download-plan", identity),
        "state": "download-allowed",
        "reasonCode": "verified-release",
        "target": str(target),
        "artifact": artifact,
        "manifest": value,
        "documentationUrl": value["documentationUrl"],
    }


def _orchestration_plan_identity(plan: Mapping[str, Any]) -> dict[str, Any]:
    manifest = plan.get("manifest")
    source = plan.get("installSource")
    download_plan = plan.get("downloadPlan")
    if not isinstance(manifest, Mapping) or not isinstance(source, Mapping):
        raise DistributionUpdateError(
            "plan-invalid", "update orchestration plan is incomplete"
        )
    return {
        "channel": plan.get("channel"),
        "currentVersion": plan.get("currentVersion"),
        "targetVersion": plan.get("targetVersion"),
        "releasePayloadRoot": plan.get("releasePayloadRoot"),
        "releasePassport": plan.get("releasePassport"),
        "manifestRoot": f"sha256:{hashlib.sha256(_canonical(manifest)).hexdigest()}",
        "runtimeBuildId": manifest.get("runtimeBuildId"),
        "frontendBuildId": manifest.get("frontendBuildId"),
        "installSource": source.get("source"),
        "managerCommand": source.get("managerCommand"),
        "verificationCommand": source.get("verificationCommand"),
        "downloadPlanId": (
            download_plan.get("planId") if isinstance(download_plan, Mapping) else None
        ),
        "action": plan.get("action"),
        "state": plan.get("state"),
        "reasonCode": plan.get("reasonCode"),
        "impact": plan.get("impact"),
        "nextAction": plan.get("nextAction"),
    }


def _finish_orchestration_plan(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        **payload,
        "planId": _stable_id(
            "product-update-plan", _orchestration_plan_identity(payload)
        ),
    }


def plan_update(
    selection: Mapping[str, Any],
    *,
    current_version: str,
    source: Mapping[str, Any],
    cache_root: str | Path,
) -> dict[str, Any]:
    """Bind one verified channel selection to one executable update action."""

    entry = selection.get("entry")
    manifest = entry.get("manifest") if isinstance(entry, Mapping) else None
    release_passport = selection.get("releasePassport")
    if (
        selection.get("schema") != "kungfu.release-channel-selection/v1"
        or not isinstance(manifest, Mapping)
        or not isinstance(release_passport, Mapping)
        or not str(selection.get("payloadRoot") or "").startswith("sha256:")
    ):
        raise DistributionUpdateError(
            "channel-selection-invalid",
            "release channel selection is incomplete",
        )
    if (
        selection.get("channel") != manifest.get("releaseChannel")
        or selection.get("installSource") != source.get("source")
        or selection.get("targetVersion") != manifest.get("productVersion")
        or selection.get("currentVersion") != current_version
    ):
        raise DistributionUpdateError(
            "channel-selection-stale",
            "release channel selection no longer matches this installation",
        )
    checked = check_release(
        manifest,
        current_version=current_version,
        source=source,
        require_publication=True,
    )
    impact = {
        "activeWorkContinues": True,
        "activationTiming": "after-core-readiness",
        "userActionRequired": checked["state"] != "current",
    }
    common = {
        "schema": ORCHESTRATION_PLAN_SCHEMA,
        "channel": selection.get("channel"),
        "currentVersion": current_version,
        "targetVersion": checked["targetVersion"],
        "releasePayloadRoot": selection.get("payloadRoot"),
        "releasePassport": copy.deepcopy(selection.get("releasePassport")),
        "installSource": copy.deepcopy(dict(source)),
        "manifest": copy.deepcopy(dict(manifest)),
        "check": checked,
        "impact": impact,
        "documentationUrl": checked["documentationUrl"],
    }
    if checked["state"] == "current":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "current",
                "reasonCode": "already-current",
                "action": "none",
                "downloadPlan": None,
                "nextAction": "No action is required.",
            }
        )
    if checked["reasonCode"] == "downgrade-refused":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "action-required",
                "reasonCode": "downgrade-refused",
                "action": "recovery",
                "downloadPlan": None,
                "nextAction": "Use an explicit release recovery procedure.",
            }
        )
    if source.get("selfUpdateAllowed"):
        download_plan = plan_download(
            manifest,
            current_version=current_version,
            source=source,
            cache_root=cache_root,
        )
        return _finish_orchestration_plan(
            {
                **common,
                "state": "update-available",
                "reasonCode": "new-product-version",
                "action": "archive-self-update",
                "downloadPlan": download_plan,
                "nextAction": "Approve this exact plan to install beside current work.",
            }
        )
    if source.get("frontendAuthority") == "package-manager":
        if not source.get("managerCommand") or not source.get("verificationCommand"):
            return _finish_orchestration_plan(
                {
                    **common,
                    "state": "action-required",
                    "reasonCode": "manager-required",
                    "action": "package-manager",
                    "downloadPlan": None,
                    "nextAction": (
                        "Use a package that declares exact update and verification argv."
                    ),
                }
            )
        return _finish_orchestration_plan(
            {
                **common,
                "state": "update-available",
                "reasonCode": "new-product-version",
                "action": "package-manager",
                "downloadPlan": None,
                "nextAction": (
                    "Approve this exact plan to run the installed package command."
                ),
            }
        )
    if source.get("frontendAuthority") == "desktop-updater":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "action-required",
                "reasonCode": "desktop-required",
                "action": "desktop-companion",
                "downloadPlan": None,
                "nextAction": (
                    "Use the desktop updater; this CLI will not replace its frontend."
                ),
            }
        )
    return _finish_orchestration_plan(
        {
            **common,
            "state": "action-required",
            "reasonCode": "unsupported-source",
            "action": str(source.get("source") or "unknown"),
            "downloadPlan": None,
            "nextAction": "Follow the release installation instructions.",
        }
    )


def validate_update_plan(
    plan: Mapping[str, Any], *, expected_plan_id: str
) -> dict[str, Any]:
    if plan.get("schema") != ORCHESTRATION_PLAN_SCHEMA:
        raise DistributionUpdateError(
            "plan-invalid", "update orchestration plan schema is invalid"
        )
    observed_plan_id = _stable_id(
        "product-update-plan", _orchestration_plan_identity(plan)
    )
    if plan.get("planId") != expected_plan_id or observed_plan_id != expected_plan_id:
        raise DistributionUpdateError(
            "stale-plan", "update orchestration plan identity changed"
        )
    return copy.deepcopy(dict(plan))


def _orchestration_receipt_path(
    config_home: str | Path, plan_id: str, receipt_id: str
) -> Path:
    return (
        Path(config_home).expanduser().resolve()
        / "product"
        / "update"
        / "receipts"
        / _path_safe_id(plan_id, "plan-id")
        / f"{_path_safe_id(receipt_id, 'receipt-id')}.json"
    )


def record_update_outcome(
    plan: Mapping[str, Any],
    *,
    config_home: str | Path,
    state: str,
    reason_code: str,
    result: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if state not in {"complete", "cancelled", "failed"}:
        raise DistributionUpdateError(
            "receipt-state-invalid", "update receipt state is invalid"
        )
    plan_id = str(plan.get("planId") or "")
    validate_update_plan(plan, expected_plan_id=plan_id)
    recorded_at_ns = time.time_ns()
    recorded_at = (
        datetime.fromtimestamp(recorded_at_ns / 1_000_000_000, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    receipt_id = _stable_id(
        "product-update-receipt",
        {
            "planId": plan_id,
            "state": state,
            "reasonCode": reason_code,
            "recordedAtNs": str(recorded_at_ns),
            "processId": os.getpid(),
        },
    )
    path = _orchestration_receipt_path(config_home, plan_id, receipt_id)
    receipt_core = {
        "schema": ORCHESTRATION_RECEIPT_SCHEMA,
        "receiptId": receipt_id,
        "planId": plan_id,
        "state": state,
        "reasonCode": reason_code,
        "recordedAt": recorded_at,
        "recordedAtNs": str(recorded_at_ns),
        "channel": plan["channel"],
        "currentVersion": plan["currentVersion"],
        "targetVersion": plan["targetVersion"],
        "installSource": plan["installSource"]["source"],
        "releasePayloadRoot": plan["releasePayloadRoot"],
        "runtimeBuildId": plan["manifest"]["runtimeBuildId"],
        "frontendBuildId": plan["manifest"]["frontendBuildId"],
        "result": copy.deepcopy(dict(result)) if result is not None else None,
        "recoveryAction": (
            None
            if state == "complete"
            else "Run `kungfu update --check` before retrying the exact release."
        ),
    }
    receipt = {
        **receipt_core,
        "receiptRoot": _content_root(receipt_core),
        "receiptPath": str(path),
    }
    _write_object(path, receipt)
    return receipt


def _version_in_output(output: str, target_version: str) -> bool:
    pattern = re.compile(
        rf"(?<![0-9A-Za-z.+-]){re.escape(target_version)}(?![0-9A-Za-z.+-])"
    )
    return pattern.search(output) is not None


def _source_command_environment(
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    source = os.environ if env is None else env
    allowed = {
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOGNAME",
        "PATH",
        "PATHEXT",
        "SHELL",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "WINDIR",
    }
    return {key: value for key, value in source.items() if key in allowed}


def execute_update(
    plan: Mapping[str, Any],
    *,
    expected_plan_id: str,
    current_version: str,
    config_home: str | Path,
    command_runner: Any = subprocess.run,
    activation_planner: Any = None,
) -> dict[str, Any]:
    """Execute exactly one bound source-owned action and retain its receipt."""

    value = validate_update_plan(plan, expected_plan_id=expected_plan_id)
    if value["state"] != "update-available":
        raise DistributionUpdateError(
            "plan-not-applicable", "update orchestration plan is not executable"
        )
    try:
        if value["action"] == "archive-self-update":
            download_plan = value["downloadPlan"]
            download_receipt = download(
                download_plan,
                expected_plan_id=download_plan["planId"],
                execute=True,
            )
            applied = apply_archive(
                value["manifest"],
                download_receipt["artifactPath"],
                current_version=current_version,
                config_home=config_home,
                expected_digest=download_receipt["artifactDigest"],
                execute=True,
            )
            execution = {
                "action": "archive-self-update",
                "download": download_receipt,
                "apply": applied,
            }
        elif value["action"] == "package-manager":
            command, verification = _package_manager_commands(
                str(value["installSource"].get("source") or ""),
                value["installSource"].get("managerCommand"),
                value["installSource"].get("verificationCommand"),
            )
            if command is None or verification is None:
                raise DistributionUpdateError(
                    "package-manager-contract-incomplete",
                    "package-manager update plan is missing its exact local argv contract",
                )
            completed = command_runner(
                command,
                check=False,
                capture_output=True,
                env=_source_command_environment(),
                text=True,
                shell=False,
                timeout=_MANAGER_COMMAND_TIMEOUT_SECONDS,
            )
            if completed.returncode != 0:
                code, message = _package_manager_failure_code(completed.stderr)
                raise DistributionUpdateError(
                    code,
                    message,
                )
            verified = command_runner(
                verification,
                check=False,
                capture_output=True,
                env=_source_command_environment(),
                text=True,
                shell=False,
                timeout=_VERIFICATION_COMMAND_TIMEOUT_SECONDS,
            )
            if verified.returncode != 0 or not _version_in_output(
                str(verified.stdout), value["targetVersion"]
            ):
                raise DistributionUpdateError(
                    "update-verification-failed",
                    "package manager completed but the target version did not verify",
                )
            execution = {
                "action": "package-manager",
                "managerReturnCode": completed.returncode,
                "verificationReturnCode": verified.returncode,
                "verifiedVersion": value["targetVersion"],
            }
        else:
            raise DistributionUpdateError(
                "unsupported-source", "install source has no executable update adapter"
            )
        activation = (
            activation_planner(value["manifest"])
            if activation_planner is not None
            else None
        )
        return record_update_outcome(
            value,
            config_home=config_home,
            state="complete",
            reason_code="update-verified",
            result={**execution, "activationPlan": activation},
        )
    except DistributionUpdateError as error:
        error.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=error.code,
        )
        raise
    except runtime_upgrade.UpgradeError as error:
        wrapped = DistributionUpdateError(error.code, str(error))
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=error.code,
        )
        raise wrapped from error
    except subprocess.TimeoutExpired as error:
        wrapped = DistributionUpdateError(
            "update-command-timeout",
            "source-owned update command exceeded its bounded execution time",
        )
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=wrapped.code,
        )
        raise wrapped from error
    except OSError as error:
        code = (
            "package-manager-unavailable"
            if value.get("action") == "package-manager"
            else "update-command-unavailable"
        )
        wrapped = DistributionUpdateError(
            code,
            "source-owned update command could not be started",
        )
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=wrapped.code,
        )
        raise wrapped from error
    except KeyboardInterrupt as error:
        wrapped = DistributionUpdateError(
            "update-cancelled",
            "update cancelled before package-manager verification completed",
        )
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="cancelled",
            reason_code=wrapped.code,
        )
        raise wrapped from error


def _copy_bounded_download(
    input_file: Any,
    output_file: Any,
    *,
    expected_size: int,
    initial_size: int = 0,
) -> None:
    observed_size = initial_size
    while True:
        remaining = expected_size - observed_size
        if remaining < 0:
            raise DistributionUpdateError(
                "artifact-verification-failed",
                "CLI artifact exceeds the size declared by the release manifest",
            )
        chunk = input_file.read(min(_DOWNLOAD_CHUNK_BYTES, remaining + 1))
        if not chunk:
            return
        if len(chunk) > remaining:
            raise DistributionUpdateError(
                "artifact-verification-failed",
                "CLI artifact exceeds the size declared by the release manifest",
            )
        output_file.write(chunk)
        observed_size += len(chunk)


def _download_response_appends(
    response: Any,
    *,
    offset: int,
    expected_size: int,
) -> bool:
    _assert_https_response(
        response,
        code="artifact-transport-insecure",
        message="CLI artifact redirect requires HTTPS",
    )
    status = int(response.status)
    if status == 200:
        return False
    if status != 206 or offset <= 0:
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "CLI artifact server returned an unexpected download range",
        )
    content_range = str(response.getheader("Content-Range") or "")
    match = _CONTENT_RANGE.fullmatch(content_range)
    if match is None:
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "CLI artifact resume response has no exact content range",
        )
    start, end, total = (int(value) for value in match.groups())
    if start != offset or end < start or end >= expected_size or total != expected_size:
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "CLI artifact resume range differs from the cached bytes or manifest",
        )
    return True


def _download_to_partial(url: str, partial: Path, *, expected_size: int) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "file":
        source = Path(urllib.request.url2pathname(parsed.path)).resolve()
        if not source.is_file():
            raise DistributionUpdateError(
                "artifact-missing", f"CLI artifact is missing: {source}"
            )
        if source.stat().st_size != expected_size:
            raise DistributionUpdateError(
                "artifact-verification-failed",
                "CLI artifact size differs from the release manifest",
            )
        partial.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as input_file, partial.open("wb") as output_file:
            _copy_bounded_download(
                input_file,
                output_file,
                expected_size=expected_size,
            )
        return
    if parsed.scheme != "https":
        raise DistributionUpdateError(
            "artifact-transport-insecure", "CLI update artifact requires HTTPS"
        )
    offset = partial.stat().st_size if partial.is_file() else 0
    if offset > expected_size:
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "partial CLI artifact exceeds the size declared by the release manifest",
        )
    if offset == expected_size:
        return
    partial.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url)
    if offset:
        request.add_header("Range", f"bytes={offset}-")
    try:
        with _open_https(
            request,
            timeout=60,
            code="artifact-transport-insecure",
            message="CLI artifact redirect requires HTTPS",
        ) as response:
            append = _download_response_appends(
                response,
                offset=offset,
                expected_size=expected_size,
            )
            with partial.open("ab" if append else "wb") as output_file:
                _copy_bounded_download(
                    response,
                    output_file,
                    expected_size=expected_size,
                    initial_size=offset if append else 0,
                )
    except OSError as error:
        raise DistributionUpdateError(
            "artifact-download-failed", "CLI artifact download failed"
        ) from error


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _discard_poisoned_partial(partial: Path) -> None:
    try:
        partial.unlink()
    except FileNotFoundError:
        pass
    except OSError as error:
        raise DistributionUpdateError(
            "artifact-io-failed",
            "invalid partial CLI artifact could not be discarded",
        ) from error


def _stage_verified_archive(
    source: Path,
    target: Path,
    *,
    expected_size: int,
    expected_digest: str,
) -> None:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as input_file, target.open("xb") as output_file:
            _copy_bounded_download(
                input_file,
                output_file,
                expected_size=expected_size,
            )
        observed_size = target.stat().st_size
        observed_digest = _file_digest(target)
    except DistributionUpdateError:
        raise
    except OSError as error:
        raise DistributionUpdateError(
            "artifact-io-failed", "CLI archive could not be staged for extraction"
        ) from error
    if observed_size != expected_size or observed_digest != expected_digest:
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "CLI archive changed while being staged for extraction",
        )


def download(
    plan: Mapping[str, Any], *, expected_plan_id: str, execute: bool
) -> dict[str, Any]:
    if plan.get("schema") != DOWNLOAD_PLAN_SCHEMA:
        raise DistributionUpdateError("plan-invalid", "download plan schema is invalid")
    identity = {
        "runtimeBuildId": plan.get("manifest", {}).get("runtimeBuildId"),
        "artifactUrl": plan.get("artifact", {}).get("url"),
        "artifactSize": plan.get("artifact", {}).get("size"),
        "artifactDigest": plan.get("artifact", {}).get("digest"),
        "target": plan.get("target"),
    }
    current_plan_id = _stable_id("product-download-plan", identity)
    if plan.get("planId") != expected_plan_id or current_plan_id != expected_plan_id:
        raise DistributionUpdateError("stale-plan", "download plan identity changed")
    if plan.get("state") != "download-allowed":
        raise DistributionUpdateError(
            "plan-not-applicable", "install source does not allow self-update"
        )
    if not execute:
        return {**copy.deepcopy(dict(plan)), "executeRequired": True}
    target = Path(str(plan["target"])).resolve()
    partial = target.with_suffix(f"{target.suffix}.part")
    lock_root = target.parent / "locks"
    lock_id = _stable_id("product-download-target", {"target": str(target)})
    with (
        _CLI_DOWNLOAD_PROCESS_LOCK,
        coordination_locks.held(
            lock_root,
            lock_id,
            label=f"cli-product-download:{lock_id}",
        ),
    ):
        try:
            if target.is_symlink() or partial.is_symlink():
                raise DistributionUpdateError(
                    "artifact-path-unsafe",
                    "CLI download target must not be a symbolic link",
                )
            if target.is_file():
                observed_size = target.stat().st_size
                observed_digest = _file_digest(target)
                if (
                    observed_size != int(plan["artifact"]["size"])
                    or observed_digest != plan["artifact"]["digest"]
                ):
                    raise DistributionUpdateError(
                        "artifact-target-collision",
                        "download target already contains different bytes",
                    )
            else:
                expected_size = int(plan["artifact"]["size"])
                if partial.is_file() and partial.stat().st_size > expected_size:
                    _discard_poisoned_partial(partial)
                try:
                    _download_to_partial(
                        str(plan["artifact"]["url"]),
                        partial,
                        expected_size=expected_size,
                    )
                except DistributionUpdateError:
                    if partial.is_file() and partial.stat().st_size >= expected_size:
                        _discard_poisoned_partial(partial)
                    raise
                observed_size = partial.stat().st_size
                if observed_size != expected_size:
                    raise DistributionUpdateError(
                        "artifact-verification-failed",
                        "downloaded CLI artifact does not match size and digest evidence",
                    )
                observed_digest = _file_digest(partial)
                if observed_digest != plan["artifact"]["digest"]:
                    _discard_poisoned_partial(partial)
                    raise DistributionUpdateError(
                        "artifact-verification-failed",
                        "downloaded CLI artifact does not match size and digest evidence",
                    )
                os.replace(partial, target)
        except DistributionUpdateError:
            raise
        except OSError as error:
            raise DistributionUpdateError(
                "artifact-io-failed",
                "CLI artifact could not be written; check free space and permissions",
            ) from error
    receipt = {
        "schema": DOWNLOAD_RECEIPT_SCHEMA,
        "planId": expected_plan_id,
        "state": "complete",
        "reasonCode": "artifact-verified",
        "artifactPath": str(target),
        "artifactDigest": observed_digest,
        "runtimeBuildId": plan["manifest"]["runtimeBuildId"],
        "documentationUrl": plan["documentationUrl"],
    }
    return {**receipt, "receiptRoot": _content_root(receipt)}


def _safe_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    parts = Path(normalized).parts
    return bool(parts) and not normalized.startswith("/") and ".." not in parts


def _archive_expanded_limit(archive_size: int) -> int:
    return min(
        _MAX_ARCHIVE_EXPANDED_BYTES,
        max(
            _MIN_ARCHIVE_EXPANDED_BYTES,
            archive_size * _MAX_ARCHIVE_EXPANSION_RATIO,
        ),
    )


def _account_archive_member(
    *,
    count: int,
    expanded_size: int,
    member_size: int,
    expanded_limit: int,
) -> tuple[int, int]:
    count += 1
    if count > _MAX_ARCHIVE_ENTRIES:
        raise DistributionUpdateError(
            "archive-resource-limit", "CLI archive contains too many entries"
        )
    if member_size < 0 or expanded_size > expanded_limit - member_size:
        raise DistributionUpdateError(
            "archive-resource-limit",
            "CLI archive expands beyond the bounded extraction budget",
        )
    return count, expanded_size + member_size


def _assert_zip_member(info: zipfile.ZipInfo) -> None:
    if not _safe_member(info.filename):
        raise DistributionUpdateError(
            "archive-path-unsafe", "CLI archive contains an unsafe path"
        )
    mode = info.external_attr >> 16
    if mode & 0o170000 == 0o120000:
        raise DistributionUpdateError(
            "archive-link-unsupported",
            "CLI archive contains an unsupported symlink",
        )


def _assert_tar_member(member: tarfile.TarInfo) -> None:
    if (
        not _safe_member(member.name)
        or member.issym()
        or member.islnk()
        or not (member.isfile() or member.isdir())
    ):
        raise DistributionUpdateError(
            "archive-entry-unsupported",
            "CLI archive contains an unsafe or unsupported entry",
        )


def _validate_archive(archive: Path, *, archive_size: int) -> tuple[str, list[Any]]:
    expanded_limit = _archive_expanded_limit(archive_size)
    if zipfile.is_zipfile(archive):
        try:
            with zipfile.ZipFile(archive) as source:
                count = 0
                expanded_size = 0
                zip_members = source.infolist()
                for info in zip_members:
                    _assert_zip_member(info)
                    count, expanded_size = _account_archive_member(
                        count=count,
                        expanded_size=expanded_size,
                        member_size=0 if info.is_dir() else info.file_size,
                        expanded_limit=expanded_limit,
                    )
        except zipfile.BadZipFile as error:
            raise DistributionUpdateError(
                "archive-invalid", "CLI artifact is not a supported archive"
            ) from error
        return "zip", zip_members
    try:
        with tarfile.open(archive, "r:*") as source:
            count = 0
            expanded_size = 0
            tar_members: list[tarfile.TarInfo] = []
            for member in source:
                _assert_tar_member(member)
                count, expanded_size = _account_archive_member(
                    count=count,
                    expanded_size=expanded_size,
                    member_size=member.size if member.isfile() else 0,
                    expanded_limit=expanded_limit,
                )
                tar_members.append(member)
    except tarfile.TarError as error:
        raise DistributionUpdateError(
            "archive-invalid", "CLI artifact is not a supported archive"
        ) from error
    return "tar", tar_members


def _extract_archive(
    archive: Path,
    target: Path,
    *,
    archive_type: str,
    members: list[Any],
) -> None:
    if archive_type == "zip":
        try:
            with zipfile.ZipFile(archive) as source:
                source.extractall(target, members=members)
        except zipfile.BadZipFile as error:
            raise DistributionUpdateError(
                "archive-invalid", "CLI artifact is not a supported archive"
            ) from error
        return
    try:
        with tarfile.open(archive, "r:*") as source:
            source.extractall(target, members=members, filter="data")
    except tarfile.TarError as error:
        raise DistributionUpdateError(
            "archive-invalid", "CLI artifact is not a supported archive"
        ) from error


_IDENTITY_FIELDS = (
    "schema",
    "productVersion",
    "releaseChannel",
    "sourceCommit",
    "runtimeBuildId",
    "runtimeArtifactDigest",
    "runtimeEntrypoint",
    "frontendBuildId",
    "controlProtocolRange",
    "peerWireProtocolRange",
    "journalSchemaReadRange",
    "journalSchemaWriteVersion",
    "migrationClass",
    "rollbackClass",
    "minimumSupportedFrontend",
    "minimumSupportedRuntime",
    "platform",
    "architecture",
)


def _install_cli_image(
    product_root: Path,
    product: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    artifact_digest: str,
    config_home: str | Path,
) -> dict[str, Any]:
    entries = product.get("entries")
    if not isinstance(entries, Mapping):
        raise DistributionUpdateError(
            "product-layout-invalid", "CLI product entries are missing"
        )
    executable_relative = str(entries.get("runtime") or "")
    manifest_relative = str(entries.get("upgradeManifest") or "")
    if not executable_relative or not manifest_relative:
        raise DistributionUpdateError(
            "product-layout-invalid", "CLI product launch entries are missing"
        )
    frontend_build_id = str(manifest["frontendBuildId"])
    target = _cli_image_root(config_home, frontend_build_id)
    lock_root = _cli_inventory_root(config_home) / "locks"
    with coordination_locks.held(
        lock_root,
        frontend_build_id,
        label=f"cli-product-install:{frontend_build_id}",
    ):
        record_path = target / "image.json"
        if record_path.is_file():
            record = _read_object(record_path)
            if (
                record.get("schema") != CLI_IMAGE_SCHEMA
                or record.get("artifactDigest") != artifact_digest
            ):
                raise DistributionUpdateError(
                    "frontend-build-id-collision",
                    "CLI frontend build id already names different archive bytes",
                )
            return record
        staging = target.with_name(
            f".{frontend_build_id}.{os.getpid()}.{time.time_ns()}.partial"
        )
        try:
            shutil.copytree(product_root, staging)
            executable = (staging / executable_relative).resolve()
            bundled_manifest = (staging / manifest_relative).resolve()
            if (
                staging.resolve() not in executable.parents
                or not executable.is_file()
                or staging.resolve() not in bundled_manifest.parents
                or not bundled_manifest.is_file()
            ):
                raise DistributionUpdateError(
                    "product-layout-invalid",
                    "CLI executable or bundled upgrade manifest escapes the product image",
                )
            record = {
                "schema": CLI_IMAGE_SCHEMA,
                "frontendBuildId": frontend_build_id,
                "runtimeBuildId": manifest["runtimeBuildId"],
                "productVersion": manifest["productVersion"],
                "artifactDigest": artifact_digest,
                "productRoot": str(target),
                "executable": executable_relative,
                "productManifest": "product.json",
                "upgradeManifest": manifest_relative,
            }
            _write_object(staging / "image.json", record)
            os.replace(staging, target)
            return record
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def _read_cli_selection(
    config_home: str | Path,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    selection_path = _cli_selection_path(config_home)
    if not selection_path.is_file():
        return None
    selection = _read_object(selection_path)
    if selection.get("schema") != CLI_SELECTION_SCHEMA:
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection schema is invalid"
        )
    frontend_build_id = _path_safe_id(
        str(selection.get("frontendBuildId") or ""), "frontend-build-id"
    )
    root = _cli_image_root(config_home, frontend_build_id)
    if Path(str(selection.get("productRoot") or "")).resolve() != root:
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection escaped the product inventory"
        )
    generation = selection.get("generation")
    if generation is not None and (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
    ):
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection generation is invalid"
        )
    image = _read_object(root / "image.json")
    if (
        image.get("schema") != CLI_IMAGE_SCHEMA
        or image.get("frontendBuildId") != frontend_build_id
        or image.get("artifactDigest") != selection.get("artifactDigest")
        or image.get("runtimeBuildId") != selection.get("runtimeBuildId")
        or Path(str(image.get("productRoot") or "")).resolve() != root
    ):
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection and image evidence disagree"
        )
    return selection, image


def _select_cli_image(
    image: Mapping[str, Any], *, config_home: str | Path
) -> dict[str, Any]:
    lock_root = _cli_inventory_root(config_home) / "locks"
    with _CLI_SELECTION_PROCESS_LOCK:
        with coordination_locks.held(
            lock_root,
            "current-selection",
            label="cli-product-select:current",
        ):
            current = _read_cli_selection(config_home)
            if current is not None:
                current_selection, current_image = current
                version_order = compare_product_versions(
                    str(current_image["productVersion"]),
                    str(image["productVersion"]),
                )
                if version_order > 0:
                    return current_selection
                if version_order == 0:
                    if (
                        current_image["frontendBuildId"] != image["frontendBuildId"]
                        or current_image["artifactDigest"] != image["artifactDigest"]
                    ):
                        raise DistributionUpdateError(
                            "frontend-version-collision",
                            "one CLI product version names different image evidence",
                        )
                    return current_selection
            previous = current[0] if current is not None else None
            generation = int((previous or {}).get("generation") or 0) + 1
            rollback = (
                {
                    "frontendBuildId": previous["frontendBuildId"],
                    "runtimeBuildId": previous["runtimeBuildId"],
                    "artifactDigest": previous["artifactDigest"],
                    "productRoot": previous["productRoot"],
                }
                if previous is not None
                else None
            )
            selection = {
                "schema": CLI_SELECTION_SCHEMA,
                "generation": generation,
                "frontendBuildId": image["frontendBuildId"],
                "runtimeBuildId": image["runtimeBuildId"],
                "artifactDigest": image["artifactDigest"],
                "productRoot": image["productRoot"],
                "previousFrontendBuildId": (
                    previous["frontendBuildId"] if previous is not None else None
                ),
                "rollback": rollback,
            }
            try:
                _write_object(_cli_selection_path(config_home), selection)
            except OSError as error:
                raise DistributionUpdateError(
                    "selection-io-failed",
                    "CLI selection could not be published; the prior selection remains authoritative",
                ) from error
            return selection


def cli_inventory_fsck(config_home: str | Path) -> dict[str, Any]:
    """Inspect the archive CLI inventory without mutating or cleaning it."""

    root = _cli_inventory_root(config_home)
    images_root = root / "images"
    images: list[dict[str, Any]] = []
    retained_partials: list[str] = []
    issues: list[dict[str, str]] = []
    if images_root.is_dir():
        for entry in sorted(images_root.iterdir(), key=lambda value: value.name):
            relative = str(entry.relative_to(root))
            if entry.name.startswith(".") and entry.name.endswith(".partial"):
                retained_partials.append(relative)
                continue
            try:
                if entry.is_symlink() or not entry.is_dir():
                    raise DistributionUpdateError(
                        "cli-image-path-unsafe",
                        "CLI image inventory entry is not a real directory",
                    )
                image = _read_object(entry / "image.json")
                frontend_build_id = _path_safe_id(
                    str(image.get("frontendBuildId") or ""),
                    "frontend-build-id",
                )
                if (
                    image.get("schema") != CLI_IMAGE_SCHEMA
                    or frontend_build_id != entry.name
                    or Path(str(image.get("productRoot") or "")).resolve()
                    != entry.resolve()
                ):
                    raise DistributionUpdateError(
                        "cli-image-invalid",
                        "CLI image identity or product root is invalid",
                    )
                executable = (entry / str(image.get("executable") or "")).resolve()
                bundled_manifest = (
                    entry / str(image.get("upgradeManifest") or "")
                ).resolve()
                if (
                    entry.resolve() not in executable.parents
                    or not executable.is_file()
                    or entry.resolve() not in bundled_manifest.parents
                    or not bundled_manifest.is_file()
                ):
                    raise DistributionUpdateError(
                        "cli-image-invalid",
                        "CLI image executable or release manifest is missing or unsafe",
                    )
                images.append(
                    {
                        "frontendBuildId": frontend_build_id,
                        "runtimeBuildId": image["runtimeBuildId"],
                        "productVersion": image["productVersion"],
                        "artifactDigest": image["artifactDigest"],
                        "productRoot": image["productRoot"],
                    }
                )
            except (
                DistributionUpdateError,
                KeyError,
                OSError,
                TypeError,
                ValueError,
            ) as error:
                issues.append(
                    {
                        "code": getattr(error, "code", "cli-image-unreadable"),
                        "path": relative,
                    }
                )
    selection = None
    try:
        selected = _read_cli_selection(config_home)
        if selected is not None:
            selection = selected[0]
    except DistributionUpdateError as error:
        issues.append(
            {
                "code": error.code,
                "path": str(_cli_selection_path(config_home).relative_to(root)),
            }
        )
    return {
        "schema": CLI_INVENTORY_FSCK_SCHEMA,
        "ok": not issues,
        "selected": selection,
        "images": images,
        "retainedPartials": retained_partials,
        "issues": issues,
        "recoveryAction": (
            None
            if not issues
            else "Keep the last known-good image and rerun `kungfu update --check` before recovery."
        ),
    }


def selected_cli_command(
    env: Mapping[str, str] | None = None,
    *,
    current_executable: str | Path | None = None,
) -> tuple[list[str], dict[str, str]] | None:
    """Resolve an archive-selected CLI image for the stable bootstrap process."""

    env = os.environ if env is None else env
    if env.get("KUNGFU_INSTALL_SOURCE") != "archive":
        return None
    config_home = Path(env.get("KF_CONFIG_HOME") or "~/.kungfu-config").expanduser()
    selected = _read_cli_selection(config_home)
    if selected is None:
        return None
    selection, image = selected
    frontend_build_id = str(selection["frontendBuildId"])
    root = _cli_image_root(config_home, frontend_build_id)
    executable = (root / str(image.get("executable") or "")).resolve()
    if root not in executable.parents or not executable.is_file():
        raise DistributionUpdateError(
            "cli-selection-invalid", "selected CLI executable is missing or unsafe"
        )
    current = Path(current_executable or sys.executable).resolve()
    if (
        current == executable
        or env.get("KUNGFU_SELECTED_FRONTEND_BUILD_ID") == frontend_build_id
    ):
        return None
    selected_env = dict(env)
    selected_env.update(
        {
            "KUNGFU_SELECTED_FRONTEND_BUILD_ID": frontend_build_id,
            "KUNGFU_PRODUCT_MANIFEST": str(root / image["productManifest"]),
            "KUNGFU_UPGRADE_MANIFEST": str(root / image["upgradeManifest"]),
        }
    )
    return [str(executable), *sys.argv[1:]], selected_env


def reexec_selected_cli() -> None:
    selected = selected_cli_command()
    if selected is not None:
        argv, env = selected
        os.execve(argv[0], argv, env)


def apply_archive(
    manifest: Mapping[str, Any],
    archive: str | Path,
    *,
    current_version: str,
    config_home: str | Path,
    expected_digest: str,
    execute: bool,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(value)
    if compare_product_versions(value["productVersion"], current_version) < 0:
        return {
            "schema": APPLY_SCHEMA,
            **_downgrade_refusal(value, current_version),
        }
    _assert_cli_publication(value)
    artifact = _artifact(value, "cli")
    archive_path = Path(archive).expanduser().resolve()
    try:
        observed_size = archive_path.stat().st_size
        observed_digest = _file_digest(archive_path)
    except OSError as error:
        raise DistributionUpdateError(
            "artifact-io-failed", "CLI archive could not be read"
        ) from error
    if (
        observed_size != int(artifact["size"])
        or expected_digest != artifact["digest"]
        or observed_digest != expected_digest
    ):
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "CLI archive size or digest is stale or invalid",
        )
    if not execute:
        _validate_archive(archive_path, archive_size=observed_size)
        return {
            "schema": APPLY_SCHEMA,
            "state": "action-required",
            "reasonCode": "execute-required",
            "runtimeBuildId": value["runtimeBuildId"],
            "artifactPath": str(archive_path),
            "artifactDigest": observed_digest,
            "executeRequired": True,
            "documentationUrl": value["documentationUrl"],
        }
    with tempfile.TemporaryDirectory(prefix="kungfu-cli-apply-") as tmp:
        root = Path(tmp)
        snapshot = root / "snapshot" / "archive"
        _stage_verified_archive(
            archive_path,
            snapshot,
            expected_size=observed_size,
            expected_digest=observed_digest,
        )
        archive_type, archive_members = _validate_archive(
            snapshot, archive_size=observed_size
        )
        contents = root / "contents"
        contents.mkdir()
        _extract_archive(
            snapshot,
            contents,
            archive_type=archive_type,
            members=archive_members,
        )
        product_files = list(contents.glob("*/product.json"))
        if len(product_files) != 1:
            raise DistributionUpdateError(
                "product-layout-invalid", "CLI archive has no unique product root"
            )
        product_root = product_files[0].parent
        product = _read_object(product_files[0])
        if product.get("schema") != "kungfu.product.cli/v1":
            raise DistributionUpdateError(
                "product-layout-invalid", "CLI product manifest schema is invalid"
            )
        entries = product.get("entries")
        if not isinstance(entries, Mapping):
            raise DistributionUpdateError(
                "product-layout-invalid", "CLI product entries are missing"
            )
        runtime_root = (product_root / str(entries.get("runtime", ""))).parent
        bundled_path = product_root / str(entries.get("upgradeManifest", ""))
        bundled = runtime_upgrade.validate_manifest(_read_object(bundled_path))
        if any(bundled[field] != value[field] for field in _IDENTITY_FIELDS):
            raise DistributionUpdateError(
                "release-identity-mismatch",
                "CLI archive and release manifest describe different builds",
            )
        install_plan = runtime_upgrade.plan_install(bundled, runtime_root, config_home)
        if install_plan["state"] != "download-allowed":
            raise DistributionUpdateError(
                "runtime-artifact-invalid", "bundled runtime digest is invalid"
            )
        image = runtime_upgrade.install_image(
            install_plan,
            expected_plan_id=install_plan["planId"],
            config_home=config_home,
        )
        frontend_image = _install_cli_image(
            product_root,
            product,
            bundled,
            artifact_digest=observed_digest,
            config_home=config_home,
        )
        selection = _select_cli_image(frontend_image, config_home=config_home)
    receipt = {
        "schema": APPLY_SCHEMA,
        "state": "complete",
        "reasonCode": "runtime-installed",
        "runtimeImage": image,
        "frontendImage": frontend_image,
        "frontendSelection": selection,
        "frontendAction": "selected-on-next-command",
        "documentationUrl": value["documentationUrl"],
    }
    return {**receipt, "receiptRoot": _content_root(receipt)}
