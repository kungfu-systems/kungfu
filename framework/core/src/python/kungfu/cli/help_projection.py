# SPDX-License-Identifier: Apache-2.0

"""Stable progressive-help projection derived from the CLI surface contract."""

from __future__ import annotations

import hashlib
import json
import shutil
import textwrap
from typing import Any

import click


SCHEMA = "kungfu.cli-help-projection/v1"


class ProjectionError(ValueError):
    """The surface contract cannot be projected without losing governance."""


def build(
    root_command: click.Command,
    *,
    metadata_registry: dict[str, Any] | None = None,
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if metadata_registry is None:
        from kungfu.cli import surface_contract

        metadata_registry = surface_contract.registry()
    help_policy = metadata_registry.get("helpProjection", {})
    if help_policy.get("schema") != SCHEMA:
        raise ProjectionError(f"helpProjection.schema must be {SCHEMA}")
    sections = list(help_policy.get("sections", []))
    section_ids = [row.get("id") for row in sections]
    if not sections or any(
        not isinstance(value, str) or not value for value in section_ids
    ):
        raise ProjectionError("helpProjection.sections must contain non-empty ids")
    if any(
        not isinstance(row.get("title"), str) or not row.get("title")
        for row in sections
    ):
        raise ProjectionError("helpProjection.sections must contain non-empty titles")
    if len(section_ids) != len(set(section_ids)):
        raise ProjectionError("helpProjection.sections contains duplicate ids")

    if contract is None:
        from kungfu.cli import surface_contract

        contract = surface_contract.fold(
            root_command, metadata_registry=metadata_registry
        )
    diagnostics = contract.get("diagnostics", {})
    if not diagnostics.get("ok"):
        codes = ", ".join(
            sorted(
                {row.get("code", "unknown") for row in diagnostics.get("errors", [])}
            )
        )
        raise ProjectionError(f"surface contract diagnostics failed: {codes}")

    commands = []
    seen_paths = set()
    known_sections = set(section_ids)
    priorities = getattr(root_command, "help_priorities", {})
    for row in contract.get("surfaces", []):
        source_kind = row.get("source", {}).get("kind")
        is_family = row.get("path_depth") == 2 and source_kind == "runtime-click"
        is_contribution = (
            row.get("path_depth") == 2 and source_kind == "kfx-contribution"
        )
        if not (is_family or is_contribution):
            continue
        if row.get("visibility") == "hidden-internal":
            continue
        section = row.get("section")
        if section not in known_sections:
            raise ProjectionError(
                f"surface {row.get('canonical_path')} has unknown help section {section!r}"
            )
        path = row.get("canonical_path")
        if path in seen_paths:
            raise ProjectionError(f"surface {path} is projected more than once")
        seen_paths.add(path)
        name = str(path).split()[-1]
        commands.append(
            {
                "id": row.get("id"),
                "name": name,
                "path": path,
                "summary": row.get("summary", ""),
                "section": section,
                "visibility": row.get("visibility"),
                "availability": row.get("availability"),
                "maturity": row.get("maturity"),
                "owner": row.get("owner"),
                "audience": row.get("audience", []),
                "priority": priorities.get(name, 100),
            }
        )

    commands.sort(
        key=lambda row: (
            section_ids.index(row["section"]),
            row["priority"],
            row["name"],
        )
    )
    projection = {
        "schema": SCHEMA,
        "contractVersion": contract.get("version"),
        "contractRoot": contract.get("contractRoot"),
        "registryRoot": contract.get("registryRoot"),
        "defaultVisibilities": list(
            help_policy.get("defaultVisibilities", ["start-here", "public"])
        ),
        "sections": sections,
        "commands": commands,
    }
    projection["projectionRoot"] = _content_root(projection)
    return projection


def render_json(projection: dict[str, Any]) -> str:
    return json.dumps(projection, indent=2, sort_keys=True) + "\n"


def render_human(
    projection: dict[str, Any],
    root_command: click.Command,
    *,
    version: str,
    mode: str = "default",
    section: str | None = None,
    width: int | None = None,
) -> str:
    section_ids = [row["id"] for row in projection["sections"]]
    if section is not None and section not in section_ids:
        raise ProjectionError(
            f"unknown help section {section!r}; choose from: {', '.join(section_ids)}"
        )
    width = max(60, width or shutil.get_terminal_size((100, 24)).columns)
    visible = set(projection.get("defaultVisibilities", []))
    lines = [f"kungfu {version}", "", "usage: kungfu [options] <command> [<args>]", ""]
    lines.extend(_render_options(root_command, width))
    lines.append("")

    for section_row in projection["sections"]:
        section_id = section_row["id"]
        if section is not None and section_id != section:
            continue
        rows = [row for row in projection["commands"] if row["section"] == section_id]
        expanded = (
            mode == "full"
            or section is not None
            or any(row["visibility"] in visible for row in rows)
        )
        lines.append(f"{section_row['title']}  [{section_id}]")
        lines.extend(_wrap(section_row.get("summary", ""), width, "  "))
        if expanded:
            lines.extend(_render_commands(rows, width))
        else:
            lines.extend(
                _wrap(
                    f"{len(rows)} command families; expand with "
                    f"'kungfu --help-section {section_id}'.",
                    width,
                    "  ",
                )
            )
        lines.append("")

    lines.append("discovery:")
    lines.append("  kungfu --help-all                 expand every command family")
    lines.append("  kungfu --help-section <section>   expand one stable section")
    lines.append(
        "  kungfu --help-json                emit the offline discovery contract"
    )
    lines.append("")
    lines.append("run 'kungfu <command> --help' for command-specific help.")
    return "\n".join(lines) + "\n"


def _render_options(root_command: click.Command, width: int) -> list[str]:
    rows = []
    for param in root_command.params:
        if not isinstance(param, click.Option) or param.hidden:
            continue
        flags = ", ".join(param.opts + param.secondary_opts)
        metavar = param.make_metavar() if not param.is_flag else None
        if metavar:
            flags = f"{flags} {metavar}"
        rows.append((flags, " ".join((param.help or "").split())))
    if not rows:
        return []
    label_width = min(max(len(flags) for flags, _ in rows), max(20, width // 3))
    lines = ["options:"]
    for flags, summary in rows:
        if len(flags) > label_width:
            lines.append(f"  {flags}")
            lines.extend(_wrap(summary, width, "    "))
            continue
        prefix = f"  {flags:<{label_width}}  "
        wrapped = textwrap.wrap(
            summary,
            width=max(20, width - len(prefix)),
            break_long_words=False,
            break_on_hyphens=False,
        ) or [""]
        lines.append(prefix + wrapped[0])
        lines.extend(" " * len(prefix) + part for part in wrapped[1:])
    return lines


def _render_commands(rows: list[dict[str, Any]], width: int) -> list[str]:
    if not rows:
        return ["  (no command families currently available)"]
    label_width = min(max(len(row["name"]) for row in rows), max(12, width // 4))
    lines = []
    for row in rows:
        availability = row.get("availability") or {}
        state = availability.get("state", "available")
        reason = availability.get("reason")
        summary = row.get("summary", "")
        if state != "available":
            summary = f"[{state}: {reason}] {summary}"
        prefix = f"  {row['name']:<{label_width}}  "
        wrapped = textwrap.wrap(
            summary,
            width=max(20, width - len(prefix)),
            break_long_words=False,
            break_on_hyphens=False,
        ) or [""]
        lines.append(prefix + wrapped[0])
        lines.extend(" " * len(prefix) + part for part in wrapped[1:])
    return lines


def _wrap(text: str, width: int, prefix: str) -> list[str]:
    return [
        prefix + line
        for line in textwrap.wrap(
            " ".join(text.split()),
            width=max(20, width - len(prefix)),
            break_long_words=False,
            break_on_hyphens=False,
        )
    ]


def _content_root(value: Any) -> str:
    payload = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"
