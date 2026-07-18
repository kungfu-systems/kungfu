# SPDX-License-Identifier: Apache-2.0

import copy
import hashlib
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
from kungfu.agent import work_profile  # noqa: E402
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
        f"FO{index}" for index in range(1, 9)
    ]
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
    assert any(
        row["apiId"] == "kungfu.agent.work-model"
        and row["name"] == "kungfu agent work-model --json"
        for row in payload["commands"]["commands"]
    )


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


def test_kfd7_profile_capabilities_and_typed_responsibility_gap():
    capabilities = work_profile.capabilities()
    assert capabilities["roles"] == ["fact", "episode", "pursuit", "atlas", "warrant"]
    assert "stale-ref" in capabilities["denials"]
    assert capabilities["recovery"]["projectionRebuild"]["identity"] == "preserved"
    assert (
        capabilities["recovery"]["cleanHome"]["lossCode"]
        == "profile-authority-unavailable"
    )
    request = _profile_request()
    del request["responsibilities"]["warrant"]

    denied = work_profile.apply_action("/unused", request, kernel=_MemoryFactKernel())

    assert denied["status"] == "denied"
    assert denied["failureCode"] == "responsibility-gap"
    assert denied["writeOccurred"] is False


def test_kfd7_profile_action_and_receipt_schemas_cover_runtime_vectors():
    root = Path(__file__).resolve().parents[4]
    action_schema = json.loads(
        (
            root / "framework/agent-work/kungfu-kfd-7-profile-action.schema.json"
        ).read_text()
    )
    receipt_schema = json.loads(
        (
            root / "framework/agent-work/kungfu-kfd-7-profile-receipt.schema.json"
        ).read_text()
    )
    request = _profile_request()
    planned = work_profile.apply_action("/unused", request, kernel=_MemoryFactKernel())

    assert list(Draft202012Validator(action_schema).iter_errors(request)) == []
    assert list(Draft202012Validator(receipt_schema).iter_errors(planned)) == []


def test_kfd7_profile_bootstrap_continue_inspect_and_replay_fail_closed():
    kernel = _MemoryFactKernel()
    request = _profile_request()

    planned = work_profile.apply_action("/runtime", request, kernel=kernel)
    created = work_profile.apply_action(
        "/runtime", request, execute=True, kernel=kernel
    )
    inspected = work_profile.inspect("/runtime", request["refName"], kernel=kernel)

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
        "/runtime", continued_request, execute=True, kernel=kernel
    )
    assert continued["status"] == "accepted"
    assert continued["result"]["revision"] == 2

    stale_request = _successor_request(created, action_id="stale-writer")
    stale = work_profile.apply_action(
        "/runtime", stale_request, execute=True, kernel=kernel
    )
    assert stale["status"] == "denied"
    assert stale["failureCode"] == "stale-ref"
    assert stale["writeOccurred"] is True
    assert stale["refWriteOccurred"] is False

    replay_mismatch_request = _successor_request(created)
    replay_mismatch_request["payload"] = {"continuation": "different-bytes"}
    replay_mismatch = work_profile.apply_action(
        "/runtime", replay_mismatch_request, execute=True, kernel=kernel
    )
    assert replay_mismatch["status"] == "denied"
    assert replay_mismatch["failureCode"] == "replay-mismatch"


def test_kfd7_profile_rejects_stale_atlas_and_expired_warrant_before_writes():
    kernel = _MemoryFactKernel()
    created = work_profile.apply_action(
        "/runtime", _profile_request(), execute=True, kernel=kernel
    )
    stale_atlas_request = _successor_request(created, action_id="atlas-stale")
    atlas_root = created["result"]["roleVersions"]["atlas"]
    atlas_body = json.loads(kernel.versions[atlas_root]["body"])
    atlas_body["state"] = "stale"
    kernel.versions[atlas_root]["body"] = json.dumps(atlas_body, sort_keys=True)

    stale_atlas = work_profile.apply_action(
        "/runtime", stale_atlas_request, execute=True, kernel=kernel
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
        kernel=kernel,
    )

    assert expired["failureCode"] == "warrant-expired"
    assert expired["writeOccurred"] is False
