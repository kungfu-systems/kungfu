# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import subprocess
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest


def _install_fake_pykungfu() -> None:
    fake = types.ModuleType("pykungfu")
    fake.__file__ = "/nonexistent/pykungfu.so"
    fake.runtime = types.ModuleType("pykungfu.runtime")
    fake.runtime.coordinator = type("FakeNativeCoordinator", (), {})
    fake.yijinjing = types.SimpleNamespace()
    sys.modules.setdefault("pykungfu", fake)
    sys.modules.setdefault("pykungfu.runtime", fake.runtime)


_install_fake_pykungfu()

from kungfu import distribution_update, release_channel  # noqa: E402
from kungfu import runtime_upgrade as release_cut  # noqa: E402


ROOT = Path(__file__).parents[4]
SOURCE_COMMIT = "1" * 40
RUNTIME_ROOT = f"sha256:{'2' * 64}"
NOW = datetime(2026, 7, 23, 12, tzinfo=timezone.utc)


def _manifest(**overrides) -> dict:
    value = {
        "schema": "kungfu.product-upgrade.manifest/v1",
        "productVersion": "4.0.0-alpha.2",
        "releaseChannel": "alpha",
        "sourceCommit": SOURCE_COMMIT,
        "runtimeBuildId": "runtime-4.0.0-alpha.2-linux-x64",
        "runtimeArtifactDigest": RUNTIME_ROOT,
        "runtimeEntrypoint": "bin/kungfu",
        "frontendBuildId": "cli-4.0.0-alpha.2-linux-x64",
        "controlProtocolRange": {"min": 1, "max": 1},
        "peerWireProtocolRange": {"min": 1, "max": 1},
        "journalSchemaReadRange": {"min": 1, "max": 1},
        "journalSchemaWriteVersion": 1,
        "migrationClass": "none",
        "rollbackClass": "automatic",
        "minimumSupportedFrontend": "4.0.0-alpha.0",
        "minimumSupportedRuntime": "4.0.0-alpha.0",
        "platform": "linux",
        "architecture": "x64",
        "artifacts": [
            {
                "kind": "runtime",
                "url": "https://releases.kungfu.invalid/runtime.tar.gz",
                "size": 42,
                "digest": RUNTIME_ROOT,
                "signature": "sigstore:fixture",
            }
        ],
        "qualificationEvidenceRef": "buildchain:qualification/fixture",
        "documentationUrl": "https://www.kungfu.tech/docs/guides/upgrading",
    }
    value.update(overrides)
    return value


def _root(seed: str) -> str:
    return f"sha256:{seed * 64}"


def _cut_aware_manifest(
    *,
    parent_release_cut_root: str | None = None,
    seed: str = "7",
    **manifest_overrides,
) -> dict:
    manifest = _manifest(
        productVersion="4.0.0-alpha.2",
        frontendBuildId=f"cli-release-cut-{seed}",
        **manifest_overrides,
    )
    platform_slice = release_cut.finish_platform_slice(
        {
            "schema": release_cut.PLATFORM_SLICE_SCHEMA,
            "platform": manifest["platform"],
            "architecture": manifest["architecture"],
            "manifestIdentityRoot": release_cut.manifest_identity_root(manifest),
            "artifactRoot": release_channel.content_root(manifest["artifacts"]),
            "qualificationEvidenceRoots": [_root("a")],
            "signingEvidenceRoots": [_root("b")],
        }
    )
    cut = release_cut.finish_release_cut(
        {
            "schema": release_cut.RELEASE_CUT_SCHEMA,
            "productVersion": manifest["productVersion"],
            "parentReleaseCutRoots": (
                [parent_release_cut_root] if parent_release_cut_root else []
            ),
            "sourceSettlementRoot": _root("c"),
            "semanticIdentityRoot": _root(seed),
            "productAssemblyRoot": _root("d"),
            "compatibilityContractRoot": _root("e"),
            "migrationContractRoot": _root("f"),
            "platformSlices": [platform_slice],
            "qualificationEvidenceRoots": [_root("a")],
            "signingEvidenceRoots": [_root("b")],
            "publicationPolicy": {
                "trustDomain": "public",
                "publicationEligible": True,
                "immutable": True,
                "eligibleChannels": ["alpha"],
            },
            "omissionRoots": [],
            "waiverRoots": [],
        }
    )
    return {
        **manifest,
        "manifestIdentityRoot": platform_slice["manifestIdentityRoot"],
        "releaseCut": cut,
        "releaseCutRoot": cut["releaseCutRoot"],
        "platformSliceRoot": platform_slice["platformSliceRoot"],
    }


def _public_transition(
    current_cut: dict,
    target_cut: dict,
    *,
    relation: str = "verified-successor",
    kind: str = "signed-supersession",
) -> dict:
    return release_cut.finish_cut_transition(
        {
            "schema": release_cut.CUT_TRANSITION_SCHEMA,
            "fromReleaseCutRoot": current_cut["releaseCutRoot"],
            "toReleaseCutRoot": target_cut["releaseCutRoot"],
            "fromProductVersion": current_cut["productVersion"],
            "toProductVersion": target_cut["productVersion"],
            "relation": relation,
            "authorization": {
                "trustDomain": "public",
                "kind": kind,
                "publicationEligible": True,
                "evidenceRoots": [_root("1")],
            },
            "compatibility": {
                "controlProtocol": True,
                "peerWireProtocol": True,
                "journalReadable": True,
                "migrationClass": "none",
                "rollbackClass": "automatic",
                "providerResumeRequired": False,
            },
            "migrationPlanRoot": _root("2"),
            "rollbackPlanRoot": _root("3"),
            "activeWorkPolicy": "keep-pinned",
            "evidenceRoots": [_root("4")],
            "diagnostics": [],
        }
    )


def _signed_index(
    tmp_path: Path,
    *,
    manifest: dict | None = None,
    cut_transition: dict | None = None,
    expires_at: str = "2026-07-24T00:00:00Z",
) -> tuple[dict, dict[str, str]]:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest or _manifest()), "utf-8")
    private_key = tmp_path / "private.pem"
    key_script = """
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
fs.writeFileSync(process.argv[1], privateKey.export({ format: 'pem', type: 'pkcs8' }));
const der = publicKey.export({ format: 'der', type: 'spki' });
process.stdout.write(der.subarray(der.length - 32).toString('base64'));
"""
    key = subprocess.run(
        ["node", "-e", key_script, str(private_key)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    entry = {
        "channel": "alpha",
        "installSource": "archive",
        "rollout": "current",
        "manifestPath": manifest_path.name,
    }
    spec = {
        "keyId": "fixture-2026",
        "generatedAt": "2026-07-23T00:00:00Z",
        "expiresAt": expires_at,
        "sourceCommit": SOURCE_COMMIT,
        "releasePassport": {
            "ref": "buildchain:passport/fixture",
            "root": f"sha256:{'3' * 64}",
        },
        "entries": [entry],
    }
    spec_path = tmp_path / "spec.json"
    output = tmp_path / "channel.json"

    def build() -> dict:
        spec_path.write_text(json.dumps(spec), "utf-8")
        subprocess.run(
            [
                "node",
                str(ROOT / "product/scripts/release-channel-index.mjs"),
                "--spec",
                str(spec_path),
                "--private-key",
                str(private_key),
                "--output",
                str(output),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(output.read_text("utf-8"))

    index = build()
    if cut_transition is not None:
        final_manifest = index["entries"][0]["manifest"]
        transition = {
            **cut_transition,
            "toReleaseCutRoot": final_manifest["releaseCutRoot"],
            "toProductVersion": final_manifest["productVersion"],
        }
        transition.pop("cutTransitionRoot", None)
        transition = release_cut.finish_cut_transition(transition)
        transition_path = tmp_path / "cut-transition.json"
        transition_path.write_text(json.dumps(transition), "utf-8")
        entry["cutTransitionPath"] = transition_path.name
        index = build()
    return index, {"fixture-2026": key}


def _resign_index(index: dict, tmp_path: Path) -> dict:
    payload = {
        key: value
        for key, value in index.items()
        if key not in {"payloadRoot", "signature"}
    }
    signed = {**payload, "payloadRoot": release_channel.content_root(payload)}
    signed_payload = tmp_path / "signed-payload.json"
    signed_payload.write_bytes(release_channel.canonical_json_bytes(signed))
    signature_script = """
const { createPrivateKey, sign } = require('node:crypto');
const fs = require('node:fs');
const signature = sign(
  null,
  fs.readFileSync(process.argv[1]),
  createPrivateKey(fs.readFileSync(process.argv[2], 'utf8')),
);
process.stdout.write(signature.toString('base64'));
"""
    signature = subprocess.run(
        [
            "node",
            "-e",
            signature_script,
            str(signed_payload),
            str(tmp_path / "private.pem"),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return {
        **signed,
        "signature": {
            "algorithm": "ed25519",
            "keyId": "fixture-2026",
            "value": signature,
        },
    }


def _assert_error(code: str, action) -> None:
    with pytest.raises(release_channel.ReleaseChannelError) as captured:
        action()
    assert captured.value.code == code


def test_rfc8032_verification_vector() -> None:
    public_key = bytes.fromhex(
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    )
    signature = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a"
        "84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46b"
        "d25bf5f0595bbe24655141438e7a100b"
    )
    release_channel.verify_ed25519(public_key, b"", signature)
    tampered = bytearray(signature)
    tampered[-1] ^= 1
    _assert_error(
        "channel-signature-invalid",
        lambda: release_channel.verify_ed25519(public_key, b"", bytes(tampered)),
    )


def test_node_signature_validates_and_selects_exact_entry(tmp_path: Path) -> None:
    index, trusted = _signed_index(tmp_path)
    verified = release_channel.validate_signed_index(index, trusted, now=NOW)
    selection = release_channel.select_release(
        verified,
        channel="alpha",
        platform_name="linux",
        architecture="x64",
        install_source="archive",
        current_version="4.0.0-alpha.1",
    )
    assert selection["targetVersion"] == "4.0.0-alpha.2"
    assert selection["payloadRoot"] == index["payloadRoot"]
    assert selection["releasePassport"] == index["releasePassport"]


def test_signed_channel_authorizes_same_semver_release_cut_supersession(
    tmp_path: Path,
) -> None:
    current_manifest = _cut_aware_manifest(seed="6")
    target_manifest = _cut_aware_manifest(
        parent_release_cut_root=current_manifest["releaseCutRoot"],
        seed="7",
    )
    transition = _public_transition(
        current_manifest["releaseCut"],
        target_manifest["releaseCut"],
    )
    index, trusted = _signed_index(
        tmp_path,
        manifest=target_manifest,
        cut_transition=transition,
    )
    verified = release_channel.validate_signed_index(index, trusted, now=NOW)
    selection = release_channel.select_release(
        verified,
        channel="alpha",
        platform_name="linux",
        architecture="x64",
        install_source="archive",
        current_version=current_manifest["productVersion"],
        current_release_cut_root=current_manifest["releaseCutRoot"],
    )
    assert selection["targetVersion"] == selection["currentVersion"]
    assert (
        selection["targetReleaseCutRoot"]
        == index["entries"][0]["manifest"]["releaseCutRoot"]
    )
    assert selection["cutDecision"]["outcome"] == "verified-successor"
    assert selection["cutDecision"]["updateAllowed"] is True


def test_signed_public_channel_rejects_publication_ineligible_local_cut(
    tmp_path: Path,
) -> None:
    index, trusted = _signed_index(tmp_path, manifest=_cut_aware_manifest())
    entry = index["entries"][0]
    manifest = entry["manifest"]
    local_cut_input = {
        key: copy.deepcopy(value)
        for key, value in manifest["releaseCut"].items()
        if key != "releaseCutRoot"
    }
    local_cut_input["publicationPolicy"] = {
        "trustDomain": "shifu-local",
        "publicationEligible": False,
        "immutable": True,
        "eligibleChannels": [],
    }
    local_cut = release_cut.finish_release_cut(local_cut_input)
    manifest["releaseCut"] = local_cut
    manifest["releaseCutRoot"] = local_cut["releaseCutRoot"]
    entry["releaseCutRoot"] = local_cut["releaseCutRoot"]
    entry["manifestRoot"] = release_channel.content_root(manifest)
    index = _resign_index(index, tmp_path)

    _assert_error(
        "channel-release-cut-publication-policy-invalid",
        lambda: release_channel.validate_signed_index(index, trusted, now=NOW),
    )


def test_production_admission_builds_an_executable_same_semver_plan(
    tmp_path: Path,
) -> None:
    platform_name, architecture = distribution_update._normalize_platform()
    current_manifest = _cut_aware_manifest(
        seed="6",
        platform=platform_name,
        architecture=architecture,
        artifacts=[
            *_manifest()["artifacts"],
            {
                "kind": "cli",
                "url": "https://releases.kungfu.invalid/kungfu-cli.tar.gz",
                "size": 84,
                "digest": _root("9"),
                "signature": "sigstore:cli-fixture",
            },
        ],
    )
    previous, trusted = _signed_index(tmp_path, manifest=current_manifest)
    current_release_cut_root = previous["entries"][0]["releaseCutRoot"]
    previous_path = tmp_path / "previous.json"
    previous_path.write_text(json.dumps(previous), "utf-8")
    passport_path = tmp_path / "passport.json"
    passport_path.write_text(
        json.dumps({"source": {"headSha": SOURCE_COMMIT}}), "utf-8"
    )
    output_path = tmp_path / "production-successor.json"
    script = """
import fs from 'node:fs';
import {
  buildChannelIndex,
  channelSpecFromAdmission,
} from './product/scripts/release-channel-index.mjs';
const [manifestPath, passportPath, previousPath, privateKeyPath, outputPath, platform, architecture] =
  process.argv.slice(1);
const previousChannelIndex = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
const spec = channelSpecFromAdmission({
  admission: { manifests: [{ platform, architecture, manifestPath }] },
  releaseCandidatePassportPath: passportPath,
  channel: 'alpha',
  keyId: 'fixture-2026',
  generatedAt: '2026-07-23T00:00:00Z',
  expiresAt: '2026-07-24T00:00:00Z',
  previousChannelIndex,
});
const index = buildChannelIndex({
  spec,
  privateKeyPem: fs.readFileSync(privateKeyPath, 'utf8'),
});
fs.writeFileSync(outputPath, `${JSON.stringify(index)}\\n`);
"""
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            script,
            str(tmp_path / "manifest.json"),
            str(passport_path),
            str(previous_path),
            str(tmp_path / "private.pem"),
            str(output_path),
            platform_name,
            architecture,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    index = json.loads(output_path.read_text("utf-8"))
    verified = release_channel.validate_signed_index(index, trusted, now=NOW)
    selection = release_channel.select_release(
        verified,
        channel="alpha",
        platform_name=platform_name,
        architecture=architecture,
        install_source="archive",
        current_version=current_manifest["productVersion"],
        current_release_cut_root=current_release_cut_root,
    )
    plan = distribution_update.plan_update(
        selection,
        current_version=current_manifest["productVersion"],
        source={
            "source": "archive",
            "frontendAuthority": "archive-updater",
            "selfUpdateAllowed": True,
            "managerCommand": None,
            "selectedReleaseCutRoot": current_release_cut_root,
        },
        cache_root=tmp_path / "downloads",
    )
    assert selection["cutDecision"]["updateAllowed"] is True
    assert plan["action"] == "archive-self-update"
    assert (
        plan["cutTransitionRoot"]
        == index["entries"][0]["cutTransition"]["cutTransitionRoot"]
    )


@pytest.mark.parametrize("relation", [None, "diverged", "unknown"])
def test_same_semver_cut_conflict_never_updates_without_signed_supersession(
    tmp_path: Path,
    relation: str | None,
) -> None:
    current_manifest = _cut_aware_manifest(seed="6")
    target_manifest = _cut_aware_manifest(
        parent_release_cut_root=current_manifest["releaseCutRoot"],
        seed="7",
    )
    transition = (
        None
        if relation is None
        else _public_transition(
            current_manifest["releaseCut"],
            target_manifest["releaseCut"],
            relation=relation,
            kind="signed-lineage",
        )
    )
    index, trusted = _signed_index(
        tmp_path,
        manifest=target_manifest,
        cut_transition=transition,
    )
    verified = release_channel.validate_signed_index(index, trusted, now=NOW)
    selection = release_channel.select_release(
        verified,
        channel="alpha",
        platform_name="linux",
        architecture="x64",
        install_source="archive",
        current_version=current_manifest["productVersion"],
        current_release_cut_root=current_manifest["releaseCutRoot"],
    )
    assert selection["cutDecision"]["updateAllowed"] is False
    assert selection["cutDecision"]["reasonCode"] in {
        "cut-conflict",
        "cut-diverged",
        "cut-relation-unknown",
    }


@pytest.mark.parametrize(
    ("mutation", "code"),
    [
        (
            lambda value: value.update(payloadRoot=f"sha256:{'0' * 64}"),
            "channel-root-mismatch",
        ),
        (
            lambda value: value["signature"].update(
                value=base64.b64encode(b"\0" * 64).decode()
            ),
            "channel-signature-invalid",
        ),
        (
            lambda value: value["entries"][0]["manifest"].update(
                productVersion="4.0.0-alpha.3"
            ),
            "channel-root-mismatch",
        ),
    ],
)
def test_tampering_fails_closed(tmp_path: Path, mutation, code: str) -> None:
    index, trusted = _signed_index(tmp_path)
    mutation(index)
    _assert_error(
        code,
        lambda: release_channel.validate_signed_index(index, trusted, now=NOW),
    )


def test_artifact_root_is_verified_after_signature(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    index, trusted = _signed_index(tmp_path)
    index["entries"][0]["artifactRoot"] = f"sha256:{'4' * 64}"
    payload = {
        key: value
        for key, value in index.items()
        if key not in {"payloadRoot", "signature"}
    }
    index["payloadRoot"] = release_channel.content_root(payload)
    monkeypatch.setattr(release_channel, "verify_ed25519", lambda *_args: None)
    _assert_error(
        "channel-artifact-root-mismatch",
        lambda: release_channel.validate_signed_index(index, trusted, now=NOW),
    )


def test_schema_external_fields_fail_before_use(tmp_path: Path) -> None:
    index, trusted = _signed_index(tmp_path)
    index["unexpected"] = "not-authority"
    _assert_error(
        "channel-index-malformed",
        lambda: release_channel.validate_signed_index(index, trusted, now=NOW),
    )


def test_freshness_and_trust_fail_closed(tmp_path: Path) -> None:
    index, trusted = _signed_index(tmp_path)
    _assert_error(
        "channel-key-untrusted",
        lambda: release_channel.validate_signed_index(index, {}, now=NOW),
    )
    _assert_error(
        "channel-index-stale",
        lambda: release_channel.validate_signed_index(
            index,
            trusted,
            now=datetime(2026, 7, 24, tzinfo=timezone.utc),
        ),
    )


class _Response(io.BytesIO):
    def __init__(self, payload: bytes, url: str) -> None:
        super().__init__(payload)
        self._url = url

    def geturl(self) -> str:
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def test_https_cache_supports_verified_offline_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    index, trusted = _signed_index(tmp_path)
    payload = release_channel.canonical_json_bytes(index)
    monkeypatch.setattr(
        release_channel,
        "_open_https",
        lambda _request, timeout: _Response(
            payload, "https://releases.kungfu.invalid/alpha.json"
        ),
    )
    online = release_channel.resolve_index(
        "https://releases.kungfu.invalid/alpha.json",
        trusted,
        cache_root=tmp_path / "cache",
        now=NOW,
    )
    assert online["transportState"] == "https"

    monkeypatch.setattr(
        release_channel,
        "_open_https",
        lambda _request, timeout: (_ for _ in ()).throw(OSError("offline")),
    )
    fallback = release_channel.resolve_index(
        "https://releases.kungfu.invalid/alpha.json",
        trusted,
        cache_root=tmp_path / "cache",
        now=NOW,
    )
    assert fallback["transportState"] == "cache-fallback"
    offline = release_channel.resolve_index(
        "https://releases.kungfu.invalid/alpha.json",
        trusted,
        cache_root=tmp_path / "cache",
        offline=True,
        now=NOW,
    )
    assert offline["transportState"] == "offline-cache"


def test_local_fixture_requires_explicit_override(tmp_path: Path) -> None:
    index, trusted = _signed_index(tmp_path)
    path = tmp_path / "fixture.json"
    path.write_bytes(release_channel.canonical_json_bytes(index) + b"\n")
    _assert_error(
        "channel-transport-insecure",
        lambda: release_channel.resolve_index(
            str(path), trusted, cache_root=tmp_path / "cache", now=NOW
        ),
    )
    resolved = release_channel.resolve_index(
        str(path),
        trusted,
        cache_root=tmp_path / "cache",
        allow_local=True,
        now=NOW,
    )
    assert resolved["transportState"] == "local-fixture"


def test_noncanonical_fixture_and_insecure_redirect_are_rejected(
    tmp_path: Path,
) -> None:
    index, trusted = _signed_index(tmp_path)
    path = tmp_path / "pretty.json"
    path.write_text(json.dumps(index, indent=2), "utf-8")
    _assert_error(
        "channel-index-noncanonical",
        lambda: release_channel.resolve_index(
            str(path),
            trusted,
            cache_root=tmp_path / "cache",
            allow_local=True,
            now=NOW,
        ),
    )
    handler = release_channel._HttpsOnlyRedirectHandler()
    request = release_channel.urllib.request.Request(
        "https://releases.kungfu.invalid/alpha.json"
    )
    _assert_error(
        "channel-transport-insecure",
        lambda: handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "http://releases.kungfu.invalid/alpha.json",
        ),
    )


def test_selection_refuses_unsupported_paused_and_downgrade(
    tmp_path: Path,
) -> None:
    index, trusted = _signed_index(tmp_path)
    verified = release_channel.validate_signed_index(index, trusted, now=NOW)
    common = {
        "index": verified,
        "channel": "alpha",
        "platform_name": "linux",
        "architecture": "x64",
        "install_source": "archive",
        "current_version": "4.0.0-alpha.1",
    }
    _assert_error(
        "channel-entry-unavailable",
        lambda: release_channel.select_release(
            **{**common, "install_source": "homebrew"}
        ),
    )
    paused = copy.deepcopy(verified)
    paused["entries"][0]["rollout"] = "paused"
    _assert_error(
        "channel-rollout-paused",
        lambda: release_channel.select_release(**{**common, "index": paused}),
    )
    _assert_error(
        "channel-downgrade-refused",
        lambda: release_channel.select_release(
            **{**common, "current_version": "4.0.0-alpha.3"}
        ),
    )


def test_installed_product_owns_channel_reference_and_trust(tmp_path: Path) -> None:
    product = tmp_path / "product.json"
    product.write_text(
        json.dumps(
            {
                "update": {
                    "channels": {
                        "alpha": {
                            "indexUrl": "https://releases.kungfu.invalid/alpha.json",
                            "trustedKeys": [
                                {
                                    "keyId": "fixture-2026",
                                    "publicKey": base64.b64encode(b"1" * 32).decode(),
                                }
                            ],
                        }
                    }
                }
            }
        ),
        "utf-8",
    )
    config = release_channel.channel_config(product, "alpha")
    assert config["reference"].startswith("https://")
    assert set(config["trustedKeys"]) == {"fixture-2026"}


def test_bootstrap_verifier_binds_staged_archive_product_and_channel(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "kungfu-cli-linux-x64.tar.gz"
    archive.write_bytes(b"qualified bootstrap archive")
    digest = f"sha256:{hashlib.sha256(archive.read_bytes()).hexdigest()}"
    manifest = _cut_aware_manifest(
        artifacts=[
            {
                "kind": "runtime",
                "url": "https://releases.kungfu.invalid/runtime.tar.gz",
                "size": 42,
                "digest": RUNTIME_ROOT,
                "signature": "sigstore:fixture",
            },
            {
                "name": "kungfu-episodes-cli-linux-x64.tar.gz",
                "kind": "cli",
                "url": "https://releases.kungfu.invalid/kungfu-cli-linux-x64.tar.gz",
                "size": archive.stat().st_size,
                "digest": digest,
                "signature": "sigstore:fixture-cli",
            },
        ]
    )
    index, trusted = _signed_index(
        tmp_path,
        manifest=manifest,
        expires_at="2026-08-24T00:00:00Z",
    )
    channel = tmp_path / "channel.json"
    channel.write_bytes(release_channel.canonical_json_bytes(index) + b"\n")
    candidate = tmp_path / "candidate"
    (candidate / "upgrade").mkdir(parents=True)
    (candidate / "product.json").write_text(
        json.dumps(
            {
                "schema": "kungfu.product.cli/v1",
                "product": "cli",
                "platform": "linux",
                "archive": archive.name,
                "install": {"source": "archive"},
            }
        ),
        "utf-8",
    )
    (candidate / "upgrade" / "kungfu-release-manifest.json").write_text(
        json.dumps(
            _cut_aware_manifest(
                artifacts=[
                    artifact
                    for artifact in manifest["artifacts"]
                    if artifact["kind"] == "runtime"
                ]
            )
        ),
        "utf-8",
    )
    entry = index["entries"][0]
    key_id, public_key = next(iter(trusted.items()))
    receipt = release_channel.verify_bootstrap_candidate(
        channel_index=channel,
        trusted_keys={key_id: public_key},
        candidate_archive=archive,
        candidate_root=candidate,
        channel="alpha",
        platform_name="linux",
        architecture="x64",
        version=manifest["productVersion"],
        manifest_root=entry["manifestRoot"],
        artifact_root=entry["artifactRoot"],
        platform_trust="signed-channel-digest",
        now=NOW,
    )
    assert receipt["state"] == "verified"
    assert receipt["artifactDigest"] == digest
    assert receipt["channelPayloadRoot"] == index["payloadRoot"]
    assert receipt["releaseCutRoot"] == entry["manifest"]["releaseCutRoot"]
    assert receipt["platformSliceRoot"] == entry["manifest"]["platformSliceRoot"]
    assert (
        receipt["bundledManifestIdentityRoot"]
        == entry["manifest"]["manifestIdentityRoot"]
    )
    (candidate / "install").mkdir()
    (candidate / "install" / "bootstrap-receipt.json").write_text(
        json.dumps(receipt),
        "utf-8",
    )
    source = distribution_update.install_source(
        {},
        product_manifest=candidate / "product.json",
    )
    assert source["selectedFrontendBuildId"] == manifest["frontendBuildId"]
    assert source["bootstrapReceipt"]["receiptRoot"] == receipt["receiptRoot"]

    with pytest.raises(
        release_channel.ReleaseChannelError,
        match="platform trust evidence is invalid",
    ):
        release_channel.verify_bootstrap_candidate(
            channel_index=channel,
            trusted_keys={key_id: public_key},
            candidate_archive=archive,
            candidate_root=candidate,
            channel="alpha",
            platform_name="linux",
            architecture="x64",
            version=manifest["productVersion"],
            manifest_root=entry["manifestRoot"],
            artifact_root=entry["artifactRoot"],
            platform_trust="authenticode-valid",
            now=NOW,
        )

    archive.write_bytes(b"tampered")
    with pytest.raises(
        release_channel.ReleaseChannelError,
        match="differs from signed release evidence",
    ):
        release_channel.verify_bootstrap_candidate(
            channel_index=channel,
            trusted_keys={key_id: public_key},
            candidate_archive=archive,
            candidate_root=candidate,
            channel="alpha",
            platform_name="linux",
            architecture="x64",
            version=manifest["productVersion"],
            manifest_root=entry["manifestRoot"],
            artifact_root=entry["artifactRoot"],
            platform_trust="signed-channel-digest",
            now=NOW,
        )
