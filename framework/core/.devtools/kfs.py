#  SPDX-License-Identifier: Apache-2.0

from env import __frozen__, kungfu_dir
from kungfu import __tool__ as origin
from os import environ
from pathlib import Path

environ["KFS_PATH"] = Path("../../developer/sdk/dist/sdk/kfs.js").resolve().as_posix()
environ["KUNGFU_PATH"] = kungfu_dir.replace("\\", "/")

if __frozen__:
    origin.sdk()
