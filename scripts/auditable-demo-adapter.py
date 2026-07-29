#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Project the exact retained Linux product artifact into demo evidence."""

from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import hashlib
import json
import os
import posixpath
import pty
import re
import select
import signal
import shutil
import struct
import subprocess
import tarfile
import tempfile
import termios
import time
from pathlib import Path, PurePosixPath
from typing import Any

ARCHIVE_NAME = "kungfu-episodes-cli-linux-x64.tar.gz"
ARCHIVE_ROOT = "kungfu-episodes-cli-linux-x64"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024
MAX_MEMBERS = 100_000
EPISODE_RELEASE_EVIDENCE = "qualification/episode-release-evidence.json"
PULL_MERGE_REF = re.compile(r"^refs/pull/[1-9][0-9]*/merge$")
COMPLETION_SENTINEL = re.compile(r"KUNGFU_TUI_DEMO_COMPLETE ([^\r\n]+)")
TERMINAL_COLUMNS = 120
TERMINAL_ROWS = 36
TERMINAL_TIMEOUT_SECONDS = 60
TERMINAL_EVENT_QUANTUM_MS = 20
MAX_TERMINAL_BYTES = 4 * 1024 * 1024
MAX_TERMINAL_EVENTS = 10_000
ANSI_OSC = re.compile(r"\x1b\].*?(?:\x07|\x1b\\)", re.DOTALL)
ANSI_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_ESCAPE = re.compile(r"\x1b[@-_]")

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


def canonical_evidence_digest(path: Path) -> str:
    script = r"""
const crypto = require("node:crypto");
const fs = require("node:fs");
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}
const evidence = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
delete evidence.evidence_digest;
const canonical = JSON.stringify(sortValue(evidence));
process.stdout.write(`sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`);
"""
    result = subprocess.run(
        ["node", "-e", script, str(path)],
        text=True,
        encoding="utf-8",
        errors="strict",
        capture_output=True,
        timeout=10,
        check=False,
    )
    if result.returncode != 0 or not SHA256.fullmatch(result.stdout):
        fail("Episode release evidence canonical digest could not be verified")
    return result.stdout


def qualified_source_revision(release_root: Path, coordinate_source: str) -> str:
    evidence_path = release_root / EPISODE_RELEASE_EVIDENCE
    if not evidence_path.exists():
        return coordinate_source
    evidence = read_json(evidence_path, EPISODE_RELEASE_EVIDENCE)
    evidence_source = evidence.get("source", {}).get("revision")
    if evidence_source == coordinate_source:
        return coordinate_source
    evidence_tree = evidence.get("source", {}).get("tree")
    ci = evidence.get("ci")
    gates = evidence.get("qualification", {}).get("hard_gates")
    trust_report = evidence.get("trust_report")
    if (
        evidence.get("schema") != "kungfu.episode.release-evidence/v1"
        or evidence.get("verdict") != "qualified"
        or not SHA40.fullmatch(str(evidence_source))
        or not SHA40.fullmatch(str(evidence_tree))
        or evidence.get("source", {}).get("dirty") is not False
        or not isinstance(ci, dict)
        or ci.get("provider") != "github-actions"
        or ci.get("sha") != coordinate_source
        or ci.get("source_sha") != coordinate_source
        or ci.get("source_tree_sha") != evidence_tree
        or not PULL_MERGE_REF.fullmatch(str(ci.get("ref", "")))
        or not isinstance(trust_report, dict)
        or trust_report.get("source_revision") != evidence_source
        or trust_report.get("source_dirty") is not False
        or not isinstance(gates, list)
        or not gates
        or any(
            not isinstance(row, dict) or row.get("passed") is not True for row in gates
        )
    ):
        fail(
            "Episode release evidence does not prove a qualified pull-merge tree equivalence"
        )
    source_gates = [row for row in gates if row.get("id") == "ci_source_revision"]
    expected_gate_evidence = (
        f"ci={coordinate_source} expected={evidence_source} "
        f"ci_tree={evidence_tree} expected_tree={evidence_tree} "
        "mode=tree-equivalent-pull-merge"
    )
    if (
        len(source_gates) != 1
        or source_gates[0].get("evidence") != expected_gate_evidence
        or not SHA256.fullmatch(str(evidence.get("evidence_digest", "")))
        or canonical_evidence_digest(evidence_path) != evidence.get("evidence_digest")
    ):
        fail("Episode release evidence tree-equivalence seal is invalid")
    return str(evidence_source)


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
    if not (member.isfile() or member.isdir() or member.issym()):
        fail(f"unsupported CLI archive member type: {name!r}")
    if member.issym():
        linkname = member.linkname
        if not linkname or linkname.startswith("/") or "\\" in linkname:
            fail(f"unsafe CLI archive symlink target: {name!r} -> {linkname!r}")
        normalized = PurePosixPath(
            posixpath.normpath(str(PurePosixPath(name).parent / linkname))
        )
        if (
            not normalized.parts
            or normalized.parts[0] != ARCHIVE_ROOT
            or ".." in normalized.parts
        ):
            fail(f"unsafe CLI archive symlink target: {name!r} -> {linkname!r}")
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
            extracted_bytes = sum(member.size for member in members)
            if extracted_bytes > MAX_EXTRACTED_BYTES:
                fail("CLI archive exceeds the bounded extracted size")
            symlinks = []
            for member in members:
                destination = target.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                if member.issym():
                    symlinks.append((member, destination))
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    fail(f"cannot read CLI archive member: {member.name}")
                with destination.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                os.chmod(destination, member.mode & 0o777)
            for member, destination in symlinks:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.symlink_to(member.linkname)
            extracted_root = (target / ARCHIVE_ROOT).resolve()
            for member, destination in symlinks:
                try:
                    resolved = destination.resolve(strict=True)
                    resolved.relative_to(extracted_root)
                except (OSError, RuntimeError, ValueError):
                    fail(
                        "CLI archive symlink does not resolve inside the product: "
                        f"{member.name!r} -> {member.linkname!r}"
                    )
                if not resolved.is_file():
                    fail(
                        "CLI archive symlink must resolve to a regular file: "
                        f"{member.name!r} -> {member.linkname!r}"
                    )
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


def safe_terminal_output(raw: bytes) -> str:
    if b"\x00" in raw:
        fail("kungfu terminal output contains NUL")
    if len(raw) > MAX_TERMINAL_BYTES:
        fail("kungfu terminal output exceeds the bounded output size")
    try:
        decoded = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        fail(f"kungfu terminal output is not valid UTF-8: {error}")
    private_patterns = (
        r"/home/runner/",
        r"/home/[^/\s]+/",
        r"/Users/[^/\s]+/",
        r"[A-Za-z]:\\Users\\[^\\\s]+\\",
        r"(?i)(token|password|secret|cookie)\s*=",
        r"(?i)\b(?:authorization|proxy-authorization):\s*(?:bearer|basic)\s+\S+",
        r"\bgh[pousr]_[A-Za-z0-9]{20,}\b",
        r"\bgithub_pat_[A-Za-z0-9_]{20,}\b",
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
    )
    for pattern in private_patterns:
        if re.search(pattern, decoded):
            fail(
                "kungfu terminal output contains a private path or credential-shaped value"
            )
    return decoded


def isolated_environment(home: Path) -> dict[str, str]:
    home.mkdir(parents=True, exist_ok=False)
    return {
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
        "NO_COLOR": "0",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
    }


def terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=2)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)


def validate_completion(decoded: str) -> dict[str, Any]:
    matches = COMPLETION_SENTINEL.findall(decoded)
    if len(matches) != 1:
        fail(
            "installed kungfu autoplay must emit exactly one "
            "KUNGFU_TUI_DEMO_COMPLETE sentinel"
        )
    try:
        completion = json.loads(matches[0])
    except json.JSONDecodeError as error:
        fail(f"installed kungfu autoplay completion sentinel is invalid JSON: {error}")
    if not isinstance(completion, dict):
        fail("installed kungfu autoplay completion sentinel must be an object")
    exact_keys(
        completion,
        {"schema", "status", "reportRoot", "eventCount"},
        set(),
        "completion sentinel",
    )
    if (
        completion["schema"] != "kungfu.agent-work-lab.tui-autoplay/v1"
        or completion["status"] != "passed"
        or not SHA256.fullmatch(str(completion["reportRoot"]))
        or not isinstance(completion["eventCount"], int)
        or isinstance(completion["eventCount"], bool)
        or completion["eventCount"] < 1
        or completion["eventCount"] > 100_000
    ):
        fail("installed kungfu autoplay completion sentinel did not pass")
    return completion


def run_autoplay(launcher: Path, home: Path) -> tuple[dict[str, Any], bytes, int]:
    environment = isolated_environment(home)
    master_fd, slave_fd = pty.openpty()
    fcntl.ioctl(
        slave_fd,
        termios.TIOCSWINSZ,
        struct.pack("HHHH", TERMINAL_ROWS, TERMINAL_COLUMNS, 0, 0),
    )
    process: subprocess.Popen[bytes] | None = None
    raw = bytearray()
    events: list[dict[str, Any]] = []
    first_output_at: float | None = None
    started_at = time.monotonic()
    timed_out = False
    try:
        process = subprocess.Popen(
            [str(launcher), "agent-work-lab", "autoplay"],
            cwd=home,
            env=environment,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = -1
        while True:
            now = time.monotonic()
            if now - started_at > TERMINAL_TIMEOUT_SECONDS:
                timed_out = True
                terminate_process_group(process)
                break
            readable, _, _ = select.select([master_fd], [], [], 0.05)
            if readable:
                try:
                    chunk = os.read(master_fd, 65_536)
                except OSError as error:
                    if error.errno == errno.EIO and process.poll() is not None:
                        break
                    raise
                if not chunk and process.poll() is not None:
                    break
                if chunk:
                    if first_output_at is None:
                        first_output_at = time.monotonic()
                    raw.extend(chunk)
                    if len(raw) > MAX_TERMINAL_BYTES:
                        terminate_process_group(process)
                        fail(
                            "installed kungfu autoplay exceeded the 4 MiB capture bound"
                        )
                    observed_ms = max(
                        0,
                        int((time.monotonic() - first_output_at) * 1000),
                    )
                    at_ms = (
                        observed_ms // TERMINAL_EVENT_QUANTUM_MS
                    ) * TERMINAL_EVENT_QUANTUM_MS
                    encoded = base64.b64encode(chunk).decode("ascii")
                    if events and events[-1]["atMs"] == at_ms:
                        previous = base64.b64decode(events[-1]["data"], validate=True)
                        events[-1]["data"] = base64.b64encode(previous + chunk).decode(
                            "ascii"
                        )
                    else:
                        events.append({"atMs": at_ms, "data": encoded})
                    if len(events) > MAX_TERMINAL_EVENTS:
                        terminate_process_group(process)
                        fail(
                            "installed kungfu autoplay exceeded the 10000-event "
                            "capture bound"
                        )
            if process.poll() is not None and not readable:
                break
        if timed_out:
            fail(
                f"installed kungfu autoplay exceeded {TERMINAL_TIMEOUT_SECONDS} seconds"
            )
        exit_code = process.wait(timeout=2)
    finally:
        if process is not None:
            terminate_process_group(process)
        if slave_fd >= 0:
            os.close(slave_fd)
        os.close(master_fd)
    if not events:
        fail("installed kungfu autoplay produced no PTY output")
    decoded = safe_terminal_output(bytes(raw))
    completion = validate_completion(decoded)
    if exit_code != 0:
        fail(f"installed kungfu autoplay failed with exit status {exit_code}")
    last_event_ms = events[-1]["atMs"]
    if last_event_ms >= TERMINAL_TIMEOUT_SECONDS * 1000:
        fail("installed kungfu autoplay capture reached the terminal time bound")
    duration_ms = min(
        60_000,
        max(500, ((last_event_ms + 500 + 999) // 1000) * 1000),
    )
    capture = {
        "schema": "kungfu.terminal-capture/v1",
        "command": "kungfu agent-work-lab autoplay",
        "dimensions": {
            "columns": TERMINAL_COLUMNS,
            "rows": TERMINAL_ROWS,
        },
        "durationMs": duration_ms,
        "encoding": "base64",
        "events": events,
        "completion": completion,
        "exitCode": exit_code,
        "authority": {
            "classification": "volatile-terminal-observation",
            "grants": [],
            "nonAuthorities": [
                "first-party-identity",
                "system-identity",
                "kfd-compliance",
                "product-system-metadata",
                "package-metadata",
                "registry-history",
                "scan-output",
                "standalone-generation",
            ],
        },
    }
    return capture, bytes(raw), exit_code


def transcript_lines(
    *,
    coordinate: dict[str, Any],
    archive_digest: str,
    executable_digest: str,
    product_version: str,
    terminal_output: str,
    capture: dict[str, Any],
    exit_code: int,
) -> list[str]:
    visible = ANSI_OSC.sub("", terminal_output)
    visible = ANSI_CSI.sub("", visible)
    visible = ANSI_ESCAPE.sub("", visible)
    visible = re.sub(r"\r+\n", "\n", visible).replace("\r", "\n")
    visible = "".join(
        character
        for character in visible
        if character in "\n\t" or ord(character) >= 0x20
    )
    lines = [
        "$ kungfu agent-work-lab autoplay",
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
        f"pty.columns={capture['dimensions']['columns']}",
        f"pty.rows={capture['dimensions']['rows']}",
        f"pty.event_count={len(capture['events'])}",
        f"pty.duration_ms={capture['durationMs']}",
        f"autoplay.report_root={capture['completion']['reportRoot']}",
        "authority.classification=volatile-terminal-observation",
        "authority.grants=none",
        "--- PTY stream (complete UTF-8; terminal controls removed) ---",
    ]
    lines.extend(visible.rstrip("\n").split("\n") if visible else [""])
    lines.append(f"exit.status={exit_code}")
    return lines


def build_projection(
    lines: list[str], capture: dict[str, Any], exit_code: int
) -> dict[str, Any]:
    if exit_code != 0:
        fail(f"installed kungfu autoplay failed with exit status {exit_code}")
    identity_end = 18
    output_start = 20
    exit_line = len(lines)
    output_lines = list(range(output_start, exit_line))
    if not output_lines:
        fail("installed kungfu autoplay produced no visible PTY transcript")
    first_output_lines = output_lines[:80]
    final_output_lines = (
        output_lines[-80:] if len(output_lines) > 80 else output_lines[-1:]
    )
    duration_ms = capture["durationMs"]
    first_boundary = max(1, duration_ms // 3)
    second_boundary = max(first_boundary + 1, (duration_ms * 2) // 3)
    return {
        "schema": "build-images.demo-projection/v1",
        "evidenceClass": "exact-installed-artifact-agent-work-lab-autoplay/v1",
        "claimBoundary": (
            "This proves one exact retained Linux x64 artifact completed the "
            "bundled offline Agent Work Lab autoplay inside a bounded, "
            "credential-free PTY. Terminal bytes are observation only and "
            "grant no authority. It does not prove hosted provider behavior, "
            "general production continuity, signed macOS behavior, "
            "performance, FO10, or production deployment."
        ),
        "cues": [
            {
                "startMs": 0,
                "endMs": first_boundary,
                "transcriptLines": list(range(1, identity_end + 1)),
                "annotation": (
                    "Exact artifact, executable, bounded PTY, and "
                    "observation-only authority identity."
                ),
            },
            {
                "startMs": first_boundary,
                "endMs": second_boundary,
                "transcriptLines": first_output_lines,
                "annotation": "Installed-product PTY stream with controls removed.",
            },
            {
                "startMs": second_boundary,
                "endMs": duration_ms,
                "transcriptLines": [*final_output_lines[-79:], exit_line],
                "annotation": (
                    "Passed completion sentinel and zero process exit; the "
                    "Release Passport remains the publication authority."
                ),
            },
        ],
    }


def write_outputs(
    output: Path,
    lines: list[str],
    projection: dict[str, Any],
    capture: dict[str, Any],
) -> None:
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        fail("adapter output must be an empty directory")
    output.mkdir(parents=True, exist_ok=True)
    (output / "complete-transcript.txt").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )
    (output / "public-projection.json").write_text(
        stable_json(projection), encoding="utf-8"
    )
    (output / "terminal-capture.json").write_text(
        stable_json(capture), encoding="utf-8"
    )
    scene = {
        "schema": "build-images.demo-scene/v1",
        "id": "kungfu-agent-work-lab-autoplay",
        "width": 1280,
        "height": 720,
        "fps": 15,
        "durationMs": capture["durationMs"],
        "title": "Kungfu Agent Work Lab — exact installed artifact",
        "commandLabel": "kungfu agent-work-lab autoplay",
        "background": "#0B1020",
        "accent": "#67E8A5",
    }
    (output / "scene.json").write_text(stable_json(scene), encoding="utf-8")


def adapt(artifact_root: Path, output: Path, source_coordinate: Path) -> None:
    coordinate = validate_coordinate(source_coordinate)
    release_root = find_release_root(artifact_root)
    qualified_source = qualified_source_revision(release_root, coordinate["sourceSha"])
    validate_reports(release_root, qualified_source)
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
            installed, archive, qualified_source
        )
        executable_digest = sha256_file(launcher)
        capture, raw_terminal_output, exit_code = run_autoplay(
            launcher, temporary_root / "home"
        )
        terminal_output = safe_terminal_output(raw_terminal_output)
        lines = transcript_lines(
            coordinate=coordinate,
            archive_digest=archive_digest,
            executable_digest=executable_digest,
            product_version=product_version,
            terminal_output=terminal_output,
            capture=capture,
            exit_code=exit_code,
        )
        write_outputs(
            output,
            lines,
            build_projection(lines, capture, exit_code),
            capture,
        )


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
