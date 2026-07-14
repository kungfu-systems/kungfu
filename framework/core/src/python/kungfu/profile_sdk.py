# SPDX-License-Identifier: Apache-2.0

"""Installed, agent-facing authoring layer for KFX Profile Suites.

This module owns no lifecycle state and no Profile schema.  It resolves source
packages, computes content roots, and delegates every lifecycle decision and
mutation to the Core service introduced by ADR-0069.
"""

from __future__ import annotations

import hashlib
import base64
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping

from kungfu import agent as agent_pack
from kungfu import runtime_broker
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
SOURCE_BUNDLE_SCHEMA = "kungfu.profile-source-bundle/v1"
SOURCE_IMPORT_PLAN_SCHEMA = "kungfu.profile-source-import-plan/v1"
COLLABORATION_SCHEMA = "kungfu.profile-collaboration/v1"
INTENT_PLAN_SCHEMA = "kungfu.profile-intent-plan/v1"
INTENT_RECEIPT_SCHEMA = "kungfu.profile-intent-receipt/v1"
KFD3_QUALIFICATION_RECEIPT_SCHEMA = "kungfu.profile-kfd3-qualification-receipt/v1"
KFD3_WITNESS_SCHEMA = "kungfu.profile-kfd3-witness/v1"
KFD3_QUALIFICATION_PLAN_SCHEMA = "kungfu.profile-kfd3-qualification-plan/v1"
KFD3_RELEASE_MANIFEST_SCHEMA = "kungfu.system-profile-kfd3-manifest/v1"

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
            "contractWorld": sdk_contract["contractWorldSchema"],
            "factSurfaces": sdk_contract["factSurfacesSchema"],
            "claims": sdk_contract["claimsSchema"],
            "assessmentPolicies": sdk_contract["assessmentPoliciesSchema"],
            "views": sdk_contract["viewsSchema"],
            "collaboration": sdk_contract["collaborationSchema"],
            "kfd3QualificationReceipt": sdk_contract["kfd3QualificationReceiptSchema"],
            "kfd3Witness": sdk_contract["kfd3WitnessSchema"],
            "sourceBundle": sdk_contract["sourceBundleSchema"],
        },
        "sourcePlanSchema": SOURCE_PLAN_SCHEMA,
        "actionRegistrySchema": ACTION_REGISTRY_SCHEMA,
        "lifecycleAuthority": storage_service.profile_lifecycle("", "contract"),
        "operations": [
            "capabilities",
            "examples",
            "discover",
            "scaffold",
            "validate",
            "qualify",
            "collaboration",
            "application",
            "kfd3-status",
            "kfd3-plan",
            "kfd3-authorize",
            "kfd3-qualify",
            "kfd3-verify",
            "intent-inspect",
            "intent-advise",
            "intent-plan",
            "intent-apply",
            "intent-verify",
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
            "member-call",
            "catalog",
            "query-plan",
            "query-run",
            "query-execute",
            "contract-plan",
            "contract-apply",
            "assess-plan",
            "assess-run",
            "assessment-plan",
            "assessment-authorize",
            "manager",
            "authorize-lifecycle",
            "export",
            "import",
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


def discover_source(
    profile_id: str,
    runtime_dir: str | Path = "",
    *,
    search_roots: list[str | Path] | None = None,
) -> dict[str, Any]:
    """Resolve one Profile Suite by semantic id across installed extension roots."""

    roots = [Path(value).expanduser() for value in (search_roots or [])]
    if not search_roots:
        roots.extend(
            Path(value).expanduser()
            for value in os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep)
            if value
        )
        if runtime_dir:
            roots.append(Path(runtime_dir).expanduser().resolve().parent / "extensions")
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "extensions"
            if candidate.is_dir():
                roots.append(candidate)
                break
    matches = []
    seen = set()
    for root in roots:
        resolved_root = root.resolve()
        if resolved_root in seen or not resolved_root.is_dir():
            continue
        seen.add(resolved_root)
        candidates = [resolved_root]
        candidates.extend(path for path in resolved_root.iterdir() if path.is_dir())
        for parent in list(candidates[1:]):
            candidates.extend(path for path in parent.iterdir() if path.is_dir())
        for candidate in candidates:
            manifest_path = candidate / "package.json"
            if not manifest_path.is_file():
                continue
            try:
                manifest = kfx_contract.read_manifest_from_dir(str(candidate))
                suite = (manifest.get("kungfuConfig") or {}).get("suite") or {}
                profile_path = _confined(candidate, str(suite.get("profile") or ""))
                profile = json.loads(profile_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if profile.get("id") == profile_id:
                matches.append(candidate.resolve())
    unique = sorted(set(matches), key=lambda path: str(path).encode("utf-8"))
    if len(unique) != 1:
        raise ProfileSdkError(
            "profile-source-unresolved" if not unique else "profile-source-ambiguous",
            "Profile source must resolve exactly once across extension roots",
            profileId=profile_id,
            searchRoots=[str(path.resolve()) for path in roots],
            matches=[str(path) for path in unique],
            decisionCards=[
                decision_card(
                    "profile-source-selection",
                    "Select one exact Profile Suite source.",
                    choices=["supply-source-path", "repair-extension-roots"],
                    basis={
                        "profileId": profile_id,
                        "matches": [str(path) for path in unique],
                    },
                    required_authority="workspace-profile-operator",
                    resume_command="rerun with one exact Profile source path",
                )
            ],
        )
    resolved = resolve_source(unique[0])
    return {
        "schema": "kungfu.profile-source-discovery/v1",
        "profileId": profile_id,
        "source": str(unique[0]),
        "profileSuiteRoot": validate_source(unique[0], runtime_dir)["inspection"][
            "profile_suite_root"
        ],
        "memberRoots": resolved["memberRoots"],
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


def invoke_member_adapter(
    source: str | Path,
    runtime_dir: str | Path,
    member_id: str,
    operation: str,
    input_value: Any,
    *,
    authorized_action: bool = False,
) -> dict[str, Any]:
    """Invoke one exact-root Profile member through its declared Python adapter.

    Core owns resolution, root binding and the transport envelope.  The member
    owns every domain operation and result schema behind ``invoke``.
    """

    if not _TOKEN.fullmatch(member_id) or not _TOKEN.fullmatch(operation):
        raise ProfileSdkError(
            "member-adapter-request-invalid",
            "member and operation must be safe Profile tokens",
        )
    validated = validate_source(source, runtime_dir)
    resolved = validated["source"]
    profile_suite_root = validated["inspection"]["profile_suite_root"]
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir,
            "get",
            profile_id=resolved["profile"]["id"],
        )
    except (KeyError, ValueError) as error:
        raise ProfileSdkError(
            "profile-not-active",
            "Profile member adapters require an active exact Profile root",
        ) from error
    if (
        not state.get("activated")
        or state.get("profile_suite_root") != profile_suite_root
    ):
        raise ProfileSdkError(
            "profile-not-active",
            "Profile member adapters require an active exact Profile root",
        )
    package_value = (resolved.get("memberPackages") or {}).get(member_id)
    if not package_value:
        raise ProfileSdkError(
            "member-adapter-not-found",
            f"Profile member is not present in this Suite: {member_id}",
        )
    package_dir = Path(str(package_value)).resolve()
    manifest = kfx_contract.read_manifest_from_dir(str(package_dir))
    config = (manifest.get("kungfuConfig") or {}).get("config") or {}
    adapter = config.get("adapter") or {}
    if "python" not in (adapter.get("runtimes") or []):
        raise ProfileSdkError(
            "member-adapter-not-declared",
            f"Profile member has no declared Python adapter: {member_id}",
        )
    entry = str((adapter.get("entry") or {}).get("python") or "")
    if not entry:
        raise ProfileSdkError(
            "member-adapter-not-declared",
            f"Profile member has no Python adapter entry: {member_id}",
        )
    entry_path = _confined(package_dir, entry)
    if not entry_path.is_file():
        raise ProfileSdkError(
            "member-adapter-entry-missing",
            f"Profile member adapter entry is missing: {entry}",
        )
    expected_root = (resolved.get("memberRoots") or {}).get(member_id)
    actual_root = package_content_root(package_dir)
    if expected_root != actual_root:
        raise ProfileSdkError(
            "member-adapter-root-mismatch",
            "Profile member bytes changed after Suite resolution",
            expectedMemberRoot=expected_root,
            actualMemberRoot=actual_root,
        )
    module_name = (
        "kungfu_profile_member_"
        + hashlib.sha256(f"{actual_root}:{entry}".encode("utf-8")).hexdigest()
    )
    spec = importlib.util.spec_from_file_location(module_name, entry_path)
    if spec is None or spec.loader is None:
        raise ProfileSdkError(
            "member-adapter-load-failed", "Profile member adapter cannot be loaded"
        )
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        invoke = getattr(module, "invoke")
        result = invoke(
            operation,
            runtime_dir=str(Path(runtime_dir).expanduser().resolve()),
            input_value=input_value,
            context={
                "profileId": resolved["profile"]["id"],
                "profileSuiteRoot": profile_suite_root,
                "memberId": member_id,
                "memberRoot": actual_root,
                "source": resolved["source"],
                "invocationMode": (
                    "authorized-action" if authorized_action else "projection-read"
                ),
            },
        )
        json.dumps(result)
    except ProfileSdkError:
        raise
    except (
        AttributeError,
        ImportError,
        KeyError,
        OSError,
        RuntimeError,
        SyntaxError,
        TypeError,
        ValueError,
    ) as error:
        raise ProfileSdkError("member-adapter-invoke-failed", str(error)) from error
    return {
        "schema": "kungfu.profile-member-receipt/v1",
        "profileId": resolved["profile"]["id"],
        "profileSuiteRoot": profile_suite_root,
        "memberId": member_id,
        "memberRoot": actual_root,
        "operation": operation,
        "source": resolved["source"],
        "result": result,
    }


def validate_source(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    resolved = resolve_source(source)
    inspection = storage_service.profile_lifecycle(
        runtime_dir,
        "inspect",
        profile_path=resolved["profilePath"],
        member_roots=resolved["memberRoots"],
    )
    collaboration = _collaboration_closure(inspection)
    return {
        "schema": "kungfu.profile-validation/v1",
        "source": resolved,
        "inspection": inspection,
        "collaboration": collaboration,
        "ok": True,
    }


def collaboration(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    """Return the installed, content-bound KFD-3 declaration closure."""

    return validate_source(source, runtime_dir)["collaboration"]


def application(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    include_qualification: bool = True,
) -> dict[str, Any]:
    """Project one declared collaboration closure for generic Human/Agent use."""

    validated = validate_source(source, runtime_dir)
    closure = validated["collaboration"]
    if not closure["declared"]:
        raise ProfileSdkError(
            "collaboration-not-declared",
            "Profile has no collaboration interface to project",
        )
    inspection = validated["inspection"]
    profile = inspection["profile"]
    actions = _read_ref_json(inspection, profile["actions"]["registry"])["actions"]
    views = _read_ref_json(inspection, profile["views"]["registry"])["views"]
    actions_by_id = {row["id"]: row for row in actions}
    views_by_id = {row["id"]: row for row in views}
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile["id"]
        )
    except ValueError as error:
        if not str(error).startswith("Profile not found:"):
            raise
        state = None
    active_exact_root = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == inspection["profile_suite_root"]
    )
    granted = sorted((state or {}).get("granted_permissions", []))
    intents = []
    for intent in closure["intents"]:
        intents.append(
            {
                **intent,
                "action": actions_by_id[intent["actionId"]],
                "inspectView": views_by_id[intent["inspectViewId"]],
                "verifyView": views_by_id[intent["verifyViewId"]],
                "missingCapabilities": sorted(
                    set(intent["requiredCapabilities"]) - set(granted)
                ),
            }
        )
    qualification_status: dict[str, Any] = {
        "qualified": False,
        "status": "untested",
        "current": False,
        "reason": "Profile KFD-3 qualification has not been tested",
        "nextActions": [],
    }
    if include_qualification:
        qualification_status = kfd3_status(source, runtime_dir)
    return {
        "schema": "kungfu.profile-application/v1",
        "profileId": profile["id"],
        "profileSuiteRoot": inspection["profile_suite_root"],
        "collaborationRoot": closure["collaborationRoot"],
        "closureRoot": closure["closureRoot"],
        "source": str(Path(source).resolve()),
        "activeExactRoot": active_exact_root,
        "profileRevision": (state or {}).get("revision"),
        "grantedCapabilities": granted,
        "value": closure["value"],
        "participants": closure["participants"],
        "constraints": closure["constraints"],
        "knownLimits": closure["knownLimits"],
        "intents": intents,
        "presentation": {"mode": "generic"},
        "protocol": closure["protocol"],
        "qualified": qualification_status["qualified"],
        "qualification": qualification_status,
    }


def intent_inspect(
    source: str | Path, runtime_dir: str | Path, intent_id: str
) -> dict[str, Any]:
    projection = application(source, runtime_dir, include_qualification=False)
    intent = next(
        (row for row in projection["intents"] if row["id"] == intent_id), None
    )
    if intent is None:
        raise ProfileSdkError(
            "collaboration-intent-not-found", f"intent not found: {intent_id}"
        )
    return {
        "schema": "kungfu.profile-intent-inspection/v1",
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "source": projection["source"],
        "profileRevision": projection["profileRevision"],
        "activeExactRoot": projection["activeExactRoot"],
        "intent": intent,
        "cut": {
            "kind": "profile-revision",
            "value": projection["profileRevision"],
        },
    }


def intent_advise(
    source: str | Path, runtime_dir: str | Path, intent_id: str
) -> dict[str, Any]:
    inspected = intent_inspect(source, runtime_dir, intent_id)
    intent = inspected["intent"]
    application_value = application(source, runtime_dir, include_qualification=False)
    constraints = [
        row
        for row in application_value["constraints"]
        if "*" in row["appliesTo"] or intent_id in row["appliesTo"]
    ]
    eligible = inspected["activeExactRoot"] and not intent["missingCapabilities"]
    return {
        "schema": "kungfu.profile-intent-advice/v1",
        "profileId": inspected["profileId"],
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
        "source": inspected["source"],
        "intentId": intent_id,
        "eligible": eligible,
        "recommendation": "preview" if eligible else "resolve-preconditions",
        "constraints": constraints,
        "knownLimits": application_value["knownLimits"],
        "missingCapabilities": intent["missingCapabilities"],
        "preconditions": {
            "activeExactRoot": inspected["activeExactRoot"],
            "profileRevision": inspected["profileRevision"],
        },
    }


def intent_plan(
    source: str | Path,
    runtime_dir: str | Path,
    intent_id: str,
    input_value: Any,
) -> dict[str, Any]:
    advice = intent_advise(source, runtime_dir, intent_id)
    if not advice["eligible"]:
        raise ProfileSdkError(
            "intent-precondition-failed",
            "intent cannot be previewed until its active-root and capability preconditions hold",
            advice=advice,
        )
    inspected = intent_inspect(source, runtime_dir, intent_id)
    action_plan = plan_action(
        source, runtime_dir, inspected["intent"]["actionId"], input_value
    )
    identity = {
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
        "intentId": intent_id,
        "actionPlanId": action_plan["planId"],
        "input": input_value,
    }
    return {
        "schema": INTENT_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "source": inspected["source"],
        "actionPlan": action_plan,
        "decisionCard": action_plan.get("decisionCard"),
        "protocolStage": "preview",
    }


def intent_apply(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if plan.get("schema") != INTENT_PLAN_SCHEMA:
        raise ProfileSdkError(
            "intent-plan-invalid", "intent apply requires an intent plan"
        )
    refreshed = intent_plan(
        str(plan.get("source") or ""),
        runtime_dir,
        str(plan.get("intentId") or ""),
        plan.get("input"),
    )
    if refreshed["planId"] != plan.get("planId"):
        raise ProfileSdkError("intent-plan-stale", "intent plan changed after preview")
    action_receipt = authorized_action_invoke(
        runtime_dir, plan.get("actionPlan") or {}, answer
    )
    identity = {
        "planId": plan["planId"],
        "actionPlanId": plan["actionPlanId"],
        "profileSuiteRoot": plan["profileSuiteRoot"],
        "collaborationRoot": plan["collaborationRoot"],
        "closureRoot": plan["closureRoot"],
        "intentId": plan["intentId"],
        "actionReceipt": action_receipt,
    }
    return {
        "schema": INTENT_RECEIPT_SCHEMA,
        "receiptId": _root(identity),
        **identity,
        "source": plan["source"],
        "protocolStage": "receipt",
        "executionReceiptVerified": action_receipt["verified"],
        "verified": False,
    }


def intent_verify(
    source: str | Path, runtime_dir: str | Path, receipt: Mapping[str, Any]
) -> dict[str, Any]:
    if receipt.get("schema") != INTENT_RECEIPT_SCHEMA:
        raise ProfileSdkError(
            "intent-receipt-invalid", "verify requires an intent receipt"
        )
    inspected = intent_inspect(source, runtime_dir, str(receipt.get("intentId") or ""))
    current = {
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
    }
    expected = {key: receipt.get(key) for key in current}
    if current != expected:
        raise ProfileSdkError(
            "intent-receipt-stale",
            "Profile or collaboration closure changed after execution",
            expected=expected,
            actual=current,
        )
    action_receipt = receipt.get("actionReceipt") or {}
    verified = bool(
        receipt.get("executionReceiptVerified")
        and action_receipt.get("verified")
        and action_receipt.get("planId") == receipt.get("actionPlanId")
    )
    if not verified:
        raise ProfileSdkError(
            "intent-execution-unverified", "underlying action receipt is not verified"
        )
    return {
        "schema": "kungfu.profile-intent-verification/v1",
        "receiptId": receipt["receiptId"],
        **current,
        "intentId": receipt["intentId"],
        "verifyView": inspected["intent"]["verifyView"],
        "protocolStage": "verify",
        "verified": True,
        "evidenceScope": "profile-root/collaboration-root/execution-receipt/declared-verify-view",
        "knownLimit": "declared verify view is bound but domain outcome truth remains evidence-dependent",
    }


def authorize_current_intent(
    runtime_dir: str | Path,
    source: str | Path,
    intent_id: str,
    input_value: Any,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    plan = intent_plan(source, runtime_dir, intent_id, input_value)
    if plan["planId"] != expected_plan_id:
        raise ProfileSdkError(
            "intent-plan-stale",
            "intent plan changed; review a fresh preview",
            expectedPlanId=expected_plan_id,
            actualPlanId=plan["planId"],
        )
    answer = answer_decision(plan["decisionCard"], choice, authorized_by)
    receipt = intent_apply(runtime_dir, plan, answer)
    return {**receipt, "verification": intent_verify(source, runtime_dir, receipt)}


def _agent_interface_authority() -> dict[str, Any]:
    """Audit the installed KFD-3 authority rather than trusting Profile prose."""

    from kungfu.agent.kfd3 import registry, registry_digest, verify_agent_interface
    from kungfu.cli.commands.agent import agent

    verification = verify_agent_interface(agent)
    application_api = next(
        (
            row
            for row in registry().get("apis", [])
            if row.get("id") == "kungfu.profile.application"
        ),
        None,
    )
    if not verification["ok"] or application_api is None:
        raise ProfileSdkError(
            "kfd3-authority-audit-failed",
            "installed collaboration-interface authority is not closed",
            agentVerification=verification,
        )
    return {
        "standard": "KFD-3",
        "registryId": verification["registry"]["registryId"],
        "registryRoot": "sha256:" + registry_digest(),
        "auditRoot": _root(verification),
        "applicationApi": {
            "id": application_api["id"],
            "surface": application_api["surface"],
            "name": application_api["name"],
            "aliases": application_api.get("aliases", []),
        },
    }


def _profile_facet_audit(resolved: Mapping[str, Any]) -> dict[str, Any]:
    """Reject executable/custom surfaces that can bypass the shared service."""

    package_dirs = {
        "suite": Path(str(resolved["source"])),
        **{
            str(key): Path(str(path))
            for key, path in (resolved.get("memberPackages") or {}).items()
        },
    }
    custom_views = []
    failures = []
    for key, package_dir in sorted(package_dirs.items()):
        manifest = kfx_contract.read_manifest_from_dir(str(package_dir))
        config = (manifest.get("kungfuConfig") or {}).get("config") or {}
        view = config.get("view")
        if view is not None:
            capabilities = sorted(view.get("capabilities") or [])
            runtime = view.get("runtime") or "node-integrated"
            entry = str(view.get("entry") or "dist/view/index.js")
            entry_path = _confined(package_dir, entry)
            reasons = []
            if runtime != "sandboxed-ipc":
                reasons.append("custom Profile views must use sandboxed-ipc")
            if capabilities:
                reasons.append(
                    "custom Profile views may not receive capability handles"
                )
            if view.get("system"):
                reasons.append("custom Profile views may not claim system authority")
            if not entry_path.is_file():
                reasons.append("custom Profile view bundle is missing")
            row = {
                "packageKey": key,
                "runtime": runtime,
                "capabilities": capabilities,
                "entry": entry,
                "bundleRoot": (
                    "sha256:" + _sha256(entry_path.read_bytes())
                    if entry_path.is_file()
                    else None
                ),
                "passed": not reasons,
            }
            custom_views.append(row)
            if reasons:
                failures.append(
                    {"packageKey": key, "facet": "view", "reasons": reasons}
                )
        for facet in ("adapter", "service", "wasm"):
            if config.get(facet) is not None:
                failures.append(
                    {
                        "packageKey": key,
                        "facet": facet,
                        "reasons": [
                            "executable Profile member facets are not yet confined to the shared intent runtime"
                        ],
                    }
                )
    if failures:
        raise ProfileSdkError(
            "kfd3-no-bypass-failed",
            "Profile exposes a custom surface outside the qualified application service",
            failures=failures,
        )
    return {
        "passed": True,
        "policy": "generic-renderer-or-capability-free-sandboxed-view/v1",
        "customViews": custom_views,
        "executableFacetCount": 0,
    }


def _shared_api_release_audit(
    projection: Mapping[str, Any], resolved: Mapping[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Prove first-party GUI/Agent parity through the installed API authority."""

    from kungfu.agent.kfd3 import registry

    apis = {row.get("id"): row for row in registry().get("apis", [])}
    probes = []
    failures = []
    for intent in projection["intents"]:
        protocol = intent.get("protocol") or {}
        api_id = protocol.get("apiId") if protocol.get("mode") == "shared-api" else None
        api = apis.get(api_id)
        projections = set((api or {}).get("projections") or [])
        gui_member = str(protocol.get("guiMember") or "")
        gui_method = str(protocol.get("guiMethod") or "")
        gui_package = Path(
            str((resolved.get("memberPackages") or {}).get(gui_member, ""))
        )
        gui_manifest = (
            kfx_contract.read_manifest_from_dir(str(gui_package))
            if gui_package.is_dir()
            else {}
        )
        view = ((gui_manifest.get("kungfuConfig") or {}).get("config") or {}).get(
            "view"
        ) or {}
        bundle = gui_package / str(view.get("entry") or "dist/view/index.js")
        source_view = gui_package / "src" / "view" / "index.tsx"
        projection_path = bundle if bundle.is_file() else source_view
        projection_kind = "built-view-bundle" if bundle.is_file() else "source-view"
        projection_data = (
            projection_path.read_bytes() if projection_path.is_file() else b""
        )
        gui_bound = bool(
            projection_data
            and re.search(
                rb"\." + re.escape(gui_method.encode("utf-8")) + rb"\s*\(",
                projection_data,
            )
        )
        matched = bool(
            api
            and api.get("surface") == "cli-api-gui"
            and "work-dashboard-gui" in projections
            and "provider-skill" in projections
            and gui_bound
        )
        if not matched:
            failures.append(
                {
                    "intentId": intent["id"],
                    "apiId": api_id,
                    "guiMember": gui_member,
                    "guiMethod": gui_method,
                    "reason": "shared API lacks a bound GUI method or matching Agent projection",
                }
            )
            continue
        probes.append(
            {
                "intentId": intent["id"],
                "apiId": api_id,
                "surface": "cli-api-gui",
                "humanProjection": "work-dashboard-gui",
                "agentProjection": "provider-skill",
                "guiMember": gui_member,
                "guiMethod": gui_method,
                "guiProjectionRoot": "sha256:" + _sha256(projection_data),
                "guiProjectionKind": projection_kind,
                "matched": True,
            }
        )
    if failures:
        raise ProfileSdkError(
            "kfd3-release-api-parity-failed",
            "one or more first-party intents lack the same GUI and Agent API surface",
            failures=failures,
        )
    facets = []
    executable_count = 0
    for key, package_dir in sorted(
        {
            "suite": Path(str(resolved["source"])),
            **{
                str(key): Path(str(path))
                for key, path in (resolved.get("memberPackages") or {}).items()
            },
        }.items()
    ):
        manifest = kfx_contract.read_manifest_from_dir(str(package_dir))
        config = (manifest.get("kungfuConfig") or {}).get("config") or {}
        for facet in ("view", "adapter", "service", "wasm"):
            if config.get(facet) is not None:
                executable_count += 1
                facets.append({"packageKey": key, "facet": facet})
    return (
        {
            "passed": True,
            "policy": "release-owned-shared-api-parity/v1",
            "customViews": facets,
            "executableFacetCount": executable_count,
        },
        probes,
    )


def _earn_kfd3(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    qualification_source: str,
) -> dict[str, Any]:
    """Run the KFD-3 probes and return a receipt for the next lifecycle revision."""

    validated = validate_source(source, runtime_dir)
    resolved = validated["source"]
    closure = validated["collaboration"]
    if not closure["declared"]:
        raise ProfileSdkError(
            "collaboration-not-declared",
            "KFD-3 qualification requires a content-bound collaboration facet",
        )
    projection = application(source, runtime_dir, include_qualification=False)
    if qualification_source == "local" and not projection["activeExactRoot"]:
        raise ProfileSdkError(
            "kfd3-active-root-required",
            "KFD-3 qualification requires the exact Profile root to be active",
        )
    if not projection["intents"]:
        raise ProfileSdkError(
            "kfd3-intent-probe-required",
            "KFD-3 qualification requires at least one material intent probe",
        )
    authority = _agent_interface_authority()
    if qualification_source == "release":
        no_bypass, probes = _shared_api_release_audit(projection, resolved)
    else:
        unsupported = [
            row["id"]
            for row in projection["intents"]
            if row["action"]["runner"] != "profile-lifecycle"
            or row["action"]["operation"] not in {"qualify", "activate", "remove"}
        ]
        if unsupported:
            raise ProfileSdkError(
                "kfd3-action-runtime-unqualified",
                "one or more material intents do not resolve to an executable confined runtime",
                intentIds=unsupported,
            )
        no_bypass = _profile_facet_audit(resolved)
        probes = []
        for intent in projection["intents"]:
            human_plan = intent_plan(source, runtime_dir, intent["id"], {})
            agent_plan = intent_plan(source, runtime_dir, intent["id"], {})
            matched = (
                human_plan["planId"] == agent_plan["planId"]
                and human_plan["actionPlanId"] == agent_plan["actionPlanId"]
                and human_plan["closureRoot"] == agent_plan["closureRoot"]
            )
            if not matched:
                raise ProfileSdkError(
                    "kfd3-dual-client-drift",
                    "Human and Agent probes produced different exact plans",
                    intentId=intent["id"],
                )
            probes.append(
                {
                    "intentId": intent["id"],
                    "humanPlanId": human_plan["planId"],
                    "agentPlanId": agent_plan["planId"],
                    "actionPlanId": human_plan["actionPlanId"],
                    "matched": True,
                }
            )
    inventory = {
        "intentIds": sorted(row["id"] for row in projection["intents"]),
        "actionIds": sorted(row["actionId"] for row in projection["intents"]),
        "viewIds": sorted(
            {
                view_id
                for row in projection["intents"]
                for view_id in (row["inspectViewId"], row["verifyViewId"])
            }
        ),
        "applicationApiId": authority["applicationApi"]["id"],
    }
    identity = {
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "profileRevision": (
            1
            if qualification_source == "release"
            else int(projection["profileRevision"] or 0) + 1
        ),
        "runtimeContract": "kungfu.profile-lifecycle/v1",
        "qualificationSource": qualification_source,
        "authority": authority,
        "surfaceInventory": inventory,
        "noBypass": no_bypass,
        "clientProbes": probes,
        "knownLimits": projection["knownLimits"],
        "evidenceScope": [
            "installed-agent-interface-closure",
            "profile-content-closure",
            "public-surface-inventory",
            (
                "release-owned-shared-api-parity"
                if qualification_source == "release"
                else "custom-view-no-bypass"
            ),
            (
                "gui-agent-api-registry-match"
                if qualification_source == "release"
                else "dual-client-exact-plan"
            ),
        ],
    }
    receipt = {
        "schema": KFD3_QUALIFICATION_RECEIPT_SCHEMA,
        "receiptId": _root(identity),
        **identity,
        "qualified": True,
    }
    witness_identity = {
        "profileId": receipt["profileId"],
        "profileSuiteRoot": receipt["profileSuiteRoot"],
        "collaborationRoot": receipt["collaborationRoot"],
        "closureRoot": receipt["closureRoot"],
        "qualificationReceiptId": receipt["receiptId"],
        "authorityRegistryRoot": authority["registryRoot"],
        "claim": "profile-collaboration-closure-qualified",
    }
    witness = {
        "schema": KFD3_WITNESS_SCHEMA,
        "witnessId": _root(witness_identity),
        **witness_identity,
        "standard": "KFD-3",
        "issuer": "kungfu-profile-runtime",
        "qualified": True,
    }
    _validate_sdk_value("kfd3WitnessSchema", witness, "KFD-3 witness")
    result = {**receipt, "witness": witness}
    _validate_sdk_value(
        "kfd3QualificationReceiptSchema", result, "KFD-3 qualification receipt"
    )
    return result


def build_kfd3_release_manifest(
    sources: list[str | Path], runtime_dir: str | Path
) -> dict[str, Any]:
    """Run factory qualification and emit exact-root release receipts."""

    entries = []
    for source in sources:
        receipt = _earn_kfd3(source, runtime_dir, qualification_source="release")
        entries.append(
            {
                "profileId": receipt["profileId"],
                "profileSuiteRoot": receipt["profileSuiteRoot"],
                "receipt": receipt,
            }
        )
    entries.sort(key=lambda row: (row["profileId"], row["profileSuiteRoot"]))
    identity = {"schema": KFD3_RELEASE_MANIFEST_SCHEMA, "entries": entries}
    return {**identity, "manifestRoot": _root(identity)}


def _release_qualification_receipt(
    profile_id: str, profile_suite_root: str
) -> dict[str, Any] | None:
    paths = []
    explicit = os.environ.get("KF_PROFILE_KFD3_MANIFEST")
    if explicit:
        paths.append(Path(explicit))
    first_party = os.environ.get("KF_FIRST_PARTY_MANIFEST")
    if first_party:
        paths.append(Path(first_party).with_name("profile-kfd3.json"))
    paths.append(Path(sys.executable).resolve().with_name("profile-kfd3.json"))
    seen = set()
    fallback = None
    for path in paths:
        resolved = path.expanduser().resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        try:
            manifest = json.loads(resolved.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("schema") != KFD3_RELEASE_MANIFEST_SCHEMA:
            continue
        identity = {"schema": manifest["schema"], "entries": manifest.get("entries")}
        if manifest.get("manifestRoot") != _root(identity):
            continue
        for entry in manifest.get("entries") or []:
            if entry.get("profileId") != profile_id:
                continue
            receipt = dict(entry.get("receipt") or {})
            if entry.get("profileSuiteRoot") == profile_suite_root:
                return receipt
            fallback = receipt
    return fallback


def _validate_kfd3_receipt_integrity(receipt: Mapping[str, Any]) -> None:
    identity_keys = [
        "profileId",
        "profileSuiteRoot",
        "collaborationRoot",
        "closureRoot",
        "profileRevision",
        "runtimeContract",
        "qualificationSource",
        "authority",
        "surfaceInventory",
        "noBypass",
        "clientProbes",
        "knownLimits",
        "evidenceScope",
    ]
    identity = {key: receipt.get(key) for key in identity_keys}
    if receipt.get("receiptId") != _root(identity):
        raise ProfileSdkError(
            "kfd3-receipt-identity-invalid",
            "KFD-3 receipt id does not bind its qualification evidence",
        )
    witness = receipt.get("witness") or {}
    witness_identity = {
        "profileId": receipt.get("profileId"),
        "profileSuiteRoot": receipt.get("profileSuiteRoot"),
        "collaborationRoot": receipt.get("collaborationRoot"),
        "closureRoot": receipt.get("closureRoot"),
        "qualificationReceiptId": receipt.get("receiptId"),
        "authorityRegistryRoot": (receipt.get("authority") or {}).get("registryRoot"),
        "claim": "profile-collaboration-closure-qualified",
    }
    if witness.get("witnessId") != _root(witness_identity):
        raise ProfileSdkError(
            "kfd3-witness-identity-invalid",
            "KFD-3 witness id does not bind the receipt and authority roots",
        )


def kfd3_status(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    """Return the machine-readable qualification state without running probes."""

    validated = validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    closure = validated["collaboration"]
    profile_id = inspection["profile"]["id"]
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile_id, include_removed=True
        )
    except ValueError as error:
        if not str(error).startswith("Profile not found:"):
            raise
        state = None
    active_exact_root = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == inspection["profile_suite_root"]
    )
    receipt = (state or {}).get("kfd3_qualification") or {}
    if not receipt:
        receipt = (
            _release_qualification_receipt(profile_id, inspection["profile_suite_root"])
            or {}
        )
    base = {
        "schema": "kungfu.profile-kfd3-status/v1",
        "profileId": profile_id,
        "profileSuiteRoot": inspection["profile_suite_root"],
        "qualified": False,
        "current": False,
        "activeExactRoot": active_exact_root,
        "receiptId": receipt.get("receiptId"),
        "witnessId": (receipt.get("witness") or {}).get("witnessId"),
        "qualificationSource": receipt.get("qualificationSource"),
    }
    if not closure["declared"]:
        return {
            **base,
            "status": "failed",
            "reason": closure["reason"],
            "nextActions": [],
        }
    if not active_exact_root:
        return {
            **base,
            "status": "stale" if receipt else "untested",
            "reason": "Profile must be active at this exact root before KFD-3 qualification",
            "nextActions": [{"action": "profile.activate", "requiresApproval": True}],
        }
    if not receipt:
        release_only = bool(closure["intents"]) and all(
            (row.get("protocol") or {}).get("mode") == "shared-api"
            for row in closure["intents"]
        )
        return {
            **base,
            "status": "untested",
            "reason": (
                "No factory KFD-3 release receipt exists for this exact system Profile root"
                if release_only
                else "No KFD-3 qualification receipt exists for this exact Profile root"
            ),
            "nextActions": (
                [{"action": "product.verify-release", "requiresApproval": False}]
                if release_only
                else [
                    {"action": "profile.kfd3.plan", "requiresApproval": False},
                    {"action": "profile.kfd3.qualify", "requiresApproval": True},
                ]
            ),
        }
    try:
        _validate_sdk_value(
            "kfd3QualificationReceiptSchema",
            receipt,
            "stored KFD-3 qualification receipt",
        )
        _validate_kfd3_receipt_integrity(receipt)
    except ProfileSdkError as error:
        return {
            **base,
            "status": "failed",
            "reason": "Stored KFD-3 qualification receipt is invalid",
            "diagnosis": error.diagnosis,
            "nextActions": [{"action": "profile.kfd3.plan", "requiresApproval": False}],
        }
    authority = _agent_interface_authority()
    current = bool(
        receipt.get("profileId") == profile_id
        and receipt.get("profileSuiteRoot") == inspection["profile_suite_root"]
        and receipt.get("collaborationRoot") == closure["collaborationRoot"]
        and receipt.get("closureRoot") == closure["closureRoot"]
        and (receipt.get("authority") or {}).get("registryRoot")
        == authority["registryRoot"]
    )
    if not current:
        return {
            **base,
            "status": "stale",
            "reason": "Profile or KFD-3 Runtime contract changed after qualification",
            "nextActions": [
                {"action": "profile.kfd3.plan", "requiresApproval": False},
                {"action": "profile.kfd3.qualify", "requiresApproval": True},
            ],
        }
    return {
        **base,
        "status": "qualified",
        "qualified": True,
        "current": True,
        "issuer": {
            "type": receipt["qualificationSource"],
            "name": (
                "Kungfu release qualification"
                if receipt["qualificationSource"] == "release"
                else "Kungfu local qualification"
            ),
        },
        "policyVersion": "kfd3-profile-collaboration/v1",
        "runtimeContractRoot": authority["registryRoot"],
        "evidenceScope": receipt["evidenceScope"],
        "nextActions": [{"action": "profile.kfd3.verify", "requiresApproval": False}],
    }


def kfd3_qualification_plan(
    source: str | Path, runtime_dir: str | Path
) -> dict[str, Any]:
    """Describe the exact probes without executing or persisting them."""

    projection = application(source, runtime_dir, include_qualification=False)
    if not projection["activeExactRoot"]:
        raise ProfileSdkError(
            "kfd3-active-root-required",
            "KFD-3 qualification requires the exact Profile root to be active",
        )
    identity = {
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "profileRevision": projection["profileRevision"],
        "runtimeContractRoot": _agent_interface_authority()["registryRoot"],
        "intentIds": sorted(row["id"] for row in projection["intents"]),
        "policyVersion": "kfd3-profile-collaboration/v1",
    }
    plan_id = _root(identity)
    card = decision_card(
        "profile-kfd3-qualification",
        "Run the exact KFD-3 dual-client and no-bypass probes for this Profile root.",
        choices=["approve", "deny"],
        basis={"planId": plan_id, **identity},
        required_authority="workspace-profile-operator",
        resume_command="kungfu profile kfd3-authorize <source> --expected-plan-id <id> --choice approve --authorized-by <actor> --json",
    )
    return {
        "schema": KFD3_QUALIFICATION_PLAN_SCHEMA,
        "planId": plan_id,
        **identity,
        "probes": [
            "profile-content-closure",
            "application-authority",
            "public-surface-inventory",
            "custom-view-no-bypass",
            "dual-client-exact-plan",
        ],
        "sideEffects": ["append Kfd3Qualified lifecycle fact after all probes pass"],
        "requiresAuthorization": True,
        "decisionCard": card,
    }


def qualify_kfd3(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    authorization_id: str = "kfd3-cli-explicit",
    qualification_source: str = "local",
) -> dict[str, Any]:
    """Run probes once and persist the earned receipt in the lifecycle journal."""

    status = kfd3_status(source, runtime_dir)
    if status["qualified"]:
        if status.get("qualificationSource") == "release":
            receipt = _release_qualification_receipt(
                status["profileId"], status["profileSuiteRoot"]
            )
            if receipt:
                return receipt
        else:
            state = storage_service.profile_lifecycle(
                runtime_dir, "get", profile_id=status["profileId"]
            )
            return dict(state["kfd3_qualification"])
    receipt = _earn_kfd3(source, runtime_dir, qualification_source=qualification_source)
    core_plan = lifecycle_plan(
        runtime_dir, "kfd3-qualify", source, qualification=receipt
    )["corePlan"]
    lifecycle_apply(runtime_dir, core_plan, authorization_id)
    return receipt


def authorize_kfd3_qualification(
    source: str | Path,
    runtime_dir: str | Path,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    """Execute one reviewed KFD-3 plan and persist its exact-root receipt."""

    plan = kfd3_qualification_plan(source, runtime_dir)
    if plan["planId"] != expected_plan_id:
        raise ProfileSdkError(
            "kfd3-plan-stale",
            "Profile or Runtime contract changed after KFD-3 planning",
            expectedPlanId=expected_plan_id,
            actualPlanId=plan["planId"],
        )
    answer = answer_decision(plan["decisionCard"], choice, authorized_by)
    if answer["choice"] != "approve":
        raise ProfileSdkError(
            "kfd3-qualification-denied", "KFD-3 qualification was denied"
        )
    return qualify_kfd3(
        source,
        runtime_dir,
        authorization_id=answer["authorizationId"],
        qualification_source="local",
    )


def verify_kfd3(
    source: str | Path, runtime_dir: str | Path, receipt: Mapping[str, Any]
) -> dict[str, Any]:
    """Verify a supplied qualification receipt against the current earned cut."""

    _validate_sdk_value(
        "kfd3QualificationReceiptSchema",
        dict(receipt),
        "KFD-3 qualification receipt",
    )
    status = kfd3_status(source, runtime_dir)
    if not status["qualified"]:
        raise ProfileSdkError(
            "kfd3-qualification-not-current",
            "Profile has no current KFD-3 qualification receipt",
            status=status,
        )
    if status.get("qualificationSource") == "release":
        current = _release_qualification_receipt(
            status["profileId"], status["profileSuiteRoot"]
        )
    else:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=status["profileId"]
        )
        current = dict(state["kfd3_qualification"])
    if not current:
        raise ProfileSdkError(
            "kfd3-qualification-not-current",
            "Profile has no current KFD-3 qualification receipt",
        )
    if dict(receipt) != current:
        raise ProfileSdkError(
            "kfd3-qualification-stale-or-tampered",
            "qualification receipt does not match the current earned Profile cut",
            expectedReceiptId=current["receiptId"],
            actualReceiptId=receipt.get("receiptId"),
            expectedWitnessId=current["witness"]["witnessId"],
            actualWitnessId=(receipt.get("witness") or {}).get("witnessId"),
        )
    return {
        "schema": "kungfu.profile-kfd3-verification/v1",
        "profileId": current["profileId"],
        "profileSuiteRoot": current["profileSuiteRoot"],
        "receiptId": current["receiptId"],
        "witnessId": current["witness"]["witnessId"],
        "verified": True,
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
        "lifecycleMutation": False,
    }


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
    rows: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise ProfileSdkError(
                "member-package-symlink",
                f"KFX member package closure cannot contain symlinks: {relative}",
            )
        if not path.is_file():
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
    if brief.get("collaboration") is not None:
        artifacts["collaboration/interface.json"] = brief["collaboration"]
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
    if brief.get("collaboration") is not None:
        profile["kfd3"] = {"collaboration": ref("collaboration/interface.json")}
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
            try:
                is_package = (resolved / "package.json").is_file()
            except OSError:
                is_package = False
            if resolved not in seen and is_package:
                seen.add(resolved)
                result.append(resolved)
    return result


def _read_ref_json(
    inspection: Mapping[str, Any], ref: Mapping[str, Any]
) -> dict[str, Any]:
    root = Path(str(inspection["profile_path"])).parent
    path = _confined(root, str(ref["path"]))
    return json.loads(path.read_text(encoding="utf-8"))


def _collaboration_closure(inspection: Mapping[str, Any]) -> dict[str, Any]:
    profile = inspection["profile"]
    declaration = profile.get("kfd3")
    if not isinstance(declaration, Mapping):
        return {
            "schema": "kungfu.profile-collaboration-closure/v1",
            "profileId": profile["id"],
            "profileSuiteRoot": inspection["profile_suite_root"],
            "status": "not-declared",
            "declared": False,
            "qualified": False,
            "reason": "Profile has no content-bound kfd3.collaboration facet",
        }

    ref = declaration.get("collaboration")
    if not isinstance(ref, Mapping):
        raise ProfileSdkError(
            "collaboration-ref-invalid",
            "Profile kfd3 declaration has no collaboration content reference",
        )
    artifact = _read_ref_json(inspection, ref)
    _validate_sdk_value("collaborationSchema", artifact, "collaboration interface")
    if artifact["profileId"] != profile["id"]:
        raise ProfileSdkError(
            "collaboration-profile-mismatch",
            "collaboration interface profileId does not match the Profile",
            expected=profile["id"],
            actual=artifact["profileId"],
        )

    participants = artifact["participants"]
    participant_ids = [row["id"] for row in participants]
    if len(participant_ids) != len(set(participant_ids)):
        raise ProfileSdkError(
            "collaboration-participant-duplicate",
            "collaboration participant ids must be unique",
        )
    participant_kinds = {row["kind"] for row in participants}
    if not {"human", "agent"}.issubset(participant_kinds):
        raise ProfileSdkError(
            "collaboration-dual-first-required",
            "KFD-3 Profile qualification requires human and agent participants",
            participantKinds=sorted(participant_kinds),
        )
    benefit_kinds = {
        row["participantKind"] for row in artifact["value"]["participantBenefits"]
    }
    if not {"human", "agent"}.issubset(benefit_kinds):
        raise ProfileSdkError(
            "collaboration-value-incomplete",
            "Profile value must be explicit for human and agent participants",
            participantKinds=sorted(benefit_kinds),
        )

    action_registry = _read_ref_json(inspection, profile["actions"]["registry"])
    _validate_action_registry(action_registry, profile)
    actions = {row["id"]: row for row in action_registry["actions"]}
    view_registry = _read_ref_json(inspection, profile["views"]["registry"])
    _validate_sdk_value("viewsSchema", view_registry, "view registry")
    view_ids = [row["id"] for row in view_registry["views"]]
    if len(view_ids) != len(set(view_ids)):
        raise ProfileSdkError(
            "collaboration-view-duplicate", "Profile view ids must be unique"
        )
    views = set(view_ids)

    intents = artifact["intents"]
    intent_ids = [row["id"] for row in intents]
    action_ids = [row["actionId"] for row in intents]
    if len(intent_ids) != len(set(intent_ids)) or len(action_ids) != len(
        set(action_ids)
    ):
        raise ProfileSdkError(
            "collaboration-intent-duplicate",
            "intent ids and action bindings must be unique",
        )
    if set(action_ids) != set(actions):
        raise ProfileSdkError(
            "collaboration-action-closure",
            "every public Profile action must have exactly one collaboration intent",
            declared=sorted(action_ids),
            actions=sorted(actions),
        )

    authority_classes = {
        authority
        for participant in participants
        for authority in participant["authorityClasses"]
    }
    for intent in intents:
        action = actions[intent["actionId"]]
        missing_views = sorted(
            {intent["inspectViewId"], intent["verifyViewId"]} - views
        )
        if missing_views:
            raise ProfileSdkError(
                "collaboration-view-unresolved",
                "intent inspect and verify views must resolve in the Profile",
                intentId=intent["id"],
                missingViews=missing_views,
            )
        if intent["requiredAuthority"] != action["authorityClass"]:
            raise ProfileSdkError(
                "collaboration-authority-drift",
                "intent and action authority classes must match",
                intentId=intent["id"],
            )
        if intent["requiredAuthority"] not in authority_classes:
            raise ProfileSdkError(
                "collaboration-authority-unowned",
                "an intent authority class is not owned by any declared participant",
                intentId=intent["id"],
            )
        if sorted(intent["requiredCapabilities"]) != sorted(
            action["requiredCapabilities"]
        ):
            raise ProfileSdkError(
                "collaboration-capability-drift",
                "intent and action required capabilities must match",
                intentId=intent["id"],
            )

    known_targets = set(intent_ids)
    for constraint in artifact["constraints"]:
        unknown = sorted(
            target
            for target in constraint["appliesTo"]
            if target != "*" and target not in known_targets
        )
        if unknown:
            raise ProfileSdkError(
                "collaboration-constraint-unresolved",
                "constraint appliesTo contains an unknown intent",
                constraintId=constraint["id"],
                unknownIntents=unknown,
            )

    home_view = artifact["presentation"]["homeViewId"]
    if home_view is not None and home_view not in views:
        raise ProfileSdkError(
            "collaboration-home-view-unresolved",
            "generic presentation homeViewId must resolve in the Profile",
            homeViewId=home_view,
        )

    closure = {
        "profileSuiteRoot": inspection["profile_suite_root"],
        "collaborationRoot": f"sha256:{ref['sha256']}",
        "participantIds": sorted(participant_ids),
        "intentIds": sorted(intent_ids),
        "actionIds": sorted(actions),
        "viewIds": sorted(views),
        "protocol": [
            "inspect",
            "advise",
            "preview",
            "authorize",
            "execute",
            "receipt",
            "verify",
        ],
    }
    return {
        "schema": "kungfu.profile-collaboration-closure/v1",
        "profileId": profile["id"],
        **closure,
        "closureRoot": _root(closure),
        "status": "declared-closed",
        "declared": True,
        "qualified": False,
        "qualificationStatus": "not-qualified",
        "genericRenderer": artifact["presentation"]["mode"] == "generic",
        "value": artifact["value"],
        "constraints": artifact["constraints"],
        "knownLimits": artifact["knownLimits"],
        "participants": participants,
        "intents": intents,
    }


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
        allowed = required | {"runtimeOperation"}
        if (
            not isinstance(row, Mapping)
            or not required.issubset(row)
            or not set(row).issubset(allowed)
        ):
            raise ProfileSdkError(
                "action-declaration-invalid",
                "action declaration has missing or extra fields",
            )
        if row["id"] in ids or not _TOKEN.fullmatch(str(row["id"])):
            raise ProfileSdkError(
                "action-id-invalid", "action ids must be unique safe tokens"
            )
        ids.add(row["id"])
        if row.get("runtimeOperation"):
            try:
                runtime_broker.operation_definition(str(row["runtimeOperation"]))
            except (KeyError, ValueError) as error:
                raise ProfileSdkError(
                    "action-runtime-operation-invalid",
                    "action runtime operation is not registered by the runtime contract",
                ) from error
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


def _portable_source_paths(root: Path) -> list[Path]:
    paths = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise ProfileSdkError(
                "source-bundle-symlink-rejected",
                "Profile source bundles do not follow symlinks",
                path=relative.as_posix(),
            )
        if path.is_file():
            paths.append(path)
    return sorted(paths, key=lambda path: path.relative_to(root).as_posix())


def _validate_source_bundle(bundle: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(bundle)
    _validate_sdk_value("sourceBundleSchema", normalized, "Profile source bundle")
    expected = str(normalized.get("bundleRoot") or "")
    body = dict(normalized)
    body.pop("bundleRoot", None)
    if expected != _root(body):
        raise ProfileSdkError(
            "source-bundle-root-mismatch", "Profile source bundle root mismatch"
        )
    paths = []
    for entry in normalized["entries"]:
        relative = str(entry["path"])
        candidate = Path(relative)
        if (
            candidate.is_absolute()
            or not relative
            or ".." in candidate.parts
            or any(part in _IGNORED_PARTS for part in candidate.parts)
        ):
            raise ProfileSdkError(
                "source-bundle-path-invalid",
                "Profile source bundle contains an unsafe path",
                path=relative,
            )
        paths.append(relative)
        if normalized["mode"] == "full":
            try:
                data = base64.b64decode(entry["contentBase64"], validate=True)
            except (ValueError, TypeError) as error:
                raise ProfileSdkError(
                    "source-bundle-content-invalid",
                    "Profile source bundle content is not canonical base64",
                    path=relative,
                ) from error
            if len(data) != entry["size"] or _sha256(data) != entry["sha256"]:
                raise ProfileSdkError(
                    "source-bundle-content-mismatch",
                    "Profile source bundle content does not match its inventory",
                    path=relative,
                )
    if paths != sorted(set(paths)):
        raise ProfileSdkError(
            "source-bundle-inventory-invalid",
            "Profile source bundle paths must be unique and sorted",
        )
    return normalized


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
