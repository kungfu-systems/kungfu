# SPDX-License-Identifier: Apache-2.0

"""Qualify the sealed Alpha candidate through temporal admission without rebuild."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from kungfu.release_provenance import (
    build_candidate,
    build_promotion,
    semantic_root,
)
from kungfu.temporal_release_admission import verify_admission

EXPECTED_ARTIFACT_COUNT = 44
EXPECTED_RUN_ID = "31051528142"
EXPECTED_SOURCE = "ad7c7db6df076f969c5939728bcbe70ccd4771b3"
EXPECTED_TREE = "67a93b5831596555e7c29104421de3a0b97eb865"
EXPECTED_VERSION = "4.0.0-alpha.1"
DEV_CUT = "f9e6b0e34bcdd6407b2a18206ace7982d64de2c8"
PREVIOUS_ALPHA = "5a3aea2d8f883b6ead343d43f2d34c574c08dc9e"
PROMOTION_COMMIT = DEV_CUT
HISTORICAL_CONTRACT = (
    "sha256:13c4679c4ac8764c85e29693bfb59099e21e9786cc6082552198d39393467490"
)


class CutoverError(ValueError):
    """Stable qualification rejection."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise CutoverError(code, message)


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _json_root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_canonical_bytes(value)).hexdigest()}"


def _content_root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_canonical_bytes(value) + b'\n').hexdigest()}"


def _file_root(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(8 * 1024 * 1024):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def _regular(path: Path, label: str) -> Path:
    if not path.is_file() or path.is_symlink():
        _fail("non-regular-input", f"{label} must be a regular non-symlink file")
    return path


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(_regular(path, label).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        _fail("invalid-json", f"{label} is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail("invalid-json", f"{label} must contain an object")
    return value


def _parse_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for index, line in enumerate(
        _regular(path, "SHA256SUMS").read_text(encoding="utf-8").splitlines(), 1
    ):
        parts = line.split("  ", 1)
        if (
            len(parts) != 2
            or len(parts[0]) != 64
            or any(char not in "0123456789abcdef" for char in parts[0])
            or "/" in parts[1]
            or "\\" in parts[1]
            or parts[1] in checksums
        ):
            _fail("invalid-checksum-manifest", f"invalid SHA256SUMS line {index}")
        checksums[parts[1]] = f"sha256:{parts[0]}"
    return checksums


def _artifact_snapshot(root: Path) -> tuple[dict[str, Any], dict[str, os.stat_result]]:
    checksums_path = root / "SHA256SUMS"
    metadata_path = root / "artifacts.json"
    checksums = _parse_checksums(checksums_path)
    metadata = _read_json(metadata_path, "artifacts.json")
    rows = metadata.get("artifacts")
    if (
        metadata.get("total_count") != EXPECTED_ARTIFACT_COUNT
        or not isinstance(rows, list)
        or len(rows) != EXPECTED_ARTIFACT_COUNT
        or len(checksums) != EXPECTED_ARTIFACT_COUNT
    ):
        _fail(
            "artifact-count-mismatch", "the sealed candidate must contain 44 archives"
        )
    files = []
    stats: dict[str, os.stat_result] = {}
    names: set[str] = set()
    for row in rows:
        name = str(row.get("name", ""))
        file_name = f"{name}.zip"
        if not name or file_name in names or file_name not in checksums:
            _fail("artifact-manifest-mismatch", "artifact names are not one-to-one")
        names.add(file_name)
        path = _regular(root / "artifacts" / file_name, file_name)
        stat = path.stat()
        observed_root = _file_root(path)
        if (
            stat.st_size != row.get("size_in_bytes")
            or observed_root != checksums[file_name]
            or row.get("digest") != observed_root
            or str(row.get("workflow_run", {}).get("id", "")) != EXPECTED_RUN_ID
        ):
            _fail("artifact-byte-mismatch", f"sealed artifact drift: {file_name}")
        files.append(
            {
                "fileName": file_name,
                "size": stat.st_size,
                "root": observed_root,
            }
        )
        stats[file_name] = stat
    actual_names = {
        path.name for path in (root / "artifacts").iterdir() if path.is_file()
    }
    if actual_names != names or set(checksums) != names:
        _fail(
            "artifact-manifest-mismatch",
            "artifact directory has missing or extra files",
        )
    files.sort(key=lambda row: row["fileName"])
    manifests = [
        {
            "path": "SHA256SUMS",
            "size": checksums_path.stat().st_size,
            "root": _file_root(checksums_path),
        },
        {
            "path": "artifacts.json",
            "size": metadata_path.stat().st_size,
            "root": _file_root(metadata_path),
        },
    ]
    body = {"files": files, "manifests": manifests}
    return {**body, "root": _json_root(body)}, stats


def _candidate_inventory(reconstruction: Path) -> dict[str, Any]:
    inventory = _read_json(
        reconstruction / "candidate-inventory.json", "candidate-inventory.json"
    )
    files = inventory.get("files")
    if (
        inventory.get("schema") != "kungfu.alpha-local-exact-candidate-inventory/v1"
        or not isinstance(files, list)
        or inventory.get("fileCount") != len(files)
    ):
        _fail("candidate-inventory-invalid", "candidate inventory contract mismatch")
    actual_paths: set[str] = set()
    candidate_root = reconstruction / "candidate"
    for path in candidate_root.rglob("*"):
        if path.is_symlink():
            _fail(
                "candidate-inventory-symlink", "candidate inventory contains a symlink"
            )
        if path.is_file():
            actual_paths.add(path.relative_to(candidate_root).as_posix())
    declared_paths = {str(row.get("path", "")) for row in files}
    if actual_paths != declared_paths or len(declared_paths) != len(files):
        _fail("candidate-inventory-drift", "candidate file set differs from inventory")
    observed = []
    for row in files:
        path = _regular(candidate_root / row["path"], row["path"])
        entry = {
            "role": row.get("role"),
            "path": row["path"],
            "size": path.stat().st_size,
            "root": _file_root(path),
        }
        if entry != row:
            _fail("candidate-byte-mismatch", f"candidate byte drift: {row['path']}")
        observed.append(entry)
    observed.sort(key=lambda row: row["path"])
    body = {
        "schema": inventory["schema"],
        "fileCount": len(observed),
        "files": observed,
    }
    observed_root = _json_root(body)
    if inventory.get("inventoryRoot") != observed_root:
        _fail("candidate-inventory-root-mismatch", "candidate inventory root drift")
    return {**body, "inventoryRoot": observed_root}


def _build_provenance(
    report: dict[str, Any], contract: dict[str, Any]
) -> dict[str, Any]:
    authority_root = semantic_root(
        {
            "schema": "kungfu.release-provenance-external-identity/v1",
            "kind": "authority",
            "identity": "kungfu-systems/kungfu:.github/workflows/release-new-version.yml",
        }
    )
    admission_roots = [
        report[field]
        for field in (
            "candidateInputRoot",
            "candidateInventoryRoot",
            "capsuleRoot",
            "bindingRoot",
            "transactionRoot",
            "evidenceRoot",
        )
    ]
    candidate = build_candidate(
        release_id="v4.0.0-alpha.1",
        candidate_id="sealed-alpha-run-31051528142",
        candidate_commit=EXPECTED_SOURCE,
        candidate_tree=EXPECTED_TREE,
        dev_cut_commit=DEV_CUT,
        dev_cut_tree=EXPECTED_TREE,
        previous_alpha_commit=PREVIOUS_ALPHA,
        previous_alpha_tree=EXPECTED_TREE,
        dev_cut_root=semantic_root({"kind": "dev-cut", "commit": DEV_CUT}),
        previous_alpha_root=semantic_root(
            {"kind": "previous-alpha", "commit": PREVIOUS_ALPHA}
        ),
        qualification_root=report["evidenceRoot"],
        authority_root=authority_root,
        contract_root=semantic_root(contract),
        admission_roots=admission_roots,
        observed_parents=[DEV_CUT, PREVIOUS_ALPHA],
        legacy_projection={
            "candidateSha": EXPECTED_SOURCE,
            "candidateTree": EXPECTED_TREE,
            "buildRunId": EXPECTED_RUN_ID,
        },
        fail_closed_on=["candidate-tree-mismatch"],
    )
    promotion = build_promotion(
        candidate_envelope=candidate,
        promotion_id=f"release-promotion:v4.0.0-alpha.1:{report['evidenceRoot']}",
        promotion_commit=PROMOTION_COMMIT,
        promotion_tree=EXPECTED_TREE,
        qualification_root=report["evidenceRoot"],
        authority_root=authority_root,
        contract_root=semantic_root(contract),
        admission_roots=admission_roots,
        candidate_ancestry_observed=False,
        legacy_projection={
            "candidateSha": EXPECTED_SOURCE,
            "promotionSha": PROMOTION_COMMIT,
            "treePreserved": True,
        },
    )
    return {
        "candidate": candidate,
        "promotion": promotion,
        "authorityRoot": authority_root,
    }


def qualify(root: Path, artifact_root: Path, reconstruction: Path) -> dict[str, Any]:
    snapshot, initial_stats = _artifact_snapshot(artifact_root)
    report = _read_json(reconstruction / "report.json", "reconstruction report")
    expected_report = {
        "status": "passed",
        "artifactCount": EXPECTED_ARTIFACT_COUNT,
        "buildRunId": EXPECTED_RUN_ID,
        "sourceCommit": EXPECTED_SOURCE,
        "sourceTree": EXPECTED_TREE,
        "version": EXPECTED_VERSION,
        "candidateInputRoot": snapshot["root"],
        "externalPublicationClaimed": False,
        "inputUnchanged": True,
    }
    for field, expected in expected_report.items():
        if report.get(field) != expected:
            _fail("reconstruction-report-mismatch", f"report {field} drift")
    inventory = _candidate_inventory(reconstruction)
    if report.get("candidateInventoryRoot") != inventory["inventoryRoot"]:
        _fail("candidate-inventory-root-mismatch", "report inventory root drift")
    source_roots = {row["fileName"]: row["root"] for row in snapshot["files"]}
    for row in inventory["files"]:
        if (
            row["role"].startswith("installable-product-")
            and source_roots.get(Path(row["path"]).name) != row["root"]
        ):
            _fail(
                "candidate-byte-substitution",
                f"staged artifact drift: {row['path']}",
            )
    capsule = _read_json(reconstruction / "rehearsal-capsule.json", "rehearsal capsule")
    capsule_root = capsule.pop("root", "")
    if capsule_root != _json_root(capsule) or capsule_root != report.get("capsuleRoot"):
        _fail("capsule-root-mismatch", "rehearsal capsule root drift")

    policy = _read_json(
        root / "docs/qualification/gates/release-admission-policy.json",
        "release admission policy",
    )
    contract = _read_json(
        root / policy["temporalAdmission"]["contract"], "temporal admission contract"
    )
    facts = _read_json(
        root / policy["temporalAdmission"]["admissionFacts"], "admission facts"
    )
    historical_proof = next(
        row["record"]
        for row in facts["proofs"]
        if row["record"]["proofId"] == "alpha-sealed-candidate-historical-contract"
    )
    compatibility_facts = _read_json(
        root / policy["temporalAdmission"]["compatibilityFacts"],
        "Buildchain compatibility Fact projection",
    )
    provenance_contract = _read_json(
        root / policy["temporalAdmission"]["releaseProvenanceContract"],
        "release provenance contract",
    )
    runtime = policy["buildchain"]["runtimes"]["alpha"]
    provenance = _build_provenance(report, provenance_contract)
    admission = verify_admission(
        contract=contract,
        admission_facts=facts,
        compatibility_facts=compatibility_facts,
        release_provenance_contract=provenance_contract,
        release_provenance=provenance["promotion"],
        current_contract_lock=_read_json(
            root / runtime["contractLock"], "Alpha contract lock"
        ),
        current_contract_digest=runtime["contractDigest"],
        bindings={
            "repository": "kungfu-systems/kungfu",
            "channel": "alpha",
            "sourceSha": EXPECTED_SOURCE,
            "sourceTree": EXPECTED_TREE,
            "promotionSha": PROMOTION_COMMIT,
            "artifactRoot": report["candidateInputRoot"],
            "runtimeSha": historical_proof["evidence"]["runtimeSha"],
            "acceptedContractDigest": HISTORICAL_CONTRACT,
            "qualificationRoot": report["evidenceRoot"],
            "approvalRoot": report["stateRoot"],
            "authorityRoot": provenance["authorityRoot"],
        },
    )
    if not admission["ok"]:
        _fail(
            "temporal-admission-rejected",
            ", ".join(admission["receipt"]["reasonCodes"]),
        )
    for file_name, before in initial_stats.items():
        after = (artifact_root / "artifacts" / file_name).stat()
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ino,
        ):
            _fail("candidate-mutated-during-qualification", file_name)
    body = {
        "schema": "kungfu.temporal-provenance-cutover-qualification/v1",
        "status": "passed",
        "buildRunId": EXPECTED_RUN_ID,
        "sourceSha": EXPECTED_SOURCE,
        "sourceTree": EXPECTED_TREE,
        "version": EXPECTED_VERSION,
        "artifactCount": EXPECTED_ARTIFACT_COUNT,
        "artifactSetRoot": snapshot["root"],
        "manifestRoots": snapshot["manifests"],
        "candidateInventoryRoot": inventory["inventoryRoot"],
        "candidateRegularFileCount": inventory["fileCount"],
        "capsuleRoot": report["capsuleRoot"],
        "candidateProvenanceObjectRoot": provenance["candidate"]["objectRoot"],
        "promotionProvenanceObjectRoot": provenance["promotion"]["objectRoot"],
        "candidateAncestryObserved": False,
        "ancestrySemanticAuthority": False,
        "admissionFactSetRoot": admission["receipt"]["admissionFactSetRoot"],
        "admissionProofRoot": admission["receipt"]["admissionProofRoot"],
        "factProjectionRoot": admission["receipt"]["factProjectionRoot"],
        "admissionReceiptRoot": admission["receipt"]["receiptRoot"],
        "admissionPathReceiptRoot": admission["receipt"]["pathReceiptRoot"],
        "acceptedContractDigest": HISTORICAL_CONTRACT,
        "currentContractDigest": runtime["contractDigest"],
        "buildchainFactRoots": admission["receipt"]["buildchainFactRoots"],
        "compatibilityPathReceiptRoots": admission["receipt"][
            "compatibilityPathReceiptRoots"
        ],
        "inputUnchanged": True,
        "heavyRebuildPerformed": False,
        "externalPublicationClaimed": False,
    }
    return {**body, "qualificationRoot": _content_root(body)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--reconstruction-root", required=True, type=Path)
    if argv is None:
        argv = sys.argv[1:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    args = parser.parse_args(argv)
    try:
        root = Path(__file__).resolve().parents[1]
        artifact_root = args.artifact_root.expanduser().resolve(strict=True)
        reconstruction = args.reconstruction_root.expanduser().resolve(strict=True)
        if not artifact_root.is_dir() or not reconstruction.is_dir():
            _fail("invalid-coordinate", "inputs must be explicit existing directories")
        result = qualify(root, artifact_root, reconstruction)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (CutoverError, OSError, KeyError, TypeError) as error:
        print(
            json.dumps(
                {
                    "schema": "kungfu.temporal-provenance-cutover-error/v1",
                    "status": "rejected",
                    "code": getattr(error, "code", "invalid-input"),
                    "message": str(error),
                    "externalPublicationClaimed": False,
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
