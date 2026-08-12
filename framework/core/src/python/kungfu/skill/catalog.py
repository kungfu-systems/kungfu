# SPDX-License-Identifier: Apache-2.0

"""Skill catalog projection and safe workspace-local authoring."""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Mapping

from kungfu.agent import assess_skill_decision
from kungfu.canonical_json import canonical_json_bytes
from kungfu.skill import contract as skill_contract
from kungfu.skill.registry import (
    SkillRegistryError,
    discover_skills,
    normalize_package,
)


def catalog_entry(skill: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": skill["key"],
        "title": skill["title"],
        "description": skill["description"],
        "kind": skill["kind"],
        "triggers": list(skill.get("triggers", [])),
        "capabilities": list(skill.get("capabilities", [])),
        "kfx": list(skill.get("kfx", [])),
        "loadPolicy": "on-demand",
        "sourceHash": skill["source"]["hash"],
    }


def build_catalog(skills: Iterable[dict[str, Any]]) -> dict[str, Any]:
    catalog = {
        "schema": "kungfu.skill-catalog/v1",
        "skills": [catalog_entry(skill) for skill in skills],
    }
    skill_contract.validate_catalog(catalog)
    return catalog


AUTHORING_CONTRACT_SCHEMA = "kungfu.skill-authoring.contract/v1"
CANDIDATE_CATALOG_SCHEMA = "kungfu.skill-authoring.candidate-catalog/v1"
INSPECTION_SCHEMA = "kungfu.skill-authoring.inspection/v1"
PLAN_SCHEMA = "kungfu.skill-authoring.plan/v1"
RECEIPT_SCHEMA = "kungfu.skill-authoring.receipt/v1"
QUALIFICATION_SCHEMA = "kungfu.skill-authoring.qualification/v1"

BLOCKED_ACTIONS = [
    "install-skill",
    "activate-skill",
    "enable-skill",
    "publish-skill",
    "invoke-kfx",
    "change-profile",
    "grant-capability",
    "use-credential",
    "open-network",
    "write-external-system",
    "mutate-shared-scope",
    "claim-work-completion",
]

NON_CLAIMS = [
    "draft-is-not-installation",
    "draft-is-not-activation",
    "draft-is-not-publication",
    "validation-is-not-capability",
    "qualification-is-not-work-completion",
    "skill-prose-is-not-authority",
]

DEFINITION_NON_CLAIMS = [
    "skill-prose-is-not-capability",
    "skill-is-not-work-authority",
    "skill-is-not-profile-authority",
    "skill-is-not-fact-or-episode-authority",
    "skill-is-not-kfd-authority",
    "skill-is-not-kfx-authority",
    "selection-load-or-invocation-is-not-completion",
    "retirement-does-not-reinterpret-history",
]


class SkillAuthoringError(ValueError):
    """Stable refusal for the safe authoring protocol."""

    def __init__(self, code: str, message: str, recovery: str) -> None:
        super().__init__(message)
        self.code = code
        self.recovery = recovery


def _root(value: Any) -> str:
    return _bytes_root(canonical_json_bytes(value))


def _bytes_root(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _with_root(value: dict[str, Any], field: str) -> dict[str, Any]:
    return {**value, field: _root(value)}


def authoring_contract() -> dict[str, Any]:
    """Return the installed, exact-root authoring discovery contract."""

    metadata = skill_contract.contract_metadata()
    body = {
        "schema": AUTHORING_CONTRACT_SCHEMA,
        "skillContractRoot": metadata["hash"],
        "mode": "workspace-local-instruction-only",
        "commands": {
            "contract": "kungfu skill author contract --json",
            "catalog": "kungfu skill author catalog --json",
            "specSchema": "kungfu skill schema --name authoringSpecV1 --json",
            "planSchema": "kungfu skill schema --name authoringPlanV1 --json",
            "receiptSchema": "kungfu skill schema --name authoringReceiptV1 --json",
            "inspect": "kungfu skill author inspect --spec <spec.json> --json",
            "scaffold": "kungfu skill author scaffold --signals <signals.json> --spec <spec.json> --workspace <path> --target <relative-path> --json",
            "qualify": "kungfu skill author qualify <draft-path> --json",
        },
        "schemas": {
            "spec": "kungfu.skill-authoring.spec/v1",
            "plan": PLAN_SCHEMA,
            "receipt": RECEIPT_SCHEMA,
            "definition": "kungfu.skill-definition/v2",
        },
        "constraints": [
            "catalog-root-must-be-current",
            "catalog-deduplication-is-mandatory",
            "decision-must-recompute-to-auto-draft",
            "workspace-and-target-must-resolve-exactly",
            "target-must-not-exist",
            "instruction-only-no-dependencies-no-effects",
            "private-transcript-and-hidden-prompt-bodies-are-not-inputs",
            "higher-priority-policy-always-wins",
        ],
        "allowedActions": [
            "inspect-catalog",
            "preview-workspace-local-draft",
            "write-new-workspace-local-draft",
            "validate-draft",
            "qualify-draft",
        ],
        "blockedActions": BLOCKED_ACTIONS,
        "nonClaims": NON_CLAIMS,
        "examples": [
            {
                "id": "repeatable-release-check",
                "spec": {
                    "schema": "kungfu.skill-authoring.spec/v1",
                    "key": "verify-release-evidence",
                    "title": "Verify Release Evidence",
                    "description": "Verify one release against retained evidence.",
                    "triggers": ["verify release evidence"],
                    "intendedUsers": ["release agent"],
                    "workScopes": ["release verification"],
                    "inputs": ["release candidate root"],
                    "outcomes": ["rooted verification report"],
                    "proof": ["focused release verification passes"],
                    "recovery": ["inspect the retained roots and retry"],
                    "higherPriorityRules": [
                        "Obey repository and Work authority before these instructions."
                    ],
                },
            }
        ],
    }
    return _with_root(body, "contractRoot")


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().casefold())


def _catalog_row(skill: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "key": str(skill["key"]),
        "title": str(skill["title"]),
        "description": str(skill["description"]),
        "triggers": sorted(str(value) for value in skill.get("triggers", [])),
        "class": (
            "instruction-only"
            if skill.get("kind") == "instruction-only"
            else "effectful-or-legacy"
        ),
        "sourceRoot": str(skill["source"]["hash"]),
    }


def candidate_catalog(
    home: str | os.PathLike[str], extra_paths: list[str] | None = None
) -> dict[str, Any]:
    rows = sorted(
        (_catalog_row(skill) for skill in discover_skills(str(home), extra_paths)),
        key=lambda row: (row["key"], row["sourceRoot"]),
    )
    body = {
        "schema": CANDIDATE_CATALOG_SCHEMA,
        "skillContractRoot": skill_contract.contract_hash(),
        "skills": rows,
        "deduplication": {
            "exact": "same-key-or-same-description-and-trigger-set",
            "plausible": "same-title-or-overlapping-trigger",
            "empty": "eligible-only-after-rooted-auto-draft-decision",
        },
    }
    return _with_root(body, "catalogRoot")


def _load_spec(value: Mapping[str, Any]) -> dict[str, Any]:
    spec = dict(value)
    try:
        skill_contract.validate_authoring_spec_v1(spec)
    except (KeyError, ValueError) as error:
        raise SkillAuthoringError(
            "authoring-spec-invalid",
            str(error),
            "provide only the bounded structured fields in the installed authoring schema",
        ) from error
    return spec


def inspect_candidates(
    home: str | os.PathLike[str],
    spec: Mapping[str, Any],
    extra_paths: list[str] | None = None,
) -> dict[str, Any]:
    bounded = _load_spec(spec)
    catalog = candidate_catalog(home, extra_paths)
    key = bounded["key"]
    title = _normalize_text(bounded["title"])
    description = _normalize_text(bounded["description"])
    triggers = {_normalize_text(value) for value in bounded["triggers"]}
    exact: list[dict[str, Any]] = []
    plausible: list[dict[str, Any]] = []
    for row in catalog["skills"]:
        row_triggers = {_normalize_text(value) for value in row["triggers"]}
        same_description_and_triggers = (
            bool(triggers)
            and _normalize_text(row["description"]) == description
            and row_triggers == triggers
        )
        if row["key"] == key or same_description_and_triggers:
            exact.append(row)
        elif _normalize_text(row["title"]) == title or triggers & row_triggers:
            plausible.append(row)
    if exact:
        disposition = "duplicate"
        next_action = "use-or-reconcile-existing-skill"
    elif len(plausible) > 1:
        disposition = "ambiguous"
        next_action = "resolve-rooted-candidate-choice"
    elif plausible:
        disposition = "suggest-existing"
        next_action = "review-rooted-existing-candidate"
    else:
        disposition = "clear"
        next_action = "run-rooted-skill-advisory"
    body = {
        "schema": INSPECTION_SCHEMA,
        "specRoot": _root(bounded),
        "candidateCatalogRoot": catalog["catalogRoot"],
        "disposition": disposition,
        "exactCandidates": exact,
        "plausibleCandidates": plausible,
        "nextAction": next_action,
    }
    return _with_root(body, "inspectionRoot")


def _resolve_target(
    workspace: str | os.PathLike[str], target: str
) -> tuple[Path, Path]:
    workspace_path = Path(workspace).expanduser().resolve()
    if not workspace_path.is_dir():
        raise SkillAuthoringError(
            "workspace-not-directory",
            str(workspace_path),
            "pass an existing authorized workspace directory",
        )
    relative = Path(target)
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise SkillAuthoringError(
            "target-path-invalid",
            target,
            "use a non-empty relative path beneath the exact workspace",
        )
    target_path = (workspace_path / relative).resolve(strict=False)
    if target_path == workspace_path or workspace_path not in target_path.parents:
        raise SkillAuthoringError(
            "target-path-escape",
            str(target_path),
            "choose a target that resolves beneath the exact workspace",
        )
    if target_path.exists():
        raise SkillAuthoringError(
            "target-collision",
            str(target_path),
            "choose a new empty target; authoring never overwrites",
        )
    if not target_path.parent.is_dir():
        raise SkillAuthoringError(
            "target-parent-not-directory",
            str(target_path.parent),
            "create and authorize the exact workspace-local source directory separately",
        )
    for parent in [target_path.parent, *target_path.parent.parents]:
        if parent == workspace_path:
            break
        if parent.is_symlink():
            raise SkillAuthoringError(
                "target-path-escape",
                str(parent),
                "remove the symlink boundary or choose a direct workspace path",
            )
    return workspace_path, target_path


def _markdown(spec: Mapping[str, Any]) -> bytes:
    def bullets(values: list[str]) -> str:
        return "\n".join(f"- {value}" for value in values)

    trigger_lines = "\n".join(f"  - {value}" for value in spec["triggers"])
    text = f"""---
key: {spec["key"]}
triggers:
{trigger_lines}
---

# {spec["title"]}

{spec["description"]}

## When to use

Intended users:
{bullets(spec["intendedUsers"])}

Work scope:
{bullets(spec["workScopes"])}

## Inputs

{bullets(spec["inputs"])}

## Outcomes

{bullets(spec["outcomes"])}

## Proof

{bullets(spec["proof"])}

Skill output is not Work completion; verify acceptance through the owning Work.

## Recovery

{bullets(spec["recovery"])}

## Higher-priority policy

{bullets(spec["higherPriorityRules"])}

If these instructions conflict with repository, Work, safety, privacy, or human authority, stop this Skill path and follow the higher-priority rule.

## Non-capabilities

- This Skill grants no capability, credential, network, KFX, Profile, identity, publication, shared-scope, external-write, or destructive authority.
- Installation, activation, enablement, dependency admission, and publication require separate explicit plans or decisions.
- Do not retain private transcript bodies or hidden prompts as Skill evidence.
"""
    return text.encode("utf-8")


def _definition(
    spec: Mapping[str, Any], target: Path, markdown: bytes
) -> dict[str, Any]:
    member = {
        "path": "SKILL.md",
        "root": _bytes_root(markdown),
        "bytes": len(markdown),
        "mediaType": "text/markdown",
    }
    content_root = _root(
        {
            "schema": "kungfu.skill-content-closure/v2",
            "entrypoint": "SKILL.md",
            "members": [member],
        }
    )
    return {
        "schema": "kungfu.skill-definition/v2",
        "identity": {"key": spec["key"], "revision": 1, "contentRoot": content_root},
        "class": "instruction-only",
        "content": {
            "algorithm": "sha256-canonical-json",
            "root": content_root,
            "entrypoint": "SKILL.md",
            "members": [member],
        },
        "provenance": {
            "sourceKind": "workspace",
            "sourceRoot": _root(spec),
            "sourceRef": f"workspace:{target.name}",
            "generated": True,
            "generatorRoot": authoring_contract()["contractRoot"],
        },
        "scope": {
            "distribution": "workspace-local",
            "appliesTo": list(spec["workScopes"]),
            "work": {
                "binding": "optional",
                "selectionAuthority": "kungfu-work",
                "completionAuthority": "kungfu-work",
            },
        },
        "dependencies": {"kfx": [], "profiles": []},
        "effects": {"mode": "none", "declarations": []},
        "compatibility": {
            "contractVersion": 2,
            "predecessor": None,
            "requires": [
                {"surface": "skill", "contractRoot": skill_contract.contract_hash()}
            ],
            "history": "preserve-original-meaning",
        },
        "proof": {
            "requirements": [
                {
                    "id": f"proof-{index + 1}",
                    "kind": "check",
                    "description": value,
                }
                for index, value in enumerate(spec["proof"])
            ],
            "completion": "work-acceptance-not-skill-output",
        },
        "recovery": {
            "strategy": "disable-and-inspect",
            "steps": list(spec["recovery"]),
            "history": "preserve-roots-receipts-and-work-meaning",
        },
        "authority": {
            "capability": "none",
            "work": "reference-only",
            "profile": "reference-only",
            "factEpisode": "reference-only",
            "kfd": "reference-only",
            "kfx": "reference-only",
            "nonClaims": DEFINITION_NON_CLAIMS,
        },
    }


def _plan_files(
    spec: Mapping[str, Any], target: Path
) -> tuple[bytes, bytes, dict[str, Any]]:
    markdown = _markdown(spec)
    definition = _definition(spec, target, markdown)
    skill_contract.validate_definition_v2(definition)
    manifest = (
        json.dumps(definition, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    return markdown, manifest, definition


def plan_scaffold(
    home: str | os.PathLike[str],
    workspace: str | os.PathLike[str],
    target: str,
    spec: Mapping[str, Any],
    signals: Mapping[str, Any],
    extra_paths: list[str] | None = None,
) -> dict[str, Any]:
    bounded = _load_spec(spec)
    workspace_path, target_path = _resolve_target(workspace, target)
    inspection = inspect_candidates(home, bounded, extra_paths)
    catalog_root = inspection["candidateCatalogRoot"]
    if signals.get("catalogRoot") != catalog_root:
        raise SkillAuthoringError(
            "stale-catalog-root",
            f"expected {catalog_root}, got {signals.get('catalogRoot')!r}",
            "rerun skill author catalog and recompute the rooted advisory",
        )
    try:
        decision = assess_skill_decision(dict(signals))
    except (KeyError, TypeError, ValueError) as error:
        raise SkillAuthoringError(
            "authoring-signals-invalid",
            str(error),
            "provide only bounded roots, booleans, enums, and rooted candidates from the installed advisory contract",
        ) from error
    if inspection["disposition"] != "clear":
        raise SkillAuthoringError(
            f"catalog-{inspection['disposition']}",
            "catalog deduplication did not produce one clear new-Skill path",
            inspection["nextAction"],
        )
    if decision["decision"] != "auto-draft":
        raise SkillAuthoringError(
            "decision-not-auto-draft",
            f"rooted advisory returned {decision['decision']}",
            decision["nextAction"],
        )
    markdown, manifest, definition = _plan_files(bounded, target_path)
    qualification_body = {
        "schema": QUALIFICATION_SCHEMA,
        "skillContractRoot": skill_contract.contract_hash(),
        "authoringContractRoot": authoring_contract()["contractRoot"],
        "definitionRoot": _root(definition),
        "contentRoot": definition["identity"]["contentRoot"],
        "class": "instruction-only",
        "dependencies": "none",
        "effects": "none",
        "verdict": "valid",
    }
    qualification = _with_root(qualification_body, "qualificationRoot")
    body = {
        "schema": PLAN_SCHEMA,
        "execute": False,
        "decisionRoot": decision["decisionRoot"],
        "candidateCatalogRoot": catalog_root,
        "inspectionRoot": inspection["inspectionRoot"],
        "workspace": str(workspace_path),
        "workspaceRoot": _root({"path": str(workspace_path)}),
        "target": str(target_path),
        "relativeTarget": str(target_path.relative_to(workspace_path)),
        "files": [
            {"path": "SKILL.md", "root": _bytes_root(markdown), "bytes": len(markdown)},
            {
                "path": "skill-definition.json",
                "root": _bytes_root(manifest),
                "bytes": len(manifest),
            },
        ],
        "definitionRoot": qualification["definitionRoot"],
        "contentRoot": qualification["contentRoot"],
        "qualificationRoot": qualification["qualificationRoot"],
        "allowedActions": ["write-new-workspace-local-draft", "validate-draft"],
        "blockedActions": BLOCKED_ACTIONS,
        "rollback": {
            "mode": "remove-only-this-new-draft",
            "target": str(target_path),
            "preserveExisting": True,
        },
        "nonClaims": NON_CLAIMS,
    }
    skill_contract.validate_authoring_plan_v1(body)
    return _with_root(body, "planRoot")


def apply_scaffold(
    plan: Mapping[str, Any],
    *,
    expected_plan_root: str,
    spec: Mapping[str, Any],
) -> dict[str, Any]:
    replay = dict(plan)
    supplied = replay.pop("planRoot", None)
    actual = _root(replay)
    if supplied != actual or expected_plan_root != actual:
        raise SkillAuthoringError(
            "plan-root-mismatch",
            f"expected {expected_plan_root!r}, supplied {supplied!r}, actual {actual!r}",
            "rerun the read-only scaffold plan and approve its exact planRoot",
        )
    skill_contract.validate_authoring_plan_v1(replay)
    workspace, target = _resolve_target(
        str(replay["workspace"]), str(replay["relativeTarget"])
    )
    if (
        str(workspace) != replay["workspace"]
        or _root({"path": str(workspace)}) != replay["workspaceRoot"]
        or str(target) != replay["target"]
    ):
        raise SkillAuthoringError(
            "target-binding-mismatch",
            "the plan target no longer matches its exact workspace binding",
            "rerun the scaffold plan from the intended workspace",
        )
    markdown, manifest, definition = _plan_files(_load_spec(spec), target)
    observed = [
        {"path": "SKILL.md", "root": _bytes_root(markdown), "bytes": len(markdown)},
        {
            "path": "skill-definition.json",
            "root": _bytes_root(manifest),
            "bytes": len(manifest),
        },
    ]
    if observed != replay["files"] or _root(definition) != replay["definitionRoot"]:
        raise SkillAuthoringError(
            "draft-input-drift",
            "the deterministic draft bytes changed after planning",
            "rerun the scaffold plan from the current exact inputs",
        )
    created: list[Path] = []
    try:
        target.mkdir(parents=True, exist_ok=False)
        for name, content in (
            ("SKILL.md", markdown),
            ("skill-definition.json", manifest),
        ):
            path = target / name
            with path.open("xb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            created.append(path)
        package = normalize_package(target)
    except Exception:
        for path in reversed(created):
            path.unlink(missing_ok=True)
        try:
            target.rmdir()
        except OSError:
            pass
        raise
    qualification = qualify_draft(target)
    body = {
        "schema": RECEIPT_SCHEMA,
        "planRoot": actual,
        "decisionRoot": replay["decisionRoot"],
        "candidateCatalogRoot": replay["candidateCatalogRoot"],
        "target": str(target),
        "fileRoots": {row["path"]: row["root"] for row in replay["files"]},
        "definitionRoot": package["definitionRoot"],
        "contentRoot": package["contentRoot"],
        "qualificationRoot": qualification["qualificationRoot"],
        "allowedActions": [
            "inspect-draft",
            "validate-draft",
            "prepare-separate-install-plan",
        ],
        "blockedActions": BLOCKED_ACTIONS,
        "rollback": replay["rollback"],
        "lifecycleMutation": False,
        "draftOnly": True,
        "nonClaims": NON_CLAIMS,
    }
    skill_contract.validate_authoring_receipt_v1(body)
    return _with_root(body, "receiptRoot")


def qualify_draft(path: str | os.PathLike[str]) -> dict[str, Any]:
    try:
        package = normalize_package(path)
    except SkillRegistryError as error:
        raise SkillAuthoringError(
            error.code,
            str(error),
            "repair the exact draft bytes and rerun qualification",
        ) from error
    definition = package["definition"]
    if (
        definition["class"] != "instruction-only"
        or definition["dependencies"] != {"kfx": [], "profiles": []}
        or definition["effects"] != {"mode": "none", "declarations": []}
        or definition["scope"]["distribution"] != "workspace-local"
    ):
        raise SkillAuthoringError(
            "authoring-ceiling-exceeded",
            "the draft is not workspace-local instruction-only content",
            "use a separate explicit KFX, Profile, capability, or lifecycle plan",
        )
    body = {
        "schema": QUALIFICATION_SCHEMA,
        "skillContractRoot": skill_contract.contract_hash(),
        "authoringContractRoot": authoring_contract()["contractRoot"],
        "definitionRoot": package["definitionRoot"],
        "contentRoot": package["contentRoot"],
        "class": "instruction-only",
        "dependencies": "none",
        "effects": "none",
        "verdict": "valid",
    }
    return _with_root(body, "qualificationRoot")
