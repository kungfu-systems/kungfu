#  SPDX-License-Identifier: Apache-2.0
#
# The sandboxed guest for the OS-sandbox gate. Launched under the OS default-deny
# sandbox, it proves that the capability relay still works (its only egress) while
# the filesystem and the network are denied. ok/FAIL goes to stderr; stdout is the
# protocol channel; the exit code is the gate result.

import importlib.util
import os
import socket
import sys

# load the guest by path (stdlib-only; avoids the native binding); reads are
# allowed under the sandbox, so importing the source is fine.
_guest_path = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    *[".."] * 3,
    "framework/core/src/python/kungfu/capability/guest.py",
)
_spec = importlib.util.spec_from_file_location("_kungfu_capability_guest", _guest_path)
_guest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guest)

fails = []


def ck(name, ok):
    sys.stderr.write(f"  {'ok' if ok else 'FAIL'}  {name}\n")
    if not ok:
        fails.append(name)


caps = _guest.connect(["rewind"])

# 1. the capability relay is reachable through the sandbox — the only egress
ck("capability relay works inside sandbox", caps["rewind"].runs() == ["run-A", "run-B"])

# 2. a filesystem write is denied by the sandbox (EPERM -> PermissionError)
try:
    with open("/tmp/kfx_sandbox_leak", "w") as f:
        f.write("x")
    ck("filesystem write denied", False)
except PermissionError:
    ck("filesystem write denied", True)

# 3. the network is denied by the sandbox (the connect is refused, not merely
#    unreachable — so this holds offline too)
try:
    socket.create_connection(("1.1.1.1", 80), timeout=3)
    ck("network denied", False)
except PermissionError:
    ck("network denied", True)
except OSError as e:
    ck("network denied", isinstance(e, PermissionError))

sys.stderr.write(
    "sandbox launch check " + (f"failed {fails}" if fails else "passed") + "\n"
)
sys.exit(1 if fails else 0)
