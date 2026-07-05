#  SPDX-License-Identifier: Apache-2.0

import click
import sys

from kungfu.cli.commands import (
    CLI,
    PrioritizedCommandGroup,
    get_current_context,
    kfc,
    update_wrapper,
    typing,
)
from kungfu.cli import variants


def engage_command_context():
    def build_bridge(f: CLI) -> CLI:
        def new_func(*args, **kwargs):
            from kungfu.cli.bridging import __registry__

            ctx = get_current_context()
            ctx.bridging = __registry__
            variants.enable("python")
            sys.argv = [sys.argv[0], *ctx.args]
            return kfc.pass_context()(f)(*args, **kwargs)

        return update_wrapper(typing.cast(CLI, new_func), f)

    return build_bridge


@kfc.group(cls=PrioritizedCommandGroup, help_priority=3)
@click.help_option("-h", "--help")
@kfc.pass_context()
def engage(ctx):
    callable(ctx)
    pass


@engage.command(
    help="Format python files with [Black](https://github.com/psf/black)",
    context_settings=dict(
        ignore_unknown_options=True,
        allow_extra_args=True,
    ),
)
@engage_command_context()
def black(ctx):
    ctx.bridging.black()


@engage.command(
    help="Manage python packages with [pdm](https://pdm.fming.dev)",
    context_settings=dict(
        ignore_unknown_options=True,
        allow_extra_args=True,
    ),
)
@engage_command_context()
def pdm(ctx):
    ctx.bridging.pdm()


@engage.command(
    help="Build with [SCons](https://scons.org)",
    context_settings=dict(
        ignore_unknown_options=True,
        allow_extra_args=True,
    ),
)
@engage_command_context()
def scons(ctx):
    ctx.bridging.scons()


def engaged_nuitka_context():
    def nuitka_context(f: CLI) -> CLI:
        def new_func(*args, **kwargs):
            from kungfu.cli.bridging import nuitka

            nuitka.setup()
            build_bridge = engage_command_context()
            return build_bridge(f)(*args, **kwargs)

        return update_wrapper(typing.cast(CLI, new_func), f)

    return nuitka_context


@engage.command(
    help="Compile and bundle python files with [Nuitka](https://nuitka.net)",
    context_settings=dict(
        ignore_unknown_options=True,
        allow_extra_args=True,
    ),
)
@engaged_nuitka_context()
def nuitka(ctx):
    ctx.bridging.nuitka()


@engage.command(
    context_settings=dict(
        ignore_unknown_options=True,
        allow_extra_args=True,
    ),
    help_priority=-1,
)
@engaged_nuitka_context()
def nuitka_data_composer(ctx):
    from nuitka.tools.data_composer import DataComposer

    callable(ctx)
    DataComposer.main()
