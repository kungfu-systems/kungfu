# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import contextlib
import errno
import hashlib
import importlib
import io
import json
import subprocess
import sys
import tarfile
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
) -> tuple[Path, dict]:
    current_platform, current_architecture = distribution_update._normalize_platform()
    platform = platform or current_platform
    architecture = architecture or current_architecture
    source = tmp_path / "source" / "kungfu-cli-test"
    runtime_root = source / "kungfu"
    runtime_root.mkdir(parents=True)
    (runtime_root / "kungfu").write_text("#!/bin/sh\necho fixture\n", "utf-8")
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


def test_install_sources_keep_package_managers_authoritative(tmp_path: Path) -> None:
    archive = distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"})
    assert archive["selfUpdateAllowed"] is True
    assert archive["managerCommand"] is None

    homebrew_product = tmp_path / "homebrew-product.json"
    homebrew_product.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": [
                        "brew",
                        "upgrade",
                        "--formula",
                        "kungfu-systems/tap/kungfu",
                    ],
                    "verificationCommand": ["kungfu", "--version"],
                }
            }
        ),
        "utf-8",
    )
    homebrew = distribution_update.install_source({}, product_manifest=homebrew_product)
    assert homebrew["selfUpdateAllowed"] is False
    assert homebrew["managerCommand"] == [
        "brew",
        "upgrade",
        "--formula",
        "kungfu-systems/tap/kungfu",
    ]
    assert homebrew["verificationCommand"] == ["kungfu", "--version"]

    product = tmp_path / "product.json"
    product.write_text(
        json.dumps({"install": {"source": "desktop-companion"}}), "utf-8"
    )
    companion = distribution_update.install_source({}, product_manifest=product)
    assert companion["frontendAuthority"] == "desktop-updater"
    assert companion["selfUpdateAllowed"] is False


def test_signed_release_check_is_platform_and_source_bound(tmp_path: Path) -> None:
    _archive_path, manifest = _archive(tmp_path)
    checked = distribution_update.check_release(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
    )
    assert checked["state"] == "available"
    assert checked["frontendAction"] == "download"
    assert checked["message"]["reasonCode"] == "new-product-version"
    assert checked["message"]["documentationUrl"].endswith("#check-and-plan-an-update")

    unqualified = {**manifest, "qualificationEvidenceRef": "unqualified-local-build"}
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.check_release(
            unqualified,
            current_version="4.0.0-alpha.0",
            source=checked["installSource"],
        )
    assert error.value.code == "release-unqualified"


@pytest.mark.parametrize("mismatch", ["platform", "architecture"])
@pytest.mark.parametrize(
    ("operation", "execute"),
    [
        ("check", False),
        ("download", False),
        ("apply", False),
        ("apply", True),
    ],
)
def test_self_update_entrypoints_reject_wrong_release_target_before_writes(
    tmp_path: Path, mismatch: str, operation: str, execute: bool
) -> None:
    current_platform, current_architecture = distribution_update._normalize_platform()
    platform = current_platform
    architecture = current_architecture
    if mismatch == "platform":
        platform = "win32" if current_platform != "win32" else "linux"
    else:
        architecture = "arm64" if current_architecture != "arm64" else "x64"
    archive, manifest = _archive(
        tmp_path,
        platform=platform,
        architecture=architecture,
    )
    source = distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"})

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        if operation == "check":
            distribution_update.check_release(
                manifest,
                current_version="4.0.0-alpha.0",
                source=source,
            )
        elif operation == "download":
            distribution_update.plan_download(
                manifest,
                current_version="4.0.0-alpha.0",
                source=source,
                cache_root=tmp_path / "cache",
            )
        else:
            distribution_update.apply_archive(
                manifest,
                archive,
                current_version="4.0.0-alpha.0",
                config_home=tmp_path / "config",
                expected_digest=manifest["artifacts"][1]["digest"],
                execute=execute,
            )

    assert error.value.code == "release-target-mismatch"
    assert not (tmp_path / "cache").exists()
    assert not (tmp_path / "config").exists()


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("4.0.0-alpha.2", "4.0.0-alpha.1", 1),
        ("4.0.0-alpha.10", "4.0.0-alpha.2", 1),
        ("4.0.0", "4.0.0-rc.1", 1),
        ("4.0.0+build.2", "4.0.0+build.1", 0),
        ("3.9.9", "4.0.0-alpha.0", -1),
    ],
)
def test_product_version_order_follows_semver(
    left: str, right: str, expected: int
) -> None:
    assert distribution_update.compare_product_versions(left, right) == expected


@pytest.mark.parametrize("version", ["4.0", "04.0.0", "4.0.0-alpha.01"])
def test_product_version_order_rejects_invalid_semver(version: str) -> None:
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.compare_product_versions(version, "4.0.0")
    assert error.value.code == "product-version-invalid"


def test_downgrade_fails_before_download_or_inventory_write(tmp_path: Path) -> None:
    archive, manifest = _archive(tmp_path, product_version="3.9.9")
    source = distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"})
    checked = distribution_update.check_release(
        manifest,
        current_version="4.0.0-alpha.0",
        source=source,
    )
    assert checked["state"] == "action-required"
    assert checked["reasonCode"] == "downgrade-refused"
    assert checked["frontendAction"] == "none"
    assert checked["message"]["documentationUrl"].endswith(
        "#downgrades-require-a-recovery-decision"
    )

    download = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )
    assert download["state"] == "action-required"
    assert download["reasonCode"] == "downgrade-refused"
    assert "target" not in download

    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    assert applied["state"] == "action-required"
    assert applied["reasonCode"] == "downgrade-refused"
    assert not (tmp_path / "config").exists()


def test_cli_projects_one_downgrade_refusal_without_running_activation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current_platform, current_architecture = distribution_update._normalize_platform()
    archive, manifest = _archive(
        tmp_path,
        platform=current_platform,
        architecture=current_architecture,
        product_version="3.9.9",
    )
    manifest_file = tmp_path / "release.json"
    manifest_file.write_text(json.dumps(manifest), "utf-8")
    monkeypatch.setattr(
        update_command,
        "_activation_plan",
        lambda _ctx, _manifest: pytest.fail(
            "downgrade refusal must not enter Core activation"
        ),
    )
    for args in [
        ["update", "check", str(manifest_file), "--json"],
        ["update", "download", str(manifest_file), "--json"],
        [
            "update",
            "apply",
            str(manifest_file),
            str(archive),
            "--expected-digest",
            manifest["artifacts"][1]["digest"],
            "--execute",
            "--json",
        ],
    ]:
        result = CliRunner().invoke(
            update_test_cli,
            ["--home", str(tmp_path / "home"), *args],
            env={"KUNGFU_INSTALL_SOURCE": "archive"},
        )
        assert result.exit_code == 0, result.output
        payload = json.loads(result.output)
        assert payload["state"] == "action-required"
        assert payload["reasonCode"] == "downgrade-refused"
        assert payload["message"]["messageReasonCode"] == "downgrade-refused"
    assert not (tmp_path / "home" / "config").exists()


def test_download_is_dry_run_first_resumable_and_fenced(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.tar.gz"
    artifact.write_bytes(b"verified-cli-archive")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "kungfu").write_text("fixture", "utf-8")
    manifest = _manifest(runtime)
    manifest["artifacts"].append(
        {
            "kind": "cli",
            "url": artifact.as_uri(),
            "size": artifact.stat().st_size,
            "digest": f"sha256:{hashlib.sha256(artifact.read_bytes()).hexdigest()}",
            "signature": "local-fixture-signature",
        }
    )
    plan = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
        allow_local_artifact=True,
    )
    preview = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=False
    )
    assert preview["executeRequired"] is True
    assert not Path(plan["target"]).exists()

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )
    assert receipt["state"] == "complete"
    assert Path(receipt["artifactPath"]).read_bytes() == artifact.read_bytes()
    repeated = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )
    assert repeated["artifactDigest"] == receipt["artifactDigest"]

    stale = {**plan, "target": str(tmp_path / "other")}
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            stale, expected_plan_id=plan["planId"], execute=False
        )
    assert error.value.code == "stale-plan"


def test_download_lock_identity_is_bound_to_target_not_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, target, _partial = _remote_download_plan(tmp_path)
    second_bytes = b"evil"
    second_artifact = {
        **first["artifact"],
        "digest": f"sha256:{hashlib.sha256(second_bytes).hexdigest()}",
    }
    second_identity = {
        "runtimeBuildId": first["manifest"]["runtimeBuildId"],
        "artifactUrl": second_artifact["url"],
        "artifactSize": second_artifact["size"],
        "artifactDigest": second_artifact["digest"],
        "target": first["target"],
    }
    second = {
        **first,
        "artifact": second_artifact,
        "planId": distribution_update._stable_id(
            "product-download-plan", second_identity
        ),
    }
    lock_names = []

    def held(_root, name, **_kwargs):
        lock_names.append(name)
        return contextlib.nullcontext()

    monkeypatch.setattr(distribution_update.coordination_locks, "held", held)
    target.parent.mkdir(parents=True)
    target.write_bytes(b"good")
    distribution_update.download(first, expected_plan_id=first["planId"], execute=True)
    target.write_bytes(second_bytes)
    distribution_update.download(
        second, expected_plan_id=second["planId"], execute=True
    )

    assert first["planId"] != second["planId"]
    assert len(lock_names) == 2
    assert lock_names[0] == lock_names[1]


def test_download_stops_before_streaming_past_declared_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(b"oversized-candidate"),
    )
    partial = tmp_path / "candidate.part"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._download_to_partial(
            "https://example.invalid/candidate.tar.gz",
            partial,
            expected_size=4,
        )

    assert error.value.code == "artifact-verification-failed"
    assert partial.stat().st_size <= 4


def test_download_discards_complete_partial_when_stream_exceeds_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)

    class ChunkedResponse(_Response):
        def read(self, size: int = -1) -> bytes:
            return super().read(min(size, 4))

    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: ChunkedResponse(b"goodx"),
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-verification-failed"
    assert not target.exists()
    assert not partial.exists()


def test_download_discards_full_digest_mismatch_and_recovers_next_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    responses = iter([_Response(b"evil"), _Response(b"good")])
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: next(responses),
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-verification-failed"
    assert not target.exists()
    assert not partial.exists()

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"


def test_download_discards_oversized_partial_before_restarting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    partial.parent.mkdir(parents=True)
    partial.write_bytes(b"oversized")
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(b"good"),
    )

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"
    assert not partial.exists()


def test_download_preserves_incomplete_partial_for_exact_range_resume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    responses = iter(
        [
            _Response(b"go"),
            _Response(
                b"od",
                status=206,
                headers={"Content-Range": "bytes 2-3/4"},
            ),
        ]
    )
    requests = []

    def open_https(request, **_kwargs):
        requests.append(request)
        return next(responses)

    monkeypatch.setattr(distribution_update, "_open_https", open_https)

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-verification-failed"
    assert partial.read_bytes() == b"go"

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert requests[1].get_header("Range") == "bytes=2-"
    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"
    assert not partial.exists()


def test_download_recovers_from_disk_full_using_retained_partial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan, target, partial = _remote_download_plan(tmp_path)
    responses = iter(
        [
            _Response(b"good"),
            _Response(
                b"od",
                status=206,
                headers={"Content-Range": "bytes 2-3/4"},
            ),
        ]
    )
    requests = []
    copy_bounded_download = distribution_update._copy_bounded_download
    fail_write = True

    def open_https(request, **_kwargs):
        requests.append(request)
        return next(responses)

    def copy_with_disk_full(input_file, output_file, **kwargs):
        nonlocal fail_write
        if fail_write:
            fail_write = False
            output_file.write(b"go")
            raise OSError(errno.ENOSPC, "No space left on device")
        copy_bounded_download(input_file, output_file, **kwargs)

    monkeypatch.setattr(distribution_update, "_open_https", open_https)
    monkeypatch.setattr(
        distribution_update,
        "_copy_bounded_download",
        copy_with_disk_full,
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.download(
            plan, expected_plan_id=plan["planId"], execute=True
        )

    assert error.value.code == "artifact-download-failed"
    assert not target.exists()
    assert partial.read_bytes() == b"go"

    receipt = distribution_update.download(
        plan, expected_plan_id=plan["planId"], execute=True
    )

    assert requests[1].get_header("Range") == "bytes=2-"
    assert receipt["state"] == "complete"
    assert target.read_bytes() == b"good"
    assert not partial.exists()


def test_remote_manifest_rejects_redirect_to_insecure_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(
            b"{}", url="http://mirror.invalid/release.json"
        ),
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.load_release_manifest(
            "https://example.invalid/release.json"
        )

    assert error.value.code == "manifest-transport-insecure"


def test_https_redirect_handler_rejects_an_insecure_intermediate_hop() -> None:
    handler = distribution_update._HttpsOnlyRedirectHandler(
        code="manifest-transport-insecure",
        message="release manifest redirect requires HTTPS",
    )
    request = distribution_update.urllib.request.Request(
        "https://example.invalid/release.json"
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "http://mirror.invalid/release.json",
        )

    assert error.value.code == "manifest-transport-insecure"


def test_https_redirect_handler_allows_a_secure_intermediate_hop() -> None:
    handler = distribution_update._HttpsOnlyRedirectHandler(
        code="manifest-transport-insecure",
        message="release manifest redirect requires HTTPS",
    )
    request = distribution_update.urllib.request.Request(
        "https://example.invalid/release.json"
    )

    redirected = handler.redirect_request(
        request,
        None,
        302,
        "Found",
        {},
        "https://mirror.invalid/release.json",
    )

    assert redirected.full_url == "https://mirror.invalid/release.json"


def test_artifact_download_rejects_redirect_to_insecure_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(
            b"abcd", url="http://mirror.invalid/candidate.tar.gz"
        ),
    )
    partial = tmp_path / "candidate.part"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._download_to_partial(
            "https://example.invalid/candidate.tar.gz",
            partial,
            expected_size=4,
        )

    assert error.value.code == "artifact-transport-insecure"
    assert not partial.exists()


@pytest.mark.parametrize(
    "content_range",
    [None, "bytes 0-1/4", "bytes 2-3/5", "bytes */4"],
)
def test_artifact_resume_rejects_unbound_content_range(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    content_range: str | None,
) -> None:
    headers = {"Content-Range": content_range} if content_range is not None else {}
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(b"cd", status=206, headers=headers),
    )
    partial = tmp_path / "candidate.part"
    partial.write_bytes(b"ab")

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._download_to_partial(
            "https://example.invalid/candidate.tar.gz",
            partial,
            expected_size=4,
        )

    assert error.value.code == "artifact-verification-failed"
    assert partial.read_bytes() == b"ab"


def test_artifact_resume_appends_only_the_exact_remaining_range(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(
            b"cd",
            status=206,
            headers={"Content-Range": "bytes 2-3/4"},
        ),
    )
    partial = tmp_path / "candidate.part"
    partial.write_bytes(b"ab")

    distribution_update._download_to_partial(
        "https://example.invalid/candidate.tar.gz",
        partial,
        expected_size=4,
    )

    assert partial.read_bytes() == b"abcd"


@pytest.mark.parametrize("execute", [False, True])
def test_apply_rejects_declared_size_drift_before_inventory_write(
    tmp_path: Path, execute: bool
) -> None:
    archive, manifest = _archive(tmp_path)
    artifact = next(item for item in manifest["artifacts"] if item["kind"] == "cli")
    artifact["size"] += 1

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            archive,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=artifact["digest"],
            execute=execute,
        )

    assert error.value.code == "artifact-verification-failed"
    assert not (tmp_path / "config").exists()


def test_apply_rejects_archive_replacement_before_extracting_or_writing_inventory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive, manifest = _archive(tmp_path)
    source = tmp_path / "source" / "kungfu-cli-test"
    bundled = source / "upgrade" / "kungfu-release-manifest.json"
    replacement_manifest = json.loads(bundled.read_text("utf-8"))
    replacement_manifest["documentationUrl"] = replacement_manifest[
        "documentationUrl"
    ].replace("www.kungfu.tech", "bad.example.net")
    bundled.write_text(json.dumps(replacement_manifest), "utf-8")
    replacement = tmp_path / "replacement.tar.gz"
    with tarfile.open(replacement, "w:gz") as output:
        output.add(source, arcname=source.name)
    stage_verified_archive = distribution_update._stage_verified_archive

    def replace_then_stage(
        source_archive: Path,
        target: Path,
        *,
        expected_size: int,
        expected_digest: str,
    ) -> None:
        replacement.replace(source_archive)
        stage_verified_archive(
            source_archive,
            target,
            expected_size=expected_size,
            expected_digest=expected_digest,
        )

    monkeypatch.setattr(
        distribution_update,
        "_stage_verified_archive",
        replace_then_stage,
    )
    config_home = tmp_path / "config"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            archive,
            current_version="4.0.0-alpha.0",
            config_home=config_home,
            expected_digest=manifest["artifacts"][1]["digest"],
            execute=True,
        )

    assert error.value.code == "artifact-verification-failed"
    assert not config_home.exists()


@pytest.mark.parametrize("archive_format", ["tar", "zip"])
@pytest.mark.parametrize("limit", ["entries", "expanded-bytes"])
@pytest.mark.parametrize("execute", [False, True])
def test_apply_rejects_archive_resource_exhaustion_before_inventory_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    archive_format: str,
    limit: str,
    execute: bool,
) -> None:
    _valid_archive, manifest = _archive(tmp_path)
    candidate = tmp_path / f"resource-exhaustion.{archive_format}"
    members = [("one.bin", b"1"), ("two.bin", b"22")]
    if archive_format == "tar":
        source = tmp_path / "resource-source"
        source.mkdir()
        for name, payload in members:
            (source / name).write_bytes(payload)
        with tarfile.open(candidate, "w") as output:
            for name, _payload in members:
                output.add(source / name, arcname=name)
    else:
        with zipfile.ZipFile(
            candidate, "w", compression=zipfile.ZIP_DEFLATED
        ) as output:
            for name, payload in members:
                output.writestr(name, payload)
    if limit == "entries":
        monkeypatch.setattr(distribution_update, "_MAX_ARCHIVE_ENTRIES", 1)
    else:
        monkeypatch.setattr(distribution_update, "_MIN_ARCHIVE_EXPANDED_BYTES", 1)
        monkeypatch.setattr(distribution_update, "_MAX_ARCHIVE_EXPANDED_BYTES", 1)
        monkeypatch.setattr(distribution_update, "_MAX_ARCHIVE_EXPANSION_RATIO", 1)
    artifact = next(item for item in manifest["artifacts"] if item["kind"] == "cli")
    artifact["size"] = candidate.stat().st_size
    artifact["digest"] = f"sha256:{hashlib.sha256(candidate.read_bytes()).hexdigest()}"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            candidate,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=artifact["digest"],
            execute=execute,
        )

    assert error.value.code == "archive-resource-limit"
    assert not (tmp_path / "config").exists()


def test_apply_installs_runtime_and_selects_versioned_cli_on_next_command(
    tmp_path: Path,
) -> None:
    archive, manifest = _archive(tmp_path)
    digest = manifest["artifacts"][1]["digest"]
    preview = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=digest,
        execute=False,
    )
    assert preview["executeRequired"] is True
    assert runtime_upgrade.list_images(tmp_path / "config") == []

    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=digest,
        execute=True,
    )
    assert applied["state"] == "complete"
    assert applied["frontendAction"] == "selected-on-next-command"
    images = runtime_upgrade.list_images(tmp_path / "config")
    assert [image["buildId"] for image in images] == [manifest["runtimeBuildId"]]
    assert Path(images[0]["artifactRoot"]).is_dir()
    frontend = applied["frontendImage"]
    assert frontend["frontendBuildId"] == manifest["frontendBuildId"]
    assert Path(frontend["productRoot"]).is_dir()
    selected = distribution_update.selected_cli_command(
        {
            "KUNGFU_INSTALL_SOURCE": "archive",
            "KF_CONFIG_HOME": str(tmp_path / "config"),
        },
        current_executable=tmp_path / "original" / "kungfu",
    )
    assert selected is not None
    command, selected_env = selected
    assert Path(command[0]) == Path(frontend["productRoot"]) / "kungfu" / "kungfu"
    assert (
        selected_env["KUNGFU_SELECTED_FRONTEND_BUILD_ID"] == manifest["frontendBuildId"]
    )
    assert (
        distribution_update.selected_cli_command(
            selected_env,
            current_executable=command[0],
        )
        is None
    )
    assert applied["receiptRoot"].startswith("sha256:")
    assert applied["frontendSelection"]["generation"] == 1
    assert applied["frontendSelection"]["previousFrontendBuildId"] is None


def test_cli_inventory_retains_stale_partial_and_reports_rollback_coordinates(
    tmp_path: Path,
) -> None:
    older_archive, older_manifest = _archive(
        tmp_path / "older", product_version="4.0.0-alpha.1"
    )
    newer_archive, newer_manifest = _archive(
        tmp_path / "newer", product_version="4.0.0-alpha.2"
    )
    config_home = tmp_path / "config"
    older = distribution_update.apply_archive(
        older_manifest,
        older_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=older_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    stale = (
        config_home
        / "product"
        / "cli"
        / "images"
        / f".{newer_manifest['frontendBuildId']}.{distribution_update.os.getpid()}.partial"
    )
    stale.mkdir(parents=True)
    (stale / "retained-for-recovery").write_text("partial", "utf-8")

    newer = distribution_update.apply_archive(
        newer_manifest,
        newer_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=newer_manifest["artifacts"][1]["digest"],
        execute=True,
    )

    selection = newer["frontendSelection"]
    assert selection["generation"] == 2
    assert (
        selection["previousFrontendBuildId"]
        == older["frontendImage"]["frontendBuildId"]
    )
    assert (
        selection["rollback"]["artifactDigest"]
        == older["frontendImage"]["artifactDigest"]
    )
    report = distribution_update.cli_inventory_fsck(config_home)
    assert report["ok"] is True
    assert report["selected"]["frontendBuildId"] == newer_manifest["frontendBuildId"]
    assert len(report["images"]) == 2
    assert (
        str(stale.relative_to(config_home / "product" / "cli"))
        in report["retainedPartials"]
    )
    assert stale.is_dir()


def test_cli_selection_interruption_keeps_last_known_good_and_retry_recovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    older_archive, older_manifest = _archive(
        tmp_path / "older", product_version="4.0.0-alpha.1"
    )
    newer_archive, newer_manifest = _archive(
        tmp_path / "newer", product_version="4.0.0-alpha.2"
    )
    config_home = tmp_path / "config"
    older = distribution_update.apply_archive(
        older_manifest,
        older_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=older_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    original_write = distribution_update._write_object

    def interrupt_selection(path: Path, value: dict) -> None:
        if path.name == "current.json":
            raise OSError(errno.EIO, "simulated selection interruption")
        original_write(path, value)

    monkeypatch.setattr(distribution_update, "_write_object", interrupt_selection)
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            newer_manifest,
            newer_archive,
            current_version="4.0.0-alpha.0",
            config_home=config_home,
            expected_digest=newer_manifest["artifacts"][1]["digest"],
            execute=True,
        )
    assert error.value.code == "selection-io-failed"
    selected = distribution_update.cli_inventory_fsck(config_home)
    assert selected["ok"] is True
    assert (
        selected["selected"]["frontendBuildId"]
        == older["frontendImage"]["frontendBuildId"]
    )

    monkeypatch.setattr(distribution_update, "_write_object", original_write)
    retried = distribution_update.apply_archive(
        newer_manifest,
        newer_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=newer_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    assert (
        retried["frontendSelection"]["frontendBuildId"]
        == newer_manifest["frontendBuildId"]
    )
    assert retried["frontendSelection"]["generation"] == 2


def test_cli_inventory_fsck_reports_malformed_image_without_crashing(
    tmp_path: Path,
) -> None:
    archive, manifest = _archive(tmp_path)
    config_home = tmp_path / "config"
    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    image_path = Path(applied["frontendImage"]["productRoot"]) / "image.json"
    image = json.loads(image_path.read_text("utf-8"))
    image.pop("runtimeBuildId")
    image_path.write_text(json.dumps(image), "utf-8")

    report = distribution_update.cli_inventory_fsck(config_home)

    assert report["ok"] is False
    assert report["selected"] is None
    assert {issue["code"] for issue in report["issues"]} == {
        "cli-image-unreadable",
        "cli-selection-invalid",
    }
    assert report["recoveryAction"] is not None


def test_apply_rejects_unsafe_archive_before_inventory_write(tmp_path: Path) -> None:
    _valid_archive, manifest = _archive(tmp_path)
    candidate = tmp_path / "unsafe.tar.gz"
    with tarfile.open(candidate, "w:gz") as output:
        member = tarfile.TarInfo("../escape")
        payload = b"unsafe"
        member.size = len(payload)
        output.addfile(member, io.BytesIO(payload))
    artifact = next(item for item in manifest["artifacts"] if item["kind"] == "cli")
    artifact["size"] = candidate.stat().st_size
    artifact["digest"] = f"sha256:{hashlib.sha256(candidate.read_bytes()).hexdigest()}"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            candidate,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=artifact["digest"],
            execute=True,
        )

    assert error.value.code == "archive-entry-unsupported"
    assert not (tmp_path / "config").exists()


def test_duplicate_frontend_build_id_rejects_different_archive_bytes(
    tmp_path: Path,
) -> None:
    first_archive, manifest = _archive(tmp_path)
    config_home = tmp_path / "config"
    distribution_update.apply_archive(
        manifest,
        first_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    source = tmp_path / "source" / "kungfu-cli-test"
    (source / "extra.txt").write_text("different archive bytes", "utf-8")
    second_archive = tmp_path / "different.tar.gz"
    with tarfile.open(second_archive, "w:gz") as output:
        output.add(source, arcname=source.name)
    second_manifest = json.loads(json.dumps(manifest))
    artifact = next(
        item for item in second_manifest["artifacts"] if item["kind"] == "cli"
    )
    artifact["size"] = second_archive.stat().st_size
    artifact["digest"] = (
        f"sha256:{hashlib.sha256(second_archive.read_bytes()).hexdigest()}"
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            second_manifest,
            second_archive,
            current_version="4.0.0-alpha.0",
            config_home=config_home,
            expected_digest=artifact["digest"],
            execute=True,
        )

    assert error.value.code == "frontend-build-id-collision"
    report = distribution_update.cli_inventory_fsck(config_home)
    assert report["ok"] is True
    assert report["selected"]["artifactDigest"] == manifest["artifacts"][1]["digest"]


def test_apply_keeps_newest_cli_selection_when_plans_finish_out_of_order(
    tmp_path: Path,
) -> None:
    older_archive, older_manifest = _archive(
        tmp_path / "older", product_version="4.0.0-alpha.1"
    )
    newer_archive, newer_manifest = _archive(
        tmp_path / "newer", product_version="4.0.0-alpha.2"
    )
    config_home = tmp_path / "config"

    distribution_update.apply_archive(
        newer_manifest,
        newer_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=newer_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    completed_last = distribution_update.apply_archive(
        older_manifest,
        older_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=older_manifest["artifacts"][1]["digest"],
        execute=True,
    )

    assert (
        completed_last["frontendSelection"]["frontendBuildId"]
        == newer_manifest["frontendBuildId"]
    )
    selected = distribution_update.selected_cli_command(
        {
            "KUNGFU_INSTALL_SOURCE": "archive",
            "KF_CONFIG_HOME": str(config_home),
        },
        current_executable=tmp_path / "original" / "kungfu",
    )
    assert selected is not None
    command, _selected_env = selected
    assert newer_manifest["frontendBuildId"] in command[0]


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (
            lambda manifest: {
                **manifest,
                "qualificationEvidenceRef": "unqualified-local-build",
            },
            "release-unqualified",
        ),
        (
            lambda manifest: {
                **manifest,
                "artifacts": [
                    {**artifact, "signature": "unqualified-local-build"}
                    if artifact["kind"] == "cli"
                    else artifact
                    for artifact in manifest["artifacts"]
                ],
            },
            "signature-missing",
        ),
    ],
)
@pytest.mark.parametrize("execute", [False, True])
def test_apply_rechecks_publication_before_preview_or_inventory_write(
    tmp_path: Path, mutate, expected_code: str, execute: bool
) -> None:
    archive, manifest = _archive(tmp_path)
    manifest = mutate(manifest)

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            archive,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=manifest["artifacts"][1]["digest"],
            execute=execute,
        )

    assert error.value.code == expected_code
    assert not (tmp_path / "config").exists()


def test_desktop_companion_never_selects_standalone_cli_image(tmp_path: Path) -> None:
    archive, manifest = _archive(tmp_path)
    distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    assert (
        distribution_update.selected_cli_command(
            {
                "KUNGFU_INSTALL_SOURCE": "desktop-companion",
                "KF_CONFIG_HOME": str(tmp_path / "config"),
            }
        )
        is None
    )


def test_package_manager_download_plan_never_self_updates(tmp_path: Path) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "winget"}),
        cache_root=tmp_path / "cache",
    )
    assert plan["state"] == "action-required"
    assert plan["reasonCode"] == "frontend-authority-external"
    assert plan["managerCommand"] is None


def test_cli_status_explains_frontend_runtime_and_no_daemon(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "status", "--json"],
        env={"KUNGFU_INSTALL_SOURCE": "archive"},
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.product-update-status/v1"
    assert payload["frontendVersion"] == "4.0.0-alpha.0"
    assert payload["installSource"]["source"] == "archive"
    assert payload["backgroundUpdater"] is False


def test_cli_package_manager_download_returns_one_external_action(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    manifest_file = tmp_path / "release.json"
    manifest_file.write_text(json.dumps(manifest), "utf-8")
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": [
                        "brew",
                        "upgrade",
                        "--formula",
                        "kungfu-systems/tap/kungfu",
                    ],
                    "verificationCommand": ["kungfu", "--version"],
                }
            }
        ),
        "utf-8",
    )
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(tmp_path / "home"),
            "update",
            "download",
            str(manifest_file),
            "--json",
        ],
        env={"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)},
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["state"] == "action-required"
    assert payload["managerCommand"] == [
        "brew",
        "upgrade",
        "--formula",
        "kungfu-systems/tap/kungfu",
    ]


def test_cli_apply_stages_product_and_reports_core_activation_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive, manifest = _archive(tmp_path)
    manifest_file = tmp_path / "release.json"
    manifest_file.write_text(json.dumps(manifest), "utf-8")
    monkeypatch.setattr(
        update_command,
        "_activation_plan",
        lambda _ctx, _manifest: {
            "state": "apply-now",
            "reasonCode": "workspace-idle",
            "impact": {"activationTiming": "now"},
            "nextAction": "Reconcile semantic readiness.",
        },
    )
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(tmp_path / "home"),
            "update",
            "apply",
            str(manifest_file),
            str(archive),
            "--expected-digest",
            manifest["artifacts"][1]["digest"],
            "--execute",
            "--json",
        ],
        env={"KUNGFU_INSTALL_SOURCE": "archive"},
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["frontendAction"] == "selected-on-next-command"
    assert payload["activationPlan"]["state"] == "apply-now"
    assert payload["message"]["reasonCode"] == "workspace-idle"


def test_one_command_plan_binds_channel_source_and_exact_action(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    archive_source = distribution_update.install_source(
        {"KUNGFU_INSTALL_SOURCE": "archive"}
    )
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=archive_source,
        cache_root=tmp_path / "cache",
    )
    assert plan["schema"] == distribution_update.ORCHESTRATION_PLAN_SCHEMA
    assert plan["state"] == "update-available"
    assert plan["action"] == "archive-self-update"
    assert plan["releasePayloadRoot"] == f"sha256:{'4' * 64}"
    assert plan["downloadPlan"]["planId"]
    assert plan["impact"]["activeWorkContinues"] is True

    current = distribution_update.plan_update(
        _selection({**manifest, "productVersion": "4.0.0-alpha.0"}),
        current_version="4.0.0-alpha.0",
        source=archive_source,
        cache_root=tmp_path / "cache",
    )
    assert current["state"] == "current"
    assert current["reasonCode"] == "already-current"

    manager_source = distribution_update.install_source(
        {"KUNGFU_INSTALL_SOURCE": "homebrew"}
    )
    manager_required = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=manager_source,
        cache_root=tmp_path / "cache",
    )
    assert manager_required["state"] == "action-required"
    assert manager_required["reasonCode"] == "manager-required"

    desktop = distribution_update.plan_update(
        _selection(manifest, source="desktop-companion"),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source(
            {"KUNGFU_INSTALL_SOURCE": "desktop-companion"}
        ),
        cache_root=tmp_path / "cache",
    )
    assert desktop["reasonCode"] == "desktop-required"
    assert desktop["action"] == "desktop-companion"

    unsupported = distribution_update.plan_update(
        _selection(manifest, source="native-installer"),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source(
            {"KUNGFU_INSTALL_SOURCE": "native-installer"}
        ),
        cache_root=tmp_path / "cache",
    )
    assert unsupported["reasonCode"] == "unsupported-source"


def test_one_command_plan_rejects_stale_identity(tmp_path: Path) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    changed = {**plan, "targetVersion": "4.0.0-alpha.9"}
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.validate_update_plan(
            changed, expected_plan_id=plan["planId"]
        )
    assert captured.value.code == "stale-plan"


def test_package_manager_execution_uses_exact_argv_and_writes_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": [
                        "brew",
                        "upgrade",
                        "--formula",
                        "kungfu-systems/tap/kungfu",
                    ],
                    "verificationCommand": ["kungfu", "--version"],
                }
            }
        ),
        "utf-8",
    )
    source = distribution_update.install_source(
        {"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)}
    )
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )
    calls = []
    monkeypatch.setenv("KUNGFU_TEST_SECRET", "must-not-reach-manager")

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        output = "" if argv[0] == "brew" else f"kungfu {manifest['productVersion']}\n"
        return types.SimpleNamespace(returncode=0, stdout=output, stderr="")

    receipt = distribution_update.execute_update(
        plan,
        expected_plan_id=plan["planId"],
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        command_runner=runner,
        activation_planner=lambda value: {
            "state": "defer-until-idle",
            "impact": {"activationTiming": "after current work is idle"},
            "runtimeBuildId": value["runtimeBuildId"],
        },
    )
    assert [call[0] for call in calls] == [
        ["brew", "upgrade", "--formula", "kungfu-systems/tap/kungfu"],
        ["kungfu", "--version"],
    ]
    assert all(call[1]["shell"] is False for call in calls)
    assert all("KUNGFU_TEST_SECRET" not in call[1]["env"] for call in calls)
    assert receipt["state"] == "complete"
    assert receipt["result"]["verifiedVersion"] == manifest["productVersion"]
    assert Path(receipt["receiptPath"]).is_file()
    assert json.loads(Path(receipt["receiptPath"]).read_text("utf-8")) == receipt


def test_package_manager_failure_is_durable_and_recoverable(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(_argv, **_kwargs):
        return types.SimpleNamespace(returncode=1, stdout="", stderr="private detail")

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == "update-command-failed"
    assert captured.value.receipt is not None
    assert captured.value.receipt["state"] == "failed"
    receipt_paths = list(
        (tmp_path / "config" / "product" / "update" / "receipts" / plan["planId"]).glob(
            "*.json"
        )
    )
    assert len(receipt_paths) == 1
    receipt_path = receipt_paths[0]
    receipt = json.loads(receipt_path.read_text("utf-8"))
    assert receipt["state"] == "failed"
    assert receipt["reasonCode"] == "update-command-failed"
    assert receipt["recoveryAction"]
    assert "private detail" not in receipt_path.read_text("utf-8")


def test_homebrew_product_manifest_rejects_untrusted_or_incomplete_argv(
    tmp_path: Path,
) -> None:
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": ["sh", "-c", "brew upgrade kungfu"],
                    "verificationCommand": ["kungfu", "--version"],
                }
            }
        ),
        "utf-8",
    )
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.install_source(
            {"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)}
        )
    assert captured.value.code == "package-manager-command-untrusted"

    product_manifest.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": [
                        "brew",
                        "upgrade",
                        "--formula",
                        "kungfu-systems/tap/kungfu",
                    ],
                }
            }
        ),
        "utf-8",
    )
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.install_source(
            {"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)}
        )
    assert captured.value.code == "package-manager-contract-incomplete"


@pytest.mark.parametrize(
    ("stderr", "reason_code"),
    [
        (
            "Error: No available formula with the name kungfu-systems/tap/kungfu",
            "package-manager-formula-unavailable",
        ),
        ("Error: No such keg: kungfu", "package-manager-formula-not-installed"),
        ("curl: Could not resolve host: github.com", "package-manager-offline"),
        ("Error: /opt/homebrew is not writable", "package-manager-permission-denied"),
    ],
)
def test_homebrew_failure_diagnostics_are_stable_and_do_not_leak_stderr(
    tmp_path: Path,
    stderr: str,
    reason_code: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(_argv, **_kwargs):
        return types.SimpleNamespace(returncode=1, stdout="", stderr=stderr)

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == reason_code
    assert captured.value.receipt is not None
    assert captured.value.receipt["reasonCode"] == reason_code
    assert stderr not in json.dumps(captured.value.receipt)


@pytest.mark.parametrize(
    ("raised", "reason_code", "receipt_state"),
    [
        (FileNotFoundError("brew"), "package-manager-unavailable", "failed"),
        (
            subprocess.TimeoutExpired(["brew"], 900),
            "update-command-timeout",
            "failed",
        ),
        (KeyboardInterrupt(), "update-cancelled", "cancelled"),
    ],
)
def test_homebrew_start_timeout_and_cancellation_have_stable_receipts(
    tmp_path: Path,
    raised: BaseException,
    reason_code: str,
    receipt_state: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(_argv, **_kwargs):
        raise raised

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == reason_code
    assert captured.value.receipt is not None
    assert captured.value.receipt["state"] == receipt_state
    assert captured.value.receipt["reasonCode"] == reason_code


def test_homebrew_completed_command_requires_exact_target_version(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(argv, **_kwargs):
        stdout = "" if argv[0] == "brew" else "kungfu 4.0.0-alpha.0\n"
        return types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == "update-verification-failed"
    assert captured.value.receipt is not None
    assert captured.value.receipt["reasonCode"] == "update-verification-failed"


def test_bare_update_check_noninteractive_and_yes_modes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    discovery = {
        "schema": "kungfu.product-update-discovery/v1",
        "transportState": "local-fixture",
        "cachePath": None,
        "plan": plan,
    }
    monkeypatch.setattr(
        update_command, "_discover_update_plan", lambda *_args: discovery
    )

    checked = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--check", "--json"],
    )
    assert checked.exit_code == 0, checked.output
    assert json.loads(checked.output)["plan"]["planId"] == plan["planId"]

    noninteractive = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--json"],
    )
    assert noninteractive.exit_code == 0, noninteractive.output
    assert json.loads(noninteractive.output)["reasonCode"] == "confirmation-required"

    expected_receipt = {
        "schema": distribution_update.ORCHESTRATION_RECEIPT_SCHEMA,
        "state": "complete",
        "receiptPath": str(tmp_path / "receipt.json"),
        "result": {
            "activationPlan": {
                "impact": {"activationTiming": "after current work is idle"},
                "nextAction": "Keep current work running.",
            }
        },
    }
    monkeypatch.setattr(
        distribution_update,
        "execute_update",
        lambda *_args, **_kwargs: expected_receipt,
    )
    executed = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--yes", "--json"],
    )
    assert executed.exit_code == 0, executed.output
    assert json.loads(executed.output)["state"] == "complete"

    current_manifest = {**manifest, "productVersion": "4.0.0-alpha.0"}
    current_plan = distribution_update.plan_update(
        _selection(current_manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {**discovery, "plan": current_plan},
    )
    no_update = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--json"],
    )
    assert no_update.exit_code == 0, no_update.output
    assert json.loads(no_update.output)["plan"]["state"] == "current"


def test_previous_archive_alpha_upgrades_once_with_rooted_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "local-fixture",
            "cachePath": None,
            "plan": plan,
        },
    )
    monkeypatch.setattr(
        update_command,
        "_activation_plan",
        lambda _ctx, value: {
            "state": "apply-now",
            "reasonCode": "workspace-idle",
            "runtimeBuildId": value["runtimeBuildId"],
            "impact": {
                "activeWorkContinues": False,
                "activationTiming": "now",
                "userActionRequired": False,
            },
            "nextAction": "Reconcile semantic readiness.",
        },
    )
    monkeypatch.setattr(
        distribution_update,
        "_open_https",
        lambda *_args, **_kwargs: _Response(archive.read_bytes()),
    )
    home = tmp_path / "installed-alpha"
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(home),
            "update",
            "--yes",
            "--json",
        ],
        env={"KUNGFU_INSTALL_SOURCE": "archive"},
    )

    assert result.exit_code == 0, result.output
    receipt = json.loads(result.output)
    assert receipt["state"] == "complete"
    assert receipt["receiptRoot"].startswith("sha256:")
    orchestration_core = {
        key: value
        for key, value in receipt.items()
        if key not in {"receiptRoot", "receiptPath"}
    }
    assert receipt["receiptRoot"] == distribution_update._content_root(
        orchestration_core
    )
    assert receipt["releasePayloadRoot"] == plan["releasePayloadRoot"]
    execution = receipt["result"]
    for stage in ("download", "apply"):
        stage_receipt = execution[stage]
        stage_core = {
            key: value for key, value in stage_receipt.items() if key != "receiptRoot"
        }
        assert stage_receipt["receiptRoot"] == distribution_update._content_root(
            stage_core
        )
    assert (
        execution["apply"]["frontendImage"]["frontendBuildId"]
        == manifest["frontendBuildId"]
    )
    assert execution["apply"]["runtimeImage"]["buildId"] == manifest["runtimeBuildId"]
    assert Path(receipt["receiptPath"]).is_file()
    assert distribution_update.cli_inventory_fsck(home / "config")["ok"] is True


def test_bare_update_interactive_cancellation_writes_one_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "local-fixture",
            "cachePath": None,
            "plan": plan,
        },
    )
    monkeypatch.setattr(update_command, "_stdin_is_interactive", lambda: True)
    result = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update"],
        input="n\n",
    )
    assert result.exit_code == 0, result.output
    assert result.output.count("Proceed with this exact update?") == 1
    receipt_paths = list(
        (tmp_path / "config" / "product" / "update" / "receipts" / plan["planId"]).glob(
            "*.json"
        )
    )
    assert len(receipt_paths) == 1
    receipt_path = receipt_paths[0]
    receipt = json.loads(receipt_path.read_text("utf-8"))
    assert receipt["state"] == "cancelled"
    assert receipt["reasonCode"] == "cancelled-by-user"


@pytest.mark.parametrize(
    ("install_source", "reason_code"),
    [
        ("homebrew", "manager-required"),
        ("desktop-companion", "desktop-required"),
        ("native-installer", "unsupported-source"),
    ],
)
def test_bare_update_projects_non_executable_source_actions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    install_source: str,
    reason_code: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest, source=install_source),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source(
            {"KUNGFU_INSTALL_SOURCE": install_source}
        ),
        cache_root=tmp_path / "cache",
    )
    monkeypatch.setattr(
        update_command,
        "_discover_update_plan",
        lambda *_args: {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "local-fixture",
            "cachePath": None,
            "plan": plan,
        },
    )
    result = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["plan"]["state"] == "action-required"
    assert payload["plan"]["reasonCode"] == reason_code


def test_bare_update_forwards_explicit_channel_and_offline_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path, product_version="4.0.0-alpha.0")
    manifest["releaseChannel"] = "stable"
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    seen = {}

    def discover(_ctx, channel, offline):
        seen.update(channel=channel, offline=offline)
        return {
            "schema": "kungfu.product-update-discovery/v1",
            "transportState": "offline-cache",
            "cachePath": str(tmp_path / "cache.json"),
            "plan": plan,
        }

    monkeypatch.setattr(update_command, "_discover_update_plan", discover)
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(tmp_path),
            "update",
            "--channel",
            "stable",
            "--offline",
            "--check",
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert seen == {"channel": "stable", "offline": True}
