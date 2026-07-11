#  SPDX-License-Identifier: Apache-2.0
#
# The frozen first-party set (ADR-0013), supervisor side. Trust is granted by
# membership in this set — a verifiable origin — never by which extension root a
# package loaded from. An adapter is capture-side instrumentation that runs
# in-process inside the traced program; it cannot be sandboxed, so an untrusted
# adapter is refused, not contained — only a source-verified first-party adapter
# may inject.
#
# The set is read from the shared manifest (KF_FIRST_PARTY_MANIFEST, the same one
# the GUI loader consumes) when present; otherwise, in a source checkout, it is
# derived from the product's own extensions/ tree. A frozen build with no baked
# manifest trusts none — adapters are refused until the manifest ships (tracked
# with built-in-extension shipping).

from __future__ import annotations

import json
import os

from kungfu import host, kfx_contract

ENV_FIRST_PARTY_MANIFEST = "KF_FIRST_PARTY_MANIFEST"
BAKED_MANIFEST_NAME = "first-party.json"


def _read_keys(path: str | None) -> set[str] | None:
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, dict):
            kfx_contract.validate_first_party_manifest(data)
    except (OSError, ValueError):
        return None
    keys = data.get("keys")
    return set(keys) if isinstance(keys, dict) else None


def _baked_manifest_path() -> str | None:
    # A product build ships the manifest at the dist root (which the app also
    # ships to Resources/kungfu); a source interpreter has no product root, so
    # this is None there and the source scan takes over.
    root = host.product_root()
    return None if root is None else str(root / BAKED_MANIFEST_NAME)


def _source_extensions_root() -> str | None:
    # In a source checkout the product's own extensions/ tree is the first-party
    # root; None in a frozen build, where the baked manifest is authoritative.
    root = os.path.abspath(
        os.path.join(os.path.dirname(__file__), *([os.pardir] * 6), "extensions")
    )
    return root if os.path.isdir(root) else None


def _package_key(pkg: str) -> str | None:
    try:
        return kfx_contract.package_key(kfx_contract.read_manifest_from_dir(pkg))
    except (OSError, ValueError):
        return None


def _scan_keys(root: str | None) -> set[str]:
    # two levels deep, mirroring the loader / adapter discovery scan
    keys: set[str] = set()
    if not root or not os.path.isdir(root):
        return keys
    for name in sorted(os.listdir(root)):
        pkg = os.path.join(root, name)
        candidates = [pkg]
        if os.path.isdir(pkg):
            candidates += [os.path.join(pkg, s) for s in sorted(os.listdir(pkg))]
        for cand in candidates:
            key = _package_key(cand)
            if key:
                keys.add(key)
    return keys


def first_party_keys() -> set[str]:
    """The set of extension keys the supervisor may trust to inject an adapter.
    Resolved in order: the explicit KF_FIRST_PARTY_MANIFEST, then the manifest a
    frozen build bakes next to the executable, then a source-checkout scan of the
    product's own extensions/ tree."""
    keys = _read_keys(os.environ.get(ENV_FIRST_PARTY_MANIFEST))
    if keys is not None:
        return keys
    keys = _read_keys(_baked_manifest_path())
    if keys is not None:
        return keys
    return _scan_keys(_source_extensions_root())


def is_first_party(key: str | None) -> bool:
    """Whether an extension key is in the frozen first-party set (ADR-0013).
    Trust follows from the source, not from where the package is installed."""
    return key is not None and key in first_party_keys()
