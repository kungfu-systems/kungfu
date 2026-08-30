# SPDX-License-Identifier: Apache-2.0

"""Installed, agent-facing authoring layer for KFX Profile Suites.

This module owns no lifecycle state and no Profile schema.  It resolves source
packages, computes content roots, and delegates every lifecycle decision and
mutation to the Core service introduced by KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.
"""

# Exact-source projection reads may inspect a retained inactive Profile root.
# They never authorize lifecycle actions or substitute a conflicting root.
# Authorized actions continue to require the exact active Profile lifecycle.
# Member bytes and Suite roots remain verified before every adapter invocation.

from __future__ import annotations

import hashlib
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
from kungfu import runtime_broker  # noqa: F401 -- private owner seam
from kungfu import kfx_contract
from kungfu.storage import profile_member_state
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
from kungfu.profile_sdk_kfd3 import (  # noqa: F401 -- private owner seams
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
    inactive_projection_read: bool = False,
) -> dict[str, Any]:
    """Invoke one exact-root Profile member through its declared Python adapter.

    Core owns resolution, root binding and the transport envelope.  The member
    owns every domain operation and result schema behind ``invoke``.

    Inactive projection reads are explicit exact-source reads; they never
    authorize a Profile action.
    """

    if not _TOKEN.fullmatch(member_id) or not _TOKEN.fullmatch(operation):
        raise ProfileSdkError(
            "member-adapter-request-invalid",
            "member and operation must be safe Profile tokens",
        )
    validated = validate_source(source, runtime_dir)
    resolved = validated["source"]
    profile_suite_root = validated["inspection"]["profile_suite_root"]
    profile_failure = profile_member_state.adapter_failure(
        runtime_dir,
        resolved["profile"]["id"],
        profile_suite_root,
        authorized_action,
        inactive_projection_read,
    )
    if profile_failure:
        raise ProfileSdkError("profile-not-active", profile_failure)
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


from kungfu._profile_sdk.lifecycle import (  # noqa: E402
    export_source_bundle as export_source_bundle,
    source_import_plan as source_import_plan,
    authorized_source_import as authorized_source_import,
    lifecycle_plan as lifecycle_plan,
    lifecycle_apply as lifecycle_apply,
    answer_decision as answer_decision,
    authorized_lifecycle_apply as authorized_lifecycle_apply,
    authorize_current_lifecycle as authorize_current_lifecycle,
)
from kungfu._profile_sdk.action import (  # noqa: E402
    semantic_diff as semantic_diff,
    action_catalog as action_catalog,
    _action_runtime_plan as _action_runtime_plan,
    plan_action as plan_action,
    invoke_action as invoke_action,
    authorized_action_invoke as authorized_action_invoke,
    _source_plan_identity as _source_plan_identity,
    _lifecycle_decision_card as _lifecycle_decision_card,
    _validate_decision_card as _validate_decision_card,
    _validate_decision_answer as _validate_decision_answer,
    _normalize_brief as _normalize_brief,
)
from kungfu._profile_sdk.intent import (  # noqa: E402
    intent_inspect as intent_inspect,
    intent_advise as intent_advise,
    intent_plan as intent_plan,
    intent_apply as intent_apply,
    intent_verify as intent_verify,
    authorize_current_intent as authorize_current_intent,
)
from kungfu._profile_sdk.kfd3 import (  # noqa: E402
    _kfd3_operations as _kfd3_operations,
    _earn_kfd3 as _earn_kfd3,
    build_kfd3_release_manifest as build_kfd3_release_manifest,
    kfd3_status as kfd3_status,
    kfd3_qualification_plan as kfd3_qualification_plan,
    qualify_kfd3 as qualify_kfd3,
    authorize_kfd3_qualification as authorize_kfd3_qualification,
    verify_kfd3 as verify_kfd3,
    qualify_source as qualify_source,
)

for _public_callable in (
    export_source_bundle,
    source_import_plan,
    authorized_source_import,
    lifecycle_plan,
    lifecycle_apply,
    answer_decision,
    authorized_lifecycle_apply,
    authorize_current_lifecycle,
    semantic_diff,
    action_catalog,
    plan_action,
    invoke_action,
    authorized_action_invoke,
    intent_inspect,
    intent_advise,
    intent_plan,
    intent_apply,
    intent_verify,
    authorize_current_intent,
    build_kfd3_release_manifest,
    kfd3_status,
    kfd3_qualification_plan,
    qualify_kfd3,
    authorize_kfd3_qualification,
    verify_kfd3,
    qualify_source,
):
    _public_callable.__module__ = __name__
