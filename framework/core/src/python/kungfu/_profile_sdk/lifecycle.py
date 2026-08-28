# SPDX-License-Identifier: Apache-2.0

"""Profile source portability and lifecycle responsibility owner."""

from __future__ import annotations

import base64
import importlib
from pathlib import Path
from typing import Any, Mapping

_facade = importlib.import_module("kungfu.profile_sdk")

SOURCE_BUNDLE_SCHEMA = _facade.SOURCE_BUNDLE_SCHEMA
SOURCE_IMPORT_PLAN_SCHEMA = _facade.SOURCE_IMPORT_PLAN_SCHEMA
DECISION_ANSWER_SCHEMA = _facade.DECISION_ANSWER_SCHEMA
ProfileSdkError = _facade.ProfileSdkError
_portable_source_paths = _facade._portable_source_paths
_sha256 = _facade._sha256
_root = _facade._root
_validate_sdk_value = _facade._validate_sdk_value
_validate_source_bundle = _facade._validate_source_bundle
_confined = _facade._confined
decision_card = _facade.decision_card
validate_decision_answer = _facade.validate_decision_answer
validate_source = _facade.validate_source
resolve_source = _facade.resolve_source
storage_service = _facade.storage_service
_work_profile_conformance = _facade._work_profile_conformance


def _lifecycle_decision_card(*args, **kwargs):
    return _facade._lifecycle_decision_card(*args, **kwargs)


def _validate_decision_card(*args, **kwargs):
    return _facade._validate_decision_card(*args, **kwargs)


def _validate_decision_answer(*args, **kwargs):
    return _facade._validate_decision_answer(*args, **kwargs)


def export_source_bundle(
    source: str | Path, runtime_dir: str | Path, *, thin: bool = False
) -> dict[str, Any]:
    """Export an exact Profile source closure without lifecycle side effects."""

    validated = validate_source(source, runtime_dir)
    root = Path(validated["source"]["source"]).resolve()
    entries = []
    for path in _portable_source_paths(root):
        data = path.read_bytes()
        entry = {
            "path": path.relative_to(root).as_posix(),
            "sha256": _sha256(data),
            "size": len(data),
        }
        if not thin:
            entry["contentBase64"] = base64.b64encode(data).decode("ascii")
        entries.append(entry)
    body = {
        "schema": SOURCE_BUNDLE_SCHEMA,
        "mode": "thin" if thin else "full",
        "selfContained": not thin,
        "profileId": validated["source"]["profile"]["id"],
        "profileVersion": validated["source"]["profile"]["version"],
        "profileSuiteRoot": validated["inspection"]["profile_suite_root"],
        "memberRoots": validated["source"]["memberRoots"],
        "entries": entries,
    }
    body["bundleRoot"] = _root(body)
    _validate_sdk_value("sourceBundleSchema", body, "Profile source bundle")
    return body


def source_import_plan(
    bundle: Mapping[str, Any], destination: str | Path
) -> dict[str, Any]:
    """Plan reconstruction of source bytes; never install or activate a Profile."""

    normalized = _validate_source_bundle(bundle)
    target = Path(destination).expanduser().resolve()
    collision = target.exists() and (not target.is_dir() or any(target.iterdir()))
    identity = {
        "bundle": normalized,
        "destination": str(target),
        "destinationCollision": collision,
    }
    plan = {
        "schema": SOURCE_IMPORT_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "requiresAuthorization": normalized["mode"] == "full" and not collision,
    }
    if normalized["mode"] == "thin":
        plan["decisionCard"] = decision_card(
            "profile-source-material-required",
            "Thin Profile bundles are root inventories; supply a full bundle before reconstruction.",
            choices=["supply-full-bundle"],
            basis={"bundleRoot": normalized["bundleRoot"]},
            required_authority="profile-source-owner",
            resume_command="export or obtain the exact full Profile source bundle",
        )
    elif collision:
        plan["decisionCard"] = decision_card(
            "profile-source-collision",
            "The Profile source import destination is not empty.",
            choices=["choose-an-empty-directory", "inspect-and-merge-manually"],
            basis={"bundleRoot": normalized["bundleRoot"], "destination": str(target)},
            required_authority="profile-source-owner",
            resume_command="choose an empty destination and re-plan",
        )
    else:
        plan["decisionCard"] = decision_card(
            "profile-source-import-authorization",
            "Authorize reconstruction of this exact Profile source closure without lifecycle activation.",
            choices=["approve", "deny"],
            basis={"planId": plan["planId"], "bundleRoot": normalized["bundleRoot"]},
            required_authority="profile-source-owner",
            resume_command="answer this card, then apply the exact source import plan",
        )
    return plan


def authorized_source_import(
    plan: Mapping[str, Any], answer: Mapping[str, Any]
) -> dict[str, Any]:
    if plan.get("schema") != SOURCE_IMPORT_PLAN_SCHEMA:
        raise ProfileSdkError(
            "source-import-plan-invalid", "Profile source import requires an exact plan"
        )
    refreshed = source_import_plan(
        dict(plan.get("bundle") or {}), str(plan.get("destination") or "")
    )
    if refreshed["planId"] != plan.get("planId"):
        raise ProfileSdkError(
            "source-import-plan-stale", "Profile source bundle or destination changed"
        )
    if not refreshed["requiresAuthorization"]:
        raise ProfileSdkError(
            "source-import-not-ready",
            "Profile source import needs a full bundle and an empty destination",
            decisionCards=[refreshed["decisionCard"]],
        )
    validate_decision_answer(answer, refreshed["decisionCard"])
    if (
        answer.get("choice") != "approve"
        or (answer.get("basis") or {}).get("planId") != refreshed["planId"]
    ):
        raise ProfileSdkError(
            "decision-denied", "Profile source import was not approved"
        )
    target = Path(refreshed["destination"])
    target.mkdir(parents=True, exist_ok=True)
    written = []
    for entry in refreshed["bundle"]["entries"]:
        path = _confined(target, entry["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        data = base64.b64decode(entry["contentBase64"], validate=True)
        path.write_bytes(data)
        written.append(entry["path"])
    return {
        "schema": "kungfu.profile-source-import-receipt/v1",
        "planId": refreshed["planId"],
        "authorizationId": answer["authorizationId"],
        "bundleRoot": refreshed["bundle"]["bundleRoot"],
        "profileSuiteRoot": refreshed["bundle"]["profileSuiteRoot"],
        "destination": str(target),
        "written": written,
        "lifecycleMutation": False,
    }


def lifecycle_plan(
    runtime_dir: str | Path,
    action: str,
    source: str | Path | None = None,
    **values: Any,
) -> dict[str, Any]:
    request: dict[str, Any] = {"action": action, **values}
    if source is not None:
        resolved = resolve_source(source)
        request.update(
            profile_path=resolved["profilePath"],
            member_roots=resolved["memberRoots"],
        )
        if action in {"qualify", "activate"}:
            inspection = storage_service.profile_lifecycle(
                runtime_dir,
                "inspect",
                profile_path=resolved["profilePath"],
                member_roots=resolved["memberRoots"],
            )
            work_conformance = _work_profile_conformance(
                inspection, "qualify" if action == "qualify" else "installed-runtime"
            )
            if work_conformance is not None:
                request["work_conformance"] = work_conformance
    plan = storage_service.profile_lifecycle(runtime_dir, "plan", request=request)
    return {
        "schema": "kungfu.profile-agent-plan/v1",
        "corePlan": plan,
        "decisionCard": _lifecycle_decision_card(action, plan),
    }


def lifecycle_apply(
    runtime_dir: str | Path, core_plan: Mapping[str, Any], authorization_id: str
) -> dict[str, Any]:
    return storage_service.profile_lifecycle(
        runtime_dir, "apply", plan=dict(core_plan), authorization_id=authorization_id
    )


def answer_decision(
    card: Mapping[str, Any], choice: str, authorized_by: str
) -> dict[str, Any]:
    _validate_decision_card(card)
    if choice not in card.get("choices", []):
        raise ProfileSdkError(
            "decision-choice-invalid",
            "answer is not one of the decision card choices",
            choices=card.get("choices", []),
        )
    actor = authorized_by.strip()
    if not actor:
        raise ProfileSdkError(
            "decision-actor-required", "authorized_by must not be empty"
        )
    identity = {
        "cardId": card["cardId"],
        "choice": choice,
        "authorizedBy": actor,
        "requiredAuthority": card["requiredAuthority"],
        "basis": card["basis"],
    }
    answer = {
        "schema": DECISION_ANSWER_SCHEMA,
        "authorizationId": _root(identity),
        **identity,
        "authorityVerification": "external-policy-required",
    }
    _validate_decision_answer(answer, card)
    return answer


def authorized_lifecycle_apply(
    runtime_dir: str | Path,
    agent_plan: Mapping[str, Any],
    answer: Mapping[str, Any],
) -> dict[str, Any]:
    if agent_plan.get("schema") != "kungfu.profile-agent-plan/v1":
        raise ProfileSdkError(
            "agent-plan-invalid", "apply requires a Profile Agent plan"
        )
    card = agent_plan.get("decisionCard") or {}
    core_plan = agent_plan.get("corePlan") or {}
    expected_card = _lifecycle_decision_card(
        str((core_plan.get("request") or {}).get("action") or ""), core_plan
    )
    if card.get("cardId") != expected_card.get("cardId"):
        raise ProfileSdkError(
            "decision-card-mismatch", "Agent plan decision card was altered"
        )
    _validate_decision_answer(answer, card)
    if answer.get("choice") != "approve":
        raise ProfileSdkError(
            "decision-denied", "the Profile lifecycle plan was not approved"
        )
    if (answer.get("basis") or {}).get("planId") != core_plan.get("plan_id"):
        raise ProfileSdkError(
            "decision-basis-mismatch", "decision answer does not bind this Core plan"
        )
    return lifecycle_apply(
        runtime_dir, core_plan, str(answer.get("authorizationId") or "")
    )


def authorize_current_lifecycle(
    runtime_dir: str | Path,
    action: str,
    source: str | Path,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    """Re-plan an exact source cut, then answer and apply its installed card."""

    plan = lifecycle_plan(runtime_dir, action, source)
    actual = str((plan.get("corePlan") or {}).get("plan_id") or "")
    if not expected_plan_id or actual != expected_plan_id:
        raise ProfileSdkError(
            "lifecycle-plan-stale",
            "Profile lifecycle plan changed; review a new decision card",
            expectedPlanId=expected_plan_id,
            actualPlanId=actual,
        )
    answer = answer_decision(plan["decisionCard"], choice, authorized_by)
    return authorized_lifecycle_apply(runtime_dir, plan, answer)
