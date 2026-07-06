# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from kungfu import kfx_contract


def test_kfx_contract_metadata_has_hash():
    metadata = kfx_contract.contract_metadata()

    assert metadata["schema"] == "kungfu.kfx.contract/v1"
    assert metadata["id"] == "kungfu-kfx"
    assert metadata["weldedSurface"] == "kfx-contract"
    assert str(metadata["hash"]).startswith("sha256:")


def test_kfx_package_manifest_schema_accepts_python_aot_probe():
    manifest = {
        "name": "@kungfu-tech/examples-probe-python",
        "version": "4.0.0-alpha.0",
        "kungfuConfig": {"key": "ProbePython"},
        "kungfuBuild": {"python": {"dependencies": {"pydantic": ">=2.0"}}},
    }

    kfx_contract.validate_package_manifest(manifest)
    assert kfx_contract.package_kind(manifest) == "python-aot"


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
