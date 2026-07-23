# SPDX-License-Identifier: Apache-2.0

import signal
import time

from kungfu import peer_lifecycle


stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
if hasattr(signal, "SIGINT"):
    signal.signal(signal.SIGINT, stop)

peer_lifecycle.declare_ready_from_environment({"fixture": "peer-lifecycle-probe"})
while not stopping:
    time.sleep(0.05)
