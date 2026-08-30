# SPDX-License-Identifier: Apache-2.0
"""Cohesive agent work state contract cases."""
# ruff: noqa: F401,F403

from _agent_work_state_support import *
from _agent_work_state_support import (
    _MemoryFactKernel,
    _profile_request,
    _role_transition_request,
    _root,
    _session_fixture,
    _successor_request,
)


@pytest.mark.parametrize("role", work_profile.ROLES)
def test_kfd7_profile_role_deletion_fails_before_write(role):
    request = _profile_request()
    del request["responsibilities"][role]

    denied = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert denied["status"] == "denied"
    assert denied["failureCode"] == "responsibility-gap"
    assert denied["writeOccurred"] is False


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("fact", "episode"),
        ("episode", "pursuit"),
        ("pursuit", "atlas"),
        ("atlas", "warrant"),
        ("fact", "warrant"),
    ],
)
def test_kfd7_profile_role_fusion_fails_before_write(left, right):
    request = _profile_request()
    request["responsibilities"][right]["objectId"] = request["responsibilities"][left][
        "objectId"
    ]

    denied = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert denied["status"] == "denied"
    assert denied["failureCode"] == "responsibility-gap"
    assert denied["writeOccurred"] is False


def test_kfd7_profile_action_and_receipt_schemas_cover_runtime_vectors():
    root = Path(__file__).resolve().parents[4]
    action_schema = json.loads(
        (
            root / "framework/agent-work/kungfu-kfd-7-profile-action.schema.json"
        ).read_text()
    )
    receipt_schema = json.loads(
        (
            root / "framework/agent-work/kungfu-kfd-7-profile-receipt.schema.json"
        ).read_text()
    )
    request = _profile_request()
    planned = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert list(Draft202012Validator(action_schema).iter_errors(request)) == []
    assert list(Draft202012Validator(receipt_schema).iter_errors(planned)) == []


def test_kfd7_profile_bootstrap_continue_inspect_and_replay_fail_closed():
    kernel = _MemoryFactKernel()
    request = _profile_request()

    planned = work_profile.apply_action(
        "/runtime", request, conformance=True, kernel=kernel
    )
    created = work_profile.apply_action(
        "/runtime", request, execute=True, conformance=True, kernel=kernel
    )
    inspected = work_profile.inspect(
        "/runtime", request["refName"], conformance=True, kernel=kernel
    )

    assert planned["status"] == "planned"
    assert created["status"] == "accepted"
    assert created["result"]["roleStates"] == {
        "fact": "declared",
        "episode": "open",
        "pursuit": "active",
        "atlas": "current",
        "warrant": "issued",
    }
    assert inspected["status"] == "current"
    assert set(inspected["roles"]) == set(work_profile.ROLES)
    assert len(inspected["relations"]) == 1

    continued_request = _successor_request(created)
    continued = work_profile.apply_action(
        "/runtime", continued_request, execute=True, conformance=True, kernel=kernel
    )
    assert continued["status"] == "accepted"
    assert continued["result"]["revision"] == 2

    stale_request = _successor_request(created, action_id="stale-writer")
    stale = work_profile.apply_action(
        "/runtime", stale_request, execute=True, conformance=True, kernel=kernel
    )
    assert stale["status"] == "denied"
    assert stale["failureCode"] == "stale-ref"
    assert stale["writeOccurred"] is True
    assert stale["refWriteOccurred"] is False

    replay_mismatch_request = _successor_request(created)
    replay_mismatch_request["payload"] = {"continuation": "different-bytes"}
    replay_mismatch = work_profile.apply_action(
        "/runtime",
        replay_mismatch_request,
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert replay_mismatch["status"] == "denied"
    assert replay_mismatch["failureCode"] == "replay-mismatch"


def test_kfd7_profile_persists_exact_role_schema_bindings_and_fails_closed():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )

    for role, version_root in created["result"]["roleVersions"].items():
        body = json.loads(kernel.versions[version_root]["body"])
        assert body["schema"] == domain_profile.role_schema_id_python(
            role, conformance=True
        )
        assert body["bindings"] == domain_profile.role_bindings_python(
            role, conformance=True
        )
        assert (
            domain_profile.validate_role_body_python(body, conformance=True)["legacy"]
            is False
        )

    pursuit_root = created["result"]["roleVersions"]["pursuit"]
    corrupted = json.loads(kernel.versions[pursuit_root]["body"])
    corrupted["bindings"]["domainProfileRoot"] = "sha256:" + "0" * 64
    kernel.versions[pursuit_root]["body"] = json.dumps(corrupted, sort_keys=True)

    denied = work_profile.apply_action(
        "/runtime",
        _successor_request(created, action_id="wrong-profile-root"),
        conformance=True,
        kernel=kernel,
    )
    assert denied["status"] == "denied"
    assert denied["failureCode"] == "body-missing"
    assert denied["details"]["missingRoles"] == ["pursuit"]


def test_kfd7_legacy_role_roots_remain_readable_without_reinterpretation():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    legacy_roots = copy.deepcopy(created["result"]["roleVersions"])
    for version_root in legacy_roots.values():
        body = json.loads(kernel.versions[version_root]["body"])
        body["schema"] = work_profile.ROLE_BODY_SCHEMA
        body.pop("bindings")
        kernel.versions[version_root]["body"] = json.dumps(body, sort_keys=True)

    inspected = work_profile.inspect(
        "/runtime", _profile_request()["refName"], conformance=True, kernel=kernel
    )
    assert inspected["status"] == "current"
    assert {
        role: row["versionRoot"] for role, row in inspected["roles"].items()
    } == legacy_roots

    continued = work_profile.apply_action(
        "/runtime",
        _successor_request(created, action_id="legacy-compatible-successor"),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert continued["status"] == "accepted"
    for role in set(work_profile.ROLES) - {"pursuit"}:
        assert continued["result"]["roleVersions"][role] == legacy_roots[role]
    pursuit_body = json.loads(
        kernel.versions[continued["result"]["roleVersions"]["pursuit"]]["body"]
    )
    assert pursuit_body["schema"] == domain_profile.role_schema_id_python(
        "pursuit", conformance=True
    )
    assert pursuit_body["bindings"] == domain_profile.role_bindings_python(
        "pursuit", conformance=True
    )
