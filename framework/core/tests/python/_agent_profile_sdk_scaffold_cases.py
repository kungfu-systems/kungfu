# SPDX-License-Identifier: Apache-2.0
"""Profile scaffold, conformance, and collaboration setup cases."""

import hashlib
import json
from pathlib import Path

import pytest

from kungfu import profile_sdk
from kungfu.cli.commands import __registry__  # noqa: F401


def brief(**changes):
    value = {
        "schema": "kungfu.profile-brief/v1",
        "id": "example.week-day",
        "title": "Week / Day",
        "version": "1.0.0",
        "purposes": ["operator-review", "handoff"],
        "permissions": [],
        "identity": {"authority": "workspace-owner"},
        "evidence": {"strength": "reported-with-references"},
        "migration": {"mode": "additive"},
    }
    value.update(changes)
    return value


def collaboration_brief():
    return {
        "summary": "Coordinate Week and Day work without hiding authority.",
        "participantBenefits": [
            {
                "participantKind": "human",
                "description": "Review exact plans and receipts.",
            },
            {
                "participantKind": "agent",
                "description": "Discover constraints and execute authorized intents.",
            },
        ],
        "participants": [
            {
                "id": "owner",
                "kind": "human",
                "title": "Owner",
                "authorityClasses": ["workflow-owner"],
            },
            {"id": "worker", "kind": "agent", "title": "Agent", "authorityClasses": []},
        ],
        "constraints": [
            {
                "id": "authorization",
                "description": "Material actions require declared authority.",
                "enforcement": "runtime",
                "appliesTo": ["*"],
            }
        ],
        "knownLimits": [
            {
                "id": "identity",
                "description": "Actor identity is externally verified.",
                "effect": "external-verification-required",
            }
        ],
    }


def create_source(tmp_path):
    source = tmp_path / "profile"
    plan = profile_sdk.scaffold_plan(brief(), source)
    assert plan["ok"] is True
    receipt = profile_sdk.apply_scaffold(plan)
    assert receipt["verified"] is True
    return source, plan


def create_symlink_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows runner does not grant symlink creation privilege")
        raise


def test_work_conformance_prefers_the_embedded_product_node_host(tmp_path, monkeypatch):
    front_door = tmp_path / "kungfu"
    front_door.write_bytes(b"")
    checker = tmp_path / "work-profile-conformance.mjs"
    checker.write_bytes(b"")
    monkeypatch.setenv("KUNGFU_CONTROLLER_ENTRYPOINT", str(front_door))
    monkeypatch.setattr(profile_sdk.shutil, "which", lambda _name: "/poison/node")

    command, environment = profile_sdk._work_profile_conformance_invocation(checker)

    assert command == [str(front_door.resolve()), str(checker)]
    assert environment is not None
    assert environment["KUNGFU_AS_VARIANT"] == "node"
    assert environment["KUNGFU_NODE_VARIANT_ENTRY"] == str(checker)


def test_work_conformance_falls_back_to_path_node_without_a_product_host(
    tmp_path, monkeypatch
):
    checker = tmp_path / "work-profile-conformance.mjs"
    checker.write_bytes(b"")
    monkeypatch.delenv("KUNGFU_CONTROLLER_ENTRYPOINT", raising=False)
    monkeypatch.delenv("KUNGFU_AGENT_SESSION_EXECUTABLE", raising=False)
    monkeypatch.setattr(profile_sdk.shutil, "which", lambda _name: "/toolchain/node")

    command, environment = profile_sdk._work_profile_conformance_invocation(checker)

    assert command == ["/toolchain/node", str(checker)]
    assert environment is None


def test_scaffold_writes_the_exact_planned_utf8_bytes(tmp_path):
    source = tmp_path / "profile"
    plan = profile_sdk.scaffold_plan(brief(), source)

    receipt = profile_sdk.apply_scaffold(plan)

    assert receipt["verified"] is True
    for relative, text in plan["files"].items():
        assert (source / relative).read_bytes() == text.encode("utf-8")


def _write_json(path, value):
    data = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {
        "path": path.relative_to(path.parents[1]).as_posix(),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _symlink_or_skip(link, target, *, target_is_directory=False):
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            pytest.skip("Windows runner account cannot create symbolic links")
        raise


def add_collaboration(source):
    actions = {
        "schema": "kungfu.profile-actions/v1",
        "actions": [
            {
                "id": "complete-day",
                "title": "Complete day",
                "runner": "kfx-member",
                "operation": "example-week-day-actions",
                "runtimeOperation": "episode.append",
                "authorityClass": "workflow-owner",
                "requiredCapabilities": [],
                "effects": ["append-admitted-fact"],
            }
        ],
    }
    views = {
        "schema": "kungfu.profile-views/v1",
        "views": [
            {
                "id": "week-state",
                "title": "Week state",
                "factSurfaces": ["example.week-day.day"],
                "definition": {"schema": "kungfu.query.definition/v1"},
                "view": {
                    "kind": "profile",
                    "profileId": "example.week-day",
                    "profileVersion": "1.0.0",
                    "memberId": "example-week-day-dashboard",
                    "viewId": "week-plan",
                    "spec": {
                        "schema": "example.week-day.week-plan-view/v1",
                        "layout": "cards",
                        "dayField": "subject_key",
                    },
                },
            }
        ],
    }
    collaboration = {
        "schema": "kungfu.profile-collaboration/v1",
        "profileId": "example.week-day",
        "value": {
            "summary": "Coordinate Week and Day work without hiding authority.",
            "participantBenefits": [
                {
                    "participantKind": "human",
                    "description": "Review exact plans and receipts.",
                },
                {
                    "participantKind": "agent",
                    "description": "Discover constraints and execute authorized intents.",
                },
            ],
        },
        "participants": [
            {
                "id": "owner",
                "kind": "human",
                "title": "Owner",
                "authorityClasses": ["workflow-owner"],
            },
            {"id": "worker", "kind": "agent", "title": "Agent", "authorityClasses": []},
        ],
        "intents": [
            {
                "id": "complete-day",
                "title": "Complete day",
                "actionId": "complete-day",
                "inspectViewId": "week-state",
                "verifyViewId": "week-state",
                "requiredAuthority": "workflow-owner",
                "requiredCapabilities": [],
                "material": True,
                "protocol": {
                    "inspect": "profile.intent.inspect",
                    "advise": "profile.intent.advise",
                    "preview": "profile.intent.plan",
                    "authorize": "profile.decide",
                    "execute": "profile.intent.apply",
                    "receipt": "profile.intent.receipt",
                    "verify": "profile.intent.verify",
                },
            }
        ],
        "constraints": [
            {
                "id": "authorization",
                "description": "Owner approval is required.",
                "enforcement": "runtime",
                "appliesTo": ["*"],
            }
        ],
        "knownLimits": [
            {
                "id": "identity",
                "description": "Actor identity is externally verified.",
                "effect": "external-verification-required",
            }
        ],
        "presentation": {"mode": "generic", "homeViewId": "week-state"},
    }
    action_ref = _write_json(source / "actions" / "registry.json", actions)
    view_ref = _write_json(source / "views" / "registry.json", views)
    collaboration_ref = _write_json(
        source / "collaboration" / "interface.json", collaboration
    )
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["actions"]["registry"] = action_ref
    profile["views"]["registry"] = view_ref
    profile["kfd3"] = {"collaboration": collaboration_ref}
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return collaboration


def make_collaboration_action_lifecycle(source):
    collaboration = add_collaboration(source)
    actions_path = source / "actions" / "registry.json"
    actions = json.loads(actions_path.read_text())
    actions["actions"][0].update(
        {
            "title": "Remove Profile",
            "runner": "profile-lifecycle",
            "operation": "remove",
            "effects": ["append-Removed-event"],
        }
    )
    action_ref = _write_json(actions_path, actions)
    profile_path = source / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["actions"]["registry"] = action_ref
    profile_path.write_text(json.dumps(profile, indent=2, sort_keys=True) + "\n")
    return collaboration
