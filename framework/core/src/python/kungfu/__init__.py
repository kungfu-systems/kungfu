#  SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import importlib
import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Type-only: give kungfu.__binding__ the pykungfu module type so consumers
    # (the yjj.sink base class, yjj.locator/writer/... calls) type-check against
    # the .pyi stubs. Must be an assignment, not `import pykungfu as __binding__`
    # (mypy treats a renamed import as a private, non-exported name). At runtime
    # this block never executes (TYPE_CHECKING is False) and __binding__ is still
    # provided lazily by the module __getattr__ below — no behavior change.
    import pykungfu

    __binding__ = pykungfu

# The native binding is imported lazily (PEP 562 module __getattr__) rather than
# at package import. This lets the pure-stdlib capability guest
# (kungfu.capability.guest) be imported in an OS-sandboxed child that has no
# native binding — the binding-less guest the runtime-plane trust boundary
# requires (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847 / KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9). Any consumer that touches kungfu.__binding__,
# kungfu.__version__ or kungfu.__build_info__ still resolves the binding on first
# use, exactly where it did before; only the paths that never touch it (the guest
# proxy) no longer pull it in.

_binding: Any = None
_build_info: dict[str, Any] | None = None


class WrongRuntimeError(RuntimeError):
    """Raised when the kungfu package runs on a foreign interpreter.

    Packages only resolve against kungfu's own pinned runtime (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05):
    the blessed interpreter is the kungfu-managed python-build-standalone that
    `kungfu env` derives environments from.
    Running anywhere else turns into this named error instead of a mystery
    native-import failure three layers deeper.
    """


def _runtime_violation(
    python_version: str,
    *,
    base_prefix: str,
    running_version: str,
    assembled: bool = False,
) -> str | None:
    """Judge interpreter blessedness; None means blessed.

    Pure so both verdicts unit-test without staging real interpreters. The
    assembled host is blessed by construction: the shipped
    python-build-standalone tree IS the product runtime
    (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2). A satellite is blessed when its feature version
    matches the one the binding was built for and it runs from a
    kungfu-managed python-build-standalone install (whose prefix directory
    is named cpython-<version>-<platform>).
    """
    if assembled:
        return None
    expected_feature = ".".join(python_version.split(".")[:2])
    running_feature = ".".join(running_version.split(".")[:2])
    if expected_feature and running_feature != expected_feature:
        return (
            f"this kungfu build speaks python {expected_feature}.x, "
            f"but the running interpreter is {running_version}"
        )
    if not os.path.basename(base_prefix).startswith("cpython-"):
        return (
            f"the running interpreter at {base_prefix} is not the "
            "kungfu-managed runtime"
        )
    return None


def _verify_blessed_runtime(binding: Any) -> None:
    import sys

    if os.environ.get("KUNGFU_ALLOW_FOREIGN_RUNTIME"):
        # The one named bypass (never silent): print where support ends.
        print(
            "kungfu: KUNGFU_ALLOW_FOREIGN_RUNTIME is set — running on an "
            "unblessed interpreter, on your own recognizance",
            file=sys.stderr,
        )
        return
    info_path = os.path.join(os.path.dirname(binding.__file__), "kungfubuildinfo.json")
    try:
        with open(info_path, "r") as build_info_file:
            python_version = json.load(build_info_file).get("pythonVersion", "")
    except OSError:
        return  # no buildinfo (bare dev build) — nothing to judge against
    from kungfu import host

    running = ".".join(str(v) for v in sys.version_info[:3])
    violation = _runtime_violation(
        python_version,
        base_prefix=sys.base_prefix,
        running_version=running,
        assembled=host.host_form() == host.FORM_ASSEMBLED,
    )
    if violation:
        raise WrongRuntimeError(
            f"{violation}\n"
            f"  found:    {sys.executable}\n"
            f"  expected: the kungfu runtime (python {python_version}, "
            "kungfu-managed)\n"
            "  fix:      run inside an env derived from it — "
            "kungfu env create, then kungfu env run"
        )


def _load_binding() -> Any:
    global _binding
    if _binding is None:
        import pykungfu as binding

        _verify_blessed_runtime(binding)
        _binding = binding
    return _binding


def _load_build_info() -> dict[str, Any]:
    global _build_info
    if _build_info is None:
        binding = _load_binding()
        with open(
            os.path.join(os.path.dirname(binding.__file__), "kungfubuildinfo.json"),
            "r",
        ) as build_info_file:
            _build_info = json.load(build_info_file)
    return _build_info


def __getattr__(name: str) -> Any:
    if name == "__binding__":
        return _load_binding()
    if name == "__build_info__":
        return _load_build_info()
    if name == "__version__":
        return _load_build_info()["version"]
    if name in {"initiative_bundle", "work_control"}:
        return importlib.import_module("kungfu.assignment_runtime").profile_domain(name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def schema_data_path(module_file: str, name: str) -> str:
    """Resolve a package data file (e.g. a *.bfbs schema blob) in both layouts.

    In a source checkout the file sits next to its module. In the assembled
    runtime, generated data also ships next to the binding — the same place
    ``kungfubuildinfo.json`` lands. Try the source layout first, then fall back
    to the binding directory.
    """
    beside_module = os.path.join(os.path.dirname(module_file), name)
    if os.path.exists(beside_module):
        return beside_module
    return os.path.join(os.path.dirname(_load_binding().__file__), name)
