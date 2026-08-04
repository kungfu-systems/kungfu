# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any

from kungfu import runtime_upgrade
from kungfu.coordination import locks as coordination_locks

from kungfu.distribution_update_planning import (
    _finish_orchestration_plan as _finish_orchestration_plan,
    _orchestration_plan_identity as _orchestration_plan_identity,
    _orchestration_receipt_path as _orchestration_receipt_path,
    check_release as check_release,
    plan_download as plan_download,
    plan_update as plan_update,
    record_update_outcome as record_update_outcome,
    validate_update_plan as validate_update_plan,
)
from kungfu.distribution_update_policy import (
    APPLY_SCHEMA as APPLY_SCHEMA,
    CHECK_SCHEMA as CHECK_SCHEMA,
    CLI_IMAGE_SCHEMA as CLI_IMAGE_SCHEMA,
    CLI_INVENTORY_FSCK_SCHEMA as CLI_INVENTORY_FSCK_SCHEMA,
    CLI_ROLLBACK_SCHEMA as CLI_ROLLBACK_SCHEMA,
    CLI_SELECTION_SCHEMA as CLI_SELECTION_SCHEMA,
    DOWNLOAD_PLAN_SCHEMA as DOWNLOAD_PLAN_SCHEMA,
    DOWNLOAD_RECEIPT_SCHEMA as DOWNLOAD_RECEIPT_SCHEMA,
    MAX_MANIFEST_BYTES as MAX_MANIFEST_BYTES,
    ORCHESTRATION_PLAN_SCHEMA as ORCHESTRATION_PLAN_SCHEMA,
    ORCHESTRATION_RECEIPT_SCHEMA as ORCHESTRATION_RECEIPT_SCHEMA,
    UNQUALIFIED as UNQUALIFIED,
    DistributionUpdateError as DistributionUpdateError,
    _artifact as _artifact,
    _assert_cli_publication as _assert_cli_publication,
    _assert_release_target as _assert_release_target,
    _canonical as _canonical,
    _CLI_DOWNLOAD_PROCESS_LOCK as _CLI_DOWNLOAD_PROCESS_LOCK,
    _CLI_SELECTION_PROCESS_LOCK as _CLI_SELECTION_PROCESS_LOCK,
    _cli_image_root as _cli_image_root,
    _cli_inventory_root as _cli_inventory_root,
    _cli_selection_path as _cli_selection_path,
    _cli_selection_receipt_generations as _cli_selection_receipt_generations,
    _cli_selection_receipt_path as _cli_selection_receipt_path,
    _command_argv as _command_argv,
    _content_root as _content_root,
    _CONTENT_RANGE as _CONTENT_RANGE,
    _DOWNLOAD_CHUNK_BYTES as _DOWNLOAD_CHUNK_BYTES,
    _downgrade_refusal as _downgrade_refusal,
    _INSTALL_SOURCES as _INSTALL_SOURCES,
    _MANAGER_COMMAND_TIMEOUT_SECONDS as _MANAGER_COMMAND_TIMEOUT_SECONDS,
    _MAX_ARCHIVE_ENTRIES as _MAX_ARCHIVE_ENTRIES,
    _MAX_ARCHIVE_EXPANDED_BYTES as _MAX_ARCHIVE_EXPANDED_BYTES,
    _MAX_ARCHIVE_EXPANSION_RATIO as _MAX_ARCHIVE_EXPANSION_RATIO,
    _MIN_ARCHIVE_EXPANDED_BYTES as _MIN_ARCHIVE_EXPANDED_BYTES,
    _next_cli_generation as _next_cli_generation,
    _normalize_platform as _normalize_platform,
    _optional_file_digest as _optional_file_digest,
    _PACKAGE_MANAGER_COMMANDS as _PACKAGE_MANAGER_COMMANDS,
    _package_manager_commands as _package_manager_commands,
    _package_manager_failure_code as _package_manager_failure_code,
    _parse_product_version as _parse_product_version,
    _path_safe_id as _path_safe_id,
    _persist_cli_selection_receipt as _persist_cli_selection_receipt,
    _read_cli_selection_receipt as _read_cli_selection_receipt,
    _read_json_object as _read_json_object,
    _read_object as _read_object,
    _read_shifu_env as _read_shifu_env,
    _SEMVER as _SEMVER,
    _stable_id as _stable_id,
    _VERIFICATION_COMMAND_TIMEOUT_SECONDS as _VERIFICATION_COMMAND_TIMEOUT_SECONDS,
    _write_object as _write_object,
    compare_product_versions as compare_product_versions,
    install_source as install_source,
    local_dogfood_residency as local_dogfood_residency,
)

release_cut = runtime_upgrade


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
                cut_decision=value["check"].get("cutDecision"),
                cut_transition=value.get("cutTransition"),
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
    safe_symlink = False
    if member.issym():
        link_name = member.linkname.replace("\\", "/")
        target = PurePosixPath(member.name).parent / PurePosixPath(link_name)
        depth = 0
        safe_symlink = (
            bool(link_name)
            and not link_name.startswith("/")
            and re.match(r"^[A-Za-z]:", link_name) is None
        )
        for part in target.parts:
            if part in ("", "."):
                continue
            if part == "..":
                depth -= 1
                if depth < 0:
                    safe_symlink = False
                    break
            else:
                depth += 1
    if (
        not _safe_member(member.name)
        or member.islnk()
        or (member.issym() and not safe_symlink)
        or not (member.isfile() or member.isdir() or member.issym())
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
_CUT_IDENTITY_FIELDS = (
    "manifestIdentityRoot",
    "releaseCut",
    "releaseCutRoot",
    "platformSliceRoot",
)


def _installed_cli_manifest(
    image: Mapping[str, Any],
) -> dict[str, Any]:
    root = Path(str(image["productRoot"])).expanduser().resolve()
    manifest = (root / str(image["upgradeManifest"])).resolve()
    if root not in manifest.parents or not manifest.is_file():
        raise DistributionUpdateError(
            "cli-image-invalid",
            "installed CLI image has no safe upgrade manifest",
        )
    return runtime_upgrade.validate_manifest(_read_object(manifest))


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
            shutil.copytree(product_root, staging, symlinks=True)
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
            runtime_root = (staging / executable_relative).parent
            try:
                observed_runtime_digest = runtime_upgrade.tree_digest(runtime_root)
            except runtime_upgrade.UpgradeError as error:
                raise DistributionUpdateError(error.code, str(error)) from error
            if observed_runtime_digest != manifest["runtimeArtifactDigest"]:
                raise DistributionUpdateError(
                    "runtime-artifact-invalid",
                    "staged CLI runtime digest does not match the release manifest",
                )
            _write_object(bundled_manifest, manifest)
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
                **(
                    {
                        "manifestIdentityRoot": manifest["manifestIdentityRoot"],
                        "releaseCutRoot": manifest["releaseCutRoot"],
                        "platformSliceRoot": manifest["platformSliceRoot"],
                    }
                    if manifest.get("releaseCutRoot")
                    else {}
                ),
            }
            _write_object(staging / "image.json", record)
            os.replace(staging, target)
            return record
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def _assert_cli_image_slot_available(
    manifest: Mapping[str, Any],
    *,
    artifact_digest: str,
    config_home: str | Path,
) -> None:
    target = _cli_image_root(config_home, str(manifest["frontendBuildId"]))
    record_path = target / "image.json"
    if not record_path.is_file():
        return
    record = _read_object(record_path)
    if (
        record.get("schema") != CLI_IMAGE_SCHEMA
        or record.get("artifactDigest") != artifact_digest
    ):
        raise DistributionUpdateError(
            "frontend-build-id-collision",
            "CLI frontend build id already names different archive bytes",
        )


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
    generation = selection.get("generation")
    if generation is not None and (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
    ):
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection generation is invalid"
        )
    transition = selection.get("cutTransition")
    verified_transition = None
    if transition is not None:
        try:
            verified_transition = release_cut.validate_cut_transition(transition)
        except (TypeError, release_cut.ReleaseCutError) as error:
            raise DistributionUpdateError(
                "cli-selection-invalid",
                "CLI selection Cut Transition evidence is invalid",
            ) from error
        if verified_transition["cutTransitionRoot"] != selection.get(
            "cutTransitionRoot"
        ):
            raise DistributionUpdateError(
                "cli-selection-invalid",
                "CLI selection Cut Transition root disagrees with retained evidence",
            )
    if release_cut.is_legacy_bootstrap(selection):
        if not release_cut.legacy_selection_is_bound(selection, verified_transition):
            raise DistributionUpdateError(
                "cli-selection-invalid",
                "legacy bootstrap selection is not bound to exact recovery evidence",
            )
        return selection, {}
    frontend_build_id = _path_safe_id(
        str(selection.get("frontendBuildId") or ""), "frontend-build-id"
    )
    root = _cli_image_root(config_home, frontend_build_id)
    if Path(str(selection.get("productRoot") or "")).resolve() != root:
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection escaped the product inventory"
        )
    image = _read_object(root / "image.json")
    if (
        image.get("schema") != CLI_IMAGE_SCHEMA
        or image.get("frontendBuildId") != frontend_build_id
        or image.get("artifactDigest") != selection.get("artifactDigest")
        or image.get("runtimeBuildId") != selection.get("runtimeBuildId")
        or image.get("releaseCutRoot") != selection.get("releaseCutRoot")
        or image.get("platformSliceRoot") != selection.get("platformSliceRoot")
        or Path(str(image.get("productRoot") or "")).resolve() != root
    ):
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection and image evidence disagree"
        )
    return selection, image


def _select_cli_image(
    image: Mapping[str, Any],
    *,
    config_home: str | Path,
    cut_decision: Mapping[str, Any] | None = None,
    cut_transition: Mapping[str, Any] | None = None,
    bootstrap_rollback: Mapping[str, Any] | None = None,
    receipt_factory: Callable[[dict[str, Any]], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    lock_root = _cli_inventory_root(config_home) / "locks"
    with _CLI_SELECTION_PROCESS_LOCK:
        with coordination_locks.held(
            lock_root,
            "current-selection",
            label="cli-product-select:current",
        ):

            def finish_selection(
                selection: dict[str, Any],
            ) -> tuple[dict[str, Any], dict[str, Any]]:
                receipt = receipt_factory(selection)
                _persist_cli_selection_receipt(config_home, selection, receipt)
                try:
                    _write_object(_cli_selection_path(config_home), selection)
                except OSError as error:
                    raise DistributionUpdateError(
                        "selection-io-failed",
                        "CLI selection could not be published; the prior selection remains authoritative",
                    ) from error
                return selection, receipt

            current = _read_cli_selection(config_home)
            if current is not None:
                current_selection, current_image = current
                current_cut = current_selection.get("releaseCutRoot")
                target_cut = image.get("releaseCutRoot")
                cut_movement_authorized = False
                if current_cut is not None or target_cut is not None:
                    if not current_cut or not target_cut:
                        raise DistributionUpdateError(
                            "release-cut-binding-incomplete",
                            "CLI image transition mixes Cut-aware and legacy identities",
                        )
                    if current_cut != target_cut and (
                        not isinstance(cut_decision, Mapping)
                        or cut_decision.get("updateAllowed") is not True
                        or cut_decision.get("currentReleaseCutRoot") != current_cut
                        or cut_decision.get("targetReleaseCutRoot") != target_cut
                    ):
                        raise DistributionUpdateError(
                            "release-cut-transition-required",
                            "CLI image selection requires an authorized Cut Transition",
                        )
                    cut_movement_authorized = current_cut != target_cut
                    if current_cut == target_cut:
                        if (
                            current_image["frontendBuildId"] != image["frontendBuildId"]
                            or current_image["artifactDigest"]
                            != image["artifactDigest"]
                        ):
                            raise DistributionUpdateError(
                                "release-cut-image-collision",
                                "one Release Cut names different CLI image evidence",
                            )
                        return current_selection, None
                if not cut_movement_authorized:
                    version_order = compare_product_versions(
                        str(
                            current_image.get("productVersion")
                            or current_selection.get("productVersion")
                            or ""
                        ),
                        str(image["productVersion"]),
                    )
                    if version_order > 0:
                        return current_selection, None
                    if version_order == 0:
                        if (
                            current_image["frontendBuildId"] != image["frontendBuildId"]
                            or current_image["artifactDigest"]
                            != image["artifactDigest"]
                        ):
                            raise DistributionUpdateError(
                                "frontend-version-collision",
                                "one CLI product version names different image evidence",
                            )
                        else:
                            return current_selection, None
            previous = current[0] if current is not None else None
            generation = _next_cli_generation(
                config_home, int((previous or {}).get("generation") or 0)
            )
            if previous is None:
                rollback = bootstrap_rollback
            elif release_cut.is_legacy_bootstrap(previous):
                rollback = release_cut.legacy_coordinate(
                    previous["releaseCutRoot"], previous["productVersion"]
                )
            else:
                rollback = release_cut.image_coordinate(previous)
            selection = release_cut.image_selection(
                image,
                schema=CLI_SELECTION_SCHEMA,
                generation=generation,
                transition_root=(
                    cut_decision.get("cutTransitionRoot")
                    if isinstance(cut_decision, Mapping)
                    else None
                ),
                transition=cut_transition,
                previous_frontend_build_id=(
                    previous.get("frontendBuildId") if previous is not None else None
                ),
                rollback=rollback,
            )
            return finish_selection(selection)


def cli_inventory_fsck(config_home: str | Path) -> dict[str, Any]:
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
                        "releaseCutRoot": image.get("releaseCutRoot"),
                        "platformSliceRoot": image.get("platformSliceRoot"),
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
    selection = selected_receipt_root = None
    retained_receipts: list[dict[str, Any]] = []
    pending_receipts: list[dict[str, Any]] = []
    selection_path_exists = _cli_selection_path(config_home).is_file()
    try:
        selected = _read_cli_selection(config_home)
        if selected is not None:
            selection = selected[0]
            receipt = _read_cli_selection_receipt(config_home, selection)
            if receipt is not None:
                selected_receipt_root = receipt["receiptRoot"]
            elif selection.get("releaseCutRoot"):
                issues.append(
                    {
                        "code": "cli-selection-receipt-missing",
                        "path": str(
                            _cli_selection_receipt_path(
                                config_home, int(selection["generation"])
                            ).relative_to(root)
                        ),
                    }
                )
    except DistributionUpdateError as error:
        issues.append(
            {
                "code": error.code,
                "path": str(_cli_selection_path(config_home).relative_to(root)),
            }
        )
    selected_generation = int((selection or {}).get("generation") or 0)
    try:
        for generation in _cli_selection_receipt_generations(config_home):
            if generation == selected_generation:
                continue
            path = _cli_selection_receipt_path(config_home, generation)
            try:
                receipt = _read_object(path)
                receipt_selection = receipt.get("frontendSelection")
                receipt_root = receipt.get("receiptRoot")
                receipt_core = {
                    key: value for key, value in receipt.items() if key != "receiptRoot"
                }
                if (
                    not isinstance(receipt_selection, Mapping)
                    or int(receipt_selection.get("generation") or 0) != generation
                    or not isinstance(receipt_root, str)
                    or receipt_root != _content_root(receipt_core)
                ):
                    raise DistributionUpdateError(
                        "cli-selection-receipt-invalid",
                        "CLI selection receipt does not verify against its generation",
                    )
                retained = {
                    "generation": generation,
                    "receiptRoot": receipt_root,
                    "frontendBuildId": receipt_selection.get("frontendBuildId"),
                }
                retained_receipts.append(retained)
                if generation > selected_generation and (
                    selection is not None or not selection_path_exists
                ):
                    pending_receipts.append(retained)
                    issues.append(
                        {
                            "code": "cli-selection-publication-pending",
                            "path": str(path.relative_to(root)),
                        }
                    )
            except (DistributionUpdateError, OSError, TypeError, ValueError) as error:
                issues.append(
                    {
                        "code": getattr(error, "code", "cli-receipt-unreadable"),
                        "path": str(path.relative_to(root)),
                    }
                )
    except DistributionUpdateError as error:
        issues.append(
            {
                "code": error.code,
                "path": "receipts",
            }
        )
    return {
        "schema": CLI_INVENTORY_FSCK_SCHEMA,
        "ok": not issues,
        "selected": selection,
        "selectedReceiptRoot": selected_receipt_root,
        "images": images,
        "retainedPartials": retained_partials,
        "retainedReceipts": retained_receipts,
        "pendingReceipts": pending_receipts,
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
    if (selected := _read_cli_selection(config_home)) is None:
        return None
    selection, image = selected
    if release_cut.is_legacy_bootstrap(selection):
        return None
    frontend_build_id = str(selection["frontendBuildId"])
    root = _cli_image_root(config_home, frontend_build_id)
    executable = (root / str(image.get("executable") or "")).resolve()
    if root not in executable.parents or not executable.is_file():
        raise DistributionUpdateError(
            "cli-selection-invalid", "selected CLI executable is missing or unsafe"
        )
    current = Path(current_executable or sys.executable).resolve()
    selected_id = env.get("KUNGFU_SELECTED_FRONTEND_BUILD_ID")
    if current == executable or selected_id == frontend_build_id:
        return None
    selected_env = dict(env)
    selected_env.update(
        {
            "KUNGFU_SELECTED_FRONTEND_BUILD_ID": frontend_build_id,
            "KUNGFU_DIR": str(executable.parent),
            "KUNGFU_PRODUCT_MANIFEST": str(root / image["productManifest"]),
            "KUNGFU_UPGRADE_MANIFEST": str(root / image["upgradeManifest"]),
            "KF_BUNDLED_EXTENSION_ROOT": str(root / "extensions"),
            "KUNGFU_AGENT_SESSION_EXECUTABLE": str(executable),
            "KUNGFU_CONTROLLER_ENTRYPOINT": str(executable),
        }
    )
    if selection.get("releaseCutRoot"):
        selected_env["KUNGFU_SELECTED_RELEASE_CUT_ROOT"] = str(
            selection["releaseCutRoot"]
        )
        selected_env["KUNGFU_SELECTED_PLATFORM_SLICE_ROOT"] = str(
            selection["platformSliceRoot"]
        )
    return [str(executable), *sys.argv[1:]], selected_env


def reexec_selected_cli() -> None:
    selected = selected_cli_command()
    if selected is not None:
        argv, env = selected
        if sys.platform == "win32":
            # Keep the selected UI in the foreground so terminal ownership and
            # its exact exit status return through the archive controller.
            raise SystemExit(subprocess.run(argv, env=env, check=False).returncode)
        os.execve(argv[0], argv, env)


def apply_archive(
    manifest: Mapping[str, Any],
    archive: str | Path,
    *,
    current_version: str,
    config_home: str | Path,
    expected_digest: str,
    execute: bool,
    cut_decision: Mapping[str, Any] | None = None,
    cut_transition: Mapping[str, Any] | None = None,
    allow_shifu_local: bool = False,
    bootstrap_release_cut_root: str | None = None,
    bootstrap_version: str | None = None,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(value)
    if compare_product_versions(value["productVersion"], current_version) < 0:
        return {
            "schema": APPLY_SCHEMA,
            **_downgrade_refusal(value, current_version),
        }
    target_cut = value.get("releaseCut")
    verified_cut_decision = None
    if target_cut is not None:
        selected = _read_cli_selection(config_home)
        if selected is None:
            installed_cut = bootstrap_release_cut_root
            installed_version = bootstrap_version
        else:
            installed_cut = selected[0].get("releaseCutRoot")
            installed_version = selected[1].get("productVersion") or selected[0].get(
                "productVersion"
            )
        if not installed_cut or not installed_version:
            raise DistributionUpdateError(
                "current-release-cut-unknown",
                "Cut-aware CLI installation requires an exact current Release Cut",
            )
        try:
            verified_cut_decision = release_cut.decide_cut_transition(
                current_release_cut_root=str(installed_cut),
                current_version=str(installed_version),
                target_cut=target_cut,
                transition=cut_transition,
            )
        except release_cut.ReleaseCutError as error:
            raise DistributionUpdateError(error.code, str(error)) from error
        if cut_decision is not None and _canonical(verified_cut_decision) != _canonical(
            cut_decision
        ):
            raise DistributionUpdateError(
                "cut-decision-mismatch",
                "applied Cut Transition differs from the planned decision",
            )
        if verified_cut_decision["updateAllowed"] is not True:
            raise DistributionUpdateError(
                verified_cut_decision["reasonCode"],
                "Cut Transition does not authorize CLI image selection",
            )
        trust_domain = target_cut["publicationPolicy"]["trustDomain"]
        if trust_domain == "shifu-local":
            if not allow_shifu_local:
                raise DistributionUpdateError(
                    "local-release-policy-required",
                    "shifu-local artifacts require the explicit local updater adapter",
                )
            if (
                target_cut["publicationPolicy"]["publicationEligible"]
                or cut_transition is None
                or cut_transition["authorization"]["publicationEligible"]
            ):
                raise DistributionUpdateError(
                    "local-release-publication-eligible",
                    "local dogfood evidence cannot authorize public publication",
                )
        elif allow_shifu_local:
            raise DistributionUpdateError(
                "local-release-policy-mismatch",
                "the local updater adapter accepts only shifu-local Release Cuts",
            )
        else:
            _assert_cli_publication(value)
    elif allow_shifu_local:
        raise DistributionUpdateError(
            "local-release-cut-missing",
            "shifu-local installation requires a Product Release Cut",
        )
    else:
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
            "currentReleaseCutRoot": (
                verified_cut_decision.get("currentReleaseCutRoot")
                if verified_cut_decision
                else None
            ),
            "targetReleaseCutRoot": value.get("releaseCutRoot"),
            "cutTransitionRoot": (
                verified_cut_decision.get("cutTransitionRoot")
                if verified_cut_decision
                else None
            ),
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
        if any(bundled.get(field) != value.get(field) for field in _IDENTITY_FIELDS):
            raise DistributionUpdateError(
                "release-identity-mismatch",
                "CLI archive and release manifest describe different builds",
            )
        if value.get("manifestIdentityRoot") and (
            bundled.get("manifestIdentityRoot") != value["manifestIdentityRoot"]
            or release_cut.manifest_identity_root(bundled)
            != value["manifestIdentityRoot"]
        ):
            raise DistributionUpdateError(
                "release-manifest-identity-mismatch",
                "CLI archive bootstrap identity differs from the final Release Cut",
            )
        _assert_cli_image_slot_available(
            value,
            artifact_digest=observed_digest,
            config_home=config_home,
        )
        install_plan = runtime_upgrade.plan_install(value, runtime_root, config_home)
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
            value,
            artifact_digest=observed_digest,
            config_home=config_home,
        )

    def receipt_for_selection(selection: dict[str, Any]) -> dict[str, Any]:
        receipt = {
            "schema": APPLY_SCHEMA,
            "state": "complete",
            "reasonCode": "runtime-installed",
            "runtimeImage": image,
            "frontendImage": frontend_image,
            "frontendSelection": selection,
            "frontendAction": "selected-on-next-command",
            "currentReleaseCutRoot": (
                verified_cut_decision.get("currentReleaseCutRoot")
                if verified_cut_decision
                else None
            ),
            "targetReleaseCutRoot": value.get("releaseCutRoot"),
            "cutTransitionRoot": (
                verified_cut_decision.get("cutTransitionRoot")
                if verified_cut_decision
                else None
            ),
            "cutTransition": (
                copy.deepcopy(dict(cut_transition))
                if cut_transition is not None
                else None
            ),
            "documentationUrl": value["documentationUrl"],
        }
        return {**receipt, "receiptRoot": _content_root(receipt)}

    selection, receipt = _select_cli_image(
        frontend_image,
        config_home=config_home,
        cut_decision=verified_cut_decision or cut_decision,
        cut_transition=cut_transition,
        receipt_factory=receipt_for_selection,
        bootstrap_rollback=(
            release_cut.legacy_coordinate(bootstrap_release_cut_root, bootstrap_version)
            if bootstrap_release_cut_root and bootstrap_version
            else None
        ),
    )
    return receipt if receipt is not None else receipt_for_selection(selection)


def apply_shifu_local_archive(
    manifest: Mapping[str, Any],
    archive: str | Path,
    *,
    config_home: str | Path,
    expected_digest: str,
    evidence_roots: list[str],
    bootstrap_release_cut_root: str | None,
    bootstrap_version: str | None,
    execute: bool,
) -> dict[str, Any]:
    """Install one exact Shifu-selected local archive through native ownership."""

    value = runtime_upgrade.validate_manifest(manifest)
    target_cut = value.get("releaseCut")
    if (
        not isinstance(target_cut, Mapping)
        or target_cut.get("publicationPolicy", {}).get("trustDomain") != "shifu-local"
    ):
        raise DistributionUpdateError(
            "local-release-policy-mismatch",
            "Shifu local installation requires a publication-ineligible local Cut",
        )
    selected = _read_cli_selection(config_home)
    legacy_selection = selected is not None and release_cut.is_legacy_bootstrap(
        selected[0]
    )
    if selected is None or legacy_selection:
        if not bootstrap_release_cut_root or not bootstrap_version:
            raise DistributionUpdateError(
                "local-bootstrap-coordinate-required",
                "first Shifu local installation requires an exact legacy bootstrap coordinate",
            )
        current_release_cut_root = bootstrap_release_cut_root
        current_version = bootstrap_version
        if (
            selected is not None
            and legacy_selection
            and (
                selected[0].get("releaseCutRoot") != bootstrap_release_cut_root
                or selected[0].get("productVersion") != bootstrap_version
            )
        ):
            raise DistributionUpdateError(
                "stale-bootstrap-coordinate",
                "legacy bootstrap selection differs from the installed Product receipt",
            )
        current_manifest = None
        authorization_kind = "shifu-local-bootstrap"
    else:
        selection, image = selected
        if bootstrap_release_cut_root is not None or bootstrap_version is not None:
            raise DistributionUpdateError(
                "local-bootstrap-already-complete",
                "native CLI inventory already has an exact Release Cut",
            )
        current_release_cut_root = str(selection.get("releaseCutRoot") or "")
        current_version = str(image.get("productVersion") or "")
        current_manifest = _installed_cli_manifest(image)
        authorization_kind = "shifu-local-successor"
    try:
        cut_transition = release_cut.shifu_local_transition(
            current_release_cut_root=current_release_cut_root,
            current_version=current_version,
            current_manifest=current_manifest,
            target_manifest=value,
            authorization_kind=authorization_kind,
            evidence_roots=evidence_roots,
        )
    except release_cut.ReleaseCutError as error:
        raise DistributionUpdateError(error.code, str(error)) from error
    return apply_archive(
        value,
        archive,
        current_version=current_version,
        config_home=config_home,
        expected_digest=expected_digest,
        execute=execute,
        cut_transition=cut_transition,
        allow_shifu_local=True,
        bootstrap_release_cut_root=(
            current_release_cut_root if selected is None or legacy_selection else None
        ),
        bootstrap_version=(
            current_version if selected is None or legacy_selection else None
        ),
    )


def rollback_shifu_local_cli(
    *,
    config_home: str | Path,
    expected_current_release_cut_root: str,
    expected_rollback_release_cut_root: str,
    evidence_roots: list[str],
    execute: bool,
) -> dict[str, Any]:
    """Roll back native CLI selection without consulting the Shifu source cache."""

    current = _read_cli_selection(config_home)
    if current is None:
        raise DistributionUpdateError(
            "cli-selection-missing", "native CLI inventory has no selected image"
        )
    selection, current_image = current
    if selection.get("releaseCutRoot") != expected_current_release_cut_root:
        raise DistributionUpdateError(
            "stale-selection",
            "native CLI selection no longer matches the expected current Release Cut",
        )
    rollback = selection.get("rollback")
    if not isinstance(rollback, Mapping):
        raise DistributionUpdateError(
            "rollback-unavailable",
            "native CLI selection has no retained rollback image",
        )
    if rollback.get("releaseCutRoot") != expected_rollback_release_cut_root:
        raise DistributionUpdateError(
            "stale-rollback-coordinate",
            "retained rollback image no longer matches the expected Release Cut",
        )
    target_is_legacy = rollback.get("kind") == release_cut.LEGACY_BOOTSTRAP_MODE
    if target_is_legacy:
        target_image: dict[str, Any] = {}
        target_version = str(rollback.get("productVersion") or "")
        if not target_version:
            raise DistributionUpdateError(
                "rollback-coordinate-invalid",
                "legacy bootstrap rollback has no exact Product version",
            )
    else:
        target_root = _cli_image_root(
            config_home, str(rollback.get("frontendBuildId") or "")
        )
        target_image = _read_object(target_root / "image.json")
        if (
            target_image.get("schema") != CLI_IMAGE_SCHEMA
            or target_image.get("releaseCutRoot") != expected_rollback_release_cut_root
            or target_image.get("artifactDigest") != rollback.get("artifactDigest")
            or Path(str(target_image.get("productRoot") or "")).resolve() != target_root
        ):
            raise DistributionUpdateError(
                "rollback-image-invalid",
                "retained rollback image does not match the native inventory coordinate",
            )
        target_version = str(target_image["productVersion"])
    current_is_legacy = release_cut.is_legacy_bootstrap(selection)
    current_version = str(
        selection.get("productVersion")
        if current_is_legacy
        else current_image["productVersion"]
    )
    current_manifest = (
        None if current_is_legacy else _installed_cli_manifest(current_image)
    )
    try:
        if target_is_legacy:
            compatibility = selection.get("cutTransition", {}).get("compatibility")
            transition = release_cut.legacy_recovery_transition(
                current_release_cut_root=expected_current_release_cut_root,
                current_version=current_version,
                target_release_cut_root=expected_rollback_release_cut_root,
                target_version=target_version,
                compatibility=compatibility or {},
                evidence_roots=evidence_roots,
            )
        else:
            target_manifest = _installed_cli_manifest(target_image)
            transition = release_cut.shifu_local_transition(
                current_release_cut_root=expected_current_release_cut_root,
                current_version=current_version,
                current_manifest=current_manifest,
                target_manifest=target_manifest,
                authorization_kind="shifu-local-recovery",
                evidence_roots=evidence_roots,
                relation="recovery",
            )
    except release_cut.ReleaseCutError as error:
        raise DistributionUpdateError(error.code, str(error)) from error
    plan = {
        "schema": CLI_ROLLBACK_SCHEMA,
        "state": "action-required" if not execute else "ready",
        "reasonCode": "execute-required" if not execute else "rollback-authorized",
        "currentReleaseCutRoot": expected_current_release_cut_root,
        "targetReleaseCutRoot": expected_rollback_release_cut_root,
        "cutTransitionRoot": transition["cutTransitionRoot"],
        "cutTransition": transition,
        "currentFrontendBuildId": current_image.get("frontendBuildId"),
        "targetFrontendBuildId": target_image.get("frontendBuildId"),
        "activeWorkPolicy": "keep-pinned",
        "sourceCacheRequired": False,
    }
    if not execute:
        return {**plan, "executeRequired": True}

    lock_root = _cli_inventory_root(config_home) / "locks"
    with _CLI_SELECTION_PROCESS_LOCK:
        with coordination_locks.held(
            lock_root,
            "current-selection",
            label="cli-product-select:rollback",
        ):
            observed = _read_cli_selection(config_home)
            if (
                observed is None
                or observed[0].get("releaseCutRoot")
                != expected_current_release_cut_root
                or observed[0].get("generation") != selection.get("generation")
            ):
                raise DistributionUpdateError(
                    "stale-selection",
                    "native CLI selection changed after rollback planning",
                )
            generation = _next_cli_generation(
                config_home, int(selection.get("generation") or 0)
            )
            reverse_rollback = (
                release_cut.legacy_coordinate(
                    selection["releaseCutRoot"], selection["productVersion"]
                )
                if current_is_legacy
                else release_cut.image_coordinate(current_image)
            )
            if target_is_legacy:
                next_selection = release_cut.legacy_selection(
                    schema=CLI_SELECTION_SCHEMA,
                    generation=generation,
                    release_cut_root=expected_rollback_release_cut_root,
                    product_version=target_version,
                    transition=transition,
                    previous_frontend_build_id=current_image.get("frontendBuildId"),
                    rollback=reverse_rollback,
                )
            else:
                next_selection = release_cut.image_selection(
                    target_image,
                    schema=CLI_SELECTION_SCHEMA,
                    generation=generation,
                    transition_root=transition["cutTransitionRoot"],
                    transition=transition,
                    previous_frontend_build_id=current_image.get("frontendBuildId"),
                    rollback=reverse_rollback,
                )
            receipt = {
                **plan,
                "state": "complete",
                "reasonCode": "rollback-selected-on-next-command",
                "executeRequired": False,
                "frontendSelection": next_selection,
            }
            rooted_receipt = {**receipt, "receiptRoot": _content_root(receipt)}
            _persist_cli_selection_receipt(config_home, next_selection, rooted_receipt)
            _write_object(_cli_selection_path(config_home), next_selection)
    return rooted_receipt
