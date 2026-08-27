# SPDX-License-Identifier: Apache-2.0

"""Immutable runtime-image inventory and upgrade lifecycle ownership."""

from __future__ import annotations

import copy
import hashlib
import os
import shutil
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from kungfu.coordination import locks as coordination_locks
from kungfu._runtime_upgrade.common import (
    GC_PLAN_SCHEMA,
    IMAGE_SCHEMA,
    MANIFEST_SCHEMA,
    MESSAGE_SCHEMA,
    PLAN_SCHEMA,
    RECEIPT_SCHEMA,
    REFERENCE_SCHEMA,
    UpgradeError,
    _canonical,
    _contract,
    _upgrade_facade_seam,
    _image_root,
    _read_json,
    _stable_id,
    _state_root,
    _validate,
    _write_json,
    inventory_root,
    manifest_digest,
    tree_digest,
)
from kungfu._runtime_upgrade.release_cut import (
    ReleaseCutError,
    manifest_identity_root,
    validate_release_cut,
)


def runtime_identity(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Project only fields owned by one immutable runtime image."""

    value = validate_manifest(manifest)
    return {
        "runtimeBuildId": value["runtimeBuildId"],
        "runtimeArtifactDigest": value["runtimeArtifactDigest"],
        "runtimeEntrypoint": value["runtimeEntrypoint"],
        "controlProtocolRange": value["controlProtocolRange"],
        "peerWireProtocolRange": value["peerWireProtocolRange"],
        "journalSchemaReadRange": value["journalSchemaReadRange"],
        "journalSchemaWriteVersion": value["journalSchemaWriteVersion"],
        "minimumSupportedRuntime": value["minimumSupportedRuntime"],
    }


def validate_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(dict(manifest))
    _validate("releaseManifest", value)
    cut_fields = {
        "manifestIdentityRoot",
        "releaseCut",
        "releaseCutRoot",
        "platformSliceRoot",
    }
    present_cut_fields = cut_fields.intersection(value)
    if present_cut_fields and present_cut_fields != cut_fields:
        raise UpgradeError(
            "release-cut-binding-incomplete",
            "release manifest must carry the complete Release Cut binding",
        )
    if present_cut_fields:
        try:
            cut = validate_release_cut(value["releaseCut"])
        except (TypeError, ReleaseCutError) as error:
            raise UpgradeError(
                getattr(error, "code", "release-cut-invalid"),
                f"release manifest Product Release Cut is invalid: {error}",
            ) from error
        identity_root = manifest_identity_root(value)
        if (
            value["manifestIdentityRoot"] != identity_root
            or value["releaseCutRoot"] != cut["releaseCutRoot"]
        ):
            raise UpgradeError(
                "release-cut-binding-mismatch",
                "release manifest identity and Release Cut roots disagree",
            )
        matching_slices = [
            item
            for item in cut["platformSlices"]
            if item["platform"] == value["platform"]
            and item["architecture"] == value["architecture"]
        ]
        if (
            len(matching_slices) != 1
            or matching_slices[0]["manifestIdentityRoot"] != identity_root
            or matching_slices[0]["platformSliceRoot"] != value["platformSliceRoot"]
        ):
            raise UpgradeError(
                "release-cut-platform-slice-mismatch",
                "release manifest is not a member of the declared platform slice",
            )
    for name in (
        "controlProtocolRange",
        "peerWireProtocolRange",
        "journalSchemaReadRange",
    ):
        if int(value[name]["min"]) > int(value[name]["max"]):
            raise UpgradeError("invalid-range", f"{name} minimum exceeds maximum")
    runtime_artifacts = [
        item for item in value["artifacts"] if item["kind"] == "runtime"
    ]
    if len(runtime_artifacts) != 1:
        raise UpgradeError(
            "runtime-artifact-ambiguous",
            "manifest must declare exactly one runtime artifact",
        )
    if runtime_artifacts[0]["digest"] != value["runtimeArtifactDigest"]:
        raise UpgradeError(
            "runtime-artifact-mismatch",
            "runtime artifact digest does not match the release identity",
        )
    return value


def user_message(
    reason_code: str,
    *,
    documentation_url: str,
    impact: Mapping[str, Any] | None = None,
    contract: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    registry = _contract(contract).get("messageRegistry")
    if not isinstance(registry, Mapping):
        raise UpgradeError(
            "message-registry-missing", "upgrade message registry is missing"
        )
    messages = registry.get("reasonMessages")
    if not isinstance(messages, Mapping):
        raise UpgradeError(
            "message-registry-missing", "upgrade reason messages are missing"
        )
    selected_reason = (
        reason_code
        if reason_code in messages
        else str(registry.get("fallbackReason") or "")
    )
    selected = messages.get(selected_reason)
    if not isinstance(selected, Mapping):
        raise UpgradeError(
            "message-registry-missing", "upgrade fallback message is missing"
        )
    anchor = str(selected["documentationAnchor"])
    return {
        "schema": MESSAGE_SCHEMA,
        "reasonCode": reason_code,
        "messageReasonCode": selected_reason,
        "title": str(selected["title"]),
        "whatHappened": str(selected["whatHappened"]),
        "activeWork": str(selected["activeWork"]),
        "activation": str(selected["activation"]),
        "userAction": str(selected["userAction"]),
        "dataAndSessions": str(selected["dataAndSessions"]),
        "impact": copy.deepcopy(dict(impact or {})),
        "documentationUrl": f"{documentation_url.split('#', 1)[0]}{anchor}",
    }


def is_public_release_cut(value: Mapping[str, Any] | None) -> bool:
    if value is None:
        return True
    policy = value.get("publicationPolicy")
    return isinstance(policy, Mapping) and (
        policy.get("trustDomain"),
        policy.get("publicationEligible"),
    ) == ("public", True)


def release_check_impact(
    reason_code: str,
    *,
    state: str | None = None,
) -> dict[str, Any]:
    action_timing = {
        "active-work-must-be-idle": "after-current-work-is-idle",
        "provider-resume-required": "after-provider-resume",
        "irreversible-migration-needs-approval": "after-recovery-evidence-and-approval",
        "rollback-unavailable": "after-recovery-path-is-approved",
        "manual-rollback-needs-approval": "after-manual-rollback-is-approved",
        "cut-recovery-approval-required": "after-recovery-is-approved",
    }
    user_action_required = state == "action-required" or reason_code in action_timing
    return {
        "activeWorkContinues": True,
        "activationTiming": action_timing.get(
            reason_code,
            "after-required-action" if user_action_required else "after-core-readiness",
        ),
        "userActionRequired": user_action_required,
    }


def plan_install(
    manifest: Mapping[str, Any],
    source_root: str | Path,
    config_home: str | Path,
    *,
    clock_ns: int | None = None,
) -> dict[str, Any]:
    target = validate_manifest(manifest)
    source = Path(source_root).expanduser().resolve()
    observed = tree_digest(source)
    identity = {
        "manifestDigest": manifest_digest(target),
        "sourceDigest": observed,
        "targetRoot": str(_image_root(config_home, target["runtimeBuildId"])),
    }
    return {
        "schema": "kungfu.runtime-image-install-plan/v1",
        "planId": _stable_id("install-plan", identity),
        "state": "download-allowed"
        if observed == target["runtimeArtifactDigest"]
        else "action-required",
        "reasonCode": "verified-artifact"
        if observed == target["runtimeArtifactDigest"]
        else "artifact-digest-mismatch",
        "manifest": target,
        "manifestDigest": identity["manifestDigest"],
        "sourceRoot": str(source),
        "sourceDigest": observed,
        "targetRoot": identity["targetRoot"],
        "createdAtNs": str(clock_ns if clock_ns is not None else time.time_ns()),
    }


def _quarantine_record(
    config_home: str | Path,
    plan: Mapping[str, Any],
    reason: str,
) -> Path:
    root = Path(config_home).expanduser().resolve() / "runtime" / "quarantine"
    path = root / f"{plan['manifest']['runtimeBuildId']}-{time.time_ns()}.json"
    _write_json(
        path,
        {
            "schema": "kungfu.runtime-image-quarantine/v1",
            "buildId": plan["manifest"]["runtimeBuildId"],
            "sourceRoot": plan["sourceRoot"],
            "observedDigest": plan["sourceDigest"],
            "expectedDigest": plan["manifest"]["runtimeArtifactDigest"],
            "reason": reason,
        },
    )
    return path


def install_image(
    plan: Mapping[str, Any],
    *,
    expected_plan_id: str,
    config_home: str | Path,
    clock_ns: int | None = None,
) -> dict[str, Any]:
    if (
        plan.get("schema") != "kungfu.runtime-image-install-plan/v1"
        or plan.get("planId") != expected_plan_id
    ):
        raise UpgradeError(
            "stale-plan", "runtime image install plan is stale or altered"
        )
    manifest = validate_manifest(plan["manifest"])
    current = plan_install(manifest, plan["sourceRoot"], config_home, clock_ns=clock_ns)
    if current["planId"] != expected_plan_id or current["state"] != "download-allowed":
        quarantine = _quarantine_record(config_home, current, current["reasonCode"])
        raise UpgradeError(
            "artifact-digest-mismatch",
            f"runtime image was rejected; quarantine record: {quarantine}",
        )
    build_id = manifest["runtimeBuildId"]
    target = _image_root(config_home, build_id)
    lock_root = inventory_root(config_home) / "locks"
    with coordination_locks.held(
        lock_root, build_id, label=f"runtime-image-install:{build_id}"
    ):
        record_path = target / "image.json"
        if record_path.is_file():
            existing = _read_json(record_path)
            _validate("runtimeImage", existing)
            if existing["manifestDigest"] != current["manifestDigest"]:
                if runtime_identity(existing["manifest"]) != runtime_identity(manifest):
                    raise UpgradeError(
                        "build-id-collision",
                        "runtime build id already names different content",
                    )
            return existing
        staging = (
            inventory_root(config_home)
            / f".{build_id}.{os.getpid()}.{time.time_ns()}.partial"
        )
        try:
            shutil.copytree(current["sourceRoot"], staging, symlinks=True)
            if tree_digest(staging) != manifest["runtimeArtifactDigest"]:
                quarantine = _quarantine_record(
                    config_home, current, "copied-artifact-digest-mismatch"
                )
                raise UpgradeError(
                    "artifact-digest-mismatch",
                    f"copied runtime image failed verification; quarantine record: {quarantine}",
                )
            entrypoint = (staging / manifest["runtimeEntrypoint"]).resolve()
            if staging.resolve() not in entrypoint.parents or not entrypoint.is_file():
                raise UpgradeError(
                    "entrypoint-missing",
                    "runtime entrypoint is missing or escapes the image root",
                )
            image = {
                "schema": IMAGE_SCHEMA,
                "buildId": build_id,
                "artifactRoot": str(target),
                "manifestDigest": current["manifestDigest"],
                "entrypoint": manifest["runtimeEntrypoint"],
                "installedAtNs": str(
                    clock_ns if clock_ns is not None else time.time_ns()
                ),
                "state": "verified",
                "manifest": manifest,
            }
            _validate("runtimeImage", image)
            _write_json(staging / "image.json", image)
            os.replace(staging, target)
            return image
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def list_images(config_home: str | Path) -> list[dict[str, Any]]:
    root = inventory_root(config_home)
    if not root.is_dir():
        return []
    images: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), key=lambda item: item.name):
        record = child / "image.json"
        if not child.is_dir() or child.name == "locks" or not record.is_file():
            continue
        value = _read_json(record)
        _validate("runtimeImage", value)
        if Path(value["artifactRoot"]).resolve() != child.resolve():
            raise UpgradeError(
                "image-root-mismatch", f"runtime image record moved: {child}"
            )
        images.append(value)
    return images


def _contains(range_value: Mapping[str, Any], version: int) -> bool:
    return int(range_value["min"]) <= version <= int(range_value["max"])


def compatibility(
    current: Mapping[str, Any] | None, target: Mapping[str, Any]
) -> dict[str, bool]:
    target_manifest = target.get("manifest", target)
    if current is None:
        return {
            "controlProtocol": True,
            "peerWireProtocol": True,
            "schemaReadable": True,
            "rollbackReadable": True,
        }
    current_manifest = current["manifest"]
    return {
        "controlProtocol": _contains(
            target_manifest["controlProtocolRange"],
            int(current_manifest["controlProtocolRange"]["max"]),
        ),
        "peerWireProtocol": _contains(
            target_manifest["peerWireProtocolRange"],
            int(current_manifest["peerWireProtocolRange"]["max"]),
        ),
        "schemaReadable": _contains(
            target_manifest["journalSchemaReadRange"],
            int(current_manifest["journalSchemaWriteVersion"]),
        ),
        "rollbackReadable": _contains(
            current_manifest["journalSchemaReadRange"],
            int(target_manifest["journalSchemaWriteVersion"]),
        ),
    }


def plan_upgrade(
    *,
    workspace_id: str,
    target: Mapping[str, Any],
    current: Mapping[str, Any] | None,
    references: Sequence[Mapping[str, Any]],
    active_generation: str | None,
    provider_resume_required: bool = False,
    provider_resume_supported: bool = False,
    backup_ready: bool = False,
    user_confirmed: bool = False,
    clock_ns: int | None = None,
) -> dict[str, Any]:
    target_value = copy.deepcopy(dict(target))
    if target_value.get("schema") == MANIFEST_SCHEMA:
        target_value = validate_manifest(target_value)
        target_installed = False
    else:
        _validate("runtimeImage", target_value)
        target_installed = True
    current_value = copy.deepcopy(dict(current)) if current is not None else None
    if current_value is not None:
        _validate("runtimeImage", current_value)
    reference_values = [copy.deepcopy(dict(item)) for item in references]
    for item in reference_values:
        _validate("runtimeReference", item)
    target_manifest = target_value.get("manifest", target_value)
    decision = compatibility(current_value, target_value)
    active = [
        item for item in reference_values if item["state"] in {"active", "retained"}
    ]
    compatible = all(
        decision[name]
        for name in ("controlProtocol", "peerWireProtocol", "schemaReadable")
    )
    state = "apply-now"
    reason = "workspace-idle"
    next_action = (
        "Activate the verified runtime image and reconcile semantic readiness."
    )
    action_required = False
    if not target_installed:
        state, reason = "download-allowed", "target-not-installed"
        next_action = (
            "Install the verified runtime image without changing the active generation."
        )
    elif (
        current_value is not None
        and current_value["buildId"] == target_value["buildId"]
    ):
        state, reason, next_action = (
            "complete",
            "already-current",
            "No action is required.",
        )
    elif target_manifest["migrationClass"] == "irreversible" and not (
        backup_ready and user_confirmed
    ):
        state, reason, action_required = (
            "action-required",
            "irreversible-migration-needs-approval",
            True,
        )
        next_action = "Create verified backup or restore evidence, then explicitly approve the irreversible migration."
    elif active:
        if provider_resume_required:
            if provider_resume_supported:
                state, reason = "resume-required", "provider-resume-required"
                next_action = "End the old physical attempt at a safe point and resume it in the new generation."
            else:
                state, reason, action_required = (
                    "blocked-incompatible",
                    "provider-resume-unsupported",
                    True,
                )
                next_action = "Finish or stop the non-resumable work before activating this update."
        elif compatible:
            state, reason = "compatible-handoff", "active-work-compatible"
            next_action = (
                "Keep current work pinned, then hand off at a fenced safe point."
            )
        else:
            state, reason = "defer-until-idle", "active-work-incompatible"
            next_action = "Stop assigning unsafe new work and wait for the current generation to become idle."
    expected_generation = (
        None if active_generation is None else str(int(active_generation) + 1)
    )
    identity = {
        "workspaceId": workspace_id,
        "state": state,
        "reasonCode": reason,
        "currentBuildId": current_value["buildId"] if current_value else None,
        "targetBuildId": target_manifest["runtimeBuildId"],
        "activeGeneration": active_generation,
        "expectedGeneration": expected_generation,
        "references": reference_values,
        "compatibility": decision,
    }
    plan = {
        "schema": PLAN_SCHEMA,
        "planId": _stable_id("upgrade-plan", identity),
        "workspaceId": workspace_id,
        "state": state,
        "reasonCode": reason,
        "current": current_value,
        "target": target_value,
        "activeGeneration": active_generation,
        "expectedGeneration": expected_generation,
        "references": reference_values,
        "compatibility": decision,
        "impact": {
            "activeWorkContinues": bool(active),
            "activationTiming": "after-safe-point" if active else "now",
            "userActionRequired": action_required,
        },
        "nextAction": next_action,
        "createdAtNs": str(clock_ns if clock_ns is not None else time.time_ns()),
    }
    _validate("upgradePlan", plan)
    return plan


def _pin_path(config_home: str | Path, workspace_id: str) -> Path:
    digest = hashlib.sha256(workspace_id.encode()).hexdigest()[:24]
    return _state_root(config_home) / "pins" / f"{digest}.json"


def active_image(config_home: str | Path, workspace_id: str) -> dict[str, Any] | None:
    path = _pin_path(config_home, workspace_id)
    if not path.is_file():
        return None
    value = _read_json(path)
    image = value.get("image")
    if not isinstance(image, dict):
        raise UpgradeError("pin-invalid", "runtime image pin has no image")
    _validate("runtimeImage", image)
    return image


def references_from_runtime_status(
    status: Mapping[str, Any], current: Mapping[str, Any] | None
) -> list[dict[str, Any]]:
    """Project live Core facts into the upgrade contract's image references.

    Distribution adapters must not infer whether work is idle from Electron or
    installer state.  This projection remains in Core and fails closed with a
    retained recovery reference when the runtime reports an uncertain live
    state.
    """

    if current is None:
        return []
    _validate("runtimeImage", current)
    build_id = str(current["buildId"])
    product = status.get("product")
    product = product if isinstance(product, Mapping) else {}
    handle = product.get("handle")
    handle = handle if isinstance(handle, Mapping) else {}
    references: list[dict[str, Any]] = []

    generation = handle.get("generation")
    workspace = product.get("workspaceId") or handle.get("workspaceId")
    if generation is not None and workspace:
        references.append(
            {
                "schema": REFERENCE_SCHEMA,
                "ownerKind": "generation",
                "ownerId": f"{workspace}:{generation}",
                "buildId": build_id,
                "state": "active",
            }
        )

    leases = product.get("leases")
    lease_items = leases.get("items") if isinstance(leases, Mapping) else []
    for lease in lease_items if isinstance(lease_items, list) else []:
        if not isinstance(lease, Mapping) or lease.get("state") != "active":
            continue
        owner_id = lease.get("leaseId") or lease.get("holderId")
        if not owner_id:
            continue
        references.append(
            {
                "schema": REFERENCE_SCHEMA,
                "ownerKind": "lease",
                "ownerId": str(owner_id),
                "buildId": build_id,
                "state": "active",
            }
        )

    coordinator = status.get("coordinator")
    coordinator = coordinator if isinstance(coordinator, Mapping) else {}
    last_state = status.get("lastState")
    last_state = last_state if isinstance(last_state, Mapping) else {}
    process_image = last_state.get("runtimeImage")
    if (
        coordinator.get("running") is True
        and isinstance(process_image, Mapping)
        and process_image.get("buildId") == build_id
    ):
        owner_id = coordinator.get("startIdentity") or coordinator.get("pid")
        references.append(
            {
                "schema": REFERENCE_SCHEMA,
                "ownerKind": "process",
                "ownerId": f"coordinator:{owner_id}",
                "buildId": build_id,
                "state": "active",
            }
        )

    lifecycle = status.get("lifecycle")
    lifecycle = lifecycle if isinstance(lifecycle, Mapping) else {}
    uncertain = product.get("error") is not None or lifecycle.get("state") in {
        "failed",
        "orphan-coordinator",
        "unowned-orphan",
    }
    if uncertain:
        references.append(
            {
                "schema": REFERENCE_SCHEMA,
                "ownerKind": "recovery",
                "ownerId": f"runtime-status:{workspace or 'unknown'}",
                "buildId": build_id,
                "state": "retained",
            }
        )

    references.sort(key=lambda item: (item["ownerKind"], item["ownerId"]))
    for reference in references:
        _validate("runtimeReference", reference)
    return references


def stage_upgrade(
    plan: Mapping[str, Any],
    *,
    expected_plan_id: str,
    current_generation: str | None,
    config_home: str | Path,
    clock_ns: int | None = None,
) -> dict[str, Any]:
    _validate("upgradePlan", plan)
    if (
        plan["planId"] != expected_plan_id
        or plan["activeGeneration"] != current_generation
    ):
        raise UpgradeError(
            "stale-generation", "upgrade plan no longer matches the active generation"
        )
    if plan["state"] not in {"apply-now", "compatible-handoff", "resume-required"}:
        raise UpgradeError(
            "plan-not-applicable",
            f"upgrade plan cannot apply from state {plan['state']}",
        )
    target = plan["target"]
    if target.get("schema") != IMAGE_SCHEMA:
        raise UpgradeError(
            "target-not-installed", "upgrade target is not an installed runtime image"
        )
    generation = plan["expectedGeneration"] or "1"
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "receiptId": _stable_id(
            "upgrade-receipt", {"planId": plan["planId"], "generation": generation}
        ),
        "planId": plan["planId"],
        "workspaceId": plan["workspaceId"],
        "state": "reconciling",
        "generation": generation,
        "previous": plan["current"],
        "target": target,
        "reasonCode": plan["reasonCode"],
        "createdAtNs": str(clock_ns if clock_ns is not None else time.time_ns()),
    }
    _validate("upgradeReceipt", receipt)
    root = _state_root(config_home)
    with coordination_locks.held(
        root / "locks",
        plan["workspaceId"],
        label=f"runtime-upgrade-stage:{plan['planId']}",
    ):
        receipt_path = root / "receipts" / f"{receipt['receiptId']}.json"
        if receipt_path.is_file():
            existing = _read_json(receipt_path)
            _validate("upgradeReceipt", existing)
            if (
                existing["state"] == "reconciling"
                and existing["planId"] == plan["planId"]
            ):
                return existing
            raise UpgradeError(
                "stale-receipt", "this upgrade plan was already reconciled"
            )
        _write_json(receipt_path, receipt)
    return receipt


def reconcile_upgrade(
    receipt: Mapping[str, Any],
    *,
    readiness_passed: bool,
    config_home: str | Path,
) -> dict[str, Any]:
    value = copy.deepcopy(dict(receipt))
    _validate("upgradeReceipt", value)
    root = _state_root(config_home)
    receipt_path = root / "receipts" / f"{value['receiptId']}.json"
    with coordination_locks.held(
        root / "locks",
        value["workspaceId"],
        label=f"runtime-upgrade-reconcile:{value['receiptId']}",
    ):
        current_receipt = _read_json(receipt_path)
        if (
            _canonical(current_receipt) != _canonical(value)
            or current_receipt["state"] != "reconciling"
        ):
            raise UpgradeError(
                "stale-receipt", "upgrade receipt was already reconciled or replaced"
            )
        pin_path = _pin_path(config_home, value["workspaceId"])
        if pin_path.is_file():
            pin = _read_json(pin_path)
            pin_generation = int(pin.get("generation", "0"))
            receipt_generation = int(value["generation"])
            pinned_image = pin.get("image") or {}
            if (
                pin_generation >= receipt_generation
                and pinned_image.get("buildId") != value["target"]["buildId"]
            ):
                raise UpgradeError(
                    "stale-generation",
                    "a newer runtime image generation is already active",
                )
        if readiness_passed:
            value["state"] = "complete"
            value["reasonCode"] = (
                "workspace-idle"
                if value["reasonCode"] == "workspace-idle"
                else value["reasonCode"]
            )
            _write_json(
                _pin_path(config_home, value["workspaceId"]),
                {
                    "schema": "kungfu.runtime-image-pin/v1",
                    "workspaceId": value["workspaceId"],
                    "generation": value["generation"],
                    "image": value["target"],
                },
            )
        elif (
            value["previous"] is not None
            and value["target"]["manifest"]["rollbackClass"] == "automatic"
        ):
            value["state"] = "failed-rolled-back"
            value["reasonCode"] = "readiness-failed"
            _write_json(
                _pin_path(config_home, value["workspaceId"]),
                {
                    "schema": "kungfu.runtime-image-pin/v1",
                    "workspaceId": value["workspaceId"],
                    "generation": str(max(int(value["generation"]) - 1, 0)),
                    "image": value["previous"],
                },
            )
        else:
            value["state"] = "action-required"
            value["reasonCode"] = "rollback-unavailable"
        _validate("upgradeReceipt", value)
        _write_json(receipt_path, value)
    return value


def pinned_entry_command(image: Mapping[str, Any]) -> list[str]:
    _validate("runtimeImage", image)
    root = Path(image["artifactRoot"]).expanduser().resolve()
    entrypoint = (root / image["entrypoint"]).resolve()
    if root not in entrypoint.parents or not entrypoint.is_file():
        raise UpgradeError(
            "entrypoint-missing",
            "pinned runtime entrypoint is missing or escapes the image root",
        )
    return [str(entrypoint)]


def pinned_environment(image: Mapping[str, Any]) -> dict[str, str]:
    _validate("runtimeImage", image)
    return {
        "KF_RUNTIME_BUILD_ID": str(image["buildId"]),
        "KF_RUNTIME_ARTIFACT_ROOT": str(Path(image["artifactRoot"]).resolve()),
        "KF_RUNTIME_ENTRYPOINT": str(image["entrypoint"]),
        "KF_RUNTIME_MANIFEST_DIGEST": str(image["manifestDigest"]),
    }


def image_from_environment(
    env: Mapping[str, str] | None = None,
) -> dict[str, str] | None:
    env = os.environ if env is None else env
    required = [
        "KF_RUNTIME_BUILD_ID",
        "KF_RUNTIME_ARTIFACT_ROOT",
        "KF_RUNTIME_ENTRYPOINT",
        "KF_RUNTIME_MANIFEST_DIGEST",
    ]
    if not any(env.get(name) for name in required):
        return None
    if not all(env.get(name) for name in required):
        raise UpgradeError(
            "pin-incomplete", "runtime image environment pin is incomplete"
        )
    return {
        "buildId": env[required[0]],
        "artifactRoot": env[required[1]],
        "entrypoint": env[required[2]],
        "manifestDigest": env[required[3]],
    }


def plan_gc(
    images: Sequence[Mapping[str, Any]],
    references: Sequence[Mapping[str, Any]],
    *,
    unknown_references: bool = False,
    clock_ns: int | None = None,
) -> dict[str, Any]:
    image_values = sorted(
        (copy.deepcopy(dict(item)) for item in images),
        key=lambda item: str(item.get("buildId", "")),
    )
    for image in image_values:
        _validate("runtimeImage", image)
    reference_values = [copy.deepcopy(dict(item)) for item in references]
    for reference in reference_values:
        _validate("runtimeReference", reference)
    retained = {
        item["buildId"]
        for item in reference_values
        if item["state"] in {"active", "retained"}
    }
    candidates = (
        []
        if unknown_references
        else [item for item in image_values if item["buildId"] not in retained]
    )
    blocked = (
        image_values
        if unknown_references
        else [item for item in image_values if item["buildId"] in retained]
    )
    identity = {
        "images": [item["buildId"] for item in image_values],
        "retained": sorted(retained),
        "unknownReferences": unknown_references,
    }
    plan = {
        "schema": GC_PLAN_SCHEMA,
        "planId": _stable_id("gc-plan", identity),
        "state": "action-required" if unknown_references else "complete",
        "candidates": candidates,
        "blocked": blocked,
        "createdAtNs": str(clock_ns if clock_ns is not None else time.time_ns()),
    }
    _validate("gcPlan", plan)
    return plan


def apply_gc(
    plan: Mapping[str, Any],
    *,
    expected_plan_id: str,
    config_home: str | Path,
    references: Sequence[Mapping[str, Any]],
    unknown_references: bool = False,
) -> list[str]:
    _validate("gcPlan", plan)
    if plan["planId"] != expected_plan_id or plan["state"] != "complete":
        raise UpgradeError("stale-plan", "runtime image GC plan is stale or blocked")
    images = [*plan["candidates"], *plan["blocked"]]
    current = plan_gc(
        images,
        references,
        unknown_references=unknown_references,
    )
    if current["planId"] != expected_plan_id or current["state"] != "complete":
        raise UpgradeError(
            "stale-plan", "runtime image references changed after the GC plan"
        )
    inventory = inventory_root(config_home)
    removed: list[str] = []
    with coordination_locks.held(
        inventory / "locks", "gc", label=f"runtime-image-gc:{expected_plan_id}"
    ):
        for image in current["candidates"]:
            root = Path(image["artifactRoot"]).expanduser().resolve()
            record = root / "image.json"
            if root.parent != inventory or root.name != image["buildId"]:
                raise UpgradeError(
                    "image-ownership-unknown",
                    f"runtime image escaped the inventory root: {root}",
                )
            if (
                not record.is_file()
                or _read_json(record).get("manifestDigest") != image["manifestDigest"]
            ):
                raise UpgradeError(
                    "image-ownership-unknown",
                    f"runtime image ownership is not proven: {root}",
                )
            shutil.rmtree(root)
            removed.append(image["buildId"])
    return removed


for _upgrade_name in (
    "runtime_identity",
    "validate_manifest",
    "user_message",
    "is_public_release_cut",
    "release_check_impact",
    "plan_install",
    "_quarantine_record",
    "install_image",
    "list_images",
    "_contains",
    "compatibility",
    "plan_upgrade",
    "_pin_path",
    "active_image",
    "references_from_runtime_status",
    "stage_upgrade",
    "reconcile_upgrade",
    "pinned_entry_command",
    "pinned_environment",
    "image_from_environment",
    "plan_gc",
    "apply_gc",
):
    globals()[_upgrade_name] = _upgrade_facade_seam(_upgrade_name)(
        globals()[_upgrade_name]
    )
del _upgrade_name
