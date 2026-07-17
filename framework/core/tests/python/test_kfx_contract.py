# SPDX-License-Identifier: Apache-2.0

import copy
import json
from pathlib import Path

import pytest

from kungfu import kfx_contract


PROFILE_FIXTURES = (
    Path(__file__).resolve().parents[4]
    / "tests"
    / "fixtures"
    / "kfx-profile-suite-contract"
)
VALID_PROFILE = json.loads(
    (PROFILE_FIXTURES / "week-day.profile.json").read_text(encoding="utf-8")
)
INVALID_PROFILE_CASES = json.loads(
    (PROFILE_FIXTURES / "invalid-cases.json").read_text(encoding="utf-8")
)


def _apply_profile_fixture_case(profile, case):
    target = profile
    for segment in case["path"][:-1]:
        target = target[segment]
    leaf = case["path"][-1]
    if case["operation"] == "remove":
        del target[leaf]
    else:
        target[leaf] = case["value"]


def test_kfx_contract_metadata_has_hash():
    metadata = kfx_contract.contract_metadata()

    assert metadata["schema"] == "kungfu.kfx.contract/v1"
    assert metadata["id"] == "kungfu-kfx"
    assert metadata["weldedSurface"] == "kfx-contract"
    assert str(metadata["hash"]).startswith("sha256:")


def test_kfx_package_manifest_schema_accepts_python_aot_probe():
    manifest = {
        "name": "@kungfu-tech/examples-probe-python",
        "version": "4.0.0-alpha.1",
        "kungfuConfig": {"key": "ProbePython"},
        "kungfuBuild": {"python": {"dependencies": {"pydantic": ">=2.0"}}},
    }

    kfx_contract.validate_package_manifest(manifest)
    assert kfx_contract.package_kind(manifest) == "python-aot"


def test_kfx_package_manifest_schema_accepts_bounded_wasm_profile():
    manifest = {
        "name": "example-wasm",
        "version": "1.0.0",
        "kungfuConfig": {
            "key": "example-wasm",
            "config": {
                "wasm": {
                    "world": "kungfu:journal/batch@1.0.0",
                    "entry": "dist/guest.wasm",
                    "sha256": "a" * 64,
                    "capabilities": ["journal.read.batch"],
                    "engine": "wasmtime",
                    "fallback": "wasmer",
                    "limits": {
                        "fuel": 100000,
                        "memoryPages": 32,
                        "batchFrames": 16,
                        "moduleBytes": 1048576,
                        "outputBytes": 64,
                    },
                }
            },
        },
    }

    kfx_contract.validate_package_manifest(manifest)
    assert kfx_contract.package_kind(manifest) == "wasm"


def test_kfx_package_manifest_schema_accepts_profile_suite_binding():
    manifest = {
        "name": "example-week-day-suite",
        "version": "1.0.0",
        "kungfuConfig": {
            "key": "week-day-suite",
            "suite": {
                "title": "Week / Day",
                "members": [
                    "week-day-contract",
                    "week-day-actions",
                    "week-day-assessment",
                    "week-day-dashboard",
                ],
                "profile": "week-day.profile.json",
            },
        },
    }

    kfx_contract.validate_package_manifest(manifest)
    assert kfx_contract.package_kind(manifest) == "suite"


def test_kfx_profile_suite_schema_accepts_complete_semantic_closure():
    members = [
        "week-day-contract",
        "week-day-actions",
        "week-day-assessment",
        "week-day-dashboard",
    ]

    kfx_contract.validate_profile_suite(VALID_PROFILE, suite_members=members)
    assert (
        kfx_contract.profile_suite_schema()["properties"]["schema"]["const"]
        == "kungfu.profile-suite/v1"
    )


@pytest.mark.parametrize(
    "case", INVALID_PROFILE_CASES, ids=[case["id"] for case in INVALID_PROFILE_CASES]
)
def test_kfx_profile_suite_negative_fixtures(case):
    profile = copy.deepcopy(VALID_PROFILE)
    _apply_profile_fixture_case(profile, case)

    with pytest.raises(ValueError, match=case["match"]):
        kfx_contract.validate_profile_suite(profile)


def test_kfx_profile_suite_rejects_package_member_drift():
    with pytest.raises(ValueError, match="must match kungfuConfig.suite.members"):
        kfx_contract.validate_profile_suite(
            VALID_PROFILE,
            suite_members=["week-day-contract", "week-day-actions"],
        )


def test_kfx_profile_suite_rejects_home_outside_profile_members():
    profile = copy.deepcopy(VALID_PROFILE)
    profile["experience"] = {"homeView": "unrelated-dashboard"}
    with pytest.raises(
        ValueError, match="experience.homeView must be a profile member"
    ):
        kfx_contract.validate_profile_suite(profile)


def test_kfx_package_manifest_schema_rejects_invalid_view_capabilities(tmp_path):
    package_dir = tmp_path / "bad-view"
    package_dir.mkdir()
    (package_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "@bad/view",
                "version": "1.0.0",
                "kungfuConfig": {
                    "key": "bad-view",
                    "config": {"view": {"capabilities": "ledger"}},
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="capabilities.*is not of type 'array'"):
        kfx_contract.read_manifest_from_dir(str(package_dir))


def test_kfx_contract_schema_rejects_missing_resolution_key(tmp_path):
    contract_path = kfx_contract.resolve_contract_path()
    contract = json.loads(open(contract_path, encoding="utf-8").read())
    del contract["resolution"]["extensionPathEnv"]
    broken = tmp_path / "kungfu-kfx.contract.json"
    broken.write_text(json.dumps(contract), encoding="utf-8")

    with pytest.raises(ValueError, match="contract validation failed"):
        kfx_contract.load_contract(str(broken))
