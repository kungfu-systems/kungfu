# SPDX-License-Identifier: Apache-2.0

"""Archive activation, inventory, rollback, and publication contracts."""

from __future__ import annotations

from _distribution_update_support import *  # noqa: F403


def test_apply_installs_runtime_and_selects_versioned_cli_on_next_command(
    tmp_path: Path,
) -> None:
    archive, manifest = _archive(tmp_path)
    digest = manifest["artifacts"][1]["digest"]
    preview = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=digest,
        execute=False,
    )
    assert preview["executeRequired"] is True
    assert runtime_upgrade.list_images(tmp_path / "config") == []

    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=digest,
        execute=True,
    )
    assert applied["state"] == "complete"
    assert applied["frontendAction"] == "selected-on-next-command"
    images = runtime_upgrade.list_images(tmp_path / "config")
    assert [image["buildId"] for image in images] == [manifest["runtimeBuildId"]]
    assert Path(images[0]["artifactRoot"]).is_dir()
    frontend = applied["frontendImage"]
    assert frontend["frontendBuildId"] == manifest["frontendBuildId"]
    assert Path(frontend["productRoot"]).is_dir()
    selected = distribution_update.selected_cli_command(
        {
            "KUNGFU_INSTALL_SOURCE": "archive",
            "KF_CONFIG_HOME": str(tmp_path / "config"),
            "KUNGFU_DIR": str(tmp_path / "stale-runtime"),
            "KF_BUNDLED_EXTENSION_ROOT": str(tmp_path / "stale-extensions"),
            "KUNGFU_AGENT_SESSION_EXECUTABLE": str(tmp_path / "stale-agent"),
            "KUNGFU_CONTROLLER_ENTRYPOINT": str(tmp_path / "stale-controller"),
        },
        current_executable=tmp_path / "original" / "kungfu",
    )
    assert selected is not None
    command, selected_env = selected
    assert Path(command[0]) == Path(frontend["productRoot"]) / "kungfu" / "kungfu"
    assert (
        selected_env["KUNGFU_SELECTED_FRONTEND_BUILD_ID"] == manifest["frontendBuildId"]
    )
    selected_executable = Path(command[0])
    selected_root = Path(frontend["productRoot"])
    assert Path(selected_env["KUNGFU_DIR"]) == selected_executable.parent
    assert (
        Path(selected_env["KF_BUNDLED_EXTENSION_ROOT"]) == selected_root / "extensions"
    )
    assert Path(selected_env["KUNGFU_AGENT_SESSION_EXECUTABLE"]) == selected_executable
    assert Path(selected_env["KUNGFU_CONTROLLER_ENTRYPOINT"]) == selected_executable
    assert (
        distribution_update.selected_cli_command(
            selected_env,
            current_executable=command[0],
        )
        is None
    )
    assert applied["receiptRoot"].startswith("sha256:")
    assert applied["frontendSelection"]["generation"] == 1
    assert applied["frontendSelection"]["previousFrontendBuildId"] is None
    inventory = distribution_update.cli_inventory_fsck(tmp_path / "config")
    assert inventory["selectedReceiptRoot"] == applied["receiptRoot"]
    persisted_receipt = (
        tmp_path
        / "config"
        / "product"
        / "cli"
        / "receipts"
        / "generation-00000000000000000001.json"
    )
    assert json.loads(persisted_receipt.read_text("utf-8")) == applied


def test_cli_inventory_retains_stale_partial_and_reports_rollback_coordinates(
    tmp_path: Path,
) -> None:
    older_archive, older_manifest = _archive(
        tmp_path / "older", product_version="4.0.0-alpha.1"
    )
    newer_archive, newer_manifest = _archive(
        tmp_path / "newer", product_version="4.0.0-alpha.2"
    )
    config_home = tmp_path / "config"
    older = distribution_update.apply_archive(
        older_manifest,
        older_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=older_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    stale = (
        config_home
        / "product"
        / "cli"
        / "images"
        / f".{newer_manifest['frontendBuildId']}.{distribution_update.os.getpid()}.partial"
    )
    stale.mkdir(parents=True)
    (stale / "retained-for-recovery").write_text("partial", "utf-8")

    newer = distribution_update.apply_archive(
        newer_manifest,
        newer_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=newer_manifest["artifacts"][1]["digest"],
        execute=True,
    )

    selection = newer["frontendSelection"]
    assert selection["generation"] == 2
    assert (
        selection["previousFrontendBuildId"]
        == older["frontendImage"]["frontendBuildId"]
    )
    assert (
        selection["rollback"]["artifactDigest"]
        == older["frontendImage"]["artifactDigest"]
    )
    report = distribution_update.cli_inventory_fsck(config_home)
    assert report["ok"] is True
    assert report["selected"]["frontendBuildId"] == newer_manifest["frontendBuildId"]
    assert len(report["images"]) == 2
    assert (
        str(stale.relative_to(config_home / "product" / "cli"))
        in report["retainedPartials"]
    )
    assert stale.is_dir()


def test_cli_selection_interruption_keeps_last_known_good_and_retry_recovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    older_archive, older_manifest = _archive(
        tmp_path / "older", product_version="4.0.0-alpha.1"
    )
    newer_archive, newer_manifest = _archive(
        tmp_path / "newer", product_version="4.0.0-alpha.2"
    )
    config_home = tmp_path / "config"
    older = distribution_update.apply_archive(
        older_manifest,
        older_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=older_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    original_write = distribution_update._write_object

    def interrupt_selection(path: Path, value: dict) -> None:
        if path.name == "current.json":
            raise OSError(errno.EIO, "simulated selection interruption")
        original_write(path, value)

    monkeypatch.setattr(distribution_update, "_write_object", interrupt_selection)
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            newer_manifest,
            newer_archive,
            current_version="4.0.0-alpha.0",
            config_home=config_home,
            expected_digest=newer_manifest["artifacts"][1]["digest"],
            execute=True,
        )
    assert error.value.code == "selection-io-failed"
    selected = distribution_update.cli_inventory_fsck(config_home)
    assert selected["ok"] is False
    assert (
        selected["selected"]["frontendBuildId"]
        == older["frontendImage"]["frontendBuildId"]
    )
    assert selected["selectedReceiptRoot"] == older["receiptRoot"]
    interrupted_receipt = (
        config_home
        / "product"
        / "cli"
        / "receipts"
        / "generation-00000000000000000002.json"
    )
    retained = json.loads(interrupted_receipt.read_text("utf-8"))
    assert (
        retained["frontendSelection"]["frontendBuildId"]
        == newer_manifest["frontendBuildId"]
    )
    assert retained["receiptRoot"] == distribution_update._content_root(
        {key: value for key, value in retained.items() if key != "receiptRoot"}
    )

    monkeypatch.setattr(distribution_update, "_write_object", original_write)
    retried = distribution_update.apply_archive(
        newer_manifest,
        newer_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=newer_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    assert (
        retried["frontendSelection"]["frontendBuildId"]
        == newer_manifest["frontendBuildId"]
    )
    assert retried["frontendSelection"]["generation"] == 3
    recovered = distribution_update.cli_inventory_fsck(config_home)
    assert recovered["ok"] is True
    assert recovered["pendingReceipts"] == []


def test_cli_inventory_fsck_reports_malformed_image_without_crashing(
    tmp_path: Path,
) -> None:
    archive, manifest = _archive(tmp_path)
    config_home = tmp_path / "config"
    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    image_path = Path(applied["frontendImage"]["productRoot"]) / "image.json"
    image = json.loads(image_path.read_text("utf-8"))
    image.pop("runtimeBuildId")
    image_path.write_text(json.dumps(image), "utf-8")

    report = distribution_update.cli_inventory_fsck(config_home)

    assert report["ok"] is False
    assert report["selected"] is None
    assert {issue["code"] for issue in report["issues"]} == {
        "cli-image-unreadable",
        "cli-selection-invalid",
    }
    assert report["recoveryAction"] is not None


def test_apply_rejects_unsafe_archive_before_inventory_write(tmp_path: Path) -> None:
    _valid_archive, manifest = _archive(tmp_path)
    candidate = tmp_path / "unsafe.tar.gz"
    with tarfile.open(candidate, "w:gz") as output:
        member = tarfile.TarInfo("../escape")
        payload = b"unsafe"
        member.size = len(payload)
        output.addfile(member, io.BytesIO(payload))
    artifact = next(item for item in manifest["artifacts"] if item["kind"] == "cli")
    artifact["size"] = candidate.stat().st_size
    artifact["digest"] = f"sha256:{hashlib.sha256(candidate.read_bytes()).hexdigest()}"

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            candidate,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=artifact["digest"],
            execute=True,
        )

    assert error.value.code == "archive-entry-unsupported"
    assert not (tmp_path / "config").exists()


def test_duplicate_frontend_build_id_rejects_different_archive_bytes(
    tmp_path: Path,
) -> None:
    first_archive, manifest = _archive(tmp_path)
    config_home = tmp_path / "config"
    distribution_update.apply_archive(
        manifest,
        first_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    source = tmp_path / "source" / "kungfu-cli-test"
    (source / "extra.txt").write_text("different archive bytes", "utf-8")
    second_archive = tmp_path / "different.tar.gz"
    with tarfile.open(second_archive, "w:gz") as output:
        output.add(source, arcname=source.name)
    second_manifest = json.loads(json.dumps(manifest))
    artifact = next(
        item for item in second_manifest["artifacts"] if item["kind"] == "cli"
    )
    artifact["size"] = second_archive.stat().st_size
    artifact["digest"] = (
        f"sha256:{hashlib.sha256(second_archive.read_bytes()).hexdigest()}"
    )

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            second_manifest,
            second_archive,
            current_version="4.0.0-alpha.0",
            config_home=config_home,
            expected_digest=artifact["digest"],
            execute=True,
        )

    assert error.value.code == "frontend-build-id-collision"
    report = distribution_update.cli_inventory_fsck(config_home)
    assert report["ok"] is True
    assert report["selected"]["artifactDigest"] == manifest["artifacts"][1]["digest"]


def test_apply_keeps_newest_cli_selection_when_plans_finish_out_of_order(
    tmp_path: Path,
) -> None:
    older_archive, older_manifest = _archive(
        tmp_path / "older", product_version="4.0.0-alpha.1"
    )
    newer_archive, newer_manifest = _archive(
        tmp_path / "newer", product_version="4.0.0-alpha.2"
    )
    config_home = tmp_path / "config"

    distribution_update.apply_archive(
        newer_manifest,
        newer_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=newer_manifest["artifacts"][1]["digest"],
        execute=True,
    )
    completed_last = distribution_update.apply_archive(
        older_manifest,
        older_archive,
        current_version="4.0.0-alpha.0",
        config_home=config_home,
        expected_digest=older_manifest["artifacts"][1]["digest"],
        execute=True,
    )

    assert (
        completed_last["frontendSelection"]["frontendBuildId"]
        == newer_manifest["frontendBuildId"]
    )
    selected = distribution_update.selected_cli_command(
        {
            "KUNGFU_INSTALL_SOURCE": "archive",
            "KF_CONFIG_HOME": str(config_home),
        },
        current_executable=tmp_path / "original" / "kungfu",
    )
    assert selected is not None
    command, _selected_env = selected
    assert newer_manifest["frontendBuildId"] in command[0]


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (
            lambda manifest: {
                **manifest,
                "qualificationEvidenceRef": "unqualified-local-build",
            },
            "release-unqualified",
        ),
        (
            lambda manifest: {
                **manifest,
                "artifacts": [
                    {**artifact, "signature": "unqualified-local-build"}
                    if artifact["kind"] == "cli"
                    else artifact
                    for artifact in manifest["artifacts"]
                ],
            },
            "signature-missing",
        ),
    ],
)
@pytest.mark.parametrize("execute", [False, True])
def test_apply_rechecks_publication_before_preview_or_inventory_write(
    tmp_path: Path, mutate, expected_code: str, execute: bool
) -> None:
    archive, manifest = _archive(tmp_path)
    manifest = mutate(manifest)

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.apply_archive(
            manifest,
            archive,
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            expected_digest=manifest["artifacts"][1]["digest"],
            execute=execute,
        )

    assert error.value.code == expected_code
    assert not (tmp_path / "config").exists()


def test_desktop_companion_never_selects_standalone_cli_image(tmp_path: Path) -> None:
    archive, manifest = _archive(tmp_path)
    distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    assert (
        distribution_update.selected_cli_command(
            {
                "KUNGFU_INSTALL_SOURCE": "desktop-companion",
                "KF_CONFIG_HOME": str(tmp_path / "config"),
            }
        )
        is None
    )


def test_package_manager_download_plan_never_self_updates(tmp_path: Path) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "winget"}),
        cache_root=tmp_path / "cache",
    )
    assert plan["state"] == "action-required"
    assert plan["reasonCode"] == "frontend-authority-external"
    assert plan["managerCommand"] is None


def test_cli_status_explains_frontend_runtime_and_no_daemon(tmp_path: Path) -> None:
    result = CliRunner().invoke(
        update_test_cli,
        ["--home", str(tmp_path), "update", "status", "--json"],
        env={"KUNGFU_INSTALL_SOURCE": "archive"},
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["schema"] == "kungfu.product-update-status/v1"
    assert payload["frontendVersion"] == "4.0.0-alpha.0"
    assert payload["installSource"]["source"] == "archive"
    assert payload["nativeReceiptRoot"] is None
    assert payload["backgroundUpdater"] is False
