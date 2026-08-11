# SPDX-License-Identifier: Apache-2.0

"""Installed, content-bound authoring kit for ordinary KFX packages.

The kit owns source materialization and deterministic qualification only.  It
never installs, activates, authorizes, or grants capabilities; those mutations
remain delegated to the existing Core-native KFX lifecycle.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

from kungfu import kfx_contract


KIT_SCHEMA = "kungfu.kfx-authoring-kit/v1"
CAPABILITIES_SCHEMA = "kungfu.kfx-authoring-capabilities/v1"
SOURCE_PLAN_SCHEMA = "kungfu.kfx-authoring-source-plan/v1"
SOURCE_RECEIPT_SCHEMA = "kungfu.kfx-authoring-source-receipt/v1"
INSPECTION_SCHEMA = "kungfu.kfx-authoring-inspection/v1"
BUILD_PLAN_SCHEMA = "kungfu.kfx-authoring-build-plan/v1"
BUILD_RECEIPT_SCHEMA = "kungfu.kfx-authoring-build-receipt/v1"
QUALIFICATION_SCHEMA = "kungfu.kfx-authoring-qualification/v1"
PACKAGE_PLAN_SCHEMA = "kungfu.kfx-authoring-package-plan/v1"
PACKAGE_RECEIPT_SCHEMA = "kungfu.kfx-authoring-package-receipt/v1"

_ASSET_PACKAGE = "kungfu.kfx_authoring_assets"
_PACKAGE_KEY = re.compile(r"^[A-Za-z0-9._-]+$")
_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
_IGNORED_PARTS = {".git", ".kungfu", "__pycache__", "node_modules", "dist"}
_QUALIFICATION_TIMEOUT_SECONDS = 30
_REQUIRED_TEMPLATE_FILES = {
    "README.md",
    "fixtures/local-receiver.mjs",
    "kungfu.kfx.json",
    "package.json",
    "sdk/kfx-host.d.ts",
    "sdk/sandbox-launcher.d.ts",
    "sdk/service-authz.d.ts",
    "sdk/service-webhook-host.mjs",
    "sdk/types.d.ts",
    "src/service.mjs",
    "test/qualify.mjs",
}


class KfxAuthoringError(ValueError):
    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(f"{code}: {message}")
        self.diagnosis = {
            "schema": "kungfu.kfx-authoring-diagnosis/v1",
            "code": code,
            "message": message,
            **details,
        }


def _asset_root():
    """Return only the installed package-data root; never search a checkout."""

    return resources.files(_ASSET_PACKAGE)


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _root(value: Any) -> str:
    payload = value if isinstance(value, bytes) else _canonical(value)
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _read_json(path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise KfxAuthoringError(
            "authoring-asset-unreadable", f"cannot read {path.name}: {error}"
        ) from error
    if not isinstance(value, dict):
        raise KfxAuthoringError(
            "authoring-asset-invalid", f"{path.name} must contain one JSON object"
        )
    return value


def _contract() -> dict[str, Any]:
    contract = _read_json(_asset_root() / "contract.json")
    if contract.get("schema") != KIT_SCHEMA:
        raise KfxAuthoringError(
            "authoring-contract-unsupported",
            "installed authoring contract is unsupported",
        )
    for coordinate in contract.get("files", []):
        relative = str(coordinate.get("path") or "")
        expected = str(coordinate.get("sha256") or "")
        if not relative or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise KfxAuthoringError(
                "authoring-contract-invalid", "asset coordinate is incomplete"
            )
        candidate = _asset_root().joinpath(*Path(relative).parts)
        try:
            payload = candidate.read_bytes()
        except OSError as error:
            raise KfxAuthoringError(
                "authoring-asset-missing", f"installed asset is missing: {relative}"
            ) from error
        actual = _sha256(payload)
        if actual != expected:
            raise KfxAuthoringError(
                "authoring-asset-root-mismatch",
                f"installed asset drifted: {relative}",
                path=relative,
                expected=expected,
                actual=actual,
            )
    unsigned = {key: value for key, value in contract.items() if key != "contractRoot"}
    actual_root = _root(unsigned)
    if contract.get("contractRoot") != actual_root:
        raise KfxAuthoringError(
            "authoring-contract-root-mismatch",
            "installed authoring contract root does not match its payload",
            expected=contract.get("contractRoot"),
            actual=actual_root,
        )
    native = kfx_contract.load_contract()
    expected_native = contract.get("nativeKfx") or {}
    if native.get("version") != expected_native.get("contractVersion") or (
        native.get("nativeRuntime") or {}
    ).get("serviceHost", {}).get("schema") != expected_native.get("serviceHostSchema"):
        raise KfxAuthoringError(
            "native-kfx-contract-incompatible",
            "installed KFX authoring kit does not match the native KFX contract",
        )
    return contract


def capabilities() -> dict[str, Any]:
    contract = _contract()
    return {
        "schema": CAPABILITIES_SCHEMA,
        "status": "available",
        "productVersion": contract["productVersion"],
        "contractRoot": contract["contractRoot"],
        "sdk": contract["sdk"],
        "schemas": contract["schemas"],
        "templates": contract["templates"],
        "lifecycle": contract["lifecycle"],
        "commands": contract["commands"],
        "nextAction": "kungfu kfx author scaffold <package-key> --out <dir> --json",
        "nonClaims": contract["nonClaims"],
    }


def brief() -> str:
    _contract()
    return (_asset_root() / "brief.md").read_text(encoding="utf-8")


def _render_template(text: str, values: Mapping[str, str]) -> str:
    rendered = text
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", value)
    if re.search(r"{{[A-Z_]+}}", rendered):
        raise KfxAuthoringError(
            "authoring-template-incomplete", "installed template has unresolved fields"
        )
    return rendered


def _template_files(values: Mapping[str, str]) -> dict[str, bytes]:
    contract = _contract()
    files: dict[str, bytes] = {}
    template_root = _asset_root() / "templates" / "webhook-service"
    for relative in contract["templates"]["webhookService"]["files"]:
        source = template_root.joinpath(*Path(relative).parts)
        payload = source.read_bytes()
        if relative.endswith(".tmpl"):
            rendered_relative = relative[: -len(".tmpl")]
            try:
                text = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise KfxAuthoringError(
                    "authoring-template-invalid", f"template is not UTF-8: {relative}"
                ) from error
            files[rendered_relative] = _render_template(text, values).encode("utf-8")
        else:
            files[relative] = payload
    sdk_root = _asset_root() / "sdk"
    for relative in contract["sdk"]["files"]:
        files[f"sdk/{relative}"] = (sdk_root / relative).read_bytes()
    return dict(sorted(files.items()))


def scaffold_plan(
    package_key: str,
    out: str | Path,
    *,
    title: str | None = None,
    version: str = "0.1.0",
) -> dict[str, Any]:
    if not _PACKAGE_KEY.fullmatch(package_key):
        raise KfxAuthoringError(
            "package-key-invalid", "package key must match ^[A-Za-z0-9._-]+$"
        )
    if not _VERSION.fullmatch(version):
        raise KfxAuthoringError(
            "package-version-invalid", "package version must be semantic"
        )
    package_title = (title or package_key.replace("-", " ").title()).strip()
    if not package_title:
        raise KfxAuthoringError("package-title-invalid", "package title is required")
    destination = Path(out).expanduser().resolve()
    contract = _contract()
    files = _template_files(
        {
            "PACKAGE_KEY": package_key,
            "PACKAGE_TITLE": package_title,
            "PACKAGE_DESCRIPTION_JSON": json.dumps(
                f"{package_title} - generated by the installed Kungfu KFX authoring kit",
                ensure_ascii=False,
            ),
            "PACKAGE_VERSION": version,
            "PRODUCT_VERSION": contract["productVersion"],
            "KIT_ROOT": contract["contractRoot"],
            "SDK_ROOT": contract["sdk"]["root"],
        }
    )
    coordinates = [
        {"path": relative, "sha256": _sha256(payload), "bytes": len(payload)}
        for relative, payload in files.items()
    ]
    body = {
        "schema": SOURCE_PLAN_SCHEMA,
        "destination": str(destination),
        "packageKey": package_key,
        "packageVersion": version,
        "productVersion": contract["productVersion"],
        "kitRoot": contract["contractRoot"],
        "sdkRoot": contract["sdk"]["root"],
        "files": coordinates,
        "material": {
            relative: base64.b64encode(payload).decode("ascii")
            for relative, payload in files.items()
        },
        "willWrite": False,
    }
    return {**body, "planRoot": _root(body)}


def apply_scaffold(plan: Mapping[str, Any]) -> dict[str, Any]:
    if plan.get("schema") != SOURCE_PLAN_SCHEMA:
        raise KfxAuthoringError("source-plan-unsupported", "unsupported source plan")
    unsigned = {key: value for key, value in plan.items() if key != "planRoot"}
    if plan.get("planRoot") != _root(unsigned):
        raise KfxAuthoringError("source-plan-tampered", "source plan root mismatch")
    destination = Path(str(plan["destination"]))
    if destination.exists() and any(destination.iterdir()):
        raise KfxAuthoringError(
            "destination-not-empty", "source destination must be absent or empty"
        )
    material = plan.get("material") or {}
    expected = {row["path"]: row["sha256"] for row in plan.get("files", [])}
    for relative, encoded in material.items():
        payload = base64.b64decode(encoded, validate=True)
        if _sha256(payload) != expected.get(relative):
            raise KfxAuthoringError(
                "source-plan-tampered", f"planned bytes drifted: {relative}"
            )
        target = (destination / relative).resolve()
        if not target.is_relative_to(destination.resolve()):
            raise KfxAuthoringError(
                "source-path-escaped", f"planned path escaped destination: {relative}"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    inspection = inspect_source(destination)
    body = {
        "schema": SOURCE_RECEIPT_SCHEMA,
        "planRoot": plan["planRoot"],
        "sourceRoot": inspection["sourceRoot"],
        "destination": str(destination.resolve()),
        "packageKey": inspection["packageKey"],
        "verified": True,
    }
    return {**body, "receiptRoot": _root(body)}


def _source_files(source: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        if path.is_symlink():
            raise KfxAuthoringError(
                "source-symlink-denied",
                f"KFX source cannot contain symlinks: {relative}",
            )
        if path.is_file():
            files[relative.as_posix()] = path.read_bytes()
    return files


def _source_root(files: Mapping[str, bytes]) -> str:
    closure = [
        {"path": path, "sha256": _sha256(payload), "bytes": len(payload)}
        for path, payload in sorted(files.items())
    ]
    return _root({"schema": "kungfu.kfx-authoring-source-closure/v1", "files": closure})


def inspect_source(source: str | Path) -> dict[str, Any]:
    root = Path(source).expanduser().resolve()
    if not root.is_dir():
        raise KfxAuthoringError("source-missing", "KFX source directory is missing")
    files = _source_files(root)
    missing = sorted(_REQUIRED_TEMPLATE_FILES - set(files))
    if missing:
        raise KfxAuthoringError(
            "source-closure-incomplete",
            "KFX authoring source is incomplete",
            missing=missing,
        )
    contract = _contract()
    for relative in contract["sdk"]["files"]:
        actual = _sha256(files[f"sdk/{relative}"])
        expected = contract["sdk"]["roots"][relative]
        if actual != expected:
            raise KfxAuthoringError(
                "sdk-root-mismatch",
                f"version-matched SDK projection drifted: {relative}",
                expected=expected,
                actual=actual,
            )
    try:
        manifest = json.loads(files["kungfu.kfx.json"])
        package = json.loads(files["package.json"])
    except json.JSONDecodeError as error:
        raise KfxAuthoringError(
            "source-json-invalid", f"KFX source JSON is invalid: {error}"
        ) from error
    if not isinstance(manifest, dict) or not isinstance(package, dict):
        raise KfxAuthoringError(
            "source-json-invalid", "manifest and package metadata must be objects"
        )
    try:
        kfx_contract.validate_package_manifest(manifest)
    except ValueError as error:
        raise KfxAuthoringError("manifest-invalid", str(error)) from error
    if "kungfuConfig" in package:
        raise KfxAuthoringError(
            "manifest-authority-conflict",
            "package.json must not author kungfuConfig",
        )
    key = kfx_contract.package_key(manifest)
    if not key or package.get("version") != manifest.get("version"):
        raise KfxAuthoringError(
            "package-identity-mismatch",
            "package transport metadata must match the KFX manifest version",
        )
    service = ((manifest.get("kungfuConfig") or {}).get("config") or {}).get("service")
    host = service.get("host") if isinstance(service, dict) else None
    expected_host = contract["nativeKfx"]["serviceHostSchema"]
    if not isinstance(host, dict) or host.get("schema") != expected_host:
        raise KfxAuthoringError(
            "service-host-contract-missing",
            "webhook starter must declare the stable service host",
        )
    if (host.get("webhook") or {}).get("listener", {}).get("mode") != "loopback":
        raise KfxAuthoringError(
            "starter-listener-not-loopback",
            "the installed starter may bind only the loopback fixture",
        )
    coordinates = [
        {"path": path, "sha256": _sha256(payload), "bytes": len(payload)}
        for path, payload in files.items()
    ]
    body = {
        "schema": INSPECTION_SCHEMA,
        "source": str(root),
        "packageKey": key,
        "packageVersion": manifest["version"],
        "productVersion": contract["productVersion"],
        "kitRoot": contract["contractRoot"],
        "sdkRoot": contract["sdk"]["root"],
        "sourceRoot": _source_root(files),
        "files": coordinates,
        "offline": True,
        "sourceFallback": False,
        "valid": True,
    }
    return {**body, "inspectionRoot": _root(body)}


def build_plan(source: str | Path, out: str | Path) -> dict[str, Any]:
    inspection = inspect_source(source)
    source_root = Path(inspection["source"])
    destination = Path(out).expanduser().resolve()
    files = _source_files(source_root)
    body = {
        "schema": BUILD_PLAN_SCHEMA,
        "source": str(source_root),
        "destination": str(destination),
        "sourceRoot": inspection["sourceRoot"],
        "packageKey": inspection["packageKey"],
        "kitRoot": inspection["kitRoot"],
        "sdkRoot": inspection["sdkRoot"],
        "files": [
            {"path": path, "sha256": _sha256(payload), "bytes": len(payload)}
            for path, payload in files.items()
        ],
        "material": {
            path: base64.b64encode(payload).decode("ascii")
            for path, payload in files.items()
        },
        "willWrite": False,
    }
    return {**body, "planRoot": _root(body)}


def apply_build(plan: Mapping[str, Any]) -> dict[str, Any]:
    if plan.get("schema") != BUILD_PLAN_SCHEMA:
        raise KfxAuthoringError("build-plan-unsupported", "unsupported build plan")
    unsigned = {key: value for key, value in plan.items() if key != "planRoot"}
    if plan.get("planRoot") != _root(unsigned):
        raise KfxAuthoringError("build-plan-tampered", "build plan root mismatch")
    destination = Path(str(plan["destination"]))
    if destination.exists() and any(destination.iterdir()):
        raise KfxAuthoringError(
            "build-destination-not-empty", "build destination must be absent or empty"
        )
    expected = {row["path"]: row["sha256"] for row in plan.get("files", [])}
    for relative, encoded in (plan.get("material") or {}).items():
        payload = base64.b64decode(encoded, validate=True)
        if _sha256(payload) != expected.get(relative):
            raise KfxAuthoringError(
                "build-plan-tampered", f"build material drifted: {relative}"
            )
        target = (destination / relative).resolve()
        if not target.is_relative_to(destination.resolve()):
            raise KfxAuthoringError(
                "build-path-escaped", f"build path escaped destination: {relative}"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    inspection = inspect_source(destination)
    if inspection["sourceRoot"] != plan["sourceRoot"]:
        raise KfxAuthoringError(
            "build-source-root-mismatch", "materialized build differs from source plan"
        )
    body = {
        "schema": BUILD_RECEIPT_SCHEMA,
        "planRoot": plan["planRoot"],
        "sourceRoot": plan["sourceRoot"],
        "artifactRoot": inspection["sourceRoot"],
        "destination": str(destination.resolve()),
        "verified": True,
    }
    return {**body, "receiptRoot": _root(body)}


def _node_invocation(entry: Path) -> tuple[list[str], dict[str, str]]:
    environment = os.environ.copy()
    environment["KFX_AUTHORING_QUALIFICATION"] = "1"
    for variable in ("KUNGFU_CONTROLLER_ENTRYPOINT", "KUNGFU_AGENT_SESSION_EXECUTABLE"):
        value = environment.get(variable)
        candidate = Path(value).expanduser().resolve() if value else None
        if candidate is not None and candidate.is_file():
            environment["KUNGFU_AS_VARIANT"] = "node"
            environment["KUNGFU_NODE_VARIANT_ENTRY"] = str(entry)
            return [str(candidate), str(entry)], environment
    node = shutil.which("node")
    if not node:
        raise KfxAuthoringError(
            "node-runtime-unavailable",
            "the packaged Node runtime required by the Node KFX starter is unavailable",
        )
    return [node, str(entry)], environment


def qualify(source: str | Path) -> dict[str, Any]:
    inspection = inspect_source(source)
    root = Path(inspection["source"])
    entry = root / "test" / "qualify.mjs"
    command, environment = _node_invocation(entry)
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=_QUALIFICATION_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise KfxAuthoringError(
            "qualification-timeout",
            "installed-only qualification exceeded its bounded runtime",
            timeoutSeconds=_QUALIFICATION_TIMEOUT_SECONDS,
        ) from error
    if completed.returncode != 0:
        raise KfxAuthoringError(
            "qualification-failed",
            completed.stderr.strip() or completed.stdout.strip() or "fixture failed",
            returncode=completed.returncode,
        )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise KfxAuthoringError(
            "qualification-output-invalid", "fixture did not emit one JSON receipt"
        ) from error
    contract = _contract()
    if (
        result.get("schema") != QUALIFICATION_SCHEMA
        or result.get("status") != "passed"
        or result.get("sdkRoot") != contract["sdk"]["root"]
    ):
        raise KfxAuthoringError(
            "qualification-receipt-invalid",
            "fixture receipt is not bound to the installed SDK",
        )
    body = {
        **result,
        "sourceRoot": inspection["sourceRoot"],
        "kitRoot": contract["contractRoot"],
        "productVersion": contract["productVersion"],
        "installedOnly": True,
        "sourceFallback": False,
    }
    return {**body, "qualificationRoot": _root(body)}


def package_plan(source: str | Path, out: str | Path) -> dict[str, Any]:
    inspection = inspect_source(source)
    qualification = qualify(source)
    destination = Path(out).expanduser().resolve()
    files = _source_files(Path(inspection["source"]))
    body = {
        "schema": PACKAGE_PLAN_SCHEMA,
        "source": inspection["source"],
        "destination": str(destination),
        "sourceRoot": inspection["sourceRoot"],
        "qualificationRoot": qualification["qualificationRoot"],
        "packageKey": inspection["packageKey"],
        "files": [
            {"path": path, "sha256": _sha256(payload), "bytes": len(payload)}
            for path, payload in files.items()
        ],
        "material": {
            path: base64.b64encode(payload).decode("ascii")
            for path, payload in files.items()
        },
        "willWrite": False,
    }
    return {**body, "planRoot": _root(body)}


def apply_package(plan: Mapping[str, Any]) -> dict[str, Any]:
    if plan.get("schema") != PACKAGE_PLAN_SCHEMA:
        raise KfxAuthoringError("package-plan-unsupported", "unsupported package plan")
    unsigned = {key: value for key, value in plan.items() if key != "planRoot"}
    if plan.get("planRoot") != _root(unsigned):
        raise KfxAuthoringError("package-plan-tampered", "package plan root mismatch")
    destination = Path(str(plan["destination"]))
    if destination.exists():
        raise KfxAuthoringError(
            "package-destination-exists", "package destination already exists"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected = {row["path"]: row["sha256"] for row in plan.get("files", [])}
    material = plan.get("material") or {}
    if set(material) != set(expected):
        raise KfxAuthoringError(
            "package-plan-tampered", "package material does not match its inventory"
        )
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for relative, encoded in sorted(material.items()):
                if (
                    not relative
                    or relative.startswith("/")
                    or "\\" in relative
                    or ".." in Path(relative).parts
                ):
                    raise KfxAuthoringError(
                        "package-path-invalid",
                        f"package path must be relative and portable: {relative}",
                    )
                payload = base64.b64decode(encoded, validate=True)
                if _sha256(payload) != expected[relative]:
                    raise KfxAuthoringError(
                        "package-plan-tampered",
                        f"package material drifted: {relative}",
                    )
                info = tarfile.TarInfo(name=f"package/{relative}")
                info.size = len(payload)
                info.mode = 0o644
                info.mtime = 0
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                archive.addfile(info, io.BytesIO(payload))
    artifact = buffer.getvalue()
    destination.write_bytes(artifact)
    try:
        manifest = kfx_contract.read_manifest_from_tgz(str(destination))
    except (OSError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        destination.unlink(missing_ok=True)
        raise KfxAuthoringError(
            "package-verification-failed", f"packaged KFX is unreadable: {error}"
        ) from error
    if kfx_contract.package_key(manifest) != plan.get("packageKey"):
        destination.unlink(missing_ok=True)
        raise KfxAuthoringError(
            "package-identity-mismatch",
            "packaged KFX identity does not match the package plan",
        )
    body = {
        "schema": PACKAGE_RECEIPT_SCHEMA,
        "planRoot": plan["planRoot"],
        "sourceRoot": plan["sourceRoot"],
        "qualificationRoot": plan["qualificationRoot"],
        "artifact": str(destination.resolve()),
        "artifactRoot": _root(artifact),
        "bytes": len(artifact),
        "packageKey": kfx_contract.package_key(manifest),
        "verified": True,
    }
    return {**body, "receiptRoot": _root(body)}


def emit_error(error: Exception) -> dict[str, Any]:
    if isinstance(error, KfxAuthoringError):
        return error.diagnosis
    return {
        "schema": "kungfu.kfx-authoring-diagnosis/v1",
        "code": "authoring-operation-failed",
        "message": str(error),
    }
