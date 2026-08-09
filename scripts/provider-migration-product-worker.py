# SPDX-License-Identifier: Apache-2.0

"""Installed-product worker for provider migration qualification."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


FILE = "content-addressed-file"
ROCKS = "rocksdb"
SCHEMA = "kungfu.provider-migration-product-qualification/v1"


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


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"expected JSON object: {path}")
    return value


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _assert_installed(product_root: Path) -> dict[str, Any]:
    import kungfu
    import pykungfu

    root = product_root.resolve()
    package_path = Path(kungfu.__file__).resolve()
    binding_path = Path(pykungfu.__file__).resolve()
    if not package_path.is_relative_to(root):
        raise AssertionError(f"kungfu imported outside product: {package_path}")
    if not binding_path.is_relative_to(root):
        raise AssertionError(f"pykungfu imported outside product: {binding_path}")
    source_root = Path(os.environ["KUNGFU_QUALIFICATION_SOURCE_ROOT"]).resolve()
    leaked = [
        entry
        for entry in sys.path
        if entry and Path(entry).resolve().is_relative_to(source_root)
    ]
    if leaked:
        raise AssertionError(f"source checkout leaked into sys.path: {leaked}")
    return {
        "python": str(Path(sys.executable).resolve().relative_to(root)),
        "kungfuPackage": str(package_path.relative_to(root)),
        "nativeBinding": str(binding_path.relative_to(root)),
        "isolatedPython": bool(sys.flags.isolated),
        "sourcePathLeak": False,
    }


def _launcher(product_root: Path) -> Path:
    product = _read(product_root / "product.json")
    return product_root / product["entries"]["kungfu"]


def _cli(
    product_root: Path,
    runtime: Path,
    *arguments: str,
    provider: str | None = None,
    expected_success: bool = True,
) -> dict[str, Any]:
    environment = dict(os.environ)
    environment["KF_RUNTIME_DIR"] = str(runtime)
    if provider is None:
        environment.pop("KUNGFU_STORAGE_PROVIDER", None)
    else:
        environment["KUNGFU_STORAGE_PROVIDER"] = provider
    result = subprocess.run(
        [str(_launcher(product_root)), *arguments],
        cwd=runtime.parent,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if expected_success and result.returncode != 0:
        raise AssertionError(
            f"installed CLI failed ({result.returncode}): {' '.join(arguments)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    if not expected_success:
        if result.returncode == 0:
            raise AssertionError(
                f"installed CLI unexpectedly succeeded: {' '.join(arguments)}"
            )
        return {
            "returnCode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise AssertionError("installed CLI JSON result must be an object")
    return value


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _file_object(runtime: Path, namespace: str, raw: bytes) -> Path:
    digest = _digest(raw)
    return runtime / "storage" / namespace / digest[:2] / digest


def _tree_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _seed(args: argparse.Namespace) -> int:
    discovery = _assert_installed(args.product_root)
    from kungfu.storage import content_store, service

    runtime = args.work_root / "runtime"
    objects = {
        "payloads": b"installed provider migration payload",
        "schemas": b'{"type":"object","title":"provider qualification"}',
        "fact-bodies": b"provider-neutral fact body",
        "episode-material": b"provider-neutral episode material",
        "profile-sources": b"provider-neutral profile source",
    }
    for namespace, raw in objects.items():
        result = content_store.put_if_absent(runtime, namespace, raw)
        if result.get("ok") is not True:
            raise AssertionError(result)
    projection = runtime / "storage" / "projections" / "qualification.sqlite"
    projection.parent.mkdir(parents=True, exist_ok=True)
    projection.write_bytes(b"derived projection is not provider identity")
    status = _cli(args.product_root, runtime, "storage", "backend", "status", "--json")
    namespaces = sorted(objects)
    if status["inventory"]["object_count"] != len(objects):
        raise AssertionError("derived projection entered provider inventory")
    capabilities = service.service_capabilities()
    providers = {item["name"]: item for item in capabilities["providers"]}
    if providers[ROCKS]["available"] is not True:
        raise AssertionError("official full product artifact lacks RocksDB")
    handoff = {
        "schema": SCHEMA,
        "artifact": {
            "digest": args.artifact_digest,
            "name": args.artifact_name,
            "product": "official-cli-archive",
        },
        "discovery": discovery,
        "runtime": str(runtime),
        "seed": {
            "namespaces": namespaces,
            "objects": {
                namespace: {
                    "digest": "sha256:" + _digest(raw),
                    "bytes": len(raw),
                }
                for namespace, raw in sorted(objects.items())
            },
            "status": status,
            "projectionExcluded": True,
        },
        "capabilities": {
            "providers": providers,
            "backendAuthority": capabilities["backend_authority"],
        },
    }
    _write(args.handoff, handoff)
    return 0


def _fault(args: argparse.Namespace) -> int:
    _assert_installed(args.product_root)
    from kungfu.storage import service

    handoff = _read(args.handoff)
    runtime = Path(handoff["runtime"])
    try:
        service.backend_switch(
            runtime,
            target_provider=ROCKS,
            expected_generation=1,
            qualification_fail_after_copied_objects=1,
        )
    except RuntimeError as error:
        if str(error) != "backend_switch_qualification_fault_after_copy":
            raise
        binding = _read(runtime / "storage" / "backend-binding.json")
        state = _read(runtime / "storage" / "backend-switch-state.json")
        if binding["provider"] != FILE or binding["generation"] != 1:
            raise AssertionError("mid-copy fault changed provider authority")
        if state["phase"] != "copying" or state["copied_objects"] < 1:
            raise AssertionError("mid-copy state is not resumable")
        handoff["midCopyFault"] = {
            "error": str(error),
            "binding": binding,
            "state": state,
            "processExit": 75,
        }
        _write(args.handoff, handoff)
        return 75
    raise AssertionError("qualification fault did not interrupt the switch")


def _writer(args: argparse.Namespace) -> int:
    _assert_installed(args.product_root)
    from kungfu.storage import content_store

    args.writer_ready.write_text("ready\n", encoding="utf-8")
    written: list[dict[str, Any]] = []
    for index in range(48):
        raw = (f"concurrent-{index:03d}-" + "x" * 4096).encode()
        deadline = time.monotonic() + 10
        while True:
            try:
                result = content_store.put_if_absent(
                    args.runtime, "concurrent-writes", raw
                )
                if result.get("ok") is not True:
                    raise AssertionError(result)
                written.append(
                    {
                        "digest": "sha256:" + _digest(raw),
                        "bytes": len(raw),
                    }
                )
                break
            except RuntimeError as error:
                if "backend_cut_in_progress" not in str(error):
                    raise
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.001)
    _write(args.writer_result, {"objects": written})
    return 0


def _complete(args: argparse.Namespace) -> int:
    discovery = _assert_installed(args.product_root)
    from kungfu.storage import content_store

    handoff = _read(args.handoff)
    runtime = Path(handoff["runtime"])
    ready = args.work_root / "writer.ready"
    writer_result = args.work_root / "writer.json"
    writer = subprocess.Popen(
        [
            sys.executable,
            "-I",
            str(Path(__file__).resolve()),
            "writer",
            "--product-root",
            str(args.product_root),
            "--work-root",
            str(args.work_root),
            "--artifact-digest",
            args.artifact_digest,
            "--artifact-name",
            args.artifact_name,
            "--handoff",
            str(args.handoff),
            "--runtime",
            str(runtime),
            "--writer-ready",
            str(ready),
            "--writer-result",
            str(writer_result),
        ],
        cwd=args.work_root,
        env=dict(os.environ),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 10
    while not ready.exists() and time.monotonic() < deadline:
        time.sleep(0.005)
    if not ready.exists():
        writer.kill()
        raise AssertionError("concurrent writer did not start")

    resumed = _cli(
        args.product_root,
        runtime,
        "storage",
        "backend",
        "switch",
        "--to",
        ROCKS,
        "--expected-generation",
        "1",
        "--json",
    )
    stdout, stderr = writer.communicate(timeout=20)
    if writer.returncode != 0:
        raise AssertionError(
            f"concurrent installed writer failed ({writer.returncode})\n"
            f"stdout:\n{stdout}\nstderr:\n{stderr}"
        )
    concurrent = _read(writer_result)
    if resumed["operation_id"] != handoff["midCopyFault"]["state"]["operation_id"]:
        raise AssertionError("retry did not resume the interrupted operation")
    if (
        resumed["target_fsck"]["semantic_root"] != resumed["post_cut"]["semantic_root"]
        or resumed["post_cut"]["object_count"] < resumed["pre_cut"]["object_count"]
    ):
        raise AssertionError("switch did not verify the authoritative cut")
    for namespace, item in handoff["seed"]["objects"].items():
        digest = item["digest"].removeprefix("sha256:")
        loaded = content_store.get(runtime, namespace, digest)
        if hashlib.sha256(loaded).hexdigest() != digest:
            raise AssertionError(f"seed object changed after switch: {namespace}")
    for item in concurrent["objects"]:
        digest = item["digest"].removeprefix("sha256:")
        if not content_store.has(runtime, "concurrent-writes", digest):
            raise AssertionError(f"acknowledged concurrent object lost: {digest}")

    restarted = _cli(
        args.product_root, runtime, "storage", "backend", "status", "--json"
    )
    if restarted["provider"] != ROCKS or restarted["binding"]["generation"] != 2:
        raise AssertionError(
            "fresh installed process did not observe committed binding"
        )

    mismatch_error = ""
    os.environ["KUNGFU_STORAGE_PROVIDER"] = FILE
    try:
        content_store.put_if_absent(runtime, "payloads", b"must be write fenced")
    except RuntimeError as error:
        mismatch_error = str(error)
    finally:
        os.environ.pop("KUNGFU_STORAGE_PROVIDER", None)
    if "provider_binding_mismatch" not in mismatch_error:
        raise AssertionError("manual provider mismatch did not fail closed")

    post_switch = b"object admitted only after RocksDB authority"
    result = content_store.put_if_absent(runtime, "post-switch", post_switch)
    if result.get("ok") is not True:
        raise AssertionError(result)
    if _file_object(runtime, "post-switch", post_switch).exists():
        raise AssertionError("post-switch object leaked into retained file provider")

    rolled_back = _cli(
        args.product_root,
        runtime,
        "storage",
        "backend",
        "rollback",
        "--expected-generation",
        "2",
        "--json",
    )
    if rolled_back["target_provider"] != FILE or rolled_back["target_generation"] != 3:
        raise AssertionError("rollback did not publish the expected generation")
    if rolled_back["pre_cut"] != rolled_back["post_cut"]:
        raise AssertionError("rollback did not preserve semantic inventory")
    if _file_object(runtime, "post-switch", post_switch).read_bytes() != post_switch:
        raise AssertionError("rollback did not reverse-sync post-switch material")
    rollback_restart = _cli(
        args.product_root, runtime, "storage", "backend", "status", "--json"
    )

    corrupt_runtime = args.work_root / "corrupt-runtime"
    corrupt_raw = b"disposable pre-cut corruption"
    result = content_store.put_if_absent(corrupt_runtime, "payloads", corrupt_raw)
    if result.get("ok") is not True:
        raise AssertionError(result)
    _file_object(corrupt_runtime, "payloads", corrupt_raw).write_bytes(b"corrupt")
    pre_cut_failure = _cli(
        args.product_root,
        corrupt_runtime,
        "storage",
        "backend",
        "switch",
        "--to",
        ROCKS,
        "--json",
        expected_success=False,
    )
    corrupt_binding = _read(corrupt_runtime / "storage" / "backend-binding.json")
    if corrupt_binding["provider"] != FILE or corrupt_binding["generation"] != 1:
        raise AssertionError("pre-cut failure changed authority")
    corrupt_state = corrupt_runtime / "storage" / "backend-switch-state.json"
    if corrupt_state.exists():
        raise AssertionError("pre-cut failure published migration state")

    qualified_namespaces = sorted(
        [
            *handoff["seed"]["namespaces"],
            "concurrent-writes",
            "post-switch",
        ]
    )
    file_provider_bytes = sum(
        _tree_bytes(runtime / "storage" / namespace)
        for namespace in qualified_namespaces
    )
    rocks_provider_bytes = _tree_bytes(runtime / "storage" / ROCKS)

    report = {
        "schema": SCHEMA,
        "verdict": "qualified",
        "artifact": handoff["artifact"],
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "discovery": discovery,
        "network": os.environ["KUNGFU_QUALIFICATION_NETWORK"],
        "seed": handoff["seed"],
        "capabilities": handoff["capabilities"],
        "midCopyFault": handoff["midCopyFault"],
        "resume": resumed,
        "concurrentWriteFence": {
            "acknowledgedObjects": len(concurrent["objects"]),
            "allPresent": True,
        },
        "postBindingRestart": restarted,
        "manualMismatch": {
            "failClosed": True,
            "error": mismatch_error,
            "canonicalRoute": "kungfu storage backend switch",
        },
        "rollback": rolled_back,
        "rollbackRestart": rollback_restart,
        "preCutFailure": {
            "command": pre_cut_failure,
            "binding": corrupt_binding,
            "targetBindingPublished": False,
            "migrationStatePublished": False,
        },
        "providerNeutrality": {
            "qualifiedNamespaces": qualified_namespaces,
            "journalsCopied": False,
            "projectionsCopied": False,
            "bindingGeneration": rollback_restart["binding"]["generation"],
        },
        "retention": {
            "oldProviderRetainedReadOnly": rolled_back["old_backend_retained_readonly"],
            "sourceRetirement": "not-performed",
            "destructiveCleanup": False,
            "residualDiskCost": {
                "status": "both-provider-stores-retained",
                "fileProviderBytes": file_provider_bytes,
                "rocksdbProviderBytes": rocks_provider_bytes,
            },
        },
        "qualifiedPlatforms": ["darwin-arm64"] if sys.platform == "darwin" else [],
        "unqualifiedPlatforms": ["linux-x64", "windows-x64"],
        "nonClaims": [
            "cross-machine provider migration",
            "distributed writer fencing",
            "destructive source cleanup",
            "physical-media durability",
            "GUI or TUI provider migration parity",
        ],
    }
    report["reportRoot"] = _root("report", report)
    _write(args.report, report)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["seed", "fault", "writer", "complete"])
    parser.add_argument("--product-root", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--artifact-digest", required=True)
    parser.add_argument("--artifact-name", required=True)
    parser.add_argument("--handoff", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--writer-ready", type=Path)
    parser.add_argument("--writer-result", type=Path)
    args = parser.parse_args()
    if args.phase == "seed":
        return _seed(args)
    if args.phase == "fault":
        return _fault(args)
    if args.phase == "writer":
        return _writer(args)
    if args.report is None:
        parser.error("--report is required for complete")
    return _complete(args)


if __name__ == "__main__":
    raise SystemExit(main())
