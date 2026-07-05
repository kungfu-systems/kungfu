#  SPDX-License-Identifier: Apache-2.0

from kungfu.cli import commands, variants

__ = [commands, variants, __builtins__]


def available():
    return reversed(__ and __.pop() and __) or [commands]


def select(modules, **kwargs):
    kwargs.pop("auto_envvar_prefix", None)
    next(m for m in modules if m.main(auto_envvar_prefix="KF", **kwargs))
