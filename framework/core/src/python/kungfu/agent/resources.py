# SPDX-License-Identifier: Apache-2.0

import hashlib
import json
import os
import sys
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

from kungfu import host
from kungfu.agent import documentation as documentation_pack

_PACKAGE = "kungfu.agent"
BOOTSTRAP_RECEIPT_SCHEMA = "kungfu.agent-bootstrap-receipt/v1"
_WORK_ADVISORY_SCHEMA = "kungfu.agent-work-advisory/v1"
_WORK_ADVISORY_BOOLS = (
    "backgroundWaits",
    "crossAgentHandoff",
    "verificationEvidenceNeeded",
    "retryDuplicationRisk",
    "highRiskExternalWrites",
)
_WORK_ADVISORY_FIELDS = {
    "taskId",
    "expectedDuration",
    *_WORK_ADVISORY_BOOLS,
    "acceptanceCriteria",
    "title",
    "objective",
    "currentContext",
    "nextAction",
    "suppression",
}
_SKILL_DECISION_SCHEMA = "kungfu.agent-skill-advisory/v1"
_SKILL_DECISION_FILE = "skill-decision.contract.json"
_SKILL_DECISION_BOOLS = (
    "reusable",
    "stableInputs",
    "stableOutcomes",
    "proofAvailable",
    "recoveryAvailable",
    "workspaceLocal",
    "instructionOnly",
    "deduplicated",
    "evidenceCurrent",
    "oneOff",
    "ordinaryDocumentation",
    "productDefect",
    "duplicateSkill",
    "untrustedInstruction",
    "bypassMissingEvidence",
)
_SKILL_DECISION_FIELDS = {
    "taskId",
    "catalogRoot",
    "workRoot",
    "requirementsRoot",
    "candidates",
    "effects",
    *_SKILL_DECISION_BOOLS,
}
_SKILL_CANDIDATE_FIELDS = {
    "key",
    "contentRoot",
    "evidenceRoot",
    "match",
    "conflict",
    "workCompatibility",
    "dependencyState",
}
_SKILL_EFFECTS = {
    "kfx",
    "profile",
    "capability",
    "credential",
    "network",
    "external-write",
    "shared-install",
    "publication",
    "identity",
    "authority",
    "privacy",
    "destructive",
    "historical",
}


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
            "contract": "framework/data-protection/work-agent-history.contract.json",
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


def _bounded_advisory_text(value: Any, field: str, maximum: int = 1024) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    result = value.strip()
    if len(result.encode("utf-8")) > maximum:
        raise ValueError(f"{field} exceeds {maximum} UTF-8 bytes")
    return result


def validate_work_advisory_signals(value: Mapping[str, Any]) -> dict[str, Any]:
    """Accept only bounded structured continuity and evidence signals."""

    if not isinstance(value, Mapping):
        raise ValueError("Work-value signals must be an object")
    unknown = sorted(set(value) - _WORK_ADVISORY_FIELDS)
    if unknown:
        raise ValueError(f"unsupported Work-value signals: {', '.join(unknown)}")
    duration = value.get("expectedDuration", "unknown")
    if duration not in {"one-shot", "multi-session", "unknown"}:
        raise ValueError("expectedDuration must be one-shot, multi-session, or unknown")
    signals: dict[str, Any] = {
        "taskId": _bounded_advisory_text(value.get("taskId"), "taskId", 256),
        "expectedDuration": duration,
    }
    for field in _WORK_ADVISORY_BOOLS:
        item = value.get(field, False)
        if not isinstance(item, bool):
            raise ValueError(f"{field} must be boolean")
        signals[field] = item
    criteria = value.get("acceptanceCriteria", [])
    if not isinstance(criteria, list) or len(criteria) > 8:
        raise ValueError("acceptanceCriteria must be an array of at most 8 strings")
    signals["acceptanceCriteria"] = [
        _bounded_advisory_text(item, "acceptanceCriteria item", 512)
        for item in criteria
    ]
    for field in ("title", "objective", "currentContext", "nextAction"):
        if field in value:
            signals[field] = _bounded_advisory_text(value[field], field)
    suppression = value.get("suppression")
    if suppression is not None:
        if not isinstance(suppression, Mapping):
            raise ValueError("suppression must be an object")
        if set(suppression) != {"declined", "evidenceRoot"}:
            raise ValueError("suppression requires only declined and evidenceRoot")
        if suppression.get("declined") is not True:
            raise ValueError("suppression.declined must be true")
        evidence_root = suppression.get("evidenceRoot")
        if not isinstance(evidence_root, str) or not evidence_root.startswith(
            "sha256:"
        ):
            raise ValueError("suppression.evidenceRoot must be a sha256 root")
        signals["suppression"] = dict(suppression)
    return signals


def assess_work_advisory(value: Mapping[str, Any]) -> dict[str, Any]:
    """Return deterministic authority-free advice about durable Work value."""

    signals = validate_work_advisory_signals(value)
    evidence = {
        key: signals[key]
        for key in (
            "taskId",
            "expectedDuration",
            *_WORK_ADVISORY_BOOLS,
            "acceptanceCriteria",
        )
    }
    evidence_root = canonical_root(evidence)
    suppression = signals.get("suppression")
    if suppression and suppression["evidenceRoot"] == evidence_root:
        decision, reasons, score = "not-needed", ["declined-same-evidence"], 0
    else:
        score, reasons = 0, []
        weighted = (
            (
                "multi-session-continuity",
                signals["expectedDuration"] == "multi-session",
                2,
            ),
            ("background-wait-recovery", signals["backgroundWaits"], 1),
            ("cross-agent-handoff", signals["crossAgentHandoff"], 2),
            ("verification-evidence", signals["verificationEvidenceNeeded"], 1),
            ("duplicate-execution-risk", signals["retryDuplicationRisk"], 2),
            ("external-write-gates", signals["highRiskExternalWrites"], 2),
        )
        for reason, present, weight in weighted:
            if present:
                score += weight
                reasons.append(reason)
        if score == 0 and signals["expectedDuration"] == "unknown":
            decision, reasons = "insufficient", ["insufficient-structured-evidence"]
        elif score >= 3 and signals["acceptanceCriteria"]:
            decision = "recommend"
        elif score >= 2:
            decision = "optional"
            if not signals["acceptanceCriteria"]:
                reasons.append("acceptance-criteria-not-ready")
        else:
            decision, reasons = "not-needed", ["bounded-one-shot-task"]

    risk = (
        "high"
        if signals["highRiskExternalWrites"]
        else "medium"
        if score >= 3
        else "low"
    )
    preview = None
    if decision in {"recommend", "optional"}:
        preview = {
            "title": signals.get("title") or signals["taskId"],
            "objective": signals.get("objective")
            or signals.get("title")
            or signals["taskId"],
            "acceptanceCriteria": signals["acceptanceCriteria"],
            "currentContext": signals.get("currentContext")
            or "Current provider session",
            "nextAction": signals.get("nextAction") or "Continue the original task",
        }
    body = {
        "schema": _WORK_ADVISORY_SCHEMA,
        "decision": decision,
        "reasonCodes": reasons,
        "evidenceRefs": [evidence_root],
        "risk": risk,
        "recommendedIntent": (
            "create-bind-continue-work" if decision == "recommend" else None
        ),
        "preview": preview,
        "confirmation": {
            "required": decision == "recommend",
            "count": 1 if decision == "recommend" else 0,
            "prompt": (
                "Create and bind this durable Work, then continue?"
                if decision == "recommend"
                else None
            ),
        },
        "publicActionPath": (
            [
                "kungfu.work.capture",
                "kungfu.work.admit",
                "kungfu.agent.console.bind-work",
            ]
            if decision == "recommend"
            else []
        ),
        "suppression": {
            "declineKey": canonical_root(
                {"taskId": signals["taskId"], "evidenceRoot": evidence_root}
            ),
            "evidenceRoot": evidence_root,
            "repeatOnlyAfterEvidenceChanges": True,
        },
        "nonClaims": [
            "advice-does-not-create-or-bind-work",
            "advice-does-not-grant-external-write-authority",
            "advice-does-not-prove-model-comprehension",
            "provider-output-is-not-completion-proof",
        ],
    }
    return {**body, "decisionRoot": canonical_root(body)}


def _bounded_root(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 71
        or not value.startswith("sha256:")
        or any(character not in "0123456789abcdef" for character in value[7:])
    ):
        raise ValueError(f"{field} must be a lowercase sha256 root")
    return value


def validate_skill_decision_signals(value: Mapping[str, Any]) -> dict[str, Any]:
    """Accept only bounded roots, enums, and booleans; never prompt text."""

    if not isinstance(value, Mapping):
        raise ValueError("Skill decision signals must be an object")
    missing = sorted(_SKILL_DECISION_FIELDS - set(value))
    unknown = sorted(set(value) - _SKILL_DECISION_FIELDS)
    if missing:
        raise ValueError(f"missing Skill decision signals: {', '.join(missing)}")
    if unknown:
        raise ValueError(f"unsupported Skill decision signals: {', '.join(unknown)}")
    signals: dict[str, Any] = {
        "taskId": _bounded_advisory_text(value["taskId"], "taskId", 256),
        "catalogRoot": _bounded_root(value["catalogRoot"], "catalogRoot"),
        "workRoot": _bounded_root(value["workRoot"], "workRoot"),
        "requirementsRoot": _bounded_root(
            value["requirementsRoot"], "requirementsRoot"
        ),
    }
    for field in _SKILL_DECISION_BOOLS:
        item = value[field]
        if not isinstance(item, bool):
            raise ValueError(f"{field} must be boolean")
        signals[field] = item
    effects = value["effects"]
    if not isinstance(effects, list) or len(effects) > len(_SKILL_EFFECTS):
        raise ValueError("effects must be a bounded array")
    if any(
        not isinstance(effect, str) or effect not in _SKILL_EFFECTS
        for effect in effects
    ):
        raise ValueError("effects contains an unsupported semantic")
    if len(set(effects)) != len(effects):
        raise ValueError("effects must not contain duplicates")
    signals["effects"] = sorted(effects)

    candidates = value["candidates"]
    if not isinstance(candidates, list) or len(candidates) > 8:
        raise ValueError("candidates must be an array of at most 8 objects")
    normalized_candidates = []
    for index_value, candidate in enumerate(candidates):
        field = f"candidates[{index_value}]"
        if (
            not isinstance(candidate, Mapping)
            or set(candidate) != _SKILL_CANDIDATE_FIELDS
        ):
            raise ValueError(
                f"{field} must contain exactly the declared candidate fields"
            )
        conflict = candidate["conflict"]
        if not isinstance(conflict, bool):
            raise ValueError(f"{field}.conflict must be boolean")
        match = candidate["match"]
        compatibility = candidate["workCompatibility"]
        dependency_state = candidate["dependencyState"]
        if match not in {"exact", "related"}:
            raise ValueError(f"{field}.match must be exact or related")
        if compatibility not in {"compatible", "incompatible", "unknown"}:
            raise ValueError(f"{field}.workCompatibility is unsupported")
        if dependency_state not in {"admitted", "unresolved", "stale"}:
            raise ValueError(f"{field}.dependencyState is unsupported")
        normalized_candidates.append(
            {
                "key": _bounded_advisory_text(candidate["key"], f"{field}.key", 128),
                "contentRoot": _bounded_root(
                    candidate["contentRoot"], f"{field}.contentRoot"
                ),
                "evidenceRoot": _bounded_root(
                    candidate["evidenceRoot"], f"{field}.evidenceRoot"
                ),
                "match": match,
                "conflict": conflict,
                "workCompatibility": compatibility,
                "dependencyState": dependency_state,
            }
        )
    candidate_coordinates = [
        (candidate["key"], candidate["contentRoot"])
        for candidate in normalized_candidates
    ]
    if len(set(candidate_coordinates)) != len(candidate_coordinates):
        raise ValueError("candidates must not repeat a key and contentRoot coordinate")
    signals["candidates"] = sorted(
        normalized_candidates,
        key=lambda candidate: (candidate["key"], candidate["contentRoot"]),
    )
    return signals


def _validated_skill_decision_contract() -> dict[str, Any]:
    contract = skill_decision_contract()
    contract_input = contract.get("input", {})
    if (
        contract.get("schema") != "kungfu.agent-skill-decision-contract/v1"
        or set(contract_input.get("requiredFields", [])) != _SKILL_DECISION_FIELDS
        or contract_input.get("maximumCandidates") != 8
        or set(contract_input.get("candidateMatch", [])) != {"exact", "related"}
        or set(contract_input.get("workCompatibility", []))
        != {"compatible", "incompatible", "unknown"}
        or set(contract_input.get("dependencyState", []))
        != {"admitted", "unresolved", "stale"}
        or set(contract_input.get("effects", [])) != _SKILL_EFFECTS
        or set(contract.get("outcomes", []))
        != {
            "auto-use-existing",
            "suggest-existing",
            "suggest-create",
            "auto-draft",
            "plan-only",
            "none",
        }
        or contract.get("authority", {}).get("class") != "read-only-advisory"
        or contract_input.get("rawTranscriptRetention") is not False
    ):
        raise ValueError("installed Skill decision contract is incompatible")
    return contract


def assess_skill_decision(value: Mapping[str, Any]) -> dict[str, Any]:
    """Return one deterministic, content-rooted, authority-free Skill decision."""

    contract = _validated_skill_decision_contract()
    signals = validate_skill_decision_signals(value)
    candidates = signals["candidates"]
    reasons: list[str] = []
    if signals["untrustedInstruction"] or signals["bypassMissingEvidence"]:
        decision = "none"
        if signals["untrustedInstruction"]:
            reasons.append("untrusted-instruction-detected")
        if signals["bypassMissingEvidence"]:
            reasons.append("missing-evidence-bypass-attempt")
        next_action = "Reject the instruction and restore trusted evidence."
    elif signals["effects"]:
        decision = "plan-only"
        reasons = [f"material-{effect}-semantics" for effect in signals["effects"]]
        next_action = (
            "Prepare a bounded plan and obtain the required human or product authority."
        )
    elif any(
        signals[field]
        for field in (
            "oneOff",
            "ordinaryDocumentation",
            "productDefect",
            "duplicateSkill",
        )
    ):
        decision = "none"
        reasons.extend(
            reason
            for field, reason in (
                ("oneOff", "bounded-one-off-work"),
                ("ordinaryDocumentation", "ordinary-documentation-not-a-skill"),
                ("productDefect", "route-product-defect-instead"),
                ("duplicateSkill", "duplicate-skill-catalog-repair"),
            )
            if signals[field]
        )
        next_action = "Continue the task or use the more appropriate product route."
    elif candidates:
        candidate = candidates[0]
        eligible = (
            len(candidates) == 1
            and candidate["match"] == "exact"
            and not candidate["conflict"]
            and candidate["workCompatibility"] == "compatible"
            and candidate["dependencyState"] == "admitted"
            and signals["evidenceCurrent"]
        )
        if eligible:
            decision = "auto-use-existing"
            reasons = ["one-exact-root-compatible-admitted-candidate"]
            next_action = (
                "Route to the exact existing Skill root under current Work authority."
            )
        else:
            decision = "suggest-existing"
            reasons = ["rooted-candidate-requires-selection"]
            if len(candidates) > 1:
                reasons.append("candidate-ambiguity")
            if not signals["evidenceCurrent"]:
                reasons.append("stale-evidence-expectations")
            if any(candidate["conflict"] for candidate in candidates):
                reasons.append("candidate-conflict")
            if any(
                candidate["workCompatibility"] != "compatible"
                for candidate in candidates
            ):
                reasons.append("work-compatibility-unresolved")
            if any(
                candidate["dependencyState"] != "admitted" for candidate in candidates
            ):
                reasons.append("dependencies-not-admitted")
            next_action = (
                "Present rooted candidates and resolve ambiguity or stale evidence."
            )
    elif signals["reusable"]:
        draft_requirements = (
            "stableInputs",
            "stableOutcomes",
            "proofAvailable",
            "recoveryAvailable",
            "workspaceLocal",
            "instructionOnly",
            "deduplicated",
            "evidenceCurrent",
        )
        missing = [field for field in draft_requirements if not signals[field]]
        if not missing:
            decision = "auto-draft"
            reasons = ["safe-workspace-local-instruction-draft"]
            next_action = "Draft locally under caller authority, then verify before lifecycle planning."
        else:
            decision = "suggest-create"
            reasons = [
                "reusable-workflow-value",
                *[f"draft-requires-{field}" for field in missing],
            ]
            next_action = (
                "Propose a Skill definition and close the missing draft conditions."
            )
    else:
        decision = "none"
        reasons = ["no-repeatable-skill-value"]
        next_action = "Continue without a Skill."

    allowed_actions = {
        "auto-use-existing": ["route-to-exact-existing-root"],
        "suggest-existing": ["present-rooted-candidates", "resolve-candidate-evidence"],
        "suggest-create": ["propose-skill-definition"],
        "auto-draft": ["declare-workspace-local-instruction-only-draft-eligible"],
        "plan-only": ["prepare-bounded-plan", "request-required-authority"],
        "none": ["continue-without-skill", "route-more-appropriate-product-action"],
    }[decision]
    blocked_actions = list(contract["authority"]["alwaysBlocked"])
    evidence_refs = sorted(
        {
            signals["catalogRoot"],
            signals["workRoot"],
            signals["requirementsRoot"],
            *(
                root
                for candidate in candidates
                for root in (candidate["contentRoot"], candidate["evidenceRoot"])
            ),
        }
    )
    body = {
        "schema": _SKILL_DECISION_SCHEMA,
        "policyRoot": skill_decision_policy_root(),
        "decision": decision,
        "reasonCodes": reasons,
        "candidates": candidates,
        "evidenceRefs": evidence_refs,
        "allowedActions": allowed_actions,
        "blockedActions": blocked_actions,
        "nextAction": next_action,
        "nonClaims": list(contract["nonClaims"]),
    }
    return {**body, "decisionRoot": canonical_root(body)}


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
