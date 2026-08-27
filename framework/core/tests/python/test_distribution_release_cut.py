# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import errno
import hashlib
import json
import tarfile
import types
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu import runtime_upgrade as release_cut

from test_distribution_update import (
    _archive,
    distribution_update,
    update_command,
    update_test_cli,
)


def _bind_local_cut(
    manifest: dict,
    *,
    parent_release_cut_root: str | None,
) -> dict:
    manifest_identity_root = release_cut.manifest_identity_root(manifest)
    qualification_roots = [
        release_cut.content_root(manifest["qualificationEvidenceRef"])
    ]
    artifact_root = release_cut.content_root(
        [
            {
                "kind": artifact["kind"],
                "url": artifact["url"],
                "size": artifact["size"],
                "digest": artifact["digest"],
                "signature": artifact["signature"],
            }
            for artifact in manifest["artifacts"]
        ]
    )
    platform_slice = release_cut.finish_platform_slice(
        {
            "schema": release_cut.PLATFORM_SLICE_SCHEMA,
            "platform": manifest["platform"],
            "architecture": manifest["architecture"],
            "manifestIdentityRoot": manifest_identity_root,
            "artifactRoot": artifact_root,
            "qualificationEvidenceRoots": qualification_roots,
            "signingEvidenceRoots": [],
        }
    )
    product_cut = release_cut.finish_release_cut(
        {
            "schema": release_cut.RELEASE_CUT_SCHEMA,
            "productVersion": manifest["productVersion"],
            "parentReleaseCutRoots": (
                [parent_release_cut_root] if parent_release_cut_root else []
            ),
            "sourceSettlementRoot": release_cut.content_root(
                {"sourceCommit": manifest["sourceCommit"]}
            ),
            "semanticIdentityRoot": release_cut.content_root(
                {
                    "productVersion": manifest["productVersion"],
                    "releaseChannel": manifest["releaseChannel"],
                    "runtimeBuildId": manifest["runtimeBuildId"],
                    "frontendBuildId": manifest["frontendBuildId"],
                }
            ),
            "productAssemblyRoot": release_cut.content_root(
                {
                    "runtimeArtifactDigest": manifest["runtimeArtifactDigest"],
                    "artifacts": [
                        {
                            "kind": artifact["kind"],
                            "url": artifact["url"],
                            "size": artifact["size"],
                            "digest": artifact["digest"],
                            "signature": artifact["signature"],
                        }
                        for artifact in manifest["artifacts"]
                    ],
                }
            ),
            "compatibilityContractRoot": release_cut.content_root(
                {
                    "controlProtocolRange": manifest["controlProtocolRange"],
                    "peerWireProtocolRange": manifest["peerWireProtocolRange"],
                    "journalSchemaReadRange": manifest["journalSchemaReadRange"],
                    "journalSchemaWriteVersion": manifest["journalSchemaWriteVersion"],
                    "minimumSupportedFrontend": manifest["minimumSupportedFrontend"],
                    "minimumSupportedRuntime": manifest["minimumSupportedRuntime"],
                }
            ),
            "migrationContractRoot": release_cut.content_root(
                {
                    "migrationClass": manifest["migrationClass"],
                    "rollbackClass": manifest["rollbackClass"],
                }
            ),
            "platformSlices": [platform_slice],
            "qualificationEvidenceRoots": qualification_roots,
            "signingEvidenceRoots": [],
            "publicationPolicy": {
                "trustDomain": "shifu-local",
                "publicationEligible": False,
                "immutable": True,
                "eligibleChannels": [],
            },
            "omissionRoots": [],
            "waiverRoots": [],
        }
    )
    return {
        **manifest,
        "manifestIdentityRoot": manifest_identity_root,
        "releaseCut": product_cut,
        "releaseCutRoot": product_cut["releaseCutRoot"],
        "platformSliceRoot": platform_slice["platformSliceRoot"],
    }


def _local_cut_archive(
    tmp_path: Path,
    *,
    product_version: str = "4.0.0-alpha.1",
    build_id: str,
    parent_release_cut_root: str | None = None,
) -> tuple[Path, dict]:
    archive, manifest = _archive(
        tmp_path,
        product_version=product_version,
    )
    manifest["runtimeBuildId"] = f"runtime-{build_id}-fixture"
    manifest["frontendBuildId"] = f"product-{build_id}-fixture"
    manifest["qualificationEvidenceRef"] = f"unqualified-local-build:{build_id}"
    for artifact in manifest["artifacts"]:
        artifact["signature"] = "unqualified-local-build"
    bundled_path = (
        tmp_path
        / "source"
        / "kungfu-cli-test"
        / "upgrade"
        / "kungfu-release-manifest.json"
    )
    bundled = json.loads(bundled_path.read_text("utf-8"))
    bundled["runtimeBuildId"] = manifest["runtimeBuildId"]
    bundled["frontendBuildId"] = manifest["frontendBuildId"]
    bundled["qualificationEvidenceRef"] = manifest["qualificationEvidenceRef"]
    for artifact in bundled["artifacts"]:
        artifact["signature"] = "unqualified-local-build"
    bundled = _bind_local_cut(
        bundled,
        parent_release_cut_root=parent_release_cut_root,
    )
    bundled_path.write_text(json.dumps(bundled), "utf-8")
    with tarfile.open(archive, "w:gz") as output:
        output.add(
            tmp_path / "source" / "kungfu-cli-test",
            arcname="kungfu-cli-test",
        )
    cli_artifact = next(
        artifact for artifact in manifest["artifacts"] if artifact["kind"] == "cli"
    )
    cli_artifact["size"] = archive.stat().st_size
    cli_artifact["digest"] = (
        f"sha256:{hashlib.sha256(archive.read_bytes()).hexdigest()}"
    )
    return archive, _bind_local_cut(
        manifest,
        parent_release_cut_root=parent_release_cut_root,
    )


def test_public_release_check_rejects_publication_ineligible_local_cut(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    local_manifest = _bind_local_cut(
        manifest,
        parent_release_cut_root=None,
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.check_release(
            local_manifest,
            current_version="4.0.0-alpha.0",
            source=distribution_update.install_source(
                {"KUNGFU_INSTALL_SOURCE": "archive"}
            ),
            require_publication=True,
        )

    assert captured.value.code == "release-publication-policy-mismatch"


@pytest.mark.parametrize(
    (
        "compatibility_update",
        "active_work_policy",
        "reason_code",
        "activation_timing",
        "user_action",
    ),
    [
        (
            {"migrationClass": "irreversible"},
            "keep-pinned",
            "irreversible-migration-needs-approval",
            "after-recovery-evidence-and-approval",
            "Create and verify backup or restore evidence, then approve explicitly.",
        ),
        (
            {"rollbackClass": "none"},
            "keep-pinned",
            "rollback-unavailable",
            "after-recovery-path-is-approved",
            "Follow the documented recovery path before proceeding.",
        ),
        (
            {"rollbackClass": "manual"},
            "keep-pinned",
            "manual-rollback-needs-approval",
            "after-manual-rollback-is-approved",
            "Review and approve the documented manual rollback path before proceeding.",
        ),
        (
            {"providerResumeRequired": True},
            "provider-resume",
            "provider-resume-required",
            "after-provider-resume",
            "End at a safe point and use the provider resume action.",
        ),
        (
            {},
            "defer-until-idle",
            "active-work-must-be-idle",
            "after-current-work-is-idle",
            "Finish the current work; do not force a restart for the update.",
        ),
    ],
)
def test_cut_policy_refusals_report_exact_user_action(
    tmp_path: Path,
    compatibility_update: dict,
    active_work_policy: str,
    reason_code: str,
    activation_timing: str,
    user_action: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    current_root = f"sha256:{'0' * 64}"
    target_manifest = _bind_local_cut(
        manifest,
        parent_release_cut_root=current_root,
    )
    transition = release_cut.build_shifu_local_transition(
        current_release_cut_root=current_root,
        current_version="4.0.0-alpha.0",
        target_cut=target_manifest["releaseCut"],
        relation="verified-successor",
        authorization_kind="shifu-local-successor",
        compatibility={
            "controlProtocol": True,
            "peerWireProtocol": True,
            "journalReadable": True,
            "migrationClass": "none",
            "rollbackClass": "automatic",
            "providerResumeRequired": False,
            **compatibility_update,
        },
        migration_plan_root=f"sha256:{'1' * 64}",
        rollback_plan_root=f"sha256:{'2' * 64}",
        active_work_policy=active_work_policy,
        evidence_roots=[f"sha256:{'3' * 64}"],
    )

    checked = distribution_update.check_release(
        target_manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        current_release_cut_root=current_root,
        cut_transition=transition,
        require_publication=False,
    )

    assert checked["state"] == "action-required"
    assert checked["reasonCode"] == reason_code
    assert checked["message"]["messageReasonCode"] == reason_code
    assert checked["message"]["userAction"] == user_action
    assert checked["message"]["impact"] == {
        "activeWorkContinues": True,
        "activationTiming": activation_timing,
        "userActionRequired": True,
    }


def test_shifu_local_same_semver_successor_installs_side_by_side_and_rolls_back(
    tmp_path: Path,
) -> None:
    config_home = tmp_path / "config"
    first_archive, first_manifest = _local_cut_archive(
        tmp_path / "first",
        build_id="first",
    )
    bootstrap_root = f"sha256:{'0' * 64}"
    first = distribution_update.apply_shifu_local_archive(
        first_manifest,
        first_archive,
        config_home=config_home,
        expected_digest=first_manifest["artifacts"][1]["digest"],
        evidence_roots=[first_manifest["artifacts"][1]["digest"]],
        bootstrap_release_cut_root=bootstrap_root,
        bootstrap_version=first_manifest["productVersion"],
        execute=True,
    )
    assert first["currentReleaseCutRoot"] == bootstrap_root
    assert first["targetReleaseCutRoot"] == first_manifest["releaseCutRoot"]
    assert first["frontendSelection"]["generation"] == 1

    second_archive, second_manifest = _local_cut_archive(
        tmp_path / "second",
        build_id="second",
        parent_release_cut_root=first_manifest["releaseCutRoot"],
    )
    second = distribution_update.apply_shifu_local_archive(
        second_manifest,
        second_archive,
        config_home=config_home,
        expected_digest=second_manifest["artifacts"][1]["digest"],
        evidence_roots=[
            second_manifest["artifacts"][1]["digest"],
            second_manifest["platformSliceRoot"],
        ],
        bootstrap_release_cut_root=None,
        bootstrap_version=None,
        execute=True,
    )
    assert first_manifest["productVersion"] == second_manifest["productVersion"]
    assert first_manifest["releaseCutRoot"] != second_manifest["releaseCutRoot"]
    assert second["frontendSelection"]["generation"] == 2
    assert (
        second["frontendSelection"]["releaseCutRoot"]
        == second_manifest["releaseCutRoot"]
    )
    assert second["frontendSelection"]["cutTransition"] == second["cutTransition"]
    assert len(distribution_update.cli_inventory_fsck(config_home)["images"]) == 2

    first_archive.unlink()
    second_archive.unlink()
    rolled_back = distribution_update.rollback_shifu_local_cli(
        config_home=config_home,
        expected_current_release_cut_root=second_manifest["releaseCutRoot"],
        expected_rollback_release_cut_root=first_manifest["releaseCutRoot"],
        evidence_roots=[second["cutTransitionRoot"]],
        execute=True,
    )
    assert rolled_back["sourceCacheRequired"] is False
    assert rolled_back["frontendSelection"]["generation"] == 3
    assert (
        rolled_back["frontendSelection"]["releaseCutRoot"]
        == first_manifest["releaseCutRoot"]
    )
    assert (
        rolled_back["frontendSelection"]["cutTransition"]
        == rolled_back["cutTransition"]
    )
    inventory = distribution_update.cli_inventory_fsck(config_home)
    assert inventory["ok"] is True
    assert inventory["selectedReceiptRoot"] == rolled_back["receiptRoot"]


def test_shifu_local_first_selection_rolls_back_to_bootstrap_without_source_cache(
    tmp_path: Path,
) -> None:
    config_home = tmp_path / "config"
    archive, manifest = _local_cut_archive(
        tmp_path / "first",
        build_id="first",
    )
    bootstrap_root = f"sha256:{'0' * 64}"
    applied = distribution_update.apply_shifu_local_archive(
        manifest,
        archive,
        config_home=config_home,
        expected_digest=manifest["artifacts"][1]["digest"],
        evidence_roots=[manifest["artifacts"][1]["digest"]],
        bootstrap_release_cut_root=bootstrap_root,
        bootstrap_version=manifest["productVersion"],
        execute=True,
    )
    archive.unlink()

    recovered = distribution_update.rollback_shifu_local_cli(
        config_home=config_home,
        expected_current_release_cut_root=manifest["releaseCutRoot"],
        expected_rollback_release_cut_root=bootstrap_root,
        evidence_roots=[applied["cutTransitionRoot"]],
        execute=True,
    )
    assert recovered["sourceCacheRequired"] is False
    assert recovered["frontendSelection"]["selectionMode"] == "legacy-bootstrap"
    assert recovered["frontendSelection"]["releaseCutRoot"] == bootstrap_root
    assert (
        distribution_update.selected_cli_command(
            {
                "KUNGFU_INSTALL_SOURCE": "archive",
                "KF_CONFIG_HOME": str(config_home),
            }
        )
        is None
    )
    inventory = distribution_update.cli_inventory_fsck(config_home)
    assert inventory["ok"] is True
    assert inventory["selectedReceiptRoot"] == recovered["receiptRoot"]

    restored = distribution_update.rollback_shifu_local_cli(
        config_home=config_home,
        expected_current_release_cut_root=bootstrap_root,
        expected_rollback_release_cut_root=manifest["releaseCutRoot"],
        evidence_roots=[recovered["cutTransitionRoot"]],
        execute=True,
    )
    assert restored["sourceCacheRequired"] is False
    assert (
        restored["frontendSelection"]["frontendBuildId"] == manifest["frontendBuildId"]
    )
    assert distribution_update.cli_inventory_fsck(config_home)["ok"] is True


def test_shifu_local_rollback_advances_past_an_unpublished_successor_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_home = tmp_path / "config"
    first_archive, first_manifest = _local_cut_archive(
        tmp_path / "first",
        build_id="first",
    )
    first = distribution_update.apply_shifu_local_archive(
        first_manifest,
        first_archive,
        config_home=config_home,
        expected_digest=first_manifest["artifacts"][1]["digest"],
        evidence_roots=[first_manifest["artifacts"][1]["digest"]],
        bootstrap_release_cut_root=f"sha256:{'0' * 64}",
        bootstrap_version=first_manifest["productVersion"],
        execute=True,
    )
    second_archive, second_manifest = _local_cut_archive(
        tmp_path / "second",
        build_id="second",
        parent_release_cut_root=first_manifest["releaseCutRoot"],
    )
    second = distribution_update.apply_shifu_local_archive(
        second_manifest,
        second_archive,
        config_home=config_home,
        expected_digest=second_manifest["artifacts"][1]["digest"],
        evidence_roots=[second_manifest["artifacts"][1]["digest"]],
        bootstrap_release_cut_root=None,
        bootstrap_version=None,
        execute=True,
    )
    third_archive, third_manifest = _local_cut_archive(
        tmp_path / "third",
        build_id="third",
        parent_release_cut_root=second_manifest["releaseCutRoot"],
    )
    original_write = distribution_update._write_object

    def interrupt_selection(path: Path, value: dict) -> None:
        if path.name == "current.json":
            raise OSError(errno.EIO, "simulated selection interruption")
        original_write(path, value)

    monkeypatch.setattr(distribution_update, "_write_object", interrupt_selection)
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_shifu_local_archive(
            third_manifest,
            third_archive,
            config_home=config_home,
            expected_digest=third_manifest["artifacts"][1]["digest"],
            evidence_roots=[third_manifest["artifacts"][1]["digest"]],
            bootstrap_release_cut_root=None,
            bootstrap_version=None,
            execute=True,
        )
    assert error.value.code == "selection-io-failed"
    interrupted = distribution_update.cli_inventory_fsck(config_home)
    assert interrupted["ok"] is False
    assert interrupted["pendingReceipts"][0]["generation"] == 3
    assert interrupted["issues"] == [
        {
            "code": "cli-selection-publication-pending",
            "path": "receipts/generation-00000000000000000003.json",
        }
    ]

    monkeypatch.setattr(distribution_update, "_write_object", original_write)
    rolled_back = distribution_update.rollback_shifu_local_cli(
        config_home=config_home,
        expected_current_release_cut_root=second_manifest["releaseCutRoot"],
        expected_rollback_release_cut_root=first_manifest["releaseCutRoot"],
        evidence_roots=[second["cutTransitionRoot"]],
        execute=True,
    )
    assert rolled_back["frontendSelection"]["generation"] == 4
    assert (
        rolled_back["frontendSelection"]["releaseCutRoot"]
        == first["targetReleaseCutRoot"]
    )
    inventory = distribution_update.cli_inventory_fsck(config_home)
    assert inventory["ok"] is True
    assert inventory["pendingReceipts"] == []
    assert [receipt["generation"] for receipt in inventory["retainedReceipts"]] == [
        1,
        2,
        3,
    ]


def test_shifu_native_cli_handoff_and_cache_independent_rollback(
    tmp_path: Path,
) -> None:
    home = tmp_path / "disposable-product-home"
    first_archive, first_manifest = _local_cut_archive(
        tmp_path / "first-cli",
        build_id="first-cli",
    )
    first_manifest_path = tmp_path / "first-cli-manifest.json"
    first_manifest_path.write_text(json.dumps(first_manifest), "utf-8")
    bootstrap_root = f"sha256:{'0' * 64}"
    first = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(home),
            "update",
            "shifu-apply",
            str(first_manifest_path),
            str(first_archive),
            "--expected-digest",
            first_manifest["artifacts"][1]["digest"],
            "--evidence-root",
            first_manifest["platformSliceRoot"],
            "--bootstrap-release-cut-root",
            bootstrap_root,
            "--bootstrap-version",
            first_manifest["productVersion"],
            "--yes",
            "--json",
        ],
    )
    assert first.exit_code == 0, first.output
    first_receipt = json.loads(first.output)
    assert first_receipt["state"] == "complete"

    second_archive, second_manifest = _local_cut_archive(
        tmp_path / "second-cli",
        build_id="second-cli",
        parent_release_cut_root=first_manifest["releaseCutRoot"],
    )
    second_manifest_path = tmp_path / "second-cli-manifest.json"
    second_manifest_path.write_text(json.dumps(second_manifest), "utf-8")
    second = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(home),
            "update",
            "shifu-apply",
            str(second_manifest_path),
            str(second_archive),
            "--expected-digest",
            second_manifest["artifacts"][1]["digest"],
            "--evidence-root",
            second_manifest["platformSliceRoot"],
            "--yes",
            "--json",
        ],
    )
    assert second.exit_code == 0, second.output
    second_receipt = json.loads(second.output)
    assert second_receipt["state"] == "complete"
    assert (
        second_receipt["frontendSelection"]["releaseCutRoot"]
        == second_manifest["releaseCutRoot"]
    )

    first_archive.unlink()
    second_archive.unlink()
    rollback = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(home),
            "update",
            "shifu-rollback",
            "--expected-current-release-cut-root",
            second_manifest["releaseCutRoot"],
            "--expected-rollback-release-cut-root",
            first_manifest["releaseCutRoot"],
            "--evidence-root",
            second_receipt["cutTransitionRoot"],
            "--yes",
            "--json",
        ],
    )
    assert rollback.exit_code == 0, rollback.output
    rollback_receipt = json.loads(rollback.output)
    assert rollback_receipt["state"] == "complete"
    assert rollback_receipt["sourceCacheRequired"] is False
    assert (
        rollback_receipt["frontendSelection"]["releaseCutRoot"]
        == first_manifest["releaseCutRoot"]
    )
    assert distribution_update.cli_inventory_fsck(home / "config")["ok"] is True


def test_shifu_local_successor_requires_cut_parent_lineage(tmp_path: Path) -> None:
    config_home = tmp_path / "config"
    first_archive, first_manifest = _local_cut_archive(
        tmp_path / "first",
        build_id="first",
    )
    distribution_update.apply_shifu_local_archive(
        first_manifest,
        first_archive,
        config_home=config_home,
        expected_digest=first_manifest["artifacts"][1]["digest"],
        evidence_roots=[first_manifest["artifacts"][1]["digest"]],
        bootstrap_release_cut_root=f"sha256:{'0' * 64}",
        bootstrap_version=first_manifest["productVersion"],
        execute=True,
    )
    second_archive, second_manifest = _local_cut_archive(
        tmp_path / "second",
        build_id="second",
    )
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.apply_shifu_local_archive(
            second_manifest,
            second_archive,
            config_home=config_home,
            expected_digest=second_manifest["artifacts"][1]["digest"],
            evidence_roots=[second_manifest["artifacts"][1]["digest"]],
            bootstrap_release_cut_root=None,
            bootstrap_version=None,
            execute=False,
        )
    assert captured.value.code == "cut-transition-lineage-mismatch"


def test_discovery_passes_exact_installed_cut_to_channel_selection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed_cut = f"sha256:{'9' * 64}"
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text("{}", "utf-8")
    monkeypatch.setattr(
        distribution_update,
        "install_source",
        lambda: {
            "source": "archive",
            "productManifest": str(product_manifest),
            "selectedReleaseCutRoot": installed_cut,
        },
    )
    monkeypatch.setattr(
        update_command.release_channel,
        "channel_config",
        lambda *_args: {"reference": "fixture", "trustedKeys": {"key": "value"}},
    )
    monkeypatch.setattr(
        update_command.release_channel,
        "resolve_index",
        lambda *_args, **_kwargs: {
            "index": {"entries": [], "payloadRoot": f"sha256:{'8' * 64}"},
            "transportState": "local-fixture",
            "cachePath": None,
        },
    )
    seen = {}

    def select_release(_index, **kwargs):
        seen.update(kwargs)
        return {"schema": "selection"}

    monkeypatch.setattr(
        update_command.release_channel,
        "select_release",
        select_release,
    )
    monkeypatch.setattr(
        distribution_update,
        "plan_update",
        lambda *_args, **_kwargs: {"schema": "plan"},
    )
    ctx = types.SimpleNamespace(config_home=str(tmp_path / "config"))
    result = update_command._discover_update_plan(ctx, "alpha", False)
    assert result["plan"] == {"schema": "plan"}
    assert seen["current_release_cut_root"] == installed_cut
