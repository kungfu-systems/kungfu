# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json

import pytest


if importlib.util.find_spec("pykungfu") is None:
    pytest.skip("native pykungfu binding is not built", allow_module_level=True)

from kungfu.agent import work_profile  # noqa: E402
from kungfu.storage import service  # noqa: E402


FILE = "content-addressed-file"
ROCKS = "rocksdb"


def _root(digit: str) -> str:
    return "sha256:" + digit * 64


def _reroot_bundle(bundle):
    material = copy.deepcopy(bundle)
    material.pop("bundleRoot", None)
    raw = json.dumps(material, sort_keys=True, separators=(",", ":"))
    bundle["bundleRoot"] = "sha256:" + hashlib.sha256(raw.encode()).hexdigest()


def _request():
    roles = list(work_profile.ROLES)
    return {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": "native-bootstrap",
        "refName": "profiles/kfd-7/native-test",
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
            for index, role in enumerate(roles, start=1)
        },
        "roleInputs": {
            "fact": {"state": "declared", "details": {"cutKind": "native-test"}},
            "episode": {
                "state": "open",
                "details": {"episodeId": "episode:native-test"},
            },
            "pursuit": {
                "state": "active",
                "details": {"success": "native CAS accepts Python revision zero"},
            },
            "atlas": {"state": "current", "details": {"validThroughRevision": 10}},
            "warrant": {
                "state": "issued",
                "details": {"validThroughRevision": 10, "allowedOperations": ["*"]},
            },
        },
        "relations": [],
        "support": {
            "createdByReceiptRoot": _root("1"),
            "schemaRoot": _root("2"),
            "declarationRoots": [_root("3")],
            "admissionRoots": [_root("4")],
            "reasonRoot": _root("5"),
        },
    }


def _successor_request(previous, *, action_id: str):
    request = _request()
    request["actionId"] = action_id
    request["basis"] = {
        "cutRoot": previous["result"]["cutRoot"],
        "revision": previous["result"]["revision"],
    }
    request["ref"] = copy.deepcopy(request["basis"])
    request["subject"] = {
        "role": "pursuit",
        "operation": "continue",
        "fromState": "active",
        "toState": "active",
    }
    request["responsibilities"] = {
        role: {
            "objectId": request["responsibilities"][role]["objectId"],
            "expectedVersionRoot": previous["result"]["roleVersions"][role],
        }
        for role in work_profile.ROLES
    }
    request.pop("roleInputs")
    request["payload"] = {"continuation": action_id}
    return request


def _role_transition_request(
    previous,
    *,
    action_id,
    role,
    operation,
    from_state,
    to_state,
    payload,
    ref_name=None,
    new_ref=False,
):
    request = _request()
    request["actionId"] = action_id
    request["refName"] = ref_name or request["refName"]
    request["basis"] = {
        "cutRoot": previous["result"]["cutRoot"],
        "revision": previous["result"]["revision"],
    }
    request["ref"] = (
        {"cutRoot": None, "revision": 0} if new_ref else copy.deepcopy(request["basis"])
    )
    request["subject"] = {
        "role": role,
        "operation": operation,
        "fromState": from_state,
        "toState": to_state,
    }
    request["responsibilities"] = {
        current_role: {
            "objectId": request["responsibilities"][current_role]["objectId"],
            "expectedVersionRoot": previous["result"]["roleVersions"][current_role],
        }
        for current_role in work_profile.ROLES
    }
    request.pop("roleInputs")
    request["relations"] = []
    request["payload"] = copy.deepcopy(payload)
    return request


def test_native_profile_bootstrap_accepts_python_revision_zero(tmp_path):
    runtime_dir = tmp_path / "runtime"
    request = _request()

    receipt = work_profile.apply_action(runtime_dir, request, execute=True)
    inspected = work_profile.inspect(runtime_dir, request["refName"])

    assert receipt["status"] == "accepted", receipt
    assert receipt["result"]["revision"] == 1
    assert inspected["status"] == "current"
    assert inspected["revision"] == 1
    assert set(inspected["roles"]) == set(work_profile.ROLES)


def test_native_profile_authority_bundle_restores_clean_home_exactly(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "clean-home"
    request = _request()
    created = work_profile.apply_action(source, request, execute=True)
    continued = work_profile.apply_action(
        source,
        _successor_request(created, action_id="source-continuation"),
        execute=True,
    )

    exported = work_profile.export_authority(source)
    assert exported["ok"] is True, exported
    bundle = exported["result"]["bundle"]
    assert bundle["schema"] == work_profile.AUTHORITY_BUNDLE_SCHEMA
    assert bundle["finalState"]["refs"][request["refName"]]["revision"] == 2

    tampered = copy.deepcopy(bundle)
    tampered["operations"][0]["request"]["object_type"] = "tampered"
    rejected = work_profile.import_authority(destination, tampered)
    assert rejected["ok"] is False
    assert rejected["failure_code"] == "bundle-root-mismatch"

    planned = work_profile.import_authority(destination, bundle)
    assert planned["ok"] is True, planned
    assert planned["status"] == "planned"
    assert planned["write_occurred"] is False
    assert work_profile.inspect(destination, request["refName"])["status"] == "absent"

    imported = work_profile.import_authority(destination, bundle, execute=True)
    assert imported["ok"] is True, imported
    assert imported["status"] == "imported"
    assert imported["result"]["record_roots_preserved"] is True
    assert imported["result"]["refs_preserved"] is True

    source_state = work_profile.inspect(source, request["refName"])
    destination_state = work_profile.inspect(destination, request["refName"])
    assert destination_state == source_state
    assert destination_state["cutRoot"] == continued["result"]["cutRoot"]
    assert destination_state["revision"] == 2

    destination_export = work_profile.export_authority(destination)
    assert destination_export["result"]["bundle_root"] == bundle["bundleRoot"]

    resumed = work_profile.apply_action(
        destination,
        _successor_request(continued, action_id="clean-home-continuation"),
        execute=True,
    )
    assert resumed["status"] == "accepted", resumed
    assert resumed["result"]["revision"] == 3


def test_native_profile_authority_import_preflights_all_operations_before_writing(
    tmp_path,
):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    request = _request()
    created = work_profile.apply_action(source, request, execute=True)
    work_profile.apply_action(
        source,
        _successor_request(created, action_id="source-continuation"),
        execute=True,
    )
    bundle = copy.deepcopy(work_profile.export_authority(source)["result"]["bundle"])

    # The outer bundle root is valid, but a later operation is not executable.
    # Earlier implementations discovered this only after prior records landed.
    bundle["operations"][1]["action"] = "unsupported-import-operation"
    bundle["operations"][1]["request"]["action"] = "unsupported-import-operation"
    _reroot_bundle(bundle)

    rejected = work_profile.import_authority(destination, bundle, execute=True)
    assert rejected["ok"] is False
    assert rejected["failure_code"] == "import-preflight-operation-mismatch"
    assert rejected["write_occurred"] is False
    assert work_profile.inspect(destination, request["refName"])["status"] == "absent"


def test_native_profile_backend_switch_and_rollback_preserve_five_role_identity(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "runtime"
    request = _request()
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    created = work_profile.apply_action(runtime_dir, request, execute=True)
    before = work_profile.inspect(runtime_dir, request["refName"])
    before_bundle = work_profile.export_authority(runtime_dir)["result"]["bundle"]

    switched = service.backend_switch(runtime_dir, target_provider=ROCKS)
    assert switched["ok"] is True, switched
    assert switched["source_provider"] == FILE
    assert switched["target_provider"] == ROCKS
    assert switched["pre_cut"] == switched["post_cut"]
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER")

    after_switch = work_profile.inspect(runtime_dir, request["refName"])
    after_switch_bundle = work_profile.export_authority(runtime_dir)["result"]["bundle"]
    assert after_switch == before
    assert after_switch_bundle == before_bundle
    assert set(after_switch["roles"]) == set(work_profile.ROLES)

    continued = work_profile.apply_action(
        runtime_dir,
        _successor_request(created, action_id="rocks-continuation"),
        execute=True,
    )
    before_rollback = work_profile.inspect(runtime_dir, request["refName"])
    before_rollback_bundle = work_profile.export_authority(runtime_dir)["result"][
        "bundle"
    ]
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    rolled_back = service.backend_rollback(runtime_dir, expected_generation=2)
    assert rolled_back["source_provider"] == ROCKS
    assert rolled_back["target_provider"] == FILE
    assert rolled_back["target_generation"] == 3
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER")

    assert work_profile.inspect(runtime_dir, request["refName"]) == before_rollback
    assert (
        work_profile.export_authority(runtime_dir)["result"]["bundle"]
        == before_rollback_bundle
    )
    assert continued["result"]["revision"] == 2


def test_native_profile_retains_authority_freshness_direction_and_causality(tmp_path):
    runtime_dir = tmp_path / "runtime"
    created = work_profile.apply_action(runtime_dir, _request(), execute=True)

    attenuated = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            created,
            action_id="native-attenuate-warrant",
            role="warrant",
            operation="attenuate",
            from_state="issued",
            to_state="attenuated",
            payload={
                "allowedOperations": [
                    "atlas:mark-stale",
                    "atlas:refresh",
                    "episode:seal",
                    "episode:reconcile",
                    "pursuit:branch",
                    "pursuit:abandon",
                    "warrant:revoke",
                ],
                "validThroughRevision": 10,
            },
        ),
        execute=True,
    )
    assert attenuated["status"] == "accepted", attenuated

    stale = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            attenuated,
            action_id="native-atlas-stale",
            role="atlas",
            operation="mark-stale",
            from_state="current",
            to_state="stale",
            payload={
                "lossRoots": [_root("6")],
                "lossReason": "retained source invalidation",
            },
        ),
        execute=True,
    )
    assert stale["status"] == "accepted", stale
    blocked = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            stale,
            action_id="native-stale-atlas-blocks-action",
            role="pursuit",
            operation="continue",
            from_state="active",
            to_state="active",
            payload={"continuation": "must be rejected"},
        ),
        execute=True,
    )
    assert blocked["failureCode"] == "atlas-stale"
    assert blocked["writeOccurred"] is False

    refreshed = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            stale,
            action_id="native-atlas-refresh",
            role="atlas",
            operation="refresh",
            from_state="stale",
            to_state="current",
            payload={
                "sourceRoots": [_root("7")],
                "lossRoots": [_root("6")],
                "validThroughRevision": 10,
            },
        ),
        execute=True,
    )
    assert refreshed["status"] == "accepted", refreshed

    branch = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            refreshed,
            action_id="native-pursuit-branch",
            role="pursuit",
            operation="branch",
            from_state="active",
            to_state="active",
            payload={
                "branchOfCutRoot": refreshed["result"]["cutRoot"],
                "branchReasonRoot": _root("8"),
            },
            ref_name="profiles/kfd-7/native-branch",
            new_ref=True,
        ),
        execute=True,
    )
    assert branch["status"] == "accepted", branch
    abandoned = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            branch,
            action_id="native-pursuit-abandon",
            role="pursuit",
            operation="abandon",
            from_state="active",
            to_state="abandoned",
            payload={"settlementRoot": _root("9"), "outcome": "branch terminated"},
            ref_name="profiles/kfd-7/native-branch",
        ),
        execute=True,
    )
    assert abandoned["status"] == "accepted", abandoned

    endpoint = _root("a")
    sealed_payload = {
        "episodeId": "episode:native-test",
        "beforeCutRoot": endpoint,
        "afterCutRoot": endpoint,
        "causalRoot": _root("b"),
        "sealedContentRoot": _root("c"),
    }
    sealed = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            refreshed,
            action_id="native-episode-seal",
            role="episode",
            operation="seal",
            from_state="open",
            to_state="sealed",
            payload=sealed_payload,
        ),
        execute=True,
    )
    assert sealed["status"] == "accepted", sealed
    mismatch = copy.deepcopy(sealed_payload)
    mismatch["causalRoot"] = _root("d")
    rejected_replay = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            sealed,
            action_id="native-episode-replay-mismatch",
            role="episode",
            operation="reconcile",
            from_state="sealed",
            to_state="reconciled",
            payload={"replay": mismatch},
        ),
        execute=True,
    )
    assert rejected_replay["failureCode"] == "replay-mismatch"
    assert rejected_replay["writeOccurred"] is False
    replayed = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            sealed,
            action_id="native-episode-replay-exact",
            role="episode",
            operation="reconcile",
            from_state="sealed",
            to_state="reconciled",
            payload={"replay": sealed_payload},
        ),
        execute=True,
    )
    assert replayed["status"] == "accepted", replayed

    revoked = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            replayed,
            action_id="native-warrant-revoke",
            role="warrant",
            operation="revoke",
            from_state="attenuated",
            to_state="revoked",
            payload={"reason": "qualification end", "reasonRoot": _root("e")},
        ),
        execute=True,
    )
    assert revoked["status"] == "accepted", revoked
    denied_after_revoke = work_profile.apply_action(
        runtime_dir,
        _role_transition_request(
            revoked,
            action_id="native-after-revoke",
            role="pursuit",
            operation="continue",
            from_state="active",
            to_state="active",
            payload={"continuation": "must fail"},
        ),
        execute=True,
    )
    assert denied_after_revoke["failureCode"] == "warrant-revoked"
    assert denied_after_revoke["writeOccurred"] is False
