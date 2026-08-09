# SPDX-License-Identifier: Apache-2.0

"""Read-only installed verifier for Kungfu public release evidence."""

from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


OFFICIAL_STATUS_URL = "https://kungfu.tech/.well-known/kungfu-release-status.json"
STATUS_SCHEMA = "kungfu.release-status/v1"
EVIDENCE_CONTRACT = "kungfu-ungfu-release-evidence-index"
ACTIVATION_RECEIPT_SET = "kungfu-buildchain-release-activation-receipt-set/v1"
ROOT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class ReleaseVerificationError(ValueError):
    """The subject is not a qualifying Kungfu release document."""


def _activation_root(value: Any) -> str:
    subject = dict(_object(value, "activation root subject"))
    subject.pop("transactionRoot", None)
    subject.pop("receiptSetRoot", None)
    canonical = json.dumps(
        subject,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReleaseVerificationError(f"{label} must be an object")
    return value


def _exact_root(value: Any, label: str) -> str:
    normalized = str(value or "")
    if ROOT_RE.fullmatch(normalized) is None:
        raise ReleaseVerificationError(f"{label} must be a sha256 content root")
    return normalized


def _exact_sha(value: Any, label: str) -> str:
    normalized = str(value or "")
    if SHA_RE.fullmatch(normalized) is None:
        raise ReleaseVerificationError(f"{label} must be an exact 40-character Git SHA")
    return normalized


def _public_https(value: Any, label: str) -> str:
    normalized = str(value or "")
    parsed = urlparse(normalized)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise ReleaseVerificationError(f"{label} must be a public HTTPS URL")
    return normalized


def load_subject(source: str | Path | None = None) -> tuple[dict[str, Any], str]:
    locator = str(source or OFFICIAL_STATUS_URL)
    parsed = urlparse(locator)
    try:
        if parsed.scheme:
            _public_https(locator, "release source")
            request = urllib.request.Request(
                locator,
                headers={"User-Agent": "kungfu-installed-release-verifier/1"},
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ReleaseVerificationError("release document exceeds 4 MiB")
            value = json.loads(raw.decode("utf-8"))
        else:
            value = json.loads(Path(locator).read_text(encoding="utf-8"))
    except ReleaseVerificationError:
        raise
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise ReleaseVerificationError(
            f"cannot read release document {locator}: {error}"
        ) from error
    return _object(value, "release document"), locator


def _legal_boundary(value: Any) -> None:
    boundary = _object(value, "legalBoundary")
    if (
        boundary.get("firstUseDateClaim") is not None
        or boundary.get("legalConclusion") != "not-made"
        or boundary.get("registrationStatusClaim") != "none"
    ):
        raise ReleaseVerificationError(
            "release document crosses the no-legal-conclusion boundary"
        )


def _verify_status(document: dict[str, Any]) -> dict[str, Any]:
    if document.get("schema") != STATUS_SCHEMA:
        raise ReleaseVerificationError(f"status schema must be {STATUS_SCHEMA}")
    state = document.get("status")
    if state not in {"preparation", "unavailable", "current-release"}:
        raise ReleaseVerificationError("release status is invalid")
    _public_https(document.get("documentationUrl"), "documentationUrl")
    _legal_boundary(document.get("legalBoundary"))
    if state != "current-release":
        if (
            document.get("releasedUseClaim") is not False
            or document.get("release") is not None
            or document.get("acquisitionEvidence") is not None
        ):
            raise ReleaseVerificationError(
                "pre-release status must not carry release or acquisition facts"
            )
        return {
            "kind": "release-status",
            "state": state,
            "releaseAvailable": False,
            "version": None,
            "sourceSha": None,
            "siteSourceSha": None,
            "meaning": (
                "The public status endpoint is internally consistent: no "
                "qualified public Kungfu release is available from this surface."
            ),
        }
    if document.get("releasedUseClaim") is not True:
        raise ReleaseVerificationError(
            "current-release status must declare releasedUseClaim=true"
        )
    release = _object(document.get("release"), "release")
    version = str(release.get("version") or "")
    if not version or release.get("tag") != f"v{version}":
        raise ReleaseVerificationError("release tag and version do not match")
    if release.get("channel") not in {"alpha", "release"}:
        raise ReleaseVerificationError("release channel must be alpha or release")
    source_sha = _exact_sha(release.get("sourceSha"), "release.sourceSha")
    site_source_sha = _exact_sha(release.get("siteSourceSha"), "release.siteSourceSha")
    _exact_root(release.get("channelPayloadRoot"), "release.channelPayloadRoot")
    passport = _object(release.get("releasePassport"), "release.releasePassport")
    _exact_root(passport.get("root"), "release.releasePassport.root")
    if not str(passport.get("ref") or ""):
        raise ReleaseVerificationError("release.releasePassport.ref is required")
    acquisition = _object(document.get("acquisitionEvidence"), "acquisitionEvidence")
    _public_https(acquisition.get("url"), "acquisitionEvidence.url")
    _exact_root(acquisition.get("root"), "acquisitionEvidence.root")
    return {
        "kind": "release-status",
        "state": state,
        "releaseAvailable": True,
        "version": version,
        "sourceSha": source_sha,
        "siteSourceSha": site_source_sha,
        "meaning": (
            "The status document binds one exact product commit, reviewed site "
            "commit, signed channel root, Release Passport, and acquisition index."
        ),
    }


def _verify_evidence(document: dict[str, Any]) -> dict[str, Any]:
    if (
        document.get("schemaVersion") != 1
        or document.get("contract") != EVIDENCE_CONTRACT
        or document.get("id") != "ungfu-public-use"
    ):
        raise ReleaseVerificationError("release evidence identity is invalid")
    _legal_boundary(document.get("legalBoundary"))
    state = document.get("state")
    if state not in {"preparation", "released-observation"}:
        raise ReleaseVerificationError("release evidence state is invalid")
    release = _object(document.get("release"), "release")
    layers = _object(document.get("layers"), "layers")
    specimen = _object(layers.get("specimen"), "layers.specimen")
    class9 = _object(
        layers.get("class9CapabilityTruth"), "layers.class9CapabilityTruth"
    )
    archive = _object(layers.get("brandArchive"), "layers.brandArchive")
    if (
        specimen.get("role") != "filing-oriented-acquisition-product-pair"
        or class9.get("role") != "released-capability-truth"
        or archive.get("role") != "supporting-history-only"
        or archive.get("primaryEvidence") is not False
    ):
        raise ReleaseVerificationError("release evidence layers are conflated")
    if state == "preparation":
        if (
            specimen.get("acquisition") is not None
            or specimen.get("product") is not None
            or specimen.get("records") != []
            or class9.get("records") != []
        ):
            raise ReleaseVerificationError(
                "preparation evidence carries released observations"
            )
        return {
            "kind": "release-evidence",
            "state": state,
            "releaseAvailable": False,
            "version": None,
            "sourceSha": None,
            "siteSourceSha": None,
            "meaning": "This is a preparation template, not released evidence.",
        }
    source_sha = _exact_sha(release.get("sourceSha"), "release.sourceSha")
    version = str(release.get("version") or "")
    if not version or release.get("tag") != f"v{version}":
        raise ReleaseVerificationError("release tag and version do not match")
    roots = release.get("artifactRoots")
    if not isinstance(roots, list) or not roots:
        raise ReleaseVerificationError("released evidence requires artifact roots")
    for index, root in enumerate(roots):
        item = _object(root, f"release.artifactRoots[{index}]")
        if not str(item.get("name") or ""):
            raise ReleaseVerificationError(
                f"release.artifactRoots[{index}].name is required"
            )
        _exact_root(item.get("sha256"), f"release.artifactRoots[{index}].sha256")
    for label in ("acquisition", "product"):
        surface = _object(specimen.get(label), f"layers.specimen.{label}")
        if surface.get("exactMark") != "Kungfu UNGFU™":
            raise ReleaseVerificationError(f"{label} does not bind the exact mark")
        _public_https(surface.get("publicUrl"), f"{label}.publicUrl")
        if surface.get("sourceCommit") != source_sha:
            raise ReleaseVerificationError(f"{label} source commit mismatch")
    return {
        "kind": "release-evidence",
        "state": state,
        "releaseAvailable": True,
        "version": version,
        "sourceSha": source_sha,
        "siteSourceSha": None,
        "meaning": (
            "The evidence index binds released acquisition, installed-product, "
            "Class 9 capability, brand archive, and artifact roots without a "
            "legal or first-use conclusion."
        ),
    }


def _verify_receipt_set(document: dict[str, Any]) -> dict[str, Any]:
    if document.get("schema") != ACTIVATION_RECEIPT_SET:
        raise ReleaseVerificationError(
            f"receipt set schema must be {ACTIVATION_RECEIPT_SET}"
        )
    bindings = _object(document.get("bindings"), "bindings")
    source_sha = _exact_sha(bindings.get("sourceSha"), "bindings.sourceSha")
    site_source_sha = _exact_sha(
        bindings.get("siteSourceSha"), "bindings.siteSourceSha"
    )
    _exact_root(bindings.get("artifactSetRoot"), "bindings.artifactSetRoot")
    version = str(bindings.get("version") or "")
    if not version or bindings.get("tag") != f"v{version}":
        raise ReleaseVerificationError("bindings.tag and version do not match")
    if bindings.get("channel") not in {"alpha", "release"}:
        raise ReleaseVerificationError("bindings.channel must be alpha or release")
    environment = bindings.get("environment")
    if environment not in {"shadow", "production"}:
        raise ReleaseVerificationError(
            "bindings.environment must be shadow or production"
        )
    binding_root = _activation_root(bindings)
    expected = [
        "artifact-publication",
        "release-passport",
        "site-publication",
        "public-readback",
        "product-qualification",
    ]
    receipts = document.get("receipts")
    if (
        not isinstance(receipts, list)
        or [item.get("kind") for item in receipts if isinstance(item, dict)] != expected
    ):
        raise ReleaseVerificationError(
            "activation receipt set is incomplete or out of order"
        )
    for index, receipt in enumerate(receipts):
        _exact_root(receipt.get("root"), f"receipts[{index}].root")
        if (
            _exact_root(receipt.get("bindingRoot"), f"receipts[{index}].bindingRoot")
            != binding_root
        ):
            raise ReleaseVerificationError(
                f"receipts[{index}].bindingRoot does not match activation inputs"
            )
        if not str(receipt.get("locator") or ""):
            raise ReleaseVerificationError(f"receipts[{index}].locator is required")
    _exact_root(document.get("transactionRoot"), "transactionRoot")
    if _exact_root(
        document.get("receiptSetRoot"), "receiptSetRoot"
    ) != _activation_root(document):
        raise ReleaseVerificationError("receiptSetRoot does not match receipt bytes")
    _legal_boundary(document.get("legalBoundary"))
    mode = document.get("mode")
    if mode not in {"shadow", "activation"}:
        raise ReleaseVerificationError("receipt set mode is invalid")
    expected_environment = "shadow" if mode == "shadow" else "production"
    expected_claim = mode == "activation"
    if environment != expected_environment:
        raise ReleaseVerificationError("receipt mode and environment do not match")
    if document.get("releasedUseClaim") is not expected_claim:
        raise ReleaseVerificationError(
            "receipt mode and released-use claim do not match"
        )
    return {
        "kind": "activation-receipt-set",
        "state": mode,
        "releaseAvailable": mode == "activation",
        "version": version,
        "sourceSha": source_sha,
        "siteSourceSha": site_source_sha,
        "meaning": (
            "Five authoritative receipts bind the same product, site, artifact, "
            "version, channel, and environment coordinates."
        ),
    }


def verify(document: dict[str, Any], *, locator: str = "") -> dict[str, Any]:
    try:
        if document.get("schema") == STATUS_SCHEMA:
            detail = _verify_status(document)
        elif document.get("contract") == EVIDENCE_CONTRACT:
            detail = _verify_evidence(document)
        elif document.get("schema") == ACTIVATION_RECEIPT_SET:
            detail = _verify_receipt_set(document)
        else:
            raise ReleaseVerificationError(
                "unsupported release document; expected release status, "
                "release evidence, or activation receipt set"
            )
        return {
            "schema": "kungfu.release-verification-result/v1",
            "verified": True,
            "locator": locator,
            **detail,
            "claims": [
                "document structure and exact bindings passed the installed verifier"
            ],
            "notClaims": [
                "legal sufficiency",
                "trademark registration",
                "first-use date",
            ],
            "issues": [],
        }
    except ReleaseVerificationError as error:
        return {
            "schema": "kungfu.release-verification-result/v1",
            "verified": False,
            "locator": locator,
            "kind": "unknown",
            "state": "rejected",
            "releaseAvailable": False,
            "version": None,
            "sourceSha": None,
            "siteSourceSha": None,
            "meaning": "The subject does not satisfy the installed release contract.",
            "claims": [],
            "notClaims": [
                "legal sufficiency",
                "trademark registration",
                "first-use date",
            ],
            "issues": [str(error)],
        }


def explain() -> dict[str, Any]:
    return {
        "schema": "kungfu.release-verifier-explanation/v1",
        "officialStatusUrl": OFFICIAL_STATUS_URL,
        "states": {
            "unavailable": "No qualified public installer or acquisition evidence is exposed.",
            "preparation": "The public contract exists, but it is not a release claim.",
            "current-release": (
                "Exact product/site commits, signed channel, Passport, acquisition "
                "index, and public read-back are linked."
            ),
        },
        "commands": {
            "status": "kungfu release status",
            "verify": "kungfu release verify <file-or-https-url>",
            "json": "add --json for stable machine-readable output",
        },
        "notClaims": [
            "legal sufficiency",
            "trademark registration",
            "first-use date",
        ],
    }
