#  SPDX-License-Identifier: Apache-2.0

import json
import os

# The native binding is imported lazily (PEP 562 module __getattr__) rather than
# at package import. This lets the pure-stdlib capability guest
# (kungfu.capability.guest) be imported in an OS-sandboxed child that has no
# native binding — the binding-less guest the runtime-plane trust boundary
# requires (ADR-0013 / ADR-0014). Any consumer that touches kungfu.__binding__,
# kungfu.__version__ or kungfu.__build_info__ still resolves the binding on first
# use, exactly where it did before; only the paths that never touch it (the guest
# proxy) no longer pull it in.

_binding = None
_build_info = None


def _load_binding():
    global _binding
    if _binding is None:
        import pykungfu as binding

        _binding = binding
    return _binding


def _load_build_info():
    global _build_info
    if _build_info is None:
        binding = _load_binding()
        with open(
            os.path.join(os.path.dirname(binding.__file__), "kungfubuildinfo.json"),
            "r",
        ) as build_info_file:
            _build_info = json.load(build_info_file)
    return _build_info


def __getattr__(name):
    if name == "__binding__":
        return _load_binding()
    if name == "__build_info__":
        return _load_build_info()
    if name == "__version__":
        return _load_build_info()["version"]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def schema_data_path(module_file, name):
    """Resolve a package data file (e.g. a *.bfbs schema blob) in both layouts.

    In a source checkout the file sits next to its module; in the frozen
    standalone runtime the module is compiled into the executable (so
    ``dirname(__file__)`` is not a real directory) and data files are shipped
    flat next to the binding — the same place ``kungfubuildinfo.json`` lands.
    Try the source layout first, then fall back to the binding directory.
    """
    beside_module = os.path.join(os.path.dirname(module_file), name)
    if os.path.exists(beside_module):
        return beside_module
    return os.path.join(os.path.dirname(_load_binding().__file__), name)
