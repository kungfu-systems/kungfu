# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu.agent.provider_bootstrap import refresh_native_skill_runtime_audit
from kungfu.canonical_json import canonical_json_bytes
from kungfu.cli.commands import kfc
import kungfu.cli.commands.agent as agent_command_module
import kungfu.cli.commands.skill as skill_command_module
import kungfu.skill.dependencies as skill_authority
import kungfu.skill.registry as skill_registry_module
from kungfu.coordination import locks
from kungfu.skill import (
    SkillAuthorityError,
    SkillRegistryError,
    apply_plan,
    dependency_audit_event,
    diagnose_registry,
    diff_revisions,
    discover_skills,
    inspect_registry,
    invoke_dependency_plan,
    normalize_package,
    plan_operation,
    plan_dependency_invocation,
    build_skill_runtime_audit,
    project_skill_runtime_audit,
    registry_history,
    registry_root,
)

assert agent_command_module and skill_command_module


def test_skill_registry_responsibility_modules_are_bounded():
    registry_path = Path(skill_registry_module.__file__).resolve()
    budgets = {
        registry_path: 850,
        registry_path.parent / "_registry" / "support.py": 450,
    }
    for source, maximum in budgets.items():
        assert len(source.read_text(encoding="utf-8").splitlines()) <= maximum


def _root(value) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"


def _package(
    root: Path,
    *,
    revision: int = 1,
    predecessor: dict | None = None,
    body: str = "# Exact Skill\n\nUse exact retained evidence.\n",
    skill_class: str = "instruction-only",
    dependencies: dict | None = None,
    effects: dict | None = None,
) -> Path:
    root.mkdir(parents=True)
    raw = body.encode()
    member = {
        "path": "SKILL.md",
        "root": f"sha256:{hashlib.sha256(raw).hexdigest()}",
        "bytes": len(raw),
        "mediaType": "text/markdown",
    }
    content_root = _root(
        {
            "schema": "kungfu.skill-content-closure/v2",
            "entrypoint": "SKILL.md",
            "members": [member],
        }
    )
    definition = {
        "schema": "kungfu.skill-definition/v2",
        "identity": {
            "key": "exact-skill",
            "revision": revision,
            "contentRoot": content_root,
        },
        "class": skill_class,
        "content": {
            "algorithm": "sha256-canonical-json",
            "root": content_root,
            "entrypoint": "SKILL.md",
            "members": [member],
        },
        "provenance": {
            "sourceKind": "workspace",
            "sourceRoot": _root({"source": revision, "body": body}),
            "sourceRef": f"workspace:test@{revision}",
            "generated": False,
        },
        "scope": {
            "distribution": "workspace-local",
            "appliesTo": ["test"],
            "work": {
                "binding": (
                    "optional" if skill_class == "instruction-only" else "required"
                ),
                "selectionAuthority": "kungfu-work",
                "completionAuthority": "kungfu-work",
            },
        },
        "dependencies": dependencies or {"kfx": [], "profiles": []},
        "effects": effects or {"mode": "none", "declarations": []},
        "compatibility": {
            "contractVersion": 2,
            "predecessor": predecessor,
            "requires": [
                {
                    "surface": "skill",
                    "contractRoot": _root({"contract": "skill-v2"}),
                }
            ],
            "history": "preserve-original-meaning",
        },
        "proof": {
            "requirements": [
                {
                    "id": "focused-test",
                    "kind": "check",
                    "description": "Run focused lifecycle tests.",
                }
            ],
            "completion": "work-acceptance-not-skill-output",
        },
        "recovery": {
            "strategy": "disable-and-inspect",
            "steps": ["Inspect the exact retained root."],
            "history": "preserve-roots-receipts-and-work-meaning",
        },
        "authority": {
            "capability": (
                "none"
                if skill_class == "instruction-only"
                else "separate-kfx-admission-required"
            ),
            "work": "reference-only",
            "profile": "reference-only",
            "factEpisode": "reference-only",
            "kfd": "reference-only",
            "kfx": "reference-only",
            "nonClaims": [
                "skill-prose-is-not-capability",
                "skill-is-not-work-authority",
                "skill-is-not-profile-authority",
                "skill-is-not-fact-or-episode-authority",
                "skill-is-not-kfd-authority",
                "skill-is-not-kfx-authority",
                "selection-load-or-invocation-is-not-completion",
                "retirement-does-not-reinterpret-history",
            ],
        },
    }
    (root / "SKILL.md").write_bytes(raw)
    (root / "skill-definition.json").write_text(
        json.dumps(definition, indent=2) + "\n", encoding="utf-8"
    )
    return root


def _apply(home: Path, operation: str, **kwargs):
    plan = plan_operation(home, operation, **kwargs)
    return plan, apply_plan(home, plan, expected_plan_root=plan["planRoot"])


def _install_and_select(home: Path, package: Path, work_ref: str, work_root: str):
    _apply(home, "install", source=package)
    _apply(
        home,
        "select",
        key="exact-skill",
        work_ref=work_ref,
        work_root=work_root,
    )


def _admitted_kfx_plan(
    dependency: dict,
    *,
    host: str,
    cut_root: str,
    policy_root: str,
    execution_allowed: bool = True,
    admission_grade: str = "kfd-attested",
):
    return {
        "schema": "kungfu.kfx.load-plan/v2",
        "revision": dependency["revision"],
        "planRoot": "sha256:" + "2" * 64,
        "graphRoot": "sha256:" + "3" * 64,
        "packages": [
            {
                "key": dependency["key"],
                "revision": dependency["revision"],
                "packageRoot": dependency["root"],
                "admissionGrade": admission_grade,
                "apiCompatibility": {"compatible": True},
                "declaredCapabilities": dependency["capabilityRequests"],
            }
        ],
        "hostContract": {
            "admission": {"state": "admitted"},
            "revision": dependency["revision"],
            "generationRoot": "sha256:" + "7" * 64,
            "runtimeAuthorizations": [
                {
                    "packageKey": dependency["key"],
                    "packageRoot": dependency["root"],
                    "host": host,
                    "revision": dependency["revision"],
                    "generationRoot": "sha256:" + "7" * 64,
                    "policyRoot": policy_root,
                    "cutRoot": cut_root,
                    "executionAllowed": execution_allowed,
                    "grantedCapabilities": dependency["capabilityRequests"],
                    "authorizationRoot": "sha256:" + "4" * 64,
                    "capabilityGrantRoot": "sha256:" + "5" * 64,
                    "reportRoot": "sha256:" + "6" * 64,
                }
            ],
        },
    }
