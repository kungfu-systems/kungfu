# SPDX-License-Identifier: Apache-2.0
"""Cohesive agent work state contract cases."""
# ruff: noqa: F401,F403

from _agent_work_state_support import *
from _agent_work_state_support import (
    _MemoryFactKernel,
    _profile_request,
    _role_transition_request,
    _root,
    _session_fixture,
    _successor_request,
)


def test_kfd7_profile_capabilities_and_typed_responsibility_gap():
    capabilities = work_profile.capabilities_python(conformance=True)
    assert capabilities["roles"] == ["fact", "episode", "pursuit", "atlas", "warrant"]
    assert "stale-ref" in capabilities["denials"]
    assert capabilities["recovery"]["projectionRebuild"]["identity"] == "preserved"
    assert (
        capabilities["recovery"]["cleanHome"]["lossCode"]
        == "profile-authority-unavailable"
    )
    request = _profile_request()
    del request["responsibilities"]["warrant"]

    denied = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert denied["status"] == "denied"
    assert denied["failureCode"] == "responsibility-gap"
    assert denied["writeOccurred"] is False


def test_kfd7_geometry_and_domain_profile_have_independent_exact_roots():
    geometry = contract.load_contract("action-geometry")
    profile = contract.load_contract("agent-work-domain-profile")
    roots = domain_profile.roots_python(conformance=True)

    assert geometry["responsibilities"] == list(work_profile.ROLES)
    assert profile["actionGeometry"]["root"] == roots["actionGeometryRoot"]
    assert roots["domainProfileRoot"] == contract.contract_hash(
        "agent-work-domain-profile"
    )
    assert roots["roleSchemaRoots"] == {
        role: profile["roleSchemas"][role]["root"] for role in work_profile.ROLES
    }
    capabilities = work_profile.capabilities_python(conformance=True)
    assert capabilities["actionGeometryRoot"] == roots["actionGeometryRoot"]
    assert capabilities["domainProfileRoot"] == roots["domainProfileRoot"]
    assert capabilities["roleSchemaRoots"] == roots["roleSchemaRoots"]
    assert capabilities["roleBodySchema"] == work_profile.ROLE_BODY_SCHEMA


def test_kfd7_geometry_evaluator_has_no_domain_profile_dependency():
    source = inspect.getsource(action_geometry)
    assert "domain_profile" not in source
    assert "INITIAL_STATES" not in source
    assert "TRANSITIONS" not in source
    assert "successPolicy" not in source

    identities = {
        role: f"fact:{index:032x}"
        for index, role in enumerate(work_profile.ROLES, start=1)
    }
    accepted = action_geometry.evaluate_python(identities, conformance=True)
    rejected = action_geometry.evaluate_python(
        identities,
        inference_claims=["completion-from-episode"],
        conformance=True,
    )

    assert accepted["admissible"] is True
    assert rejected["admissible"] is False
    assert rejected["failures"] == [
        {
            "code": "non-substitution-invariant",
            "invariant": "completion-not-from-episode",
        }
    ]


def test_kfd7_public_semantics_fail_visible_without_native_action_runtime():
    identities = {
        role: f"fact:{index:032x}"
        for index, role in enumerate(work_profile.ROLES, start=1)
    }
    with pytest.raises(
        NativeActionRuntimeUnavailable, match="build it with `./shifu build:core`"
    ):
        action_geometry.evaluate(identities)
    with pytest.raises(
        NativeActionRuntimeUnavailable, match="explicit \\*_python oracle"
    ):
        domain_profile.roots()
    with pytest.raises(
        NativeActionRuntimeUnavailable, match="explicit \\*_python oracle"
    ):
        work_profile.capabilities()
    with pytest.raises(ConformanceOracleDisabled, match="conformance=True"):
        action_geometry.evaluate_python(identities)
    with pytest.raises(ConformanceOracleDisabled, match="conformance=True"):
        domain_profile.roots_python()
    with pytest.raises(ConformanceOracleDisabled, match="conformance=True"):
        work_profile.capabilities_python()
    with pytest.raises(ConformanceOracleDisabled, match="conformance=True"):
        work_profile.session_compressibility_python(_session_fixture())


def test_kfd7_domain_profile_validates_successor_and_legacy_bodies():
    role = "pursuit"
    successor = {
        "schema": domain_profile.role_schema_id_python(role, conformance=True),
        "role": role,
        "state": "active",
        "details": {"summary": "preserve contract roots"},
        "bindings": domain_profile.role_bindings_python(role, conformance=True),
    }
    assert (
        domain_profile.validate_role_body_python(successor, conformance=True)["legacy"]
        is False
    )

    missing = copy.deepcopy(successor)
    del missing["bindings"]["roleSchemaRoot"]
    with pytest.raises(ValueError, match="validation failed"):
        domain_profile.validate_role_body_python(missing, conformance=True)

    wrong = copy.deepcopy(successor)
    wrong["bindings"]["roleSchemaRoot"] = "sha256:" + "0" * 64
    with pytest.raises(ValueError, match="exact contract roots"):
        domain_profile.validate_role_body_python(wrong, conformance=True)

    legacy = {
        "schema": work_profile.ROLE_BODY_SCHEMA,
        "role": role,
        "state": "active",
        "details": {"summary": "legacy meaning is unchanged"},
    }
    assert domain_profile.validate_role_body_python(legacy, conformance=True) == {
        "role": role,
        "legacy": True,
    }
