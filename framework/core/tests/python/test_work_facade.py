#  SPDX-License-Identifier: Apache-2.0

import hashlib
import json

import pytest

from kungfu.work_facade import (
    READ_ONLY_FACADE_ACTIONS,
    WorkPortabilityError,
    export_portable_work,
    inspect_work,
    plan_completion,
    plan_managed_run_link,
    plan_portable_import,
    portable_import_delta,
    plan_settlement,
    recover_work,
    work_loop_capabilities,
)


ROOT = f"sha256:{'f' * 64}"
CUT_ROOT = f"sha256:{'a' * 64}"


def cut(status="current", confidence="high", gaps=None):
    return {
        "status": status,
        "confidence": confidence,
        "current": {"cutRoot": f"sha256:{'a' * 64}"},
        "gaps": gaps or [],
        "authority": "git-tracked-project-cut",
    }


def work(work_id, status, updated=1):
    return {"work_id": work_id, "status": status, "updated_time": updated}


def portable_cut(cut_root=CUT_ROOT):
    return {
        "status": "current",
        "confidence": "high",
        "current": {
            "cutRoot": cut_root,
            "parentCutRoots": [f"sha256:{'b' * 64}"],
            "sourceRoot": f"sha256:{'c' * 64}",
            "atlasRoot": f"sha256:{'d' * 64}",
            "episodeRoots": [f"sha256:{'e' * 64}"],
            "manifest": ".kungfu/project-cuts/current/manifest.json",
            "receipt": ".kungfu/project-cuts/current/receipt.json",
            "receiptValid": True,
            "publicationCommit": "1" * 40,
        },
        "gaps": [],
        "authority": "git-tracked-project-cut",
    }


def portable_item():
    return {
        "work_id": "w1234abcd",
        "title": "Portable work",
        "kind": "task",
        "summary": "Continue from an exact Cut",
        "status": "waiting",
        "next_action": "resume",
        "created_time": 10,
        "updated_time": 20,
        "checkpoints": [{"time": 11, "note": "source-qualified"}],
        "decisions": [{"time": 12, "decision": "continue", "decided_by": "review"}],
        "validations": [
            {"time": 13, "result": "pass", "command": "./shifu check", "note": None}
        ],
        "artifacts": [
            {
                "time": 14,
                "ref": "https://github.com/kungfu-systems/kungfu/pull/1234",
                "kind": "pull-request",
            }
        ],
        "runs": [{"time": 15, "run_id": "run-1"}],
        "history": [{"time": 10, "event": "created"}],
    }


def resign(envelope):
    unsigned = {key: value for key, value in envelope.items() if key != "portableRoot"}
    encoded = json.dumps(
        unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    envelope["portableRoot"] = f"sha256:{hashlib.sha256(encoded).hexdigest()}"
    return envelope


def test_simple_session_selects_exactly_one_open_work():
    projection = inspect_work(cut(), {"w1": work("w1", "active")})
    assert projection["status"] == "active"
    assert projection["work"]["work_id"] == "w1"
    assert projection["nextActions"] == ["checkpoint", "complete"]
    assert projection["authority"]["projection"] == "non-authoritative"


def test_multiple_open_work_items_fail_visible():
    projection = inspect_work(
        cut(), {"w1": work("w1", "active"), "w2": work("w2", "waiting", 2)}
    )
    assert projection["status"] == "ambiguous"
    assert projection["work"] is None
    assert "multiple-open-work-items" in projection["gaps"]
    assert recover_work(projection)["action"] == "select-work"


def test_ready_work_requires_completion_evidence_before_settlement():
    projection = inspect_work(cut(), {"w1": work("w1", "ready")})
    plan = recover_work(projection)
    assert projection["status"] == "completion-pending"
    assert plan["code"] == "completion-evidence-required"
    assert plan["action"] == "complete"
    assert plan["writeOccurred"] is False


def test_thin_cut_recovery_precedes_work_resume():
    projection = inspect_work(
        cut("thin", "medium", ["receipt-missing"]),
        {"w1": work("w1", "waiting")},
    )
    plan = recover_work(projection)
    assert plan["code"] == "project-cut-thin"
    assert plan["action"] == "recover-project-cut"


def test_managed_run_link_is_idempotent_and_unknown_work_fails_closed():
    items = {"w1": {**work("w1", "active"), "runs": [{"run_id": "r1"}]}}
    assert plan_managed_run_link(items, "w1", "r1")["reused"] is True
    assert plan_managed_run_link(items, "w1", "r2")["code"] == "run-link-required"
    assert plan_managed_run_link(items, "missing", "r2")["ok"] is False


def test_completion_needs_ready_work_and_passing_validation():
    item = {**work("w1", "ready"), "validations": [{"result": "pass"}]}
    projection = inspect_work(cut(), {"w1": item})
    plan = plan_completion(projection, "w1")
    assert plan["status"] == "plan"
    assert plan["requiresIndependentReview"] is True
    assert plan["writeOccurred"] is False


def test_settlement_requires_four_exact_roots_and_never_self_executes():
    plan = plan_settlement(
        "w1",
        claim_root=ROOT,
        review_root=ROOT,
        decision_root=ROOT,
        project_cut_root=ROOT,
    )
    assert plan["status"] == "plan"
    assert plan["writeOccurred"] is False
    blocked = plan_settlement(
        "w1",
        claim_root="",
        review_root=ROOT,
        decision_root=ROOT,
        project_cut_root=ROOT,
    )
    assert blocked["missingRoots"] == ["claimRoot"]


def test_only_facade_plans_bypass_legacy_runtime_initialization():
    assert READ_ONLY_FACADE_ACTIONS == {
        "capabilities",
        "inspect",
        "recover",
        "complete",
        "settle",
        "export",
        "import",
    }
    assert "create" not in READ_ONLY_FACADE_ACTIONS
    assert "checkpoint" not in READ_ONLY_FACADE_ACTIONS


def test_work_loop_capabilities_are_complete_and_fail_visible():
    payload = work_loop_capabilities()
    operations = {row["id"]: row for row in payload["operations"]}
    assert set(operations) == {
        "inspect",
        "begin",
        "checkpoint",
        "complete",
        "settle",
        "resume",
        "recover",
        "export",
        "import",
    }
    assert operations["inspect"]["availability"] == "available"
    assert operations["complete"]["availability"] == "plan-only"
    assert operations["begin"]["availability"] == "unavailable"
    assert operations["begin"]["command"] is None
    assert operations["export"]["availability"] == "available"
    assert operations["import"]["availability"] == "available"
    assert payload["surfaces"]["cli"]["availability"] == "available"
    assert payload["surfaces"]["agent"]["availability"] == "available"
    assert payload["surfaces"]["gui"]["availability"] == "available"
    assert payload["surfaces"]["gui"]["projection"] == "work-dashboard"
    assert payload["surfaces"]["tui"]["availability"] == "available"
    assert payload["surfaces"]["tui"]["projection"] == "mission-control-profile-shell"


def test_portable_export_is_byte_stable_and_excludes_local_time():
    item = portable_item()
    first = export_portable_work(
        portable_cut(), {item["work_id"]: item}, item["work_id"]
    )
    second = export_portable_work(
        portable_cut(), {item["work_id"]: item}, item["work_id"]
    )
    assert first == second
    assert first["schema"] == "kungfu.work.portable-envelope/v1"
    assert first["projectCut"]["cutRoot"] == CUT_ROOT
    assert first["portableRoot"].startswith("sha256:")
    encoded = json.dumps(first)
    assert "created_time" not in encoded
    assert "updated_time" not in encoded
    assert first["work"]["checkpoints"] == [{"note": "source-qualified"}]


def test_portable_import_is_verify_first_idempotent_and_prefix_recoverable():
    item = portable_item()
    envelope = export_portable_work(
        portable_cut(), {item["work_id"]: item}, item["work_id"]
    )
    plan = plan_portable_import(portable_cut(), {}, envelope)
    assert plan["status"] == "plan"
    assert plan["writeOccurred"] is False
    assert plan["actionTypes"] == [
        "create",
        "nextAction",
        "checkpoints",
        "decisions",
        "validations",
        "artifacts",
        "runs",
        "status",
    ]
    current = plan_portable_import(portable_cut(), {item["work_id"]: item}, envelope)
    assert current["status"] == "current"
    assert current["reused"] is True

    partial = {
        **portable_item(),
        "status": "active",
        "next_action": "resume",
        "decisions": [],
        "validations": [],
        "artifacts": [],
        "runs": [],
    }
    assert [
        name for name, _value in portable_import_delta(partial, envelope["work"])
    ] == [
        "decisions",
        "validations",
        "artifacts",
        "runs",
        "status",
    ]


def test_portable_import_rejects_tamper_wrong_cut_and_divergence_without_a_plan():
    item = portable_item()
    envelope = export_portable_work(
        portable_cut(), {item["work_id"]: item}, item["work_id"]
    )
    tampered = json.loads(json.dumps(envelope))
    tampered["work"]["summary"] = "modified"
    with pytest.raises(WorkPortabilityError, match="PORTABLE_ROOT_MISMATCH"):
        plan_portable_import(portable_cut(), {}, tampered)
    with pytest.raises(WorkPortabilityError, match="PORTABLE_PROJECT_CUT_MISMATCH"):
        plan_portable_import(portable_cut(f"sha256:{'9' * 64}"), {}, envelope)
    divergent = {**item, "title": "different"}
    with pytest.raises(WorkPortabilityError, match="PORTABLE_WORK_CONFLICT"):
        plan_portable_import(portable_cut(), {item["work_id"]: divergent}, envelope)


def test_portable_import_rejects_self_signed_cut_shape_and_path_escape():
    item = portable_item()
    envelope = export_portable_work(
        portable_cut(), {item["work_id"]: item}, item["work_id"]
    )
    extra_field = json.loads(json.dumps(envelope))
    extra_field["projectCut"]["localHome"] = "/private/runtime"
    with pytest.raises(WorkPortabilityError, match="PORTABLE_SHAPE_INVALID"):
        plan_portable_import(portable_cut(), {}, resign(extra_field))

    escaped_path = json.loads(json.dumps(envelope))
    escaped_path["projectCut"]["receiptPath"] = ".kungfu/project-cuts/../secret"
    with pytest.raises(WorkPortabilityError, match="PORTABLE_PROJECT_CUT_PATH_INVALID"):
        plan_portable_import(portable_cut(), {}, resign(escaped_path))


def test_portable_export_rejects_sensitive_or_unverified_material():
    item = portable_item()
    item["artifacts"][0]["ref"] = "https://example.invalid/file?token=secret"
    with pytest.raises(WorkPortabilityError, match="PORTABLE_SENSITIVE_TEXT"):
        export_portable_work(portable_cut(), {item["work_id"]: item}, item["work_id"])
    for credential in (
        f"ghp_{'A' * 36}",
        f"github_pat_{'A' * 82}",
        f"Bearer {'a' * 32}",
    ):
        credential_item = portable_item()
        credential_item["summary"] = credential
        with pytest.raises(WorkPortabilityError, match="PORTABLE_SENSITIVE_TEXT"):
            export_portable_work(
                portable_cut(),
                {credential_item["work_id"]: credential_item},
                credential_item["work_id"],
            )
    malformed = portable_item()
    malformed["title"] = "https://[broken"
    with pytest.raises(WorkPortabilityError, match="PORTABLE_TEXT_INVALID"):
        export_portable_work(
            portable_cut(), {malformed["work_id"]: malformed}, malformed["work_id"]
        )
    oversized = portable_item()
    oversized["summary"] = "x" * 65537
    with pytest.raises(WorkPortabilityError, match="PORTABLE_TEXT_TOO_LARGE"):
        export_portable_work(
            portable_cut(),
            {oversized["work_id"]: oversized},
            oversized["work_id"],
        )
    cut_projection = portable_cut()
    cut_projection["current"]["receiptValid"] = False
    with pytest.raises(WorkPortabilityError, match="PORTABLE_PROJECT_CUT_UNVERIFIED"):
        export_portable_work(
            cut_projection, {item["work_id"]: portable_item()}, item["work_id"]
        )
