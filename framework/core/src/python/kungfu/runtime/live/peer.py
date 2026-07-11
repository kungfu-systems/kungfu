#  SPDX-License-Identifier: Apache-2.0

import kungfu
import psutil
import signal
import kungfu.runtime.io as kfio
import kungfu.runtime as kfr
from typing import Any

from . import os_signal  # type: ignore[attr-defined]  # native submodule

# native pybind11 binding (no stubs); Any so `yjj.peer` is a usable base
yjj: Any = kungfu.__binding__.runtime


class Peer(yjj.peer):
    def __init__(self, ctx):
        yjj.peer.__init__(
            self,
            yjj.location(
                kfr.MODES[ctx.mode],
                kfr.ROLES[ctx.role],
                ctx.namespace,
                ctx.name,
                ctx.runtime_locator,
            ),
            low_latency=ctx.low_latency,
        )
        self.ctx = ctx
        self._process = psutil.Process()

        os_signal.handle_os_signals(self.exit_gracefully)

    def go(self):
        kfio.checkin(self.ctx, self.io_device)
        yjj.peer.go(self)

    def exit_gracefully(self, signum, frame):
        self.stop()
        if signum == signal.SIGTERM:
            self.logger.info("%s terminated", self.ctx.name)
