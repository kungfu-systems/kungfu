# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path

import pytest
import click
from click.testing import CliRunner


def _install_fake_pykungfu():
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.runtime = types.ModuleType("pykungfu.runtime")
    fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
    fake.yijinjing = types.SimpleNamespace()
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", fake.runtime)


_install_fake_pykungfu()

import kungfu  # noqa: E402

kungfu.__version__ = "test"

from kungfu import runtime_service, runtime_upgrade  # noqa: E402
from kungfu.cli.commands.runtime import runtime as runtime_cli  # noqa: E402


ROOT = Path(__file__).parents[4]
CASES = json.loads(
    (ROOT / "tests/fixtures/runtime-upgrade-control-plane/cases.json").read_text()
)["cases"]


@click.group()
@click.option("--home", type=click.Path(), required=True)
@click.pass_context
def upgrade_test_cli(ctx, home):
    ctx.name = "runtime-upgrade-test"
    ctx.config_home = str(Path(home) / "config")
    ctx.home = str(home)
    ctx.extension_path = None
    ctx.log_level = "warning"
    ctx.runtime_dir = str(Path(home) / "runtime")
    ctx.dataset_dir = str(Path(home) / "dataset")
    ctx.backtest_dir = str(Path(home) / "backtest")
    ctx.inbox_dir = str(Path(home) / "inbox")
    ctx.runtime_locator = None
    ctx.backtest_locator = None
    ctx.config_location = None
    ctx.console_location = None
    ctx.index_location = None
    ctx.stage = "test"


upgrade_test_cli.add_command(runtime_cli)


def _source(root: Path, name: str) -> Path:
    source = root / name
    (source / "bin").mkdir(parents=True)
    entrypoint = source / "bin" / "kungfu"
    entrypoint.write_text(f"#!/bin/sh\necho {name}\n", "utf-8")
    entrypoint.chmod(0o755)
    (source / "runtime.txt").write_text(name, "utf-8")
    return source


def _manifest(
    source: Path,
    build_id: str,
    *,
    protocol: int = 2,
    migration_class: str = "reversible",
    rollback_class: str = "automatic",
) -> dict:
    digest = runtime_upgrade.tree_digest(source)
    return {
        "schema": runtime_upgrade.MANIFEST_SCHEMA,
        "productVersion": "4.0.0-alpha.1",
        "releaseChannel": "alpha/v4/v4.0",
        "sourceCommit": "1" * 40,
        "runtimeBuildId": build_id,
        "runtimeArtifactDigest": digest,
        "runtimeEntrypoint": "bin/kungfu",
        "frontendBuildId": f"frontend-{build_id}",
        "controlProtocolRange": {"min": protocol, "max": protocol},
        "peerWireProtocolRange": {"min": protocol, "max": protocol},
        "journalSchemaReadRange": {"min": protocol, "max": protocol},
        "journalSchemaWriteVersion": protocol,
        "migrationClass": migration_class,
        "rollbackClass": rollback_class,
        "minimumSupportedFrontend": "4.0.0-alpha.1",
        "minimumSupportedRuntime": "4.0.0-alpha.1",
        "platform": "darwin",
        "architecture": "arm64",
        "artifacts": [
            {
                "kind": "runtime",
                "url": f"https://example.invalid/{build_id}.tar.zst",
                "size": 1,
                "digest": digest,
                "signature": f"fixture-signature-{build_id}",
            }
        ],
        "qualificationEvidenceRef": f"fixture:{build_id}",
        "documentationUrl": "https://www.kungfu.tech/docs/guides/upgrading",
    }


def _install(config_home: Path, source: Path, manifest: dict, clock_ns: int) -> dict:
    plan = runtime_upgrade.plan_install(
        manifest,
        source,
        config_home,
        clock_ns=clock_ns,
    )
    return runtime_upgrade.install_image(
        plan,
        expected_plan_id=plan["planId"],
        config_home=config_home,
        clock_ns=clock_ns,
    )


def _reference(build_id: str, state: str = "active") -> dict:
    return {
        "schema": runtime_upgrade.REFERENCE_SCHEMA,
        "ownerKind": "lease",
        "ownerId": f"lease-{build_id}",
        "buildId": build_id,
        "state": state,
    }


def test_release_manifest_accepts_named_artifacts_without_weakening_schema(
    tmp_path,
):
    source = _source(tmp_path, "runtime-named-artifacts")
    manifest = _manifest(source, "runtime-named-artifacts")
    manifest["artifacts"].extend(
        [
            {
                "name": "Kungfu.Episodes.Setup.4.0.0-alpha.2.exe",
                "kind": "desktop",
                "url": "https://example.invalid/Kungfu.Episodes.Setup.4.0.0-alpha.2.exe",
                "size": 2,
                "digest": f"sha256:{'2' * 64}",
                "signature": "sigstore:desktop-fixture",
            },
            {
                "name": "kungfu-episodes-cli-windows-x64.zip",
                "kind": "cli",
                "url": "https://example.invalid/kungfu-episodes-cli-windows-x64.zip",
                "size": 3,
                "digest": f"sha256:{'3' * 64}",
                "signature": "sigstore:cli-fixture",
            },
        ]
    )

    assert runtime_upgrade.validate_manifest(manifest) == manifest

    manifest["artifacts"][1]["unexpected"] = "not-authority"
    with pytest.raises(ValueError, match="Additional properties are not allowed"):
        runtime_upgrade.validate_manifest(manifest)


def test_user_message_answers_product_questions_and_links_exact_reason() -> None:
    message = runtime_upgrade.user_message(
        "active-work-incompatible",
        documentation_url="https://www.kungfu.tech/docs/guides/upgrading",
        impact={
            "activeWorkContinues": True,
            "activationTiming": "after-safe-point",
            "userActionRequired": False,
        },
    )
    assert message["schema"] == runtime_upgrade.MESSAGE_SCHEMA
    assert message["reasonCode"] == "active-work-incompatible"
    assert message["activeWork"]
    assert message["activation"]
    assert message["userAction"]
    assert message["dataAndSessions"]
    assert message["documentationUrl"].endswith("#updates-while-work-is-active")

    fallback = runtime_upgrade.user_message(
        "future-reason",
        documentation_url="https://www.kungfu.tech/docs/guides/upgrading#old",
    )
    assert fallback["messageReasonCode"] == "action-required"
    assert fallback["reasonCode"] == "future-reason"
    assert fallback["documentationUrl"].endswith("#troubleshooting")


def test_release_check_impact_marks_generic_action_required() -> None:
    assert runtime_upgrade.release_check_impact(
        "cut-diverged",
        state="action-required",
    ) == {
        "activeWorkContinues": True,
        "activationTiming": "after-required-action",
        "userActionRequired": True,
    }


def test_runtime_reference_discovery_projects_live_core_facts(tmp_path):
    source = _source(tmp_path, "runtime-a")
    current = _install(tmp_path / "config", source, _manifest(source, "runtime-a"), 1)
    status = {
        "product": {
            "workspaceId": "workspace-a",
            "liveState": "ready",
            "handle": {"workspaceId": "workspace-a", "generation": "7"},
            "leases": {
                "activeCount": 1,
                "items": [
                    {
                        "leaseId": "lease-a",
                        "holderId": "holder-a",
                        "state": "active",
                    }
                ],
            },
            "error": None,
        },
        "lifecycle": {"state": "ready"},
        "coordinator": {
            "running": True,
            "pid": 42,
            "startIdentity": "start-42",
        },
        "lastState": {"runtimeImage": current},
    }

    references = runtime_upgrade.references_from_runtime_status(status, current)

    assert [(item["ownerKind"], item["ownerId"]) for item in references] == [
        ("generation", "workspace-a:7"),
        ("lease", "lease-a"),
        ("process", "coordinator:start-42"),
    ]
    assert {item["buildId"] for item in references} == {"runtime-a"}


def test_runtime_reference_discovery_fails_closed_on_uncertain_state(tmp_path):
    source = _source(tmp_path, "runtime-a")
    current = _install(tmp_path / "config", source, _manifest(source, "runtime-a"), 1)
    references = runtime_upgrade.references_from_runtime_status(
        {
            "product": {
                "workspaceId": "workspace-a",
                "handle": None,
                "leases": {"items": []},
                "error": {"code": "stale-generation"},
            },
            "lifecycle": {"state": "failed"},
            "coordinator": {"running": False},
            "lastState": {},
        },
        current,
    )

    assert references == [
        {
            "schema": runtime_upgrade.REFERENCE_SCHEMA,
            "ownerKind": "recovery",
            "ownerId": "runtime-status:workspace-a",
            "buildId": "runtime-a",
            "state": "retained",
        }
    ]


def test_install_is_side_by_side_verified_and_idempotent(tmp_path):
    source = _source(tmp_path, "runtime-a")
    manifest = _manifest(source, "runtime-a")
    plan = runtime_upgrade.plan_install(
        manifest, source, tmp_path / "config", clock_ns=1
    )

    assert plan["state"] == "download-allowed"
    image = runtime_upgrade.install_image(
        plan,
        expected_plan_id=plan["planId"],
        config_home=tmp_path / "config",
        clock_ns=2,
    )
    repeated = runtime_upgrade.install_image(
        plan,
        expected_plan_id=plan["planId"],
        config_home=tmp_path / "config",
        clock_ns=3,
    )

    assert image == repeated
    assert Path(image["artifactRoot"]).name == "runtime-a"
    assert runtime_upgrade.tree_digest(source) == manifest["runtimeArtifactDigest"]
    assert runtime_upgrade.list_images(tmp_path / "config") == [image]


def test_install_preserves_internal_relative_symlink(tmp_path):
    source = _source(tmp_path, "runtime-links")
    (source / "bin" / "python3").write_text("runtime", "utf-8")
    (source / "bin" / "python").symlink_to("python3")
    manifest = _manifest(source, "runtime-links")
    plan = runtime_upgrade.plan_install(
        manifest, source, tmp_path / "config", clock_ns=1
    )

    image = runtime_upgrade.install_image(
        plan,
        expected_plan_id=plan["planId"],
        config_home=tmp_path / "config",
        clock_ns=2,
    )

    installed_link = Path(image["artifactRoot"]) / "bin" / "python"
    assert installed_link.is_symlink()
    assert installed_link.readlink() == Path("python3")
    assert installed_link.read_text("utf-8") == "runtime"


def test_tree_digest_rejects_escaping_symlink(tmp_path):
    source = _source(tmp_path, "runtime-escape")
    outside = tmp_path / "outside"
    outside.write_text("outside", "utf-8")
    (source / "bin" / "python").symlink_to(outside)

    with pytest.raises(runtime_upgrade.UpgradeError) as error:
        runtime_upgrade.tree_digest(source)

    assert error.value.code == "artifact-symlink-unsupported"


def test_cli_exposes_one_welded_upgrade_contract_and_inventory(tmp_path):
    runner = CliRunner()
    home = tmp_path / "home"
    contract_result = runner.invoke(
        upgrade_test_cli,
        ["--home", str(home), "runtime", "upgrade", "contract", "--json"],
    )
    inventory_result = runner.invoke(
        upgrade_test_cli,
        ["--home", str(home), "runtime", "upgrade", "inventory", "--json"],
    )

    assert contract_result.exit_code == 0, contract_result.output
    assert json.loads(contract_result.output)["schema"] == (
        "kungfu.product-upgrade.contract/v1"
    )
    assert inventory_result.exit_code == 0, inventory_result.output
    assert json.loads(inventory_result.output) == {
        "schema": "kungfu.runtime-image-inventory/v1",
        "images": [],
    }


def test_corrupt_artifact_is_rejected_and_quarantine_is_recorded(tmp_path):
    source = _source(tmp_path, "runtime-a")
    manifest = _manifest(source, "runtime-a")
    plan = runtime_upgrade.plan_install(
        manifest, source, tmp_path / "config", clock_ns=1
    )
    (source / "runtime.txt").write_text("corrupt", "utf-8")

    with pytest.raises(runtime_upgrade.UpgradeError) as failure:
        runtime_upgrade.install_image(
            plan,
            expected_plan_id=plan["planId"],
            config_home=tmp_path / "config",
        )

    assert failure.value.code == "artifact-digest-mismatch"
    assert not (tmp_path / "config/runtime/images/runtime-a").exists()
    assert len(list((tmp_path / "config/runtime/quarantine").glob("*.json"))) == 1


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_upgrade_planning_matrix(case, tmp_path):
    old_source = _source(tmp_path, f"{case['id']}-old")
    target_source = _source(tmp_path, f"{case['id']}-target")
    old = _install(
        tmp_path / "config", old_source, _manifest(old_source, f"{case['id']}-old"), 1
    )
    target_protocol = 2 if case["compatible"] else 3
    target = _install(
        tmp_path / "config",
        target_source,
        _manifest(
            target_source,
            f"{case['id']}-target",
            protocol=target_protocol,
            migration_class=case["migrationClass"],
        ),
        2,
    )
    references = [_reference(old["buildId"])] if case["active"] else []

    plan = runtime_upgrade.plan_upgrade(
        workspace_id="workspace-test",
        target=target,
        current=old,
        references=references,
        active_generation="7" if case["active"] else None,
        provider_resume_required=case.get("providerResumeRequired", False),
        provider_resume_supported=case.get("providerResumeSupported", False),
        backup_ready=False,
        user_confirmed=False,
        clock_ns=3,
    )

    assert plan["state"] == case["expectedState"]
    assert plan["impact"]["activeWorkContinues"] is case["active"]


def test_stale_generation_cannot_stage_and_readiness_commits_or_rolls_back(tmp_path):
    config_home = tmp_path / "config"
    old_source = _source(tmp_path, "old")
    new_source = _source(tmp_path, "new")
    old = _install(config_home, old_source, _manifest(old_source, "old"), 1)
    new = _install(config_home, new_source, _manifest(new_source, "new"), 2)
    plan = runtime_upgrade.plan_upgrade(
        workspace_id="workspace-test",
        target=new,
        current=old,
        references=[],
        active_generation="4",
        clock_ns=3,
    )

    with pytest.raises(runtime_upgrade.UpgradeError) as failure:
        runtime_upgrade.stage_upgrade(
            plan,
            expected_plan_id=plan["planId"],
            current_generation="5",
            config_home=config_home,
        )
    assert failure.value.code == "stale-generation"

    receipt = runtime_upgrade.stage_upgrade(
        plan,
        expected_plan_id=plan["planId"],
        current_generation="4",
        config_home=config_home,
        clock_ns=4,
    )
    rolled_back = runtime_upgrade.reconcile_upgrade(
        receipt,
        readiness_passed=False,
        config_home=config_home,
    )
    assert rolled_back["state"] == "failed-rolled-back"
    assert (
        runtime_upgrade.active_image(config_home, "workspace-test")["buildId"] == "old"
    )

    with pytest.raises(runtime_upgrade.UpgradeError) as stale_receipt:
        runtime_upgrade.reconcile_upgrade(
            receipt,
            readiness_passed=True,
            config_home=config_home,
        )
    assert stale_receipt.value.code == "stale-receipt"

    retry = runtime_upgrade.plan_upgrade(
        workspace_id="workspace-commit-test",
        target=new,
        current=old,
        references=[],
        active_generation="4",
        clock_ns=5,
    )
    completed = runtime_upgrade.reconcile_upgrade(
        runtime_upgrade.stage_upgrade(
            retry,
            expected_plan_id=retry["planId"],
            current_generation="4",
            config_home=config_home,
            clock_ns=6,
        ),
        readiness_passed=True,
        config_home=config_home,
    )
    assert completed["state"] == "complete"
    assert (
        runtime_upgrade.active_image(config_home, "workspace-commit-test")["buildId"]
        == "new"
    )


def test_generation_pin_is_immutable_when_current_pointer_changes(
    tmp_path, monkeypatch
):
    config_home = tmp_path / "config"
    source_a = _source(tmp_path, "runtime-a")
    source_b = _source(tmp_path, "runtime-b")
    image_a = _install(config_home, source_a, _manifest(source_a, "runtime-a"), 1)
    image_b = _install(config_home, source_b, _manifest(source_b, "runtime-b"), 2)

    command_a = runtime_upgrade.pinned_entry_command(image_a)
    monkeypatch.setenv("KF_RUNTIME_BUILD_ID", image_b["buildId"])
    monkeypatch.setenv("KF_RUNTIME_ARTIFACT_ROOT", image_b["artifactRoot"])
    monkeypatch.setenv("KF_RUNTIME_ENTRYPOINT", image_b["entrypoint"])
    monkeypatch.setenv("KF_RUNTIME_MANIFEST_DIGEST", image_b["manifestDigest"])

    assert runtime_upgrade.pinned_entry_command(image_a) == command_a
    assert command_a != runtime_upgrade.pinned_entry_command(image_b)
    assert runtime_upgrade.image_from_environment(os.environ)["buildId"] == "runtime-b"

    coordinator = runtime_service.coordinator_run_command(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
        "warning",
        image_a,
    )
    child_env = runtime_service.command_env(
        str(tmp_path / "home"),
        str(tmp_path / "runtime"),
        "warning",
        str(config_home),
        runtime_image=image_a,
    )
    assert coordinator[0] == command_a[0]
    assert child_env["KF_RUNTIME_BUILD_ID"] == "runtime-a"
    assert child_env["KF_RUNTIME_ARTIFACT_ROOT"] == image_a["artifactRoot"]


def test_gc_retains_live_images_and_fails_closed_on_unknown_references(tmp_path):
    config_home = tmp_path / "config"
    source_a = _source(tmp_path, "runtime-a")
    source_b = _source(tmp_path, "runtime-b")
    image_a = _install(config_home, source_a, _manifest(source_a, "runtime-a"), 1)
    image_b = _install(config_home, source_b, _manifest(source_b, "runtime-b"), 2)

    blocked = runtime_upgrade.plan_gc(
        [image_a, image_b],
        [_reference("runtime-a")],
        unknown_references=True,
        clock_ns=3,
    )
    assert blocked["state"] == "action-required"
    assert blocked["candidates"] == []

    plan = runtime_upgrade.plan_gc(
        [image_a, image_b],
        [_reference("runtime-a")],
        clock_ns=4,
    )
    assert [item["buildId"] for item in plan["blocked"]] == ["runtime-a"]
    assert [item["buildId"] for item in plan["candidates"]] == ["runtime-b"]
    assert runtime_upgrade.apply_gc(
        plan,
        expected_plan_id=plan["planId"],
        config_home=config_home,
        references=[_reference("runtime-a")],
    ) == ["runtime-b"]
    assert Path(image_a["artifactRoot"]).is_dir()
    assert not Path(image_b["artifactRoot"]).exists()


def test_gc_apply_rejects_a_new_reference_without_deleting_any_image(tmp_path):
    config_home = tmp_path / "config"
    source = _source(tmp_path, "runtime-a")
    image = _install(config_home, source, _manifest(source, "runtime-a"), 1)
    plan = runtime_upgrade.plan_gc([image], [], clock_ns=2)

    with pytest.raises(runtime_upgrade.UpgradeError) as failure:
        runtime_upgrade.apply_gc(
            plan,
            expected_plan_id=plan["planId"],
            config_home=config_home,
            references=[_reference("runtime-a")],
        )

    assert failure.value.code == "stale-plan"
    assert Path(image["artifactRoot"]).is_dir()


def test_qualification_churns_128_generations_without_mixed_authority_or_data_loss(
    tmp_path,
):
    config_home = tmp_path / "config"
    workspace_fact = tmp_path / "workspace" / "episode-fact.json"
    workspace_fact.parent.mkdir()
    workspace_fact.write_text('{"owner":"workspace","retained":true}\n', "utf-8")
    images = []
    current = None

    for index in range(128):
        build_id = f"qualification-{index:03d}"
        source = _source(tmp_path / "sources", build_id)
        target = _install(
            config_home,
            source,
            _manifest(source, build_id),
            index * 3 + 1,
        )
        active_generation = str(index) if current is not None else None
        plan = runtime_upgrade.plan_upgrade(
            workspace_id="qualification-workspace",
            target=target,
            current=current,
            references=[],
            active_generation=active_generation,
            clock_ns=index * 3 + 2,
        )
        assert plan["state"] == "apply-now"
        receipt = runtime_upgrade.stage_upgrade(
            plan,
            expected_plan_id=plan["planId"],
            current_generation=active_generation,
            config_home=config_home,
            clock_ns=index * 3 + 3,
        )
        completed = runtime_upgrade.reconcile_upgrade(
            receipt,
            readiness_passed=True,
            config_home=config_home,
        )
        assert completed["state"] == "complete"
        assert (
            runtime_upgrade.active_image(config_home, "qualification-workspace")[
                "buildId"
            ]
            == build_id
        )
        images.append(target)
        current = target

    reference = _reference(current["buildId"])
    gc_plan = runtime_upgrade.plan_gc(images, [reference], clock_ns=1000)
    removed = runtime_upgrade.apply_gc(
        gc_plan,
        expected_plan_id=gc_plan["planId"],
        config_home=config_home,
        references=[reference],
    )

    assert len(removed) == 127
    assert [image["buildId"] for image in runtime_upgrade.list_images(config_home)] == [
        current["buildId"]
    ]
    assert workspace_fact.read_text("utf-8") == (
        '{"owner":"workspace","retained":true}\n'
    )
    assert not (config_home / "runtime" / "quarantine").exists()
