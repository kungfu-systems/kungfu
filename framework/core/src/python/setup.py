#  SPDX-License-Identifier: Apache-2.0
#
# S1 阶段 B：脱 poetry-core，改读 [project]（PEP 621）做单一真相源。
# - version 仍来自 kungfubuildinfo.json（构建期信息，非 pyproject 静态字段）。
# - setup.py 在 build/python 下运行（run-wheel.js copy src/python→build/python，不含
#   pyproject），故向上递归查找 pyproject.toml（沿用旧 poetry Factory 的向上查找行为，
#   实测它命中 framework/core/pyproject.toml）。

import json
import sys

from os import path
from pathlib import Path
from setuptools import find_packages, setup
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


class BinaryDistribution(Distribution):
    """Distribution which always forces a binary package with platform name"""

    def has_ext_modules(self):
        return True


setup(
    name=project["name"],
    version=build_info["version"],
    license=_license(),
    author=_author(),
    url=urls.get("homepage"),
    project_urls={"repository": urls["repository"]} if "repository" in urls else {},
    packages=[""] + find_packages(exclude=["test"]),
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
        ]
    },
    include_package_data=True,
    # [project].dependencies 已是 PEP 508 完整约束（含平台 marker），直接作为 wheel
    # 的 install_requires；与旧 poetry 把全部 deps 注入 install_requires 行为等价。
    install_requires=project.get("dependencies", []),
    entry_points={"console_scripts": ["kfc = kungfu.__main__:main"]},
    distclass=BinaryDistribution,
    has_ext_modules=lambda: True,
)
