# SPDX-License-Identifier: Apache-2.0

"""Own bounded HTTPS download and safe archive materialization."""

from __future__ import annotations

import copy
import hashlib
import os
import re
import tarfile
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any

from kungfu.coordination import locks as coordination_locks
from kungfu.distribution_update_policy import (
    DOWNLOAD_PLAN_SCHEMA,
    DOWNLOAD_RECEIPT_SCHEMA,
    DistributionUpdateError,
    _CLI_DOWNLOAD_PROCESS_LOCK,
    _CONTENT_RANGE,
    _DOWNLOAD_CHUNK_BYTES,
    _MAX_ARCHIVE_ENTRIES,
    _MAX_ARCHIVE_EXPANDED_BYTES,
    _MAX_ARCHIVE_EXPANSION_RATIO,
    _MIN_ARCHIVE_EXPANDED_BYTES,
    _content_root,
    _stable_id,
)


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
