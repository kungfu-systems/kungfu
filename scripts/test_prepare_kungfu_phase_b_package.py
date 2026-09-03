# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from scripts.prepare_kungfu_phase_b_package import (
    PACKAGE_NAME,
    PackageIdentityError,
    prepare_package,
)

SOURCE_SHA = "a" * 40
BUILD_IMAGES_SHA = "b" * 40
VERSION = "4.0.0-alpha.1"
ROOT = "kungfu-cli-linux-x64"


def metadata_files(
    *,
    source_sha: str = SOURCE_SHA,
    version: str = VERSION,
) -> dict[str, dict[str, object]]:
    return {
        "product.json": {
            "schema": "kungfu.product.cli/v1",
            "product": "cli",
            "platform": "linux-x64",
            "archive": PACKAGE_NAME,
            "entries": {
                "compatibility": "runtime/product-compatibility.json",
                "upgradeManifest": "upgrade/kungfu-release-manifest.json",
            },
        },
        "runtime/product-compatibility.json": {
            "schema": "kungfu.product.compatibility/v1",
            "source_commit": source_sha,
            "platform": "linux-x64",
            "versions": {"product": version},
        },
        "upgrade/kungfu-release-manifest.json": {
            "schema": "kungfu.product-upgrade.manifest/v1",
            "productVersion": version,
            "sourceCommit": source_sha,
            "platform": "linux",
            "architecture": "x64",
        },
    }


def write_package(
    path: Path,
    *,
    source_sha: str = SOURCE_SHA,
    version: str = VERSION,
    unsafe_symlink: bool = False,
) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for relative, value in metadata_files(
            source_sha=source_sha, version=version
        ).items():
            payload = (json.dumps(value) + "\n").encode()
            info = tarfile.TarInfo(f"{ROOT}/{relative}")
            info.size = len(payload)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(payload))
        if unsafe_symlink:
            info = tarfile.TarInfo(f"{ROOT}/escape")
            info.type = tarfile.SYMTYPE
            info.linkname = "../../outside"
            archive.addfile(info)


class PrepareKungfuPhaseBPackageTest(unittest.TestCase):
    def prepare(self, source: Path, output: Path, github_output: Path | None = None):
        return prepare_package(
            input_root=source,
            output_dir=output,
            expected_source_sha=SOURCE_SHA,
            expected_version=VERSION,
            build_images_ref="v1.2.4-alpha.28",
            build_images_sha=BUILD_IMAGES_SHA,
            github_output=github_output,
        )

    def test_stages_exact_package_and_identity_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input" / "nested"
            source.mkdir(parents=True)
            package = source / PACKAGE_NAME
            write_package(package)
            github_output = root / "github-output"

            identity = self.prepare(root / "input", root / "output", github_output)

            self.assertEqual(identity["package"]["sourceCommit"], SOURCE_SHA)
            self.assertEqual(identity["package"]["version"], VERSION)
            self.assertEqual(identity["consumer"]["commit"], BUILD_IMAGES_SHA)
            self.assertEqual(
                (root / "output" / PACKAGE_NAME).read_bytes(), package.read_bytes()
            )
            retained = json.loads(
                (root / "output" / "package-identity.json").read_text()
            )
            self.assertEqual(retained, identity)
            outputs = github_output.read_text()
            self.assertIn(f"source_sha={SOURCE_SHA}\n", outputs)
            self.assertIn(f"package_version={VERSION}\n", outputs)
            self.assertRegex(outputs, r"package_sha256=[0-9a-f]{64}\n")

    def test_rejects_source_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.mkdir(exist_ok=True)
            write_package(root / PACKAGE_NAME, source_sha="c" * 40)
            with self.assertRaisesRegex(PackageIdentityError, "source_commit.*must be"):
                self.prepare(root, root / "output")

    def test_rejects_version_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_package(root / PACKAGE_NAME, version="4.0.0-alpha.0")
            with self.assertRaisesRegex(
                PackageIdentityError, "versions.*product.*must be"
            ):
                self.prepare(root, root / "output")

    def test_rejects_unsafe_archive_member(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_package(root / PACKAGE_NAME, unsafe_symlink=True)
            with self.assertRaisesRegex(
                PackageIdentityError, "unsupported archive member type"
            ):
                self.prepare(root, root / "output")

    def test_rejects_multiple_candidate_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for directory in ("one", "two"):
                target = root / directory
                target.mkdir()
                write_package(target / PACKAGE_NAME)
            with self.assertRaisesRegex(PackageIdentityError, "found 2"):
                self.prepare(root, root / "output")


if __name__ == "__main__":
    unittest.main()
