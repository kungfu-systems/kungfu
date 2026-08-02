# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import os
import time
import urllib.parse
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from kungfu import runtime_upgrade
from kungfu.distribution_update_policy import (
    CHECK_SCHEMA,
    DOWNLOAD_PLAN_SCHEMA,
    ORCHESTRATION_PLAN_SCHEMA,
    ORCHESTRATION_RECEIPT_SCHEMA,
    DistributionUpdateError,
    _artifact,
    _assert_cli_publication,
    _assert_release_target,
    _canonical,
    _content_root,
    _downgrade_refusal,
    _path_safe_id,
    _stable_id,
    _write_object,
    compare_product_versions,
)

release_cut = runtime_upgrade


def check_release(
    manifest: Mapping[str, Any],
    *,
    current_version: str,
    source: Mapping[str, Any],
    current_release_cut_root: str | None = None,
    cut_transition: Mapping[str, Any] | None = None,
    require_publication: bool = True,
    expected_platform: str | None = None,
    expected_architecture: str | None = None,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(
        value,
        expected_platform=expected_platform,
        expected_architecture=expected_architecture,
    )
    if require_publication:
        _assert_cli_publication(value)
    target_cut = value.get("releaseCut")
    cut_decision = None
    if target_cut is not None:
        installed_cut = current_release_cut_root or source.get("selectedReleaseCutRoot")
        if not isinstance(installed_cut, str):
            raise DistributionUpdateError(
                "current-release-cut-unknown",
                "Cut-aware update requires the exact installed Release Cut",
            )
        try:
            cut_decision = release_cut.decide_cut_transition(
                current_release_cut_root=installed_cut,
                current_version=current_version,
                target_cut=target_cut,
                transition=cut_transition,
            )
        except release_cut.ReleaseCutError as error:
            raise DistributionUpdateError(error.code, str(error)) from error
    version_order = compare_product_versions(value["productVersion"], current_version)
    if version_order < 0:
        return {
            "schema": CHECK_SCHEMA,
            **_downgrade_refusal(value, current_version),
            "installSource": copy.deepcopy(dict(source)),
            "manifest": value,
        }
    manager_action = source.get("managerCommand")
    available = (
        cut_decision["updateAllowed"] if cut_decision is not None else version_order > 0
    )
    reason_code = (
        cut_decision["reasonCode"]
        if cut_decision is not None
        else "new-product-version"
        if available
        else "already-current"
    )
    state = (
        "available"
        if available
        else "current"
        if reason_code == "already-current"
        else "action-required"
    )
    return {
        "schema": CHECK_SCHEMA,
        "state": state,
        "reasonCode": reason_code,
        "currentVersion": current_version,
        "targetVersion": value["productVersion"],
        "runtimeBuildId": value["runtimeBuildId"],
        "installSource": copy.deepcopy(dict(source)),
        "frontendAction": "download"
        if source.get("selfUpdateAllowed")
        else "package-manager"
        if manager_action
        else "external-installer",
        "managerCommand": copy.deepcopy(manager_action),
        "documentationUrl": value["documentationUrl"],
        "message": runtime_upgrade.user_message(
            reason_code,
            documentation_url=value["documentationUrl"],
            impact=runtime_upgrade.release_check_impact(reason_code, state=state),
        ),
        "manifest": value,
        "cutDecision": copy.deepcopy(cut_decision),
    }


def plan_download(
    manifest: Mapping[str, Any],
    *,
    current_version: str,
    source: Mapping[str, Any],
    cache_root: str | Path,
    allow_local_artifact: bool = False,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(value)
    if compare_product_versions(value["productVersion"], current_version) < 0:
        return {
            "schema": DOWNLOAD_PLAN_SCHEMA,
            "planId": _stable_id(
                "product-download-plan",
                {
                    "currentVersion": current_version,
                    "targetVersion": value["productVersion"],
                    "reasonCode": "downgrade-refused",
                },
            ),
            **_downgrade_refusal(value, current_version),
        }
    if not source.get("selfUpdateAllowed"):
        reason_code = "frontend-authority-external"
        return {
            "schema": DOWNLOAD_PLAN_SCHEMA,
            "planId": _stable_id(
                "product-download-plan",
                {
                    "runtimeBuildId": value["runtimeBuildId"],
                    "source": str(source.get("source")),
                },
            ),
            "state": "action-required",
            "reasonCode": reason_code,
            "managerCommand": copy.deepcopy(source.get("managerCommand")),
            "documentationUrl": value["documentationUrl"],
            "message": runtime_upgrade.user_message(
                reason_code,
                documentation_url=value["documentationUrl"],
                impact={
                    "activeWorkContinues": True,
                    "activationTiming": "owned-by-install-source",
                    "userActionRequired": True,
                },
            ),
        }
    artifact = _artifact(value, "cli")
    if not allow_local_artifact:
        _assert_cli_publication(value)
    parsed = urllib.parse.urlparse(artifact["url"])
    name = Path(parsed.path).name
    if not name or name in {".", ".."}:
        raise DistributionUpdateError(
            "artifact-url-invalid", "CLI artifact URL has no safe filename"
        )
    target = Path(cache_root).expanduser().resolve() / value["runtimeBuildId"] / name
    identity = {
        "runtimeBuildId": value["runtimeBuildId"],
        "artifactUrl": artifact["url"],
        "artifactSize": artifact["size"],
        "artifactDigest": artifact["digest"],
        "target": str(target),
    }
    return {
        "schema": DOWNLOAD_PLAN_SCHEMA,
        "planId": _stable_id("product-download-plan", identity),
        "state": "download-allowed",
        "reasonCode": "verified-release",
        "target": str(target),
        "artifact": artifact,
        "manifest": value,
        "documentationUrl": value["documentationUrl"],
    }


def _orchestration_plan_identity(plan: Mapping[str, Any]) -> dict[str, Any]:
    manifest = plan.get("manifest")
    source = plan.get("installSource")
    download_plan = plan.get("downloadPlan")
    if not isinstance(manifest, Mapping) or not isinstance(source, Mapping):
        raise DistributionUpdateError(
            "plan-invalid", "update orchestration plan is incomplete"
        )
    return {
        "channel": plan.get("channel"),
        "currentVersion": plan.get("currentVersion"),
        "targetVersion": plan.get("targetVersion"),
        "releasePayloadRoot": plan.get("releasePayloadRoot"),
        "releasePassport": plan.get("releasePassport"),
        "currentReleaseCutRoot": plan.get("currentReleaseCutRoot"),
        "targetReleaseCutRoot": plan.get("targetReleaseCutRoot"),
        "platformSliceRoot": plan.get("platformSliceRoot"),
        "cutTransitionRoot": plan.get("cutTransitionRoot"),
        "cutTransition": plan.get("cutTransition"),
        "manifestRoot": f"sha256:{hashlib.sha256(_canonical(manifest)).hexdigest()}",
        "runtimeBuildId": manifest.get("runtimeBuildId"),
        "frontendBuildId": manifest.get("frontendBuildId"),
        "installSource": source.get("source"),
        "managerCommand": source.get("managerCommand"),
        "verificationCommand": source.get("verificationCommand"),
        "downloadPlanId": (
            download_plan.get("planId") if isinstance(download_plan, Mapping) else None
        ),
        "action": plan.get("action"),
        "state": plan.get("state"),
        "reasonCode": plan.get("reasonCode"),
        "impact": plan.get("impact"),
        "nextAction": plan.get("nextAction"),
    }


def _finish_orchestration_plan(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        **payload,
        "planId": _stable_id(
            "product-update-plan", _orchestration_plan_identity(payload)
        ),
    }


def plan_update(
    selection: Mapping[str, Any],
    *,
    current_version: str,
    source: Mapping[str, Any],
    cache_root: str | Path,
) -> dict[str, Any]:
    """Bind one verified channel selection to one executable update action."""

    entry = selection.get("entry")
    manifest = entry.get("manifest") if isinstance(entry, Mapping) else None
    release_passport = selection.get("releasePassport")
    if (
        selection.get("schema") != "kungfu.release-channel-selection/v1"
        or not isinstance(manifest, Mapping)
        or not isinstance(release_passport, Mapping)
        or not str(selection.get("payloadRoot") or "").startswith("sha256:")
    ):
        raise DistributionUpdateError(
            "channel-selection-invalid",
            "release channel selection is incomplete",
        )
    assert isinstance(entry, Mapping)
    if (
        selection.get("channel") != manifest.get("releaseChannel")
        or selection.get("installSource") != source.get("source")
        or selection.get("targetVersion") != manifest.get("productVersion")
        or selection.get("currentVersion") != current_version
    ):
        raise DistributionUpdateError(
            "channel-selection-stale",
            "release channel selection no longer matches this installation",
        )
    cut_decision = selection.get("cutDecision")
    if cut_decision is not None:
        if (
            not isinstance(cut_decision, Mapping)
            or selection.get("currentReleaseCutRoot")
            != source.get("selectedReleaseCutRoot")
            or selection.get("targetReleaseCutRoot") != manifest.get("releaseCutRoot")
            or selection.get("platformSliceRoot") != manifest.get("platformSliceRoot")
        ):
            raise DistributionUpdateError(
                "channel-selection-stale",
                "release channel Cut selection no longer matches this installation",
            )
    checked = check_release(
        manifest,
        current_version=current_version,
        source=source,
        require_publication=True,
        current_release_cut_root=selection.get("currentReleaseCutRoot"),
        cut_transition=entry.get("cutTransition"),
    )
    impact = {
        "activeWorkContinues": True,
        "activationTiming": "after-core-readiness",
        "userActionRequired": checked["state"] != "current",
    }
    common = {
        "schema": ORCHESTRATION_PLAN_SCHEMA,
        "channel": selection.get("channel"),
        "currentVersion": current_version,
        "targetVersion": checked["targetVersion"],
        "releasePayloadRoot": selection.get("payloadRoot"),
        "releasePassport": copy.deepcopy(selection.get("releasePassport")),
        "currentReleaseCutRoot": selection.get("currentReleaseCutRoot"),
        "targetReleaseCutRoot": selection.get("targetReleaseCutRoot"),
        "platformSliceRoot": selection.get("platformSliceRoot"),
        "cutTransitionRoot": (
            cut_decision.get("cutTransitionRoot")
            if isinstance(cut_decision, Mapping)
            else None
        ),
        "cutTransition": copy.deepcopy(entry.get("cutTransition")),
        "installSource": copy.deepcopy(dict(source)),
        "manifest": copy.deepcopy(dict(manifest)),
        "check": checked,
        "impact": impact,
        "documentationUrl": checked["documentationUrl"],
    }
    if checked["state"] == "current":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "current",
                "reasonCode": "already-current",
                "action": "none",
                "downloadPlan": None,
                "nextAction": "No action is required.",
            }
        )
    if checked["state"] == "action-required":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "action-required",
                "reasonCode": checked["reasonCode"],
                "action": "none",
                "downloadPlan": None,
                "nextAction": (
                    "Retain the current image and obtain an authorized Cut Transition."
                ),
            }
        )
    if checked["reasonCode"] == "downgrade-refused":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "action-required",
                "reasonCode": "downgrade-refused",
                "action": "recovery",
                "downloadPlan": None,
                "nextAction": "Use an explicit release recovery procedure.",
            }
        )
    if source.get("selfUpdateAllowed"):
        download_plan = plan_download(
            manifest,
            current_version=current_version,
            source=source,
            cache_root=cache_root,
        )
        return _finish_orchestration_plan(
            {
                **common,
                "state": "update-available",
                "reasonCode": checked["reasonCode"],
                "action": "archive-self-update",
                "downloadPlan": download_plan,
                "nextAction": "Approve this exact plan to install beside current work.",
            }
        )
    if source.get("frontendAuthority") == "package-manager":
        if not source.get("managerCommand") or not source.get("verificationCommand"):
            return _finish_orchestration_plan(
                {
                    **common,
                    "state": "action-required",
                    "reasonCode": "manager-required",
                    "action": "package-manager",
                    "downloadPlan": None,
                    "nextAction": (
                        "Use a package that declares exact update and verification argv."
                    ),
                }
            )
        return _finish_orchestration_plan(
            {
                **common,
                "state": "update-available",
                "reasonCode": checked["reasonCode"],
                "action": "package-manager",
                "downloadPlan": None,
                "nextAction": (
                    "Approve this exact plan to run the installed package command."
                ),
            }
        )
    if source.get("frontendAuthority") == "desktop-updater":
        return _finish_orchestration_plan(
            {
                **common,
                "state": "action-required",
                "reasonCode": "desktop-required",
                "action": "desktop-companion",
                "downloadPlan": None,
                "nextAction": (
                    "Use the desktop updater; this CLI will not replace its frontend."
                ),
            }
        )
    return _finish_orchestration_plan(
        {
            **common,
            "state": "action-required",
            "reasonCode": "unsupported-source",
            "action": str(source.get("source") or "unknown"),
            "downloadPlan": None,
            "nextAction": "Follow the release installation instructions.",
        }
    )


def validate_update_plan(
    plan: Mapping[str, Any], *, expected_plan_id: str
) -> dict[str, Any]:
    if plan.get("schema") != ORCHESTRATION_PLAN_SCHEMA:
        raise DistributionUpdateError(
            "plan-invalid", "update orchestration plan schema is invalid"
        )
    observed_plan_id = _stable_id(
        "product-update-plan", _orchestration_plan_identity(plan)
    )
    if plan.get("planId") != expected_plan_id or observed_plan_id != expected_plan_id:
        raise DistributionUpdateError(
            "stale-plan", "update orchestration plan identity changed"
        )
    return copy.deepcopy(dict(plan))


def _orchestration_receipt_path(
    config_home: str | Path, plan_id: str, receipt_id: str
) -> Path:
    return (
        Path(config_home).expanduser().resolve()
        / "product"
        / "update"
        / "receipts"
        / _path_safe_id(plan_id, "plan-id")
        / f"{_path_safe_id(receipt_id, 'receipt-id')}.json"
    )


def record_update_outcome(
    plan: Mapping[str, Any],
    *,
    config_home: str | Path,
    state: str,
    reason_code: str,
    result: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if state not in {"complete", "cancelled", "failed"}:
        raise DistributionUpdateError(
            "receipt-state-invalid", "update receipt state is invalid"
        )
    plan_id = str(plan.get("planId") or "")
    validate_update_plan(plan, expected_plan_id=plan_id)
    recorded_at_ns = time.time_ns()
    recorded_at = (
        datetime.fromtimestamp(recorded_at_ns / 1_000_000_000, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    receipt_id = _stable_id(
        "product-update-receipt",
        {
            "planId": plan_id,
            "state": state,
            "reasonCode": reason_code,
            "recordedAtNs": str(recorded_at_ns),
            "processId": os.getpid(),
        },
    )
    path = _orchestration_receipt_path(config_home, plan_id, receipt_id)
    receipt_core = {
        "schema": ORCHESTRATION_RECEIPT_SCHEMA,
        "receiptId": receipt_id,
        "planId": plan_id,
        "state": state,
        "reasonCode": reason_code,
        "recordedAt": recorded_at,
        "recordedAtNs": str(recorded_at_ns),
        "channel": plan["channel"],
        "currentVersion": plan["currentVersion"],
        "targetVersion": plan["targetVersion"],
        "installSource": plan["installSource"]["source"],
        "releasePayloadRoot": plan["releasePayloadRoot"],
        "currentReleaseCutRoot": plan.get("currentReleaseCutRoot"),
        "targetReleaseCutRoot": plan.get("targetReleaseCutRoot"),
        "platformSliceRoot": plan.get("platformSliceRoot"),
        "cutTransitionRoot": plan.get("cutTransitionRoot"),
        "runtimeBuildId": plan["manifest"]["runtimeBuildId"],
        "frontendBuildId": plan["manifest"]["frontendBuildId"],
        "result": copy.deepcopy(dict(result)) if result is not None else None,
        "recoveryAction": (
            None
            if state == "complete"
            else "Run `kungfu update --check` before retrying the exact release."
        ),
    }
    receipt = {
        **receipt_core,
        "receiptRoot": _content_root(receipt_core),
        "receiptPath": str(path),
    }
    _write_object(path, receipt)
    return receipt
