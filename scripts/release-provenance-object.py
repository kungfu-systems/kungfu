#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Produce and verify immutable release provenance envelopes."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

from kungfu.release_provenance import (
    ReleaseProvenanceError,
    build_candidate,
    build_candidate_v2,
    build_promotion,
    migrate_candidate_v1,
    semantic_root,
    verify,
    verify_migration,
)
from kungfu.temporal_release_admission import (
    verify_admission,
    verify_contract_selection,
    verify_rollback,
)


def _json_file(path: str | None, default: Any) -> Any:
    return json.loads(Path(path).read_text()) if path else default


def _write(path: str, value: Any) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _git(repository: str, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", repository, *args],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReleaseProvenanceError(
            "source-content-read",
            result.stderr.decode("utf-8", errors="replace").strip()
            or f"git {' '.join(args)} failed",
        )
    return result.stdout


def _git_blob_digests(
    repository: str, object_ids: list[str]
) -> dict[str, tuple[int, str]]:
    unique_ids = list(dict.fromkeys(object_ids))
    if not unique_ids:
        return {}
    process = subprocess.Popen(
        ["git", "-C", repository, "cat-file", "--batch"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write("".join(f"{object_id}\n" for object_id in unique_ids).encode())
    process.stdin.close()
    digests: dict[str, tuple[int, str]] = {}
    for expected_id in unique_ids:
        header = process.stdout.readline().decode("ascii", errors="replace").strip()
        fields = header.split()
        if len(fields) != 3 or fields[0] != expected_id or fields[1] != "blob":
            process.kill()
            raise ReleaseProvenanceError(
                "source-content-read", f"unexpected git cat-file header: {header}"
            )
        size = int(fields[2])
        content = process.stdout.read(size)
        if len(content) != size or process.stdout.read(1) != b"\n":
            process.kill()
            raise ReleaseProvenanceError(
                "source-content-read", f"truncated git blob: {expected_id}"
            )
        digests[expected_id] = (size, hashlib.sha256(content).hexdigest())
    stderr = process.stderr.read() if process.stderr is not None else b""
    if process.wait() != 0:
        raise ReleaseProvenanceError(
            "source-content-read",
            stderr.decode("utf-8", errors="replace").strip()
            or "git cat-file --batch failed",
        )
    return digests


def _source_content(repository: str, revision: str) -> dict[str, Any]:
    """Hash one revision as a canonical logical file set, not as a Git tree."""

    source_entries: list[tuple[str, str, str, str]] = []
    listing = _git(repository, "ls-tree", "-rz", "--full-tree", revision)
    for raw in listing.split(b"\0"):
        if not raw:
            continue
        metadata, separator, path_bytes = raw.partition(b"\t")
        if not separator:
            raise ReleaseProvenanceError(
                "source-content-read", "git ls-tree entry has no path separator"
            )
        fields = metadata.decode("ascii").split()
        if len(fields) != 3:
            raise ReleaseProvenanceError(
                "source-content-read", "git ls-tree entry has invalid metadata"
            )
        mode, object_type, object_id = fields
        try:
            logical_path = path_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ReleaseProvenanceError(
                "source-content-path", "source path is not valid UTF-8"
            ) from error
        if unicodedata.normalize("NFC", logical_path) != logical_path:
            raise ReleaseProvenanceError(
                "source-content-path", "source path is not NFC-normalized"
            )
        if object_type == "blob":
            kind = {
                "100644": "file",
                "100755": "executable",
                "120000": "symlink",
            }.get(mode)
            if kind is None:
                raise ReleaseProvenanceError(
                    "source-content-mode", f"unsupported blob mode: {mode}"
                )
        elif object_type == "commit" and mode == "160000":
            kind = "submodule"
        else:
            raise ReleaseProvenanceError(
                "source-content-mode",
                f"unsupported source entry: mode={mode} type={object_type}",
            )
        source_entries.append((logical_path, kind, object_type, object_id))

    blob_digests = _git_blob_digests(
        repository,
        [
            object_id
            for _, _, object_type, object_id in source_entries
            if object_type == "blob"
        ],
    )
    entries: list[dict[str, Any]] = []
    for logical_path, kind, object_type, object_id in source_entries:
        if object_type == "blob":
            size, digest = blob_digests[object_id]
        else:
            content = object_id.encode("ascii")
            size, digest = len(content), hashlib.sha256(content).hexdigest()
        entries.append(
            {
                "bytes": size,
                "contentSha256": digest,
                "kind": kind,
                "path": logical_path,
            }
        )

    manifest = {
        "schema": "kungfu.release-source-content-file-set/v1",
        "entries": entries,
    }
    canonical = json.dumps(
        manifest,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    algorithm = "sha256-canonical-file-set-v1"
    digest = hashlib.sha256(canonical).hexdigest()
    content_record = {
        "schema": "kungfu.release-source-content/v1",
        "algorithm": algorithm,
        "digest": digest,
    }
    return {
        "schema": "kungfu.release-source-content-digest/v1",
        "algorithm": algorithm,
        "digest": digest,
        "contentRoot": semantic_root(content_record),
        "entryCount": len(entries),
        "manifestRoot": semantic_root(manifest),
    }


def _root_or_identity(root: str | None, identity: str | None, field: str) -> str:
    if root:
        return root
    if identity:
        return semantic_root(
            {
                "schema": "kungfu.release-provenance-external-identity/v1",
                "kind": field,
                "identity": identity,
            }
        )
    raise ReleaseProvenanceError(
        "missing-input", f"{field} root or identity is required"
    )


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--qualification-root")
    parser.add_argument("--qualification-id")
    parser.add_argument("--authority-root")
    parser.add_argument("--authority-id")
    parser.add_argument("--contract-root")
    parser.add_argument("--contract-file")
    parser.add_argument("--admission-root", action="append", default=[])
    parser.add_argument("--legacy-projection")
    parser.add_argument("--output", required=True)


def _contract_root(args: argparse.Namespace) -> str:
    if args.contract_root:
        return args.contract_root
    if args.contract_file:
        return semantic_root(_json_file(args.contract_file, {}))
    raise ReleaseProvenanceError(
        "missing-input", "contract root or contract file is required"
    )


def _roots(args: argparse.Namespace) -> tuple[str, str, str, list[str]]:
    qualification_root = _root_or_identity(
        args.qualification_root, args.qualification_id, "qualification"
    )
    authority_root = _root_or_identity(
        args.authority_root, args.authority_id, "authority"
    )
    contract_root = _contract_root(args)
    admission_roots = list(
        dict.fromkeys([*args.admission_root, qualification_root, contract_root])
    )
    return qualification_root, authority_root, contract_root, admission_roots


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    candidate = commands.add_parser("candidate")
    _common(candidate)
    candidate.add_argument("--candidate-id", required=True)
    candidate.add_argument("--candidate-commit", required=True)
    candidate.add_argument("--candidate-tree", required=True)
    candidate.add_argument("--dev-cut-commit", required=True)
    candidate.add_argument("--dev-cut-tree", required=True)
    candidate.add_argument("--dev-cut-root")
    candidate.add_argument("--dev-cut-id")
    candidate.add_argument("--previous-alpha-commit", required=True)
    candidate.add_argument("--previous-alpha-tree", required=True)
    candidate.add_argument("--previous-alpha-root")
    candidate.add_argument("--previous-alpha-id")
    candidate.add_argument("--observed-parent", action="append", default=[])
    candidate.add_argument(
        "--advisory-parentage",
        action="store_true",
        help="report parent-order drift without rejecting the semantic object",
    )

    candidate_v2 = commands.add_parser("candidate-v2")
    _common(candidate_v2)
    candidate_v2.add_argument("--candidate-id", required=True)
    candidate_v2.add_argument("--source-content-algorithm", required=True)
    candidate_v2.add_argument("--source-content-digest", required=True)
    candidate_v2.add_argument("--candidate-commit", required=True)
    candidate_v2.add_argument("--candidate-tree", required=True)
    candidate_v2.add_argument("--dev-cut-commit", required=True)
    candidate_v2.add_argument("--dev-cut-tree", required=True)
    candidate_v2.add_argument("--dev-cut-root")
    candidate_v2.add_argument("--dev-cut-id")
    candidate_v2.add_argument("--previous-alpha-commit", required=True)
    candidate_v2.add_argument("--previous-alpha-tree", required=True)
    candidate_v2.add_argument("--previous-alpha-root")
    candidate_v2.add_argument("--previous-alpha-id")
    candidate_v2.add_argument("--approval-root")
    candidate_v2.add_argument("--approval-id")
    candidate_v2.add_argument("--observed-parent", action="append", default=[])

    promotion = commands.add_parser("promotion")
    _common(promotion)
    promotion.add_argument("--candidate-envelope", required=True)
    promotion.add_argument("--promotion-id", required=True)
    promotion.add_argument("--promotion-commit", required=True)
    promotion.add_argument("--promotion-tree", required=True)
    promotion.add_argument(
        "--candidate-ancestry-observed", choices=("true", "false"), required=True
    )

    verification = commands.add_parser("verify")
    verification.add_argument("--input", required=True)
    verification.add_argument("--expected")
    migration = commands.add_parser("migrate-candidate")
    migration.add_argument("--input", required=True)
    migration.add_argument("--source-content-algorithm", required=True)
    migration.add_argument("--source-content-digest", required=True)
    migration.add_argument("--approval-root")
    migration.add_argument("--approval-id")
    migration.add_argument("--output", required=True)
    migration_verification = commands.add_parser("verify-migration")
    migration_verification.add_argument("--input", required=True)
    source_content = commands.add_parser("source-content")
    source_content.add_argument("--repository", default=".")
    source_content.add_argument("--revision", required=True)
    commands.add_parser("admission")
    commands.add_parser("fact-selection")
    rollback_admission = commands.add_parser("rollback-admission")
    rollback_admission.add_argument("--request", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "admission":
            request = json.load(sys.stdin)
            report = verify_admission(
                contract=request["contract"],
                admission_facts=request["admissionFacts"],
                compatibility_facts=request["compatibilityFacts"],
                release_provenance_contract=request["releaseProvenanceContract"],
                release_provenance=request["releaseProvenance"],
                current_contract_lock=request["currentContractLock"],
                current_contract_digest=request["currentContractDigest"],
                bindings=request["bindings"],
                mode=request.get("mode", "fact-only"),
            )
            print(json.dumps(report, sort_keys=True))
            return 0 if report["ok"] else 1
        if args.command == "fact-selection":
            request = json.load(sys.stdin)
            report = verify_contract_selection(
                contract=request["contract"],
                admission_facts=request["admissionFacts"],
                compatibility_facts=request["compatibilityFacts"],
                current_contract_lock=request["currentContractLock"],
                channel=request["channel"],
                accepted_contract_digest=request["acceptedContractDigest"],
                current_contract_digest=request["currentContractDigest"],
            )
            print(json.dumps(report, sort_keys=True))
            return 0 if report["ok"] else 1
        if args.command == "rollback-admission":
            request = _json_file(args.request, {})
            root = Path(__file__).resolve().parents[1]
            report = verify_rollback(
                rollback_contract=_json_file(
                    str(
                        root
                        / "framework/release/kungfu-temporal-release-rollback.contract.json"
                    ),
                    {},
                ),
                admission_contract=_json_file(
                    str(
                        root
                        / "framework/release/kungfu-temporal-release-admission.contract.json"
                    ),
                    {},
                ),
                admission_facts=_json_file(
                    str(
                        root
                        / "docs/qualification/evidence/kungfu-temporal-release-admission-facts.json"
                    ),
                    {},
                ),
                release_provenance_contract=_json_file(
                    str(
                        root
                        / "framework/release/kungfu-release-provenance.contract.json"
                    ),
                    {},
                ),
                release_provenance=request["releaseProvenance"],
                bindings=request["bindings"],
            )
            print(json.dumps(report, sort_keys=True))
            return 0 if report["ok"] else 1
        if args.command == "verify":
            report = verify(_json_file(args.input, {}), _json_file(args.expected, None))
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0 if report["ok"] else 1
        if args.command == "verify-migration":
            report = verify_migration(_json_file(args.input, {}))
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0 if report["ok"] else 1
        if args.command == "source-content":
            print(
                json.dumps(
                    _source_content(args.repository, args.revision),
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0
        if args.command == "migrate-candidate":
            bundle = migrate_candidate_v1(
                _json_file(args.input, {}),
                source_content_algorithm=args.source_content_algorithm,
                source_content_digest=args.source_content_digest,
                approval_root=_root_or_identity(
                    args.approval_root, args.approval_id, "approval"
                ),
            )
            report = verify_migration(bundle)
            if not report["ok"]:
                print(json.dumps(report, indent=2, sort_keys=True), file=sys.stderr)
                return 1
            _write(args.output, bundle)
            print(
                json.dumps(
                    {
                        "schema": "kungfu.release-provenance-migration-write-receipt/v1",
                        "ok": True,
                        "output": args.output,
                        "predecessorObjectRoot": report["predecessorObjectRoot"],
                        "successorObjectRoot": report["successorObjectRoot"],
                        "migrationReceiptRoot": bundle["receipt"]["root"],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0

        qualification_root, authority_root, contract_root, admission_roots = _roots(
            args
        )
        legacy_projection = _json_file(args.legacy_projection, {})
        if args.command in {"candidate", "candidate-v2"}:
            dev_cut_root = _root_or_identity(
                args.dev_cut_root,
                args.dev_cut_id,
                "dev-cut",
            )
            previous_alpha_root = _root_or_identity(
                args.previous_alpha_root,
                args.previous_alpha_id,
                "previous-alpha",
            )
            common = {
                "release_id": args.release_id,
                "candidate_id": args.candidate_id,
                "candidate_commit": args.candidate_commit,
                "candidate_tree": args.candidate_tree,
                "dev_cut_commit": args.dev_cut_commit,
                "dev_cut_tree": args.dev_cut_tree,
                "previous_alpha_commit": args.previous_alpha_commit,
                "previous_alpha_tree": args.previous_alpha_tree,
                "dev_cut_root": dev_cut_root,
                "previous_alpha_root": previous_alpha_root,
                "qualification_root": qualification_root,
                "authority_root": authority_root,
                "contract_root": contract_root,
                "admission_roots": admission_roots,
                "observed_parents": args.observed_parent,
            }
            if args.command == "candidate-v2":
                envelope = build_candidate_v2(
                    **common,
                    source_content_algorithm=args.source_content_algorithm,
                    source_content_digest=args.source_content_digest,
                    approval_root=_root_or_identity(
                        args.approval_root, args.approval_id, "approval"
                    ),
                )
            else:
                fail_closed_on = ["candidate-tree-mismatch"]
                if not args.advisory_parentage:
                    fail_closed_on.append("parent-order-mismatch")
                envelope = build_candidate(
                    **common,
                    legacy_projection=legacy_projection,
                    fail_closed_on=fail_closed_on,
                )
        else:
            envelope = build_promotion(
                candidate_envelope=_json_file(args.candidate_envelope, {}),
                promotion_id=args.promotion_id,
                promotion_commit=args.promotion_commit,
                promotion_tree=args.promotion_tree,
                qualification_root=qualification_root,
                authority_root=authority_root,
                contract_root=contract_root,
                admission_roots=admission_roots,
                candidate_ancestry_observed=(
                    args.candidate_ancestry_observed == "true"
                ),
                legacy_projection=legacy_projection,
            )
        report = verify(envelope)
        if not report["ok"]:
            print(json.dumps(report, indent=2, sort_keys=True), file=sys.stderr)
            return 1
        _write(args.output, envelope)
        print(
            json.dumps(
                {
                    "schema": "kungfu.release-provenance-write-receipt/v1",
                    "ok": True,
                    "output": args.output,
                    "objectRoot": envelope["objectRoot"],
                    "gitProjectionRoot": envelope["gitProjectionRoot"],
                    "legacyProjectionRoot": envelope.get("legacyProjectionRoot"),
                    "projectionStatus": envelope["gitProjection"].get("status"),
                    "projectionDrift": envelope["gitProjection"].get("drift", []),
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    except (ReleaseProvenanceError, OSError, json.JSONDecodeError) as error:
        code = getattr(error, "code", "invalid-input")
        print(
            json.dumps(
                {
                    "schema": "kungfu.release-provenance-error/v1",
                    "ok": False,
                    "code": code,
                    "message": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
