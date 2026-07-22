#  SPDX-License-Identifier: Apache-2.0

import click
import kungfu
import platform
import os
import typing
from click.globals import get_current_context
from functools import update_wrapper
from kungfu.config import default_config_home, default_runtime_home

# click 8.1.7+ 移除了私有 TypeVar F；CLI 仅用于装饰器类型标注，改本地定义不依赖 click 内部符号。
CLI = typing.TypeVar("CLI", bound=typing.Callable[..., typing.Any])


def initialize_runtime_context(ctx) -> None:
    """Materialize the legacy runtime context after an intent has selected it."""
    os.environ["KF_CONFIG_HOME"] = ctx.config_home
    os.environ["KF_HOME"] = ctx.home
    os.environ["KF_LOG_LEVEL"] = ctx.log_level

    def ensure_dir(path):
        os.makedirs(path, exist_ok=True)
        return path

    ctx.runtime_dir = ensure_dir(ctx.runtime_dir)
    os.environ["KF_RUNTIME_DIR"] = ctx.runtime_dir
    ctx.dataset_dir = ensure_dir(ctx.dataset_dir)
    ctx.backtest_dir = ensure_dir(ctx.backtest_dir)
    ctx.inbox_dir = ensure_dir(ctx.inbox_dir)

    lf = kungfu.__binding__.yijinjing
    yjj = kungfu.__binding__.runtime
    ctx.runtime_locator = yjj.locator(ctx.runtime_dir)
    ctx.backtest_locator = yjj.locator(lf.enums.mode.BACKTEST)
    ctx.config_location = yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.location_role.SYSTEM,
        "etc",
        "kungfu",
        ctx.runtime_locator,
    )
    ctx.console_location = yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.location_role.SYSTEM,
        "service",
        "console",
        ctx.runtime_locator,
    )
    ctx.index_location = yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.location_role.SYSTEM,
        "journal",
        "index",
        ctx.runtime_locator,
    )


class PrioritizedCommandGroup(click.Group):
    DEFAULT_PRIORITY = 100

    def __init__(self, *args, **kwargs):
        self.help_priorities = {}
        self.list_commands = self.list_commands_for_help  # type: ignore[method-assign]
        super(PrioritizedCommandGroup, self).__init__(*args, **kwargs)

    def get_help(self, ctx):
        return super(PrioritizedCommandGroup, self).get_help(ctx)

    def resolve_command(self, ctx, args):
        resolved = super(PrioritizedCommandGroup, self).resolve_command(ctx, args)
        command_name, _command, _remaining = resolved
        root_path = ctx.find_root().command_path
        relative_path = ctx.command_path[len(root_path) :]
        path = f"kungfu{relative_path} {command_name}"

        # Compatibility paths reuse the exact same Click command objects as
        # their canonical replacements.  The registry is the single source of
        # migration metadata; warnings stay on stderr so JSON stdout and output
        # roots remain byte-for-byte owned by the shared handler.
        from kungfu.cli import surface_contract

        alias = next(
            (
                row
                for row in surface_contract.registry().get("aliases", [])
                if row.get("path") == path
            ),
            None,
        )
        if alias is not None:
            click.echo(
                f"warning: `{path}` is a compatibility alias; "
                f"use `{alias['replacement']}`",
                err=True,
            )
        return resolved

    def list_commands_for_help(self, ctx):
        """reorder the list of commands when listing the help"""
        commands = super(PrioritizedCommandGroup, self).list_commands(ctx)
        prioritized = filter(
            lambda command: self.help_priorities[command] > 0, commands
        )
        return (
            c[1]
            for c in sorted(
                (self.help_priorities.get(command, self.DEFAULT_PRIORITY), command)
                for command in prioritized
            )
        )

    def group(self, *args, **kwargs):
        """Behaves the same as `click.Group.command()` except capture
        a priority for listing command names in help.
        """
        help_priority = kwargs.pop("help_priority", self.DEFAULT_PRIORITY)
        help_priorities = self.help_priorities

        def decorator(f):
            group = super(PrioritizedCommandGroup, self).group(*args, **kwargs)(f)
            help_priorities[group.name] = help_priority
            return group

        return decorator

    def command(self, *args, **kwargs):
        """Behaves the same as `click.Group.command()` except capture
        a priority for listing command names in help.
        """
        help_priority = kwargs.pop("help_priority", self.DEFAULT_PRIORITY)
        help_priorities = self.help_priorities

        def decorator(f):
            cmd = super(PrioritizedCommandGroup, self).command(*args, **kwargs)(f)
            help_priorities[cmd.name] = help_priority
            return cmd

        return decorator

    @staticmethod
    def pass_context(*keys):
        def copy_from_parent(f: CLI) -> CLI:
            def new_func(*args, **kwargs):
                ctx = get_current_context()
                ENV_dict = {
                    ("KF_" + key[4:]).upper(): value
                    for key, value in kwargs.items()
                    if key.upper().startswith("ENV_")
                }
                for k, v in ENV_dict.items():
                    if v:
                        os.environ[k] = k

                ARG_dict = {
                    ("KF_" + key[4:]).upper(): value
                    for key, value in kwargs.items()
                    if key.upper().startswith("ARG_")
                }
                for k, v in ARG_dict.items():
                    if v:
                        os.environ[k] = v

                for key in [
                    "name",
                    "config_home",
                    "home",
                    "extension_path",
                    "log_level",
                    "runtime_dir",
                    "dataset_dir",
                    "backtest_dir",
                    "inbox_dir",
                    "runtime_locator",
                    "backtest_locator",
                    "config_location",
                    "console_location",
                    "index_location",
                    "stage",
                ] + list(keys):
                    ancestor = ctx.parent
                    while ancestor is not None and key not in ancestor.__dict__:
                        ancestor = ancestor.parent
                    if ancestor is None:
                        raise click.ClickException(
                            f"Kungfu command context field is unavailable: {key}"
                        )
                    ctx.__dict__[key] = ancestor.__dict__[key]
                return f(ctx, *args, **kwargs)

            return typing.cast(CLI, update_wrapper(new_func, f))

        return copy_from_parent


class ProgressiveHelpGroup(PrioritizedCommandGroup):
    """Render root discovery from the governed surface projection."""

    def get_help(self, ctx):
        from kungfu.cli import help_projection

        try:
            projection = help_projection.build(self)
            return help_projection.render_human(
                projection,
                self,
                version=kungfu.__version__,
                width=ctx.terminal_width,
            ).rstrip("\n")
        except help_projection.ProjectionError as error:
            raise click.UsageError(str(error), ctx) from error


def _progressive_help(ctx, param, value):
    if not value or ctx.resilient_parsing:
        return
    from kungfu.cli import help_projection

    try:
        projection = help_projection.build(ctx.command)
        if param.name == "help_json":
            click.echo(help_projection.render_json(projection), nl=False)
        else:
            click.echo(
                help_projection.render_human(
                    projection,
                    ctx.command,
                    version=kungfu.__version__,
                    mode="full" if param.name == "help_all" else "section",
                    section=value if param.name == "help_section" else None,
                    width=ctx.terminal_width,
                ),
                nl=False,
            )
    except help_projection.ProjectionError as error:
        raise click.UsageError(str(error), ctx) from error
    ctx.exit()


@click.group("kungfu", invoke_without_command=True, cls=ProgressiveHelpGroup)
@click.option(
    "-H",
    "--home",
    type=str,
    help="kungfu runtime home folder, defaults to the config contract runtime home",
)
@click.option(
    "-X",
    "--extension-path",
    type=str,
    help="where to find extensions",
)
@click.option(
    "-l",
    "--log_level",
    type=click.Choice(["trace", "debug", "info", "warning", "error", "critical"]),
    default="warning",
    help="logging level",
)
@click.option(
    "-n",
    "--name",
    type=str,
    help="name for the process, defaults to command if not set",
)
@click.option("-s", "--stage", type=str, help="stage")
@click.option(
    "-ENV-verify-location",
    is_flag=True,
    required=False,
    help="verify location_uid and change seed regenerate if clash ",
)
@click.option(
    "--help-all",
    is_flag=True,
    is_eager=True,
    expose_value=False,
    callback=_progressive_help,
    help="expand every governed command family and exit",
)
@click.option(
    "--help-section",
    metavar="SECTION",
    is_eager=True,
    expose_value=False,
    callback=_progressive_help,
    help="expand one governed help section and exit",
)
@click.option(
    "--help-json",
    is_flag=True,
    is_eager=True,
    expose_value=False,
    callback=_progressive_help,
    help="emit the offline discovery contract as JSON and exit",
)
@click.help_option("-h", "--help")
@click.version_option(kungfu.__version__, "--version", message=kungfu.__version__)
@click.pass_context
def kfc(ctx, home, extension_path, log_level, name, stage, env_verify_location):
    if env_verify_location:
        os.environ["KF_VERIFY_LOCATION"] = "KF_VERIFY_LOCATION"

    runtime_dir_override = os.environ.get("KF_RUNTIME_DIR") if not home else None
    home = default_runtime_home() if not home else home
    config_home = default_config_home()
    ctx.extension_path = extension_path
    ctx.config_home = config_home
    ctx.home = home
    ctx.log_level = log_level
    ctx.runtime_dir = os.path.abspath(
        os.path.expanduser(runtime_dir_override or os.path.join(ctx.home, "runtime"))
    )
    ctx.dataset_dir = os.path.join(ctx.home, "dataset")
    ctx.backtest_dir = os.path.join(ctx.home, "backtest")
    ctx.inbox_dir = os.path.join(ctx.home, "inbox")
    ctx.runtime_locator = None
    ctx.backtest_locator = None
    ctx.config_location = None
    ctx.console_location = None
    ctx.index_location = None
    ctx.name = name or ctx.invoked_subcommand
    ctx.stage = stage or "prod"

    # Bare discovery must remain offline and side-effect free. The assembled
    # trunk renders the same projection without Python; the source entry point
    # must preserve that contract when it is invoked directly.
    if ctx.invoked_subcommand is None:
        click.echo(kfc.get_help(ctx))
        return

    # Workspace discovery and selection are control-plane operations. They must
    # be able to inspect an uninitialized candidate without the root callback
    # creating directories or rewriting the caller's resolution evidence first.
    if ctx.invoked_subcommand in {
        "workspace",
        "managed-run",
        "storage",
        "health",
        "recover",
        "action",
        "assignment",
        "agent",
        "xinfa",
        "pursuit",
        "warrant",
        "episode",
        "exit",
        "cut",
        "work",
    }:
        return
    initialize_runtime_context(ctx)


def main(**kwargs):
    from . import __registry__ as commands

    return kfc(obj=commands, **kwargs) is not False
