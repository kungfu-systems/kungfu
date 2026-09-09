# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

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
