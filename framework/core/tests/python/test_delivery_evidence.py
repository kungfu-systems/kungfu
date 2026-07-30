# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
from datetime import datetime, timezone

import pytest

from kungfu import delivery_evidence
from kungfu.storage import service


NOW = datetime(2026, 7, 28, 16, 0, tzinfo=timezone.utc)


def _root(marker: str) -> str:
    return "sha256:" + marker * 64


def _expectation() -> dict:
    return {
        "schema": delivery_evidence.EXPECTATION_SCHEMA,
        "repository": {
            "id": "R_kgDOExactRepository",
            "fullName": "kungfu-systems/kungfu",
        },
        "pullRequest": {
            "number": 2048,
            "headSha": "a" * 40,
            "mergeCommitSha": "b" * 40,
        },
        "githubRun": {
            "workflow": "Build",
            "runId": "987654321",
            "attempt": 2,
        },
        "buildchain": {
            "receiptRoot": _root("c"),
            "artifactRoots": [_root("d"), _root("e")],
            "schemaRoots": [_root("f")],
        },
        "mergeQueue": {"attemptRoot": _root("1")},
    }


def _envelope() -> dict:
    return {
        **copy.deepcopy(_expectation()),
        "schema": delivery_evidence.ENVELOPE_SCHEMA,
        "timestamps": {
            "mergedAt": "2026-07-28T15:05:00Z",
            "runCompletedAt": "2026-07-28T15:00:00Z",
            "observedAt": "2026-07-28T15:06:00Z",
        },
    }


def _path(value: dict, dotted: str):
    current = value
    names = dotted.split(".")
    for name in names[:-1]:
        current = current[name]
    return current, names[-1]


def test_contract_binds_exact_delivery_coordinates():
    verified = delivery_evidence.verify_envelope(_envelope(), _expectation(), now=NOW)

    assert verified["ok"] is True
    assert verified["coordinateRoot"] == delivery_evidence.coordinate_root(
        _expectation()
    )
    assert verified["evidenceRoot"].startswith("sha256:")
    assert verified["envelope"]["buildchain"]["artifactRoots"] == [
        _root("d"),
        _root("e"),
    ]


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (
            lambda value: value["repository"].update({"fullName": "other/repository"}),
            "delivery-evidence-repository-mismatch",
        ),
        (
            lambda value: value["pullRequest"].update({"headSha": "2" * 40}),
            "delivery-evidence-pr-head-mismatch",
        ),
        (
            lambda value: value["pullRequest"].update({"mergeCommitSha": "3" * 40}),
            "delivery-evidence-merge-mismatch",
        ),
        (
            lambda value: value["githubRun"].update({"attempt": 3}),
            "delivery-evidence-run-mismatch",
        ),
        (
            lambda value: value["buildchain"].update({"artifactRoots": [_root("4")]}),
            "delivery-evidence-artifact-mismatch",
        ),
        (
            lambda value: value["buildchain"].update({"schemaRoots": [_root("5")]}),
            "delivery-evidence-schema-root-mismatch",
        ),
        (
            lambda value: value["mergeQueue"].update({"attemptRoot": _root("6")}),
            "delivery-evidence-queue-mismatch",
        ),
    ],
)
def test_verifier_fails_closed_on_coordinate_mismatch(mutation, code):
    envelope = _envelope()
    mutation(envelope)

    with pytest.raises(delivery_evidence.EvidenceValidationError) as failure:
        delivery_evidence.verify_envelope(envelope, _expectation(), now=NOW)

    assert failure.value.code == code
    assert failure.value.retryable is False


def test_verifier_classifies_missing_malformed_and_stale_evidence():
    missing = _envelope()
    del missing["buildchain"]["receiptRoot"]
    with pytest.raises(delivery_evidence.EvidenceValidationError) as failure:
        delivery_evidence.verify_envelope(missing, _expectation(), now=NOW)
    assert failure.value.code == "delivery-evidence-missing"
    assert failure.value.retryable is True

    malformed = _envelope()
    malformed["pullRequest"]["headSha"] = "not-a-sha"
    with pytest.raises(delivery_evidence.EvidenceValidationError) as failure:
        delivery_evidence.verify_envelope(malformed, _expectation(), now=NOW)
    assert failure.value.code == "delivery-evidence-malformed"
    assert failure.value.retryable is False

    stale = _envelope()
    stale["timestamps"]["runCompletedAt"] = "2026-07-20T15:00:00Z"
    stale["timestamps"]["mergedAt"] = "2026-07-20T15:05:00Z"
    with pytest.raises(delivery_evidence.EvidenceValidationError) as failure:
        delivery_evidence.verify_envelope(stale, _expectation(), now=NOW)
    assert failure.value.code == "delivery-evidence-stale"
    assert failure.value.retryable is False


@pytest.mark.parametrize(
    "mutation",
    [
        lambda timestamps: timestamps.update(
            {
                "runCompletedAt": "2026-07-28T15:05:01Z",
                "mergedAt": "2026-07-28T15:05:00Z",
            }
        ),
        lambda timestamps: timestamps.update(
            {
                "mergedAt": "2026-07-28T15:06:01Z",
                "observedAt": "2026-07-28T15:06:00Z",
            }
        ),
    ],
)
def test_verifier_requires_merge_queue_validation_before_protected_merge(mutation):
    envelope = _envelope()
    mutation(envelope["timestamps"])

    with pytest.raises(delivery_evidence.EvidenceValidationError) as failure:
        delivery_evidence.verify_envelope(envelope, _expectation(), now=NOW)

    assert failure.value.code == "delivery-evidence-malformed"
    assert failure.value.retryable is False


def test_success_is_one_native_fact_and_one_idempotent_delivery_episode(tmp_path):
    runtime = str(tmp_path / "runtime")

    admitted = delivery_evidence.ingest(
        runtime, _envelope(), _expectation(), actor="codex/root", now=NOW
    )
    duplicate = delivery_evidence.ingest(
        runtime, _envelope(), _expectation(), actor="codex/root", now=NOW
    )

    assert admitted["status"] == "admitted"
    assert admitted["state"]["episodeRoot"].startswith("sha256:")
    assert admitted["state"]["lagSeconds"] == 3300
    assert admitted["state"]["unpublishedDownstream"] is True
    assert duplicate["status"] == "duplicate"
    assert duplicate["writeOccurred"] is False
    assert duplicate["state"]["episodeId"] == admitted["state"]["episodeId"]
    source = f"delivery-evidence:{admitted['state']['coordinateRoot'][7:31]}"
    all_episodes = service.episode_list(runtime, limit=0)["episodes"]
    inspected = service.episode_inspect(
        runtime, episode_id=int(admitted["state"]["episodeId"])
    )
    assert inspected["episode"]["open"]["source"] == source, inspected
    episodes = [
        row for row in all_episodes if (row.get("open") or {}).get("source") == source
    ]
    assert len(episodes) == 1, all_episodes
    material = service.fact_material_list(
        runtime,
        type_id=delivery_evidence.FACT_TYPE_ID,
        subject_key=admitted["state"]["ingestionId"],
    )
    assert len(material["state"]["observation_history"]) == 1


def test_retry_after_missing_evidence_converges_without_duplicate_effects(tmp_path):
    runtime = str(tmp_path / "runtime")
    missing = _envelope()
    del missing["buildchain"]["artifactRoots"]

    failed = delivery_evidence.ingest(
        runtime, missing, _expectation(), actor="codex/root", now=NOW
    )
    admitted = delivery_evidence.ingest(
        runtime, _envelope(), _expectation(), actor="codex/root", now=NOW
    )
    repeated = delivery_evidence.ingest(
        runtime, _envelope(), _expectation(), actor="codex/root", now=NOW
    )

    assert failed["status"] == "retryable-failure"
    assert failed["retryAction"] == {
        "action": "retry-delivery-evidence-ingestion",
        "idempotencyKey": failed["state"]["idempotencyKey"],
    }
    assert failed["state"]["retryCount"] == 1
    assert admitted["status"] == "admitted"
    assert admitted["state"]["retryCount"] == 1
    assert admitted["state"]["firstSeenAt"] == failed["state"]["firstSeenAt"]
    assert repeated["status"] == "duplicate"
    material = service.fact_material_list(
        runtime,
        type_id=delivery_evidence.FACT_TYPE_ID,
        subject_key=admitted["state"]["ingestionId"],
    )
    assert len(material["state"]["observation_history"]) == 2


def test_terminal_failure_is_retained_and_does_not_retry(tmp_path):
    runtime = str(tmp_path / "runtime")
    mismatch = _envelope()
    mismatch["mergeQueue"]["attemptRoot"] = _root("7")

    failed = delivery_evidence.ingest(
        runtime, mismatch, _expectation(), actor="codex/root", now=NOW
    )
    repeated = delivery_evidence.ingest(
        runtime, _envelope(), _expectation(), actor="codex/root", now=NOW
    )

    assert failed["status"] == "terminal-failure"
    assert failed["retryAction"] is None
    assert repeated["status"] == "terminal-failure"
    assert repeated["writeOccurred"] is False
    assert service.episode_list(runtime, limit=0)["episodes"]
    delivery_episodes = [
        row
        for row in service.episode_list(runtime, limit=0)["episodes"]
        if str((row.get("open") or {}).get("source") or "").startswith(
            "delivery-evidence:"
        )
    ]
    assert delivery_episodes == []


def test_unknown_raw_payload_is_rejected_and_never_persisted(tmp_path):
    runtime = str(tmp_path / "runtime")
    envelope = _envelope()
    envelope["rawPayload"] = {"authorization": "secret"}

    result = delivery_evidence.ingest(
        runtime, envelope, _expectation(), actor="codex/root", now=NOW
    )

    assert result["status"] == "terminal-failure"
    assert result["state"]["latestErrorCode"] == "delivery-evidence-unknown-field"
    material = service.fact_material_list(
        runtime,
        type_id=delivery_evidence.FACT_TYPE_ID,
        subject_key=result["state"]["ingestionId"],
    )
    assert "secret" not in str(material)
