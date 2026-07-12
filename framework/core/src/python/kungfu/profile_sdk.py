# SPDX-License-Identifier: Apache-2.0

"""Installed, agent-facing authoring layer for KFX Profile Suites.

This module owns no lifecycle state and no Profile schema.  It resolves source
packages, computes content roots, and delegates every lifecycle decision and
mutation to the Core service introduced by ADR-0069.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping

from kungfu import agent as agent_pack
from kungfu import contract as contract_runtime
from kungfu import kfx_contract
from kungfu.storage import service as storage_service


SDK_SCHEMA = "kungfu.agent-profile-sdk/v1"
BRIEF_SCHEMA = "kungfu.profile-brief/v1"
DECISION_CARD_SCHEMA = "kungfu.decision-card/v1"
DIAGNOSIS_SCHEMA = "kungfu.profile-diagnosis/v1"
SOURCE_PLAN_SCHEMA = "kungfu.profile-source-plan/v1"
ACTION_REGISTRY_SCHEMA = "kungfu.profile-actions/v1"
ACTION_PLAN_SCHEMA = "kungfu.profile-action-plan/v1"
ACTION_RECEIPT_SCHEMA = "kungfu.profile-action-receipt/v1"
DECISION_ANSWER_SCHEMA = "kungfu.decision-answer/v1"

_TOKEN = re.compile(r"^[A-Za-z0-9._-]+$")
_IGNORED_PARTS = {".git", "node_modules", "__pycache__", ".DS_Store"}


class ProfileSdkError(ValueError):
    def __init__(self, code: str, message: str, **details: Any):
        self.diagnosis = {
            "schema": DIAGNOSIS_SCHEMA,
            "ok": False,
            "code": code,
            "message": message,
            **details,
        }
        super().__init__(message)


def capabilities() -> dict[str, Any]:
    sdk_contract = agent_pack.profile_sdk_contract()
    contract_bytes = agent_pack.document_text("profile-sdk.contract.json").encode(
        "utf-8"
    )
    return {
        "schema": SDK_SCHEMA,
        "contract": kfx_contract.contract_metadata(),
        "profileSchema": kfx_contract.profile_suite_schema(),
        "sdkContract": {
            "schema": sdk_contract["schema"],
            "id": sdk_contract["id"],
            "version": sdk_contract["version"],
            "root": "sha256:" + _sha256(contract_bytes),
        },
        "schemas": {
            "brief": sdk_contract["briefSchema"],
            "decisionCard": sdk_contract["decisionCardSchema"],
            "decisionAnswer": sdk_contract["decisionAnswerSchema"],
            "actionRegistry": sdk_contract["actionRegistrySchema"],
            "factSurfaces": sdk_contract["factSurfacesSchema"],
            "claims": sdk_contract["claimsSchema"],
            "assessmentPolicies": sdk_contract["assessmentPoliciesSchema"],
            "views": sdk_contract["viewsSchema"],
        },
        "sourcePlanSchema": SOURCE_PLAN_SCHEMA,
        "actionRegistrySchema": ACTION_REGISTRY_SCHEMA,
        "lifecycleAuthority": storage_service.profile_lifecycle("", "contract"),
        "operations": [
            "capabilities",
            "examples",
            "scaffold",
            "validate",
            "qualify",
            "plan",
            "decide",
            "apply",
            "inspect",
            "list",
            "history",
            "diff",
            "actions",
            "invoke-plan",
            "invoke",
            "catalog",
            "query-plan",
            "query-run",
            "assess-plan",
            "assess-run",
            "manager",
            "authorize-lifecycle",
        ],
        "customMemberBuild": {
            "command": "kungfu sdk kfx build",
            "rebuildsProduct": False,
        },
        "authorityBoundaries": {
            "schema": "embedded-kfx-contract",
            "memberRoots": "resolved-package-bytes",
            "lifecycle": "libkungfu-profile-lifecycle",
            "authorization": "external-explicit-decision",
            "selfCertification": False,
        },
    }


def examples() -> dict[str, Any]:
    return {
        "schema": "kungfu.profile-examples/v1",
        "brief": {
            "schema": BRIEF_SCHEMA,
            "id": "example.week-day",
            "title": "Week / Day",
            "version": "1.0.0",
            "purposes": ["handoff", "operator-review"],
            "permissions": [],
            "identity": {"authority": "workspace-owner"},
            "evidence": {"strength": "reported-with-references"},
            "migration": {"mode": "additive"},
        },
        "flow": [
            "kungfu profile scaffold brief.json --out ./week-day --json",
            "kungfu profile scaffold brief.json --out ./week-day --execute --json",
            "kungfu profile validate ./week-day --json",
            "kungfu profile qualify ./week-day --json",
            "kungfu profile plan install ./week-day --json",
        ],
    }


def validate_contract_artifact(schema_key: str, value: Any, label: str) -> None:
    """Validate an Agent Profile SDK edge artifact against the installed pack."""

    _validate_sdk_value(schema_key, value, label)


def validate_decision_answer(
    answer: Mapping[str, Any], card: Mapping[str, Any]
) -> None:
    """Verify an external decision answer against one exact installed card."""

    _validate_decision_answer(answer, card)


def scaffold_plan(brief: Mapping[str, Any], out: str | Path) -> dict[str, Any]:
    normalized, cards = _normalize_brief(brief)
    out_path = Path(out).expanduser().resolve()
    if out_path.exists() and any(
        out_path.iterdir() if out_path.is_dir() else [out_path]
    ):
        cards.append(
            decision_card(
                "profile-source-collision",
                "The requested Profile source destination is not empty.",
                choices=["choose-an-empty-directory", "inspect-and-merge-manually"],
                basis={"destination": str(out_path)},
                required_authority="workspace-owner",
                resume_command="kungfu profile scaffold <brief.json> --out <empty-dir> --json",
            )
        )
    if cards:
        return {
            "schema": SOURCE_PLAN_SCHEMA,
            "ok": False,
            "status": "needs-decision",
            "destination": str(out_path),
            "decisionCards": cards,
            "writes": [],
        }
    files = _source_files(normalized)
    identity = _source_plan_identity(normalized, str(out_path), files)
    return {
        "schema": SOURCE_PLAN_SCHEMA,
        "ok": True,
        "status": "ready",
        "planId": _root(identity),
        "destination": str(out_path),
        "normalizedBrief": normalized,
        "writes": identity["files"],
        "files": {path: data.decode("utf-8") for path, data in files.items()},
        "selfCertifiedFields": [],
        "requiresExecute": True,
    }


def apply_scaffold(plan: Mapping[str, Any]) -> dict[str, Any]:
    if plan.get("schema") != SOURCE_PLAN_SCHEMA or not plan.get("ok"):
        raise ProfileSdkError(
            "source-plan-invalid", "scaffold requires a ready source plan"
        )
    destination = Path(str(plan["destination"]))
    if destination.exists() and any(
        destination.iterdir() if destination.is_dir() else [destination]
    ):
        raise ProfileSdkError(
            "source-plan-stale",
            "Profile source destination changed after planning",
            destination=str(destination),
        )
    files = plan.get("files")
    if not isinstance(files, Mapping):
        raise ProfileSdkError("source-plan-invalid", "source plan has no file material")
    if not all(
        isinstance(path, str) and isinstance(text, str) for path, text in files.items()
    ):
        raise ProfileSdkError(
            "source-plan-invalid", "source plan files must be UTF-8 text entries"
        )
    material = {path: text.encode("utf-8") for path, text in files.items()}
    identity = _source_plan_identity(
        plan.get("normalizedBrief"), str(destination), material
    )
    if _root(identity) != plan.get("planId") or plan.get("writes") != identity["files"]:
        raise ProfileSdkError(
            "source-plan-tampered",
            "source plan material no longer matches its identity",
        )
    written = []
    for relative, text in sorted(files.items()):
        target = _confined(destination, str(relative))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        written.append(str(target))
    return {
        "schema": "kungfu.profile-source-receipt/v1",
        "planId": plan["planId"],
        "destination": str(destination),
        "written": written,
        "verified": all(
            Path(path).is_file() and _sha256(Path(path).read_bytes()) == row["sha256"]
            for path, row in zip(written, identity["files"], strict=True)
        ),
    }


def resolve_source(source: str | Path) -> dict[str, Any]:
    suite_dir = Path(source).expanduser().resolve()
    manifest = kfx_contract.read_manifest_from_dir(str(suite_dir))
    config = manifest.get("kungfuConfig") or {}
    suite = config.get("suite")
    if not isinstance(suite, Mapping):
        raise ProfileSdkError(
            "suite-manifest-required", "source is not a KFX Suite package"
        )
    profile_rel = str(suite.get("profile") or "")
    if not profile_rel:
        raise ProfileSdkError(
            "profile-path-required", "Suite manifest does not declare suite.profile"
        )
    profile_path = _confined(suite_dir, profile_rel)
    try:
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileSdkError(
            "profile-unreadable", str(error), path=str(profile_path)
        ) from error
    members = list(suite.get("members") or [])
    kfx_contract.validate_profile_suite(profile, suite_members=members)
    expected = sorted(set(members))
    candidates: dict[str, list[Path]] = {key: [] for key in expected}
    for directory in _package_dirs(suite_dir):
        try:
            candidate = kfx_contract.read_manifest_from_dir(str(directory))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        key = kfx_contract.package_key(candidate)
        if key in candidates:
            candidates[key].append(directory)
    duplicate = {
        key: [str(p) for p in paths]
        for key, paths in candidates.items()
        if len(paths) > 1
    }
    missing = [key for key, paths in candidates.items() if not paths]
    if missing or duplicate:
        cards = []
        if missing:
            cards.append(
                decision_card(
                    "profile-member-missing",
                    "One or more declared Suite members cannot be resolved.",
                    choices=["supply-member-package", "remove-member-and-replan"],
                    basis={"source": str(suite_dir), "members": missing},
                    required_authority="profile-author",
                    resume_command=f"kungfu profile validate {suite_dir} --json",
                )
            )
        if duplicate:
            cards.append(
                decision_card(
                    "profile-member-duplicate",
                    "A Suite member identity resolves to multiple package closures.",
                    choices=["remove-duplicate", "rename-and-redeclare-member"],
                    basis={"duplicates": duplicate},
                    required_authority="profile-author",
                    resume_command=f"kungfu profile validate {suite_dir} --json",
                )
            )
        raise ProfileSdkError(
            "member-resolution-failed",
            "Suite members did not resolve exactly once",
            decisionCards=cards,
        )
    roots = {key: package_content_root(paths[0]) for key, paths in candidates.items()}
    return {
        "schema": "kungfu.profile-source-resolution/v1",
        "source": str(suite_dir),
        "suiteKey": kfx_contract.package_key(manifest),
        "profilePath": str(profile_path),
        "profile": profile,
        "memberRoots": roots,
        "memberPackages": {key: str(paths[0]) for key, paths in candidates.items()},
        "contract": kfx_contract.contract_metadata(),
        "verified": True,
    }


def validate_source(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    resolved = resolve_source(source)
    inspection = storage_service.profile_lifecycle(
        runtime_dir,
        "inspect",
        profile_path=resolved["profilePath"],
        member_roots=resolved["memberRoots"],
    )
    return {
        "schema": "kungfu.profile-validation/v1",
        "source": resolved,
        "inspection": inspection,
        "ok": True,
    }


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
    return {
        "schema": "kungfu.profile-source-qualification/v1",
        "profileSuiteRoot": inspection["profile_suite_root"],
        "status": "qualified-for-install-plan",
        "checks": sorted(checks),
        "evidenceScope": "source-contract/content-closure/runtime-contract",
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


def semantic_diff(left: str | Path, right: str | Path) -> dict[str, Any]:
    a = resolve_source(left)
    b = resolve_source(right)
    pa, pb = a["profile"], b["profile"]
    categories = {
        "display": _changes(pa, pb, ["title", "views"]),
        "content": _changes(pa, pb, ["kfd1", "members"]),
        "permission": _changes(pa, pb, ["permissions"]),
        "authority": _changes(pa, pb, ["actions"]),
        "evidence": _changes(pa, pb, ["kfd2", "qualification"]),
        "migration": _changes(pa, pb, ["migrations"]),
    }
    cards = []
    for category, authority in {
        "permission": "workspace-profile-operator",
        "authority": "profile-authority-owner",
        "evidence": "evidence-policy-owner",
        "migration": "workspace-data-owner",
    }.items():
        if categories[category]:
            cards.append(
                decision_card(
                    f"profile-{category}-change",
                    f"Approve or reject the Profile {category} change.",
                    choices=["approve", "reject", "revise"],
                    basis={"category": category, "changes": categories[category]},
                    required_authority=authority,
                    resume_command="rerun kungfu profile diff, then create a fresh lifecycle plan",
                )
            )
    return {
        "schema": "kungfu.profile-semantic-diff/v1",
        "leftRoot": validate_source(left, "")["inspection"]["profile_suite_root"],
        "rightRoot": validate_source(right, "")["inspection"]["profile_suite_root"],
        "categories": categories,
        "changedCategories": [key for key, rows in categories.items() if rows],
        "decisionCards": cards,
    }


def action_catalog(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    validated = validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    registry = _read_ref_json(inspection, inspection["profile"]["actions"]["registry"])
    _validate_action_registry(registry, inspection["profile"])
    return {
        "schema": "kungfu.profile-action-catalog/v1",
        "profileId": inspection["profile"]["id"],
        "profileSuiteRoot": inspection["profile_suite_root"],
        "source": str(Path(source).resolve()),
        "actions": registry["actions"],
    }


def plan_action(
    source: str | Path, runtime_dir: str | Path, action_id: str, input_value: Any
) -> dict[str, Any]:
    catalog = action_catalog(source, runtime_dir)
    action = next((row for row in catalog["actions"] if row["id"] == action_id), None)
    if action is None:
        raise ProfileSdkError(
            "action-not-found", f"Profile action not found: {action_id}"
        )
    state = storage_service.profile_lifecycle(
        runtime_dir, "get", profile_id=catalog["profileId"]
    )
    if (
        not state.get("activated")
        or state.get("profile_suite_root") != catalog["profileSuiteRoot"]
    ):
        raise ProfileSdkError(
            "profile-not-active", "Action requires this exact Profile root to be active"
        )
    identity = {
        "profileId": catalog["profileId"],
        "profileSuiteRoot": catalog["profileSuiteRoot"],
        "action": action,
        "input": input_value,
        "stateRevision": state["revision"],
        "source": catalog["source"],
    }
    missing_capabilities = sorted(
        set(action["requiredCapabilities"]) - set(state.get("granted_permissions", []))
    )
    if missing_capabilities:
        raise ProfileSdkError(
            "action-capability-not-granted",
            "Action requires Profile capabilities that are not active",
            missingCapabilities=missing_capabilities,
        )
    plan = {
        "schema": ACTION_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "requiresAuthorization": action["authorityClass"] != "none",
        "effects": action.get("effects", []),
    }
    if plan["requiresAuthorization"]:
        plan["decisionCard"] = decision_card(
            "profile-action-authorization",
            f"Authorize Profile action {action_id} for the exact active root.",
            choices=["approve", "deny"],
            basis={
                "planId": plan["planId"],
                "profileSuiteRoot": catalog["profileSuiteRoot"],
            },
            required_authority=action["authorityClass"],
            resume_command="answer this card, then invoke with the exact action plan and decision answer",
        )
    return plan


def invoke_action(
    runtime_dir: str | Path, plan: Mapping[str, Any], authorization_id: str | None
) -> dict[str, Any]:
    if plan.get("schema") != ACTION_PLAN_SCHEMA:
        raise ProfileSdkError(
            "action-plan-invalid", "invoke requires a Profile action plan"
        )
    refreshed = plan_action(
        str(plan.get("source") or ""),
        runtime_dir,
        str((plan.get("action") or {}).get("id") or ""),
        plan.get("input"),
    )
    if refreshed.get("planId") != plan.get("planId"):
        raise ProfileSdkError(
            "action-plan-stale", "Profile source or active state changed after planning"
        )
    action = plan.get("action") or {}
    if plan.get("requiresAuthorization") and not authorization_id:
        raise ProfileSdkError(
            "authorization-required", "Profile action requires an authorization id"
        )
    state = storage_service.profile_lifecycle(
        runtime_dir, "get", profile_id=plan["profileId"]
    )
    if state.get("profile_suite_root") != plan.get("profileSuiteRoot") or state.get(
        "revision"
    ) != plan.get("stateRevision"):
        raise ProfileSdkError(
            "action-plan-stale", "active Profile state changed after action planning"
        )
    # S2 exposes the common lifecycle action seam. Domain fact mutation lands in
    # S3 once its declared schemas/queries/assessment policies can be bound.
    if action.get("runner") != "profile-lifecycle":
        raise ProfileSdkError(
            "action-runner-unsupported", "S2 only invokes profile-lifecycle actions"
        )
    lifecycle_action = action.get("operation")
    if lifecycle_action not in {"qualify", "activate", "remove"}:
        raise ProfileSdkError(
            "action-operation-unsupported", "unsupported lifecycle action operation"
        )
    source = plan.get("source")
    values: dict[str, Any] = {}
    if lifecycle_action == "remove":
        values["profile_id"] = plan["profileId"]
        source = None
    core = lifecycle_plan(runtime_dir, lifecycle_action, source, **values)["corePlan"]
    receipt = lifecycle_apply(
        runtime_dir, core, authorization_id or "action-policy:none"
    )
    return {
        "schema": ACTION_RECEIPT_SCHEMA,
        "planId": plan["planId"],
        "authorizationId": authorization_id,
        "coreReceipt": receipt,
        "verified": True,
    }


def authorized_action_invoke(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if plan.get("schema") != ACTION_PLAN_SCHEMA:
        raise ProfileSdkError(
            "action-plan-invalid", "invoke requires a Profile action plan"
        )
    if not plan.get("requiresAuthorization"):
        return invoke_action(runtime_dir, plan, None)
    refreshed = plan_action(
        str(plan.get("source") or ""),
        runtime_dir,
        str((plan.get("action") or {}).get("id") or ""),
        plan.get("input"),
    )
    card = plan.get("decisionCard") or {}
    if card.get("cardId") != (refreshed.get("decisionCard") or {}).get("cardId"):
        raise ProfileSdkError(
            "decision-card-mismatch", "action plan decision card was altered"
        )
    if not answer:
        raise ProfileSdkError(
            "decision-answer-invalid", "action invoke requires a decision answer"
        )
    _validate_decision_answer(answer, card)
    if answer.get("choice") != "approve":
        raise ProfileSdkError("decision-denied", "the Profile action was not approved")
    if (answer.get("basis") or {}).get("planId") != plan.get("planId"):
        raise ProfileSdkError(
            "decision-basis-mismatch", "decision answer does not bind this action plan"
        )
    return invoke_action(runtime_dir, plan, str(answer.get("authorizationId") or ""))


def decision_card(
    kind: str,
    question: str,
    *,
    choices: list[str],
    basis: Mapping[str, Any],
    required_authority: str,
    resume_command: str,
) -> dict[str, Any]:
    identity = {
        "kind": kind,
        "question": question,
        "choices": choices,
        "basis": basis,
        "requiredAuthority": required_authority,
    }
    card = {
        "schema": DECISION_CARD_SCHEMA,
        "cardId": _root(identity),
        **identity,
        "status": "open",
        "expiry": {"mode": "basis-root-change", "staleWhen": "any basis value changes"},
        "resumeCommand": resume_command,
        "answer": None,
    }
    _validate_sdk_value("decisionCardSchema", card, "decision card")
    return card


def _source_plan_identity(
    brief: Any, destination: str, files: Mapping[str, bytes]
) -> dict[str, Any]:
    return {
        "brief": brief,
        "destination": destination,
        "files": [
            {"path": path, "sha256": _sha256(data)}
            for path, data in sorted(files.items())
        ],
    }


def _lifecycle_decision_card(action: str, plan: Mapping[str, Any]) -> dict[str, Any]:
    return decision_card(
        "profile-lifecycle-authorization",
        f"Authorize the exact {action} plan for this Profile root.",
        choices=["approve", "deny"],
        basis={
            "planId": plan.get("plan_id"),
            "basis": plan.get("basis"),
            "effects": plan.get("effects"),
        },
        required_authority="workspace-profile-operator",
        resume_command="kungfu profile decide <plan.json> --choice approve --authorized-by <actor> --out <answer.json> --json; kungfu profile apply <plan.json> --authorization-file <answer.json> --json",
    )


def _validate_decision_card(card: Mapping[str, Any]) -> None:
    _validate_sdk_value("decisionCardSchema", dict(card), "decision card")
    if card.get("schema") != DECISION_CARD_SCHEMA or card.get("status") != "open":
        raise ProfileSdkError(
            "decision-card-invalid", "answer requires an open decision card"
        )
    identity = {
        "kind": card.get("kind"),
        "question": card.get("question"),
        "choices": card.get("choices"),
        "basis": card.get("basis"),
        "requiredAuthority": card.get("requiredAuthority"),
    }
    if card.get("cardId") != _root(identity):
        raise ProfileSdkError(
            "decision-card-tampered", "decision card no longer matches its identity"
        )


def _validate_decision_answer(
    answer: Mapping[str, Any], card: Mapping[str, Any]
) -> None:
    _validate_decision_card(card)
    _validate_sdk_value("decisionAnswerSchema", dict(answer), "decision answer")
    identity = {
        "cardId": answer.get("cardId"),
        "choice": answer.get("choice"),
        "authorizedBy": answer.get("authorizedBy"),
        "requiredAuthority": answer.get("requiredAuthority"),
        "basis": answer.get("basis"),
    }
    if answer.get("cardId") != card.get("cardId"):
        raise ProfileSdkError(
            "decision-answer-mismatch", "decision answer targets another card"
        )
    if answer.get("requiredAuthority") != card.get("requiredAuthority"):
        raise ProfileSdkError(
            "decision-authority-mismatch", "decision answer changes required authority"
        )
    if answer.get("choice") not in card.get("choices", []):
        raise ProfileSdkError(
            "decision-choice-invalid", "decision answer choice is no longer offered"
        )
    if answer.get("basis") != card.get("basis"):
        raise ProfileSdkError(
            "decision-basis-mismatch", "decision answer changes the card basis"
        )
    if not str(answer.get("authorizedBy") or "").strip():
        raise ProfileSdkError("decision-actor-required", "decision answer has no actor")
    if answer.get("authorizationId") != _root(identity):
        raise ProfileSdkError(
            "decision-answer-tampered", "decision answer no longer matches its identity"
        )


def package_content_root(package_dir: str | Path) -> str:
    root = Path(package_dir).resolve()
    rows = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise ProfileSdkError(
                "member-package-symlink",
                f"KFX member package closure cannot contain symlinks: {relative}",
            )
        if not path.is_file() or any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        data = path.read_bytes()
        rows.append(
            {"path": relative.as_posix(), "sha256": _sha256(data), "size": len(data)}
        )
    rows.sort(key=lambda row: row["path"].encode("utf-8"))
    if not rows:
        raise ProfileSdkError(
            "member-package-empty", f"KFX member package is empty: {root}"
        )
    return _root({"schema": "kungfu.kfx-package-closure/v1", "files": rows})


def _normalize_brief(
    brief: Mapping[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    allowed = {
        "schema",
        "id",
        "title",
        "version",
        "purposes",
        "permissions",
        "identity",
        "evidence",
        "migration",
    }
    if set(brief) - allowed:
        raise ProfileSdkError(
            "brief-field-unknown",
            "brief contains fields not owned by the installed contract",
            fields=sorted(set(brief) - allowed),
        )
    if brief.get("schema") != BRIEF_SCHEMA:
        raise ProfileSdkError("brief-schema-invalid", f"brief must use {BRIEF_SCHEMA}")
    profile_id = str(brief.get("id") or "").strip()
    title = str(brief.get("title") or "").strip()
    version = str(brief.get("version") or "1.0.0").strip()
    if not profile_id or not _TOKEN.fullmatch(profile_id):
        raise ProfileSdkError(
            "profile-id-invalid", "brief.id must be a safe Profile token"
        )
    if not title:
        raise ProfileSdkError("profile-title-required", "brief.title must not be empty")
    cards = []
    checks = [
        (
            "identity",
            "authority",
            "identity-authority",
            ["workspace-owner", "declared-source-owner"],
        ),
        (
            "evidence",
            "strength",
            "evidence-strength",
            ["reported-with-references", "independently-observed"],
        ),
        (
            "migration",
            "mode",
            "migration-mode",
            ["additive", "explicit-destructive-plan"],
        ),
    ]
    for section, field, kind, choices in checks:
        value = brief.get(section)
        selected = value.get(field) if isinstance(value, Mapping) else None
        if selected not in choices:
            cards.append(
                decision_card(
                    kind,
                    f"Choose the Profile {section} {field} boundary.",
                    choices=choices,
                    basis={
                        "profileId": profile_id,
                        "briefSha256": _sha256(_canonical(brief)),
                        "supplied": selected,
                    },
                    required_authority="profile-author",
                    resume_command="update brief.json, then rerun kungfu profile scaffold",
                )
            )
    migration = brief.get("migration")
    if (
        isinstance(migration, Mapping)
        and migration.get("mode") == "explicit-destructive-plan"
    ):
        cards.append(
            decision_card(
                "destructive-migration",
                "A destructive migration requires a separate bounded migration plan.",
                choices=["switch-to-additive", "prepare-separate-migration-plan"],
                basis={"profileId": profile_id, "migration": dict(migration)},
                required_authority="workspace-data-owner",
                resume_command="revise the brief, then rerun kungfu profile scaffold",
            )
        )
    normalized = {
        "schema": BRIEF_SCHEMA,
        "id": profile_id,
        "title": title,
        "version": version,
        "purposes": sorted(
            set(str(v) for v in brief.get("purposes", ["operator-review"]))
        ),
        "permissions": sorted(set(str(v) for v in brief.get("permissions", []))),
        "identity": dict(brief.get("identity") or {}),
        "evidence": dict(brief.get("evidence") or {}),
        "migration": dict(brief.get("migration") or {}),
    }
    if not cards:
        _validate_sdk_value("briefSchema", normalized, "Profile brief")
    return normalized, cards


def _source_files(brief: Mapping[str, Any]) -> dict[str, bytes]:
    slug = str(brief["id"]).replace(".", "-")
    members = [f"{slug}-contract", f"{slug}-actions", f"{slug}-assessment"]
    artifacts: dict[str, Any] = {
        "contracts/world.json": {
            "schema": "kungfu.profile-contract-world/v1",
            "profileId": brief["id"],
            "identityAuthority": brief["identity"]["authority"],
        },
        "contracts/facts.json": {
            "schema": "kungfu.profile-fact-surfaces/v1",
            "surfaces": [],
        },
        "compatibility/v1.json": {
            "schema": "kungfu.profile-compatibility/v1",
            "runtimeContracts": ["kungfu.profile-lifecycle/v1"],
        },
        "claims/claims.json": {
            "schema": "kungfu.profile-claims/v1",
            "claims": [],
            "evidenceStrength": brief["evidence"]["strength"],
        },
        "assessments/policies.json": {
            "schema": "kungfu.profile-assessment-policies/v1",
            "policies": [],
        },
        "actions/registry.json": {"schema": ACTION_REGISTRY_SCHEMA, "actions": []},
        "views/registry.json": {"schema": "kungfu.profile-views/v1", "views": []},
        "migrations/registry.json": {
            "schema": "kungfu.profile-migrations/v1",
            "mode": brief["migration"]["mode"],
            "migrations": [],
        },
        "permissions.json": {
            "schema": "kungfu.profile-permissions/v1",
            "permissions": brief["permissions"],
        },
        "qualification/profile.json": {
            "schema": "kungfu.profile-qualification/v1",
            "checks": ["content-closure", "runtime-contract"],
        },
    }
    encoded = {path: _pretty(value) for path, value in artifacts.items()}

    def ref(path):
        return {"path": path, "sha256": _sha256(encoded[path])}

    profile = {
        "schema": "kungfu.profile-suite/v1",
        "id": brief["id"],
        "title": brief["title"],
        "version": brief["version"],
        "members": {"required": members, "optional": []},
        "kfd1": {
            "contractWorld": ref("contracts/world.json"),
            "factSurfaces": [ref("contracts/facts.json")],
            "reducers": [],
            "compatibility": ref("compatibility/v1.json"),
        },
        "kfd2": {
            "claims": [ref("claims/claims.json")],
            "purposes": brief["purposes"],
            "policies": [ref("assessments/policies.json")],
        },
        "actions": {"registry": ref("actions/registry.json")},
        "views": {"registry": ref("views/registry.json")},
        "migrations": {"registry": ref("migrations/registry.json")},
        "permissions": {"registry": ref("permissions.json")},
        "qualification": {"profile": ref("qualification/profile.json")},
    }
    files = {
        "package.json": _pretty(
            {
                "name": f"@kungfu-profile/{slug}",
                "version": brief["version"],
                "private": True,
                "kungfuConfig": {
                    "key": brief["id"],
                    "suite": {
                        "title": brief["title"],
                        "members": members,
                        "profile": "profile.json",
                    },
                },
            }
        ),
        "profile.json": _pretty(profile),
        **encoded,
    }
    for member in members:
        files[f"members/{member}/package.json"] = _pretty(
            {
                "name": f"@kungfu-profile/{member}",
                "version": brief["version"],
                "private": True,
                "kungfuConfig": {"key": member},
            }
        )
        files[f"members/{member}/README.md"] = (
            f"# {member}\n\nDeclarative KFX Profile member.\n".encode()
        )
    return files


def _package_dirs(suite_dir: Path) -> list[Path]:
    roots = [suite_dir, suite_dir / "members", suite_dir.parent]
    result = []
    seen = set()
    for root in roots:
        if not root.is_dir():
            continue
        for candidate in [root, *[p for p in root.iterdir() if p.is_dir()]]:
            resolved = candidate.resolve()
            if resolved not in seen and (resolved / "package.json").is_file():
                seen.add(resolved)
                result.append(resolved)
    return result


def _read_ref_json(
    inspection: Mapping[str, Any], ref: Mapping[str, Any]
) -> dict[str, Any]:
    root = Path(str(inspection["profile_path"])).parent
    path = _confined(root, str(ref["path"]))
    return json.loads(path.read_text(encoding="utf-8"))


def _validate_action_registry(
    registry: Mapping[str, Any], profile: Mapping[str, Any]
) -> None:
    _validate_sdk_value("actionRegistrySchema", dict(registry), "action registry")
    ids = set()
    members = set(profile["members"]["required"] + profile["members"]["optional"])
    for row in registry["actions"]:
        required = {
            "id",
            "title",
            "runner",
            "operation",
            "authorityClass",
            "requiredCapabilities",
            "effects",
        }
        if not isinstance(row, Mapping) or set(row) != required:
            raise ProfileSdkError(
                "action-declaration-invalid",
                "action declaration has missing or extra fields",
            )
        if row["id"] in ids or not _TOKEN.fullmatch(str(row["id"])):
            raise ProfileSdkError(
                "action-id-invalid", "action ids must be unique safe tokens"
            )
        ids.add(row["id"])
        if row["runner"] not in {"profile-lifecycle", "kfx-member"}:
            raise ProfileSdkError(
                "action-runner-invalid", "action runner is not confined"
            )
        if row["runner"] == "kfx-member" and row["operation"] not in members:
            raise ProfileSdkError(
                "action-member-unknown", "kfx-member action must name a Suite member"
            )
        if row["runner"] == "profile-lifecycle" and row["operation"] not in {
            "qualify",
            "activate",
            "remove",
        }:
            raise ProfileSdkError(
                "action-operation-unsupported",
                "profile-lifecycle action declares an unsupported operation",
            )


def _validate_sdk_value(schema_key: str, value: Any, label: str) -> None:
    try:
        contract_runtime.validate_json_schema(
            value, agent_pack.profile_sdk_contract()[schema_key], label
        )
    except ValueError as error:
        raise ProfileSdkError(
            "profile-sdk-contract-invalid", str(error), artifact=label
        ) from error


def _changes(
    left: Mapping[str, Any], right: Mapping[str, Any], keys: list[str]
) -> list[dict[str, Any]]:
    return [
        {"field": key, "left": left.get(key), "right": right.get(key)}
        for key in keys
        if left.get(key) != right.get(key)
    ]


def _confined(root: Path, relative: str) -> Path:
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise ProfileSdkError(
            "path-escape", f"path escapes Profile source root: {relative}"
        )
    return target


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _pretty(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _root(value: Any) -> str:
    return "sha256:" + _sha256(_canonical(value))
