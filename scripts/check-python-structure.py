#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Build-free, exact-root Python structure governance and report query."""

from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
import math
import os
import subprocess
import sys
import tarfile
from datetime import date
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = Path("developer/maintainability/abstraction-integrity.manifest.json")
PYTHON_SOURCE_ROOT = "framework/core/src/python"
GIT_TIMEOUT_SECONDS = float(os.environ.get("KUNGFU_GIT_COMMAND_TIMEOUT_SECONDS", "10"))


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()


def digest(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical(value)).hexdigest()}"


def digest_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def read_json(relative: Path) -> dict[str, Any]:
    value = json.loads((ROOT / relative).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{relative} must contain an object")
    return value


def git(*args: str) -> bytes:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=ROOT,
            check=False,
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError(
            f"git {' '.join(args)} timed out after {GIT_TIMEOUT_SECONDS:g}s"
        ) from exc
    if result.returncode:
        raise ValueError(
            f"git {' '.join(args)} failed: {result.stderr.decode(errors='replace').strip()}"
        )
    return result.stdout


def physical_lines(content: str) -> int:
    return len(content.splitlines())


def module_name(pathname: str) -> str:
    prefix = "framework/core/src/python/"
    if not pathname.startswith(prefix):
        return ""
    relative = pathname[len(prefix) :]
    if relative.endswith("/__init__.py"):
        relative = relative[: -len("/__init__.py")]
    elif relative.endswith(".py"):
        relative = relative[:-3]
    return relative.replace("/", ".")


def imported_modules(tree: ast.AST, module: str) -> list[str]:
    result: set[str] = set()
    package = module.rsplit(".", 1)[0] if "." in module else module
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
    return sorted(result)


def top_level_symbols(tree: ast.Module) -> list[dict[str, Any]]:
    result = []
    for node in tree.body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "class" if isinstance(node, ast.ClassDef) else "function"
            bases = (
                [ast.unparse(base) for base in node.bases]
                if isinstance(node, ast.ClassDef)
                else []
            )
            decorators = [ast.unparse(value) for value in node.decorator_list]
            methods = list(node.body) if isinstance(node, ast.ClassDef) else []
            result.append(
                {
                    "name": node.name,
                    "kind": kind,
                    "bases": bases,
                    "decorators": decorators,
                    "methodsTyped": all(
                        function_annotations_complete(method)
                        for method in methods
                        if isinstance(method, (ast.FunctionDef, ast.AsyncFunctionDef))
                        and (
                            method.name == "__call__" or not method.name.startswith("_")
                        )
                    ),
                    "fieldsTyped": all(
                        isinstance(field, ast.AnnAssign)
                        for field in methods
                        if isinstance(field, (ast.Assign, ast.AnnAssign))
                    ),
                }
            )
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            result.extend(
                {
                    "name": alias.asname or alias.name.rsplit(".", 1)[-1],
                    "kind": "import",
                    "bases": [],
                    "decorators": [],
                }
                for alias in node.names
            )
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            result.extend(
                {
                    "name": target.id,
                    "kind": "assignment",
                    "bases": [],
                    "decorators": [],
                }
                for target in targets
                if isinstance(target, ast.Name)
            )
    return result


def function_annotations_complete(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> bool:
    arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
    arguments = [value for value in arguments if value.arg not in {"self", "cls"}]
    return bool(
        node.returns is not None
        and all(value.annotation is not None for value in arguments)
        and (node.args.vararg is None or node.args.vararg.annotation is not None)
        and (node.args.kwarg is None or node.args.kwarg.annotation is not None)
    )


def wrapper_only_module(tree: ast.Module) -> bool:
    """Detect modules whose only definitions mechanically forward calls."""

    imported_names = {
        alias.asname or alias.name.split(".", 1)[0]
        for node in tree.body
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    }
    definitions = [
        node
        for node in tree.body
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    if not definitions:
        return bool(imported_names)
    if any(isinstance(node, ast.ClassDef) for node in definitions):
        return False
    for node in definitions:
        body = list(node.body)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            body = body[1:]
        if (
            len(body) != 1
            or not isinstance(body[0], ast.Return)
            or not isinstance(body[0].value, ast.Call)
        ):
            return False
        target = body[0].value.func
        while isinstance(target, ast.Attribute):
            target = target.value
        if not isinstance(target, ast.Name) or target.id not in imported_names:
            return False
    return True


def platform_branches(tree: ast.AST, pathname: str) -> list[dict[str, Any]]:
    result = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.If):
            continue
        expression = ast.unparse(node.test)
        if any(
            marker in expression
            for marker in ("platform.system", "sys.platform", "os.name")
        ):
            result.append({"path": pathname, "line": node.lineno, "test": expression})
    return result


def responsibility_count(tree: ast.Module, imports: Iterable[str]) -> int:
    definitions = sum(
        isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        for node in tree.body
    )
    return definitions + len(set(imports))


def files_at_ref(ref: str, roots: list[str]) -> dict[str, str]:
    archive = git("archive", "--format=tar", ref, "--", *roots)
    result: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        members = sorted(
            (
                member
                for member in bundle.getmembers()
                if member.isfile() and member.name.endswith(".py")
            ),
            key=lambda member: member.name,
        )
        for member in members:
            source = bundle.extractfile(member)
            if source is None:
                raise ValueError(f"git archive member is unreadable: {member.name}")
            result[member.name] = source.read().decode("utf-8")
    return result


def files_at_worktree(roots: list[str]) -> dict[str, str]:
    result = {}
    for root in roots:
        directory = ROOT / root
        if not directory.is_dir():
            raise ValueError(f"source root is missing: {root}")
        for path in sorted(directory.rglob("*.py")):
            if any(part in {".venv", "__pycache__", "build"} for part in path.parts):
                continue
            result[path.relative_to(ROOT).as_posix()] = path.read_text(encoding="utf-8")
    return result


def strongly_connected(graph: dict[str, list[str]]) -> list[list[str]]:
    index = 0
    stack: list[str] = []
    indices: dict[str, int] = {}
    low: dict[str, int] = {}
    active: set[str] = set()
    components: list[list[str]] = []

    def visit(node: str) -> None:
        nonlocal index
        indices[node] = low[node] = index
        index += 1
        stack.append(node)
        active.add(node)
        for target in graph.get(node, []):
            if target not in graph:
                continue
            if target not in indices:
                visit(target)
                low[node] = min(low[node], low[target])
            elif target in active:
                low[node] = min(low[node], indices[target])
        if low[node] != indices[node]:
            return
        component = []
        while stack:
            target = stack.pop()
            active.remove(target)
            component.append(target)
            if target == node:
                break
        if len(component) > 1:
            components.append(sorted(component))

    for node in sorted(graph):
        if node not in indices:
            visit(node)
    return sorted(components)


def aggregate_lines(
    files: list[dict[str, Any]], manifest: dict[str, Any]
) -> dict[str, int]:
    values = {}
    for rule in manifest["aggregates"]:
        prefix = rule["prefix"]
        total = 0
        for item in files:
            path = item["path"]
            if not path.startswith(prefix):
                continue
            remainder = path[len(prefix) :]
            if rule["recursive"] or "/" not in remainder:
                total += item["physicalLines"]
        values[rule["id"]] = total
    return values


def measure(contents: dict[str, str], manifest: dict[str, Any]) -> dict[str, Any]:
    production_roots = tuple(manifest["sourceRoots"]["production"])
    test_roots = tuple(manifest["sourceRoots"]["test"])
    files = []
    graph: dict[str, list[str]] = {}
    branches = []
    parse_errors = []
    for pathname, content in sorted(contents.items()):
        try:
            tree = ast.parse(content, filename=pathname)
        except SyntaxError as error:
            parse_errors.append(
                {"path": pathname, "line": error.lineno, "message": error.msg}
            )
            continue
        module = module_name(pathname)
        imports = imported_modules(tree, module)
        symbols = top_level_symbols(tree)
        production = pathname.startswith(production_roots)
        test = pathname.startswith(test_roots)
        item = {
            "path": pathname,
            "module": module,
            "kind": "production" if production else "test" if test else "unclassified",
            "physicalLines": physical_lines(content),
            "contentRoot": f"sha256:{hashlib.sha256(content.encode()).hexdigest()}",
            "ownedDefinitions": sum(
                symbol["kind"] in {"class", "function"} for symbol in symbols
            ),
            "responsibilities": responsibility_count(tree, imports),
            "imports": imports,
            "symbols": symbols,
            "wrapperOnly": wrapper_only_module(tree),
        }
        files.append(item)
        if production and module:
            graph[module] = imports
            branches.extend(platform_branches(tree, pathname))
    production = [item for item in files if item["kind"] == "production"]
    tests = [item for item in files if item["kind"] == "test"]
    hidden = [
        item["path"]
        for item in files
        if item["kind"] == "unclassified"
        and item["path"].startswith(f"{PYTHON_SOURCE_ROOT}/")
    ]
    body = {
        "schema": "kungfu.python-structure-measurement/v1",
        "sourceRoots": manifest["sourceRoots"],
        "counts": {
            "productionFiles": len(production),
            "productionPhysicalLines": sum(
                item["physicalLines"] for item in production
            ),
            "testFiles": len(tests),
            "testPhysicalLines": sum(item["physicalLines"] for item in tests),
        },
        "aggregates": aggregate_lines(production, manifest),
        "modulesOver1000": [
            {"path": item["path"], "physicalLines": item["physicalLines"]}
            for item in production
            if item["physicalLines"] > 1000
        ],
        "modulesOver2000": [
            {"path": item["path"], "physicalLines": item["physicalLines"]}
            for item in production
            if item["physicalLines"] > 2000
        ],
        "stronglyConnectedComponents": strongly_connected(graph),
        "platformBranches": sorted(
            branches, key=lambda value: (value["path"], value["line"])
        ),
        "parseErrors": parse_errors,
        "hiddenProductionFiles": hidden,
        "files": files,
    }
    return {**body, "sourceRoot": digest(body)}


def compact_measurement(measurement: dict[str, Any]) -> dict[str, Any]:
    """Retain exact roots and governance signals without duplicating AST detail."""

    production = [item for item in measurement["files"] if item["kind"] == "production"]
    body = {
        key: value
        for key, value in measurement.items()
        if key not in {"files", "sourceRoot"}
    }
    body["oversizedFiles"] = [
        {
            "path": item["path"],
            "physicalLines": item["physicalLines"],
            "contentRoot": item["contentRoot"],
            "responsibilities": item["responsibilities"],
        }
        for item in production
        if item["physicalLines"] > 1000
    ]
    return {**body, "sourceRoot": digest(body)}


def symbol_index(measurement: dict[str, Any]) -> dict[str, set[str]]:
    return {
        item["module"]: {symbol["name"] for symbol in item["symbols"]}
        for item in measurement["files"]
        if item["module"]
    }


def exception_issues(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    issues = []
    required = {"id", "owner", "scope", "expires", "authorizedBy", "retirement"}
    seen_ids: set[str] = set()
    for value in manifest.get("exceptions", []):
        valid = isinstance(value, dict) and required.issubset(value)
        identifier = str(value.get("id") or "") if isinstance(value, dict) else ""
        if valid:
            try:
                expires = date.fromisoformat(str(value["expires"]))
            except ValueError:
                valid = False
            else:
                valid = expires > date.today()
        if (
            not valid
            or not identifier
            or identifier in seen_ids
            or value.get("owner") == value.get("authorizedBy")
            or not str(value.get("owner") or "").strip()
            or not str(value.get("authorizedBy") or "").strip()
            or not str(value.get("scope") or "").strip()
            or not str(value.get("retirement") or "").strip()
        ):
            issues.append({"code": "invalid-structure-exception", "value": value})
        seen_ids.add(identifier)
    return issues


def governance_issues(
    baseline: dict[str, Any],
    current: dict[str, Any],
    manifest: dict[str, Any],
    baseline_revision: str,
    *,
    tracked_paths: set[str] | None = None,
) -> list[dict[str, Any]]:
    issues = []
    if current["parseErrors"]:
        issues.extend(
            {"code": "python-parse-error", **value} for value in current["parseErrors"]
        )
    issues.extend(
        {"code": "production-source-hidden", "path": path}
        for path in current.get("hiddenProductionFiles", [])
    )
    before_oversized = {item["path"]: item for item in baseline["oversizedFiles"]}
    after = {
        item["path"]: item for item in current["files"] if item["kind"] == "production"
    }
    limit = manifest["limits"]["newProductionModulePhysicalLines"]
    minimum_owned = manifest["limits"]["minimumOwnedDefinitions"]
    minimum_substantive_lines = manifest["limits"][
        "minimumSubstantiveModulePhysicalLines"
    ]
    for path, item in after.items():
        old = before_oversized.get(path)
        tracked_at_baseline = (
            path in tracked_paths
            if tracked_paths is not None
            else (
                subprocess.run(
                    ["git", "cat-file", "-e", f"{baseline_revision}:{path}"],
                    cwd=ROOT,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                ).returncode
                == 0
            )
        )
        if not tracked_at_baseline:
            if item["physicalLines"] > limit:
                issues.append(
                    {"code": "new-production-module-over-limit", "path": path}
                )
            if item.get("wrapperOnly") or (
                0 < item["ownedDefinitions"] < minimum_owned
                and item["physicalLines"] < minimum_substantive_lines
            ):
                issues.append({"code": "wrapper-only-split", "path": path})
            continue
        if old is not None and item["physicalLines"] > old["physicalLines"]:
            issues.append({"code": "oversized-module-grew", "path": path})
        if (
            old is not None
            and item["contentRoot"] != old["contentRoot"]
            and item["responsibilities"] >= old["responsibilities"]
        ):
            issues.append(
                {"code": "oversized-responsibility-not-reduced", "path": path}
            )
    headroom = manifest["limits"]["aggregateHeadroomPercent"] / 100
    for name, value in current["aggregates"].items():
        ceiling = math.ceil(baseline["aggregates"][name] * (1 + headroom))
        if value > ceiling:
            issues.append(
                {
                    "code": "aggregate-budget-regressed",
                    "aggregate": name,
                    "value": value,
                    "ceiling": ceiling,
                }
            )
    baseline_scc = {tuple(value) for value in baseline["stronglyConnectedComponents"]}
    for component in current["stronglyConnectedComponents"]:
        if tuple(component) not in baseline_scc:
            issues.append({"code": "new-python-import-cycle", "modules": component})
    for forbidden in manifest["forbiddenStronglyConnectedComponents"]:
        forbidden_set = set(forbidden)
        if any(
            forbidden_set.issubset(component)
            for component in map(set, current["stronglyConnectedComponents"])
        ):
            issues.append(
                {"code": "forbidden-python-import-cycle", "modules": forbidden}
            )
    symbols = symbol_index(current)
    for reference in manifest["publicImports"]:
        module, symbol = reference.rsplit(".", 1)
        if symbol not in symbols.get(module, set()):
            issues.append(
                {"code": "declared-python-symbol-missing", "symbol": reference}
            )
    details = {
        (item["module"], symbol["name"]): symbol
        for item in current["files"]
        for symbol in item["symbols"]
        if item["module"]
    }
    for reference in manifest["typedSeams"]:
        module, symbol = reference.rsplit(".", 1)
        declaration = details.get((module, symbol))
        if declaration is None:
            issues.append(
                {"code": "declared-python-symbol-missing", "symbol": reference}
            )
            continue
        bases = set(declaration["bases"])
        decorators = set(declaration["decorators"])
        if symbol.endswith(("Port", "Sink", "Host", "Authority", "Clock")):
            valid = (
                declaration["kind"] == "class"
                and "Protocol" in bases
                and declaration.get("methodsTyped") is True
            )
        else:
            valid = (
                declaration["kind"] == "class"
                and any(value.startswith("dataclass") for value in decorators)
                and declaration.get("fieldsTyped") is True
            )
        if not valid:
            issues.append({"code": "typed-seam-invalid", "symbol": reference})
    owner_paths: dict[str, list[str]] = {}
    for owner in manifest.get("ownership", []):
        owner_name = str(owner.get("owner") or "")
        for path in owner.get("paths") or []:
            owner_paths.setdefault(str(path), []).append(owner_name)
    for path, owners in owner_paths.items():
        if len(set(owners)) != 1:
            issues.append(
                {"code": "duplicated-responsibility", "path": path, "owners": owners}
            )
    issues.extend(exception_issues(manifest))
    return issues


def baseline_document(ref: str, manifest: dict[str, Any]) -> dict[str, Any]:
    roots = [PYTHON_SOURCE_ROOT, *manifest["sourceRoots"]["test"]]
    measurement = compact_measurement(measure(files_at_ref(ref, roots), manifest))
    commit = git("rev-parse", f"{ref}^{{commit}}").decode().strip()
    body = {
        "schema": "kungfu.python-structure-baseline/v1",
        "sourceRevision": commit,
        "measurement": measurement,
    }
    return {**body, "baselineRoot": digest(body)}


def report_document(
    baseline: dict[str, Any], current: dict[str, Any], manifest: dict[str, Any]
) -> dict[str, Any]:
    issues = governance_issues(
        baseline["measurement"], current, manifest, str(baseline["sourceRevision"])
    )
    retained_measurement = compact_measurement(current)
    body = {
        "schema": "kungfu.abstraction-integrity-report/v1",
        "sourceRevision": git("rev-parse", "HEAD^{commit}").decode().strip(),
        "manifestPath": MANIFEST_PATH.as_posix(),
        "manifestRoot": digest(manifest),
        "generatorRoot": digest_bytes(Path(__file__).read_bytes()),
        "baselineRoot": baseline["baselineRoot"],
        "sourceRoot": retained_measurement["sourceRoot"],
        "measurement": retained_measurement,
        "publicImports": manifest["publicImports"],
        "typedSeams": manifest["typedSeams"],
        "ownership": manifest["ownership"],
        "exceptions": manifest["exceptions"],
        "summary": {"blockingIssues": len(issues)},
        "issues": issues,
    }
    return {**body, "reportRoot": digest(body)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit-baseline", metavar="REF")
    parser.add_argument("--emit-report", action="store_true")
    parser.add_argument("--check-legacy-report", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    manifest = read_json(MANIFEST_PATH)
    if args.emit_baseline:
        print(
            json.dumps(
                baseline_document(args.emit_baseline, manifest),
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    baseline = read_json(Path(manifest["baselinePath"]))
    expected_root = baseline.get("baselineRoot")
    baseline_body = {
        key: value for key, value in baseline.items() if key != "baselineRoot"
    }
    if expected_root != digest(baseline_body):
        raise ValueError("Python structure baseline root is invalid")
    rebuilt = baseline_document(str(baseline["sourceRevision"]), manifest)
    if rebuilt != baseline:
        raise ValueError("Python structure baseline is stale or incomplete")
    roots = [PYTHON_SOURCE_ROOT, *manifest["sourceRoots"]["test"]]
    report = report_document(
        baseline, measure(files_at_worktree(roots), manifest), manifest
    )
    if args.emit_report:
        print(json.dumps(report, indent=2, sort_keys=True))
        return int(report["summary"]["blockingIssues"] > 0)
    if args.check_legacy_report:
        retained = read_json(Path(manifest["legacyReportPath"]))
        if retained != report:
            raise ValueError("legacy abstraction integrity snapshot is stale")
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        print(
            f"python-structure source={report['sourceRoot']} blocking={report['summary']['blockingIssues']}"
        )
    return int(report["summary"]["blockingIssues"] > 0)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"python-structure: {error}", file=sys.stderr)
        raise SystemExit(2) from error
