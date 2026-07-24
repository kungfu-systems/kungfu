# SPDX-License-Identifier: Apache-2.0

"""Installed-product qualification for the KFD Agent Hub profile."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import kungfu

from kungfu.agent.agent_hub import semantic_root


QUALIFICATION_SCHEMA = "kungfu.kfd-agent-hub-qualification/v1"
VERIFICATION_SCHEMA = "kungfu.kfd-agent-hub-qualification-verification/v1"
WHAT_WAS_TESTED = [
    "Two independently rooted local Hub identities",
    "Capability and profile negotiation",
    "Delivery separated from receiver admission",
    "Duplicate and idempotency-conflict handling",
    "Delegated authority attenuation and revocation",
    "Visible concurrent and reconnect conflicts",
    "Partial, intentionally withheld, and unavailable knowledge",
    "Completion that requires evidence instead of command success",
    "Content-bound export/import and root-drift rejection",
]
MEANING = (
    "This Kungfu installation can act as the tested local KFD Agent Hub and "
    "exchange bounded Work with another independently rooted local Hub."
)
NON_CLAIMS = [
    "KFD certification",
    "security assessment",
    "production fitness",
    "remote-network interoperability",
    "external vendor adoption",
    "stable or public release status",
    "support for an unobserved platform or artifact",
]


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _regular(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.is_symlink():
        raise ValueError(f"{label} must resolve to a regular file: {path}")
    return resolved


def resolve_kfd_entry(override: str | Path | None = None) -> Path:
    selected = override or os.environ.get("KUNGFU_KFD_ENTRY")
    if selected:
        return _regular(Path(selected), "KFD entry")
    binding_dir = Path(kungfu.__binding__.__file__).resolve().parent
    candidates = [
        binding_dir.parent / "node_modules/@kungfu-tech/kfd/bin/kfd.mjs",
        binding_dir / "node_modules/@kungfu-tech/kfd/bin/kfd.mjs",
    ]
    candidates.extend(
        parent / "node_modules/@kungfu-tech/kfd/bin/kfd.mjs"
        for parent in binding_dir.parents
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise ValueError(
        "bundled KFD package not found; installed Kungfu products ship "
        "Resources/node_modules/@kungfu-tech/kfd"
    )


def resolve_product_executable(override: str | Path | None = None) -> Path:
    selected = override or os.environ.get("KUNGFU_EXECUTABLE")
    if selected:
        return _regular(Path(selected), "Kungfu executable")
    manifest_value = os.environ.get("KUNGFU_PRODUCT_MANIFEST")
    if manifest_value:
        manifest_path = Path(manifest_value).resolve()
        manifest = _read_json(manifest_path)
        entry = manifest.get("entries", {}).get("kungfu")
        if isinstance(entry, str) and entry:
            return _regular(manifest_path.parent / entry, "Kungfu executable")
    return _regular(Path(sys.argv[0]), "Kungfu executable")


def run_kfd_step(entry: Path, *commands: str) -> None:
    entry = Path(entry)
    package_root = entry.parent.parent
    if commands[:2] == ("test", "agent-hub"):
        script = package_root / "scripts/agent-hub-runner.mjs"
        script_commands = commands
    elif commands[:2] == ("verify", "agent-hub-report"):
        script = package_root / "scripts/agent-hub-report-verifier.mjs"
        script_commands = commands[2:]
    else:
        raise ValueError(f"unsupported bundled KFD Agent Hub command: {commands}")
    _regular(script, "KFD Agent Hub script")
    status = kungfu.__binding__.libnode.run(sys.argv[0], str(script), *script_commands)
    if isinstance(status, int) and status != 0:
        raise RuntimeError(f"bundled KFD command exited with status {status}")


def _run_kfd(executable: Path, entry: Path, *commands: str) -> None:
    env = os.environ.copy()
    env["KUNGFU_INTERNAL_AGENT_HUB_KFD_STEP"] = json.dumps(
        {"entry": str(entry), "commands": list(commands)},
        separators=(",", ":"),
    )
    result = subprocess.run(
        [str(executable), "agent"],
        check=False,
        capture_output=True,
        env=env,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        if len(detail) > 4000:
            detail = detail[-4000:]
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"bundled KFD command exited with status {result.returncode}{suffix}"
        )


def _build_info() -> tuple[Path, dict[str, Any]]:
    path = Path(kungfu.__binding__.__file__).resolve().parent / "kungfubuildinfo.json"
    if not path.is_file():
        raise ValueError(f"Kungfu build identity not found: {path}")
    return path, _read_json(path)


def product_identity(executable: Path) -> dict[str, Any]:
    build_path, build = _build_info()
    release_path_value = os.environ.get("KUNGFU_UPGRADE_MANIFEST")
    release_path = Path(release_path_value).resolve() if release_path_value else None
    release = (
        _read_json(release_path)
        if release_path is not None and release_path.is_file()
        else None
    )
    identity = {
        "name": "Kungfu Work",
        "version": str(getattr(kungfu, "__version__", build.get("version", "unknown"))),
        "executable": str(executable),
        "artifactDigest": _sha256_file(executable),
        "buildInfoDigest": _sha256_file(build_path),
        "sourceCommit": build.get("git", {}).get("revision"),
        "sourceBranch": build.get("git", {}).get("branch"),
        "sourcePristine": build.get("git", {}).get("pristine"),
        "platform": {
            "os": platform.system().lower(),
            "arch": platform.machine().lower(),
        },
        "provenance": (
            "installed-product"
            if os.environ.get("KUNGFU_INSTALL_SOURCE")
            else "built-product"
        ),
    }
    if release is not None:
        assert release_path is not None
        identity["releaseManifestDigest"] = _sha256_file(release_path)
        identity["releaseManifestSourceCommit"] = release.get("sourceCommit")
    return identity


def private_home_snapshot() -> dict[str, Any]:
    root = (Path.home() / ".kungfu").resolve()
    rows: list[dict[str, Any]] = []
    counts = {
        "file": 0,
        "directory": 0,
        "symlink": 0,
        "other": 0,
        "totalBytes": 0,
    }
    if root.exists():
        for current, directories, files in os.walk(root, followlinks=False):
            current_path = Path(current)
            for name in sorted([*directories, *files]):
                path = current_path / name
                stat = path.lstat()
                relative = path.relative_to(root).as_posix()
                if path.is_symlink():
                    kind = "symlink"
                elif path.is_dir():
                    kind = "directory"
                elif path.is_file():
                    kind = "file"
                    counts["totalBytes"] += stat.st_size
                else:
                    kind = "other"
                counts[kind] += 1
                rows.append(
                    {
                        "relative": relative,
                        "type": kind,
                        "size": stat.st_size,
                        "mode": stat.st_mode,
                        "mtimeNs": stat.st_mtime_ns,
                    }
                )
    rows.sort(key=lambda row: row["relative"])
    return {
        "pathClass": "user-kungfu-home",
        "exists": root.exists(),
        "counts": counts,
        "metadataRoot": semantic_root(rows),
        "contentRead": False,
    }


def qualify(
    output_dir: str | Path,
    *,
    kfd_entry: str | Path | None = None,
    product_executable: str | Path | None = None,
    timeout_ms: int = 30_000,
) -> dict[str, Any]:
    output = Path(output_dir).resolve()
    if output.exists():
        raise ValueError(f"qualification output must be new: {output}")
    if timeout_ms < 100:
        raise ValueError("timeout must be at least 100 milliseconds")
    entry = resolve_kfd_entry(kfd_entry)
    executable = resolve_product_executable(product_executable)
    output.mkdir(parents=True)
    domains = output / "domains"
    domains.mkdir()
    report_path = output / "kfd-agent-hub-report.json"
    verification_path = output / "kfd-agent-hub-verification.json"
    before = private_home_snapshot()
    product = product_identity(executable)
    _run_kfd(
        executable,
        entry,
        "test",
        "agent-hub",
        "--adapter",
        str(executable),
        "--adapter-arg",
        "agent",
        "--adapter-arg",
        "hub",
        "--adapter-arg",
        "adapter",
        "--adapter-arg",
        "--qualification-root",
        "--adapter-arg",
        str(domains),
        "--adapter-source-commit",
        str(product.get("sourceCommit") or "unknown"),
        "--output",
        str(report_path),
        "--timeout-ms",
        str(timeout_ms),
        "--quiet",
    )
    _run_kfd(
        executable,
        entry,
        "verify",
        "agent-hub-report",
        str(report_path),
        "--adapter",
        str(executable),
        "--output",
        str(verification_path),
        "--json",
    )
    after = private_home_snapshot()
    report = _read_json(report_path)
    verification = _read_json(verification_path)
    real_home_unchanged = semantic_root(before) == semantic_root(after)
    valid = (
        report.get("valid") is True
        and report.get("coverage", {}).get("passed") == 20
        and verification.get("valid") is True
        and real_home_unchanged
    )
    payload = {
        "schema": QUALIFICATION_SCHEMA,
        "valid": valid,
        "result": "pass" if valid else "fail",
        "product": product,
        "kfd": {
            "package": report.get("sourceCut", {}).get("package"),
            "version": report.get("sourceCut", {}).get("packageVersion"),
            "profile": report.get("profile"),
            "suite": report.get("suite"),
            "offline": report.get("execution", {}).get("offline"),
        },
        "testedResponsibilities": WHAT_WAS_TESTED,
        "coverage": report.get("coverage"),
        "meaning": MEANING,
        "nonClaims": NON_CLAIMS,
        "isolation": {
            "topology": "two-isolated-local-peer-authority-domains",
            "realHomeUnchanged": real_home_unchanged,
            "realHomeBefore": before,
            "realHomeAfter": after,
        },
        "evidence": {
            "directory": str(output),
            "report": report_path.name,
            "reportDigest": semantic_root(report),
            "verification": verification_path.name,
            "verificationDigest": semantic_root(verification),
            "qualification": "qualification.json",
        },
        "next": {
            "verify": (
                f"kungfu agent hub verify --qualification-dir {json.dumps(str(output))}"
            ),
            "inspectJson": (
                "kungfu agent hub verify --qualification-dir "
                f"{json.dumps(str(output))} --json"
            ),
        },
    }
    (output / "qualification.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return payload


def verify(
    qualification_dir: str | Path,
    *,
    kfd_entry: str | Path | None = None,
    product_executable: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(qualification_dir).resolve()
    qualification_path = root / "qualification.json"
    report_path = root / "kfd-agent-hub-report.json"
    if not qualification_path.is_file() or not report_path.is_file():
        raise ValueError(f"qualification evidence is incomplete: {root}")
    entry = resolve_kfd_entry(kfd_entry)
    executable = resolve_product_executable(product_executable)
    retained = _read_json(qualification_path)
    report = _read_json(report_path)
    recheck_dir = root / "verification-rechecks"
    recheck_dir.mkdir(exist_ok=True)
    recheck_path = recheck_dir / f"{time.time_ns()}-{os.getpid()}.json"
    _run_kfd(
        executable,
        entry,
        "verify",
        "agent-hub-report",
        str(report_path),
        "--adapter",
        str(executable),
        "--output",
        str(recheck_path),
        "--json",
    )
    offline = _read_json(recheck_path)
    current_product = product_identity(executable)
    checks = [
        {
            "id": "qualification-contract",
            "passed": retained.get("schema") == QUALIFICATION_SCHEMA,
        },
        {
            "id": "declared-result",
            "passed": retained.get("valid") is True
            and retained.get("coverage", {}).get("passed") == 20,
        },
        {
            "id": "report-root",
            "passed": retained.get("evidence", {}).get("reportDigest")
            == semantic_root(report),
        },
        {
            "id": "offline-verifier",
            "passed": offline.get("valid") is True,
        },
        {
            "id": "product-artifact",
            "passed": retained.get("product", {}).get("artifactDigest")
            == current_product.get("artifactDigest"),
        },
        {
            "id": "real-home-isolation",
            "passed": retained.get("isolation", {}).get("realHomeUnchanged") is True,
        },
        {
            "id": "claim-boundary",
            "passed": retained.get("meaning") == MEANING
            and retained.get("nonClaims") == NON_CLAIMS,
        },
    ]
    valid = all(check["passed"] for check in checks)
    return {
        "schema": VERIFICATION_SCHEMA,
        "valid": valid,
        "result": "pass" if valid else "fail",
        "qualificationDirectory": str(root),
        "checks": checks,
        "coverage": retained.get("coverage"),
        "meaning": retained.get("meaning"),
        "nonClaims": retained.get("nonClaims"),
        "evidence": retained.get("evidence"),
        "recheck": str(recheck_path.relative_to(root)),
        "offlineVerifier": offline,
    }


def render_human(payload: dict[str, Any], *, verification: bool = False) -> str:
    title = (
        "KFD Agent Hub Offline Verification"
        if verification
        else "KFD Agent Hub Qualification"
    )
    status = "PASSED" if payload.get("valid") else "FAILED"
    coverage = payload.get("coverage") or {}
    lines = [f"{title}  {status}", ""]
    if not verification:
        product = payload["product"]
        lines.extend(
            [
                "Product",
                f"  {product['name']} {product['version']}",
                (
                    f"  {product['platform']['os']} "
                    f"{product['platform']['arch']} · {product['provenance']}"
                ),
                "",
                "What was tested",
            ]
        )
        lines.extend(f"  ✓ {item}" for item in payload["testedResponsibilities"])
        lines.append("")
    lines.extend(
        [
            "Result",
            (
                f"  {coverage.get('passed', 0)} of "
                f"{coverage.get('total', 20)} scenarios passed"
            ),
        ]
    )
    if not verification:
        lines.extend(
            [
                "  Independent offline verification passed",
                (
                    "  Your real ~/.kungfu state was unchanged"
                    if payload["isolation"]["realHomeUnchanged"]
                    else "  WARNING: real ~/.kungfu metadata changed"
                ),
            ]
        )
    lines.extend(["", "What this means", f"  {payload['meaning']}", ""])
    lines.append("What this does NOT mean")
    lines.extend(f"  • {item}" for item in payload["nonClaims"])
    lines.extend(["", "Evidence"])
    evidence = payload["evidence"]
    if evidence.get("directory"):
        lines.append(f"  Directory: {evidence['directory']}")
    lines.append(f"  Report root: {evidence['reportDigest']}")
    if not verification:
        lines.extend(["", "Verify again", f"  {payload['next']['verify']}"])
    return "\n".join(lines) + "\n"
