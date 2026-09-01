# SPDX-License-Identifier: Apache-2.0
"""Shared parsing rules for native KFX mutation authority evidence."""

import json

import click


MUTATION_AUTHORITY_FIELDS = {
    "purpose",
    "policy",
    "assessmentTime",
    "authorizationTime",
    "attestation",
    "identity",
    "trustInputs",
    "kfdAssessment",
    "runtimeEvidence",
    "developmentSourceBootstrap",
    "requestedCapabilities",
    "approvalRoots",
    "recoveryWarrant",
}


def native_json_file(path, label):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise click.BadParameter(f"cannot read {label}: {error}") from error
    if not isinstance(value, dict):
        raise click.BadParameter(f"{label} must contain one JSON object")
    return value


def native_authority_file(path):
    authority = native_json_file(path, "KFX mutation authority evidence")
    unsupported = sorted(set(authority) - MUTATION_AUTHORITY_FIELDS)
    if unsupported:
        raise click.BadParameter(
            "KFX mutation authority evidence contains non-authority fields: "
            + ", ".join(unsupported),
            param_hint="--authority-file",
        )
    return authority
