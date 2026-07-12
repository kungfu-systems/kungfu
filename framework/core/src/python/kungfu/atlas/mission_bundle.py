# SPDX-License-Identifier: Apache-2.0

"""Portable Mission closure composed from self-contained Episode bundles."""

import json
from pathlib import Path
from typing import Any

from kungfu import profile_composition, profile_sdk
from kungfu.atlas import mission_control
from kungfu.storage import service as storage_service

BUNDLE_SCHEMA = "kungfu.mission-control.bundle/v2"
LEGACY_BUNDLE_SCHEMA = "kungfu.mission-control.bundle/v1"
BUNDLE_MODES = ("full", "thin")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def _root(value: Any) -> str:
    return mission_control._sha256_root(value)


def _bundle_root(bundle: dict[str, Any]) -> str:
    body = dict(bundle)
    body.pop("bundle_root", None)
    return _root(body)


def _episode_root(bundle: dict[str, Any]) -> str:
    value = str(bundle.get("manifest", {}).get("content_root") or "")
    if value and not value.startswith("sha256:"):
        value = "sha256:" + value
    return value


def _order_time(bundle: dict[str, Any]) -> int:
    journals = bundle.get("journals") or []
    frame_times = [
        int(frame.get("gen_time") or 0)
        for journal in journals
        for frame in journal.get("frames") or []
        if frame.get("gen_time")
    ]
    if frame_times:
        return min(frame_times)
    return int(bundle.get("manifest", {}).get("begin_time") or 0)


def _material_missing(bundle: dict[str, Any]) -> int:
    if bundle.get("self_contained") is True:
        return 0
    material = bundle.get("material") or {}
    return int(material.get("missing_frame_count") or 0) + int(
        material.get("missing_ref_payload_count") or 0
    )


def _active_profile_binding(runtime_dir: str) -> dict[str, Any]:
    discovered = mission_control.mission_control_profile_source(runtime_dir)
    catalog = profile_composition.catalog(
        discovered["source"], runtime_dir, require_active=True
    )
    return {
        "id": catalog["profileId"],
        "version": catalog["profileVersion"],
        "suite_root": catalog["profileSuiteRoot"],
        "catalog_root": catalog["catalogRoot"],
        "member_roots": catalog["memberRoots"],
        "policy_roots": {
            row["id"]: _root(row) for row in catalog.get("policies") or []
        },
    }


def _verify_profile_binding(runtime_dir: str, bundle: dict[str, Any]) -> dict[str, Any]:
    expected = bundle.get("profile") or {}
    current = _active_profile_binding(runtime_dir)
    fields = (
        "id",
        "version",
        "suite_root",
        "catalog_root",
        "member_roots",
        "policy_roots",
    )
    mismatches = [name for name in fields if expected.get(name) != current.get(name)]
    if mismatches:
        raise profile_sdk.ProfileSdkError(
            "mission-bundle-profile-mismatch",
            "Mission bundle belongs to another active Profile closure",
            mismatches=mismatches,
            expected=expected,
            current=current,
        )
    return current


def build_mission_bundle(
    runtime_dir: str,
    *,
    mission_id: str,
    mode: str = "full",
    storage_source_id: str = "atlas",
    purpose: str = mission_control.PROGRESS_PURPOSE,
) -> dict[str, Any]:
    """Build a bounded Mission closure from the Episodes that prove its state."""

    if mode not in BUNDLE_MODES:
        raise ValueError("Mission bundle mode must be full or thin")
    state = mission_control.query_state(
        runtime_dir,
        mission_id=mission_id,
        storage_source_id=storage_source_id,
    )
    report = None
    if state["goals"]:
        report = mission_control.assess_progress(
            runtime_dir,
            mission_id=mission_id,
            storage_source_id=storage_source_id,
            purpose=purpose,
        )
        state = report["state"]
        profile = report["profile"]
    else:
        profile = mission_control.build_cost_state_proof_profile(
            runtime_dir,
            state,
            assessment_state="not-assessed",
            report_hash=None,
        )

    episode_roles: dict[int, set[str]] = {}

    def add_episode(value: Any, role: str) -> None:
        try:
            episode_id = int(value or 0)
        except (TypeError, ValueError):
            return
        if episode_id:
            episode_roles.setdefault(episode_id, set()).add(role)

    catalog = storage_service.fact_type_list(runtime_dir)
    for world in catalog.get("contract_worlds", []):
        if (
            world.get("id") == mission_control.CONTRACT_WORLD_ID
            and world.get("version") == mission_control.CONTRACT_VERSION
        ):
            add_episode(world.get("episode_id"), "contract-world")
    for surface in catalog.get("fact_types", []):
        if (
            surface.get("contract_world", {}).get("id")
            == mission_control.CONTRACT_WORLD_ID
            and surface.get("version") == mission_control.CONTRACT_VERSION
        ):
            add_episode(surface.get("episode_id"), "fact-surface")
    for row in state["rows"]:
        add_episode(row.get("episode_id"), "mission-state")
        source = row.get("payload", {}).get("source", {})
        add_episode(source.get("import_episode_id"), "source-provenance")
    for claim in state.get("claims", []):
        for evidence in (
            claim.get("payload", {}).get("record", {}).get("evidence_episodes", [])
        ):
            add_episode(evidence.get("episode_id"), "claim-evidence")
    for cost_episode in profile["proof"].get("cost_episode_roots", []):
        add_episode(cost_episode.get("episode_id"), "cost-evidence")
    if report:
        add_episode(report["assessment"].get("assessment_episode_id"), "assessment")

    entries: list[dict[str, Any]] = []
    missing_episodes = []
    for episode_id in episode_roles:
        try:
            episode_bundle = storage_service.build_export_bundle(
                runtime_dir,
                episode_id=episode_id,
                thin=mode == "thin",
            )
        except ValueError as error:
            missing_episodes.append(
                {"episode_id": str(episode_id), "reason": str(error)}
            )
            continue
        entries.append(
            {
                "episode_id": str(episode_id),
                "episode_root": _episode_root(episode_bundle),
                "roles": sorted(episode_roles[episode_id]),
                "order_time": str(_order_time(episode_bundle)),
                "self_contained": bool(episode_bundle.get("self_contained")),
                "missing_material_count": _material_missing(episode_bundle),
                "bundle": episode_bundle,
            }
        )
    entries.sort(key=lambda row: (int(row["order_time"]), row["episode_id"]))
    missing_material_count = sum(
        int(entry["missing_material_count"]) for entry in entries
    )
    full_closure = (
        mode == "full"
        and not missing_episodes
        and not missing_material_count
        and all(entry["self_contained"] for entry in entries)
    )
    source_provenance = any("source-provenance" in entry["roles"] for entry in entries)
    profile_binding = _active_profile_binding(runtime_dir)
    query_receipt = state["profile_query_receipt"]
    profile_binding.update(
        {
            "query_receipt_root": _root(query_receipt),
            "query_definition_root": query_receipt["queryDefinitionRoot"],
            "query_proof_root": query_receipt["queryProofRoot"],
            "result_hash": query_receipt["result"]["result_hash"],
        }
    )
    body = {
        "schema": BUNDLE_SCHEMA,
        "mode": mode,
        "status": "portable" if full_closure else "degraded",
        "mission_subject": state["mission_subject"],
        "mission_id": str(
            state["mission"].get("payload", {}).get("record", {}).get("mission_id")
            or mission_id
        ),
        "profile": profile_binding,
        "contract": {
            "world": state["definition"]["basis"]["contract_world"],
            "fact_surfaces": state["definition"]["basis"]["fact_surfaces"],
        },
        "expected_state": {
            "query_definition_root": state["query_definition_root"],
            "query_proof_root": state["query_proof_root"],
            "result_hash": state["result_hash"],
            "canonical_state": state["canonical_state"],
            "cut": state["cut"],
        },
        "trust": (
            {
                "claim": report["claim"],
                "fitness": report["fitness"],
                "assessment_key": report["assessment_key"],
                "report_hash": report["report_hash"],
                "profile_schema": profile["schema"],
                "profile_hash": profile["profile_hash"],
            }
            if report
            else None
        ),
        "closure": {
            "episode_count": len(entries),
            "full_closure": full_closure,
            "source_provenance_included": source_provenance,
            "missing_material_count": missing_material_count,
            "missing_episodes": missing_episodes,
            "known_limits": (
                [
                    "Atlas bridge provenance may be a shared import Episode with "
                    "records outside this Mission"
                ]
                if source_provenance
                else []
            ),
        },
        "episodes": entries,
    }
    body["bundle_id"] = (
        "mission:"
        + _root(
            {
                "mission_subject": body["mission_subject"],
                "result_hash": body["expected_state"]["result_hash"],
                "mode": mode,
            }
        )[7:31]
    )
    body["bundle_root"] = _bundle_root(body)
    return body


def write_mission_bundle(
    runtime_dir: str,
    out_path: str | Path,
    **options: Any,
) -> dict[str, Any]:
    bundle = build_mission_bundle(runtime_dir, **options)
    path = Path(out_path).expanduser()
    if not path.parent.exists():
        raise FileNotFoundError(f"Mission bundle parent does not exist: {path.parent}")
    path.write_text(
        json.dumps(bundle, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return {
        "schema": "kungfu.mission-control.bundle-export/v1",
        "status": bundle["status"],
        "mode": bundle["mode"],
        "mission_subject": bundle["mission_subject"],
        "bundle_id": bundle["bundle_id"],
        "bundle_root": bundle["bundle_root"],
        "episode_count": bundle["closure"]["episode_count"],
        "out": str(path.resolve()),
    }


def read_mission_bundle(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).expanduser().read_text(encoding="utf-8"))


def import_mission_bundle(
    runtime_dir: str,
    bundle: dict[str, Any],
    *,
    execute: bool = False,
) -> dict[str, Any]:
    """Verify a Mission bundle and optionally materialize a full closure."""

    schema = str(bundle.get("schema") or "")
    if schema not in {BUNDLE_SCHEMA, LEGACY_BUNDLE_SCHEMA}:
        raise ValueError(f"unsupported Mission bundle schema: {bundle.get('schema')}")
    legacy = schema == LEGACY_BUNDLE_SCHEMA
    mode = str(bundle.get("mode") or "")
    if mode not in BUNDLE_MODES:
        raise ValueError("Mission bundle mode must be full or thin")
    expected_root = str(bundle.get("bundle_root") or "")
    computed_root = _bundle_root(bundle)
    if not expected_root or expected_root != computed_root:
        raise ValueError("Mission bundle root mismatch")
    profile_verification = None
    if not legacy:
        profile_verification = {
            "ok": True,
            "active": _verify_profile_binding(runtime_dir, bundle),
        }
    entries = list(bundle.get("episodes") or [])
    if int(bundle.get("closure", {}).get("episode_count") or 0) != len(entries):
        raise ValueError("Mission bundle episode inventory count mismatch")
    for entry in entries:
        episode_bundle = entry.get("bundle") or {}
        if str(episode_bundle.get("episode_id") or "") != str(
            entry.get("episode_id") or ""
        ):
            raise ValueError("Mission bundle episode id mismatch")
        if _episode_root(episode_bundle) != str(entry.get("episode_root") or ""):
            raise ValueError("Mission bundle Episode root mismatch")

    receipts = []
    # v1 remains readable for audit, but it cannot be executed because it does
    # not bind the Profile Suite, member, catalog, or policy closure.
    materialize = execute and mode == "full" and not legacy
    for entry in sorted(
        entries, key=lambda row: (int(row.get("order_time") or 0), row["episode_id"])
    ):
        receipt = storage_service.import_bundle(
            runtime_dir,
            entry["bundle"],
            execute=materialize,
        )
        receipts.append(
            {
                "episode_id": entry["episode_id"],
                "roles": entry["roles"],
                "ok": bool(receipt.get("ok")),
                "status": str(receipt.get("status") or "validated"),
                "receipt": receipt,
            }
        )

    missing_material_count = sum(
        int(entry.get("missing_material_count") or 0) for entry in entries
    )
    failed = [receipt for receipt in receipts if not receipt["ok"]]
    state_verification = None
    if materialize and not failed and not missing_material_count:
        state = mission_control.query_state(
            runtime_dir,
            mission_id=str(bundle["mission_subject"]),
        )
        expected = bundle["expected_state"]
        state_verification = {
            "query_definition_root_match": (
                state["query_definition_root"] == expected["query_definition_root"]
            ),
            "query_proof_root_match": (
                state["query_proof_root"] == expected["query_proof_root"]
            ),
            "result_hash_match": state["result_hash"] == expected["result_hash"],
            "canonical_state": state["canonical_state"],
        }
        state_verification["ok"] = all(state_verification.values())

    accepted = bool(
        materialize
        and not failed
        and not missing_material_count
        and state_verification
        and state_verification["ok"]
    )
    if accepted:
        status = "imported"
    elif not execute or legacy:
        status = "validated"
    else:
        status = "degraded"
    return {
        "schema": "kungfu.mission-control.bundle-import/v1",
        "status": status,
        "accepted": accepted,
        "materialized": materialize and not failed,
        "mode": mode,
        "mission_subject": bundle["mission_subject"],
        "bundle_id": bundle["bundle_id"],
        "bundle_root": computed_root,
        "profile_verification": profile_verification,
        "episode_count": len(entries),
        "missing_material_count": missing_material_count,
        "missing_episodes": bundle.get("closure", {}).get("missing_episodes", []),
        "state_verification": state_verification,
        "receipts": receipts,
        "diagnosis": (
            (
                "v1 bundles are audit-readable but cannot be materialized because "
                "they do not bind an exact Profile closure"
                if legacy and execute
                else "thin bundles preserve roots and references but require a "
                "full bundle before Mission state can be materialized"
            )
            if (legacy and execute) or (execute and mode == "thin")
            else ""
        ),
    }


def import_mission_bundle_file(
    runtime_dir: str,
    path: str | Path,
    *,
    execute: bool = False,
) -> dict[str, Any]:
    return import_mission_bundle(
        runtime_dir, read_mission_bundle(path), execute=execute
    )
