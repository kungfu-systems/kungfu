#  SPDX-License-Identifier: Apache-2.0

import click
import os
import platform
import re
import sys
import tokenize

from kungfu.cli import bridging


@click.command(
    context_settings=dict(
        allow_extra_args=True,
        allow_interspersed_args=True,
        ignore_unknown_options=True,
    )
)
@click.option(
    "-b",
    "bytes_warn",
    count=True,
    help="issue warnings about str(bytes_instance), str(bytearray_instance) "
    "and comparing bytes/bytearray with str. (-bb: issue errors)",
)
@click.option(
    "-B",
    "no_pyc",
    is_flag=True,
    help="don't write .pyc files on import; also PYTHONDONTWRITEBYTECODE=x",
)
@click.option(
    "-c",
    "code",
    type=str,
    help="program passed in as string (terminates option list)",
)
@click.option(
    "-d",
    "debug_parser",
    is_flag=True,
    help="debug output from parser; also PYTHONDEBUG=x",
)
@click.option(
    "-E",
    "ignore_python_environment",
    is_flag=True,
    help="ignore PYTHON* environment variables (such as PYTHONPATH)",
)
@click.option(
    "-I",
    "isolated",
    is_flag=True,
    help="isolate Python from the user's environment (implies -E and -s)",
)
@click.option(
    "-m",
    "module",
    type=str,
    help="run library module as a script (terminates option list)",
)
@click.option(
    "-O",
    "optimize",
    count=True,
    help="remove assert and __debug__-dependent statements; "
    "add .opt-1 before .pyc extension; "
    "also PYTHONOPTIMIZE=x",
)
@click.option(
    "-s",
    "ignore_user_site",
    is_flag=True,
    help="don't add user site directory to sys.path; also PYTHONNOUSERSITE",
)
@click.option(
    "-S",
    "ignore_import_site",
    is_flag=True,
    help="don't imply 'import site' on initialization",
)
@click.option(
    "-u",
    "unbuffered",
    is_flag=True,
    help="force the stdout and stderr streams to be unbuffered; "
    "this option has no effect on stdin; also PYTHONUNBUFFERED=x",
)
@click.option(
    "-v",
    "verbose",
    count=True,
    help="verbose (trace import statements); also PYTHONVERBOSE=x; "
    "can be supplied multiple times to increase verbosity",
)
@click.option(
    "-W",
    "warning",
    type=str,
    multiple=True,
    help="warning control; arg is action:message:category:module:lineno; "
    "also PYTHONWARNINGS=arg",
)
@click.option(
    "-x",
    "skip_first_line",
    is_flag=True,
    help="skip first line of source, allowing use of non-Unix forms of #!cmd",
)
@click.option(
    "-X",
    "spec_option",
    type=str,
    multiple=True,
    help="set implementation-specific option",
)
@click.help_option("-h", "--help")
@click.version_option(
    platform.python_version(),
    "-V",
    "--version",
    message=f"Python {platform.python_version()}",
)
@click.argument("argv", type=str, nargs=-1)
def main(argv, **options):
    __name__ = "__main__"  # noqa: F841  (待审:疑似应设 exec 脚本命名空间)

    if options["no_pyc"]:
        os.environ["PYTHONDONTWRITEBYTECODE"] = "x"

    if options["debug_parser"]:
        os.environ["PYTHONDEBUG"] = "x"

    if options["ignore_python_environment"] or options["isolated"]:
        os.environ.pop("PYTHONPATH", None)

    if options["ignore_user_site"] or options["isolated"]:
        os.environ["PYTHONNOUSERSITE"] = "x"

    if options["code"]:
        exec(options["code"])
        return

    if options["module"]:
        module_name = options["module"]
        matches = [i for i, arg in enumerate(sys.argv) if re.search("^-.*m", arg)]
        idx = matches[0] + 2
        sys.argv = [module_name, *sys.argv[idx:]]
        bridging.run_module_main(module_name)
        return

    if argv:
        sys.argv = [sys.executable, *argv[1:]]
        __file__ = str(os.path.abspath(argv[0]))
        dist_root = str(os.path.dirname(sys.executable))
        if __file__.startswith(dist_root):
            module_name = (
                __file__.replace(dist_root, "")
                .replace(".py", "")
                .replace(os.sep, ".")[1:]
            )
            bridging.run_module(module_name)
            return
        with tokenize.open(__file__) as source:
            code = source.read()
        exec(code)
        return

    pass
