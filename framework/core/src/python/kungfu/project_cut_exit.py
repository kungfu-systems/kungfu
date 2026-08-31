# SPDX-License-Identifier: Apache-2.0

"""Owned Project Cut history bundle verification and materialization boundary."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from kungfu.action_envelope import canonical_json_bytes


_PROJECT_CUT_BUNDLE_SCHEMA = "kungfu.project-cut.history-bundle/v1"
_PROJECT_CUT_IDENTITY_SCHEMA = "kungfu.project-cut.history-identity/v1"
_PROJECT_CUT_SCHEMA = "project.cut/v1"
_PROJECT_CUT_ROOT_INPUT_SCHEMA = "project.cut.root-input/v1"
_PROJECT_CUT_RECEIPT_SCHEMA = "project.cut.receipt/v1"
_PROJECT_CUT_PUBLICATION_SCHEMA = "kungfu.settlement-publication.manifest/v1"
_PROJECT_CUT_ROOT_ALGORITHM = "sha256-project-cut-canonical-json-v1"
_PROJECT_CUT_ROOT = re.compile(r"^sha256:[0-9a-f]{64}$")
_PROJECT_CUT_PRIVATE_ABSOLUTE = re.compile(r"^(?:/|file:///|[A-Za-z]:[\\/])")
_PROJECT_CUT_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
_PROJECT_CUT_MAX_SUCCESSORS = 256
_PROJECT_CUT_MAX_PUBLICATIONS = 256


class ProjectCutExitError(ValueError):
    """Stable Project Cut member diagnosis."""

    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(message)
        self.code = code
        self.details = details


class ProjectCutExitPort(Protocol):
    """Typed Project Cut portability boundary consumed by Exit Bundle."""

    def build_bundle(
        self, options: Mapping[str, Any], *, mode: str
    ) -> dict[str, Any]: ...

    def verify_bundle(self, bundle: Mapping[str, Any]) -> dict[str, Any]: ...

    def import_bundle(
        self,
        runtime_dir: str | Path,
        bundle: Mapping[str, Any],
        *,
        execute: bool,
    ) -> dict[str, Any]: ...


def _project_cut_sha256(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _project_cut_semantic_root(value: Any) -> str:
    return _project_cut_sha256(canonical_json_bytes(value))


def _project_cut_require_root(value: Any, field: str) -> str:
    text = str(value or "")
    if not _PROJECT_CUT_ROOT.fullmatch(text):
        raise ProjectCutExitError("project-cut-root-invalid", f"{field} is invalid")
    return text


def _project_cut_reject_duplicate(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, child in pairs:
        if key in value:
            raise ProjectCutExitError(
                "project-cut-json-duplicate-key", f"duplicate JSON key: {key}"
            )
        value[key] = child
    return value


def _project_cut_scan_value(value: Any, field: str = "$") -> None:
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise ProjectCutExitError(
                "project-cut-json-noncanonical", f"{field} is not NFC"
            )
        if _PROJECT_CUT_PRIVATE_ABSOLUTE.match(value) and not value.startswith(
            ("http://", "https://")
        ):
            raise ProjectCutExitError(
                "project-cut-private-path-leakage",
                f"{field} contains a private absolute path",
            )
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _project_cut_scan_value(child, f"{field}[{index}]")
        return
    if isinstance(value, Mapping):
        for key, child in value.items():
            _project_cut_scan_value(key, f"{field}.<key>")
            _project_cut_scan_value(child, f"{field}.{key}")


def _project_cut_read_json_bytes(path: str | Path) -> tuple[dict[str, Any], bytes]:
    source = Path(path).expanduser()
    payload = source.read_bytes()
    if len(payload) > _PROJECT_CUT_MAX_ARTIFACT_BYTES:
        raise ProjectCutExitError(
            "project-cut-artifact-too-large", "Project Cut artifact exceeds the bound"
        )
    try:
        text = payload.decode("utf-8")
        if text.startswith("\ufeff"):
            raise UnicodeError("UTF-8 BOM is not admitted")
        value = json.loads(text, object_pairs_hook=_project_cut_reject_duplicate)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ProjectCutExitError(
            "project-cut-json-invalid", f"cannot read {source.name}: {error}"
        ) from error
    if not isinstance(value, dict):
        raise ProjectCutExitError(
            "project-cut-json-invalid", "artifact must be an object"
        )
    _project_cut_scan_value(value)
    return value, payload


def _project_cut_member_root_input(cut: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema": _PROJECT_CUT_ROOT_INPUT_SCHEMA,
        "project": cut.get("project"),
        "parentCutRoots": cut.get("parentCutRoots"),
        "sourceProjection": cut.get("sourceProjection"),
        "atlas": cut.get("atlas"),
        "episodeDelta": cut.get("episodeDelta"),
        "interpretation": cut.get("interpretation"),
        "visibility": cut.get("visibility"),
        "omissions": cut.get("omissions"),
        "conflicts": cut.get("conflicts"),
        "unknowns": cut.get("unknowns"),
        "compatibility": cut.get("compatibility"),
    }


def _project_cut_verify_cut(cut: Mapping[str, Any], artifact: bytes) -> dict[str, str]:
    if cut.get("schema") != _PROJECT_CUT_SCHEMA:
        raise ProjectCutExitError(
            "project-cut-schema-unsupported", "expected project.cut/v1"
        )
    cut_root = _project_cut_require_root(cut.get("cutRoot"), "cutRoot")
    if _project_cut_semantic_root(_project_cut_member_root_input(cut)) != cut_root:
        raise ProjectCutExitError("project-cut-root-mismatch", "cutRoot differs")
    return {
        "cutRoot": cut_root,
        "serializationRoot": _project_cut_semantic_root(cut),
        "artifactDigest": _project_cut_sha256(artifact),
    }


def _project_cut_verify_receipt(
    receipt: Mapping[str, Any], cut_roots: Mapping[str, str]
) -> dict[str, str]:
    if receipt.get("schema") != _PROJECT_CUT_RECEIPT_SCHEMA:
        raise ProjectCutExitError(
            "project-cut-receipt-schema-unsupported", "expected project.cut.receipt/v1"
        )
    if receipt.get("rootAlgorithm") != _PROJECT_CUT_ROOT_ALGORITHM:
        raise ProjectCutExitError(
            "project-cut-root-algorithm-unsupported", "root algorithm differs"
        )
    if receipt.get("verdict") != "valid" or receipt.get("diagnostics") != []:
        raise ProjectCutExitError(
            "project-cut-receipt-unqualified", "Project Cut receipt is not valid"
        )
    for field in ("cutRoot", "serializationRoot", "artifactDigest"):
        if receipt.get(field) != cut_roots[field]:
            raise ProjectCutExitError(
                "project-cut-receipt-mismatch", f"receipt {field} differs"
            )
    receipt_root = _project_cut_require_root(receipt.get("receiptRoot"), "receiptRoot")
    preimage = dict(receipt)
    preimage.pop("receiptRoot", None)
    if _project_cut_semantic_root(preimage) != receipt_root:
        raise ProjectCutExitError(
            "project-cut-receipt-root-mismatch", "receiptRoot differs"
        )
    return {**cut_roots, "receiptRoot": receipt_root}


def _project_cut_artifact(path: str | Path) -> dict[str, Any]:
    manifest, manifest_bytes = _project_cut_read_json_bytes(path)
    receipt_path = Path(path).with_name("receipt.json")
    receipt, receipt_bytes = _project_cut_read_json_bytes(receipt_path)
    roots = _project_cut_verify_receipt(
        receipt, _project_cut_verify_cut(manifest, manifest_bytes)
    )
    return {
        "cutRoot": roots["cutRoot"],
        "roots": roots,
        "parentCutRoots": list(manifest.get("parentCutRoots") or []),
        "manifestBase64": base64.b64encode(manifest_bytes).decode("ascii"),
        "receiptBase64": base64.b64encode(receipt_bytes).decode("ascii"),
        "manifest": manifest,
        "receipt": receipt,
    }


def _project_cut_publication(path: str | Path, cut_roots: set[str]) -> dict[str, Any]:
    manifest, payload = _project_cut_read_json_bytes(path)
    if manifest.get("schema") != _PROJECT_CUT_PUBLICATION_SCHEMA:
        raise ProjectCutExitError(
            "project-cut-publication-schema-unsupported",
            "expected settlement publication manifest v1",
        )
    root = _project_cut_require_root(manifest.get("manifestRoot"), "manifestRoot")
    preimage = dict(manifest)
    preimage.pop("manifestRoot", None)
    if _project_cut_semantic_root(preimage) != root:
        raise ProjectCutExitError(
            "project-cut-publication-root-mismatch", "publication manifest root differs"
        )
    selected = {
        str(row.get("cutRoot") or "")
        for row in (manifest.get("selection") or {}).get("projectCuts") or []
        if isinstance(row, Mapping)
    }
    if not selected.intersection(cut_roots):
        raise ProjectCutExitError(
            "project-cut-publication-unbound",
            "publication manifest does not select a bundled Project Cut",
        )
    return {
        "manifestRoot": root,
        "batchRoot": _project_cut_require_root(manifest.get("batchRoot"), "batchRoot"),
        "manifestBase64": base64.b64encode(payload).decode("ascii"),
        "manifest": manifest,
    }


def _project_cut_identity(bundle: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema": _PROJECT_CUT_IDENTITY_SCHEMA,
        "primaryCutRoot": bundle.get("primaryCutRoot"),
        "roots": bundle.get("roots"),
        "predecessorCutRoots": bundle.get("predecessorCutRoots"),
        "successorCutRoots": bundle.get("successorCutRoots"),
        "settlement": bundle.get("settlement"),
        "omissions": bundle.get("omissions"),
        "conflicts": bundle.get("conflicts"),
        "unknowns": bundle.get("unknowns"),
    }


def build_bundle(options: Mapping[str, Any], *, mode: str) -> dict[str, Any]:
    """Build one full or inventory-only member from tracked Project Cut files."""

    if mode not in {"full", "thin"}:
        raise ProjectCutExitError(
            "project-cut-mode-invalid", "mode must be full or thin"
        )
    primary_path = str(options.get("manifestPath") or "")
    if not primary_path:
        raise ProjectCutExitError(
            "project-cut-option-required", "manifestPath is required"
        )
    successor_paths = list(options.get("successorManifestPaths") or [])
    publication_paths = list(options.get("publicationManifestPaths") or [])
    if (
        len(successor_paths) > _PROJECT_CUT_MAX_SUCCESSORS
        or len(publication_paths) > _PROJECT_CUT_MAX_PUBLICATIONS
    ):
        raise ProjectCutExitError(
            "project-cut-inventory-too-large", "Project Cut member exceeds its bound"
        )
    primary = _project_cut_artifact(primary_path)
    successors = [_project_cut_artifact(path) for path in successor_paths]
    for successor in successors:
        if primary["cutRoot"] not in successor["parentCutRoots"]:
            raise ProjectCutExitError(
                "project-cut-successor-mismatch",
                "successor does not name the primary Cut as a parent",
            )
    cuts = [primary, *successors]
    publications = [
        _project_cut_publication(path, {row["cutRoot"] for row in cuts})
        for path in publication_paths
    ]
    bundle: dict[str, Any] = {
        "schema": _PROJECT_CUT_BUNDLE_SCHEMA,
        "mode": mode,
        "primaryCutRoot": primary["cutRoot"],
        "roots": primary["roots"],
        "predecessorCutRoots": primary["parentCutRoots"],
        "successorCutRoots": sorted(row["cutRoot"] for row in successors),
        "settlement": {
            "state": "published" if publications else "settled-unpublished",
            "publicationManifestRoots": sorted(
                row["manifestRoot"] for row in publications
            ),
        },
        "omissions": list(primary["manifest"].get("omissions") or []),
        "conflicts": list(primary["manifest"].get("conflicts") or []),
        "unknowns": list(primary["manifest"].get("unknowns") or []),
        "cuts": cuts if mode == "full" else [],
        "publications": publications if mode == "full" else [],
        "capabilities": (
            ["inspect", "verify-inventory", "verify-content", "materialize"]
            if mode == "full"
            else ["inspect", "verify-inventory"]
        ),
    }
    bundle["bundleRoot"] = _project_cut_semantic_root(_project_cut_identity(bundle))
    return verify_bundle(bundle)


def _project_cut_decode(value: Any, field: str) -> bytes:
    try:
        payload = base64.b64decode(str(value or ""), validate=True)
    except ValueError as error:
        raise ProjectCutExitError(
            "project-cut-material-invalid", f"{field} is not base64"
        ) from error
    if len(payload) > _PROJECT_CUT_MAX_ARTIFACT_BYTES:
        raise ProjectCutExitError(
            "project-cut-artifact-too-large", f"{field} exceeds the bound"
        )
    return payload


def _project_cut_parse_material(value: Any, field: str) -> dict[str, Any]:
    payload = _project_cut_decode(value, field)
    try:
        parsed = json.loads(
            payload.decode("utf-8"), object_pairs_hook=_project_cut_reject_duplicate
        )
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ProjectCutExitError(
            "project-cut-material-invalid", f"{field} is not exact JSON"
        ) from error
    if not isinstance(parsed, dict):
        raise ProjectCutExitError(
            "project-cut-material-invalid", f"{field} must encode an object"
        )
    _project_cut_scan_value(parsed)
    return parsed


def _project_cut_verify_bundle_member(row: Mapping[str, Any]) -> dict[str, Any]:
    manifest_bytes = _project_cut_decode(row.get("manifestBase64"), "manifestBase64")
    receipt_bytes = _project_cut_decode(row.get("receiptBase64"), "receiptBase64")
    manifest = _project_cut_parse_material(row.get("manifestBase64"), "manifestBase64")
    receipt = _project_cut_parse_material(row.get("receiptBase64"), "receiptBase64")
    if row.get("manifest") != manifest or row.get("receipt") != receipt:
        raise ProjectCutExitError(
            "project-cut-material-mismatch", "decoded Project Cut objects differ"
        )
    verified_roots = _project_cut_verify_receipt(
        receipt, _project_cut_verify_cut(manifest, manifest_bytes)
    )
    if (
        row.get("roots") != verified_roots
        or row.get("cutRoot") != verified_roots["cutRoot"]
    ):
        raise ProjectCutExitError(
            "project-cut-member-root-mismatch", "Project Cut roots differ"
        )
    if row.get("parentCutRoots") != list(manifest.get("parentCutRoots") or []):
        raise ProjectCutExitError(
            "project-cut-relation-mismatch", "Project Cut parents differ"
        )
    if receipt_bytes != canonical_json_bytes(receipt) + b"\n":
        raise ProjectCutExitError(
            "project-cut-receipt-bytes-noncanonical",
            "Project Cut receipt bytes are not canonical",
        )
    return dict(row)


def _project_cut_verify_relationships(bundle, verified, primary_root, roots):
    if primary_root not in verified or verified[primary_root]["roots"] != roots:
        raise ProjectCutExitError(
            "project-cut-primary-missing", "primary Project Cut material is absent"
        )
    primary = verified[primary_root]
    if bundle.get("predecessorCutRoots") != primary["parentCutRoots"]:
        raise ProjectCutExitError(
            "project-cut-relation-mismatch", "predecessor inventory differs"
        )
    declared_successors = list(bundle.get("successorCutRoots") or [])
    if declared_successors != sorted(root for root in verified if root != primary_root):
        raise ProjectCutExitError(
            "project-cut-relation-mismatch", "successor inventory differs"
        )
    for successor_root in declared_successors:
        row = verified.get(successor_root)
        if row is None or primary_root not in row.get("parentCutRoots", []):
            raise ProjectCutExitError(
                "project-cut-successor-mismatch", "successor relation differs"
            )
    for field in ("omissions", "conflicts", "unknowns"):
        if bundle.get(field) != list(primary["manifest"].get(field) or []):
            raise ProjectCutExitError(
                "project-cut-loss-mismatch", f"{field} inventory differs"
            )


def _project_cut_verify_publications(publications, verified):
    publication_roots = []
    for row in publications:
        manifest = _project_cut_parse_material(
            row.get("manifestBase64"), "publicationBase64"
        )
        if row.get("manifest") != manifest:
            raise ProjectCutExitError(
                "project-cut-publication-mismatch", "publication bytes differ"
            )
        preimage = dict(manifest)
        manifest_root = preimage.pop("manifestRoot", None)
        batch_root = _project_cut_require_root(manifest.get("batchRoot"), "batchRoot")
        selected = {
            str(entry.get("cutRoot") or "")
            for entry in (manifest.get("selection") or {}).get("projectCuts") or []
            if isinstance(entry, Mapping)
        }
        if (
            manifest.get("schema") != _PROJECT_CUT_PUBLICATION_SCHEMA
            or manifest_root != row.get("manifestRoot")
            or _project_cut_semantic_root(preimage) != manifest_root
            or row.get("batchRoot") != batch_root
            or not isinstance(manifest.get("batchInput"), Mapping)
            or _project_cut_semantic_root(manifest["batchInput"]) != batch_root
            or not selected.intersection(verified)
            or manifest.get("authority") != "projection-of-kungfu-native-settlement"
            or manifest.get("generatedBy") != "kungfu-settlement-publication/v1"
            or (manifest.get("runtimeContinuation") or {}).get("publicationIsAuthority")
            is not False
        ):
            raise ProjectCutExitError(
                "project-cut-publication-root-mismatch",
                "publication manifest root differs",
            )
        publication_roots.append(manifest_root)
    return publication_roots


def verify_bundle(bundle: Mapping[str, Any]) -> dict[str, Any]:
    """Verify the member using Project Cut-owned root rules."""

    if bundle.get("schema") != _PROJECT_CUT_BUNDLE_SCHEMA:
        raise ProjectCutExitError(
            "project-cut-bundle-schema-unsupported",
            f"expected {_PROJECT_CUT_BUNDLE_SCHEMA}",
        )
    mode = bundle.get("mode")
    if mode not in {"full", "thin"}:
        raise ProjectCutExitError("project-cut-mode-invalid", "mode differs")
    if bundle.get("bundleRoot") != _project_cut_semantic_root(
        _project_cut_identity(bundle)
    ):
        raise ProjectCutExitError(
            "project-cut-bundle-root-mismatch", "history bundle root differs"
        )
    primary_root = _project_cut_require_root(
        bundle.get("primaryCutRoot"), "primaryCutRoot"
    )
    roots = bundle.get("roots") or {}
    if roots.get("cutRoot") != primary_root:
        raise ProjectCutExitError("project-cut-root-mismatch", "primary root differs")
    for field in ("cutRoot", "serializationRoot", "artifactDigest", "receiptRoot"):
        _project_cut_require_root(roots.get(field), f"roots.{field}")
    if mode == "thin":
        if bundle.get("cuts") or bundle.get("publications"):
            raise ProjectCutExitError(
                "project-cut-thin-overclaim", "thin bundle contains material"
            )
        if bundle.get("capabilities") != ["inspect", "verify-inventory"]:
            raise ProjectCutExitError(
                "project-cut-thin-overclaim", "thin capabilities differ"
            )
        return dict(bundle)

    cuts = list(bundle.get("cuts") or [])
    if not cuts or len(cuts) > _PROJECT_CUT_MAX_SUCCESSORS + 1:
        raise ProjectCutExitError(
            "project-cut-material-missing", "full bundle has no Project Cut material"
        )
    if bundle.get("capabilities") != [
        "inspect",
        "verify-inventory",
        "verify-content",
        "materialize",
    ]:
        raise ProjectCutExitError(
            "project-cut-capability-overclaim", "full capabilities differ"
        )
    verified: dict[str, dict[str, Any]] = {}
    for row in cuts:
        member = _project_cut_verify_bundle_member(row)
        if member["cutRoot"] in verified:
            raise ProjectCutExitError(
                "project-cut-duplicate-identity", "Project Cut identity is duplicated"
            )
        verified[member["cutRoot"]] = member
    _project_cut_verify_relationships(bundle, verified, primary_root, roots)
    publication_roots = _project_cut_verify_publications(
        bundle.get("publications") or [], verified
    )
    settlement = bundle.get("settlement") or {}
    expected_state = "published" if publication_roots else "settled-unpublished"
    if settlement != {
        "state": expected_state,
        "publicationManifestRoots": sorted(publication_roots),
    }:
        raise ProjectCutExitError(
            "project-cut-settlement-mismatch", "settlement inventory differs"
        )
    return dict(bundle)


def _project_cut_target_files(
    runtime_dir: str | Path, bundle: Mapping[str, Any]
) -> list[tuple[Path, bytes]]:
    data_home = Path(runtime_dir).expanduser().resolve().parent
    outputs: list[tuple[Path, bytes]] = []
    for row in bundle.get("cuts") or []:
        digest = str(row["cutRoot"])[7:]
        directory = data_home / "project-cuts" / "sha256" / digest[:2] / digest
        outputs.extend(
            [
                (
                    directory / "manifest.json",
                    _project_cut_decode(row["manifestBase64"], "manifest"),
                ),
                (
                    directory / "receipt.json",
                    _project_cut_decode(row["receiptBase64"], "receipt"),
                ),
            ]
        )
    for row in bundle.get("publications") or []:
        digest = str(row["batchRoot"])[7:]
        outputs.append(
            (
                data_home
                / "ledger-publications"
                / "sha256"
                / digest[:2]
                / digest
                / "manifest.json",
                _project_cut_decode(row["manifestBase64"], "publication"),
            )
        )
    return outputs


def import_bundle(
    runtime_dir: str | Path, bundle: Mapping[str, Any], *, execute: bool
) -> dict[str, Any]:
    """Preflight all exact bytes, then materialize only into Project Cut layout."""

    verified = verify_bundle(bundle)
    if verified["mode"] != "full":
        return {
            "ok": False,
            "status": "rejected",
            "writeOccurred": False,
            "code": "project-cut-thin-materialization-forbidden",
        }
    outputs = _project_cut_target_files(runtime_dir, verified)
    already = []
    pending = []
    for path, payload in outputs:
        if path.exists():
            if path.read_bytes() != payload:
                raise ProjectCutExitError(
                    "project-cut-destination-diverged",
                    "destination contains different bytes for the same identity",
                    target=path.name,
                )
            already.append(path)
        else:
            pending.append((path, payload))
    if not execute:
        return {
            "ok": True,
            "status": "validated",
            "writeOccurred": False,
            "bundleRoot": verified["bundleRoot"],
            "plannedWrites": len(pending),
        }
    for path, payload in pending:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
        with temporary.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    for path, payload in outputs:
        if path.read_bytes() != payload:
            raise ProjectCutExitError(
                "project-cut-postflight-mismatch", "materialized bytes differ"
            )
    return {
        "ok": True,
        "status": "already_present" if not pending else "imported",
        "writeOccurred": bool(pending),
        "bundleRoot": verified["bundleRoot"],
        "cutRoot": verified["primaryCutRoot"],
        "writtenArtifacts": len(pending),
        "alreadyPresentArtifacts": len(already),
    }
