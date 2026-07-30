import importlib.util
from pathlib import Path

import pytest


CORE_DIR = Path(__file__).resolve().parents[2]
CONANFILE_PATH = CORE_DIR / "conanfile.py"


def _load_conanfile():
    spec = importlib.util.spec_from_file_location(
        "kungfu_core_conanfile", CONANFILE_PATH
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_prepare_rxcpp_compat_patches_copy_without_mutating_source(tmp_path):
    conanfile = _load_conanfile()
    source_include = tmp_path / "source" / "include"
    source_rxcpp = source_include / "rxcpp"
    source_rxcpp.mkdir(parents=True)
    source_header = source_rxcpp / "rx-notification.hpp"
    source_header.write_text(
        f"before\n{conanfile._RXCPP_INVALID_ASSIGNMENT}\nafter\n",
        encoding="utf-8",
    )

    destination_include = tmp_path / "build" / "compat"
    conanfile._prepare_rxcpp_compat(source_include, destination_include)

    assert conanfile._RXCPP_INVALID_ASSIGNMENT in source_header.read_text(
        encoding="utf-8"
    )
    generated = (destination_include / "rxcpp" / "rx-notification.hpp").read_text(
        encoding="utf-8"
    )
    assert conanfile._RXCPP_INVALID_ASSIGNMENT not in generated
    assert conanfile._RXCPP_DELETED_ASSIGNMENT in generated


def test_prepare_rxcpp_compat_fails_closed_on_upstream_drift(tmp_path):
    conanfile = _load_conanfile()
    source_rxcpp = tmp_path / "source" / "include" / "rxcpp"
    source_rxcpp.mkdir(parents=True)
    (source_rxcpp / "rx-notification.hpp").write_text(
        "upstream changed\n", encoding="utf-8"
    )

    with pytest.raises(RuntimeError, match="no longer matches exactly once"):
        conanfile._prepare_rxcpp_compat(
            tmp_path / "source" / "include", tmp_path / "build" / "compat"
        )


def test_cmake_path_normalizes_windows_separators():
    conanfile = _load_conanfile()

    assert conanfile._cmake_path(r"D:\a\kungfu\core\build\compat") == (
        "D:/a/kungfu/core/build/compat"
    )
