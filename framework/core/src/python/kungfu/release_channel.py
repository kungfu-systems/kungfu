# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from kungfu import runtime_upgrade


CHANNEL_INDEX_SCHEMA = "kungfu.release-channel-index/v1"
CHANNEL_SELECTION_SCHEMA = "kungfu.release-channel-selection/v1"
MAX_CHANNEL_INDEX_BYTES = 1024 * 1024
_ROOT = re.compile(r"^sha256:[a-f0-9]{64}$")
_SOURCE_COMMIT = re.compile(r"^[a-f0-9]{40}$")
_CHANNELS = {"alpha", "stable"}
_ROLLOUT_STATES = {"current", "paused", "rollback-only"}

# RFC 8032 Ed25519 verification. Keeping verification here avoids making an
# installed standalone CLI depend on an ambient OpenSSL executable or optional
# Python package. Signing remains release-tooling-only and is implemented with
# Node's platform crypto API.
_Q = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _Q - 2, _Q)) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)
_IDENTITY = (0, 1, 1, 0)


class ReleaseChannelError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def content_root(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_json_bytes(value)).hexdigest()}"


def _artifact_root(manifest: Mapping[str, Any]) -> str:
    return content_root(
        [
            {
                "kind": artifact["kind"],
                "url": artifact["url"],
                "size": artifact["size"],
                "digest": artifact["digest"],
                "signature": artifact["signature"],
            }
            for artifact in manifest["artifacts"]
        ]
    )


def _xrecover(y: int) -> int:
    xx = ((y * y - 1) * pow((_D * y * y + 1) % _Q, _Q - 2, _Q)) % _Q
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if (x * x - xx) % _Q != 0:
        raise ReleaseChannelError("channel-signature-invalid", "invalid Ed25519 point")
    return _Q - x if x & 1 else x


_BY = (4 * pow(5, _Q - 2, _Q)) % _Q
_BX = _xrecover(_BY)
_BASE = (_BX, _BY, 1, (_BX * _BY) % _Q)


def _point_add(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = ((y1 - x1) * (y2 - x2)) % _Q
    b = ((y1 + x1) * (y2 + x2)) % _Q
    c = (2 * _D * t1 * t2) % _Q
    d = (2 * z1 * z2) % _Q
    e = (b - a) % _Q
    f = (d - c) % _Q
    g = (d + c) % _Q
    h = (b + a) % _Q
    return (e * f % _Q, g * h % _Q, f * g % _Q, e * h % _Q)


def _scalar_multiply(
    point: tuple[int, int, int, int], scalar: int
) -> tuple[int, int, int, int]:
    result = _IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        scalar >>= 1
    return result


def _point_equal(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> bool:
    return (left[0] * right[2] - right[0] * left[2]) % _Q == 0 and (
        left[1] * right[2] - right[1] * left[2]
    ) % _Q == 0


def _encode_point(point: tuple[int, int, int, int]) -> bytes:
    inverse = pow(point[2], _Q - 2, _Q)
    x = point[0] * inverse % _Q
    y = point[1] * inverse % _Q
    encoded = y | ((x & 1) << 255)
    return encoded.to_bytes(32, "little")


def _decode_point(encoded: bytes) -> tuple[int, int, int, int]:
    if len(encoded) != 32:
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 point must be 32 bytes"
        )
    value = int.from_bytes(encoded, "little")
    y = value & ((1 << 255) - 1)
    if y >= _Q:
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 point is not canonical"
        )
    x = _xrecover(y)
    if (x & 1) != (value >> 255):
        x = _Q - x
    point = (x, y, 1, x * y % _Q)
    if _encode_point(point) != encoded:
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 point is not canonical"
        )
    if not _point_equal(_scalar_multiply(point, _L), _IDENTITY):
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 point is outside the subgroup"
        )
    return point


def verify_ed25519(public_key: bytes, message: bytes, signature: bytes) -> None:
    if len(public_key) != 32 or len(signature) != 64:
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 key or signature size is invalid"
        )
    public_point = _decode_point(public_key)
    nonce_point = _decode_point(signature[:32])
    if _point_equal(public_point, _IDENTITY):
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 identity key is forbidden"
        )
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= _L:
        raise ReleaseChannelError(
            "channel-signature-invalid", "Ed25519 scalar is not canonical"
        )
    challenge = (
        int.from_bytes(
            hashlib.sha512(signature[:32] + public_key + message).digest(), "little"
        )
        % _L
    )
    expected = _point_add(nonce_point, _scalar_multiply(public_point, challenge))
    if not _point_equal(_scalar_multiply(_BASE, scalar), expected):
        raise ReleaseChannelError(
            "channel-signature-invalid", "release channel signature did not verify"
        )


def _require_string(value: Mapping[str, Any], field: str) -> str:
    result = value.get(field)
    if not isinstance(result, str) or not result:
        raise ReleaseChannelError(
            "channel-index-malformed", f"release channel {field} must be a string"
        )
    return result


def _require_fields(value: Mapping[str, Any], fields: set[str], label: str) -> None:
    if set(value) != fields:
        raise ReleaseChannelError(
            "channel-index-malformed",
            f"release channel {label} fields are invalid",
        )


def _parse_time(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReleaseChannelError(
            "channel-index-malformed", f"release channel {field} is invalid"
        ) from error
    if parsed.tzinfo is None:
        raise ReleaseChannelError(
            "channel-index-malformed", f"release channel {field} needs a timezone"
        )
    return parsed.astimezone(timezone.utc)


def validate_signed_index(
    index: Mapping[str, Any],
    trusted_keys: Mapping[str, str],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    value = copy.deepcopy(dict(index))
    _require_fields(
        value,
        {
            "schema",
            "generatedAt",
            "expiresAt",
            "sourceCommit",
            "releasePassport",
            "entries",
            "payloadRoot",
            "signature",
        },
        "index",
    )
    if value.get("schema") != CHANNEL_INDEX_SCHEMA:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel schema is unsupported"
        )
    signature = value.get("signature")
    if not isinstance(signature, Mapping):
        raise ReleaseChannelError(
            "channel-signature-missing", "release channel signature is missing"
        )
    _require_fields(signature, {"algorithm", "keyId", "value"}, "signature")
    if signature.get("algorithm") != "ed25519":
        raise ReleaseChannelError(
            "channel-signature-invalid", "release channel algorithm is unsupported"
        )
    key_id = _require_string(signature, "keyId")
    encoded_key = trusted_keys.get(key_id)
    if encoded_key is None:
        raise ReleaseChannelError(
            "channel-key-untrusted", f"release channel key is not trusted: {key_id}"
        )
    try:
        public_key = base64.b64decode(encoded_key, validate=True)
        signature_bytes = base64.b64decode(
            _require_string(signature, "value"), validate=True
        )
    except (ValueError, TypeError) as error:
        raise ReleaseChannelError(
            "channel-signature-invalid", "release channel signature is not base64"
        ) from error

    payload_root = _require_string(value, "payloadRoot")
    if _ROOT.fullmatch(payload_root) is None:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel payload root is invalid"
        )
    signed = {key: item for key, item in value.items() if key != "signature"}
    payload = {key: item for key, item in signed.items() if key != "payloadRoot"}
    if content_root(payload) != payload_root:
        raise ReleaseChannelError(
            "channel-root-mismatch", "release channel payload root did not verify"
        )
    verify_ed25519(public_key, canonical_json_bytes(signed), signature_bytes)

    source_commit = _require_string(value, "sourceCommit")
    if _SOURCE_COMMIT.fullmatch(source_commit) is None:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel source commit is invalid"
        )
    passport = value.get("releasePassport")
    if not isinstance(passport, Mapping):
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel passport binding is missing"
        )
    _require_fields(passport, {"ref", "root"}, "passport")
    _require_string(passport, "ref")
    if _ROOT.fullmatch(_require_string(passport, "root")) is None:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel passport root is invalid"
        )

    generated_at = _parse_time(_require_string(value, "generatedAt"), "generatedAt")
    expires_at = _parse_time(_require_string(value, "expiresAt"), "expiresAt")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if expires_at <= generated_at:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel freshness window is empty"
        )
    if current < generated_at:
        raise ReleaseChannelError(
            "channel-index-not-yet-valid", "release channel is not valid yet"
        )
    if current >= expires_at:
        raise ReleaseChannelError(
            "channel-index-stale", "release channel index has expired"
        )

    entries = value.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel entries are missing"
        )
    identities: set[tuple[str, str, str, str]] = set()
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ReleaseChannelError(
                "channel-index-malformed", "release channel entry is not an object"
            )
        _require_fields(
            entry,
            {
                "channel",
                "platform",
                "architecture",
                "installSource",
                "rollout",
                "manifest",
                "manifestRoot",
                "artifactRoot",
                "documentationUrl",
            },
            "entry",
        )
        channel = _require_string(entry, "channel")
        rollout = _require_string(entry, "rollout")
        platform_name = _require_string(entry, "platform")
        architecture = _require_string(entry, "architecture")
        install_source = _require_string(entry, "installSource")
        documentation_url = _require_string(entry, "documentationUrl")
        if channel not in _CHANNELS or rollout not in _ROLLOUT_STATES:
            raise ReleaseChannelError(
                "channel-index-malformed", "release channel entry state is invalid"
            )
        parsed_documentation = urllib.parse.urlparse(documentation_url)
        if (
            parsed_documentation.scheme != "https"
            or not parsed_documentation.netloc
            or parsed_documentation.username is not None
            or parsed_documentation.password is not None
            or parsed_documentation.query
        ):
            raise ReleaseChannelError(
                "channel-index-malformed",
                "release channel documentation URL is not public HTTPS",
            )
        identity = (channel, platform_name, architecture, install_source)
        if identity in identities:
            raise ReleaseChannelError(
                "channel-entry-ambiguous", "release channel entry is duplicated"
            )
        identities.add(identity)
        manifest = entry.get("manifest")
        if not isinstance(manifest, Mapping):
            raise ReleaseChannelError(
                "channel-index-malformed",
                "release channel entry manifest is missing",
            )
        try:
            runtime_upgrade.validate_manifest(manifest)
        except (TypeError, runtime_upgrade.UpgradeError) as error:
            raise ReleaseChannelError(
                "channel-index-malformed",
                "release channel entry manifest is invalid",
            ) from error
        if _ROOT.fullmatch(_require_string(entry, "manifestRoot")) is None:
            raise ReleaseChannelError(
                "channel-index-malformed", "release manifest root is invalid"
            )
        if _ROOT.fullmatch(_require_string(entry, "artifactRoot")) is None:
            raise ReleaseChannelError(
                "channel-index-malformed", "release artifact root is invalid"
            )
        if content_root(manifest) != entry["manifestRoot"]:
            raise ReleaseChannelError(
                "channel-manifest-root-mismatch",
                "release manifest root did not verify",
            )
        if _artifact_root(manifest) != entry["artifactRoot"]:
            raise ReleaseChannelError(
                "channel-artifact-root-mismatch",
                "release artifact root did not verify",
            )
        if (
            manifest["releaseChannel"] != channel
            or manifest["platform"] != platform_name
            or manifest["architecture"] != architecture
            or manifest["sourceCommit"] != source_commit
        ):
            raise ReleaseChannelError(
                "channel-entry-mismatch",
                "release channel entry and manifest identity differ",
            )
    return value


def _read_index_bytes(payload: bytes) -> dict[str, Any]:
    if len(payload) > MAX_CHANNEL_INDEX_BYTES:
        raise ReleaseChannelError(
            "channel-index-too-large", "release channel index exceeds the size limit"
        )
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel index is invalid JSON"
        ) from error
    if not isinstance(value, dict):
        raise ReleaseChannelError(
            "channel-index-malformed", "release channel index is not an object"
        )
    canonical = canonical_json_bytes(value)
    if payload not in {canonical, canonical + b"\n"}:
        raise ReleaseChannelError(
            "channel-index-noncanonical",
            "release channel index is not canonically encoded",
        )
    return value


class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: Any,
        file_pointer: Any,
        response_code: int,
        response_message: str,
        headers: Any,
        new_url: str,
    ) -> Any:
        target = urllib.parse.urljoin(request.full_url, new_url)
        if urllib.parse.urlparse(target).scheme.lower() != "https":
            raise ReleaseChannelError(
                "channel-transport-insecure",
                "release channel redirect requires HTTPS",
            )
        return super().redirect_request(
            request,
            file_pointer,
            response_code,
            response_message,
            headers,
            target,
        )


def _open_https(request: urllib.request.Request, *, timeout: int) -> Any:
    return urllib.request.build_opener(_HttpsOnlyRedirectHandler()).open(
        request, timeout=timeout
    )


def _cache_path(cache_root: str | Path, reference: str) -> Path:
    digest = hashlib.sha256(reference.encode("utf-8")).hexdigest()
    return Path(cache_root).expanduser().resolve() / f"{digest}.json"


def _write_cache(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("xb") as output:
            output.write(canonical_json_bytes(value) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _load_cached(
    path: Path, trusted_keys: Mapping[str, str], *, now: datetime | None
) -> dict[str, Any]:
    try:
        value = _read_index_bytes(path.read_bytes())
    except OSError as error:
        raise ReleaseChannelError(
            "channel-offline-unavailable",
            "no verified release channel cache is available",
        ) from error
    return validate_signed_index(value, trusted_keys, now=now)


def resolve_index(
    reference: str,
    trusted_keys: Mapping[str, str],
    *,
    cache_root: str | Path,
    offline: bool = False,
    allow_local: bool = False,
    now: datetime | None = None,
    timeout: int = 10,
) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(reference)
    cache = _cache_path(cache_root, reference)
    if offline:
        return {
            "index": _load_cached(cache, trusted_keys, now=now),
            "transportState": "offline-cache",
            "cachePath": str(cache),
        }
    if parsed.scheme in {"", "file"}:
        if not allow_local:
            raise ReleaseChannelError(
                "channel-transport-insecure",
                "local release channels require an explicit fixture override",
            )
        path = (
            Path(urllib.request.url2pathname(parsed.path))
            if parsed.scheme == "file"
            else Path(reference)
        )
        try:
            value = _read_index_bytes(path.expanduser().resolve().read_bytes())
        except OSError as error:
            raise ReleaseChannelError(
                "channel-unavailable", "release channel fixture is unavailable"
            ) from error
        return {
            "index": validate_signed_index(value, trusted_keys, now=now),
            "transportState": "local-fixture",
            "cachePath": None,
        }
    if parsed.scheme != "https":
        raise ReleaseChannelError(
            "channel-transport-insecure", "release channels require HTTPS"
        )
    request = urllib.request.Request(reference, headers={"Accept": "application/json"})
    try:
        with _open_https(request, timeout=timeout) as response:
            final_url = urllib.parse.urlparse(str(response.geturl()))
            if final_url.scheme != "https":
                raise ReleaseChannelError(
                    "channel-transport-insecure",
                    "release channel redirect requires HTTPS",
                )
            payload = response.read(MAX_CHANNEL_INDEX_BYTES + 1)
        value = validate_signed_index(_read_index_bytes(payload), trusted_keys, now=now)
        _write_cache(cache, value)
        return {
            "index": value,
            "transportState": "https",
            "cachePath": str(cache),
        }
    except ReleaseChannelError:
        raise
    except OSError as error:
        try:
            cached = _load_cached(cache, trusted_keys, now=now)
        except ReleaseChannelError:
            raise ReleaseChannelError(
                "channel-unavailable",
                "release channel is unavailable and no verified cache can be used",
            ) from error
        return {
            "index": cached,
            "transportState": "cache-fallback",
            "cachePath": str(cache),
        }


def select_release(
    index: Mapping[str, Any],
    *,
    channel: str,
    platform_name: str,
    architecture: str,
    install_source: str,
    current_version: str,
    allow_rollback: bool = False,
) -> dict[str, Any]:
    if channel not in _CHANNELS:
        raise ReleaseChannelError(
            "channel-unsupported", f"unsupported release channel: {channel}"
        )
    matches = [
        entry
        for entry in index["entries"]
        if entry["channel"] == channel
        and entry["platform"] == platform_name
        and entry["architecture"] == architecture
        and entry["installSource"] == install_source
    ]
    if len(matches) != 1:
        code = "channel-entry-unavailable" if not matches else "channel-entry-ambiguous"
        raise ReleaseChannelError(
            code,
            "release channel has no unique entry for this platform and install source",
        )
    entry = copy.deepcopy(dict(matches[0]))
    if entry["rollout"] == "paused":
        raise ReleaseChannelError(
            "channel-rollout-paused", "release channel rollout is paused"
        )
    target_version = entry["manifest"]["productVersion"]
    order = _compare_versions(target_version, current_version)
    if order < 0 and not (entry["rollout"] == "rollback-only" and allow_rollback):
        raise ReleaseChannelError(
            "channel-downgrade-refused",
            "release channel would downgrade this installation",
        )
    if entry["rollout"] == "rollback-only" and not allow_rollback:
        raise ReleaseChannelError(
            "channel-rollback-only",
            "release channel entry is available only for explicit recovery",
        )
    return {
        "schema": CHANNEL_SELECTION_SCHEMA,
        "channel": channel,
        "platform": platform_name,
        "architecture": architecture,
        "installSource": install_source,
        "currentVersion": current_version,
        "targetVersion": target_version,
        "payloadRoot": index["payloadRoot"],
        "releasePassport": copy.deepcopy(index["releasePassport"]),
        "entry": entry,
    }


def verify_bootstrap_candidate(
    *,
    channel_index: str | Path,
    trusted_keys: Mapping[str, str],
    candidate_archive: str | Path,
    candidate_root: str | Path,
    channel: str,
    platform_name: str,
    architecture: str,
    version: str,
    manifest_root: str,
    artifact_root: str,
    platform_trust: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Verify staged archive bytes and product identity before selection."""

    expected_platform_trust = {
        "darwin": "codesign-valid",
        "linux": "signed-channel-digest",
        "win32": "authenticode-valid",
    }.get(platform_name)
    if platform_trust != expected_platform_trust:
        raise ReleaseChannelError(
            "platform-trust-invalid",
            "bootstrap platform trust evidence is invalid for this target",
        )
    index = validate_signed_index(
        _read_index_bytes(Path(channel_index).read_bytes()),
        trusted_keys,
        now=now,
    )
    matches = [
        entry
        for entry in index["entries"]
        if entry["channel"] == channel
        and entry["platform"] == platform_name
        and entry["architecture"] == architecture
        and entry["installSource"] == "archive"
        and entry["manifest"]["productVersion"] == version
    ]
    if len(matches) != 1:
        raise ReleaseChannelError(
            "channel-entry-unavailable",
            "signed release channel has no unique bootstrap entry",
        )
    entry = matches[0]
    if entry["rollout"] != "current":
        raise ReleaseChannelError(
            "channel-rollout-paused",
            "signed release channel entry is not current",
        )
    if entry["manifestRoot"] != manifest_root or entry["artifactRoot"] != artifact_root:
        raise ReleaseChannelError(
            "bootstrap-root-mismatch",
            "installer roots differ from signed release authority",
        )
    manifest = runtime_upgrade.validate_manifest(entry["manifest"])
    evidence = str(manifest.get("qualificationEvidenceRef") or "")
    artifacts = [
        artifact for artifact in manifest["artifacts"] if artifact["kind"] == "cli"
    ]
    if (
        not evidence
        or evidence.startswith("unqualified-local-build")
        or len(artifacts) != 1
        or not artifacts[0]["signature"]
        or artifacts[0]["signature"] == "unqualified-local-build"
    ):
        raise ReleaseChannelError(
            "release-unqualified",
            "signed release entry has no qualified CLI publication evidence",
        )
    artifact = artifacts[0]
    archive_path = Path(candidate_archive)
    observed_size = archive_path.stat().st_size
    observed_digest = f"sha256:{hashlib.sha256(archive_path.read_bytes()).hexdigest()}"
    if observed_size != artifact["size"] or observed_digest != artifact["digest"]:
        raise ReleaseChannelError(
            "artifact-verification-failed",
            "staged bootstrap archive differs from signed release evidence",
        )
    product_root = Path(candidate_root)
    try:
        product = json.loads((product_root / "product.json").read_text("utf-8"))
        bundled = json.loads(
            (product_root / "upgrade" / "kungfu-release-manifest.json").read_text(
                "utf-8"
            )
        )
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseChannelError(
            "product-manifest-missing",
            "staged product identity is unreadable",
        ) from error
    if (
        product.get("schema") != "kungfu.product.cli/v1"
        or product.get("product") != "cli"
        or product.get("platform") != platform_name
        or product.get("archive") != archive_path.name
        or product.get("install", {}).get("source") != "archive"
    ):
        raise ReleaseChannelError(
            "product-manifest-mismatch",
            "staged product manifest does not describe this archive target",
        )
    identity_fields = (
        "schema",
        "productVersion",
        "releaseChannel",
        "sourceCommit",
        "runtimeBuildId",
        "runtimeArtifactDigest",
        "frontendBuildId",
        "platform",
        "architecture",
    )
    if any(bundled.get(field) != manifest.get(field) for field in identity_fields):
        raise ReleaseChannelError(
            "product-manifest-mismatch",
            "staged product identity differs from signed release manifest",
        )
    receipt = {
        "schema": "kungfu.bootstrap-verification-receipt/v1",
        "state": "verified",
        "channel": channel,
        "productVersion": version,
        "sourceCommit": manifest["sourceCommit"],
        "frontendBuildId": manifest["frontendBuildId"],
        "runtimeBuildId": manifest["runtimeBuildId"],
        "platform": platform_name,
        "architecture": architecture,
        "installSource": "archive",
        "channelPayloadRoot": index["payloadRoot"],
        "manifestRoot": manifest_root,
        "artifactRoot": artifact_root,
        "artifactDigest": observed_digest,
        "platformTrust": platform_trust,
        "releasePassport": copy.deepcopy(index["releasePassport"]),
    }
    receipt["receiptRoot"] = content_root(receipt)
    return receipt


def _compare_versions(left: str, right: str) -> int:
    # Local import prevents a module cycle when distribution_update begins using
    # this resolver as its discovery layer.
    from kungfu.distribution_update import compare_product_versions

    return compare_product_versions(left, right)


def channel_config(product_manifest: str | Path, channel: str) -> dict[str, Any]:
    try:
        product = json.loads(Path(product_manifest).expanduser().read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseChannelError(
            "channel-config-unavailable",
            "installed channel configuration is unreadable",
        ) from error
    channels = product.get("update", {}).get("channels", {})
    config = channels.get(channel) if isinstance(channels, Mapping) else None
    if not isinstance(config, Mapping):
        raise ReleaseChannelError(
            "channel-config-unavailable",
            f"installed product does not configure the {channel} channel",
        )
    reference = config.get("indexUrl") or config.get("indexPath")
    keys = config.get("trustedKeys")
    if not isinstance(reference, str) or not reference or not isinstance(keys, list):
        raise ReleaseChannelError(
            "channel-config-invalid", "installed channel configuration is invalid"
        )
    trusted: dict[str, str] = {}
    for key in keys:
        if (
            not isinstance(key, Mapping)
            or not isinstance(key.get("keyId"), str)
            or not isinstance(key.get("publicKey"), str)
            or key["keyId"] in trusted
        ):
            raise ReleaseChannelError(
                "channel-config-invalid", "installed channel trust keys are invalid"
            )
        trusted[key["keyId"]] = key["publicKey"]
    if not trusted:
        raise ReleaseChannelError(
            "channel-config-invalid", "installed channel trust store is empty"
        )
    return {"reference": reference, "trustedKeys": trusted}
