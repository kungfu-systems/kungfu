"""Pure Cut/Work projection and recovery classification."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import PurePosixPath
from typing import Any, NoReturn
from urllib.parse import urlsplit


OPEN_STATES = {"active", "waiting", "blocked", "ready"}
READ_ONLY_FACADE_ACTIONS = frozenset(
    {"capabilities", "inspect", "recover", "complete", "settle", "export", "import"}
)
PORTABLE_WORK_SCHEMA = "kungfu.work.portable-envelope/v1"
PORTABLE_IMPORT_SCHEMA = "kungfu.work.import-receipt/v1"
PORTABLE_MAX_BYTES = 4 * 1024 * 1024
PORTABLE_MAX_TEXT = 64 * 1024
PORTABLE_MAX_ROWS = 10_000
PORTABLE_AUTHORITY = {
    "work": "kungfu-work-journal",
    "projectCut": "git-tracked-project-cut",
    "import": "verify-current-cut-before-append",
    "timestamps": "excluded-non-semantic",
}
_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_WORK_ID = re.compile(r"w[0-9a-f]{8}\Z")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*\S+"
)
_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
_AWS_ACCESS_KEY = re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
_COMMON_CREDENTIAL = re.compile(
    r"\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|"
    r"sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b"
)
_BEARER_CREDENTIAL = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}")


class WorkPortabilityError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


def _portability_fail(code: str, message: str) -> NoReturn:
    raise WorkPortabilityError(code, message)


def _exact_object(value: Any, fields: set[str], path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _portability_fail("PORTABLE_SHAPE_INVALID", f"{path} must be an object")
    if set(value) != fields:
        _portability_fail(
            "PORTABLE_SHAPE_INVALID", f"{path} fields do not match the contract"
        )
    return value


def _text(value: Any, path: str, *, optional: bool = False) -> str | None:
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value:
        _portability_fail("PORTABLE_SHAPE_INVALID", f"{path} must be text")
    if len(value.encode("utf-8")) > PORTABLE_MAX_TEXT:
        _portability_fail("PORTABLE_TEXT_TOO_LARGE", f"{path} exceeds 64 KiB")
    return value


def _safe_text(value: str | None, path: str) -> None:
    if value is None:
        return
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        _portability_fail("PORTABLE_TEXT_INVALID", f"{path} is not portable: {error}")
    unsafe_url = parsed.scheme in {"http", "https"} and bool(
        parsed.username or parsed.password or parsed.query or parsed.fragment
    )
    if (
        unsafe_url
        or _SECRET_ASSIGNMENT.search(value)
        or _PRIVATE_KEY.search(value)
        or _AWS_ACCESS_KEY.search(value)
        or _COMMON_CREDENTIAL.search(value)
        or _BEARER_CREDENTIAL.search(value)
    ):
        _portability_fail(
            "PORTABLE_SENSITIVE_TEXT", f"{path} contains non-portable sensitive text"
        )


def _root(value: Any, path: str) -> str:
    if not isinstance(value, str) or _ROOT.fullmatch(value) is None:
        _portability_fail("PORTABLE_ROOT_INVALID", f"{path} must be a sha256 root")
    return value


def _root_list(value: Any, path: str) -> list[str]:
    if not isinstance(value, list):
        _portability_fail("PORTABLE_SHAPE_INVALID", f"{path} must be an array")
    return [_root(root, f"{path}[{index}]") for index, root in enumerate(value)]


def _project_cut_path(value: Any, path: str) -> str:
    text = _text(value, path)
    candidate = PurePosixPath(str(text))
    if (
        candidate.is_absolute()
        or ".." in candidate.parts
        or "\\" in str(text)
        or "\0" in str(text)
        or len(candidate.parts) < 3
        or candidate.parts[:2] != (".kungfu", "project-cuts")
    ):
        _portability_fail(
            "PORTABLE_PROJECT_CUT_PATH_INVALID",
            f"{path} must stay below .kungfu/project-cuts",
        )
    return str(text)


def _validate_portable_cut(value: Any) -> dict[str, Any]:
    cut = _exact_object(
        value,
        {
            "cutRoot",
            "parentCutRoots",
            "sourceRoot",
            "atlasRoot",
            "episodeRoots",
            "manifestPath",
            "receiptPath",
            "publicationCommit",
        },
        "projectCut",
    )
    publication = cut["publicationCommit"]
    if not isinstance(publication, str) or _COMMIT.fullmatch(publication) is None:
        _portability_fail(
            "PORTABLE_PUBLICATION_INVALID", "Project Cut publication is not exact"
        )
    return {
        "cutRoot": _root(cut["cutRoot"], "projectCut.cutRoot"),
        "parentCutRoots": _root_list(
            cut["parentCutRoots"], "projectCut.parentCutRoots"
        ),
        "sourceRoot": _root(cut["sourceRoot"], "projectCut.sourceRoot"),
        "atlasRoot": _root(cut["atlasRoot"], "projectCut.atlasRoot"),
        "episodeRoots": _root_list(cut["episodeRoots"], "projectCut.episodeRoots"),
        "manifestPath": _project_cut_path(
            cut["manifestPath"], "projectCut.manifestPath"
        ),
        "receiptPath": _project_cut_path(cut["receiptPath"], "projectCut.receiptPath"),
        "publicationCommit": publication,
    }


def _rows(value: Any, path: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        _portability_fail("PORTABLE_SHAPE_INVALID", f"{path} must be an array")
    if len(value) > PORTABLE_MAX_ROWS:
        _portability_fail("PORTABLE_ROWS_TOO_LARGE", f"{path} exceeds 10000 rows")
    if not all(isinstance(row, dict) for row in value):
        _portability_fail("PORTABLE_SHAPE_INVALID", f"{path} entries must be objects")
    return value


def _validate_portable_work(value: Any) -> dict[str, Any]:
    item = _exact_object(
        value,
        {
            "workId",
            "title",
            "kind",
            "summary",
            "status",
            "nextAction",
            "checkpoints",
            "decisions",
            "validations",
            "artifacts",
            "runs",
        },
        "work",
    )
    work_id = _text(item["workId"], "work.workId")
    if _WORK_ID.fullmatch(str(work_id)) is None:
        _portability_fail("PORTABLE_WORK_ID_INVALID", "work.workId is not canonical")
    title = _text(item["title"], "work.title")
    kind = _text(item["kind"], "work.kind")
    summary = _text(item["summary"], "work.summary", optional=True)
    status = _text(item["status"], "work.status")
    if status not in {"active", "waiting", "blocked", "ready", "done"}:
        _portability_fail("PORTABLE_STATUS_INVALID", "work.status is unsupported")
    next_action = _text(item["nextAction"], "work.nextAction", optional=True)
    checkpoints = []
    for index, row in enumerate(_rows(item["checkpoints"], "work.checkpoints")):
        row = _exact_object(row, {"note"}, f"work.checkpoints[{index}]")
        checkpoints.append(
            {"note": _text(row["note"], f"work.checkpoints[{index}].note")}
        )
    decisions = []
    for index, row in enumerate(_rows(item["decisions"], "work.decisions")):
        row = _exact_object(row, {"decision", "decidedBy"}, f"work.decisions[{index}]")
        decisions.append(
            {
                "decision": _text(row["decision"], f"work.decisions[{index}].decision"),
                "decidedBy": _text(
                    row["decidedBy"],
                    f"work.decisions[{index}].decidedBy",
                    optional=True,
                ),
            }
        )
    validations = []
    for index, row in enumerate(_rows(item["validations"], "work.validations")):
        row = _exact_object(
            row, {"result", "command", "note"}, f"work.validations[{index}]"
        )
        result = _text(row["result"], f"work.validations[{index}].result")
        if result not in {"pass", "fail"}:
            _portability_fail(
                "PORTABLE_RESULT_INVALID", f"work.validations[{index}] is unsupported"
            )
        validations.append(
            {
                "result": result,
                "command": _text(
                    row["command"],
                    f"work.validations[{index}].command",
                    optional=True,
                ),
                "note": _text(
                    row["note"], f"work.validations[{index}].note", optional=True
                ),
            }
        )
    artifacts = []
    for index, row in enumerate(_rows(item["artifacts"], "work.artifacts")):
        row = _exact_object(row, {"ref", "kind"}, f"work.artifacts[{index}]")
        artifacts.append(
            {
                "ref": _text(row["ref"], f"work.artifacts[{index}].ref"),
                "kind": _text(
                    row["kind"], f"work.artifacts[{index}].kind", optional=True
                ),
            }
        )
    runs = []
    for index, row in enumerate(_rows(item["runs"], "work.runs")):
        row = _exact_object(row, {"runId"}, f"work.runs[{index}]")
        runs.append({"runId": _text(row["runId"], f"work.runs[{index}].runId")})
    normalized = {
        "workId": work_id,
        "title": title,
        "kind": kind,
        "summary": summary,
        "status": status,
        "nextAction": next_action,
        "checkpoints": checkpoints,
        "decisions": decisions,
        "validations": validations,
        "artifacts": artifacts,
        "runs": runs,
    }
    for path, value in (
        ("work.title", title),
        ("work.kind", kind),
        ("work.summary", summary),
        ("work.nextAction", next_action),
    ):
        _safe_text(value, path)
    for collection in ("checkpoints", "decisions", "validations", "artifacts", "runs"):
        for index, row in enumerate(normalized[collection]):
            for field, value in row.items():
                _safe_text(value, f"work.{collection}[{index}].{field}")
    return normalized


def portable_work_item(item: dict[str, Any]) -> dict[str, Any]:
    """Remove local timestamps while preserving the Work semantic projection."""

    return _validate_portable_work(
        {
            "workId": item.get("work_id"),
            "title": item.get("title"),
            "kind": item.get("kind"),
            "summary": item.get("summary"),
            "status": item.get("status"),
            "nextAction": item.get("next_action"),
            "checkpoints": [
                {"note": row.get("note")} for row in item.get("checkpoints", [])
            ],
            "decisions": [
                {
                    "decision": row.get("decision"),
                    "decidedBy": row.get("decided_by"),
                }
                for row in item.get("decisions", [])
            ],
            "validations": [
                {
                    "result": row.get("result"),
                    "command": row.get("command"),
                    "note": row.get("note"),
                }
                for row in item.get("validations", [])
            ],
            "artifacts": [
                {"ref": row.get("ref"), "kind": row.get("kind")}
                for row in item.get("artifacts", [])
            ],
            "runs": [{"runId": row.get("run_id")} for row in item.get("runs", [])],
        }
    )


def _portable_cut(projection: dict[str, Any]) -> dict[str, Any]:
    current = projection.get("current")
    if projection.get("status") != "current" or not isinstance(current, dict):
        _portability_fail(
            "PORTABLE_PROJECT_CUT_NOT_CURRENT",
            "export and import require one clean current Project Cut",
        )
    if current.get("receiptValid") is not True:
        _portability_fail(
            "PORTABLE_PROJECT_CUT_UNVERIFIED",
            "the current Project Cut receipt is not valid",
        )
    return _validate_portable_cut(
        {
            "cutRoot": current.get("cutRoot"),
            "parentCutRoots": current.get("parentCutRoots"),
            "sourceRoot": current.get("sourceRoot"),
            "atlasRoot": current.get("atlasRoot"),
            "episodeRoots": current.get("episodeRoots"),
            "manifestPath": current.get("manifest"),
            "receiptPath": current.get("receipt"),
            "publicationCommit": current.get("publicationCommit"),
        }
    )


def _portable_root(value: dict[str, Any]) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def export_portable_work(
    cut_projection: dict[str, Any],
    items: dict[str, dict[str, Any]],
    work_id: str,
) -> dict[str, Any]:
    item = items.get(work_id)
    if item is None:
        _portability_fail("PORTABLE_WORK_MISSING", "the requested Work does not exist")
    envelope = {
        "schema": PORTABLE_WORK_SCHEMA,
        "projectCut": _portable_cut(cut_projection),
        "work": portable_work_item(item),
        "authority": dict(PORTABLE_AUTHORITY),
    }
    signed = {**envelope, "portableRoot": _portable_root(envelope)}
    if (
        len(json.dumps(signed, indent=2, sort_keys=True).encode("utf-8"))
        > PORTABLE_MAX_BYTES
    ):
        _portability_fail(
            "PORTABLE_ENVELOPE_TOO_LARGE", "portable envelope exceeds 4 MiB"
        )
    return signed


def _is_prefix(current: list[Any], target: list[Any]) -> bool:
    return len(current) <= len(target) and current == target[: len(current)]


def portable_import_delta(
    existing: dict[str, Any] | None, target: dict[str, Any]
) -> list[tuple[str, Any]]:
    target = _validate_portable_work(target)
    actions: list[tuple[str, Any]] = []
    if existing is None:
        actions.append(("create", target))
        current = {
            **target,
            "status": "active",
            "nextAction": None,
            "checkpoints": [],
            "decisions": [],
            "validations": [],
            "artifacts": [],
            "runs": [],
        }
    else:
        current = portable_work_item(existing)
        for field in ("workId", "title", "kind", "summary"):
            if current[field] != target[field]:
                _portability_fail(
                    "PORTABLE_WORK_CONFLICT", f"existing Work differs at {field}"
                )
    if current["nextAction"] != target["nextAction"]:
        if current["nextAction"] is not None:
            _portability_fail(
                "PORTABLE_WORK_CONFLICT", "existing Work has a different next action"
            )
        if target["nextAction"] is not None:
            actions.append(("nextAction", target["nextAction"]))
    for collection in ("checkpoints", "decisions", "validations", "artifacts", "runs"):
        if not _is_prefix(current[collection], target[collection]):
            _portability_fail(
                "PORTABLE_WORK_CONFLICT", f"existing Work diverges at {collection}"
            )
        actions.extend(
            (collection, row) for row in target[collection][len(current[collection]) :]
        )
    if current["status"] != target["status"]:
        if current["status"] != "active":
            _portability_fail(
                "PORTABLE_WORK_CONFLICT", "existing Work has a different status"
            )
        actions.append(("status", target["status"]))
    return actions


def plan_portable_import(
    cut_projection: dict[str, Any],
    items: dict[str, dict[str, Any]],
    envelope: Any,
) -> dict[str, Any]:
    envelope = _exact_object(
        envelope,
        {"schema", "projectCut", "work", "authority", "portableRoot"},
        "envelope",
    )
    if envelope["schema"] != PORTABLE_WORK_SCHEMA:
        _portability_fail("PORTABLE_SCHEMA_MISMATCH", "portable schema differs")
    if envelope["authority"] != PORTABLE_AUTHORITY:
        _portability_fail("PORTABLE_AUTHORITY_MISMATCH", "authority contract differs")
    root = _root(envelope["portableRoot"], "portableRoot")
    unsigned = {key: value for key, value in envelope.items() if key != "portableRoot"}
    if _portable_root(unsigned) != root:
        _portability_fail("PORTABLE_ROOT_MISMATCH", "portable envelope was modified")
    portable_cut = _validate_portable_cut(envelope["projectCut"])
    current_cut = _portable_cut(cut_projection)
    if portable_cut != current_cut:
        _portability_fail(
            "PORTABLE_PROJECT_CUT_MISMATCH",
            "portable Work does not bind the current Project Cut",
        )
    target = _validate_portable_work(envelope["work"])
    existing = items.get(str(target["workId"]))
    actions = portable_import_delta(existing, target)
    return {
        "schema": PORTABLE_IMPORT_SCHEMA,
        "status": "plan" if actions else "current",
        "code": "work-import-required" if actions else "work-import-current",
        "workId": target["workId"],
        "projectCutRoot": current_cut["cutRoot"],
        "portableRoot": root,
        "actionTypes": [name for name, _value in actions],
        "writeOccurred": False,
        "reused": not actions,
    }


def work_loop_capabilities() -> dict[str, Any]:
    """Describe the shared Work/Cut loop without claiming missing authority."""

    operations = [
        {
            "id": "inspect",
            "availability": "available",
            "command": "kungfu work inspect --repo <path> --json",
            "resultSchema": "kungfu.work.inspect/v1",
            "authority": "read-only-projection",
        },
        {
            "id": "begin",
            "availability": "unavailable",
            "command": None,
            "resultSchema": None,
            "authority": "mission-control.assignment.create",
            "reason": "native-assignment-orchestration-not-admitted",
        },
        {
            "id": "checkpoint",
            "availability": "degraded",
            "command": "kungfu work checkpoint <work-id> <note>",
            "resultSchema": None,
            "authority": "kungfu-work-journal",
            "reason": "legacy-work-receipt-not-yet-projected",
        },
        {
            "id": "complete",
            "availability": "plan-only",
            "command": "kungfu work complete <work-id> --repo <path> --json",
            "resultSchema": "kungfu.work.completion-candidate/v1",
            "authority": "completion-candidate-planner",
        },
        {
            "id": "settle",
            "availability": "plan-only",
            "command": "kungfu work settle <work-id> --claim-root <root> --review-root <root> --decision-root <root> --project-cut-root <root> --json",
            "resultSchema": "kungfu.work.settlement-plan/v1",
            "authority": "settlement-planner",
        },
        {
            "id": "resume",
            "availability": "degraded",
            "command": "kungfu work resume <work-id> --json",
            "resultSchema": None,
            "authority": "kungfu-work-journal",
            "reason": "assignment-and-cut-binding-not-yet-enforced",
        },
        {
            "id": "recover",
            "availability": "available",
            "command": "kungfu work recover --repo <path> --json",
            "resultSchema": "kungfu.work.recovery-plan/v1",
            "authority": "read-only-projection",
        },
        {
            "id": "export",
            "availability": "available",
            "command": "kungfu work export <work-id> --repo <path> --json",
            "resultSchema": PORTABLE_WORK_SCHEMA,
            "authority": "work-loop-portability",
        },
        {
            "id": "import",
            "availability": "available",
            "command": "kungfu work import --file <envelope.json> --repo <path> [--execute] --json",
            "resultSchema": PORTABLE_IMPORT_SCHEMA,
            "authority": "work-loop-portability",
        },
    ]
    return {
        "schema": "kungfu.work-loop-capabilities/v1",
        "mentalModel": ["current Cut", "work in progress", "next Cut"],
        "operations": operations,
        "surfaces": {
            "cli": {
                "availability": "available",
                "entrypoint": "kungfu work capabilities --json",
            },
            "agent": {
                "availability": "available",
                "entrypoint": "kungfu agent capabilities --json",
                "projection": "workLoop",
            },
            "gui": {
                "availability": "available",
                "entrypoint": "@kungfu-tech/api.openWorkLoop",
                "projection": "work-dashboard",
            },
            "tui": {
                "availability": "available",
                "entrypoint": "@kungfu-tech/api.openWorkLoop",
                "projection": "mission-control-profile-shell",
            },
        },
        "domainProfile": {
            "availability": "unavailable",
            "reason": "domain-profile-authoring-contract-not-admitted",
        },
        "authority": {
            "projection": "non-authoritative",
            "writesRequireDeclaredOperation": True,
            "settlementRequiresIndependentReview": True,
        },
    }


def inspect_work(
    cut: dict[str, Any], items: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    open_items = [item for item in items.values() if item.get("status") in OPEN_STATES]
    open_items.sort(key=lambda item: item.get("updated_time") or 0, reverse=True)
    gaps = list(cut.get("gaps") or [])
    current_work = open_items[0] if len(open_items) == 1 else None

    if len(open_items) > 1:
        gaps.append("multiple-open-work-items")
        next_actions = ["select-work"]
        status = "ambiguous"
    elif current_work is None:
        next_actions = ["begin"]
        status = "idle"
    elif current_work["status"] == "blocked":
        next_actions = ["recover"]
        status = "blocked"
    elif current_work["status"] == "ready":
        next_actions = ["complete", "settle"]
        status = "completion-pending"
    elif current_work["status"] == "waiting":
        next_actions = ["resume", "recover"]
        status = "paused"
    else:
        next_actions = ["checkpoint", "complete"]
        status = "active"

    if current_work is not None:
        gaps.extend(
            ["initiative-binding-unavailable", "assignment-binding-unavailable"]
        )
    confidence = cut.get("confidence", "none")
    if gaps and confidence == "high":
        confidence = "medium"
    return {
        "schema": "kungfu.work.inspect/v1",
        "status": status,
        "confidence": confidence,
        "cut": cut.get("current"),
        "cutStatus": cut.get("status"),
        "work": current_work,
        "openWork": open_items,
        "gaps": sorted(set(gaps)),
        "nextActions": next_actions,
        "authority": {
            "cut": cut.get("authority"),
            "work": "kungfu-work-journal",
            "projection": "non-authoritative",
        },
    }


def recover_work(projection: dict[str, Any]) -> dict[str, Any]:
    """Classify recovery without changing Work, runtime, or Git state."""

    work = projection.get("work")
    if projection.get("status") == "ambiguous":
        action = "select-work"
        code = "work-ambiguous"
    elif work is None:
        action = "begin"
        code = "work-missing"
    elif projection.get("cutStatus") in {"conflicted", "thin"}:
        action = "recover-project-cut"
        code = f"project-cut-{projection['cutStatus']}"
    elif work.get("status") == "ready":
        action = "complete"
        code = "completion-evidence-required"
    elif work.get("status") in {"waiting", "blocked"}:
        action = "resume"
        code = f"work-{work['status']}"
    else:
        action = "checkpoint"
        code = "work-current"
    return {
        "schema": "kungfu.work.recovery-plan/v1",
        "status": "plan",
        "code": code,
        "workId": work.get("work_id") if work else None,
        "action": action,
        "gaps": list(projection.get("gaps") or []),
        "writeOccurred": False,
    }


def plan_managed_run_link(
    items: dict[str, dict[str, Any]], work_id: str, run_id: str
) -> dict[str, Any]:
    item = items.get(work_id)
    if item is None:
        return {"ok": False, "code": "work-missing", "writeOccurred": False}
    existing = {row.get("run_id") for row in item.get("runs", []) if row.get("run_id")}
    return {
        "ok": True,
        "code": "run-link-current" if run_id in existing else "run-link-required",
        "workId": work_id,
        "runId": run_id,
        "reused": run_id in existing,
        "writeOccurred": False,
    }


def plan_completion(projection: dict[str, Any], work_id: str) -> dict[str, Any]:
    item = next(
        (
            row
            for row in projection.get("openWork", [])
            if row.get("work_id") == work_id
        ),
        None,
    )
    missing = []
    if item is None:
        missing.append("work-missing")
    elif item.get("status") != "ready":
        missing.append("work-not-ready")
    if item is not None and not any(
        row.get("result") == "pass" for row in item.get("validations", [])
    ):
        missing.append("passing-validation-missing")
    if projection.get("cut") is None:
        missing.append("current-project-cut-missing")
    return {
        "schema": "kungfu.work.completion-candidate/v1",
        "status": "blocked" if missing else "plan",
        "workId": work_id,
        "projectCutRoot": (projection.get("cut") or {}).get("cutRoot"),
        "missingEvidence": missing,
        "authorityOperations": ["episode.seal", "mission-control.claim-completion"],
        "requiresIndependentReview": True,
        "nextActions": ["checkpoint"] if missing else ["settle"],
        "writeOccurred": False,
    }


def plan_settlement(
    work_id: str,
    *,
    claim_root: str,
    review_root: str,
    decision_root: str,
    project_cut_root: str,
) -> dict[str, Any]:
    roots = {
        "claimRoot": claim_root,
        "reviewRoot": review_root,
        "decisionRoot": decision_root,
        "projectCutRoot": project_cut_root,
    }
    missing = [
        name for name, value in roots.items() if not str(value).startswith("sha256:")
    ]
    return {
        "schema": "kungfu.work.settlement-plan/v1",
        "status": "blocked" if missing else "plan",
        "workId": work_id,
        **roots,
        "missingRoots": missing,
        "authorityOperations": [
            "mission-control.decide",
            "project-cut.prepare",
            "project-cut.publish",
        ],
        "nextActions": ["request-evidence"] if missing else ["settle"],
        "writeOccurred": False,
    }
