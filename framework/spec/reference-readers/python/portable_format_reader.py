# SPDX-License-Identifier: Apache-2.0
"""Stdlib-only independent reader for the packed @kungfu-tech/spec corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Any

CURRENT_JOURNAL_EPOCH = 0xE3B24C8D
PAGE_HEADER_SIZE = 32
FRAME_HEADER_SIZE = 72
PAGE_SIZE = 2 * 1024 * 1024


def sha256(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def reject(code: str) -> dict[str, Any]:
    return {
        "outcome": "reject",
        "classification": "malformed",
        "reason": "FORMAT_TUPLE_MALFORMED",
        "failureCode": code,
        "writeOccurred": False,
    }


def classify_journal(data: bytes) -> dict[str, Any]:
    if len(data) < PAGE_HEADER_SIZE:
        return reject("E_READER_MALFORMED_FRAMING")
    epoch, header_size = struct.unpack_from("<II", data, 0)
    page_size = struct.unpack_from("<Q", data, 8)[0]
    frame_header_size = struct.unpack_from("<I", data, 16)[0]
    last_frame_offset = struct.unpack_from("<Q", data, 24)[0]
    if epoch != CURRENT_JOURNAL_EPOCH:
        return {
            "outcome": "migration-required",
            "classification": "unsupported-edge",
            "reason": "FORMAT_UNSUPPORTED_EDGE",
            "failureCode": "E_MIGRATION_UNSUPPORTED_EDGE",
            "writeOccurred": False,
        }
    if (
        header_size != PAGE_HEADER_SIZE
        or page_size != PAGE_SIZE
        or frame_header_size != FRAME_HEADER_SIZE
        or last_frame_offset > len(data)
        or len(data) < PAGE_HEADER_SIZE + FRAME_HEADER_SIZE
    ):
        return reject("E_READER_MALFORMED_FRAMING")
    carrier_type = struct.unpack_from("<i", data, PAGE_HEADER_SIZE + 24)[0]
    if carrier_type <= 0:
        return {
            "outcome": "read-degraded",
            "classification": "optional-unknown",
            "reason": "FORMAT_OPTIONAL_UNKNOWN",
            "failureCode": "E_READER_UNKNOWN_CARRIER",
            "writeOccurred": False,
        }
    return {
        "outcome": "read",
        "classification": "exact",
        "reason": "FORMAT_EXACT",
        "failureCode": "",
        "writeOccurred": False,
    }


def parse_legacy_atoms(data: bytes) -> None:
    if len(data) < 8:
        raise ValueError("legacy atom count is missing")
    count = int.from_bytes(data[:8], "big")
    offset = 8
    for _ in range(count):
        if offset + 8 > len(data):
            raise ValueError("legacy atom length is missing")
        length = int.from_bytes(data[offset : offset + 8], "big")
        offset += 8
        if offset + length > len(data):
            raise ValueError("legacy atom body is truncated")
        offset += length
    if offset != len(data):
        raise ValueError("legacy atom tail is unframed")


def negotiate_tuple(
    source: dict[str, Any],
    current: dict[str, Any],
    required_axes: list[str],
    migration: dict[str, Any],
) -> dict[str, Any]:
    missing = [axis for axis in required_axes if axis not in source]
    unknown = [f"unknown:{axis}" for axis in source if axis not in required_axes]
    if missing or unknown:
        return reject("E_MIGRATION_TUPLE_MALFORMED")
    ordinary_axes = [
        "journalEpoch",
        "workspaceLayout",
        "recordSchemas",
        "payloadSchemas",
        "rootProtocols",
        "bundleManifest",
    ]
    differences = [axis for axis in ordinary_axes if source[axis] != current[axis]]
    source_capabilities = set(map(str, source.get("capabilities", [])))
    target_capabilities = set(map(str, current.get("capabilities", [])))
    if target_capabilities - source_capabilities:
        differences.append("capabilities")
    optional_unknown = source_capabilities - target_capabilities
    if not differences and optional_unknown:
        return {
            "outcome": "read-degraded",
            "classification": "optional-unknown",
            "reason": "FORMAT_OPTIONAL_UNKNOWN",
            "failureCode": "",
            "writeOccurred": False,
        }
    if not differences:
        return {
            "outcome": "read",
            "classification": "exact",
            "reason": "FORMAT_EXACT",
            "failureCode": "",
            "writeOccurred": False,
        }
    source_root = source.get("rootProtocols", {}).get("factRoot")
    target_root = current.get("rootProtocols", {}).get("factRoot")
    for edge in migration.get("graph", {}).get("edges", []):
        if (
            edge.get("from") == source_root
            and edge.get("to") == target_root
            and differences == ["rootProtocols"]
        ):
            return {
                "outcome": "migration-required",
                "classification": "supported-edge",
                "reason": "FORMAT_SUPPORTED_MIGRATION",
                "failureCode": "",
                "writeOccurred": False,
            }
    return {
        "outcome": "migration-required",
        "classification": "unsupported-edge",
        "reason": "FORMAT_UNSUPPORTED_EDGE",
        "failureCode": "E_MIGRATION_UNSUPPORTED_EDGE",
        "writeOccurred": False,
    }


def classify(
    vector: dict[str, Any],
    data: bytes,
    compatibility: dict[str, Any],
    migration: dict[str, Any],
) -> dict[str, Any]:
    if vector["layer"] == "compatibility-tuple":
        try:
            payload = json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return reject("E_READER_MALFORMED_FRAMING")
        if payload.get(
            "schema"
        ) != "kungfu.format.compatibility-tuple-vector/v1" or not isinstance(
            payload.get("tuple"), dict
        ):
            return reject("E_MIGRATION_TUPLE_MALFORMED")
        return negotiate_tuple(
            payload["tuple"],
            compatibility["current_tuple"],
            compatibility["tuple_contract"]["requiredAxes"],
            migration,
        )
    if vector["layer"] == "journal-page":
        return classify_journal(data)
    protocol = vector["protocol"]
    if protocol == "sha256-length-framed-fields-v1":
        try:
            parse_legacy_atoms(data)
        except ValueError:
            return reject("E_READER_MALFORMED_FRAMING")
        return {
            "outcome": "migration-required",
            "classification": "supported-edge",
            "reason": "FORMAT_SUPPORTED_MIGRATION",
            "failureCode": "",
            "writeOccurred": False,
        }
    if protocol == "kungfu.fact-root.canonical/v3":
        return {
            "outcome": "migration-required",
            "classification": "unsupported-edge",
            "reason": "FORMAT_UNSUPPORTED_EDGE",
            "failureCode": "E_MIGRATION_UNSUPPORTED_EDGE",
            "writeOccurred": False,
        }
    if vector.get("repair"):
        return {
            "outcome": "preserve-only",
            "classification": "damage-evidence",
            "reason": "REPAIR_SOURCE_RETAINED",
            "failureCode": "E_READER_REQUIRED_MATERIAL_MISSING",
            "writeOccurred": False,
        }
    if protocol == "kungfu.fact-root.canonical/v2" and data.startswith(b"KFR2"):
        return {
            "outcome": "read",
            "classification": "exact",
            "reason": "FORMAT_EXACT",
            "failureCode": "",
            "writeOccurred": False,
        }
    return reject("E_READER_MALFORMED_FRAMING")


def inside(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"path escapes package corpus: {relative}")
    return candidate


def run(package_root: Path) -> dict[str, Any]:
    package_root = package_root.resolve()
    dist = package_root / "dist"
    manifest = read_json(dist / "manifest.json")
    if manifest.get("package", {}).get("name") != "@kungfu-tech/spec":
        raise ValueError("unexpected package identity")
    for artifact_id, descriptor in manifest.get("artifacts", {}).items():
        artifact = inside(dist, descriptor["path"])
        data = artifact.read_bytes()
        if sha256(data) != descriptor["artifact_root"]:
            raise ValueError(f"artifact root mismatch: {artifact_id}")
        if len(data) != descriptor["byte_length"]:
            raise ValueError(f"artifact length mismatch: {artifact_id}")
    compatibility = read_json(dist / "compatibility.json")
    migration = read_json(dist / "migration.json")
    vectors = read_json(dist / "vectors" / "index.json")
    vector_root = (dist / "vectors").resolve()
    results = []
    for vector in vectors["vectors"]:
        vector_path = inside(
            vector_root,
            f"{vectors['latest_release']}/{vector['path']}",
        )
        data = vector_path.read_bytes()
        if sha256(data) != vector["byteRoot"]:
            raise ValueError(f"vector root mismatch: {vector['id']}")
        if len(data) != vector["byteLength"]:
            raise ValueError(f"vector length mismatch: {vector['id']}")
        actual = classify(vector, data, compatibility, migration)
        if actual != vector["expected"]:
            raise ValueError(
                f"vector outcome mismatch: {vector['id']}: "
                f"{json.dumps(actual, sort_keys=True)}"
            )
        results.append({"id": vector["id"], **actual})
    return {
        "schema": "kungfu.spec.independent-python-reader-report/v1",
        "package": manifest["package"],
        "normativeRoot": manifest["normative"]["root"],
        "latestVectorRelease": vectors["latest_release"],
        "latestVectorReleaseRoot": vectors["latest_release_root"],
        "vectorCount": len(results),
        "outcomes": sorted({result["outcome"] for result in results}),
        "runtimeDependencies": [],
        "vectors": results,
    }


def main() -> int:
    default_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-root", type=Path, default=default_root)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        report = run(args.package_root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"[independent-python-reader] FAIL - {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    else:
        print(
            "[independent-python-reader] OK - "
            f"{report['vectorCount']} vectors, "
            f"release={report['latestVectorReleaseRoot']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
