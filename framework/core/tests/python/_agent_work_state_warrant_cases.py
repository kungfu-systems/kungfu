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


def test_kfd7_profile_rejects_stale_atlas_and_expired_warrant_before_writes():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    stale_atlas_request = _successor_request(created, action_id="atlas-stale")
    atlas_root = created["result"]["roleVersions"]["atlas"]
    atlas_body = json.loads(kernel.versions[atlas_root]["body"])
    atlas_body["state"] = "stale"
    kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)

    stale_atlas = work_profile.apply_action(
        "/runtime", stale_atlas_request, execute=True, conformance=True, kernel=kernel
    )

    assert stale_atlas["failureCode"] == "atlas-stale"
    assert stale_atlas["writeOccurred"] is False

    atlas_body["state"] = "current"
    kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)
    warrant_root = created["result"]["roleVersions"]["warrant"]
    warrant_body = json.loads(kernel.versions[warrant_root]["body"])
    warrant_body["details"]["validThroughRevision"] = 0
    kernel.versions[warrant_root]["body"] = json.dumps(warrant_body, sort_keys=True)
    expired = work_profile.apply_action(
        "/runtime",
        _successor_request(created, action_id="warrant-expired"),
        conformance=True,
        kernel=kernel,
    )

    assert expired["failureCode"] == "warrant-expired"
    assert expired["writeOccurred"] is False


def test_kfd7_profile_warrant_attenuation_and_revocation_are_enforced():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    attenuated = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            created,
            action_id="attenuate-warrant",
            role="warrant",
            operation="attenuate",
            from_state="issued",
            to_state="attenuated",
            payload={
                "allowedOperations": ["pursuit:continue", "warrant:revoke"],
                "validThroughRevision": 5,
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert attenuated["status"] == "accepted"

    denied = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            attenuated,
            action_id="complete-outside-scope",
            role="pursuit",
            operation="complete",
            from_state="active",
            to_state="completed",
            payload={"settlementRoot": "sha256:" + "8" * 64, "outcome": "done"},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert denied["failureCode"] == "unauthorized"
    assert denied["writeOccurred"] is False

    revoked = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            attenuated,
            action_id="revoke-warrant",
            role="warrant",
            operation="revoke",
            from_state="attenuated",
            to_state="revoked",
            payload={
                "reason": "issuer withdrew authority",
                "reasonRoot": "sha256:" + "9" * 64,
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert revoked["status"] == "accepted"
    rejected_after_revoke = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            revoked,
            action_id="continue-after-revoke",
            role="pursuit",
            operation="continue",
            from_state="active",
            to_state="active",
            payload={"continuation": "must fail"},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert rejected_after_revoke["failureCode"] == "warrant-revoked"
    assert rejected_after_revoke["writeOccurred"] is False


def test_kfd7_profile_atlas_loss_refresh_and_pursuit_branch_are_explicit():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    stale = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            created,
            action_id="mark-atlas-stale",
            role="atlas",
            operation="mark-stale",
            from_state="current",
            to_state="stale",
            payload={
                "lossRoots": ["sha256:" + "a" * 64],
                "lossReason": "source expired",
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert stale["status"] == "accepted"
    blocked = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            stale,
            action_id="blocked-by-stale-atlas",
            role="pursuit",
            operation="continue",
            from_state="active",
            to_state="active",
            payload={"continuation": "unsafe"},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert blocked["failureCode"] == "atlas-stale"
    assert blocked["writeOccurred"] is False

    refreshed = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            stale,
            action_id="refresh-atlas",
            role="atlas",
            operation="refresh",
            from_state="stale",
            to_state="current",
            payload={
                "sourceRoots": ["sha256:" + "b" * 64],
                "lossRoots": ["sha256:" + "a" * 64],
                "validThroughRevision": 10,
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert refreshed["status"] == "accepted"

    branched = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            refreshed,
            action_id="branch-pursuit",
            role="pursuit",
            operation="branch",
            from_state="active",
            to_state="active",
            payload={
                "branchOfCutRoot": refreshed["result"]["cutRoot"],
                "branchReasonRoot": "sha256:" + "c" * 64,
            },
            ref_name="profiles/work/branch",
            new_ref=True,
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert branched["status"] == "accepted"
    assert branched["result"]["revision"] == 1
    assert (
        work_profile.inspect(
            "/runtime", "profiles/work/main", conformance=True, kernel=kernel
        )["revision"]
        == 3
    )

    abandoned = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            branched,
            action_id="abandon-branch",
            role="pursuit",
            operation="abandon",
            from_state="active",
            to_state="abandoned",
            payload={
                "settlementRoot": "sha256:" + "d" * 64,
                "outcome": "superseded by main",
            },
            ref_name="profiles/work/branch",
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert abandoned["status"] == "accepted"


def test_kfd7_profile_episode_replay_distinguishes_equal_endpoint_causality():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    endpoint = "sha256:" + "d" * 64
    sealed_payload = {
        "episodeId": "episode:1",
        "beforeCutRoot": endpoint,
        "afterCutRoot": endpoint,
        "causalRoot": "sha256:" + "e" * 64,
        "sealedContentRoot": "sha256:" + "f" * 64,
    }
    sealed = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            created,
            action_id="seal-equal-endpoint-episode",
            role="episode",
            operation="seal",
            from_state="open",
            to_state="sealed",
            payload=sealed_payload,
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert sealed["status"] == "accepted"

    mismatched = copy.deepcopy(sealed_payload)
    mismatched["causalRoot"] = "sha256:" + "0" * 64
    replay_denied = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            sealed,
            action_id="replay-mismatched-causality",
            role="episode",
            operation="reconcile",
            from_state="sealed",
            to_state="reconciled",
            payload={"replay": mismatched},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert replay_denied["failureCode"] == "replay-mismatch"
    assert replay_denied["writeOccurred"] is False

    replayed = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            sealed,
            action_id="replay-exact-causality",
            role="episode",
            operation="reconcile",
            from_state="sealed",
            to_state="reconciled",
            payload={"replay": sealed_payload},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert replayed["status"] == "accepted"


def test_kfd7_context_only_rival_loses_each_decision_relevant_role():
    baseline_kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/baseline",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=baseline_kernel,
    )
    candidate = _successor_request(created, action_id="same-visible-task")
    visible_task = {
        "subject": copy.deepcopy(candidate["subject"]),
        "payload": copy.deepcopy(candidate["payload"]),
    }
    baseline_plan = work_profile.apply_action(
        "/baseline", candidate, conformance=True, kernel=baseline_kernel
    )
    assert baseline_plan["status"] == "planned"
    assert baseline_plan["changedRoles"] == ["pursuit"]

    fact_variant = copy.deepcopy(candidate)
    fact_variant["responsibilities"]["fact"]["expectedVersionRoot"] = (
        "sha256:" + "7" * 64
    )
    assert {
        "subject": fact_variant["subject"],
        "payload": fact_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/baseline", fact_variant, conformance=True, kernel=baseline_kernel
        )["failureCode"]
        == "profile-state-mismatch"
    )

    pursuit_kernel = _MemoryFactKernel()
    pursuit_created = work_profile.apply_action(
        "/pursuit",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=pursuit_kernel,
    )
    pursuit_root = pursuit_created["result"]["roleVersions"]["pursuit"]
    pursuit_body = json.loads(pursuit_kernel.versions[pursuit_root]["body"])
    pursuit_body["state"] = "completed"
    pursuit_kernel.versions[pursuit_root]["body"] = json.dumps(
        pursuit_body, sort_keys=True
    )
    pursuit_variant = _successor_request(pursuit_created, action_id="same-visible-task")
    assert {
        "subject": pursuit_variant["subject"],
        "payload": pursuit_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/pursuit", pursuit_variant, conformance=True, kernel=pursuit_kernel
        )["failureCode"]
        == "profile-state-mismatch"
    )

    atlas_kernel = _MemoryFactKernel()
    atlas_created = work_profile.apply_action(
        "/atlas",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=atlas_kernel,
    )
    atlas_root = atlas_created["result"]["roleVersions"]["atlas"]
    atlas_body = json.loads(atlas_kernel.versions[atlas_root]["body"])
    atlas_body["state"] = "stale"
    atlas_kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)
    atlas_variant = _successor_request(atlas_created, action_id="same-visible-task")
    assert {
        "subject": atlas_variant["subject"],
        "payload": atlas_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/atlas", atlas_variant, conformance=True, kernel=atlas_kernel
        )["failureCode"]
        == "atlas-stale"
    )

    warrant_kernel = _MemoryFactKernel()
    warrant_created = work_profile.apply_action(
        "/warrant",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=warrant_kernel,
    )
    warrant_root = warrant_created["result"]["roleVersions"]["warrant"]
    warrant_body = json.loads(warrant_kernel.versions[warrant_root]["body"])
    warrant_body["details"]["allowedOperations"] = ["atlas:refresh"]
    warrant_kernel.versions[warrant_root]["body"] = json.dumps(
        warrant_body, sort_keys=True
    )
    warrant_variant = _successor_request(warrant_created, action_id="same-visible-task")
    assert {
        "subject": warrant_variant["subject"],
        "payload": warrant_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/warrant", warrant_variant, conformance=True, kernel=warrant_kernel
        )["failureCode"]
        == "unauthorized"
    )
