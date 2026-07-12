# SPDX-License-Identifier: Apache-2.0

import hashlib

import pytest

from kungfu.cli.commands import kfx


def _manifest(digest):
    return {
        "kungfuConfig": {
            "key": "portable",
            "config": {
                "wasm": {
                    "world": "kungfu:journal/batch@1.0.0",
                    "entry": "dist/guest.wasm",
                    "sha256": digest,
                    "capabilities": ["journal.read.batch"],
                    "engine": "wasmtime",
                    "fallback": "wasmer",
                    "limits": {
                        "fuel": 100000,
                        "memoryPages": 2,
                        "batchFrames": 16,
                        "moduleBytes": 4096,
                        "outputBytes": 64,
                    },
                }
            },
        }
    }


def test_wasm_run_spec_requires_consent_and_rehashes_artifact(tmp_path):
    package = tmp_path / "portable"
    module = package / "dist" / "guest.wasm"
    module.parent.mkdir(parents=True)
    module.write_bytes(b"\0asmfixture")
    digest = hashlib.sha256(module.read_bytes()).hexdigest()

    with pytest.raises(ValueError, match="manifest declarations do not grant"):
        kfx._wasm_run_spec(package, _manifest(digest), [])

    config, resolved = kfx._wasm_run_spec(
        package, _manifest(digest), ["journal.read.batch"]
    )
    assert resolved == module
    assert config["world"] == "kungfu:journal/batch@1.0.0"


def test_wasm_run_spec_rejects_escape_and_hash_drift(tmp_path):
    package = tmp_path / "portable"
    package.mkdir()
    outside = tmp_path / "guest.wasm"
    outside.write_bytes(b"\0asmoutside")
    escaped = _manifest(hashlib.sha256(outside.read_bytes()).hexdigest())
    escaped["kungfuConfig"]["config"]["wasm"]["entry"] = "../guest.wasm"
    with pytest.raises(ValueError, match="inside the installed package"):
        kfx._wasm_run_spec(package, escaped, ["journal.read.batch"])

    module = package / "guest.wasm"
    module.write_bytes(b"\0asmchanged")
    drifted = _manifest("0" * 64)
    drifted["kungfuConfig"]["config"]["wasm"]["entry"] = "guest.wasm"
    with pytest.raises(ValueError, match="SHA-256"):
        kfx._wasm_run_spec(package, drifted, ["journal.read.batch"])
