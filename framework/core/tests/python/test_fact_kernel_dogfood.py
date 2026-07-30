# SPDX-License-Identifier: Apache-2.0

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
WORKLOAD = ROOT / "framework/core/tests/qualification/fact_kernel_dogfood/workload.py"
REPORT = (
    ROOT
    / "docs/qualification/evidence/fact-kernel-dogfood/generic-fact-kernel-v1/report.json"
)


def _module():
    spec = importlib.util.spec_from_file_location(
        "fact_kernel_dogfood_workload", WORKLOAD
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_three_process_no_chat_handoff_matches_retained_report(tmp_path):
    actual = _module().run_qualification(tmp_path)
    retained = json.loads(REPORT.read_text(encoding="utf-8"))

    assert actual == retained
    assert actual["handoff"]["human_relay_count"] == 0
    assert len(set(actual["role_identities"].values())) == 4
    assert actual["p17"]["checks"]["FO1"] == "qualified"
    assert actual["p17"]["checks"]["FO6"] == "qualified"
    assert actual["p17"]["status"] == "not-qualified"
    assert actual["decision"] == "continue-shadow"
    assert all(item["status"] != "silent" for item in actual["fault_matrix"])
