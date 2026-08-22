# SPDX-License-Identifier: Apache-2.0

"""Verify the exact Python runtime responsibility split and frozen surfaces."""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "framework/maintainability/python-runtime-responsibility-map.json"


def source_at(revision: str, pathname: str) -> str:
    return subprocess.run(
        ["git", "show", f"{revision}:{pathname}"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def module_name(pathname: str) -> str:
    return (
        pathname.removeprefix("framework/core/src/python/")
        .removesuffix(".py")
        .replace("/", ".")
    )


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
    definitions = sum(
        isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        for node in tree.body
    )
    return {
        "physicalLines": len(source.splitlines()),
        "responsibilities": definitions
        + len(imported_modules(tree, module_name(pathname))),
    }


def top_level_symbols(tree: ast.Module) -> set[str]:
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


def node_at(tree: ast.Module, qualified_name: str) -> ast.AST:
    parts = qualified_name.split(".")
    current: ast.AST = tree
    for part in parts:
        body = getattr(current, "body", [])
        current = next(
            node
            for node in body
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
        if not decorators:
            continue
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    responsibility_map = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    assert responsibility_map["schema"] == "kungfu.python-runtime-responsibility-map/v1"
    baseline = responsibility_map["baselineRevision"]
    subprocess.run(
        ["git", "cat-file", "-e", f"{baseline}^{{commit}}"], cwd=ROOT, check=True
    )

    service_path, cli_path = responsibility_map["sourcePaths"]
    service_before = ast.parse(source_at(baseline, service_path), filename=service_path)
    service_source = (ROOT / service_path).read_text(encoding="utf-8")
    service_after = ast.parse(service_source, filename=service_path)
    cli_before = ast.parse(source_at(baseline, cli_path), filename=cli_path)
    cli_after = ast.parse(
        (ROOT / cli_path).read_text(encoding="utf-8"), filename=cli_path
    )

    baseline_public = {
        name for name in top_level_symbols(service_before) if not name.startswith("_")
    }
    current_public = {
        name for name in top_level_symbols(service_after) if not name.startswith("_")
    }
    assert current_public == baseline_public
    assert click_contract(cli_after) == click_contract(cli_before)

    persistence = responsibility_map["persistenceContract"]
    for name in persistence["constants"]:
        before = assignment_expression(service_before, name)
        after = assignment_expression(service_after, name)
        assert after == before, name
    for name in persistence["pathFunctions"]:
        assert stable_ast(node_at(service_after, name)) == stable_ast(
            node_at(service_before, name)
        ), name
    for name in responsibility_map["sideEffectOrder"]:
        assert stable_ast(node_at(service_after, name)) == stable_ast(
            node_at(service_before, name)
        ), name
    for name in responsibility_map["nativeInterface"]:
        assert class_signatures(service_after, name) == class_signatures(
            service_before, name
        ), name

    for name, expression in responsibility_map["facadeAliases"].items():
        assert assignment_expression(service_after, name) == expression, name

    owner_path = responsibility_map["ownerFiles"][0]
    owner_source = (ROOT / owner_path).read_text(encoding="utf-8")
    owner_tree = ast.parse(owner_source, filename=owner_path)
    for class_name, methods in responsibility_map["ownedDefinitions"].items():
        signatures = class_signatures(owner_tree, class_name)
        assert set(signatures) == set(methods), class_name

    before_metrics = {"physicalLines": 0, "responsibilities": 0}
    for pathname in responsibility_map["sourcePaths"]:
        measured = source_measurement(source_at(baseline, pathname), pathname)
        for key in before_metrics:
            before_metrics[key] += measured[key]
    current_metrics = {"physicalLines": 0, "responsibilities": 0}
    for pathname in [
        *responsibility_map["sourcePaths"],
        *responsibility_map["ownerFiles"],
    ]:
        measured = source_measurement(
            (ROOT / pathname).read_text(encoding="utf-8"), pathname
        )
        for key in current_metrics:
            current_metrics[key] += measured[key]
    assert before_metrics == {
        key: responsibility_map["baseline"][key] for key in before_metrics
    }
    assert current_metrics == {
        key: responsibility_map["current"][key] for key in current_metrics
    }
    assert current_metrics["responsibilities"] < before_metrics["responsibilities"]

    modification_surface = responsibility_map["modificationSurface"]
    baseline_owner_source = source_at(
        baseline, modification_surface["baselineProcessOwner"]
    )
    current_owner_path = modification_surface["currentProcessOwner"]
    current_owner_source = (ROOT / current_owner_path).read_text(encoding="utf-8")
    baseline_owner_tree = ast.parse(
        baseline_owner_source, filename=modification_surface["baselineProcessOwner"]
    )
    current_owner_tree = ast.parse(current_owner_source, filename=current_owner_path)
    assert (
        len(baseline_owner_source.splitlines())
        == modification_surface["baselineOwnerPhysicalLines"]
    )
    assert (
        len(current_owner_source.splitlines())
        == modification_surface["currentOwnerPhysicalLines"]
    )
    assert (
        len(
            imported_modules(
                baseline_owner_tree,
                module_name(modification_surface["baselineProcessOwner"]),
            )
        )
        == modification_surface["baselineOwnerKungfuImports"]
    )
    assert (
        len(imported_modules(current_owner_tree, module_name(current_owner_path)))
        == modification_surface["currentOwnerKungfuImports"]
    )
    assert (
        modification_surface["currentOwnerPhysicalLines"]
        < modification_surface["baselineOwnerPhysicalLines"]
    )

    report = {
        "schema": "kungfu.python-runtime-responsibility-check/v1",
        "status": "pass",
        "baselineRevision": baseline,
        "baseline": before_metrics,
        "current": current_metrics,
        "publicSymbols": len(current_public),
        "clickCommands": len(click_contract(cli_after)),
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(
            "pass: runtime responsibilities "
            f"{before_metrics['responsibilities']} -> "
            f"{current_metrics['responsibilities']}"
        )


if __name__ == "__main__":
    main()
