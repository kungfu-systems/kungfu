#  SPDX-License-Identifier: Apache-2.0

import os
import sys

from os.path import abspath, dirname

base_dir = dirname(abspath(dirname(__file__)))
python_dir = os.path.join(base_dir, "src", "python")
kungfu_dir = os.path.join(base_dir, "dist", "kungfu")
build_info_file = os.path.join(kungfu_dir, "kungfubuildinfo.json")

sys.path.append(python_dir)
sys.path.append(kungfu_dir)
os.environ["PATH"] += os.pathsep + kungfu_dir
os.environ["KF_LOG_LEVEL"] = "trace"


__frozen__ = os.path.exists(kungfu_dir) and os.path.exists(build_info_file)
