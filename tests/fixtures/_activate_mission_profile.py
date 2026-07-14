# SPDX-License-Identifier: Apache-2.0

"""Authorize the exact Mission Control Profile used by Atlas fixtures."""

from pathlib import Path
import sys

core_dir = Path(__file__).resolve().parents[2] / "framework" / "core"
sys.path.insert(0, str(core_dir / "src" / "python"))
sys.path.insert(0, str(core_dir / "dist" / "kungfu"))

from kungfu import profile_composition, profile_sdk  # noqa: E402


runtime_dir = Path(sys.argv[1])
source = Path(sys.argv[2])

for action in ("install", "qualify", "activate"):
    plan = profile_sdk.lifecycle_plan(
        runtime_dir,
        action,
        source,
        **({"granted_permissions": ["storage"]} if action == "activate" else {}),
    )["corePlan"]
    profile_sdk.lifecycle_apply(runtime_dir, plan, f"fixture:{action}")

contract = profile_composition.contract_materialization_plan(source, runtime_dir)
if contract["operations"]:
    profile_composition.authorized_contract_materialize(
        runtime_dir,
        contract,
        profile_sdk.answer_decision(
            contract["decisionCard"], "approve", "fixture-owner"
        ),
    )
