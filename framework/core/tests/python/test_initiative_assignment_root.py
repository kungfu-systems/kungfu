# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

import pytest

from kungfu.initiative_family.canonical import (
    InitiativeAssignmentRootError,
    initiative_assignment_root_evidence,
    verify_initiative_assignment_root,
)


CORPUS = json.loads(
    (
        Path(__file__).parents[4]
        / "tests/fixtures/initiative-assignment-root/vectors.json"
    ).read_text(encoding="utf-8")
)
CONTRACT = json.loads(
    (
        Path(__file__).parents[4]
        / "framework/initiative-assignment/kungfu-initiative-assignment-root-v1.json"
    ).read_text(encoding="utf-8")
)
ACCEPTED = {row["id"]: row for row in CORPUS["accepted"]}


def test_contract_binds_protocol_preimage_history_and_conformance() -> None:
    assert CONTRACT["protocolId"] == CORPUS["protocolId"]
    assert CONTRACT["inputFields"] == [
        "protocolId",
        "surfaceId",
        "subjectKey",
        "payload",
    ]
    assert CONTRACT["preimage"]["segments"] == [
        "UTF-8(protocolId)",
        "00",
        "UTF-8(ActionCanonicalJson({payload,subjectKey,surfaceId}))",
    ]
    assert "MUST NOT recalculate" in CONTRACT["historyBoundary"]["rule"]
    assert CONTRACT["conformance"]["vectors"] == (
        "tests/fixtures/initiative-assignment-root/vectors.json"
    )
    assert {
        row.rsplit(".", 1)[-1] for row in CONTRACT["conformance"]["implementations"]
    } == {
        "py",
        "cpp",
    }


@pytest.mark.parametrize("vector", CORPUS["accepted"], ids=lambda row: row["id"])
def test_accepted_vectors(vector: dict[str, object]) -> None:
    assert initiative_assignment_root_evidence(vector["input"]) == vector["expected"]
    assert (
        verify_initiative_assignment_root(
            vector["input"],
            canonical_hex=vector["expected"]["canonicalHex"],
            preimage_hex=vector["expected"]["preimageHex"],
            root=vector["expected"]["root"],
        )
        == vector["expected"]
    )


@pytest.mark.parametrize("vector", CORPUS["rejected"], ids=lambda row: row["id"])
def test_rejected_vectors(vector: dict[str, object]) -> None:
    accepted_id = vector.get("acceptedId")
    if isinstance(accepted_id, str):
        accepted = ACCEPTED[accepted_id]
        value = accepted["input"]
        claim = dict(accepted["expected"])
        override = vector["claimOverride"]
        claim[override["field"]] = override["value"]
    else:
        value = vector["input"]
        claim = None
    with pytest.raises(InitiativeAssignmentRootError) as raised:
        if isinstance(claim, dict):
            verify_initiative_assignment_root(
                value,
                canonical_hex=claim["canonicalHex"],
                preimage_hex=claim["preimageHex"],
                root=claim["root"],
            )
        else:
            initiative_assignment_root_evidence(value)
    assert raised.value.code == vector["failureCode"]
