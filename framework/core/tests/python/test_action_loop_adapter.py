# SPDX-License-Identifier: Apache-2.0

from kungfu.agent import action_loop


def _root(character: str) -> str:
    return "sha256:" + character * 64


def _payload() -> dict:
    atlas_root = _root("a")
    return {
        "loopRef": "action-loop/same-root-atlas",
        "loopId": "loop:same-root-atlas",
        "loopRoot": _root("b"),
        "idempotencyKey": "same-root-atlas",
        "predecessor": {
            "id": "atlas:current",
            "root": atlas_root,
            "state": "current",
        },
        "successor": {
            "binding": {
                "id": "atlas:current",
                "root": atlas_root,
                "state": "current",
            },
            "verification": {
                "valid": True,
                "atlasRoot": atlas_root,
                "receiptRoot": _root("c"),
                "diagnostics": [],
            },
        },
        "episode": {
            "id": "episode:same-root-atlas",
            "root": _root("d"),
            "state": "sealed",
        },
    }


def test_same_root_first_atlas_refresh_binds_receipt_then_replays(
    monkeypatch, tmp_path
):
    payload = _payload()
    current = {
        "roles": {
            "atlas": {
                "body": {
                    "details": {
                        "root": payload["successor"]["binding"]["root"],
                    }
                }
            }
        }
    }
    calls = []

    def apply_transition(_runtime_dir, **kwargs):
        calls.append(kwargs)
        current["roles"]["atlas"]["body"]["details"] = kwargs["payload"]
        return {
            "status": "accepted",
            "inspection": {"cutRoot": _root("e"), "revision": 2},
        }

    monkeypatch.setattr(action_loop, "_current_profile", lambda *_: current)
    monkeypatch.setattr(action_loop, "_apply_profile_transition", apply_transition)

    first = action_loop.refresh_atlas(tmp_path, payload)
    assert first["status"] == "accepted"
    assert first["writeOccurred"] is True
    assert len(calls) == 1
    assert calls[0]["operation"] == "refresh"
    assert calls[0]["payload"]["predecessorRoot"] == payload["predecessor"]["root"]
    assert calls[0]["payload"]["actionLoopStepReceipt"] == first["receipt"]

    current["cutRoot"] = _root("e")
    current["revision"] = 2
    replay = action_loop.refresh_atlas(tmp_path, payload)
    assert replay["status"] == "accepted"
    assert replay["writeOccurred"] is False
    assert replay["receipt"] == first["receipt"]
    assert len(calls) == 1


def test_completion_claim_emits_canonical_context_roots(monkeypatch, tmp_path):
    calls = []

    def mission_action(_runtime_dir, intent_id, values):
        calls.append((intent_id, values))
        if intent_id == "claim-completion":
            return {"receipt": {"payload_hash": _root("e")}}
        if intent_id == "review-completion":
            return {
                "review": {"review_id": "review-a", "verdict": "fit"},
                "review_root": _root("f"),
                "continuation_plan_root": _root("1"),
            }
        assert intent_id == "decide-continuation"
        return {"receipt": {"payload_hash": _root("2")}}

    monkeypatch.setattr(action_loop, "_mission_action", mission_action)
    payload = {
        "loopId": "loop:completion",
        "loopRoot": _root("3"),
        "idempotencyKey": "completion",
        "envelope": {"roles": {"atlas": {"root": _root("4")}}},
        "completion": {
            "missionId": "initiative-a",
            "goalId": "assignment-a",
            "statement": "Compatibility is proven.",
            "reviewer": "independent-reviewer",
            "reviewerSource": _root("5"),
            "inputAtlasRoot": _root("6"),
        },
    }

    result = action_loop.review_completion(tmp_path, payload)

    assert result["status"] == "accepted"
    claim_values = calls[0][1]
    assert claim_values["inputContextRoot"] == _root("6")
    assert claim_values["resultContextRoot"] == _root("4")
    assert "inputAtlasRoot" not in claim_values
    assert "resultAtlasRoot" not in claim_values
