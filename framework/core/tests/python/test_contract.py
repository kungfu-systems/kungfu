# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

from kungfu import contract
from kungfu.storage import service as storage_service


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


def test_action_runtime_passes_the_installed_product_root_to_native(
    monkeypatch, tmp_path
):
    product_root = tmp_path / "runtime"
    calls = []

    class Runtime:
        @staticmethod
        def run_storage_service_operation(operation, runtime_dir, request):
            calls.append((operation, runtime_dir, request))
            return {"ok": True}

    monkeypatch.setattr(storage_service, "_runtime", lambda: Runtime())
    monkeypatch.setattr("kungfu.host.product_root", lambda: product_root)

    assert storage_service.action_runtime("", "capabilities") == {"ok": True}
    assert calls == [
        (
            "action_runtime",
            "",
            {"action": "capabilities", "search_base": str(product_root)},
        )
    ]


def test_action_runtime_preserves_an_explicit_search_base(monkeypatch, tmp_path):
    calls = []

    class Runtime:
        @staticmethod
        def run_storage_service_operation(operation, runtime_dir, request):
            calls.append(request)
            return {"ok": True}

    monkeypatch.setattr(storage_service, "_runtime", lambda: Runtime())
    monkeypatch.setattr(
        "kungfu.host.product_root", lambda: tmp_path / "installed-runtime"
    )

    storage_service.action_runtime(
        "", "capabilities", {"search_base": "/explicit/product"}
    )
    assert calls == [{"action": "capabilities", "search_base": "/explicit/product"}]
