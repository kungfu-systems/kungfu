# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shlex
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from jsonschema import Draft202012Validator

import kungfu
from kungfu.agent import resources


RECEIPT_SCHEMA = "kungfu.agent-first-value-receipt/v1"
REVISION = re.compile(r"^[0-9a-f]{40,64}$")
Runner = Callable[[list[str], int, int], tuple[int, bytes, bytes]]
SubprocessError = subprocess.SubprocessError


def work_authority_capabilities():
    return {
        "schema": "kungfu.work.authority-capabilities/v1",
        "commandFamily": "kungfu work",
        "mutationAuthority": "work-control-profile-actions",
        "durableEvidence": ["episode", "fact", "action-receipt"],
        "commands": [
            "capture",
            "admit",
            "claim",
            "kickoff",
            "stage",
            "claim-completion",
            "review",
            "decide",
            "seal",
        ],
        "readCommands": ["status", "gate", "verify-binding", "verify-seal"],
        "legacyStore": False,
    }


def _root_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _root(value: Any) -> str:
    return _root_bytes(_canonical_bytes(value))


def _resource_bytes(name: str) -> bytes:
    return (resources.pack_root() / name).read_bytes()


def contract() -> dict[str, Any]:
    payload = resources.first_value_contract()
    prompt = payload.get("prompt") or {}
    if prompt.get("root") != _root_bytes(str(prompt.get("text", "")).encode("utf-8")):
        raise ValueError("first-value contract prompt root mismatch")
    return payload


def contract_view() -> dict[str, Any]:
    payload = contract()
    roots = _pack_roots()
    return {
        "schema": "kungfu.agent-first-value-contract-view/v1",
        "contract": payload,
        "productIdentity": _product_identity(roots),
        "receiptSchema": resources.first_value_receipt_schema(),
    }


def validate_brief(text: str) -> str:
    if len(text.encode("utf-8")) > 8192 or len(text.splitlines()) > 120:
        raise ValueError("installed Agent brief exceeds its 8192-byte/120-line budget")
    return text


def intent_map_view() -> dict[str, Any]:
    payload = resources.intent_map()
    required = payload.get("requiredIntentIds", [])
    actual = [row.get("id") for row in payload.get("intents", [])]
    if len(actual) != len(set(actual)) or set(required) != set(actual):
        raise ValueError("installed Agent intent map has invalid required coverage")
    return payload


def _pack_roots() -> dict[str, str]:
    return {
        "contractRoot": _root_bytes(_resource_bytes("first-value.contract.json")),
        "briefRoot": _root_bytes(_resource_bytes("brief.md")),
        "intentMapRoot": _root_bytes(_resource_bytes("intent-map.json")),
    }


def _source_revision() -> str | None:
    build_info = kungfu.__build_info__
    intrinsic = str((build_info.get("git") or {}).get("revision") or "").strip()
    requested = os.environ.get("KUNGFU_FIRST_VALUE_SOURCE_REVISION", "").strip()
    if intrinsic and not REVISION.fullmatch(intrinsic):
        raise ValueError("kungfu build-info source revision is not a Git object id")
    if requested and not REVISION.fullmatch(requested):
        raise ValueError("KUNGFU_FIRST_VALUE_SOURCE_REVISION is not a Git object id")
    if intrinsic and requested and intrinsic != requested:
        raise ValueError(
            "KUNGFU_FIRST_VALUE_SOURCE_REVISION does not match kungfu build-info"
        )
    return intrinsic or requested or None


def _product_identity(roots: dict[str, str]) -> dict[str, Any]:
    identity = {
        "version": kungfu.__version__,
        **roots,
        "sourceRevision": _source_revision(),
    }
    identity["candidateRoot"] = _root(identity)
    return identity


def _intent(intent_id: str) -> dict[str, Any]:
    rows = resources.intent_map().get("intents") or []
    matches = [row for row in rows if row.get("id") == intent_id]
    if len(matches) != 1:
        raise ValueError(f"first-value intent is not uniquely declared: {intent_id}")
    return matches[0]


def _matches_template(template: str, actual: list[str]) -> bool:
    expected = shlex.split(template)
    if len(expected) != len(actual):
        return False
    for left, right in zip(expected, actual, strict=True):
        if left.startswith("<") and left.endswith(">"):
            if not right:
                return False
        elif left != right:
            return False
    return True


def validate_discovery(intent_id: str, command: str) -> tuple[list[str], str]:
    try:
        argv = shlex.split(command)
    except ValueError as error:
        raise ValueError(
            f"first-value discovery command is invalid: {error}"
        ) from error
    if not argv or argv[0] != "kungfu":
        raise ValueError("first-value discovery must invoke the current kungfu CLI")
    if "--execute" in argv:
        raise ValueError("first-value discovery cannot contain --execute")
    row = _intent(intent_id)
    declared = row.get("discoveryCommands") or []
    if not any(_matches_template(template, argv) for template in declared):
        raise ValueError(
            f"first-value discovery is not declared by intent {intent_id}: {command}"
        )
    safety_class = "read-only" if row.get("access") == "read-only" else "preview-safe"
    return argv, safety_class


def _default_runner(argv: list[str], timeout: int, maximum: int):
    explicit = os.environ.get("KUNGFU_CLI_BIN", "").strip()
    if explicit:
        launch = [explicit]
    elif getattr(sys, "frozen", False):
        launch = [sys.executable]
    elif Path(sys.argv[0]).name in {"kungfu", "kungfu.exe"}:
        launch = [sys.argv[0]]
    else:
        launch = [sys.executable, "-m", "kungfu"]
    result = subprocess.run(
        [*launch, *argv[1:]],
        check=False,
        capture_output=True,
        timeout=timeout,
    )
    stdout = result.stdout or b""
    stderr = result.stderr or b""
    if len(stdout) > maximum or len(stderr) > maximum:
        raise ValueError("first-value discovery exceeded the bounded output budget")
    return result.returncode, stdout, stderr


def create_receipt(
    *,
    intent_id: str,
    discovery_command: str,
    question_count: int,
    outcome_summary: str,
    runner: Runner | None = None,
    observed_at: str | None = None,
    attempt_id: str | None = None,
) -> dict[str, Any]:
    first_value_contract = contract()
    maximum_questions = first_value_contract["result"]["maximumQuestionCount"]
    if (
        not isinstance(question_count, int)
        or not 0 <= question_count <= maximum_questions
    ):
        raise ValueError(f"first-value question count must be 0..{maximum_questions}")
    if not outcome_summary.strip() or len(outcome_summary.encode("utf-8")) > 512:
        raise ValueError("first-value outcome summary must be 1..512 UTF-8 bytes")

    argv, safety_class = validate_discovery(intent_id, discovery_command)
    policy = first_value_contract["result"]["discoveryPolicy"]
    execute = runner or _default_runner
    returncode, stdout, stderr = execute(
        argv,
        int(policy["timeoutSeconds"]),
        int(policy["maximumOutputBytes"]),
    )
    if returncode != 0:
        error_root = _root_bytes(stderr or stdout)
        raise ValueError(
            f"first-value discovery failed with exit {returncode}; output root {error_root}"
        )
    if not stdout:
        raise ValueError("first-value discovery returned no verifiable output")

    roots = _pack_roots()
    output_root = _root_bytes(stdout)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "verdict": "verified",
        "attemptId": attempt_id
        or os.environ.get("KUNGFU_FIRST_VALUE_ATTEMPT_ID", "").strip()
        or f"attempt-{uuid.uuid4()}",
        "provider": {
            "surface": "kungfu-cli",
            "qualificationScope": "candidate-local-rerun",
        },
        "platform": {
            "system": platform.system().lower(),
            "machine": platform.machine().lower(),
        },
        "promptRoot": first_value_contract["prompt"]["root"],
        "productIdentity": _product_identity(roots),
        "questionCount": question_count,
        "intentId": intent_id,
        "discovery": {
            "command": discovery_command,
            "safetyClass": safety_class,
            "exitCode": 0,
            "outputRoot": output_root,
            "outputBytes": len(stdout),
        },
        "outcome": {
            "kind": "verified-discovery",
            "summaryRoot": _root_bytes(outcome_summary.strip().encode("utf-8")),
            "verificationRoot": _root(
                {
                    "command": discovery_command,
                    "exitCode": 0,
                    "outputRoot": output_root,
                }
            ),
        },
        "nonClaims": list(first_value_contract["qualification"]["nonClaims"]),
        "diagnostics": [],
        "observedAt": observed_at
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    receipt["receiptRoot"] = _root(receipt)
    verify_receipt(receipt, require_current_product=True)
    return receipt


def verify_receipt(
    receipt: dict[str, Any], *, require_current_product: bool = True
) -> dict[str, Any]:
    schema = resources.first_value_receipt_schema()
    errors = sorted(
        Draft202012Validator(schema).iter_errors(receipt),
        key=lambda error: list(error.path),
    )
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.path) or "<root>"
        raise ValueError(
            f"first-value receipt schema mismatch at {location}: {error.message}"
        )
    subject = dict(receipt)
    receipt_root = subject.pop("receiptRoot")
    if receipt_root != _root(subject):
        raise ValueError("first-value receipt root mismatch")

    first_value_contract = contract()
    if receipt["promptRoot"] != first_value_contract["prompt"]["root"]:
        raise ValueError("first-value receipt prompt root mismatch")
    _, safety_class = validate_discovery(
        receipt["intentId"], receipt["discovery"]["command"]
    )
    if receipt["discovery"]["safetyClass"] != safety_class:
        raise ValueError("first-value receipt discovery safety class mismatch")
    identity = dict(receipt["productIdentity"])
    candidate_root = identity.pop("candidateRoot")
    if candidate_root != _root(identity):
        raise ValueError("first-value receipt candidate root mismatch")
    verification_root = _root(
        {
            "command": receipt["discovery"]["command"],
            "exitCode": receipt["discovery"]["exitCode"],
            "outputRoot": receipt["discovery"]["outputRoot"],
        }
    )
    if receipt["outcome"]["verificationRoot"] != verification_root:
        raise ValueError("first-value receipt outcome verification root mismatch")
    required_non_claims = set(first_value_contract["qualification"]["nonClaims"])
    if set(receipt["nonClaims"]) != required_non_claims:
        raise ValueError("first-value receipt non-claims mismatch")
    if require_current_product:
        expected = _product_identity(_pack_roots())
        if receipt["productIdentity"] != expected:
            raise ValueError("first-value receipt product identity mismatch")
    return {
        "schema": "kungfu.agent-first-value-receipt-verification/v1",
        "verified": True,
        "receiptRoot": receipt_root,
        "candidateRoot": receipt["productIdentity"]["candidateRoot"],
        "intentId": receipt["intentId"],
    }


def read_receipt(path: str | Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise ValueError("first-value receipt must be a JSON object")
    return value
