# SPDX-License-Identifier: Apache-2.0

"""Executable verification probes for Agent Runtime Profiles."""

from __future__ import annotations

import os
import re
import subprocess
from datetime import UTC, datetime
from typing import Any, Callable, Mapping


_SEMANTIC_VERSION = re.compile(
    r"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?![0-9])"
)


def parse_semantic_version(output: str) -> str | None:
    match = _SEMANTIC_VERSION.search(output)
    return match.group(1) if match else None


class VerificationProbe:
    """Inspect only one declared executable with its version command."""

    def __init__(
        self,
        *,
        schema: str,
        default_timeout_seconds: float = 5.0,
        provider_timeouts: Mapping[str, float | None] | None = None,
        run: Callable[..., Any] = subprocess.run,
    ) -> None:
        self.schema = schema
        self.default_timeout_seconds = default_timeout_seconds
        self.provider_timeouts = dict(provider_timeouts or {})
        self.run = run

    def timeout(self, provider: str) -> float | None:
        return self.provider_timeouts.get(provider, self.default_timeout_seconds)

    def raw_version(
        self,
        executable: str,
        version_argv: list[str],
        *,
        timeout_seconds: float | None = None,
    ) -> str | None:
        try:
            result = self.run(
                [executable, *(str(value) for value in version_argv)],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds or self.default_timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        output = (result.stdout or result.stderr or "").strip()
        return output.splitlines()[0].strip() if output else None

    def verify(self, profile: Mapping[str, Any]) -> dict[str, Any]:
        executable = str((profile.get("launch") or {}).get("executable") or "")
        provider = str(profile.get("provider") or "")
        launch_argv = [
            str(value) for value in (profile.get("launch") or {}).get("argv") or []
        ]
        probe_argv = [
            str(value)
            for value in (profile.get("launch") or {}).get("versionArgv") or []
        ]
        if not probe_argv:
            probe_argv = (
                [*launch_argv, "--version"]
                if provider == "synthetic"
                else ["--version"]
            )
        available = bool(
            executable and os.path.isfile(executable) and os.access(executable, os.X_OK)
        )
        version = None
        error = None
        warning = None
        if available:
            try:
                result = self.run(
                    [executable, *probe_argv],
                    capture_output=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.timeout(provider),
                    check=False,
                    env=(
                        {**os.environ, "KUNGFU_AS_VARIANT": "node"}
                        if provider == "synthetic"
                        else None
                    ),
                )
                text = (result.stdout or result.stderr or "").strip()
                if result.returncode != 0:
                    warning = f"version probe exited {result.returncode}"
                elif text:
                    first_line = text.splitlines()[0].strip()[:256]
                    version = parse_semantic_version(first_line) or first_line
                else:
                    warning = "version probe returned no output"
            except (OSError, subprocess.SubprocessError) as exc:
                warning = str(exc)
        else:
            error = "executable is missing or not executable"
        return {
            "schema": self.schema,
            "profileId": profile.get("id"),
            "provider": provider,
            "executable": executable,
            "argv": probe_argv,
            "available": available,
            "version": version,
            "ok": available,
            "error": error,
            "warning": warning,
            "versionAdmission": "diagnostic-only",
            "observedAt": datetime.now(UTC).isoformat(),
            "privacyBoundary": "bounded declared executable version probe only",
        }
