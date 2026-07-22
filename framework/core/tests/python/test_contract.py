# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

from kungfu import contract


def test_source_discovery_never_treats_the_module_file_as_a_directory(monkeypatch):
    module_file = Path(contract.__file__).resolve()
    original_is_file = Path.is_file

    def windows_like_is_file(candidate):
        if module_file in candidate.parents:
            raise FileNotFoundError(candidate)
        return original_is_file(candidate)

    monkeypatch.setattr(Path, "is_file", windows_like_is_file)

    registry = Path(contract.resolve_registry_path(env={}))
    runtime = Path(contract.resolve_contract_path("runtime", env={}))

    assert registry.name == contract.REGISTRY_FILE
    assert original_is_file(registry)
    assert original_is_file(runtime)
