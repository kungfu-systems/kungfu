# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import shutil
from pathlib import Path

import pytest
import pykungfu  # noqa: F401

from kungfu import distribution_update, exit_bundle, product_release_history

from test_distribution_release_cut import _local_cut_archive


def _cli_digest(manifest: dict) -> str:
    return next(
        artifact["digest"]
        for artifact in manifest["artifacts"]
        if artifact["kind"] == "cli"
    )


def _apply(
    config_home: Path,
    archive: Path,
    manifest: dict,
    *,
    bootstrap_root: str | None,
) -> dict:
    return distribution_update.apply_shifu_local_archive(
        manifest,
        archive,
        config_home=config_home,
        expected_digest=_cli_digest(manifest),
        evidence_roots=[_cli_digest(manifest), manifest["platformSliceRoot"]],
        bootstrap_release_cut_root=bootstrap_root,
        bootstrap_version=(manifest["productVersion"] if bootstrap_root else None),
        execute=True,
    )


def _installed_history(tmp_path: Path) -> tuple[Path, dict, dict, dict]:
    config_home = tmp_path / "source-config"
    first_archive, first_manifest = _local_cut_archive(
        tmp_path / "first", build_id="portable-first"
    )
    first = _apply(
        config_home,
        first_archive,
        first_manifest,
        bootstrap_root=f"sha256:{'0' * 64}",
    )
    second_archive, second_manifest = _local_cut_archive(
        tmp_path / "second",
        build_id="portable-second",
        parent_release_cut_root=first_manifest["releaseCutRoot"],
    )
    second = _apply(config_home, second_archive, second_manifest, bootstrap_root=None)
    assert first_manifest["productVersion"] == second_manifest["productVersion"]
    assert first_manifest["releaseCutRoot"] != second_manifest["releaseCutRoot"]
    first_archive.unlink()
    second_archive.unlink()
    return config_home, first, second, second_manifest


def _request(mode: str = "full") -> dict:
    return {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": f"exit:product-release-history-{mode}",
        "mode": mode,
        "scope": {
            "id": "fixture/product-release-history",
            "authority": "pytest",
            "schema": "test.product-release-history/v1",
            "protocol": "test-product-release-history-root/v1",
        },
        "members": [
            {
                "memberId": "product-release-history",
                "kind": "product-release-cut-v1",
                "requiredForScope": True,
                "options": {},
            }
        ],
    }


def test_exit_product_release_history_survives_cache_deletion_and_rolls_back(
    tmp_path: Path,
) -> None:
    source, first, second, second_manifest = _installed_history(tmp_path)
    package = exit_bundle.build(
        tmp_path / "source-runtime",
        _request(),
        config_home=source,
    )
    inspection = exit_bundle.inspect(package)
    member = package["materials"]["product-release-history"]

    assert inspection["status"] == "verified"
    assert member["identityRoot"] == second_manifest["releaseCutRoot"]
    assert member["inventory"]["trustDomains"] == ["shifu-local"]
    assert len(member["inventory"]["imageRoots"]) == 2

    destination = tmp_path / "destination-config"
    imported = exit_bundle.import_package(
        tmp_path / "destination-runtime",
        package,
        config_home=destination,
        execute=True,
        authorized_by="pytest",
    )
    repeated = exit_bundle.import_package(
        tmp_path / "destination-runtime",
        package,
        config_home=destination,
        execute=True,
        authorized_by="pytest",
    )

    assert imported["ok"] is True, imported
    assert imported["status"] == "imported"
    assert repeated["status"] == "already_present"
    selected = distribution_update.cli_inventory_fsck(destination)
    assert selected["ok"] is True
    assert selected["selected"]["releaseCutRoot"] == second["targetReleaseCutRoot"]
    assert selected["selected"]["productRoot"].startswith(str(destination.resolve()))

    reexported = product_release_history.build(destination)
    assert set(reexported["inventory"]["selectionReceiptRoots"]) >= set(
        member["inventory"]["selectionReceiptRoots"]
    )
    assert set(reexported["inventory"]["updateReceiptRoots"]) == set(
        member["inventory"]["updateReceiptRoots"]
    )

    rolled_back = distribution_update.rollback_shifu_local_cli(
        config_home=destination,
        expected_current_release_cut_root=second["targetReleaseCutRoot"],
        expected_rollback_release_cut_root=first["targetReleaseCutRoot"],
        evidence_roots=[second["cutTransitionRoot"]],
        execute=True,
    )
    assert rolled_back["sourceCacheRequired"] is False
    assert (
        rolled_back["frontendSelection"]["releaseCutRoot"]
        == first["targetReleaseCutRoot"]
    )


def test_product_release_history_rejects_unknown_features_and_thin_import(
    tmp_path: Path,
) -> None:
    source, _first, _second, _manifest = _installed_history(tmp_path)
    full = product_release_history.build(source)
    unknown = copy.deepcopy(full)
    unknown["requiredFeatures"].append("future-required-history-v9")

    with pytest.raises(exit_bundle.ProductReleaseHistoryError) as error:
        product_release_history.verify(unknown)
    assert error.value.code == "history-required-feature-unsupported"

    thin = product_release_history.build(source, mode="thin")
    assert product_release_history.verify(thin)["mode"] == "thin"
    with pytest.raises(exit_bundle.ProductReleaseHistoryError) as error:
        product_release_history.import_history(
            tmp_path / "thin-destination", thin, execute=True
        )
    assert error.value.code == "history-thin-materialization-forbidden"


def test_product_release_history_recovers_receipt_before_current_interruption(
    tmp_path: Path,
) -> None:
    source, _first, _second, _manifest = _installed_history(tmp_path)
    bundle = product_release_history.build(source)
    destination = tmp_path / "interrupted-destination"

    with pytest.raises(exit_bundle.ProductReleaseHistoryError) as error:
        product_release_history.import_history(
            destination, bundle, execute=True, _fault_before_current=True
        )
    assert error.value.code == "qualification-fault-before-current"
    pending = distribution_update.cli_inventory_fsck(destination)
    assert pending["ok"] is False
    assert pending["issues"][0]["code"] == "cli-selection-publication-pending"

    recovered = product_release_history.import_history(
        destination, bundle, execute=True
    )
    assert recovered["status"] == "recovered"
    assert recovered["sourceCacheRequired"] is False
    assert distribution_update.cli_inventory_fsck(destination)["ok"] is True


def test_product_release_history_refuses_recovery_after_receipt_bound_image_loss(
    tmp_path: Path,
) -> None:
    source, _first, _second, _manifest = _installed_history(tmp_path)
    bundle = product_release_history.build(source)
    destination = tmp_path / "lost-recovery-image"

    with pytest.raises(exit_bundle.ProductReleaseHistoryError):
        product_release_history.import_history(
            destination, bundle, execute=True, _fault_before_current=True
        )
    selected_id = str(bundle["material"]["selected"]["frontendBuildId"])
    shutil.rmtree(distribution_update._cli_image_root(destination, selected_id))

    with pytest.raises(exit_bundle.ProductReleaseHistoryError) as error:
        product_release_history.import_history(destination, bundle, execute=True)
    assert error.value.code == "history-recovery-image-missing"
    assert not distribution_update._cli_selection_path(destination).exists()


def test_product_release_history_rejects_diverged_destination_before_selection(
    tmp_path: Path,
) -> None:
    source, _first, _second, _manifest = _installed_history(tmp_path)
    bundle = product_release_history.build(source)
    destination = tmp_path / "diverged-destination"
    distribution_update._write_object(
        distribution_update._cli_selection_path(destination),
        {"schema": distribution_update.CLI_SELECTION_SCHEMA, "generation": 1},
    )

    with pytest.raises(exit_bundle.ProductReleaseHistoryError) as error:
        product_release_history.import_history(destination, bundle, execute=True)
    assert error.value.code == "history-destination-not-clean"
