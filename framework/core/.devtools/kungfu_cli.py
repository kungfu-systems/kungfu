#  SPDX-License-Identifier: Apache-2.0

from env import __frozen__
from kungfu import __main__ as origin
from multiprocessing import freeze_support
from pathlib import Path
from os import environ


environ["KUNGFU_DIR"] = Path("dist/kungfu").resolve().as_posix()


def main():
    if __frozen__:
        freeze_support()
        origin.main()


if __name__ == "__main__":
    main()
