# SPDX-License-Identifier: Apache-2.0

"""Installed, agent-facing authoring layer for KFX Profile Suites.

This module owns no lifecycle state and no Profile schema.  It resolves source
packages, computes content roots, and delegates every lifecycle decision and
mutation to the Core service introduced by KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.
"""

from __future__ import annotations

import hashlib
import base64
import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from functools import partial
from pathlib import Path
from typing import Any, Iterator, Mapping

from kungfu import agent as agent_pack
from kungfu import runtime_broker
from kungfu import kfx_contract
from kungfu.storage import service as storage_service
from kungfu.profile_sdk_support import (
    ACTION_PLAN_SCHEMA as ACTION_PLAN_SCHEMA,
    ACTION_RECEIPT_SCHEMA as ACTION_RECEIPT_SCHEMA,
    ACTION_REGISTRY_SCHEMA as ACTION_REGISTRY_SCHEMA,
    BRIEF_SCHEMA as BRIEF_SCHEMA,
    COLLABORATION_SCHEMA as COLLABORATION_SCHEMA,
    DECISION_ANSWER_SCHEMA as DECISION_ANSWER_SCHEMA,
    DECISION_CARD_SCHEMA as DECISION_CARD_SCHEMA,
    DIAGNOSIS_SCHEMA as DIAGNOSIS_SCHEMA,
    INTENT_PLAN_SCHEMA as INTENT_PLAN_SCHEMA,
    INTENT_RECEIPT_SCHEMA as INTENT_RECEIPT_SCHEMA,
    KFD3_QUALIFICATION_PLAN_SCHEMA as KFD3_QUALIFICATION_PLAN_SCHEMA,
    KFD3_QUALIFICATION_RECEIPT_SCHEMA as KFD3_QUALIFICATION_RECEIPT_SCHEMA,
    KFD3_RELEASE_MANIFEST_SCHEMA as KFD3_RELEASE_MANIFEST_SCHEMA,
    KFD3_WITNESS_SCHEMA as KFD3_WITNESS_SCHEMA,
    SDK_SCHEMA as SDK_SCHEMA,
    SOURCE_IMPORT_PLAN_SCHEMA as SOURCE_IMPORT_PLAN_SCHEMA,
    SOURCE_PLAN_SCHEMA as SOURCE_PLAN_SCHEMA,
    ProfileSdkError as ProfileSdkError,
    _IGNORED_PARTS as _IGNORED_PARTS,
    _TOKEN as _TOKEN,
    _canonical as _canonical,
    _changes as _changes,
    command_contract as _command_contract,
    _confined as _confined,
    _portable_source_paths as _portable_source_paths,
    _pretty as _pretty,
    _root as _root,
    _sha256 as _sha256,
    _validate_sdk_value as _validate_sdk_value,
    _validate_source_bundle as _validate_source_bundle,
    decision_card as decision_card,
)
from kungfu.profile_sdk_source import (
    _collaboration_closure as _collaboration_closure,
    _read_ref_json as _read_ref_json,
    _source_files as _source_files,
    _validate_action_registry as _validate_action_registry,
    package_content_root as package_content_root,
    resolve_profile_source as _resolve_profile_source,
)
from kungfu.profile_sdk_kfd3 import (
    Kfd3Operations as Kfd3Operations,
    _agent_interface_authority as _agent_interface_authority,
    _earn_kfd3 as _earn_kfd3_impl,
    _profile_facet_audit as _profile_facet_audit,
    _release_qualification_receipt as _release_qualification_receipt,
    _shared_api_release_audit as _shared_api_release_audit,
    _validate_kfd3_receipt_integrity as _validate_kfd3_receipt_integrity,
    authorize_kfd3_qualification as _authorize_kfd3_qualification,
    build_kfd3_release_manifest as _build_kfd3_release_manifest,
    kfd3_qualification_plan as _kfd3_qualification_plan,
    kfd3_status as _kfd3_status,
    qualify_kfd3 as _qualify_kfd3,
    verify_kfd3 as _verify_kfd3,
)

SOURCE_BUNDLE_SCHEMA = "kungfu.profile-source-bundle/v1"

_VALIDATION_SCOPE: ContextVar[dict[tuple[str, str], dict[str, Any]] | None] = (
    ContextVar("kungfu_profile_validation_scope", default=None)
)


@contextmanager
def validation_scope() -> Iterator[None]:
    """Reuse exact source validation inside one bounded product transaction.

    Profile source packages are immutable inputs for the duration of this
    scope. Runtime lifecycle and Fact state may still change: callers that need
    those folds continue to read them from their owning services. Nested scopes
    deliberately share one cache, while every later command starts from an
    empty scope and therefore revalidates source bytes and conformance.
    """

    current = _VALIDATION_SCOPE.get()
    if current is not None:
        yield
        return
    token = _VALIDATION_SCOPE.set({})
    try:
        yield
    finally:
        _VALIDATION_SCOPE.reset(token)


def _work_profile_conformance_script() -> Path | None:
    relative = Path("framework/work-profile-conformance/work-profile-conformance.mjs")
    roots = (*Path(__file__).resolve().parents, *Path.cwd().resolve().parents)
    candidates = (
        Path(__file__).resolve().parent
        / "work_profile_conformance/work-profile-conformance.mjs",
        *(parent / relative for parent in roots),
    )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def _work_profile_conformance_invocation(
    checker: Path,
) -> tuple[list[str], dict[str, str] | None]:
    for variable in (
        "KUNGFU_CONTROLLER_ENTRYPOINT",
        "KUNGFU_AGENT_SESSION_EXECUTABLE",
    ):
        value = os.environ.get(variable)
        embedded = Path(value).expanduser().resolve() if value else None
        if embedded is not None and embedded.is_file():
            environment = os.environ.copy()
            environment["KUNGFU_AS_VARIANT"] = "node"
            environment["KUNGFU_NODE_VARIANT_ENTRY"] = str(checker)
            return [str(embedded), str(checker)], environment
    if node := shutil.which("node"):
        return [node, str(checker)], None
    message = "Work Profile conformance checker is unavailable"
    raise ProfileSdkError("work-profile-conformance-checker-unavailable", message)


def _work_profile_conformance(
    inspection: Mapping[str, Any], surface: str
) -> dict[str, Any] | None:
    work = inspection["profile"].get("work")
    declaration_ref = work.get("conformance") if isinstance(work, Mapping) else None
    if declaration_ref is None and inspection.get("work_capable"):
        raise ProfileSdkError(
            "work-profile-conformance-required",
            "Work-capable Profile requires exact Work conformance",
        )
    if declaration_ref is None:
        return None
    if not isinstance(declaration_ref, Mapping):
        raise ProfileSdkError(
            "work-profile-conformance-ref-invalid",
            "Profile work.conformance must be a content reference",
        )
    declaration_path = _confined(
        Path(str(inspection["profile_path"])).parent,
        str(declaration_ref.get("path") or ""),
    )
    expected = str(declaration_ref.get("sha256") or "")
    if expected != (actual := _sha256(declaration_path.read_bytes())):
        raise ProfileSdkError(
            "work-profile-conformance-root-mismatch",
            "Profile Work conformance declaration root mismatch",
            expected=expected,
            actual=actual,
        )
    checker = _work_profile_conformance_script()
    if checker is None:
        raise ProfileSdkError(
            "work-profile-conformance-checker-unavailable",
            "Work Profile conformance checker is unavailable",
        )
    command, environment = _work_profile_conformance_invocation(checker)
    completed = subprocess.run(
        [
            *command,
            "--declaration",
            str(declaration_path),
            "--surface",
            surface,
            "--json",
        ],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )
    if completed.returncode != 0:
        try:
            failed = json.loads(completed.stdout)
        except json.JSONDecodeError:
            failed = None
        raise ProfileSdkError(
            "work-profile-conformance-denied",
            completed.stderr.strip()
            or (
                f"Work Profile conformance denied: {failed.get('verdict')}"
                if failed
                else "Work Profile conformance checker failed"
            ),
            result=failed,
        )
    result = json.loads(completed.stdout)
    result["publicSurface"] = surface
    return result


def capabilities() -> dict[str, Any]:
    sdk_contract = agent_pack.profile_sdk_contract()
    contract_bytes = agent_pack.document_text("profile-sdk.contract.json").encode(
        "utf-8"
    )
    lifecycle_authority = storage_service.profile_lifecycle("", "contract")
    sdk_authority = {
        "schema": sdk_contract["schema"],
        "id": sdk_contract["id"],
        "version": sdk_contract["version"],
        "root": "sha256:" + _sha256(contract_bytes),
    }
    lifecycle_command_contract = _command_contract(
        lifecycle_authority,
        sdk_authority,
        agent_pack.cli_surface_catalog(),
    )
    return {
        "schema": SDK_SCHEMA,
        "contract": kfx_contract.contract_metadata(),
        "profileSchema": kfx_contract.profile_suite_schema(),
        "sdkContract": sdk_authority,
        "schemas": {
            "brief": sdk_contract["briefSchema"],
            "decisionCard": sdk_contract["decisionCardSchema"],
            "decisionAnswer": sdk_contract["decisionAnswerSchema"],
            "actionRegistry": sdk_contract["actionRegistrySchema"],
            "contractWorld": sdk_contract["contractWorldSchema"],
            "factSurfaces": sdk_contract["factSurfacesSchema"],
            "claims": sdk_contract["claimsSchema"],
            "assessmentPolicies": sdk_contract["assessmentPoliciesSchema"],
            "views": sdk_contract["viewsSchema"],
            "collaboration": sdk_contract["collaborationSchema"],
            "kfd3QualificationReceipt": sdk_contract["kfd3QualificationReceiptSchema"],
            "kfd3Witness": sdk_contract["kfd3WitnessSchema"],
            "sourceBundle": sdk_contract["sourceBundleSchema"],
            "workProfileConformanceDeclaration": (
                "kungfu.work-profile-conformance-declaration/v1"
            ),
            "workProfileConformanceResult": (
                "kungfu.work-profile-conformance-result/v1"
            ),
        },
        "sourcePlanSchema": SOURCE_PLAN_SCHEMA,
        "actionRegistrySchema": ACTION_REGISTRY_SCHEMA,
        "lifecycleAuthority": lifecycle_authority,
        "lifecycleCommandContract": lifecycle_command_contract,
        "operations": [
            "capabilities",
            "examples",
            "discover",
            "scaffold",
            "validate",
            "qualify",
            "collaboration",
            "application",
            "kfd3-status",
            "kfd3-plan",
            "kfd3-authorize",
            "kfd3-qualify",
            "kfd3-verify",
            "intent-inspect",
            "intent-advise",
            "intent-plan",
            "intent-apply",
            "intent-verify",
            "plan",
            "decide",
            "apply",
            "inspect",
            "list",
            "history",
            "diff",
            "actions",
            "invoke-plan",
            "invoke",
            "member-call",
            "catalog",
            "query-plan",
            "query-run",
            "query-execute",
            "contract-plan",
            "contract-apply",
            "assess-plan",
            "assess-run",
            "assessment-plan",
            "assessment-authorize",
            "manager",
            "authorize-lifecycle",
            "lifecycle-command-contract",
            "export",
            "import",
        ],
        "customMemberBuild": {
            "command": "kungfu sdk kfx build",
            "rebuildsProduct": False,
        },
        "authorityBoundaries": {
            "schema": "embedded-kfx-contract",
            "memberRoots": "resolved-package-bytes",
            "lifecycle": "libkungfu-profile-lifecycle",
            "authorization": "external-explicit-decision",
            "selfCertification": False,
            "workConformance": (
                "required content-bound work.conformance for Work-capable Profiles; "
                "validate and qualify project one checker result"
            ),
        },
    }


def lifecycle_command_contract() -> dict[str, Any]:
    """Return the same installed command contract projected by capabilities."""

    return capabilities()["lifecycleCommandContract"]


def examples() -> dict[str, Any]:
    return {
        "schema": "kungfu.profile-examples/v1",
        "brief": {
            "schema": BRIEF_SCHEMA,
            "id": "example.week-day",
            "title": "Week / Day",
            "version": "1.0.0",
            "purposes": ["handoff", "operator-review"],
            "permissions": [],
            "identity": {"authority": "workspace-owner"},
            "evidence": {"strength": "reported-with-references"},
            "migration": {"mode": "additive"},
        },
        "flow": [
            "kungfu profile scaffold brief.json --out ./week-day --json",
            "kungfu profile scaffold brief.json --out ./week-day --execute --json",
            "kungfu profile validate ./week-day --json",
            "kungfu profile qualify ./week-day --json",
            "kungfu profile plan install ./week-day --json",
        ],
    }


def discover_source(
    profile_id: str,
    runtime_dir: str | Path = "",
    *,
    search_roots: list[str | Path] | None = None,
) -> dict[str, Any]:
    """Resolve one Profile Suite by semantic id across installed extension roots."""

    roots = [Path(value).expanduser() for value in (search_roots or [])]
    if not search_roots:
        roots.extend(
            Path(value).expanduser()
            for value in os.environ.get("KF_EXTENSION_PATH", "").split(os.pathsep)
            if value
        )
        if runtime_dir:
            roots.append(Path(runtime_dir).expanduser().resolve().parent / "extensions")
    matches = []
    seen = set()
    for root in roots:
        resolved_root = root.resolve()
        if resolved_root in seen or not resolved_root.is_dir():
            continue
        seen.add(resolved_root)
        candidates = [resolved_root]
        candidates.extend(path for path in resolved_root.iterdir() if path.is_dir())
        for parent in list(candidates[1:]):
            candidates.extend(path for path in parent.iterdir() if path.is_dir())
        for candidate in candidates:
            manifest_path = candidate / kfx_contract.PACKAGE_MANIFEST_FILE
            if not manifest_path.is_file():
                continue
            try:
                manifest = kfx_contract.read_manifest_from_dir(str(candidate))
                suite = (manifest.get("kungfuConfig") or {}).get("suite") or {}
                profile_path = _confined(candidate, str(suite.get("profile") or ""))
                profile = json.loads(profile_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if profile.get("id") == profile_id:
                matches.append(candidate.resolve())
    unique = sorted(set(matches), key=lambda path: str(path).encode("utf-8"))
    if len(unique) != 1:
        raise ProfileSdkError(
            "profile-source-unresolved" if not unique else "profile-source-ambiguous",
            "Profile source must resolve exactly once across extension roots",
            profileId=profile_id,
            searchRoots=[str(path.resolve()) for path in roots],
            matches=[str(path) for path in unique],
            decisionCards=[
                decision_card(
                    "profile-source-selection",
                    "Select one exact Profile Suite source.",
                    choices=["supply-source-path", "repair-extension-roots"],
                    basis={
                        "profileId": profile_id,
                        "matches": [str(path) for path in unique],
                    },
                    required_authority="workspace-profile-operator",
                    resume_command="rerun with one exact Profile source path",
                )
            ],
        )
    resolved = resolve_source(unique[0])
    return {
        "schema": "kungfu.profile-source-discovery/v1",
        "profileId": profile_id,
        "source": str(unique[0]),
        "profileSuiteRoot": validate_source(unique[0], runtime_dir)["inspection"][
            "profile_suite_root"
        ],
        "memberRoots": resolved["memberRoots"],
    }


def validate_contract_artifact(schema_key: str, value: Any, label: str) -> None:
    """Validate an Agent Profile SDK edge artifact against the installed pack."""

    _validate_sdk_value(schema_key, value, label)


def validate_decision_answer(
    answer: Mapping[str, Any], card: Mapping[str, Any]
) -> None:
    """Verify an external decision answer against one exact installed card."""

    _validate_decision_answer(answer, card)


def scaffold_plan(brief: Mapping[str, Any], out: str | Path) -> dict[str, Any]:
    normalized, cards = _normalize_brief(brief)
    out_path = Path(out).expanduser().resolve()
    if out_path.exists() and any(
        out_path.iterdir() if out_path.is_dir() else [out_path]
    ):
        cards.append(
            decision_card(
                "profile-source-collision",
                "The requested Profile source destination is not empty.",
                choices=["choose-an-empty-directory", "inspect-and-merge-manually"],
                basis={"destination": str(out_path)},
                required_authority="workspace-owner",
                resume_command="kungfu profile scaffold <brief.json> --out <empty-dir> --json",
            )
        )
    if cards:
        return {
            "schema": SOURCE_PLAN_SCHEMA,
            "ok": False,
            "status": "needs-decision",
            "destination": str(out_path),
            "decisionCards": cards,
            "writes": [],
        }
    files = _source_files(normalized)
    identity = _source_plan_identity(normalized, str(out_path), files)
    return {
        "schema": SOURCE_PLAN_SCHEMA,
        "ok": True,
        "status": "ready",
        "planId": _root(identity),
        "destination": str(out_path),
        "normalizedBrief": normalized,
        "writes": identity["files"],
        "files": {path: data.decode("utf-8") for path, data in files.items()},
        "selfCertifiedFields": [],
        "requiresExecute": True,
    }


def apply_scaffold(plan: Mapping[str, Any]) -> dict[str, Any]:
    if plan.get("schema") != SOURCE_PLAN_SCHEMA or not plan.get("ok"):
        raise ProfileSdkError(
            "source-plan-invalid", "scaffold requires a ready source plan"
        )
    destination = Path(str(plan["destination"]))
    if destination.exists() and any(
        destination.iterdir() if destination.is_dir() else [destination]
    ):
        raise ProfileSdkError(
            "source-plan-stale",
            "Profile source destination changed after planning",
            destination=str(destination),
        )
    files = plan.get("files")
    if not isinstance(files, Mapping):
        raise ProfileSdkError("source-plan-invalid", "source plan has no file material")
    if not all(
        isinstance(path, str) and isinstance(text, str) for path, text in files.items()
    ):
        raise ProfileSdkError(
            "source-plan-invalid", "source plan files must be UTF-8 text entries"
        )
    material = {path: text.encode("utf-8") for path, text in files.items()}
    identity = _source_plan_identity(
        plan.get("normalizedBrief"), str(destination), material
    )
    if _root(identity) != plan.get("planId") or plan.get("writes") != identity["files"]:
        raise ProfileSdkError(
            "source-plan-tampered",
            "source plan material no longer matches its identity",
        )
    written = []
    for relative, text in sorted(files.items()):
        target = _confined(destination, str(relative))
        target.parent.mkdir(parents=True, exist_ok=True)
        # The plan identity binds exact UTF-8 bytes.  Path.write_text() applies
        # platform newline translation on Windows, which would mutate those
        # bytes after they were hashed and make the scaffold fail its own
        # content-closure checks.
        target.write_bytes(text.encode("utf-8"))
        written.append(str(target))
    return {
        "schema": "kungfu.profile-source-receipt/v1",
        "planId": plan["planId"],
        "destination": str(destination),
        "written": written,
        "verified": all(
            Path(path).is_file() and _sha256(Path(path).read_bytes()) == row["sha256"]
            for path, row in zip(written, identity["files"], strict=True)
        ),
    }


resolve_source = partial(_resolve_profile_source, decision_factory=decision_card)


def invoke_member_adapter(
    source: str | Path,
    runtime_dir: str | Path,
    member_id: str,
    operation: str,
    input_value: Any,
    *,
    authorized_action: bool = False,
) -> dict[str, Any]:
    """Invoke one exact-root Profile member through its declared Python adapter.

    Core owns resolution, root binding and the transport envelope.  The member
    owns every domain operation and result schema behind ``invoke``.
    """

    if not _TOKEN.fullmatch(member_id) or not _TOKEN.fullmatch(operation):
        raise ProfileSdkError(
            "member-adapter-request-invalid",
            "member and operation must be safe Profile tokens",
        )
    validated = validate_source(source, runtime_dir)
    resolved = validated["source"]
    profile_suite_root = validated["inspection"]["profile_suite_root"]
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir,
            "get",
            profile_id=resolved["profile"]["id"],
        )
    except (KeyError, ValueError) as error:
        raise ProfileSdkError(
            "profile-not-active",
            "Profile member adapters require an active exact Profile root",
        ) from error
    if (
        not state.get("activated")
        or state.get("profile_suite_root") != profile_suite_root
    ):
        raise ProfileSdkError(
            "profile-not-active",
            "Profile member adapters require an active exact Profile root",
        )
    package_value = (resolved.get("memberPackages") or {}).get(member_id)
    if not package_value:
        raise ProfileSdkError(
            "member-adapter-not-found",
            f"Profile member is not present in this Suite: {member_id}",
        )
    package_dir = Path(str(package_value)).resolve()
    manifest = kfx_contract.read_manifest_from_dir(str(package_dir))
    config = (manifest.get("kungfuConfig") or {}).get("config") or {}
    adapter = config.get("adapter") or {}
    if "python" not in (adapter.get("runtimes") or []):
        raise ProfileSdkError(
            "member-adapter-not-declared",
            f"Profile member has no declared Python adapter: {member_id}",
        )
    entry = str((adapter.get("entry") or {}).get("python") or "")
    if not entry:
        raise ProfileSdkError(
            "member-adapter-not-declared",
            f"Profile member has no Python adapter entry: {member_id}",
        )
    entry_path = _confined(package_dir, entry)
    if not entry_path.is_file():
        raise ProfileSdkError(
            "member-adapter-entry-missing",
            f"Profile member adapter entry is missing: {entry}",
        )
    expected_root = (resolved.get("memberRoots") or {}).get(member_id)
    actual_root = package_content_root(package_dir)
    if expected_root != actual_root:
        raise ProfileSdkError(
            "member-adapter-root-mismatch",
            "Profile member bytes changed after Suite resolution",
            expectedMemberRoot=expected_root,
            actualMemberRoot=actual_root,
        )
    module_name = (
        "kungfu_profile_member_"
        + hashlib.sha256(f"{actual_root}:{entry}".encode("utf-8")).hexdigest()
    )
    spec = importlib.util.spec_from_file_location(module_name, entry_path)
    if spec is None or spec.loader is None:
        raise ProfileSdkError(
            "member-adapter-load-failed", "Profile member adapter cannot be loaded"
        )
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        invoke = getattr(module, "invoke")
        result = invoke(
            operation,
            runtime_dir=str(Path(runtime_dir).expanduser().resolve()),
            input_value=input_value,
            context={
                "profileId": resolved["profile"]["id"],
                "profileSuiteRoot": profile_suite_root,
                "memberId": member_id,
                "memberRoot": actual_root,
                "source": resolved["source"],
                "invocationMode": (
                    "authorized-action" if authorized_action else "projection-read"
                ),
            },
        )
        json.dumps(result)
    except ProfileSdkError:
        raise
    except (
        AttributeError,
        ImportError,
        KeyError,
        OSError,
        RuntimeError,
        SyntaxError,
        TypeError,
        ValueError,
    ) as error:
        raise ProfileSdkError("member-adapter-invoke-failed", str(error)) from error
    return {
        "schema": "kungfu.profile-member-receipt/v1",
        "profileId": resolved["profile"]["id"],
        "profileSuiteRoot": profile_suite_root,
        "memberId": member_id,
        "memberRoot": actual_root,
        "operation": operation,
        "source": resolved["source"],
        "result": result,
    }


def load_member_python_package(source: str | Path, member_id: str, package: str):
    """Load a content-bound Python package owned by one Profile member.

    This is the domain-neutral equivalent of the adapter loader: resolution
    stays inside the declared member package and the module name is derived
    from its content root. It deliberately grants no lifecycle authority.
    """

    if not _TOKEN.fullmatch(member_id) or not _TOKEN.fullmatch(package):
        raise ProfileSdkError(
            "member-package-request-invalid",
            "member and package must be safe Profile tokens",
        )
    resolved = resolve_source(source)
    package_value = (resolved.get("memberPackages") or {}).get(member_id)
    if not package_value:
        raise ProfileSdkError(
            "member-package-not-found",
            f"Profile member is not present in this Suite: {member_id}",
        )
    member_dir = Path(str(package_value)).resolve()
    expected_root = (resolved.get("memberRoots") or {}).get(member_id)
    actual_root = package_content_root(member_dir)
    if expected_root != actual_root:
        raise ProfileSdkError(
            "member-package-root-mismatch",
            "Profile member bytes changed after Suite resolution",
            expectedMemberRoot=expected_root,
            actualMemberRoot=actual_root,
        )
    package_dir = _confined(member_dir, package)
    entry_path = package_dir / "__init__.py"
    if not entry_path.is_file():
        raise ProfileSdkError(
            "member-package-entry-missing",
            f"Profile member Python package is missing: {package}",
        )
    module_name = (
        "kungfu_profile_package_"
        + hashlib.sha256(
            f"{actual_root}:{member_id}:{package}".encode("utf-8")
        ).hexdigest()
    )
    loaded = sys.modules.get(module_name)
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location(
        module_name,
        entry_path,
        submodule_search_locations=[str(package_dir)],
    )
    if spec is None or spec.loader is None:
        raise ProfileSdkError(
            "member-package-load-failed", "Profile member package cannot be loaded"
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return module


def validate_source(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    scoped = _VALIDATION_SCOPE.get()
    cache_key = (
        str(Path(source).expanduser().resolve()),
        str(Path(runtime_dir).expanduser().resolve()),
    )
    if scoped is not None and cache_key in scoped:
        return copy.deepcopy(scoped[cache_key])
    resolved = resolve_source(source)
    inspection = storage_service.profile_lifecycle(
        runtime_dir,
        "inspect",
        profile_path=resolved["profilePath"],
        member_roots=resolved["memberRoots"],
    )
    collaboration = _collaboration_closure(inspection)
    work_conformance = _work_profile_conformance(inspection, "validate")
    result = {
        "schema": "kungfu.profile-validation/v1",
        "source": resolved,
        "inspection": inspection,
        "collaboration": collaboration,
        "workConformance": work_conformance,
        "ok": True,
    }
    if scoped is not None:
        scoped[cache_key] = copy.deepcopy(result)
    return result


def collaboration(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    """Return the installed, content-bound KFD-3 declaration closure."""

    return validate_source(source, runtime_dir)["collaboration"]


def application(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    include_qualification: bool = True,
) -> dict[str, Any]:
    """Project one declared collaboration closure for generic Human/Agent use."""

    validated = validate_source(source, runtime_dir)
    closure = validated["collaboration"]
    if not closure["declared"]:
        raise ProfileSdkError(
            "collaboration-not-declared",
            "Profile has no collaboration interface to project",
        )
    inspection = validated["inspection"]
    profile = inspection["profile"]
    actions = _read_ref_json(inspection, profile["actions"]["registry"])["actions"]
    views = _read_ref_json(inspection, profile["views"]["registry"])["views"]
    actions_by_id = {row["id"]: row for row in actions}
    views_by_id = {row["id"]: row for row in views}
    try:
        state = storage_service.profile_lifecycle(
            runtime_dir, "get", profile_id=profile["id"]
        )
    except ValueError as error:
        if not str(error).startswith("Profile not found:"):
            raise
        state = None
    active_exact_root = bool(
        state
        and state.get("activated")
        and state.get("profile_suite_root") == inspection["profile_suite_root"]
    )
    granted = sorted((state or {}).get("granted_permissions", []))
    intents = []
    for intent in closure["intents"]:
        intents.append(
            {
                **intent,
                "action": actions_by_id[intent["actionId"]],
                "inspectView": views_by_id[intent["inspectViewId"]],
                "verifyView": views_by_id[intent["verifyViewId"]],
                "missingCapabilities": sorted(
                    set(intent["requiredCapabilities"]) - set(granted)
                ),
            }
        )
    qualification_status: dict[str, Any] = {
        "qualified": False,
        "status": "untested",
        "current": False,
        "reason": "Profile KFD-3 qualification has not been tested",
        "nextActions": [],
    }
    if include_qualification:
        qualification_status = kfd3_status(source, runtime_dir)
    return {
        "schema": "kungfu.profile-application/v1",
        "profileId": profile["id"],
        "profileSuiteRoot": inspection["profile_suite_root"],
        "collaborationRoot": closure["collaborationRoot"],
        "closureRoot": closure["closureRoot"],
        "source": str(Path(source).resolve()),
        "activeExactRoot": active_exact_root,
        "profileRevision": (state or {}).get("revision"),
        "grantedCapabilities": granted,
        "value": closure["value"],
        "participants": closure["participants"],
        "constraints": closure["constraints"],
        "knownLimits": closure["knownLimits"],
        "intents": intents,
        "presentation": {"mode": "generic"},
        "protocol": closure["protocol"],
        "qualified": qualification_status["qualified"],
        "qualification": qualification_status,
    }


def intent_inspect(
    source: str | Path, runtime_dir: str | Path, intent_id: str
) -> dict[str, Any]:
    projection = application(source, runtime_dir, include_qualification=False)
    intent = next(
        (row for row in projection["intents"] if row["id"] == intent_id), None
    )
    if intent is None:
        raise ProfileSdkError(
            "collaboration-intent-not-found", f"intent not found: {intent_id}"
        )
    return {
        "schema": "kungfu.profile-intent-inspection/v1",
        "profileId": projection["profileId"],
        "profileSuiteRoot": projection["profileSuiteRoot"],
        "collaborationRoot": projection["collaborationRoot"],
        "closureRoot": projection["closureRoot"],
        "source": projection["source"],
        "profileRevision": projection["profileRevision"],
        "activeExactRoot": projection["activeExactRoot"],
        "intent": intent,
        "cut": {
            "kind": "profile-revision",
            "value": projection["profileRevision"],
        },
    }


def intent_advise(
    source: str | Path, runtime_dir: str | Path, intent_id: str
) -> dict[str, Any]:
    inspected = intent_inspect(source, runtime_dir, intent_id)
    intent = inspected["intent"]
    application_value = application(source, runtime_dir, include_qualification=False)
    constraints = [
        row
        for row in application_value["constraints"]
        if "*" in row["appliesTo"] or intent_id in row["appliesTo"]
    ]
    eligible = inspected["activeExactRoot"] and not intent["missingCapabilities"]
    return {
        "schema": "kungfu.profile-intent-advice/v1",
        "profileId": inspected["profileId"],
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
        "source": inspected["source"],
        "intentId": intent_id,
        "eligible": eligible,
        "recommendation": "preview" if eligible else "resolve-preconditions",
        "constraints": constraints,
        "knownLimits": application_value["knownLimits"],
        "missingCapabilities": intent["missingCapabilities"],
        "preconditions": {
            "activeExactRoot": inspected["activeExactRoot"],
            "profileRevision": inspected["profileRevision"],
        },
    }


def intent_plan(
    source: str | Path,
    runtime_dir: str | Path,
    intent_id: str,
    input_value: Any,
) -> dict[str, Any]:
    advice = intent_advise(source, runtime_dir, intent_id)
    if not advice["eligible"]:
        raise ProfileSdkError(
            "intent-precondition-failed",
            "intent cannot be previewed until its active-root and capability preconditions hold",
            advice=advice,
        )
    inspected = intent_inspect(source, runtime_dir, intent_id)
    action_plan = plan_action(
        source, runtime_dir, inspected["intent"]["actionId"], input_value
    )
    identity = {
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
        "intentId": intent_id,
        "actionPlanId": action_plan["planId"],
        "input": input_value,
    }
    return {
        "schema": INTENT_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "source": inspected["source"],
        "actionPlan": action_plan,
        "decisionCard": action_plan.get("decisionCard"),
        "protocolStage": "preview",
    }


def intent_apply(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if plan.get("schema") != INTENT_PLAN_SCHEMA:
        raise ProfileSdkError(
            "intent-plan-invalid", "intent apply requires an intent plan"
        )
    refreshed = intent_plan(
        str(plan.get("source") or ""),
        runtime_dir,
        str(plan.get("intentId") or ""),
        plan.get("input"),
    )
    if refreshed["planId"] != plan.get("planId"):
        raise ProfileSdkError("intent-plan-stale", "intent plan changed after preview")
    action_receipt = authorized_action_invoke(
        runtime_dir, plan.get("actionPlan") or {}, answer
    )
    identity = {
        "planId": plan["planId"],
        "actionPlanId": plan["actionPlanId"],
        "profileSuiteRoot": plan["profileSuiteRoot"],
        "collaborationRoot": plan["collaborationRoot"],
        "closureRoot": plan["closureRoot"],
        "intentId": plan["intentId"],
        "actionReceipt": action_receipt,
    }
    return {
        "schema": INTENT_RECEIPT_SCHEMA,
        "receiptId": _root(identity),
        **identity,
        "source": plan["source"],
        "protocolStage": "receipt",
        "executionReceiptVerified": action_receipt["verified"],
        "verified": False,
    }


def intent_verify(
    source: str | Path, runtime_dir: str | Path, receipt: Mapping[str, Any]
) -> dict[str, Any]:
    if receipt.get("schema") != INTENT_RECEIPT_SCHEMA:
        raise ProfileSdkError(
            "intent-receipt-invalid", "verify requires an intent receipt"
        )
    inspected = intent_inspect(source, runtime_dir, str(receipt.get("intentId") or ""))
    current = {
        "profileSuiteRoot": inspected["profileSuiteRoot"],
        "collaborationRoot": inspected["collaborationRoot"],
        "closureRoot": inspected["closureRoot"],
    }
    expected = {key: receipt.get(key) for key in current}
    if current != expected:
        raise ProfileSdkError(
            "intent-receipt-stale",
            "Profile or collaboration closure changed after execution",
            expected=expected,
            actual=current,
        )
    action_receipt = receipt.get("actionReceipt") or {}
    verified = bool(
        receipt.get("executionReceiptVerified")
        and action_receipt.get("verified")
        and action_receipt.get("planId") == receipt.get("actionPlanId")
    )
    if not verified:
        raise ProfileSdkError(
            "intent-execution-unverified", "underlying action receipt is not verified"
        )
    return {
        "schema": "kungfu.profile-intent-verification/v1",
        "receiptId": receipt["receiptId"],
        **current,
        "intentId": receipt["intentId"],
        "verifyView": inspected["intent"]["verifyView"],
        "protocolStage": "verify",
        "verified": True,
        "evidenceScope": "profile-root/collaboration-root/execution-receipt/declared-verify-view",
        "knownLimit": "declared verify view is bound but domain outcome truth remains evidence-dependent",
    }


def authorize_current_intent(
    runtime_dir: str | Path,
    source: str | Path,
    intent_id: str,
    input_value: Any,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    plan = intent_plan(source, runtime_dir, intent_id, input_value)
    if plan["planId"] != expected_plan_id:
        raise ProfileSdkError(
            "intent-plan-stale",
            "intent plan changed; review a fresh preview",
            expectedPlanId=expected_plan_id,
            actualPlanId=plan["planId"],
        )
    answer = answer_decision(plan["decisionCard"], choice, authorized_by)
    receipt = intent_apply(runtime_dir, plan, answer)
    return {**receipt, "verification": intent_verify(source, runtime_dir, receipt)}


def _kfd3_operations() -> Kfd3Operations:
    return Kfd3Operations(
        validate_source=validate_source,
        application=application,
        intent_plan=intent_plan,
        decision_card=decision_card,
        lifecycle_plan=lifecycle_plan,
        lifecycle_apply=lifecycle_apply,
        answer_decision=answer_decision,
    )


def _earn_kfd3(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    qualification_source: str,
) -> dict[str, Any]:
    return _earn_kfd3_impl(
        _kfd3_operations(),
        source,
        runtime_dir,
        qualification_source=qualification_source,
    )


def build_kfd3_release_manifest(
    sources: list[str | Path], runtime_dir: str | Path
) -> dict[str, Any]:
    return _build_kfd3_release_manifest(_kfd3_operations(), sources, runtime_dir)


def kfd3_status(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    return _kfd3_status(_kfd3_operations(), source, runtime_dir)


def kfd3_qualification_plan(
    source: str | Path, runtime_dir: str | Path
) -> dict[str, Any]:
    return _kfd3_qualification_plan(_kfd3_operations(), source, runtime_dir)


def qualify_kfd3(
    source: str | Path,
    runtime_dir: str | Path,
    *,
    authorization_id: str = "kfd3-cli-explicit",
    qualification_source: str = "local",
) -> dict[str, Any]:
    return _qualify_kfd3(
        _kfd3_operations(),
        source,
        runtime_dir,
        authorization_id=authorization_id,
        qualification_source=qualification_source,
    )


def authorize_kfd3_qualification(
    source: str | Path,
    runtime_dir: str | Path,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    return _authorize_kfd3_qualification(
        _kfd3_operations(),
        source,
        runtime_dir,
        expected_plan_id,
        choice,
        authorized_by,
    )


def verify_kfd3(
    source: str | Path, runtime_dir: str | Path, receipt: Mapping[str, Any]
) -> dict[str, Any]:
    return _verify_kfd3(_kfd3_operations(), source, runtime_dir, receipt)


def qualify_source(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    validated = validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    compatibility = _read_ref_json(
        inspection, inspection["profile"]["kfd1"]["compatibility"]
    )
    qualification = _read_ref_json(
        inspection, inspection["profile"]["qualification"]["profile"]
    )
    contracts = compatibility.get("runtimeContracts", [])
    checks = qualification.get("checks", [])
    if (
        contracts != ["kungfu.profile-lifecycle/v1"]
        and "kungfu.profile-lifecycle/v1" not in contracts
    ):
        raise ProfileSdkError(
            "runtime-incompatible", "Profile omits the current lifecycle contract"
        )
    if sorted(checks) != ["content-closure", "runtime-contract"]:
        raise ProfileSdkError(
            "qualification-check-unsupported",
            "This runtime only qualifies content-closure and runtime-contract",
            requested=checks,
        )
    collaboration = validated["collaboration"]
    return {
        "schema": "kungfu.profile-source-qualification/v1",
        "profileSuiteRoot": inspection["profile_suite_root"],
        "status": "qualified-for-install-plan",
        "checks": sorted(checks),
        "evidenceScope": "source-contract/content-closure/runtime-contract",
        "kfd3": {
            "declared": collaboration["declared"],
            "qualified": False,
            "status": collaboration.get("qualificationStatus", "not-declared"),
            "closureRoot": collaboration.get("closureRoot"),
            "reason": collaboration.get("reason"),
        },
        "workConformance": _work_profile_conformance(inspection, "qualify"),
        "lifecycleMutation": False,
    }


def export_source_bundle(
    source: str | Path, runtime_dir: str | Path, *, thin: bool = False
) -> dict[str, Any]:
    """Export an exact Profile source closure without lifecycle side effects."""

    validated = validate_source(source, runtime_dir)
    root = Path(validated["source"]["source"]).resolve()
    entries = []
    for path in _portable_source_paths(root):
        data = path.read_bytes()
        entry = {
            "path": path.relative_to(root).as_posix(),
            "sha256": _sha256(data),
            "size": len(data),
        }
        if not thin:
            entry["contentBase64"] = base64.b64encode(data).decode("ascii")
        entries.append(entry)
    body = {
        "schema": SOURCE_BUNDLE_SCHEMA,
        "mode": "thin" if thin else "full",
        "selfContained": not thin,
        "profileId": validated["source"]["profile"]["id"],
        "profileVersion": validated["source"]["profile"]["version"],
        "profileSuiteRoot": validated["inspection"]["profile_suite_root"],
        "memberRoots": validated["source"]["memberRoots"],
        "entries": entries,
    }
    body["bundleRoot"] = _root(body)
    _validate_sdk_value("sourceBundleSchema", body, "Profile source bundle")
    return body


def source_import_plan(
    bundle: Mapping[str, Any], destination: str | Path
) -> dict[str, Any]:
    """Plan reconstruction of source bytes; never install or activate a Profile."""

    normalized = _validate_source_bundle(bundle)
    target = Path(destination).expanduser().resolve()
    collision = target.exists() and (not target.is_dir() or any(target.iterdir()))
    identity = {
        "bundle": normalized,
        "destination": str(target),
        "destinationCollision": collision,
    }
    plan = {
        "schema": SOURCE_IMPORT_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "requiresAuthorization": normalized["mode"] == "full" and not collision,
    }
    if normalized["mode"] == "thin":
        plan["decisionCard"] = decision_card(
            "profile-source-material-required",
            "Thin Profile bundles are root inventories; supply a full bundle before reconstruction.",
            choices=["supply-full-bundle"],
            basis={"bundleRoot": normalized["bundleRoot"]},
            required_authority="profile-source-owner",
            resume_command="export or obtain the exact full Profile source bundle",
        )
    elif collision:
        plan["decisionCard"] = decision_card(
            "profile-source-collision",
            "The Profile source import destination is not empty.",
            choices=["choose-an-empty-directory", "inspect-and-merge-manually"],
            basis={"bundleRoot": normalized["bundleRoot"], "destination": str(target)},
            required_authority="profile-source-owner",
            resume_command="choose an empty destination and re-plan",
        )
    else:
        plan["decisionCard"] = decision_card(
            "profile-source-import-authorization",
            "Authorize reconstruction of this exact Profile source closure without lifecycle activation.",
            choices=["approve", "deny"],
            basis={"planId": plan["planId"], "bundleRoot": normalized["bundleRoot"]},
            required_authority="profile-source-owner",
            resume_command="answer this card, then apply the exact source import plan",
        )
    return plan


def authorized_source_import(
    plan: Mapping[str, Any], answer: Mapping[str, Any]
) -> dict[str, Any]:
    if plan.get("schema") != SOURCE_IMPORT_PLAN_SCHEMA:
        raise ProfileSdkError(
            "source-import-plan-invalid", "Profile source import requires an exact plan"
        )
    refreshed = source_import_plan(
        dict(plan.get("bundle") or {}), str(plan.get("destination") or "")
    )
    if refreshed["planId"] != plan.get("planId"):
        raise ProfileSdkError(
            "source-import-plan-stale", "Profile source bundle or destination changed"
        )
    if not refreshed["requiresAuthorization"]:
        raise ProfileSdkError(
            "source-import-not-ready",
            "Profile source import needs a full bundle and an empty destination",
            decisionCards=[refreshed["decisionCard"]],
        )
    validate_decision_answer(answer, refreshed["decisionCard"])
    if (
        answer.get("choice") != "approve"
        or (answer.get("basis") or {}).get("planId") != refreshed["planId"]
    ):
        raise ProfileSdkError(
            "decision-denied", "Profile source import was not approved"
        )
    target = Path(refreshed["destination"])
    target.mkdir(parents=True, exist_ok=True)
    written = []
    for entry in refreshed["bundle"]["entries"]:
        path = _confined(target, entry["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        data = base64.b64decode(entry["contentBase64"], validate=True)
        path.write_bytes(data)
        written.append(entry["path"])
    return {
        "schema": "kungfu.profile-source-import-receipt/v1",
        "planId": refreshed["planId"],
        "authorizationId": answer["authorizationId"],
        "bundleRoot": refreshed["bundle"]["bundleRoot"],
        "profileSuiteRoot": refreshed["bundle"]["profileSuiteRoot"],
        "destination": str(target),
        "written": written,
        "lifecycleMutation": False,
    }


def lifecycle_plan(
    runtime_dir: str | Path,
    action: str,
    source: str | Path | None = None,
    **values: Any,
) -> dict[str, Any]:
    request: dict[str, Any] = {"action": action, **values}
    if source is not None:
        resolved = resolve_source(source)
        request.update(
            profile_path=resolved["profilePath"],
            member_roots=resolved["memberRoots"],
        )
        if action in {"qualify", "activate"}:
            inspection = storage_service.profile_lifecycle(
                runtime_dir,
                "inspect",
                profile_path=resolved["profilePath"],
                member_roots=resolved["memberRoots"],
            )
            work_conformance = _work_profile_conformance(
                inspection, "qualify" if action == "qualify" else "installed-runtime"
            )
            if work_conformance is not None:
                request["work_conformance"] = work_conformance
    plan = storage_service.profile_lifecycle(runtime_dir, "plan", request=request)
    return {
        "schema": "kungfu.profile-agent-plan/v1",
        "corePlan": plan,
        "decisionCard": _lifecycle_decision_card(action, plan),
    }


def lifecycle_apply(
    runtime_dir: str | Path, core_plan: Mapping[str, Any], authorization_id: str
) -> dict[str, Any]:
    return storage_service.profile_lifecycle(
        runtime_dir, "apply", plan=dict(core_plan), authorization_id=authorization_id
    )


def answer_decision(
    card: Mapping[str, Any], choice: str, authorized_by: str
) -> dict[str, Any]:
    _validate_decision_card(card)
    if choice not in card.get("choices", []):
        raise ProfileSdkError(
            "decision-choice-invalid",
            "answer is not one of the decision card choices",
            choices=card.get("choices", []),
        )
    actor = authorized_by.strip()
    if not actor:
        raise ProfileSdkError(
            "decision-actor-required", "authorized_by must not be empty"
        )
    identity = {
        "cardId": card["cardId"],
        "choice": choice,
        "authorizedBy": actor,
        "requiredAuthority": card["requiredAuthority"],
        "basis": card["basis"],
    }
    answer = {
        "schema": DECISION_ANSWER_SCHEMA,
        "authorizationId": _root(identity),
        **identity,
        "authorityVerification": "external-policy-required",
    }
    _validate_decision_answer(answer, card)
    return answer


def authorized_lifecycle_apply(
    runtime_dir: str | Path,
    agent_plan: Mapping[str, Any],
    answer: Mapping[str, Any],
) -> dict[str, Any]:
    if agent_plan.get("schema") != "kungfu.profile-agent-plan/v1":
        raise ProfileSdkError(
            "agent-plan-invalid", "apply requires a Profile Agent plan"
        )
    card = agent_plan.get("decisionCard") or {}
    core_plan = agent_plan.get("corePlan") or {}
    expected_card = _lifecycle_decision_card(
        str((core_plan.get("request") or {}).get("action") or ""), core_plan
    )
    if card.get("cardId") != expected_card.get("cardId"):
        raise ProfileSdkError(
            "decision-card-mismatch", "Agent plan decision card was altered"
        )
    _validate_decision_answer(answer, card)
    if answer.get("choice") != "approve":
        raise ProfileSdkError(
            "decision-denied", "the Profile lifecycle plan was not approved"
        )
    if (answer.get("basis") or {}).get("planId") != core_plan.get("plan_id"):
        raise ProfileSdkError(
            "decision-basis-mismatch", "decision answer does not bind this Core plan"
        )
    return lifecycle_apply(
        runtime_dir, core_plan, str(answer.get("authorizationId") or "")
    )


def authorize_current_lifecycle(
    runtime_dir: str | Path,
    action: str,
    source: str | Path,
    expected_plan_id: str,
    choice: str,
    authorized_by: str,
) -> dict[str, Any]:
    """Re-plan an exact source cut, then answer and apply its installed card."""

    plan = lifecycle_plan(runtime_dir, action, source)
    actual = str((plan.get("corePlan") or {}).get("plan_id") or "")
    if not expected_plan_id or actual != expected_plan_id:
        raise ProfileSdkError(
            "lifecycle-plan-stale",
            "Profile lifecycle plan changed; review a new decision card",
            expectedPlanId=expected_plan_id,
            actualPlanId=actual,
        )
    answer = answer_decision(plan["decisionCard"], choice, authorized_by)
    return authorized_lifecycle_apply(runtime_dir, plan, answer)


def semantic_diff(left: str | Path, right: str | Path) -> dict[str, Any]:
    a = resolve_source(left)
    b = resolve_source(right)
    pa, pb = a["profile"], b["profile"]
    categories = {
        "display": _changes(pa, pb, ["title", "views"]),
        "content": _changes(pa, pb, ["kfd1", "members"]),
        "permission": _changes(pa, pb, ["permissions"]),
        "authority": _changes(pa, pb, ["actions", "kfd3"]),
        "evidence": _changes(pa, pb, ["kfd2", "qualification"]),
        "migration": _changes(pa, pb, ["migrations"]),
    }
    cards = []
    for category, authority in {
        "permission": "workspace-profile-operator",
        "authority": "profile-authority-owner",
        "evidence": "evidence-policy-owner",
        "migration": "workspace-data-owner",
    }.items():
        if categories[category]:
            cards.append(
                decision_card(
                    f"profile-{category}-change",
                    f"Approve or reject the Profile {category} change.",
                    choices=["approve", "reject", "revise"],
                    basis={"category": category, "changes": categories[category]},
                    required_authority=authority,
                    resume_command="rerun kungfu profile diff, then create a fresh lifecycle plan",
                )
            )
    return {
        "schema": "kungfu.profile-semantic-diff/v1",
        "leftRoot": validate_source(left, "")["inspection"]["profile_suite_root"],
        "rightRoot": validate_source(right, "")["inspection"]["profile_suite_root"],
        "categories": categories,
        "changedCategories": [key for key, rows in categories.items() if rows],
        "decisionCards": cards,
    }


def action_catalog(source: str | Path, runtime_dir: str | Path) -> dict[str, Any]:
    validated = validate_source(source, runtime_dir)
    inspection = validated["inspection"]
    registry = _read_ref_json(inspection, inspection["profile"]["actions"]["registry"])
    _validate_action_registry(registry, inspection["profile"])
    return {
        "schema": "kungfu.profile-action-catalog/v1",
        "profileId": inspection["profile"]["id"],
        "profileSuiteRoot": inspection["profile_suite_root"],
        "source": str(Path(source).resolve()),
        "actions": registry["actions"],
    }


def _action_runtime_plan(
    runtime_dir: str | Path, action: Mapping[str, Any]
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    operation_id = str(action.get("runtimeOperation") or "")
    try:
        operation = runtime_broker.operation_definition(operation_id)
    except (KeyError, ValueError) as error:
        raise ProfileSdkError(
            "action-runtime-operation-invalid", str(error), operationId=operation_id
        ) from error
    evidence = None
    minimum_cut = None
    if operation["operationClass"] != "storage-only":
        evidence_path = runtime_broker.native_readiness_evidence_path(runtime_dir)
        try:
            evidence = runtime_broker.discover_native_readiness_evidence(runtime_dir)
        except ValueError as error:
            raise ProfileSdkError(
                "runtime-evidence-invalid",
                str(error),
                evidencePath=str(evidence_path),
            ) from error
        if evidence is None:
            raise ProfileSdkError(
                "runtime-evidence-unavailable",
                "live Profile action requires native durability evidence coordinates",
                evidencePath=str(evidence_path),
                operationId=operation_id,
            )
        minimum_cut = evidence["minimumCut"]
        if (
            "runtime.live-projection" in operation["requiredCapabilities"]
            and evidence.get("projection") is None
        ):
            raise ProfileSdkError(
                "runtime-evidence-incomplete",
                "live projection action requires projection evidence coordinates",
                evidencePath=str(evidence_path),
                operationId=operation_id,
            )
    runtime_plan = runtime_broker.plan_operation(
        operation_id,
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="kfx",
        minimum_cut=minimum_cut,
    )
    return runtime_plan, evidence


def plan_action(
    source: str | Path, runtime_dir: str | Path, action_id: str, input_value: Any
) -> dict[str, Any]:
    catalog = action_catalog(source, runtime_dir)
    collaboration_value = collaboration(source, runtime_dir)
    action = next((row for row in catalog["actions"] if row["id"] == action_id), None)
    if action is None:
        raise ProfileSdkError(
            "action-not-found", f"Profile action not found: {action_id}"
        )
    state = storage_service.profile_lifecycle(
        runtime_dir, "get", profile_id=catalog["profileId"]
    )
    if (
        not state.get("activated")
        or state.get("profile_suite_root") != catalog["profileSuiteRoot"]
    ):
        raise ProfileSdkError(
            "profile-not-active", "Action requires this exact Profile root to be active"
        )
    identity = {
        "profileId": catalog["profileId"],
        "profileSuiteRoot": catalog["profileSuiteRoot"],
        "action": action,
        "input": input_value,
        "stateRevision": state["revision"],
    }
    if collaboration_value["declared"]:
        intent = next(
            (
                row
                for row in collaboration_value["intents"]
                if row["actionId"] == action_id
            ),
            None,
        )
        if intent is None:
            raise ProfileSdkError(
                "collaboration-action-closure",
                "declared collaboration has no intent for this action",
            )
        identity.update(
            {
                "collaborationRoot": collaboration_value["collaborationRoot"],
                "closureRoot": collaboration_value["closureRoot"],
                "intentId": intent["id"],
            }
        )
    missing_capabilities = sorted(
        set(action["requiredCapabilities"]) - set(state.get("granted_permissions", []))
    )
    if missing_capabilities:
        raise ProfileSdkError(
            "action-capability-not-granted",
            "Action requires Profile capabilities that are not active",
            missingCapabilities=missing_capabilities,
        )
    runtime_plan, runtime_evidence = _action_runtime_plan(runtime_dir, action)
    identity["runtimeOperation"] = runtime_plan["operation"]["id"]
    if runtime_evidence is not None:
        identity.update(
            {
                "runtimePlan": runtime_plan,
                "runtimeEvidence": runtime_evidence,
            }
        )
    plan = {
        "schema": ACTION_PLAN_SCHEMA,
        "planId": _root(identity),
        **identity,
        "source": catalog["source"],
        "runtimePlan": runtime_plan,
        "runtimeEvidence": runtime_evidence,
        "requiresAuthorization": action["authorityClass"] != "none",
        "effects": action.get("effects", []),
    }
    if plan["requiresAuthorization"]:
        plan["decisionCard"] = decision_card(
            "profile-action-authorization",
            f"Authorize Profile action {action_id} for the exact active root.",
            choices=["approve", "deny"],
            basis={
                "planId": plan["planId"],
                "profileSuiteRoot": catalog["profileSuiteRoot"],
            },
            required_authority=action["authorityClass"],
            resume_command="answer this card, then invoke with the exact action plan and decision answer",
        )
    return plan


def invoke_action(
    runtime_dir: str | Path, plan: Mapping[str, Any], authorization_id: str | None
) -> dict[str, Any]:
    if plan.get("schema") != ACTION_PLAN_SCHEMA:
        raise ProfileSdkError(
            "action-plan-invalid", "invoke requires a Profile action plan"
        )
    refreshed = plan_action(
        str(plan.get("source") or ""),
        runtime_dir,
        str((plan.get("action") or {}).get("id") or ""),
        plan.get("input"),
    )
    if refreshed.get("planId") != plan.get("planId"):
        raise ProfileSdkError(
            "action-plan-stale", "Profile source or active state changed after planning"
        )
    if refreshed.get("runtimePlan") != plan.get("runtimePlan") or refreshed.get(
        "runtimeEvidence"
    ) != plan.get("runtimeEvidence"):
        raise ProfileSdkError(
            "action-plan-stale", "runtime execution material changed after planning"
        )
    action = plan.get("action") or {}
    if plan.get("requiresAuthorization") and not authorization_id:
        raise ProfileSdkError(
            "authorization-required", "Profile action requires an authorization id"
        )
    state = storage_service.profile_lifecycle(
        runtime_dir, "get", profile_id=plan["profileId"]
    )
    if state.get("profile_suite_root") != plan.get("profileSuiteRoot") or state.get(
        "revision"
    ) != plan.get("stateRevision"):
        raise ProfileSdkError(
            "action-plan-stale", "active Profile state changed after action planning"
        )
    if action.get("runner") == "kfx-member":

        def invoke_kfx(_activation: Mapping[str, Any]) -> dict[str, Any]:
            receipt = invoke_member_adapter(
                str(plan.get("source") or ""),
                runtime_dir,
                str(action.get("operation") or ""),
                str(action.get("id") or ""),
                plan.get("input"),
                authorized_action=True,
            )
            result = receipt.get("result")
            if not isinstance(result, Mapping):
                raise ProfileSdkError(
                    "member-adapter-result-invalid",
                    "Profile action member must return an object result",
                )
            return {
                **result,
                "memberReceipt": {
                    key: value for key, value in receipt.items() if key != "result"
                },
            }

        callback = invoke_kfx
    elif action.get("runner") == "profile-lifecycle":
        lifecycle_action = action.get("operation")
        if lifecycle_action not in {"qualify", "activate", "remove"}:
            raise ProfileSdkError(
                "action-operation-unsupported",
                "unsupported lifecycle action operation",
            )
        source_value = plan.get("source")
        lifecycle_source = str(source_value) if source_value is not None else None
        lifecycle_values: dict[str, Any] = {}
        if lifecycle_action == "remove":
            lifecycle_values["profile_id"] = plan["profileId"]
            lifecycle_source = None
        core = lifecycle_plan(
            runtime_dir, lifecycle_action, lifecycle_source, **lifecycle_values
        )["corePlan"]

        def invoke_lifecycle(_activation: Mapping[str, Any]) -> dict[str, Any]:
            return {
                "coreReceipt": lifecycle_apply(
                    runtime_dir, core, authorization_id or "action-policy:none"
                )
            }

        callback = invoke_lifecycle
    else:
        raise ProfileSdkError(
            "action-runner-unsupported", "unsupported Profile action runner"
        )

    evidence = plan.get("runtimeEvidence")
    readiness_authority = None
    runtime_home = str(Path(runtime_dir).expanduser().resolve().parent)
    if isinstance(evidence, Mapping):
        try:
            readiness_authority = runtime_broker.native_readiness_authority(evidence)
        except (TypeError, ValueError) as error:
            raise ProfileSdkError("runtime-evidence-invalid", str(error)) from error
        runtime_home = str(evidence["runtimeHome"])
    broker = runtime_broker.RuntimeCapabilityBroker.for_process(
        runtime_home,
        str(runtime_dir),
        readiness_authority=readiness_authority,
    )
    runtime_plan = plan.get("runtimePlan")
    if not isinstance(runtime_plan, Mapping):
        raise ProfileSdkError(
            "action-runtime-plan-invalid", "Profile action has no runtime plan"
        )
    try:
        runtime_receipt = broker.invoke(runtime_plan, callback)
    except ValueError as error:
        raise ProfileSdkError("action-runtime-plan-invalid", str(error)) from error
    result = runtime_receipt.get("result")
    if not runtime_receipt.get("accepted") or not isinstance(result, Mapping):
        return {
            "schema": ACTION_RECEIPT_SCHEMA,
            "planId": plan["planId"],
            "authorizationId": authorization_id,
            "runtimeReceipt": runtime_receipt,
            "coreReceipt": None,
            "verified": False,
        }
    return {
        "schema": ACTION_RECEIPT_SCHEMA,
        "planId": plan["planId"],
        "authorizationId": authorization_id,
        "runtimeReceipt": runtime_receipt,
        **result,
        "verified": True,
    }


def authorized_action_invoke(
    runtime_dir: str | Path,
    plan: Mapping[str, Any],
    answer: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if plan.get("schema") != ACTION_PLAN_SCHEMA:
        raise ProfileSdkError(
            "action-plan-invalid", "invoke requires a Profile action plan"
        )
    if not plan.get("requiresAuthorization"):
        return invoke_action(runtime_dir, plan, None)
    refreshed = plan_action(
        str(plan.get("source") or ""),
        runtime_dir,
        str((plan.get("action") or {}).get("id") or ""),
        plan.get("input"),
    )
    card = plan.get("decisionCard") or {}
    if card.get("cardId") != (refreshed.get("decisionCard") or {}).get("cardId"):
        raise ProfileSdkError(
            "decision-card-mismatch", "action plan decision card was altered"
        )
    if not answer:
        raise ProfileSdkError(
            "decision-answer-invalid", "action invoke requires a decision answer"
        )
    _validate_decision_answer(answer, card)
    if answer.get("choice") != "approve":
        raise ProfileSdkError("decision-denied", "the Profile action was not approved")
    if (answer.get("basis") or {}).get("planId") != plan.get("planId"):
        raise ProfileSdkError(
            "decision-basis-mismatch", "decision answer does not bind this action plan"
        )
    return invoke_action(runtime_dir, plan, str(answer.get("authorizationId") or ""))


def _source_plan_identity(
    brief: Any, destination: str, files: Mapping[str, bytes]
) -> dict[str, Any]:
    return {
        "brief": brief,
        "destination": destination,
        "files": [
            {"path": path, "sha256": _sha256(data)}
            for path, data in sorted(files.items())
        ],
    }


def _lifecycle_decision_card(action: str, plan: Mapping[str, Any]) -> dict[str, Any]:
    return decision_card(
        "profile-lifecycle-authorization",
        f"Authorize the exact {action} plan for this Profile root.",
        choices=["approve", "deny"],
        basis={
            "planId": plan.get("plan_id"),
            "basis": plan.get("basis"),
            "effects": plan.get("effects"),
        },
        required_authority="workspace-profile-operator",
        resume_command="kungfu profile decide <plan.json> --choice approve --authorized-by <actor> --out <answer.json> --json; kungfu profile apply <plan.json> --authorization-file <answer.json> --json",
    )


def _validate_decision_card(card: Mapping[str, Any]) -> None:
    _validate_sdk_value("decisionCardSchema", dict(card), "decision card")
    if card.get("schema") != DECISION_CARD_SCHEMA or card.get("status") != "open":
        raise ProfileSdkError(
            "decision-card-invalid", "answer requires an open decision card"
        )
    identity = {
        "kind": card.get("kind"),
        "question": card.get("question"),
        "choices": card.get("choices"),
        "basis": card.get("basis"),
        "requiredAuthority": card.get("requiredAuthority"),
    }
    if card.get("cardId") != _root(identity):
        raise ProfileSdkError(
            "decision-card-tampered", "decision card no longer matches its identity"
        )


def _validate_decision_answer(
    answer: Mapping[str, Any], card: Mapping[str, Any]
) -> None:
    _validate_decision_card(card)
    _validate_sdk_value("decisionAnswerSchema", dict(answer), "decision answer")
    identity = {
        "cardId": answer.get("cardId"),
        "choice": answer.get("choice"),
        "authorizedBy": answer.get("authorizedBy"),
        "requiredAuthority": answer.get("requiredAuthority"),
        "basis": answer.get("basis"),
    }
    if answer.get("cardId") != card.get("cardId"):
        raise ProfileSdkError(
            "decision-answer-mismatch", "decision answer targets another card"
        )
    if answer.get("requiredAuthority") != card.get("requiredAuthority"):
        raise ProfileSdkError(
            "decision-authority-mismatch", "decision answer changes required authority"
        )
    if answer.get("choice") not in card.get("choices", []):
        raise ProfileSdkError(
            "decision-choice-invalid", "decision answer choice is no longer offered"
        )
    if answer.get("basis") != card.get("basis"):
        raise ProfileSdkError(
            "decision-basis-mismatch", "decision answer changes the card basis"
        )
    if not str(answer.get("authorizedBy") or "").strip():
        raise ProfileSdkError("decision-actor-required", "decision answer has no actor")
    if answer.get("authorizationId") != _root(identity):
        raise ProfileSdkError(
            "decision-answer-tampered", "decision answer no longer matches its identity"
        )


def _normalize_brief(
    brief: Mapping[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    allowed = {
        "schema",
        "id",
        "title",
        "version",
        "purposes",
        "permissions",
        "identity",
        "evidence",
        "migration",
        "collaboration",
    }
    if set(brief) - allowed:
        raise ProfileSdkError(
            "brief-field-unknown",
            "brief contains fields not owned by the installed contract",
            fields=sorted(set(brief) - allowed),
        )
    if brief.get("schema") != BRIEF_SCHEMA:
        raise ProfileSdkError("brief-schema-invalid", f"brief must use {BRIEF_SCHEMA}")
    profile_id = str(brief.get("id") or "").strip()
    title = str(brief.get("title") or "").strip()
    version = str(brief.get("version") or "1.0.0").strip()
    if not profile_id or not _TOKEN.fullmatch(profile_id):
        raise ProfileSdkError(
            "profile-id-invalid", "brief.id must be a safe Profile token"
        )
    if not title:
        raise ProfileSdkError("profile-title-required", "brief.title must not be empty")
    cards = []
    checks = [
        (
            "identity",
            "authority",
            "identity-authority",
            ["workspace-owner", "declared-source-owner"],
        ),
        (
            "evidence",
            "strength",
            "evidence-strength",
            ["reported-with-references", "independently-observed"],
        ),
        (
            "migration",
            "mode",
            "migration-mode",
            ["additive", "explicit-destructive-plan"],
        ),
    ]
    for section, field, kind, choices in checks:
        value = brief.get(section)
        selected = value.get(field) if isinstance(value, Mapping) else None
        if selected not in choices:
            cards.append(
                decision_card(
                    kind,
                    f"Choose the Profile {section} {field} boundary.",
                    choices=choices,
                    basis={
                        "profileId": profile_id,
                        "briefSha256": _sha256(_canonical(brief)),
                        "supplied": selected,
                    },
                    required_authority="profile-author",
                    resume_command="update brief.json, then rerun kungfu profile scaffold",
                )
            )
    migration = brief.get("migration")
    if (
        isinstance(migration, Mapping)
        and migration.get("mode") == "explicit-destructive-plan"
    ):
        cards.append(
            decision_card(
                "destructive-migration",
                "A destructive migration requires a separate bounded migration plan.",
                choices=["switch-to-additive", "prepare-separate-migration-plan"],
                basis={"profileId": profile_id, "migration": dict(migration)},
                required_authority="workspace-data-owner",
                resume_command="revise the brief, then rerun kungfu profile scaffold",
            )
        )
    normalized = {
        "schema": BRIEF_SCHEMA,
        "id": profile_id,
        "title": title,
        "version": version,
        "purposes": sorted(
            set(str(v) for v in brief.get("purposes", ["operator-review"]))
        ),
        "permissions": sorted(set(str(v) for v in brief.get("permissions", []))),
        "identity": dict(brief.get("identity") or {}),
        "evidence": dict(brief.get("evidence") or {}),
        "migration": dict(brief.get("migration") or {}),
    }
    collaboration = brief.get("collaboration")
    if collaboration is not None:
        if not isinstance(collaboration, Mapping):
            raise ProfileSdkError(
                "collaboration-brief-invalid",
                "brief.collaboration must be an object when KFD-3 is requested",
            )
        artifact = {
            "schema": COLLABORATION_SCHEMA,
            "profileId": profile_id,
            "value": {
                "summary": collaboration.get("summary"),
                "participantBenefits": collaboration.get("participantBenefits", []),
            },
            "participants": collaboration.get("participants", []),
            "intents": [],
            "constraints": collaboration.get("constraints", []),
            "knownLimits": collaboration.get("knownLimits", []),
            "presentation": {"mode": "generic", "homeViewId": None},
        }
        _validate_sdk_value(
            "collaborationSchema", artifact, "Profile brief collaboration"
        )
        normalized["collaboration"] = artifact
    if not cards:
        _validate_sdk_value("briefSchema", normalized, "Profile brief")
    return normalized, cards
