# SPDX-License-Identifier: Apache-2.0
#
# Rewind adapters execute inside the traced process. Their package name,
# discovery root, and product assembly metadata therefore confer no authority:
# injection requires one exact Core host authorization.

import json
import os

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


def _host_descriptor(package_key, authorization_root):
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
        "packageRoot": roots["package"],
        "manifestRoot": roots["manifest"],
        "ownerProviderRoot": roots["provider"],
        "trustRoot": roots["trust"],
        "runtimeTier": "integrated-explicit",
        "admissionGrade": "kfd-attested",
        "placement": "co-resident",
        "requiredCapabilities": ["process"],
        "grantedCapabilities": ["process"],
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


def _mock_native_authority(
    monkeypatch, descriptor, allowed_key=None, *, observed_matches=True
):
    calls = []

    def kfx_registry(action, request, runtime_dir):
        calls.append((action, request, runtime_dir))
        if action == "plan":
            if descriptor is None:
                raise ValueError("KF_KFX_CUT_MISSING")
            return {"hostContract": descriptor}
        if action == "inspect":
            candidate = next(
                (
                    item
                    for item in descriptor["runtimeAuthorizations"]
                    if item["packageKey"] == request["packageKey"]
                ),
                None,
            )
            if candidate is None or not observed_matches:
                return {
                    "package": {
                        "packageRoot": f"sha256:{'e' * 64}",
                        "manifestRoot": f"sha256:{'e' * 64}",
                    }
                }
            return {
                "package": {
                    "packageRoot": candidate["packageRoot"],
                    "manifestRoot": candidate["manifestRoot"],
                }
            }
        if action == "runtime-warrant-heartbeat":
            return {"leaseState": {"state": "active"}}
        if action == "runtime-warrant-settle":
            return {"leaseState": {"state": "settled"}}
        if action != "runtime-warrant-adopt":
            raise AssertionError(f"unexpected native KFX action: {action}")
        candidate = next(
            (
                item
                for item in descriptor["runtimeAuthorizations"]
                if item["packageKey"] == request["packageKey"]
                and item["host"] == request["host"]
            ),
            None,
        )
        if (
            candidate is None
            or request["packageKey"] != allowed_key
            or request["expectedAuthorizationRoot"] != candidate["authorizationRoot"]
        ):
            raise ValueError("KF_KFX_AUTHORIZATION_STALE")
        return {
            "schema": "kungfu.kfx.runtime-warrant-adoption/v1",
            "executionAllowed": True,
            "hostLaunch": {"authorization": candidate},
            "runtimeWarrant": {
                "warrantRoot": f"sha256:{'6' * 64}",
                "packageKey": candidate["packageKey"],
                "host": candidate["host"],
                "holder": request["holder"],
                "capabilityGrantRoot": candidate["capabilityGrantRoot"],
                "mutationWarrantRoot": candidate["warrantRoot"],
            },
            "leaseState": {
                "warrantRoot": f"sha256:{'6' * 64}",
                "holder": request["holder"],
                "generation": 1,
                "fencingToken": f"sha256:{'7' * 64}",
                "state": "active",
            },
        }

    monkeypatch.setattr(adapters.storage_service, "kfx_registry", kfx_registry)
    return calls


def _setup(tmp_path, monkeypatch):
    extension_root = tmp_path / "extensions"
    _write_adapter(str(extension_root), "bundled-a")
    _write_adapter(str(extension_root), "external-b")
    monkeypatch.setenv("KF_EXTENSION_PATH", str(extension_root))


def test_discovery_origin_and_package_name_confer_zero_authority(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _mock_native_authority(monkeypatch, None)
    entries, dirs, refused = adapters.discover_adapters(
        str(tmp_path / "runtime"), "python", []
    )
    assert entries == [] and dirs == []
    assert {row["key"] for row in refused} == {"bundled-a", "external-b"}


def test_only_the_exact_core_authorization_allows_in_process_injection(
    tmp_path, monkeypatch
):
    _setup(tmp_path, monkeypatch)
    authorization_root = f"sha256:{'4' * 64}"
    descriptor = _host_descriptor("external-b", authorization_root)
    calls = _mock_native_authority(monkeypatch, descriptor, "external-b")

    leases = []
    entries, dirs, refused = adapters.discover_adapters(
        str(tmp_path / "runtime"), "python", leases
    )
    assert len(entries) == 1
    assert {os.path.basename(path) for path in dirs} == {"external-b"}
    assert {row["key"] for row in refused} == {"bundled-a"}
    launch = next(
        request for action, request, _ in calls if action == "runtime-warrant-adopt"
    )
    assert launch["expectedCutRoot"] == descriptor["cutRoot"]
    assert launch["expectedGenerationRoot"] == descriptor["generationRoot"]
    assert launch["expectedAuthorizationRoot"] == authorization_root
    assert launch["requestedCapabilities"] == ["process"]
    for lease in leases:
        lease.settle("completed")


def test_caller_supplied_descriptor_conveys_zero_authority(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    descriptor = _host_descriptor("bundled-a", f"sha256:{'4' * 64}")
    path = tmp_path / "host-descriptor.json"
    path.write_text(json.dumps(descriptor), encoding="utf-8")
    monkeypatch.setenv("KF_KFX_HOST_DESCRIPTOR", str(path))
    _mock_native_authority(monkeypatch, None)

    entries, dirs, refused = adapters.discover_adapters(
        str(tmp_path / "runtime"), "python", []
    )
    assert entries == [] and dirs == []
    assert {row["key"] for row in refused} == {"bundled-a", "external-b"}


def test_same_key_shadow_with_different_closure_is_refused(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    descriptor = _host_descriptor("external-b", f"sha256:{'4' * 64}")
    calls = _mock_native_authority(
        monkeypatch, descriptor, "external-b", observed_matches=False
    )

    entries, dirs, refused = adapters.discover_adapters(
        str(tmp_path / "runtime"), "python", []
    )
    assert entries == [] and dirs == []
    assert {row["key"] for row in refused} == {"bundled-a", "external-b"}
    assert not any(action == "runtime-warrant-adopt" for action, _, _ in calls)
