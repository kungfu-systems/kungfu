# SPDX-License-Identifier: Apache-2.0

"""Release selection, versioning, and downgrade contracts."""

from __future__ import annotations

from _distribution_update_support import *  # noqa: F403


def test_install_sources_keep_package_managers_authoritative(tmp_path: Path) -> None:
    archive = distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"})
    assert archive["selfUpdateAllowed"] is True
    assert archive["managerCommand"] is None

    homebrew_product = tmp_path / "homebrew-product.json"
    homebrew_product.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": [
                        "brew",
                        "upgrade",
                        "--formula",
                        "kungfu-systems/tap/kungfu",
                    ],
                    "verificationCommand": ["kungfu", "--version"],
                }
            }
        ),
        "utf-8",
    )
    homebrew = distribution_update.install_source({}, product_manifest=homebrew_product)
    assert homebrew["selfUpdateAllowed"] is False
    assert homebrew["managerCommand"] == [
        "brew",
        "upgrade",
        "--formula",
        "kungfu-systems/tap/kungfu",
    ]
    assert homebrew["verificationCommand"] == ["kungfu", "--version"]

    product = tmp_path / "product.json"
    product.write_text(
        json.dumps({"install": {"source": "desktop-companion"}}), "utf-8"
    )
    companion = distribution_update.install_source({}, product_manifest=product)
    assert companion["frontendAuthority"] == "desktop-updater"
    assert companion["selfUpdateAllowed"] is False


def test_signed_release_check_is_platform_and_source_bound(tmp_path: Path) -> None:
    _archive_path, manifest = _archive(tmp_path)
    checked = distribution_update.check_release(
        manifest,
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
    )
    assert checked["state"] == "available"
    assert checked["frontendAction"] == "download"
    assert checked["message"]["reasonCode"] == "new-product-version"
    assert checked["message"]["documentationUrl"].endswith("#check-and-plan-an-update")

    unqualified = {**manifest, "qualificationEvidenceRef": "unqualified-local-build"}
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.check_release(
            unqualified,
            current_version="4.0.0-alpha.0",
            source=checked["installSource"],
        )
    assert error.value.code == "release-unqualified"


@pytest.mark.parametrize("mismatch", ["platform", "architecture"])
@pytest.mark.parametrize(
    ("operation", "execute"),
    [
        ("check", False),
        ("download", False),
        ("apply", False),
        ("apply", True),
    ],
)
def test_self_update_entrypoints_reject_wrong_release_target_before_writes(
    tmp_path: Path, mismatch: str, operation: str, execute: bool
) -> None:
    current_platform, current_architecture = distribution_update._normalize_platform()
    platform = current_platform
    architecture = current_architecture
    if mismatch == "platform":
        platform = "win32" if current_platform != "win32" else "linux"
    else:
        architecture = "arm64" if current_architecture != "arm64" else "x64"
    archive, manifest = _archive(
        tmp_path,
        platform=platform,
        architecture=architecture,
    )
    source = distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"})

    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        if operation == "check":
            distribution_update.check_release(
                manifest,
                current_version="4.0.0-alpha.0",
                source=source,
            )
        elif operation == "download":
            distribution_update.plan_download(
                manifest,
                current_version="4.0.0-alpha.0",
                source=source,
                cache_root=tmp_path / "cache",
            )
        else:
            distribution_update.apply_archive(
                manifest,
                archive,
                current_version="4.0.0-alpha.0",
                config_home=tmp_path / "config",
                expected_digest=manifest["artifacts"][1]["digest"],
                execute=execute,
            )

    assert error.value.code == "release-target-mismatch"
    assert not (tmp_path / "cache").exists()
    assert not (tmp_path / "config").exists()


@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("4.0.0-alpha.2", "4.0.0-alpha.1", 1),
        ("4.0.0-alpha.10", "4.0.0-alpha.2", 1),
        ("4.0.0", "4.0.0-rc.1", 1),
        ("4.0.0+build.2", "4.0.0+build.1", 0),
        ("3.9.9", "4.0.0-alpha.0", -1),
    ],
)
def test_product_version_order_follows_semver(
    left: str, right: str, expected: int
) -> None:
    assert distribution_update.compare_product_versions(left, right) == expected


@pytest.mark.parametrize("version", ["4.0", "04.0.0", "4.0.0-alpha.01"])
def test_product_version_order_rejects_invalid_semver(version: str) -> None:
    with pytest.raises(distribution_update.DistributionUpdateError) as error:
        distribution_update.compare_product_versions(version, "4.0.0")
    assert error.value.code == "product-version-invalid"


def test_downgrade_fails_before_download_or_inventory_write(tmp_path: Path) -> None:
    archive, manifest = _archive(tmp_path, product_version="3.9.9")
    source = distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"})
    checked = distribution_update.check_release(
        manifest,
        current_version="4.0.0-alpha.0",
        source=source,
    )
    assert checked["state"] == "action-required"
    assert checked["reasonCode"] == "downgrade-refused"
    assert checked["frontendAction"] == "none"
    assert checked["message"]["documentationUrl"].endswith(
        "#downgrades-require-a-recovery-decision"
    )

    download = distribution_update.plan_download(
        manifest,
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )
    assert download["state"] == "action-required"
    assert download["reasonCode"] == "downgrade-refused"
    assert "target" not in download

    applied = distribution_update.apply_archive(
        manifest,
        archive,
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        expected_digest=manifest["artifacts"][1]["digest"],
        execute=True,
    )
    assert applied["state"] == "action-required"
    assert applied["reasonCode"] == "downgrade-refused"
    assert not (tmp_path / "config").exists()


def test_cli_projects_one_downgrade_refusal_without_running_activation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current_platform, current_architecture = distribution_update._normalize_platform()
    archive, manifest = _archive(
        tmp_path,
        platform=current_platform,
        architecture=current_architecture,
        product_version="3.9.9",
    )
    manifest_file = tmp_path / "release.json"
    manifest_file.write_text(json.dumps(manifest), "utf-8")
    monkeypatch.setattr(
        update_command,
        "_activation_plan",
        lambda _ctx, _manifest: pytest.fail(
            "downgrade refusal must not enter Core activation"
        ),
    )
    for args in [
        ["update", "check", str(manifest_file), "--json"],
        ["update", "download", str(manifest_file), "--json"],
        [
            "update",
            "apply",
            str(manifest_file),
            str(archive),
            "--expected-digest",
            manifest["artifacts"][1]["digest"],
            "--execute",
            "--json",
        ],
    ]:
        result = CliRunner().invoke(
            update_test_cli,
            ["--home", str(tmp_path / "home"), *args],
            env={"KUNGFU_INSTALL_SOURCE": "archive"},
        )
        assert result.exit_code == 0, result.output
        payload = json.loads(result.output)
        assert payload["state"] == "action-required"
        assert payload["reasonCode"] == "downgrade-refused"
        assert payload["message"]["messageReasonCode"] == "downgrade-refused"
    assert not (tmp_path / "home" / "config").exists()
