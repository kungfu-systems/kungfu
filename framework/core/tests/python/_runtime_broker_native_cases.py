# SPDX-License-Identifier: Apache-2.0

import copy
import json
from pathlib import Path

import pytest

from kungfu import runtime_broker, runtime_state

from _runtime_broker_scaffold_cases import (
    READINESS_FIXTURES,
    _cut,
    _FileProcessHost,
    _native_evidence,
    _projection_status,
    _reconciliation,
)


def test_reconciled_native_evidence_projects_exact_durable_and_projection_cuts(
    tmp_path,
):
    runtime_dir = tmp_path / "home" / "runtime"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]
    authority = runtime_state._ReconciledReadinessProjection(
        _reconciliation(),
        _projection_status(),
    )
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=authority,
    ).activate(requirement, "python")

    assert receipt["outcome"] == "activated"
    assert receipt["handle"]["readiness"]["durableCut"] == _cut()
    assert receipt["handle"]["readiness"]["projectionCut"] == _cut()
    assert [
        evidence["kind"] for evidence in receipt["handle"]["readiness"]["evidence"]
    ] == ["durability-receipt", "projection-status"]


def test_reconciled_readiness_rejects_non_authoritative_durability_evidence():
    authority = runtime_state._ReconciledReadinessProjection(
        {**_reconciliation(), "recovered": False}
    )
    requirement = runtime_broker.plan_operation(
        "assessment.request",
        workspace="workspace-test",
        request_source="python",
        minimum_cut=_cut(),
    )["requirement"]

    with pytest.raises(ValueError, match="not authoritative"):
        authority.establish(requirement, "1", {})


def test_retained_readiness_fixture_binds_native_evidence_above_the_minimum_cut():
    fixture = READINESS_FIXTURES["valid"]
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace="workspace-retained-fixture",
        request_source="python",
        minimum_cut=fixture["minimumCut"],
    )["requirement"]
    readiness = runtime_state._ReconciledReadinessProjection(
        fixture["durabilityReconciliation"],
        fixture["projectionStatus"],
    ).establish(requirement, "1", {})

    assert runtime_broker._readiness_admits_requirement(requirement, readiness)
    assert readiness["durableCut"]["sequence"] == "42"
    assert readiness["projectionCut"] == readiness["durableCut"]


def test_product_discovers_exact_native_readiness_coordinates(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    monkeypatch.setenv("KF_CONFIG_HOME", str(config_home))
    assert runtime_broker.discover_native_readiness_evidence(runtime_dir) is None

    evidence = _native_evidence(runtime_dir)
    path = runtime_broker.native_readiness_evidence_path(runtime_dir)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(evidence))

    discovered = runtime_broker.discover_native_readiness_evidence(runtime_dir)
    assert discovered == evidence
    authority = runtime_broker.native_readiness_authority(discovered)
    assert authority.durability_request_id == 17
    assert authority.projection_qualification_profile == (
        "candidate/test-local-filesystem/v1"
    )


def test_product_publishes_native_coordinates_only_after_exact_authority(
    tmp_path, monkeypatch
):
    from kungfu import durability, projection

    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    evidence = _native_evidence(runtime_dir)
    calls = []
    monkeypatch.setattr(
        durability,
        "reconcile",
        lambda **kwargs: (
            calls.append(("durability", kwargs))
            or _reconciliation(evidence["minimumCut"])
        ),
    )
    monkeypatch.setattr(
        projection,
        "candidate_status",
        lambda **kwargs: (
            calls.append(("projection", kwargs))
            or _projection_status(evidence["minimumCut"])
        ),
    )
    original_replace = runtime_state.os.replace

    def replace_after_authority(source, destination):
        assert [kind for kind, _ in calls] == ["durability", "projection"]
        assert not Path(destination).exists()
        original_replace(source, destination)

    monkeypatch.setattr(runtime_state.os, "replace", replace_after_authority)

    published = runtime_broker.publish_native_readiness_evidence(
        runtime_dir,
        evidence,
        operation_id="projection.subscribe",
        config_home=config_home,
    )

    assert published == evidence
    assert (
        runtime_broker.discover_native_readiness_evidence(runtime_dir, config_home)
        == evidence
    )
    assert calls[0][1]["sequence"] == 1
    assert calls[1][1]["container_epoch"] == 1


def test_native_coordinate_publication_failure_preserves_previous_descriptor(
    tmp_path, monkeypatch
):
    from kungfu import durability

    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    previous = _native_evidence(runtime_dir)
    path = runtime_broker.native_readiness_evidence_path(runtime_dir, config_home)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(previous, indent=2, sort_keys=True) + "\n")
    original = path.read_bytes()
    replacement = copy.deepcopy(previous)
    replacement["durability"]["requestId"] = "18"
    monkeypatch.setattr(
        durability,
        "reconcile",
        lambda **kwargs: (_ for _ in ()).throw(ValueError("authority unavailable")),
    )

    with pytest.raises(ValueError, match="authority unavailable"):
        runtime_broker.publish_native_readiness_evidence(
            runtime_dir,
            replacement,
            operation_id="assessment.request",
            config_home=config_home,
        )

    assert path.read_bytes() == original
    assert (
        runtime_broker.discover_native_readiness_evidence(runtime_dir, config_home)
        == previous
    )


def test_native_coordinate_publication_rejects_non_live_and_lagging_evidence(
    tmp_path, monkeypatch
):
    from kungfu import durability, projection

    runtime_dir = tmp_path / "home" / "runtime"
    config_home = tmp_path / "config"
    evidence = _native_evidence(runtime_dir, _cut(sequence="2", frame_uid="2"))

    with pytest.raises(ValueError, match="live-required"):
        runtime_broker.publish_native_readiness_evidence(
            runtime_dir,
            evidence,
            operation_id="episode.inspect",
            config_home=config_home,
        )

    monkeypatch.setattr(
        durability,
        "reconcile",
        lambda **kwargs: _reconciliation(_cut(sequence="1", frame_uid="1")),
    )
    monkeypatch.setattr(
        projection,
        "candidate_status",
        lambda **kwargs: _projection_status(_cut(sequence="1", frame_uid="1")),
    )
    with pytest.raises(ValueError, match="did not establish"):
        runtime_broker.publish_native_readiness_evidence(
            runtime_dir,
            evidence,
            operation_id="projection.subscribe",
            config_home=config_home,
        )

    assert not runtime_broker.native_readiness_evidence_path(
        runtime_dir, config_home
    ).exists()


def test_product_rejects_foreign_native_readiness_coordinates(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "home" / "runtime"
    monkeypatch.setenv("KF_CONFIG_HOME", str(tmp_path / "config"))
    evidence = _native_evidence(runtime_dir)
    evidence["workspaceId"] = "workspace-foreign"
    path = runtime_broker.native_readiness_evidence_path(runtime_dir)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(evidence))

    with pytest.raises(ValueError, match="another workspace"):
        runtime_broker.discover_native_readiness_evidence(runtime_dir)


def test_product_rejects_mismatched_native_runtime_home(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "home" / "runtime"
    monkeypatch.setenv("KF_CONFIG_HOME", str(tmp_path / "config"))
    evidence = _native_evidence(runtime_dir)
    evidence["runtimeHome"] = str(tmp_path / "foreign-home")
    path = runtime_broker.native_readiness_evidence_path(runtime_dir)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(evidence))

    with pytest.raises(ValueError, match="runtime home does not match"):
        runtime_broker.discover_native_readiness_evidence(runtime_dir)


def test_native_readiness_authority_invokes_existing_typed_authorities(
    tmp_path, monkeypatch
):
    from kungfu import durability, projection

    fixture = READINESS_FIXTURES["valid"]
    calls = []
    monkeypatch.setattr(
        durability,
        "reconcile",
        lambda **kwargs: (
            calls.append(("durability", kwargs)) or fixture["durabilityReconciliation"]
        ),
    )
    monkeypatch.setattr(
        projection,
        "candidate_status",
        lambda **kwargs: (
            calls.append(("projection", kwargs)) or fixture["projectionStatus"]
        ),
    )
    runtime_dir = tmp_path / "home" / "runtime"
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=fixture["minimumCut"],
    )["requirement"]
    authority = runtime_broker.NativeReadinessAuthority(
        data_root=str(runtime_dir),
        durability_request_id=17,
        requested_profile="durable_sync",
        writer_resource_id="00000007.0000000b",
        durability_qualification_profile="test/disposable-powercut/v1",
        projection_writer_resource_id="projection-restart-writer",
        projection_qualification_profile="candidate/test-local-filesystem/v1",
    )
    receipt = runtime_broker.ProcessRuntimeActivationClient(
        str(runtime_dir.parent),
        str(runtime_dir),
        config_home=str(tmp_path / "config"),
        host=_FileProcessHost(tmp_path / "activation-count"),
        readiness_authority=authority,
    ).activate(requirement, "python")

    assert receipt["outcome"] == "activated"
    assert [kind for kind, _ in calls] == ["durability", "projection"]
    assert calls[0][1]["sequence"] == 41
    assert calls[1][1]["container_epoch"] == 11
