# SPDX-License-Identifier: Apache-2.0

"""Read-only consumer for a precompiled Xinfa Documentation Atlas.

This module deliberately contains no selector or compiler.  It verifies the
content-addressed Xinfa artifacts, then exposes exact catalog, document and
precompiled Human/Agent projection reads for installed Kungfu surfaces.
"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath


_COMPATIBILITY = Path("compatibility/context-pack-v1")


def _canonical_bytes(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def _digest(value):
    return "sha256:" + hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _byte_digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _json(path):
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def _portable_path(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("documentation path must be a non-empty POSIX path")
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or ".." in candidate.parts or str(candidate) != value:
        raise ValueError("documentation path must remain inside the pack")
    return value


def default_pack_root():
    override = os.environ.get("KUNGFU_DOCUMENTATION_ATLAS")
    if override:
        return Path(override)
    packaged = Path(__file__).resolve().parent / "documentation"
    if packaged.is_dir():
        return packaged
    raise FileNotFoundError(
        "no packaged Documentation Atlas; set KUNGFU_DOCUMENTATION_ATLAS"
    )


def verify(root=None):
    root = Path(root) if root is not None else default_pack_root()
    required = [
        "atlas.json",
        "manifest.json",
        "receipt.json",
        "views/human.json",
        "views/agent.json",
        "compatibility/context-pack-v1/pack.json",
        "compatibility/context-pack-v1/manifest.json",
        "compatibility/context-pack-v1/receipt.json",
    ]
    diagnostics = []
    for relative in required:
        if not (root / relative).is_file():
            diagnostics.append({"code": "missing-artifact", "path": relative})
    if diagnostics:
        return {
            "schema": "kungfu.documentation-pack-verification/v1",
            "valid": False,
            "diagnostics": diagnostics,
        }

    atlas = _json(root / "atlas.json")
    manifest = _json(root / "manifest.json")
    receipt = _json(root / "receipt.json")
    pack_root = root / _COMPATIBILITY
    pack = _json(pack_root / "pack.json")
    pack_manifest = _json(pack_root / "manifest.json")
    pack_receipt = _json(pack_root / "receipt.json")

    atlas_core = dict(atlas)
    atlas_root = atlas_core.pop("atlas_root", None)
    if _digest(atlas_core) != atlas_root:
        diagnostics.append({"code": "atlas-root", "path": "atlas.json"})

    pack_core = json.loads(json.dumps(pack))
    declared_pack_root = pack_core.get("roots", {}).pop("pack", None)
    if _digest(pack_core) != declared_pack_root:
        diagnostics.append(
            {"code": "pack-root", "path": str(_COMPATIBILITY / "pack.json")}
        )

    for artifact in manifest.get("artifacts", []):
        relative = _portable_path(artifact.get("path"))
        data = (root / relative).read_bytes()
        if len(data) != artifact.get("size") or _byte_digest(data) != artifact.get(
            "content_root"
        ):
            diagnostics.append({"code": "artifact-root", "path": relative})

    manifest_core = dict(manifest)
    manifest_root = manifest_core.pop("manifest_root", None)
    if _digest(manifest_core) != manifest_root:
        diagnostics.append({"code": "manifest-root", "path": "manifest.json"})
    receipt_core = dict(receipt)
    receipt_root = receipt_core.pop("receipt_root", None)
    if _digest(receipt_core) != receipt_root:
        diagnostics.append({"code": "receipt-root", "path": "receipt.json"})

    pack_bytes = (pack_root / "pack.json").read_bytes()
    pack_manifest_core = dict(pack_manifest)
    pack_manifest_root = pack_manifest_core.pop("manifestRoot", None)
    artifact = (pack_manifest.get("artifacts") or [{}])[0]
    if (
        artifact.get("contentRoot") != _byte_digest(pack_bytes)
        or artifact.get("size") != len(pack_bytes)
        or _digest(pack_manifest_core) != pack_manifest_root
    ):
        diagnostics.append(
            {
                "code": "context-pack-manifest",
                "path": str(_COMPATIBILITY / "manifest.json"),
            }
        )
    pack_receipt_core = dict(pack_receipt)
    pack_receipt_root = pack_receipt_core.pop("receiptRoot", None)
    if (
        pack_receipt.get("verdict") != "pass"
        or pack_receipt.get("packRoot") != declared_pack_root
        or pack_receipt.get("manifestRoot") != pack_manifest_root
        or _digest(pack_receipt_core) != pack_receipt_root
    ):
        diagnostics.append(
            {
                "code": "context-pack-receipt",
                "path": str(_COMPATIBILITY / "receipt.json"),
            }
        )

    for audience in ("human", "agent"):
        view = _json(root / "views" / f"{audience}.json")
        if view.get("atlas_root") != atlas_root or view.get("audience") != audience:
            diagnostics.append(
                {"code": "projection-root", "path": f"views/{audience}.json"}
            )

    if (
        atlas.get("visibility") != "public"
        or atlas.get("roots", {}).get("context_pack") != declared_pack_root
        or manifest.get("atlas_root") != atlas_root
        or manifest.get("context_pack_root") != declared_pack_root
        or receipt.get("atlas_root") != atlas_root
        or receipt.get("context_pack_root") != declared_pack_root
        or receipt.get("manifest_root") != manifest_root
        or receipt.get("verdict") != "pass"
    ):
        diagnostics.append({"code": "authority-binding", "path": "."})

    return {
        "schema": "kungfu.documentation-pack-verification/v1",
        "valid": not diagnostics,
        "readOnly": True,
        "compiler": "xinfa",
        "atlasRoot": atlas_root,
        "packRoot": declared_pack_root,
        "cutRoot": atlas.get("roots", {}).get("cut"),
        "manifestRoot": manifest_root,
        "receiptRoot": receipt_root,
        "diagnostics": diagnostics,
    }


def _verified_pack(root=None):
    root = Path(root) if root is not None else default_pack_root()
    result = verify(root)
    if not result["valid"]:
        raise ValueError(
            "Documentation Atlas verification failed: "
            + json.dumps(result["diagnostics"], sort_keys=True)
        )
    return root, _json(root / _COMPATIBILITY / "pack.json"), result


def catalog(root=None):
    _, pack, result = _verified_pack(root)
    return {
        "schema": "kungfu.documentation-catalog/v1",
        "roots": {key: result[key] for key in ("atlasRoot", "packRoot", "cutRoot")},
        "entries": [
            {key: item[key] for key in ("path", "contentRoot", "size", "visibility")}
            for item in pack.get("inventory", [])
        ],
    }


def read(relative, root=None):
    relative = _portable_path(relative)
    _, pack, result = _verified_pack(root)
    for item in pack.get("inventory", []):
        if item.get("path") == relative:
            return {
                "schema": "kungfu.documentation-read/v1",
                "roots": {
                    key: result[key] for key in ("atlasRoot", "packRoot", "cutRoot")
                },
                "path": relative,
                "contentRoot": item["contentRoot"],
                "content": item["content"],
            }
    raise KeyError(f"documentation surface not present in pack: {relative}")


def projection(audience, root=None):
    if audience not in {"human", "agent"}:
        raise ValueError("audience must be human or agent")
    root, _, result = _verified_pack(root)
    value = _json(root / "views" / f"{audience}.json")
    return {
        "schema": "kungfu.documentation-projection/v1",
        "roots": {key: result[key] for key in ("atlasRoot", "packRoot", "cutRoot")},
        "audience": audience,
        "projection": value,
    }
