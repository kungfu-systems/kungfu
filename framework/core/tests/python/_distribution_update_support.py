# SPDX-License-Identifier: Apache-2.0

# ruff: noqa: F401,F811

from __future__ import annotations

import contextlib
import errno
import hashlib
import importlib
import io
import json
import platform
import subprocess
import sys
import tarfile
import time
import types
import zipfile
from pathlib import Path

import click
import pytest
from click.testing import CliRunner


def _install_fake_pykungfu():
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.runtime = types.ModuleType("pykungfu.runtime")
    fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
    fake.yijinjing = types.SimpleNamespace()
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", fake.runtime)


_install_fake_pykungfu()

import kungfu  # noqa: E402
from kungfu import distribution_update, runtime_upgrade  # noqa: E402

kungfu.__version__ = "4.0.0-alpha.0"

from kungfu.cli.commands.update import update as update_cli  # noqa: E402

update_command = importlib.import_module("kungfu.cli.commands.update")


@pytest.fixture(autouse=True)
def _installed_product_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(kungfu, "__version__", "4.0.0-alpha.0")


class _Response(io.BytesIO):
    def __init__(
        self,
        payload: bytes,
        *,
        url: str = "https://example.invalid/candidate.tar.gz",
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(payload)
        self.status = status
        self._url = url
        self._headers = headers or {}

    def geturl(self) -> str:
        return self._url

    def getheader(self, name: str, default=None):
        return self._headers.get(name, default)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


@click.group()
@click.option("--home", type=click.Path(), required=True)
@click.pass_context
def update_test_cli(ctx, home):
    ctx.name = "product-update-test"
    ctx.config_home = str(Path(home) / "config")
    ctx.home = str(home)
    ctx.extension_path = None
    ctx.log_level = "warning"
    ctx.runtime_dir = str(Path(home) / "runtime")
    ctx.dataset_dir = str(Path(home) / "dataset")
    ctx.backtest_dir = str(Path(home) / "backtest")
    ctx.inbox_dir = str(Path(home) / "inbox")
    ctx.runtime_locator = None
    ctx.backtest_locator = None
    ctx.config_location = None
    ctx.console_location = None
    ctx.index_location = None
    ctx.stage = "test"


update_test_cli.add_command(update_cli)


def _manifest(
    runtime_root: Path,
    *,
    platform: str | None = None,
    architecture: str | None = None,
    product_version: str = "4.0.0-alpha.1",
) -> dict:
    current_platform, current_architecture = distribution_update._normalize_platform()
    platform = platform or current_platform
    architecture = architecture or current_architecture
    digest = runtime_upgrade.tree_digest(runtime_root)
    return {
        "schema": runtime_upgrade.MANIFEST_SCHEMA,
        "productVersion": product_version,
        "releaseChannel": "alpha",
        "sourceCommit": "1" * 40,
        "runtimeBuildId": f"runtime-{product_version}-fixture",
        "runtimeArtifactDigest": digest,
        "runtimeEntrypoint": "kungfu",
        "frontendBuildId": f"product-{product_version}-fixture",
        "controlProtocolRange": {"min": 1, "max": 1},
        "peerWireProtocolRange": {"min": 1, "max": 1},
        "journalSchemaReadRange": {"min": 1, "max": 1},
        "journalSchemaWriteVersion": 1,
        "migrationClass": "none",
        "rollbackClass": "automatic",
        "minimumSupportedFrontend": "4.0.0-alpha.0",
        "minimumSupportedRuntime": "4.0.0-alpha.0",
        "platform": platform,
        "architecture": architecture,
        "artifacts": [
            {
                "kind": "runtime",
                "url": "app-resource://kungfu",
                "size": 1,
                "digest": digest,
                "signature": "sigstore:runtime-fixture",
            }
        ],
        "qualificationEvidenceRef": "buildchain:qualification/fixture",
        "documentationUrl": "https://www.kungfu.tech/docs/guides/upgrading",
    }


def _archive(
    tmp_path: Path,
    *,
    platform: str | None = None,
    architecture: str | None = None,
    product_version: str = "4.0.0-alpha.1",
    runtime_symlink: bool = False,
) -> tuple[Path, dict]:
    current_platform, current_architecture = distribution_update._normalize_platform()
    platform = platform or current_platform
    architecture = architecture or current_architecture
    source = tmp_path / "source" / "kungfu-cli-test"
    runtime_root = source / "kungfu"
    runtime_root.mkdir(parents=True)
    (runtime_root / "kungfu").write_text("#!/bin/sh\necho fixture\n", "utf-8")
    if runtime_symlink:
        (runtime_root / "kungfu-alias").symlink_to("kungfu")
    internal = _manifest(
        runtime_root,
        platform=platform,
        architecture=architecture,
        product_version=product_version,
    )
    upgrade = source / "upgrade"
    upgrade.mkdir()
    (upgrade / "kungfu-release-manifest.json").write_text(json.dumps(internal), "utf-8")
    (source / "product.json").write_text(
        json.dumps(
            {
                "schema": "kungfu.product.cli/v1",
                "install": {"source": "archive"},
                "entries": {
                    "runtime": "kungfu/kungfu",
                    "upgradeManifest": "upgrade/kungfu-release-manifest.json",
                },
            }
        ),
        "utf-8",
    )
    archive = tmp_path / "kungfu-cli-test.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        output.add(source, arcname=source.name)
    digest = f"sha256:{hashlib.sha256(archive.read_bytes()).hexdigest()}"
    external = {
        **internal,
        "artifacts": [
            *internal["artifacts"],
            {
                "kind": "cli",
                "url": "https://example.invalid/kungfu-cli-test.tar.gz",
                "size": archive.stat().st_size,
                "digest": digest,
                "signature": "sigstore:cli-fixture",
            },
        ],
    }
    return archive, external


def _selection(manifest: dict, *, source: str = "archive") -> dict:
    return {
        "schema": "kungfu.release-channel-selection/v1",
        "channel": manifest["releaseChannel"],
        "platform": manifest["platform"],
        "architecture": manifest["architecture"],
        "installSource": source,
        "currentVersion": "4.0.0-alpha.0",
        "targetVersion": manifest["productVersion"],
        "payloadRoot": f"sha256:{'4' * 64}",
        "releasePassport": {
            "ref": "buildchain:passport/fixture",
            "root": f"sha256:{'5' * 64}",
        },
        "entry": {"manifest": manifest},
    }


def _remote_download_plan(
    tmp_path: Path, payload: bytes = b"good"
) -> tuple[dict, Path, Path]:
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "kungfu").write_text("fixture", "utf-8")
    manifest = _manifest(runtime)
    manifest["artifacts"].append(
        {
            "kind": "cli",
            "url": "https://example.invalid/candidate.tar.gz",
            "size": len(payload),
            "digest": f"sha256:{hashlib.sha256(payload).hexdigest()}",
            "signature": "sigstore:cli-fixture",
        }
    )
    plan = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    target = Path(plan["target"])
    return plan, target, target.with_suffix(f"{target.suffix}.part")


# Deliberate shared test vocabulary for the private responsibility modules.
__all__ = [name for name in globals() if not name.startswith("__")]
