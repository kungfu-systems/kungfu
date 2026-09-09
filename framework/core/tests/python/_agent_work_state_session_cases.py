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


def test_kfd7_session_geometry_round_trip_is_domain_neutral():
    session = _session_fixture()
    expanded = work_profile.expand_session_python(session, conformance=True)
    projected = work_profile.project_session_python(expanded, conformance=True)
    before = expanded["observations"]
    after = work_profile.expand_session_python(projected, conformance=True)[
        "observations"
    ]

    assert action_geometry.evaluate_session_refinement_python(
        before, after, conformance=True
    ) == {
        "schema": action_geometry.SESSION_EVALUATION_SCHEMA,
        "geometryRoot": contract.contract_hash("action-geometry"),
        "preserved": True,
        "missingDimensions": [],
        "changedDimensions": [],
    }


def test_kfd7_simple_session_round_trips_all_five_decision_observations():
    session = _session_fixture()
    expanded = work_profile.expand_session_python(session, conformance=True)

    assert expanded["compressibility"] == {
        "schema": work_profile.SESSION_COMPRESSIBILITY_SCHEMA,
        "sessionId": session["sessionId"],
        "compressible": True,
        "breakpoints": [],
        "revealedRoles": [],
    }
    assert set(expanded["observations"]) == {
        "direction",
        "perspective-boundary",
        "effective-authority",
        "causal-process",
        "admitted-result",
    }
    assert work_profile.project_session_python(expanded, conformance=True) == session


def test_kfd7_session_cli_and_python_api_share_the_same_projection(
    tmp_path, monkeypatch
):
    session = _session_fixture()
    expected = work_profile.expand_session_python(session, conformance=True)
    monkeypatch.setattr(work_profile, "require_action_runtime", lambda: object())
    monkeypatch.setattr(
        work_profile.storage_service,
        "action_runtime",
        lambda _runtime_dir, action, payload: (
            work_profile.expand_session_python(payload["session"], conformance=True)
            if action == "expand_session"
            else pytest.fail(f"unexpected native action: {action}")
        ),
    )
    encoded = base64.b64encode(json.dumps(session).encode()).decode()
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "agent",
            "work",
            "session",
            "--operation",
            "expand",
            "--input-base64",
            encoded,
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == expected


@pytest.mark.parametrize(
    ("role", "mutate"),
    [
        (
            "pursuit",
            lambda value: value["goal"].update({"alternatives": ["pursuit:other"]}),
        ),
        (
            "atlas",
            lambda value: value["context"].update(
                {"state": "stale", "lossRoots": ["sha256:" + "d" * 64]}
            ),
        ),
        (
            "warrant",
            lambda value: value["permissions"].update({"state": "revoked"}),
        ),
        (
            "episode",
            lambda value: value["run"].update(
                {"episodeIds": ["episode:release-check", "episode:retry"]}
            ),
        ),
        (
            "fact",
            lambda value: value["facts"].update(
                {"branchRoots": ["sha256:" + "e" * 64]}
            ),
        ),
    ],
)
def test_kfd7_session_complexity_breakpoints_reveal_the_independent_role(role, mutate):
    session = _session_fixture()
    mutate(session)
    expanded = work_profile.expand_session_python(session, conformance=True)

    assert expanded["compressibility"]["compressible"] is False
    assert role in expanded["compressibility"]["revealedRoles"]
    with pytest.raises(ValueError, match="session-complexity-breakpoint"):
        work_profile.project_session_python(expanded, conformance=True)


def test_kfd7_same_payload_has_different_actions_without_direction_authority_or_freshness():
    baseline = _session_fixture()
    payload = copy.deepcopy(baseline["facts"])
    assert work_profile.session_valid_actions_python(baseline, conformance=True) == [
        "episode:seal",
        "fact:successor",
    ]

    different_direction = copy.deepcopy(baseline)
    different_direction["goal"]["operations"] = ["episode:seal"]
    weaker_authority = copy.deepcopy(baseline)
    weaker_authority["permissions"]["allowedOperations"] = ["fact:successor"]
    stale_context = copy.deepcopy(baseline)
    stale_context["context"]["validThroughRevision"] = 3

    for candidate in (different_direction, weaker_authority, stale_context):
        assert candidate["facts"] == payload
    assert work_profile.session_valid_actions_python(
        different_direction, conformance=True
    ) == ["episode:seal"]
    assert work_profile.session_valid_actions_python(
        weaker_authority, conformance=True
    ) == ["fact:successor"]
    assert (
        work_profile.session_valid_actions_python(stale_context, conformance=True) == []
    )
