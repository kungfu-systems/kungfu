# SPDX-License-Identifier: Apache-2.0

import importlib
from types import SimpleNamespace

import pytest


ASSIGNMENT_CLI = importlib.import_module("kungfu.cli.commands.assignment")


def _sha256(marker):
    return "sha256:" + marker * 64


def _equivalent_reviews(*, include_plan=False):
    plan_root = _sha256("8")
    claim_hash = _sha256("9")
    reviews = [
        {
            "review_id": f"review-{index}",
            "claim_id": "completion-a",
            "claim_payload_hash": claim_hash,
            "continuation_plan_root": plan_root,
            **(
                {"continuation_plan": {"allowed_actions": ["approve", "close"]}}
                if include_plan
                else {}
            ),
            "verdict": "fit",
        }
        for index in range(3)
    ]
    return plan_root, reviews


def test_work_close_resume_deduplicates_equivalent_fit_reviews(tmp_path, monkeypatch):
    plan_root, reviews = _equivalent_reviews()
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_runtime",
        lambda *_args: (SimpleNamespace(), tmp_path / "runtime", None),
    )
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_status",
        lambda *_args: {
            "phase": "independently-reviewed",
            "independent_reviews": reviews,
            "continuation_decisions": [],
        },
    )

    resumed = ASSIGNMENT_CLI._resume_starter_close(
        workspace_root=tmp_path,
        home=None,
        initiative_id="initiative-a",
        assignment_id="assignment-a",
    )

    assert resumed["status"] == "review-passed"
    assert resumed["reviewReceipt"]["planRoot"] == plan_root
    assert resumed["writeOccurred"] is False


def test_work_close_plan_deduplicates_equivalent_fit_reviews(tmp_path, monkeypatch):
    _, reviews = _equivalent_reviews(include_plan=True)
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_runtime",
        lambda *_args: (
            SimpleNamespace(
                workspace_id="project-a",
                workspace_root=str(tmp_path),
                identity_root=_sha256("1"),
            ),
            tmp_path / "runtime",
            None,
        ),
    )
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_status",
        lambda *_args: {
            "phase": "independently-reviewed",
            "query_proof_root": _sha256("2"),
            "assignment": {"assignment_id": "assignment-a"},
            "independent_reviews": reviews,
            "continuation_decisions": [],
        },
    )

    plan = ASSIGNMENT_CLI._work_close_plan(
        workspace_root=tmp_path,
        home=None,
        initiative_id="initiative-a",
        assignment_id="assignment-a",
    )

    assert plan["review"]["id"] == "review-2"
    assert plan["executable"] is True
    assert plan["writeOccurred"] is False


def test_work_close_resume_rejects_conflicting_fit_reviews(tmp_path, monkeypatch):
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_runtime",
        lambda *_args: (SimpleNamespace(), tmp_path / "runtime", None),
    )
    monkeypatch.setattr(
        ASSIGNMENT_CLI,
        "_status",
        lambda *_args: {
            "phase": "independently-reviewed",
            "independent_reviews": [
                {
                    "review_id": "review-a",
                    "claim_id": "completion-a",
                    "claim_payload_hash": _sha256("1"),
                    "continuation_plan_root": _sha256("2"),
                    "verdict": "fit",
                },
                {
                    "review_id": "review-b",
                    "claim_id": "completion-b",
                    "claim_payload_hash": _sha256("3"),
                    "continuation_plan_root": _sha256("4"),
                    "verdict": "fit",
                },
            ],
            "continuation_decisions": [],
        },
    )

    with pytest.raises(ValueError, match="conflicting fit reviews"):
        ASSIGNMENT_CLI._resume_starter_close(
            workspace_root=tmp_path,
            home=None,
            initiative_id="initiative-a",
            assignment_id="assignment-a",
        )
