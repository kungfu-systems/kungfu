#  SPDX-License-Identifier: Apache-2.0
#
# S1 阶段 B：脱 poetry-core，改读 [project]（PEP 621）做单一真相源。
# - version 仍来自 kungfubuildinfo.json（构建期信息，非 pyproject 静态字段）。
# - setup.py 在 build/python 下运行（run-wheel.js copy src/python→build/python，不含
#   pyproject），故向上递归查找 pyproject.toml（沿用旧 poetry Factory 的向上查找行为，
#   实测它命中 framework/core/pyproject.toml）。

import json
import posixpath
import re
import shutil
import sys

from os import path
from pathlib import Path
from pathlib import PurePosixPath
from setuptools import find_packages, setup
from setuptools.command.build_py import build_py
from setuptools.dist import Distribution

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - 运行环境为 py3.13；此分支仅作兜底
    import tomli as tomllib


def _find_pyproject(start):
    here = Path(start).resolve()
    for candidate_dir in (here, *here.parents):
        pyproject = candidate_dir / "pyproject.toml"
        if pyproject.is_file():
            return pyproject
    raise FileNotFoundError(f"pyproject.toml not found upward from {here}")


_here = path.dirname(path.abspath(__file__))
with open(_find_pyproject(_here), "rb") as pyproject_file:
    project = tomllib.load(pyproject_file)["project"]

with open(path.join(_here, "kungfubuildinfo.json"), "r") as build_info_file:
    build_info = json.load(build_info_file)


def _author():
    authors = project.get("authors") or [{}]
    name = authors[0].get("name", "")
    email = authors[0].get("email", "")
    return f"{name} <{email}>" if email else name


def _license():
    lic = project.get("license")
    if isinstance(lic, dict):
        return lic.get("text", "")
    return lic or ""


urls = project.get("urls", {})


_STATIC_ESM_PATTERNS = (
    re.compile(r"(?:^|\n)\s*import\s+(?:[^'\";]*?\sfrom\s+)?(['\"])([^'\"]+)\1"),
    re.compile(r"(?:^|\n)\s*export\s+[^'\";]*?\sfrom\s+(['\"])([^'\"]+)\1"),
)


def _load_work_design_manifest(repository_root):
    manifest_path = repository_root.joinpath(
        "framework", "work-design-preflight", "work-design-runtime.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schema") != "kungfu.work-design.runtime-closure/v1"
        or not isinstance(manifest.get("entrypoint"), str)
        or not isinstance(manifest.get("files"), list)
    ):
        raise ValueError("invalid Work Design runtime closure manifest")
    if manifest["entrypoint"] not in manifest["files"]:
        raise ValueError("Work Design entrypoint is absent from its closure")
    return manifest


def _work_design_coordinate(relative):
    coordinate = PurePosixPath(relative)
    if coordinate.is_absolute() or ".." in coordinate.parts:
        raise ValueError(f"invalid Work Design runtime path: {relative}")
    return coordinate


def _relative_esm_dependencies(source, coordinate):
    for pattern in _STATIC_ESM_PATTERNS:
        for match in pattern.finditer(source):
            specifier = match.group(2)
            if not specifier.startswith("."):
                continue
            dependency = coordinate.parent.joinpath(specifier)
            normalized = PurePosixPath(posixpath.normpath(dependency.as_posix()))
            if ".." in normalized.parts:
                raise ValueError(
                    f"Work Design import escapes framework: {coordinate} -> {specifier}"
                )
            yield normalized.as_posix()


def _work_design_runtime_files(repository_root):
    manifest = _load_work_design_manifest(repository_root)
    declared = set(manifest["files"])
    discovered = set()
    pending = [manifest["entrypoint"]]
    framework_root = (repository_root / "framework").resolve()
    while pending:
        relative = pending.pop()
        if relative in discovered:
            continue
        coordinate = _work_design_coordinate(relative)
        if relative not in declared:
            raise ValueError(f"undeclared Work Design runtime dependency: {relative}")
        source_path = framework_root.joinpath(*coordinate.parts)
        source = source_path.read_text(encoding="utf-8")
        discovered.add(relative)
        pending.extend(_relative_esm_dependencies(source, coordinate))
    extras = sorted(declared - discovered)
    if extras:
        raise ValueError(f"unreachable Work Design runtime files: {', '.join(extras)}")
    return sorted(discovered)


class BinaryDistribution(Distribution):
    """Distribution which always forces a binary package with platform name"""

    def has_ext_modules(self):
        return True


class BuildPythonWithExitContract(build_py):
    """Ship normative contracts and installed Work read-only runtimes."""

    def run(self):
        super().run()
        source = (
            _find_pyproject(_here).parent.parent
            / "exit"
            / "kungfu-exit-bundle.contract.json"
        )
        destination = Path(self.build_lib) / "kungfu" / "exit_bundle.contract.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        conformance_source = (
            _find_pyproject(_here).parent.parent / "work-profile-conformance"
        )
        conformance_destination = (
            Path(self.build_lib) / "kungfu" / "work_profile_conformance"
        )
        shutil.copytree(conformance_source, conformance_destination, dirs_exist_ok=True)
        manifest = json.loads(
            (conformance_source / "authority-manifest.json").read_text(encoding="utf-8")
        )
        repository_root = _find_pyproject(_here).parent.parent.parent
        for coordinate in manifest["files"]:
            relative = Path(coordinate["path"])
            source_file = (repository_root / relative).resolve()
            if not source_file.is_relative_to(repository_root.resolve()):
                raise ValueError(f"invalid Work conformance authority path: {relative}")
            destination_file = conformance_destination / "authority" / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_file, destination_file)

        work_design_runtime = (
            Path(self.build_lib) / "kungfu" / "work_design_runtime" / "framework"
        )
        work_design_manifest = (
            repository_root
            / "framework"
            / "work-design-preflight"
            / "work-design-runtime.json"
        )
        work_design_runtime.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(
            work_design_manifest,
            work_design_runtime.parent / "work-design-runtime.json",
        )
        for relative in _work_design_runtime_files(repository_root):
            coordinate = PurePosixPath(relative)
            source_file = repository_root / "framework" / Path(*coordinate.parts)
            destination_file = work_design_runtime / Path(*coordinate.parts)
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_file, destination_file)


setup(
    name=project["name"],
    version=build_info["version"],
    license=_license(),
    author=_author(),
    url=urls.get("homepage"),
    project_urls={"repository": urls["repository"]} if "repository" in urls else {},
    # project_tour intentionally remains a PEP 420 namespace package, so the
    # legacy find_packages scan cannot discover it even though the installed
    # CLI imports it during registry bootstrap.
    packages=[""] + find_packages(exclude=["test"]) + ["kungfu.project_tour"],
    package_data={
        "": [
            "*.dll",
            "*.dylib",
            "*.pyd",
            "*.so",
            "*.so.*",
            "*.json",
            "*.md",
            "examples/*.md",
            "skills/*/SKILL.md",
        ],
        "kungfu.kfx_authoring_assets": [
            "brief.md",
            "contract.json",
            "sdk/*.d.ts",
            "sdk/*.mjs",
            "templates/webhook-service/*.tmpl",
            "templates/webhook-service/fixtures/*.mjs",
            "templates/webhook-service/src/*.tmpl",
            "templates/webhook-service/test/*.tmpl",
        ],
    },
    include_package_data=True,
    # [project].dependencies 已是 PEP 508 完整约束（含平台 marker），直接作为 wheel
    # 的 install_requires；与旧 poetry 把全部 deps 注入 install_requires 行为等价。
    install_requires=project.get("dependencies", []),
    entry_points={
        "console_scripts": [
            "kungfu-exit-verify = kungfu.exit_verifier:main",
        ]
    },
    cmdclass={"build_py": BuildPythonWithExitContract},
    distclass=BinaryDistribution,
    has_ext_modules=lambda: True,
)
