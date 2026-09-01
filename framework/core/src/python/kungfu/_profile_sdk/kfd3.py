# SPDX-License-Identifier: Apache-2.0

"""KFD-3 qualification adapter for the installed Profile SDK."""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import TYPE_CHECKING, Any, Mapping

if TYPE_CHECKING:
    from kungfu.profile_sdk_kfd3 import Kfd3Operations as Kfd3OperationsType
else:
    Kfd3OperationsType = Any

_facade = importlib.import_module("kungfu.profile_sdk")

Kfd3Operations = _facade.Kfd3Operations
ProfileSdkError = _facade.ProfileSdkError
_build_kfd3_release_manifest = _facade._build_kfd3_release_manifest
_earn_kfd3_impl = _facade._earn_kfd3_impl
_kfd3_qualification_plan = _facade._kfd3_qualification_plan
_kfd3_status = _facade._kfd3_status
_qualify_kfd3 = _facade._qualify_kfd3
_authorize_kfd3_qualification = _facade._authorize_kfd3_qualification
_verify_kfd3 = _facade._verify_kfd3
_read_ref_json = _facade._read_ref_json
_work_profile_conformance = _facade._work_profile_conformance
application = _facade.application
intent_plan = _facade.intent_plan
decision_card = _facade.decision_card
lifecycle_plan = _facade.lifecycle_plan
lifecycle_apply = _facade.lifecycle_apply
answer_decision = _facade.answer_decision
validate_source = _facade.validate_source


def _kfd3_operations() -> Kfd3OperationsType:
    return Kfd3Operations(
        validate_source=validate_source,
        application=application,
        intent_plan=intent_plan,
        decision_card=decision_card,
        lifecycle_plan=lifecycle_plan,
        lifecycle_apply=lifecycle_apply,
        answer_decision=answer_decision,
    )


def _earn_kfd3(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    qualification_source: str,
) -> dict[str, Any]:
    return _earn_kfd3_impl(
        _kfd3_operations(),
        source,
        runtime_dir,
        qualification_source=qualification_source,
    )


def build_kfd3_release_manifest(
    sources: list[str | Path], runtime_dir: str | Path
) -> dict[str, Any]:
    return _build_kfd3_release_manifest(_kfd3_operations(), sources, runtime_dir)


def kfd3_status(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    return _kfd3_status(_kfd3_operations(), source, runtime_dir)


def kfd3_qualification_plan(
    source: str | Path, runtime_dir: str | Path
) -> dict[str, Any]:
    return _kfd3_qualification_plan(_kfd3_operations(), source, runtime_dir)


def qualify_kfd3(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    authorization_id: str = "kfd3-cli-explicit",
    qualification_source: str = "local",
) -> dict[str, Any]:
    return _qualify_kfd3(
        _kfd3_operations(),
        source,
        runtime_dir,
        authorization_id=authorization_id,
        qualification_source=qualification_source,
    )


def authorize_kfd3_qualification(
    source: str | Path,
    runtime_dir: str | Path,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    return _authorize_kfd3_qualification(
        _kfd3_operations(),
        source,
        runtime_dir,
        expected_plan_id,
        choice,
        authorized_by,
    )


def verify_kfd3(
    source: str | Path, runtime_dir: str | Path, receipt: Mapping[str, Any]
) -> dict[str, Any]:
    return _verify_kfd3(_kfd3_operations(), source, runtime_dir, receipt)


def qualify_source(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    validated = validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    compatibility = _read_ref_json(
        inspection, inspection["profile"]["kfd1"]["compatibility"]
    )
    qualification = _read_ref_json(
        inspection, inspection["profile"]["qualification"]["profile"]
    )
    contracts = compatibility.get("runtimeContracts", [])
    checks = qualification.get("checks", [])
    if (
        contracts != ["kungfu.profile-lifecycle/v1"]
        and "kungfu.profile-lifecycle/v1" not in contracts
    ):
        raise ProfileSdkError(
            "runtime-incompatible", "Profile omits the current lifecycle contract"
        )
    if sorted(checks) != ["content-closure", "runtime-contract"]:
        raise ProfileSdkError(
            "qualification-check-unsupported",
            "This runtime only qualifies content-closure and runtime-contract",
            requested=checks,
        )
    collaboration = validated["collaboration"]
    return {
        "schema": "kungfu.profile-source-qualification/v1",
        "profileSuiteRoot": inspection["profile_suite_root"],
        "status": "qualified-for-install-plan",
        "checks": sorted(checks),
        "evidenceScope": "source-contract/content-closure/runtime-contract",
        "kfd3": {
            "declared": collaboration["declared"],
            "qualified": False,
            "status": collaboration.get("qualificationStatus", "not-declared"),
            "closureRoot": collaboration.get("closureRoot"),
            "reason": collaboration.get("reason"),
        },
        "workConformance": _work_profile_conformance(inspection, "qualify"),
        "lifecycleMutation": False,
    }
