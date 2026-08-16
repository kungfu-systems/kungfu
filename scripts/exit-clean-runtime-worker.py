# SPDX-License-Identifier: Apache-2.0

"""Installed-product worker for the retained Exit clean-runtime qualification.

The orchestrator starts this file with the Python interpreter inside an extracted
official CLI artifact and ``-I``.  Source and destination phases are separate
processes; the destination receives only the packages, a rooted handoff, and
installed-product discovery paths.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

try:
    import resource
except ImportError:  # pragma: no cover - Windows release qualification
    resource = None


SCHEMA = "kungfu.exit-clean-runtime-qualification/v1"
HANDOFF_SCHEMA = "kungfu.exit-clean-runtime-handoff/v1"
EPISODE_ID = 20260720
WORK_REF = "profiles/kfd-7/exit-clean-runtime"
INITIATIVE_ID = "exit-clean-runtime"
ASSIGNMENT_ID = "continue-after-exit"


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _root(domain: str, value: Any) -> str:
    return (
        "sha256:"
        + hashlib.sha256(
            b"kungfu.exit-clean-runtime/v1\0"
            + domain.encode("utf-8")
            + b"\0"
            + _canonical(value)
        ).hexdigest()
    )


def _maximum_resident_kib() -> int | None:
    if resource is None:
        return None
    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return value // 1024 if sys.platform == "darwin" else value


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"expected JSON object: {path}")
    return value


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _assert_installed(product_root: Path) -> dict[str, Any]:
    import kungfu
    import pykungfu

    product_root = product_root.resolve()
    package_path = Path(kungfu.__file__).resolve()
    binding_path = Path(pykungfu.__file__).resolve()
    if not package_path.is_relative_to(product_root):
        raise AssertionError(f"kungfu imported outside product: {package_path}")
    if not binding_path.is_relative_to(product_root):
        raise AssertionError(f"pykungfu imported outside product: {binding_path}")
    leaked = [
        entry
        for entry in sys.path
        if entry
        and Path(entry)
        .resolve()
        .is_relative_to(Path(os.environ["KUNGFU_QUALIFICATION_SOURCE_ROOT"]).resolve())
    ]
    if leaked:
        raise AssertionError(f"source checkout leaked into sys.path: {leaked}")
    return {
        "python": str(Path(sys.executable).resolve().relative_to(product_root)),
        "kungfuPackage": str(package_path.relative_to(product_root)),
        "nativeBinding": str(binding_path.relative_to(product_root)),
        "contractRegistry": str(
            Path(os.environ["KUNGFU_CONTRACT_REGISTRY"])
            .resolve()
            .relative_to(product_root)
        ),
        "bundledExtensionRoot": str(
            Path(os.environ["KF_BUNDLED_EXTENSION_ROOT"])
            .resolve()
            .relative_to(product_root)
        ),
        "isolatedPython": bool(sys.flags.isolated),
        "sourcePathLeak": False,
    }


def _installed_cli(
    product_root: Path,
    runtime: Path,
    *arguments: str,
) -> dict[str, Any]:
    manifest = _read(product_root / "product.json")
    launcher = product_root / manifest["entries"]["kungfu"]
    environment = dict(os.environ)
    environment["KF_RUNTIME_DIR"] = str(runtime)
    result = subprocess.run(
        [str(launcher), *arguments],
        cwd=runtime.parent,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"installed CLI failed ({result.returncode}): {' '.join(arguments)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(
            f"installed CLI returned non-JSON output: {' '.join(arguments)}\n"
            f"{result.stdout}"
        ) from error
    if not isinstance(value, dict):
        raise TypeError("installed CLI JSON result must be an object")
    return value


def _work_request() -> dict[str, Any]:
    from kungfu.agent import work_profile

    def digest(digit: str) -> str:
        return "sha256:" + digit * 64

    return {
        "schema": work_profile.ACTION_SCHEMA,
        "actionId": "exit-clean-runtime-bootstrap",
        "refName": WORK_REF,
        "basis": {"cutRoot": None, "revision": 0},
        "ref": {"cutRoot": None, "revision": 0},
        "subject": {
            "role": "fact",
            "operation": "create",
            "fromState": "absent",
            "toState": "declared",
        },
        "responsibilities": {
            role: {
                "objectId": f"fact:{index:032x}",
                "expectedVersionRoot": None,
            }
            for index, role in enumerate(work_profile.ROLES, start=1)
        },
        "roleInputs": {
            "fact": {
                "state": "declared",
                "details": {"cutKind": "installed-exit-qualification"},
            },
            "episode": {
                "state": "open",
                "details": {"episodeId": "episode:exit-clean-runtime"},
            },
            "pursuit": {
                "state": "active",
                "details": {"success": "continue once from imported exact roots"},
            },
            "atlas": {
                "state": "current",
                "details": {"validThroughRevision": 10},
            },
            "warrant": {
                "state": "issued",
                "details": {
                    "validThroughRevision": 10,
                    "allowedOperations": ["*"],
                },
            },
        },
        "relations": [],
        "support": {
            "createdByReceiptRoot": digest("1"),
            "schemaRoot": digest("2"),
            "declarationRoots": [digest("3")],
            "admissionRoots": [digest("4")],
            "reasonRoot": digest("5"),
        },
    }


def _successor(previous: dict[str, Any], action_id: str) -> dict[str, Any]:
    from kungfu.agent import work_profile

    request = _work_request()
    result = previous["result"]
    request["actionId"] = action_id
    request["basis"] = {
        "cutRoot": result["cutRoot"],
        "revision": result["revision"],
    }
    request["ref"] = copy.deepcopy(request["basis"])
    request["subject"] = {
        "role": "pursuit",
        "operation": "continue",
        "fromState": "active",
        "toState": "active",
    }
    request["responsibilities"] = {
        role: {
            "objectId": request["responsibilities"][role]["objectId"],
            "expectedVersionRoot": result["roleVersions"][role],
        }
        for role in work_profile.ROLES
    }
    request.pop("roleInputs")
    request["payload"] = {
        "continuation": action_id,
        "bounded": True,
        "source": "exact-import-receipt",
    }
    return request


def _activate_work_control_profile(runtime: Path) -> Path:
    from kungfu import profile_composition, profile_sdk

    source = Path(profile_sdk.discover_source("kungfu.work-control", runtime)["source"])
    for action in ("install", "qualify", "activate"):
        values = {"granted_permissions": ["storage"]} if action == "activate" else {}
        plan = profile_sdk.lifecycle_plan(runtime, action, source, **values)["corePlan"]
        receipt = profile_sdk.lifecycle_apply(
            runtime, plan, f"exit-clean-runtime:{action}"
        )
        if receipt.get("verified") is not True:
            raise AssertionError(receipt)
    contract_plan = profile_composition.contract_materialization_plan(source, runtime)
    if contract_plan["operations"]:
        receipt = profile_composition.authorized_contract_materialize(
            runtime,
            contract_plan,
            profile_sdk.answer_decision(
                contract_plan["decisionCard"],
                "approve",
                "exit-clean-runtime-owner",
            ),
        )
        if receipt.get("status") not in {"materialized", "current"}:
            raise AssertionError(receipt)
    return source


def _request(profile_source: Path, mode: str) -> dict[str, Any]:
    return {
        "schema": "kungfu.exit-bundle-request/v1",
        "bundleId": f"exit:clean-runtime-{mode}",
        "mode": mode,
        "scope": {
            "id": "agent-work/exit-clean-runtime",
            "authority": "installed Kungfu Core and Profile authorities",
            "schema": SCHEMA,
            "protocol": "installed-clean-runtime/v1",
        },
        "requiredCapabilities": (
            ["inspect", "verify-inventory"]
            if mode == "thin"
            else [
                "inspect",
                "verify-inventory",
                "verify-content",
                "materialize",
                "rebuild-projections",
                "continue",
            ]
        ),
        "members": [
            {
                "memberId": "work-control-profile",
                "kind": "profile-source-v1",
                "requiredForScope": True,
                "options": {
                    "source": str(profile_source),
                    "grantedPermissions": ["storage"],
                },
            },
            {
                "memberId": "work-authority",
                "kind": "fact-authority-v2",
                "requiredForScope": True,
                "options": {},
            },
            {
                "memberId": "work-cut",
                "kind": "fact-cut-portable-v1",
                "requiredForScope": True,
                "options": {"refName": WORK_REF},
            },
            {
                "memberId": "qualification-episode",
                "kind": "episode-v1",
                "requiredForScope": True,
                "options": {"episodeId": EPISODE_ID},
            },
            {
                "memberId": "initiative-state",
                "kind": "initiative-bundle-v1",
                "requiredForScope": True,
                "options": {
                    "initiativeId": INITIATIVE_ID,
                    "purpose": "operator-review",
                },
            },
        ],
    }


def source_phase(args: argparse.Namespace) -> int:
    discovery = _assert_installed(args.product_root)
    from kungfu import exit_bundle
    from kungfu.agent import work_profile
    from kungfu import work_control
    from kungfu.storage import service

    runtime = args.work_root / "source-runtime"
    profile_source = _activate_work_control_profile(runtime)
    created = work_profile.apply_action(runtime, _work_request(), execute=True)
    continued = work_profile.apply_action(
        runtime,
        _successor(created, "source-bounded-step"),
        execute=True,
    )
    if continued.get("status") != "accepted":
        raise AssertionError(continued)
    service.episode_begin(
        runtime,
        episode_id=EPISODE_ID,
        begin_time=1,
        title="Installed Exit qualification",
        actor="qualification",
        source="official-cli-artifact",
    )
    service.episode_end(
        runtime,
        episode_id=EPISODE_ID,
        end_time=2,
        reason="sealed representative fixture",
    )
    work_control.create_initiative(
        str(runtime),
        initiative_id=INITIATIVE_ID,
        title="Exit clean-runtime qualification",
        intent="Continue from one exact installed Exit package",
        actor="qualification-owner",
        actor_type="user",
    )
    work_control.create_assignment(
        str(runtime),
        initiative_id=INITIATIVE_ID,
        assignment_id=ASSIGNMENT_ID,
        title="Continue after installed import",
        objective="Perform one bounded continuation without chat context",
        actor="qualification-agent",
        actor_type="agent",
    )

    full = exit_bundle.build(runtime, _request(profile_source, "full"))
    thin = exit_bundle.build(runtime, _request(profile_source, "thin"))
    _write(args.full, full)
    _write(args.thin, thin)
    source_state = {
        "work": work_profile.inspect(runtime, WORK_REF),
        "workAuthorityBundleRoot": work_profile.export_authority(runtime)["result"][
            "bundle_root"
        ],
        "factPortableBundleRoot": service.fact_kernel_export(
            runtime, ref_name=WORK_REF
        )["bundle_root"],
        "episodeContentRoot": (
            service.build_export_bundle(runtime, episode_id=EPISODE_ID)["manifest"][
                "content_root"
            ]
        ),
        "initiativeBundleRoot": full["materials"]["initiative-state"]["bundle_root"],
        "initiativeExpectedState": full["materials"]["initiative-state"][
            "expected_state"
        ],
        "profileSuiteRoot": full["materials"]["work-control-profile"][
            "profileSuiteRoot"
        ],
        "sourceCutRoot": continued["result"]["cutRoot"],
        "sourceRevision": continued["result"]["revision"],
    }
    handoff = {
        "schema": HANDOFF_SCHEMA,
        "artifactDigest": args.artifact_digest,
        "fullPackageRoot": full["packageRoot"],
        "thinPackageRoot": thin["packageRoot"],
        "sourceState": source_state,
        "installedDiscovery": discovery,
    }
    handoff["handoffRoot"] = _root("handoff", handoff)
    _write(args.handoff, handoff)
    return 0


def _reroot(package: dict[str, Any]) -> dict[str, Any]:
    from kungfu import exit_bundle

    package["manifest"]["bundleRoot"] = exit_bundle._manifest_root(package["manifest"])
    package["packageRoot"] = exit_bundle._package_root(package)
    return package


def _fault_campaign(
    full: dict[str, Any],
    thin: dict[str, Any],
    work_root: Path,
) -> list[dict[str, Any]]:
    from kungfu import exit_bundle, exit_verifier

    cases: list[dict[str, Any]] = []

    tampered = copy.deepcopy(full)
    tampered["materials"]["qualification-episode"]["episode_id"] = EPISODE_ID + 1
    result = exit_verifier.verify(tampered)
    cases.append({"id": "tamper", "status": result["verdict"]})

    missing = copy.deepcopy(full)
    missing["materials"].pop("qualification-episode")
    _reroot(missing)
    result = exit_verifier.verify(missing)
    cases.append({"id": "missing-material", "status": result["verdict"]})

    version = copy.deepcopy(full)
    version["manifest"]["schema"] = "kungfu.exit-bundle/v999"
    _reroot(version)
    result = exit_verifier.verify(version)
    cases.append({"id": "version-mismatch", "status": result["verdict"]})

    thin_receipt = exit_bundle.import_package(
        work_root / "thin-runtime",
        thin,
        execute=True,
        authorized_by="qualification-owner",
    )
    cases.append(
        {
            "id": "thin-materialization",
            "status": thin_receipt["status"],
            "code": thin_receipt["failure"]["code"],
        }
    )

    interrupted_runtime = work_root / "interrupted-runtime"
    interrupted = exit_bundle.import_package(
        interrupted_runtime,
        full,
        execute=True,
        authorized_by="qualification-owner",
        _fault_after_member=2,
    )
    retried = exit_bundle.import_package(
        interrupted_runtime,
        full,
        execute=True,
        authorized_by="qualification-owner",
    )
    cases.append(
        {
            "id": "interrupted-import-retry",
            "status": interrupted["status"],
            "retryStatus": retried["status"],
            "remainingAfterRetry": retried["remainingMembers"],
        }
    )
    return cases


def _delete_derived_projections(runtime: Path) -> list[str]:
    root = runtime.resolve()
    deleted = []
    for relative in (
        "storage/projections/source-registry.sqlite",
        "storage/projections/manifest-catalog.sqlite",
        "storage/projections/episode-manifest.sqlite",
    ):
        target = (runtime / relative).resolve()
        if not target.is_relative_to(root):
            raise AssertionError(f"projection escaped disposable runtime: {target}")
        if target.exists():
            target.unlink()
            deleted.append(relative)
    return deleted


def destination_phase(args: argparse.Namespace) -> int:
    started = time.monotonic()
    discovery = _assert_installed(args.product_root)
    from kungfu import exit_bundle, exit_verifier, profile_sdk
    from kungfu.agent import work_profile
    from kungfu import work_control
    from kungfu.storage import service

    handoff = _read(args.handoff)
    full = _read(args.full)
    thin = _read(args.thin)
    expected_handoff_root = handoff.pop("handoffRoot")
    if expected_handoff_root != _root("handoff", handoff):
        raise AssertionError("handoff root mismatch")
    handoff["handoffRoot"] = expected_handoff_root
    if handoff["artifactDigest"] != args.artifact_digest:
        raise AssertionError("artifact digest changed between source and destination")

    full_verification = exit_verifier.verify(full)
    thin_verification = exit_verifier.verify(thin)
    if full_verification["verdict"] != "verified":
        raise AssertionError(full_verification)
    if thin_verification["verdict"] != "degraded":
        raise AssertionError(thin_verification)

    runtime = args.work_root / "destination-runtime"
    preview = exit_bundle.import_package(runtime, full)
    if preview["status"] != "validated" or runtime.exists():
        raise AssertionError("validate-only import mutated the destination")
    imported = exit_bundle.import_package(
        runtime,
        full,
        execute=True,
        authorized_by="qualification-owner",
    )
    if imported["status"] != "imported" or imported["remainingMembers"]:
        raise AssertionError(imported)
    retried = exit_bundle.import_package(
        runtime,
        full,
        execute=True,
        authorized_by="qualification-owner",
    )
    if retried["status"] != "already_present":
        raise AssertionError(retried)

    source_state = handoff["sourceState"]
    destination_work = work_profile.inspect(runtime, WORK_REF)
    destination_profile = profile_sdk.discover_source("kungfu.work-control", runtime)[
        "source"
    ]
    destination_initiative = work_control.query_state(
        str(runtime), initiative_id=INITIATIVE_ID
    )
    destination_state = {
        "work": destination_work,
        "workAuthorityBundleRoot": work_profile.export_authority(runtime)["result"][
            "bundle_root"
        ],
        "factPortableBundleRoot": service.fact_kernel_export(
            runtime, ref_name=WORK_REF
        )["bundle_root"],
        "episodeContentRoot": (
            service.build_export_bundle(runtime, episode_id=EPISODE_ID)["manifest"][
                "content_root"
            ]
        ),
        "initiativeBundleRoot": full["materials"]["initiative-state"]["bundle_root"],
        "initiativeExpectedState": {
            key: destination_initiative[key]
            for key in (
                "query_definition_root",
                "query_proof_root",
                "result_hash",
                "canonical_state",
                "cut",
            )
        },
        "profileSuiteRoot": profile_sdk.export_source_bundle(
            destination_profile, runtime, thin=False
        )["profileSuiteRoot"],
    }
    for field in (
        "work",
        "workAuthorityBundleRoot",
        "factPortableBundleRoot",
        "episodeContentRoot",
        "initiativeBundleRoot",
        "initiativeExpectedState",
        "profileSuiteRoot",
    ):
        if destination_state[field] != source_state[field]:
            raise AssertionError(f"source/destination {field} diverged")

    cli_work = _installed_cli(
        args.product_root,
        runtime,
        "agent",
        "work",
        "inspect",
        "--ref",
        WORK_REF,
        "--json",
    )
    cli_fact_fsck = _installed_cli(
        args.product_root,
        runtime,
        "facts",
        "integrity",
        "fsck",
        "--cut-root",
        source_state["sourceCutRoot"],
    )
    cli_exit = _installed_cli(
        args.product_root,
        runtime,
        "exit",
        "inspect",
        "--file",
        str(args.full),
        "--json",
    )
    if cli_work != destination_work:
        raise AssertionError("installed Agent CLI inspection diverged")
    if cli_fact_fsck.get("ok") is not True:
        raise AssertionError(cli_fact_fsck)
    if cli_exit.get("packageRoot") != full["packageRoot"]:
        raise AssertionError(cli_exit)

    fact_fsck = service.fact_kernel_fsck(
        runtime, cut_root=source_state["sourceCutRoot"]
    )
    service.rebuild_index(runtime)
    service.episode_projection_rebuild(runtime)
    service.fact_kernel_rebuild_projections(runtime)
    storage_fsck_before = service.fsck(runtime, episode_id=EPISODE_ID)
    deleted = _delete_derived_projections(runtime)
    if len(deleted) != 3:
        raise AssertionError(
            f"expected three disposable projections, deleted {deleted}"
        )
    storage_fsck_without_projection = service.fsck(runtime, episode_id=EPISODE_ID)
    storage_rebuild = service.rebuild_index(runtime)
    episode_rebuild = service.episode_projection_rebuild(runtime)
    fact_rebuild = service.fact_kernel_rebuild_projections(runtime)
    storage_fsck_after = service.fsck(runtime, episode_id=EPISODE_ID)
    rebuilt_work = work_profile.inspect(runtime, WORK_REF)
    if rebuilt_work != destination_work:
        raise AssertionError("projection rebuild changed authoritative work state")

    continuation_request = _successor(
        {
            "result": {
                "cutRoot": destination_work["cutRoot"],
                "revision": destination_work["revision"],
                "roleVersions": {
                    role: destination_work["roles"][role]["versionRoot"]
                    for role in destination_work["roles"]
                },
            }
        },
        "destination-bounded-step",
    )
    continuation = work_profile.apply_action(
        runtime, continuation_request, execute=True
    )
    if continuation.get("status") != "accepted":
        raise AssertionError(continuation)
    if continuation["result"]["revision"] != source_state["sourceRevision"] + 1:
        raise AssertionError("bounded continuation did not advance exactly once")

    faults = _fault_campaign(full, thin, args.work_root)
    required_fault_status = {
        "tamper": "rejected",
        "missing-material": "rejected",
        "version-mismatch": "rejected",
        "thin-materialization": "rejected",
        "interrupted-import-retry": "partial",
    }
    for case in faults:
        if case["status"] != required_fault_status[case["id"]]:
            raise AssertionError(case)
    retry_case = next(row for row in faults if row["id"] == "interrupted-import-retry")
    if retry_case["retryStatus"] != "imported" or retry_case["remainingAfterRetry"]:
        raise AssertionError(retry_case)

    duration_ms = round((time.monotonic() - started) * 1000)
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "qualified",
        "artifact": {
            "digest": args.artifact_digest,
            "name": args.artifact_name,
            "product": "official-cli-archive",
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "filesystemProfile": {
                "name": "disposable-host-default",
                "device": runtime.stat().st_dev,
            },
        },
        "environment": {
            "emptyDestination": True,
            "sourceCheckoutOnSysPath": False,
            "oldRuntimeAvailable": False,
            "network": os.environ.get("KUNGFU_QUALIFICATION_NETWORK", "not-proven"),
            "installedDiscovery": discovery,
        },
        "packages": {
            "full": {
                "packageRoot": full["packageRoot"],
                "bundleRoot": full["manifest"]["bundleRoot"],
                "verifierRoot": full_verification["reportRoot"],
                "verdict": full_verification["verdict"],
            },
            "thin": {
                "packageRoot": thin["packageRoot"],
                "bundleRoot": thin["manifest"]["bundleRoot"],
                "verifierRoot": thin_verification["reportRoot"],
                "verdict": thin_verification["verdict"],
                "omissions": thin_verification["omissions"],
            },
        },
        "import": {
            "previewReceiptRoot": preview["receiptRoot"],
            "executeReceiptRoot": imported["receiptRoot"],
            "retryReceiptRoot": retried["receiptRoot"],
            "sourceDestinationExact": True,
            "sourceStateRoot": _root(
                "exact-state",
                {key: source_state[key] for key in destination_state},
            ),
            "destinationStateRoot": _root("exact-state", destination_state),
        },
        "installedCli": {
            "entry": "kungfu",
            "agentWorkInspectStatus": cli_work["status"],
            "agentWorkCutRoot": cli_work["cutRoot"],
            "factFsckOk": cli_fact_fsck["ok"],
            "exitInspectStatus": cli_exit["status"],
            "exitPackageRoot": cli_exit["packageRoot"],
        },
        "fsckAndRebuild": {
            "factFsckOk": fact_fsck["ok"],
            "storageFsckBeforeOk": storage_fsck_before["ok"],
            "deletedDerivedProjections": deleted,
            "projectionLossVisible": storage_fsck_without_projection["ok"] is not True
            or bool(storage_fsck_without_projection.get("issues")),
            "storageRebuild": {
                "ok": storage_rebuild["ok"],
                "written": storage_rebuild["written"],
                "rebuiltFrom": storage_rebuild["rebuilt_from"],
                "projections": [
                    {
                        "name": row["name"],
                        "ok": row["detail"]["ok"],
                        "written": row["written"],
                    }
                    for row in storage_rebuild["projections"]
                ],
            },
            "episodeRebuild": {
                key: episode_rebuild[key]
                for key in ("ok", "authority", "projection", "query_records")
            },
            "factRebuild": {
                key: fact_rebuild[key]
                for key in (
                    "ok",
                    "mode",
                    "before_root",
                    "after_root",
                    "projection_count",
                    "write_occurred",
                )
            },
            "storageFsckAfterOk": storage_fsck_after["ok"],
            "authorityUnchanged": True,
        },
        "continuation": {
            "input": {
                "packageRoot": full["packageRoot"],
                "importReceiptRoot": imported["receiptRoot"],
                "cutRoot": destination_work["cutRoot"],
                "revision": destination_work["revision"],
                "installedDiscoveryRoot": _root("discovery", discovery),
            },
            "receiptRoot": continuation["kernelReceiptRoot"],
            "resultCutRoot": continuation["result"]["cutRoot"],
            "resultRevision": continuation["result"]["revision"],
            "boundedSteps": 1,
            "chatContextUsed": False,
        },
        "faultCampaign": faults,
        "capabilities": full["manifest"]["capabilities"],
        "bounds": {
            "durationMs": duration_ms,
            "maximumResidentKiB": _maximum_resident_kib(),
            "packageBytes": {
                "full": args.full.stat().st_size,
                "thin": args.thin.stat().st_size,
            },
        },
        "releaseMatrix": [
            {
                "platform": f"{platform.system().lower()}-{platform.machine().lower()}",
                "artifactDigest": args.artifact_digest,
                "verdict": "qualified",
            },
            {
                "platform": "linux-x86_64",
                "artifactDigest": None,
                "verdict": "unqualified-no-artifact-evidence",
            },
            {
                "platform": "windows-x86_64",
                "artifactDigest": None,
                "verdict": "unqualified-no-artifact-evidence",
            },
        ],
        "knownLimits": [
            "This report qualifies one official macOS CLI artifact only.",
            "GUI/TUI parity, independent verifier implementation, third-party readers, distributed recovery, and physical-media durability are not claimed.",
            "The network claim is bounded to the named OS or process sandbox used by the orchestrator.",
        ],
    }
    if not all(
        (
            report["fsckAndRebuild"]["factFsckOk"],
            report["fsckAndRebuild"]["storageFsckBeforeOk"],
            report["fsckAndRebuild"]["projectionLossVisible"],
            report["fsckAndRebuild"]["storageFsckAfterOk"],
        )
    ):
        raise AssertionError(report["fsckAndRebuild"])
    report["reportRoot"] = _root("report", report)
    _write(args.report, report)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("source", "destination"))
    parser.add_argument("--product-root", type=Path, required=True)
    parser.add_argument("--work-root", type=Path, required=True)
    parser.add_argument("--artifact-digest", required=True)
    parser.add_argument("--artifact-name", required=True)
    parser.add_argument("--full", type=Path, required=True)
    parser.add_argument("--thin", type=Path, required=True)
    parser.add_argument("--handoff", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    args.product_root = args.product_root.resolve()
    args.work_root = args.work_root.resolve()
    if args.phase == "source":
        return source_phase(args)
    return destination_phase(args)


if __name__ == "__main__":
    raise SystemExit(main())
