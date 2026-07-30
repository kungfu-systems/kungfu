# SPDX-License-Identifier: Apache-2.0

import os
import subprocess
import sys
import time


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python-reader-call.py READER [ARG...]", file=sys.stderr)
        return 2
    result = subprocess.run([sys.executable, *sys.argv[1:]], check=False)
    time.sleep(int(os.environ.get("KUNGFU_QUALIFICATION_HOLD_MS", "0")) / 1000)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
