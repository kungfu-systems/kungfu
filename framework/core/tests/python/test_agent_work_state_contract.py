# SPDX-License-Identifier: Apache-2.0

import copy
import base64
import hashlib
import inspect
import json
import sys
import types
from pathlib import Path

from click.testing import CliRunner
from jsonschema import Draft202012Validator
import pytest

fake = types.ModuleType("pykungfu")
fake.__file__ = "/nonexistent/pykungfu.so"
fake.yijinjing = types.SimpleNamespace(
    enums=types.SimpleNamespace(
        mode=types.SimpleNamespace(LIVE="LIVE", BACKTEST="BACKTEST"),
        location_role=types.SimpleNamespace(SYSTEM="SYSTEM"),
    )
)
runtime = types.ModuleType("pykungfu.runtime")
runtime.coordinator = object
runtime.locator = lambda value: {"value": value}
runtime.location = lambda *args: {"args": args}
runtime.compute_content_hash = lambda payload, algorithm: (
    f"{algorithm}:{hashlib.sha256(payload).hexdigest()}"
)
runtime.compute_content_hash_value = lambda payload, algorithm: hashlib.sha256(
    payload
).hexdigest()
runtime.format_content_hash = lambda algorithm, value: f"{algorithm}:{value}"
fake.runtime = runtime
sys.modules.setdefault("pykungfu", fake)
sys.modules.setdefault("pykungfu.runtime", runtime)

import kungfu  # noqa: E402

kungfu._build_info = {"version": "test"}

from kungfu import contract, durability  # noqa: E402
from kungfu.agent import (  # noqa: E402
    action_geometry,
    domain_profile,
    first_value,
    work_profile,
)
from kungfu.agent.native_authority import (  # noqa: E402
    ConformanceOracleDisabled,
    NativeActionRuntimeUnavailable,
)
from kungfu.cli.commands import __registry__  # noqa: E402, F401
from kungfu.cli.commands import kfc  # noqa: E402


ROLE_IDS = ["pursuit", "atlas", "warrant", "episode"]
INVALID_INFERENCES = {
    "goal-is-authority",
    "context-is-reality",
    "plan-is-occurrence",
    "occurrence-is-completion",
    "parent-warrant-authorizes-descendant",
}


def contract_schema_errors(value):
    return list(Draft202012Validator(value["contractSchema"]).iter_errors(value))


def test_agent_work_state_contract_is_registered_and_self_validating():
    value = contract.load_contract("agent-work-state")

    assert value["schema"] == "kungfu.agent-work-state.contract/v2"
    assert value["version"] == 2
    assert value["weldedSurface"] == "agent-work-state-contract"
    assert value["roleOrder"] == ROLE_IDS
    assert [role["id"] for role in value["roles"]] == ROLE_IDS
    assert {row["id"] for row in value["invalidInferences"]} == INVALID_INFERENCES
    assert value["relations"]["inheritance"] == "none"
    assert value["qualification"]["gate"] == "P17"
    assert value["qualification"]["status"] == "not-qualified"
    assert value["formalModel"]["version"] == 1
    assert value["actionBinding"]["primitive"] is False
    assert value["actionBinding"]["requiredRoots"] == [
        "fact_cut_root",
        "pursuit_root",
        "atlas_root",
        "warrant_root",
    ]
    Draft202012Validator.check_schema(value["profileSchema"])
    assert [row["id"] for row in value["qualification"]["checks"]] == [
        f"FO{index}" for index in range(1, 11)
    ]
    Draft202012Validator.check_schema(value["continuityValidation"]["evidenceSchema"])
    assert (
        value["continuityValidation"]["publicOutcome"]
        == "Keep the work when the chat ends."
    )
    assert value["publicSurfaces"]["governance"] == {
        "contract": "kfd-1-generic-query",
        "agent": "kfd-3-collaboration-interface",
        "agentDiscovery": "kfd-3-collaboration-interface",
        "human": "documentation",
        "decision": "architecture-decision",
        "register": "kfd-1-register",
    }


def test_agent_work_state_contract_fails_closed_on_qualification_and_surfaces():
    value = contract.load_contract("agent-work-state")
    mutations = []

    release_qualified = copy.deepcopy(value)
    release_qualified["status"]["releaseQualification"] = "qualified"
    mutations.append(release_qualified)

    p17_qualified = copy.deepcopy(value)
    p17_qualified["qualification"]["status"] = "qualified"
    mutations.append(p17_qualified)

    missing_check = copy.deepcopy(value)
    missing_check["qualification"]["checks"].pop()
    mutations.append(missing_check)

    missing_surface_governance = copy.deepcopy(value)
    del missing_surface_governance["publicSurfaces"]["governance"]
    mutations.append(missing_surface_governance)

    missing_profile_schema = copy.deepcopy(value)
    del missing_profile_schema["profileSchema"]
    mutations.append(missing_profile_schema)

    for mutation in mutations:
        assert contract_schema_errors(mutation)


def test_agent_work_state_contract_cannot_replace_its_schema_authority(tmp_path):
    value = contract.load_contract("agent-work-state")
    value["contractSchema"] = {}
    value["status"]["releaseQualification"] = "qualified"
    value["qualification"]["status"] = "qualified"
    candidate = tmp_path / "agent-work-state.json"
    candidate.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(ValueError, match="contract schema authority mismatch"):
        contract.load_contract("agent-work-state", str(candidate))


def test_agent_work_model_and_generic_contract_query_share_one_hash(tmp_path):
    runner = CliRunner()
    agent_result = runner.invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "agent", "work-model", "--json"],
    )
    generic_result = runner.invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "contract",
            "show",
            "agent-work-state",
            "--json",
        ],
    )

    assert agent_result.exit_code == 0, agent_result.output
    assert generic_result.exit_code == 0, generic_result.output
    agent_value = json.loads(agent_result.output)
    generic_value = json.loads(generic_result.output)
    assert agent_value["hash"] == generic_value["hash"]
    assert agent_value["roleOrder"] == generic_value["roleOrder"] == ROLE_IDS
    assert agent_value["qualification"] == generic_value["qualification"]


def test_agent_capabilities_discovers_the_same_work_model(tmp_path, monkeypatch):
    monkeypatch.setattr(durability, "capabilities", lambda: {"status": "test"})
    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "agent", "capabilities", "--json"],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    metadata = contract.contract_metadata("agent-work-state")
    assert payload["workModel"] == {
        "command": "kungfu agent work-model --json",
        "contract": metadata,
    }
    assert payload["actionGeometry"] == contract.contract_metadata("action-geometry")
    assert payload["workDomainProfile"] == contract.contract_metadata(
        "agent-work-domain-profile"
    )
    assert payload["workLoop"] == first_value.work_authority_capabilities()
    assert any(
        row["apiId"] == "kungfu.agent.work-model"
        and row["name"] == "kungfu agent work-model --json"
        for row in payload["commands"]["commands"]
    )
    assert payload["workLoop"]["commandFamily"] == "kungfu work"
    assert payload["workLoop"]["legacyStore"] is False


def test_agent_work_model_closes_the_kfd3_runtime_interface(tmp_path):
    result = CliRunner().invoke(
        kfc,
        ["--home", str(tmp_path / "home"), "agent", "verify", "--json"],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["ok"] is True
    assert payload["runtimeAnchors"]["missingRuntimeAnchors"] == []
    assert payload["commandCatalog"]["missingRegistryEntries"] == []
    assert payload["commandCatalog"]["missingCatalogEntries"] == []


def test_kfd7_authority_bundle_cli_exports_and_imports_the_same_public_shape(
    tmp_path, monkeypatch
):
    bundle = {
        "schema": work_profile.AUTHORITY_BUNDLE_SCHEMA,
        "bundleRoot": "sha256:" + "a" * 64,
    }
    exported = {
        "ok": True,
        "status": "exported",
        "result": {"bundle": bundle},
    }
    observed = {}
    monkeypatch.setattr(work_profile, "export_authority", lambda runtime_dir: exported)

    def import_authority(runtime_dir, candidate, *, execute=False):
        observed.update(
            {"runtimeDir": str(runtime_dir), "bundle": candidate, "execute": execute}
        )
        return {"ok": True, "status": "imported" if execute else "planned"}

    monkeypatch.setattr(work_profile, "import_authority", import_authority)
    runner = CliRunner()
    home = tmp_path / "home"
    export_result = runner.invoke(
        kfc,
        ["--home", str(home), "agent", "work", "export-authority", "--json"],
    )
    encoded = base64.b64encode(json.dumps(bundle).encode()).decode()
    import_result = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "agent",
            "work",
            "import-authority",
            "--input-base64",
            encoded,
            "--execute",
            "--json",
        ],
    )

    assert export_result.exit_code == 0, export_result.output
    assert json.loads(export_result.output) == exported
    assert import_result.exit_code == 0, import_result.output
    assert json.loads(import_result.output)["status"] == "imported"
    assert observed == {
        "runtimeDir": str(home / "runtime"),
        "bundle": bundle,
        "execute": True,
    }


def _root(value):
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


class _MemoryFactKernel:
    def __init__(self):
        self.objects = {}
        self.versions = {}
        self.relations = {}
        self.cuts = {}
        self.refs = {}
        self.transitions = {}

    @staticmethod
    def _ok(action, result, *, write=True, status="accepted"):
        return {
            "schema": "kungfu.fact-kernel.operation/v1",
            "ok": True,
            "action": action,
            "status": status,
            "write_occurred": write,
            "result": result,
            "receipt_root": _root([action, result]) if write else None,
        }

    @staticmethod
    def _fail(action, code, message):
        return {
            "schema": "kungfu.fact-kernel.operation/v1",
            "ok": False,
            "action": action,
            "status": "rejected",
            "failure_code": code,
            "message": message,
            "details": {},
            "write_occurred": False,
            "receipt": None,
        }

    def __call__(self, runtime_dir, action, request=None):
        request = copy.deepcopy(request or {})
        if action == "query":
            cut_root = request.get("cut_root")
            if not cut_root:
                return {
                    "schema": "kungfu.fact-kernel.state/v1",
                    "ok": True,
                    "refs": copy.deepcopy(self.refs),
                }
            cut = self.cuts.get(cut_root)
            if cut is None:
                return self._fail(action, "unknown-cut", "missing Cut")
            objects = []
            for object_id, version_root in cut["objectVersions"]:
                version = self.versions[version_root]
                objects.append(
                    {
                        "member": [object_id, version_root],
                        "version": {"bodyRoot": _root(version["body"])},
                        "body": version["body"],
                        "body_status": "present",
                    }
                )
            return {
                "schema": "kungfu.fact-kernel.state/v1",
                "ok": True,
                "cut_root": cut_root,
                "cut": copy.deepcopy(cut),
                "objects": objects,
                "relations": [
                    {
                        "relation_root": root,
                        "relation": copy.deepcopy(self.relations[root]),
                    }
                    for root in cut["activeRelationRoots"]
                ],
                "ref_resolution": None,
            }
        if action == "object-put":
            object_id = request["object_id"]
            existing = self.objects.get(object_id)
            if existing is not None and existing != request:
                return self._fail(action, "invalid-identity", "object changed")
            self.objects[object_id] = request
            return self._ok(
                action,
                {"object_id": object_id, "object_root": _root(request)},
                write=existing is None,
                status="accepted" if existing is None else "idempotent",
            )
        if action == "version-put":
            version_root = _root(request)
            existing = version_root in self.versions
            self.versions[version_root] = copy.deepcopy(request)
            return self._ok(
                action,
                {
                    "object_id": request["object_id"],
                    "version_root": version_root,
                    "body_root": _root(request["body"]),
                },
                write=not existing,
                status="accepted" if not existing else "idempotent",
            )
        if action == "relation-add":
            relation_root = _root(request)
            existing = relation_root in self.relations
            self.relations[relation_root] = request
            return self._ok(
                action,
                {
                    "relation_id": request["relation_id"],
                    "relation_root": relation_root,
                },
                write=not existing,
                status="accepted" if not existing else "idempotent",
            )
        if action == "cut-put":
            cut_root = _root(request)
            existing = cut_root in self.cuts
            self.cuts[cut_root] = {
                "parentCutRoots": request["parent_cut_roots"],
                "objectVersions": [
                    [row["object_id"], row["version_root"]]
                    for row in request["object_versions"]
                ],
                "activeRelationRoots": request["active_relation_roots"],
                "declarationRoots": request["declaration_roots"],
                "admissionRoots": request["admission_roots"],
                "episodeFrontier": request["episode_frontier"],
                "omissionRoots": request["omission_roots"],
                "conflictRoots": request["conflict_roots"],
            }
            return self._ok(
                action,
                {"cut_root": cut_root},
                write=not existing,
                status="accepted" if not existing else "idempotent",
            )
        if action == "ref-cas":
            transition_id = request["transition_id"]
            previous = self.transitions.get(transition_id)
            if previous is not None:
                if previous["request"] != request:
                    return self._fail(
                        action, "transition-id-reused", "replay bytes differ"
                    )
                return self._ok(
                    action,
                    copy.deepcopy(previous["result"]),
                    write=False,
                    status="idempotent-replay",
                )
            current = self.refs.get(request["ref_name"])
            current_root = current["cut_root"] if current else None
            current_revision = current["revision"] if current else 0
            if (
                current_root != request["expected_old_cut_root"]
                or current_revision != request["expected_old_revision"]
            ):
                return self._fail(action, "stale-ref", "ref changed")
            result = {
                "transition_id": transition_id,
                "ref_name": request["ref_name"],
                "prior_cut_root": current_root or "",
                "current_cut_root": request["new_cut_root"],
                "prior_revision": current_revision,
                "current_revision": current_revision + 1,
            }
            self.refs[request["ref_name"]] = {
                "cut_root": request["new_cut_root"],
                "revision": current_revision + 1,
            }
            self.transitions[transition_id] = {
                "request": request,
                "result": result,
            }
            return self._ok(action, result)
        raise AssertionError(f"unexpected action {action}")


def _profile_request():
    roles = list(work_profile.ROLES)
    role_ids = {role: f"fact:{index:032x}" for index, role in enumerate(roles, start=1)}
    support_root = "sha256:" + "1" * 64
    return {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": "bootstrap-1",
        "refName": "profiles/work/main",
        "basis": {"cutRoot": None, "revision": 0},
        "ref": {"cutRoot": None, "revision": 0},
        "subject": {
            "role": "fact",
            "operation": "create",
            "fromState": "absent",
            "toState": "declared",
        },
        "responsibilities": {
            role: {"objectId": role_ids[role], "expectedVersionRoot": None}
            for role in roles
        },
        "roleInputs": {
            "fact": {"state": "declared", "details": {"cutKind": "input"}},
            "episode": {"state": "open", "details": {"episodeId": "episode:1"}},
            "pursuit": {"state": "active", "details": {"success": "tests pass"}},
            "atlas": {"state": "current", "details": {"validThroughRevision": 10}},
            "warrant": {
                "state": "issued",
                "details": {"validThroughRevision": 10, "allowedOperations": ["*"]},
            },
        },
        "relations": [
            {
                "relationId": "fact:" + "a" * 32,
                "relationType": "pursuit-uses-atlas",
                "sourceRole": "pursuit",
                "targetRole": "atlas",
                "attributesRoot": "sha256:" + "2" * 64,
            }
        ],
        "support": {
            "createdByReceiptRoot": support_root,
            "schemaRoot": "sha256:" + "3" * 64,
            "declarationRoots": ["sha256:" + "4" * 64],
            "admissionRoots": ["sha256:" + "5" * 64],
            "reasonRoot": "sha256:" + "6" * 64,
        },
    }


def _session_fixture():
    return {
        "schema": work_profile.SESSION_SCHEMA,
        "sessionId": "session:release-check",
        "goal": {
            "pursuitId": "pursuit:release-check",
            "state": "active",
            "summary": "qualify the exact release cut",
            "operations": ["fact:successor", "episode:seal"],
            "alternatives": [],
        },
        "context": {
            "atlasId": "atlas:release-check",
            "state": "current",
            "perspective": "release-reviewer",
            "perspectives": ["release-reviewer"],
            "basisRevision": 4,
            "validThroughRevision": 4,
            "lossRoots": [],
        },
        "permissions": {
            "warrantId": "warrant:release-check",
            "state": "issued",
            "allowedOperations": ["fact:successor", "episode:seal"],
            "validThroughRevision": 4,
            "delegated": False,
        },
        "run": {
            "episodeId": "episode:release-check",
            "episodeIds": ["episode:release-check"],
            "state": "open",
            "causalRoot": "sha256:" + "a" * 64,
        },
        "facts": {
            "factId": "fact:release-check",
            "state": "declared",
            "inputRoot": "sha256:" + "b" * 64,
            "resultRoots": ["sha256:" + "c" * 64],
            "branchRoots": [],
        },
    }


def _successor_request(previous, *, action_id="continue-1"):
    request = _profile_request()
    request["actionId"] = action_id
    request["basis"] = {
        "cutRoot": previous["result"]["cutRoot"],
        "revision": previous["result"]["revision"],
    }
    request["ref"] = copy.deepcopy(request["basis"])
    request["subject"] = {
        "role": "pursuit",
        "operation": "continue",
        "fromState": "active",
        "toState": "active",
    }
    request["responsibilities"] = {
        role: {
            "objectId": request["responsibilities"][role]["objectId"],
            "expectedVersionRoot": previous["result"]["roleVersions"][role],
        }
        for role in work_profile.ROLES
    }
    request.pop("roleInputs")
    request["relations"] = []
    request["payload"] = {"continuation": action_id}
    return request


def _role_transition_request(
    previous,
    *,
    action_id,
    role,
    operation,
    from_state,
    to_state,
    payload,
    ref_name=None,
    new_ref=False,
):
    request = _profile_request()
    request["actionId"] = action_id
    request["refName"] = ref_name or request["refName"]
    request["basis"] = {
        "cutRoot": previous["result"]["cutRoot"],
        "revision": previous["result"]["revision"],
    }
    request["ref"] = (
        {"cutRoot": None, "revision": 0} if new_ref else copy.deepcopy(request["basis"])
    )
    request["subject"] = {
        "role": role,
        "operation": operation,
        "fromState": from_state,
        "toState": to_state,
    }
    request["responsibilities"] = {
        current_role: {
            "objectId": request["responsibilities"][current_role]["objectId"],
            "expectedVersionRoot": previous["result"]["roleVersions"][current_role],
        }
        for current_role in work_profile.ROLES
    }
    request.pop("roleInputs")
    request["relations"] = []
    request["payload"] = copy.deepcopy(payload)
    return request


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


def test_kfd7_session_geometry_round_trip_is_domain_neutral():
    session = _session_fixture()
    expanded = work_profile.expand_session_python(session, conformance=True)
    projected = work_profile.project_session_python(expanded, conformance=True)
    before = expanded["observations"]
    after = work_profile.expand_session_python(projected, conformance=True)[
        "observations"
    ]

    assert action_geometry.evaluate_session_refinement_python(
        before, after, conformance=True
    ) == {
        "schema": action_geometry.SESSION_EVALUATION_SCHEMA,
        "geometryRoot": contract.contract_hash("action-geometry"),
        "preserved": True,
        "missingDimensions": [],
        "changedDimensions": [],
    }


def test_kfd7_simple_session_round_trips_all_five_decision_observations():
    session = _session_fixture()
    expanded = work_profile.expand_session_python(session, conformance=True)

    assert expanded["compressibility"] == {
        "schema": work_profile.SESSION_COMPRESSIBILITY_SCHEMA,
        "sessionId": session["sessionId"],
        "compressible": True,
        "breakpoints": [],
        "revealedRoles": [],
    }
    assert set(expanded["observations"]) == {
        "direction",
        "perspective-boundary",
        "effective-authority",
        "causal-process",
        "admitted-result",
    }
    assert work_profile.project_session_python(expanded, conformance=True) == session


def test_kfd7_session_cli_and_python_api_share_the_same_projection(
    tmp_path, monkeypatch
):
    session = _session_fixture()
    expected = work_profile.expand_session_python(session, conformance=True)
    monkeypatch.setattr(work_profile, "require_action_runtime", lambda: object())
    monkeypatch.setattr(
        work_profile.storage_service,
        "action_runtime",
        lambda _runtime_dir, action, payload: (
            work_profile.expand_session_python(payload["session"], conformance=True)
            if action == "expand_session"
            else pytest.fail(f"unexpected native action: {action}")
        ),
    )
    encoded = base64.b64encode(json.dumps(session).encode()).decode()
    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(tmp_path / "home"),
            "agent",
            "work",
            "session",
            "--operation",
            "expand",
            "--input-base64",
            encoded,
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == expected


@pytest.mark.parametrize(
    ("role", "mutate"),
    [
        (
            "pursuit",
            lambda value: value["goal"].update({"alternatives": ["pursuit:other"]}),
        ),
        (
            "atlas",
            lambda value: value["context"].update(
                {"state": "stale", "lossRoots": ["sha256:" + "d" * 64]}
            ),
        ),
        (
            "warrant",
            lambda value: value["permissions"].update({"state": "revoked"}),
        ),
        (
            "episode",
            lambda value: value["run"].update(
                {"episodeIds": ["episode:release-check", "episode:retry"]}
            ),
        ),
        (
            "fact",
            lambda value: value["facts"].update(
                {"branchRoots": ["sha256:" + "e" * 64]}
            ),
        ),
    ],
)
def test_kfd7_session_complexity_breakpoints_reveal_the_independent_role(role, mutate):
    session = _session_fixture()
    mutate(session)
    expanded = work_profile.expand_session_python(session, conformance=True)

    assert expanded["compressibility"]["compressible"] is False
    assert role in expanded["compressibility"]["revealedRoles"]
    with pytest.raises(ValueError, match="session-complexity-breakpoint"):
        work_profile.project_session_python(expanded, conformance=True)


def test_kfd7_same_payload_has_different_actions_without_direction_authority_or_freshness():
    baseline = _session_fixture()
    payload = copy.deepcopy(baseline["facts"])
    assert work_profile.session_valid_actions_python(baseline, conformance=True) == [
        "episode:seal",
        "fact:successor",
    ]

    different_direction = copy.deepcopy(baseline)
    different_direction["goal"]["operations"] = ["episode:seal"]
    weaker_authority = copy.deepcopy(baseline)
    weaker_authority["permissions"]["allowedOperations"] = ["fact:successor"]
    stale_context = copy.deepcopy(baseline)
    stale_context["context"]["validThroughRevision"] = 3

    for candidate in (different_direction, weaker_authority, stale_context):
        assert candidate["facts"] == payload
    assert work_profile.session_valid_actions_python(
        different_direction, conformance=True
    ) == ["episode:seal"]
    assert work_profile.session_valid_actions_python(
        weaker_authority, conformance=True
    ) == ["fact:successor"]
    assert (
        work_profile.session_valid_actions_python(stale_context, conformance=True) == []
    )


@pytest.mark.parametrize("role", work_profile.ROLES)
def test_kfd7_profile_role_deletion_fails_before_write(role):
    request = _profile_request()
    del request["responsibilities"][role]

    denied = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert denied["status"] == "denied"
    assert denied["failureCode"] == "responsibility-gap"
    assert denied["writeOccurred"] is False


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("fact", "episode"),
        ("episode", "pursuit"),
        ("pursuit", "atlas"),
        ("atlas", "warrant"),
        ("fact", "warrant"),
    ],
)
def test_kfd7_profile_role_fusion_fails_before_write(left, right):
    request = _profile_request()
    request["responsibilities"][right]["objectId"] = request["responsibilities"][left][
        "objectId"
    ]

    denied = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert denied["status"] == "denied"
    assert denied["failureCode"] == "responsibility-gap"
    assert denied["writeOccurred"] is False


def test_kfd7_profile_action_and_receipt_schemas_cover_runtime_vectors():
    root = Path(__file__).resolve().parents[4]
    action_schema = json.loads(
        (
            root / "framework/work/agent-work/kungfu-kfd-7-profile-action.schema.json"
        ).read_text()
    )
    receipt_schema = json.loads(
        (
            root / "framework/work/agent-work/kungfu-kfd-7-profile-receipt.schema.json"
        ).read_text()
    )
    request = _profile_request()
    planned = work_profile.apply_action(
        "/unused", request, conformance=True, kernel=_MemoryFactKernel()
    )

    assert list(Draft202012Validator(action_schema).iter_errors(request)) == []
    assert list(Draft202012Validator(receipt_schema).iter_errors(planned)) == []


def test_kfd7_profile_bootstrap_continue_inspect_and_replay_fail_closed():
    kernel = _MemoryFactKernel()
    request = _profile_request()

    planned = work_profile.apply_action(
        "/runtime", request, conformance=True, kernel=kernel
    )
    created = work_profile.apply_action(
        "/runtime", request, execute=True, conformance=True, kernel=kernel
    )
    inspected = work_profile.inspect(
        "/runtime", request["refName"], conformance=True, kernel=kernel
    )

    assert planned["status"] == "planned"
    assert created["status"] == "accepted"
    assert created["result"]["roleStates"] == {
        "fact": "declared",
        "episode": "open",
        "pursuit": "active",
        "atlas": "current",
        "warrant": "issued",
    }
    assert inspected["status"] == "current"
    assert set(inspected["roles"]) == set(work_profile.ROLES)
    assert len(inspected["relations"]) == 1

    continued_request = _successor_request(created)
    continued = work_profile.apply_action(
        "/runtime", continued_request, execute=True, conformance=True, kernel=kernel
    )
    assert continued["status"] == "accepted"
    assert continued["result"]["revision"] == 2

    stale_request = _successor_request(created, action_id="stale-writer")
    stale = work_profile.apply_action(
        "/runtime", stale_request, execute=True, conformance=True, kernel=kernel
    )
    assert stale["status"] == "denied"
    assert stale["failureCode"] == "stale-ref"
    assert stale["writeOccurred"] is True
    assert stale["refWriteOccurred"] is False

    replay_mismatch_request = _successor_request(created)
    replay_mismatch_request["payload"] = {"continuation": "different-bytes"}
    replay_mismatch = work_profile.apply_action(
        "/runtime",
        replay_mismatch_request,
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert replay_mismatch["status"] == "denied"
    assert replay_mismatch["failureCode"] == "replay-mismatch"


def test_kfd7_profile_persists_exact_role_schema_bindings_and_fails_closed():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )

    for role, version_root in created["result"]["roleVersions"].items():
        body = json.loads(kernel.versions[version_root]["body"])
        assert body["schema"] == domain_profile.role_schema_id_python(
            role, conformance=True
        )
        assert body["bindings"] == domain_profile.role_bindings_python(
            role, conformance=True
        )
        assert (
            domain_profile.validate_role_body_python(body, conformance=True)["legacy"]
            is False
        )

    pursuit_root = created["result"]["roleVersions"]["pursuit"]
    corrupted = json.loads(kernel.versions[pursuit_root]["body"])
    corrupted["bindings"]["domainProfileRoot"] = "sha256:" + "0" * 64
    kernel.versions[pursuit_root]["body"] = json.dumps(corrupted, sort_keys=True)

    denied = work_profile.apply_action(
        "/runtime",
        _successor_request(created, action_id="wrong-profile-root"),
        conformance=True,
        kernel=kernel,
    )
    assert denied["status"] == "denied"
    assert denied["failureCode"] == "body-missing"
    assert denied["details"]["missingRoles"] == ["pursuit"]


def test_kfd7_legacy_role_roots_remain_readable_without_reinterpretation():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    legacy_roots = copy.deepcopy(created["result"]["roleVersions"])
    for version_root in legacy_roots.values():
        body = json.loads(kernel.versions[version_root]["body"])
        body["schema"] = work_profile.ROLE_BODY_SCHEMA
        body.pop("bindings")
        kernel.versions[version_root]["body"] = json.dumps(body, sort_keys=True)

    inspected = work_profile.inspect(
        "/runtime", _profile_request()["refName"], conformance=True, kernel=kernel
    )
    assert inspected["status"] == "current"
    assert {
        role: row["versionRoot"] for role, row in inspected["roles"].items()
    } == legacy_roots

    continued = work_profile.apply_action(
        "/runtime",
        _successor_request(created, action_id="legacy-compatible-successor"),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert continued["status"] == "accepted"
    for role in set(work_profile.ROLES) - {"pursuit"}:
        assert continued["result"]["roleVersions"][role] == legacy_roots[role]
    pursuit_body = json.loads(
        kernel.versions[continued["result"]["roleVersions"]["pursuit"]]["body"]
    )
    assert pursuit_body["schema"] == domain_profile.role_schema_id_python(
        "pursuit", conformance=True
    )
    assert pursuit_body["bindings"] == domain_profile.role_bindings_python(
        "pursuit", conformance=True
    )


def test_kfd7_profile_rejects_stale_atlas_and_expired_warrant_before_writes():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    stale_atlas_request = _successor_request(created, action_id="atlas-stale")
    atlas_root = created["result"]["roleVersions"]["atlas"]
    atlas_body = json.loads(kernel.versions[atlas_root]["body"])
    atlas_body["state"] = "stale"
    kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)

    stale_atlas = work_profile.apply_action(
        "/runtime", stale_atlas_request, execute=True, conformance=True, kernel=kernel
    )

    assert stale_atlas["failureCode"] == "atlas-stale"
    assert stale_atlas["writeOccurred"] is False

    atlas_body["state"] = "current"
    kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)
    warrant_root = created["result"]["roleVersions"]["warrant"]
    warrant_body = json.loads(kernel.versions[warrant_root]["body"])
    warrant_body["details"]["validThroughRevision"] = 0
    kernel.versions[warrant_root]["body"] = json.dumps(warrant_body, sort_keys=True)
    expired = work_profile.apply_action(
        "/runtime",
        _successor_request(created, action_id="warrant-expired"),
        conformance=True,
        kernel=kernel,
    )

    assert expired["failureCode"] == "warrant-expired"
    assert expired["writeOccurred"] is False


def test_kfd7_profile_warrant_attenuation_and_revocation_are_enforced():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    attenuated = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            created,
            action_id="attenuate-warrant",
            role="warrant",
            operation="attenuate",
            from_state="issued",
            to_state="attenuated",
            payload={
                "allowedOperations": ["pursuit:continue", "warrant:revoke"],
                "validThroughRevision": 5,
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert attenuated["status"] == "accepted"

    denied = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            attenuated,
            action_id="complete-outside-scope",
            role="pursuit",
            operation="complete",
            from_state="active",
            to_state="completed",
            payload={"settlementRoot": "sha256:" + "8" * 64, "outcome": "done"},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert denied["failureCode"] == "unauthorized"
    assert denied["writeOccurred"] is False

    revoked = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            attenuated,
            action_id="revoke-warrant",
            role="warrant",
            operation="revoke",
            from_state="attenuated",
            to_state="revoked",
            payload={
                "reason": "issuer withdrew authority",
                "reasonRoot": "sha256:" + "9" * 64,
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert revoked["status"] == "accepted"
    rejected_after_revoke = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            revoked,
            action_id="continue-after-revoke",
            role="pursuit",
            operation="continue",
            from_state="active",
            to_state="active",
            payload={"continuation": "must fail"},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert rejected_after_revoke["failureCode"] == "warrant-revoked"
    assert rejected_after_revoke["writeOccurred"] is False


def test_kfd7_profile_atlas_loss_refresh_and_pursuit_branch_are_explicit():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    stale = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            created,
            action_id="mark-atlas-stale",
            role="atlas",
            operation="mark-stale",
            from_state="current",
            to_state="stale",
            payload={
                "lossRoots": ["sha256:" + "a" * 64],
                "lossReason": "source expired",
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert stale["status"] == "accepted"
    blocked = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            stale,
            action_id="blocked-by-stale-atlas",
            role="pursuit",
            operation="continue",
            from_state="active",
            to_state="active",
            payload={"continuation": "unsafe"},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert blocked["failureCode"] == "atlas-stale"
    assert blocked["writeOccurred"] is False

    refreshed = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            stale,
            action_id="refresh-atlas",
            role="atlas",
            operation="refresh",
            from_state="stale",
            to_state="current",
            payload={
                "sourceRoots": ["sha256:" + "b" * 64],
                "lossRoots": ["sha256:" + "a" * 64],
                "validThroughRevision": 10,
            },
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert refreshed["status"] == "accepted"

    branched = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            refreshed,
            action_id="branch-pursuit",
            role="pursuit",
            operation="branch",
            from_state="active",
            to_state="active",
            payload={
                "branchOfCutRoot": refreshed["result"]["cutRoot"],
                "branchReasonRoot": "sha256:" + "c" * 64,
            },
            ref_name="profiles/work/branch",
            new_ref=True,
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert branched["status"] == "accepted"
    assert branched["result"]["revision"] == 1
    assert (
        work_profile.inspect(
            "/runtime", "profiles/work/main", conformance=True, kernel=kernel
        )["revision"]
        == 3
    )

    abandoned = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            branched,
            action_id="abandon-branch",
            role="pursuit",
            operation="abandon",
            from_state="active",
            to_state="abandoned",
            payload={
                "settlementRoot": "sha256:" + "d" * 64,
                "outcome": "superseded by main",
            },
            ref_name="profiles/work/branch",
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert abandoned["status"] == "accepted"


def test_kfd7_profile_episode_replay_distinguishes_equal_endpoint_causality():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, conformance=True, kernel=kernel
    )
    endpoint = "sha256:" + "d" * 64
    sealed_payload = {
        "episodeId": "episode:1",
        "beforeCutRoot": endpoint,
        "afterCutRoot": endpoint,
        "causalRoot": "sha256:" + "e" * 64,
        "sealedContentRoot": "sha256:" + "f" * 64,
    }
    sealed = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            created,
            action_id="seal-equal-endpoint-episode",
            role="episode",
            operation="seal",
            from_state="open",
            to_state="sealed",
            payload=sealed_payload,
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert sealed["status"] == "accepted"

    mismatched = copy.deepcopy(sealed_payload)
    mismatched["causalRoot"] = "sha256:" + "0" * 64
    replay_denied = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            sealed,
            action_id="replay-mismatched-causality",
            role="episode",
            operation="reconcile",
            from_state="sealed",
            to_state="reconciled",
            payload={"replay": mismatched},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert replay_denied["failureCode"] == "replay-mismatch"
    assert replay_denied["writeOccurred"] is False

    replayed = work_profile.apply_action(
        "/runtime",
        _role_transition_request(
            sealed,
            action_id="replay-exact-causality",
            role="episode",
            operation="reconcile",
            from_state="sealed",
            to_state="reconciled",
            payload={"replay": sealed_payload},
        ),
        execute=True,
        conformance=True,
        kernel=kernel,
    )
    assert replayed["status"] == "accepted"


def test_kfd7_context_only_rival_loses_each_decision_relevant_role():
    baseline_kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/baseline",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=baseline_kernel,
    )
    candidate = _successor_request(created, action_id="same-visible-task")
    visible_task = {
        "subject": copy.deepcopy(candidate["subject"]),
        "payload": copy.deepcopy(candidate["payload"]),
    }
    baseline_plan = work_profile.apply_action(
        "/baseline", candidate, conformance=True, kernel=baseline_kernel
    )
    assert baseline_plan["status"] == "planned"
    assert baseline_plan["changedRoles"] == ["pursuit"]

    fact_variant = copy.deepcopy(candidate)
    fact_variant["responsibilities"]["fact"]["expectedVersionRoot"] = (
        "sha256:" + "7" * 64
    )
    assert {
        "subject": fact_variant["subject"],
        "payload": fact_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/baseline", fact_variant, conformance=True, kernel=baseline_kernel
        )["failureCode"]
        == "profile-state-mismatch"
    )

    pursuit_kernel = _MemoryFactKernel()
    pursuit_created = work_profile.apply_action(
        "/pursuit",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=pursuit_kernel,
    )
    pursuit_root = pursuit_created["result"]["roleVersions"]["pursuit"]
    pursuit_body = json.loads(pursuit_kernel.versions[pursuit_root]["body"])
    pursuit_body["state"] = "completed"
    pursuit_kernel.versions[pursuit_root]["body"] = json.dumps(
        pursuit_body, sort_keys=True
    )
    pursuit_variant = _successor_request(pursuit_created, action_id="same-visible-task")
    assert {
        "subject": pursuit_variant["subject"],
        "payload": pursuit_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/pursuit", pursuit_variant, conformance=True, kernel=pursuit_kernel
        )["failureCode"]
        == "profile-state-mismatch"
    )

    atlas_kernel = _MemoryFactKernel()
    atlas_created = work_profile.apply_action(
        "/atlas",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=atlas_kernel,
    )
    atlas_root = atlas_created["result"]["roleVersions"]["atlas"]
    atlas_body = json.loads(atlas_kernel.versions[atlas_root]["body"])
    atlas_body["state"] = "stale"
    atlas_kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)
    atlas_variant = _successor_request(atlas_created, action_id="same-visible-task")
    assert {
        "subject": atlas_variant["subject"],
        "payload": atlas_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/atlas", atlas_variant, conformance=True, kernel=atlas_kernel
        )["failureCode"]
        == "atlas-stale"
    )

    warrant_kernel = _MemoryFactKernel()
    warrant_created = work_profile.apply_action(
        "/warrant",
        _profile_request(),
        execute=True,
        conformance=True,
        kernel=warrant_kernel,
    )
    warrant_root = warrant_created["result"]["roleVersions"]["warrant"]
    warrant_body = json.loads(warrant_kernel.versions[warrant_root]["body"])
    warrant_body["details"]["allowedOperations"] = ["atlas:refresh"]
    warrant_kernel.versions[warrant_root]["body"] = json.dumps(
        warrant_body, sort_keys=True
    )
    warrant_variant = _successor_request(warrant_created, action_id="same-visible-task")
    assert {
        "subject": warrant_variant["subject"],
        "payload": warrant_variant["payload"],
    } == visible_task
    assert (
        work_profile.apply_action(
            "/warrant", warrant_variant, conformance=True, kernel=warrant_kernel
        )["failureCode"]
        == "unauthorized"
    )

    # A context-only rival also treats equal endpoints as equal. The Profile's
    # Episode replay fixture above rejects a different causal root, preserving
    # the fifth role even when beforeCutRoot == afterCutRoot.
