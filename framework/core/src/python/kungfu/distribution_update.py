# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import json
import os
import re
import shutil as shutil
import subprocess
import sys as sys
import tempfile
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast

from kungfu import runtime_upgrade
from kungfu.coordination import locks as coordination_locks

from kungfu.distribution_update_planning import (
    _finish_orchestration_plan as _finish_orchestration_plan,
    _orchestration_plan_identity as _orchestration_plan_identity,
    _orchestration_receipt_path as _orchestration_receipt_path,
    check_release as check_release,
    plan_download as plan_download,
    plan_update as plan_update,
    record_update_outcome as record_update_outcome,
    validate_update_plan as validate_update_plan,
)
from kungfu.distribution_update_policy import (
    APPLY_SCHEMA as APPLY_SCHEMA,
    CHECK_SCHEMA as CHECK_SCHEMA,
    CLI_IMAGE_SCHEMA as CLI_IMAGE_SCHEMA,
    CLI_INVENTORY_FSCK_SCHEMA as CLI_INVENTORY_FSCK_SCHEMA,
    CLI_ROLLBACK_SCHEMA as CLI_ROLLBACK_SCHEMA,
    CLI_SELECTION_SCHEMA as CLI_SELECTION_SCHEMA,
    DOWNLOAD_PLAN_SCHEMA as DOWNLOAD_PLAN_SCHEMA,
    DOWNLOAD_RECEIPT_SCHEMA as DOWNLOAD_RECEIPT_SCHEMA,
    MAX_MANIFEST_BYTES as MAX_MANIFEST_BYTES,
    ORCHESTRATION_PLAN_SCHEMA as ORCHESTRATION_PLAN_SCHEMA,
    ORCHESTRATION_RECEIPT_SCHEMA as ORCHESTRATION_RECEIPT_SCHEMA,
    UNQUALIFIED as UNQUALIFIED,
    DistributionUpdateError as DistributionUpdateError,
    _artifact as _artifact,
    _assert_cli_publication as _assert_cli_publication,
    _assert_release_target as _assert_release_target,
    _canonical as _canonical,
    _CLI_DOWNLOAD_PROCESS_LOCK as _CLI_DOWNLOAD_PROCESS_LOCK,
    _CLI_SELECTION_PROCESS_LOCK as _CLI_SELECTION_PROCESS_LOCK,
    _cli_image_root as _cli_image_root,
    _cli_inventory_root as _cli_inventory_root,
    _cli_selection_path as _cli_selection_path,
    _cli_selection_receipt_generations as _cli_selection_receipt_generations,
    _cli_selection_receipt_path as _cli_selection_receipt_path,
    _command_argv as _command_argv,
    _content_root as _content_root,
    _CONTENT_RANGE as _CONTENT_RANGE,
    _DOWNLOAD_CHUNK_BYTES as _DOWNLOAD_CHUNK_BYTES,
    _downgrade_refusal as _downgrade_refusal,
    _INSTALL_SOURCES as _INSTALL_SOURCES,
    _MANAGER_COMMAND_TIMEOUT_SECONDS as _MANAGER_COMMAND_TIMEOUT_SECONDS,
    _MAX_ARCHIVE_ENTRIES as _MAX_ARCHIVE_ENTRIES,
    _MAX_ARCHIVE_EXPANDED_BYTES as _MAX_ARCHIVE_EXPANDED_BYTES,
    _MAX_ARCHIVE_EXPANSION_RATIO as _MAX_ARCHIVE_EXPANSION_RATIO,
    _MIN_ARCHIVE_EXPANDED_BYTES as _MIN_ARCHIVE_EXPANDED_BYTES,
    _next_cli_generation as _next_cli_generation,
    _normalize_platform as _normalize_platform,
    _optional_file_digest as _optional_file_digest,
    _PACKAGE_MANAGER_COMMANDS as _PACKAGE_MANAGER_COMMANDS,
    _package_manager_commands as _package_manager_commands,
    _package_manager_failure_code as _package_manager_failure_code,
    _parse_product_version as _parse_product_version,
    _path_safe_id as _path_safe_id,
    _persist_cli_selection_receipt as _persist_cli_selection_receipt,
    _read_cli_selection_receipt as _read_cli_selection_receipt,
    _read_json_object as _read_json_object,
    _read_object as _read_object,
    _read_shifu_env as _read_shifu_env,
    _SEMVER as _SEMVER,
    _stable_id as _stable_id,
    _VERIFICATION_COMMAND_TIMEOUT_SECONDS as _VERIFICATION_COMMAND_TIMEOUT_SECONDS,
    _write_object as _write_object,
    compare_product_versions as compare_product_versions,
    install_source as install_source,
    local_dogfood_residency as local_dogfood_residency,
)
from kungfu._distribution_update.download import (
    _HttpsOnlyRedirectHandler as _HttpsOnlyRedirectHandler,
    _account_archive_member as _account_archive_member_dispatch,
    _archive_expanded_limit as _archive_expanded_limit_dispatch,
    _assert_https_response as _assert_https_response_dispatch,
    _assert_tar_member as _assert_tar_member_dispatch,
    _assert_zip_member as _assert_zip_member_dispatch,
    _copy_bounded_download as _copy_bounded_download_dispatch,
    _discard_poisoned_partial as _discard_poisoned_partial_dispatch,
    _download_response_appends as _download_response_appends_dispatch,
    _download_to_partial as _download_to_partial_dispatch,
    _extract_archive as _extract_archive,
    _file_digest as _file_digest_dispatch,
    _open_https as _open_https_dispatch,
    _safe_member as _safe_member_dispatch,
    _stage_verified_archive as _stage_verified_archive_dispatch,
    _validate_archive as _validate_archive_impl,
    download as _download_impl,
)
from kungfu._distribution_update.cli import (
    _assert_cli_image_slot_available as _assert_cli_image_slot_available,
    _install_cli_image as _install_cli_image_impl,
    _installed_cli_manifest as _installed_cli_manifest,
    _read_cli_selection as _read_cli_selection,
    _select_cli_image as _select_cli_image_impl,
    cli_inventory_fsck as cli_inventory_fsck,
    selected_cli_command as selected_cli_command,
)

release_cut = runtime_upgrade


def _owner_fallback(dispatch: Callable[..., Any]) -> Callable[..., Any]:
    """Expose the typed implementation retained by the owner dispatch."""

    return cast(Callable[..., Any], getattr(dispatch, "__wrapped__"))


_account_archive_member = _owner_fallback(_account_archive_member_dispatch)
_archive_expanded_limit = _owner_fallback(_archive_expanded_limit_dispatch)
_assert_https_response = _owner_fallback(_assert_https_response_dispatch)
_assert_tar_member = _owner_fallback(_assert_tar_member_dispatch)
_assert_zip_member = _owner_fallback(_assert_zip_member_dispatch)
_copy_bounded_download = _owner_fallback(_copy_bounded_download_dispatch)
_discard_poisoned_partial = _owner_fallback(_discard_poisoned_partial_dispatch)
_download_response_appends = _owner_fallback(_download_response_appends_dispatch)
_download_to_partial = _owner_fallback(_download_to_partial_dispatch)
_file_digest = _owner_fallback(_file_digest_dispatch)
_open_https = _owner_fallback(_open_https_dispatch)
_safe_member = _owner_fallback(_safe_member_dispatch)
_stage_verified_archive = _owner_fallback(_stage_verified_archive_dispatch)


def download(
    plan: Mapping[str, Any], *, expected_plan_id: str, execute: bool
) -> dict[str, Any]:
    return _download_impl(
        plan,
        expected_plan_id=expected_plan_id,
        execute=execute,
    )


def _validate_archive(archive: Path, *, archive_size: int) -> tuple[str, list[Any]]:
    return _validate_archive_impl(
        archive,
        archive_size=archive_size,
    )


def _install_cli_image(
    product_root: Path,
    product: Mapping[str, Any],
    manifest: Mapping[str, Any],
    *,
    artifact_digest: str,
    config_home: str | Path,
) -> dict[str, Any]:
    return _install_cli_image_impl(
        product_root,
        product,
        manifest,
        artifact_digest=artifact_digest,
        config_home=config_home,
    )


def _select_cli_image(
    image: Mapping[str, Any],
    *,
    config_home: str | Path,
    cut_decision: Mapping[str, Any] | None = None,
    cut_transition: Mapping[str, Any] | None = None,
    bootstrap_rollback: Mapping[str, Any] | None = None,
    receipt_factory: Callable[[dict[str, Any]], dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    return _select_cli_image_impl(
        image,
        config_home=config_home,
        cut_decision=cut_decision,
        cut_transition=cut_transition,
        bootstrap_rollback=bootstrap_rollback,
        receipt_factory=receipt_factory,
    )


def reexec_selected_cli() -> None:
    selected = selected_cli_command()
    if selected is not None:
        argv, env = selected
        if sys.platform == "win32":
            raise SystemExit(subprocess.run(argv, env=env, check=False).returncode)
        os.execve(argv[0], argv, env)


def load_release_manifest(reference: str | Path) -> tuple[dict[str, Any], bool]:
    text_reference = str(reference)
    parsed = urllib.parse.urlparse(text_reference)
    remote = parsed.scheme in {"http", "https"}
    if remote:
        if parsed.scheme != "https":
            raise DistributionUpdateError(
                "manifest-transport-insecure", "release manifests require HTTPS"
            )
        try:
            with _open_https(
                text_reference,
                timeout=30,
                code="manifest-transport-insecure",
                message="release manifest redirect requires HTTPS",
            ) as response:
                _assert_https_response(
                    response,
                    code="manifest-transport-insecure",
                    message="release manifest redirect requires HTTPS",
                )
                payload = response.read(MAX_MANIFEST_BYTES + 1)
        except OSError as error:
            raise DistributionUpdateError(
                "manifest-download-failed", "could not download release manifest"
            ) from error
        if len(payload) > MAX_MANIFEST_BYTES:
            raise DistributionUpdateError(
                "manifest-too-large", "release manifest exceeds the size limit"
            )
        try:
            value = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DistributionUpdateError(
                "manifest-invalid", "release manifest is invalid JSON"
            ) from error
    else:
        path = (
            Path(urllib.request.url2pathname(parsed.path))
            if parsed.scheme == "file"
            else Path(text_reference)
        )
        value = _read_object(path.expanduser().resolve())
    if not isinstance(value, dict):
        raise DistributionUpdateError(
            "manifest-invalid", "release manifest is not an object"
        )
    return runtime_upgrade.validate_manifest(value), remote


def _version_in_output(output: str, target_version: str) -> bool:
    pattern = re.compile(
        rf"(?<![0-9A-Za-z.+-]){re.escape(target_version)}(?![0-9A-Za-z.+-])"
    )
    return pattern.search(output) is not None


def _source_command_environment(
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    source = os.environ if env is None else env
    allowed = {
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOGNAME",
        "PATH",
        "PATHEXT",
        "SHELL",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "WINDIR",
    }
    return {key: value for key, value in source.items() if key in allowed}


def execute_update(
    plan: Mapping[str, Any],
    *,
    expected_plan_id: str,
    current_version: str,
    config_home: str | Path,
    command_runner: Any = subprocess.run,
    activation_planner: Any = None,
) -> dict[str, Any]:
    """Execute exactly one bound source-owned action and retain its receipt."""

    value = validate_update_plan(plan, expected_plan_id=expected_plan_id)
    if value["state"] != "update-available":
        raise DistributionUpdateError(
            "plan-not-applicable", "update orchestration plan is not executable"
        )
    try:
        if value["action"] == "archive-self-update":
            download_plan = value["downloadPlan"]
            download_receipt = download(
                download_plan,
                expected_plan_id=download_plan["planId"],
                execute=True,
            )
            applied = apply_archive(
                value["manifest"],
                download_receipt["artifactPath"],
                current_version=current_version,
                config_home=config_home,
                expected_digest=download_receipt["artifactDigest"],
                execute=True,
                cut_decision=value["check"].get("cutDecision"),
                cut_transition=value.get("cutTransition"),
            )
            execution = {
                "action": "archive-self-update",
                "download": download_receipt,
                "apply": applied,
            }
        elif value["action"] == "package-manager":
            command, verification = _package_manager_commands(
                str(value["installSource"].get("source") or ""),
                value["installSource"].get("managerCommand"),
                value["installSource"].get("verificationCommand"),
            )
            if command is None or verification is None:
                raise DistributionUpdateError(
                    "package-manager-contract-incomplete",
                    "package-manager update plan is missing its exact local argv contract",
                )
            completed = command_runner(
                command,
                check=False,
                capture_output=True,
                env=_source_command_environment(),
                text=True,
                shell=False,
                timeout=_MANAGER_COMMAND_TIMEOUT_SECONDS,
            )
            if completed.returncode != 0:
                code, message = _package_manager_failure_code(completed.stderr)
                raise DistributionUpdateError(
                    code,
                    message,
                )
            verified = command_runner(
                verification,
                check=False,
                capture_output=True,
                env=_source_command_environment(),
                text=True,
                shell=False,
                timeout=_VERIFICATION_COMMAND_TIMEOUT_SECONDS,
            )
            if verified.returncode != 0 or not _version_in_output(
                str(verified.stdout), value["targetVersion"]
            ):
                raise DistributionUpdateError(
                    "update-verification-failed",
                    "package manager completed but the target version did not verify",
                )
            execution = {
                "action": "package-manager",
                "managerReturnCode": completed.returncode,
                "verificationReturnCode": verified.returncode,
                "verifiedVersion": value["targetVersion"],
            }
        else:
            raise DistributionUpdateError(
                "unsupported-source", "install source has no executable update adapter"
            )
        activation = (
            activation_planner(value["manifest"])
            if activation_planner is not None
            else None
        )
        return record_update_outcome(
            value,
            config_home=config_home,
            state="complete",
            reason_code="update-verified",
            result={**execution, "activationPlan": activation},
        )
    except DistributionUpdateError as error:
        error.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=error.code,
        )
        raise
    except runtime_upgrade.UpgradeError as error:
        wrapped = DistributionUpdateError(error.code, str(error))
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=error.code,
        )
        raise wrapped from error
    except subprocess.TimeoutExpired as error:
        wrapped = DistributionUpdateError(
            "update-command-timeout",
            "source-owned update command exceeded its bounded execution time",
        )
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=wrapped.code,
        )
        raise wrapped from error
    except OSError as error:
        code = (
            "package-manager-unavailable"
            if value.get("action") == "package-manager"
            else "update-command-unavailable"
        )
        wrapped = DistributionUpdateError(
            code,
            "source-owned update command could not be started",
        )
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="failed",
            reason_code=wrapped.code,
        )
        raise wrapped from error
    except KeyboardInterrupt as error:
        wrapped = DistributionUpdateError(
            "update-cancelled",
            "update cancelled before package-manager verification completed",
        )
        wrapped.receipt = record_update_outcome(
            value,
            config_home=config_home,
            state="cancelled",
            reason_code=wrapped.code,
        )
        raise wrapped from error


_IDENTITY_FIELDS = (
    "schema",
    "productVersion",
    "releaseChannel",
    "sourceCommit",
    "runtimeBuildId",
    "runtimeArtifactDigest",
    "runtimeEntrypoint",
    "frontendBuildId",
    "controlProtocolRange",
    "peerWireProtocolRange",
    "journalSchemaReadRange",
    "journalSchemaWriteVersion",
    "migrationClass",
    "rollbackClass",
    "minimumSupportedFrontend",
    "minimumSupportedRuntime",
    "platform",
    "architecture",
)
_CUT_IDENTITY_FIELDS = (
    "manifestIdentityRoot",
    "releaseCut",
    "releaseCutRoot",
    "platformSliceRoot",
)


def apply_archive(
    manifest: Mapping[str, Any],
    archive: str | Path,
    *,
    current_version: str,
    config_home: str | Path,
    expected_digest: str,
    execute: bool,
    cut_decision: Mapping[str, Any] | None = None,
    cut_transition: Mapping[str, Any] | None = None,
    allow_shifu_local: bool = False,
    bootstrap_release_cut_root: str | None = None,
    bootstrap_version: str | None = None,
) -> dict[str, Any]:
    value = runtime_upgrade.validate_manifest(manifest)
    _assert_release_target(value)
    if compare_product_versions(value["productVersion"], current_version) < 0:
        return {
            "schema": APPLY_SCHEMA,
            **_downgrade_refusal(value, current_version),
        }
    target_cut = value.get("releaseCut")
    verified_cut_decision = None
    if target_cut is not None:
        selected = _read_cli_selection(config_home)
        if selected is None:
            installed_cut = bootstrap_release_cut_root
            installed_version = bootstrap_version
        else:
            installed_cut = selected[0].get("releaseCutRoot")
            installed_version = selected[1].get("productVersion") or selected[0].get(
                "productVersion"
            )
        if not installed_cut or not installed_version:
            raise DistributionUpdateError(
                "current-release-cut-unknown",
                "Cut-aware CLI installation requires an exact current Release Cut",
            )
        try:
            verified_cut_decision = release_cut.decide_cut_transition(
                current_release_cut_root=str(installed_cut),
                current_version=str(installed_version),
                target_cut=target_cut,
                transition=cut_transition,
            )
        except release_cut.ReleaseCutError as error:
            raise DistributionUpdateError(error.code, str(error)) from error
        if cut_decision is not None and _canonical(verified_cut_decision) != _canonical(
            cut_decision
        ):
            raise DistributionUpdateError(
                "cut-decision-mismatch",
                "applied Cut Transition differs from the planned decision",
            )
        if verified_cut_decision["updateAllowed"] is not True:
            raise DistributionUpdateError(
                verified_cut_decision["reasonCode"],
                "Cut Transition does not authorize CLI image selection",
            )
        trust_domain = target_cut["publicationPolicy"]["trustDomain"]
        if trust_domain == "shifu-local":
            if not allow_shifu_local:
                raise DistributionUpdateError(
                    "local-release-policy-required",
                    "shifu-local artifacts require the explicit local updater adapter",
                )
            if (
                target_cut["publicationPolicy"]["publicationEligible"]
                or cut_transition is None
                or cut_transition["authorization"]["publicationEligible"]
            ):
                raise DistributionUpdateError(
                    "local-release-publication-eligible",
                    "local dogfood evidence cannot authorize public publication",
                )
        elif allow_shifu_local:
            raise DistributionUpdateError(
                "local-release-policy-mismatch",
                "the local updater adapter accepts only shifu-local Release Cuts",
            )
        else:
            _assert_cli_publication(value)
    elif allow_shifu_local:
        raise DistributionUpdateError(
            "local-release-cut-missing",
            "shifu-local installation requires a Product Release Cut",
        )
    else:
        _assert_cli_publication(value)
    artifact = _artifact(value, "cli")
    archive_path = Path(archive).expanduser().resolve()
    try:
        observed_size = archive_path.stat().st_size
        observed_digest = _file_digest(archive_path)
    except OSError as error:
        raise DistributionUpdateError(
            "artifact-io-failed", "CLI archive could not be read"
        ) from error
    if (
        observed_size != int(artifact["size"])
        or expected_digest != artifact["digest"]
        or observed_digest != expected_digest
    ):
        raise DistributionUpdateError(
            "artifact-verification-failed",
            "CLI archive size or digest is stale or invalid",
        )
    if not execute:
        _validate_archive(archive_path, archive_size=observed_size)
        return {
            "schema": APPLY_SCHEMA,
            "state": "action-required",
            "reasonCode": "execute-required",
            "runtimeBuildId": value["runtimeBuildId"],
            "artifactPath": str(archive_path),
            "artifactDigest": observed_digest,
            "currentReleaseCutRoot": (
                verified_cut_decision.get("currentReleaseCutRoot")
                if verified_cut_decision
                else None
            ),
            "targetReleaseCutRoot": value.get("releaseCutRoot"),
            "cutTransitionRoot": (
                verified_cut_decision.get("cutTransitionRoot")
                if verified_cut_decision
                else None
            ),
            "executeRequired": True,
            "documentationUrl": value["documentationUrl"],
        }
    with tempfile.TemporaryDirectory(prefix="kungfu-cli-apply-") as tmp:
        root = Path(tmp)
        snapshot = root / "snapshot" / "archive"
        _stage_verified_archive(
            archive_path,
            snapshot,
            expected_size=observed_size,
            expected_digest=observed_digest,
        )
        archive_type, archive_members = _validate_archive(
            snapshot, archive_size=observed_size
        )
        contents = root / "contents"
        contents.mkdir()
        _extract_archive(
            snapshot,
            contents,
            archive_type=archive_type,
            members=archive_members,
        )
        product_files = list(contents.glob("*/product.json"))
        if len(product_files) != 1:
            raise DistributionUpdateError(
                "product-layout-invalid", "CLI archive has no unique product root"
            )
        product_root = product_files[0].parent
        product = _read_object(product_files[0])
        if product.get("schema") != "kungfu.product.cli/v1":
            raise DistributionUpdateError(
                "product-layout-invalid", "CLI product manifest schema is invalid"
            )
        entries = product.get("entries")
        if not isinstance(entries, Mapping):
            raise DistributionUpdateError(
                "product-layout-invalid", "CLI product entries are missing"
            )
        runtime_root = (product_root / str(entries.get("runtime", ""))).parent
        bundled_path = product_root / str(entries.get("upgradeManifest", ""))
        bundled = runtime_upgrade.validate_manifest(_read_object(bundled_path))
        if any(bundled.get(field) != value.get(field) for field in _IDENTITY_FIELDS):
            raise DistributionUpdateError(
                "release-identity-mismatch",
                "CLI archive and release manifest describe different builds",
            )
        if value.get("manifestIdentityRoot") and (
            bundled.get("manifestIdentityRoot") != value["manifestIdentityRoot"]
            or release_cut.manifest_identity_root(bundled)
            != value["manifestIdentityRoot"]
        ):
            raise DistributionUpdateError(
                "release-manifest-identity-mismatch",
                "CLI archive bootstrap identity differs from the final Release Cut",
            )
        _assert_cli_image_slot_available(
            value,
            artifact_digest=observed_digest,
            config_home=config_home,
        )
        install_plan = runtime_upgrade.plan_install(value, runtime_root, config_home)
        if install_plan["state"] != "download-allowed":
            raise DistributionUpdateError(
                "runtime-artifact-invalid", "bundled runtime digest is invalid"
            )
        image = runtime_upgrade.install_image(
            install_plan,
            expected_plan_id=install_plan["planId"],
            config_home=config_home,
        )
        frontend_image = _install_cli_image(
            product_root,
            product,
            value,
            artifact_digest=observed_digest,
            config_home=config_home,
        )

    def receipt_for_selection(selection: dict[str, Any]) -> dict[str, Any]:
        receipt = {
            "schema": APPLY_SCHEMA,
            "state": "complete",
            "reasonCode": "runtime-installed",
            "runtimeImage": image,
            "frontendImage": frontend_image,
            "frontendSelection": selection,
            "frontendAction": "selected-on-next-command",
            "currentReleaseCutRoot": (
                verified_cut_decision.get("currentReleaseCutRoot")
                if verified_cut_decision
                else None
            ),
            "targetReleaseCutRoot": value.get("releaseCutRoot"),
            "cutTransitionRoot": (
                verified_cut_decision.get("cutTransitionRoot")
                if verified_cut_decision
                else None
            ),
            "cutTransition": (
                copy.deepcopy(dict(cut_transition))
                if cut_transition is not None
                else None
            ),
            "documentationUrl": value["documentationUrl"],
        }
        return {**receipt, "receiptRoot": _content_root(receipt)}

    selection, receipt = _select_cli_image(
        frontend_image,
        config_home=config_home,
        cut_decision=verified_cut_decision or cut_decision,
        cut_transition=cut_transition,
        receipt_factory=receipt_for_selection,
        bootstrap_rollback=(
            release_cut.legacy_coordinate(bootstrap_release_cut_root, bootstrap_version)
            if bootstrap_release_cut_root and bootstrap_version
            else None
        ),
    )
    return receipt if receipt is not None else receipt_for_selection(selection)


def apply_shifu_local_archive(
    manifest: Mapping[str, Any],
    archive: str | Path,
    *,
    config_home: str | Path,
    expected_digest: str,
    evidence_roots: list[str],
    bootstrap_release_cut_root: str | None,
    bootstrap_version: str | None,
    execute: bool,
) -> dict[str, Any]:
    """Install one exact Shifu-selected local archive through native ownership."""

    value = runtime_upgrade.validate_manifest(manifest)
    target_cut = value.get("releaseCut")
    if (
        not isinstance(target_cut, Mapping)
        or target_cut.get("publicationPolicy", {}).get("trustDomain") != "shifu-local"
    ):
        raise DistributionUpdateError(
            "local-release-policy-mismatch",
            "Shifu local installation requires a publication-ineligible local Cut",
        )
    selected = _read_cli_selection(config_home)
    legacy_selection = selected is not None and release_cut.is_legacy_bootstrap(
        selected[0]
    )
    if selected is None or legacy_selection:
        if not bootstrap_release_cut_root or not bootstrap_version:
            raise DistributionUpdateError(
                "local-bootstrap-coordinate-required",
                "first Shifu local installation requires an exact legacy bootstrap coordinate",
            )
        current_release_cut_root = bootstrap_release_cut_root
        current_version = bootstrap_version
        if (
            selected is not None
            and legacy_selection
            and (
                selected[0].get("releaseCutRoot") != bootstrap_release_cut_root
                or selected[0].get("productVersion") != bootstrap_version
            )
        ):
            raise DistributionUpdateError(
                "stale-bootstrap-coordinate",
                "legacy bootstrap selection differs from the installed Product receipt",
            )
        current_manifest = None
        authorization_kind = "shifu-local-bootstrap"
    else:
        selection, image = selected
        if bootstrap_release_cut_root is not None or bootstrap_version is not None:
            raise DistributionUpdateError(
                "local-bootstrap-already-complete",
                "native CLI inventory already has an exact Release Cut",
            )
        current_release_cut_root = str(selection.get("releaseCutRoot") or "")
        current_version = str(image.get("productVersion") or "")
        current_manifest = _installed_cli_manifest(image)
        authorization_kind = "shifu-local-successor"
    try:
        cut_transition = release_cut.shifu_local_transition(
            current_release_cut_root=current_release_cut_root,
            current_version=current_version,
            current_manifest=current_manifest,
            target_manifest=value,
            authorization_kind=authorization_kind,
            evidence_roots=evidence_roots,
        )
    except release_cut.ReleaseCutError as error:
        raise DistributionUpdateError(error.code, str(error)) from error
    return apply_archive(
        value,
        archive,
        current_version=current_version,
        config_home=config_home,
        expected_digest=expected_digest,
        execute=execute,
        cut_transition=cut_transition,
        allow_shifu_local=True,
        bootstrap_release_cut_root=(
            current_release_cut_root if selected is None or legacy_selection else None
        ),
        bootstrap_version=(
            current_version if selected is None or legacy_selection else None
        ),
    )


def rollback_shifu_local_cli(
    *,
    config_home: str | Path,
    expected_current_release_cut_root: str,
    expected_rollback_release_cut_root: str,
    evidence_roots: list[str],
    execute: bool,
) -> dict[str, Any]:
    """Roll back native CLI selection without consulting the Shifu source cache."""

    current = _read_cli_selection(config_home)
    if current is None:
        raise DistributionUpdateError(
            "cli-selection-missing", "native CLI inventory has no selected image"
        )
    selection, current_image = current
    if selection.get("releaseCutRoot") != expected_current_release_cut_root:
        raise DistributionUpdateError(
            "stale-selection",
            "native CLI selection no longer matches the expected current Release Cut",
        )
    rollback = selection.get("rollback")
    if not isinstance(rollback, Mapping):
        raise DistributionUpdateError(
            "rollback-unavailable",
            "native CLI selection has no retained rollback image",
        )
    if rollback.get("releaseCutRoot") != expected_rollback_release_cut_root:
        raise DistributionUpdateError(
            "stale-rollback-coordinate",
            "retained rollback image no longer matches the expected Release Cut",
        )
    target_is_legacy = rollback.get("kind") == release_cut.LEGACY_BOOTSTRAP_MODE
    if target_is_legacy:
        target_image: dict[str, Any] = {}
        target_version = str(rollback.get("productVersion") or "")
        if not target_version:
            raise DistributionUpdateError(
                "rollback-coordinate-invalid",
                "legacy bootstrap rollback has no exact Product version",
            )
    else:
        target_root = _cli_image_root(
            config_home, str(rollback.get("frontendBuildId") or "")
        )
        target_image = _read_object(target_root / "image.json")
        if (
            target_image.get("schema") != CLI_IMAGE_SCHEMA
            or target_image.get("releaseCutRoot") != expected_rollback_release_cut_root
            or target_image.get("artifactDigest") != rollback.get("artifactDigest")
            or Path(str(target_image.get("productRoot") or "")).resolve() != target_root
        ):
            raise DistributionUpdateError(
                "rollback-image-invalid",
                "retained rollback image does not match the native inventory coordinate",
            )
        target_version = str(target_image["productVersion"])
    current_is_legacy = release_cut.is_legacy_bootstrap(selection)
    current_version = str(
        selection.get("productVersion")
        if current_is_legacy
        else current_image["productVersion"]
    )
    current_manifest = (
        None if current_is_legacy else _installed_cli_manifest(current_image)
    )
    try:
        if target_is_legacy:
            compatibility = selection.get("cutTransition", {}).get("compatibility")
            transition = release_cut.legacy_recovery_transition(
                current_release_cut_root=expected_current_release_cut_root,
                current_version=current_version,
                target_release_cut_root=expected_rollback_release_cut_root,
                target_version=target_version,
                compatibility=compatibility or {},
                evidence_roots=evidence_roots,
            )
        else:
            target_manifest = _installed_cli_manifest(target_image)
            transition = release_cut.shifu_local_transition(
                current_release_cut_root=expected_current_release_cut_root,
                current_version=current_version,
                current_manifest=current_manifest,
                target_manifest=target_manifest,
                authorization_kind="shifu-local-recovery",
                evidence_roots=evidence_roots,
                relation="recovery",
            )
    except release_cut.ReleaseCutError as error:
        raise DistributionUpdateError(error.code, str(error)) from error
    plan = {
        "schema": CLI_ROLLBACK_SCHEMA,
        "state": "action-required" if not execute else "ready",
        "reasonCode": "execute-required" if not execute else "rollback-authorized",
        "currentReleaseCutRoot": expected_current_release_cut_root,
        "targetReleaseCutRoot": expected_rollback_release_cut_root,
        "cutTransitionRoot": transition["cutTransitionRoot"],
        "cutTransition": transition,
        "currentFrontendBuildId": current_image.get("frontendBuildId"),
        "targetFrontendBuildId": target_image.get("frontendBuildId"),
        "activeWorkPolicy": "keep-pinned",
        "sourceCacheRequired": False,
    }
    if not execute:
        return {**plan, "executeRequired": True}

    lock_root = _cli_inventory_root(config_home) / "locks"
    with _CLI_SELECTION_PROCESS_LOCK:
        with coordination_locks.held(
            lock_root,
            "current-selection",
            label="cli-product-select:rollback",
        ):
            observed = _read_cli_selection(config_home)
            if (
                observed is None
                or observed[0].get("releaseCutRoot")
                != expected_current_release_cut_root
                or observed[0].get("generation") != selection.get("generation")
            ):
                raise DistributionUpdateError(
                    "stale-selection",
                    "native CLI selection changed after rollback planning",
                )
            generation = _next_cli_generation(
                config_home, int(selection.get("generation") or 0)
            )
            reverse_rollback = (
                release_cut.legacy_coordinate(
                    selection["releaseCutRoot"], selection["productVersion"]
                )
                if current_is_legacy
                else release_cut.image_coordinate(current_image)
            )
            if target_is_legacy:
                next_selection = release_cut.legacy_selection(
                    schema=CLI_SELECTION_SCHEMA,
                    generation=generation,
                    release_cut_root=expected_rollback_release_cut_root,
                    product_version=target_version,
                    transition=transition,
                    previous_frontend_build_id=current_image.get("frontendBuildId"),
                    rollback=reverse_rollback,
                )
            else:
                next_selection = release_cut.image_selection(
                    target_image,
                    schema=CLI_SELECTION_SCHEMA,
                    generation=generation,
                    transition_root=transition["cutTransitionRoot"],
                    transition=transition,
                    previous_frontend_build_id=current_image.get("frontendBuildId"),
                    rollback=reverse_rollback,
                )
            receipt = {
                **plan,
                "state": "complete",
                "reasonCode": "rollback-selected-on-next-command",
                "executeRequired": False,
                "frontendSelection": next_selection,
            }
            rooted_receipt = {**receipt, "receiptRoot": _content_root(receipt)}
            _persist_cli_selection_receipt(config_home, next_selection, rooted_receipt)
            _write_object(_cli_selection_path(config_home), next_selection)
    return rooted_receipt
