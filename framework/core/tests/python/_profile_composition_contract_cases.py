# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

from _profile_composition_support import (
    DOGFOOD_SOURCE,
    CliRunner,
    Path,
    __registry__,
    _activate,
    _brief,
    _dynamic_source,
    _fact_state_definition,
    _set_retired_fact_surface,
    _set_work_item_authorities,
    _source,
    _upgrade,
    _write_artifact,
    hashlib,
    json,
    kfc,
    profile_composition,
    profile_sdk,
    pytest,
    storage_service,
    time,
)

__all__ = [
    "test_contract_accepts_authority_narrowing_without_retired_source_facts",
    "test_contract_retains_history_when_current_profile_retires_a_source_authority",
    "test_contract_accepts_surface_narrowing_without_retired_surface_facts",
    "test_contract_rejects_surface_register_expansion",
    "test_contract_retains_history_when_current_profile_retires_a_fact_surface",
]


def test_contract_accepts_authority_narrowing_without_retired_source_facts(tmp_path):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _set_work_item_authorities(source, ["retired-owner", "workspace-owner"])
    _activate(source, runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )
    written = storage_service.fact_material_put(
        runtime,
        {
            "type_id": "work-item",
            "type_version": "1",
            "source_id": "workspace-owner",
            "subject_key": "week-1",
            "payload": {"status": "active"},
            "observation_id": "week-1-active",
            "action": "assert",
            "valid_until": 0,
        },
    )
    assert written["receipt"]["admission"]["outcome"] == "admitted"

    _set_work_item_authorities(source, ["workspace-owner"])
    _upgrade(source, runtime)

    assert (
        profile_composition.contract_materialization_plan(source, runtime)["operations"]
        == []
    )


def test_contract_retains_history_when_current_profile_retires_a_source_authority(
    tmp_path,
):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _set_work_item_authorities(source, ["retired-owner", "workspace-owner"])
    _activate(source, runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )
    written = storage_service.fact_material_put(
        runtime,
        {
            "type_id": "work-item",
            "type_version": "1",
            "source_id": "retired-owner",
            "subject_key": "week-1",
            "payload": {"status": "active"},
            "observation_id": "week-1-retired",
            "action": "assert",
            "valid_until": 0,
        },
    )
    assert written["receipt"]["admission"]["outcome"] == "admitted"

    _set_work_item_authorities(source, ["workspace-owner"])
    _upgrade(source, runtime)

    plan = profile_composition.contract_materialization_plan(source, runtime)
    assert plan["operations"] == []
    catalog = storage_service.fact_type_list(runtime)
    work_item = next(row for row in catalog["fact_types"] if row["id"] == "work-item")
    assert set(work_item["source_authorities"]) == {
        "retired-owner",
        "workspace-owner",
    }
    history = storage_service.fact_state(runtime)["observation_history"]
    assert any(row["observation_id"] == "week-1-retired" for row in history)


def test_contract_accepts_surface_narrowing_without_retired_surface_facts(tmp_path):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _set_retired_fact_surface(source, present=True)
    _activate(source, runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )

    _set_retired_fact_surface(source, present=False)
    _upgrade(source, runtime)

    assert (
        profile_composition.contract_materialization_plan(source, runtime)["operations"]
        == []
    )


def test_contract_rejects_surface_register_expansion(tmp_path):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _activate(source, runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )

    _set_retired_fact_surface(source, present=True)
    _upgrade(source, runtime)

    with pytest.raises(profile_sdk.ProfileSdkError) as raised:
        profile_composition.contract_materialization_plan(source, runtime)
    assert raised.value.diagnosis["code"] == "contract-world-incompatible"


def test_contract_retains_history_when_current_profile_retires_a_fact_surface(
    tmp_path,
):
    source = _dynamic_source(tmp_path)
    runtime = tmp_path / "runtime"
    _set_retired_fact_surface(source, present=True)
    _activate(source, runtime)
    contract = profile_composition.contract_materialization_plan(source, runtime)
    profile_composition.authorized_contract_materialize(
        runtime,
        contract,
        profile_sdk.answer_decision(contract["decisionCard"], "approve", "test-owner"),
    )
    written = storage_service.fact_material_put(
        runtime,
        {
            "type_id": "retired-item",
            "type_version": "1",
            "source_id": "workspace-owner",
            "subject_key": "retired-1",
            "payload": {"status": "retained"},
            "observation_id": "retired-1-retained",
            "action": "assert",
            "valid_until": 0,
        },
    )
    assert written["receipt"]["admission"]["outcome"] == "admitted"

    _set_retired_fact_surface(source, present=False)
    _upgrade(source, runtime)

    plan = profile_composition.contract_materialization_plan(source, runtime)
    assert plan["operations"] == []
    catalog = storage_service.fact_type_list(runtime)
    assert any(row["id"] == "retired-item" for row in catalog["fact_types"])
    history = storage_service.fact_state(runtime)["observation_history"]
    assert any(row["observation_id"] == "retired-1-retained" for row in history)
