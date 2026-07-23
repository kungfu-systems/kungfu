# SPDX-License-Identifier: Apache-2.0

"""Qualify Exit migration from one extracted official Kungfu CLI artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "product" / "release" / "cli"
WORKER = ROOT / "scripts" / "exit-clean-runtime-worker.py"


def _latest_artifact() -> Path:
    artifacts = sorted(
        [*RELEASE.glob("kungfu-episodes-cli-*.tar.gz"), *RELEASE.glob("*.zip")],
        key=lambda path: path.stat().st_mtime,
    )
    if not artifacts:
        raise FileNotFoundError(f"no official CLI artifact under {RELEASE}")
    return artifacts[-1]


def _extract(artifact: Path, destination: Path) -> Path:
    if artifact.suffix == ".zip":
        with zipfile.ZipFile(artifact) as archive:
            archive.extractall(destination)
    else:
        with tarfile.open(artifact, "r:gz") as archive:
            archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1:
        raise AssertionError("CLI artifact must contain exactly one install root")
    return roots[0]


def _product_manifest(install_root: Path) -> dict[str, Any]:
    value = json.loads((install_root / "product.json").read_text(encoding="utf-8"))
    if value.get("schema") != "kungfu.product.cli/v1":
        raise AssertionError("not a Kungfu CLI product artifact")
    return value


def _run(
    python: Path,
    install_root: Path,
    work_root: Path,
    artifact: Path,
    digest: str,
    phase: str,
    *,
    deny_network: bool,
) -> None:
    common = [
        str(python),
        "-I",
        str(WORKER),
        phase,
        "--product-root",
        str(install_root),
        "--work-root",
        str(work_root),
        "--artifact-digest",
        digest,
        "--artifact-name",
        artifact.name,
        "--full",
        str(work_root / "full.json"),
        "--thin",
        str(work_root / "thin.json"),
        "--handoff",
        str(work_root / "handoff.json"),
        "--report",
        str(work_root / "report.json"),
    ]
    command = common
    network = "not-proven-no-os-sandbox"
    if deny_network and sys.platform == "darwin" and shutil.which("sandbox-exec"):
        command = [
            shutil.which("sandbox-exec") or "/usr/bin/sandbox-exec",
            "-p",
            "(version 1) (allow default) (deny network*)",
            *common,
        ]
        network = "denied-by-macos-sandbox"
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "PYTHONPATH",
            "PYTHONHOME",
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
            "KF_HOME",
            "KF_RUNTIME_DIR",
            "KUNGFU_ALLOW_FOREIGN_RUNTIME",
            "KUNGFU_NATIVE_PATH",
        }
    }
    environment.update(
        {
            "HOME": str(work_root / f"{phase}-home"),
            "TMPDIR": str(work_root / "tmp"),
            "KUNGFU_CONTRACT_REGISTRY": str(
                install_root / "runtime" / "config" / "kungfu-contracts.registry.json"
            ),
            "KF_FIRST_PARTY_SOURCE_ROOT": str(install_root / "extensions"),
            "KUNGFU_QUALIFICATION_SOURCE_ROOT": str(ROOT),
            "KUNGFU_QUALIFICATION_NETWORK": network,
        }
    )
    Path(environment["HOME"]).mkdir(parents=True, exist_ok=True)
    Path(environment["TMPDIR"]).mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        command,
        cwd=work_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"{phase} phase failed ({result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )


def qualify(artifact: Path, report_out: Path | None = None) -> dict[str, Any]:
    artifact = artifact.resolve()
    digest = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="kungfu-exit-clean-runtime-") as temp:
        work_root = Path(temp)
        install_root = _extract(artifact, work_root / "install")
        manifest = _product_manifest(install_root)
        python_relative = (
            Path("runtime/python/python.exe")
            if sys.platform == "win32"
            else Path("runtime/python/bin/python3")
        )
        python = install_root / python_relative
        if not python.is_file():
            raise AssertionError(f"assembled artifact interpreter missing: {python}")
        if not (install_root / manifest["entries"]["kungfu"]).is_file():
            raise AssertionError("installed CLI entry missing")
        for phase in ("source", "destination"):
            _run(
                python,
                install_root,
                work_root,
                artifact,
                digest,
                phase,
                deny_network=True,
            )
        report = json.loads((work_root / "report.json").read_text(encoding="utf-8"))
        if report_out is not None:
            report_out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(work_root / "report.json", report_out)
        return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--report-out", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = qualify(args.artifact or _latest_artifact(), args.report_out)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(
            "[exit-clean-runtime] qualified "
            f"{report['artifact']['digest']} -> {report['reportRoot']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
