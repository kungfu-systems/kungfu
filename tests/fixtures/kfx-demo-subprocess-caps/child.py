#  SPDX-License-Identifier: Apache-2.0
#
# The sandboxed Python guest for the subprocess capability transport gate. It
# reaches only its declared capabilities, forwarded to the Node host over stdio;
# its ok/FAIL report goes to stderr (stdout is the protocol channel) and its exit
# code is the gate result.

import importlib.util
import os
import sys
import threading

# Load the guest by path so the gate is self-contained: guest.py is stdlib-only,
# and importing it through the kungfu package would pull in the native binding
# this transport does not need. Real callers use `from kungfu.capability import
# connect` (see kungfu/capability/__init__.py).
_guest_path = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    *[".."] * 3,
    "framework/core/src/python/kungfu/capability/guest.py",
)
_spec = importlib.util.spec_from_file_location("_kungfu_capability_guest", _guest_path)
_guest = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_guest)
connect = _guest.connect

fails = []


def ck(name, ok):
    sys.stderr.write(f"  {'ok' if ok else 'FAIL'}  {name}\n")
    if not ok:
        fails.append(name)


caps = connect(["rewind", "ledger"])  # stdin/stdout is the channel

# a declared capability call round-trips to the host and back
ck("declared call forwards + returns", caps["rewind"].runs() == ["run-A", "run-B"])

# an undeclared capability is absent — the guest is built from the declared set
ck("undeclared capability absent", "work" not in caps)

# a callback argument bridges back as host->guest events
received = []
done = threading.Event()


def on_event(value):
    received.append(value)
    if len(received) == 2:
        done.set()


caps["ledger"].subscribe(on_event)
done.wait(2.0)
ck("subscription bridges host->guest", received == [7, 9])

sys.stderr.write(
    "subprocess caps check " + (f"failed {fails}" if fails else "passed") + "\n"
)
sys.exit(1 if fails else 0)
