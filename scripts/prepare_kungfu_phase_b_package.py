# SPDX-License-Identifier: Apache-2.0

"""Validate and stage the exact Kungfu CLI package consumed by Phase B."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any

PACKAGE_NAME = "kungfu-cli-linux-x64.tar.gz"
PACKAGE_ROOT = "kungfu-cli-linux-x64"
MAX_METADATA_BYTES = 4 * 1024 * 1024
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


class PackageIdentityError(RuntimeError):
    """Raised when the package cannot be bound to the expected identity."""


def fail(message: str) -> None:
    raise PackageIdentityError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_package(input_root: Path) -> Path:
    matches = sorted(path for path in input_root.rglob(PACKAGE_NAME) if path.is_file())
    if len(matches) != 1:
        fail(
            f"expected exactly one {PACKAGE_NAME} under {input_root}, "
            f"found {len(matches)}"
        )
    return matches[0]


def validate_member(member: tarfile.TarInfo) -> None:
    name = member.name
    path = PurePosixPath(name)
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or ".." in path.parts
        or path.parts[0] != PACKAGE_ROOT
    ):
        fail(f"unsafe archive member path: {name!r}")
    if not (member.isfile() or member.isdir()):
        fail(f"unsupported archive member type: {name!r}")


def read_metadata(
    archive: tarfile.TarFile,
    members: list[tarfile.TarInfo],
    relative_path: str,
) -> dict[str, Any]:
    expected = f"{PACKAGE_ROOT}/{relative_path}"
    matches = [member for member in members if member.name == expected]
    if len(matches) != 1 or not matches[0].isfile():
        fail(f"expected exactly one regular metadata file: {expected}")
    member = matches[0]
    if member.size > MAX_METADATA_BYTES:
        fail(f"metadata file exceeds {MAX_METADATA_BYTES} bytes: {expected}")
    source = archive.extractfile(member)
    if source is None:
        fail(f"cannot read metadata file: {expected}")
    try:
        value = json.loads(source.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid JSON metadata in {expected}: {error}")
    if not isinstance(value, dict):
        fail(f"metadata root must be an object: {expected}")
    return value


def require_equal(
    value: dict[str, Any], field: str, expected: Any, document: str
) -> None:
    if value.get(field) != expected:
        fail(
            f"{document} field {field!r} must be {expected!r}, got {value.get(field)!r}"
        )


def validate_package_metadata(
    package: Path, expected_source_sha: str, expected_version: str
) -> None:
    try:
        with tarfile.open(package, "r:gz") as archive:
            members = archive.getmembers()
            if not members:
                fail("package archive is empty")
            for member in members:
                validate_member(member)

            product = read_metadata(archive, members, "product.json")
            compatibility = read_metadata(
                archive, members, "runtime/product-compatibility.json"
            )
            upgrade = read_metadata(
                archive, members, "upgrade/kungfu-release-manifest.json"
            )
    except (tarfile.TarError, OSError) as error:
        fail(f"cannot read package archive {package}: {error}")

    require_equal(product, "schema", "kungfu.product.cli/v1", "product.json")
    require_equal(product, "product", "cli", "product.json")
    require_equal(product, "platform", "linux-x64", "product.json")
    require_equal(product, "archive", PACKAGE_NAME, "product.json")
    entries = product.get("entries")
    if not isinstance(entries, dict):
        fail("product.json field 'entries' must be an object")
    require_equal(
        entries,
        "compatibility",
        "runtime/product-compatibility.json",
        "product.json entries",
    )
    require_equal(
        entries,
        "upgradeManifest",
        "upgrade/kungfu-release-manifest.json",
        "product.json entries",
    )

    require_equal(
        compatibility,
        "schema",
        "kungfu.product.compatibility/v1",
        "product compatibility",
    )
    require_equal(
        compatibility, "source_commit", expected_source_sha, "product compatibility"
    )
    require_equal(compatibility, "platform", "linux-x64", "product compatibility")
    versions = compatibility.get("versions")
    if not isinstance(versions, dict):
        fail("product compatibility field 'versions' must be an object")
    require_equal(
        versions,
        "product",
        expected_version,
        "product compatibility versions",
    )

    require_equal(
        upgrade,
        "schema",
        "kungfu.product-upgrade.manifest/v1",
        "upgrade manifest",
    )
    require_equal(upgrade, "productVersion", expected_version, "upgrade manifest")
    require_equal(upgrade, "sourceCommit", expected_source_sha, "upgrade manifest")
    require_equal(upgrade, "platform", "linux", "upgrade manifest")
    require_equal(upgrade, "architecture", "x64", "upgrade manifest")


def write_github_output(path: Path, values: dict[str, str | int]) -> None:
    with path.open("a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def prepare_package(
    *,
    input_root: Path,
    output_dir: Path,
    expected_source_sha: str,
    expected_version: str,
    build_images_ref: str,
    build_images_sha: str,
    github_output: Path | None = None,
) -> dict[str, Any]:
    if not SHA_PATTERN.fullmatch(expected_source_sha):
        fail("expected source SHA must be exactly 40 lowercase hexadecimal characters")
    if not expected_version.strip():
        fail("expected version must not be empty")
    if not build_images_ref.strip():
        fail("build-images ref must not be empty")
    if not SHA_PATTERN.fullmatch(build_images_sha):
        fail("build-images SHA must be exactly 40 lowercase hexadecimal characters")
    if output_dir.exists():
        fail(f"output directory already exists: {output_dir}")

    package = find_package(input_root)
    validate_package_metadata(package, expected_source_sha, expected_version)
    package_sha256 = sha256_file(package)
    package_size = package.stat().st_size

    output_dir.mkdir(parents=True)
    staged_package = output_dir / PACKAGE_NAME
    shutil.copyfile(package, staged_package)
    identity = {
        "schema": "kungfu.phase-b-package-identity/v1",
        "package": {
            "filename": PACKAGE_NAME,
            "sha256": package_sha256,
            "sizeBytes": package_size,
            "version": expected_version,
            "sourceCommit": expected_source_sha,
            "platform": "linux-x64",
        },
        "consumer": {
            "repository": "kungfu-systems/build-images",
            "ref": build_images_ref,
            "commit": build_images_sha,
        },
    }
    identity_path = output_dir / "package-identity.json"
    identity_path.write_text(
        json.dumps(identity, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    outputs: dict[str, str | int] = {
        "package_sha256": package_sha256,
        "package_size_bytes": package_size,
        "package_version": expected_version,
        "source_sha": expected_source_sha,
    }
    if github_output is not None:
        write_github_output(github_output, outputs)
    print(json.dumps(identity, sort_keys=True))
    return identity


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-source-sha", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--build-images-ref", required=True)
    parser.add_argument("--build-images-sha", required=True)
    parser.add_argument(
        "--github-output",
        type=Path,
        default=Path(os.environ["GITHUB_OUTPUT"])
        if os.environ.get("GITHUB_OUTPUT")
        else None,
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        prepare_package(
            input_root=args.input_root,
            output_dir=args.output_dir,
            expected_source_sha=args.expected_source_sha,
            expected_version=args.expected_version,
            build_images_ref=args.build_images_ref,
            build_images_sha=args.build_images_sha,
            github_output=args.github_output,
        )
    except PackageIdentityError as error:
        raise SystemExit(f"prepare Phase B package: {error}") from error


if __name__ == "__main__":
    main()
