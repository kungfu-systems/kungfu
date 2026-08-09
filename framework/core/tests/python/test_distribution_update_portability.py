# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest

from kungfu import distribution_update, runtime_upgrade
from test_distribution_update import _archive


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


def test_apply_preserves_and_verifies_runtime_symlinks_in_selected_cli_image(
    tmp_path: Path,
) -> None:
    archive, manifest = _archive(tmp_path, runtime_symlink=True)
    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )

    frontend_runtime = Path(applied["frontendImage"]["productRoot"]) / "kungfu"
    alias = frontend_runtime / "kungfu-alias"
    assert alias.is_symlink()
    assert alias.readlink() == Path("kungfu")
    assert (
        runtime_upgrade.tree_digest(frontend_runtime)
        == manifest["runtimeArtifactDigest"]
    )
    selected = distribution_update.selected_cli_command(
        {
            "KUNGFU_INSTALL_SOURCE": "archive",
            "KF_CONFIG_HOME": str(tmp_path / "config"),
        },
        current_executable=tmp_path / "original" / "kungfu",
    )
    assert selected is not None
    assert Path(selected[0][0]) == frontend_runtime / "kungfu"


def test_apply_rejects_staged_cli_runtime_digest_drift(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive, manifest = _archive(tmp_path)
    copytree = distribution_update.shutil.copytree

    def copytree_with_drift(source, target, *args, **kwargs):
        copied = copytree(source, target, *args, **kwargs)
        if (Path(source) / "product.json").is_file():
            (Path(target) / "kungfu" / "kungfu").write_text("tampered\n", "utf-8")
        return copied

    monkeypatch.setattr(distribution_update.shutil, "copytree", copytree_with_drift)
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            archive,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=manifest["artifacts"][1]["digest"],
            execute=True,
        )

    assert error.value.code == "runtime-artifact-invalid"
    assert not (
        tmp_path / "config" / "product" / "cli" / "images" / manifest["frontendBuildId"]
    ).exists()


def test_tar_archive_accepts_internal_relative_symlink(tmp_path: Path) -> None:
    candidate = tmp_path / "portable.tar.gz"
    with tarfile.open(candidate, "w:gz") as output:
        directory = tarfile.TarInfo("product/runtime/bin")
        directory.type = tarfile.DIRTYPE
        output.addfile(directory)
        payload = b"runtime"
        executable = tarfile.TarInfo("product/runtime/bin/python3")
        executable.size = len(payload)
        output.addfile(executable, io.BytesIO(payload))
        link = tarfile.TarInfo("product/runtime/bin/python")
        link.type = tarfile.SYMTYPE
        link.linkname = "python3"
        output.addfile(link)

    archive_type, members = distribution_update._validate_archive(
        candidate,
        archive_size=candidate.stat().st_size,
    )
    target = tmp_path / "extracted"
    target.mkdir()
    distribution_update._extract_archive(
        candidate,
        target,
        archive_type=archive_type,
        members=members,
    )

    installed_link = target / "product/runtime/bin/python"
    assert installed_link.is_symlink()
    assert installed_link.readlink() == Path("python3")
    assert installed_link.read_bytes() == payload


@pytest.mark.parametrize(
    "link_name",
    [
        "/tmp/escape",
        "../../../../escape",
        "C:/escape",
        "C:escape",
        r"C:\escape",
        "//server/share",
    ],
)
def test_tar_archive_rejects_escaping_symlink(
    tmp_path: Path,
    link_name: str,
) -> None:
    candidate = tmp_path / "unsafe-link.tar.gz"
    with tarfile.open(candidate, "w:gz") as output:
        link = tarfile.TarInfo("product/runtime/bin/python")
        link.type = tarfile.SYMTYPE
        link.linkname = link_name
        output.addfile(link)

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update._validate_archive(
            candidate,
            archive_size=candidate.stat().st_size,
        )

    assert error.value.code == "archive-entry-unsupported"
