# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import kungfu
import pytest

from kungfu import profile_composition, profile_sdk, runtime_broker, runtime_service
from kungfu.atlas import importer, mission_bundle, mission_control, payloads
from kungfu.atlas import store as atlas_store
from kungfu.atlas import CARRIER_ATLAS_ACTION
from kungfu.rewind import reporting as rewind_reporting
from kungfu.sources import store as source_store
from kungfu.storage import service as storage_service


MISSION_PROFILE_SOURCE = (
    Path(__file__).resolve().parents[4] / "extensions" / "mission-control"
)


def _activate_mission_profile(runtime_dir, *, materialize=True):
    for action in ("install", "qualify", "activate"):
        plan = profile_sdk.lifecycle_plan(
            runtime_dir,
            action,
            MISSION_PROFILE_SOURCE,
            **({"granted_permissions": ["storage"]} if action == "activate" else {}),
        )["corePlan"]
        profile_sdk.lifecycle_apply(runtime_dir, plan, f"test:{action}")
    contract = profile_composition.contract_materialization_plan(
        MISSION_PROFILE_SOURCE, runtime_dir
    )
    if materialize and contract["operations"]:
        profile_composition.authorized_contract_materialize(
            runtime_dir,
            contract,
            profile_sdk.answer_decision(
                contract["decisionCard"], "approve", "test-owner"
            ),
        )


def _import_atlas(runtime_dir, repo_root):
    receipt = profile_sdk.invoke_member_adapter(
        MISSION_PROFILE_SOURCE,
        runtime_dir,
        "mission-control-actions",
        "import-atlas",
        {"repo": str(repo_root), "source": "atlas"},
        authorized_action=True,
    )
    return receipt["result"]["coreReceipt"]


def _admit_profile_runtime(monkeypatch, runtime_dir, config_home):
    runtime_path = Path(runtime_dir).resolve()
    evidence = {
        "schema": "kungfu.runtime.native-readiness-evidence/v1",
        "workspaceId": runtime_broker.workspace_id(runtime_path),
        "runtimeHome": str(runtime_path.parent),
        "dataRoot": str(runtime_path),
        "minimumCut": {
            "stream_id": "1",
            "container_epoch": "1",
            "sequence": "1",
            "frame_uid": "1",
        },
        "durability": {
            "requestId": "17",
            "requestedProfile": "durable_sync",
            "writerResourceId": "00000007.0000000b",
            "qualificationProfile": "test/disposable-powercut/v1",
        },
        "projection": None,
    }
    path = runtime_broker.native_readiness_evidence_path(runtime_dir, config_home)
    _write_json(path, evidence)

    class AdmittingBroker:
        def invoke(self, plan, callback):
            activation = {"outcome": "activated"}
            return {
                "schema": "kungfu.runtime.invocation-receipt/v1",
                "planId": plan["planId"],
                "operationId": plan["operation"]["id"],
                "accepted": True,
                "activation": activation,
                "result": callback(activation),
            }

    monkeypatch.setattr(
        runtime_broker.RuntimeCapabilityBroker,
        "for_process",
        classmethod(lambda cls, *_args, **_kwargs: AdmittingBroker()),
    )


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def _sha256_root(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sealed_work_episode(runtime_dir, *, episode_id=5200):
    storage_service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        begin_time=1000,
        title="assessment work",
        actor="pytest",
        source="adr-0052-test",
    )
    closed = storage_service.episode_end(
        runtime_dir,
        episode_id=episode_id,
        end_time=1100,
        reason="work sealed before assessment",
    )
    return "sha256:" + closed["content_root"]["root_value"]


def _assessment_request(work_episode_root, *, episode_id=5200, evidence=None):
    return {
        "claim_id": "claim-release-ready",
        "claim_type": "release-readiness",
        "purpose": "release-gate",
        "work_episode_id": episode_id,
        "work_episode_root": work_episode_root,
        "query_definition_root": _sha256_root("query-definition"),
        "query_proof_root": _sha256_root("query-proof"),
        "contract_world": {
            "id": "kungfu-runtime",
            "version": "v1",
            "root": _sha256_root("contract-world"),
        },
        "fact_surfaces": [
            {
                "id": "release-facts",
                "version": "v1",
                "root": _sha256_root("release-facts"),
            }
        ],
        "policy": {
            "id": "deterministic-assessor",
            "version": "v1",
            "root": _sha256_root("deterministic-assessor"),
        },
        "evidence": evidence
        or {
            "canonical_fact_count": 3,
            "conflict_count": 0,
            "admitted_count": 3,
            "unregistered_surface_count": 0,
            "incompatible_schema_count": 0,
            "ambiguous_authority_count": 0,
            "unverifiable_count": 0,
        },
        "deadline": 0,
        "responsibility": "workspace-coordinator",
        "residual_risks": ["first built-in assessor only"],
    }


def _atlas_fixture(root):
    _write_json(
        root / "agent-journal/missions/registry/active/mission-a.json",
        {
            "mission_id": "mission-a",
            "title": "Mission A",
            "status": "active",
            "updated_at": "2026-07-08T00:00:00Z",
            "active_lens": "principal-engineer",
            "current_stage": {"name": "stage-a", "next_review": "2026-07-08"},
            "large_body": {"kept": "full mission payload"},
        },
    )
    _write_json(
        root / "agent-journal/goals/registry/active/goal-a.json",
        {
            "goal_id": "goal-a",
            "status": "active",
            "updated_at": "2026-07-08T01:00:00Z",
            "title": "Goal A",
            "mission_id": "mission-a",
            "mission_parent_goal": "goal-parent",
            "mission_role": "supporting",
            "mission_importance": "high",
            "mission_track": "mission-control",
            "mission_why_matters": "Make the Mission legible",
            "next_action": "implement",
            "large_body": ["full", "goal", "payload"],
        },
    )
    _write_json(
        root / "reviews/worktree-status/ai__codex__goal-a.json",
        {
            "branch": "ai/codex/goal-a",
            "status": "ready",
            "updated_at": "2026-07-08T02:00:00Z",
            "ready": True,
            "summary": "ready marker",
            "risk": "",
        },
    )


def _atlas_window_context_fixture(root):
    _write_json(
        root / "agent-journal/goals/registry/archive/goal-old.json",
        {
            "goal_id": "goal-old",
            "status": "done",
            "updated_at": "2026-06-01T00:00:00Z",
            "title": "Old Goal",
        },
    )
    _write_json(
        root / "agent-journal/missions/registry/archive/mission-b.json",
        {
            "mission_id": "mission-b",
            "title": "Mission B",
            "status": "active",
            "updated_at": "2026-06-01T00:00:00Z",
        },
    )
    _write_json(
        root / "agent-journal/goals/registry/active/goal-b.json",
        {
            "goal_id": "goal-b",
            "status": "active",
            "updated_at": "2026-07-08T00:00:00Z",
            "title": "Goal B",
            "mission_id": "mission-b",
        },
    )


def _action_receipts(source_records):
    receipts = {}
    for index, record in enumerate(
        payloads.enrich_source_records(source_records), start=1
    ):
        journal_payload = f"journal-payload-{index}".encode("utf-8")
        receipts[(record["kind"], record["source_id"])] = {
            "frame_uid": index,
            "trigger_frame_uid": index - 1,
            "stream_id": 0,
            "gen_time": 1000 + index,
            "trigger_time": 0,
            "carrier_type": CARRIER_ATLAS_ACTION,
            "source": 101,
            "initial_source": 101,
            "dest": 0,
            "data_length": len(journal_payload),
            "data_type": 0,
            "journal_payload_hash": payloads.payload_hash(journal_payload),
        }
    return receipts


def _action_frames_from_manifest(manifest):
    frames = {}
    for entry in manifest["entries"]:
        if "action" not in entry:
            continue
        journal = dict(entry["action"]["journal"])
        journal["_payload"] = f"journal-payload-{journal['frame_uid']}".encode("utf-8")
        frames[
            (
                entry["action"]["journal"]["frame_uid"],
                entry["action"]["journal"]["gen_time"],
            )
        ] = journal
    return frames


def _action_frames_with_checksums(manifest, payload_checksum, frame_checksum):
    frames = _action_frames_from_manifest(manifest)
    for frame in frames.values():
        frame["_payload_checksum_for"] = (
            lambda _length, _algorithm, checksum=payload_checksum: checksum
        )
        frame["_frame_checksum_for"] = (
            lambda _length, _algorithm, checksum=frame_checksum: checksum
        )
    return frames


def test_atlas_source_records_keep_full_payloads(tmp_path):
    repo = tmp_path / "atlas"
    _atlas_fixture(repo)

    (
        missions,
        goals,
        markers,
        source_records,
        warnings,
    ) = importer.read_control_plane_with_sources(str(repo))

    assert warnings == []
    assert [card["mission_id"] for card in missions] == ["mission-a"]
    assert [card["goal_id"] for card in goals] == ["goal-a"]
    assert goals[0]["mission_parent_goal"] == "goal-parent"
    assert goals[0]["mission_role"] == "supporting"
    assert goals[0]["mission_importance"] == "high"
    assert goals[0]["mission_track"] == "mission-control"
    assert goals[0]["mission_why_matters"] == "Make the Mission legible"
    assert goals[0]["updated_at"] == "2026-07-08T01:00:00Z"
    assert [card["branch"] for card in markers] == ["ai/codex/goal-a"]
    assert {(row["kind"], row["source_id"]) for row in source_records} == {
        ("mission", "mission-a"),
        ("goal", "goal-a"),
        ("marker", "ai/codex/goal-a"),
    }
    mission = next(row for row in source_records if row["kind"] == "mission")
    assert mission["payload"]["large_body"] == {"kept": "full mission payload"}
    assert mission["source_path"] == (
        "agent-journal/missions/registry/active/mission-a.json"
    )
    assert mission["source_time"] == "2026-07-08T00:00:00Z"


def test_atlas_source_records_filter_by_window(tmp_path):
    repo = tmp_path / "atlas"
    _atlas_fixture(repo)
    _atlas_window_context_fixture(repo)

    (
        missions,
        goals,
        _,
        source_records,
        warnings,
    ) = importer.read_control_plane_with_sources(
        str(repo),
        window={"since": "2026-07-01T00:00:00Z"},
    )

    assert warnings == []
    assert [card["goal_id"] for card in goals] == ["goal-a", "goal-b"]
    assert [card["mission_id"] for card in missions] == ["mission-a", "mission-b"]
    assert ("goal", "goal-old") not in {
        (record["kind"], record["source_id"]) for record in source_records
    }
    assert ("mission", "mission-b") in {
        (record["kind"], record["source_id"]) for record in source_records
    }


def test_atlas_import_admits_mission_and_go_into_shared_fact_state(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)

    first = _import_atlas(runtime_dir, repo)
    admitted = first["mission_control"]
    assert admitted["status"] == "admitted", admitted.get("error", admitted)
    assert admitted["authority_mode"] == "atlas-bridge"
    assert admitted["contract_world"] == {
        "id": mission_control.CONTRACT_WORLD_ID,
        "version": mission_control.CONTRACT_VERSION,
    }
    assert admitted["admitted"] == 2
    assert admitted["already_present"] == 0
    assert admitted["outcomes"] == {"admitted": 2}
    assert admitted["import_episode_id"] == first["episode_id"]
    assert admitted["import_episode_root"].startswith("sha256:")

    state = storage_service.fact_state(runtime_dir)
    assert len(state["canonical_facts"]) == 2
    assert {row["fact_surface_id"] for row in state["canonical_facts"]} == {
        mission_control.MISSION_SURFACE_ID,
        mission_control.GO_SURFACE_ID,
    }
    material = storage_service.fact_material_list(runtime_dir)
    bodies = list(material["payloads"].values())
    assert {body["source"]["authority_mode"] for body in bodies} == {"atlas-bridge"}
    assert {body["source"]["import_episode_root"] for body in bodies} == {
        admitted["import_episode_root"]
    }
    goal_body = next(body for body in bodies if body["source"]["kind"] == "goal")
    assert goal_body["links"] == {"initiative_id": "atlas:mission-a"}
    assert goal_body["record"]["assignment_id"] == "goal-a"
    assert goal_body["record"]["mission_parent_goal"] == "goal-parent"
    assert goal_body["record"]["mission_role"] == "supporting"
    assert goal_body["record"]["mission_importance"] == "high"
    assert goal_body["record"]["mission_track"] == "mission-control"
    assert goal_body["record"]["mission_why_matters"] == ("Make the Mission legible")
    assert goal_body["record"]["updated_at"] == "2026-07-08T01:00:00Z"

    second = _import_atlas(runtime_dir, repo)
    assert second["mission_control"]["status"] == "admitted"
    assert second["mission_control"]["admitted"] == 0
    assert second["mission_control"]["already_present"] == 2
    assert len(storage_service.fact_state(runtime_dir)["canonical_facts"]) == 2

    goal_path = repo / "agent-journal/goals/registry/active/goal-a.json"
    changed = json.loads(goal_path.read_text(encoding="utf-8"))
    changed["status"] = "ready"
    changed["updated_at"] = "2026-07-09T00:00:00Z"
    _write_json(goal_path, changed)
    third = _import_atlas(runtime_dir, repo)
    assert third["mission_control"]["status"] == "admitted", third["mission_control"]
    assert third["mission_control"]["admitted"] == 1
    assert third["mission_control"]["already_present"] == 1
    goal_material = storage_service.fact_material_list(
        runtime_dir,
        type_id=mission_control.GO_SURFACE_ID,
        subject_key="atlas:goal-a",
    )
    latest = goal_material["state"]["canonical_facts"]
    assert len(latest) == 1
    latest_body = goal_material["payloads"][latest[0]["payload_hash"]]
    assert latest_body["record"]["status"] == "ready"


def test_mission_go_authority_cutover_is_parity_bound_and_freezes_atlas(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    imported = _import_atlas(runtime_dir, repo)

    parity = mission_control.authority_parity(str(runtime_dir))
    assert parity["status"] == "matched"
    assert parity["counts"] == {
        "expected": 2,
        "admitted": 2,
        "missing": 0,
        "extra": 0,
        "hash_mismatch": 0,
        "unavailable": 0,
    }
    assert parity["basis"]["atlas_import"]["import_id"] == imported["import_id"]
    assert parity["parity_root"].startswith("sha256:")

    with pytest.raises(ValueError, match="parity root changed"):
        mission_control.cutover_authority(
            str(runtime_dir),
            storage_source_id="atlas",
            expected_parity_root=_sha256_root("stale-parity"),
            project_cut_root=_sha256_root("project-cut"),
            atlas_root=_sha256_root("atlas-root"),
            actor="test-agent",
            reason="prove exact parity",
        )

    cutover = mission_control.cutover_authority(
        str(runtime_dir),
        storage_source_id="atlas",
        expected_parity_root=parity["parity_root"],
        project_cut_root=_sha256_root("project-cut"),
        atlas_root=_sha256_root("atlas-root"),
        actor="test-agent",
        reason="move runtime writes to native Mission Control",
    )
    assert cutover["status"] == "cutover"
    assert cutover["migration"]["legacy_mutation_path"] == "frozen-read-only"
    assert cutover["migration"]["atlas_import"]["repo_head"] == (
        imported["repo_head"] or ""
    )
    authority = mission_control.authority_status(str(runtime_dir))
    assert authority["state"] == "native-active"
    assert authority["write_authority"] == "kungfu-native"
    assert authority["parity_root"] == parity["parity_root"]

    with pytest.raises(ValueError, match="Atlas Mission/Go mutation path is frozen"):
        _import_atlas(runtime_dir, repo)

    created = mission_control.create_go(
        str(runtime_dir),
        mission_id="mission-a",
        goal_id="native-child",
        title="Native child",
        objective="Continue after authority cutover",
        actor="test-agent",
        parent_goal_id="goal-a",
        owning_workspace_identity_root=_sha256_root("workspace"),
        responsibility="review-agent",
        acceptance_root=_sha256_root("acceptance"),
        atlas_root=_sha256_root("successor-atlas"),
        context_binding={
            "schema": "xinfa.go-context-binding/v1",
            "status": "complete",
            "atlas_root": _sha256_root("successor-atlas"),
            "cut_root": _sha256_root("input-cut"),
            "route_id": "mission-control",
            "route_root": _sha256_root("route"),
            "authority_root": _sha256_root("authority"),
            "task_envelope_root": _sha256_root("task-envelope"),
            "route_receipt_root": _sha256_root("route-receipt"),
            "chart_root": _sha256_root("chart"),
            "policy_root": _sha256_root("policy"),
            "omissions_root": _sha256_root("omissions"),
            "budget": 32768,
        },
        project_cut_root=_sha256_root("successor-cut"),
        evidence_episode_roots=[_sha256_root("episode")],
    )
    assert created["receipt"]["status"] == "admitted"
    native = next(
        row
        for row in mission_control.list_goals(str(runtime_dir))
        if row["goal_id"] == "native-child"
    )
    assert native["parent_goal_id"] == ""
    assert native["depends_on"] == []
    assert native["parent_assignment_ref"]["workspace_identity_root"] == (
        _sha256_root("workspace")
    )
    assert native["parent_assignment_ref"]["subject"] == "atlas:goal-a"
    assert native["responsibility"] == "review-agent"
    assert native["project_cut_root"] == _sha256_root("successor-cut")
    assert native["context_binding"]["route_id"] == "mission-control"
    assert native["context_binding_root"].startswith("sha256:")

    with pytest.raises(ValueError, match="must equal atlas_root"):
        mission_control.create_go(
            str(runtime_dir),
            mission_id="mission-a",
            goal_id="mismatched-context",
            title="Mismatched context",
            objective="Reject a stale context binding",
            actor="test-agent",
            atlas_root=_sha256_root("successor-atlas"),
            context_binding={
                **native["context_binding"],
                "atlas_root": _sha256_root("stale-atlas"),
            },
        )


def test_mission_go_authority_rollback_is_exact_and_retains_native_facts(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    _import_atlas(runtime_dir, repo)
    parity = mission_control.authority_parity(str(runtime_dir))
    cutover = mission_control.cutover_authority(
        str(runtime_dir),
        storage_source_id="atlas",
        expected_parity_root=parity["parity_root"],
        project_cut_root=_sha256_root("project-cut"),
        atlas_root=_sha256_root("atlas-root"),
        actor="test-agent",
        reason="exercise rollback",
    )
    cutover_id = cutover["migration"]["migration_id"]

    with pytest.raises(ValueError, match="migration changed"):
        mission_control.rollback_authority(
            str(runtime_dir),
            expected_migration_id="authority-stale",
            actor="test-agent",
            reason="stale rollback",
        )

    rolled_back = mission_control.rollback_authority(
        str(runtime_dir),
        expected_migration_id=cutover_id,
        actor="test-agent",
        reason="restore legacy writer",
    )
    assert rolled_back["migration"]["native_fact_disposition"] == ("retained-read-only")
    authority = mission_control.authority_status(str(runtime_dir))
    assert authority["state"] == "rolled-back"
    assert authority["write_authority"] == mission_control.ATLAS_FACT_SOURCE_ID
    assert authority["transition_count"] == 2

    with pytest.raises(ValueError, match="mutation is frozen by authority rollback"):
        mission_control.create_go(
            str(runtime_dir),
            mission_id="mission-a",
            goal_id="must-not-dual-write",
            title="Rejected",
            objective="Prevent dual writes",
            actor="test-agent",
        )
    repeated_import = _import_atlas(runtime_dir, repo)
    assert repeated_import["mission_control"]["status"] == "admitted"
    next_parity = mission_control.authority_parity(str(runtime_dir))
    recutover = mission_control.cutover_authority(
        str(runtime_dir),
        storage_source_id="atlas",
        expected_parity_root=next_parity["parity_root"],
        project_cut_root=_sha256_root("project-cut-2"),
        atlas_root=_sha256_root("atlas-root-2"),
        actor="test-agent",
        reason="prove a successor cutover is a new event",
    )
    assert recutover["migration"]["migration_id"] != cutover_id
    assert (
        recutover["migration"]["previous_migration_id"]
        == (rolled_back["migration"]["migration_id"])
    )
    assert mission_control.authority_status(str(runtime_dir))["transition_count"] == 3


def test_mission_go_authority_cli_uses_the_profile_action_boundary(
    tmp_path, monkeypatch
):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    config_home = tmp_path / "config"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    _import_atlas(runtime_dir, repo)
    _admit_profile_runtime(monkeypatch, runtime_dir, config_home)

    from click.testing import CliRunner
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    runner = CliRunner(mix_stderr=False)
    cli_env = {
        "KF_RUNTIME_DIR": str(runtime_dir),
        "KF_CONFIG_HOME": str(config_home),
    }
    status_cli = runner.invoke(
        kfc, ["atlas", "authority-status", "--json"], env=cli_env
    )
    assert status_cli.exit_code == 0, status_cli.output
    assert "compatibility alias" in status_cli.stderr
    before = json.loads(status_cli.output)
    assert before["authority"]["state"] == "pre-cutover"
    assert before["parity"]["status"] == "matched"

    cutover_cli = runner.invoke(
        kfc,
        [
            "atlas",
            "authority-cutover",
            "--expected-parity-root",
            before["parity"]["parity_root"],
            "--project-cut-root",
            _sha256_root("project-cut"),
            "--atlas-root",
            _sha256_root("atlas-root"),
            "--actor",
            "test-agent",
            "--reason",
            "prove the shared CLI and Profile action boundary",
            "--json",
        ],
        env=cli_env,
    )
    assert cutover_cli.exit_code == 0, cutover_cli.output
    cutover = json.loads(cutover_cli.output)
    assert cutover["status"] == "cutover"

    active_cli = runner.invoke(
        kfc, ["atlas", "authority-status", "--json"], env=cli_env
    )
    assert active_cli.exit_code == 0, active_cli.output
    assert json.loads(active_cli.output)["authority"]["write_authority"] == (
        "kungfu-native"
    )

    rollback_cli = runner.invoke(
        kfc,
        [
            "atlas",
            "authority-rollback",
            "--expected-migration-id",
            cutover["migration"]["migration_id"],
            "--actor",
            "test-agent",
            "--reason",
            "exercise the exact rollback fence",
            "--json",
        ],
        env=cli_env,
    )
    assert rollback_cli.exit_code == 0, rollback_cli.output
    assert json.loads(rollback_cli.output)["status"] == "rolled-back"


def test_atlas_source_import_does_not_own_mission_admission(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _atlas_fixture(repo)

    imported = atlas_store.ImportStore(runtime_dir).run_import(str(repo))

    assert imported["post_seal"] is None
    assert imported["missions"] == 1
    assert imported["goals"] == 1
    assert storage_service.fact_state(runtime_dir)["canonical_facts"] == []


def test_mission_control_queries_and_assesses_progress_at_pinned_cuts(
    tmp_path, monkeypatch
):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    _import_atlas(runtime_dir, repo)

    definition = mission_control.build_state_query(
        str(runtime_dir), mission_id="mission-a"
    )
    assert definition["object"] == "fact-state"
    assert definition["subject_keys"] == ["atlas:goal-a", "atlas:mission-a"]
    assert definition["basis"]["scope"] == "domain-fact-ledger"

    first_state = mission_control.query_state(str(runtime_dir), mission_id="mission-a")
    assert first_state["canonical_state"] is True
    assert first_state["query_definition_root"].startswith("sha256:")
    assert first_state["query_proof_root"].startswith("sha256:")
    assert first_state["mission"]["payload"]["record"]["mission_id"] == "mission-a"
    assert [row["payload"]["record"]["goal_id"] for row in first_state["goals"]] == [
        "goal-a"
    ]
    assert first_state["lineage"]["conflicts"] == []
    assert len(first_state["lineage"]["episode_content_roots"]) == 2

    episodes_before_home = storage_service.episode_list(runtime_dir)["episodes"]
    mission_home = mission_control.query_mission_home(
        str(runtime_dir), mission_id="mission-a"
    )
    public_mission_home = profile_sdk.invoke_member_adapter(
        MISSION_PROFILE_SOURCE,
        runtime_dir,
        "mission-control-actions",
        "mission-home",
        {"missionId": "mission-a", "source": "atlas"},
    )["result"]
    episodes_after_home = storage_service.episode_list(runtime_dir)["episodes"]
    assert mission_home["schema"] == "kungfu.mission-control.mission-home/v1"
    assert mission_home["mode"] == "read-only"
    assert mission_home["query_definition_root"] == first_state["query_definition_root"]
    assert mission_home["query_proof_root"] == first_state["query_proof_root"]
    assert (
        mission_home["query_profile"]["query_definition_root"]
        == (mission_home["query_definition_root"])
    )
    assert (
        mission_home["query_profile"]["query_proof_root"]
        == (mission_home["query_proof_root"])
    )
    assert len(mission_home["query_profile"]["answers"]) == 5
    assert public_mission_home == mission_home
    assert episodes_after_home == episodes_before_home

    rewind_reporting.begin_run(
        str(runtime_dir),
        run_id="goal-a-run",
        provider="codex",
        cwd=None,
        work_id="goal-a",
    )
    rewind_reporting.report_cost(
        str(runtime_dir),
        run_id="goal-a-run",
        provider="codex",
        surface="exec-json",
        source="codex-exec-json",
        attribution="exact_run",
        work_id="goal-a",
        model="test-model",
        input_tokens=120,
        output_tokens=30,
    )
    rewind_reporting.end_run(
        str(runtime_dir),
        run_id="goal-a-run",
        status="succeeded",
        exit_code=0,
    )
    rewind_episodes = [
        row
        for row in storage_service.episode_list(runtime_dir)["episodes"]
        if row["open"]["source"] == "rewind:goal-a-run"
    ]
    assert len(rewind_episodes) == 1
    assert rewind_episodes[0]["unique_frame_count"] == 3
    assert rewind_episodes[0]["root"]["root_value"]
    first_report = mission_control.assess_progress(
        str(runtime_dir), mission_id="mission-a"
    )
    assert first_report["fitness"] == "fit"
    assert first_report["assessment"]["state"] == "fresh"
    assert first_report["assessment"]["report"]["purpose"] == "operator-review"
    assert (
        first_report["assessment"]["report"]["query_proof_root"]
        == first_state["query_proof_root"]
    )
    profile = first_report["profile"]
    assert profile["schema"] == ("kungfu.profile.delegated-work-cost-state-proof/v1")
    assert profile["profile_hash"].startswith("sha256:")
    assert profile["state"]["value"] == "active"
    assert profile["cost"]["status"] == "partial"
    assert profile["cost"]["observation_count"] == 1
    assert profile["cost"]["tokens"]["input_tokens"] == 120
    assert profile["cost"]["tokens"]["output_tokens"] == 30
    assert profile["cost"]["cost_usd"] is None
    assert profile["cost"]["cost_usd_known"] is False
    assert profile["cost"]["attribution"] == {
        "best": "exact-run",
        "worst": "exact-run",
        "ambiguous": False,
    }
    assert profile["cost"]["proof_episodes"], profile["cost"]
    assert profile["cost"]["proof_episodes"][0]["run_id"] == "goal-a-run"
    assert profile["cost"]["proof_episodes"][0]["episode_root"].startswith("sha256:")
    assert profile["proof"]["query_proof_root"] == first_state["query_proof_root"]
    assert profile["proof"]["assessment_report_hash"] == first_report["report_hash"]
    query_profile = first_report["query_profile"]
    assert query_profile["schema"] == "kungfu.mission-control.query-profile/v1"
    assert query_profile["profile"]["reducer"] == (
        "kungfu.mission-control.five-questions"
    )
    assert (
        query_profile["profile"]["profile_suite_root"]
        == first_state["profile_suite_root"]
    )
    assert query_profile["profile"]["catalog_root"] == first_state["catalog_root"]
    assert len(query_profile["views"]) == 6
    assert len(query_profile["answers"]) == 5
    assert {view["view"]["kind"] for view in query_profile["views"]} == {
        "table",
        "timeline",
        "diff",
        "causal-graph",
        "attention",
        "profile",
    }
    next_answer = next(
        answer
        for answer in query_profile["answers"]
        if answer["question_id"] == "next-responsibility"
    )
    assert next_answer["status"] == "declared"
    assert next_answer["data"]["declared_actions"][0]["action"] == "implement"
    assert next_answer["data"]["declared_actions"][0]["source"] == ("go.next_action")
    assert "Continue under" not in next_answer["summary"]
    catalog = storage_service.saved_query_catalog(runtime_dir)
    assert catalog["entries"] == []
    repeated = mission_control.assess_progress(str(runtime_dir), mission_id="mission-a")
    assert repeated["assessment_key"] == first_report["assessment_key"]
    assert repeated["assessment"]["reused"] is True
    assert (
        repeated["query_profile"]["profile"]["profile_suite_root"]
        == (query_profile["profile"]["profile_suite_root"])
    )

    from click.testing import CliRunner
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    runner = CliRunner(mix_stderr=False)
    config_home = tmp_path / "config"
    _admit_profile_runtime(monkeypatch, runtime_dir, config_home)
    cli = runner.invoke(
        kfc,
        ["atlas", "assess-mission", "mission-a", "--json"],
        env={
            "KF_RUNTIME_DIR": str(runtime_dir),
            "KF_CONFIG_HOME": str(config_home),
        },
    )
    assert cli.exit_code == 0, cli.output
    cli_report = json.loads(cli.output)
    assert cli_report["fitness"] == "fit"
    assert cli_report["assessment_key"] == first_report["assessment_key"]

    dashboard_cli = runner.invoke(
        kfc,
        ["atlas", "show", "dashboard", "--json"],
        env={"KF_RUNTIME_DIR": str(runtime_dir)},
    )
    assert dashboard_cli.exit_code == 0, dashboard_cli.output
    dashboard = json.loads(dashboard_cli.output)
    assert dashboard["schema"] == "kungfu.mission-control.dashboard-snapshot/v1"
    assert dashboard["cut"]["kind"] == "system_time"
    assert dashboard["freshness"] == {
        "basis": "request-cut",
        "status": "fresh",
    }
    assert [row["mission_id"] for row in dashboard["missions"]] == ["mission-a"]
    assert [row["goal_id"] for row in dashboard["goals"]] == ["goal-a"]

    historical_cut = int(first_state["cut"]["resolved"]["system_time"])
    goal_path = repo / "agent-journal/goals/registry/active/goal-a.json"
    changed = json.loads(goal_path.read_text(encoding="utf-8"))
    changed["status"] = "blocked"
    changed["updated_at"] = "2026-07-09T00:00:00Z"
    _write_json(goal_path, changed)
    _import_atlas(runtime_dir, repo)

    current_report = mission_control.assess_progress(
        str(runtime_dir), mission_id="mission-a"
    )
    assert current_report["fitness"] == "warning"
    assert current_report["assessment_key"] != first_report["assessment_key"]
    historical_report = mission_control.assess_progress(
        str(runtime_dir),
        mission_id="mission-a",
        cut_system_time=historical_cut,
    )
    assert historical_report["fitness"] == "fit"
    assert (
        historical_report["state"]["goals"][0]["payload"]["record"]["status"]
        == "active"
    )
    assert historical_report["profile"]["cost"]["status"] == "missing"
    assert historical_report["profile"]["cost"]["observation_count"] == 0


def test_mission_control_native_go_completion_claim_fails_closed_then_passes(
    tmp_path,
    monkeypatch,
):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    _import_atlas(runtime_dir, repo)

    created = mission_control.create_go(
        str(runtime_dir),
        mission_id="mission-a",
        goal_id="native-go",
        title="Native Go",
        objective="Prove the Mission Control completion loop",
        actor="test-agent",
        actor_type="agent",
    )
    assert created["authority_mode"] == "kungfu-native"
    assert created["mission_subject"] == "atlas:mission-a"
    assert created["go_subject"] == "kungfu:native-go"
    assert created["receipt"]["status"] == "admitted"

    state = mission_control.query_state(str(runtime_dir), mission_id="mission-a")
    assert [row["payload"]["record"]["goal_id"] for row in state["goals"]] == [
        "goal-a",
        "native-go",
    ]

    no_evidence = mission_control.claim_completion(
        str(runtime_dir),
        mission_id="mission-a",
        goal_id="native-go",
        statement="The loop is implemented",
        actor="test-agent",
        actor_type="agent",
    )
    assert no_evidence["claim"]["evidence_episodes"] == []
    insufficient = mission_control.assess_completion(
        str(runtime_dir), mission_id="mission-a", goal_id="native-go"
    )
    assert insufficient["fitness"] == "insufficient"
    assert insufficient["assessment"]["state"] in {
        "insufficient-evidence",
        "unverifiable",
    }
    assert insufficient["profile"]["state"]["value"] == "claimed-complete"

    rewind_reporting.begin_run(
        str(runtime_dir),
        run_id="native-go-run",
        provider="codex",
        cwd=None,
        work_id="native-go",
    )
    rewind_reporting.report_cost(
        str(runtime_dir),
        run_id="native-go-run",
        provider="codex",
        surface="exec-json",
        source="codex-exec-json",
        attribution="exact_run",
        work_id="native-go",
        input_tokens=80,
        output_tokens=20,
        cost_usd=0.25,
    )
    rewind_reporting.end_run(
        str(runtime_dir),
        run_id="native-go-run",
        status="succeeded",
        exit_code=0,
    )
    work_episode = next(
        row
        for row in storage_service.episode_list(runtime_dir)["episodes"]
        if row["open"]["source"] == "rewind:native-go-run"
    )
    claimed = mission_control.claim_completion(
        str(runtime_dir),
        mission_id="mission-a",
        goal_id="native-go",
        statement="The loop is implemented with sealed work evidence",
        actor="test-agent",
        actor_type="agent",
        evidence_episode_ids=[int(work_episode["episode_id"])],
    )
    assert len(claimed["claim"]["evidence_episodes"]) == 1
    assert claimed["claim"]["evidence_episodes"][0]["episode_root"].startswith(
        "sha256:"
    )

    completed = mission_control.assess_completion(
        str(runtime_dir), mission_id="mission-a", goal_id="native-go"
    )
    assert completed["fitness"] == "fit"
    assert completed["assessment"]["state"] == "fresh"
    assert completed["claim"]["type"] == "task-completed"
    assert len(completed["composite_proof"]["verified_evidence"]) == 1
    assert completed["profile"]["cost"]["status"] == "attributed", completed["profile"][
        "cost"
    ]
    assert completed["profile"]["cost"]["cost_usd"] == 0.25
    assert completed["profile"]["cost"]["tokens"]["input_tokens"] == 80
    assert completed["query_proof_root"].startswith("sha256:")
    assert (
        completed["assessment"]["report"]["query_proof_root"]
        == completed["query_proof_root"]
    )

    from click.testing import CliRunner
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    runner = CliRunner(mix_stderr=False)
    config_home = tmp_path / "config"
    _admit_profile_runtime(monkeypatch, runtime_dir, config_home)
    cli_env = {
        "KF_RUNTIME_DIR": str(runtime_dir),
        "KF_CONFIG_HOME": str(config_home),
    }
    create_cli = runner.invoke(
        kfc,
        [
            "atlas",
            "create-go",
            "mission-a",
            "native-go",
            "--title",
            "Native Go",
            "--objective",
            "Prove the Mission Control completion loop",
            "--actor",
            "test-agent",
            "--json",
        ],
        env=cli_env,
    )
    assert create_cli.exit_code == 0, create_cli.output
    repeated_create = json.loads(create_cli.output)
    assert repeated_create["receipt"]["reused"] is True
    assert (
        repeated_create["receipt"]["payload_hash"] == created["receipt"]["payload_hash"]
    )
    assert repeated_create["receipt"]["episode_id"] == created["receipt"]["episode_id"]

    claim_cli = runner.invoke(
        kfc,
        [
            "atlas",
            "claim-completion",
            "mission-a",
            "native-go",
            "--statement",
            "The loop is implemented with sealed work evidence",
            "--actor",
            "test-agent",
            "--evidence-episode",
            str(work_episode["episode_id"]),
            "--json",
        ],
        env=cli_env,
    )
    assert claim_cli.exit_code == 0, claim_cli.output
    repeated_claim = json.loads(claim_cli.output)
    assert repeated_claim["receipt"]["reused"] is True
    assert (
        repeated_claim["receipt"]["payload_hash"] == claimed["receipt"]["payload_hash"]
    )
    assert repeated_claim["receipt"]["episode_id"] == claimed["receipt"]["episode_id"]

    cli = runner.invoke(
        kfc,
        [
            "atlas",
            "assess-completion",
            "mission-a",
            "native-go",
            "--json",
        ],
        env=cli_env,
    )
    assert cli.exit_code == 0, cli.output
    cli_report = json.loads(cli.output)
    assert cli_report["fitness"] == "fit"
    assert cli_report["assessment_key"] == completed["assessment_key"]

    workspace_identity_root = _sha256_root("atlas-cli-workspace")
    child_cli = runner.invoke(
        kfc,
        [
            "atlas",
            "create-go",
            "mission-a",
            "native-child-go",
            "--title",
            "Native Child Go",
            "--objective",
            "Prove exact local hierarchy identity plumbing",
            "--actor",
            "test-agent",
            "--parent-go",
            "native-go",
            "--owning-workspace-identity-root",
            workspace_identity_root,
            "--json",
        ],
        env=cli_env,
    )
    assert child_cli.exit_code == 0, child_cli.output
    child = json.loads(child_cli.output)
    assert child["go_subject"] == "kungfu:native-child-go"
    native_child = next(
        row["payload"]["record"]
        for row in mission_control.query_state(
            str(runtime_dir), mission_id="mission-a"
        )["goals"]
        if row["payload"]["record"]["goal_id"] == "native-child-go"
    )
    assert (
        native_child["parent_assignment_ref"]["workspace_identity_root"]
        == workspace_identity_root
    )


def test_tracked_completion_selects_claimed_cut_in_multi_cut_commit(
    tmp_path, monkeypatch
):
    commit = "1" * 40
    tree = "2" * 40
    acceptance_root = "sha256:" + "a" * 64
    atlas_root = "sha256:" + "b" * 64
    cut_root = "sha256:" + "c" * 64
    receipt_root = "sha256:" + "d" * 64
    episode_root = "sha256:" + "e" * 64
    selected_path = ".kungfu/project-cuts/sha256/cc/" + "c" * 64 + "/manifest.json"
    unrelated_path = ".kungfu/project-cuts/sha256/ff/" + "f" * 64 + "/manifest.json"

    def fake_run(argv, **_kwargs):
        if argv[0] == "git":
            revision = argv[-1]
            if revision == "--show-toplevel":
                stdout = str(tmp_path.resolve()) + "\n"
            elif revision == "HEAD^{commit}":
                stdout = commit + "\n"
            elif revision == f"{commit}^{{commit}}":
                stdout = commit + "\n"
            elif revision == f"{commit}^{{tree}}":
                stdout = tree + "\n"
            else:
                raise AssertionError(argv)
            return subprocess.CompletedProcess(argv, 0, stdout, "")
        assert argv[0] == "node"
        reconcile = {
            "ok": False,
            "cuts": [
                {
                    "path": unrelated_path,
                    "cutRoot": "sha256:" + "f" * 64,
                    "atlasRoot": "sha256:" + "9" * 64,
                    "receiptRoot": "sha256:" + "8" * 64,
                    "episodes": [],
                },
                {
                    "path": selected_path,
                    "cutRoot": cut_root,
                    "atlasRoot": atlas_root,
                    "receiptRoot": receipt_root,
                    "episodes": [{"semanticRoot": episode_root}],
                },
            ],
            "diagnostics": [
                {
                    "code": "source-drift",
                    "path": unrelated_path,
                    "detail": "unrelated leaf differs",
                }
            ],
        }
        return subprocess.CompletedProcess(argv, 1, json.dumps(reconcile), "")

    monkeypatch.setattr(mission_control.subprocess, "run", fake_run)
    state = {
        "goals": [
            {
                "subject_key": "kungfu:multi-cut-go",
                "payload": {
                    "record": {
                        "goal_id": "multi-cut-go",
                        "acceptance_root": acceptance_root,
                        "input_atlas_root": acceptance_root,
                        "project_cut_root": cut_root,
                    }
                },
            }
        ]
    }
    claim = {
        "git_commit": commit,
        "git_tree_root": mission_control._sha256_root(tree),
        "go_set": ["multi-cut-go"],
        "acceptance_root": acceptance_root,
        "input_atlas_root": acceptance_root,
        "result_atlas_root": atlas_root,
        "project_cut_root": cut_root,
        "project_cut_receipt_root": receipt_root,
        "evidence_episodes": [{"episode_root": episode_root}],
    }

    evidence = mission_control._tracked_completion_evidence(
        str(tmp_path), state, "multi-cut-go", claim
    )

    assert evidence["valid"] is True
    assert evidence["cut"]["cutRoot"] == cut_root
    assert evidence["diagnostics"] == []


def test_independent_completion_review_and_exact_continuation(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    catalog_before = storage_service.fact_type_list(runtime_dir)
    assert {row["id"] for row in catalog_before["fact_types"]} == {
        "kungfu.mission-control.mission",
        "kungfu.mission-control.go",
        "kungfu.mission-control.completion-claim",
    }
    mission_control.create_mission(
        str(runtime_dir),
        mission_id="review-mission",
        title="Review Mission",
        intent="Prove chat-free independent review and continuation",
        actor="mission-owner",
        actor_type="user",
    )
    mission_control.create_go(
        str(runtime_dir),
        mission_id="review-mission",
        goal_id="reviewed-go",
        title="Reviewed Go",
        objective="Produce one root-bound completion claim",
        actor="agent-a",
    )
    rewind_reporting.begin_run(
        str(runtime_dir),
        run_id="reviewed-go-run",
        provider="codex",
        cwd=None,
        work_id="reviewed-go",
    )
    rewind_reporting.end_run(
        str(runtime_dir),
        run_id="reviewed-go-run",
        status="succeeded",
        exit_code=0,
    )
    work_episode = next(
        row
        for row in storage_service.episode_list(runtime_dir)["episodes"]
        if row["open"]["source"] == "rewind:reviewed-go-run"
    )
    root_a = "sha256:" + "a" * 64
    root_b = "sha256:" + "b" * 64
    claimed = mission_control.claim_completion(
        str(runtime_dir),
        mission_id="review-mission",
        goal_id="reviewed-go",
        statement="The exact cut is ready for independent review",
        actor="agent-a",
        evidence_episode_ids=[int(work_episode["episode_id"])],
        go_set=["reviewed-go"],
        acceptance_root=root_a,
        input_atlas_root=root_a,
        result_atlas_root=root_b,
        project_cut_root=root_b,
        git_commit="1" * 40,
        git_tree_root=root_a,
        proof_roots=[root_b],
        known_gaps=["full replay evidence is not retained in the thin shadow"],
        evidence_availability=[
            {
                "acceptance": "source and root inspection",
                "level": "thin",
                "state": "available",
            },
            {
                "acceptance": "raw replay",
                "level": "full",
                "state": "unavailable",
            },
        ],
    )
    assert claimed["claim"]["project_cut_root"] == root_b
    assert claimed["claim"]["git_commit"] == "1" * 40

    with pytest.raises(ValueError, match="identity must differ"):
        mission_control.review_completion(
            str(runtime_dir),
            mission_id="review-mission",
            goal_id="reviewed-go",
            reviewer="agent-a",
            reviewer_source="new-session-a",
        )

    review = mission_control.review_completion(
        str(runtime_dir),
        mission_id="review-mission",
        goal_id="reviewed-go",
        reviewer="agent-b",
        reviewer_source="new-session-b",
        proposed_followups=[
            {
                "goal_id": "obtain-full-evidence",
                "title": "Obtain full evidence",
                "objective": "Fetch the exact raw replay material",
                "why_created": "The independent review found a bounded full-evidence gap",
                "depends_on": ["reviewed-go"],
                "acceptance_root": root_b,
            }
        ],
    )
    assert review["review"]["verdict"] == "partial"
    assert review["review"]["reviewer"] == "agent-b"
    assert review["review_root"].startswith("sha256:")
    assert review["continuation_plan_root"].startswith("sha256:")
    assert review["receipt"]["episode_id"]
    assert review["review"]["continuation_plan"]["evidence_requests"] == [
        {
            "acceptance": "raw replay",
            "level": "full",
            "state": "unavailable",
            "action": "request-evidence",
            "command": "./shifu workspace request-full-evidence <checkout> --json",
        }
    ]

    with pytest.raises(ValueError, match="review changed"):
        mission_control.decide_continuation(
            str(runtime_dir),
            mission_id="review-mission",
            goal_id="reviewed-go",
            review_id=review["review"]["review_id"],
            expected_review_root=root_a,
            expected_plan_root=review["continuation_plan_root"],
            action="create-follow-up",
            actor="agent-c",
            reason="continue the bounded evidence gap",
        )
    with pytest.raises(ValueError, match="human-decision-required"):
        mission_control.decide_continuation(
            str(runtime_dir),
            mission_id="review-mission",
            goal_id="reviewed-go",
            review_id=review["review"]["review_id"],
            expected_review_root=review["review_root"],
            expected_plan_root=review["continuation_plan_root"],
            action="create-follow-up",
            actor="agent-c",
            change_class="mission",
            reason="attempt to change the Mission",
        )
    decision = mission_control.decide_continuation(
        str(runtime_dir),
        mission_id="review-mission",
        goal_id="reviewed-go",
        review_id=review["review"]["review_id"],
        expected_review_root=review["review_root"],
        expected_plan_root=review["continuation_plan_root"],
        action="create-follow-up",
        actor="agent-c",
        reason="continue the bounded evidence gap",
    )
    assert decision["decision"]["action"] == "create-follow-up"
    assert [row["go_subject"] for row in decision["created_followups"]] == [
        "kungfu:obtain-full-evidence"
    ]
    state = mission_control.query_state(str(runtime_dir), mission_id="review-mission")
    assert len(state["claims"]) == 1
    assert len(state["reviews"]) == 2
    assert {row["fact_surface_id"] for row in state["reviews"]} == {
        "kungfu.mission-control.completion-claim"
    }
    assert any(
        row["payload"]["record"].get("goal_id") == "obtain-full-evidence"
        for row in state["goals"]
    )


def test_tracked_empty_delta_closes_only_the_episode_gap():
    report = {
        "fitness": "insufficient",
        "composite_proof": {"verified_evidence": [], "invalid_evidence": []},
        "assessment": {
            "state": "unverifiable",
            "report": {
                "state": "unverifiable",
                "evidence": {
                    "conflict_count": 0,
                    "unregistered_surface_count": 0,
                    "incompatible_schema_count": 0,
                    "ambiguous_authority_count": 0,
                    "unverifiable_count": 1,
                },
            },
        },
    }
    claim = {
        "evidence_episodes": [],
        "evidence_availability": [],
        "known_gaps": [],
    }
    tracked = {"valid": True, "cut": {"episodes": []}}

    assert mission_control._tracked_empty_delta_closes_episode_gap(
        report, claim, tracked
    )
    assert not mission_control._tracked_empty_delta_closes_episode_gap(
        report, claim, {**tracked, "valid": False}
    )
    assert not mission_control._tracked_empty_delta_closes_episode_gap(
        report, claim, {"valid": True, "cut": {"episodes": [{}]}}
    )
    assert not mission_control._tracked_empty_delta_closes_episode_gap(
        {**report, "composite_proof": {"invalid_evidence": [{}]}}, claim, tracked
    )
    assert not mission_control._tracked_empty_delta_closes_episode_gap(
        report, {**claim, "known_gaps": ["unclosed gap"]}, tracked
    )
    for state in ("conflicted", "stale"):
        conflicting_assessment = {
            **report["assessment"],
            "state": state,
            "report": {**report["assessment"]["report"], "state": state},
        }
        assert not mission_control._tracked_empty_delta_closes_episode_gap(
            {**report, "assessment": conflicting_assessment}, claim, tracked
        )
    for field in (
        "conflict_count",
        "unregistered_surface_count",
        "incompatible_schema_count",
        "ambiguous_authority_count",
    ):
        conflicting_evidence = {
            **report["assessment"]["report"]["evidence"],
            field: 1,
        }
        assert not mission_control._tracked_empty_delta_closes_episode_gap(
            {
                **report,
                "assessment": {
                    **report["assessment"],
                    "report": {
                        **report["assessment"]["report"],
                        "evidence": conflicting_evidence,
                    },
                },
            },
            claim,
            tracked,
        )
    extra_unverifiable = {
        **report["assessment"]["report"]["evidence"],
        "unverifiable_count": 2,
    }
    assert not mission_control._tracked_empty_delta_closes_episode_gap(
        {
            **report,
            "assessment": {
                **report["assessment"],
                "report": {
                    **report["assessment"]["report"],
                    "evidence": extra_unverifiable,
                },
            },
        },
        claim,
        tracked,
    )
    for state in ("unavailable", "missing"):
        assert not mission_control._tracked_empty_delta_closes_episode_gap(
            report,
            {
                **claim,
                "evidence_availability": [
                    {"acceptance": "exact proof", "level": "full", "state": state}
                ],
            },
            tracked,
        )


def test_tracked_completion_evidence_rejects_fault_campaign(tmp_path, monkeypatch):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    subprocess.run(["git", "init", "-q", checkout], check=True)
    subprocess.run(
        ["git", "-C", checkout, "config", "user.name", "Review Test"], check=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            checkout,
            "config",
            "user.email",
            "review@example.invalid",
        ],
        check=True,
    )
    (checkout / "work.txt").write_text("qualified\n", encoding="utf-8")
    subprocess.run(["git", "-C", checkout, "add", "work.txt"], check=True)
    subprocess.run(
        ["git", "-C", checkout, "commit", "-qm", "test: qualified cut"],
        check=True,
    )
    commit = subprocess.run(
        ["git", "-C", checkout, "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    tree_oid = subprocess.run(
        ["git", "-C", checkout, "rev-parse", "HEAD^{tree}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    acceptance = _sha256_root("acceptance")
    input_atlas = _sha256_root("input-atlas")
    result_atlas = _sha256_root("result-atlas")
    cut_root = _sha256_root("project-cut")
    receipt_root = _sha256_root("cut-receipt")
    episode_root = _sha256_root("episode")
    state = {
        "goals": [
            {
                "subject_key": "kungfu:parent-go",
                "payload": {
                    "record": {
                        "goal_id": "parent-go",
                        "acceptance_root": acceptance,
                        "input_atlas_root": input_atlas,
                        "project_cut_root": cut_root,
                        "parent_goal_id": "",
                    }
                },
            },
            {
                "subject_key": "kungfu:child-go",
                "payload": {
                    "record": {
                        "goal_id": "child-go",
                        "parent_goal_id": "parent-go",
                    }
                },
            },
        ]
    }
    claim = {
        "git_commit": commit,
        "git_tree_root": mission_control._sha256_root(tree_oid),
        "go_set": ["child-go", "parent-go"],
        "acceptance_root": acceptance,
        "input_atlas_root": input_atlas,
        "result_atlas_root": result_atlas,
        "project_cut_root": cut_root,
        "project_cut_receipt_root": receipt_root,
        "evidence_episodes": [{"episode_id": "7", "episode_root": episode_root}],
    }
    reconcile = {
        "ok": True,
        "diagnostics": [],
        "cuts": [
            {
                "cutRoot": cut_root,
                "atlasRoot": result_atlas,
                "receiptRoot": receipt_root,
                "episodes": [{"semanticRoot": episode_root}],
            }
        ],
    }
    real_run = subprocess.run

    def fake_run(args, **kwargs):
        if args[0] == "node":
            return subprocess.CompletedProcess(args, 0, json.dumps(reconcile), "")
        return real_run(args, **kwargs)

    monkeypatch.setattr(mission_control.subprocess, "run", fake_run)
    valid = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", claim
    )
    assert valid["valid"] is True
    assert valid["evidence_root"].startswith("sha256:")

    state["goals"][1]["payload"]["record"] = {
        "goal_id": "child-go",
        "parent_goal_id": "",
        "parent_assignment_ref": {
            "schema": "kungfu.assignment-graph.work-ref/v1",
            "workspace_identity_root": _sha256_root("workspace"),
            "object_kind": "assignment",
            "subject": "kungfu:parent-go",
            "version_root": _sha256_root("parent-version"),
            "cut_root": _sha256_root("workspace-cut"),
        },
    }
    valid_work_ref_parent = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", claim
    )
    assert valid_work_ref_parent["valid"] is True

    reconcile["cuts"][0]["episodes"] = []
    episodeless_claim = {**claim, "evidence_episodes": []}
    valid_empty_delta = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", episodeless_claim
    )
    assert valid_empty_delta["valid"] is True
    assert valid_empty_delta["cut"]["episodes"] == []
    reconcile["cuts"][0]["episodes"] = [{"semanticRoot": episode_root}]
    missing_claim_episode = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", episodeless_claim
    )
    assert missing_claim_episode["valid"] is False
    assert "missing-episode" in {
        row["code"] for row in missing_claim_episode["diagnostics"]
    }

    reconcile["cuts"].append(
        {
            "cutRoot": _sha256_root("parent-project-cut"),
            "atlasRoot": _sha256_root("parent-atlas"),
            "receiptRoot": _sha256_root("parent-cut-receipt"),
            "episodes": [],
        }
    )
    valid_with_history = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", claim
    )
    assert valid_with_history["valid"] is True
    assert valid_with_history["cut"]["cutRoot"] == cut_root

    parent_root = reconcile["cuts"][1]["cutRoot"]
    parent_digest = parent_root.removeprefix("sha256:")
    reconcile.update(
        {
            "ok": False,
            "diagnostics": [
                {
                    "code": "source-drift",
                    "path": (
                        f".kungfu/project-cuts/sha256/{parent_digest[:2]}/"
                        f"{parent_digest}/manifest.json"
                    ),
                    "detail": "retained parent Cut differs from the current source",
                }
            ],
        }
    )
    valid_with_stale_history = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", claim
    )
    assert valid_with_stale_history["valid"] is True

    claimed_digest = cut_root.removeprefix("sha256:")
    reconcile["diagnostics"][0]["path"] = (
        f".kungfu/project-cuts/sha256/{claimed_digest[:2]}/"
        f"{claimed_digest}/manifest.json"
    )
    invalid_claimed_cut = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", claim
    )
    assert invalid_claimed_cut["valid"] is False
    assert "source-drift" in {row["code"] for row in invalid_claimed_cut["diagnostics"]}
    reconcile.update({"ok": True, "diagnostics": []})

    cases = {
        "missing-episode": {"episodes": []},
        "stale-atlas": {"atlasRoot": _sha256_root("stale-atlas")},
        "receipt-cut-mismatch": {"receiptRoot": _sha256_root("wrong-receipt")},
    }
    for code, cut_patch in cases.items():
        reconcile["cuts"][0].update(cut_patch)
        rejected = mission_control._tracked_completion_evidence(
            str(checkout), state, "parent-go", claim
        )
        assert rejected["valid"] is False
        assert code in {row["code"] for row in rejected["diagnostics"]}
        reconcile["cuts"][0] = {
            "cutRoot": cut_root,
            "atlasRoot": result_atlas,
            "receiptRoot": receipt_root,
            "episodes": [{"semanticRoot": episode_root}],
        }

    incomplete = {**claim, "go_set": ["parent-go"]}
    rejected = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", incomplete
    )
    assert "incomplete-parent-acceptance" in {
        row["code"] for row in rejected["diagnostics"]
    }

    forged = {**claim, "project_cut_root": _sha256_root("forged-cut")}
    rejected = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", forged
    )
    assert "project-cut-root-mismatch" in {
        row["code"] for row in rejected["diagnostics"]
    }

    (checkout / "work.txt").write_text("drifted\n", encoding="utf-8")
    subprocess.run(["git", "-C", checkout, "add", "work.txt"], check=True)
    subprocess.run(
        ["git", "-C", checkout, "commit", "-qm", "test: post-claim drift"],
        check=True,
    )
    rejected = mission_control._tracked_completion_evidence(
        str(checkout), state, "parent-go", claim
    )
    assert "post-claim-source-drift" in {row["code"] for row in rejected["diagnostics"]}


def test_native_only_workspace_keeps_optional_atlas_projection_stdout_clean(
    tmp_path, capfd
):
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    mission_control.create_mission(
        str(runtime_dir),
        mission_id="native-only",
        title="Native only",
        intent="Keep JSON output machine-readable without an Atlas import",
        actor="test-user",
        actor_type="user",
    )

    assert atlas_store.load(str(runtime_dir)) is None
    captured = capfd.readouterr()
    assert captured.out == ""


def test_native_mission_full_bundle_roundtrip_and_thin_degraded_import(tmp_path):
    source = tmp_path / "source-runtime"
    destination = tmp_path / "destination-runtime"
    thin_destination = tmp_path / "thin-destination-runtime"
    inactive_destination = tmp_path / "inactive-destination-runtime"
    _activate_mission_profile(source)
    _activate_mission_profile(destination, materialize=False)
    _activate_mission_profile(thin_destination, materialize=False)

    created = mission_control.create_mission(
        str(source),
        mission_id="native-mission",
        title="Native Mission",
        intent="Preserve a long-running purpose with proof",
        actor="test-user",
        actor_type="user",
    )
    assert created["mission_subject"] == "kungfu:native-mission"
    assert mission_control.list_missions(str(source))[0]["authority_mode"] == (
        "kungfu-native"
    )
    mission_control.create_go(
        str(source),
        mission_id="native-mission",
        goal_id="portable-go",
        title="Portable Go",
        objective="Prove full and thin Mission transfer",
        actor="test-agent",
        actor_type="agent",
    )
    rewind_reporting.begin_run(
        str(source),
        run_id="portable-go-run",
        provider="codex",
        cwd=None,
        work_id="portable-go",
    )
    rewind_reporting.report_cost(
        str(source),
        run_id="portable-go-run",
        provider="codex",
        surface="exec-json",
        source="test",
        attribution="exact_run",
        work_id="portable-go",
        input_tokens=40,
        output_tokens=10,
        cost_usd=0.1,
    )
    rewind_reporting.end_run(
        str(source), run_id="portable-go-run", status="succeeded", exit_code=0
    )
    evidence = next(
        row
        for row in storage_service.episode_list(source, limit=0)["episodes"]
        if row["open"]["source"] == "rewind:portable-go-run"
    )
    mission_control.claim_completion(
        str(source),
        mission_id="native-mission",
        goal_id="portable-go",
        statement="The portable Mission loop is complete",
        actor="test-agent",
        actor_type="agent",
        evidence_episode_ids=[int(evidence["episode_id"])],
    )
    source_report = mission_control.assess_completion(
        str(source), mission_id="native-mission", goal_id="portable-go"
    )
    assert source_report["fitness"] == "fit"

    full = mission_bundle.build_mission_bundle(
        str(source), mission_id="native-mission", mode="full"
    )
    thin = mission_bundle.build_mission_bundle(
        str(source), mission_id="native-mission", mode="thin"
    )
    assert full["status"] == "portable", full["closure"]
    assert full["schema"] == "kungfu.mission-control.bundle/v2"
    assert full["profile"]["id"] == "kungfu.mission-control"
    assert full["profile"]["version"] == "3.1.0"
    assert full["profile"]["suite_root"].startswith("sha256:")
    assert full["profile"]["catalog_root"].startswith("sha256:")
    assert set(full["profile"]["member_roots"]) == {
        "mission-control-actions",
        "mission-control-assessment",
        "mission-control-contract",
        "mission-control-views",
        "work-dashboard",
    }
    assert set(full["profile"]["policy_roots"]) == {
        "mission-progress-policy",
        "task-completion-policy",
    }
    assert full["profile"]["query_receipt_root"].startswith("sha256:")
    assert full["closure"]["full_closure"] is True
    assert full["closure"]["source_provenance_included"] is False
    assert thin["status"] == "degraded"
    assert thin["closure"]["full_closure"] is False
    assert all(not row["self_contained"] for row in thin["episodes"])

    with pytest.raises(profile_sdk.ProfileSdkError) as inactive:
        mission_bundle.import_mission_bundle(
            str(inactive_destination), full, execute=True
        )
    assert inactive.value.diagnosis["code"] == "profile-not-active"
    assert (
        storage_service.profile_lifecycle(
            inactive_destination, "list", include_removed=True
        )["profiles"]
        == []
    )

    imported = mission_bundle.import_mission_bundle(
        str(destination), full, execute=True
    )
    assert imported["status"] == "imported", imported
    assert imported["accepted"] is True
    assert imported["profile_verification"]["ok"] is True
    assert imported["state_verification"]["ok"] is True
    assert mission_control.list_missions(str(destination))[0]["mission_id"] == (
        "native-mission"
    )
    destination_report = mission_control.assess_completion(
        str(destination), mission_id="native-mission", goal_id="portable-go"
    )
    assert destination_report["fitness"] == "fit"
    assert destination_report["profile"]["cost"]["cost_usd"] == 0.1
    assert destination_report["profile"]["cost"]["tokens"]["input_tokens"] == 40

    degraded = mission_bundle.import_mission_bundle(
        str(thin_destination), thin, execute=True
    )
    assert degraded["status"] == "degraded"
    assert degraded["accepted"] is False
    assert degraded["materialized"] is False
    assert "require a full bundle" in degraded["diagnosis"]
    assert mission_control.list_missions(str(thin_destination)) == []

    tampered = json.loads(json.dumps(full))
    tampered["mission_id"] = "tampered"
    with pytest.raises(ValueError, match="bundle root mismatch"):
        mission_bundle.import_mission_bundle(str(tmp_path / "tampered"), tampered)

    from click.testing import CliRunner
    from kungfu.cli.commands import __registry__  # noqa: F401
    from kungfu.cli.commands import kfc

    bundle_path = tmp_path / "native-mission.kfmission.json"
    runner = CliRunner(mix_stderr=False)
    create_cli = runner.invoke(
        kfc,
        [
            "atlas",
            "create-mission",
            "native-mission",
            "--title",
            "Native Mission",
            "--intent",
            "Preserve a long-running purpose with proof",
            "--actor",
            "test-user",
            "--actor-type",
            "user",
            "--json",
        ],
        env={"KF_RUNTIME_DIR": str(source)},
    )
    assert create_cli.exit_code == 0, create_cli.output
    assert json.loads(create_cli.output)["receipt"]["reused"] is True
    exported = runner.invoke(
        kfc,
        [
            "atlas",
            "export-mission",
            "native-mission",
            "--out",
            str(bundle_path),
            "--mode",
            "full",
            "--json",
        ],
        env={"KF_RUNTIME_DIR": str(source)},
    )
    assert exported.exit_code == 0, exported.output
    assert json.loads(exported.output)["status"] == "portable"
    listed = runner.invoke(
        kfc,
        ["atlas", "show", "missions", "--json"],
        env={"KF_RUNTIME_DIR": str(source)},
    )
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)[0]["mission_id"] == "native-mission"


def test_mission_control_batches_large_mission_state_queries(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    for index in range(260):
        _write_json(
            repo / f"agent-journal/goals/registry/active/large-go-{index:03d}.json",
            {
                "goal_id": f"large-go-{index:03d}",
                "status": "active",
                "updated_at": "2026-07-08T01:00:00Z",
                "title": f"Large Go {index:03d}",
                "mission_id": "mission-a",
                "next_action": "keep the query bounded",
            },
        )
    _import_atlas(runtime_dir, repo)

    state = mission_control.query_state(str(runtime_dir), mission_id="mission-a")

    assert len(state["goals"]) == 261
    assert state["canonical_state"] is True
    assert state["definition"]["schema"] == (
        "kungfu.mission-control.batched-state-query/v1"
    )
    assert state["logical_plan"] == {
        "engine": "mission-control-batched-fact-state/v1",
        "batch_size": 256,
        "subquery_count": 2,
    }
    assert len(state["lineage"]["subqueries"]) == 2
    assert state["profile_query_receipt"]["result"]["row_count"] == 262
    assert state["query_proof_root"].startswith("sha256:")


def test_initiative_assignment_reads_legacy_sealed_identity_without_rewrite(tmp_path):
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    storage_service.fact_declare_contract_world(
        runtime_dir,
        {
            "id": mission_control.LEGACY_CONTRACT_WORLD_ID,
            "version": mission_control.LEGACY_CONTRACT_VERSION,
            "effective_from": 100,
            "effective_until": 0,
            "fact_surface_ids": [
                mission_control.LEGACY_MISSION_SURFACE_ID,
                mission_control.LEGACY_GO_SURFACE_ID,
            ],
        },
        system_time=100,
    )
    for surface_id in (
        mission_control.LEGACY_MISSION_SURFACE_ID,
        mission_control.LEGACY_GO_SURFACE_ID,
    ):
        storage_service.fact_type_create(
            runtime_dir,
            {
                "id": surface_id,
                "version": mission_control.LEGACY_CONTRACT_VERSION,
                "contract_world_id": mission_control.LEGACY_CONTRACT_WORLD_ID,
                "effective_from": 100,
                "effective_until": 0,
                "source_authorities": [mission_control.ATLAS_FACT_SOURCE_ID],
                "schema": {
                    "type": "object",
                    "properties": {
                        "record": {"type": "object"},
                        "source": {"type": "object"},
                        "links": {"type": "object"},
                    },
                    "required": ["record", "source", "links"],
                    "additionalProperties": False,
                },
            },
            system_time=101,
        )
    legacy_payloads = (
        (
            mission_control.LEGACY_MISSION_SURFACE_ID,
            "legacy:initiative-a",
            "legacy-mission-observation",
            {
                "record": {"mission_id": "initiative-a", "title": "Legacy"},
                "source": {
                    "authority_mode": "atlas-bridge",
                    "source_id": mission_control.ATLAS_FACT_SOURCE_ID,
                    "source_time": "2026-01-01T00:00:00Z",
                    "payload_hash": "sha256:" + "1" * 64,
                },
                "links": {"mission_id": "legacy:initiative-a"},
            },
        ),
        (
            mission_control.LEGACY_GO_SURFACE_ID,
            "legacy:assignment-a",
            "legacy-go-observation",
            {
                "record": {
                    "goal_id": "assignment-a",
                    "mission_id": "initiative-a",
                    "title": "Legacy assignment",
                },
                "source": {
                    "authority_mode": "atlas-bridge",
                    "source_id": mission_control.ATLAS_FACT_SOURCE_ID,
                    "source_time": "2026-01-01T00:00:01Z",
                    "payload_hash": "sha256:" + "2" * 64,
                },
                "links": {"mission_id": "legacy:initiative-a"},
            },
        ),
    )
    for index, (surface_id, subject_key, observation_id, payload) in enumerate(
        legacy_payloads, start=110
    ):
        storage_service.fact_material_put(
            runtime_dir,
            {
                "type_id": surface_id,
                "type_version": mission_control.LEGACY_CONTRACT_VERSION,
                "source_id": mission_control.ATLAS_FACT_SOURCE_ID,
                "subject_key": subject_key,
                "payload": payload,
                "observation_id": observation_id,
                "action": "assert",
                "valid_from": index,
                "valid_until": 0,
            },
            system_time=index,
        )

    before = storage_service.fact_material_list(runtime_dir)
    before_rows = {
        row["observation_id"]: {
            key: row[key]
            for key in (
                "fact_surface_id",
                "observation_id",
                "payload_hash",
                "schema_owner_root",
                "source_id",
                "subject_key",
            )
        }
        for row in before["state"]["canonical_facts"]
        if row["fact_surface_id"].startswith("kungfu.mission-control.")
    }
    initiatives = mission_control.list_initiatives(str(runtime_dir))
    assignments = mission_control.list_assignments(str(runtime_dir))
    after = storage_service.fact_material_list(runtime_dir)

    assert initiatives[0]["initiative_id"] == "initiative-a"
    assert assignments[0]["assignment_id"] == "assignment-a"
    assert initiatives[0]["sealed_identity"] == {
        "contract_world_id": "kungfu.mission-control",
        "fact_surface_id": "kungfu.mission-control.mission",
        "type_version": "3",
        "observation_id": "legacy-mission-observation",
        "payload_hash": before_rows["legacy-mission-observation"]["payload_hash"],
        "source_id": "atlas-adapter",
        "subject_key": "legacy:initiative-a",
    }
    after_rows = {
        row["observation_id"]: {
            key: row[key]
            for key in (
                "fact_surface_id",
                "observation_id",
                "payload_hash",
                "schema_owner_root",
                "source_id",
                "subject_key",
            )
        }
        for row in after["state"]["canonical_facts"]
        if row["fact_surface_id"].startswith("kungfu.mission-control.")
    }
    assert json.dumps(before_rows, sort_keys=True, separators=(",", ":")) == (
        json.dumps(after_rows, sort_keys=True, separators=(",", ":"))
    )

    created_initiative = profile_sdk.invoke_member_adapter(
        MISSION_PROFILE_SOURCE,
        runtime_dir,
        "mission-control-actions",
        "create-initiative",
        {
            "initiativeId": "initiative-new",
            "title": "Current initiative",
            "intent": "Prove coexistence",
            "actor": "test-agent",
        },
        authorized_action=True,
    )
    created_assignment = profile_sdk.invoke_member_adapter(
        MISSION_PROFILE_SOURCE,
        runtime_dir,
        "mission-control-actions",
        "create-assignment",
        {
            "initiativeId": "initiative-new",
            "assignmentId": "assignment-new",
            "title": "Current assignment",
            "objective": "Use only the successor world",
            "actor": "test-agent",
            "source": "kungfu",
        },
        authorized_action=True,
    )
    assert created_initiative["result"]["coreReceipt"]["schema"] == (
        "kungfu.initiative-assignment.initiative-write/v1"
    )
    assert created_assignment["result"]["coreReceipt"]["schema"] == (
        "kungfu.initiative-assignment.assignment-write/v1"
    )
    surfaces = {
        row["fact_surface_id"]
        for row in storage_service.fact_state(runtime_dir)["canonical_facts"]
    }
    assert {
        mission_control.LEGACY_MISSION_SURFACE_ID,
        mission_control.LEGACY_GO_SURFACE_ID,
        mission_control.INITIATIVE_SURFACE_ID,
        mission_control.ASSIGNMENT_SURFACE_ID,
    } <= surfaces


def test_atlas_range_export_preserves_context_closure(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    window = {"since": "2026-07-01T00:00:00Z"}
    _atlas_fixture(repo)
    _atlas_window_context_fixture(repo)

    (
        missions,
        goals,
        markers,
        source_records,
        warnings,
    ) = importer.read_control_plane_with_sources(str(repo), window=window)
    assert warnings == []

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-range-closure",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
        },
        range_filter=window,
        action_receipts=_action_receipts(source_records),
    )

    exported = payloads.export_records(store, range_filter=window)
    exported_keys = {(row["kind"], row["source_id"]) for row in exported}
    source_keys = {(row["kind"], row["source_id"]) for row in source_records}

    assert exported_keys == source_keys
    assert ("mission", "mission-b") in exported_keys
    assert (
        payloads.export_sync_root(store, range_filter=window) == manifest["sync_root"]
    )
    assert payloads.verify_against_source(store, source_records)["ok"]


def test_payload_manifest_fsck_export_and_verify(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    (
        missions,
        goals,
        markers,
        source_records,
        _,
    ) = importer.read_control_plane_with_sources(str(repo))

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
        },
        storage_source_id="atlas-local",
        range_filter={"since": "2026-07-01T00:00:00Z"},
        action_receipts=_action_receipts(source_records),
    )

    report = payloads.fsck_import(
        store, action_frames=_action_frames_from_manifest(manifest)
    )
    assert report["ok"]
    assert report["checked"] == {
        "payloads": 3,
        "missions": 1,
        "goals": 1,
        "markers": 1,
        "actions": 3,
        "sync_roots": 1,
        "storage_manifests": 1,
    }
    assert manifest["sync_root"] == payloads.compute_sync_root(manifest["entries"])
    assert manifest["sync_root"]["schema"] == payloads.SYNC_ROOT_SCHEMA
    assert (
        manifest["sync_root"]["scope"] == payloads.SYNC_ROOT_SCOPE_ATLAS_IMPORT_MANIFEST
    )
    assert manifest["sync_root"]["value"].startswith("sha256:")

    records = payloads.export_records(store)
    assert len(records) == 3
    goal = next(row for row in records if row["kind"] == "goal")
    assert goal["payload"]["large_body"] == ["full", "goal", "payload"]
    assert goal["repo_head"] == "abc123"
    assert goal["storage_source_id"] == "atlas-local"
    assert goal["source_time"] == "2026-07-08T01:00:00Z"
    assert goal["action"]["schema"] == payloads.ACTION_ENVELOPE_SCHEMA
    assert goal["action"]["action_type"] == "atlas.goal.snapshot"
    assert goal["action"]["schema_ref"]["id"] == "kungfu.atlas.GoalSnapshot"
    assert goal["action"]["payload"]["hash"] == goal["payload_hash"]
    assert goal["action"]["journal"]["frame_uid"] > 0
    assert goal["action"]["journal"]["carrier_type"] == CARRIER_ATLAS_ACTION

    missing_frame = payloads.fsck_import(store, action_frames={})
    assert not missing_frame["ok"]
    assert any(
        error["code"] == "action_frame_missing" for error in missing_frame["errors"]
    )

    verify = payloads.verify_against_source(store, source_records)
    assert verify == {
        "ok": True,
        "scope": "atlas",
        "checked": 3,
        "missing": [],
        "extra": [],
        "hash_mismatch": [],
    }


def test_storage_core_binding_owns_sync_root_and_payload_checks(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-runtime-core",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )
    runtime = kungfu.__binding__.runtime

    assert (
        runtime.compute_storage_sync_root(manifest["entries"]) == manifest["sync_root"]
    )
    assert (
        runtime.verify_storage_sync_root(manifest["sync_root"], manifest["entries"])
        == []
    )

    tampered = dict(manifest["sync_root"])
    tampered["value"] = payloads.SYNC_ROOT_INITIAL
    issues = runtime.verify_storage_sync_root(tampered, manifest["entries"])
    assert issues[0]["code"] == "sync_root_mismatch"
    assert issues[0]["field"] == "value"

    first = manifest["entries"][0]
    raw = payloads.payload_path(store, first["payload_hash"]).read_bytes()
    assert (
        runtime.verify_storage_payload(raw, first["payload_hash"], first["byte_len"])
        == ""
    )
    assert (
        runtime.verify_storage_payload(
            raw + b"extra", first["payload_hash"], first["byte_len"]
        )
        == "byte_len_mismatch"
    )


def test_typed_storage_read_bindings_bypass_json_transport(tmp_path):
    runtime = kungfu.__binding__.runtime
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(
        runtime_dir,
        episode_id=701,
        location_uid=17,
        title="typed-query",
        actor="binding-test",
    )
    storage_service.episode_end(runtime_dir, episode_id=701, end_time=1000)
    original_loads = json.loads

    def reject_json_transport(*_args, **_kwargs):
        raise AssertionError("typed status binding must not call json.loads")

    json.loads = reject_json_transport
    try:
        status = runtime.storage_status_typed(str(runtime_dir))
        status_high_level = storage_service.status(runtime_dir)
        layout = storage_service.layout(runtime_dir)
        query = runtime.storage_query_typed(
            str(runtime_dir), "episode_records", episode_id=701
        )
        query_edge = storage_service.query_projection(runtime_dir, query="entries")
        gc = storage_service.gc_plan(runtime_dir)
        rebuild = storage_service.rebuild_index(runtime_dir, dry_run=True)
        compact = storage_service.compact_plan(runtime_dir)
        fsck = storage_service.fsck(runtime_dir, episode_id=701)
        repair = storage_service.repair_plan(runtime_dir, episode_id=701)
        listed = storage_service.episode_list(runtime_dir)
        inspected = storage_service.episode_inspect(runtime_dir, episode_id=701)
        projection = storage_service.episode_projection_rebuild(runtime_dir)
        registered_source = storage_service.source_register(
            runtime_dir,
            source_id="typed-source",
            kind="adapter",
            coordinate="adapter://typed",
        )
        updated_source = runtime.storage_source_update_head_typed(
            str(runtime_dir),
            "typed-source",
            update_time=1600,
            head="head-1",
        )
        accepted_range = runtime.storage_source_record_accepted_range_typed(
            str(runtime_dir),
            "typed-source",
            "manifest-1",
            accept_time=1700,
        )
        source_list = runtime.storage_source_list_typed(str(runtime_dir))
        source_inspect = storage_service.source_inspect(
            runtime_dir, source_id="typed-source"
        )
        source_fsck = runtime.storage_source_registry_fsck_typed(
            str(runtime_dir), "typed-source"
        )
        source_rebuild = runtime.storage_source_registry_rebuild_typed(str(runtime_dir))
    finally:
        json.loads = original_loads

    assert status["ok"] is True
    assert status["source_id"] is None
    assert isinstance(status["provider_runtime"], dict)
    assert status["provider_runtime"]["read_fill_cache"] is None
    assert isinstance(status["projections"], list)
    assert status["projections"][0]["verification"]["authority"] == "yijinjing-journal"
    assert status_high_level["authority"] == status["authority"]
    assert status_high_level["projections"] == status["projections"]
    assert layout["owner"] == "libkungfu"
    assert layout["runtime_dir"] == str(runtime_dir.resolve())
    assert (
        status_high_level["provider_cache"]["hits"] >= status["provider_cache"]["hits"]
    )
    assert query["query"] == 4
    assert query["rows"][0]["body"]["title"] == "typed-query"
    assert query["rows"][0]["body"]["location_uid"] == 17
    assert query_edge["query"] == "entries"
    assert query_edge["row_count"] == 0
    assert gc["dry_run"] is True
    assert rebuild["would_write"] is True
    assert compact["dry_run"] is True
    assert fsck["scope"] == 2
    assert fsck["episode_id"] == 701
    assert repair["scope"] == 2
    assert repair["episode_id"] == 701
    assert repair["dry_run"] is True
    assert listed["episodes"][0]["episode_id"] == 701
    assert inspected["content_root"]["status"] == 4
    assert projection["authority"] == "yijinjing-journal"
    assert registered_source["kind"] == 4
    assert updated_source["head"] == "head-1"
    assert accepted_range["status"] == 1
    assert source_list["sources"][0]["source_uid"] == registered_source["source_uid"]
    assert source_inspect["source"]["current_head"] == "head-1"
    assert source_fsck["journal"]["ok"] is True
    assert source_rebuild["authority"] == "yijinjing-journal"


def test_runtime_storage_service_surface_is_bound_from_libkungfu(tmp_path):
    runtime = kungfu.__binding__.runtime
    capabilities = storage_service.service_capabilities()

    assert capabilities["schema"] == "kungfu.runtime.storage-service/v1"
    assert capabilities["owner"] == "libkungfu"
    assert capabilities["backend"] == "content-addressed-file"
    assert capabilities["provider"] == "content-addressed-file"
    assert capabilities["provider_config_source"] == "default"
    assert {provider["name"] for provider in capabilities["providers"]} == {
        "content-addressed-file",
        "rocksdb",
    }
    assert any(
        provider["name"] == "rocksdb"
        and provider["runtime"]["lifecycle"] == "provider-instance-owned"
        for provider in capabilities["providers"]
    )
    assert set(capabilities["operations"]) == {
        "status",
        "fsck",
        "repair_plan",
        "repair_fetch",
        "repair_apply",
        "export_bundle",
        "import_bundle",
        "rebuild_index",
        "gc_plan",
        "compact_plan",
        "verify_sync",
        "episode_admission",
        "backend_status",
        "backend_switch",
        "backend_rollback",
        "query",
        "query_plan",
        "fact_query",
        "fact_changelog",
        "saved_query_catalog",
        "profile_lifecycle",
        "kfx_runtime",
        "fact_kernel",
        "fact_contract",
        "fact_declare_world",
        "fact_declare_surface",
        "fact_observe",
        "fact_state",
        "fact_library_contract",
        "fact_type_create",
        "fact_type_list",
        "fact_material_put",
        "fact_material_list",
        "fact_library_export",
        "fact_library_import",
        "assessment_contract",
        "assessment_request",
        "assessment_execute",
        "assessment_status",
        "assessment_list",
        "assessment_invalidate",
        "trust_require",
        "layout",
        "episode_begin",
        "episode_heartbeat",
        "episode_end",
        "episode_abort",
        "episode_attach_frame",
        "episode_attach_ref",
        "episode_recover",
        "episode_recovery_plan",
        "episode_recovery_execute",
        "episode_list",
        "episode_inspect",
        "episode_projection_rebuild",
        "source_register",
        "source_update_head",
        "source_record_accepted_range",
        "source_list",
        "source_inspect",
        "source_registry_fsck",
        "source_registry_rebuild",
    }

    request = runtime.make_storage_service_request(
        "status",
        str(tmp_path),
        {"scope": "source", "source_id": "local-synth", "dry_run": True},
    )
    assert request == {
        "schema": "kungfu.runtime.storage-service/v1",
        "owner": "libkungfu",
        "operation": "status",
        "runtime_dir": str(tmp_path),
        "provider": "content-addressed-file",
        "provider_config_source": "default",
        "scope": "source",
        "source_id": "local-synth",
        "dry_run": True,
        "verify": True,
        "range": {},
        "artifact_uri": "",
    }
    status = runtime.run_storage_service_operation(
        "status",
        str(tmp_path),
        {"scope": "all"},
    )
    assert status["ok"]
    assert status["backend"] == "content-addressed-file"
    assert status["provider"] == "content-addressed-file"
    assert status["provider_config_source"] == "default"
    assert status["provider_runtime"]["lifecycle"] == "stateless-filesystem"
    assert status["sources"] == []

    request = runtime.make_storage_service_request(
        "status",
        str(tmp_path),
        {"provider": "rocksdb", "scope": "all"},
    )
    assert request["provider"] == "rocksdb"
    assert request["provider_config_source"] == "option"

    workspace_home = tmp_path / ".kungfu"
    runtime_dir = workspace_home / "runtime"
    config_home = tmp_path / ".kungfu-config"
    (runtime_dir / "skill-manager").mkdir(parents=True)
    (runtime_dir / "nn").mkdir()
    (runtime_dir / "storage" / "schemas").mkdir(parents=True)
    coordinator_guard = runtime_dir / "coordinator" / "continuity-locks" / "locks.guard"
    coordinator_guard.parent.mkdir(parents=True)
    coordinator_guard.write_text("guard\n")
    layout = storage_service.layout(
        runtime_dir,
        runtime_home=workspace_home,
        config_home=config_home,
    )
    layout_edge = runtime.run_storage_service_operation(
        "layout",
        str(runtime_dir),
        {
            "runtime_home": str(workspace_home),
            "config_home": str(config_home),
        },
    )
    assert layout["schema"] == "kungfu.workspace.episode-layout/v1"
    assert layout["owner"] == "libkungfu"
    assert layout["workspace_data_home"] == str(workspace_home)
    assert layout["runtime_home"] == str(workspace_home)
    assert layout["runtime_home_source"] == "option"
    assert layout["runtime_dir"] == str(runtime_dir)
    assert layout["config_home"] == str(config_home)
    assert layout["paths"]["data_home"] == str(workspace_home)
    assert layout["paths"]["storage_dir"] == str(runtime_dir / "storage")
    assert layout["paths"]["skill_manager_dir"] == str(runtime_dir / "skill-manager")
    assert layout["paths"]["agent_session_dir"] == str(runtime_dir / "agent-session")
    assert layout["paths"]["skill_context_dir"] == str(runtime_dir / "skill-context")
    assert layout["paths"]["nn_dir"] == str(runtime_dir / "nn")
    assert layout["paths"]["map_dir"] == str(runtime_dir / "map")
    assert layout["paths"]["ownership_dir"] == str(runtime_dir / "ownership")
    assert layout["paths"]["manifest_catalog_journal"] == str(
        runtime_dir / "journal/system/storage/manifest-catalog/live/*.journal"
    )
    assert layout["paths"]["source_registry_journal"] == str(
        runtime_dir / "journal/system/storage/source-registry/live/*.journal"
    )
    assert layout["paths"]["source_registry_projection"] == str(
        runtime_dir / "storage/projections/source-registry.sqlite"
    )
    assert layout["paths"]["manifest_catalog_projection"] == str(
        runtime_dir / "storage/projections/manifest-catalog.sqlite"
    )
    assert layout["paths"]["episode_manifest_journal"] == str(
        runtime_dir / "journal/system/storage/episode-manifest/live/*.journal"
    )
    assert layout["episodes"]["authority"] == "yijinjing-journal"
    assert layout["episodes"]["query_tables"] == [
        "episodes",
        "episode_records",
        "episode_frames",
        "episode_refs",
    ]
    persistence = {entry["id"]: entry["persistence"] for entry in layout["entries"]}
    assert persistence["journal"] == "durable"
    assert persistence["nn"] == "ephemeral"
    assert persistence["coordinator-locks"] == "ephemeral"
    assert persistence["skill-context"] == "cache"
    assert persistence["storage-schemas"] == "durable"
    assert layout["coverage"]["complete"]
    assert layout["coverage"]["unclassified_durable_candidates"] == []
    assert layout_edge["paths"] == layout["paths"]
    assert layout_edge["episodes"] == layout["episodes"]
    assert layout_edge["provider_layout"] == {
        key: value
        for key, value in layout["provider_layout"].items()
        if value is not None
    }

    (runtime_dir / "undeclared-future-store").mkdir()
    drifted_layout = storage_service.layout(
        runtime_dir,
        runtime_home=workspace_home,
        config_home=config_home,
    )
    assert not drifted_layout["coverage"]["complete"]
    assert drifted_layout["coverage"]["unclassified_durable_candidates"] == [
        str(runtime_dir / "undeclared-future-store")
    ]


def test_workspace_layout_v1_freeze_classifies_and_fails_closed(tmp_path):
    workspace_home = tmp_path / ".kungfu"
    runtime_dir = workspace_home / "runtime"
    for name in (
        "backups",
        "private",
        "cache",
        "locks",
        "projections",
        "contract",
        "missions",
        "skills",
        "skill-bindings",
    ):
        (workspace_home / name).mkdir(parents=True)
    (runtime_dir / "skill-manager").mkdir(parents=True)
    (runtime_dir / "nn").mkdir()
    (runtime_dir / "storage" / "schemas").mkdir(parents=True)
    for name in (
        "sources",
        "peers",
        "coordination",
        "admission",
        "fact-durable-admission",
        "receipts",
        "master",
        "episode-provider",
        "full-evidence",
        "rewind",
        "work",
        "agent",
    ):
        (runtime_dir / name).mkdir()
    (runtime_dir / "skill-audit.jsonl").write_text("")
    (runtime_dir / "storage" / "backend-switch-receipts").mkdir()
    (runtime_dir / "storage" / "backend-switch-state.json").write_text("{}\n")
    (runtime_dir / "storage" / "backend-switch.lock").write_text("")
    (runtime_dir / "storage" / "backend-authority.lock").write_text("")
    coordinator_guard = runtime_dir / "coordinator" / "continuity-locks" / "locks.guard"
    coordinator_guard.parent.mkdir(parents=True)
    coordinator_guard.write_text("guard\n")

    layout = storage_service.layout(runtime_dir, runtime_home=workspace_home)
    persistence = {entry["id"]: entry["persistence"] for entry in layout["entries"]}
    assert layout["schema"] == "kungfu.workspace.episode-layout/v1"
    assert layout["paths"]["skill_manager_dir"] == str(runtime_dir / "skill-manager")
    assert layout["paths"]["agent_session_dir"] == str(runtime_dir / "agent-session")
    assert layout["paths"]["skill_context_dir"] == str(runtime_dir / "skill-context")
    assert layout["paths"]["ownership_dir"] == str(runtime_dir / "ownership")
    assert layout["paths"]["sources_dir"] == str(runtime_dir / "sources")
    assert layout["paths"]["backend_switch_state"] == str(
        runtime_dir / "storage" / "backend-switch-state.json"
    )
    assert persistence["journal"] == "durable"
    assert persistence["backups"] == "durable"
    assert persistence["private"] == "durable"
    assert persistence["cache"] == "cache"
    assert persistence["locks"] == "ephemeral"
    assert persistence["projections"] == "cache"
    assert persistence["contract"] == "durable"
    assert persistence["missions"] == "durable"
    assert persistence["skills"] == "durable"
    assert persistence["skill-bindings"] == "durable"
    assert persistence["nn"] == "ephemeral"
    assert persistence["coordinator-locks"] == "ephemeral"
    assert persistence["coordination"] == "ephemeral"
    assert persistence["admission"] == "durable"
    assert persistence["fact-durable-admission"] == "durable"
    assert persistence["receipts"] == "durable"
    assert persistence["storage-backend-switch-state"] == "durable"
    assert persistence["storage-backend-switch-lock"] == "ephemeral"
    assert persistence["episode-provider"] == "ephemeral"
    assert persistence["full-evidence"] == "durable"
    assert persistence["rewind"] == "durable"
    assert persistence["work"] == "durable"
    assert persistence["agent"] == "durable"
    assert persistence["skill-audit"] == "durable"
    assert persistence["skill-context"] == "cache"
    assert persistence["storage-schemas"] == "durable"
    assert layout["coverage"]["complete"]

    (runtime_dir / "undeclared-future-store").mkdir()
    drifted = storage_service.layout(runtime_dir, runtime_home=workspace_home)
    assert not drifted["coverage"]["complete"]
    assert drifted["coverage"]["unclassified_durable_candidates"] == [
        str(runtime_dir / "undeclared-future-store")
    ]


def test_workspace_layout_coverage_rejects_non_directory_scan_root(tmp_path):
    workspace_home = tmp_path / ".kungfu"
    runtime_dir = workspace_home / "runtime"
    runtime_dir.mkdir(parents=True)
    (runtime_dir / "coordinator").write_text("not a directory\n")

    layout = storage_service.layout(runtime_dir, runtime_home=workspace_home)

    assert not layout["coverage"]["complete"]
    assert layout["coverage"]["unclassified_durable_candidates"] == [
        str(runtime_dir / "coordinator")
    ]


def test_workspace_layout_scans_explicit_runtime_but_not_unrelated_home(tmp_path):
    workspace_home = tmp_path / "declared-home"
    runtime_dir = tmp_path / "other" / "runtime"
    (runtime_dir / "storage" / "unknown").mkdir(parents=True)
    (runtime_dir / "coordinator" / "unknown").mkdir(parents=True)
    (workspace_home / "unknown").mkdir(parents=True)

    layout = storage_service.layout(runtime_dir, runtime_home=workspace_home)

    assert layout["runtime_dir_is_standard_child"] is False
    assert layout["coverage"]["checked_roots"] == [
        str(runtime_dir),
        str(runtime_dir / "storage"),
        str(runtime_dir / "coordinator"),
    ]
    assert not layout["coverage"]["complete"]
    assert layout["coverage"]["unclassified_durable_candidates"] == [
        str(runtime_dir / "storage" / "unknown"),
        str(runtime_dir / "coordinator" / "unknown"),
    ]


def test_python_storage_operations_enter_runtime_service_surface(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    accepted = storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )
    assert accepted["source_id"] == "local-synth"

    runtime = kungfu.__binding__.runtime
    original_operation = runtime.run_storage_service_operation
    original_typed_status = runtime.storage_status_typed
    original_typed_layout = runtime.storage_layout_typed
    original_typed_query = runtime.storage_query_typed
    original_typed_gc = runtime.storage_gc_plan_typed
    original_typed_rebuild = runtime.storage_rebuild_index_typed
    original_typed_compact = runtime.storage_compact_plan_typed
    original_typed_fsck = runtime.storage_fsck_typed
    original_typed_repair = runtime.storage_repair_plan_typed
    calls = []
    typed_statuses = []
    typed_layouts = []
    typed_queries = []
    typed_maintenance = []

    def spy_operation(operation, runtime_dir_arg, options):
        calls.append((operation, runtime_dir_arg, dict(options)))
        return original_operation(operation, runtime_dir_arg, options)

    def spy_typed_query(runtime_dir_arg, query, **options):
        typed_queries.append((runtime_dir_arg, query, dict(options)))
        return original_typed_query(runtime_dir_arg, query, **options)

    def spy_typed_status(runtime_dir_arg, source_id=None):
        typed_statuses.append((runtime_dir_arg, source_id))
        return original_typed_status(runtime_dir_arg, source_id)

    def spy_typed_layout(runtime_dir_arg, **options):
        typed_layouts.append((runtime_dir_arg, dict(options)))
        return original_typed_layout(runtime_dir_arg, **options)

    def spy_typed_gc(runtime_dir_arg, **options):
        typed_maintenance.append(("gc_plan", runtime_dir_arg, dict(options)))
        return original_typed_gc(runtime_dir_arg, **options)

    def spy_typed_rebuild(runtime_dir_arg, **options):
        typed_maintenance.append(("rebuild_index", runtime_dir_arg, dict(options)))
        return original_typed_rebuild(runtime_dir_arg, **options)

    def spy_typed_compact(runtime_dir_arg, **options):
        typed_maintenance.append(("compact_plan", runtime_dir_arg, dict(options)))
        return original_typed_compact(runtime_dir_arg, **options)

    def spy_typed_fsck(runtime_dir_arg, **options):
        typed_maintenance.append(("fsck", runtime_dir_arg, dict(options)))
        return original_typed_fsck(runtime_dir_arg, **options)

    def spy_typed_repair(runtime_dir_arg, **options):
        typed_maintenance.append(("repair_plan", runtime_dir_arg, dict(options)))
        return original_typed_repair(runtime_dir_arg, **options)

    monkeypatch.setattr(
        runtime,
        "run_storage_service_operation",
        spy_operation,
    )
    monkeypatch.setattr(runtime, "storage_status_typed", spy_typed_status)
    monkeypatch.setattr(runtime, "storage_layout_typed", spy_typed_layout)
    monkeypatch.setattr(runtime, "storage_query_typed", spy_typed_query)
    monkeypatch.setattr(runtime, "storage_gc_plan_typed", spy_typed_gc)
    monkeypatch.setattr(runtime, "storage_rebuild_index_typed", spy_typed_rebuild)
    monkeypatch.setattr(runtime, "storage_compact_plan_typed", spy_typed_compact)
    monkeypatch.setattr(runtime, "storage_fsck_typed", spy_typed_fsck)
    monkeypatch.setattr(runtime, "storage_repair_plan_typed", spy_typed_repair)

    storage_service.status(runtime_dir, source_id="local-synth")
    storage_service.layout(runtime_dir)
    storage_service.fsck(runtime_dir, source_id="local-synth")
    storage_service.repair_plan(runtime_dir, source_id="local-synth", dry_run=True)
    storage_service.repair_fetch(runtime_dir, source_id="local-synth", dry_run=True)
    storage_service.repair_apply(
        runtime_dir,
        storage_service.build_export_bundle(runtime_dir, source_id="local-synth"),
        source_id="local-synth",
        dry_run=True,
    )
    storage_service.rebuild_index(runtime_dir, source_id="local-synth", dry_run=True)
    storage_service.rebuild_index(runtime_dir, source_id="local-synth", dry_run=False)
    storage_service.gc_plan(runtime_dir, dry_run=True)
    storage_service.compact_plan(runtime_dir, dry_run=True)
    storage_service.build_export_bundle(runtime_dir, source_id="local-synth")
    storage_service.import_bundle(
        tmp_path / "imported-runtime",
        storage_service.build_export_bundle(runtime_dir, source_id="local-synth"),
    )
    storage_service.verify_local_sync(runtime_dir, source_id="local-synth")
    query = storage_service.query_projection(
        runtime_dir,
        query="entries",
        source_id="local-synth",
        kind="note",
        limit=10,
    )
    assert query["ok"]
    assert query["row_count"] == 1
    assert query["rows"][0]["kind"] == "note"
    assert query["rows"][0]["storage_source_id"] == "local-synth"

    entered = {operation for operation, _, _ in calls}
    assert {
        "repair_fetch",
        "repair_apply",
        "export_bundle",
        "import_bundle",
        "verify_sync",
    } <= entered
    assert typed_statuses == [(str(runtime_dir), "local-synth")]
    assert typed_layouts == [
        (
            str(runtime_dir),
            {"runtime_home": "", "config_home": "", "provider": ""},
        )
    ]
    assert typed_queries == [
        (
            str(runtime_dir),
            "entries",
            {
                "source_id": "local-synth",
                "entry_kind": "note",
                "limit": 10,
                "since": "",
                "until": "",
            },
        )
    ]
    assert typed_maintenance == [
        (
            "fsck",
            str(runtime_dir),
            {"source_id": "local-synth", "episode_id": 0, "verify_frames": False},
        ),
        (
            "repair_plan",
            str(runtime_dir),
            {
                "source_id": "local-synth",
                "episode_id": 0,
                "dry_run": True,
            },
        ),
        (
            "rebuild_index",
            str(runtime_dir),
            {"source_id": "local-synth", "dry_run": True},
        ),
        (
            "rebuild_index",
            str(runtime_dir),
            {"source_id": "local-synth", "dry_run": False},
        ),
        ("gc_plan", str(runtime_dir), {"source_id": None, "dry_run": True}),
        ("compact_plan", str(runtime_dir), {"source_id": None, "dry_run": True}),
    ]


def test_python_episode_writes_use_native_retry_edge(tmp_path, monkeypatch):
    runtime = kungfu.__binding__.runtime
    runtime_dir = tmp_path / "runtime"
    original_edge = runtime.run_storage_service_operation
    calls = []

    def edge_spy(operation, *args, **kwargs):
        calls.append(operation)
        return original_edge(operation, *args, **kwargs)

    monkeypatch.setattr(runtime, "run_storage_service_operation", edge_spy)

    assert (
        storage_service.episode_begin(runtime_dir, episode_id=801, begin_time=1000)[
            "write_retry"
        ]["attempts"]
        == 1
    )
    storage_service.episode_heartbeat(runtime_dir, episode_id=801, update_time=1100)
    storage_service.episode_attach_frame(
        runtime_dir, episode_id=801, frame_uid=1, gen_time=1200
    )
    storage_service.episode_attach_ref(
        runtime_dir, episode_id=801, ref_kind="input_frame", ref_uid=2
    )
    storage_service.episode_end(runtime_dir, episode_id=801, end_time=1300)
    storage_service.episode_begin(runtime_dir, episode_id=802, begin_time=1400)
    storage_service.episode_recover(runtime_dir, episode_id=802, end_time=1500)

    assert calls == [
        "episode_begin",
        "episode_heartbeat",
        "episode_attach_frame",
        "episode_attach_ref",
        "episode_end",
        "episode_begin",
        "episode_recover",
    ]


def test_storage_query_edge_renders_typed_source_manifest_and_entry_rows(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.write_synthetic_source(
        runtime_dir,
        source_id="typed-query-source",
        manifest_id="typed-query-manifest",
        source_head="typed-head",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )

    sources = storage_service.query_projection(
        runtime_dir,
        query="sources",
        source_id="typed-query-source",
    )
    assert sources["projection"] == {
        "name": "manifest-catalog",
        "schema": "kungfu.storage.manifest-catalog/v1",
        "authority": "yijinjing-journal",
        "rebuildable": True,
    }
    assert sources["row_count"] == 1
    assert sources["rows"][0]["source_id"] == "typed-query-source"
    assert sources["rows"][0]["manifest_id"] == "typed-query-manifest"

    manifests = storage_service.query_projection(
        runtime_dir,
        query="manifests",
        source_id="typed-query-source",
    )
    assert manifests["row_count"] == 1
    assert manifests["rows"][0]["source_id"] == "typed-query-source"
    assert manifests["rows"][0]["manifest_id"] == "typed-query-manifest"
    assert manifests["rows"][0]["status"] == "ok"

    entries = storage_service.query_projection(
        runtime_dir,
        query="entries",
        source_id="typed-query-source",
        kind="note",
        limit=1,
    )
    assert entries["row_count"] == 1
    assert entries["rows"][0]["source_id"] == "note-a"
    assert entries["rows"][0]["storage_source_id"] == "typed-query-source"


def test_episode_manifest_v1_is_yijinjing_backed_and_fscked(tmp_path):
    runtime_dir = tmp_path / "runtime"
    episode = storage_service.episode_begin(
        runtime_dir,
        episode_id=42,
        title="test episode",
        actor="pytest",
        source="unit-test",
        begin_time=1000,
    )
    assert episode["schema_version"] == 1
    assert episode["episode_id"] == 42

    input_ref = storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=42,
        ref_kind="input_frame",
        ref_uid=99,
        ref_id="external-frame:99",
    )
    assert input_ref["ref_kind"] == 1

    attached = storage_service.episode_attach_frame(
        runtime_dir,
        episode_id=42,
        frame_uid=100,
        trigger_frame_uid=99,
        stream_id=7,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=12,
        integrity_version=2,
        payload_checksum=123,
        frame_checksum=456,
    )
    assert attached["schema_version"] == 1
    assert attached["frame_uid"] == 100

    ended = storage_service.episode_end(
        runtime_dir,
        episode_id=42,
        end_time=1200,
        last_frame_uid=100,
        frame_count=1,
        reason="done",
    )
    assert ended["close"]["status"] == 2
    assert ended["content_root"]["episode_id"] == 42

    listed = storage_service.episode_list(runtime_dir)
    assert listed["authority"] == "yijinjing-journal"
    assert len(listed["episodes"]) == 1
    assert listed["episodes"][0]["episode_id"] == 42
    assert listed["episodes"][0]["unique_frame_count"] == 1

    inspected = storage_service.episode_inspect(runtime_dir, episode_id=42)
    assert inspected["ok"]
    assert inspected["episode"]["close"]["status"] == 2
    # open + frame + ref + close, plus the KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9 root committed at seal
    assert len(inspected["episode"]["records"]) == 5
    assert inspected["episode"]["records"][-1]["body"]["root_value"]
    frame_index = inspected["episode"]["frame_indices"][0]
    assert inspected["content_root"]["status"] == 4
    assert inspected["episode"]["records"][frame_index]["body"]["frame_uid"] == 100
    assert inspected["causal_graph"]["schema"] == "kungfu.episode.causal-graph/v1"
    assert inspected["causal_graph"]["degraded"] is False
    assert inspected["causal_graph"]["dependencies"][0]["kind"] == "frame"
    assert inspected["causal_graph"]["dependencies"][0]["status"] == "declared_external"

    fsck = storage_service.fsck(runtime_dir)
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["checked"]["episode_manifest_records"] == 5
    assert fsck["checked"]["episodes"] == 1
    assert fsck["episode_manifest"]["authority"] == "yijinjing-journal"

    episode_fsck = storage_service.fsck(runtime_dir, episode_id=42)
    assert episode_fsck["ok"]
    assert episode_fsck["scope"] == 2
    assert episode_fsck["episode_id"] == 42
    assert episode_fsck["checked"]["episodes"] == 1

    episode_rows = storage_service.query_projection(
        runtime_dir,
        query="episodes",
        episode_id=42,
    )
    assert episode_rows["ok"]
    assert episode_rows["projection"]["authority"] == "yijinjing-journal"
    assert episode_rows["row_count"] == 1
    assert episode_rows["rows"][0]["episode_id"] == 42

    frame_rows = storage_service.query_projection(
        runtime_dir,
        query="episode_frames",
        episode_id=42,
    )
    assert frame_rows["ok"]
    assert frame_rows["row_count"] == 1
    assert frame_rows["rows"][0]["frame_uid"] == 100

    bundle = storage_service.build_export_bundle(runtime_dir, episode_id=42)
    assert bundle["schema"] == "kungfu.storage.episode-bundle/v1"
    assert bundle["scope"] == "episode"
    assert bundle["episode_id"] == 42
    assert bundle["manifest"]["episode_id"] == 42
    assert bundle["causal_graph"]["degraded"] is False
    assert bundle["dependencies"][0]["status"] == "declared_external"
    assert bundle["record_count"] == 5
    assert bundle["frame_count"] == 1


def test_episode_fixed_text_edges_are_capacity_bounded(tmp_path):
    runtime_dir = tmp_path / "runtime"
    title = "t" * 64
    actor = "a" * 64
    source = "s" * 64
    note = "n" * 64
    ref_id = "i" * 128
    ref_hash = "h" * 128
    reason = "r" * 64

    opened = storage_service.episode_begin(
        runtime_dir,
        episode_id=43,
        title=title,
        actor=actor,
        source=source,
        begin_time=1000,
    )
    assert opened["title"] == title
    assert opened["actor"] == actor
    assert opened["source"] == source

    heartbeat = storage_service.episode_heartbeat(
        runtime_dir,
        episode_id=43,
        update_time=1100,
        note=note,
    )
    assert heartbeat["note"] == note

    reference = storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=43,
        ref_kind="payload",
        ref_uid=1,
        ref_id=ref_id,
        ref_hash=ref_hash,
        update_time=1200,
    )
    assert reference["ref_id"] == ref_id
    assert reference["ref_hash"] == ref_hash

    ended = storage_service.episode_end(
        runtime_dir,
        episode_id=43,
        end_time=1300,
        reason=reason,
    )
    assert ended["close"]["reason"] == reason

    inspected = storage_service.episode_inspect(runtime_dir, episode_id=43)
    records = inspected["episode"]["records"]
    assert records[0]["body"]["title"] == title
    assert records[0]["body"]["actor"] == actor
    assert records[0]["body"]["source"] == source
    assert records[1]["body"]["note"] == note
    assert records[2]["body"]["ref_id"] == ref_id
    assert records[2]["body"]["ref_hash"] == ref_hash
    assert records[3]["body"]["reason"] == reason


def test_fact_query_reproduces_head_and_historical_episode_cuts(tmp_path):
    runtime_dir = tmp_path / "runtime"
    opened = storage_service.episode_begin(
        runtime_dir,
        episode_id=1048,
        title="query basis proof",
        actor="pytest",
        source="adr-0048-q0",
        begin_time=1000,
    )
    attached = storage_service.episode_attach_frame(
        runtime_dir,
        episode_id=1048,
        frame_uid=2001,
        trigger_frame_uid=0,
        stream_id=48,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=12,
        integrity_version=2,
        payload_checksum=123,
        frame_checksum=456,
    )
    storage_service.episode_end(
        runtime_dir,
        episode_id=1048,
        end_time=1200,
        last_frame_uid=2001,
        frame_count=1,
        reason="done",
    )

    records = storage_service.episode_inspect(runtime_dir, episode_id=1048)["records"]
    attached_record = next(
        record
        for record in records
        if record["record_kind"] == "episode_frame_attached"
    )
    historical_cut = {
        "kind": "manifest_frame_uid",
        "manifest_frame_uid": str(attached_record["manifest_frame_uid"]),
    }
    historical = storage_service.fact_query(
        runtime_dir, episode_id=1048, cut=historical_cut
    )
    repeated = storage_service.fact_query(
        runtime_dir, episode_id=1048, cut=historical_cut
    )
    head = storage_service.fact_query(runtime_dir, episode_id=1048)

    assert opened["episode_id"] == attached["episode_id"]
    assert historical == repeated
    assert historical["schema"] == "kungfu.query.result/v1"
    assert historical["definition"]["schema"] == "kungfu.query.definition/v1"
    assert historical["definition"]["basis"]["cut"] == historical_cut
    assert historical["rows"][0]["status"] == "open"
    assert historical["rows"][0]["content_root_status"] == "undefined"
    assert historical["lineage"]["authority"]["kind"] == "yijinjing-journal"
    assert historical["lineage"]["authority"]["record_count"] == 2
    assert historical["lineage"]["cut"]["resolved"] == historical_cut
    assert historical["lineage"]["determinism"] == "deterministic"
    assert historical["lineage"]["canonical_state"] is True
    assert (
        historical["lineage"]["contract_world_declaration"]
        == historical["definition"]["basis"]["contract_world"]
    )
    assert (
        historical["lineage"]["fact_surface_declarations"]
        == historical["definition"]["basis"]["fact_surfaces"]
    )
    assert historical["lineage"]["admission_outcomes"] == [
        {
            "outcome": "admitted",
            "fact_surface_id": "kungfu.runtime.episode-manifest",
            "record_count": 2,
            "reason": "records satisfy the built-in typed Episode manifest declaration",
        }
    ]
    assert historical["lineage"]["missing_inputs"] == []
    assert historical["logical_plan"]["schema"] == "kungfu.query.logical-plan/v1"
    assert (
        historical["lineage"]["logical_plan_hash"]
        == historical["logical_plan"]["logical_plan_hash"]
    )
    assert set(historical["lineage"]["time_basis"]) == {
        "valid_time",
        "system_time",
        "causal_time",
    }
    assert historical["lineage"]["time_basis"]["valid_time"] == "not-projected"
    assert (
        historical["lineage"]["policy_versions"]["engine"]
        == "episode-authority-scan/v1"
    )

    assert head["definition"]["basis"]["cut"] == {"kind": "head"}
    assert head["rows"][0]["status"] == "ended"
    assert head["rows"][0]["content_root_status"] == "verified"
    assert head["result_hash"] != historical["result_hash"]
    assert head["lineage"]["cut"]["resolved"]["kind"] == "manifest_frame_uid"
    assert head["lineage"]["episode_content_roots"][0]["status"] == "verified"

    missing = storage_service.fact_query(
        runtime_dir,
        episode_id=1048,
        cut={
            "kind": "manifest_frame_uid",
            "manifest_frame_uid": "18446744073709551615",
        },
    )
    assert missing["rows"] == []
    assert missing["lineage"]["determinism"] == "unverifiable"
    assert missing["lineage"]["canonical_state"] is False
    assert missing["lineage"]["cut"]["resolved"] == {"kind": "unresolved"}
    assert missing["lineage"]["missing_inputs"] == [
        {
            "kind": "manifest_cut",
            "manifest_frame_uid": "18446744073709551615",
        }
    ]


def test_fact_query_fails_closed_on_unregistered_or_changed_declarations(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(runtime_dir, episode_id=51, begin_time=1000)

    admitted = storage_service.fact_query(runtime_dir, episode_id=51)
    capabilities = storage_service.query_plan(runtime_dir, action="capabilities")
    builtins = capabilities["builtin_declarations"]

    assert admitted["lineage"]["canonical_state"] is True
    assert (
        admitted["definition"]["basis"]["contract_world"]
        == builtins["contract_world"]["reference"]
    )
    assert admitted["definition"]["basis"]["fact_surfaces"] == [
        builtins["fact_surfaces"][0]["reference"]
    ]

    changed_root = json.loads(json.dumps(admitted["definition"]))
    changed_root["basis"]["fact_surfaces"][0]["root"] = "sha256:" + "0" * 64
    unverifiable = storage_service.fact_query_definition(runtime_dir, changed_root)

    assert unverifiable["rows"] == []
    assert unverifiable["lineage"]["canonical_state"] is False
    assert unverifiable["lineage"]["determinism"] == "unverifiable"
    assert unverifiable["lineage"]["admission_outcomes"][0]["outcome"] == (
        "unverifiable"
    )
    assert (
        unverifiable["lineage"]["fact_surface_declarations"][0]["root"]
        == "sha256:" + "0" * 64
    )
    assert storage_service.fact_query(runtime_dir, episode_id=51) == admitted

    unregistered = json.loads(json.dumps(admitted["definition"]))
    unregistered["basis"]["fact_surfaces"][0]["id"] = "example.unknown"
    rejected = storage_service.fact_query_definition(runtime_dir, unregistered)
    assert rejected["rows"] == []
    assert rejected["lineage"]["admission_outcomes"][0]["outcome"] == (
        "unregistered-surface"
    )


def test_domain_fact_state_is_empty_before_the_admission_journal_exists(tmp_path):
    state = storage_service.fact_state(tmp_path / "runtime")

    assert state["declarations"] == {
        "contract_world": None,
        "fact_surface": None,
    }
    assert state["canonical_facts"] == []
    assert state["observation_history"] == []


def test_domain_fact_admission_replays_declaration_history_and_observation_lifecycle(
    tmp_path,
):
    runtime_dir = tmp_path / "runtime"
    schema_v1 = "sha256:" + "1" * 64
    schema_v2 = "sha256:" + "2" * 64

    world_v1 = storage_service.fact_declare_contract_world(
        runtime_dir,
        {
            "id": "example.inventory",
            "version": "1",
            "effective_from": 100,
            "effective_until": 200,
            "fact_surface_ids": ["example.inventory.stock"],
        },
        system_time=90,
    )
    surface_v1 = storage_service.fact_declare_surface(
        runtime_dir,
        {
            "id": "example.inventory.stock",
            "version": "1",
            "contract_world": world_v1["reference"],
            "effective_from": 100,
            "effective_until": 200,
            "schema_owner_root": schema_v1,
            "source_authorities": ["warehouse-a", "warehouse-b"],
            "identity_policy": "subject-key/v1",
            "valid_time_policy": "explicit-range/v1",
            "system_time_policy": "journal-event-time/v1",
            "causal_time_policy": "event-parent/v1",
            "reducer_policy": "latest-admitted-per-source/v1",
            "correction_policy": "explicit-target/v1",
            "retraction_policy": "explicit-target/v1",
            "conflict_policy": "preserve-source-claims/v1",
            "redaction_policy": "hash-and-ref/v1",
            "compatibility_policy": "exact-schema-root/v1",
            "known_limits": ["single-writer admission journal"],
        },
        system_time=91,
    )

    def observe(observation_id, system_time, **overrides):
        observation = {
            "observation_id": observation_id,
            "contract_world_id": "example.inventory",
            "fact_surface_id": "example.inventory.stock",
            "schema_owner_root": schema_v1,
            "source_id": "warehouse-a",
            "subject_key": "sku-42",
            "valid_from": 1000,
            "valid_until": 0,
            "payload_hash": "sha256:" + observation_id[-1] * 64,
            "payload_ref": f"content:{observation_id}",
            "action": "assert",
            "target_observation_id": "",
        }
        observation.update(overrides)
        return storage_service.fact_observe(
            runtime_dir, observation, system_time=system_time
        )

    admitted_v1 = observe("obs-a", 110, payload_hash="sha256:" + "a" * 64)
    unregistered = observe("obs-b", 111, fact_surface_id="example.inventory.unknown")
    incompatible = observe("obs-c", 112, schema_owner_root=schema_v2)
    ambiguous = observe("obs-d", 113, source_id="")
    unverifiable = observe("obs-e", 114, payload_hash="not-a-content-root")

    assert [
        admitted_v1["admission"]["outcome"],
        unregistered["admission"]["outcome"],
        incompatible["admission"]["outcome"],
        ambiguous["admission"]["outcome"],
        unverifiable["admission"]["outcome"],
    ] == [
        "admitted",
        "unregistered-surface",
        "incompatible-schema",
        "ambiguous-authority",
        "unverifiable",
    ]

    world_v2 = storage_service.fact_declare_contract_world(
        runtime_dir,
        {
            "id": "example.inventory",
            "version": "2",
            "effective_from": 200,
            "effective_until": 0,
            "fact_surface_ids": ["example.inventory.stock"],
        },
        system_time=190,
    )
    surface_v2 = storage_service.fact_declare_surface(
        runtime_dir,
        {
            **surface_v1["declaration"],
            "version": "2",
            "contract_world": world_v2["reference"],
            "effective_from": 200,
            "effective_until": 0,
            "schema_owner_root": schema_v2,
        },
        system_time=191,
    )

    asserted_v2 = observe(
        "obs-f",
        205,
        schema_owner_root=schema_v2,
        payload_hash="sha256:" + "f" * 64,
    )
    corrected_v2 = observe(
        "obs-1",
        210,
        schema_owner_root=schema_v2,
        payload_hash="sha256:" + "3" * 64,
        action="correct",
        target_observation_id="obs-f",
        valid_from=1010,
    )
    conflicting_v2 = observe(
        "obs-2",
        215,
        schema_owner_root=schema_v2,
        source_id="warehouse-b",
        payload_hash="sha256:" + "4" * 64,
        valid_from=1010,
    )
    cross_identity_correction = observe(
        "obs-x",
        216,
        schema_owner_root=schema_v2,
        source_id="warehouse-b",
        subject_key="sku-other",
        payload_hash="sha256:" + "7" * 64,
        action="correct",
        target_observation_id="obs-2",
        valid_from=1010,
    )
    retracted_v2 = observe(
        "obs-3",
        220,
        schema_owner_root=schema_v2,
        source_id="warehouse-b",
        payload_hash="sha256:" + "5" * 64,
        action="retract",
        target_observation_id="obs-2",
        valid_from=1020,
    )

    assert asserted_v2["admission"]["outcome"] == "admitted"
    assert corrected_v2["admission"]["outcome"] == "admitted"
    with pytest.raises((RuntimeError, ValueError), match="already recorded"):
        observe(
            "obs-1",
            211,
            schema_owner_root=schema_v2,
            payload_hash="sha256:" + "6" * 64,
        )
    assert conflicting_v2["admission"]["outcome"] == "admitted"
    assert cross_identity_correction["admission"]["outcome"] == "unverifiable"
    assert retracted_v2["admission"]["outcome"] == "admitted"

    historical_v1 = storage_service.fact_state(
        runtime_dir, cut_system_time=150, subject_key="sku-42"
    )
    historical_conflict = storage_service.fact_state(
        runtime_dir, cut_system_time=219, subject_key="sku-42"
    )
    head = storage_service.fact_state(runtime_dir, subject_key="sku-42")
    repeated = storage_service.fact_state(runtime_dir, subject_key="sku-42")

    assert head == repeated
    assert historical_v1["declarations"]["contract_world"] == world_v1["reference"]
    assert historical_v1["declarations"]["fact_surface"] == surface_v1["reference"]
    assert historical_v1["admission_outcomes"] == {
        "admitted": 1,
        "ambiguous-authority": 1,
        "incompatible-schema": 1,
        "unregistered-surface": 1,
        "unverifiable": 1,
    }
    assert [fact["observation_id"] for fact in historical_v1["canonical_facts"]] == [
        "obs-a"
    ]
    assert (
        historical_conflict["declarations"]["contract_world"] == world_v2["reference"]
    )
    assert (
        historical_conflict["declarations"]["fact_surface"] == surface_v2["reference"]
    )
    assert historical_conflict["conflicts"] == [
        {
            "subject_key": "sku-42",
            "observation_ids": ["obs-1", "obs-2"],
            "source_ids": ["warehouse-a", "warehouse-b"],
        }
    ]
    assert head["conflicts"] == []
    assert [fact["observation_id"] for fact in head["canonical_facts"]] == ["obs-1"]
    assert head["canonical_facts"][0]["valid_time"] == {
        "from": 1010,
        "until": 0,
    }
    assert head["canonical_facts"][0]["system_time"] == 210
    assert (
        head["canonical_facts"][0]["causal_parent_event_id"]
        == asserted_v2["observation_event_id"]
    )
    assert {event["action"] for event in head["observation_history"]} >= {
        "assert",
        "correct",
        "retract",
    }
    assert all(event["episode_id"] for event in head["observation_history"])
    assert head["proof"]["schema_owner"] == "flatbuffers"
    assert head["proof"]["schema_root"].startswith("sha256:")


def test_managed_fact_library_roundtrips_types_material_and_owned_content(tmp_path):
    runtime_dir = tmp_path / "source" / "runtime"
    definition = {
        "id": "goal-status",
        "version": "1",
        "source_authorities": ["agent", "human"],
        "schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string"},
                "ready_for_handoff": {"type": "boolean"},
            },
            "required": ["status", "ready_for_handoff"],
            "additionalProperties": False,
        },
    }

    created = storage_service.fact_type_create(runtime_dir, definition, system_time=100)
    recovered = storage_service.fact_type_create(
        runtime_dir, definition, system_time=101
    )
    assert created["status"] == "created"
    assert recovered["status"] == "already_present"
    assert created["schema_hash"].startswith("sha256:")
    with pytest.raises(
        (RuntimeError, ValueError), match="different immutable definition"
    ):
        storage_service.fact_type_create(
            runtime_dir,
            {**definition, "source_authorities": ["agent"]},
            system_time=102,
        )

    catalog = storage_service.fact_type_list(runtime_dir)
    assert [row["id"] for row in catalog["fact_types"]] == ["goal-status"]
    assert catalog["fact_types"][0]["episode_id"]

    with pytest.raises(
        (RuntimeError, ValueError), match="missing required ready_for_handoff"
    ):
        storage_service.fact_material_put(
            runtime_dir,
            {
                "type_id": "goal-status",
                "type_version": "1",
                "source_id": "agent",
                "subject_key": "invalid-goal",
                "payload": {"status": "ready"},
            },
            system_time=150,
        )

    written = storage_service.fact_material_put(
        runtime_dir,
        {
            "type_id": "goal-status",
            "type_version": "1",
            "source_id": "agent",
            "subject_key": "fact-library-goal",
            "payload": {
                "status": "ready",
                "ready_for_handoff": True,
            },
        },
        system_time=200,
    )
    assert written["ok"] is True
    assert written["receipt"]["admission"]["outcome"] == "admitted"

    material = storage_service.fact_material_list(
        runtime_dir, type_id="goal-status", subject_key="fact-library-goal"
    )
    history = material["state"]["observation_history"]
    assert len(history) == 1
    assert material["payloads"][history[0]["payload_hash"]] == {
        "ready_for_handoff": True,
        "status": "ready",
    }

    full = storage_service.fact_library_export(runtime_dir)
    thin = storage_service.fact_library_export(runtime_dir, thin=True)
    assert full["schema"] == "kungfu.facts.library-bundle/v1"
    assert full["mode"] == "full"
    assert full["self_contained"] is True
    assert full["material"]["missing_frame_count"] == 0
    assert full["episode_count"] == 3
    namespaces = {
        row["content_namespace"]
        for episode in full["episodes"]
        for row in episode.get("ref_payloads", [])
    }
    assert namespaces == {"payloads", "schemas"}
    assert thin["mode"] == "thin"
    assert all("self_contained" not in episode for episode in thin["episodes"])

    imported_runtime = tmp_path / "imported" / "runtime"
    preview = storage_service.fact_library_import(imported_runtime, full)
    applied = storage_service.fact_library_import(imported_runtime, full, dry_run=False)
    repeated = storage_service.fact_library_import(
        imported_runtime, full, dry_run=False
    )
    assert preview["ok"] is True and preview["dry_run"] is True
    assert applied["ok"] is True and applied["receipt_count"] == 3
    assert len(applied["preflight_receipts"]) == 3
    assert repeated["ok"] is True
    assert {receipt["status"] for receipt in repeated["receipts"]} == {
        "already_present"
    }
    imported = storage_service.fact_material_list(
        imported_runtime, type_id="goal-status"
    )
    assert len(imported["state"]["canonical_facts"]) == 1
    imported_hash = imported["state"]["canonical_facts"][0]["payload_hash"]
    assert imported["payloads"][imported_hash]["ready_for_handoff"] is True

    tampered = json.loads(json.dumps(full))
    schema_payload = next(
        row
        for episode in tampered["episodes"]
        for row in episode.get("ref_payloads", [])
        if row["content_namespace"] == "schemas"
    )
    schema_payload["content_namespace"] = "payloads"
    with pytest.raises(
        (RuntimeError, ValueError), match="ref_payload_namespace_mismatch"
    ):
        storage_service.fact_library_import(tmp_path / "tampered" / "runtime", tampered)


def test_fact_changelog_resumes_pages_without_loss_or_duplication(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(
        runtime_dir, episode_id=8048, title="changelog", begin_time=1000
    )
    definition = storage_service.build_fact_query_definition(episode_id=8048)

    first = storage_service.fact_changelog(runtime_dir, definition, max_messages=2)
    assert first["schema"] == "kungfu.query.changelog/v1"
    assert first["complete"] is False
    assert [message["type"] for message in first["messages"]] == [
        "SnapshotBegin",
        "RowUpsert",
    ]
    assert len({message["message_id"] for message in first["messages"]}) == 2
    assert int(first["resume_token"]["target"]["record_count"]) >= 1

    tampered = json.loads(json.dumps(first["resume_token"]))
    tampered["next_message_index"] += 1
    with pytest.raises((RuntimeError, ValueError), match="integrity check failed"):
        storage_service.fact_changelog(
            runtime_dir, definition, resume_token=tampered, max_messages=2
        )

    second = storage_service.fact_changelog(
        runtime_dir,
        definition,
        resume_token=first["resume_token"],
        max_messages=2,
    )
    assert second["batch_id"] == first["batch_id"]
    assert second["complete"] is True
    assert [message["type"] for message in second["messages"]] == ["SnapshotEnd"]
    assert [message["index"] for message in first["messages"] + second["messages"]] == [
        0,
        1,
        2,
    ]

    steady = second["resume_token"]
    unchanged = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady
    )
    assert unchanged["complete"] is True
    assert [message["type"] for message in unchanged["messages"]] == ["Progress"]

    storage_service.episode_end(
        runtime_dir,
        episode_id=8048,
        end_time=1200,
        reason="done",
    )
    changed = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady, max_messages=1
    )
    replay = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady, max_messages=1
    )
    assert changed == replay
    assert changed["complete"] is False
    assert changed["messages"][0]["type"] == "RowUpsert"
    assert changed["messages"][0]["row"]["status"] == "ended"
    assert changed["messages"][0]["evidence_ref"]["content_root_status"] in {
        "verified",
        "undefined",
    }

    finished = storage_service.fact_changelog(
        runtime_dir,
        definition,
        resume_token=changed["resume_token"],
        max_messages=10,
    )
    assert finished["complete"] is True
    assert [message["type"] for message in finished["messages"]] == ["Progress"]
    assert finished["messages"][0]["frontier"]["kind"] == "manifest_frame_uid"


def test_fact_state_changelog_uses_stable_keys_and_system_time_frontiers(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _activate_mission_profile(runtime_dir)
    _atlas_fixture(repo)
    _import_atlas(runtime_dir, repo)

    profile_definition = mission_control.build_state_query(
        str(runtime_dir), mission_id="mission-a"
    )
    definition = mission_control._runtime_query_definition(profile_definition)
    snapshot = storage_service.fact_changelog(runtime_dir, definition)
    assert snapshot["complete"] is True
    assert snapshot["resume_token"]["target"]["kind"] == "system_time"
    assert [message["type"] for message in snapshot["messages"]] == [
        "SnapshotBegin",
        "RowUpsert",
        "RowUpsert",
        "SnapshotEnd",
    ]
    goal_upsert = next(
        message
        for message in snapshot["messages"]
        if message.get("row", {}).get("subject_key") == "atlas:goal-a"
    )
    assert goal_upsert["evidence_ref"]["payload_hash"]
    assert goal_upsert["evidence_ref"]["episode_id"]

    steady = snapshot["resume_token"]
    unchanged = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady
    )
    assert [message["type"] for message in unchanged["messages"]] == ["Progress"]

    goal_path = repo / "agent-journal/goals/registry/active/goal-a.json"
    changed = json.loads(goal_path.read_text(encoding="utf-8"))
    changed["status"] = "ready"
    changed["updated_at"] = "2026-07-09T00:00:00Z"
    _write_json(goal_path, changed)
    _import_atlas(runtime_dir, repo)

    correction = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady
    )
    replay = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady
    )
    assert correction == replay
    assert [message["type"] for message in correction["messages"]] == [
        "RowUpsert",
        "Progress",
    ]
    assert correction["messages"][0]["key"] == goal_upsert["key"]
    assert (
        correction["messages"][0]["row"]["episode_id"]
        != goal_upsert["row"]["episode_id"]
    )
    assert correction["messages"][1]["frontier"]["kind"] == "system_time"
    assert int(correction["messages"][1]["frontier"]["system_time"]) > int(
        steady["target"]["system_time"]
    )


def test_temporal_attention_pattern_is_reproducible_and_retracts_on_late_terminal(
    tmp_path,
):
    runtime_dir = tmp_path / "runtime"
    buildchain_events = [
        (1, "alpha_published", "feature-agent", 1000),
        (2, "gate_failed", "release-infra", 1100),
        (3, "alpha_published", "feature-agent", 1200),
        (4, "gate_failed", "release-infra", 1300),
        # This event is beyond the declared as_of cut and must not contaminate it.
        (5, "alpha_published", "future-agent", 3000),
    ]
    for episode_id, title, actor, begin_time in buildchain_events:
        storage_service.episode_begin(
            runtime_dir,
            episode_id=episode_id,
            title=title,
            actor=actor,
            source="buildchain-feature-42",
            begin_time=begin_time,
        )

    definition = storage_service.build_fact_query_definition(limit=10)
    definition["temporal_pattern"] = {
        "schema": "kungfu.query.temporal-pattern/v1",
        "partition_by": "source",
        "order_by": "begin_time",
        "sequence": [
            {"field": "title", "equals": "alpha_published"},
            {"field": "title", "equals": "gate_failed"},
        ],
        "repeat": {"min": 2, "max": 8},
        "within_ns": "1000",
        "as_of_time": "2000",
        "absence": {"field": "title", "equals": "stable_published"},
    }

    plan = storage_service.query_plan(
        runtime_dir, action="validate", definition=definition
    )
    explanation = storage_service.query_plan(
        runtime_dir, action="explain", definition=definition
    )
    assert [
        operator["kind"] for operator in explanation["logical_plan"]["operators"]
    ] == [
        "authority_scan",
        "temporal_match",
        "limit",
        "project",
        "evidence",
    ]
    result = storage_service.fact_query_definition(runtime_dir, definition)
    assert result["result_schema"]["schema"] == ("kungfu.query.temporal-match-row/v1")
    assert len(result["rows"]) == 1
    match = result["rows"][0]
    assert match["partition_key"] == "buildchain-feature-42"
    assert match["repeat_count"] == 2
    assert match["matched_episode_ids"] == [1, 2, 3, 4]
    assert match["attribution_counts"] == {
        "feature-agent": 2,
        "release-infra": 2,
    }
    assert match["attention_required"] is True
    assert result["lineage"]["canonical_state"] is True

    sql = """SELECT * FROM episodes MATCH_RECOGNIZE (
      PARTITION BY source ORDER BY begin_time ASC
      PATTERN ((A B){2,8})
      DEFINE A AS title = 'alpha_published', B AS title = 'gate_failed'
      WITHIN 1000 AS OF 2000 ABSENT title = 'stable_published'
    ) LIMIT 10"""
    compilation = storage_service.compile_fact_query_sql(
        runtime_dir,
        sql=sql,
        definition=storage_service.build_fact_query_definition(limit=10),
    )
    assert compilation["definition"] == plan["definition"]
    assert compilation["logical_plan_hash"] == plan["logical_plan_hash"]

    storage_service.episode_projection_rebuild(runtime_dir)
    conformance = storage_service.fact_query_conformance(runtime_dir, definition)
    assert conformance["ok"] is True

    snapshot = storage_service.fact_changelog(runtime_dir, definition)
    assert [message["type"] for message in snapshot["messages"]] == [
        "SnapshotBegin",
        "RowUpsert",
        "SnapshotEnd",
    ]
    steady = snapshot["resume_token"]
    storage_service.episode_begin(
        runtime_dir,
        episode_id=6,
        title="stable_published",
        actor="release-infra",
        source="buildchain-feature-42",
        begin_time=1500,
    )
    correction = storage_service.fact_changelog(
        runtime_dir, definition, resume_token=steady
    )
    assert [message["type"] for message in correction["messages"]] == [
        "RowRetract",
        "Progress",
    ]
    assert correction["messages"][0]["key"] == match["match_id"]
    assert correction["messages"][0]["evidence_ref"]["evidence_refs"]


def test_temporal_pattern_reuses_the_same_algebra_for_non_buildchain_work(tmp_path):
    runtime_dir = tmp_path / "runtime"
    for episode_id, title, actor, begin_time in [
        (10, "stage_started", "ingest-agent", 1000),
        (11, "validation_failed", "source-data", 1100),
        (12, "stage_started", "ingest-agent", 1200),
        (13, "validation_failed", "schema-drift", 1300),
    ]:
        storage_service.episode_begin(
            runtime_dir,
            episode_id=episode_id,
            title=title,
            actor=actor,
            source="corpus-import-7",
            begin_time=begin_time,
        )
    definition = storage_service.build_fact_query_definition(limit=10)
    definition["temporal_pattern"] = {
        "schema": "kungfu.query.temporal-pattern/v1",
        "partition_by": "source",
        "order_by": "begin_time",
        "sequence": [
            {"field": "title", "equals": "stage_started"},
            {"field": "title", "equals": "validation_failed"},
        ],
        "repeat": {"min": 2, "max": 4},
        "within_ns": "1000",
        "as_of_time": "2000",
        "absence": {"field": "title", "equals": "human_decision_required"},
    }

    result = storage_service.fact_query_definition(runtime_dir, definition)
    assert len(result["rows"]) == 1
    assert result["rows"][0]["partition_key"] == "corpus-import-7"
    assert result["rows"][0]["attribution_counts"] == {
        "ingest-agent": 2,
        "schema-drift": 1,
        "source-data": 1,
    }


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda pattern: pattern.pop("as_of_time"), "requires field: as_of_time"),
        (
            lambda pattern: pattern.update(repeat={"min": 0, "max": 2}),
            "1 <= min <= max <= 16",
        ),
        (
            lambda pattern: pattern.update(order_by="record_count"),
            "order_by must be begin_time or end_time",
        ),
        (
            lambda pattern: pattern["sequence"][0].update(field="private_field"),
            "unsupported Episode field",
        ),
    ],
)
def test_temporal_pattern_fails_closed_outside_bounded_algebra(
    tmp_path, mutation, message
):
    definition = storage_service.build_fact_query_definition()
    pattern = {
        "schema": "kungfu.query.temporal-pattern/v1",
        "partition_by": "source",
        "order_by": "begin_time",
        "sequence": [
            {"field": "title", "equals": "stage_started"},
            {"field": "title", "equals": "validation_failed"},
        ],
        "repeat": {"min": 2, "max": 4},
        "within_ns": "1000",
        "as_of_time": "2000",
    }
    mutation(pattern)
    definition["temporal_pattern"] = pattern
    with pytest.raises((RuntimeError, ValueError), match=message):
        storage_service.query_plan(tmp_path, action="validate", definition=definition)


def test_query_planner_normalizes_defaults_and_exposes_one_semantic_root(tmp_path):
    runtime_dir = tmp_path / "runtime"
    explicit = storage_service.build_fact_query_definition(episode_id=48, limit=10)
    sparse = {
        "schema": "kungfu.query.definition/v1",
        "basis": {
            "contract_world": explicit["basis"]["contract_world"],
            "fact_surfaces": explicit["basis"]["fact_surfaces"],
            "scope": "episode-manifest",
            "episode_id": "48",
            "perspective": "manifest-append-order",
            "cut": {"kind": "head"},
        },
        "object": "episodes",
        "limit": 10,
    }

    explicit_validation = storage_service.query_plan(
        runtime_dir, action="validate", definition=explicit
    )
    sparse_validation = storage_service.query_plan(
        runtime_dir, action="validate", definition=sparse
    )
    explanation = storage_service.query_plan(
        runtime_dir, action="explain", definition=sparse
    )
    capabilities = storage_service.query_plan(runtime_dir, action="capabilities")
    definition_schema = storage_service.query_plan(runtime_dir, action="schema")

    assert explicit_validation == sparse_validation
    assert explicit_validation["schema"] == "kungfu.query.validation/v1"
    assert explicit_validation["ok"] is True
    assert (
        explanation["logical_plan"]["logical_plan_hash"]
        == explicit_validation["logical_plan_hash"]
    )
    assert [
        operator["kind"] for operator in explanation["logical_plan"]["operators"]
    ] == [
        "authority_scan",
        "filter",
        "order",
        "limit",
        "project",
        "evidence",
    ]
    assert explanation["physical"]["engine"] == "episode-authority-scan/v1"
    assert capabilities["physical_plan"]["public"] is False
    assert capabilities["admission_outcomes"] == [
        "admitted",
        "unregistered-surface",
        "incompatible-schema",
        "ambiguous-authority",
        "unverifiable",
    ]
    assert capabilities["builtin_declarations"]["contract_world"]["reference"][
        "root"
    ].startswith("sha256:")
    assert capabilities["formats"] == ["json", "ndjson", "tsv"]
    assert capabilities["temporal_patterns"]["sequence_steps"] == 2
    assert capabilities["temporal_patterns"]["repeat"] == "1..16"
    assert definition_schema["$schema"].endswith("/draft/2020-12/schema")
    assert definition_schema["additionalProperties"] is False
    assert "temporal_pattern" in definition_schema["properties"]
    assert definition_schema["properties"]["basis"]["additionalProperties"] is False
    assert "contract_world" in definition_schema["properties"]["basis"]["required"]
    assert "fact_surfaces" in definition_schema["properties"]["basis"]["required"]
    assert (
        definition_schema["properties"]["basis"]["properties"]["contract_world"][
            "additionalProperties"
        ]
        is False
    )

    missing_declarations = json.loads(json.dumps(sparse))
    missing_declarations["basis"].pop("contract_world")
    missing_declarations["basis"].pop("fact_surfaces")
    with pytest.raises(
        (RuntimeError, ValueError),
        match="requires explicit contract_world and fact_surfaces declarations",
    ):
        storage_service.query_plan(
            runtime_dir, action="validate", definition=missing_declarations
        )

    unsupported = dict(sparse)
    unsupported["where"] = {"field": "status", "operator": "eq", "value": "ended"}
    with pytest.raises(
        (RuntimeError, ValueError), match="unsupported query field: definition.where"
    ):
        storage_service.query_plan(
            runtime_dir, action="validate", definition=unsupported
        )

    invalid_declaration = json.loads(json.dumps(explicit))
    invalid_declaration["basis"]["contract_world"] = {
        "id": "kungfu.runtime",
        "version": "1",
        "root": "sha256:" + "0" * 64,
        "latest": True,
    }
    with pytest.raises(
        (RuntimeError, ValueError),
        match="unsupported query field: definition.basis.contract_world.latest",
    ):
        storage_service.query_plan(
            runtime_dir, action="validate", definition=invalid_declaration
        )


def test_sql_frontend_and_sqlite_projection_conform_at_head_and_exact_cut(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(
        runtime_dir, episode_id=48, title="q2", begin_time=1000
    )
    storage_service.episode_attach_frame(
        runtime_dir,
        episode_id=48,
        frame_uid=4801,
        stream_id=48,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        data_length=8,
        integrity_version=2,
        payload_checksum=11,
        frame_checksum=22,
    )
    records = storage_service.episode_inspect(runtime_dir, episode_id=48)["records"]
    exact_cut = {
        "kind": "manifest_frame_uid",
        "manifest_frame_uid": str(records[-1]["manifest_frame_uid"]),
    }
    storage_service.episode_end(
        runtime_dir, episode_id=48, end_time=1200, frame_count=1, reason="done"
    )
    rebuilt = storage_service.episode_projection_rebuild(runtime_dir)
    journal_records = {
        item["table"]: item["count"] for item in rebuilt["journal_records"]
    }
    assert rebuilt["query_records"] == journal_records["episode_manifest_records"]

    head_definition = storage_service.build_fact_query_definition(
        episode_id=48, limit=10
    )
    sql = (
        "SELECT * FROM episodes WHERE episode_id = 48 ORDER BY episode_id ASC LIMIT 10"
    )
    compilation = storage_service.compile_fact_query_sql(
        runtime_dir, sql=sql, definition=storage_service.build_fact_query_definition()
    )
    direct_plan = storage_service.query_plan(
        runtime_dir, action="validate", definition=head_definition
    )
    assert compilation["logical_plan_hash"] == direct_plan["logical_plan_hash"]
    assert compilation["definition"] == direct_plan["definition"]

    head = storage_service.fact_query_conformance(runtime_dir, head_definition)
    historical = storage_service.fact_query_conformance(
        runtime_dir,
        storage_service.build_fact_query_definition(
            episode_id=48, cut=exact_cut, limit=10
        ),
    )
    missing_cut = storage_service.fact_query_conformance(
        runtime_dir,
        storage_service.build_fact_query_definition(
            episode_id=48,
            cut={
                "kind": "manifest_frame_uid",
                "manifest_frame_uid": "18446744073709551615",
            },
            limit=10,
        ),
    )
    changed_declaration = json.loads(json.dumps(head_definition))
    changed_declaration["basis"]["fact_surfaces"][0]["root"] = "sha256:" + "0" * 64
    rejected_basis = storage_service.fact_query_conformance(
        runtime_dir, changed_declaration
    )
    assert head["ok"] is True
    assert historical["ok"] is True
    assert missing_cut["ok"] is True
    assert rejected_basis["ok"] is True
    assert head["authority"]["lineage"]["execution"]["engine"] == (
        "episode-authority-scan/v1"
    )
    assert head["sqlite"]["lineage"]["execution"]["engine"] == (
        "episode-sqlite-projection/v1"
    )
    assert head["sqlite"]["lineage"]["execution"]["projection_verified"] is True
    assert head["checks"]["lineage_semantics"] is True
    assert historical["sqlite"]["rows"][0]["status"] == "open"
    assert head["sqlite"]["rows"][0]["status"] == "ended"
    assert missing_cut["sqlite"]["lineage"]["canonical_state"] is False
    assert (
        rejected_basis["sqlite"]["lineage"]["admission_outcomes"][0]["outcome"]
        == "unverifiable"
    )

    capabilities = storage_service.query_plan(runtime_dir, action="capabilities")
    assert capabilities["frontends"] == ["query-definition", "bounded-sql"]
    assert capabilities["sql"]["basis_owner"] == "QueryDefinition"
    assert capabilities["execution_engines"] == [
        "episode-authority-scan/v1",
        "episode-sqlite-projection/v1",
        "fact-authority-scan/v1",
    ]


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT episode_id FROM episodes",
        "SELECT * FROM episodes ORDER BY episode_id DESC",
        "SELECT * FROM episodes WHERE status = 'ended'",
        "SELECT * FROM episodes LIMIT 0",
        "SELECT * FROM episodes LIMIT 1001",
        "SELECT * FROM episodes; DROP TABLE episodes",
    ],
)
def test_sql_frontend_rejects_everything_outside_the_declared_subset(tmp_path, sql):
    with pytest.raises(
        (RuntimeError, ValueError), match="unsupported SQL|LIMIT must be between"
    ):
        storage_service.compile_fact_query_sql(
            tmp_path,
            sql=sql,
            definition=storage_service.build_fact_query_definition(),
        )


def test_sqlite_query_engine_fails_closed_when_projection_is_stale(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(runtime_dir, episode_id=1, begin_time=1000)
    storage_service.episode_projection_rebuild(runtime_dir)
    storage_service.episode_begin(runtime_dir, episode_id=2, begin_time=1100)

    with pytest.raises(
        (RuntimeError, ValueError), match="projection is absent or stale"
    ):
        storage_service.fact_query(runtime_dir, engine="sqlite")


# A well-formed digest whose bytes were never published: stage 4 resolves
# payload refs through the content store by hash, so "absent" must still be
# addressable to count as missing (a malformed hash is unaddressable instead).
_ABSENT_PAYLOAD_HASH = "sha256:" + hashlib.sha256(b"absent-payload").hexdigest()


def test_episode_fsck_reports_degraded_causal_dependencies(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.episode_begin(
        runtime_dir,
        episode_id=7,
        parent_episode_id=999,
        root_trigger_frame_uid=77,
        title="degraded episode",
        actor="pytest",
        source="unit-test",
        begin_time=1000,
    )
    storage_service.episode_attach_frame(
        runtime_dir,
        episode_id=7,
        frame_uid=101,
        trigger_frame_uid=77,
        stream_id=7,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=12,
        integrity_version=2,
        payload_checksum=123,
        frame_checksum=456,
    )
    storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=7,
        ref_kind="payload",
        ref_id="missing/payload.json",
        ref_hash=_ABSENT_PAYLOAD_HASH,
    )
    storage_service.episode_attach_ref(
        runtime_dir,
        episode_id=7,
        ref_kind="episode",
        ref_uid=998,
    )
    storage_service.episode_end(
        runtime_dir,
        episode_id=7,
        end_time=1200,
        last_frame_uid=101,
        frame_count=1,
        reason="done",
    )

    inspected = storage_service.episode_inspect(runtime_dir, episode_id=7)
    assert inspected["ok"]
    assert inspected["causal_graph"]["degraded"] is True
    assert {
        dependency["kind"] for dependency in inspected["causal_graph"]["dependencies"]
    } >= {
        "episode",
        "frame",
        "payload",
    }

    fsck = storage_service.fsck(runtime_dir, episode_id=7)
    # stage 4: the episode is sealed, so an unresolved payload ref falsifies
    # the seal (error/failed) instead of merely degrading it
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    assert fsck["degraded"] is True
    warning_codes = {
        issue["code"] for issue in fsck["issues"] if issue["severity"] == "warning"
    }
    assert "episode_dependency_missing" in warning_codes
    assert "episode_root_trigger_frame_missing" in warning_codes
    assert "episode_trigger_frame_missing" in warning_codes

    error_codes = {
        issue["code"] for issue in fsck["issues"] if issue["severity"] == "error"
    }
    assert "episode_payload_ref_missing" in error_codes

    bundle = storage_service.build_export_bundle(runtime_dir, episode_id=7)
    assert bundle["degraded"] is True
    assert bundle["causal_graph"]["degraded"] is True
    assert bundle["dependency_count"] == len(bundle["dependencies"])

    imported = storage_service.import_bundle(tmp_path / "imported-runtime", bundle)
    assert imported["schema"] == "kungfu.storage.episode-import/v1"
    assert imported["scope"] == "episode"
    assert imported["accepted"] is False
    assert imported["degraded"] is True
    assert imported["causal_graph"]["degraded"] is True
    assert imported["dependency_count"] == len(bundle["dependencies"])

    repair = storage_service.repair_plan(runtime_dir, episode_id=7, dry_run=True)
    assert repair["scope"] == 2
    assert repair["episode_id"] == 7
    assert repair["dry_run"] is True
    assert repair["plan_only"] is True
    assert repair["status"] == "failed"
    assert repair["degraded"] is True
    assert len(repair["candidates"]) >= 4
    candidate_codes = {candidate["code"] for candidate in repair["candidates"]}
    assert "repair_episode_dependency" in candidate_codes
    assert "repair_episode_root_trigger_frame" in candidate_codes
    assert "repair_episode_trigger_frame" in candidate_codes
    assert "repair_episode_payload_ref" in candidate_codes
    assert {candidate["kind"] for candidate in repair["candidates"]} >= {
        "episode",
        "frame",
        "payload",
    }
    assert all(
        candidate["safe_to_apply"] is False for candidate in repair["candidates"]
    )

    donor_dir = runtime_dir / "remotes" / "donor" / "runtime"
    storage_service.episode_begin(
        donor_dir,
        episode_id=7,
        parent_episode_id=999,
        root_trigger_frame_uid=77,
        title="degraded episode",
        actor="pytest",
        source="unit-test",
        begin_time=1000,
    )
    storage_service.episode_attach_frame(
        donor_dir,
        episode_id=7,
        frame_uid=77,
        stream_id=7,
        gen_time=1050,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=8,
        integrity_version=2,
        payload_checksum=111,
        frame_checksum=222,
    )
    storage_service.episode_attach_frame(
        donor_dir,
        episode_id=7,
        frame_uid=101,
        trigger_frame_uid=77,
        stream_id=7,
        gen_time=1100,
        carrier_type=10803,
        source=1,
        dest=0,
        data_length=12,
        integrity_version=2,
        payload_checksum=123,
        frame_checksum=456,
    )
    storage_service.episode_attach_ref(
        donor_dir,
        episode_id=7,
        ref_kind="payload",
        ref_id="missing/payload.json",
        ref_hash=_ABSENT_PAYLOAD_HASH,
    )
    storage_service.episode_attach_ref(
        donor_dir,
        episode_id=7,
        ref_kind="episode",
        ref_uid=998,
    )
    storage_service.episode_end(
        donor_dir,
        episode_id=7,
        end_time=1200,
        last_frame_uid=101,
        frame_count=2,
        reason="done",
    )
    fetch_out = tmp_path / "episode-repair-material.json"
    fetched = storage_service.repair_fetch(
        runtime_dir, episode_id=7, out_path=fetch_out, dry_run=True
    )
    assert fetched["schema"] == "kungfu.storage.repair-fetch/v1"
    assert fetched["dry_run"] is True
    assert fetched["read_only"] is True
    assert fetched["written"] is True
    assert fetch_out.exists()
    assert fetched["matched_count"] >= 2
    assert fetched["material"]["schema"] == "kungfu.storage.repair-material/v1"
    assert fetched["material"]["episode_bundles"]
    assert any(
        row["evidence_source"] == "remote-mirror:donor" for row in fetched["matched"]
    )

    dry_apply = storage_service.repair_apply(
        runtime_dir, fetched["material"], episode_id=7, dry_run=True
    )
    assert dry_apply["schema"] == "kungfu.storage.repair-apply/v1"
    assert dry_apply["dry_run"] is True
    assert dry_apply["applied"] is False
    assert dry_apply["applied_count"] >= 1
    # still failed: the sealed episode's payload bytes are not in the store
    # (bundles carry manifest records, not payload bodies)
    assert storage_service.fsck(runtime_dir, episode_id=7)["status"] == "failed"

    applied = storage_service.repair_apply(
        runtime_dir, fetched["material"], episode_id=7, dry_run=False
    )
    assert applied["schema"] == "kungfu.storage.repair-apply/v1"
    assert applied["applied"] is True
    assert applied["applied_count"] >= 1
    repaired_warning_codes = {
        issue["code"]
        for issue in storage_service.fsck(runtime_dir, episode_id=7)["issues"]
        if issue["severity"] == "warning"
    }
    assert "episode_root_trigger_frame_missing" not in repaired_warning_codes
    assert "episode_trigger_frame_missing" not in repaired_warning_codes


def test_payload_fsck_verifies_versioned_frame_checksums(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    receipts = _action_receipts(source_records)
    payload_checksum = 1234
    frame_checksum = 5678
    for receipt in receipts.values():
        receipt.update(
            {
                "integrity_version": payloads.FRAME_INTEGRITY_VERSION_V2,
                "checksum_algorithm": payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C,
                "payload_checksum": payload_checksum,
                "frame_checksum": frame_checksum,
            }
        )
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-v2",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )

    report = payloads.fsck_import(
        store,
        action_frames=_action_frames_with_checksums(
            manifest, payload_checksum, frame_checksum
        ),
    )
    assert report["ok"]

    for receipt in receipts.values():
        receipt["integrity_version"] = payloads.FRAME_INTEGRITY_VERSION_V1
        receipt["checksum_algorithm"] = payloads.FRAME_CHECKSUM_ALGORITHM_FNV1A64
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-v1",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )
    report = payloads.fsck_import(
        store,
        action_frames=_action_frames_with_checksums(
            manifest, payload_checksum, frame_checksum
        ),
    )
    assert report["ok"]


def test_payload_fsck_rejects_unknown_or_mismatched_frame_checksum_metadata(
    tmp_path,
):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    receipts = _action_receipts(source_records)
    for receipt in receipts.values():
        receipt.update(
            {
                "integrity_version": payloads.FRAME_INTEGRITY_VERSION_V2,
                "checksum_algorithm": payloads.FRAME_CHECKSUM_ALGORITHM_FNV1A64,
                "payload_checksum": 1234,
                "frame_checksum": 5678,
            }
        )
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-mismatch",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )
    report = payloads.fsck_import(
        store, action_frames=_action_frames_with_checksums(manifest, 1234, 5678)
    )
    assert not report["ok"]
    assert any(
        error.get("field") == "checksum_algorithm"
        and error.get("expected") == payloads.FRAME_CHECKSUM_ALGORITHM_CRC32C
        for error in report["errors"]
    )

    for receipt in receipts.values():
        receipt["checksum_algorithm"] = "mystery64"
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-checksum-unknown",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
        action_receipts=receipts,
    )
    report = payloads.fsck_import(
        store, action_frames=_action_frames_with_checksums(manifest, 1234, 5678)
    )
    assert not report["ok"]
    assert any(
        error.get("field") == "checksum_algorithm"
        and error.get("actual") == "mystery64"
        for error in report["errors"]
    )


def test_payload_fsck_reports_missing_payload(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    (
        missions,
        goals,
        markers,
        source_records,
        _,
    ) = importer.read_control_plane_with_sources(str(repo))
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={
            "missions": len(missions),
            "goals": len(goals),
            "markers": len(markers),
        },
    )
    first = manifest["entries"][0]
    payloads.payload_path(store, first["payload_hash"]).unlink()

    report = payloads.fsck_import(store)

    assert not report["ok"]
    assert any(error["code"] == "payload_missing" for error in report["errors"])


def test_payload_fsck_rejects_missing_sync_root(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )
    del manifest["sync_root"]
    payloads.latest_manifest_path(store).write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    report = payloads.fsck_import(store)

    assert not report["ok"]
    assert any(error["code"] == "sync_root_missing" for error in report["errors"])


def test_payload_fsck_rejects_sync_root_entry_mutation(tmp_path):
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))
    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-test",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )
    manifest["entries"][0]["source_path"] = "tampered.json"
    payloads.latest_manifest_path(store).write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    report = payloads.fsck_import(store)

    assert not report["ok"]
    assert any(
        error["code"] == "sync_root_mismatch" and error["field"] == "value"
        for error in report["errors"]
    )


def test_source_range_builder_supports_relative_since():
    window = source_store.build_range_filter(
        since="3d",
        now=datetime(2026, 7, 8, 12, 0, 0, tzinfo=timezone.utc),
    )

    assert window == {"since": "2026-07-05T12:00:00Z"}


def test_generic_storage_service_handles_non_atlas_source_bundle(tmp_path):
    runtime_dir = tmp_path / "runtime"
    accepted = storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            },
            {
                "kind": "note",
                "source_id": "note-b",
                "source_path": "notes/b.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload": {"title": "B", "body": "beta"},
            },
        ],
    )

    assert accepted["schema"] == "kungfu.storage.import-manifest/v1"
    assert accepted["source_id"] == "local-synth"
    assert accepted["accepted_ranges"][0]["status"] == "ok"
    assert len(accepted["payload_inventory"]["entries"]) == 2
    assert storage_service.status(runtime_dir, source_id="local-synth")["ok"]
    fsck = storage_service.fsck(runtime_dir, source_id="local-synth")
    assert fsck["ok"]
    assert fsck["checked"]["sources"] == 1
    assert fsck["checked"]["manifests"] == 1
    assert fsck["checked"]["payloads"] == 2

    exported = storage_service.export_records(
        runtime_dir,
        source_id="local-synth",
        range_filter={"since": "2026-07-09T00:00:00Z"},
    )
    assert [row["source_id"] for row in exported] == ["note-b"]
    bundle = storage_service.build_export_bundle(runtime_dir, source_id="local-synth")
    assert bundle["schema"] == "kungfu.storage.export-bundle/v1"
    assert len(bundle["records"]) == 2

    range_bundle = storage_service.build_export_bundle(
        runtime_dir,
        source_id="local-synth",
        range_filter={"since": "2026-07-09T00:00:00Z"},
    )
    assert len(range_bundle["manifest"]["entries"]) == 1
    assert len(range_bundle["records"]) == 1

    imported_runtime = tmp_path / "imported-runtime"
    import_result = storage_service.import_bundle(imported_runtime, bundle)
    assert import_result == {
        "ok": True,
        "scope": "source",
        "source_id": "local-synth",
        "manifest_id": "imp-synth",
        "records": 2,
    }
    assert storage_service.fsck(imported_runtime, source_id="local-synth")["ok"]

    imported_range_runtime = tmp_path / "imported-range-runtime"
    range_import = storage_service.import_bundle(imported_range_runtime, range_bundle)
    assert range_import["records"] == 1
    assert storage_service.fsck(imported_range_runtime, source_id="local-synth")["ok"]


def test_runtime_storage_service_operations_own_file_provider(tmp_path):
    runtime_dir = tmp_path / "runtime"
    storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )

    runtime = kungfu.__binding__.runtime
    status = runtime.run_storage_service_operation(
        "status",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert status["ok"]
    assert status["source_status"][0]["source_id"] == "local-synth"

    fsck = runtime.run_storage_service_operation(
        "fsck",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert fsck["ok"]
    assert fsck["checked"]["payloads"] == 1

    bundle = runtime.run_storage_service_operation(
        "export_bundle",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert bundle["schema"] == "kungfu.storage.export-bundle/v1"
    assert len(bundle["records"]) == 1

    imported_runtime = tmp_path / "imported-runtime"
    imported = runtime.run_storage_service_operation(
        "import_bundle",
        str(imported_runtime),
        {"scope": "source", "source_id": "local-synth", "bundle": bundle},
    )
    assert imported["ok"]
    assert imported["records"] == 1

    verify = runtime.run_storage_service_operation(
        "verify_sync",
        str(imported_runtime),
        {"scope": "source", "source_id": "local-synth"},
    )
    assert verify["ok"]
    assert verify["sync_roots_match"]
    assert verify["local_sync_root"] == bundle["sync_root"]
    assert verify["imported_sync_root"] == bundle["sync_root"]


def test_storage_maintenance_rebuild_gc_compact_and_sync_check(tmp_path):
    runtime_dir = tmp_path / "runtime"
    accepted = storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload": {"title": "A", "body": "alpha"},
            }
        ],
    )
    status = storage_service.status(runtime_dir, source_id="local-synth")
    assert status["source_status"][0]["accepted_cursor"]["source_head"] == "head-1"
    assert status["source_status"][0]["sync_root"] == {
        "algorithm": accepted["sync_root"]["algorithm"],
        "value": accepted["sync_root"]["value"],
    }
    # The JSON-as-contract artifacts are retired (KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 final slice): no
    # sources.json registry and no per-source manifest files — the journals
    # are the authority.
    assert not (runtime_dir / "storage" / "sources.json").exists()
    assert not (runtime_dir / "storage" / "sources").exists()

    dry_rebuild = storage_service.rebuild_index(
        runtime_dir, source_id="local-synth", dry_run=True
    )
    assert dry_rebuild["ok"]
    assert dry_rebuild["would_write"]
    assert not (runtime_dir / "storage/projections/manifest-catalog.sqlite").exists()

    rebuild = storage_service.rebuild_index(runtime_dir, source_id="local-synth")
    assert rebuild["ok"]
    assert rebuild["written"]
    catalog_projection = next(
        row
        for row in rebuild["projections"]
        if row["name"] == "manifest-catalog-sqlite"
    )
    assert catalog_projection["written"] is True
    catalog_rows = {
        row["table"]: row["count"] for row in catalog_projection["detail"]["rows"]
    }
    assert catalog_rows["import_manifest_accepted"] == 1
    assert catalog_rows["manifest_entry_recorded"] == 1
    assert catalog_rows["channel_cursor_updated"] == 1
    sqlite_path = runtime_dir / "storage/projections/manifest-catalog.sqlite"
    assert sqlite_path.exists()
    with sqlite3.connect(sqlite_path) as db:
        tables = {
            row[0]
            for row in db.execute("select name from sqlite_master where type = 'table'")
        }
        assert {
            "ImportManifestAccepted",
            "ManifestEntryRecorded",
            "ExportBundleRecorded",
            "ChannelCursorUpdated",
        } <= tables
        assert (
            db.execute("select count(*) from ImportManifestAccepted").fetchone()[0] == 1
        )
    assert storage_service.status(runtime_dir, source_id="local-synth")["ok"]
    status = storage_service.status(runtime_dir, source_id="local-synth")
    status_catalog = next(
        row for row in status["projections"] if row["name"] == "manifest-catalog-sqlite"
    )
    assert status_catalog["verification"]["projection_present"] is True
    assert status_catalog["verification"]["status"] == "ok"

    orphan_raw = b'{"orphan":true}'
    orphan_hash = payloads.payload_hash(orphan_raw)
    storage_service.write_payload_bytes(runtime_dir, orphan_hash, orphan_raw)
    gc = storage_service.gc_plan(runtime_dir, dry_run=True)
    assert len(gc["candidates"]) == 1
    assert gc["candidates"][0]["payload_hash"] == orphan_hash
    assert gc["candidates"][0]["safe_to_delete"] is True
    assert storage_service.payload_path(runtime_dir, orphan_hash).exists()

    compact = storage_service.compact_plan(runtime_dir, dry_run=True)
    assert compact["ok"]
    assert len(compact["gc"]["candidates"]) == 1
    assert compact["projection_compact"]["name"] == "manifest-catalog-sqlite"
    assert compact["projection_compact"]["action"] == "rebuild-and-vacuum"
    assert any(row["name"] == "backend-compact" for row in compact["unsupported"])

    fsck = storage_service.fsck(runtime_dir)
    assert fsck["ok"]
    assert fsck["checked"]["projection_indexes"] == 2
    assert fsck["checked"]["manifests"] == 1
    assert fsck["checked"]["entries_documents"] == 1
    assert fsck["checked"]["orphan_payloads"] == 1
    assert any(issue["code"] == "orphan_payload" for issue in fsck["issues"])

    sync_check = storage_service.verify_local_sync(runtime_dir, source_id="local-synth")
    assert sync_check["ok"]
    assert sync_check["sync_roots_match"]
    assert sync_check["exported_records"] == 1
    assert sync_check["local_sync_root"] == accepted["sync_root"]
    assert sync_check["imported_sync_root"] == accepted["sync_root"]


def test_atlas_import_persists_generic_source_manifest(tmp_path):
    repo = tmp_path / "atlas"
    runtime_dir = tmp_path / "runtime"
    _atlas_fixture(repo)

    result = source_store.add_source(
        runtime_dir,
        source_id="atlas-local",
        source_type="atlas",
        repo=str(repo),
    )
    # add_source registers into the source-registry kernel journal; the
    # storage_record is that journal's fold edge (KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5).
    assert result["storage_record"]["registered"] is True
    assert result["storage_record"]["registration"]["source_id"] == "atlas-local"
    assert result["storage_record"]["registration"]["kind"] == 4

    sync = source_store.sync_source(runtime_dir, "atlas-local")
    assert sync["ok"]
    generic = storage_service.load_latest_manifest(runtime_dir, "atlas-local")
    assert generic is not None
    assert generic["schema"] == "kungfu.storage.import-manifest/v1"
    assert generic["scope"] == "atlas"
    assert len(generic["payload_inventory"]["entries"]) == 3

    source_fsck = source_store.fsck_source(runtime_dir, "atlas-local")
    assert source_fsck["ok"]
    assert source_fsck["storage"]["ok"]


def test_storage_fsck_reports_degraded_status_for_recorded_payload_states(tmp_path):
    runtime_dir = tmp_path / "runtime"
    # The repairable scenario: the manifest honestly records the body missing,
    # while a copy still exists in the local store (lost and found). Producers
    # never serialize non-present bodies, so the material is seeded explicitly.
    lost_raw = payloads.canonical_json_bytes({"body": "lost"})
    lost_hash = payloads.payload_hash(lost_raw)
    storage_service.write_payload_bytes(runtime_dir, lost_hash, lost_raw)
    storage_service.write_synthetic_source(
        runtime_dir,
        source_id="degraded-synth",
        manifest_id="imp-degraded",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-present",
                "source_path": "notes/p.json",
                "source_time": "2026-07-07T00:00:00Z",
                "payload": {"body": "present"},
            },
            {
                "kind": "note",
                "source_id": "note-missing",
                "source_path": "notes/m.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload_hash": lost_hash,
                "byte_len": len(lost_raw),
                "payload_state": "missing",
            },
            {
                "kind": "note",
                "source_id": "note-redacted",
                "source_path": "notes/r.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload_state": "redacted",
            },
        ],
    )

    report = storage_service.fsck(runtime_dir, source_id="degraded-synth")
    # A recorded-missing payload is incomplete, not corrupt: ok stays true, but the
    # tri-state verdict degrades so the loss is not hidden under ok=true. A redacted
    # body is an intentional withholding and does not degrade the verdict.
    assert report["ok"]
    assert report["status"] == "degraded"
    withheld = {
        issue["detail"]["subject"]: (
            issue["detail"]["state"],
            issue["detail"]["intentional"],
        )
        for issue in report["issues"]
        if issue["code"] == "payload_not_present"
    }
    assert withheld["note:note-missing"] == ("missing", False)
    assert withheld["note:note-redacted"] == ("redacted", True)

    repair = storage_service.repair_plan(
        runtime_dir, source_id="degraded-synth", dry_run=True
    )
    assert repair["status"] == "degraded"
    assert len(repair["candidates"]) == 1
    assert repair["candidates"][0]["code"] == "repair_source_payload"
    assert repair["candidates"][0]["subject"]["subject"] == "note:note-missing"
    assert repair["candidates"][0]["subject"]["payload_hash"]

    fetch_out = tmp_path / "source-repair-material.json"
    fetched = storage_service.repair_fetch(
        runtime_dir, source_id="degraded-synth", out_path=fetch_out, dry_run=True
    )
    assert fetched["schema"] == "kungfu.storage.repair-fetch/v1"
    assert fetched["ok"]
    assert fetched["written"] is True
    assert fetch_out.exists()
    assert fetched["matched_count"] == 1
    assert fetched["material"]["source_bundles"]

    dry_apply = storage_service.repair_apply(
        runtime_dir, fetched["material"], source_id="degraded-synth", dry_run=True
    )
    assert dry_apply["schema"] == "kungfu.storage.repair-apply/v1"
    assert dry_apply["dry_run"] is True
    assert dry_apply["applied"] is False
    assert dry_apply["applied_count"] >= 1
    assert (
        storage_service.fsck(runtime_dir, source_id="degraded-synth")["status"]
        == "degraded"
    )

    applied = storage_service.repair_apply(
        runtime_dir, fetched["material"], source_id="degraded-synth", dry_run=False
    )
    assert applied["applied"] is True
    assert applied["applied_count"] >= 1
    repaired = storage_service.fsck(runtime_dir, source_id="degraded-synth")
    assert repaired["ok"]
    assert repaired["status"] == "ok"
    warning_subjects = {
        issue["detail"]["subject"]
        for issue in repaired["issues"]
        if issue["code"] == "payload_not_present"
    }
    assert "note:note-missing" not in warning_subjects

    # A fully present source verifies as ok with an ok verdict.
    healthy_dir = tmp_path / "healthy"
    storage_service.write_synthetic_source(
        healthy_dir,
        source_id="healthy-synth",
        records=[
            {
                "kind": "note",
                "source_id": "note-a",
                "source_path": "notes/a.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload": {"body": "a"},
            }
        ],
    )
    healthy = storage_service.fsck(healthy_dir, source_id="healthy-synth")
    assert healthy["ok"]
    assert healthy["status"] == "ok"


def test_payload_state_producer_export_import_round_trip(tmp_path):
    # Producer contract (KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de security boundary over the KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 record
    # face): redacted/absent bodies are never stored or read, missing exports
    # its honest gap, and all four states survive a cross-store round trip
    # with the sync root intact.
    runtime_a = tmp_path / "runtime-a"
    redacted_hash = payloads.payload_hash(b"sensitive-material-never-stored")
    accepted = storage_service.write_synthetic_source(
        runtime_a,
        source_id="four-state",
        manifest_id="imp-four-state",
        source_head="head-1",
        records=[
            {
                "kind": "note",
                "source_id": "note-present",
                "source_path": "notes/p.json",
                "source_time": "2026-07-07T00:00:00Z",
                "payload": {"body": "public"},
            },
            {
                "kind": "note",
                "source_id": "note-redacted",
                "source_path": "notes/r.json",
                "source_time": "2026-07-08T00:00:00Z",
                "payload_hash": redacted_hash,
                "byte_len": 32,
                "payload_state": "redacted",
            },
            {
                "kind": "note",
                "source_id": "note-absent",
                "source_path": "notes/a.json",
                "source_time": "2026-07-09T00:00:00Z",
                "payload_state": "absent",
            },
            {
                "kind": "note",
                "source_id": "note-missing",
                "source_path": "notes/m.json",
                "source_time": "2026-07-10T00:00:00Z",
                "payload_state": "missing",
            },
        ],
    )
    states = {
        entry["source_id"]: entry["payload_state"] for entry in accepted["entries"]
    }
    assert states == {
        "note-present": "present",
        "note-redacted": "redacted",
        "note-absent": "absent",
        "note-missing": "missing",
    }
    by_id = {entry["source_id"]: entry for entry in accepted["entries"]}
    # redacted may carry the pre-withholding identity; absent carries none
    assert by_id["note-redacted"]["payload_hash"] == redacted_hash
    assert by_id["note-absent"]["payload_hash"] == ""
    # no body ever lands in the store for withheld states
    assert not storage_service.payload_path(runtime_a, redacted_hash).exists()

    report = storage_service.fsck(runtime_a, source_id="four-state")
    assert report["ok"]
    assert report["status"] == "degraded"  # only the missing body degrades
    withheld = {
        issue["detail"]["subject"]: issue["detail"]["intentional"]
        for issue in report["issues"]
        if issue["code"] == "payload_not_present"
    }
    assert withheld == {
        "note:note-redacted": True,
        "note:note-absent": True,
        "note:note-missing": False,
    }

    bundle = storage_service.build_export_bundle(runtime_a, source_id="four-state")
    exported = {row["source_id"]: row for row in bundle["records"]}
    assert exported["note-present"]["payload"] == {"body": "public"}
    assert exported["note-redacted"]["payload"] is None
    assert exported["note-absent"]["payload"] is None
    assert exported["note-missing"]["payload"] is None
    assert exported["note-redacted"]["payload_state"] == "redacted"

    runtime_b = tmp_path / "runtime-b"
    imported = storage_service.import_bundle(runtime_b, bundle)
    assert imported["ok"]
    manifest_a = storage_service.load_latest_manifest(runtime_a, "four-state")
    manifest_b = storage_service.load_latest_manifest(runtime_b, "four-state")
    assert manifest_a["sync_root"] == manifest_b["sync_root"]
    report_b = storage_service.fsck(runtime_b, source_id="four-state")
    assert report_b["ok"]
    assert report_b["status"] == "degraded"

    verify = storage_service.verify_local_sync(runtime_b, source_id="four-state")
    assert verify["ok"]
    assert verify["sync_roots_match"]


def test_atlas_producer_enrich_and_write_honor_withheld_states(tmp_path):
    store = tmp_path / "store"
    redacted_hash = payloads.payload_hash(b"secret-source-body")
    records = [
        {
            "kind": "goal",
            "source_id": "goal-open",
            "source_path": "goals/open.json",
            "source_time": "2026-07-09T00:00:00Z",
            "schema_version": 1,
            "payload": {"goal_id": "goal-open", "title": "open"},
        },
        {
            "kind": "goal",
            "source_id": "goal-secret",
            "source_path": "goals/secret.json",
            "source_time": "2026-07-09T01:00:00Z",
            "schema_version": 1,
            "payload_state": payloads.PAYLOAD_STATE_REDACTED,
            "payload_hash": redacted_hash,
            "byte_len": 18,
        },
        {
            "kind": "marker",
            "source_id": "marker-gone",
            "source_path": "markers/gone.json",
            "source_time": "2026-07-09T02:00:00Z",
            "schema_version": 1,
            "payload_state": payloads.PAYLOAD_STATE_ABSENT,
        },
    ]

    enriched = payloads.enrich_source_records(records)
    by_id = {row["source_id"]: row for row in enriched}
    assert "payload" not in by_id["goal-secret"]
    assert "payload" not in by_id["marker-gone"]
    assert by_id["goal-secret"]["payload_hash"] == redacted_hash
    assert by_id["marker-gone"]["payload_hash"] == ""
    assert by_id["marker-gone"]["byte_len"] == 0

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-withheld",
        repo_root=str(tmp_path),
        repo_head="head-1",
        source_records=enriched,
        counts={},
    )
    states = {
        entry["source_id"]: entry["payload_state"] for entry in manifest["entries"]
    }
    assert states["goal-secret"] == "redacted"
    assert states["marker-gone"] == "absent"
    # the withheld body never lands in the adapter store either
    assert not payloads.payload_path(store, redacted_hash).exists()

    report = payloads.fsck_import(store)
    assert report["ok"]
    warned = {
        (warning["kind"], warning["source_id"])
        for warning in report["warnings"]
        if warning["code"] == "payload_not_present"
    }
    assert ("goal", "goal-secret") in warned
    assert ("marker", "marker-gone") in warned

    exported = payloads.export_records(store)
    rows = {row["source_id"]: row for row in exported}
    assert rows["goal-open"]["payload"] == {"goal_id": "goal-open", "title": "open"}
    assert rows["goal-secret"]["payload"] is None
    assert rows["marker-gone"]["payload"] is None


def test_atlas_producer_normalizes_missing_source_time_for_typed_sync_root(tmp_path):
    [entry] = payloads.enrich_source_records(
        [
            {
                "kind": "goal",
                "source_id": "goal-without-time",
                "source_path": "goals/without-time.json",
                "schema_version": 1,
                "payload": {"goal_id": "goal-without-time"},
            }
        ]
    )

    assert entry["source_time"] == ""
    manifest = payloads.write_import_payloads(
        tmp_path / "store",
        import_id="imp-without-time",
        repo_root=str(tmp_path),
        repo_head="head-1",
        source_records=[entry],
        counts={},
    )
    accepted = storage_service.accept_manifest(
        tmp_path / "runtime", manifest["storage_manifest"]
    )
    assert accepted["sync_root"] == manifest["sync_root"]


def test_source_registry_records_round_trip_through_journal(tmp_path):
    # KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5: source-registry records are Hana-core kernel metadata written to
    # an append-only yijinjing journal; JSON is only an edge projection. This
    # drives the runtime service surface end to end and asserts the journal
    # (not any JSON file) is the authority.
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)

    registered = runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {
            "source_id": "atlas-local",
            "kind": "adapter",
            "coordinate": "/repo/atlas",
            "head": "head-0",
            "register_time": 1000,
        },
    )
    assert registered["record_kind"] == "source_registered"
    assert registered["source_id"] == "atlas-local"
    assert registered["kind"] == "adapter"
    source_uid = registered["source_uid"]
    assert source_uid != 0

    # A second, independent source proves per-source folding.
    runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {"source_id": "runtime-b", "kind": "kungfu_runtime", "register_time": 1001},
    )

    # Head moves forward via an append-only delta record.
    updated = runtime.run_storage_service_operation(
        "source_update_head",
        runtime_dir,
        {
            "source_id": "atlas-local",
            "head": "head-1",
            "first_frame_uid": 10,
            "last_frame_uid": 42,
            "inventory_hash_algo": "sha256",
            "inventory_hash": "abc123",
            "update_time": 2000,
        },
    )
    assert updated["record_kind"] == "source_head_updated"
    assert updated["head"] == "head-1"

    accepted = runtime.run_storage_service_operation(
        "source_record_accepted_range",
        runtime_dir,
        {
            "source_id": "atlas-local",
            "manifest_id": "manifest-1",
            "first_frame_uid": 10,
            "last_frame_uid": 42,
            "status": "ok",
            "accept_time": 3000,
        },
    )
    assert accepted["record_kind"] == "accepted_range_recorded"
    assert accepted["manifest_id"] == "manifest-1"

    listed = runtime.run_storage_service_operation("source_list", runtime_dir, {})
    assert listed["ok"]
    assert listed["authority"] == "yijinjing-journal"
    assert listed["source_count"] == 2
    by_uid = {source["source_uid"]: source for source in listed["sources"]}
    folded = by_uid[source_uid]
    # Current view folds the latest head delta over the registration.
    assert folded["head"] == "head-1"
    assert folded["registered"] is True
    assert folded["accepted_range_count"] == 1

    inspected = runtime.run_storage_service_operation(
        "source_inspect", runtime_dir, {"source_id": "atlas-local"}
    )
    assert inspected["ok"]
    assert inspected["authority"] == "yijinjing-journal"
    assert len(inspected["accepted_ranges"]) == 1
    assert inspected["accepted_ranges"][0]["manifest_id"] == "manifest-1"

    fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert fsck["ok"]
    assert fsck["status"] == "ok"
    assert fsck["authority"] == "yijinjing-journal"
    assert fsck["checked"]["sources"] == 2

    # Authority is the append-only journal, not a JSON registry file. The legacy
    # JSON registry path (storage/sources.json) is not what these records use.
    assert not (tmp_path / "storage" / "sources.json").exists()


def test_source_registry_fsck_flags_dangling_head_without_registration(tmp_path):
    # A head update for a source that was never registered is dangling producer
    # output; fsck must record it honestly rather than silently dropping it.
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)

    runtime.storage_source_update_head_typed(
        runtime_dir,
        "ghost",
        head="h",
        update_time=5000,
    )
    inspected = runtime.storage_source_inspect_typed(runtime_dir, "ghost")
    fsck = runtime.storage_source_registry_fsck_typed(runtime_dir)
    assert inspected["source"]["registered"] is False
    assert inspected["source"]["current_head"] == "h"
    assert fsck["ok"] is False
    assert fsck["status"] == "failed"
    assert any(
        err["code"] == "source_registration_missing"
        for err in fsck["journal"]["errors"]
    )


def test_source_registry_sqlite_projection_rebuilds_from_journal(tmp_path):
    # KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 slice 2: the source-registry journal projects to a rebuildable
    # SQLite cache via the compile-time Hana -> SQLite path. The journal stays
    # the authority; the projection is derived and fsck verifies it against the
    # journal fold.
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)

    runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {"source_id": "atlas-local", "kind": "adapter", "register_time": 1000},
    )
    runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {"source_id": "runtime-b", "kind": "kungfu_runtime", "register_time": 1001},
    )
    runtime.run_storage_service_operation(
        "source_update_head",
        runtime_dir,
        {"source_id": "atlas-local", "head": "h1", "update_time": 2000},
    )
    runtime.run_storage_service_operation(
        "source_record_accepted_range",
        runtime_dir,
        {"source_id": "atlas-local", "manifest_id": "m1", "accept_time": 3000},
    )

    projection_db = tmp_path / "storage" / "projections" / "source-registry.sqlite"

    # Before any rebuild, fsck honestly reports the projection is absent (records
    # exist but no projection is built) without failing the journal check.
    pre = runtime.run_storage_service_operation("source_registry_fsck", runtime_dir, {})
    assert pre["ok"]
    assert pre["projection"]["projection_present"] is False
    assert pre["projection"]["status"] == "absent"
    assert not projection_db.exists()

    rebuilt = runtime.run_storage_service_operation(
        "source_registry_rebuild", runtime_dir, {}
    )
    assert rebuilt["ok"]
    assert rebuilt["authority"] == "yijinjing-journal"
    assert rebuilt["rows"] == {
        "source_registered": 2,
        "source_head_updated": 1,
        "accepted_range_recorded": 1,
    }
    assert projection_db.exists()

    # The projection is a real, query-able SQLite database with typed tables
    # derived straight from the POD records. The kind column holds the POD enum
    # value (SourceKind::Adapter == 4, KungfuRuntime == 3), not the JSON edge
    # name — the projection mirrors the kernel record, the same way the profile /
    # session / state caches store their enums as integers.
    with sqlite3.connect(projection_db) as conn:
        registered = conn.execute(
            "SELECT source_id, kind FROM SourceRegistered ORDER BY source_id"
        ).fetchall()
    assert registered == [("atlas-local", 4), ("runtime-b", 3)]

    post = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert post["ok"]
    assert post["status"] == "ok"
    assert post["projection"]["projection_present"] is True
    assert post["projection"]["status"] == "ok"
    assert post["projection"]["rows"] == {
        "source_registered": 2,
        "source_head_updated": 1,
        "accepted_range_recorded": 1,
    }


def test_source_registry_projection_fsck_detects_drift(tmp_path):
    # A projection that has fallen behind the journal is degraded, not failed:
    # the journal is intact, the derived cache just needs a rebuild.
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)

    runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {"source_id": "s1", "register_time": 1000},
    )
    runtime.run_storage_service_operation("source_registry_rebuild", runtime_dir, {})

    # New journal record after the rebuild: projection now lags the journal.
    runtime.run_storage_service_operation(
        "source_register",
        runtime_dir,
        {"source_id": "s2", "register_time": 1001},
    )

    fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert fsck["ok"] is False
    assert fsck["status"] == "degraded"
    projection = fsck["projection"]
    assert projection["status"] == "degraded"
    assert projection["degraded"] is True
    drift = {row["table"]: row for row in projection["drift"]}
    assert drift["source_registered"]["projection_rows"] == 1
    assert drift["source_registered"]["journal_distinct"] == 2

    # Rebuilding reconciles the projection back to the journal.
    runtime.run_storage_service_operation("source_registry_rebuild", runtime_dir, {})
    healed = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert healed["ok"]
    assert healed["projection"]["status"] == "ok"


def test_source_registry_projection_rebuild_rolls_back_as_one_transaction(tmp_path):
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)
    projection_db = tmp_path / "storage" / "projections" / "source-registry.sqlite"

    runtime.run_storage_service_operation(
        "source_register", runtime_dir, {"source_id": "s1", "register_time": 1000}
    )
    runtime.run_storage_service_operation("source_registry_rebuild", runtime_dir, {})
    with sqlite3.connect(projection_db) as conn:
        conn.execute(
            "CREATE TRIGGER reject_projection_replay "
            "BEFORE INSERT ON SourceRegistered "
            "BEGIN SELECT RAISE(ABORT, 'injected projection replay failure'); END"
        )
        assert conn.execute("SELECT source_id FROM SourceRegistered").fetchall() == [
            ("s1",)
        ]

    runtime.run_storage_service_operation(
        "source_register", runtime_dir, {"source_id": "s2", "register_time": 1001}
    )
    with pytest.raises(RuntimeError):
        runtime.run_storage_service_operation(
            "source_registry_rebuild", runtime_dir, {}
        )

    # DELETE and replay are in one transaction: the injected insert failure
    # cannot expose an empty or half-rebuilt projection to readers.
    with sqlite3.connect(projection_db) as conn:
        assert conn.execute("SELECT source_id FROM SourceRegistered").fetchall() == [
            ("s1",)
        ]
        conn.execute("DROP TRIGGER reject_projection_replay")

    runtime.run_storage_service_operation("source_registry_rebuild", runtime_dir, {})
    healed = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert healed["projection"]["status"] == "ok"
    assert healed["projection"]["rows"]["source_registered"] == 2


def test_source_registry_projection_fsck_detects_same_count_content_drift(tmp_path):
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)
    projection_db = tmp_path / "storage" / "projections" / "source-registry.sqlite"

    runtime.run_storage_service_operation(
        "source_register", runtime_dir, {"source_id": "s1", "register_time": 1000}
    )
    runtime.run_storage_service_operation("source_registry_rebuild", runtime_dir, {})
    with sqlite3.connect(projection_db) as conn:
        conn.execute("UPDATE SourceRegistered SET location_uid = location_uid + 1")

    fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    drift = {row["table"]: row for row in fsck["projection"]["drift"]}
    assert drift["source_registered"]["projection_rows"] == 1
    assert drift["source_registered"]["journal_distinct"] == 1
    assert drift["source_registered"]["reason"] == "content_mismatch"
    assert drift["source_registered"]["projection_digest"]
    assert drift["source_registered"]["journal_digest"]
    assert (
        drift["source_registered"]["projection_digest"]
        != drift["source_registered"]["journal_digest"]
    )


def test_source_registry_projection_fsck_does_not_create_missing_schema(tmp_path):
    runtime = kungfu.__binding__.runtime
    runtime_dir = str(tmp_path)
    projection_db = tmp_path / "storage" / "projections" / "source-registry.sqlite"

    runtime.run_storage_service_operation(
        "source_register", runtime_dir, {"source_id": "s1", "register_time": 1000}
    )
    projection_db.parent.mkdir(parents=True)
    with sqlite3.connect(projection_db):
        pass

    fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    assert fsck["projection"]["status"] == "degraded"
    assert fsck["projection"]["drift"][0]["reason"] == "schema_unreadable"
    with sqlite3.connect(projection_db) as conn:
        assert (
            conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
            == []
        )


def test_manifest_projection_allows_export_lag_but_detects_export_corruption(tmp_path):
    runtime = kungfu.__binding__.runtime
    runtime_dir = tmp_path / "runtime"
    storage_service.write_synthetic_source(
        runtime_dir,
        source_id="local-synth",
        manifest_id="imp-synth",
        source_head="head-1",
        records=[],
    )
    storage_service.rebuild_index(runtime_dir, source_id="local-synth")

    # Export receipts are append-only read-path audit records, so a projection
    # captured before a later export remains a valid (stale) subset.
    runtime.run_storage_service_operation(
        "export_bundle",
        str(runtime_dir),
        {"scope": "source", "source_id": "local-synth"},
    )
    status = storage_service.status(runtime_dir, source_id="local-synth")
    manifest_projection = next(
        row for row in status["projections"] if row["name"] == "manifest-catalog-sqlite"
    )
    assert manifest_projection["verification"]["status"] == "ok"

    storage_service.rebuild_index(runtime_dir, source_id="local-synth")
    projection_db = runtime_dir / "storage/projections/manifest-catalog.sqlite"
    with sqlite3.connect(projection_db) as conn:
        conn.execute("UPDATE ExportBundleRecorded SET location_uid = location_uid + 1")

    status = storage_service.status(runtime_dir, source_id="local-synth")
    manifest_projection = next(
        row for row in status["projections"] if row["name"] == "manifest-catalog-sqlite"
    )
    drift = {row["table"]: row for row in manifest_projection["verification"]["drift"]}
    assert drift["export_bundle_recorded"]["reason"] == "content_mismatch"


def test_payload_bodies_are_opaque_content_addressed_bytes(tmp_path):
    # KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 point 6: payload bodies are opaque content-addressed bytes with no
    # format-implying extension. The body format is orthogonal to the record
    # schema; the manifest entry commits to the body by hash, length, and
    # content_type metadata, not by the file name.
    repo = tmp_path / "atlas"
    store = tmp_path / "store"
    _atlas_fixture(repo)
    _, _, _, source_records, _ = importer.read_control_plane_with_sources(str(repo))

    manifest = payloads.write_import_payloads(
        store,
        import_id="imp-opaque",
        repo_root=str(repo),
        repo_head="abc123",
        source_records=source_records,
        counts={"missions": 1, "goals": 1, "markers": 1},
    )

    entry = manifest["entries"][0]
    digest = entry["payload_hash"]
    body_path = store / "payloads" / digest[:2] / digest

    # The body is stored at the hash-addressed path with no extension...
    assert body_path.exists()
    assert body_path.suffix == ""
    # ...and the legacy .json-envelope path is gone.
    assert not (store / "payloads" / digest[:2] / f"{digest}.json").exists()

    # The stored bytes are exactly the opaque body, content-addressed: the file
    # name is the sha256 of its contents.
    raw = body_path.read_bytes()
    import hashlib

    assert hashlib.sha256(raw).hexdigest() == digest
    assert len(raw) == entry["byte_len"]

    # Format lives on the record as metadata, not in the file name.
    assert entry["content_type"] == payloads.CONTENT_TYPE_JSON

    # The runtime still verifies the body by hash + length regardless of naming.
    runtime = kungfu.__binding__.runtime
    assert runtime.verify_storage_payload(raw, digest, entry["byte_len"]) == ""


def test_assessment_job_is_durable_idempotent_and_does_not_mutate_work_episode(
    tmp_path,
):
    runtime_dir = tmp_path / "runtime"
    work_root = _sealed_work_episode(runtime_dir)
    work_before = storage_service.episode_inspect(runtime_dir, episode_id=5200)[
        "content_root"
    ]

    requested = storage_service.assessment_request(
        runtime_dir,
        _assessment_request(work_root),
        system_time=1200,
    )
    assert requested["state"] == "pending"
    assert requested["parent_episode_id"] == 5200
    assert requested["reused"] is False

    # A fresh edge call folds the journaled request, proving this is not an
    # in-memory callback or append-hot-path assessment.
    pending = storage_service.assessment_status(
        runtime_dir, requested["assessment_key"]
    )
    assert pending["found"] is True
    assert pending["state"] == "pending"
    timed_out = storage_service.trust_await(
        runtime_dir,
        requested["assessment_key"],
        purpose="release-gate",
        timeout_seconds=0,
    )
    assert timed_out["allowed"] is False
    assert timed_out["reason"] == "trust-timeout"
    assert (
        storage_service.episode_inspect(runtime_dir, episode_id=5200)["content_root"]
        == work_before
    )

    completed = storage_service.assessment_execute(
        runtime_dir,
        requested["assessment_key"],
        executor_profile="process",
        system_time=1300,
    )
    assert completed["state"] == "fresh"
    assert completed["execution"]["executor_profile"] == "process"
    assert completed["report"]["deterministic"] is True
    assert completed["report"]["report_hash"].startswith("sha256:")
    assert completed["parent_episode_id"] == 5200

    result_episode = storage_service.episode_inspect(
        runtime_dir, episode_id=completed["assessment_episode_id"]
    )
    request_episode = storage_service.episode_inspect(
        runtime_dir, episode_id=requested["assessment_episode_id"]
    )
    assert result_episode["episode"]["open"]["parent_episode_id"] == 5200
    assert result_episode["episode"]["open"]["source"] == (
        "adr-0052-assessment-runtime"
    )
    assert (
        result_episode["episode"]["open"]["location_uid"]
        != (request_episode["episode"]["open"]["location_uid"])
    )

    repeated = storage_service.assessment_execute(
        runtime_dir,
        requested["assessment_key"],
        executor_profile="thread",
        system_time=1400,
    )
    assert repeated["reused"] is True
    assert repeated["report"]["report_hash"] == completed["report"]["report_hash"]
    assert repeated["assessment_episode_id"] == completed["assessment_episode_id"]

    assert (
        storage_service.trust_require(
            runtime_dir, requested["assessment_key"], purpose="release-gate"
        )["allowed"]
        is True
    )
    assert storage_service.trust_require(
        runtime_dir, requested["assessment_key"], purpose="different-purpose"
    ) == {
        "schema": "kungfu.trust.assessment/v1",
        "allowed": False,
        "reason": "purpose-mismatch",
    }
    assert (
        storage_service.trust_require(
            runtime_dir, _sha256_root("missing-assessment"), purpose="release-gate"
        )["reason"]
        == "assessment-not-found"
    )


def test_assessment_request_rejects_a_claim_about_the_wrong_episode_root(tmp_path):
    runtime_dir = tmp_path / "runtime"
    work_root = _sealed_work_episode(runtime_dir)
    request = _assessment_request(work_root)
    request["work_episode_root"] = _sha256_root("not-the-sealed-episode")

    with pytest.raises(
        (RuntimeError, ValueError), match="does not match the sealed Episode"
    ):
        storage_service.assessment_request(runtime_dir, request, system_time=1200)


def test_assessment_process_and_thread_executors_have_identical_report_hashes(
    tmp_path,
):
    results = {}
    for executor_profile in ("process", "thread"):
        runtime_dir = tmp_path / executor_profile
        work_root = _sealed_work_episode(runtime_dir)
        requested = storage_service.assessment_request(
            runtime_dir,
            _assessment_request(work_root),
            system_time=1200,
        )
        if executor_profile == "process":
            child = subprocess.run(
                runtime_service.assessment_worker_command(
                    str(runtime_dir), requested["assessment_key"]
                ),
                check=False,
                capture_output=True,
                text=True,
                env=dict(os.environ),
            )
            assert child.returncode == 0, child.stderr
            results[executor_profile] = storage_service.assessment_status(
                runtime_dir, requested["assessment_key"]
            )
        else:
            results[executor_profile] = storage_service.assessment_execute(
                runtime_dir,
                requested["assessment_key"],
                executor_profile=executor_profile,
                system_time=1300,
            )

    assert results["process"]["assessment_key"] == results["thread"]["assessment_key"]
    assert results["process"]["report"] == results["thread"]["report"]
    assert (
        results["process"]["report"]["report_hash"]
        == results["thread"]["report"]["report_hash"]
    )
    assert results["process"]["execution"]["executor_profile"] == "process"
    assert results["thread"]["execution"]["executor_profile"] == "thread"
    assert results["process"]["execution"]["separate_thread_dispatch"] is False
    assert results["thread"]["execution"]["separate_thread_dispatch"] is True


def test_assessment_invalidation_is_precise_and_subscription_list_is_folded(
    tmp_path,
):
    runtime_dir = tmp_path / "runtime"
    work_root = _sealed_work_episode(runtime_dir)
    requested = storage_service.assessment_request(
        runtime_dir, _assessment_request(work_root), system_time=1200
    )
    storage_service.assessment_execute(
        runtime_dir, requested["assessment_key"], system_time=1300
    )

    irrelevant = storage_service.assessment_invalidate(
        runtime_dir,
        requested["assessment_key"],
        changed_root=_sha256_root("unrelated-fact-surface"),
        reason="unrelated evidence changed",
        system_time=1400,
    )
    assert irrelevant["invalidated"] is False
    assert irrelevant["relevant"] is False
    assert (
        storage_service.assessment_status(runtime_dir, requested["assessment_key"])[
            "state"
        ]
        == "fresh"
    )

    relevant = storage_service.assessment_invalidate(
        runtime_dir,
        requested["assessment_key"],
        changed_root=_sha256_root("release-facts"),
        reason="bound fact surface changed",
        system_time=1500,
    )
    assert relevant["invalidated"] is True
    assert relevant["relevant"] is True
    assert (
        storage_service.assessment_status(runtime_dir, requested["assessment_key"])[
            "state"
        ]
        == "stale"
    )

    listed = storage_service.assessment_list(runtime_dir)
    assert listed["assessment_count"] == 1
    assert listed["assessments"][0]["state"] == "stale"


@pytest.mark.parametrize(
    ("evidence", "expected_state"),
    [
        ({"canonical_fact_count": 0}, "insufficient-evidence"),
        ({"canonical_fact_count": 2, "conflict_count": 1}, "conflicted"),
        ({"canonical_fact_count": 2, "unverifiable_count": 1}, "unverifiable"),
    ],
)
def test_assessment_fails_closed_for_nonfresh_evidence(
    tmp_path, evidence, expected_state
):
    runtime_dir = tmp_path / expected_state
    work_root = _sealed_work_episode(runtime_dir)
    requested = storage_service.assessment_request(
        runtime_dir,
        _assessment_request(work_root, evidence=evidence),
        system_time=1200,
    )
    completed = storage_service.assessment_execute(
        runtime_dir,
        requested["assessment_key"],
        executor_profile="process",
        system_time=1300,
    )
    assert completed["state"] == expected_state
    gate = storage_service.trust_require(
        runtime_dir, requested["assessment_key"], purpose="release-gate"
    )
    assert gate["allowed"] is False
    assert gate["reason"] == "assessment-not-fresh"
