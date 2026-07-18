# SPDX-License-Identifier: Apache-2.0

"""Thin Click projections over the authoritative Action Primitive Profile."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from kungfu.agent import work_profile


PUBLIC_ROLES = ("atlas", "pursuit", "warrant", "episode")


def _echo(payload):
    click.echo(json.dumps(payload, indent=2, sort_keys=True))


def role_capabilities(role: str) -> dict:
    if role not in PUBLIC_ROLES:
        raise ValueError(f"unsupported public Action Primitive role: {role}")
    profile = work_profile.capabilities()
    return {
        "schema": "kungfu.action-primitive-role-capabilities/v1",
        "role": role,
        "profile": profile["profile"],
        "actionSchema": profile["actionSchema"],
        "receiptSchema": profile["receiptSchema"],
        "transitions": profile["transitions"][role],
        "denials": profile["denials"],
        "authority": profile["authority"],
        "nonClaims": profile["nonClaims"],
    }


def role_inspection(runtime_dir: str, role: str, ref_name: str) -> dict:
    return {
        "schema": "kungfu.action-primitive-role-inspection/v1",
        "role": role,
        "profileInspection": work_profile.inspect(runtime_dir, ref_name),
    }


def _read_request(reference: str) -> dict:
    try:
        text = (
            sys.stdin.read() if reference == "-" else Path(reference).read_text("utf-8")
        )
        value = json.loads(text)
    except (OSError, json.JSONDecodeError) as error:
        raise click.ClickException(f"cannot read Action request: {error}") from error
    if not isinstance(value, dict):
        raise click.ClickException("Action request must be a JSON object")
    return value


def apply_role_action(
    runtime_dir: str, role: str, request: dict, execute: bool
) -> dict:
    subject = request.get("subject")
    actual = subject.get("role") if isinstance(subject, dict) else None
    if actual != role:
        raise click.ClickException(
            f"kungfu {role} accepts only subject.role={role!r}; received {actual!r}"
        )
    return work_profile.apply_action(runtime_dir, request, execute=execute)


def register_role_commands(group, role: str) -> None:
    if role not in PUBLIC_ROLES:
        raise ValueError(f"unsupported public Action Primitive role: {role}")

    @group.command(name="capabilities", help="show role transitions and denial codes")
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    def capabilities(as_json):
        del as_json
        _echo(role_capabilities(role))

    @group.command(name="inspect", help="inspect this role at one named Fact ref")
    @click.option("--ref", "ref_name", default="profile/main", show_default=True)
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @click.pass_context
    def inspect(ctx, ref_name, as_json):
        del as_json
        _echo(role_inspection(ctx.parent.runtime_dir, role, ref_name))

    @group.command(name="action", help="plan or execute one versioned role transition")
    @click.option(
        "--request",
        "request_path",
        required=True,
        type=click.Path(dir_okay=False),
        help="Action request JSON file, or - for stdin",
    )
    @click.option("--execute", is_flag=True, help="cross the native Fact ref CAS")
    @click.option("--json", "as_json", is_flag=True, help="machine-readable output")
    @click.pass_context
    def action(ctx, request_path, execute, as_json):
        del as_json
        request = _read_request(request_path)
        _echo(apply_role_action(ctx.parent.runtime_dir, role, request, execute))
