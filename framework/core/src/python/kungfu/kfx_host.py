"""Thin host projection for the Core-owned KFX Experience/Flow descriptor."""

from __future__ import annotations

from typing import Any


HOSTS = frozenset({"gui", "tui", "cli", "agent"})


def project_control_suite_host(status: dict[str, Any], host: str) -> dict[str, Any]:
    """Retain the exact Core Control status across every presentation host."""

    if host not in HOSTS:
        raise ValueError(f"unsupported KFX host: {host}")
    if (
        status.get("schema") != "kungfu.kfx.control-suite-status/v1"
        or status.get("controllerId") != "kungfu-kfx-control-suite"
        or not str(status.get("statusRoot") or "").startswith("sha256:")
        or (status.get("mode") == "active") != bool(status.get("executionAllowed"))
        or (status.get("cutRoot") is None) != (status.get("revision") == 0)
    ):
        raise ValueError("KFX Control status identity does not match")
    return {
        "schema": "kungfu.kfx.control-host-projection/v1",
        "host": host,
        "controllerId": status["controllerId"],
        "statusRoot": status["statusRoot"],
        "cutRoot": status["cutRoot"],
        "revision": status["revision"],
        "mode": status["mode"],
        "executionAllowed": status["executionAllowed"],
        "diagnostics": status["diagnostics"],
    }


def project_experience_flow_host(
    descriptor: dict[str, Any], host: str
) -> dict[str, Any]:
    """Retain Core identities while adding only host-native availability."""

    if descriptor.get("schema") != "kungfu.kfx.experience-flow-host/v3":
        raise ValueError("unsupported KFX Experience/Flow host descriptor")
    if host not in HOSTS:
        raise ValueError(f"unsupported KFX host: {host}")
    for field in (
        "descriptorRoot",
        "registryRoot",
        "graphRoot",
        "planRoot",
        "receiptDependencyRoot",
        "cutRoot",
        "revision",
        "generation",
        "generationRoot",
        "admission",
        "runtimeAuthorizations",
        "contributions",
    ):
        if field not in descriptor:
            raise ValueError(f"KFX host descriptor is missing {field}")

    admission = descriptor["admission"]
    generation = descriptor["generation"]
    if (
        admission.get("schema") != "kungfu.kfx.host-admission/v2"
        or admission.get("exactRootRequired") is not True
        or admission.get("registryRoot") != descriptor["registryRoot"]
        or admission.get("graphRoot") != descriptor["graphRoot"]
        or admission.get("planRoot") != descriptor["planRoot"]
        or admission.get("cutRoot") != descriptor["cutRoot"]
        or admission.get("revision") != descriptor["revision"]
        or admission.get("generationRoot") != descriptor["generationRoot"]
        or generation.get("registryRoot") != descriptor["registryRoot"]
        or generation.get("graphRoot") != descriptor["graphRoot"]
        or generation.get("cutRoot") != descriptor["cutRoot"]
        or generation.get("revision") != descriptor["revision"]
        or len(admission.get("runtimeAuthorizationRoots", []))
        != len(descriptor["runtimeAuthorizations"])
        or (admission.get("state") == "admitted") != (descriptor["cutRoot"] is not None)
    ):
        raise ValueError("KFX host descriptor admission identity does not match")
    for index, authorization in enumerate(descriptor["runtimeAuthorizations"]):
        if (
            admission["runtimeAuthorizationRoots"][index]
            != authorization.get("authorizationRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
            or authorization.get("generationRoot") != descriptor["generationRoot"]
        ):
            raise ValueError("KFX runtime authorization identity does not match")

    diagnostics = []
    if admission["state"] != "admitted":
        diagnostics.append(
            {
                "code": "KF_KFX_HOST_NOT_ADMITTED",
                "recoveryGuidance": ["settle-exact-kfx-fact-cut"],
            }
        )
    contributions = []
    for contribution in descriptor["contributions"]:
        try:
            index = admission["contributionRoots"].index(
                contribution["contributionRoot"]
            )
        except (KeyError, ValueError) as error:
            raise ValueError(
                "KFX host contribution admission identity does not match"
            ) from error
        authorization = contribution.get("authorization") or {}
        if (
            admission["facetRoots"][index] != contribution.get("facetRoot")
            or admission["capabilityRoots"][index] != contribution.get("capabilityRoot")
            or admission["authorizationRoots"][index]
            != authorization.get("authorizationRoot")
            or authorization.get("ownerProviderRoot")
            != contribution.get("ownerProviderRoot")
            or authorization.get("trustRoot") != contribution.get("ownerTrustRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
            or authorization.get("generationRoot") != descriptor["generationRoot"]
            or (
                admission["state"] == "admitted"
                and (
                    not authorization.get("capabilityDeclarationRoot")
                    or not authorization.get("capabilityGrantRoot")
                    or not authorization.get("corePolicyRoot")
                    or not authorization.get("requestedPolicyRoot")
                    or not authorization.get("policyRoot")
                    or not authorization.get("warrantRoot")
                    or not set(authorization.get("requiredCapabilities", []))
                    <= set(authorization.get("grantedCapabilities", []))
                )
            )
        ):
            raise ValueError("KFX host contribution admission identity does not match")
        projection = dict(contribution)
        presentation = contribution.get("presentation") or {}
        supported = host in presentation.get("hosts", [])
        optional = presentation.get("optional") is True
        projection["semanticState"] = contribution["state"]
        projection["presentationState"] = (
            "active" if supported else "dormant" if optional else "degraded"
        )
        projection["executionEligible"] = (
            admission["state"] == "admitted"
            and authorization.get("executionAllowed") is True
            and contribution["state"] == "active"
            and projection["presentationState"] == "active"
        )
        if projection["presentationState"] == "dormant":
            diagnostics.append(
                {
                    "code": "KF_KFX_PRESENTATION_DORMANT",
                    "contributionRoot": contribution["contributionRoot"],
                    "recoveryGuidance": [f"install-optional-{host}-presentation"],
                }
            )
        contributions.append(projection)

    return {
        "schema": "kungfu.kfx.host-projection/v1",
        "host": host,
        "descriptorRoot": descriptor["descriptorRoot"],
        "graphRoot": descriptor["graphRoot"],
        "planRoot": descriptor["planRoot"],
        "receiptDependencyRoot": descriptor["receiptDependencyRoot"],
        "cutRoot": descriptor["cutRoot"],
        "revision": descriptor["revision"],
        "generationRoot": descriptor["generationRoot"],
        "admissionState": admission["state"],
        "diagnostics": diagnostics,
        "contributions": contributions,
    }


def project_cli_experience_flow_host(
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    return project_experience_flow_host(descriptor, "cli")


def project_agent_experience_flow_host(
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    return project_experience_flow_host(descriptor, "agent")


def authorize_host_launch(
    descriptor: dict[str, Any],
    package_key: str,
    host: str,
    expected_authorization_root: str,
) -> dict[str, Any]:
    """Validate the exact Core authorization before any physical host launch."""

    project_experience_flow_host(descriptor, "cli")
    admission = descriptor["admission"]
    for authorization in descriptor["runtimeAuthorizations"]:
        if (
            authorization.get("packageKey") != package_key
            or authorization.get("host") != host
        ):
            continue
        if (
            admission["state"] != "admitted"
            or expected_authorization_root not in admission["runtimeAuthorizationRoots"]
            or authorization.get("authorizationRoot") != expected_authorization_root
            or not authorization.get("capabilityDeclarationRoot")
            or not authorization.get("capabilityGrantRoot")
            or not authorization.get("corePolicyRoot")
            or not authorization.get("requestedPolicyRoot")
            or not authorization.get("policyRoot")
            or not authorization.get("warrantRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
            or authorization.get("generationRoot") != descriptor["generationRoot"]
            or not set(authorization.get("requiredCapabilities", []))
            <= set(authorization.get("grantedCapabilities", []))
            or authorization.get("executionAllowed") is not True
        ):
            raise ValueError("KFX host launch authorization does not match")
        return authorization
    raise ValueError("KFX host launch authorization does not match")
