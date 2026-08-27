# SPDX-License-Identifier: Apache-2.0

"""Own installed CLI image inventory, selection, and bootstrap re-exec."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from kungfu import runtime_upgrade
from kungfu.coordination import locks as coordination_locks
from kungfu.distribution_update_policy import (
    CLI_IMAGE_SCHEMA,
    CLI_INVENTORY_FSCK_SCHEMA,
    CLI_SELECTION_SCHEMA,
    DistributionUpdateError,
    _CLI_SELECTION_PROCESS_LOCK,
    _cli_image_root,
    _cli_inventory_root,
    _cli_selection_path,
    _cli_selection_receipt_generations,
    _cli_selection_receipt_path,
    _content_root,
    _next_cli_generation,
    _path_safe_id,
    _persist_cli_selection_receipt,
    _read_cli_selection_receipt,
    _read_object,
    _write_object,
    compare_product_versions,
)


release_cut = runtime_upgrade


def _installed_cli_manifest(
    image: Mapping[str, Any],
) -> dict[str, Any]:
    root = Path(str(image["productRoot"])).expanduser().resolve()
    manifest = (root / str(image["upgradeManifest"])).resolve()
    if root not in manifest.parents or not manifest.is_file():
        raise DistributionUpdateError(
            "cli-image-invalid",
            "installed CLI image has no safe upgrade manifest",
        )
    return runtime_upgrade.validate_manifest(_read_object(manifest))


def _install_cli_image(
    product_root: Path,
    product: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    artifact_digest: str,
    config_home: str | Path,
) -> dict[str, Any]:
    entries = product.get("entries")
    if not isinstance(entries, Mapping):
        raise DistributionUpdateError(
            "product-layout-invalid", "CLI product entries are missing"
        )
    executable_relative = str(entries.get("runtime") or "")
    manifest_relative = str(entries.get("upgradeManifest") or "")
    if not executable_relative or not manifest_relative:
        raise DistributionUpdateError(
            "product-layout-invalid", "CLI product launch entries are missing"
        )
    frontend_build_id = str(manifest["frontendBuildId"])
    target = _cli_image_root(config_home, frontend_build_id)
    lock_root = _cli_inventory_root(config_home) / "locks"
    with coordination_locks.held(
        lock_root,
        frontend_build_id,
        label=f"cli-product-install:{frontend_build_id}",
    ):
        record_path = target / "image.json"
        if record_path.is_file():
            record = _read_object(record_path)
            if (
                record.get("schema") != CLI_IMAGE_SCHEMA
                or record.get("artifactDigest") != artifact_digest
            ):
                raise DistributionUpdateError(
                    "frontend-build-id-collision",
                    "CLI frontend build id already names different archive bytes",
                )
            return record
        staging = target.with_name(
            f".{frontend_build_id}.{os.getpid()}.{time.time_ns()}.partial"
        )
        try:
            shutil.copytree(product_root, staging, symlinks=True)
            executable = (staging / executable_relative).resolve()
            bundled_manifest = (staging / manifest_relative).resolve()
            if (
                staging.resolve() not in executable.parents
                or not executable.is_file()
                or staging.resolve() not in bundled_manifest.parents
                or not bundled_manifest.is_file()
            ):
                raise DistributionUpdateError(
                    "product-layout-invalid",
                    "CLI executable or bundled upgrade manifest escapes the product image",
                )
            runtime_root = (staging / executable_relative).parent
            try:
                observed_runtime_digest = runtime_upgrade.tree_digest(runtime_root)
            except runtime_upgrade.UpgradeError as error:
                raise DistributionUpdateError(error.code, str(error)) from error
            if observed_runtime_digest != manifest["runtimeArtifactDigest"]:
                raise DistributionUpdateError(
                    "runtime-artifact-invalid",
                    "staged CLI runtime digest does not match the release manifest",
                )
            _write_object(bundled_manifest, manifest)
            record = {
                "schema": CLI_IMAGE_SCHEMA,
                "frontendBuildId": frontend_build_id,
                "runtimeBuildId": manifest["runtimeBuildId"],
                "productVersion": manifest["productVersion"],
                "artifactDigest": artifact_digest,
                "productRoot": str(target),
                "executable": executable_relative,
                "productManifest": "product.json",
                "upgradeManifest": manifest_relative,
                **(
                    {
                        "manifestIdentityRoot": manifest["manifestIdentityRoot"],
                        "releaseCutRoot": manifest["releaseCutRoot"],
                        "platformSliceRoot": manifest["platformSliceRoot"],
                    }
                    if manifest.get("releaseCutRoot")
                    else {}
                ),
            }
            _write_object(staging / "image.json", record)
            os.replace(staging, target)
            return record
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def _assert_cli_image_slot_available(
    manifest: Mapping[str, Any],
    *,
    artifact_digest: str,
    config_home: str | Path,
) -> None:
    target = _cli_image_root(config_home, str(manifest["frontendBuildId"]))
    record_path = target / "image.json"
    if not record_path.is_file():
        return
    record = _read_object(record_path)
    if (
        record.get("schema") != CLI_IMAGE_SCHEMA
        or record.get("artifactDigest") != artifact_digest
    ):
        raise DistributionUpdateError(
            "frontend-build-id-collision",
            "CLI frontend build id already names different archive bytes",
        )


def _read_cli_selection(
    config_home: str | Path,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    selection_path = _cli_selection_path(config_home)
    if not selection_path.is_file():
        return None
    selection = _read_object(selection_path)
    if selection.get("schema") != CLI_SELECTION_SCHEMA:
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection schema is invalid"
        )
    generation = selection.get("generation")
    if generation is not None and (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
    ):
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection generation is invalid"
        )
    transition = selection.get("cutTransition")
    verified_transition = None
    if transition is not None:
        try:
            verified_transition = release_cut.validate_cut_transition(transition)
        except (TypeError, release_cut.ReleaseCutError) as error:
            raise DistributionUpdateError(
                "cli-selection-invalid",
                "CLI selection Cut Transition evidence is invalid",
            ) from error
        if verified_transition["cutTransitionRoot"] != selection.get(
            "cutTransitionRoot"
        ):
            raise DistributionUpdateError(
                "cli-selection-invalid",
                "CLI selection Cut Transition root disagrees with retained evidence",
            )
    if release_cut.is_legacy_bootstrap(selection):
        if not release_cut.legacy_selection_is_bound(selection, verified_transition):
            raise DistributionUpdateError(
                "cli-selection-invalid",
                "legacy bootstrap selection is not bound to exact recovery evidence",
            )
        return selection, {}
    frontend_build_id = _path_safe_id(
        str(selection.get("frontendBuildId") or ""), "frontend-build-id"
    )
    root = _cli_image_root(config_home, frontend_build_id)
    if Path(str(selection.get("productRoot") or "")).resolve() != root:
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection escaped the product inventory"
        )
    image = _read_object(root / "image.json")
    if (
        image.get("schema") != CLI_IMAGE_SCHEMA
        or image.get("frontendBuildId") != frontend_build_id
        or image.get("artifactDigest") != selection.get("artifactDigest")
        or image.get("runtimeBuildId") != selection.get("runtimeBuildId")
        or image.get("releaseCutRoot") != selection.get("releaseCutRoot")
        or image.get("platformSliceRoot") != selection.get("platformSliceRoot")
        or Path(str(image.get("productRoot") or "")).resolve() != root
    ):
        raise DistributionUpdateError(
            "cli-selection-invalid", "CLI selection and image evidence disagree"
        )
    return selection, image


def _select_cli_image(
    image: Mapping[str, Any],
    *,
    config_home: str | Path,
    cut_decision: Mapping[str, Any] | None = None,
    cut_transition: Mapping[str, Any] | None = None,
    bootstrap_rollback: Mapping[str, Any] | None = None,
    receipt_factory: Callable[[dict[str, Any]], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    lock_root = _cli_inventory_root(config_home) / "locks"
    with _CLI_SELECTION_PROCESS_LOCK:
        with coordination_locks.held(
            lock_root,
            "current-selection",
            label="cli-product-select:current",
        ):

            def finish_selection(
                selection: dict[str, Any],
            ) -> tuple[dict[str, Any], dict[str, Any]]:
                receipt = receipt_factory(selection)
                _persist_cli_selection_receipt(config_home, selection, receipt)
                try:
                    _write_object(_cli_selection_path(config_home), selection)
                except OSError as error:
                    raise DistributionUpdateError(
                        "selection-io-failed",
                        "CLI selection could not be published; the prior selection remains authoritative",
                    ) from error
                return selection, receipt

            current = _read_cli_selection(config_home)
            if current is not None:
                current_selection, current_image = current
                current_cut = current_selection.get("releaseCutRoot")
                target_cut = image.get("releaseCutRoot")
                cut_movement_authorized = False
                if current_cut is not None or target_cut is not None:
                    if not current_cut or not target_cut:
                        raise DistributionUpdateError(
                            "release-cut-binding-incomplete",
                            "CLI image transition mixes Cut-aware and legacy identities",
                        )
                    if current_cut != target_cut and (
                        not isinstance(cut_decision, Mapping)
                        or cut_decision.get("updateAllowed") is not True
                        or cut_decision.get("currentReleaseCutRoot") != current_cut
                        or cut_decision.get("targetReleaseCutRoot") != target_cut
                    ):
                        raise DistributionUpdateError(
                            "release-cut-transition-required",
                            "CLI image selection requires an authorized Cut Transition",
                        )
                    cut_movement_authorized = current_cut != target_cut
                    if current_cut == target_cut:
                        if (
                            current_image["frontendBuildId"] != image["frontendBuildId"]
                            or current_image["artifactDigest"]
                            != image["artifactDigest"]
                        ):
                            raise DistributionUpdateError(
                                "release-cut-image-collision",
                                "one Release Cut names different CLI image evidence",
                            )
                        return current_selection, None
                if not cut_movement_authorized:
                    version_order = compare_product_versions(
                        str(
                            current_image.get("productVersion")
                            or current_selection.get("productVersion")
                            or ""
                        ),
                        str(image["productVersion"]),
                    )
                    if version_order > 0:
                        return current_selection, None
                    if version_order == 0:
                        if (
                            current_image["frontendBuildId"] != image["frontendBuildId"]
                            or current_image["artifactDigest"]
                            != image["artifactDigest"]
                        ):
                            raise DistributionUpdateError(
                                "frontend-version-collision",
                                "one CLI product version names different image evidence",
                            )
                        else:
                            return current_selection, None
            previous = current[0] if current is not None else None
            generation = _next_cli_generation(
                config_home, int((previous or {}).get("generation") or 0)
            )
            if previous is None:
                rollback = bootstrap_rollback
            elif release_cut.is_legacy_bootstrap(previous):
                rollback = release_cut.legacy_coordinate(
                    previous["releaseCutRoot"], previous["productVersion"]
                )
            else:
                rollback = release_cut.image_coordinate(previous)
            selection = release_cut.image_selection(
                image,
                schema=CLI_SELECTION_SCHEMA,
                generation=generation,
                transition_root=(
                    cut_decision.get("cutTransitionRoot")
                    if isinstance(cut_decision, Mapping)
                    else None
                ),
                transition=cut_transition,
                previous_frontend_build_id=(
                    previous.get("frontendBuildId") if previous is not None else None
                ),
                rollback=rollback,
            )
            return finish_selection(selection)


def cli_inventory_fsck(config_home: str | Path) -> dict[str, Any]:
    root = _cli_inventory_root(config_home)
    images_root = root / "images"
    images: list[dict[str, Any]] = []
    retained_partials: list[str] = []
    issues: list[dict[str, str]] = []
    if images_root.is_dir():
        for entry in sorted(images_root.iterdir(), key=lambda value: value.name):
            relative = str(entry.relative_to(root))
            if entry.name.startswith(".") and entry.name.endswith(".partial"):
                retained_partials.append(relative)
                continue
            try:
                if entry.is_symlink() or not entry.is_dir():
                    raise DistributionUpdateError(
                        "cli-image-path-unsafe",
                        "CLI image inventory entry is not a real directory",
                    )
                image = _read_object(entry / "image.json")
                frontend_build_id = _path_safe_id(
                    str(image.get("frontendBuildId") or ""),
                    "frontend-build-id",
                )
                if (
                    image.get("schema") != CLI_IMAGE_SCHEMA
                    or frontend_build_id != entry.name
                    or Path(str(image.get("productRoot") or "")).resolve()
                    != entry.resolve()
                ):
                    raise DistributionUpdateError(
                        "cli-image-invalid",
                        "CLI image identity or product root is invalid",
                    )
                executable = (entry / str(image.get("executable") or "")).resolve()
                bundled_manifest = (
                    entry / str(image.get("upgradeManifest") or "")
                ).resolve()
                if (
                    entry.resolve() not in executable.parents
                    or not executable.is_file()
                    or entry.resolve() not in bundled_manifest.parents
                    or not bundled_manifest.is_file()
                ):
                    raise DistributionUpdateError(
                        "cli-image-invalid",
                        "CLI image executable or release manifest is missing or unsafe",
                    )
                images.append(
                    {
                        "frontendBuildId": frontend_build_id,
                        "runtimeBuildId": image["runtimeBuildId"],
                        "productVersion": image["productVersion"],
                        "artifactDigest": image["artifactDigest"],
                        "productRoot": image["productRoot"],
                        "releaseCutRoot": image.get("releaseCutRoot"),
                        "platformSliceRoot": image.get("platformSliceRoot"),
                    }
                )
            except (
                DistributionUpdateError,
                KeyError,
                OSError,
                TypeError,
                ValueError,
            ) as error:
                issues.append(
                    {
                        "code": getattr(error, "code", "cli-image-unreadable"),
                        "path": relative,
                    }
                )
    selection = selected_receipt_root = None
    retained_receipts: list[dict[str, Any]] = []
    pending_receipts: list[dict[str, Any]] = []
    selection_path_exists = _cli_selection_path(config_home).is_file()
    try:
        selected = _read_cli_selection(config_home)
        if selected is not None:
            selection = selected[0]
            receipt = _read_cli_selection_receipt(config_home, selection)
            if receipt is not None:
                selected_receipt_root = receipt["receiptRoot"]
            elif selection.get("releaseCutRoot"):
                issues.append(
                    {
                        "code": "cli-selection-receipt-missing",
                        "path": str(
                            _cli_selection_receipt_path(
                                config_home, int(selection["generation"])
                            ).relative_to(root)
                        ),
                    }
                )
    except DistributionUpdateError as error:
        issues.append(
            {
                "code": error.code,
                "path": str(_cli_selection_path(config_home).relative_to(root)),
            }
        )
    selected_generation = int((selection or {}).get("generation") or 0)
    try:
        for generation in _cli_selection_receipt_generations(config_home):
            if generation == selected_generation:
                continue
            path = _cli_selection_receipt_path(config_home, generation)
            try:
                receipt = _read_object(path)
                receipt_selection = receipt.get("frontendSelection")
                receipt_root = receipt.get("receiptRoot")
                receipt_core = {
                    key: value for key, value in receipt.items() if key != "receiptRoot"
                }
                if (
                    not isinstance(receipt_selection, Mapping)
                    or int(receipt_selection.get("generation") or 0) != generation
                    or not isinstance(receipt_root, str)
                    or receipt_root != _content_root(receipt_core)
                ):
                    raise DistributionUpdateError(
                        "cli-selection-receipt-invalid",
                        "CLI selection receipt does not verify against its generation",
                    )
                retained = {
                    "generation": generation,
                    "receiptRoot": receipt_root,
                    "frontendBuildId": receipt_selection.get("frontendBuildId"),
                }
                retained_receipts.append(retained)
                if generation > selected_generation and (
                    selection is not None or not selection_path_exists
                ):
                    pending_receipts.append(retained)
                    issues.append(
                        {
                            "code": "cli-selection-publication-pending",
                            "path": str(path.relative_to(root)),
                        }
                    )
            except (DistributionUpdateError, OSError, TypeError, ValueError) as error:
                issues.append(
                    {
                        "code": getattr(error, "code", "cli-receipt-unreadable"),
                        "path": str(path.relative_to(root)),
                    }
                )
    except DistributionUpdateError as error:
        issues.append(
            {
                "code": error.code,
                "path": "receipts",
            }
        )
    return {
        "schema": CLI_INVENTORY_FSCK_SCHEMA,
        "ok": not issues,
        "selected": selection,
        "selectedReceiptRoot": selected_receipt_root,
        "images": images,
        "retainedPartials": retained_partials,
        "retainedReceipts": retained_receipts,
        "pendingReceipts": pending_receipts,
        "issues": issues,
        "recoveryAction": (
            None
            if not issues
            else "Keep the last known-good image and rerun `kungfu update --check` before recovery."
        ),
    }


def selected_cli_command(
    env: Mapping[str, str] | None = None,
    *,
    current_executable: str | Path | None = None,
) -> tuple[list[str], dict[str, str]] | None:
    """Resolve an archive-selected CLI image for the stable bootstrap process."""

    env = os.environ if env is None else env
    if env.get("KUNGFU_INSTALL_SOURCE") != "archive":
        return None
    config_home = Path(env.get("KF_CONFIG_HOME") or "~/.kungfu-config").expanduser()
    if (selected := _read_cli_selection(config_home)) is None:
        return None
    selection, image = selected
    if release_cut.is_legacy_bootstrap(selection):
        return None
    frontend_build_id = str(selection["frontendBuildId"])
    root = _cli_image_root(config_home, frontend_build_id)
    executable = (root / str(image.get("executable") or "")).resolve()
    if root not in executable.parents or not executable.is_file():
        raise DistributionUpdateError(
            "cli-selection-invalid", "selected CLI executable is missing or unsafe"
        )
    current = Path(current_executable or sys.executable).resolve()
    selected_id = env.get("KUNGFU_SELECTED_FRONTEND_BUILD_ID")
    if current == executable or selected_id == frontend_build_id:
        return None
    selected_env = dict(env)
    selected_env.update(
        {
            "KUNGFU_SELECTED_FRONTEND_BUILD_ID": frontend_build_id,
            "KUNGFU_DIR": str(executable.parent),
            "KUNGFU_PRODUCT_MANIFEST": str(root / image["productManifest"]),
            "KUNGFU_UPGRADE_MANIFEST": str(root / image["upgradeManifest"]),
            "KF_BUNDLED_EXTENSION_ROOT": str(root / "extensions"),
            "KUNGFU_AGENT_SESSION_EXECUTABLE": str(executable),
            "KUNGFU_CONTROLLER_ENTRYPOINT": str(executable),
        }
    )
    if selection.get("releaseCutRoot"):
        selected_env["KUNGFU_SELECTED_RELEASE_CUT_ROOT"] = str(
            selection["releaseCutRoot"]
        )
        selected_env["KUNGFU_SELECTED_PLATFORM_SLICE_ROOT"] = str(
            selection["platformSliceRoot"]
        )
    return [str(executable), *sys.argv[1:]], selected_env


def reexec_selected_cli() -> None:
    selected = selected_cli_command()
    if selected is not None:
        argv, env = selected
        if sys.platform == "win32":
            raise SystemExit(subprocess.run(argv, env=env, check=False).returncode)
        os.execve(argv[0], argv, env)
