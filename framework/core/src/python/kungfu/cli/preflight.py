# SPDX-License-Identifier: Apache-2.0

"""Command-scoped rendering for the unified read-only diagnostic contract."""

from __future__ import annotations

from functools import wraps

import click

from kungfu import diagnostics


def _problem_text(report) -> str:
    return "\n\n".join(
        diagnostics.actionable_text(item) for item in report.get("problems", [])
    )


def run_command_preflight(ctx, profile_id: str, *, render_warning: bool = True) -> dict:
    """Run one fresh profile and render only non-ready outcomes."""

    report = diagnostics.collect_preflight(
        ctx.home,
        ctx.runtime_dir,
        ctx.config_home,
        profile_id,
    )
    diagnostics.validate_preflight(report)
    if report["decision"] == "allow":
        return report
    detail = _problem_text(report)
    if report["decision"] == "warn":
        if render_warning:
            click.echo(
                f"Warning: {profile_id} preflight is {report['status']}.\n{detail}",
                err=True,
            )
        return report
    error = click.ClickException(
        f"{profile_id} preflight blocked this command.\n\n{detail}"
    )
    error.exit_code = report["exitCode"]
    raise error


def command_preflight(profile_id: str):
    """Decorate a command function after its Kungfu context adapter."""

    def decorate(function):
        @wraps(function)
        def wrapped(ctx, *args, **kwargs):
            run_command_preflight(
                ctx,
                profile_id,
                render_warning=not bool(kwargs.get("as_json", False)),
            )
            return function(ctx, *args, **kwargs)

        return wrapped

    return decorate
