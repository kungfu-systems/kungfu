# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import os
import sys
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

from kungfu import host
from kungfu.agent.advisory import (
    evaluate_skill_decision as _evaluate_skill_decision,
    evaluate_work_advisory as _evaluate_work_advisory,
    normalize_skill_signals as _normalize_skill_signals,
    normalize_work_signals as _normalize_work_signals,
)
from kungfu.agent import documentation as documentation_pack

_PACKAGE = "kungfu.agent"
BOOTSTRAP_RECEIPT_SCHEMA = "kungfu.agent-bootstrap-receipt/v1"
_SKILL_DECISION_FILE = "skill-decision.contract.json"


def pack_root():
    shipped = _shipped_pack_root()
    if shipped is not None:
        return shipped
    return resources.files(_PACKAGE)


def _shipped_pack_root():
    # A product build ships the pack at the dist root; argv0 stays as a
    # fallback for entries relocated next to the pack (app Resources).
    candidates = []
    root = host.product_root()
    if root is not None:
        candidates.append(root / "agent")
    argv0 = sys.argv[0] if sys.argv else ""
    if argv0:
        candidates.append(Path(argv0).resolve().parent / "agent")
    for candidate in candidates:
        if (candidate / "index.json").is_file():
            return candidate
    return None


def _read_json(name):
    return json.loads((pack_root() / name).read_text(encoding="utf-8"))


def index():
    return _read_json("index.json")


def commands():
    return _read_json("commands.json")


def intent_map():
    return _read_json("intent-map.json")


def first_value_contract():
    return _read_json("first-value.contract.json")


def first_value_receipt_schema():
    return _read_json("first-value-receipt.schema.json")


def skill_decision_contract():
    return _read_json(_SKILL_DECISION_FILE)


def skill_decision_policy_root() -> str:
    return _byte_root((pack_root() / _SKILL_DECISION_FILE).read_bytes())


def skill_state(target, destination):
    source = skill_path(target).read_bytes()
    destination = Path(destination) / "SKILL.md"
    if not destination.is_file():
        return "absent"
    try:
        installed = destination.read_bytes()
        text = installed.decode("utf-8")
    except (OSError, UnicodeError):
        return "incompatible"
    if (
        not text.startswith("---\n")
        or "\nname:" not in text
        or "\ndescription:" not in text
    ):
        return "incompatible"
    return "current" if installed == source else "stale"


def cli_surface_catalog():
    return _read_json("cli_surface.catalog.json")


def registry():
    return _read_json("kfd3_api.registry.json")


def registry_schema():
    return _read_json("kfd3_api.schema.json")


def profile_sdk_contract():
    return _read_json("profile-sdk.contract.json")


def bootstrap_contract():
    return bootstrap_receipt_schema()["x-kungfu-contract"]


def bootstrap_receipt_schema():
    return _read_json("bootstrap-receipt.schema.json")


def canonical_root(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _byte_root(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def native_bootstrap_receipt(
    provider: str,
    *,
    profile: Mapping[str, Any],
    adapter: Mapping[str, Any],
    session_ref: Mapping[str, str],
) -> dict[str, Any]:
    """Verify the exact first-entry material delivered before provider start."""

    diagnostics: list[dict[str, str]] = []
    roots: dict[str, Any] = {
        "runtimeProfile": canonical_root(dict(profile)),
        "agentPack": None,
        "brief": None,
        "intentMap": None,
        "documentationAtlas": None,
        "documentationPack": None,
        "documentationManifest": None,
        "documentationReceipt": None,
        "providerSkill": None,
    }
    try:
        roots.update(
            {
                "agentPack": canonical_root(index()),
                "brief": _byte_root(document_text("brief.md").encode("utf-8")),
                "intentMap": canonical_root(intent_map()),
            }
        )
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError) as error:
        diagnostics.append({"code": "agent-pack-unavailable", "detail": str(error)})
    try:
        verification = documentation_pack.verify()
        if verification.get("valid") is True:
            roots.update(
                {
                    "documentationAtlas": verification.get("atlasRoot"),
                    "documentationPack": verification.get("packRoot"),
                    "documentationManifest": verification.get("manifestRoot"),
                    "documentationReceipt": verification.get("receiptRoot"),
                }
            )
        else:
            diagnostics.append(
                {
                    "code": "documentation-pack-invalid",
                    "detail": json.dumps(
                        verification.get("diagnostics") or [],
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                }
            )
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError) as error:
        diagnostics.append(
            {"code": "documentation-pack-unavailable", "detail": str(error)}
        )
    skill_file = str(adapter.get("skillFile") or "").strip()
    if skill_file:
        try:
            roots["providerSkill"] = _byte_root(
                Path(skill_file).expanduser().resolve().read_bytes()
            )
        except (FileNotFoundError, OSError) as error:
            diagnostics.append(
                {"code": "provider-skill-unavailable", "detail": str(error)}
            )
    else:
        diagnostics.append(
            {
                "code": "provider-skill-unavailable",
                "detail": "materialized adapter did not declare skillFile",
            }
        )
    required_roots = (
        "agentPack",
        "brief",
        "intentMap",
        "documentationAtlas",
        "documentationPack",
        "documentationManifest",
        "documentationReceipt",
        "providerSkill",
    )
    verified = not diagnostics and all(roots[key] for key in required_roots)
    body = {
        "schema": BOOTSTRAP_RECEIPT_SCHEMA,
        "attemptId": str(session_ref["sessionAttemptId"]),
        "consoleId": str(session_ref["workConsoleId"]),
        "provider": provider,
        "state": "verified" if verified else "degraded",
        "result": "delivered" if verified else "diagnostic-only",
        "mutationsAllowed": verified,
        "deliveredBeforeProviderStart": True,
        "invocationOrder": [
            "verify-agent-pack",
            "verify-documentation-atlas",
            "verify-provider-skill",
            "publish-native-environment",
            "start-provider-process",
        ],
        "roots": roots,
        "diagnostics": diagnostics,
        "nonClaims": [
            "delivery-does-not-prove-provider-comprehension",
            "bootstrap-does-not-grant-work-authority",
            "provider-exit-does-not-prove-work-completion",
        ],
    }
    return {**body, "receiptRoot": canonical_root(body)}


def bootstrap_context(receipt: Mapping[str, Any] | None) -> dict[str, Any]:
    if receipt is None:
        return {
            "schema": BOOTSTRAP_RECEIPT_SCHEMA,
            "state": "not-issued",
            "attemptId": None,
            "receiptRoot": None,
            "mutationsAllowed": False,
        }
    return {
        key: receipt[key]
        for key in ("schema", "state", "attemptId", "receiptRoot", "mutationsAllowed")
    }


def validated_current_bootstrap_receipt(
    envelope: Mapping[str, Any], *, environ: Mapping[str, str] | None = None
) -> dict[str, Any]:
    current = os.environ if environ is None else environ
    raw = current.get("KUNGFU_AGENT_BOOTSTRAP_RECEIPT", "").strip()
    if not raw:
        raise ValueError(
            "native Agent bootstrap receipt is missing; Work mutation is disabled"
        )
    receipt = json.loads(raw)
    body = dict(receipt)
    declared_root = body.pop("receiptRoot", None)
    if receipt.get("schema") != BOOTSTRAP_RECEIPT_SCHEMA:
        raise ValueError(
            "native Agent bootstrap receipt schema is unsupported; "
            "Work mutation is disabled"
        )
    if not isinstance(declared_root, str) or canonical_root(body) != declared_root:
        raise ValueError(
            "native Agent bootstrap receipt root is invalid; Work mutation is disabled"
        )
    attempt_id = str(envelope.get("attemptId") or "")
    if (
        receipt.get("attemptId") != attempt_id
        or current.get("KUNGFU_AGENT_ATTEMPT_ID", attempt_id) != attempt_id
    ):
        raise ValueError(
            "native Agent bootstrap receipt does not match this attempt; "
            "Work mutation is disabled"
        )
    if (
        receipt.get("state") != "verified"
        or receipt.get("mutationsAllowed") is not True
    ):
        raise ValueError(
            "native Agent bootstrap is degraded; inspect "
            "KUNGFU_AGENT_BOOTSTRAP_RECEIPT before retrying Work mutation"
        )
    return receipt


def require_current_native_bootstrap_for_mutation(
    *, environ: Mapping[str, str] | None = None
) -> dict[str, Any] | None:
    current = os.environ if environ is None else environ
    raw = current.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if not raw:
        return None
    return validated_current_bootstrap_receipt(json.loads(raw), environ=current)


def bootstrap_status(*, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    current = os.environ if environ is None else environ
    contract = bootstrap_contract()
    envelope_raw = current.get("KUNGFU_AGENT_CONSOLE_ENVELOPE", "").strip()
    if not envelope_raw:
        return {
            "schema": "kungfu.agent-bootstrap-status/v1",
            "available": False,
            "state": "unavailable",
            "contract": contract,
            "diagnostics": [
                {
                    "code": "not-native-agent-console",
                    "detail": "run inside a provider launched by kungfu run agent",
                }
            ],
        }
    envelope = json.loads(envelope_raw)
    receipt_raw = current.get("KUNGFU_AGENT_BOOTSTRAP_RECEIPT", "").strip()
    if not receipt_raw:
        return {
            "schema": "kungfu.agent-bootstrap-status/v1",
            "available": True,
            "state": "pending",
            "attemptId": envelope["attemptId"],
            "consoleId": envelope["consoleId"],
            "mutationsAllowed": False,
            "contract": contract,
            "diagnostics": [],
        }
    receipt = json.loads(receipt_raw)
    body = dict(receipt)
    declared_root = body.pop("receiptRoot", None)
    diagnostics = list(receipt.get("diagnostics") or [])
    if declared_root != canonical_root(body):
        diagnostics.append(
            {
                "code": "receipt-root-invalid",
                "detail": "bootstrap receipt content does not match receiptRoot",
            }
        )
    if receipt.get("attemptId") != envelope.get("attemptId"):
        diagnostics.append(
            {
                "code": "attempt-mismatch",
                "detail": "bootstrap receipt does not belong to this native attempt",
            }
        )
    state = (
        "verified"
        if not diagnostics
        and receipt.get("state") == "verified"
        and receipt.get("mutationsAllowed") is True
        else "degraded"
    )
    return {
        "schema": "kungfu.agent-bootstrap-status/v1",
        "available": True,
        "state": state,
        "attemptId": envelope["attemptId"],
        "consoleId": envelope["consoleId"],
        "mutationsAllowed": state == "verified",
        "contract": contract,
        "receipt": receipt,
        "diagnostics": diagnostics,
    }


def docs_context() -> dict[str, Any]:
    repo_root = _find_repo_root()
    local = []
    if repo_root is not None:
        local = [
            {"name": "documentation map", "path": str(repo_root / "docs" / "MAP.md")},
            {
                "name": "agent-first global config",
                "path": str(repo_root / "docs" / "config.md"),
            },
        ]
    return {
        "local": local,
        "public": [
            {
                "name": "documentation map",
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/MAP.md",
            },
            {
                "name": "agent-first global config",
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/guides/config.md",
            },
        ],
    }


def _find_repo_root() -> Path | None:
    candidates = [Path.cwd(), Path(__file__).resolve()]
    for candidate in candidates:
        for directory in [candidate, *candidate.parents]:
            if (directory / "docs" / "MAP.md").is_file() and (
                directory / "framework"
            ).is_dir():
                return directory
    return None


def work_authority_capabilities() -> dict[str, Any]:
    return {
        "schema": "kungfu.work.authority-capabilities/v1",
        "commandFamily": "kungfu work",
        "mutationAuthority": "kungfu.assignment-runtime/v1",
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


def agent_activity_history_projection(
    work_ref: Mapping[str, Any] | None, *, entrypoint: str
) -> dict[str, Any]:
    """Keep provider activity explicitly outside semantic Work history."""

    return {
        "schema": "kungfu.work-agent-history.projection/v1",
        "state": "session-activity-only",
        "entrypoint": entrypoint,
        "workRefRoot": canonical_root(work_ref) if work_ref is not None else None,
        "semanticAdmissionReceiptRoot": None,
        "processExitSettlesWork": False,
        "selfReportSettlesWork": False,
        "nextAction": "independent-assessment-required",
        "authority": {
            "contract": "framework/core/data-protection/work-agent-history.contract.json",
            "semanticOwner": "profile-kfd-action-episode",
            "observer": "agent-session",
        },
    }


def session_ref(work: Mapping[str, Any], attempt_id: str) -> dict[str, str]:
    initiative = (
        f":{work['initiativeId']}"
        if work.get("entityType") == "assignment" and work.get("initiativeId")
        else ""
    )
    return {
        "workConsoleId": (
            f"work:{work['profileId']}:{work['entityType']}"
            f"{initiative}:{work['entityId']}"
        ),
        "sessionAttemptId": attempt_id,
    }


def validate_work_advisory_signals(value: Mapping[str, Any]) -> dict[str, Any]:
    return _normalize_work_signals(value)


def assess_work_advisory(value: Mapping[str, Any]) -> dict[str, Any]:
    return _evaluate_work_advisory(value)


def validate_skill_decision_signals(value: Mapping[str, Any]) -> dict[str, Any]:
    return _normalize_skill_signals(value)


def assess_skill_decision(value: Mapping[str, Any]) -> dict[str, Any]:
    return _evaluate_skill_decision(value)


def document_text(name):
    return (pack_root() / name).read_text(encoding="utf-8")


def skill_path(target):
    return pack_root() / "skills" / target / "SKILL.md"


def choose_mode(
    *,
    command=None,
    needs_supervision=False,
    has_existing_run=False,
    needs_structured_work=False,
    remote_runtime=False,
):
    if remote_runtime:
        mode = "remote-sync"
        reason = "Remote/runtime boundary is the primary constraint."
    elif has_existing_run or command:
        mode = "trace"
        reason = "There is an existing command or run to capture without rewriting it."
    elif needs_supervision:
        mode = "managed-run"
        reason = (
            "A provider CLI should run under Kungfu supervision and cost/audit capture."
        )
    elif needs_structured_work:
        mode = "report"
        reason = "The task mainly needs structured work facts rather than a captured process."
    else:
        mode = "brief"
        reason = "No runtime action is required; read the local pack first."
    return {
        "schema": "kungfu.agent-mode-choice/v1",
        "mode": mode,
        "reason": reason,
        "command": command,
        "maturity": commands()["modes"][mode]["maturity"],
        "next": commands()["modes"][mode]["next"],
    }
