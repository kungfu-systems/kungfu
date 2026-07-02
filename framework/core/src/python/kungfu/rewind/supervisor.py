#  SPDX-License-Identifier: Apache-2.0
#
# The `kungfu trace` supervisor — capture layer L0.
#
# One traced run = one supervisor = one journal writer. The supervisor assigns
# run_id, injects the capture environment into the child process tree, brackets
# the run with RunBegin/RunEnd frames, and emits the trace bundle's format
# pieces (schema blob + manifest) so the run decodes without this runtime.
#
# Ingestion layers (design decision D):
#   L0 this file            process supervision, run identity, run bracketing
#   L1 model-wire proxy     model request/response at the wire (next change)
#   L2 in-process hooks     tool/framework semantics fed over the local
#                           ingest endpoint announced in the environment
#   L3 adapters             optional, never the moat evidence path

import os
import signal
import subprocess
import sys
import uuid

import kungfu

from kungfu.rewind import (
    MSG_RUN_BEGIN,
    MSG_RUN_END,
    SCHEMA_VERSION,
)
from kungfu.rewind import bundle, events
from kungfu.rewind.fb.RunStatus import RunStatus

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

ENV_RUN_ID = "KUNGFU_REWIND_RUN_ID"
PUBLIC_DEST = 0


class Supervisor:
    def __init__(self, runtime_dir, command, run_id=None):
        self.runtime_dir = runtime_dir
        self.command = list(command)
        self.run_id = run_id or uuid.uuid4().hex
        self.locator = yjj.locator(runtime_dir)
        self.location = yjj.location(
            lf.enums.mode.LIVE,
            lf.enums.category.SYSTEM,
            "rewind",
            self.run_id,
            self.locator,
        )
        # standalone single-writer journal, same shape as the C++ slices:
        # no master, no-op publisher, private bus. Keep every piece alive on
        # self — the writer borrows them without owning their lifetime.
        self.publisher = yjj.noop_publisher()
        self.bus = yjj.bus(False)
        self.writer = yjj.writer(
            self.location, PUBLIC_DEST, True, self.publisher, False, self.bus, 0
        )

    def write_event(self, msg_type, data):
        # the binding takes the payload as a byte sequence (list[int])
        self.writer.write_bytes(0, msg_type, list(data), len(data))

    def child_env(self):
        env = dict(os.environ)
        env[ENV_RUN_ID] = self.run_id
        return env

    def bundle_dir(self):
        return os.path.join(self.runtime_dir, "rewind", self.run_id, "bundle")

    def run(self):
        self.write_event(
            MSG_RUN_BEGIN,
            events.run_begin(
                run_id=self.run_id,
                command=subprocess.list2cmdline(self.command),
                runtime=sys.platform,
                supervisor_version=kungfu.__version__,
                schema_version=SCHEMA_VERSION,
            ),
        )

        status, exit_code = RunStatus.Failed, 1
        child = subprocess.Popen(self.command, env=self.child_env())
        try:
            exit_code = child.wait()
            status = RunStatus.Succeeded if exit_code == 0 else RunStatus.Failed
            if exit_code < 0:
                status = RunStatus.Interrupted
        except KeyboardInterrupt:
            child.send_signal(signal.SIGINT)
            exit_code = child.wait()
            status = RunStatus.Interrupted
        finally:
            self.write_event(
                MSG_RUN_END,
                events.run_end(self.run_id, status, exit_code),
            )
            manifest_path = bundle.emit(
                self.bundle_dir(),
                self.runtime_dir,
                {
                    "mode": "LIVE",
                    "category": "SYSTEM",
                    "group": "rewind",
                    "name": self.run_id,
                    "dest": PUBLIC_DEST,
                },
            )
        return exit_code, status, manifest_path
