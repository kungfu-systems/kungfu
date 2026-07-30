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
