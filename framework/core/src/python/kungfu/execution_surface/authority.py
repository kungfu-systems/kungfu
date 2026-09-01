# SPDX-License-Identifier: Apache-2.0

"""Single fail-closed authority for Kungfu execution-surface provenance."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping
from typing import Any, Literal, Never, overload

from kungfu import contract as contract_runtime
from kungfu.action_envelope import canonical_json_bytes
from kungfu.content_hash import compute_content_hash


REQUEST_SCHEMA = "kungfu.runtime-surface-request/v1"
RECEIPT_SCHEMA = "kungfu.runtime-surface-receipt/v1"
ROOT_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
CONCRETE_SURFACES = {
    "installed-product",
    "source-checkout",
    "hybrid-boundary",
}
SURFACES = {*CONCRETE_SURFACES, "capability-negotiated"}
REQUEST_FIELDS = {
    "schema",
    "operationId",
    "requestedSurface",
    "candidates",
    "authorityRoots",
    "fallback",
}
CANDIDATE_FIELDS = {
    "providerId",
    "surface",
    "capabilities",
    "executable",
    "source",
    "bundleRoot",
    "qualification",
}


def coordinator_ready(status: Mapping[str, Any]) -> bool:
    """Require verified process identities and the matching native-ready state."""

    lifecycle = status.get("lifecycle") or {}
    supervisor = status.get("supervisor") or {}
    coordinator = status.get("coordinator") or {}
    last_state = status.get("lastState") or {}
    return all(
        (
            lifecycle.get("healthy") is True,
            supervisor.get("identityVerified") is True,
            coordinator.get("identityVerified") is True,
            last_state.get("status") == "coordinator-running",
            last_state.get("coordinatorPid") == coordinator.get("pid"),
        )
    )


def coordinator_running_state(
    *,
    schema: str,
    home: str,
    runtime_dir: str,
    authority: Mapping[str, Any],
    pid: int,
    start_identity: Any,
    runtime_image: Mapping[str, Any] | None,
    updated_at: float,
) -> dict[str, Any]:
    """Project ready state only after the native coordinator is constructed."""

    return {
        "schema": schema,
        "status": "coordinator-running",
        "home": home,
        "runtimeDir": runtime_dir,
        **authority,
        "coordinatorPid": pid,
        "coordinatorStartIdentity": start_identity,
        "runtimeImage": copy.deepcopy(dict(runtime_image))
        if runtime_image is not None
        else None,
        "updatedAt": updated_at,
    }


class RuntimeSurfaceError(ValueError):
    """A runtime surface cannot be selected or verified safely."""

    def __init__(self, code: str, message: str, *, recovery: str):
        super().__init__(message)
        self.code = code
        self.recovery = recovery

    def diagnosis(self) -> dict[str, Any]:
        return {
            "schema": "kungfu.runtime-surface-diagnosis/v1",
            "ok": False,
            "code": self.code,
            "message": str(self),
            "nextActions": [{"action": "recover", "command": self.recovery}],
        }


def _fail(code: str, message: str, recovery: str) -> Never:
    raise RuntimeSurfaceError(code, message, recovery=recovery)


@overload
def _root(value: Any, field: str, *, nullable: Literal[False] = False) -> str: ...


@overload
def _root(value: Any, field: str, *, nullable: Literal[True]) -> str | None: ...


@overload
def _root(value: Any, field: str, *, nullable: bool) -> str | None: ...


def _root(value: Any, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    text = str(value or "")
    if not ROOT_PATTERN.fullmatch(text):
        _fail(
            "runtime-surface-root-invalid",
            f"{field} must be an exact sha256 content root",
            "kungfu runtime surface contract --json",
        )
    return text


def _object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        _fail(
            "runtime-surface-shape-invalid",
            f"{field} must be an object",
            "kungfu runtime surface contract --json",
        )
    return dict(value)


def _exact_fields(value: Mapping[str, Any], allowed: set[str], field: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        _fail(
            "runtime-surface-unknown-field",
            f"{field} contains unknown fields: {', '.join(unknown)}",
            "kungfu runtime surface contract --json",
        )


def load_contract(
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    value = (
        contract_runtime.load_contract("runtime-surface")
        if contract is None
        else contract
    )
    validate_contract(value)
    return value


def _contract_root(contract: Mapping[str, Any]) -> str:
    return compute_content_hash(canonical_json_bytes(contract))


def _by_id(rows: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
    ids = [str(row.get("id") or "") for row in rows]
    duplicates = sorted({item for item in ids if item and ids.count(item) > 1})
    if not all(ids) or duplicates:
        _fail(
            "runtime-surface-duplicate-ownership",
            f"{label} identities must be non-empty and unique: {duplicates}",
            "kungfu contract verify --json",
        )
    return dict(zip(ids, rows, strict=True))


def _validate_provider(provider_id, provider, contract, surfaces, capabilities):
    if provider.get("surfaceClass") not in surfaces:
        _fail(
            "runtime-surface-provider-class",
            f"provider {provider_id} declares an unknown surface class",
            "kungfu contract show runtime-surface --json",
        )
    surface = provider["surfaceClass"]
    if provider.get("owner") != contract["surfaceClasses"][surface].get("owner"):
        _fail(
            "runtime-surface-provider-owner",
            f"provider {provider_id} does not match its surface owner",
            "kungfu contract show runtime-surface --json",
        )
    missing = set(provider.get("capabilities") or []) - capabilities
    if missing:
        _fail(
            "runtime-surface-capability-unknown",
            f"provider {provider_id} declares unknown capabilities: {sorted(missing)}",
            "kungfu contract show runtime-surface --json",
        )


def _validate_operation_selection(operation_id, operation, capabilities):
    allowed = set(operation.get("allowedSurfaces") or [])
    required = set(operation.get("requiredCapabilities") or [])
    if not allowed <= CONCRETE_SURFACES or required - capabilities:
        _fail(
            "runtime-surface-operation-invalid",
            f"operation {operation_id} has unknown surfaces or capabilities",
            "kungfu contract show runtime-surface --json",
        )
    mode = operation.get("selectionMode")
    if mode == "exact" and len(allowed) != 1:
        _fail(
            "runtime-surface-selection-ambiguous",
            f"exact operation {operation_id} must own one surface",
            "kungfu contract show runtime-surface --json",
        )
    if mode == "capability-negotiated" and len(allowed) < 2:
        _fail(
            "runtime-surface-selection-ambiguous",
            f"negotiated operation {operation_id} needs multiple surfaces",
            "kungfu contract show runtime-surface --json",
        )
    return allowed, required


def _validate_operation_owners(operation_id, allowed, required, preference, providers):
    if len(preference) != len(set(preference)) or any(
        provider_id not in providers for provider_id in preference
    ):
        _fail(
            "runtime-surface-provider-preference",
            f"operation {operation_id} has an invalid provider preference",
            "kungfu contract show runtime-surface --json",
        )
    owners: dict[str, list[str]] = {surface: [] for surface in allowed}
    for provider_id in preference:
        provider = providers[provider_id]
        surface = str(provider.get("surfaceClass") or "")
        if surface in allowed and required <= set(provider.get("capabilities") or []):
            owners[surface].append(provider_id)
    ambiguous = {surface: rows for surface, rows in owners.items() if len(rows) != 1}
    if ambiguous:
        _fail(
            "runtime-surface-duplicate-ownership",
            f"operation {operation_id} does not have exactly one capable provider per surface: {ambiguous}",
            "kungfu contract show runtime-surface --json",
        )


def _validate_operation(operation_id, operation, providers, capabilities):
    allowed, required = _validate_operation_selection(
        operation_id, operation, capabilities
    )
    preference = list(operation.get("providerPreference") or [])
    _validate_operation_owners(operation_id, allowed, required, preference, providers)
    fallback = operation.get("fallback") or {}
    targets = set(fallback.get("targets") or [])
    if not targets <= allowed or (fallback.get("mode") == "forbidden" and targets):
        _fail(
            "runtime-surface-fallback-ambiguous",
            f"operation {operation_id} has contradictory fallback targets",
            "kungfu contract show runtime-surface --json",
        )


def validate_contract(contract: dict[str, Any]) -> None:
    if contract.get("schema") != "kungfu.runtime-surface.contract/v1":
        _fail(
            "runtime-surface-contract-schema",
            "runtime surface contract schema is unsupported",
            "kungfu contract show runtime-surface --json",
        )
    contract_runtime.validate_json_schema(
        contract, contract.get("contractSchema"), "runtime-surface contract"
    )
    surfaces = set((contract.get("surfaceClasses") or {}).keys())
    if surfaces != SURFACES:
        _fail(
            "runtime-surface-class-set",
            "runtime surface class authority is incomplete or contains unknown classes",
            "kungfu contract show runtime-surface --json",
        )
    surface_owners = [
        str(row.get("owner") or "")
        for row in (contract.get("surfaceClasses") or {}).values()
    ]
    if not all(surface_owners) or len(surface_owners) != len(set(surface_owners)):
        _fail(
            "runtime-surface-duplicate-ownership",
            "each runtime surface class must have one distinct non-empty owner",
            "kungfu contract show runtime-surface --json",
        )
    capabilities = set(contract.get("capabilities") or [])
    providers = _by_id(list(contract.get("providers") or []), "provider")
    operations = _by_id(list(contract.get("operations") or []), "operation")
    for provider_id, provider in providers.items():
        _validate_provider(provider_id, provider, contract, surfaces, capabilities)
    for operation_id, operation in operations.items():
        _validate_operation(operation_id, operation, providers, capabilities)


def _normalize_candidate(
    raw: Any,
    *,
    providers: dict[str, dict[str, Any]],
    operation: dict[str, Any],
) -> dict[str, Any]:
    candidate = _object(raw, "candidate")
    _exact_fields(candidate, CANDIDATE_FIELDS, "candidate")
    provider_id = str(candidate.get("providerId") or "")
    provider = providers.get(provider_id)
    if provider is None or provider.get("surfaceClass") == "capability-negotiated":
        _fail(
            "runtime-surface-provider-unknown",
            f"candidate provider is not contract-permitted: {provider_id or '<empty>'}",
            "kungfu runtime surface contract --json",
        )
    surface = str(candidate.get("surface") or "")
    if (
        surface != provider.get("surfaceClass")
        or surface not in operation["allowedSurfaces"]
    ):
        _fail(
            "runtime-surface-provider-mismatch",
            f"candidate {provider_id} does not own surface {surface or '<empty>'} for this operation",
            "kungfu runtime surface contract --json",
        )
    capabilities = sorted({str(item) for item in candidate.get("capabilities") or []})
    required = set(operation["requiredCapabilities"])
    if not required <= set(capabilities) or not set(capabilities) <= set(
        provider["capabilities"]
    ):
        _fail(
            "runtime-surface-capability-missing",
            f"candidate {provider_id} lacks required or declares unauthorized capabilities",
            "kungfu runtime surface contract --json",
        )
    executable = _object(candidate.get("executable"), "candidate.executable")
    if set(executable) != {"path", "digest", "kind", "version"}:
        _fail(
            "runtime-surface-executable-incomplete",
            "candidate executable identity must explicitly contain path, digest, kind, and version",
            "kungfu runtime surface contract --json",
        )
    expected_kind = provider["executableKind"]
    if executable.get("kind") != expected_kind:
        _fail(
            "runtime-surface-executable-kind",
            f"candidate executable kind must be {expected_kind}",
            "kungfu runtime surface contract --json",
        )
    for field in ("path", "digest", "version"):
        if surface != "hybrid-boundary" and not executable.get(field):
            _fail(
                "runtime-surface-executable-incomplete",
                f"{surface} requires executable.{field}",
                "kungfu runtime surface contract --json",
            )
    executable["digest"] = _root(
        executable.get("digest"),
        "executable.digest",
        nullable=surface == "hybrid-boundary",
    )
    source = _object(candidate.get("source"), "candidate.source")
    if set(source) != {"commit", "tree", "worktree"}:
        _fail(
            "runtime-surface-source-incomplete",
            "candidate source must explicitly contain commit, tree, and worktree",
            "kungfu runtime surface contract --json",
        )
    if surface in {"source-checkout", "hybrid-boundary"}:
        if not COMMIT_PATTERN.fullmatch(str(source.get("commit") or "")):
            _fail(
                "runtime-surface-source-commit",
                f"{surface} requires an exact source commit",
                "shifu source contract",
            )
        tree = str(source.get("tree") or "").removeprefix("git:")
        if not COMMIT_PATTERN.fullmatch(tree) or (
            surface == "source-checkout" and not source.get("worktree")
        ):
            _fail(
                "runtime-surface-source-tree",
                f"{surface} requires an exact source tree"
                + (" and worktree" if surface == "source-checkout" else ""),
                "shifu source contract",
            )
        source["tree"] = f"git:{tree}"
    elif any(value is not None for value in source.values()):
        _fail(
            "runtime-surface-product-source-contradiction",
            "installed-product candidates must use explicit null source coordinates",
            "kungfu runtime surface contract --json",
        )
    qualification = _object(candidate.get("qualification"), "candidate.qualification")
    if set(qualification) != {"state", "evidenceRoots"}:
        _fail(
            "runtime-surface-qualification-incomplete",
            "candidate qualification must contain state and evidenceRoots",
            "kungfu runtime surface contract --json",
        )
    state = str(qualification.get("state") or "")
    if state not in provider["qualificationStates"]:
        _fail(
            "runtime-surface-unqualified-evidence",
            f"candidate {provider_id} qualification state is not permitted",
            "kungfu health --json",
        )
    evidence_roots = sorted(
        {
            _root(item, "qualification.evidenceRoot")
            for item in qualification.get("evidenceRoots") or []
        }
    )
    if not evidence_roots:
        _fail(
            "runtime-surface-unqualified-evidence",
            f"candidate {provider_id} has no qualified evidence root",
            "kungfu health --json",
        )
    bundle_root = _root(candidate.get("bundleRoot"), "bundleRoot", nullable=True)
    if operation["id"] == "portable-bundle.consume" and bundle_root is None:
        _fail(
            "runtime-surface-bundle-root-missing",
            "portable bundle consumption requires an exact bundle root",
            "kungfu agent docs --verify --json",
        )
    return {
        "providerId": provider_id,
        "surface": surface,
        "capabilities": capabilities,
        "executable": executable,
        "source": source,
        "bundleRoot": bundle_root,
        "qualification": {"state": state, "evidenceRoots": evidence_roots},
    }


def resolve(
    request: Mapping[str, Any], contract: dict[str, Any] | None = None
) -> dict[str, Any]:
    contract = load_contract(contract)
    request = _object(request, "request")
    _exact_fields(request, REQUEST_FIELDS, "request")
    if request.get("schema") != REQUEST_SCHEMA:
        _fail(
            "runtime-surface-request-schema",
            "runtime surface request schema is unsupported",
            "kungfu runtime surface contract --json",
        )
    operations = {row["id"]: row for row in contract["operations"]}
    providers = {row["id"]: row for row in contract["providers"]}
    operation_id = str(request.get("operationId") or "")
    operation = operations.get(operation_id)
    if operation is None:
        _fail(
            "runtime-surface-operation-unknown",
            f"runtime surface operation is not governed: {operation_id or '<empty>'}",
            "kungfu runtime surface contract --json",
        )
    requested = str(request.get("requestedSurface") or "")
    if requested not in SURFACES:
        _fail(
            "runtime-surface-class-unknown",
            f"requested runtime surface is unknown: {requested or '<empty>'}",
            "kungfu runtime surface contract --json",
        )
    if (
        operation["selectionMode"] == "exact"
        and requested != operation["allowedSurfaces"][0]
    ):
        _fail(
            "runtime-surface-product-source-contradiction",
            f"operation {operation_id} requires {operation['allowedSurfaces'][0]}, not {requested}",
            "kungfu runtime surface contract --json",
        )
    normalized = [
        _normalize_candidate(raw, providers=providers, operation=operation)
        for raw in request.get("candidates") or []
    ]
    candidate_ids = [row["providerId"] for row in normalized]
    if len(candidate_ids) != len(set(candidate_ids)):
        _fail(
            "runtime-surface-candidate-ambiguous",
            "runtime surface candidates contain a duplicate provider",
            "kungfu runtime surface contract --json",
        )
    by_provider = {row["providerId"]: row for row in normalized}
    eligible = [
        by_provider[provider_id]
        for provider_id in operation["providerPreference"]
        if provider_id in by_provider
    ]
    fallback_request = _object(request.get("fallback") or {}, "request.fallback")
    if set(fallback_request) != {"allowed", "reason"}:
        _fail(
            "runtime-surface-fallback-incomplete",
            "request fallback must explicitly contain allowed and reason",
            "kungfu runtime surface contract --json",
        )
    selected = next((row for row in eligible if row["surface"] == requested), None)
    fallback_used = False
    fallback_reason: str | None = None
    if requested == "capability-negotiated":
        selected = eligible[0] if eligible else None
    elif selected is None and eligible:
        fallback = operation["fallback"]
        reason = str(fallback_request.get("reason") or "").strip()
        selected_candidate = eligible[0]
        if (
            fallback.get("mode") != "explicit-qualified"
            or fallback_request.get("allowed") is not True
            or selected_candidate["surface"] not in fallback.get("targets", [])
            or not reason
        ):
            _fail(
                "runtime-surface-fallback-forbidden",
                f"operation {operation_id} cannot silently switch from {requested}",
                "kungfu runtime surface contract --json",
            )
        selected = selected_candidate
        fallback_used = True
        fallback_reason = reason
    if selected is None:
        _fail(
            "runtime-surface-provider-unavailable",
            f"no qualified provider satisfies operation {operation_id} on {requested}",
            "kungfu runtime surface contract --json",
        )
    authority = _object(request.get("authorityRoots"), "request.authorityRoots")
    if set(authority) != {"assignmentRequestRoot", "workDefinitionRoot", "workRoot"}:
        _fail(
            "runtime-surface-authority-incomplete",
            "authorityRoots must explicitly contain Assignment request, Work definition, and Work roots",
            "kungfu runtime surface contract --json",
        )
    authority = {
        key: _root(value, f"authorityRoots.{key}", nullable=True)
        for key, value in authority.items()
    }
    body = {
        "schema": RECEIPT_SCHEMA,
        "contractRoot": _contract_root(contract),
        "operationId": operation_id,
        "runtimeSurface": selected["surface"],
        "selectedProvider": selected["providerId"],
        "executable": copy.deepcopy(selected["executable"]),
        "source": copy.deepcopy(selected["source"]),
        "bundleRoot": selected["bundleRoot"],
        "authorityRoots": authority,
        "capabilities": selected["capabilities"],
        "selection": {
            "mode": operation["selectionMode"],
            "requestedSurface": requested,
            "fallback": {
                "allowed": fallback_request.get("allowed") is True,
                "used": fallback_used,
                "from": requested if fallback_used else None,
                "to": selected["surface"] if fallback_used else None,
                "reason": fallback_reason,
            },
        },
        "qualification": copy.deepcopy(selected["qualification"]),
        "reason": (
            "contract-provider-preference"
            if requested == "capability-negotiated"
            else "explicit-qualified-fallback"
            if fallback_used
            else "exact-surface-match"
        ),
    }
    receipt = {**body, "receiptRoot": compute_content_hash(canonical_json_bytes(body))}
    verify(receipt, contract)
    return receipt


def verify(
    receipt: Mapping[str, Any], contract: dict[str, Any] | None = None
) -> dict[str, Any]:
    contract = load_contract(contract)
    value = _object(receipt, "receipt")
    try:
        contract_runtime.validate_json_schema(
            value, contract.get("receiptSchema"), "runtime-surface receipt"
        )
    except ValueError as error:
        _fail(
            "runtime-surface-receipt-schema",
            str(error),
            "kungfu runtime surface contract --json",
        )
    declared = str(value.get("receiptRoot") or "")
    body = {
        key: copy.deepcopy(item) for key, item in value.items() if key != "receiptRoot"
    }
    observed = compute_content_hash(canonical_json_bytes(body))
    if declared != observed:
        _fail(
            "runtime-surface-receipt-root",
            f"runtime surface receipt root mismatch: expected {declared}, observed {observed}",
            "kungfu runtime surface verify <receipt.json> --json",
        )
    if value.get("contractRoot") != _contract_root(contract):
        _fail(
            "runtime-surface-contract-root",
            "runtime surface receipt names a different contract root",
            "kungfu runtime surface contract --json",
        )
    operations = {row["id"]: row for row in contract["operations"]}
    providers = {row["id"]: row for row in contract["providers"]}
    operation = operations.get(value.get("operationId"))
    provider = providers.get(value.get("selectedProvider"))
    if (
        operation is None
        or provider is None
        or value.get("runtimeSurface") != provider.get("surfaceClass")
        or value.get("runtimeSurface") not in operation.get("allowedSurfaces", [])
        or not set(operation.get("requiredCapabilities", []))
        <= set(value.get("capabilities", []))
    ):
        _fail(
            "runtime-surface-receipt-authority",
            "runtime surface receipt disagrees with its operation or provider authority",
            "kungfu runtime surface contract --json",
        )
    normalized = _normalize_candidate(
        {
            "providerId": value["selectedProvider"],
            "surface": value["runtimeSurface"],
            "capabilities": value["capabilities"],
            "executable": value["executable"],
            "source": value["source"],
            "bundleRoot": value["bundleRoot"],
            "qualification": value["qualification"],
        },
        providers=providers,
        operation=operation,
    )
    if normalized["providerId"] not in operation["providerPreference"]:
        _fail(
            "runtime-surface-receipt-authority",
            "runtime surface receipt selects a provider outside operation preference",
            "kungfu runtime surface contract --json",
        )
    authority = value["authorityRoots"]
    for key in ("assignmentRequestRoot", "workDefinitionRoot", "workRoot"):
        _root(authority.get(key), f"authorityRoots.{key}", nullable=True)
    selection = value["selection"]
    requested = selection["requestedSurface"]
    if requested not in SURFACES or selection["mode"] != operation["selectionMode"]:
        _fail(
            "runtime-surface-receipt-selection",
            "runtime surface receipt selection mode or requested class is invalid",
            "kungfu runtime surface contract --json",
        )
    selected_surface = value["runtimeSurface"]
    if operation["selectionMode"] == "exact" and (
        requested != operation["allowedSurfaces"][0] or selected_surface != requested
    ):
        _fail(
            "runtime-surface-receipt-selection",
            "exact runtime surface receipt contradicts the operation requirement",
            "kungfu runtime surface contract --json",
        )
    fallback = value["selection"]["fallback"]
    if fallback["used"] and (
        operation["fallback"]["mode"] != "explicit-qualified"
        or fallback["allowed"] is not True
        or requested == "capability-negotiated"
        or fallback["from"] != requested
        or fallback["to"] != selected_surface
        or fallback["to"] not in operation["fallback"]["targets"]
        or not fallback["reason"]
    ):
        _fail(
            "runtime-surface-receipt-fallback",
            "runtime surface receipt contains an unauthorized fallback",
            "kungfu runtime surface contract --json",
        )
    if (
        not fallback["used"]
        and requested != "capability-negotiated"
        and requested != selected_surface
    ):
        _fail(
            "runtime-surface-receipt-selection",
            "runtime surface changed without a qualified fallback",
            "kungfu runtime surface contract --json",
        )
    if not fallback["used"] and any(
        fallback.get(key) is not None for key in ("from", "to", "reason")
    ):
        _fail(
            "runtime-surface-receipt-fallback",
            "runtime surface receipt contains dormant fallback coordinates",
            "kungfu runtime surface contract --json",
        )
    expected_reason = (
        "contract-provider-preference"
        if requested == "capability-negotiated"
        else "explicit-qualified-fallback"
        if fallback["used"]
        else "exact-surface-match"
    )
    if value["reason"] != expected_reason:
        _fail(
            "runtime-surface-receipt-reason",
            "runtime surface receipt selection reason contradicts its decision",
            "kungfu runtime surface contract --json",
        )
    return {
        "schema": "kungfu.runtime-surface-verification/v1",
        "ok": True,
        "receiptRoot": declared,
        "contractRoot": value["contractRoot"],
        "operationId": value["operationId"],
        "runtimeSurface": value["runtimeSurface"],
        "selectedProvider": value["selectedProvider"],
    }


def loads_object(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        _fail(
            "runtime-surface-json-invalid",
            f"{label} is not valid JSON: {error}",
            "kungfu runtime surface contract --json",
        )
    return _object(value, label)
