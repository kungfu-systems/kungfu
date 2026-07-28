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

    if descriptor.get("schema") != "kungfu.kfx.experience-flow-host/v2":
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
        "contributions",
    ):
        if field not in descriptor:
            raise ValueError(f"KFX host descriptor is missing {field}")

    admission = descriptor["admission"]
    generation = descriptor["generation"]
    if (
        admission.get("schema") != "kungfu.kfx.host-admission/v1"
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
        or (admission.get("state") == "admitted") != (descriptor["cutRoot"] is not None)
    ):
        raise ValueError("KFX host descriptor admission identity does not match")

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
            or authorization.get("capabilityRoot") != contribution.get("capabilityRoot")
            or authorization.get("cutRoot") != descriptor["cutRoot"]
            or authorization.get("revision") != descriptor["revision"]
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
