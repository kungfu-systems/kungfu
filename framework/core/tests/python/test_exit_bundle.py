# SPDX-License-Identifier: Apache-2.0

import copy
from pathlib import Path

from click.testing import CliRunner

from kungfu import exit_bundle, profile_composition, profile_sdk
from kungfu.agent import work_profile
from kungfu.atlas import mission_control
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import fact_profile_shadow
from kungfu.storage import service as storage_service


MISSION_PROFILE_SOURCE = (
    Path(__file__).resolve().parents[4] / "extensions" / "mission-control"
)


def _activate_mission_profile(runtime_dir):
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime_dir,
            action,
            MISSION_PROFILE_SOURCE,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime_dir, plan, f"exit-test:{action}")
    contract = profile_composition.contract_materialization_plan(
        MISSION_PROFILE_SOURCE, runtime_dir
    )
    if contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime_dir,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"], "approve", "exit-test-owner"
            ),
        )


def _sealed_episode(runtime_dir, episode_id):
    storage_service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        begin_time=episode_id * 10,
        title=f"Exit fixture {episode_id}",
        actor="pytest",
        source="exit-composition-test",
    )
    storage_service.episode_end(
        runtime_dir,
        episode_id=episode_id,
        end_time=episode_id * 10 + 1,
        reason="sealed for exit composition",
    )


def _request(*episode_ids, mode="full"):
    return {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": f"exit:test-{mode}",
        "mode": mode,
        "scope": {
            "id": "test/work-item",
            "authority": "pytest",
            "schema": "test.work-item/v1",
            "protocol": "test-work-item-root/v1",
        },
        "members": [
            {
                "memberId": f"episode-{episode_id}",
                "kind": "episode-v1",
                "requiredForScope": True,
                "options": {"episodeId": episode_id},
            }
            for episode_id in episode_ids
        ],
    }


def _root(label):
    return fact_profile_shadow.semantic_root("exit-composition-test/v1", label)


def _work_profile_request():
    return {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": "exit-composition-bootstrap",
        "refName": "profiles/kfd-7/exit-composition",
        "basis": {"cutRoot": None, "revision": 0},
        "ref": {"cutRoot": None, "revision": 0},
        "subject": {
            "role": "fact",
            "operation": "create",
            "fromState": "absent",
            "toState": "declared",
        },
        "responsibilities": {
            role: {
                "objectId": f"fact:{index:032x}",
                "expectedVersionRoot": None,
            }
            for index, role in enumerate(work_profile.ROLES, start=1)
        },
        "roleInputs": {
            "fact": {"state": "declared", "details": {"cutKind": "exit-test"}},
            "episode": {
                "state": "open",
                "details": {"episodeId": "episode:exit-test"},
            },
            "pursuit": {
                "state": "active",
                "details": {"success": "exact exit roundtrip"},
            },
            "atlas": {
                "state": "current",
                "details": {"validThroughRevision": 1},
            },
            "warrant": {
                "state": "issued",
                "details": {
                    "validThroughRevision": 1,
                    "allowedOperations": ["*"],
                },
            },
        },
        "relations": [],
        "support": {
            "createdByReceiptRoot": _root("created"),
            "schemaRoot": _root("schema"),
            "declarationRoots": [_root("declaration")],
            "admissionRoots": [_root("admission")],
            "reasonRoot": _root("reason"),
        },
    }


def _single_member_request(member_id, kind, options):
    return {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": f"exit:{member_id}",
        "mode": "full",
        "scope": {
            "id": f"fixture/{member_id}",
            "authority": "pytest",
            "schema": "test.exit-member/v1",
            "protocol": "test-exit-member-root/v1",
        },
        "members": [
            {
                "memberId": member_id,
                "kind": kind,
                "requiredForScope": True,
                "options": options,
            }
        ],
    }


def test_episode_exit_package_roundtrip_is_exact_and_idempotent(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _sealed_episode(source, 701)

    package = exit_bundle.build(source, _request(701))
    inspection = exit_bundle.inspect(package)
    preview = exit_bundle.import_package(destination, package)
    imported = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )
    repeated = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )

    assert package["schema"] == "kungfu.exit-package/v1"
    assert package["manifest"]["schema"] == "kungfu.exit-bundle/v1"
    assert package["manifest"]["closure"] == {
        "selfContained": True,
        "completeForScope": True,
        "materialMissing": False,
        "degraded": False,
    }
    assert inspection["status"] == "verified"
    assert preview["status"] == "validated"
    assert preview["remainingMembers"] == ["episode-701"]
    assert imported["ok"] is True
    assert imported["status"] == "imported"
    assert imported["writtenMembers"] == ["episode-701"]
    assert imported["remainingMembers"] == []
    assert repeated["ok"] is True
    assert repeated["status"] == "already_present"
    assert repeated["alreadyPresent"] == ["episode-701"]
    assert (
        storage_service.build_export_bundle(destination, episode_id=701)["manifest"][
            "content_root"
        ]
        == package["materials"]["episode-701"]["manifest"]["content_root"]
    )


def test_thin_package_is_honest_and_rejected_before_write(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _sealed_episode(source, 702)
    package = exit_bundle.build(source, _request(702, mode="thin"))

    inspection = exit_bundle.inspect(package)
    receipt = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )

    assert package["materials"] == {}
    assert package["manifest"]["closure"]["degraded"] is True
    assert package["manifest"]["capabilities"] == ["inspect", "verify-inventory"]
    assert inspection["status"] == "degraded"
    assert receipt["status"] == "rejected"
    assert receipt["failure"]["code"] == "thin-materialization-forbidden"
    assert receipt["memberReceipts"] == []
    assert storage_service.episode_list(destination, limit=0)["episodes"] == []


def test_package_tamper_and_member_protocol_fail_closed(tmp_path):
    source = tmp_path / "source" / "runtime"
    _sealed_episode(source, 703)
    package = exit_bundle.build(source, _request(703))

    tampered = copy.deepcopy(package)
    tampered["materials"]["episode-703"]["episode_id"] = "999"
    try:
        exit_bundle.inspect(tampered)
    except exit_bundle.ExitBundleError as error:
        assert error.code == "package-root-mismatch"
    else:
        raise AssertionError("tampered package was accepted")

    unsupported = copy.deepcopy(package)
    unsupported["manifest"]["members"][0]["protocol"] = "episode-sealed-content-root/v9"
    unsupported["manifest"]["bundleRoot"] = exit_bundle._manifest_root(
        unsupported["manifest"]
    )
    unsupported["packageRoot"] = exit_bundle._package_root(unsupported)
    try:
        exit_bundle.inspect(unsupported)
    except exit_bundle.ExitBundleError as error:
        assert error.code == "unsupported-member-protocol"
    else:
        raise AssertionError("unsupported member protocol was accepted")


def test_mid_import_fault_reports_landed_and_remaining_members(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _sealed_episode(source, 704)
    _sealed_episode(source, 705)
    package = exit_bundle.build(source, _request(704, 705))

    partial = exit_bundle.import_package(
        destination,
        package,
        execute=True,
        authorized_by="test-owner",
        _fault_after_member=1,
    )
    resumed = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )

    assert partial["status"] == "partial"
    assert partial["writtenMembers"] == ["episode-704"]
    assert partial["remainingMembers"] == ["episode-705"]
    assert partial["failure"]["code"] == "qualification-fault"
    assert resumed["status"] == "imported"
    assert resumed["alreadyPresent"] == ["episode-704"]
    assert resumed["writtenMembers"] == ["episode-705"]


def test_destination_same_id_different_root_fails_visible(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _sealed_episode(source, 707)
    storage_service.episode_begin(
        destination,
        episode_id=707,
        begin_time=7070,
        title="Divergent destination Episode",
        actor="pytest",
        source="exit-composition-test",
    )
    storage_service.episode_end(
        destination,
        episode_id=707,
        end_time=7072,
        reason="different root",
    )
    package = exit_bundle.build(source, _request(707))

    rejected = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )

    assert rejected["ok"] is False
    assert rejected["status"] == "rejected"
    assert rejected["remainingMembers"] == ["episode-707"]
    assert rejected["failure"]["code"] == "member-import-rejected"
    assert rejected["memberReceipts"][0]["receipt"]["status"] == "failed"


def test_exit_cli_uses_the_same_service_receipt(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _sealed_episode(source, 706)
    package = exit_bundle.build(source, _request(706))
    encoded = (
        __import__("base64")
        .b64encode(__import__("json").dumps(package).encode("utf-8"))
        .decode("ascii")
    )
    runner = CliRunner()

    preview = runner.invoke(
        kfc,
        [
            "exit",
            "import",
            "--input-base64",
            encoded,
            "--json",
        ],
        env={"KF_RUNTIME_DIR": str(destination)},
    )

    assert preview.exit_code == 0, preview.output
    assert __import__("json").loads(preview.output)["status"] == "validated"


def test_profile_and_mission_exit_package_replays_into_clean_runtime(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _activate_mission_profile(source)
    mission_control.create_mission(
        str(source),
        mission_id="exit-mission",
        title="Exit Mission",
        intent="Prove Profile and Mission closure on a clean runtime",
        actor="test-owner",
        actor_type="user",
    )
    mission_control.create_go(
        str(source),
        mission_id="exit-mission",
        goal_id="exit-go",
        title="Exit Go",
        objective="Rehydrate the exact Mission state",
        actor="test-agent",
        actor_type="agent",
    )
    request = {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": "exit:mission-profile",
        "mode": "full",
        "scope": {
            "id": "mission/exit-mission",
            "authority": "Mission Control Profile domain",
            "schema": "kungfu.mission-control.bundle/v2",
            "protocol": "mission-control-portability/v2",
        },
        "members": [
            {
                "memberId": "mission-profile",
                "kind": "profile-source-v1",
                "requiredForScope": True,
                "options": {
                    "source": str(MISSION_PROFILE_SOURCE),
                    "grantedPermissions": ["storage"],
                },
            },
            {
                "memberId": "mission-state",
                "kind": "mission-control-v2",
                "requiredForScope": True,
                "options": {"missionId": "exit-mission"},
            },
        ],
    }

    package = exit_bundle.build(source, request)
    imported = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )
    repeated = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )

    assert imported["ok"] is True, imported
    assert imported["status"] == "imported"
    assert imported["writtenMembers"] == ["mission-profile", "mission-state"]
    assert repeated["ok"] is True, repeated
    assert repeated["status"] == "already_present"
    assert repeated["alreadyPresent"] == ["mission-profile", "mission-state"]
    mission = mission_control.query_state(str(destination), mission_id="exit-mission")
    assert mission["mission"]["payload"]["record"]["mission_id"] == "exit-mission"
    assert [row["payload"]["record"]["goal_id"] for row in mission["goals"]] == [
        "exit-go"
    ]
    assert (
        mission["profile_suite_root"]
        == package["execution"]["mission-profile"]["profileSuiteRoot"]
    )


def test_all_remaining_member_adapters_roundtrip_idempotently(tmp_path):
    authority_source = tmp_path / "authority-source"
    authority_receipt = work_profile.apply_action(
        authority_source, _work_profile_request(), execute=True
    )
    assert authority_receipt["status"] == "accepted"

    cut_source = tmp_path / "cut-source"
    cut = storage_service.fact_profile_shadow_project(
        cut_source,
        {
            "sources": [
                {
                    "profile": "mission-go",
                    "source_id": "exit:fixture",
                    "source_cut_root": _root("source-cut"),
                    "last_accepted_head": _root("source-head"),
                    "authority_receipt_root": _root("authority"),
                    "declaration_root": _root("declaration"),
                    "admission_root": _root("admission"),
                    "payload": {"status": "portable"},
                    "loss": [],
                }
            ],
            "relations": [],
            "ref": {
                "transition_id": "exit-fixture-create",
                "name": "heads/exit-fixture",
                "expected_old_cut_root": None,
                "expected_old_revision": 0,
                "kind": "create",
                "reason_root": _root("ref-reason"),
            },
        },
    )
    assert cut["cut_root"].startswith("sha256:")

    source_source = tmp_path / "generic-source"
    storage_service.write_synthetic_source(
        source_source,
        source_id="exit-synth",
        manifest_id="exit-synth-manifest",
        source_head="exit-head-1",
        records=[
            {
                "kind": "note",
                "source_id": "exit-note",
                "source_path": "notes/exit.json",
                "source_time": "2026-07-20T00:00:00Z",
                "payload": {"status": "portable"},
            }
        ],
    )

    library_source = tmp_path / "library-source"
    definition = {
        "id": "exit-status",
        "version": "1",
        "source_authorities": ["agent"],
        "schema": {
            "type": "object",
            "properties": {"status": {"type": "string"}},
            "required": ["status"],
            "additionalProperties": False,
        },
    }
    storage_service.fact_type_create(library_source, definition, system_time=100)
    storage_service.fact_material_put(
        library_source,
        {
            "type_id": "exit-status",
            "type_version": "1",
            "source_id": "agent",
            "subject_key": "exit-fixture",
            "payload": {"status": "portable"},
        },
        system_time=200,
    )

    cases = [
        (
            authority_source,
            "fact-authority",
            "fact-authority-v2",
            {},
        ),
        (
            cut_source,
            "fact-cut",
            "fact-cut-portable-v1",
            {"refName": "heads/exit-fixture"},
        ),
        (
            source_source,
            "storage-source",
            "storage-source-export-v1",
            {"sourceId": "exit-synth"},
        ),
        (
            library_source,
            "fact-library",
            "fact-library-v1",
            {},
        ),
    ]
    for source, member_id, kind, options in cases:
        destination = tmp_path / f"{member_id}-destination"
        package = exit_bundle.build(
            source, _single_member_request(member_id, kind, options)
        )
        imported = exit_bundle.import_package(
            destination, package, execute=True, authorized_by="test-owner"
        )
        repeated = exit_bundle.import_package(
            destination, package, execute=True, authorized_by="test-owner"
        )
        assert imported["ok"] is True, (member_id, imported)
        assert imported["status"] == "imported", (member_id, imported)
        assert repeated["ok"] is True, (member_id, repeated)
        assert repeated["status"] == "already_present", (member_id, repeated)
