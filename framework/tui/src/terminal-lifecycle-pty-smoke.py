# SPDX-License-Identifier: Apache-2.0

"""Run one command in a real POSIX PTY and forward its byte stream."""

from __future__ import annotations

import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: terminal-lifecycle-pty-smoke.py COMMAND [ARG ...]")
    pid, descriptor = os.forkpty()
    if pid == 0:
        os.execv(sys.argv[1], sys.argv[1:])

    while True:
        try:
            chunk = os.read(descriptor, 65536)
        except OSError:
            break
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
