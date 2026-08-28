# SPDX-License-Identifier: Apache-2.0

"""Profile action planning, authorization, and semantic-diff owner."""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any, Mapping

_facade = importlib.import_module("kungfu.profile_sdk")

runtime_broker = _facade.runtime_broker
storage_service = _facade.storage_service
ProfileSdkError = _facade.ProfileSdkError
ACTION_PLAN_SCHEMA = _facade.ACTION_PLAN_SCHEMA
ACTION_RECEIPT_SCHEMA = _facade.ACTION_RECEIPT_SCHEMA
BRIEF_SCHEMA = _facade.BRIEF_SCHEMA
COLLABORATION_SCHEMA = _facade.COLLABORATION_SCHEMA
DECISION_CARD_SCHEMA = _facade.DECISION_CARD_SCHEMA
_TOKEN = _facade._TOKEN
_canonical = _facade._canonical
_changes = _facade._changes
_read_ref_json = _facade._read_ref_json
_root = _facade._root
_sha256 = _facade._sha256
_validate_action_registry = _facade._validate_action_registry
_validate_sdk_value = _facade._validate_sdk_value
collaboration = _facade.collaboration
decision_card = _facade.decision_card
lifecycle_plan = _facade.lifecycle_plan
lifecycle_apply = _facade.lifecycle_apply
resolve_source = _facade.resolve_source
validate_source = _facade.validate_source


def invoke_member_adapter(*args: Any, **kwargs: Any):
    return _facade.invoke_member_adapter(*args, **kwargs)


def semantic_diff(left: str | Path, right: str | Path) -> dict[str, Any]:
    a = resolve_source(left)
    b = resolve_source(right)
    pa, pb = a["profile"], b["profile"]
    categories = {
        "display": _changes(pa, pb, ["title", "views"]),
        "content": _changes(pa, pb, ["kfd1", "members"]),
        "permission": _changes(pa, pb, ["permissions"]),
        "authority": _changes(pa, pb, ["actions", "kfd3"]),
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


def _action_runtime_plan(
    runtime_dir: str | Path, action: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    operation_id = str(action.get("runtimeOperation") or "")
    try:
        operation = runtime_broker.operation_definition(operation_id)
    except (KeyError, ValueError) as error:
        raise ProfileSdkError(
            "action-runtime-operation-invalid", str(error), operationId=operation_id
        ) from error
    evidence = None
    minimum_cut = None
    if operation["operationClass"] != "storage-only":
        evidence_path = runtime_broker.native_readiness_evidence_path(runtime_dir)
        try:
            evidence = runtime_broker.discover_native_readiness_evidence(runtime_dir)
        except ValueError as error:
            raise ProfileSdkError(
                "runtime-evidence-invalid",
                str(error),
                evidencePath=str(evidence_path),
            ) from error
        if evidence is None:
            raise ProfileSdkError(
                "runtime-evidence-unavailable",
                "live Profile action requires native durability evidence coordinates",
                evidencePath=str(evidence_path),
                operationId=operation_id,
            )
        minimum_cut = evidence["minimumCut"]
        if (
            "runtime.live-projection" in operation["requiredCapabilities"]
            and evidence.get("projection") is None
        ):
            raise ProfileSdkError(
                "runtime-evidence-incomplete",
                "live projection action requires projection evidence coordinates",
                evidencePath=str(evidence_path),
                operationId=operation_id,
            )
    runtime_plan = runtime_broker.plan_operation(
        operation_id,
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="kfx",
        minimum_cut=minimum_cut,
    )
    return runtime_plan, evidence


def plan_action(
    source: str | Path, runtime_dir: str | Path, action_id: str, input_value: Any
) -> dict[str, Any]:
    catalog = action_catalog(source, runtime_dir)
    collaboration_value = collaboration(source, runtime_dir)
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
    }
    if collaboration_value["declared"]:
        intent = next(
            (
                row
                for row in collaboration_value["intents"]
                if row["actionId"] == action_id
            ),
            None,
        )
        if intent is None:
            raise ProfileSdkError(
                "collaboration-action-closure",
                "declared collaboration has no intent for this action",
            )
        identity.update(
            {
                "collaborationRoot": collaboration_value["collaborationRoot"],
                "closureRoot": collaboration_value["closureRoot"],
                "intentId": intent["id"],
            }
        )
    missing_capabilities = sorted(
        set(action["requiredCapabilities"]) - set(state.get("granted_permissions", []))
    )
    if missing_capabilities:
        raise ProfileSdkError(
            "action-capability-not-granted",
            "Action requires Profile capabilities that are not active",
            missingCapabilities=missing_capabilities,
        )
    runtime_plan, runtime_evidence = _action_runtime_plan(runtime_dir, action)
    identity["runtimeOperation"] = runtime_plan["operation"]["id"]
    if runtime_evidence is not None:
        identity.update(
            {
                "runtimePlan": runtime_plan,
                "runtimeEvidence": runtime_evidence,
            }
        )
    plan = {
        "schema": ACTION_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "source": catalog["source"],
        "runtimePlan": runtime_plan,
        "runtimeEvidence": runtime_evidence,
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
    if refreshed.get("runtimePlan") != plan.get("runtimePlan") or refreshed.get(
        "runtimeEvidence"
    ) != plan.get("runtimeEvidence"):
        raise ProfileSdkError(
            "action-plan-stale", "runtime execution material changed after planning"
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
    if action.get("runner") == "kfx-member":

        def invoke_kfx(_activation: Mapping[str, Any]) -> dict[str, Any]:
            receipt = invoke_member_adapter(
                str(plan.get("source") or ""),
                runtime_dir,
                str(action.get("operation") or ""),
                str(action.get("id") or ""),
                plan.get("input"),
                authorized_action=True,
            )
            result = receipt.get("result")
            if not isinstance(result, Mapping):
                raise ProfileSdkError(
                    "member-adapter-result-invalid",
                    "Profile action member must return an object result",
                )
            return {
                **result,
                "memberReceipt": {
                    key: value for key, value in receipt.items() if key != "result"
                },
            }

        callback = invoke_kfx
    elif action.get("runner") == "profile-lifecycle":
        lifecycle_action = action.get("operation")
        if lifecycle_action not in {"qualify", "activate", "remove"}:
            raise ProfileSdkError(
                "action-operation-unsupported",
                "unsupported lifecycle action operation",
            )
        source_value = plan.get("source")
        lifecycle_source = str(source_value) if source_value is not None else None
        lifecycle_values: dict[str, Any] = {}
        if lifecycle_action == "remove":
            lifecycle_values["profile_id"] = plan["profileId"]
            lifecycle_source = None
        core = lifecycle_plan(
            runtime_dir, lifecycle_action, lifecycle_source, **lifecycle_values
        )["corePlan"]

        def invoke_lifecycle(_activation: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "coreReceipt": lifecycle_apply(
                    runtime_dir, core, authorization_id or "action-policy:none"
                )
            }

        callback = invoke_lifecycle
    else:
        raise ProfileSdkError(
            "action-runner-unsupported", "unsupported Profile action runner"
        )

    evidence = plan.get("runtimeEvidence")
    readiness_authority = None
    runtime_home = str(Path(runtime_dir).expanduser().resolve().parent)
    if isinstance(evidence, Mapping):
        try:
            readiness_authority = runtime_broker.native_readiness_authority(evidence)
        except (TypeError, ValueError) as error:
            raise ProfileSdkError("runtime-evidence-invalid", str(error)) from error
        runtime_home = str(evidence["runtimeHome"])
    broker = runtime_broker.RuntimeCapabilityBroker.for_process(
        runtime_home,
        str(runtime_dir),
        readiness_authority=readiness_authority,
    )
    runtime_plan = plan.get("runtimePlan")
    if not isinstance(runtime_plan, Mapping):
        raise ProfileSdkError(
            "action-runtime-plan-invalid", "Profile action has no runtime plan"
        )
    try:
        runtime_receipt = broker.invoke(runtime_plan, callback)
    except ValueError as error:
        raise ProfileSdkError("action-runtime-plan-invalid", str(error)) from error
    result = runtime_receipt.get("result")
    if not runtime_receipt.get("accepted") or not isinstance(result, Mapping):
        return {
            "schema": ACTION_RECEIPT_SCHEMA,
            "planId": plan["planId"],
            "authorizationId": authorization_id,
            "runtimeReceipt": runtime_receipt,
            "coreReceipt": None,
            "verified": False,
        }
    return {
        "schema": ACTION_RECEIPT_SCHEMA,
        "planId": plan["planId"],
        "authorizationId": authorization_id,
        "runtimeReceipt": runtime_receipt,
        **result,
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
        "collaboration",
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
    collaboration = brief.get("collaboration")
    if collaboration is not None:
        if not isinstance(collaboration, Mapping):
            raise ProfileSdkError(
                "collaboration-brief-invalid",
                "brief.collaboration must be an object when KFD-3 is requested",
            )
        artifact = {
            "schema": COLLABORATION_SCHEMA,
            "profileId": profile_id,
            "value": {
                "summary": collaboration.get("summary"),
                "participantBenefits": collaboration.get("participantBenefits", []),
            },
            "participants": collaboration.get("participants", []),
            "intents": [],
            "constraints": collaboration.get("constraints", []),
            "knownLimits": collaboration.get("knownLimits", []),
            "presentation": {"mode": "generic", "homeViewId": None},
        }
        _validate_sdk_value(
            "collaborationSchema", artifact, "Profile brief collaboration"
        )
        normalized["collaboration"] = artifact
    if not cards:
        _validate_sdk_value("briefSchema", normalized, "Profile brief")
    return normalized, cards
