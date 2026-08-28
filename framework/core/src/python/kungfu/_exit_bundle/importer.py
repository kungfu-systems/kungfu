# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import tempfile
from pathlib import Path
from typing import Any, Mapping

from kungfu import contract as contract_runtime
from kungfu import product_release_history
from kungfu.storage import service as storage_service

from kungfu._exit_bundle.common import (
    RECEIPT_SCHEMA,
    ExitBundleError,
    _KINDS,
    _PRODUCT_RELEASE_HISTORY,
    _contract,
    _describe,
    _exit_facade_seam,
    _project_cut_import_bundle,
    _root,
)
from kungfu._exit_bundle.verification import inspect


def _profile_source(
    runtime_dir: str | Path,
    bundle: Mapping[str, Any],
) -> tuple[Path, bool]:
    from kungfu import profile_sdk

    profile_id = str(bundle["profileId"])
    try:
        discovered = profile_sdk.discover_source(profile_id, runtime_dir)
        source = Path(discovered["source"])
        current = profile_sdk.export_source_bundle(source, runtime_dir, thin=False)
        if current.get("bundleRoot") != bundle.get("bundleRoot"):
            raise ExitBundleError(
                "profile-source-diverged",
                "installed Profile source has the same id but different bytes",
                profileId=profile_id,
            )
        return source, True
    except profile_sdk.ProfileSdkError as error:
        if error.diagnosis.get("code") != "profile-source-unresolved":
            raise
    target = (
        Path(runtime_dir).expanduser().resolve().parent
        / "extensions"
        / f"{profile_id}-{str(bundle['profileSuiteRoot'])[7:19]}"
    )
    return target, False


def _apply_profile(
    runtime_dir: str | Path,
    bundle: Mapping[str, Any],
    execution: Mapping[str, Any],
    actor: str,
) -> dict[str, Any]:
    from kungfu import profile_composition, profile_sdk

    source, already_source = _profile_source(runtime_dir, bundle)
    written: list[str] = []
    source_receipt = None
    if not already_source:
        plan = profile_sdk.source_import_plan(bundle, source)
        answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", actor)
        source_receipt = profile_sdk.authorized_source_import(plan, answer)
        written = list(source_receipt["written"])

    lifecycle = []
    state = None
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=str(bundle["profileId"])
        )
    except ValueError as error:
        if not str(error).startswith("Profile not found:"):
            raise
    exact_active = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == bundle["profileSuiteRoot"]
    )
    if state and state.get("profile_suite_root") != bundle["profileSuiteRoot"]:
        raise ExitBundleError(
            "profile-destination-diverged",
            "destination Profile id is bound to another Suite root",
            profileId=bundle["profileId"],
        )
    if not exact_active:
        actions = (
            ("qualify", "activate")
            if state is not None
            else ("install", "qualify", "activate")
        )
        for action in actions:
            values = (
                {"granted_permissions": list(execution.get("grantedPermissions") or [])}
                if action == "activate"
                else {}
            )
            plan = profile_sdk.lifecycle_plan(runtime_dir, action, source, **values)
            answer = profile_sdk.answer_decision(plan["decisionCard"], "approve", actor)
            receipt = profile_sdk.authorized_lifecycle_apply(runtime_dir, plan, answer)
            lifecycle.append({"action": action, "receipt": receipt})
    contract_plan: dict[str, Any] = {"operations": []}
    contract_receipt = None
    if not execution.get("deferContractMaterialization"):
        contract_plan = profile_composition.contract_materialization_plan(
            source, runtime_dir
        )
        if contract_plan["operations"]:
            contract_receipt = profile_composition.authorized_contract_materialize(
                runtime_dir,
                contract_plan,
                profile_sdk.answer_decision(
                    contract_plan["decisionCard"], "approve", actor
                ),
            )
    verified = profile_sdk.export_source_bundle(source, runtime_dir, thin=False)
    if verified["bundleRoot"] != bundle["bundleRoot"]:
        raise ExitBundleError(
            "profile-postflight-mismatch", "Profile source root changed after import"
        )
    return {
        "ok": True,
        "status": (
            "already_present"
            if already_source and exact_active and not contract_plan["operations"]
            else "imported"
        ),
        "writeOccurred": bool(written or lifecycle or contract_receipt),
        "sourceReceipt": source_receipt,
        "lifecycle": lifecycle,
        "contractReceipt": contract_receipt,
        "profileSuiteRoot": bundle["profileSuiteRoot"],
        "bundleRoot": bundle["bundleRoot"],
    }


def _apply_member(
    runtime_dir: str | Path,
    kind: str,
    material: Mapping[str, Any],
    execution: Mapping[str, Any],
    actor: str,
    *,
    config_home: str | Path | None = None,
) -> dict[str, Any]:
    if kind == "profile-source-v1":
        return _apply_profile(runtime_dir, material, execution, actor)
    if kind == "storage-source-export-v1":
        source_id = str((material.get("manifest") or {}).get("source_id") or "")
        try:
            current = storage_service.build_export_bundle(
                runtime_dir, source_id=source_id
            )
            if (
                _describe(kind, current)["contentRoot"]
                == _describe(kind, material)["contentRoot"]
            ):
                return {
                    "ok": True,
                    "status": "already_present",
                    "writeOccurred": False,
                    "sourceId": source_id,
                    "syncRoot": (material.get("manifest") or {}).get("sync_root"),
                }
        except (RuntimeError, ValueError):
            pass
        result = storage_service.import_bundle(
            runtime_dir, dict(material), verify=True, execute=True
        )
        return {
            **result,
            "status": "imported",
            "writeOccurred": True,
        }
    if kind == "episode-v1":
        result = storage_service.import_bundle(
            runtime_dir, dict(material), verify=True, execute=True
        )
        return {
            **result,
            "status": result.get("status") or "imported",
            "writeOccurred": result.get("status") != "already_present",
        }
    if kind == "fact-authority-v2":
        from kungfu.agent import work_profile

        result = work_profile.import_authority(
            runtime_dir, dict(material), execute=True
        )
        write_occurred = result.get("write_occurred") is True
        return {
            **result,
            "status": "imported" if write_occurred else "already_present",
            "writeOccurred": write_occurred,
        }
    if kind == "fact-cut-portable-v1":
        target = material.get("target") or {}
        ref_name = str(target.get("ref_name") or "")
        if ref_name:
            current = storage_service.fact_kernel(
                runtime_dir, "query", {"ref_name": ref_name}
            )
            if current.get("cut_root") == target.get("cut_root"):
                return {
                    "ok": True,
                    "status": "already_present",
                    "writeOccurred": False,
                    "observed_cut_root": current["cut_root"],
                    "bundle_root": material.get("bundle_root"),
                }
        return storage_service.fact_kernel_import(
            runtime_dir, dict(material), dry_run=False
        )
    if kind == "fact-library-v1":
        result = storage_service.fact_library_import(
            runtime_dir, dict(material), dry_run=False
        )
        write_occurred = any(
            row.get("status") != "already_present"
            for row in result.get("receipts") or []
        )
        return {
            **result,
            "status": (
                "imported"
                if result.get("ok") and write_occurred
                else ("already_present" if result.get("ok") else "rejected")
            ),
            "writeOccurred": write_occurred,
        }
    if kind == "project-cut-v1":
        return _project_cut_import_bundle(runtime_dir, material, execute=True)
    if kind == "product-release-cut-v1":
        try:
            return _PRODUCT_RELEASE_HISTORY.import_history(
                config_home or runtime_dir, material, execute=True
            )
        except product_release_history.ProductReleaseHistoryError as error:
            raise ExitBundleError(error.code, str(error), **error.details) from error
    if kind == "initiative-bundle-v1":
        from kungfu import initiative_bundle

        result = initiative_bundle.import_initiative_bundle(
            str(runtime_dir), dict(material), execute=True
        )
        write_occurred = any(
            row.get("status") != "already_present"
            for row in result.get("receipts") or []
        )
        return {
            **result,
            "ok": result.get("accepted") is True,
            "status": (
                "already_present"
                if result.get("accepted") is True and not write_occurred
                else "imported"
            ),
            "writeOccurred": write_occurred,
        }
    raise ExitBundleError("unsupported-member-kind", kind)


def _receipt(
    package: Mapping[str, Any],
    *,
    status: str,
    execute: bool,
    member_receipts: list[dict[str, Any]],
    already_present: list[str],
    written: list[str],
    remaining: list[str],
    failure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = package["manifest"]
    value: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "status": status,
        "ok": status in {"validated", "imported", "already_present"},
        "execute": execute,
        "bundleId": manifest["bundleId"],
        "bundleRoot": manifest["bundleRoot"],
        "packageRoot": package["packageRoot"],
        "alreadyPresent": already_present,
        "writtenMembers": written,
        "remainingMembers": remaining,
        "memberReceipts": member_receipts,
        "omissions": copy.deepcopy(manifest["omissions"]),
        "loss": copy.deepcopy(manifest["loss"]),
        "residualRisk": (
            []
            if status in {"validated", "imported", "already_present"}
            else [
                "Append-only domain writes listed in memberReceipts may remain after a partial import."
            ]
        ),
        "recoveryNextAction": (
            "none"
            if status in {"imported", "already_present"}
            else (
                "rerun validate-only after resolving the diagnosis"
                if status == "rejected"
                else "rerun the same exact package; completed member imports are idempotent"
            )
        ),
        "failure": failure,
    }
    value["receiptRoot"] = _root("receipt", value)
    try:
        contract_runtime.validate_json_schema(
            value, _contract()["receiptSchema"], "exit import receipt"
        )
    except ValueError as error:  # pragma: no cover - implementation invariant
        raise ExitBundleError("receipt-schema-invalid", str(error)) from error
    return value


def import_package(
    runtime_dir: str | Path,
    package: Mapping[str, Any],
    *,
    config_home: str | Path | None = None,
    execute: bool = False,
    authorized_by: str = "",
    _fault_after_member: int | None = None,
) -> dict[str, Any]:
    """Validate by default; explicitly execute after isolated full replay."""

    inspection = inspect(package)
    manifest = package["manifest"]
    ordered = sorted(
        manifest["members"],
        key=lambda row: (
            _KINDS[str(package["execution"][row["memberId"]]["kind"])]["rank"],
            row["memberId"],
        ),
    )
    member_ids = [str(row["memberId"]) for row in ordered]
    if not execute:
        return _receipt(
            package,
            status="validated",
            execute=False,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
        )
    if inspection["mode"] == "thin":
        return _receipt(
            package,
            status="rejected",
            execute=True,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
            failure={
                "code": "thin-materialization-forbidden",
                "message": "thin Exit packages are inventory-only",
            },
        )
    actor = authorized_by.strip()
    if not actor:
        return _receipt(
            package,
            status="rejected",
            execute=True,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
            failure={
                "code": "authorization-actor-required",
                "message": "explicit execute requires authorized_by",
            },
        )

    try:
        with tempfile.TemporaryDirectory(prefix="kungfu-exit-preflight-") as root:
            preflight_runtime = Path(root) / "runtime"
            for row in ordered:
                member_id = str(row["memberId"])
                execution = package["execution"][member_id]
                result = _apply_member(
                    preflight_runtime,
                    str(execution["kind"]),
                    package["materials"][member_id],
                    execution,
                    "kungfu-exit-preflight",
                    config_home=Path(root) / "config",
                )
                if result.get("ok") is not True:
                    raise ExitBundleError(
                        "isolated-preflight-failed",
                        f"isolated preflight rejected {member_id}",
                        memberId=member_id,
                        receipt=result,
                    )
    except (ExitBundleError, OSError, RuntimeError, ValueError) as error:
        failure = (
            error.diagnosis()
            if isinstance(error, ExitBundleError)
            else {"code": "isolated-preflight-failed", "message": str(error)}
        )
        return _receipt(
            package,
            status="rejected",
            execute=True,
            member_receipts=[],
            already_present=[],
            written=[],
            remaining=member_ids,
            failure=failure,
        )

    receipts: list[dict[str, Any]] = []
    already: list[str] = []
    written: list[str] = []
    for index, row in enumerate(ordered):
        member_id = str(row["memberId"])
        execution = package["execution"][member_id]
        if _fault_after_member is not None and index >= _fault_after_member:
            return _receipt(
                package,
                status="partial",
                execute=True,
                member_receipts=receipts,
                already_present=already,
                written=written,
                remaining=member_ids[index:],
                failure={
                    "code": "qualification-fault",
                    "message": "deterministic test fault after completed member",
                },
            )
        try:
            result = _apply_member(
                runtime_dir,
                str(execution["kind"]),
                package["materials"][member_id],
                execution,
                actor,
                config_home=config_home,
            )
        except (ExitBundleError, OSError, RuntimeError, ValueError) as error:
            failure = (
                error.diagnosis()
                if isinstance(error, ExitBundleError)
                else {"code": "member-import-failed", "message": str(error)}
            )
            return _receipt(
                package,
                status="partial" if receipts else "rejected",
                execute=True,
                member_receipts=receipts,
                already_present=already,
                written=written,
                remaining=member_ids[index:],
                failure={"memberId": member_id, **failure},
            )
        wrapped = {"memberId": member_id, "kind": execution["kind"], "receipt": result}
        receipts.append(wrapped)
        if result.get("ok") is not True:
            return _receipt(
                package,
                status="partial" if written else "rejected",
                execute=True,
                member_receipts=receipts,
                already_present=already,
                written=written,
                remaining=member_ids[index:],
                failure={
                    "code": "member-import-rejected",
                    "memberId": member_id,
                    "receipt": result,
                },
            )
        status = str(result.get("status") or "")
        if status in {"already_present", "already-present", "current"} or (
            result.get("writeOccurred") is False
        ):
            already.append(member_id)
        else:
            written.append(member_id)
    final_status = "already_present" if not written else "imported"
    return _receipt(
        package,
        status=final_status,
        execute=True,
        member_receipts=receipts,
        already_present=already,
        written=written,
        remaining=[],
    )


for _exit_name in (
    "_profile_source",
    "_apply_profile",
    "_apply_member",
    "_receipt",
    "import_package",
):
    globals()[_exit_name] = _exit_facade_seam(_exit_name)(globals()[_exit_name])
del _exit_name
