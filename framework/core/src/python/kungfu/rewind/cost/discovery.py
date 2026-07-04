#  SPDX-License-Identifier: Apache-2.0
#
# Provider binary discovery — locate the Codex and Claude CLIs a managed run
# would drive, and record enough to attribute a run to a concrete binary.
#
# Privacy boundary: discovery reads the PATH, a small set of known install
# locations, and the binary's own `--version`. It NEVER reads auth.json,
# cookies, the keychain,
# API keys, billing pages, or session databases. Version probing runs the
# binary with `--version` only.

from __future__ import annotations

import dataclasses
import shutil
import subprocess
import sys
from typing import Callable, Optional

# Codex ships a working CLI inside the macOS app bundle even when `codex` is not
# on the shell PATH (smoke evidence 2026-07-04). Discovery checks it explicitly
# so a Codex App user needs no PATH surgery.
CODEX_APP_BUNDLE = "/Applications/Codex.app/Contents/Resources/codex"

# how a binary was located — travels with the discovery for diagnostics and so
# a run can record which install it drove.
PATH_CLASS_PATH = "path"
PATH_CLASS_CODEX_APP_BUNDLE = "codex_app_bundle"

_VERSION_TIMEOUT_S = 5.0


@dataclasses.dataclass
class ProviderDiscovery:
    """Result of looking for one provider's CLI.

    `found` is the headline; `path`/`path_class`/`version` describe the hit;
    `candidates_checked` and `error` explain a miss so a failure is diagnosable
    rather than silent.
    """

    provider: str
    found: bool = False
    path: Optional[str] = None
    path_class: Optional[str] = None
    version: Optional[str] = None
    candidates_checked: list = dataclasses.field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


def _default_version_probe(path: str) -> Optional[str]:
    """Run `<path> --version` read-only and return the first non-empty line.

    Any failure (missing binary, timeout, non-zero exit) returns None — a
    version is a nice-to-have, never a reason to fail discovery.
    """
    try:
        proc = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=_VERSION_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = (proc.stdout or proc.stderr or "").strip()
    if not out:
        return None
    return out.splitlines()[0].strip()


# Candidate builders: given the resolver, yield (path, path_class) pairs to try
# in priority order. Each provider owns its own known locations here.
def _codex_candidates(which, platform):
    hits = []
    on_path = which("codex")
    if on_path:
        hits.append((on_path, PATH_CLASS_PATH))
    if platform == "darwin":
        hits.append((CODEX_APP_BUNDLE, PATH_CLASS_CODEX_APP_BUNDLE))
    return hits


def _claude_candidates(which, platform):
    hits = []
    on_path = which("claude")
    if on_path:
        hits.append((on_path, PATH_CLASS_PATH))
    return hits


_PROVIDER_CANDIDATES = {
    "codex": _codex_candidates,
    "claude": _claude_candidates,
}


def _exists(path: str) -> bool:
    # a PATH hit is already resolved; a known-location candidate must be checked.
    import os

    return os.path.isfile(path) and os.access(path, os.X_OK)


def discover_provider(
    provider: str,
    *,
    which: Callable[[str], Optional[str]] = shutil.which,
    version_probe: Optional[Callable[[str], Optional[str]]] = None,
    platform: str = sys.platform,
    exists: Callable[[str], bool] = _exists,
) -> ProviderDiscovery:
    """Locate one provider's CLI.

    Injectable `which` / `version_probe` / `platform` / `exists` keep this
    testable without a real binary on the machine — fixtures drive it with
    synthetic resolvers. `version_probe=None` uses the real `--version` runner;
    pass a stub to avoid executing anything.
    """
    if provider not in _PROVIDER_CANDIDATES:
        return ProviderDiscovery(
            provider=provider,
            found=False,
            error=f"unknown provider: {provider}",
        )
    probe = version_probe if version_probe is not None else _default_version_probe
    result = ProviderDiscovery(provider=provider)
    for path, path_class in _PROVIDER_CANDIDATES[provider](which, platform):
        result.candidates_checked.append(path)
        # PATH hits are pre-resolved by `which`; known-location candidates
        # (the app bundle) must be confirmed to exist and be executable.
        if path_class == PATH_CLASS_PATH or exists(path):
            result.found = True
            result.path = path
            result.path_class = path_class
            result.version = probe(path)
            return result
    if not result.found and result.error is None:
        result.error = "not found on PATH or known install locations"
    return result


def discover_providers(
    providers: Optional[list] = None,
    **kwargs,
) -> dict:
    """Discover several providers at once; returns {provider: ProviderDiscovery}.

    Defaults to the built-in provider set (codex, claude). All keyword args pass
    through to `discover_provider` (which/version_probe/platform/exists).
    """
    if providers is None:
        providers = ["codex", "claude"]
    return {p: discover_provider(p, **kwargs) for p in providers}
