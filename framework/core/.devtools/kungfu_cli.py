#  SPDX-License-Identifier: Apache-2.0

from env import __frozen__
from kungfu import __main__ as origin
from pathlib import Path
from os import environ


environ["KUNGFU_DIR"] = Path("dist/kungfu").resolve().as_posix()


if __frozen__:
    origin.main()
