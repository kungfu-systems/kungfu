# SPDX-License-Identifier: Apache-2.0

"""Owned Product Release History portability and recovery service."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import shutil
import stat
import time
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from kungfu import distribution_update, runtime_upgrade
from kungfu.coordination import locks as coordination_locks


class ProductReleaseHistoryPort(Protocol):
    """Typed boundary consumed by Exit Bundle composition."""

    def build(
        self, config_home: str | Path, *, mode: str = "full"
    ) -> dict[str, Any]: ...

    def verify(
        self, bundle: Mapping[str, Any], *, require_full: bool = False
    ) -> dict[str, Any]: ...

    def import_history(
        self,
        config_home: str | Path,
        bundle: Mapping[str, Any],
        *,
        execute: bool = False,
    ) -> dict[str, Any]: ...


_PRODUCT_HISTORY_BUNDLE_SCHEMA = "kungfu.product-release-cut.history-bundle/v1"
_PRODUCT_HISTORY_PROTOCOL = "product-release-cut-history-portability/v1"
_PRODUCT_HISTORY_IMPORT_RECEIPT_SCHEMA = (
    "kungfu.product-release-cut.history-import-receipt/v1"
)
_PRODUCT_HISTORY_FORMAT_VERSION = 1
_PRODUCT_HISTORY_SUPPORTED_FEATURES = {
    "copy-forward-installed-images-v1",
    "selection-receipt-journal-v1",
    "trust-domain-separation-v1",
}


class ProductReleaseHistoryError(ValueError):
    """Stable fail-closed diagnosis for the Product Release Cut adapter."""

    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(message)
        self.code = code
        self.details = details


def _product_history_canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def _product_history_root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(_product_history_canonical(value)).hexdigest()}"


def _product_history_digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _product_history_read_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProductReleaseHistoryError(
            "history-metadata-unreadable", f"history metadata is unreadable: {path}"
        ) from error
    if not isinstance(value, dict):
        raise ProductReleaseHistoryError(
            "history-metadata-invalid", f"history metadata is not an object: {path}"
        )
    return value


def _product_history_write_object(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _product_history_relative(value: str, label: str) -> Path:
    candidate = Path(value)
    if (
        not value
        or candidate.is_absolute()
        or value != candidate.as_posix()
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        raise ProductReleaseHistoryError(
            "history-path-unsafe", f"{label} is not a safe relative path"
        )
    return candidate


def _product_history_rooted_object(value: Mapping[str, Any], *, root_field: str) -> str:
    declared = value.get(root_field)
    core = {key: item for key, item in value.items() if key != root_field}
    if not isinstance(declared, str) or declared != _product_history_root(core):
        raise ProductReleaseHistoryError(
            "history-receipt-root-invalid",
            f"{root_field} does not verify against retained receipt bytes",
        )
    return declared


def _product_history_update_receipt_root(value: Mapping[str, Any]) -> str:
    declared = value.get("receiptRoot")
    core = {
        key: item
        for key, item in value.items()
        if key not in {"receiptRoot", "receiptPath"}
    }
    if not isinstance(declared, str) or declared != _product_history_root(core):
        raise ProductReleaseHistoryError(
            "history-update-receipt-root-invalid",
            "Product update receipt root does not verify",
        )
    return declared


def _product_history_image_entries(
    root: Path, *, include_bytes: bool
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    inventory: list[dict[str, Any]] = []
    material: list[dict[str, Any]] = []
    for base, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort()
        file_names.sort()
        base_path = Path(base)
        symlink_directories = [
            name for name in directory_names if (base_path / name).is_symlink()
        ]
        directory_names[:] = [
            name for name in directory_names if name not in symlink_directories
        ]
        for name in [*symlink_directories, *file_names]:
            path = base_path / name
            relative = path.relative_to(root).as_posix()
            if relative == "image.json":
                continue
            _product_history_relative(relative, "installed image entry")
            if path.is_symlink():
                target = os.readlink(path)
                target_path = Path(target)
                if target_path.is_absolute():
                    raise ProductReleaseHistoryError(
                        "history-symlink-unsafe",
                        "installed image contains an absolute symlink",
                    )
                resolved = (path.parent / target_path).resolve()
                if (
                    root.resolve() != resolved
                    and root.resolve() not in resolved.parents
                ):
                    raise ProductReleaseHistoryError(
                        "history-symlink-unsafe",
                        "installed image symlink escapes its image root",
                    )
                description: dict[str, Any] = {
                    "path": relative,
                    "kind": "symlink",
                    "target": target,
                }
                inventory.append(description)
                if include_bytes:
                    material.append(copy.deepcopy(description))
                continue
            if not path.is_file():
                raise ProductReleaseHistoryError(
                    "history-entry-unsupported",
                    "installed image contains an unsupported filesystem entry",
                    path=relative,
                )
            content = path.read_bytes()
            description = {
                "path": relative,
                "kind": "file",
                "mode": stat.S_IMODE(path.stat().st_mode),
                "byteLength": len(content),
                "sha256": _product_history_digest(content),
            }
            inventory.append(description)
            if include_bytes:
                material.append(
                    {
                        **description,
                        "bytesBase64": base64.b64encode(content).decode("ascii"),
                    }
                )
    return inventory, material


def _product_history_portable_record(record: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: copy.deepcopy(value)
        for key, value in record.items()
        if key != "productRoot"
    }


def _product_history_image_material(
    image_root: Path,
    *,
    include_bytes: bool,
    expected_product_root: Path | None = None,
) -> dict[str, Any]:
    record = _product_history_read_object(image_root / "image.json")
    product_root = (expected_product_root or image_root).resolve()
    if (
        record.get("schema") != distribution_update.CLI_IMAGE_SCHEMA
        or record.get("frontendBuildId") != product_root.name
        or Path(str(record.get("productRoot") or "")).resolve() != product_root
    ):
        raise ProductReleaseHistoryError(
            "history-image-invalid", "installed image identity does not verify"
        )
    manifest_path = image_root / _product_history_relative(
        str(record.get("upgradeManifest") or ""), "upgrade manifest"
    )
    manifest = runtime_upgrade.validate_manifest(
        _product_history_read_object(manifest_path)
    )
    if (
        manifest.get("frontendBuildId") != record.get("frontendBuildId")
        or manifest.get("runtimeBuildId") != record.get("runtimeBuildId")
        or manifest.get("releaseCutRoot") != record.get("releaseCutRoot")
        or manifest.get("platformSliceRoot") != record.get("platformSliceRoot")
    ):
        raise ProductReleaseHistoryError(
            "history-image-manifest-mismatch",
            "installed image and Product Release Cut manifest disagree",
        )
    cut = runtime_upgrade.validate_release_cut(manifest.get("releaseCut") or {})
    trust_domain = str((cut.get("publicationPolicy") or {}).get("trustDomain") or "")
    if trust_domain not in {"public", "shifu-local"}:
        raise ProductReleaseHistoryError(
            "history-trust-domain-invalid",
            "Product Release Cut trust domain is unsupported",
        )
    inventory, entries = _product_history_image_entries(
        image_root, include_bytes=include_bytes
    )
    portable = _product_history_portable_record(record)
    identity = {
        "record": portable,
        "manifestIdentityRoot": manifest["manifestIdentityRoot"],
        "releaseCutRoot": cut["releaseCutRoot"],
        "platformSliceRoot": record["platformSliceRoot"],
        "trustDomain": trust_domain,
        "entries": inventory,
    }
    return {
        **identity,
        "portableImageRoot": _product_history_root(identity),
        "releaseManifest": manifest,
        "materialEntries": entries,
    }


def _product_history_selection_receipts(root: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    if not root.is_dir():
        return values
    for path in sorted(root.glob("*.json")):
        value = _product_history_read_object(path)
        _product_history_rooted_object(value, root_field="receiptRoot")
        values.append(value)
    return values


def _product_history_update_receipts(root: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    if not root.is_dir():
        return values
    for path in sorted(root.rglob("*.json")):
        value = _product_history_read_object(path)
        if value.get("schema") != distribution_update.ORCHESTRATION_RECEIPT_SCHEMA:
            raise ProductReleaseHistoryError(
                "history-update-receipt-schema-invalid",
                "unknown required Product update receipt encountered",
            )
        _product_history_update_receipt_root(value)
        values.append(value)
    return values


def _product_history_merge_receipts(
    *groups: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_root: dict[str, dict[str, Any]] = {}
    for receipt in (item for group in groups for item in group):
        root = str(receipt["receiptRoot"])
        existing = by_root.get(root)
        if existing is not None and existing != receipt:
            raise ProductReleaseHistoryError(
                "history-source-receipt-collision",
                "one retained receipt root has different bytes",
            )
        by_root[root] = receipt
    return [by_root[root] for root in sorted(by_root)]


def _product_history_inventory(material: Mapping[str, Any]) -> dict[str, Any]:
    images = material.get("images") or []
    receipts = material.get("selectionReceipts") or []
    update_receipts = material.get("updateReceipts") or []
    selected = material.get("selected") or {}
    return {
        "selectedFrontendBuildId": selected.get("frontendBuildId"),
        "selectedReleaseCutRoot": selected.get("releaseCutRoot"),
        "selectedReceiptRoot": material.get("selectedReceiptRoot"),
        "imageRoots": sorted(str(row["portableImageRoot"]) for row in images),
        "releaseCutRoots": sorted(str(row["releaseCutRoot"]) for row in images),
        "transitionRoots": sorted(
            {
                str(receipt["frontendSelection"]["cutTransitionRoot"])
                for receipt in receipts
                if (receipt.get("frontendSelection") or {}).get("cutTransitionRoot")
            }
        ),
        "selectionReceiptRoots": sorted(str(row["receiptRoot"]) for row in receipts),
        "updateReceiptRoots": sorted(
            str(row["receiptRoot"]) for row in update_receipts
        ),
        "trustDomains": sorted({str(row["trustDomain"]) for row in images}),
    }


def build(config_home: str | Path, *, mode: str = "full") -> dict[str, Any]:
    """Verify and export one installed Product Release Cut history bundle."""

    if mode not in {"full", "thin"}:
        raise ProductReleaseHistoryError(
            "history-mode-invalid", "mode must be full or thin"
        )
    home = Path(config_home).expanduser().resolve()
    fsck = distribution_update.cli_inventory_fsck(home)
    if fsck.get("ok") is not True:
        raise ProductReleaseHistoryError(
            "history-source-inventory-invalid",
            "installed CLI history must pass fsck before export",
            issues=fsck.get("issues") or [],
        )
    selected = copy.deepcopy(fsck.get("selected") or {})
    if not selected or runtime_upgrade.is_legacy_bootstrap(selected):
        raise ProductReleaseHistoryError(
            "history-selected-image-required",
            "portable Product Release Cut history requires a selected installed image",
        )
    cli_root = home / "product" / "cli"
    images = [
        _product_history_image_material(
            cli_root / "images" / str(row["frontendBuildId"]),
            include_bytes=True,
        )
        for row in fsck.get("images") or []
    ]
    receipts = _product_history_merge_receipts(
        _product_history_selection_receipts(cli_root / "receipts"),
        _product_history_selection_receipts(
            cli_root / "history" / "selection-receipts"
        ),
    )
    selected_receipt_root = str(fsck.get("selectedReceiptRoot") or "")
    if not selected_receipt_root or selected_receipt_root not in {
        str(row.get("receiptRoot") or "") for row in receipts
    }:
        raise ProductReleaseHistoryError(
            "history-selected-receipt-missing",
            "selected Product Release Cut receipt is not retained",
        )
    material = {
        "selected": selected,
        "selectedReceiptRoot": selected_receipt_root,
        "images": images,
        "selectionReceipts": receipts,
        "updateReceipts": _product_history_merge_receipts(
            _product_history_update_receipts(home / "product" / "update" / "receipts"),
            _product_history_update_receipts(cli_root / "history" / "update-receipts"),
        ),
    }
    inventory = _product_history_inventory(material)
    history_root = _product_history_root(inventory)
    value = {
        "schema": _PRODUCT_HISTORY_BUNDLE_SCHEMA,
        "protocol": _PRODUCT_HISTORY_PROTOCOL,
        "formatVersion": _PRODUCT_HISTORY_FORMAT_VERSION,
        "mode": mode,
        "requiredFeatures": sorted(_PRODUCT_HISTORY_SUPPORTED_FEATURES),
        "identityRoot": str(inventory["selectedReleaseCutRoot"]),
        "historyRoot": history_root,
        "inventory": inventory,
        "material": material if mode == "full" else None,
        "capabilities": (
            ["inspect", "verify-inventory", "verify-content", "materialize"]
            if mode == "full"
            else ["inspect", "verify-inventory"]
        ),
    }
    return {**value, "bundleRoot": _product_history_root(value)}


def _product_history_verify_image(value: Mapping[str, Any]) -> dict[str, Any]:
    record = value.get("record")
    entries = value.get("entries")
    material_entries = value.get("materialEntries")
    manifest = value.get("releaseManifest")
    if (
        not isinstance(record, Mapping)
        or not isinstance(entries, list)
        or not isinstance(material_entries, list)
    ):
        raise ProductReleaseHistoryError(
            "history-image-material-invalid", "installed image material is incomplete"
        )
    verified_manifest = runtime_upgrade.validate_manifest(manifest or {})
    cut = runtime_upgrade.validate_release_cut(
        verified_manifest.get("releaseCut") or {}
    )
    trust_domain = str((cut.get("publicationPolicy") or {}).get("trustDomain") or "")
    identity = {
        "record": copy.deepcopy(dict(record)),
        "manifestIdentityRoot": verified_manifest["manifestIdentityRoot"],
        "releaseCutRoot": cut["releaseCutRoot"],
        "platformSliceRoot": record.get("platformSliceRoot"),
        "trustDomain": trust_domain,
        "entries": copy.deepcopy(entries),
    }
    if (
        trust_domain not in {"public", "shifu-local"}
        or value.get("portableImageRoot") != _product_history_root(identity)
        or value.get("releaseCutRoot") != cut["releaseCutRoot"]
        or value.get("trustDomain") != trust_domain
    ):
        raise ProductReleaseHistoryError(
            "history-image-root-invalid",
            "portable installed image root does not verify",
        )
    by_path = {
        str(row.get("path") or ""): row
        for row in material_entries
        if isinstance(row, Mapping)
    }
    if len(by_path) != len(entries):
        raise ProductReleaseHistoryError(
            "history-image-entry-invalid",
            "installed image entry inventory is incomplete",
        )
    for expected in entries:
        if not isinstance(expected, Mapping):
            raise ProductReleaseHistoryError(
                "history-image-entry-invalid", "installed image entry is not an object"
            )
        path = str(expected.get("path") or "")
        _product_history_relative(path, "installed image entry")
        observed = by_path.get(path)
        if not isinstance(observed, Mapping):
            raise ProductReleaseHistoryError(
                "history-image-entry-missing",
                "installed image bytes are missing",
                path=path,
            )
        if expected.get("kind") == "file":
            try:
                content = base64.b64decode(
                    str(observed.get("bytesBase64") or ""), validate=True
                )
            except ValueError as error:
                raise ProductReleaseHistoryError(
                    "history-image-bytes-invalid", "installed image bytes are invalid"
                ) from error
            comparable = {
                key: item for key, item in observed.items() if key != "bytesBase64"
            }
            if (
                comparable != dict(expected)
                or len(content) != expected.get("byteLength")
                or _product_history_digest(content) != expected.get("sha256")
            ):
                raise ProductReleaseHistoryError(
                    "history-image-bytes-invalid",
                    "installed image bytes do not verify",
                    path=path,
                )
        elif expected.get("kind") == "symlink":
            if (
                dict(observed) != dict(expected)
                or Path(str(expected.get("target") or "")).is_absolute()
            ):
                raise ProductReleaseHistoryError(
                    "history-symlink-unsafe",
                    "installed image symlink is invalid",
                    path=path,
                )
        else:
            raise ProductReleaseHistoryError(
                "history-image-entry-invalid",
                "unknown required installed image entry kind",
            )
    return identity


def verify(bundle: Mapping[str, Any], *, require_full: bool = False) -> dict[str, Any]:
    """Verify inventory roots and, for full bundles, every retained byte."""

    value = copy.deepcopy(dict(bundle))
    declared_root = value.pop("bundleRoot", None)
    required = value.get("requiredFeatures")
    unknown = (
        sorted(
            set(str(item) for item in required) - _PRODUCT_HISTORY_SUPPORTED_FEATURES
        )
        if isinstance(required, list)
        else ["requiredFeatures"]
    )
    if unknown:
        raise ProductReleaseHistoryError(
            "history-required-feature-unsupported",
            "bundle requires unknown Product Release Cut history features",
            features=unknown,
        )
    if (
        value.get("schema") != _PRODUCT_HISTORY_BUNDLE_SCHEMA
        or value.get("protocol") != _PRODUCT_HISTORY_PROTOCOL
        or value.get("formatVersion") != _PRODUCT_HISTORY_FORMAT_VERSION
        or value.get("mode") not in {"full", "thin"}
        or declared_root != _product_history_root(value)
    ):
        raise ProductReleaseHistoryError(
            "history-bundle-root-invalid",
            "Product Release Cut history bundle does not verify",
        )
    inventory = value.get("inventory")
    if not isinstance(inventory, Mapping) or value.get(
        "historyRoot"
    ) != _product_history_root(inventory):
        raise ProductReleaseHistoryError(
            "history-inventory-root-invalid",
            "Product Release Cut inventory root does not verify",
        )
    if value.get("identityRoot") != inventory.get("selectedReleaseCutRoot"):
        raise ProductReleaseHistoryError(
            "history-identity-root-invalid",
            "selected Product Release Cut identity disagrees",
        )
    if value.get("mode") == "thin":
        if require_full:
            raise ProductReleaseHistoryError(
                "history-thin-materialization-forbidden",
                "thin history is inventory-only",
            )
        return {**dict(inventory), "bundleRoot": declared_root, "mode": "thin"}
    material = value.get("material")
    if not isinstance(material, Mapping):
        raise ProductReleaseHistoryError(
            "history-material-missing",
            "full Product Release Cut history has no material",
        )
    images = material.get("images")
    receipts = material.get("selectionReceipts")
    update_receipts = material.get("updateReceipts")
    if (
        not isinstance(images, list)
        or not isinstance(receipts, list)
        or not isinstance(update_receipts, list)
    ):
        raise ProductReleaseHistoryError(
            "history-material-invalid", "Product Release Cut history arrays are invalid"
        )
    for image in images:
        if not isinstance(image, Mapping):
            raise ProductReleaseHistoryError(
                "history-image-material-invalid", "image material is not an object"
            )
        _product_history_verify_image(image)
    for receipt in receipts:
        if not isinstance(receipt, Mapping):
            raise ProductReleaseHistoryError(
                "history-receipt-invalid", "selection receipt is not an object"
            )
        _product_history_rooted_object(receipt, root_field="receiptRoot")
        transition = (receipt.get("frontendSelection") or {}).get("cutTransition")
        if transition is not None:
            runtime_upgrade.validate_cut_transition(transition)
    for receipt in update_receipts:
        if (
            not isinstance(receipt, Mapping)
            or receipt.get("schema") != distribution_update.ORCHESTRATION_RECEIPT_SCHEMA
        ):
            raise ProductReleaseHistoryError(
                "history-update-receipt-schema-invalid",
                "unknown required Product update receipt encountered",
            )
        _product_history_update_receipt_root(receipt)
    observed_inventory = _product_history_inventory(material)
    if dict(inventory) != observed_inventory or value.get(
        "historyRoot"
    ) != _product_history_root(observed_inventory):
        raise ProductReleaseHistoryError(
            "history-inventory-mismatch",
            "retained material disagrees with Product Release Cut inventory",
        )
    return {**observed_inventory, "bundleRoot": declared_root, "mode": "full"}


def _product_history_destination_record(
    image: Mapping[str, Any], target: Path
) -> dict[str, Any]:
    return {**copy.deepcopy(dict(image["record"])), "productRoot": str(target)}


def _product_history_preflight_image(image: Mapping[str, Any], target: Path) -> str:
    expected_root = str(image["portableImageRoot"])
    if not target.exists():
        return "pending"
    if not target.is_dir() or target.is_symlink():
        raise ProductReleaseHistoryError(
            "history-destination-image-collision",
            "destination image path is not a directory",
        )
    observed = _product_history_image_material(target, include_bytes=True)
    if observed["portableImageRoot"] != expected_root:
        raise ProductReleaseHistoryError(
            "history-destination-image-collision",
            "destination image has different bytes",
        )
    return "already_present"


def _product_history_materialize_image(image: Mapping[str, Any], target: Path) -> str:
    preflight = _product_history_preflight_image(image, target)
    if preflight == "already_present":
        return preflight
    expected_root = str(image["portableImageRoot"])
    staging = target.with_name(f".{target.name}.{os.getpid()}.{time.time_ns()}.partial")
    try:
        staging.mkdir(parents=True)
        for entry in image["materialEntries"]:
            relative = _product_history_relative(
                str(entry["path"]), "installed image entry"
            )
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if entry["kind"] == "file":
                content = base64.b64decode(str(entry["bytesBase64"]), validate=True)
                with destination.open("xb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(destination, int(entry["mode"]))
            else:
                target_value = str(entry["target"])
                resolved = (destination.parent / target_value).resolve()
                if (
                    staging.resolve() != resolved
                    and staging.resolve() not in resolved.parents
                ):
                    raise ProductReleaseHistoryError(
                        "history-symlink-unsafe",
                        "imported installed image symlink escapes",
                    )
                os.symlink(target_value, destination)
        _product_history_write_object(
            staging / "image.json", _product_history_destination_record(image, target)
        )
        observed = _product_history_image_material(
            staging, include_bytes=True, expected_product_root=target
        )
        if observed["portableImageRoot"] != expected_root:
            raise ProductReleaseHistoryError(
                "history-import-postflight-mismatch",
                "staged installed image does not verify",
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging, target)
        return "imported"
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _product_history_reroot_coordinate(
    coordinate: Mapping[str, Any] | None, images: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any] | None:
    if coordinate is None:
        return None
    if coordinate.get("kind") == runtime_upgrade.LEGACY_BOOTSTRAP_MODE:
        return copy.deepcopy(dict(coordinate))
    frontend_id = str(coordinate.get("frontendBuildId") or "")
    target = images.get(frontend_id)
    if target is None:
        raise ProductReleaseHistoryError(
            "history-rollback-image-missing",
            "selected rollback coordinate is not present in the portable image inventory",
        )
    return runtime_upgrade.image_coordinate(target)


def _product_history_path(config_home: Path, category: str, root: str) -> Path:
    digest = root.removeprefix("sha256:")
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ProductReleaseHistoryError(
            "history-root-invalid", "history root is malformed"
        )
    return config_home / "product" / "cli" / "history" / category / f"{digest}.json"


def import_history(
    config_home: str | Path,
    bundle: Mapping[str, Any],
    *,
    execute: bool = False,
    _fault_before_current: bool = False,
) -> dict[str, Any]:
    """Validate or copy-forward one full bundle into a clean installed-product home."""

    report = verify(bundle, require_full=True)
    if not execute:
        return {
            "ok": True,
            "status": "validated",
            "writeOccurred": False,
            "bundleRoot": report["bundleRoot"],
            "identityRoot": report["selectedReleaseCutRoot"],
        }
    home = Path(config_home).expanduser().resolve()
    cli_root = home / "product" / "cli"
    lock_root = cli_root / "locks"
    material = dict(bundle["material"])
    source_selection = dict(material["selected"])
    source_bundle_root = str(bundle["bundleRoot"])
    receipt_path = distribution_update._cli_selection_receipt_path(home, 1)
    with distribution_update._CLI_SELECTION_PROCESS_LOCK:
        with coordination_locks.held(
            lock_root,
            "current-selection",
            label="cli-product-select:portable-history-import",
        ):
            current_path = distribution_update._cli_selection_path(home)
            if receipt_path.is_file():
                pending = _product_history_read_object(receipt_path)
                _product_history_rooted_object(pending, root_field="receiptRoot")
                if (
                    pending.get("schema") != _PRODUCT_HISTORY_IMPORT_RECEIPT_SCHEMA
                    or pending.get("sourceBundleRoot") != source_bundle_root
                ):
                    raise ProductReleaseHistoryError(
                        "history-destination-receipt-collision",
                        "destination generation one belongs to different history",
                    )
                expected_selection = pending.get("frontendSelection")
                if not isinstance(expected_selection, Mapping):
                    raise ProductReleaseHistoryError(
                        "history-destination-receipt-invalid",
                        "copy-forward receipt has no selected image",
                    )
                for image in material["images"]:
                    target = distribution_update._cli_image_root(
                        home, str(image["record"]["frontendBuildId"])
                    )
                    if (
                        _product_history_preflight_image(image, target)
                        != "already_present"
                    ):
                        raise ProductReleaseHistoryError(
                            "history-recovery-image-missing",
                            "copy-forward recovery requires every receipt-bound image",
                        )
                for category, receipts in (
                    ("selection-receipts", material["selectionReceipts"]),
                    ("update-receipts", material["updateReceipts"]),
                ):
                    for source_receipt in receipts:
                        history_path = _product_history_path(
                            home, category, str(source_receipt["receiptRoot"])
                        )
                        if (
                            not history_path.is_file()
                            or _product_history_read_object(history_path)
                            != source_receipt
                        ):
                            raise ProductReleaseHistoryError(
                                "history-recovery-receipt-missing",
                                "copy-forward recovery requires every receipt-bound history member",
                            )
                if current_path.is_file():
                    if _product_history_read_object(current_path) != expected_selection:
                        raise ProductReleaseHistoryError(
                            "history-destination-selection-diverged",
                            "destination selection differs from retained copy-forward receipt",
                        )
                    status = "already_present"
                    wrote = False
                else:
                    preflight = distribution_update.cli_inventory_fsck(home)
                    issue_codes = {
                        str(issue.get("code") or "")
                        for issue in preflight.get("issues") or []
                    }
                    if issue_codes != {"cli-selection-publication-pending"}:
                        raise ProductReleaseHistoryError(
                            "history-recovery-preflight-failed",
                            "copy-forward recovery inventory has unexpected issues",
                            issues=preflight.get("issues") or [],
                        )
                    _product_history_write_object(current_path, expected_selection)
                    status = "recovered"
                    wrote = True
                postflight = distribution_update.cli_inventory_fsck(home)
                if (
                    postflight.get("ok") is not True
                    or postflight.get("selectedReceiptRoot") != pending["receiptRoot"]
                ):
                    raise ProductReleaseHistoryError(
                        "history-import-postflight-mismatch",
                        "recovered Product Release Cut history did not pass fsck",
                    )
                return {
                    "ok": True,
                    "status": status,
                    "writeOccurred": wrote,
                    "bundleRoot": source_bundle_root,
                    "identityRoot": report["selectedReleaseCutRoot"],
                    "receiptRoot": pending["receiptRoot"],
                    "frontendSelection": copy.deepcopy(dict(expected_selection)),
                    "sourceCacheRequired": False,
                }
            if (
                current_path.exists()
                or distribution_update._cli_selection_receipt_generations(home)
            ):
                raise ProductReleaseHistoryError(
                    "history-destination-not-clean",
                    "Product Release Cut history import requires a clean selection journal",
                )
            destination_images: dict[str, dict[str, Any]] = {}
            image_plan: list[tuple[Mapping[str, Any], Path]] = []
            for image in material["images"]:
                frontend_id = str(image["record"]["frontendBuildId"])
                target = distribution_update._cli_image_root(home, frontend_id)
                _product_history_preflight_image(image, target)
                image_plan.append((image, target))
                destination_images[frontend_id] = _product_history_destination_record(
                    image, target
                )
            selected_id = str(source_selection.get("frontendBuildId") or "")
            selected_image = destination_images.get(selected_id)
            if selected_image is None:
                raise ProductReleaseHistoryError(
                    "history-selected-image-missing",
                    "selected installed image is not portable",
                )
            transition = source_selection.get("cutTransition")
            if transition is not None:
                runtime_upgrade.validate_cut_transition(transition)
            selection = runtime_upgrade.image_selection(
                selected_image,
                schema=distribution_update.CLI_SELECTION_SCHEMA,
                generation=1,
                transition_root=source_selection.get("cutTransitionRoot"),
                transition=transition,
                previous_frontend_build_id=source_selection.get(
                    "previousFrontendBuildId"
                ),
                rollback=_product_history_reroot_coordinate(
                    source_selection.get("rollback"), destination_images
                ),
            )
            receipt_plan: list[tuple[Path, Mapping[str, Any]]] = []
            for category, receipts in (
                ("selection-receipts", material["selectionReceipts"]),
                ("update-receipts", material["updateReceipts"]),
            ):
                for source_receipt in receipts:
                    path = _product_history_path(
                        home, category, str(source_receipt["receiptRoot"])
                    )
                    if (
                        path.is_file()
                        and _product_history_read_object(path) != source_receipt
                    ):
                        raise ProductReleaseHistoryError(
                            "history-source-receipt-collision",
                            "retained source receipt root has different bytes",
                        )
                    if not path.is_file():
                        receipt_plan.append((path, source_receipt))
            image_statuses: list[dict[str, str]] = []
            for image, target in image_plan:
                status = _product_history_materialize_image(image, target)
                image_statuses.append(
                    {
                        "frontendBuildId": str(image["record"]["frontendBuildId"]),
                        "status": status,
                    }
                )
            for path, source_receipt in receipt_plan:
                _product_history_write_object(path, source_receipt)
            receipt = {
                "schema": _PRODUCT_HISTORY_IMPORT_RECEIPT_SCHEMA,
                "state": "complete",
                "reasonCode": "portable-history-copy-forward",
                "sourceBundleRoot": source_bundle_root,
                "sourceHistoryRoot": bundle["historyRoot"],
                "sourceSelectedReceiptRoot": material["selectedReceiptRoot"],
                "sourceSelectedGeneration": source_selection.get("generation"),
                "sourceReleaseCutRoot": source_selection.get("releaseCutRoot"),
                "frontendSelection": selection,
                "importedImageRoots": list(bundle["inventory"]["imageRoots"]),
                "importedSelectionReceiptRoots": list(
                    bundle["inventory"]["selectionReceiptRoots"]
                ),
                "importedUpdateReceiptRoots": list(
                    bundle["inventory"]["updateReceiptRoots"]
                ),
                "trustDomains": list(bundle["inventory"]["trustDomains"]),
                "copyForwardProtocol": _PRODUCT_HISTORY_PROTOCOL,
                "sourceCacheRequired": False,
            }
            rooted_receipt = {**receipt, "receiptRoot": _product_history_root(receipt)}
            distribution_update._persist_cli_selection_receipt(
                home, selection, rooted_receipt
            )
            if _fault_before_current:
                raise ProductReleaseHistoryError(
                    "qualification-fault-before-current",
                    "deterministic qualification fault before current selection publication",
                )
            try:
                _product_history_write_object(current_path, selection)
            except OSError as error:
                raise ProductReleaseHistoryError(
                    "history-selection-io-failed",
                    "copy-forward receipt is durable but current selection publication failed",
                ) from error
    postflight = distribution_update.cli_inventory_fsck(home)
    if (
        postflight.get("ok") is not True
        or postflight.get("selectedReceiptRoot") != rooted_receipt["receiptRoot"]
    ):
        raise ProductReleaseHistoryError(
            "history-import-postflight-mismatch",
            "imported Product Release Cut history did not pass fsck",
        )
    return {
        "ok": True,
        "status": "imported",
        "writeOccurred": True,
        "bundleRoot": source_bundle_root,
        "identityRoot": report["selectedReleaseCutRoot"],
        "receiptRoot": rooted_receipt["receiptRoot"],
        "frontendSelection": selection,
        "imageReceipts": image_statuses,
        "sourceCacheRequired": False,
    }
