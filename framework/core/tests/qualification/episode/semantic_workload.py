# SPDX-License-Identifier: Apache-2.0
"""Production-surface comparisons for Episode Qualification Semantic v1."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable

from semantic_oracle import (
    EpisodeOracle,
    Evidence,
    exhaust_bounded_histories,
    repair_is_monotonic,
)


CORE_DIR = Path(__file__).resolve().parents[3]
DIMENSIONS = (
    "lifecycle_safety",
    "capability_soundness",
    "useful_degradation",
    "repair_monotonicity",
    "dependency_containment",
    "projection_derivation",
    "publication_recovery",
    "content_integrity",
    "portable_identity",
)


def _load_runtime() -> tuple[Any, Any]:
    sys.path.insert(0, str(CORE_DIR / "src" / "python"))
    sys.path.insert(0, str(CORE_DIR / "dist" / "kungfu"))
    from kungfu.storage import content_store, service

    return service, content_store


def _write_json(path: str | Path, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, target)


def _expect(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def _begin(service: Any, runtime_dir: Path, episode_id: int, **values: Any) -> None:
    service.episode_begin(
        runtime_dir,
        episode_id=episode_id,
        title=f"semantic case {episode_id}",
        actor="qualification",
        source="qualification/semantic/v1",
        begin_time=1_000 + episode_id,
        **values,
    )


def _end(service: Any, runtime_dir: Path, episode_id: int) -> None:
    service.episode_end(
        runtime_dir,
        episode_id=episode_id,
        end_time=2_000 + episode_id,
        frame_count=0,
        reason="semantic qualification",
    )


def _case_lifecycle_recovery(service: Any, _: Any, root: Path) -> dict[str, Any]:
    runtime_dir = root / "lifecycle-recovery"
    oracle = EpisodeOracle()
    oracle.begin()
    _begin(service, runtime_dir, 101)
    opened = service.episode_inspect(runtime_dir, episode_id=101)["episode"]
    _expect(opened["status"], oracle.observe().lifecycle, "open lifecycle")
    _expect(opened["closed"], False, "open must not be presented as closed")

    _expect(oracle.recover(), True, "oracle first recovery")
    recovered = service.episode_recover(
        runtime_dir, episode_id=101, reason="semantic interrupted publication"
    )
    _expect(recovered["recovered_count"], 1, "production first recovery")
    inspected = service.episode_inspect(runtime_dir, episode_id=101)["episode"]
    _expect(inspected["status"], oracle.observe().lifecycle, "recovered lifecycle")
    _expect(inspected["closed"], True, "recovered Episode closure")

    _expect(oracle.recover(), False, "oracle repeated recovery")
    repeated = service.episode_recover(runtime_dir, episode_id=101)
    _expect(repeated["recovered_count"], 0, "production repeated recovery")
    return {
        "open_status": opened["status"],
        "recovered_status": inspected["status"],
        "first_recovered_count": recovered["recovered_count"],
        "second_recovered_count": repeated["recovered_count"],
    }


def _case_content_repair(
    service: Any, content_store: Any, root: Path
) -> dict[str, Any]:
    runtime_dir = root / "content-repair"
    raw = b"episode semantic qualification payload"
    digest = hashlib.sha256(raw).hexdigest()
    ref_hash = f"sha256:{digest}"
    oracle = EpisodeOracle()
    oracle.begin()
    oracle.attach_payload("payload", Evidence.MISSING)
    _begin(service, runtime_dir, 201)
    service.episode_attach_ref(
        runtime_dir,
        episode_id=201,
        ref_kind="payload",
        ref_id="qualification/payload.bin",
        ref_hash=ref_hash,
    )
    before = service.fsck(runtime_dir, episode_id=201)
    before_oracle = oracle.observe()
    _expect(before["status"], before_oracle.status, "open missing payload status")
    _expect(
        "episode_payload_ref_missing" in {row["code"] for row in before["warnings"]},
        True,
        "open missing payload evidence",
    )
    records_before = service.episode_inspect(runtime_dir, episode_id=201)["episode"][
        "record_count"
    ]

    published = content_store.put_if_absent(
        runtime_dir, "payloads", raw, expected_hash=ref_hash
    )
    _expect(published["ok"], True, "content publication")
    oracle.restore_payload("payload")
    after = service.fsck(runtime_dir, episode_id=201)
    after_oracle = oracle.observe()
    _expect(after["status"], after_oracle.status, "restored open payload status")
    _expect(
        repair_is_monotonic(before_oracle, after_oracle), True, "repair monotonicity"
    )

    repeated = content_store.put_if_absent(
        runtime_dir, "payloads", raw, expected_hash=ref_hash
    )
    _expect(repeated["ok"], True, "repeated content publication")
    _expect(repeated["existed"], True, "put-if-absent idempotence")
    records_after = service.episode_inspect(runtime_dir, episode_id=201)["episode"][
        "record_count"
    ]
    _expect(records_after, records_before, "repair must not rewrite manifest facts")

    rejected = content_store.put_if_absent(
        runtime_dir,
        "payloads",
        b"wrong bytes",
        expected_hash="sha256:" + "0" * 64,
    )
    _expect(rejected["ok"], False, "hash mismatch rejection")
    _expect(rejected["error"], "hash_mismatch", "hash mismatch classification")

    oracle.end()
    _end(service, runtime_dir, 201)
    sealed = service.fsck(runtime_dir, episode_id=201)
    _expect(sealed["status"], oracle.observe().status, "sealed restored payload status")
    verified = content_store.verify(runtime_dir, "payloads", ref_hash)
    _expect(verified["ok"], True, "verified content read")
    return {
        "status_path": [before["status"], after["status"], sealed["status"]],
        "manifest_records_before_repair": records_before,
        "manifest_records_after_repair": records_after,
        "put_if_absent_repeated": repeated["existed"],
        "hash_mismatch_rejected": not rejected["ok"],
        "content_profile": content_store.capabilities(runtime_dir)["profile"],
    }


def _case_dependency_containment(service: Any, _: Any, root: Path) -> dict[str, Any]:
    runtime_dir = root / "dependency-containment"
    dependent = EpisodeOracle()
    dependent.begin()
    dependent.require_episode(999)
    dependent.end()
    _begin(service, runtime_dir, 301, parent_episode_id=999)
    _end(service, runtime_dir, 301)

    independent = EpisodeOracle()
    independent.begin()
    independent.end()
    _begin(service, runtime_dir, 302)
    _end(service, runtime_dir, 302)

    dependent_before = service.fsck(runtime_dir, episode_id=301)
    independent_before = service.fsck(runtime_dir, episode_id=302)
    _expect(dependent_before["status"], dependent.observe().status, "dependent status")
    missing_dependency_observed = "episode_dependency_missing" in {
        row["code"] for row in dependent_before["warnings"]
    }
    _expect(
        missing_dependency_observed,
        True,
        "dependent degradation must name the missing dependency",
    )
    _expect(
        independent_before["status"], independent.observe().status, "independent status"
    )

    _begin(service, runtime_dir, 999)
    _end(service, runtime_dir, 999)
    dependent.resolve_episode(999)
    dependent_after = service.fsck(runtime_dir, episode_id=301)
    independent_after = service.fsck(runtime_dir, episode_id=302)
    _expect(
        dependent_after["status"], dependent.observe().status, "resolved dependency"
    )
    _expect(
        independent_after["status"],
        independent_before["status"],
        "independent Episode containment",
    )
    return {
        "dependent_status_path": [
            dependent_before["status"],
            dependent_after["status"],
        ],
        "independent_status_path": [
            independent_before["status"],
            independent_after["status"],
        ],
        "missing_dependency_code_observed": missing_dependency_observed,
    }


def _case_projection(service: Any, _: Any, root: Path) -> dict[str, Any]:
    runtime_dir = root / "projection"
    oracle = EpisodeOracle()
    oracle.begin()
    oracle.end()
    _begin(service, runtime_dir, 401)
    _end(service, runtime_dir, 401)
    absent = service.fsck(runtime_dir, episode_id=401)["episode_projection"]
    _expect(absent["status"], oracle.projection, "absent projection")

    rebuilt = service.episode_projection_rebuild(runtime_dir)
    oracle.rebuild_projection()
    current = service.fsck(runtime_dir, episode_id=401)["episode_projection"]
    _expect(current["status"], "ok", "rebuilt projection")

    _begin(service, runtime_dir, 402)
    _end(service, runtime_dir, 402)
    oracle.mark_projection_stale()
    stale_fsck = service.fsck(runtime_dir, episode_id=402)
    stale = stale_fsck["episode_projection"]
    _expect(stale["status"], "degraded", "stale projection")
    _expect(stale_fsck["status"], oracle.observe().status, "stale projection trust")

    service.episode_projection_rebuild(runtime_dir)
    oracle.rebuild_projection()
    healed = service.fsck(runtime_dir, episode_id=402)
    _expect(healed["episode_projection"]["status"], "ok", "healed projection")
    _expect(healed["status"], oracle.observe().status, "healed projection trust")
    return {
        "projection_status_path": [
            absent["status"],
            current["status"],
            stale["status"],
            healed["episode_projection"]["status"],
        ],
        "authority": rebuilt["authority"],
        "journal_records": rebuilt["journal_records"],
    }


def _case_portable_identity(service: Any, _: Any, root: Path) -> dict[str, Any]:
    runtime_dir = root / "portable-identity"
    imported_runtime = root / "portable-identity-import"
    _begin(service, runtime_dir, 501)
    _end(service, runtime_dir, 501)
    bundle = service.build_export_bundle(runtime_dir, episode_id=501)
    imported = service.import_bundle(imported_runtime, bundle)
    _expect(imported["episode_id"], 501, "portable Episode id")
    _expect(imported["records"], bundle["record_count"], "portable record count")
    _expect(
        imported["dependency_count"],
        bundle["dependency_count"],
        "portable dependency count",
    )
    _expect(imported["dry_run"], True, "Episode import v1 is validation-only")
    _expect(imported["accepted"], False, "Episode import v1 does not materialize")
    return {
        "episode_id": imported["episode_id"],
        "record_count": imported["records"],
        "dependency_count": imported["dependency_count"],
        "import_status": imported["status"],
        "materialized": imported["accepted"],
    }


CASES: tuple[
    tuple[str, tuple[str, ...], Callable[[Any, Any, Path], dict[str, Any]]], ...
] = (
    (
        "open-publication-recovery",
        ("lifecycle_safety", "publication_recovery"),
        _case_lifecycle_recovery,
    ),
    (
        "content-degradation-and-repair",
        ("useful_degradation", "repair_monotonicity", "content_integrity"),
        _case_content_repair,
    ),
    (
        "dependency-failure-containment",
        ("useful_degradation", "dependency_containment"),
        _case_dependency_containment,
    ),
    ("projection-derivation", ("projection_derivation",), _case_projection),
    ("portable-identity", ("portable_identity",), _case_portable_identity),
)


def run_semantic(runtime_root: Path) -> dict[str, Any]:
    service, content_store = _load_runtime()
    try:
        histories_checked = exhaust_bounded_histories()
        oracle_check = {
            "status": "passed",
            "histories_checked": histories_checked,
            "violation": None,
        }
    except Exception as error:
        oracle_check = {
            "status": "failed",
            "histories_checked": 0,
            "violation": f"{type(error).__name__}: {error}"[:1000],
        }
    cases: list[dict[str, Any]] = []
    for name, dimensions, invoke in CASES:
        try:
            evidence = invoke(service, content_store, runtime_root)
            cases.append(
                {
                    "name": name,
                    "dimensions": list(dimensions),
                    "status": "passed",
                    "violations": [],
                    "evidence": evidence,
                }
            )
        except Exception as error:
            cases.append(
                {
                    "name": name,
                    "dimensions": list(dimensions),
                    "status": "failed",
                    "violations": [f"{type(error).__name__}: {error}"[:1000]],
                    "evidence": {},
                }
            )

    dimensions: dict[str, dict[str, Any]] = {}
    for dimension in DIMENSIONS:
        covered = [case for case in cases if dimension in case["dimensions"]]
        violations = [
            {"case": case["name"], "message": message}
            for case in covered
            for message in case["violations"]
        ]
        if dimension == "capability_soundness":
            dimensions[dimension] = {
                "status": "not_exercised",
                "cases_executed": 0,
                "violations": [],
                "evidence": [],
                "reason": "production Episode safe-capability report is not implemented",
            }
        elif not covered:
            dimensions[dimension] = {
                "status": "not_exercised",
                "cases_executed": 0,
                "violations": [],
                "evidence": [],
                "reason": "no production comparison is registered",
            }
        else:
            dimensions[dimension] = {
                "status": "failed" if violations else "passed",
                "cases_executed": len(covered),
                "violations": violations,
                "evidence": [case["name"] for case in covered],
                "reason": None,
            }
    return {
        "ok": oracle_check["status"] == "passed"
        and all(case["status"] == "passed" for case in cases),
        "kind": "semantic",
        "oracle": "kungfu.episode.semantic-oracle/v1",
        "oracle_check": oracle_check,
        "cases": cases,
        "dimensions": dimensions,
        "errors": [
            {
                "code": "semantic_case_failed",
                "case": case["name"],
                "violations": case["violations"],
            }
            for case in cases
            if case["status"] == "failed"
        ]
        + (
            [
                {
                    "code": "semantic_oracle_check_failed",
                    "violation": oracle_check["violation"],
                }
            ]
            if oracle_check["status"] == "failed"
            else []
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", required=True)
    parser.add_argument("--runtime-root", required=True)
    args = parser.parse_args()
    result = run_semantic(Path(args.runtime_root))
    _write_json(args.result, result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
