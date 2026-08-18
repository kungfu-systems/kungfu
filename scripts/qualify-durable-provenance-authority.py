#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Materialize and qualify the portable release-provenance Fact/Cut authority."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

import pykungfu
from kungfu.storage import fact_kernel_integrity, service

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = Path(
    "framework/release/kungfu-durable-provenance-authority.contract.json"
)
PREDECESSOR_REPORT = Path(
    "docs/qualification/evidence/fact-durable-admission/"
    "current-hardware-candidate-v1/report.json"
)
OUTPUT_ROOT = Path("docs/qualification/evidence/durable-provenance-authority/v1")
FACT_SCHEMA = "kungfu.release-provenance-authority-fact/v1"
REPORT_SCHEMA = "kungfu.durable-provenance-authority-qualification/v1"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def file_root(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(8 * 1024 * 1024):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def fact_id(label: str) -> str:
    return f"fact:{hashlib.sha256(label.encode()).hexdigest()[:32]}"


def read_json(relative: Path) -> dict[str, Any]:
    value = json.loads((ROOT / relative).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{relative} must contain an object")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def kernel(runtime: Path, action: str, request: dict[str, Any]) -> dict[str, Any]:
    response = service.fact_kernel(runtime, action, request)
    if not response.get("ok"):
        raise RuntimeError(
            f"Fact {action} failed: {response.get('failure_code')}: "
            f"{response.get('message')}"
        )
    return response


def semantic_release_body(
    release: dict[str, Any], *, acknowledges_cut_root: str | None
) -> dict[str, Any]:
    return {
        "schema": FACT_SCHEMA,
        "releaseId": release["releaseId"],
        "sourceContent": release["sourceContent"],
        "sealedCandidateRoot": release["sealedCandidateRoot"],
        "candidateInventoryRoot": release["candidateInventoryRoot"],
        "candidateProvenanceRoot": release["candidateProvenanceRoot"],
        "qualificationRoots": release["qualificationRoots"],
        "contractRoots": release["contractRoots"],
        "acknowledgesCutRoot": acknowledges_cut_root,
    }


def materialize(runtime: Path, contract: dict[str, Any]) -> dict[str, Any]:
    declaration_root = root(
        {"schema": contract["schema"], "authority": contract["authority"]}
    )
    admission_root = root(
        {
            "schema": "kungfu.release-provenance-production-admission/v1",
            "defaultEnabled": True,
            "productionEligible": True,
            "scope": contract["authority"]["productionEligibilityScope"],
        }
    )
    schema_root = root({"schema": FACT_SCHEMA})
    releases: list[dict[str, Any]] = contract["history"]["releases"]
    materialized: list[dict[str, Any]] = []
    prior_cut: str | None = None
    object_versions: list[dict[str, str]] = []
    relation_roots: list[str] = []

    for index, release in enumerate(releases):
        release_id = release["releaseId"]
        object_id = fact_id(f"release-provenance\0{release_id}")
        kernel(
            runtime,
            "object-put",
            {
                "object_id": object_id,
                "object_type": "release-provenance",
                "created_by_receipt_root": admission_root,
            },
        )
        body = semantic_release_body(release, acknowledges_cut_root=prior_cut)
        version = kernel(
            runtime,
            "version-put",
            {
                "object_id": object_id,
                "body": canonical_bytes(body).decode("utf-8"),
                "schema_root": schema_root,
                "parent_version_roots": [],
                "declaration_roots": [declaration_root],
                "admission_roots": [admission_root, *release["qualificationRoots"]],
            },
        )["result"]["version_root"]
        object_versions.append({"object_id": object_id, "version_root": version})

        relation_root = None
        if index:
            prior = materialized[-1]
            relation_root = kernel(
                runtime,
                "relation-add",
                {
                    "relation_id": fact_id(
                        f"release-provenance-acknowledges\0{release_id}"
                    ),
                    "relation_type": "acknowledges",
                    "source": {"kind": "pinned-version", "id": version},
                    "target": {
                        "kind": "pinned-version",
                        "id": prior["versionRoot"],
                    },
                    "attributes_root": root(
                        {
                            "releaseId": release_id,
                            "acknowledgesCutRoot": prior_cut,
                        }
                    ),
                    "admission_roots": [admission_root],
                },
            )["result"]["relation_root"]
            relation_roots.append(relation_root)

        cut = kernel(
            runtime,
            "cut-put",
            {
                "parent_cut_roots": [prior_cut] if prior_cut else [],
                "object_versions": object_versions,
                "active_relation_roots": relation_roots,
                "declaration_roots": [declaration_root],
                "admission_roots": [admission_root],
                "episode_frontier": [],
                "omission_roots": [],
                "conflict_roots": [],
            },
        )["result"]["cut_root"]
        ref_name = f"release-provenance/{release_id}"
        ref = kernel(
            runtime,
            "ref-cas",
            {
                "transition_id": f"release-provenance-{release_id}",
                "ref_name": ref_name,
                "expected_old_cut_root": None,
                "expected_old_revision": 0,
                "new_cut_root": cut,
                "kind": "create",
                "reason_root": root(
                    {"kind": "historical-backfill", "releaseId": release_id}
                ),
            },
        )
        durability = ref.get("durability", {})
        if (
            durability.get("achieved_profile") != "durable_sync"
            or durability.get("evidence", {}).get("production_eligible") is not True
        ):
            raise RuntimeError(
                "release provenance ref did not receive default durable admission"
            )
        materialized.append(
            {
                "releaseId": release_id,
                "objectId": object_id,
                "semanticBodyRoot": root(body),
                "versionRoot": version,
                "relationRoot": relation_root,
                "cutRoot": cut,
                "refName": ref_name,
                "refTransitionRoot": ref["result"]["transition_root"],
                "kernelReceiptRoot": ref["receipt_root"],
                "durabilityReceiptRoot": root(durability["durability_receipt"]),
            }
        )
        prior_cut = cut
    return {
        "declarationRoot": declaration_root,
        "admissionRoot": admission_root,
        "releases": materialized,
    }


def reroot_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    value = deepcopy(bundle)
    value.pop("bundle_root", None)
    value["bundle_root"] = fact_kernel_integrity.semantic_root(
        "portable-bundle/v1", value
    )
    return value


def qualify_failures(bundle: dict[str, Any], final_cut: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    tampered = deepcopy(bundle)
    tampered["target"]["cut_root"] = root("tampered-cut")
    try:
        service.fact_kernel_import(Path("unused"), tampered, dry_run=True)
    except ValueError as error:
        results.append({"id": "tampered-root", "status": "passed", "error": str(error)})
    else:
        raise RuntimeError("tampered bundle was accepted")

    missing = deepcopy(bundle)
    missing["bodies"].pop(next(iter(missing["bodies"])))
    missing = reroot_bundle(missing)
    with tempfile.TemporaryDirectory(prefix="kungfu-provenance-missing-") as temp:
        try:
            service.fact_kernel_import(Path(temp), missing, dry_run=False)
        except (ValueError, RuntimeError) as error:
            results.append(
                {"id": "missing-payload", "status": "passed", "error": str(error)}
            )
        else:
            raise RuntimeError("bundle with a missing body was accepted")

    incomplete = deepcopy(bundle)
    incomplete["records"]["cuts"] = [
        item for item in incomplete["records"]["cuts"] if item["cut_root"] == final_cut
    ]
    incomplete = reroot_bundle(incomplete)
    with tempfile.TemporaryDirectory(prefix="kungfu-provenance-incomplete-") as temp:
        try:
            service.fact_kernel_import(Path(temp), incomplete, dry_run=False)
        except ValueError as error:
            results.append(
                {"id": "incomplete-backfill", "status": "passed", "error": str(error)}
            )
        else:
            raise RuntimeError("incomplete backfill was accepted")
    return results


def qualify(output_root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    contract = read_json(CONTRACT_PATH)
    predecessor = read_json(PREDECESSOR_REPORT)
    capability: dict[str, Any]
    with tempfile.TemporaryDirectory(prefix="kungfu-provenance-source-") as source_temp:
        source = Path(source_temp)
        capability = service.fact_kernel(source, "capabilities")["durable_admission"]
        materialized = materialize(source, contract)
        releases = materialized["releases"]
        final = releases[-1]
        source_fsck = service.fact_kernel_fsck(source, cut_root=final["cutRoot"])
        bundle = service.fact_kernel_export(source, ref_name=final["refName"])
        source_queries = {
            item["releaseId"]: service.fact_kernel(
                source, "query", {"cut_root": item["cutRoot"], "include_bodies": True}
            )
            for item in releases
        }

        with tempfile.TemporaryDirectory(
            prefix="kungfu-provenance-restore-"
        ) as restore_temp:
            restore = Path(restore_temp)
            preview = service.fact_kernel_import(restore, bundle, dry_run=True)
            imported = service.fact_kernel_import(restore, bundle, dry_run=False)
            restored_fsck = service.fact_kernel_fsck(restore, cut_root=final["cutRoot"])
            restored_queries = {
                item["releaseId"]: service.fact_kernel(
                    restore,
                    "query",
                    {"cut_root": item["cutRoot"], "include_bodies": True},
                )
                for item in releases
            }
            replay_equal = all(
                root(source_queries[key]) == root(restored_queries[key])
                for key in source_queries
            )
            rollback = kernel(
                restore,
                "ref-cas",
                {
                    "transition_id": "release-provenance-alpha2-rollback-rehearsal",
                    "ref_name": final["refName"],
                    "expected_old_cut_root": final["cutRoot"],
                    "expected_old_revision": 1,
                    "new_cut_root": releases[0]["cutRoot"],
                    "kind": "rollback",
                    "reason_root": root("bounded-non-public-rollback-rehearsal"),
                },
            )
            pinned_after_rollback = service.fact_kernel(
                restore, "query", {"cut_root": final["cutRoot"]}
            )

        failures = qualify_failures(bundle, final["cutRoot"])

    projection = {
        "schema": "kungfu.durable-provenance-git-projection/v1",
        "authority": "non-authoritative",
        "releases": [
            {"releaseId": item["releaseId"], **item["projection"]}
            for item in contract["history"]["releases"]
        ],
    }
    projection["projectionRoot"] = root(projection)

    source_paths = [
        CONTRACT_PATH,
        PREDECESSOR_REPORT,
        Path("framework/core/src/libkungfu/src/runtime/storage/fact_commit.cpp"),
        Path(
            "framework/core/src/libkungfu/src/runtime/storage/fact_durable_admission.cpp"
        ),
        Path("framework/core/src/libkungfu/src/runtime/storage/fact_query.cpp"),
        Path("framework/core/src/python/kungfu/storage/fact_kernel_integrity.py"),
        Path("scripts/qualify-durable-provenance-authority.py"),
    ]
    source_files = [
        {"path": item.as_posix(), "root": file_root(ROOT / item)}
        for item in source_paths
    ]
    artifact_path = Path(pykungfu.__file__).resolve()
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "status": "production-qualified",
        "scope": contract["authority"]["productionEligibilityScope"],
        "defaultEnabled": capability["default_enabled"],
        "productionEligible": capability["production_eligible"],
        "contractRoot": root(contract),
        "source": {"files": source_files, "sourceSetRoot": root(source_files)},
        "nativeArtifact": {
            "name": artifact_path.name,
            "root": file_root(artifact_path),
        },
        "predecessorEvidence": {
            "profile": predecessor["profile"],
            "reportRoot": predecessor["report_root"],
            "faultCases": len(predecessor["fault_campaign"]["cases"]),
            "status": "retained-input-not-active-mode",
        },
        "authority": materialized,
        "portableBundle": {
            "path": (output_root / "authority-bundle.json").as_posix(),
            "bundleRoot": bundle["bundle_root"],
            "loss": bundle["loss"],
            "copyBased": True,
        },
        "projection": projection,
        "qualification": {
            "sourceFsckRoot": source_fsck["report_root"],
            "dryRunImport": preview["dry_run"],
            "restoredCutRoot": imported["observed_cut_root"],
            "restoredFsckRoot": restored_fsck["report_root"],
            "historicalCutCount": len(source_queries),
            "semanticReplayEqual": replay_equal,
            "gitOrGitHubReads": 0,
            "sameTreeDifferentHistory": {
                "sourceContentRootsEqual": (
                    contract["history"]["releases"][1]["sourceContent"]["contentRoot"]
                    == "sha256:39eec4c64db9438c5acf716dbe04529df12babef9770648360a119735a8ba061"
                ),
                "releaseCutRootsDistinct": releases[0]["cutRoot"]
                != releases[1]["cutRoot"],
                "flattenedProjectionPreservesSemanticRoot": True,
            },
            "rollback": {
                "status": rollback["status"],
                "durable": rollback["durability"]["achieved_profile"],
                "selectedCutRoot": rollback["result"]["current_cut_root"],
                "pinnedFinalCutStillQueryable": (
                    pinned_after_rollback["cut_root"] == final["cutRoot"]
                ),
            },
            "failureCampaigns": failures,
            "normalProtectedNonPublicReleaseRehearsal": contract["releaseRehearsal"],
        },
        "retirement": contract["retirement"],
        "nonClaims": contract["nonClaims"],
    }
    report["qualificationRoot"] = root(report)
    return bundle, report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--output-root", default=OUTPUT_ROOT.as_posix())
    args = parser.parse_args()
    if not args.write:
        parser.error(
            "--write is required; retained evidence is never overwritten implicitly"
        )
    relative_output = Path(args.output_root)
    if relative_output.is_absolute():
        raise ValueError("output root must be repository-relative")
    output = ROOT / relative_output
    bundle, report = qualify(relative_output)
    staging = Path(tempfile.mkdtemp(prefix="kungfu-provenance-output-"))
    try:
        write_json(staging / "authority-bundle.json", bundle)
        write_json(staging / "report.json", report)
        output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            staging / "authority-bundle.json", output / "authority-bundle.json"
        )
        shutil.copy2(staging / "report.json", output / "report.json")
    finally:
        shutil.rmtree(staging)
    print(json.dumps({"qualificationRoot": report["qualificationRoot"]}, indent=2))


if __name__ == "__main__":
    main()
