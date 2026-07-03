#  SPDX-License-Identifier: Apache-2.0

import kungfu
import os
import sys
import subprocess

from kungfu.console import site, variants
from os.path import abspath, dirname


def disableStaticallyLinkedPython():
    from nuitka import PythonVersions

    PythonVersions.isStaticallyLinkedPython = lambda: False


def useEngagedCommands():
    from nuitka.build import DataComposerInterface, SconsInterface
    from nuitka.utils.Execution import withEnvironmentVarsOverridden

    def runEngagedDataComposer(source_dir):
        mapping = {
            "NUITKA_PACKAGE_HOME": dirname(abspath(sys.modules["nuitka"].__path__[0])),
            "PATH": os.environ["PATH"],
            "PYTHONPATH": os.pathsep.join(sys.path),
        }
        blob_filename = DataComposerInterface.getConstantBlobFilename(source_dir)
        with withEnvironmentVarsOverridden(mapping):
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "kungfu",
                    "engage",
                    "nuitka-data-composer",
                    source_dir,
                    blob_filename,
                ],
                shell=False,
            )
        return blob_filename

    def getEngagedSconsBinaryCall():
        os.environ["PYTHONPATH"] = (
            dirname(dirname(kungfu.__file__))
            + os.pathsep
            + dirname(kungfu.__binding__.__file__)
        )
        return [sys.executable, "-m", "kungfu", "engage", "scons"]

    DataComposerInterface.runDataComposer = runEngagedDataComposer
    SconsInterface._getSconsBinaryCall = getEngagedSconsBinaryCall


def useEngagedEnvironment():
    from nuitka.build import SconsUtils

    def withKungfuLib():
        origin = SconsUtils.createEnvironment

        def createEnvironment(**kwargs):
            env = origin(**kwargs)
            env.Append(LIBPATH=dirname(kungfu.__binding__.__file__))
            return env

        return createEnvironment

    SconsUtils.createEnvironment = withKungfuLib()


def setup():
    site.setup()
    disableStaticallyLinkedPython()
    useEngagedCommands()
    useEngagedEnvironment()
    os.environ.update(
        {
            "PYTHONPATH": os.pathsep.join(sys.path),
        }
    )
    variants.enable("python")


def main():
    # Delegate to Nuitka's own entry point instead of re-implementing its option
    # parsing and plugin loading (those internals drift with every Nuitka
    # release and had gone stale). setup() has already injected the engaged
    # scons / data-composer / binding LIBPATH, and engage_command_context has set
    # sys.argv to the Nuitka arguments, so Nuitka's own main picks all of it up.
    from nuitka.__main__ import main as nuitka_main

    nuitka_main()
