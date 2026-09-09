# SPDX-License-Identifier: Apache-2.0
"""Native Work binding and observer cases."""
# ruff: noqa: F401,F403

from _run_product_path_support import *
from _run_product_path_support import _capture


def test_native_work_binding_never_guesses_between_assignments(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    _capture(project, "second")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "executing")

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "ambiguous"
    assert selection["candidateAssignmentIds"] == ["first", "second"]


def test_native_work_binding_with_no_work_is_read_only(tmp_path):
    project = tmp_path / "project"
    project.mkdir()

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "none"
    assert not (project / ".kungfu").exists()


@pytest.mark.parametrize("phase", [*orchestration.PHASES, "ready", "planned"])
def test_native_work_binding_discovers_but_does_not_claim_the_only_current_work(
    tmp_path, monkeypatch, phase
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: phase)
    monkeypatch.setattr(
        orchestration,
        "list_sealed_assignment_states",
        lambda *_args: {
            "states": [],
            "unqualified_states": [],
            "issues": [],
        },
    )
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment._status",
        lambda *_args: {
            "assignment": {"assignment_id": "first", "phase": phase},
            "query_proof_root": "sha256:" + "1" * 64,
        },
    )
    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert selection["state"] == "single"
    assert work_ref is None
    assert selection["assignmentId"] == "first"
    assert selection["phase"] == phase


def test_native_work_binding_reports_one_captured_request_without_admitting(
    tmp_path,
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "single"
    assert selection["candidateAssignmentIds"] == ["first"]
    assert selection["assignmentId"] == "first"
    assert selection["phase"] == "captured"
    assert not (project / ".kungfu" / "runtime").exists()


def test_native_work_binding_excludes_portably_settled_work(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "continuation-decided")
    monkeypatch.setattr(
        orchestration,
        "list_sealed_assignment_states",
        lambda *_args: {
            "states": [
                {
                    "assignment_subject": "kungfu:first",
                    "settled": True,
                }
            ],
            "unqualified_states": [],
            "issues": [],
        },
    )

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "none"
    assert selection["candidateAssignmentIds"] == []
    assert selection["settledAssignmentIds"] == ["first"]


def test_native_work_binding_degrades_when_settlement_is_ambiguous(
    tmp_path, monkeypatch
):
    project = tmp_path / "project"
    project.mkdir()
    _capture(project, "first")
    monkeypatch.setattr(run, "_work_phase", lambda *_args: "continuation-decided")
    monkeypatch.setattr(
        orchestration,
        "list_sealed_assignment_states",
        lambda *_args: {
            "states": [],
            "unqualified_states": [],
            "issues": [{"code": "sealed-assignment-state-invalid"}],
        },
    )

    work_ref, selection = run._native_work_binding(
        str(project), "workspace:test", project / ".kungfu" / "runtime"
    )

    assert work_ref is None
    assert selection["state"] == "degraded"
    assert selection["candidateAssignmentIds"] == ["first"]
    assert "cannot prove" in selection["diagnostic"]


def test_native_work_observer_reads_fresh_core_state_without_mutation(
    tmp_path, monkeypatch
):
    root = "sha256:" + "1" * 64
    monkeypatch.setattr(
        "kungfu.cli.commands.assignment._status",
        lambda *_args: {
            "assignment": {
                "title": "Native continuity",
                "objective": "Keep Work visible across native UIs",
                "work_definition": {
                    "acceptance_criteria": ["Rediscover the same Work"]
                },
                "evidenceEpisodeRoots": [root],
            },
            "phase": "executing",
            "query_proof_root": root,
            "next_actions": [
                {
                    "action": "stage",
                    "description": "Record the stage-ready boundary",
                }
            ],
        },
    )

    observed = run._native_work_observer(
        tmp_path,
        {
            "state": "bound",
            "initiativeId": "initiative:alpha",
            "assignmentId": "assignment:alpha",
            "phase": "executing",
        },
    )

    assert observed["state"] == "fresh"
    assert observed["work"] == {
        "schema": "kungfu.native-work-observation/v1",
        "state": "available",
        "initiativeId": "initiative:alpha",
        "assignmentId": "assignment:alpha",
        "title": "Native continuity",
        "objective": "Keep Work visible across native UIs",
        "acceptanceChecks": ["Rediscover the same Work"],
        "phase": "executing",
        "queryProofRoot": root,
        "nextActions": ["stage: Record the stage-ready boundary"],
        "evidenceEpisodeRoots": [root],
        "continuation": {
            "completionClaimCount": 0,
            "independentReviewCount": 0,
            "continuationDecisionCount": 0,
        },
        "remainingObligation": None,
        "nextAction": "stage: Record the stage-ready boundary",
    }


def test_native_work_observer_exposes_none_ambiguous_and_degraded(tmp_path):
    none = run._native_work_observer(tmp_path, {"state": "none"})
    ambiguous = run._native_work_observer(tmp_path, {"state": "ambiguous"})
    degraded = run._native_work_observer(
        tmp_path,
        {"state": "single-unbound", "diagnostic": "proof unavailable"},
    )

    assert none["work"]["state"] == "none"
    assert ambiguous["work"]["state"] == "ambiguous"
    assert degraded["state"] == "degraded"
    assert degraded["work"]["state"] == "degraded"
    assert degraded["diagnostic"] == "proof unavailable"


def test_unbound_native_work_observer_does_not_load_work_authority(
    monkeypatch, tmp_path
):
    import builtins

    original_import = builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "kungfu.cli.commands" and "assignment" in fromlist:
            raise AssertionError("unbound observer loaded Work authority")
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    for state in ("none", "ambiguous", "single", "single-unbound"):
        observed = run._native_work_observer(
            tmp_path,
            {"state": state, "diagnostic": "proof unavailable"},
        )
        assert observed["work"]["state"] in {
            "none",
            "ambiguous",
            "available",
            "degraded",
        }
