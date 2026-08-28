# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

import pytest

from kungfu.agent import session_contract
from kungfu.assignment_runtime import fresh_recovery


def _root(digit):
    return f"sha256:{digit * 64}"


def _fixture():
    assignment = {
        "initiative_id": "initiative:test",
        "assignment_id": "assignment:test",
        "request_root": _root("1"),
        "work_definition_root": _root("2"),
    }
    status = {
        "phase": "continuation-decided",
        "query_proof_root": _root("9"),
        "assignment": assignment,
    }
    work_ref = {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "project:test",
        "profileId": "kungfu.work-control",
        "profileRoot": _root("3"),
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": fresh_recovery._root(assignment),
        "purpose": "continue-project-assignment",
        "systemTimeCut": _root("5"),
        "initiativeId": "initiative:test",
    }
    profile = {
        "profileId": "kungfu.work-control",
        "profileRoot": _root("3"),
        "sourceContractRoot": _root("6"),
    }
    return status, work_ref, profile


def test_plan_reuses_content_addressed_work_ref_after_lifecycle_advances(tmp_path):
    status, retained, profile = _fixture()
    path = tmp_path / "retained-work-ref.json"
    path.write_text(json.dumps(retained), encoding="utf-8")
    work_ref = fresh_recovery._recovery_work_ref(
        retained_work_ref=path,
        expected_work_ref_root=fresh_recovery._root(retained),
        identity=SimpleNamespace(workspace_id="project:test"),
        status=status,
        recovery_profile=profile,
        initiative_id="initiative:test",
        assignment_id="assignment:test",
    )
    plan = fresh_recovery.build_plan(
        workspace={"id": "project:test", "root": "/project"},
        status=status,
        binding={
            "workRef": work_ref,
            "session": {
                "workConsoleId": "assistant:project:test",
                "sessionAttemptId": "native:new",
            },
        },
        previous_attempt_id="native:old",
        expected_request_root=_root("1"),
        expected_work_definition_root=_root("2"),
        expected_profile_root=_root("3"),
        recovery_profile=profile,
        profile_active=False,
        now="2026-08-25T09:00:00Z",
    )

    assert plan["workRef"] == retained
    assert plan["work"]["systemTimeCut"] == retained["systemTimeCut"]
    assert plan["work"]["currentQueryProofRoot"] == status["query_proof_root"]
    assert fresh_recovery._root(plan["workRef"]) == fresh_recovery._root(retained)


def test_retained_work_ref_root_and_coordinates_fail_closed(tmp_path):
    status, retained, profile = _fixture()
    path = tmp_path / "retained-work-ref.json"
    path.write_text(json.dumps(retained), encoding="utf-8")
    values = {
        "retained_work_ref": path,
        "identity": SimpleNamespace(workspace_id="project:test"),
        "status": status,
        "recovery_profile": profile,
        "initiative_id": "initiative:test",
        "assignment_id": "assignment:test",
    }
    with pytest.raises(ValueError, match="requires --expected-work-ref-root"):
        fresh_recovery._recovery_work_ref(expected_work_ref_root=None, **values)

    with pytest.raises(ValueError, match="root does not match"):
        fresh_recovery._recovery_work_ref(expected_work_ref_root=_root("0"), **values)

    path.write_text(
        json.dumps({**retained, "entityId": "assignment:other"}), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="existing Assignment"):
        fresh_recovery._recovery_work_ref(expected_work_ref_root=_root("0"), **values)


def test_binding_preserves_expected_work_ref_time_cut_only():
    _status, current, _profile = _fixture()
    retained = {**current, "systemTimeCut": _root("8")}

    assert (
        session_contract.retain_expected_work_ref(current, {"workRef": retained})
        == retained
    )
    with pytest.raises(ValueError, match="current Assignment coordinates"):
        session_contract.retain_expected_work_ref(
            current,
            {"workRef": {**retained, "entityId": "assignment:other"}},
        )
