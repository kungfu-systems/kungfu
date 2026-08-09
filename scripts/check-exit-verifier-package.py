# SPDX-License-Identifier: Apache-2.0

"""Qualify the registry-free Exit verifier shipped in a built Core wheel."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from kungfu import exit_bundle, exit_verifier
from kungfu.storage import service as storage_service


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "framework" / "core" / "build" / "python" / "dist"
EVIDENCE_SCHEMA = "kungfu.exit-verifier-qualification/v1"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compare source and extracted-wheel Exit verifier reports."
    )
    parser.add_argument("--wheel", type=Path, help="Core wheel to qualify")
    parser.add_argument("--json", action="store_true", help="emit JSON evidence")
    return parser


def _latest_wheel() -> Path:
    candidates = sorted(
        DIST.glob("kungfu-*.whl"), key=lambda path: path.stat().st_mtime
    )
    if not candidates:
        raise FileNotFoundError(f"no built Core wheel found under {DIST}")
    return candidates[-1]


def _package(runtime: Path, mode: str) -> dict[str, Any]:
    return exit_bundle.build(
        runtime,
        {
            "schema": "kungfu.exit-bundle-request/v1",
            "bundleId": f"exit:packaged-verifier-{mode}",
            "mode": mode,
            "scope": {
                "id": "verifier/packaged-qualification",
                "authority": "kungfu-exit-verifier-qualification",
                "schema": EVIDENCE_SCHEMA,
                "protocol": "source-wheel-parity/v1",
            },
            "members": [
                {
                    "memberId": "episode-primary",
                    "kind": "episode-v1",
                    "requiredForScope": True,
                    "options": {"episodeId": 20260720},
                }
            ],
        },
    )


def _run_packaged(
    site: Path,
    package_path: Path | None,
    *,
    runtime_guard: Path,
) -> tuple[int, dict[str, Any]]:
    command = [sys.executable, "-m", "kungfu.exit_verifier"]
    command.extend(
        ["--info", "--json"]
        if package_path is None
        else ["--file", str(package_path), "--json"]
    )
    environment = os.environ.copy()
    environment.pop("KUNGFU_CONTRACT_REGISTRY", None)
    environment.pop("KUNGFU_EXIT_BUNDLE_CONTRACT", None)
    environment["PYTHONPATH"] = str(site)
    environment["KF_RUNTIME_DIR"] = str(runtime_guard)
    process = subprocess.run(
        command,
        cwd=site.parent,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if not process.stdout:
        raise AssertionError(
            f"packaged verifier emitted no JSON (exit {process.returncode}): "
            f"{process.stderr.strip()}"
        )
    return process.returncode, json.loads(process.stdout)


def qualify(wheel: Path) -> dict[str, Any]:
    wheel = wheel.resolve()
    if not wheel.is_file():
        raise FileNotFoundError(f"Core wheel not found: {wheel}")
    with tempfile.TemporaryDirectory(prefix="kungfu-exit-verifier-") as temp:
        directory = Path(temp)
        fixture_runtime = directory / "fixture-runtime"
        runtime_guard = directory / "must-not-exist"
        storage_service.episode_begin(
            fixture_runtime,
            episode_id=20260720,
            begin_time=1,
            title="packaged verifier qualification",
            actor="qualification",
            source="source-wheel-parity",
        )
        storage_service.episode_end(
            fixture_runtime,
            episode_id=20260720,
            end_time=2,
            reason="sealed",
        )
        packages = {mode: _package(fixture_runtime, mode) for mode in ("full", "thin")}
        site = directory / "site"
        site.mkdir()
        with zipfile.ZipFile(wheel) as archive:
            names = set(archive.namelist())
            required = {
                "kungfu/exit_bundle.contract.json",
                "kungfu/exit_verifier.contract.json",
                "kungfu/exit_verifier.corpus.json",
                "kungfu/exit_verifier.py",
            }
            missing = sorted(required - names)
            if missing:
                raise AssertionError(
                    f"Core wheel omits verifier artifact(s): {', '.join(missing)}"
                )
            entrypoints = next(
                name for name in names if name.endswith(".dist-info/entry_points.txt")
            )
            if "kungfu-exit-verify" not in archive.read(entrypoints).decode("utf-8"):
                raise AssertionError(
                    "Core wheel omits kungfu-exit-verify console script"
                )
            archive.extractall(site)

        info_code, packaged_info = _run_packaged(
            site, None, runtime_guard=runtime_guard
        )
        source_info = exit_verifier.info()
        if info_code != 0 or packaged_info != source_info:
            raise AssertionError("source and packaged verifier discovery diverged")

        cases = []
        for mode, package in packages.items():
            package_path = directory / f"{mode}.json"
            package_path.write_text(
                json.dumps(package, sort_keys=True, separators=(",", ":")),
                encoding="utf-8",
            )
            source_report = exit_verifier.verify(package)
            exit_code, packaged_report = _run_packaged(
                site,
                package_path,
                runtime_guard=runtime_guard,
            )
            expected_code = int(source_info["exitCodes"][source_report["verdict"]])
            if exit_code != expected_code or packaged_report != source_report:
                raise AssertionError(
                    f"source and packaged verifier reports diverged for {mode}"
                )
            cases.append(
                {
                    "mode": mode,
                    "verdict": packaged_report["verdict"],
                    "exitCode": exit_code,
                    "packageRoot": packaged_report["packageRoot"],
                    "reportRoot": packaged_report["reportRoot"],
                }
            )
        if runtime_guard.exists():
            raise AssertionError("packaged verifier initialized a runtime")

        evidence = {
            "schema": EVIDENCE_SCHEMA,
            "status": "qualified",
            "wheel": wheel.name,
            "wheelSha256": "sha256:" + hashlib.sha256(wheel.read_bytes()).hexdigest(),
            "verifier": packaged_info["verifier"],
            "infoRoot": packaged_info["infoRoot"],
            "runtimeMutation": False,
            "sourceWheelParity": True,
            "cases": cases,
        }
        return evidence


def main() -> int:
    args = _parser().parse_args()
    evidence = qualify(args.wheel or _latest_wheel())
    if args.json:
        print(json.dumps(evidence, indent=2, sort_keys=True))
    else:
        print(
            "[exit-verifier] packaged source/wheel parity qualified: "
            f"{evidence['verifier']['manifestRoot']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
