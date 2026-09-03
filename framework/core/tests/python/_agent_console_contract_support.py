# SPDX-License-Identifier: Apache-2.0
# ruff: noqa: F401,F811

from pathlib import Path
import json
import os
import select
import subprocess
from types import SimpleNamespace
import sys
import time
import tomllib

from click.testing import CliRunner
import pytest
from jsonschema import Draft202012Validator

from kungfu import config
from kungfu.agent import native_launch
from kungfu.agent import run_agent
from kungfu.agent import runtime_profiles
from kungfu.agent import session_contract
from kungfu.cli.commands import agent as agent_commands, kfc
from kungfu.rewind.cost.discovery import discover_provider_candidates
from kungfu.workspace import resolve_workspace_target
from agent_bootstrap_fixtures import verified_bootstrap_receipt


ROOT = Path(__file__).resolve().parents[4]
CONTRACT = ROOT / "framework" / "config" / "kungfu-config.contract.json"
ROOT_HASH = "sha256:" + "a" * 64


def _contract():
    return config.load_contract(str(CONTRACT))


def _work_ref():
    return {
        "schema": "kungfu.work-ref/v1",
        "workspaceId": "workspace:test",
        "profileId": "kungfu.work-control",
        "profileRoot": ROOT_HASH,
        "entityType": "assignment",
        "entityId": "assignment:test",
        "entityRoot": ROOT_HASH,
        "purpose": "delegated-work",
        "systemTimeCut": "2026-07-13T00:00:00Z",
        "initiativeId": "initiative:test",
    }


def _skill_runtime_pointer():
    return {
        "schema": "kungfu.skill-runtime-audit-pointer/v1",
        "path": "/runtime/skill-manager/agent-console-attempt-1.json",
        "runtimeAuditRoot": ROOT_HASH,
        "registryStateRoot": ROOT_HASH,
        "historyRoot": ROOT_HASH,
        "diagnosisRoot": ROOT_HASH,
        "catalogRoot": ROOT_HASH,
        "decisionPolicyRoot": ROOT_HASH,
        "workRefRoot": ROOT_HASH,
        "kfxDependencyRoots": [ROOT_HASH],
        "receiptRoots": [ROOT_HASH],
        "recoveryRoot": ROOT_HASH,
        "entrypoints": {
            "catalog": ["kungfu", "skill", "catalog", "--json"],
            "advise": ["kungfu", "agent", "skill-advisory", "--json"],
            "read": ["kungfu", "skill", "read", "<key>", "--json"],
            "audit": ["kungfu", "skill", "audit", "--json"],
            "explain": ["kungfu", "skill", "explain", "<key>", "--json"],
            "diagnose": ["kungfu", "skill", "diagnose", "--json"],
            "kfx": ["kungfu", "kfx", "native", "status", "--json"],
        },
        "authority": "read-only-projection",
    }


def _third_party_adapter(skill_source, *, provider="termagent"):
    return {
        "schema": "kungfu.native-provider-adapter/v1",
        "id": provider,
        "label": "Terminal Agent",
        "discovery": {
            "executableNames": [provider],
            "knownPaths": [],
            "versionArgv": ["--version"],
        },
        "credentialEnvironment": ["TERMAGENT_API_KEY"],
        "skill": {
            "source": str(skill_source),
            "argv": ["--instructions", "{skill_file}"],
            "environment": {"TERMAGENT_SKILL": "{skill_file}"},
            "environmentJson": {
                "TERMAGENT_CONTEXT": {
                    "skill": "{skill_file}",
                    "root": "{adapter_root}",
                }
            },
            "files": [
                {
                    "path": "settings.json",
                    "content": {"skills": ["{skills_root}"]},
                }
            ],
        },
        "knownLimits": ["synthetic third-party qualification adapter"],
    }


__all__ = [name for name in globals() if not name.startswith("__")]
