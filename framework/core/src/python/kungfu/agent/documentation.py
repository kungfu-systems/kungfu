# SPDX-License-Identifier: Apache-2.0

"""Read-only consumer for a precompiled Xinfa Documentation Atlas.

This module deliberately contains no selector or compiler.  It verifies the
content-addressed Xinfa artifacts, then exposes exact catalog, document and
precompiled Human/Agent projection reads for installed Kungfu surfaces.
"""

import gzip
import hashlib
import json
import os
import subprocess
from pathlib import Path, PurePosixPath

_COMPATIBILITY = Path("compatibility/context-pack-v1")


def discovery_context(repo_root=None):
    local_docs = []
    if repo_root is not None:
        local_docs = [
            {"name": "documentation map", "path": str(repo_root / "docs" / "MAP.md")},
            {
                "name": "agent-first global config",
                "path": str(repo_root / "docs" / "config.md"),
            },
        ]
    return {
        "local": local_docs,
        "public": [
            {
                "name": "documentation map",
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/MAP.md",
            },
            {
                "name": "agent-first global config",
                "url": "https://github.com/kungfu-tech/kungfu/blob/dev/v3/docs/guides/config.md",
            },
        ],
    }


def _canonical_bytes(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def _digest(value):
    return "sha256:" + hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _byte_digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _artifact_bytes(root, relative):
    direct = root / relative
    if direct.is_file():
        return direct.read_bytes()
    bundle = os.environ.get("KUNGFU_DOCUMENTATION_ATLAS_BUNDLE")
    if bundle:
        compressed = Path(bundle) / f"{relative}.gz"
        if compressed.is_file():
            return gzip.decompress(compressed.read_bytes())
    raise FileNotFoundError(f"Documentation Atlas artifact is absent: {relative}")


def _json(root, relative):
    return json.loads(_artifact_bytes(root, relative).decode("utf-8"))


def _portable_artifact(root, name):
    direct = root / name
    if direct.is_file():
        return direct.read_bytes()
    override = os.environ.get("KUNGFU_PORTABLE_ATLAS_BUNDLE")
    if override:
        candidate = Path(override)
        if name == "bundle.json" and candidate.is_file():
            return candidate.read_bytes()
        sibling = candidate.parent / "portable-atlas-classification.json.gz"
        if name == "classification.json.gz" and sibling.is_file():
            return sibling.read_bytes()
    source_root = Path(__file__).resolve().parents[6]
    source = (
        source_root
        / ".xinfa"
        / (
            "product-atlas-bundle.json"
            if name == "bundle.json"
            else "portable-atlas-classification.json.gz"
        )
    )
    if source.is_file():
        return source.read_bytes()
    raise FileNotFoundError(f"Portable Atlas Bundle artifact is absent: {name}")


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
        try:
            _artifact_bytes(root, relative)
        except (FileNotFoundError, OSError):
            diagnostics.append({"code": "missing-artifact", "path": relative})
    try:
        bundle_bytes = _portable_artifact(root, "bundle.json")
        classification_compressed = _portable_artifact(root, "classification.json.gz")
    except (FileNotFoundError, OSError) as error:
        diagnostics.append({"code": "missing-portable-bundle", "path": str(error)})
    if diagnostics:
        return {
            "schema": "kungfu.documentation-pack-verification/v1",
            "valid": False,
            "diagnostics": diagnostics,
        }

    atlas = _json(root, "atlas.json")
    manifest = _json(root, "manifest.json")
    receipt = _json(root, "receipt.json")
    pack = _json(root, str(_COMPATIBILITY / "pack.json"))
    pack_manifest = _json(root, str(_COMPATIBILITY / "manifest.json"))
    pack_receipt = _json(root, str(_COMPATIBILITY / "receipt.json"))
    bundle = json.loads(bundle_bytes.decode("utf-8"))
    classification_bytes = gzip.decompress(classification_compressed)
    classification = json.loads(classification_bytes.decode("utf-8"))

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
        data = _artifact_bytes(root, relative)
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

    pack_bytes = _artifact_bytes(root, str(_COMPATIBILITY / "pack.json"))
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
        view = _json(root, f"views/{audience}.json")
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

    bundle_core = dict(bundle)
    bundle_root = bundle_core.pop("bundleRoot", None)
    classification_meta = bundle.get("classification", {})
    material = classification_meta.get("material", {})
    if (
        _digest(bundle_core) != bundle_root
        or bundle.get("roots", {}).get("atlas") != atlas_root
        or bundle.get("roots", {}).get("contextPack") != declared_pack_root
        or bundle.get("routes", {}).get("incompleteRoutes") != 0
        or bundle.get("budgets", {}).get("passed") is not True
    ):
        diagnostics.append({"code": "portable-bundle-root", "path": "bundle.json"})
    if (
        _byte_digest(classification_bytes)
        != classification_meta.get("classificationRoot")
        or len(classification_compressed) != material.get("compressedBytes")
        or len(classification_bytes) != material.get("uncompressedBytes")
        or classification.get("unknown") != 0
        or classification.get("silentOmissions") != 0
        or classification.get("total") != classification_meta.get("total")
    ):
        diagnostics.append(
            {"code": "portable-classification-root", "path": "classification.json.gz"}
        )

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
        "bundleRoot": bundle_root,
        "classificationRoot": classification_meta.get("classificationRoot"),
        "releasePassportRoot": bundle.get("releasePassportBinding", {}).get(
            "releasePassportRoot"
        ),
        "releaseQualified": bundle.get("budgets", {}).get("releaseQualified") is True,
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
    return root, _json(root, str(_COMPATIBILITY / "pack.json")), result


def catalog(root=None):
    _, pack, result = _verified_pack(root)
    return {
        "schema": "kungfu.documentation-catalog/v1",
        "roots": {
            key: result[key]
            for key in ("atlasRoot", "packRoot", "cutRoot", "bundleRoot")
        },
        "entries": [
            {
                **{
                    key: item[key]
                    for key in ("path", "contentRoot", "size", "visibility")
                },
                "class": "embedded",
            }
            for item in pack.get("inventory", [])
        ],
    }


def bundle(root=None):
    root, _, result = _verified_pack(root)
    value = json.loads(_portable_artifact(root, "bundle.json").decode("utf-8"))
    return {
        "schema": "kungfu.portable-atlas-bundle-view/v1",
        "valid": True,
        "bundleRoot": result["bundleRoot"],
        "atlasRoot": result["atlasRoot"],
        "contextPackRoot": result["packRoot"],
        "classification": value["classification"],
        "routes": value["routes"],
        "expansion": value["expansion"],
        "budgets": value["budgets"],
        "sourceCut": value["sourceCut"],
        "releasePassportBinding": value["releasePassportBinding"],
        "assembly": value["assembly"],
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
    value = _json(root, f"views/{audience}.json")
    return {
        "schema": "kungfu.documentation-projection/v1",
        "roots": {key: result[key] for key in ("atlasRoot", "packRoot", "cutRoot")},
        "audience": audience,
        "projection": value,
    }


def _xinfa(arguments):
    # Keep offline Atlas verification stdlib-only.  The CLI stack (and click)
    # is needed only when a caller asks the linked Xinfa runtime to project or
    # expand task context.
    from kungfu.cli.commands.env import _resolve_trunk

    trunk = _resolve_trunk()
    if not trunk:
        raise FileNotFoundError(
            "linked Xinfa product was not found; set KUNGFU_TRUNK_BIN for source qualification"
        )
    result = subprocess.run(
        [trunk, "xinfa", *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic"
        raise ValueError(f"Xinfa context operation failed: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Xinfa returned invalid JSON") from error


def task_context(task, role, budget, route, root=None):
    root, _, verification = _verified_pack(root)
    payload = _xinfa(
        [
            "context",
            "--atlas",
            str(root),
            "--route",
            route,
            "--task",
            task,
            "--role",
            role,
            "--budget",
            str(budget),
            "--json",
        ]
    )
    projection_value = payload.get("projection", payload)
    omissions = projection_value.get("omissions", [])
    required_omissions = [row for row in omissions if row.get("required") is True]
    status = projection_value.get("status", payload.get("status"))
    roots = projection_value.get("roots", payload.get("roots", {}))
    atlas_root = (
        roots.get("atlas")
        or roots.get("atlasRoot")
        or projection_value.get("atlas_root")
        or projection_value.get("atlasRoot")
    )
    if atlas_root and atlas_root != verification["atlasRoot"]:
        raise ValueError("Xinfa context Atlas root does not match the installed pack")
    if status not in {None, "complete", "pass"} or required_omissions:
        raise ValueError(
            "Xinfa context is incomplete: "
            + json.dumps(
                {"status": status, "requiredOmissions": required_omissions},
                sort_keys=True,
            )
        )
    return {
        "schema": "kungfu.agent-task-context/v1",
        "route": route,
        "task": task,
        "role": role,
        "budget": budget,
        "roots": {
            key: verification[key]
            for key in (
                "atlasRoot",
                "packRoot",
                "cutRoot",
                "manifestRoot",
                "receiptRoot",
            )
        },
        "context": projection_value,
        "omissions": omissions,
        "expansionHandles": projection_value.get(
            "expansion_handles", projection_value.get("expansionHandles", [])
        ),
        "internalPathsExposed": False,
    }


def expand(view, handle, budget, root=None):
    root, _, verification = _verified_pack(root)
    if view not in {"agent", "human"}:
        raise ValueError("view must be agent or human")
    payload = _xinfa(
        [
            "expand",
            "--atlas",
            str(root),
            "--view",
            str(root / "views" / f"{view}.json"),
            "--handle",
            handle,
            "--budget",
            str(budget),
            "--json",
        ]
    )
    return {
        "schema": "kungfu.agent-context-expansion/v1",
        "view": view,
        "handle": handle,
        "budget": budget,
        "roots": {
            key: verification[key] for key in ("atlasRoot", "packRoot", "cutRoot")
        },
        "expansion": payload,
        "internalPathsExposed": False,
    }
