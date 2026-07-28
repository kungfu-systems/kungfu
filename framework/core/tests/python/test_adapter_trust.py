# SPDX-License-Identifier: Apache-2.0
#
# Rewind adapters execute inside the traced process. Their package name,
# discovery root, and product assembly metadata therefore confer no authority:
# injection requires one exact Core host authorization.

import json
import os

from kungfu import profile_sdk
from kungfu.rewind import adapters


def _write_adapter(root, key, runtime="python"):
    pkg = os.path.join(root, key)
    entry = os.path.join("src", "adapter", runtime, "index.py")
    os.makedirs(os.path.join(pkg, os.path.dirname(entry)), exist_ok=True)
    with open(os.path.join(pkg, "kungfu.kfx.json"), "w", encoding="utf-8") as file:
        json.dump(
            {
                "schema": "kungfu.kfx.manifest/v1",
                "name": f"@kungfu-tech/kfx-adapter-{key}",
                "version": "1.0.0",
                "kungfuConfig": {
                    "key": key,
                    "config": {
                        "adapter": {
                            "runtimes": [runtime],
                            "entry": {runtime: entry},
                            "capabilities": [],
                        }
                    },
                },
            },
            file,
        )
    with open(os.path.join(pkg, entry), "w", encoding="utf-8") as file:
        file.write("# adapter source\n")
    return pkg


def _host_descriptor(package_key, package_root, authorization_root):
    roots = {
        name: f"sha256:{character * 64}"
        for name, character in {
            "descriptor": "0",
            "registry": "1",
            "graph": "2",
            "plan": "3",
            "receipt": "4",
            "cut": "5",
            "generation": "6",
            "package": "7",
            "manifest": "8",
            "provider": "9",
            "trust": "a",
            "report": "b",
            "admissionPlan": "c",
            "corePolicy": "d",
            "requestedPolicy": "e",
            "policy": "f",
            "authorizationPlan": "0",
            "declaration": "1",
            "grant": "2",
            "warrant": "3",
        }.items()
    }
    authorization = {
        "schema": "kungfu.kfx.host-authorization/v2",
        "packageKey": package_key,
        "packageRoot": package_root,
        "manifestRoot": roots["manifest"],
        "ownerProviderRoot": roots["provider"],
        "trustRoot": roots["trust"],
        "runtimeTier": "integrated-explicit",
        "admissionGrade": "kfd-attested",
        "placement": "co-resident",
        "requiredCapabilities": [],
        "grantedCapabilities": [],
        "reportRoot": roots["report"],
        "admissionPlanRoot": roots["admissionPlan"],
        "corePolicyRoot": roots["corePolicy"],
        "requestedPolicyRoot": roots["requestedPolicy"],
        "policyRoot": roots["policy"],
        "authorizationPlanRoot": roots["authorizationPlan"],
        "capabilityDeclarationRoot": roots["declaration"],
        "capabilityGrantRoot": roots["grant"],
        "warrantRoot": roots["warrant"],
        "cutRoot": roots["cut"],
        "revision": 1,
        "generationRoot": roots["generation"],
        "executionAllowed": True,
        "authorizationRoot": authorization_root,
        "host": "adapter-python",
    }
    return {
        "schema": "kungfu.kfx.experience-flow-host/v3",
        "descriptorRoot": roots["descriptor"],
        "registryRoot": roots["registry"],
        "graphRoot": roots["graph"],
        "planRoot": roots["plan"],
        "receiptDependencyRoot": roots["receipt"],
        "cutRoot": roots["cut"],
        "revision": 1,
        "generation": {
            "schema": "kungfu.kfx.host-generation/v2",
            "registryRoot": roots["registry"],
            "graphRoot": roots["graph"],
            "cutRoot": roots["cut"],
            "revision": 1,
        },
        "generationRoot": roots["generation"],
        "admission": {
            "schema": "kungfu.kfx.host-admission/v2",
            "state": "admitted",
            "exactRootRequired": True,
            "registryRoot": roots["registry"],
            "graphRoot": roots["graph"],
            "planRoot": roots["plan"],
            "cutRoot": roots["cut"],
            "revision": 1,
            "generationRoot": roots["generation"],
            "contributionRoots": [],
            "facetRoots": [],
            "capabilityRoots": [],
            "authorizationRoots": [],
            "runtimeAuthorizationRoots": [authorization_root],
        },
        "runtimeAuthorizations": [authorization],
        "contributions": [],
    }


def _write_descriptor(tmp_path, monkeypatch, package_key, authorization_root):
    path = tmp_path / "host-descriptor.json"
    path.write_text(
        json.dumps(
            _host_descriptor(
                package_key,
                profile_sdk.package_content_root(tmp_path / "extensions" / package_key),
                authorization_root,
            )
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("KF_KFX_HOST_DESCRIPTOR", str(path))


def _setup(tmp_path, monkeypatch):
    extension_root = tmp_path / "extensions"
    _write_adapter(str(extension_root), "bundled-a")
    _write_adapter(str(extension_root), "external-b")
    monkeypatch.setenv("KF_EXTENSION_PATH", str(extension_root))


def test_discovery_origin_and_package_name_confer_zero_authority(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    entries, dirs, refused = adapters.discover_adapters(None, "python")
    assert entries == [] and dirs == []
    assert {row["key"] for row in refused} == {"bundled-a", "external-b"}


def test_only_the_exact_core_authorization_allows_in_process_injection(
    tmp_path, monkeypatch
):
    _setup(tmp_path, monkeypatch)
    authorization_root = f"sha256:{'4' * 64}"
    _write_descriptor(tmp_path, monkeypatch, "external-b", authorization_root)

    entries, dirs, refused = adapters.discover_adapters(None, "python")
    assert len(entries) == 1
    assert {os.path.basename(path) for path in dirs} == {"external-b"}
    assert {row["key"] for row in refused} == {"bundled-a"}


def test_mismatched_authorization_root_fails_closed(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    descriptor = _host_descriptor(
        "bundled-a",
        profile_sdk.package_content_root(tmp_path / "extensions" / "bundled-a"),
        f"sha256:{'4' * 64}",
    )
    descriptor["admission"]["runtimeAuthorizationRoots"][0] = f"sha256:{'5' * 64}"
    path = tmp_path / "host-descriptor.json"
    path.write_text(json.dumps(descriptor), encoding="utf-8")
    monkeypatch.setenv("KF_KFX_HOST_DESCRIPTOR", str(path))

    entries, dirs, refused = adapters.discover_adapters(None, "python")
    assert entries == [] and dirs == []
    assert {row["key"] for row in refused} == {"bundled-a", "external-b"}


def test_same_key_with_different_package_root_cannot_borrow_authority(
    tmp_path, monkeypatch
):
    _setup(tmp_path, monkeypatch)
    authorization_root = f"sha256:{'4' * 64}"
    _write_descriptor(tmp_path, monkeypatch, "external-b", authorization_root)
    adapter = (
        tmp_path
        / "extensions"
        / "external-b"
        / "src"
        / "adapter"
        / "python"
        / "index.py"
    )
    adapter.write_text("# different adapter source\n", encoding="utf-8")

    entries, dirs, refused = adapters.discover_adapters(None, "python")
    assert entries == [] and dirs == []
    assert {row["key"] for row in refused} == {"bundled-a", "external-b"}
