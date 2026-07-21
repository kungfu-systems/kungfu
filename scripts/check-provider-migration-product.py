# SPDX-License-Identifier: Apache-2.0

"""Qualify installed provider migration and an optional no-RocksDB Core candidate."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "product" / "release" / "cli"
WORKER = ROOT / "scripts" / "provider-migration-product-worker.py"


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _root(domain: str, value: Any) -> str:
    return (
        "sha256:"
        + hashlib.sha256(
            b"kungfu.provider-migration-product/v1\0"
            + domain.encode("utf-8")
            + b"\0"
            + _canonical(value)
        ).hexdigest()
    )


def _normalize(value: Any, work_root: Path) -> Any:
    if isinstance(value, dict):
        return {key: _normalize(item, work_root) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize(item, work_root) for item in value]
    if isinstance(value, str):
        return value.replace(str(work_root), "<qualification-work-root>")
    return value


def _latest_artifact() -> Path:
    artifacts = sorted(
        [*RELEASE.glob("kungfu-episodes-cli-*.tar.gz"), *RELEASE.glob("*.zip")],
        key=lambda path: path.stat().st_mtime,
    )
    if not artifacts:
        raise FileNotFoundError(f"no official CLI artifact under {RELEASE}")
    return artifacts[-1]


def _extract(artifact: Path, destination: Path) -> Path:
    if artifact.suffix == ".zip":
        with zipfile.ZipFile(artifact) as archive:
            archive.extractall(destination)
    else:
        with tarfile.open(artifact, "r:gz") as archive:
            archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1:
        raise AssertionError("CLI artifact must contain exactly one install root")
    return roots[0]


def _run_worker(
    python: Path,
    install_root: Path,
    work_root: Path,
    artifact: Path,
    digest: str,
    phase: str,
    *,
    expected_code: int,
) -> None:
    common = [
        str(python),
        "-I",
        str(WORKER),
        phase,
        "--product-root",
        str(install_root),
        "--work-root",
        str(work_root),
        "--artifact-digest",
        digest,
        "--artifact-name",
        artifact.name,
        "--handoff",
        str(work_root / "handoff.json"),
        "--report",
        str(work_root / "report.json"),
    ]
    command = common
    network = "not-proven-no-os-sandbox"
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        command = [
            shutil.which("sandbox-exec") or "/usr/bin/sandbox-exec",
            "-p",
            "(version 1) (allow default) (deny network*)",
            *common,
        ]
        network = "denied-by-macos-sandbox"
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "PYTHONPATH",
            "PYTHONHOME",
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
            "KF_HOME",
            "KF_RUNTIME_DIR",
            "KUNGFU_ALLOW_FOREIGN_RUNTIME",
            "KUNGFU_NATIVE_PATH",
            "KUNGFU_STORAGE_PROVIDER",
        }
    }
    environment.update(
        {
            "HOME": str(work_root / f"{phase}-home"),
            "TMPDIR": str(work_root / "tmp"),
            "KUNGFU_CONTRACT_REGISTRY": str(
                install_root / "runtime" / "config" / "kungfu-contracts.registry.json"
            ),
            "KF_FIRST_PARTY_SOURCE_ROOT": str(install_root / "extensions"),
            "KUNGFU_QUALIFICATION_SOURCE_ROOT": str(ROOT),
            "KUNGFU_QUALIFICATION_NETWORK": network,
        }
    )
    Path(environment["HOME"]).mkdir(parents=True, exist_ok=True)
    Path(environment["TMPDIR"]).mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        command,
        cwd=work_root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != expected_code:
        raise AssertionError(
            f"{phase} phase returned {result.returncode}, expected {expected_code}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )


class _Config(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("runtime_dir", ctypes.c_char_p),
        ("stream_root", ctypes.c_char_p),
        ("host_namespace", ctypes.c_char_p),
        ("host_name", ctypes.c_char_p),
        ("mode", ctypes.c_uint8),
        ("reserved0", ctypes.c_uint8 * 7),
        ("default_timeout_ms", ctypes.c_uint64),
        ("reserved1", ctypes.c_uint64 * 3),
    ]


class _Message(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("protocol_id", ctypes.c_char_p),
        ("protocol_version", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
        ("schema_ref", ctypes.c_char_p),
        ("encoding", ctypes.c_char_p),
        ("bytes", ctypes.c_void_p),
        ("byte_size", ctypes.c_uint64),
    ]


class _Result(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("message", _Message),
        ("token", ctypes.c_uint64),
    ]


_OPEN = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.POINTER(_Config), ctypes.POINTER(ctypes.c_void_p)
)
_CAPS = ctypes.CFUNCTYPE(
    ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint64)
)
_ERROR = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_void_p),
    ctypes.POINTER(ctypes.c_uint64),
)
_CLOSE = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)
_INTERFACE_GET = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_void_p,
)
_EXECUTE = ctypes.CFUNCTYPE(
    ctypes.c_int32,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.POINTER(_Message),
    ctypes.POINTER(_Result),
)
_RELEASE = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint64)


class _Api(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_uint32),
        ("struct_size", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint64),
        ("context_open", _OPEN),
        ("context_capabilities", _CAPS),
        ("context_last_error", _ERROR),
        ("context_request_cancel", _CLOSE),
        ("context_reset_cancel", _CLOSE),
        ("interface_get", _INTERFACE_GET),
        ("context_close", _CLOSE),
    ]


class _MaintenanceApi(ctypes.Structure):
    _fields_ = [
        ("abi_version", ctypes.c_uint32),
        ("struct_size", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint64),
        ("execute", _EXECUTE),
        ("release_result", _RELEASE),
    ]


def _last_error(api: _Api, context: ctypes.c_void_p) -> str:
    data = ctypes.c_void_p()
    size = ctypes.c_uint64()
    if api.context_last_error(context, ctypes.byref(data), ctypes.byref(size)) != 0:
        return "last_error_unavailable"
    if not data.value:
        return ""
    return ctypes.string_at(data.value, size.value).decode("utf-8")


def _no_rocks_probe(
    library: Path, identity_path: Path, work_root: Path
) -> dict[str, Any]:
    identity_bytes = identity_path.read_bytes()
    identity = json.loads(identity_bytes)
    if identity["profile"] != "embedded-sqlite":
        raise AssertionError("no-RocksDB candidate is not embedded-sqlite")
    if "rocksdb-storage" in identity["providers"]:
        raise AssertionError("no-RocksDB candidate declares RocksDB")
    library_bytes = library.read_bytes()
    artifact_root = _root(
        "no-rocks-candidate",
        {
            "identitySha256": hashlib.sha256(identity_bytes).hexdigest(),
            "librarySha256": hashlib.sha256(library_bytes).hexdigest(),
        },
    )
    runtime = work_root / "no-rocks-runtime"
    raw = b"no-rocks packaged candidate source object"
    digest = hashlib.sha256(raw).hexdigest()
    object_path = runtime / "storage" / "payloads" / digest[:2] / digest
    object_path.parent.mkdir(parents=True, exist_ok=True)
    object_path.write_bytes(raw)

    module = ctypes.CDLL(str(library))
    get_api = module.kungfu_get_api
    get_api.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    get_api.restype = ctypes.c_int32
    api = _Api()
    if get_api(1, ctypes.sizeof(_Api), ctypes.byref(api)) != 0:
        raise AssertionError("no-RocksDB candidate standard ABI discovery failed")
    config = _Config()
    config.struct_size = ctypes.sizeof(_Config)
    config.runtime_dir = os.fsencode(runtime)
    config.stream_root = os.fsencode(runtime)
    config.host_namespace = b"provider-migration"
    config.host_name = b"no-rocks-probe"
    context = ctypes.c_void_p()
    if api.context_open(ctypes.byref(config), ctypes.byref(context)) != 0:
        raise AssertionError("no-RocksDB candidate context open failed")
    maintenance = _MaintenanceApi()
    if (
        api.interface_get(
            context,
            4,
            1,
            ctypes.sizeof(maintenance),
            ctypes.byref(maintenance),
        )
        != 0
    ):
        raise AssertionError("no-RocksDB candidate maintenance discovery failed")

    request = json.dumps(
        {"target_provider": "rocksdb", "expected_generation": 1},
        separators=(",", ":"),
    ).encode()
    request_buffer = ctypes.create_string_buffer(request)
    message = _Message(
        struct_size=ctypes.sizeof(_Message),
        protocol_id=b"kungfu.runtime.storage-service",
        protocol_version=1,
        schema_ref=b"kungfu.maintenance.request/v1",
        encoding=b"application/json",
        bytes=ctypes.cast(request_buffer, ctypes.c_void_p),
        byte_size=len(request),
    )
    result = _Result()
    result.struct_size = ctypes.sizeof(_Result)
    status = maintenance.execute(
        context,
        11,
        ctypes.byref(message),
        ctypes.byref(result),
    )
    error = _last_error(api, context)
    if status != 9 or error != "provider_unavailable: rocksdb":
        raise AssertionError(
            f"unexpected no-RocksDB result: status={status} error={error!r}"
        )
    if result.token:
        maintenance.release_result(context, result.token)
    if api.context_close(context) != 0:
        raise AssertionError("no-RocksDB candidate context close failed")
    binding = json.loads(
        (runtime / "storage" / "backend-binding.json").read_text(encoding="utf-8")
    )
    state_path = runtime / "storage" / "backend-switch-state.json"
    if binding["provider"] != "content-addressed-file" or binding["generation"] != 1:
        raise AssertionError("unavailable provider changed authority")
    if state_path.exists():
        raise AssertionError("unavailable provider published migration state")
    return {
        "status": "qualified-candidate",
        "artifactRoot": artifact_root,
        "buildIdentity": {
            key: value for key, value in identity.items() if key != "build_root"
        },
        "nativeAbi": 1,
        "executeStatus": status,
        "error": error,
        "sourceBinding": binding,
        "targetBindingPublished": False,
        "migrationStatePublished": False,
        "releaseBoundary": (
            "supported embedded-sqlite Core candidate; not an official CLI release"
        ),
    }


def qualify(
    artifact: Path,
    *,
    no_rocks_library: Path,
    no_rocks_identity: Path,
    report_out: Path | None = None,
) -> dict[str, Any]:
    artifact = artifact.resolve()
    digest = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="kungfu-provider-migration-") as temp:
        work_root = Path(temp)
        install_root = _extract(artifact, work_root / "install")
        product = json.loads(
            (install_root / "product.json").read_text(encoding="utf-8")
        )
        if product.get("schema") != "kungfu.product.cli/v1":
            raise AssertionError("not a Kungfu CLI product artifact")
        python_relative = (
            Path("runtime/python/python.exe")
            if sys.platform == "win32"
            else Path("runtime/python/bin/python3")
        )
        python = install_root / python_relative
        if not python.is_file():
            raise AssertionError(f"assembled artifact interpreter missing: {python}")
        for phase, expected in (("seed", 0), ("fault", 75), ("complete", 0)):
            _run_worker(
                python,
                install_root,
                work_root,
                artifact,
                digest,
                phase,
                expected_code=expected,
            )
        report = json.loads((work_root / "report.json").read_text(encoding="utf-8"))
        report["noRocksCandidate"] = _no_rocks_probe(
            no_rocks_library.resolve(),
            no_rocks_identity.resolve(),
            work_root,
        )
        report = _normalize(report, work_root)
        report.pop("reportRoot", None)
        report["reportRoot"] = _root("report", report)
        if report_out is not None:
            report_out.parent.mkdir(parents=True, exist_ok=True)
            report_out.write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--no-rocks-library", type=Path, required=True)
    parser.add_argument("--no-rocks-identity", type=Path, required=True)
    parser.add_argument("--report-out", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = qualify(
        args.artifact or _latest_artifact(),
        no_rocks_library=args.no_rocks_library,
        no_rocks_identity=args.no_rocks_identity,
        report_out=args.report_out,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(
            "[provider-migration-product] qualified "
            f"{report['artifact']['digest']} -> {report['reportRoot']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
