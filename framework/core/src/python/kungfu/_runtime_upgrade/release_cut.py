# SPDX-License-Identifier: Apache-2.0

"""Product Release Cut validation and transition decision ownership."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from kungfu._runtime_upgrade.common import LEGACY_BOOTSTRAP_MODE, _upgrade_facade_seam

RELEASE_CUT_SCHEMA = "kungfu.product-release-cut/v1"
PLATFORM_SLICE_SCHEMA = "kungfu.product-release-platform-slice/v1"
CUT_TRANSITION_SCHEMA = "kungfu.product-release-cut-transition/v1"
CUT_DECISION_SCHEMA = "kungfu.product-release-cut-decision/v1"

_ROOT = re.compile(r"^sha256:[a-f0-9]{64}$")
_SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_PLATFORMS = {"darwin", "linux", "win32"}
_ARCHITECTURES = {"arm64", "x64"}
_RELATIONS = {
    "verified-successor",
    "ancestor",
    "recovery",
    "diverged",
    "unknown",
}
_PUBLIC_AUTHORIZATIONS = {"signed-lineage", "signed-supersession", "incident-recovery"}
_LOCAL_AUTHORIZATIONS = {
    "shifu-local-bootstrap",
    "shifu-local-successor",
    "shifu-local-recovery",
}
_MANIFEST_CUT_FIELDS = {
    "manifestIdentityRoot",
    "releaseCut",
    "releaseCutRoot",
    "platformSliceRoot",
    "cutTransition",
    "artifacts",
    "localArtifact",
    "qualificationEvidenceRef",
}


class ReleaseCutError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def canonical_json_bytes(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ReleaseCutError(
            "release-cut-noncanonical",
            "Release Cut values must be canonical JSON without non-finite numbers",
        ) from error
    return encoded.encode("ascii")


def content_root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"


def manifest_identity_root(manifest: Mapping[str, Any]) -> str:
    """Root the manifest identity before its Release Cut projection is attached."""

    identity = {
        key: copy.deepcopy(value)
        for key, value in manifest.items()
        if key not in _MANIFEST_CUT_FIELDS
    }
    return content_root(identity)


def _require_exact_fields(
    value: Mapping[str, Any], expected: set[str], label: str
) -> None:
    if set(value) != expected:
        raise ReleaseCutError(
            f"{label}-fields-invalid",
            f"{label.replace('-', ' ')} fields are incomplete or unsupported",
        )


def _require_string(value: Mapping[str, Any], field: str, label: str) -> str:
    item = value.get(field)
    if not isinstance(item, str) or not item:
        raise ReleaseCutError(
            f"{label}-invalid", f"{label.replace('-', ' ')} {field} is invalid"
        )
    return item


def _require_root(value: Any, field: str, label: str) -> str:
    if not isinstance(value, str) or _ROOT.fullmatch(value) is None:
        raise ReleaseCutError(
            f"{label}-root-invalid",
            f"{label.replace('-', ' ')} {field} is not a sha256 root",
        )
    return value


def _root_list(
    value: Any,
    field: str,
    label: str,
    *,
    allow_empty: bool = True,
) -> list[str]:
    if (
        not isinstance(value, list)
        or (not allow_empty and not value)
        or any(
            not isinstance(item, str) or _ROOT.fullmatch(item) is None for item in value
        )
    ):
        raise ReleaseCutError(
            f"{label}-root-list-invalid",
            f"{label.replace('-', ' ')} {field} is not a root list",
        )
    if value != sorted(set(value)):
        raise ReleaseCutError(
            f"{label}-root-list-noncanonical",
            f"{label.replace('-', ' ')} {field} must be sorted and duplicate-free",
        )
    return list(value)


def validate_platform_slice(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    _require_exact_fields(
        result,
        {
            "schema",
            "platform",
            "architecture",
            "manifestIdentityRoot",
            "artifactRoot",
            "qualificationEvidenceRoots",
            "signingEvidenceRoots",
            "platformSliceRoot",
        },
        "platform-slice",
    )
    if result.get("schema") != PLATFORM_SLICE_SCHEMA:
        raise ReleaseCutError(
            "platform-slice-schema-unsupported",
            "platform slice schema is unsupported",
        )
    platform = _require_string(result, "platform", "platform-slice")
    architecture = _require_string(result, "architecture", "platform-slice")
    if platform not in _PLATFORMS or architecture not in _ARCHITECTURES:
        raise ReleaseCutError(
            "platform-slice-target-invalid",
            "platform slice target is unsupported",
        )
    _require_root(
        result.get("manifestIdentityRoot"), "manifestIdentityRoot", "platform-slice"
    )
    _require_root(result.get("artifactRoot"), "artifactRoot", "platform-slice")
    _root_list(
        result.get("qualificationEvidenceRoots"),
        "qualificationEvidenceRoots",
        "platform-slice",
        allow_empty=False,
    )
    _root_list(
        result.get("signingEvidenceRoots"), "signingEvidenceRoots", "platform-slice"
    )
    observed = _require_root(
        result.get("platformSliceRoot"), "platformSliceRoot", "platform-slice"
    )
    expected = content_root(
        {key: item for key, item in result.items() if key != "platformSliceRoot"}
    )
    if observed != expected:
        raise ReleaseCutError(
            "platform-slice-root-mismatch",
            "platform slice root did not verify",
        )
    return result


def finish_platform_slice(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result["platformSliceRoot"] = content_root(result)
    return validate_platform_slice(result)


def validate_release_cut(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    _require_exact_fields(
        result,
        {
            "schema",
            "productVersion",
            "parentReleaseCutRoots",
            "sourceSettlementRoot",
            "semanticIdentityRoot",
            "productAssemblyRoot",
            "compatibilityContractRoot",
            "migrationContractRoot",
            "platformSlices",
            "qualificationEvidenceRoots",
            "signingEvidenceRoots",
            "publicationPolicy",
            "omissionRoots",
            "waiverRoots",
            "releaseCutRoot",
        },
        "release-cut",
    )
    if result.get("schema") != RELEASE_CUT_SCHEMA:
        raise ReleaseCutError(
            "release-cut-schema-unsupported", "Release Cut schema is unsupported"
        )
    version = _require_string(result, "productVersion", "release-cut")
    if _SEMVER.fullmatch(version) is None:
        raise ReleaseCutError(
            "release-cut-version-invalid", "Release Cut productVersion is not SemVer"
        )
    for field in (
        "sourceSettlementRoot",
        "semanticIdentityRoot",
        "productAssemblyRoot",
        "compatibilityContractRoot",
        "migrationContractRoot",
    ):
        _require_root(result.get(field), field, "release-cut")
    _root_list(
        result.get("parentReleaseCutRoots"), "parentReleaseCutRoots", "release-cut"
    )
    _root_list(
        result.get("qualificationEvidenceRoots"),
        "qualificationEvidenceRoots",
        "release-cut",
        allow_empty=False,
    )
    signing = _root_list(
        result.get("signingEvidenceRoots"), "signingEvidenceRoots", "release-cut"
    )
    _root_list(result.get("omissionRoots"), "omissionRoots", "release-cut")
    _root_list(result.get("waiverRoots"), "waiverRoots", "release-cut")

    slices = result.get("platformSlices")
    if not isinstance(slices, list) or not slices:
        raise ReleaseCutError(
            "release-cut-slices-missing", "Release Cut has no platform slices"
        )
    result["platformSlices"] = [validate_platform_slice(item) for item in slices]
    slice_keys = [
        (item["platform"], item["architecture"]) for item in result["platformSlices"]
    ]
    if slice_keys != sorted(set(slice_keys)):
        raise ReleaseCutError(
            "release-cut-slices-noncanonical",
            "Release Cut platform slices must be sorted and target-unique",
        )

    policy = result.get("publicationPolicy")
    if not isinstance(policy, Mapping):
        raise ReleaseCutError(
            "release-cut-policy-invalid", "Release Cut publication policy is missing"
        )
    policy = copy.deepcopy(dict(policy))
    _require_exact_fields(
        policy,
        {"trustDomain", "publicationEligible", "immutable", "eligibleChannels"},
        "release-cut-policy",
    )
    trust_domain = _require_string(policy, "trustDomain", "release-cut-policy")
    channels = policy.get("eligibleChannels")
    if (
        not isinstance(policy.get("publicationEligible"), bool)
        or not isinstance(policy.get("immutable"), bool)
        or not isinstance(channels, list)
        or channels != sorted(set(channels))
        or any(item not in {"alpha", "stable"} for item in channels)
    ):
        raise ReleaseCutError(
            "release-cut-policy-invalid", "Release Cut publication policy is invalid"
        )
    if trust_domain == "public":
        if not policy["publicationEligible"] or not policy["immutable"] or not channels:
            raise ReleaseCutError(
                "public-release-policy-invalid",
                "public Release Cuts must be immutable and publication eligible",
            )
        if not signing or any(
            not item["signingEvidenceRoots"] for item in result["platformSlices"]
        ):
            raise ReleaseCutError(
                "public-release-signing-missing",
                "public Release Cuts require signing evidence for every slice",
            )
    elif trust_domain == "shifu-local":
        if policy["publicationEligible"] or channels:
            raise ReleaseCutError(
                "local-release-publication-eligible",
                "shifu-local Release Cuts cannot enter public channels",
            )
    else:
        raise ReleaseCutError(
            "release-cut-trust-domain-unsupported",
            "Release Cut trust domain is unsupported",
        )
    result["publicationPolicy"] = policy

    observed = _require_root(
        result.get("releaseCutRoot"), "releaseCutRoot", "release-cut"
    )
    expected = content_root(
        {key: item for key, item in result.items() if key != "releaseCutRoot"}
    )
    if observed != expected:
        raise ReleaseCutError(
            "release-cut-root-mismatch", "Release Cut root did not verify"
        )
    return result


def finish_release_cut(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result["releaseCutRoot"] = content_root(result)
    return validate_release_cut(result)


def validate_cut_transition(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    _require_exact_fields(
        result,
        {
            "schema",
            "fromReleaseCutRoot",
            "toReleaseCutRoot",
            "fromProductVersion",
            "toProductVersion",
            "relation",
            "authorization",
            "compatibility",
            "migrationPlanRoot",
            "rollbackPlanRoot",
            "activeWorkPolicy",
            "evidenceRoots",
            "diagnostics",
            "cutTransitionRoot",
        },
        "cut-transition",
    )
    if result.get("schema") != CUT_TRANSITION_SCHEMA:
        raise ReleaseCutError(
            "cut-transition-schema-unsupported",
            "Cut Transition schema is unsupported",
        )
    for field in (
        "fromReleaseCutRoot",
        "toReleaseCutRoot",
        "migrationPlanRoot",
        "rollbackPlanRoot",
    ):
        _require_root(result.get(field), field, "cut-transition")
    for field in ("fromProductVersion", "toProductVersion"):
        version = _require_string(result, field, "cut-transition")
        if _SEMVER.fullmatch(version) is None:
            raise ReleaseCutError(
                "cut-transition-version-invalid",
                "Cut Transition product version is not SemVer",
            )
    relation = _require_string(result, "relation", "cut-transition")
    if relation not in _RELATIONS:
        raise ReleaseCutError(
            "cut-transition-relation-unsupported",
            "Cut Transition relation is unsupported",
        )
    _root_list(
        result.get("evidenceRoots"),
        "evidenceRoots",
        "cut-transition",
        allow_empty=False,
    )
    authorization = result.get("authorization")
    if not isinstance(authorization, Mapping):
        raise ReleaseCutError(
            "cut-transition-authorization-invalid",
            "Cut Transition authorization is missing",
        )
    authorization = copy.deepcopy(dict(authorization))
    _require_exact_fields(
        authorization,
        {"trustDomain", "kind", "publicationEligible", "evidenceRoots"},
        "cut-transition-authorization",
    )
    trust_domain = _require_string(
        authorization, "trustDomain", "cut-transition-authorization"
    )
    kind = _require_string(authorization, "kind", "cut-transition-authorization")
    _root_list(
        authorization.get("evidenceRoots"),
        "evidenceRoots",
        "cut-transition-authorization",
        allow_empty=False,
    )
    if not isinstance(authorization.get("publicationEligible"), bool):
        raise ReleaseCutError(
            "cut-transition-authorization-invalid",
            "Cut Transition publication eligibility is invalid",
        )
    if trust_domain == "public":
        if (
            kind not in _PUBLIC_AUTHORIZATIONS
            or not authorization["publicationEligible"]
        ):
            raise ReleaseCutError(
                "public-transition-authorization-invalid",
                "public Cut Transition lacks signed lineage, supersession, or recovery authority",
            )
    elif trust_domain == "shifu-local":
        if kind not in _LOCAL_AUTHORIZATIONS or authorization["publicationEligible"]:
            raise ReleaseCutError(
                "local-transition-publication-eligible",
                "shifu-local Cut Transitions cannot authorize public publication",
            )
        if kind == "shifu-local-bootstrap" and relation != "verified-successor":
            raise ReleaseCutError(
                "local-bootstrap-relation-invalid",
                "local bootstrap must create one explicit successor transition",
            )
    else:
        raise ReleaseCutError(
            "cut-transition-trust-domain-unsupported",
            "Cut Transition trust domain is unsupported",
        )
    result["authorization"] = authorization

    compatibility = result.get("compatibility")
    if not isinstance(compatibility, Mapping):
        raise ReleaseCutError(
            "cut-transition-compatibility-invalid",
            "Cut Transition compatibility decision is missing",
        )
    compatibility = copy.deepcopy(dict(compatibility))
    _require_exact_fields(
        compatibility,
        {
            "controlProtocol",
            "peerWireProtocol",
            "journalReadable",
            "migrationClass",
            "rollbackClass",
            "providerResumeRequired",
        },
        "cut-transition-compatibility",
    )
    if (
        any(
            not isinstance(compatibility.get(field), bool)
            for field in (
                "controlProtocol",
                "peerWireProtocol",
                "journalReadable",
                "providerResumeRequired",
            )
        )
        or compatibility.get("migrationClass")
        not in {
            "none",
            "reversible",
            "irreversible",
        }
        or compatibility.get("rollbackClass") not in {"automatic", "manual", "none"}
    ):
        raise ReleaseCutError(
            "cut-transition-compatibility-invalid",
            "Cut Transition compatibility decision is invalid",
        )
    result["compatibility"] = compatibility
    if (
        result.get("activeWorkPolicy")
        not in {
            "keep-pinned",
            "compatible-handoff",
            "provider-resume",
            "defer-until-idle",
        }
        or not isinstance(result.get("diagnostics"), list)
        or any(not isinstance(item, str) or not item for item in result["diagnostics"])
    ):
        raise ReleaseCutError(
            "cut-transition-policy-invalid",
            "Cut Transition active-work policy or diagnostics are invalid",
        )
    observed = _require_root(
        result.get("cutTransitionRoot"), "cutTransitionRoot", "cut-transition"
    )
    expected = content_root(
        {key: item for key, item in result.items() if key != "cutTransitionRoot"}
    )
    if observed != expected:
        raise ReleaseCutError(
            "cut-transition-root-mismatch",
            "Cut Transition root did not verify",
        )
    return result


def finish_cut_transition(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    result["cutTransitionRoot"] = content_root(result)
    return validate_cut_transition(result)


def build_shifu_local_transition(
    *,
    current_release_cut_root: str,
    current_version: str,
    target_cut: Mapping[str, Any],
    relation: str,
    authorization_kind: str,
    compatibility: Mapping[str, Any],
    migration_plan_root: str,
    rollback_plan_root: str,
    active_work_policy: str,
    evidence_roots: list[str],
    diagnostics: list[str] | None = None,
) -> dict[str, Any]:
    """Build the exact publication-ineligible transition selected by Shifu."""

    target = validate_release_cut(target_cut)
    if target["publicationPolicy"]["trustDomain"] != "shifu-local":
        raise ReleaseCutError(
            "local-release-policy-mismatch",
            "Shifu local transitions require a shifu-local target Cut",
        )
    evidence = sorted(set(evidence_roots))
    transition = {
        "schema": CUT_TRANSITION_SCHEMA,
        "fromReleaseCutRoot": _require_root(
            current_release_cut_root,
            "currentReleaseCutRoot",
            "shifu-local-transition",
        ),
        "toReleaseCutRoot": target["releaseCutRoot"],
        "fromProductVersion": current_version,
        "toProductVersion": target["productVersion"],
        "relation": relation,
        "authorization": {
            "trustDomain": "shifu-local",
            "kind": authorization_kind,
            "publicationEligible": False,
            "evidenceRoots": evidence,
        },
        "compatibility": copy.deepcopy(dict(compatibility)),
        "migrationPlanRoot": migration_plan_root,
        "rollbackPlanRoot": rollback_plan_root,
        "activeWorkPolicy": active_work_policy,
        "evidenceRoots": evidence,
        "diagnostics": list(diagnostics or []),
    }
    return finish_cut_transition(transition)


def is_legacy_bootstrap(selection: Mapping[str, Any]) -> bool:
    return selection.get("selectionMode") == LEGACY_BOOTSTRAP_MODE


def legacy_coordinate(
    release_cut_root: Any,
    product_version: Any,
) -> dict[str, Any]:
    return {
        "kind": LEGACY_BOOTSTRAP_MODE,
        "releaseCutRoot": release_cut_root,
        "productVersion": product_version,
    }


def image_coordinate(image: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "frontendBuildId": image["frontendBuildId"],
        "runtimeBuildId": image["runtimeBuildId"],
        "artifactDigest": image["artifactDigest"],
        "productRoot": image["productRoot"],
        **(
            {
                "releaseCutRoot": image["releaseCutRoot"],
                "platformSliceRoot": image["platformSliceRoot"],
            }
            if image.get("releaseCutRoot")
            else {}
        ),
    }


def legacy_selection_is_bound(
    selection: Mapping[str, Any],
    transition: Mapping[str, Any] | None,
) -> bool:
    return bool(
        transition is not None
        and transition.get("toReleaseCutRoot") == selection.get("releaseCutRoot")
        and transition.get("toProductVersion") == selection.get("productVersion")
    )


def manifest_compatibility(
    current: Mapping[str, Any] | None,
    target: Mapping[str, Any],
) -> dict[str, Any]:
    def ranges_overlap(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
        return max(int(left["min"]), int(right["min"])) <= min(
            int(left["max"]), int(right["max"])
        )

    if current is None:
        control_protocol = peer_wire_protocol = journal_readable = True
    else:
        control_protocol = ranges_overlap(
            current["controlProtocolRange"], target["controlProtocolRange"]
        )
        peer_wire_protocol = ranges_overlap(
            current["peerWireProtocolRange"], target["peerWireProtocolRange"]
        )
        journal_write = int(current["journalSchemaWriteVersion"])
        journal_readable = (
            int(target["journalSchemaReadRange"]["min"])
            <= journal_write
            <= int(target["journalSchemaReadRange"]["max"])
        )
    return {
        "controlProtocol": control_protocol,
        "peerWireProtocol": peer_wire_protocol,
        "journalReadable": journal_readable,
        "migrationClass": target["migrationClass"],
        "rollbackClass": target["rollbackClass"],
        "providerResumeRequired": target["migrationClass"] != "none",
    }


def shifu_local_transition(
    *,
    current_release_cut_root: str,
    current_version: str,
    current_manifest: Mapping[str, Any] | None,
    target_manifest: Mapping[str, Any],
    authorization_kind: str,
    evidence_roots: list[str],
    relation: str = "verified-successor",
) -> dict[str, Any]:
    target_cut = target_manifest["releaseCut"]
    compatibility = manifest_compatibility(current_manifest, target_manifest)
    return build_shifu_local_transition(
        current_release_cut_root=current_release_cut_root,
        current_version=current_version,
        target_cut=target_cut,
        relation=relation,
        authorization_kind=authorization_kind,
        compatibility=compatibility,
        migration_plan_root=content_root(
            {
                "migrationClass": target_manifest["migrationClass"],
                "runtimeBuildId": target_manifest["runtimeBuildId"],
                "targetReleaseCutRoot": target_cut["releaseCutRoot"],
            }
        ),
        rollback_plan_root=content_root(
            {
                "rollbackClass": target_manifest["rollbackClass"],
                "currentReleaseCutRoot": current_release_cut_root,
                "targetReleaseCutRoot": target_cut["releaseCutRoot"],
            }
        ),
        active_work_policy=(
            "provider-resume"
            if compatibility["providerResumeRequired"]
            else "keep-pinned"
        ),
        evidence_roots=evidence_roots,
        diagnostics=[],
    )


def image_selection(
    image: Mapping[str, Any],
    *,
    schema: str,
    generation: int,
    transition_root: Any,
    transition: Mapping[str, Any] | None,
    previous_frontend_build_id: Any,
    rollback: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "schema": schema,
        "generation": generation,
        "frontendBuildId": image["frontendBuildId"],
        "runtimeBuildId": image["runtimeBuildId"],
        "artifactDigest": image["artifactDigest"],
        "productRoot": image["productRoot"],
        **(
            {
                "manifestIdentityRoot": image["manifestIdentityRoot"],
                "releaseCutRoot": image["releaseCutRoot"],
                "platformSliceRoot": image["platformSliceRoot"],
                "cutTransitionRoot": transition_root,
                "cutTransition": (
                    copy.deepcopy(dict(transition)) if transition is not None else None
                ),
            }
            if image.get("releaseCutRoot")
            else {}
        ),
        "previousFrontendBuildId": previous_frontend_build_id,
        "rollback": copy.deepcopy(dict(rollback)) if rollback is not None else None,
    }


def legacy_selection(
    *,
    schema: str,
    generation: int,
    release_cut_root: str,
    product_version: str,
    transition: Mapping[str, Any],
    previous_frontend_build_id: Any,
    rollback: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schema": schema,
        "selectionMode": LEGACY_BOOTSTRAP_MODE,
        "generation": generation,
        "releaseCutRoot": release_cut_root,
        "productVersion": product_version,
        "cutTransitionRoot": transition["cutTransitionRoot"],
        "cutTransition": copy.deepcopy(dict(transition)),
        "previousFrontendBuildId": previous_frontend_build_id,
        "rollback": copy.deepcopy(dict(rollback)),
    }


def legacy_recovery_transition(
    *,
    current_release_cut_root: str,
    current_version: str,
    target_release_cut_root: str,
    target_version: str,
    compatibility: Mapping[str, Any],
    evidence_roots: list[str],
) -> dict[str, Any]:
    evidence = sorted(set(evidence_roots))
    return finish_cut_transition(
        {
            "schema": CUT_TRANSITION_SCHEMA,
            "fromReleaseCutRoot": current_release_cut_root,
            "toReleaseCutRoot": target_release_cut_root,
            "fromProductVersion": current_version,
            "toProductVersion": target_version,
            "relation": "recovery",
            "authorization": {
                "trustDomain": "shifu-local",
                "kind": "shifu-local-recovery",
                "publicationEligible": False,
                "evidenceRoots": evidence,
            },
            "compatibility": copy.deepcopy(dict(compatibility)),
            "migrationPlanRoot": content_root(
                {
                    "migrationClass": "none",
                    "targetReleaseCutRoot": target_release_cut_root,
                }
            ),
            "rollbackPlanRoot": content_root(
                {
                    "rollbackClass": "automatic",
                    "currentReleaseCutRoot": current_release_cut_root,
                    "targetReleaseCutRoot": target_release_cut_root,
                }
            ),
            "activeWorkPolicy": "keep-pinned",
            "evidenceRoots": evidence,
            "diagnostics": [],
        }
    )


def decide_cut_transition(
    *,
    current_release_cut_root: str,
    current_version: str,
    target_cut: Mapping[str, Any],
    transition: Mapping[str, Any] | None,
) -> dict[str, Any]:
    current_root = _require_root(
        current_release_cut_root, "currentReleaseCutRoot", "cut-decision"
    )
    target = validate_release_cut(target_cut)
    target_root = target["releaseCutRoot"]
    target_version = target["productVersion"]
    if current_root == target_root:
        return {
            "schema": CUT_DECISION_SCHEMA,
            "outcome": "identical",
            "reasonCode": "already-current",
            "currentReleaseCutRoot": current_root,
            "targetReleaseCutRoot": target_root,
            "currentVersion": current_version,
            "targetVersion": target_version,
            "cutTransitionRoot": None,
            "updateAllowed": False,
            "approvalRequired": False,
        }
    if transition is None:
        return {
            "schema": CUT_DECISION_SCHEMA,
            "outcome": "unknown",
            "reasonCode": (
                "cut-conflict"
                if current_version == target_version
                else "cut-relation-unknown"
            ),
            "currentReleaseCutRoot": current_root,
            "targetReleaseCutRoot": target_root,
            "currentVersion": current_version,
            "targetVersion": target_version,
            "cutTransitionRoot": None,
            "updateAllowed": False,
            "approvalRequired": False,
        }
    movement = validate_cut_transition(transition)
    if (
        movement["fromReleaseCutRoot"] != current_root
        or movement["toReleaseCutRoot"] != target_root
        or movement["fromProductVersion"] != current_version
        or movement["toProductVersion"] != target_version
        or movement["authorization"]["trustDomain"]
        != target["publicationPolicy"]["trustDomain"]
    ):
        raise ReleaseCutError(
            "cut-transition-binding-mismatch",
            "Cut Transition does not bind the current and target Release Cuts",
        )
    relation = movement["relation"]
    authorization_kind = movement["authorization"]["kind"]
    if (
        relation == "verified-successor"
        and authorization_kind != "shifu-local-bootstrap"
        and current_root not in target["parentReleaseCutRoots"]
    ):
        raise ReleaseCutError(
            "cut-transition-lineage-mismatch",
            "successor Cut does not bind the current Release Cut as a parent",
        )
    if (
        authorization_kind == "shifu-local-bootstrap"
        and target["publicationPolicy"]["trustDomain"] != "shifu-local"
    ):
        raise ReleaseCutError(
            "local-bootstrap-publication-forbidden",
            "local bootstrap authority cannot target a public Release Cut",
        )
    compatible = all(
        movement["compatibility"][field]
        for field in ("controlProtocol", "peerWireProtocol", "journalReadable")
    )
    policy_reason = None
    compatibility = movement["compatibility"]
    if compatibility["migrationClass"] == "irreversible":
        policy_reason = "irreversible-migration-needs-approval"
    elif compatibility["rollbackClass"] == "none":
        policy_reason = "rollback-unavailable"
    elif compatibility["rollbackClass"] == "manual":
        policy_reason = "manual-rollback-needs-approval"
    elif compatibility["providerResumeRequired"]:
        policy_reason = "provider-resume-required"
    elif movement["activeWorkPolicy"] == "provider-resume":
        policy_reason = "provider-resume-required"
    elif movement["activeWorkPolicy"] == "defer-until-idle":
        policy_reason = "active-work-must-be-idle"
    update_allowed = (
        relation == "verified-successor" and compatible and policy_reason is None
    )
    approval_required = relation == "recovery" or policy_reason is not None
    reason = {
        "verified-successor": (
            (
                "verified-local-bootstrap"
                if authorization_kind == "shifu-local-bootstrap"
                else "verified-cut-successor"
            )
            if update_allowed
            else "cut-successor-incompatible"
        ),
        "ancestor": "cut-ancestor",
        "recovery": "cut-recovery-approval-required",
        "diverged": "cut-diverged",
        "unknown": "cut-relation-unknown",
    }[relation]
    if (
        update_allowed
        and current_version == target_version
        and movement["authorization"]["trustDomain"] == "public"
        and movement["authorization"]["kind"] != "signed-supersession"
    ):
        update_allowed = False
        reason = "cut-conflict"
    elif relation == "verified-successor" and policy_reason is not None:
        reason = policy_reason
    return {
        "schema": CUT_DECISION_SCHEMA,
        "outcome": relation,
        "reasonCode": reason,
        "currentReleaseCutRoot": current_root,
        "targetReleaseCutRoot": target_root,
        "currentVersion": current_version,
        "targetVersion": target_version,
        "cutTransitionRoot": movement["cutTransitionRoot"],
        "updateAllowed": update_allowed,
        "approvalRequired": approval_required,
    }


for _upgrade_name in (
    "canonical_json_bytes",
    "content_root",
    "manifest_identity_root",
    "_require_exact_fields",
    "_require_string",
    "_require_root",
    "_root_list",
    "validate_platform_slice",
    "finish_platform_slice",
    "validate_release_cut",
    "finish_release_cut",
    "validate_cut_transition",
    "finish_cut_transition",
    "build_shifu_local_transition",
    "is_legacy_bootstrap",
    "legacy_coordinate",
    "image_coordinate",
    "legacy_selection_is_bound",
    "manifest_compatibility",
    "shifu_local_transition",
    "image_selection",
    "legacy_selection",
    "legacy_recovery_transition",
    "decide_cut_transition",
):
    globals()[_upgrade_name] = _upgrade_facade_seam(_upgrade_name)(
        globals()[_upgrade_name]
    )
del _upgrade_name
