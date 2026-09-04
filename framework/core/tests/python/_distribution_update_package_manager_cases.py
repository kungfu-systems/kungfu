# SPDX-License-Identifier: Apache-2.0

"""Dogfood residency and package-manager update contracts."""

from __future__ import annotations

from _distribution_update_support import *  # noqa: F403


def test_local_dogfood_residency_binds_product_mainline_profile_and_rollback(
    tmp_path: Path,
) -> None:
    commit = "a" * 40
    arch = {
        "arm64": "aarch64",
        "aarch64": "aarch64",
        "x64": "x86_64",
        "x86_64": "x86_64",
        "amd64": "x86_64",
    }.get(platform.machine().lower(), platform.machine().lower())
    os_name = {"Darwin": "macos", "Linux": "linux", "Windows": "windows"}.get(
        platform.system(), platform.system().lower()
    )
    registry = tmp_path / ".cache/kungfu/product" / f"{os_name}-{arch}"
    artifact = tmp_path / "Applications/Kungfu.app"
    runtime = artifact / "Contents/Resources/kungfu"
    upgrade = artifact / "Contents/Resources/upgrade/kungfu-release-manifest.json"
    rollback = registry / "previous-build"
    runtime.mkdir(parents=True)
    upgrade.parent.mkdir(parents=True)
    rollback.mkdir(parents=True)
    (rollback / "meta.env").write_text("KUNGFU_BUILD_SHA='old'\n", encoding="utf-8")
    (runtime / "kungfubuildinfo.json").write_text(
        json.dumps(
            {
                "version": "4.0.0-alpha.1",
                "git": {
                    "revision": commit,
                    "branch": "dev/v4/v4.0",
                    "pristine": True,
                },
            }
        ),
        encoding="utf-8",
    )
    (runtime / "profile-kfd3.json").write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "profileId": "kungfu.work-control",
                        "profileSuiteRoot": "sha256:" + "b" * 64,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    upgrade.write_text(
        json.dumps(
            {
                "schema": "kungfu.product-upgrade.manifest/v1",
                "sourceCommit": commit,
            }
        ),
        encoding="utf-8",
    )
    registry.mkdir(parents=True, exist_ok=True)
    (registry / "installed.meta.env").write_text(
        "\n".join(
            [
                f"KUNGFU_INSTALLED_SHA='{commit}'",
                "KUNGFU_INSTALLED_BUILD_ID='current-build'",
                f"KUNGFU_INSTALLED_ARTIFACT='{artifact}'",
                "KUNGFU_INSTALLED_DIGEST='sha256:" + "c" * 64 + "'",
                "KUNGFU_INSTALLED_MAINLINE_REF='origin/HEAD'",
                f"KUNGFU_INSTALLED_MAINLINE_SHA='{commit}'",
                "KUNGFU_INSTALLED_INTEGRATED='true'",
                "KUNGFU_INSTALLED_QUALIFIED='true'",
                "KUNGFU_ROLLBACK_BUILD_ID='previous-build'",
                "KUNGFU_ROLLBACK_SHA='" + "d" * 40 + "'",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (registry / "last-promotion.json").write_text(
        json.dumps(
            {
                "schema": "shifu.local-promotion-receipt/v1",
                "product": "kungfu",
                "action": "promote",
                "artifactId": "current-build",
                "toCommit": commit,
                "occurredAt": int(time.time()),
            }
        ),
        encoding="utf-8",
    )

    status = distribution_update.local_dogfood_residency(
        {
            "HOME": str(tmp_path),
            "KUNGFU_DIR": str(runtime),
            "KUNGFU_UPGRADE_MANIFEST": str(upgrade),
            "KUNGFU_CONTROLLER_ENTRYPOINT": "/usr/local/bin/kungfu",
        }
    )

    assert status["state"] == "qualified"
    assert status["sourceCommit"] == commit
    assert status["mainline"]["integrated"] is True
    assert status["controllerProfileRoots"] == ["sha256:" + "b" * 64]
    assert status["rollback"]["available"] is True
    assert status["rollback"]["checkCommand"] == [
        "shifu",
        "promote",
        "--rollback",
        "--check",
    ]
    assert status["qualification"]["promotionMatches"] is True
    assert status["freshness"]["state"] == "fresh"
    assert status["writes"] == []


def test_cli_package_manager_download_returns_one_external_action(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    manifest_file = tmp_path / "release.json"
    manifest_file.write_text(json.dumps(manifest), "utf-8")
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text(
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
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(tmp_path / "home"),
            "update",
            "download",
            str(manifest_file),
            "--json",
        ],
        env={"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)},
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["state"] == "action-required"
    assert payload["managerCommand"] == [
        "brew",
        "upgrade",
        "--formula",
        "kungfu-systems/tap/kungfu",
    ]


def test_cli_apply_stages_product_and_reports_core_activation_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive, manifest = _archive(tmp_path)
    manifest_file = tmp_path / "release.json"
    manifest_file.write_text(json.dumps(manifest), "utf-8")
    monkeypatch.setattr(
        update_command,
        "_activation_plan",
        lambda _ctx, _manifest: {
            "state": "apply-now",
            "reasonCode": "workspace-idle",
            "impact": {"activationTiming": "now"},
            "nextAction": "Reconcile semantic readiness.",
        },
    )
    result = CliRunner().invoke(
        update_test_cli,
        [
            "--home",
            str(tmp_path / "home"),
            "update",
            "apply",
            str(manifest_file),
            str(archive),
            "--expected-digest",
            manifest["artifacts"][1]["digest"],
            "--execute",
            "--json",
        ],
        env={"KUNGFU_INSTALL_SOURCE": "archive"},
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["frontendAction"] == "selected-on-next-command"
    assert payload["activationPlan"]["state"] == "apply-now"
    assert payload["message"]["reasonCode"] == "workspace-idle"


def test_one_command_plan_binds_channel_source_and_exact_action(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    archive_source = distribution_update.install_source(
        {"KUNGFU_INSTALL_SOURCE": "archive"}
    )
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=archive_source,
        cache_root=tmp_path / "cache",
    )
    assert plan["schema"] == distribution_update.ORCHESTRATION_PLAN_SCHEMA
    assert plan["state"] == "update-available"
    assert plan["action"] == "archive-self-update"
    assert plan["releasePayloadRoot"] == f"sha256:{'4' * 64}"
    assert plan["downloadPlan"]["planId"]
    assert plan["impact"]["activeWorkContinues"] is True

    current = distribution_update.plan_update(
        _selection({**manifest, "productVersion": "4.0.0-alpha.0"}),
        current_version="4.0.0-alpha.0",
        source=archive_source,
        cache_root=tmp_path / "cache",
    )
    assert current["state"] == "current"
    assert current["reasonCode"] == "already-current"

    manager_source = distribution_update.install_source(
        {"KUNGFU_INSTALL_SOURCE": "homebrew"}
    )
    manager_required = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=manager_source,
        cache_root=tmp_path / "cache",
    )
    assert manager_required["state"] == "action-required"
    assert manager_required["reasonCode"] == "manager-required"

    desktop = distribution_update.plan_update(
        _selection(manifest, source="desktop-companion"),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source(
            {"KUNGFU_INSTALL_SOURCE": "desktop-companion"}
        ),
        cache_root=tmp_path / "cache",
    )
    assert desktop["reasonCode"] == "desktop-required"
    assert desktop["action"] == "desktop-companion"

    unsupported = distribution_update.plan_update(
        _selection(manifest, source="native-installer"),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source(
            {"KUNGFU_INSTALL_SOURCE": "native-installer"}
        ),
        cache_root=tmp_path / "cache",
    )
    assert unsupported["reasonCode"] == "unsupported-source"


def test_one_command_plan_rejects_stale_identity(tmp_path: Path) -> None:
    _archive_path, manifest = _archive(tmp_path)
    plan = distribution_update.plan_update(
        _selection(manifest),
        current_version="4.0.0-alpha.0",
        source=distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "archive"}),
        cache_root=tmp_path / "cache",
    )
    changed = {**plan, "targetVersion": "4.0.0-alpha.9"}
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.validate_update_plan(
            changed, expected_plan_id=plan["planId"]
        )
    assert captured.value.code == "stale-plan"


def test_package_manager_execution_uses_exact_argv_and_writes_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text(
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
    source = distribution_update.install_source(
        {"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)}
    )
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )
    calls = []
    monkeypatch.setenv("KUNGFU_TEST_SECRET", "must-not-reach-manager")

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        output = "" if argv[0] == "brew" else f"kungfu {manifest['productVersion']}\n"
        return types.SimpleNamespace(returncode=0, stdout=output, stderr="")

    receipt = distribution_update.execute_update(
        plan,
        expected_plan_id=plan["planId"],
        current_version="4.0.0-alpha.0",
        config_home=tmp_path / "config",
        command_runner=runner,
        activation_planner=lambda value: {
            "state": "defer-until-idle",
            "impact": {"activationTiming": "after current work is idle"},
            "runtimeBuildId": value["runtimeBuildId"],
        },
    )
    assert [call[0] for call in calls] == [
        ["brew", "upgrade", "--formula", "kungfu-systems/tap/kungfu"],
        ["kungfu", "--version"],
    ]
    assert all(call[1]["shell"] is False for call in calls)
    assert all("KUNGFU_TEST_SECRET" not in call[1]["env"] for call in calls)
    assert receipt["state"] == "complete"
    assert receipt["result"]["verifiedVersion"] == manifest["productVersion"]
    assert Path(receipt["receiptPath"]).is_file()
    assert json.loads(Path(receipt["receiptPath"]).read_text("utf-8")) == receipt


def test_package_manager_failure_is_durable_and_recoverable(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(_argv, **_kwargs):
        return types.SimpleNamespace(returncode=1, stdout="", stderr="private detail")

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == "update-command-failed"
    assert captured.value.receipt is not None
    assert captured.value.receipt["state"] == "failed"
    receipt_paths = list(
        (tmp_path / "config" / "product" / "update" / "receipts" / plan["planId"]).glob(
            "*.json"
        )
    )
    assert len(receipt_paths) == 1
    receipt_path = receipt_paths[0]
    receipt = json.loads(receipt_path.read_text("utf-8"))
    assert receipt["state"] == "failed"
    assert receipt["reasonCode"] == "update-command-failed"
    assert receipt["recoveryAction"]
    assert "private detail" not in receipt_path.read_text("utf-8")


def test_homebrew_product_manifest_rejects_untrusted_or_incomplete_argv(
    tmp_path: Path,
) -> None:
    product_manifest = tmp_path / "product.json"
    product_manifest.write_text(
        json.dumps(
            {
                "install": {
                    "source": "homebrew",
                    "managerCommand": ["sh", "-c", "brew upgrade kungfu"],
                    "verificationCommand": ["kungfu", "--version"],
                }
            }
        ),
        "utf-8",
    )
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.install_source(
            {"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)}
        )
    assert captured.value.code == "package-manager-command-untrusted"

    product_manifest.write_text(
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
                }
            }
        ),
        "utf-8",
    )
    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.install_source(
            {"KUNGFU_PRODUCT_MANIFEST": str(product_manifest)}
        )
    assert captured.value.code == "package-manager-contract-incomplete"


@pytest.mark.parametrize(
    ("stderr", "reason_code"),
    [
        (
            "Error: No available formula with the name kungfu-systems/tap/kungfu",
            "package-manager-formula-unavailable",
        ),
        ("Error: No such keg: kungfu", "package-manager-formula-not-installed"),
        ("curl: Could not resolve host: github.com", "package-manager-offline"),
        ("Error: /opt/homebrew is not writable", "package-manager-permission-denied"),
    ],
)
def test_homebrew_failure_diagnostics_are_stable_and_do_not_leak_stderr(
    tmp_path: Path,
    stderr: str,
    reason_code: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(_argv, **_kwargs):
        return types.SimpleNamespace(returncode=1, stdout="", stderr=stderr)

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == reason_code
    assert captured.value.receipt is not None
    assert captured.value.receipt["reasonCode"] == reason_code
    assert stderr not in json.dumps(captured.value.receipt)


@pytest.mark.parametrize(
    ("raised", "reason_code", "receipt_state"),
    [
        (FileNotFoundError("brew"), "package-manager-unavailable", "failed"),
        (
            subprocess.TimeoutExpired(["brew"], 900),
            "update-command-timeout",
            "failed",
        ),
        (KeyboardInterrupt(), "update-cancelled", "cancelled"),
    ],
)
def test_homebrew_start_timeout_and_cancellation_have_stable_receipts(
    tmp_path: Path,
    raised: BaseException,
    reason_code: str,
    receipt_state: str,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(_argv, **_kwargs):
        raise raised

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == reason_code
    assert captured.value.receipt is not None
    assert captured.value.receipt["state"] == receipt_state
    assert captured.value.receipt["reasonCode"] == reason_code


def test_homebrew_completed_command_requires_exact_target_version(
    tmp_path: Path,
) -> None:
    _archive_path, manifest = _archive(tmp_path)
    source = {
        **distribution_update.install_source({"KUNGFU_INSTALL_SOURCE": "homebrew"}),
        "managerCommand": [
            "brew",
            "upgrade",
            "--formula",
            "kungfu-systems/tap/kungfu",
        ],
        "verificationCommand": ["kungfu", "--version"],
    }
    plan = distribution_update.plan_update(
        _selection(manifest, source="homebrew"),
        current_version="4.0.0-alpha.0",
        source=source,
        cache_root=tmp_path / "cache",
    )

    def runner(argv, **_kwargs):
        stdout = "" if argv[0] == "brew" else "kungfu 4.0.0-alpha.0\n"
        return types.SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    with pytest.raises(distribution_update.DistributionUpdateError) as captured:
        distribution_update.execute_update(
            plan,
            expected_plan_id=plan["planId"],
            current_version="4.0.0-alpha.0",
            config_home=tmp_path / "config",
            command_runner=runner,
        )
    assert captured.value.code == "update-verification-failed"
    assert captured.value.receipt is not None
    assert captured.value.receipt["reasonCode"] == "update-verification-failed"
