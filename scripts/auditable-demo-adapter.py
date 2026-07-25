#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Project the exact retained Linux product artifact into demo evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

ARCHIVE_NAME = "kungfu-episodes-cli-linux-x64.tar.gz"
ARCHIVE_ROOT = "kungfu-episodes-cli-linux-x64"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 100_000

REPORTS = (
    (
        "qualification/layer-qualification-summary.json",
        "kungfu.layer-qualification-summary/v1",
        "status",
        "passed",
    ),
    (
        "qualification/live-peer-continuity/report.json",
        "kungfu.runtime.live-peer-continuity-qualification/v1",
        "verdict",
        "passed",
    ),
    (
        "qualification/runtime-activation/report.json",
        "kungfu.runtime-activation.qualification-report/v1",
        "verdict",
        "passed",
    ),
    (
        "qualification/zero-burden-desktop/report.json",
        "kungfu.zero-burden-desktop.qualification/v1",
        "verdict",
        "passed",
    ),
    (
        "qualification/invariant-run.json",
        "kungfu.invariant-run/v1",
        "summary.verdict",
        "verified",
    ),
)


class AdapterError(RuntimeError):
    """Fail-closed adapter contract violation."""


def fail(message: str) -> None:
    raise AdapterError(message)


def canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def stable_json(value: Any) -> str:
    return json.dumps(canonical(value), indent=2, ensure_ascii=False) + "\n"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} is missing")
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular non-symlink file")
    if metadata.st_size > MAX_JSON_BYTES:
        fail(f"{label} exceeds {MAX_JSON_BYTES} bytes")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid UTF-8 JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{label} root must be an object")
    return value


def exact_keys(
    value: dict[str, Any], required: set[str], optional: set[str], label: str
) -> None:
    unknown = sorted(set(value) - required - optional)
    missing = sorted(required - set(value))
    if unknown:
        fail(f"{label} has undeclared keys: {', '.join(unknown)}")
    if missing:
        fail(f"{label} is missing keys: {', '.join(missing)}")


def nested(value: dict[str, Any], dotted: str, label: str) -> Any:
    current: Any = value
    for key in dotted.split("."):
        if not isinstance(current, dict) or key not in current:
            fail(f"{label}.{dotted} is missing")
        current = current[key]
    return current


def source_revision(report: dict[str, Any]) -> str:
    candidates = [
        report.get("sourceRevision"),
        nested(report, "reuse.tuple.sourceRevision", "report")
        if report.get("schema") == "kungfu.layer-qualification-summary/v1"
        else None,
        report.get("source", {}).get("revision")
        if isinstance(report.get("source"), dict)
        else None,
    ]
    values = [value for value in candidates if isinstance(value, str)]
    if len(values) != 1 or not SHA40.fullmatch(values[0]):
        fail("qualification report must bind exactly one 40-character source revision")
    return values[0]


def validate_coordinate(path: Path) -> dict[str, Any]:
    coordinate = read_json(path, "source coordinate")
    exact_keys(
        coordinate,
        {
            "schema",
            "repository",
            "runId",
            "runAttempt",
            "sourceSha",
            "id",
            "nodeId",
            "name",
            "digest",
            "sizeInBytes",
            "createdAt",
            "expiresAt",
        },
        set(),
        "source coordinate",
    )
    if coordinate["schema"] != "buildchain.github-artifact-coordinate/v1":
        fail("unsupported source coordinate schema")
    if coordinate["repository"] != "kungfu-systems/kungfu":
        fail("source artifact repository is not kungfu-systems/kungfu")
    if not SHA40.fullmatch(str(coordinate["sourceSha"])):
        fail("source coordinate sourceSha is invalid")
    if not SHA256.fullmatch(str(coordinate["digest"])):
        fail("source coordinate digest is not immutable")
    expected_name = f"kungfu-linux-x64-{coordinate['sourceSha']}"
    if coordinate["name"] != expected_name:
        fail(
            f"source artifact name must be {expected_name!r}, got {coordinate['name']!r}"
        )
    for field in ("runId", "runAttempt", "id"):
        if not re.fullmatch(r"[1-9][0-9]*", str(coordinate[field])):
            fail(f"source coordinate {field} is invalid")
    return coordinate


def find_release_root(artifact_root: Path) -> Path:
    matches = sorted(
        path.parent.parent
        for path in artifact_root.rglob(
            "qualification/layer-qualification-summary.json"
        )
        if path.is_file()
        and not path.is_symlink()
        and path.parent.name == "qualification"
    )
    unique = sorted(set(matches))
    if len(unique) != 1:
        fail(
            "source artifact must contain exactly one product/release qualification "
            f"root, found {len(unique)}"
        )
    return unique[0]


def validate_reports(release_root: Path, expected_source: str) -> list[dict[str, str]]:
    evidence = []
    for relative, schema, verdict_path, expected_verdict in REPORTS:
        path = release_root / relative
        report = read_json(path, relative)
        if report.get("schema") != schema:
            fail(f"{relative} has unsupported schema {report.get('schema')!r}")
        if nested(report, verdict_path, relative) != expected_verdict:
            fail(f"{relative} did not pass")
        observed_source = source_revision(report)
        if observed_source != expected_source:
            fail(
                f"{relative} source mismatch: expected {expected_source}, "
                f"observed {observed_source}"
            )
        evidence.append(
            {
                "path": relative,
                "schema": schema,
                "sha256": sha256_file(path),
                "verdict": expected_verdict,
            }
        )
    return evidence


def validate_member(member: tarfile.TarInfo) -> None:
    name = member.name
    parts = PurePosixPath(name).parts
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or ".." in parts
        or not parts
        or parts[0] != ARCHIVE_ROOT
    ):
        fail(f"unsafe CLI archive member path: {name!r}")
    if not (member.isfile() or member.isdir()):
        fail(f"unsupported CLI archive member type: {name!r}")
    if member.size < 0 or member.size > MAX_MEMBER_BYTES:
        fail(f"CLI archive member exceeds the bounded size: {name!r}")


def extract_cli(archive_path: Path, target: Path) -> Path:
    metadata = archive_path.lstat()
    if archive_path.is_symlink() or not archive_path.is_file():
        fail("CLI archive must be a regular non-symlink file")
    if metadata.st_size > MAX_ARCHIVE_BYTES:
        fail("CLI archive exceeds the bounded size")
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if not members or len(members) > MAX_MEMBERS:
                fail("CLI archive has an invalid member count")
            for member in members:
                validate_member(member)
            for member in members:
                destination = target.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    fail(f"cannot read CLI archive member: {member.name}")
                with destination.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                os.chmod(destination, member.mode & 0o777)
    except (tarfile.TarError, OSError) as error:
        fail(f"cannot extract CLI archive: {error}")
    return target / ARCHIVE_ROOT


def resolve_entry(root: Path, relative: Any, label: str) -> Path:
    if (
        not isinstance(relative, str)
        or not relative
        or Path(relative).is_absolute()
        or "\\" in relative
        or ".." in PurePosixPath(relative).parts
    ):
        fail(f"{label} is not an exact product-relative path")
    resolved = root.joinpath(*PurePosixPath(relative).parts).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        fail(f"{label} escapes the installed product")
    if not resolved.is_file() or resolved.is_symlink():
        fail(f"{label} must resolve to a regular non-symlink file")
    return resolved


def validate_product(
    root: Path, archive_path: Path, expected_source: str
) -> tuple[Path, str]:
    product = read_json(root / "product.json", "installed product.json")
    if (
        product.get("schema") != "kungfu.product.cli/v1"
        or product.get("product") != "cli"
        or product.get("platform") != "linux-x64"
        or product.get("archive") != ARCHIVE_NAME
    ):
        fail("installed product identity does not describe the Linux x64 Kungfu CLI")
    entries = product.get("entries")
    if not isinstance(entries, dict):
        fail("installed product entries must be an object")
    launcher = resolve_entry(root, entries.get("kungfu"), "entries.kungfu")
    compatibility_path = resolve_entry(
        root, entries.get("compatibility"), "entries.compatibility"
    )
    upgrade_path = resolve_entry(
        root, entries.get("upgradeManifest"), "entries.upgradeManifest"
    )
    compatibility = read_json(compatibility_path, "installed compatibility")
    if (
        compatibility.get("schema") != "kungfu.product.compatibility/v1"
        or compatibility.get("source_commit") != expected_source
        or compatibility.get("platform") != "linux-x64"
    ):
        fail("installed compatibility identity does not match the source artifact")
    versions = compatibility.get("versions")
    if not isinstance(versions, dict) or not isinstance(versions.get("product"), str):
        fail("installed compatibility has no product version")
    upgrade = read_json(upgrade_path, "installed upgrade manifest")
    if (
        upgrade.get("schema") != "kungfu.product-upgrade.manifest/v1"
        or upgrade.get("sourceCommit") != expected_source
        or upgrade.get("productVersion") != versions["product"]
        or upgrade.get("platform") != "linux"
        or upgrade.get("architecture") != "x64"
    ):
        fail("installed upgrade identity does not match the source artifact")
    return launcher, versions["product"]


def safe_output(text: str, label: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if "\x00" in normalized:
        fail(f"{label} contains NUL")
    if len(normalized.encode("utf-8")) > 2 * 1024 * 1024:
        fail(f"{label} exceeds the bounded output size")
    private_patterns = (
        r"/home/runner/",
        r"/Users/[^/\s]+/",
        r"[A-Za-z]:\\Users\\[^\\\s]+\\",
        r"(?i)(token|password|secret|cookie)\s*=",
    )
    for pattern in private_patterns:
        if re.search(pattern, normalized):
            fail(f"{label} contains a private path or credential-shaped value")
    return normalized


def run_brief(launcher: Path, home: Path) -> tuple[str, str, int]:
    home.mkdir(parents=True, exist_ok=False)
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(home),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "KF_HOME": str(home / "kungfu"),
        "KF_CONFIG_HOME": str(home / "config"),
        "KF_RUNTIME_DIR": str(home / "kungfu/runtime"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        "CI": "true",
        "SOURCE_DATE_EPOCH": "0",
    }
    result = subprocess.run(
        [str(launcher), "agent", "brief"],
        cwd=home,
        env=environment,
        text=True,
        encoding="utf-8",
        errors="strict",
        capture_output=True,
        timeout=120,
        check=False,
    )
    return (
        safe_output(result.stdout, "kungfu stdout"),
        safe_output(result.stderr, "kungfu stderr"),
        result.returncode,
    )


def transcript_lines(
    *,
    coordinate: dict[str, Any],
    archive_digest: str,
    executable_digest: str,
    product_version: str,
    stdout: str,
    stderr: str,
    exit_code: int,
) -> list[str]:
    lines = [
        "$ kungfu agent brief",
        f"artifact.repository={coordinate['repository']}",
        f"artifact.run_id={coordinate['runId']}",
        f"artifact.name={coordinate['name']}",
        f"artifact.upload_digest={coordinate['digest']}",
        f"artifact.source_sha={coordinate['sourceSha']}",
        "install.method=safe-tar-extract",
        f"install.archive={ARCHIVE_NAME}",
        f"install.archive_digest={archive_digest}",
        f"install.executable_digest={executable_digest}",
        f"product.version={product_version}",
        "--- stdout (complete) ---",
    ]
    lines.extend(stdout.rstrip("\n").split("\n") if stdout else [""])
    lines.append("--- stderr (complete) ---")
    lines.extend(stderr.rstrip("\n").split("\n") if stderr else [""])
    lines.append(f"exit.status={exit_code}")
    return lines


def build_projection(lines: list[str], exit_code: int) -> dict[str, Any]:
    if exit_code != 0:
        fail(f"installed kungfu agent brief failed with exit status {exit_code}")
    identity_end = 11
    stdout_start = 13
    stderr_marker = lines.index("--- stderr (complete) ---") + 1
    stdout_end = stderr_marker - 1
    exit_line = len(lines)
    stdout_lines = list(range(stdout_start, stdout_end + 1))
    if not stdout_lines:
        fail("installed kungfu agent brief produced no stdout")
    midpoint = min(len(stdout_lines), max(1, len(stdout_lines) // 2))
    return {
        "schema": "build-images.demo-projection/v1",
        "evidenceClass": "exact-installed-artifact-agent-brief/v1",
        "claimBoundary": (
            "This proves the exact retained Linux x64 artifact can expose its "
            "bundled agent brief in an isolated credential-free Home. It does "
            "not prove continuity, provider behavior, signed macOS behavior, "
            "production durability, comparative performance, or FO10."
        ),
        "cues": [
            {
                "startMs": 0,
                "endMs": 4000,
                "transcriptLines": list(range(1, identity_end + 1)),
                "annotation": "Observed artifact and executable identity.",
            },
            {
                "startMs": 4000,
                "endMs": 10000,
                "transcriptLines": stdout_lines[:midpoint],
                "annotation": "Literal installed-product stdout.",
            },
            {
                "startMs": 10000,
                "endMs": 15000,
                "transcriptLines": stdout_lines[midpoint:] or stdout_lines[-1:],
                "annotation": "Literal installed-product stdout continued.",
            },
            {
                "startMs": 15000,
                "endMs": 18000,
                "transcriptLines": [exit_line],
                "annotation": "Observed process exit status; scene chrome is design annotation.",
            },
        ],
    }


def write_outputs(output: Path, lines: list[str], projection: dict[str, Any]) -> None:
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        fail("adapter output must be an empty directory")
    output.mkdir(parents=True, exist_ok=True)
    (output / "complete-transcript.txt").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )
    (output / "public-projection.json").write_text(
        stable_json(projection), encoding="utf-8"
    )
    scene = {
        "schema": "build-images.demo-scene/v1",
        "id": "kungfu-agent-brief-artifact",
        "width": 1280,
        "height": 720,
        "fps": 15,
        "durationMs": 18000,
        "title": "Kungfu — exact installed artifact",
        "commandLabel": "kungfu agent brief",
        "background": "#0B1020",
        "accent": "#67E8A5",
    }
    (output / "scene.json").write_text(stable_json(scene), encoding="utf-8")


def adapt(artifact_root: Path, output: Path, source_coordinate: Path) -> None:
    coordinate = validate_coordinate(source_coordinate)
    release_root = find_release_root(artifact_root)
    validate_reports(release_root, coordinate["sourceSha"])
    archives = sorted(
        path
        for path in release_root.rglob(ARCHIVE_NAME)
        if path.is_file() and not path.is_symlink()
    )
    if len(archives) != 1:
        fail(f"source artifact must contain exactly one {ARCHIVE_NAME}")
    archive = archives[0]
    archive_digest = sha256_file(archive)
    with tempfile.TemporaryDirectory(prefix="kungfu-auditable-demo-") as temporary:
        temporary_root = Path(temporary)
        installed = extract_cli(archive, temporary_root / "installed")
        launcher, product_version = validate_product(
            installed, archive, coordinate["sourceSha"]
        )
        executable_digest = sha256_file(launcher)
        stdout, stderr, exit_code = run_brief(launcher, temporary_root / "home")
        lines = transcript_lines(
            coordinate=coordinate,
            archive_digest=archive_digest,
            executable_digest=executable_digest,
            product_version=product_version,
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
        )
        write_outputs(output, lines, build_projection(lines, exit_code))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-coordinate", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        adapt(
            args.artifact_root.resolve(),
            args.output.resolve(),
            args.source_coordinate.resolve(),
        )
    except (AdapterError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(f"auditable demo adapter: {error}") from error


if __name__ == "__main__":
    main()
