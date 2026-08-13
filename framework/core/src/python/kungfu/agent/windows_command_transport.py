# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral Windows command-wrapper prompt transport."""

from __future__ import annotations

from pathlib import Path
import re
import shutil
import sys
from typing import Mapping, Sequence


COMMAND_WRAPPER_SUFFIXES = {".bat", ".cmd"}
_FORWARDING_WRAPPER = re.compile(
    r'\A\s*@echo\s+off\s*\r?\n\s*call\s+"(?P<target>[^"\r\n]+)"\s+%\*\s*\Z',
    re.IGNORECASE,
)
_NPM_WRAPPER_ENTRY = re.compile(
    r"^\s*endlocal\s+&\s+goto\s+#_undefined_#\s+2>nul\s+\|\|\s+"
    r'title\s+%comspec%\s+&\s+"%_prog%"\s+'
    r'"%dp0%\\(?P<entry>[^"\r\n]+)"\s+%\*\s*$',
    re.IGNORECASE | re.MULTILINE,
)
_NPM_WRAPPER_MARKERS = (
    "goto start",
    ":find_dp0",
    "set dp0=%~dp0",
    "call :find_dp0",
    'set "_prog=',
)
_ENV_REFERENCE = re.compile(r"%([^%\r\n]+)%")
_PROMPT_INSTRUCTION_PREFIX = (
    "Kungfu Windows command-wrapper transport: the complete prompt follows as "
    "ASCII text with Unicode escapes. Interpret every backslash-u escape, "
    "including surrogate pairs, then follow the decoded prompt exactly: "
)
_PROMPT_SAFE_CHARACTERS = frozenset(" .,:;/_-")


def resolve_command_wrapper(
    argv: Sequence[str], *, env: Mapping[str, str]
) -> list[str]:
    """Resolve exact forwarding and standard npm wrappers before shell parsing."""

    resolved = [str(value) for value in argv]
    if sys.platform != "win32" or not resolved:
        return resolved
    environment = {str(key).casefold(): str(value) for key, value in env.items()}
    observed: set[str] = set()
    for _ in range(8):
        wrapper = Path(resolved[0])
        identity = str(wrapper.resolve(strict=False)).casefold()
        if (
            wrapper.suffix.lower() not in COMMAND_WRAPPER_SUFFIXES
            or identity in observed
        ):
            break
        observed.add(identity)
        try:
            if wrapper.stat().st_size > 16 * 1024:
                break
            content = wrapper.read_text(encoding="utf-8", errors="replace")
        except OSError:
            break
        forwarding_match = _FORWARDING_WRAPPER.fullmatch(content)
        if forwarding_match is None:
            npm_launch = _resolve_npm_wrapper(
                wrapper, content=content, environment=environment
            )
            if npm_launch is None:
                break
            resolved = [*npm_launch, *resolved[1:]]
            break

        missing_environment = False

        def expand_environment(reference: re.Match[str]) -> str:
            nonlocal missing_environment
            value = environment.get(reference.group(1).casefold())
            if value is None:
                missing_environment = True
                return reference.group(0)
            return value

        target_text = _ENV_REFERENCE.sub(
            expand_environment, forwarding_match.group("target")
        )
        if missing_environment:
            break
        target = Path(target_text)
        if not target.is_absolute():
            target = wrapper.parent / target
        if not target.is_file():
            break
        resolved[0] = str(target)
    return resolved


def _resolve_npm_wrapper(
    wrapper: Path, *, content: str, environment: Mapping[str, str]
) -> list[str] | None:
    """Return the native argv prefix for a standard npm-generated shim."""

    lowered = content.casefold()
    if not all(marker in lowered for marker in _NPM_WRAPPER_MARKERS):
        return None
    match = _NPM_WRAPPER_ENTRY.search(content)
    if match is None:
        return None

    wrapper_root = wrapper.parent.resolve(strict=False)
    entrypoint = (wrapper_root / match.group("entry")).resolve(strict=False)
    try:
        entrypoint.relative_to(wrapper_root)
    except ValueError:
        return None
    if not entrypoint.is_file():
        return None

    local_node = wrapper_root / "node.exe"
    if local_node.is_file():
        executable = local_node
    else:
        node = shutil.which("node", path=environment.get("path"))
        if not node:
            return None
        executable = Path(node)
    if not executable.is_file():
        return None
    return [str(executable), str(entrypoint)]


def encode_wrapper_prompt(argv: Sequence[str]) -> list[str]:
    """Encode multiline prompts outside ``cmd.exe`` metacharacter syntax."""

    resolved = [str(value) for value in argv]
    if not resolved or not any(marker in resolved[-1] for marker in ("\r", "\n")):
        return resolved
    resolved[-1] = _PROMPT_INSTRUCTION_PREFIX + _escape_prompt(resolved[-1])
    return resolved


def _escape_prompt(value: str) -> str:
    encoded: list[str] = []
    for character in value:
        codepoint = ord(character)
        if character.isascii() and (
            character.isalnum() or character in _PROMPT_SAFE_CHARACTERS
        ):
            encoded.append(character)
        elif codepoint <= 0xFFFF:
            encoded.append(f"\\u{codepoint:04x}")
        else:
            scalar = codepoint - 0x10000
            encoded.append(f"\\u{0xD800 + (scalar >> 10):04x}")
            encoded.append(f"\\u{0xDC00 + (scalar & 0x3FF):04x}")
    return "".join(encoded)
