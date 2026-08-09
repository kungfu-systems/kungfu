# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle


def _sealed_episode(
    runtime_dir: Path, name: str, *, episode_id: int = 0
) -> RuntimeEpisodeLifecycle:
    lifecycle = RuntimeEpisodeLifecycle(
        runtime_dir=str(runtime_dir),
        namespace="agent",
        name=name,
        title=f"admission {name}",
        actor="pytest",
        source=f"admission-{name}",
        episode_id=episode_id,
    )
    lifecycle.record_event("test.step", b'{"step":1}', run_id="admission")
    lifecycle.close(ok=True)
    return lifecycle


def _declared_identity(value: str) -> dict:
    return {
        "schema": "kungfu.workspace.identity/v1",
        "kind": "declared",
        "id": value,
    }


def _event_journals(runtime_dir: Path) -> list[Path]:
    manifest_dir = runtime_dir / "journal/system/storage/episode-manifest/live"
    return [
        path
        for path in sorted(runtime_dir.glob("journal/**/*.journal"))
        if path.parent != manifest_dir
    ]


def test_local_direct_plan_is_read_only_and_execute_is_destination_owned(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    episode = _sealed_episode(source, "local")
    source_before = service.episode_list(source)

    plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        project_cut_roots=["sha256:" + "1" * 64],
    )

    assert plan["ok"] is True
    assert plan["dry_run"] is True
    assert plan["write_intent"] == {
        "destination_only": True,
        "episodes": 1,
        "git_mutation": False,
        "source_cleanup": False,
        "source_mutation": False,
    }
    assert plan["episodes"][0]["disposition"] == "missing"
    assert not (destination / "admission").exists()

    receipt = service.episode_admission(
        destination,
        action="execute",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        plan=plan,
        project_cut_roots=["sha256:" + "1" * 64],
    )

    assert receipt["ok"] is True, receipt
    assert receipt["status"] == "admitted"
    assert receipt["accepted_roots"] == [plan["episodes"][0]["root"]]
    assert receipt["git_side_effect"] is False
    assert receipt["source_cleanup"] is False
    assert service.episode_list(source) == source_before
    inspected = service.episode_admission(
        destination, action="inspect", plan_root=plan["plan_root"]
    )
    assert inspected["state"]["status"] == "admitted"
    assert inspected["receipt"]["destination_authority_proof"].startswith("sha256:")

    state_path = (
        destination
        / "admission"
        / f"{plan['plan_root'].removeprefix('sha256:')}.state.json"
    )
    interrupted_state = json.loads(state_path.read_text())
    interrupted_state["status"] = "interrupted"
    state_path.write_text(json.dumps(interrupted_state))
    resumed = service.episode_admission(
        destination,
        action="resume",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        plan_root=plan["plan_root"],
    )
    assert resumed["ok"] is True
    assert resumed["accepted_roots"] == [plan["episodes"][0]["root"]]
    assert resumed["already_present_roots"] == []

    repeated_plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        project_cut_roots=["sha256:" + "1" * 64],
    )
    assert repeated_plan["episodes"][0]["disposition"] == "already-present"
    repeated = service.episode_admission(
        destination,
        action="execute",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        plan=repeated_plan,
        project_cut_roots=["sha256:" + "1" * 64],
    )
    assert repeated["ok"] is True
    assert repeated["accepted_roots"] == []
    assert repeated["already_present_roots"] == [repeated_plan["episodes"][0]["root"]]


def test_push_pull_and_transports_preserve_episode_admission_truth(tmp_path):
    source = tmp_path / "source"
    episode = _sealed_episode(source, "transport")
    bundle = service.build_export_bundle(source, episode_id=episode.episode_id)

    pull = service.episode_admission(
        tmp_path / "pull-destination",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        initiator="destination-pull",
    )
    push = service.episode_admission(
        tmp_path / "push-destination",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        initiator="source-push",
    )
    bundle_destination = tmp_path / "bundle-destination"
    bundle_plan = service.episode_admission(
        bundle_destination,
        transport="bundle",
        episode_bundles=[bundle],
        source_identity=_declared_identity("source:test"),
    )
    remote_destination = tmp_path / "remote-destination"
    remote_plan = service.episode_admission(
        remote_destination,
        transport="remote-stream",
        episode_bundles=[bundle],
        source_identity=_declared_identity("source:test"),
    )

    expected = pull["episodes"]
    assert push["episodes"] == expected
    assert bundle_plan["episodes"] == expected
    assert remote_plan["episodes"] == expected
    assert {pull["initiator"], push["initiator"]} == {
        "destination-pull",
        "source-push",
    }
    assert {
        pull["transport"],
        bundle_plan["transport"],
        remote_plan["transport"],
    } == {"local-direct", "bundle", "remote-stream"}

    accepted = []
    for transport, destination, plan in [
        ("bundle", bundle_destination, bundle_plan),
        ("remote-stream", remote_destination, remote_plan),
    ]:
        receipt = service.episode_admission(
            destination,
            action="execute",
            transport=transport,
            episode_bundles=[bundle],
            source_identity=_declared_identity("source:test"),
            plan=plan,
        )
        assert receipt["ok"] is True, receipt
        assert receipt["transport_observation"]["truth_effect"] == "none"
        accepted.append(receipt["accepted_roots"])
    assert accepted == [[expected[0]["root"]], [expected[0]["root"]]]


def test_local_direct_admits_multiple_sealed_episodes_without_bundle_files(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    episodes = [_sealed_episode(source, name) for name in ("first", "second")]
    selected = [episode.episode_id for episode in episodes]

    plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=selected,
    )
    assert len(plan["episodes"]) == 2
    assert {row["disposition"] for row in plan["episodes"]} == {"missing"}
    receipt = service.episode_admission(
        destination,
        action="execute",
        source_runtime_dir=source,
        episode_ids=selected,
        plan=plan,
    )

    assert receipt["ok"] is True, receipt
    assert set(receipt["accepted_roots"]) == {row["root"] for row in plan["episodes"]}
    assert {
        row["episode_id"] for row in service.episode_list(destination)["episodes"]
    } == set(selected)


def test_execute_rejects_frontier_drift_before_writing_state(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    episode = _sealed_episode(source, "selected")
    plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
    )
    _sealed_episode(destination, "unrelated")

    receipt = service.episode_admission(
        destination,
        action="execute",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        plan=plan,
    )

    assert receipt["ok"] is False
    assert receipt["status"] == "interrupted"
    assert receipt["errors"] == [{"code": "admission_plan_drift"}]
    assert not (destination / "admission").exists()


def test_destination_conflict_is_explicit_and_never_overwritten(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source_episode = _sealed_episode(source, "source")
    _sealed_episode(destination, "different", episode_id=source_episode.episode_id)

    plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=[source_episode.episode_id],
    )
    assert plan["ok"] is False
    assert plan["episodes"][0]["disposition"] == "conflicted"

    receipt = service.episode_admission(
        destination,
        action="execute",
        source_runtime_dir=source,
        episode_ids=[source_episode.episode_id],
        plan=plan,
    )
    assert receipt["ok"] is False
    assert receipt["status"] == "conflicted"
    assert receipt["conflicted_roots"] == [plan["episodes"][0]["root"]]
    assert not (destination / "admission").exists()


def test_same_root_with_missing_destination_material_is_refused(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    episode = _sealed_episode(source, "source")
    plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
    )
    receipt = service.episode_admission(
        destination,
        action="execute",
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
        plan=plan,
    )
    assert receipt["ok"] is True

    journals = _event_journals(destination)
    assert journals
    for journal in journals:
        journal.unlink()

    damaged_plan = service.episode_admission(
        destination,
        source_runtime_dir=source,
        episode_ids=[episode.episode_id],
    )
    assert damaged_plan["ok"] is False
    assert damaged_plan["episodes"][0]["disposition"] == "refused"


def test_non_local_transport_requires_declared_source_identity(tmp_path):
    source = tmp_path / "source"
    episode = _sealed_episode(source, "identity")
    bundle = service.build_export_bundle(source, episode_id=episode.episode_id)

    with pytest.raises(Exception, match="source_identity is required"):
        service.episode_admission(
            tmp_path / "destination",
            transport="bundle",
            episode_bundles=[bundle],
        )


def test_bundle_transport_deduplicates_roots_and_rejects_id_conflicts(tmp_path):
    source = tmp_path / "source"
    first = _sealed_episode(source, "first")
    second = _sealed_episode(source, "second")
    first_bundle = service.build_export_bundle(source, episode_id=first.episode_id)
    second_bundle = service.build_export_bundle(source, episode_id=second.episode_id)
    identity = _declared_identity("source:test")

    plan = service.episode_admission(
        tmp_path / "deduplicated",
        transport="bundle",
        episode_bundles=[first_bundle, first_bundle],
        source_identity=identity,
    )
    assert len(plan["episodes"]) == 1

    conflicting_bundle = copy.deepcopy(second_bundle)
    conflicting_bundle["episode_id"] = str(first.episode_id)
    with pytest.raises(Exception, match="episode_bundle_duplicate_root_conflict"):
        service.episode_admission(
            tmp_path / "conflicted",
            transport="bundle",
            episode_bundles=[first_bundle, conflicting_bundle],
            source_identity=identity,
        )


@pytest.mark.parametrize(
    ("command", "initiator"),
    [("pull", "destination-pull"), ("push", "source-push")],
)
def test_workspace_cli_projects_the_same_admission_plan(tmp_path, command, initiator):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    episode = _sealed_episode(source, f"cli-{command}")

    result = CliRunner().invoke(
        kfc,
        [
            "workspace",
            command,
            "--source-runtime",
            str(source),
            "--destination-runtime",
            str(destination),
            "--episode-id",
            str(episode.episode_id),
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    plan = json.loads(result.output)
    assert plan["initiator"] == initiator
    assert plan["dry_run"] is True
    assert plan["episodes"][0]["disposition"] == "missing"
