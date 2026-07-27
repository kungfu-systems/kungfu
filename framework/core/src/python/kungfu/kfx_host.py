"""Thin host projection for the Core-owned KFX Experience/Flow descriptor."""

from __future__ import annotations

from typing import Any


HOSTS = frozenset({"gui", "tui", "cli", "agent"})


def project_experience_flow_host(
    descriptor: dict[str, Any], host: str
) -> dict[str, Any]:
    """Retain Core identities while adding only host-native availability."""

    if descriptor.get("schema") != "kungfu.kfx.experience-flow-host/v1":
        raise ValueError("unsupported KFX Experience/Flow host descriptor")
    if host not in HOSTS:
        raise ValueError(f"unsupported KFX host: {host}")
    for field in (
        "descriptorRoot",
        "graphRoot",
        "planRoot",
        "receiptDependencyRoot",
        "cutRoot",
        "revision",
        "contributions",
    ):
        if field not in descriptor:
            raise ValueError(f"KFX host descriptor is missing {field}")

    contributions = []
    for contribution in descriptor["contributions"]:
        projection = dict(contribution)
        presentation = contribution.get("presentation") or {}
        supported = host in presentation.get("hosts", [])
        optional = presentation.get("optional") is True
        projection["semanticState"] = contribution["state"]
        projection["presentationState"] = (
            "active" if supported else "dormant" if optional else "degraded"
        )
        projection["executionEligible"] = (
            contribution["state"] == "active"
            and projection["presentationState"] != "degraded"
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
        "contributions": contributions,
    }
