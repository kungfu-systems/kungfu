# SPDX-License-Identifier: Apache-2.0

"""Profile source, package-closure, and collaboration validation helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from kungfu import kfx_contract, runtime_broker
from kungfu.profile_sdk_support import (
    ACTION_REGISTRY_SCHEMA,
    ProfileSdkError,
    _IGNORED_PARTS,
    _TOKEN,
    _confined,
    _pretty,
    _root,
    _sha256,
    _validate_sdk_value,
)


def package_content_root(package_dir: str | Path) -> str:
    root = Path(package_dir).resolve()
    rows: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise ProfileSdkError(
                "member-package-symlink",
                f"KFX member package closure cannot contain symlinks: {relative}",
            )
        if not path.is_file():
            continue
        data = path.read_bytes()
        rows.append(
            {"path": relative.as_posix(), "sha256": _sha256(data), "size": len(data)}
        )
    rows.sort(key=lambda row: row["path"].encode("utf-8"))
    if not rows:
        raise ProfileSdkError(
            "member-package-empty", f"KFX member package is empty: {root}"
        )
    return _root({"schema": "kungfu.kfx-package-closure/v1", "files": rows})


def _source_files(brief: Mapping[str, Any]) -> dict[str, bytes]:
    slug = str(brief["id"]).replace(".", "-")
    members = [f"{slug}-contract", f"{slug}-actions", f"{slug}-assessment"]
    artifacts: dict[str, Any] = {
        "contracts/world.json": {
            "schema": "kungfu.profile-contract-world/v1",
            "profileId": brief["id"],
            "identityAuthority": brief["identity"]["authority"],
        },
        "contracts/facts.json": {
            "schema": "kungfu.profile-fact-surfaces/v1",
            "surfaces": [],
        },
        "compatibility/v1.json": {
            "schema": "kungfu.profile-compatibility/v1",
            "runtimeContracts": ["kungfu.profile-lifecycle/v1"],
        },
        "claims/claims.json": {
            "schema": "kungfu.profile-claims/v1",
            "claims": [],
            "evidenceStrength": brief["evidence"]["strength"],
        },
        "assessments/policies.json": {
            "schema": "kungfu.profile-assessment-policies/v1",
            "policies": [],
        },
        "actions/registry.json": {"schema": ACTION_REGISTRY_SCHEMA, "actions": []},
        "views/registry.json": {"schema": "kungfu.profile-views/v1", "views": []},
        "migrations/registry.json": {
            "schema": "kungfu.profile-migrations/v1",
            "mode": brief["migration"]["mode"],
            "migrations": [],
        },
        "permissions.json": {
            "schema": "kungfu.profile-permissions/v1",
            "permissions": brief["permissions"],
        },
        "qualification/profile.json": {
            "schema": "kungfu.profile-qualification/v1",
            "checks": ["content-closure", "runtime-contract"],
        },
    }
    if brief.get("collaboration") is not None:
        artifacts["collaboration/interface.json"] = brief["collaboration"]
    encoded = {path: _pretty(value) for path, value in artifacts.items()}

    def ref(path):
        return {"path": path, "sha256": _sha256(encoded[path])}

    profile = {
        "schema": "kungfu.profile-suite/v1",
        "id": brief["id"],
        "title": brief["title"],
        "version": brief["version"],
        "members": {"required": members, "optional": []},
        "kfd1": {
            "contractWorld": ref("contracts/world.json"),
            "factSurfaces": [ref("contracts/facts.json")],
            "reducers": [],
            "compatibility": ref("compatibility/v1.json"),
        },
        "kfd2": {
            "claims": [ref("claims/claims.json")],
            "purposes": brief["purposes"],
            "policies": [ref("assessments/policies.json")],
        },
        "actions": {"registry": ref("actions/registry.json")},
        "views": {"registry": ref("views/registry.json")},
        "migrations": {"registry": ref("migrations/registry.json")},
        "permissions": {"registry": ref("permissions.json")},
        "qualification": {"profile": ref("qualification/profile.json")},
    }
    if brief.get("collaboration") is not None:
        profile["kfd3"] = {"collaboration": ref("collaboration/interface.json")}

    def package_files(prefix, name, config):
        common = {"name": name, "version": brief["version"]}
        manifest = {"schema": kfx_contract.PACKAGE_MANIFEST_SCHEMA, **common}
        manifest["kungfuConfig"] = config
        return {
            f"{prefix}package.json": _pretty({**common, "private": True}),
            f"{prefix}{kfx_contract.PACKAGE_MANIFEST_FILE}": _pretty(manifest),
        }

    suite = {"title": brief["title"], "members": members, "profile": "profile.json"}
    suite_config = {"key": brief["id"], "suite": suite}
    files = {
        **package_files("", f"@kungfu-profile/{slug}", suite_config),
        "profile.json": _pretty(profile),
        **encoded,
    }
    for member in members:
        files.update(
            package_files(
                f"members/{member}/",
                f"@kungfu-profile/{member}",
                {"key": member},
            )
        )
        files[f"members/{member}/README.md"] = (
            f"# {member}\n\nDeclarative KFX Profile member.\n".encode()
        )
    return files


def _package_dirs(suite_dir: Path) -> list[Path]:
    roots = [suite_dir, suite_dir / "members", suite_dir.parent]
    dependencies = suite_dir / "node_modules"
    if dependencies.is_dir():
        roots.append(dependencies)
        roots.extend(
            entry
            for entry in dependencies.iterdir()
            if entry.is_dir() and entry.name.startswith("@")
        )
    result = []
    seen = set()
    for root in roots:
        if not root.is_dir():
            continue
        for candidate in [root, *[p for p in root.iterdir() if p.is_dir()]]:
            resolved = candidate.resolve()
            try:
                is_package = (resolved / kfx_contract.PACKAGE_MANIFEST_FILE).is_file()
            except OSError:
                is_package = False
            if resolved not in seen and is_package:
                seen.add(resolved)
                result.append(resolved)
    return result


def _read_ref_json(
    inspection: Mapping[str, Any], ref: Mapping[str, Any]
) -> dict[str, Any]:
    root = Path(str(inspection["profile_path"])).parent
    path = _confined(root, str(ref["path"]))
    return json.loads(path.read_text(encoding="utf-8"))


def _collaboration_closure(inspection: Mapping[str, Any]) -> dict[str, Any]:
    profile = inspection["profile"]
    declaration = profile.get("kfd3")
    if not isinstance(declaration, Mapping):
        return {
            "schema": "kungfu.profile-collaboration-closure/v1",
            "profileId": profile["id"],
            "profileSuiteRoot": inspection["profile_suite_root"],
            "status": "not-declared",
            "declared": False,
            "qualified": False,
            "reason": "Profile has no content-bound kfd3.collaboration facet",
        }

    ref = declaration.get("collaboration")
    if not isinstance(ref, Mapping):
        raise ProfileSdkError(
            "collaboration-ref-invalid",
            "Profile kfd3 declaration has no collaboration content reference",
        )
    artifact = _read_ref_json(inspection, ref)
    _validate_sdk_value("collaborationSchema", artifact, "collaboration interface")
    if artifact["profileId"] != profile["id"]:
        raise ProfileSdkError(
            "collaboration-profile-mismatch",
            "collaboration interface profileId does not match the Profile",
            expected=profile["id"],
            actual=artifact["profileId"],
        )

    participants = artifact["participants"]
    participant_ids = [row["id"] for row in participants]
    if len(participant_ids) != len(set(participant_ids)):
        raise ProfileSdkError(
            "collaboration-participant-duplicate",
            "collaboration participant ids must be unique",
        )
    participant_kinds = {row["kind"] for row in participants}
    if not {"human", "agent"}.issubset(participant_kinds):
        raise ProfileSdkError(
            "collaboration-dual-first-required",
            "KFD-3 Profile qualification requires human and agent participants",
            participantKinds=sorted(participant_kinds),
        )
    benefit_kinds = {
        row["participantKind"] for row in artifact["value"]["participantBenefits"]
    }
    if not {"human", "agent"}.issubset(benefit_kinds):
        raise ProfileSdkError(
            "collaboration-value-incomplete",
            "Profile value must be explicit for human and agent participants",
            participantKinds=sorted(benefit_kinds),
        )

    action_registry = _read_ref_json(inspection, profile["actions"]["registry"])
    _validate_action_registry(action_registry, profile)
    actions = {row["id"]: row for row in action_registry["actions"]}
    view_registry = _read_ref_json(inspection, profile["views"]["registry"])
    _validate_sdk_value("viewsSchema", view_registry, "view registry")
    view_ids = [row["id"] for row in view_registry["views"]]
    if len(view_ids) != len(set(view_ids)):
        raise ProfileSdkError(
            "collaboration-view-duplicate", "Profile view ids must be unique"
        )
    views = set(view_ids)

    intents = artifact["intents"]
    intent_ids = [row["id"] for row in intents]
    action_ids = [row["actionId"] for row in intents]
    if len(intent_ids) != len(set(intent_ids)) or len(action_ids) != len(
        set(action_ids)
    ):
        raise ProfileSdkError(
            "collaboration-intent-duplicate",
            "intent ids and action bindings must be unique",
        )
    if set(action_ids) != set(actions):
        raise ProfileSdkError(
            "collaboration-action-closure",
            "every public Profile action must have exactly one collaboration intent",
            declared=sorted(action_ids),
            actions=sorted(actions),
        )

    authority_classes = {
        authority
        for participant in participants
        for authority in participant["authorityClasses"]
    }
    for intent in intents:
        action = actions[intent["actionId"]]
        missing_views = sorted(
            {intent["inspectViewId"], intent["verifyViewId"]} - views
        )
        if missing_views:
            raise ProfileSdkError(
                "collaboration-view-unresolved",
                "intent inspect and verify views must resolve in the Profile",
                intentId=intent["id"],
                missingViews=missing_views,
            )
        if intent["requiredAuthority"] != action["authorityClass"]:
            raise ProfileSdkError(
                "collaboration-authority-drift",
                "intent and action authority classes must match",
                intentId=intent["id"],
            )
        if intent["requiredAuthority"] not in authority_classes:
            raise ProfileSdkError(
                "collaboration-authority-unowned",
                "an intent authority class is not owned by any declared participant",
                intentId=intent["id"],
            )
        if sorted(intent["requiredCapabilities"]) != sorted(
            action["requiredCapabilities"]
        ):
            raise ProfileSdkError(
                "collaboration-capability-drift",
                "intent and action required capabilities must match",
                intentId=intent["id"],
            )

    known_targets = set(intent_ids)
    for constraint in artifact["constraints"]:
        unknown = sorted(
            target
            for target in constraint["appliesTo"]
            if target != "*" and target not in known_targets
        )
        if unknown:
            raise ProfileSdkError(
                "collaboration-constraint-unresolved",
                "constraint appliesTo contains an unknown intent",
                constraintId=constraint["id"],
                unknownIntents=unknown,
            )

    home_view = artifact["presentation"]["homeViewId"]
    if home_view is not None and home_view not in views:
        raise ProfileSdkError(
            "collaboration-home-view-unresolved",
            "generic presentation homeViewId must resolve in the Profile",
            homeViewId=home_view,
        )

    closure = {
        "profileSuiteRoot": inspection["profile_suite_root"],
        "collaborationRoot": f"sha256:{ref['sha256']}",
        "participantIds": sorted(participant_ids),
        "intentIds": sorted(intent_ids),
        "actionIds": sorted(actions),
        "viewIds": sorted(views),
        "protocol": [
            "inspect",
            "advise",
            "preview",
            "authorize",
            "execute",
            "receipt",
            "verify",
        ],
    }
    return {
        "schema": "kungfu.profile-collaboration-closure/v1",
        "profileId": profile["id"],
        **closure,
        "closureRoot": _root(closure),
        "status": "declared-closed",
        "declared": True,
        "qualified": False,
        "qualificationStatus": "not-qualified",
        "genericRenderer": artifact["presentation"]["mode"] == "generic",
        "value": artifact["value"],
        "constraints": artifact["constraints"],
        "knownLimits": artifact["knownLimits"],
        "participants": participants,
        "intents": intents,
    }


def _validate_action_registry(
    registry: Mapping[str, Any], profile: Mapping[str, Any]
) -> None:
    _validate_sdk_value("actionRegistrySchema", dict(registry), "action registry")
    ids = set()
    actions_by_id: dict[str, Mapping[str, Any]] = {}
    members = set(profile["members"]["required"] + profile["members"]["optional"])
    for row in registry["actions"]:
        required = {
            "id",
            "title",
            "runner",
            "operation",
            "authorityClass",
            "requiredCapabilities",
            "effects",
        }
        allowed = required | {"runtimeOperation", "compatibility"}
        if (
            not isinstance(row, Mapping)
            or not required.issubset(row)
            or not set(row).issubset(allowed)
        ):
            raise ProfileSdkError(
                "action-declaration-invalid",
                "action declaration has missing or extra fields",
            )
        if row["id"] in ids or not _TOKEN.fullmatch(str(row["id"])):
            raise ProfileSdkError(
                "action-id-invalid", "action ids must be unique safe tokens"
            )
        ids.add(row["id"])
        actions_by_id[str(row["id"])] = row
        if row.get("runtimeOperation"):
            try:
                runtime_broker.operation_definition(str(row["runtimeOperation"]))
            except (KeyError, ValueError) as error:
                raise ProfileSdkError(
                    "action-runtime-operation-invalid",
                    "action runtime operation is not registered by the runtime contract",
                ) from error
        if row["runner"] not in {"profile-lifecycle", "kfx-member"}:
            raise ProfileSdkError(
                "action-runner-invalid", "action runner is not confined"
            )
        if row["runner"] == "kfx-member" and row["operation"] not in members:
            raise ProfileSdkError(
                "action-member-unknown", "kfx-member action must name a Suite member"
            )
        if row["runner"] == "profile-lifecycle" and row["operation"] not in {
            "qualify",
            "activate",
            "remove",
        }:
            raise ProfileSdkError(
                "action-operation-unsupported",
                "profile-lifecycle action declares an unsupported operation",
            )
    authority_fields = (
        "runner",
        "operation",
        "runtimeOperation",
        "authorityClass",
        "requiredCapabilities",
        "effects",
    )
    for row in registry["actions"]:
        compatibility = row.get("compatibility")
        if not compatibility:
            continue
        replacement = actions_by_id.get(str(compatibility["replacement"]))
        if (
            replacement is None
            or replacement is row
            or replacement.get("compatibility") is not None
        ):
            raise ProfileSdkError(
                "action-compatibility-invalid",
                "deprecated action aliases must name one native successor action",
            )
        if any(row.get(field) != replacement.get(field) for field in authority_fields):
            raise ProfileSdkError(
                "action-compatibility-authority-drift",
                "deprecated action aliases must preserve the successor action authority and effects",
            )
