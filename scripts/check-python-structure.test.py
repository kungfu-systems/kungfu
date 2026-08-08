# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "check_python_structure", ROOT / "scripts/check-python-structure.py"
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PythonStructureGovernanceTest(unittest.TestCase):
    def test_git_timeout_is_reported(self) -> None:
        with mock.patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(("git", "show"), 10),
        ):
            with self.assertRaisesRegex(ValueError, "timed out after 10s"):
                MODULE.git("show", "HEAD:file")

    @staticmethod
    def _empty_measurement(manifest):
        return {
            "parseErrors": [],
            "hiddenProductionFiles": [],
            "files": [],
            "aggregates": {row["id"]: 0 for row in manifest["aggregates"]},
            "stronglyConnectedComponents": [],
        }

    def test_negative_anti_gaming_corpus_fails_closed(self) -> None:
        fixtures = json.loads(
            (
                ROOT
                / "framework/maintainability/python-structure-negative-fixtures.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            fixtures["schema"], "kungfu.python-structure-negative-fixtures/v2"
        )
        base_manifest = MODULE.read_json(MODULE.MANIFEST_PATH)
        for case in fixtures["cases"]:
            manifest = copy.deepcopy(base_manifest)
            manifest["sourceRoots"]["production"] = case.get(
                "productionRoots", manifest["sourceRoots"]["production"]
            )
            manifest["ownership"] = case.get("ownership", manifest["ownership"])
            manifest["exceptions"] = case.get("exceptions", manifest["exceptions"])
            baseline = {
                "oversizedFiles": [],
                "aggregates": {row["id"]: 0 for row in manifest["aggregates"]},
                "stronglyConnectedComponents": [],
            }
            current = self._empty_measurement(manifest)
            tracked_paths = set()
            if case.get("contents"):
                current = MODULE.measure(case["contents"], manifest)
            if case.get("baselineFile"):
                baseline["oversizedFiles"] = [case["baselineFile"]]
                current["files"] = [case["currentFile"]]
                tracked_paths.add(case["baselineFile"]["path"])
            issues = MODULE.governance_issues(
                baseline,
                current,
                manifest,
                "fixture-baseline",
                tracked_paths=tracked_paths,
            )
            self.assertIn(
                case["expected"],
                {issue["code"] for issue in issues},
                msg=case["id"],
            )

    def test_typed_seam_declaration_must_remain_structural(self) -> None:
        manifest = MODULE.read_json(MODULE.MANIFEST_PATH)
        current = MODULE.measure(
            {
                "framework/core/src/python/kungfu/fake.py": (
                    "ProductReleaseHistoryPort = object()\n"
                )
            },
            {**manifest, "typedSeams": ["kungfu.fake.ProductReleaseHistoryPort"]},
        )
        issues = MODULE.governance_issues(
            {
                "oversizedFiles": [],
                "aggregates": current["aggregates"],
                "stronglyConnectedComponents": [],
            },
            current,
            {**manifest, "typedSeams": ["kungfu.fake.ProductReleaseHistoryPort"]},
            "fixture-baseline",
            tracked_paths=set(
                current_path["path"] for current_path in current["files"]
            ),
        )
        self.assertIn("typed-seam-invalid", {issue["code"] for issue in issues})

    def test_scc_query_is_deterministic(self) -> None:
        graph = {"a": ["b"], "b": ["a", "c"], "c": []}
        self.assertEqual(MODULE.strongly_connected(graph), [["a", "b"]])

    def test_physical_lines_do_not_hide_minified_source(self) -> None:
        self.assertEqual(MODULE.physical_lines("a=1;b=2\n"), 1)


if __name__ == "__main__":
    unittest.main()
