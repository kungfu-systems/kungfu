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
FUNCTION_RISK_MEASUREMENT = r"""
import fs from 'node:fs';
import {
  functionSnapshot,
  readJson,
  trackedCurrentFiles,
  trackedFilesAt,
} from './framework/maintainability/source-analysis-kernel.mjs';
import { analyzeTransition } from './framework/maintainability/function-risk.mjs';

const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const policy = readJson('framework/maintainability/function-risk-policy.json');
const layers = readJson('framework/core/architecture/layers.json');
const ownership = readJson(
  'framework/maintainability/abstraction-integrity.manifest.json',
).ownership;
const riskBaseline = functionSnapshot(
  trackedFilesAt(policy.baselineRef),
  policy,
  layers,
  ownership,
);

function measure(files, paths) {
  const snapshot = functionSnapshot(files, policy, layers, ownership);
  const transition = analyzeTransition(
    snapshot.functions,
    riskBaseline.functions,
    snapshot.files,
    riskBaseline.files,
    policy,
  );
  const selectedPaths = new Set(paths);
  const functions = transition.functions.filter(({ path }) =>
    selectedPaths.has(path),
  );
  return {
    functions: functions.length,
    baseRisk: functions.reduce((sum, item) => sum + item.baseRisk, 0),
    changeRisk: functions.reduce((sum, item) => sum + item.changeRisk, 0),
    maximum: Math.max(...functions.map(({ changeRisk }) => changeRisk)),
  };
}

process.stdout.write(JSON.stringify({
  baseline: measure(
    trackedFilesAt(request.exactBase),
    request.baselinePaths,
  ),
  current: measure(trackedCurrentFiles(), request.currentPaths),
}));
"""


def source_bytes_at(revision: str, pathname: str) -> bytes:
    return subprocess.run(
        ["git", "show", f"{revision}:{pathname}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout


def source_at(revision: str, pathname: str) -> str:
    return source_bytes_at(revision, pathname).decode("utf-8")


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


def function_node_counts(source: str, pathname: str) -> dict[str, int]:
    tree = ast.parse(source, filename=pathname)
    return {
        node.name: sum(1 for child in ast.walk(node) if child is not node)
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def sha256_bytes(source: bytes) -> str:
    return hashlib.sha256(source).hexdigest()


def owner_function_risk(
    exact_base: str, baseline_paths: list[str], current_paths: list[str]
) -> dict[str, dict[str, int]]:
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", FUNCTION_RISK_MEASUREMENT],
        cwd=ROOT,
        input=json.dumps(
            {
                "exactBase": exact_base,
                "baselinePaths": baseline_paths,
                "currentPaths": current_paths,
            }
        ),
        text=True,
        capture_output=True,
        check=True,
        env=None,
    )
    return json.loads(completed.stdout)


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
                sha256_bytes(source_bytes_at(exact_base, source["path"]))
                == source["sha256"]
            )
        cli = contract["cli"]
        assert sha256_bytes((ROOT / cli["path"]).read_bytes()) == cli["sha256"]
        assert set(contract["publicImports"]) <= top_level_symbols(
            current_source, pathname
        )
        for source in contract.get("currentSources", []):
            assert (
                sha256_bytes((ROOT / source["path"]).read_bytes()) == source["sha256"]
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
            function_risk = owner_function_risk(
                exact_base,
                aggregate["baseline"]["paths"],
                aggregate["current"]["paths"],
            )
            assert function_risk["baseline"] == aggregate["baseline"]["functionRisk"]
            assert function_risk["current"] == aggregate["current"]["functionRisk"]
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
            function_nodes = function_node_counts(
                (ROOT / current_owner["outcomeOwnerPath"]).read_text(encoding="utf-8"),
                current_owner["outcomeOwnerPath"],
            )
            assert set(cohesive["ownerFunctions"]) <= set(function_nodes)
            assert all(function_nodes[name] > 10 for name in cohesive["ownerFunctions"])


if __name__ == "__main__":
    main()
