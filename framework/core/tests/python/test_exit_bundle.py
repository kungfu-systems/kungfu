# SPDX-License-Identifier: Apache-2.0

import copy
import json
from pathlib import Path
import shutil

from click.testing import CliRunner
import pytest

from kungfu import dogfood as dogfood_api
from kungfu import exit_bundle, exit_verifier, profile_composition, profile_sdk
from kungfu import project_cut_exit
from kungfu.agent import work_profile
from kungfu import work_control
from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import fact_profile_shadow
from kungfu.storage import service as storage_service


WORK_CONTROL_PROFILE_SOURCE = (
    Path(__file__).resolve().parents[4] / "extensions" / "work-control"
)
DOGFOOD_PROFILE_SOURCE = Path(__file__).resolve().parents[4] / "extensions" / "dogfood"
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PROJECT_CUT_ROOT = "b3f93706640ab2d63e7eadb5bed0b473c79a8f04a07e501ec4d34db4fd262e6b"
PROJECT_CUT_SUCCESSOR_ROOT = (
    "4e36c3ba7813ca8d69572c19faf174b9ae3b5188afd1792e9ea5c02acc5adf1e"
)
PROJECT_CUT_PUBLICATION_ROOTS = (
    "f466df51e1259a944a0cd4e94a27b091ea4137d6c3b170dcfb5621ba9c48c9e9",
    "2073a8094acb224e4abe38cc53b3ffc27c6a5de5ea4bda799c35339ac8d11503",
)


def _activate_work_control_profile(runtime_dir):
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime_dir,
            action,
            WORK_CONTROL_PROFILE_SOURCE,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime_dir, plan, f"exit-test:{action}")
    contract = profile_composition.contract_materialization_plan(
        WORK_CONTROL_PROFILE_SOURCE, runtime_dir
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


def _copy_project_cut_history(target):
    paths = []
    for digest in (PROJECT_CUT_ROOT, PROJECT_CUT_SUCCESSOR_ROOT):
        relative = Path("project-cuts") / "sha256" / digest[:2] / digest
        source = REPOSITORY_ROOT / ".kungfu" / relative
        destination = target / relative
        destination.mkdir(parents=True)
        for name in ("manifest.json", "receipt.json"):
            shutil.copy2(source / name, destination / name)
        paths.append(destination / "manifest.json")
    publications = []
    for digest in PROJECT_CUT_PUBLICATION_ROOTS:
        relative = Path("ledger-publications") / "sha256" / digest[:2] / digest
        source = REPOSITORY_ROOT / ".kungfu" / relative / "manifest.json"
        destination = target / relative / "manifest.json"
        destination.parent.mkdir(parents=True)
        shutil.copy2(source, destination)
        publications.append(destination)
    return {
        "manifestPath": str(paths[0]),
        "successorManifestPaths": [str(paths[1])],
        "publicationManifestPaths": [str(path) for path in publications],
    }


def _project_cut_request(options, mode="full"):
    return {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": f"exit:project-cut-history-{mode}",
        "mode": mode,
        "scope": {
            "id": "project-cut/history-fixture",
            "authority": "Project Cut protocol",
            "schema": "project.cut/v1",
            "protocol": "project-cut-history-portability/v1",
            "cutRoot": f"sha256:{PROJECT_CUT_ROOT}",
        },
        "members": [
            {
                "memberId": "project-cut-history",
                "kind": "project-cut-v1",
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


def test_exit_history_status_is_honest_and_scope_bound(tmp_path):
    source = tmp_path / "source" / "runtime"
    _sealed_episode(source, 708)

    general = exit_verifier.status(source)
    selected = exit_verifier.status(source, _request(708))

    assert general["state"] == "contract-ready"
    assert general["coverage"] == "not-evaluated"
    assert general["selectedScope"] is None
    assert general["lastVerifiedExport"] is None
    assert len(general["eligibleMembers"]) == 9
    assert selected["state"] == "inventory-verified"
    assert selected["coverage"] == "selected-scope-inventory"
    assert [
        row["memberId"] for row in selected["selectedScope"]["inventoryMembers"]
    ] == ["episode-708"]
    assert selected["selectedScope"]["contentVerifiedMembers"] == []
    assert selected["selectedScope"]["intentionalThinLoss"]
    assert str(tmp_path) not in json.dumps(selected)

    thin = exit_bundle.build(source, _request(708, mode="thin"))
    exit_verifier.record_verified_export(source, thin)
    degraded = exit_verifier.status(source)
    assert degraded["state"] == "degraded"
    assert degraded["coverage"] == "last-export-explicit-loss"
    assert degraded["lastVerifiedExport"]["loss"]


def test_exit_history_cli_exports_and_verifies_through_shared_core(tmp_path):
    source = tmp_path / "source" / "runtime"
    request_path = tmp_path / "request.json"
    package_path = tmp_path / "history.json"
    _sealed_episode(source, 709)
    request_path.write_text(json.dumps(_request(709)), encoding="utf-8")
    runner = CliRunner()

    status = runner.invoke(
        kfc,
        ["exit", "history", "status", "--file", str(request_path), "--json"],
        env={"KF_RUNTIME_DIR": str(source)},
    )
    exported = runner.invoke(
        kfc,
        [
            "exit",
            "history",
            "export",
            "--file",
            str(request_path),
            "--out",
            str(package_path),
            "--json",
        ],
        env={"KF_RUNTIME_DIR": str(source)},
    )
    verified = runner.invoke(
        kfc,
        ["exit", "history", "verify", "--file", str(package_path), "--json"],
        env={"KF_RUNTIME_DIR": str(source)},
    )

    assert status.exit_code == 0, status.output
    assert json.loads(status.output)["state"] == "inventory-verified"
    assert exported.exit_code == 0, exported.output
    export_receipt = json.loads(exported.output)
    assert export_receipt["schema"] == "kungfu.exit-history.export-receipt/v1"
    assert export_receipt["written"] is True
    observed = exit_verifier.status(source)["lastVerifiedExport"]
    projected = exit_verifier.status(source)
    assert projected["state"] == "verified"
    assert projected["coverage"] == "last-export-content-verified"
    assert observed["packageRoot"] == export_receipt["packageRoot"]
    assert observed["observerRoot"] == export_receipt["observerRoot"]
    assert observed["authority"] == "disposable-observer-projection"
    assert str(tmp_path) not in json.dumps(observed)
    assert package_path.is_file()
    assert verified.exit_code == 0, verified.output
    assert json.loads(verified.output)["verdict"] == "verified"


def test_exit_history_projection_rebuild_is_bounded_and_authorized(tmp_path):
    runtime = tmp_path / "runtime"
    _sealed_episode(runtime, 710)

    plan = exit_verifier.rebuild_projections(runtime, projections=["episode"])
    rebuilt = exit_verifier.rebuild_projections(
        runtime,
        projections=["episode", "fact-kernel"],
        execute=True,
        authorized_by="test-owner",
    )

    assert plan["status"] == "planned"
    assert plan["authorityMutation"] is False
    assert plan["nextActions"] == [
        "kungfu exit history rebuild --execute --authorized-by <actor> --json"
    ]
    assert rebuilt["ok"] is True
    assert rebuilt["status"] == "rebuilt"
    assert rebuilt["authorityMutation"] is False
    assert {row["projection"] for row in rebuilt["receipts"]} == {
        "episode",
        "fact-kernel",
    }
    assert str(tmp_path) not in json.dumps(rebuilt)
    with pytest.raises(exit_bundle.ExitBundleError) as error:
        exit_verifier.rebuild_projections(runtime, execute=True)
    assert error.value.code == "authorization-actor-required"


def test_profile_and_initiative_exit_package_replays_into_clean_runtime(tmp_path):
    source = tmp_path / "source" / "runtime"
    destination = tmp_path / "destination" / "runtime"
    _activate_work_control_profile(source)
    work_control.create_initiative(
        str(source),
        initiative_id="exit-initiative",
        title="Exit Initiative",
        intent="Prove Profile and Initiative closure on a clean runtime",
        actor="test-owner",
        actor_type="user",
    )
    work_control.create_assignment(
        str(source),
        initiative_id="exit-initiative",
        assignment_id="exit-go",
        title="Exit Go",
        objective="Rehydrate the exact Initiative state",
        actor="test-agent",
        actor_type="agent",
    )
    request = {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": "exit:work-control-profile",
        "mode": "full",
        "scope": {
            "id": "initiative/exit-initiative",
            "authority": "Initiative Control Profile domain",
            "schema": "kungfu.initiative-control.bundle/v2",
            "protocol": "initiative-control-portability/v2",
        },
        "members": [
            {
                "memberId": "work-control-profile",
                "kind": "profile-source-v1",
                "requiredForScope": True,
                "options": {
                    "source": str(WORK_CONTROL_PROFILE_SOURCE),
                    "grantedPermissions": ["storage"],
                },
            },
            {
                "memberId": "initiative-state",
                "kind": "initiative-bundle-v1",
                "requiredForScope": True,
                "options": {"initiativeId": "exit-initiative"},
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
    assert imported["writtenMembers"] == ["work-control-profile", "initiative-state"]
    assert repeated["ok"] is True, repeated
    assert repeated["status"] == "already_present"
    assert repeated["alreadyPresent"] == ["work-control-profile", "initiative-state"]
    initiative = work_control.query_state(
        str(destination), initiative_id="exit-initiative"
    )
    assert (
        initiative["initiative"]["payload"]["record"]["initiative_id"]
        == "exit-initiative"
    )
    assert [
        row["payload"]["record"]["assignment_id"] for row in initiative["assignments"]
    ] == ["exit-go"]
    assert (
        initiative["profile_suite_root"]
        == package["execution"]["work-control-profile"]["profileSuiteRoot"]
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
                    "profile": "initiative-assignment",
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


def test_project_cut_history_owner_preserves_composer_imports():
    assert exit_bundle.ProjectCutExitError is project_cut_exit.ProjectCutExitError
    assert exit_bundle._project_cut_build_bundle is project_cut_exit.build_bundle
    assert exit_bundle._project_cut_verify_bundle is project_cut_exit.verify_bundle
    assert exit_bundle._project_cut_import_bundle is project_cut_exit.import_bundle


def test_project_cut_history_member_survives_source_removal(tmp_path):
    source_home = tmp_path / "disposable-source"
    options = _copy_project_cut_history(source_home)
    package = exit_bundle.build(source_home / "runtime", _project_cut_request(options))
    expected = {
        Path(path).relative_to(source_home): Path(path).read_bytes()
        for path in [
            options["manifestPath"],
            str(Path(options["manifestPath"]).with_name("receipt.json")),
            options["successorManifestPaths"][0],
            str(Path(options["successorManifestPaths"][0]).with_name("receipt.json")),
            *options["publicationManifestPaths"],
        ]
    }

    assert exit_bundle.inspect(package)["status"] == "verified"
    material = package["materials"]["project-cut-history"]
    assert material["primaryCutRoot"] == f"sha256:{PROJECT_CUT_ROOT}"
    assert material["successorCutRoots"] == [f"sha256:{PROJECT_CUT_SUCCESSOR_ROOT}"]
    assert material["settlement"]["state"] == "published"

    shutil.rmtree(source_home)
    destination_runtime = tmp_path / "clean-destination" / "runtime"
    imported = exit_bundle.import_package(
        destination_runtime,
        package,
        execute=True,
        authorized_by="test-owner",
    )
    repeated = exit_bundle.import_package(
        destination_runtime,
        package,
        execute=True,
        authorized_by="test-owner",
    )

    assert imported["ok"] is True, imported
    assert imported["status"] == "imported"
    assert imported["writtenMembers"] == ["project-cut-history"]
    assert repeated["ok"] is True, repeated
    assert repeated["status"] == "already_present"
    for relative, payload in expected.items():
        assert (destination_runtime.parent / relative).read_bytes() == payload
    assert not source_home.exists()


def test_project_cut_history_member_rejects_thin_and_diverged_destinations(
    tmp_path,
):
    source_home = tmp_path / "source"
    options = _copy_project_cut_history(source_home)
    source_runtime = source_home / "runtime"
    thin = exit_bundle.build(source_runtime, _project_cut_request(options, mode="thin"))
    thin_destination = tmp_path / "thin-destination" / "runtime"

    assert exit_bundle.inspect(thin)["status"] == "degraded"
    rejected_thin = exit_bundle.import_package(
        thin_destination,
        thin,
        execute=True,
        authorized_by="test-owner",
    )
    assert rejected_thin["status"] == "rejected"
    assert rejected_thin["failure"]["code"] == "thin-materialization-forbidden"
    assert not thin_destination.parent.exists()

    full = exit_bundle.build(source_runtime, _project_cut_request(options))
    diverged_home = tmp_path / "diverged-destination"
    diverged_receipt = (
        diverged_home
        / "project-cuts"
        / "sha256"
        / PROJECT_CUT_ROOT[:2]
        / PROJECT_CUT_ROOT
        / "receipt.json"
    )
    diverged_receipt.parent.mkdir(parents=True)
    diverged_receipt.write_bytes(b'{"diverged":true}\n')
    rejected = exit_bundle.import_package(
        diverged_home / "runtime",
        full,
        execute=True,
        authorized_by="test-owner",
    )
    assert rejected["status"] == "rejected"
    assert rejected["failure"]["code"] == "member-import-failed"
    assert "destination contains different bytes" in rejected["failure"]["message"]
    assert not diverged_receipt.with_name("manifest.json").exists()
    assert diverged_receipt.read_bytes() == b'{"diverged":true}\n'

    relation_tamper = copy.deepcopy(full)
    relation_tamper["materials"]["project-cut-history"]["cuts"][1][
        "parentCutRoots"
    ] = []
    relation_material = relation_tamper["materials"]["project-cut-history"]
    relation_descriptor = relation_tamper["manifest"]["members"][0]["material"]
    relation_descriptor["byteLength"] = len(
        exit_bundle.canonical_json_bytes(relation_material)
    )
    relation_descriptor["sha256"] = exit_bundle._material_root(relation_material)
    relation_tamper["manifest"]["bundleRoot"] = exit_bundle._manifest_root(
        relation_tamper["manifest"]
    )
    relation_tamper["packageRoot"] = exit_bundle._package_root(relation_tamper)
    with pytest.raises(exit_bundle.ProjectCutExitError) as relation_error:
        exit_bundle.inspect(relation_tamper)
    assert relation_error.value.code == "project-cut-relation-mismatch"

    publication_tamper = copy.deepcopy(full)
    publication_tamper["materials"]["project-cut-history"]["publications"][0][
        "batchRoot"
    ] = f"sha256:{'c' * 64}"
    publication_material = publication_tamper["materials"]["project-cut-history"]
    publication_descriptor = publication_tamper["manifest"]["members"][0]["material"]
    publication_descriptor["byteLength"] = len(
        exit_bundle.canonical_json_bytes(publication_material)
    )
    publication_descriptor["sha256"] = exit_bundle._material_root(publication_material)
    publication_tamper["manifest"]["bundleRoot"] = exit_bundle._manifest_root(
        publication_tamper["manifest"]
    )
    publication_tamper["packageRoot"] = exit_bundle._package_root(publication_tamper)
    with pytest.raises(exit_bundle.ProjectCutExitError) as publication_error:
        exit_bundle.inspect(publication_tamper)
    assert publication_error.value.code == "project-cut-publication-root-mismatch"

    private_manifest = tmp_path / "private-path" / "manifest.json"
    private_manifest.parent.mkdir()
    value = json.loads(Path(options["manifestPath"]).read_text(encoding="utf-8"))
    value["privateSource"] = "/Users/example/private/worktree"
    private_manifest.write_text(json.dumps(value) + "\n", encoding="utf-8")
    shutil.copy2(
        Path(options["manifestPath"]).with_name("receipt.json"),
        private_manifest.with_name("receipt.json"),
    )
    with pytest.raises(exit_bundle.ProjectCutExitError) as error:
        exit_bundle._project_cut_build_bundle(
            {"manifestPath": str(private_manifest)}, mode="full"
        )
    assert error.value.code == "project-cut-private-path-leakage"


def test_dogfood_profile_facts_roundtrip_through_native_exit_members(tmp_path):
    source = tmp_path / "dogfood-source" / "runtime"
    destination = tmp_path / "dogfood-destination" / "runtime"
    dogfood_api.ensure_profile(str(source), "test-owner")
    finding = dogfood_api.action(
        str(source),
        "capture-finding",
        {
            "findingId": "exit-history-finding",
            "title": "Exit history finding",
            "summary": "A qualified Dogfood fact survives its original runtime.",
            "episodeRoot": f"sha256:{'a' * 64}",
            "evidenceRoots": [f"sha256:{'b' * 64}"],
            "dimensions": {
                "repository": ["kungfu"],
                "component": ["exit"],
                "capability": ["history"],
                "error": ["portability"],
                "platform": ["source"],
            },
            "privacy": "internal",
            "runtimeSurface": "source-checkout",
            "runtimeReceiptRoot": f"sha256:{'c' * 64}",
            "actor": "test-agent",
            "observedAt": "2026-08-01T00:00:00Z",
            "impact": "normal",
        },
        "test-owner",
    )["finding"]
    request = {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": "exit:dogfood-native-history",
        "mode": "full",
        "scope": {
            "id": "dogfood/history-fixture",
            "authority": "kungfu.dogfood.feedback Profile",
            "schema": "kungfu.dogfood-feedback.finding/v1",
            "protocol": "declared-facts-v1",
        },
        "members": [
            {
                "memberId": "dogfood-profile",
                "kind": "profile-source-v1",
                "requiredForScope": True,
                "options": {
                    "source": str(DOGFOOD_PROFILE_SOURCE),
                    "grantedPermissions": ["storage"],
                },
            },
            {
                "memberId": "dogfood-facts",
                "kind": "fact-library-v1",
                "requiredForScope": True,
                "options": {},
            },
        ],
    }
    package = exit_bundle.build(source, request)
    shutil.rmtree(source.parent)

    imported = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )
    repeated = exit_bundle.import_package(
        destination, package, execute=True, authorized_by="test-owner"
    )
    assert imported["failure"] is None, json.dumps(imported, indent=2)
    assert imported["ok"] is True, imported
    assert imported["writtenMembers"] == ["dogfood-profile", "dogfood-facts"]
    assert repeated["status"] == "already_present", repeated
    lookup = dogfood_api.read(
        str(destination), "lookup", {"identity": finding["finding_root"]}
    )

    assert lookup["match_count"] == 1
    assert lookup["matches"][0]["record"]["finding_root"] == finding["finding_root"]
