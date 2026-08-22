# SPDX-License-Identifier: Apache-2.0

"""Verify the exact protected-baseline Agent Python responsibility map."""

from __future__ import annotations

import ast
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "framework/maintainability/agent-python-responsibility-map.json"
EXPECTED_TARGETS = {
    "framework/core/src/python/kungfu/agent/resources.py",
    "framework/core/src/python/kungfu/agent/run_agent.py",
    "framework/core/src/python/kungfu/agent_work_lab.py",
    "framework/core/src/python/kungfu/assignment_orchestration.py",
    "framework/core/src/python/kungfu/cli/commands/agent.py",
    "framework/core/src/python/kungfu/cli/commands/assignment.py",
    "framework/core/src/python/kungfu/profile_sdk.py",
}


def source_at(revision: str, pathname: str) -> str:
    return subprocess.run(
        ["git", "show", f"{revision}:{pathname}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def imported_modules(tree: ast.AST, module: str) -> set[str]:
    package = module.rsplit(".", 1)[0] if "." in module else module
    result: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result.update(
                alias.name for alias in node.names if alias.name.startswith("kungfu")
            )
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = package.split(".")
                base_parts = parts[: max(len(parts) - node.level + 1, 0)]
                if base:
                    base_parts.extend(base.split("."))
                base = ".".join(base_parts)
            if base == "kungfu":
                result.update(f"kungfu.{alias.name}" for alias in node.names)
            elif base.startswith("kungfu"):
                result.add(base)
    return result


def source_measurement(source: str, pathname: str) -> dict[str, int]:
    tree = ast.parse(source, filename=pathname)
    module = pathname.removeprefix("framework/core/src/python/").removesuffix(".py")
    module = module.replace("/", ".")
    definitions = sum(
        isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        for node in tree.body
    )
    return {
        "physicalLines": len(source.splitlines()),
        "responsibilities": definitions + len(imported_modules(tree, module)),
    }


def top_level_symbols(source: str, pathname: str) -> set[str]:
    tree = ast.parse(source, filename=pathname)
    symbols: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            symbols.update(
                alias.asname or alias.name.rsplit(".", 1)[-1] for alias in node.names
            )
        elif isinstance(node, ast.Assign):
            symbols.update(
                target.id for target in node.targets if isinstance(target, ast.Name)
            )
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            symbols.add(node.target.id)
    return symbols


def class_method_node_counts(
    source: str, pathname: str, class_name: str
) -> dict[str, int]:
    tree = ast.parse(source, filename=pathname)
    owner = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == class_name
    )
    return {
        node.name: sum(1 for child in ast.walk(node) if child is not node)
        for node in owner.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def sha256_text(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def main() -> None:
    responsibility_map = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    assert responsibility_map["schema"] == "kungfu.agent-python-responsibility-map/v1"
    baseline = responsibility_map["baselineRevision"]
    assert len(baseline) == 40 and all(
        character in "0123456789abcdef" for character in baseline
    )
    subprocess.run(
        ["git", "cat-file", "-e", f"{baseline}^{{commit}}"], cwd=ROOT, check=True
    )
    targets = responsibility_map["targets"]
    assert {row["sourcePath"] for row in targets} == EXPECTED_TARGETS
    for row in targets:
        pathname = row["sourcePath"]
        before = source_measurement(source_at(baseline, pathname), pathname)
        current_source = (ROOT / pathname).read_text(encoding="utf-8")
        after = source_measurement(current_source, pathname)
        assert before == {key: row["baseline"][key] for key in before}, pathname
        assert after == {key: row["current"][key] for key in after}, pathname
        assert after["physicalLines"] < before["physicalLines"], pathname
        assert after["responsibilities"] < before["responsibilities"], pathname
        assert set(row["facadeSymbols"]) <= top_level_symbols(current_source, pathname)
        owner_symbols: set[str] = set()
        for owner_path in row["ownerFiles"]:
            owner = ROOT / owner_path
            assert owner.is_file(), owner_path
            owner_symbols.update(
                top_level_symbols(owner.read_text(encoding="utf-8"), owner_path)
            )
        assert set(row["ownedDefinitions"]) <= owner_symbols, pathname
        contract = row.get("convergenceContract")
        if contract is None:
            continue
        exact_base = contract["exactBase"]
        subprocess.run(
            ["git", "cat-file", "-e", f"{exact_base}^{{commit}}"],
            cwd=ROOT,
            check=True,
        )
        for source in contract["baselineSources"]:
            assert (
                sha256_text(source_at(exact_base, source["path"])) == source["sha256"]
            )
        cli = contract["cli"]
        assert (
            sha256_text((ROOT / cli["path"]).read_text(encoding="utf-8"))
            == cli["sha256"]
        )
        assert set(contract["publicImports"]) <= top_level_symbols(
            current_source, pathname
        )
        for source in contract.get("currentSources", []):
            assert (
                sha256_text((ROOT / source["path"]).read_text(encoding="utf-8"))
                == source["sha256"]
            )
        aggregate = contract.get("ownerAggregate")
        if aggregate is not None:
            measured = sum(
                source_measurement(
                    (ROOT / owner_path).read_text(encoding="utf-8"), owner_path
                )["responsibilities"]
                for owner_path in aggregate["current"]["paths"]
            )
            assert measured == aggregate["current"]["responsibilities"]
            assert measured < aggregate["baseline"]["responsibilities"]
            for metric in ("baseRisk", "changeRisk", "maximum"):
                assert (
                    aggregate["current"]["functionRisk"][metric]
                    < aggregate["baseline"]["functionRisk"][metric]
                )
        surface = contract.get("modificationSurface")
        if surface is not None:
            current_owner = surface["current"]
            owner_measurement = source_measurement(
                (ROOT / current_owner["outcomeOwnerPath"]).read_text(encoding="utf-8"),
                current_owner["outcomeOwnerPath"],
            )
            assert owner_measurement == {
                "physicalLines": current_owner["ownerPhysicalLines"],
                "responsibilities": current_owner["ownerResponsibilities"],
            }
            assert (
                current_owner["ownerPhysicalLines"]
                < surface["baseline"]["ownerPhysicalLines"]
            )
            cohesive = surface["cohesiveExtraction"]
            method_nodes = class_method_node_counts(
                (ROOT / current_owner["outcomeOwnerPath"]).read_text(encoding="utf-8"),
                current_owner["outcomeOwnerPath"],
                cohesive["ownerClass"],
            )
            assert set(cohesive["ownedMethods"]) <= set(method_nodes)
            assert all(method_nodes[name] > 10 for name in cohesive["ownedMethods"])


if __name__ == "__main__":
    main()
