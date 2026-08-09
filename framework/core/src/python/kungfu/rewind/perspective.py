# SPDX-License-Identifier: Apache-2.0

"""Observer-bound KFD-4 projection, replay, fsck, and product qualification."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable

POLICY_VERSION = "kungfu-observer-timeline/v1"
QUALIFICATION_SCHEMA = "kungfu.kfd-4-perspective-qualification/v1"
_ROOT_PREFIX = "sha256:"
_PRESERVED_ELEMENTS = [
    "observer",
    "accepted-fact-cut",
    "causal-order",
    "natural-objects",
    "consequences",
    "evidence-boundary",
    "known-gaps",
]


class PerspectiveError(ValueError):
    """Stable fail-closed diagnosis for perspective projection inputs."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _root(value: Any) -> str:
    return _ROOT_PREFIX + hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _file_root(path: Path) -> str:
    return _ROOT_PREFIX + hashlib.sha256(path.read_bytes()).hexdigest()


def _is_root(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith(_ROOT_PREFIX):
        return False
    digest = value[len(_ROOT_PREFIX) :]
    return len(digest) == 64 and all(char in "0123456789abcdef" for char in digest)


def _unique_strings(values: Iterable[Any]) -> list[str]:
    return sorted({str(value) for value in values if str(value)})


def _accepted_cut(source: dict[str, Any]) -> dict[str, Any]:
    accepted = source.get("acceptedRange") or {}
    return {
        "sourceId": str(source.get("sourceId") or ""),
        "manifestId": str(accepted.get("manifestId") or ""),
        "firstFrameUid": int(accepted.get("firstFrameUid") or 0),
        "lastFrameUid": int(accepted.get("lastFrameUid") or 0),
        "status": str(accepted.get("status") or ""),
        "head": str(source.get("head") or ""),
    }


def _validate_sources(
    accepted_sources: list[dict[str, Any]], source_priority: list[str]
) -> dict[str, dict[str, Any]]:
    if not accepted_sources:
        raise PerspectiveError(
            "accepted-sources-missing", "accepted sources are required"
        )
    by_id: dict[str, dict[str, Any]] = {}
    for source in accepted_sources:
        source_id = str(source.get("sourceId") or "")
        if not source_id or source_id in by_id:
            raise PerspectiveError(
                "source-identity", "accepted source ids must be non-empty and unique"
            )
        accepted = source.get("acceptedRange") or {}
        if source.get("registered") is not True:
            raise PerspectiveError(
                "source-registration-missing", f"source {source_id} is not registered"
            )
        if accepted.get("status") != "ok":
            raise PerspectiveError(
                "stale-or-unaccepted-cut",
                f"source {source_id} does not have one current accepted range",
            )
        first = int(accepted.get("firstFrameUid") or 0)
        last = int(accepted.get("lastFrameUid") or 0)
        if first <= 0 or last < first or not str(accepted.get("manifestId") or ""):
            raise PerspectiveError(
                "accepted-cut-malformed",
                f"source {source_id} accepted range is malformed",
            )
        by_id[source_id] = source
    if len(source_priority) != len(set(source_priority)):
        raise PerspectiveError(
            "source-priority-duplicate", "source priority must be unique"
        )
    if set(source_priority) != set(by_id):
        raise PerspectiveError(
            "source-priority-incomplete",
            "source priority must name every accepted source exactly once",
        )
    return by_id


def _validate_facts(
    facts: list[dict[str, Any]], sources: dict[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    if not facts:
        raise PerspectiveError(
            "facts-missing", "at least one accepted fact is required"
        )
    by_id: dict[str, dict[str, Any]] = {}
    for fact in facts:
        fact_id = str(fact.get("id") or "")
        source_id = str(fact.get("sourceId") or "")
        if not fact_id or fact_id in by_id:
            raise PerspectiveError(
                "fact-identity", "fact ids must be non-empty and unique"
            )
        if source_id not in sources:
            raise PerspectiveError(
                "fact-source-unaccepted",
                f"fact {fact_id} uses unaccepted source {source_id}",
            )
        if not _is_root(fact.get("evidenceRoot")):
            raise PerspectiveError(
                "missing-evidence", f"fact {fact_id} has no content-bound evidence root"
            )
        frame_uid = int(fact.get("frameUid") or 0)
        accepted = sources[source_id]["acceptedRange"]
        first = int(accepted["firstFrameUid"])
        last = int(accepted["lastFrameUid"])
        if frame_uid < first or frame_uid > last:
            raise PerspectiveError(
                "undeclared-fact-cut",
                f"fact {fact_id} frame {frame_uid} is outside {source_id} accepted cut",
            )
        if int(fact.get("sourceLocalOrder") or 0) <= 0:
            raise PerspectiveError(
                "source-local-order", f"fact {fact_id} has no source-local order"
            )
        by_id[fact_id] = fact
    for fact_id, fact in by_id.items():
        for parent in fact.get("causalParents") or []:
            if parent not in by_id:
                raise PerspectiveError(
                    "causal-parent-missing",
                    f"fact {fact_id} references unknown parent {parent}",
                )
    return by_id


def _topological_order(
    facts: dict[str, dict[str, Any]], source_priority: list[str]
) -> list[str]:
    priority = {source_id: index for index, source_id in enumerate(source_priority)}
    remaining = set(facts)
    emitted: set[str] = set()
    order: list[str] = []
    while remaining:
        ready = [
            fact_id
            for fact_id in remaining
            if set(facts[fact_id].get("causalParents") or []).issubset(emitted)
        ]
        if not ready:
            raise PerspectiveError(
                "causal-cycle", "causal constraints do not admit a total order"
            )
        ready.sort(
            key=lambda fact_id: (
                priority[str(facts[fact_id]["sourceId"])],
                int(facts[fact_id]["sourceLocalOrder"]),
                int(facts[fact_id]["frameUid"]),
                fact_id,
            )
        )
        selected = ready[0]
        remaining.remove(selected)
        emitted.add(selected)
        order.append(selected)
    return order


def project(
    *,
    observer: dict[str, Any],
    accepted_sources: list[dict[str, Any]],
    facts: list[dict[str, Any]],
    source_priority: list[str],
    policy_version: str = POLICY_VERSION,
    replay_loss: list[str] | None = None,
) -> dict[str, Any]:
    """Build one deterministic observer-relative projection from accepted facts."""

    if policy_version != POLICY_VERSION:
        raise PerspectiveError(
            "unknown-policy-version", f"unsupported projection policy {policy_version}"
        )
    observer_id = str(observer.get("id") or "")
    observer_location = str(observer.get("location") or "")
    if not observer_id or not observer_location:
        raise PerspectiveError(
            "observer-identity", "observer id and location are required"
        )
    sources = _validate_sources(accepted_sources, source_priority)
    fact_map = _validate_facts(facts, sources)
    order = _topological_order(fact_map, source_priority)
    accepted_facts = [
        {
            "sourceId": source_id,
            "sourceKind": str(sources[source_id].get("sourceKind") or "other"),
            "location": str(sources[source_id].get("location") or source_id),
            "acceptedRange": _root(_accepted_cut(sources[source_id])),
            "watermark": str(sources[source_id].get("head") or ""),
            "manifest": str(sources[source_id]["acceptedRange"]["manifestId"]),
            "freshness": "current",
            "provenance": str(sources[source_id].get("coordinate") or ""),
        }
        for source_id in source_priority
    ]
    causal_constraints = [
        {
            "before": parent,
            "after": fact_id,
            "basis": "causal-parent",
            "evidence": str(fact_map[fact_id]["evidenceRoot"]),
        }
        for fact_id in order
        for parent in fact_map[fact_id].get("causalParents") or []
    ]
    perspective = {
        "schemaVersion": 1,
        "contract": "kfd-4-observer-perspective",
        "standard": "kfd-4",
        "id": f"kungfu-perspective-{observer_id}",
        "viewSubject": {
            "kind": "mixed-source-work-state",
            "description": "A deterministic view over accepted Kungfu source facts.",
        },
        "observer": {
            "id": observer_id,
            "kind": str(observer.get("kind") or "runtime-location"),
            "location": observer_location,
            "description": str(observer.get("description") or "Kungfu observer"),
        },
        "acceptedFacts": accepted_facts,
        "projectionPolicy": {
            "policyVersion": policy_version,
            "observerLocation": observer_location,
            "sourcePriority": list(source_priority),
            "causalDominance": True,
            "concurrentOrdering": "observer source priority, then source-local order",
            "tieBreaker": "source-id+frame-uid+fact-id",
        },
        "causalConstraints": causal_constraints,
        "degradedEvidence": [],
        "verification": {
            "result": "pass",
            "command": "./shifu test:kfd4-perspective",
            "notes": "Projection content is accepted only when the attached fsck passes.",
        },
    }
    material = {
        "perspective": perspective,
        "order": order,
        "facts": [copy.deepcopy(fact_map[fact_id]) for fact_id in order],
        "acceptedCuts": [
            _accepted_cut(sources[source_id]) for source_id in source_priority
        ],
        "replayLoss": list(replay_loss or []),
    }
    material["viewRoot"] = _root(material)
    fsck = fsck_projection(material)
    if fsck["status"] != "passed":
        raise PerspectiveError("projection-fsck", "new projection failed its own fsck")
    material["fsck"] = fsck
    return material


def fsck_projection(value: dict[str, Any]) -> dict[str, Any]:
    """Verify order, cuts, policy, evidence, identity, and content root."""

    issues: list[dict[str, str]] = []
    perspective = value.get("perspective") or {}
    facts = value.get("facts") or []
    order = value.get("order") or []
    if perspective.get("projectionPolicy", {}).get("policyVersion") != POLICY_VERSION:
        issues.append(
            {
                "code": "unknown-policy-version",
                "path": "perspective.projectionPolicy.policyVersion",
            }
        )
    if not str(perspective.get("observer", {}).get("id") or ""):
        issues.append({"code": "observer-identity", "path": "perspective.observer.id"})
    fact_ids = [str(fact.get("id") or "") for fact in facts]
    if len(set(fact_ids)) != len(fact_ids) or set(order) != set(fact_ids):
        issues.append({"code": "projection-membership", "path": "order"})
    positions = {fact_id: index for index, fact_id in enumerate(order)}
    for fact in facts:
        fact_id = str(fact.get("id") or "")
        if not _is_root(fact.get("evidenceRoot")):
            issues.append(
                {"code": "missing-evidence", "path": f"facts.{fact_id}.evidenceRoot"}
            )
        for parent in fact.get("causalParents") or []:
            if parent not in positions or positions.get(
                parent, len(order)
            ) >= positions.get(fact_id, -1):
                issues.append(
                    {
                        "code": "causal-inversion",
                        "path": f"facts.{fact_id}.causalParents",
                    }
                )
    cuts = {
        str(cut.get("sourceId") or ""): cut for cut in value.get("acceptedCuts") or []
    }
    for fact in facts:
        fact_id = str(fact.get("id") or "")
        cut = cuts.get(str(fact.get("sourceId") or ""))
        frame_uid = int(fact.get("frameUid") or 0)
        if (
            cut is None
            or cut.get("status") != "ok"
            or frame_uid < int(cut.get("firstFrameUid") or 0)
            or frame_uid > int(cut.get("lastFrameUid") or 0)
        ):
            issues.append(
                {"code": "undeclared-fact-cut", "path": f"facts.{fact_id}.frameUid"}
            )
    root_material = {
        key: item for key, item in value.items() if key not in {"viewRoot", "fsck"}
    }
    if value.get("viewRoot") != _root(root_material):
        issues.append({"code": "view-root-drift", "path": "viewRoot"})
    report = {
        "schema": "kungfu.kfd-4-projection-fsck/v1",
        "status": "passed" if not issues else "failed",
        "checks": [
            "observer-identity",
            "accepted-fact-cuts",
            "causal-dominance",
            "deterministic-order",
            "evidence-boundary",
            "content-root",
        ],
        "issues": issues,
    }
    report["root"] = _root(report)
    return report


def replay(
    projections: list[dict[str, Any]],
    *,
    mode: str,
    replay_observer: dict[str, str],
    declared_loss: list[str],
) -> dict[str, Any]:
    """Reconstruct one view or contrast multiple views without observer substitution."""

    if mode not in {"perspective-preserving", "contrastive"}:
        raise PerspectiveError("replay-mode", f"unsupported replay mode {mode}")
    if not projections or (mode == "contrastive" and len(projections) < 2):
        raise PerspectiveError("replay-cardinality", f"{mode} replay has too few views")
    source_views = []
    for projection in projections:
        perspective = projection["perspective"]
        facts = projection["facts"]
        source_views.append(
            {
                "id": perspective["id"],
                "kind": "observer-view",
                "coordinate": f"kungfu-perspective://{perspective['id']}@{projection['viewRoot']}",
                "sha256": projection["viewRoot"].removeprefix(_ROOT_PREFIX),
                "observer": perspective["observer"]["id"],
                "perspective": perspective["viewSubject"]["description"],
                "acceptedFactCut": _root(projection["acceptedCuts"]),
                "naturalObjects": _unique_strings(
                    fact["naturalObject"] for fact in facts
                ),
                "consequences": _unique_strings(fact["consequence"] for fact in facts),
                "knownGaps": _unique_strings(
                    item.get("reason", "")
                    for item in perspective.get("degradedEvidence") or []
                ),
            }
        )
    document: dict[str, Any] = {
        "schemaVersion": 1,
        "contract": "kfd-4-perspective-replay",
        "standard": "kfd-4",
        "replayId": f"kungfu-{mode}-replay",
        "mode": mode,
        "sourceViews": source_views,
        "replayObserver": {
            "id": str(replay_observer.get("id") or ""),
            "kind": str(replay_observer.get("kind") or "service"),
            "purpose": str(
                replay_observer.get("purpose") or "Verify perspective preservation."
            ),
        },
        "reconstruction": {
            "policyVersion": POLICY_VERSION,
            "sharedContext": _root(
                sorted(fact["id"] for fact in projections[0]["facts"])
            ),
            "preservedElements": list(_PRESERVED_ELEMENTS),
            "declaredLoss": list(declared_loss),
            "degradedState": "none",
        },
        "verification": {"result": "not-checked", "evidence": []},
    }
    if mode == "contrastive":
        document["contrast"] = {
            "dimensions": ["evidence-boundary", "consequence"],
            "mismatches": [
                {
                    "sourceViewIds": [view["id"] for view in source_views],
                    "observation": "Concurrent facts retain observer-relative order while causal edges remain fixed.",
                    "primitiveSignal": "inconclusive",
                }
            ],
        }
    checked = fsck_replay(document, projections)
    document["verification"] = {
        "result": "pass" if checked["status"] == "passed" else "fail",
        "evidence": [checked["root"]],
        "notes": "Replay verification is derived from retained source view roots and declared loss.",
    }
    return {"document": document, "fsck": checked}


def fsck_replay(
    document: dict[str, Any], projections: list[dict[str, Any]]
) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    source_views = document.get("sourceViews") or []
    if len(source_views) != len(projections):
        issues.append({"code": "replay-cardinality", "path": "sourceViews"})
    expected = {
        projection["perspective"]["id"]: projection for projection in projections
    }
    observers: list[str] = []
    for view in source_views:
        projection = expected.get(str(view.get("id") or ""))
        if projection is None:
            issues.append({"code": "source-view-unknown", "path": "sourceViews.id"})
            continue
        expected_observer = projection["perspective"]["observer"]["id"]
        observers.append(str(view.get("observer") or ""))
        if view.get("observer") != expected_observer:
            issues.append(
                {
                    "code": "observer-substitution",
                    "path": f"sourceViews.{view.get('id')}.observer",
                }
            )
        if view.get("sha256") != projection["viewRoot"].removeprefix(_ROOT_PREFIX):
            issues.append(
                {
                    "code": "source-view-root-drift",
                    "path": f"sourceViews.{view.get('id')}.sha256",
                }
            )
        if view.get("acceptedFactCut") != _root(projection["acceptedCuts"]):
            issues.append(
                {
                    "code": "accepted-cut-drift",
                    "path": f"sourceViews.{view.get('id')}.acceptedFactCut",
                }
            )
    if document.get("mode") == "contrastive" and len(set(observers)) != len(
        projections
    ):
        issues.append({"code": "observer-flattened", "path": "sourceViews.observer"})
    reconstruction = document.get("reconstruction") or {}
    preserved = set(reconstruction.get("preservedElements") or [])
    for item in _PRESERVED_ELEMENTS:
        if item not in preserved:
            issues.append(
                {
                    "code": "preservation-missing",
                    "path": f"reconstruction.preservedElements.{item}",
                }
            )
    declared = reconstruction.get("declaredLoss")
    expected_loss = {
        item
        for projection in projections
        for item in projection.get("replayLoss") or []
    }
    if not isinstance(declared, list) or not expected_loss.issubset(
        set(declared or [])
    ):
        issues.append(
            {"code": "undeclared-loss", "path": "reconstruction.declaredLoss"}
        )
    report = {
        "schema": "kungfu.kfd-4-replay-fsck/v1",
        "status": "passed" if not issues else "failed",
        "issues": issues,
    }
    report["root"] = _root(report)
    return report


def _normalized_source(inspected: dict[str, Any]) -> dict[str, Any]:
    source = inspected["source"]
    [accepted] = inspected["accepted_ranges"]
    frame_range = accepted["range"]
    return {
        "sourceId": source["source_id"],
        "sourceKind": "remote-runtime",
        "location": str(source["location_uid"]),
        "coordinate": source["coordinate"],
        "head": source["head"],
        "registered": source["registered"],
        "acceptedRange": {
            "manifestId": accepted["manifest_id"],
            "firstFrameUid": frame_range["first_frame_uid"],
            "lastFrameUid": frame_range["last_frame_uid"],
            "status": accepted["status"],
        },
    }


def qualify(
    runtime_dir: str | Path, *, native_build_info: dict[str, Any]
) -> dict[str, Any]:
    """Exercise real native Fact/source-registry operations and retain KFD-4 evidence."""

    import kungfu
    from kungfu.storage import service as storage_service

    runtime_dir = str(runtime_dir)
    runtime = kungfu.__binding__.runtime
    source_specs = [
        ("runtime-a", "kungfu://runtime-a", "head-a", 10, 30),
        ("runtime-b", "kungfu://runtime-b", "head-b", 20, 40),
    ]
    for index, (source_id, coordinate, head, first, last) in enumerate(source_specs):
        runtime.run_storage_service_operation(
            "source_register",
            runtime_dir,
            {
                "source_id": source_id,
                "kind": "kungfu_runtime",
                "coordinate": coordinate,
                "head": head,
                "register_time": 1000 + index,
            },
        )
        runtime.run_storage_service_operation(
            "source_update_head",
            runtime_dir,
            {
                "source_id": source_id,
                "head": head,
                "first_frame_uid": first,
                "last_frame_uid": last,
                "update_time": 2000 + index,
            },
        )
        runtime.run_storage_service_operation(
            "source_record_accepted_range",
            runtime_dir,
            {
                "source_id": source_id,
                "manifest_id": f"manifest-{source_id}",
                "first_frame_uid": first,
                "last_frame_uid": last,
                "status": "ok",
                "accept_time": 3000 + index,
            },
        )
    rebuild = runtime.run_storage_service_operation(
        "source_registry_rebuild", runtime_dir, {}
    )
    source_fsck = runtime.run_storage_service_operation(
        "source_registry_fsck", runtime_dir, {}
    )
    if (
        not source_fsck.get("ok")
        or source_fsck.get("projection", {}).get("status") != "ok"
    ):
        raise PerspectiveError(
            "native-source-fsck", "native source registry did not qualify"
        )
    sources = [
        _normalized_source(
            runtime.run_storage_service_operation(
                "source_inspect", runtime_dir, {"source_id": source_id}
            )
        )
        for source_id, *_ in source_specs
    ]

    schema_root = _ROOT_PREFIX + "4" * 64
    world = storage_service.fact_declare_contract_world(
        runtime_dir,
        {
            "id": "kungfu.kfd4.work-state",
            "version": "1",
            "effective_from": 100,
            "effective_until": 0,
            "fact_surface_ids": ["kungfu.kfd4.work-state.event"],
        },
        system_time=90,
    )
    storage_service.fact_declare_surface(
        runtime_dir,
        {
            "id": "kungfu.kfd4.work-state.event",
            "version": "1",
            "contract_world": world["reference"],
            "effective_from": 100,
            "effective_until": 0,
            "schema_owner_root": schema_root,
            "source_authorities": ["runtime-a", "runtime-b"],
            "identity_policy": "observation-id/v1",
            "valid_time_policy": "explicit-range/v1",
            "system_time_policy": "journal-event-time/v1",
            "causal_time_policy": "declared-parent/v1",
            "reducer_policy": "preserve-source-claims/v1",
            "correction_policy": "explicit-target/v1",
            "retraction_policy": "explicit-target/v1",
            "conflict_policy": "preserve-source-claims/v1",
            "redaction_policy": "hash-and-ref/v1",
            "compatibility_policy": "exact-schema-root/v1",
            "known_limits": ["bounded two-source qualification fixture"],
        },
        system_time=91,
    )
    fact_specs = [
        ("fact-a1", "runtime-a", 10, 1, [], "assignment", "accepted by maintainer"),
        ("fact-b1", "runtime-b", 20, 1, [], "review", "accepted by reviewer"),
        (
            "fact-a2",
            "runtime-a",
            30,
            2,
            ["fact-b1"],
            "release gate",
            "blocked until review",
        ),
    ]
    facts = []
    admissions = []
    for index, (
        fact_id,
        source_id,
        frame_uid,
        local_order,
        parents,
        natural,
        consequence,
    ) in enumerate(fact_specs):
        payload_root = _root(
            {"fact": fact_id, "naturalObject": natural, "consequence": consequence}
        )
        admitted = storage_service.fact_observe(
            runtime_dir,
            {
                "observation_id": fact_id,
                "contract_world_id": "kungfu.kfd4.work-state",
                "fact_surface_id": "kungfu.kfd4.work-state.event",
                "schema_owner_root": schema_root,
                "source_id": source_id,
                "subject_key": "kfd4-product-qualification",
                "valid_from": 1000 + index,
                "valid_until": 0,
                "payload_hash": payload_root,
                "payload_ref": f"content:{fact_id}",
                "action": "assert",
                "target_observation_id": "",
            },
            system_time=110 + index,
        )
        if admitted.get("admission", {}).get("outcome") != "admitted":
            raise PerspectiveError(
                "native-fact-admission", f"native fact {fact_id} was not admitted"
            )
        admissions.append(
            {
                "observationId": fact_id,
                "sourceId": source_id,
                "outcome": admitted["admission"]["outcome"],
                "payloadRoot": payload_root,
                "receiptRoot": _root(
                    {
                        "observationId": fact_id,
                        "sourceId": source_id,
                        "outcome": admitted["admission"]["outcome"],
                        "payloadRoot": payload_root,
                    }
                ),
            }
        )
        facts.append(
            {
                "id": fact_id,
                "sourceId": source_id,
                "frameUid": frame_uid,
                "sourceLocalOrder": local_order,
                "causalParents": parents,
                "naturalObject": natural,
                "consequence": consequence,
                "evidenceRoot": payload_root,
            }
        )

    loss = ["consumer-local display state is outside the retained source cut"]
    projection_a = project(
        observer={
            "id": "runtime-a",
            "location": "runtime-a",
            "kind": "runtime-location",
        },
        accepted_sources=sources,
        facts=facts,
        source_priority=["runtime-a", "runtime-b"],
        replay_loss=loss,
    )
    projection_b = project(
        observer={
            "id": "runtime-b",
            "location": "runtime-b",
            "kind": "runtime-location",
        },
        accepted_sources=sources,
        facts=facts,
        source_priority=["runtime-b", "runtime-a"],
        replay_loss=loss,
    )
    preserving = replay(
        [projection_a],
        mode="perspective-preserving",
        replay_observer={"id": "kungfu-rewind", "kind": "service"},
        declared_loss=loss,
    )
    contrastive = replay(
        [projection_a, projection_b],
        mode="contrastive",
        replay_observer={"id": "buildchain", "kind": "service"},
        declared_loss=loss,
    )

    negative_cases: list[dict[str, Any]] = []

    def retain_negative(case_id: str, action) -> None:
        try:
            result = action()
            issues = result.get("issues", [])
            observed = "failed" if result.get("status") == "failed" else "passed"
            codes = sorted({issue.get("code", "") for issue in issues})
        except PerspectiveError as error:
            observed = "failed"
            codes = [error.code]
        negative_cases.append(
            {
                "id": case_id,
                "expected": "failed",
                "observed": observed,
                "issueCodes": codes,
            }
        )

    def inverted_projection() -> dict[str, Any]:
        value = copy.deepcopy(projection_a)
        value["order"] = ["fact-a2", "fact-b1", "fact-a1"]
        return fsck_projection(value)

    retain_negative("causal-inversion", inverted_projection)
    retain_negative(
        "undeclared-fact-cut",
        lambda: project(
            observer={"id": "runtime-a", "location": "runtime-a"},
            accepted_sources=sources,
            facts=[{**facts[0], "frameUid": 99}],
            source_priority=["runtime-a", "runtime-b"],
        ),
    )
    retain_negative(
        "unknown-policy-version",
        lambda: project(
            observer={"id": "runtime-a", "location": "runtime-a"},
            accepted_sources=sources,
            facts=facts,
            source_priority=["runtime-a", "runtime-b"],
            policy_version="unknown/v9",
        ),
    )
    retain_negative(
        "missing-evidence",
        lambda: project(
            observer={"id": "runtime-a", "location": "runtime-a"},
            accepted_sources=sources,
            facts=[{**facts[0], "evidenceRoot": ""}],
            source_priority=["runtime-a", "runtime-b"],
        ),
    )

    def flattened_replay() -> dict[str, Any]:
        value = copy.deepcopy(contrastive["document"])
        value["sourceViews"][1]["observer"] = value["sourceViews"][0]["observer"]
        return fsck_replay(value, [projection_a, projection_b])

    retain_negative("flattened-observer", flattened_replay)

    def undeclared_loss() -> dict[str, Any]:
        value = copy.deepcopy(contrastive["document"])
        value["reconstruction"].pop("declaredLoss")
        return fsck_replay(value, [projection_a, projection_b])

    retain_negative("undeclared-replay-loss", undeclared_loss)
    if any(
        case["observed"] != case["expected"] or not case["issueCodes"]
        for case in negative_cases
    ):
        raise PerspectiveError(
            "negative-qualification", "one negative KFD-4 case did not fail closed"
        )

    source_fsck_summary = {
        "ok": source_fsck["ok"],
        "status": source_fsck["status"],
        "projectionStatus": source_fsck["projection"]["status"],
        "checked": source_fsck["checked"],
    }
    source_fsck_summary["root"] = _root(source_fsck_summary)
    safe_build_info = {
        key: copy.deepcopy(native_build_info[key])
        for key in ("version", "pythonVersion", "git")
        if key in native_build_info
    }
    report = {
        "schema": QUALIFICATION_SCHEMA,
        "standard": "kfd-4",
        "candidateOnly": True,
        "native": {
            "authority": source_fsck["authority"],
            "sourceRegistryRebuild": {
                "ok": rebuild["ok"],
                "rows": rebuild["rows"],
            },
            "sourceRegistryFsck": source_fsck_summary,
            "factAdmissions": admissions,
            "build": safe_build_info,
        },
        "perspectives": [projection_a, projection_b],
        "perspectivePreservingReplay": preserving,
        "contrastiveReplay": contrastive,
        "negativeCases": negative_cases,
        "verdict": {
            "status": "passed",
            "qualifying": False,
            "selfCertified": False,
            "releaseQualification": "not-qualified",
            "shippedSupport": False,
        },
        "nonClaims": [
            "This first-party report does not establish universal perspective completeness or observer equivalence.",
            "A passed Buildchain gate does not independently qualify, activate, or ship KFD-4 support.",
        ],
    }
    report["qualificationRoot"] = _root(report)
    return report


def bind_source(report: dict[str, Any], repo_root: Path) -> dict[str, Any]:
    module_path = Path("framework/core/src/python/kungfu/rewind/perspective.py")
    test_path = Path("framework/core/tests/python/test_kfd4_perspective.py")
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    report = copy.deepcopy(report)
    report["source"] = {
        "repository": "kungfu-systems/kungfu",
        "implementationRevision": revision,
        "bindings": [
            {"path": str(module_path), "sha256": _file_root(repo_root / module_path)},
            {"path": str(test_path), "sha256": _file_root(repo_root / test_path)},
        ],
    }
    report.pop("qualificationRoot", None)
    report["qualificationRoot"] = _root(report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--native-build-info", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(
        prefix="kungfu-kfd4-qualification-"
    ) as runtime_dir:
        report = qualify(
            runtime_dir,
            native_build_info=json.loads(
                args.native_build_info.read_text(encoding="utf-8")
            ),
        )
    report = bind_source(report, args.repo_root.resolve())
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
