# SPDX-License-Identifier: Apache-2.0

"""Verify the exact protected-baseline Python runtime responsibility split."""

from __future__ import annotations

import ast
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "framework/maintainability/python-runtime-responsibility-map.json"
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
  { extractorAlgorithm: 'python-multiline-v2' },
);

function measure(files, paths) {
  const availablePaths = new Set(files.map(({ path }) => path));
  const missingPaths = paths.filter((path) => !availablePaths.has(path));
  if (missingPaths.length > 0) {
    throw new Error(
      `required owner source paths missing: ${missingPaths.join(', ')}`,
    );
  }
  const snapshot = functionSnapshot(files, policy, layers, ownership, {
    extractorAlgorithm: 'python-multiline-v2',
  });
  const transition = analyzeTransition(
    snapshot.functions,
    riskBaseline.functions,
    snapshot.files,
    riskBaseline.files,
    policy,
    {
      identityAlgorithm: 'qualified-occurrence-v2',
      movementScope: 'same-owner',
    },
  );
  const selectedPaths = new Set(paths);
  const ambiguous = transition.findings.filter(
    ({ code, paths: findingPaths }) =>
      code === 'ambiguous-function-identity' &&
      findingPaths.some((path) => selectedPaths.has(path)),
  );
  if (ambiguous.length) {
    throw new Error(
      `ambiguous function identity: ${JSON.stringify(ambiguous)}`,
    );
  }
  const functions = transition.functions.filter(({ path }) =>
    selectedPaths.has(path),
  );
  const baselineById = new Map(
    riskBaseline.functions.map((item) => [item.id, item]),
  );
  const selectedBaseline = riskBaseline.functions.filter(({ path }) =>
    selectedPaths.has(path),
  );
  const linked = functions.filter(({ previousId }) => previousId);
  const added = functions.filter(({ previousId }) => !previousId);
  const retiredIds = new Set(transition.retiredFunctions);
  const retired = selectedBaseline.filter(({ id }) => retiredIds.has(id));
  const sum = (items, field) =>
    items.reduce((total, item) => total + item[field], 0);
  return {
    functions: functions.length,
    baseRisk: functions.reduce((sum, item) => sum + item.baseRisk, 0),
    changeRisk: functions.reduce((sum, item) => sum + item.changeRisk, 0),
    maximum: Math.max(...functions.map(({ changeRisk }) => changeRisk)),
    transitionContribution: {
      linked: {
        functions: linked.length,
        previousBaseRisk: sum(
          linked.map(({ previousId }) => baselineById.get(previousId)),
          'baseRisk',
        ),
        currentBaseRisk: sum(linked, 'baseRisk'),
        currentChangeRisk: sum(linked, 'changeRisk'),
      },
      new: {
        functions: added.length,
        currentBaseRisk: sum(added, 'baseRisk'),
        currentChangeRisk: sum(added, 'changeRisk'),
      },
      retired: {
        functions: retired.length,
        previousBaseRisk: sum(retired, 'baseRisk'),
        symbols: retired.map(({ symbol }) => symbol).sort(),
      },
    },
    rows: functions.map(({ path, id, symbol, owner, bodyRoot, baseRisk, changeRisk, movement, previousId }) => ({
      path,
      id,
      symbol,
      owner,
      bodyRoot,
      baseRisk,
      changeRisk,
      movement,
      previousId,
    })),
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
    return source_bytes_at(revision, pathname).decode()


def sha256_bytes(source: bytes) -> str:
    return hashlib.sha256(source).hexdigest()


def module_name(pathname: str) -> str:
    return (
        pathname.removeprefix("framework/core/src/python/")
        .removesuffix(".py")
        .replace("/", ".")
    )


def resolved_import_base(node: ast.ImportFrom, module: str) -> str:
    package = module.rsplit(".", 1)[0] if "." in module else module
    base = node.module or ""
    if not node.level:
        return base
    parts = package.split(".")
    base_parts = parts[: max(len(parts) - node.level + 1, 0)]
    if base:
        base_parts.extend(base.split("."))
    return ".".join(base_parts)


def kungfu_imports(node: ast.AST, module: str) -> set[str]:
    if isinstance(node, ast.Import):
        return {alias.name for alias in node.names if alias.name.startswith("kungfu")}
    if not isinstance(node, ast.ImportFrom):
        return set()
    base = resolved_import_base(node, module)
    if base == "kungfu":
        return {f"kungfu.{alias.name}" for alias in node.names}
    return {base} if base.startswith("kungfu") else set()


def imported_modules(tree: ast.AST, module: str) -> set[str]:
    result: set[str] = set()
    for node in ast.walk(tree):
        result.update(kungfu_imports(node, module))
    return result


def source_measurement(source: str, pathname: str) -> dict[str, int]:
    tree = ast.parse(source, filename=pathname)
    definitions = sum(
        isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        for node in tree.body
    )
    return {
        "physicalLines": len(source.splitlines()),
        "responsibilities": definitions
        + len(imported_modules(tree, module_name(pathname))),
    }


def declared_symbols(node: ast.AST) -> set[str]:
    if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
        return {node.name}
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return {alias.asname or alias.name.rsplit(".", 1)[-1] for alias in node.names}
    if isinstance(node, ast.Assign):
        return {target.id for target in node.targets if isinstance(target, ast.Name)}
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return {node.target.id}
    return set()


def top_level_symbols(tree: ast.Module) -> set[str]:
    result: set[str] = set()
    for node in tree.body:
        result.update(declared_symbols(node))
    return result


def node_at(tree: ast.Module, qualified_name: str) -> ast.AST:
    current: ast.AST = tree
    for part in qualified_name.split("."):
        current = next(
            node
            for node in getattr(current, "body", [])
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == part
        )
    return current


def stable_ast(node: ast.AST) -> str:
    return ast.dump(node, annotate_fields=True, include_attributes=False)


def click_contract(tree: ast.Module) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorators = [stable_ast(item) for item in node.decorator_list]
        if decorators:
            result[node.name] = {
                "arguments": stable_ast(node.args),
                "decorators": decorators,
            }
    return result


def assignment_expression(tree: ast.Module, name: str) -> str:
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            return ast.unparse(node.value)
    raise AssertionError(f"missing facade alias {name}")


def class_signatures(tree: ast.Module, name: str) -> dict[str, str]:
    class_node = node_at(tree, name)
    assert isinstance(class_node, ast.ClassDef)
    return {
        node.name: stable_ast(node.args)
        for node in class_node.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def static_owner_methods(tree: ast.Module, class_name: str) -> dict[str, int]:
    class_node = node_at(tree, class_name)
    assert isinstance(class_node, ast.ClassDef)
    result: dict[str, int] = {}
    for node in class_node.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        assert any(
            isinstance(decorator, ast.Name) and decorator.id == "staticmethod"
            for decorator in node.decorator_list
        ), (class_name, node.name)
        positional = [*node.args.posonlyargs, *node.args.args]
        assert not positional or positional[0].arg not in {"self", "cls"}
        result[node.name] = sum(1 for child in ast.walk(node) if child is not node)
    return result


def module_function_nodes(tree: ast.Module) -> dict[str, int]:
    return {
        node.name: sum(1 for child in ast.walk(node) if child is not node)
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def class_assignments(tree: ast.Module, class_name: str) -> dict[str, str]:
    class_node = node_at(tree, class_name)
    assert isinstance(class_node, ast.ClassDef)
    result: dict[str, str] = {}
    for node in class_node.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        result[target.id] = ast.unparse(node.value)
    return result


def function_risk(
    exact_base: str, baseline_paths: list[str], current_paths: list[str]
) -> dict[str, Any]:
    result = subprocess.run(
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
    )
    return json.loads(result.stdout)


def risk_summary(measurement: dict[str, Any]) -> dict[str, int]:
    return {
        key: measurement[key]
        for key in ("functions", "baseRisk", "changeRisk", "maximum")
    }


def hotspot(measurement: dict[str, Any], name: str) -> dict[str, Any]:
    matches = [row for row in measurement["rows"] if f":{name}:" in row["id"]]
    assert len(matches) == 1, (name, matches)
    return matches[0]


def load_responsibility_map() -> tuple[dict[str, Any], str]:
    responsibility_map = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    assert responsibility_map["schema"] == "kungfu.python-runtime-responsibility-map/v1"
    exact_base = responsibility_map["baselineRevision"]
    subprocess.run(
        ["git", "cat-file", "-e", f"{exact_base}^{{commit}}"],
        cwd=ROOT,
        check=True,
    )
    return responsibility_map, exact_base


def assert_lineage(responsibility_map: dict[str, Any], exact_base: str) -> None:
    for source in responsibility_map["baselineSources"]:
        baseline_bytes = source_bytes_at(exact_base, source["path"])
        predecessor_bytes = source_bytes_at(
            responsibility_map["lineageAudit"]["predecessorBase"], source["path"]
        )
        assert sha256_bytes(baseline_bytes) == source["sha256"]
        assert sha256_bytes(predecessor_bytes) == source["predecessorBaseSha256"]
        assert baseline_bytes == predecessor_bytes
    for source in responsibility_map["currentSources"]:
        assert sha256_bytes((ROOT / source["path"]).read_bytes()) == source["sha256"]


def parse_contract_sources(
    responsibility_map: dict[str, Any], exact_base: str
) -> tuple[str, str, ast.Module, ast.Module, ast.Module, ast.Module]:
    service_path, cli_path = responsibility_map["sourcePaths"]
    service_before = ast.parse(
        source_at(exact_base, service_path), filename=service_path
    )
    service_after = ast.parse(
        (ROOT / service_path).read_text(encoding="utf-8"), filename=service_path
    )
    cli_before = ast.parse(source_at(exact_base, cli_path), filename=cli_path)
    cli_after = ast.parse(
        (ROOT / cli_path).read_text(encoding="utf-8"), filename=cli_path
    )
    return service_path, cli_path, service_before, service_after, cli_before, cli_after


def assert_public_contracts(
    responsibility_map: dict[str, Any],
    service_before: ast.Module,
    service_after: ast.Module,
    cli_before: ast.Module,
    cli_after: ast.Module,
) -> set[str]:
    baseline_public = {
        name for name in top_level_symbols(service_before) if not name.startswith("_")
    }
    current_public = {
        name for name in top_level_symbols(service_after) if not name.startswith("_")
    }
    assert current_public == baseline_public
    assert click_contract(cli_after) == click_contract(cli_before)
    for qualified_import in responsibility_map["publicImports"]:
        assert qualified_import.rsplit(".", 1)[-1] in current_public

    persistence = responsibility_map["persistenceContract"]
    for name in persistence["constants"]:
        assert assignment_expression(service_after, name) == assignment_expression(
            service_before, name
        )
    for name in persistence["pathFunctions"]:
        assert stable_ast(node_at(service_after, name)) == stable_ast(
            node_at(service_before, name)
        )
    for name in responsibility_map["sideEffectOrder"]:
        assert stable_ast(node_at(service_after, name)) == stable_ast(
            node_at(service_before, name)
        )
    for name in responsibility_map["nativeInterface"]:
        assert class_signatures(service_after, name) == class_signatures(
            service_before, name
        )
    assert stable_ast(node_at(service_after, "CoordinatorProcess")) == stable_ast(
        node_at(service_before, "CoordinatorProcess")
    )
    for name, expression in responsibility_map["facadeAliases"].items():
        assert assignment_expression(service_after, name) == expression
    for name in responsibility_map["serviceLocalDefinitions"]:
        assert stable_ast(node_at(service_after, name)) == stable_ast(
            node_at(service_before, name)
        )
    return current_public


def assert_owner_contracts(
    responsibility_map: dict[str, Any], service_before: ast.Module
) -> tuple[str, ast.Module]:
    owner_path = responsibility_map["ownerFiles"][0]
    owner_source = (ROOT / owner_path).read_text(encoding="utf-8")
    owner_tree = ast.parse(owner_source, filename=owner_path)
    owned = responsibility_map["ownedDefinitions"]
    owner_functions = module_function_nodes(owner_tree)
    assert set(owner_functions) == set(owned["moduleFunctions"])
    assert all(owner_functions[name] > 10 for name in owned["moduleFunctions"])
    assert not any(isinstance(node, ast.ClassDef) for node in owner_tree.body)
    return owner_source, owner_tree


def responsibility_measurements(
    responsibility_map: dict[str, Any], exact_base: str
) -> tuple[list[str], list[str], dict[str, int], dict[str, int]]:
    baseline_paths = responsibility_map["sourcePaths"]
    current_paths = [*baseline_paths, *responsibility_map["ownerFiles"]]
    baseline_measurement = {"physicalLines": 0, "responsibilities": 0}
    for pathname in baseline_paths:
        measured = source_measurement(source_at(exact_base, pathname), pathname)
        for key in baseline_measurement:
            baseline_measurement[key] += measured[key]
    current_measurement = {"physicalLines": 0, "responsibilities": 0}
    for pathname in current_paths:
        measured = source_measurement(
            (ROOT / pathname).read_text(encoding="utf-8"), pathname
        )
        for key in current_measurement:
            current_measurement[key] += measured[key]
    assert baseline_measurement == {
        key: responsibility_map["baseline"][key] for key in baseline_measurement
    }
    assert current_measurement == {
        key: responsibility_map["current"][key] for key in current_measurement
    }
    assert (
        current_measurement["responsibilities"]
        < baseline_measurement["responsibilities"]
    )
    return baseline_paths, current_paths, baseline_measurement, current_measurement


def assert_risk_improvement(
    responsibility_map: dict[str, Any],
    exact_base: str,
    baseline_paths: list[str],
    current_paths: list[str],
) -> dict[str, Any]:
    measured_risk = function_risk(exact_base, baseline_paths, current_paths)
    measured_baseline = risk_summary(measured_risk["baseline"])
    declared_baseline = responsibility_map["baseline"]["functionRisk"]
    assert measured_baseline == declared_baseline, {
        "measured": measured_baseline,
        "declared": declared_baseline,
    }
    measured_current = risk_summary(measured_risk["current"])
    declared_current = responsibility_map["current"]["functionRisk"]
    assert measured_current == declared_current, {
        "measured": measured_current,
        "declared": declared_current,
        "ownerRows": [
            row
            for row in measured_risk["current"]["rows"]
            if row["path"] in current_paths[len(baseline_paths) :]
        ],
        "changedOwnerRows": [
            row
            for row in measured_risk["current"]["rows"]
            if row["changeRisk"] > row["baseRisk"]
        ],
        "transitionContribution": measured_risk["current"]["transitionContribution"],
    }
    assert measured_risk["current"]["baseRisk"] < measured_risk["baseline"]["baseRisk"]
    assert (
        measured_risk["current"]["changeRisk"] < measured_risk["baseline"]["changeRisk"]
    )
    assert measured_risk["current"]["maximum"] <= measured_risk["baseline"]["maximum"]
    expected_owner = responsibility_map["owner"]
    assert {
        row["owner"]
        for measurement in measured_risk.values()
        for row in measurement["rows"]
    } == {expected_owner}
    return measured_risk


def assert_transition_contribution(
    responsibility_map: dict[str, Any], measured_risk: dict[str, Any]
) -> None:
    current = measured_risk["current"]
    assert (
        current["transitionContribution"]
        == responsibility_map["transitionContribution"]
    )
    assert current["transitionContribution"]["new"]["functions"] == 0
    process_rows = {
        row["symbol"]: row
        for row in current["rows"]
        if row["path"] in responsibility_map["ownerFiles"]
    }
    for symbol in responsibility_map["processIdentityContinuity"]:
        row = process_rows[symbol]
        assert row["movement"] == "renamed-file"
        assert row["previousId"].startswith(
            "python:framework/core/src/python/kungfu/runtime_service.py:"
        )
        assert f":{symbol}:" in row["previousId"]


def assert_modification_surface(
    responsibility_map: dict[str, Any],
    exact_base: str,
    owner_source: str,
    owner_tree: ast.Module,
    measured_risk: dict[str, Any],
) -> None:
    surface = responsibility_map["modificationSurface"]
    owner_path = responsibility_map["ownerFiles"][0]
    assert (
        len(source_at(exact_base, surface["baselineProcessOwner"]).splitlines())
        == surface["baselineOwnerPhysicalLines"]
    )
    assert len(owner_source.splitlines()) == surface["currentOwnerPhysicalLines"]
    assert (
        len(imported_modules(owner_tree, module_name(owner_path)))
        == surface["currentOwnerKungfuImports"]
    )
    baseline_owner_tree = ast.parse(
        source_at(exact_base, surface["baselineProcessOwner"])
    )
    assert (
        len(
            imported_modules(
                baseline_owner_tree, module_name(surface["baselineProcessOwner"])
            )
        )
        == surface["baselineOwnerKungfuImports"]
    )
    baseline_hotspot = hotspot(
        measured_risk["baseline"], surface["baselineHotspot"]["name"]
    )
    current_hotspot = hotspot(
        measured_risk["current"], surface["currentHotspot"]["name"]
    )
    assert baseline_hotspot["baseRisk"] == surface["baselineHotspot"]["baseRisk"]
    assert current_hotspot["baseRisk"] == surface["currentHotspot"]["baseRisk"]
    assert current_hotspot["bodyRoot"] == baseline_hotspot["bodyRoot"]


def main() -> None:
    responsibility_map, exact_base = load_responsibility_map()
    assert responsibility_map["functionRiskAlgorithmVersion"] == (
        "qualified-occurrence-v2"
    )
    assert responsibility_map["functionExtractorAlgorithmVersion"] == (
        "python-multiline-v2"
    )
    assert_lineage(responsibility_map, exact_base)
    (
        _service_path,
        _cli_path,
        service_before,
        service_after,
        cli_before,
        cli_after,
    ) = parse_contract_sources(responsibility_map, exact_base)
    current_public = assert_public_contracts(
        responsibility_map,
        service_before,
        service_after,
        cli_before,
        cli_after,
    )
    owner_source, owner_tree = assert_owner_contracts(
        responsibility_map, service_before
    )
    baseline_paths, current_paths, baseline_measurement, current_measurement = (
        responsibility_measurements(responsibility_map, exact_base)
    )
    measured_risk = assert_risk_improvement(
        responsibility_map, exact_base, baseline_paths, current_paths
    )
    assert_transition_contribution(responsibility_map, measured_risk)
    assert_modification_surface(
        responsibility_map,
        exact_base,
        owner_source,
        owner_tree,
        measured_risk,
    )
    print(
        json.dumps(
            {
                "schema": "kungfu.python-runtime-responsibility-check/v1",
                "status": "pass",
                "baselineRevision": exact_base,
                "baseline": {
                    **baseline_measurement,
                    "functionRisk": risk_summary(measured_risk["baseline"]),
                },
                "current": {
                    **current_measurement,
                    "functionRisk": risk_summary(measured_risk["current"]),
                },
                "publicSymbols": len(current_public),
                "clickCommands": len(click_contract(cli_after)),
                "requiredOwnerPaths": current_paths,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
