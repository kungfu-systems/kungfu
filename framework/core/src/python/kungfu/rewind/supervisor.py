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
#   L1 model-wire proxy     model request/response at the wire (proxy.py)
#   L2 in-process hooks     tool/framework semantics fed over the local
#                           ingest endpoint announced in the environment
#   L3 adapters             optional, never the moat evidence path
#
# Threading: the journal keeps its single-writer discipline by construction —
# capture layers never touch the writer, they enqueue serialized events and one
# writer thread drains the queue in arrival order.

import os
import queue
import signal
import subprocess
import sys
import threading
import uuid

import kungfu

from kungfu.rewind import (
    MSG_RUN_BEGIN,
    MSG_RUN_END,
    SCHEMA_VERSION,
)
from kungfu.rewind import adapters, bundle, events
from kungfu.rewind.fb.RunStatus import RunStatus
from kungfu.rewind.ingest import IngestServer
from kungfu.rewind.schema_registry import register_user_schema
from kungfu.rewind.proxy import (
    DEFAULT_ANTHROPIC_UPSTREAM,
    DEFAULT_OPENAI_UPSTREAM,
    ModelWireProxy,
)

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

ENV_RUN_ID = "KUNGFU_REWIND_RUN_ID"
ENV_INGEST = "KUNGFU_REWIND_INGEST"
PUBLIC_DEST = 0

_HOOK_DIR = os.path.join(os.path.dirname(__file__), "hook")

# base-url variables the proxy takes over in the child environment; the
# parent's own values (if any) become the forward targets
_OPENAI_ENV = ("OPENAI_BASE_URL", "OPENAI_API_BASE")
_ANTHROPIC_ENV = ("ANTHROPIC_BASE_URL",)

_STOP = object()


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
        self.events = queue.SimpleQueue()
        self.proxy = ModelWireProxy(
            self.run_id, self.enqueue, upstreams=self._upstreams()
        )
        # kfx open-layer schemas registered during the run: msg_type -> (name,
        # bfbs, tier). Collected off the ingest threads, bound into the bundle
        # manifest at finalize. Dict assignment is atomic under CPython; a run's
        # kfx set is tiny, so no extra lock.
        self.user_schemas = {}
        self.ingest = IngestServer(
            self.run_id, self.enqueue, schema_sink=self._register_kfx_schema
        )

    def _register_kfx_schema(self, msg_type, name, bfbs, tier):
        self.user_schemas[int(msg_type)] = (name, bfbs, tier)

    @staticmethod
    def _upstreams():
        openai = next((os.environ[k] for k in _OPENAI_ENV if os.environ.get(k)), None)
        anthropic = next(
            (os.environ[k] for k in _ANTHROPIC_ENV if os.environ.get(k)), None
        )
        return {
            "openai": openai or DEFAULT_OPENAI_UPSTREAM,
            "anthropic": anthropic or DEFAULT_ANTHROPIC_UPSTREAM,
        }

    def enqueue(self, msg_type, data):
        self.events.put((msg_type, data))

    def _drain_events(self):
        while True:
            item = self.events.get()
            if item is _STOP:
                return
            msg_type, data = item
            # the binding takes the payload as a byte sequence (list[int])
            self.writer.write_bytes(0, msg_type, list(data), len(data))

    def child_env(self):
        env = dict(os.environ)
        env[ENV_RUN_ID] = self.run_id
        for key in _OPENAI_ENV + _ANTHROPIC_ENV:
            env[key] = self.proxy.base_url
        # L2: announce the ingest endpoint and let each runtime's preload
        # machinery pull in its hook — python via site (sitecustomize on
        # PYTHONPATH), node via NODE_OPTIONS --require. Both preserve
        # whatever the environment already had.
        env[ENV_INGEST] = self.ingest.endpoint
        existing = env.get("PYTHONPATH")
        # kfx adapter plugins: discover adapter forms in the extension roots and
        # announce their entry files to each runtime's child hook. Python
        # adapters also put their package dirs on PYTHONPATH so an adapter can
        # import its own siblings; node adapters are required by absolute path.
        py_entries, py_dirs, py_refused = adapters.discover_adapters(
            self.runtime_dir, "python"
        )
        node_entries, _, node_refused = adapters.discover_adapters(
            self.runtime_dir, "node"
        )
        for refused in py_refused + node_refused:
            # an adapter injects into the traced program in-process; an untrusted
            # one cannot be sandboxed, so it is refused rather than contained.
            sys.stderr.write(
                f"[kungfu trace] refusing untrusted adapter "
                f"{refused['key']!r} at {refused['package']}: only a "
                f"source-verified first-party adapter may inject.\n"
            )
        if py_entries:
            env[adapters.ENV_PLUGIN_ADAPTERS] = os.pathsep.join(py_entries)
        if node_entries:
            env[adapters.ENV_NODE_ADAPTERS] = os.pathsep.join(node_entries)
        pythonpath_parts = [_HOOK_DIR, *py_dirs]
        if existing:
            pythonpath_parts.append(existing)
        env["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)
        node_require = f"--require {os.path.join(_HOOK_DIR, 'rewind_hook.js')}"
        node_existing = env.get("NODE_OPTIONS")
        env["NODE_OPTIONS"] = (
            f"{node_existing} {node_require}" if node_existing else node_require
        )
        return env

    def bundle_dir(self):
        return os.path.join(self.runtime_dir, "rewind", self.run_id, "bundle")

    def run(self):
        writer_thread = threading.Thread(target=self._drain_events)
        writer_thread.start()
        self.proxy.start()
        self.ingest.start()
        self.enqueue(
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
            # child gone -> no new wire or hook events; stop the capture
            # layers before the RunEnd bracket so every event lands inside
            # the run
            self.proxy.stop()
            self.ingest.stop()
            self.enqueue(
                MSG_RUN_END,
                events.run_end(self.run_id, status, exit_code),
            )
            self.events.put(_STOP)
            writer_thread.join()
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
            # bind each kfx open-layer schema into the run manifest, on top of
            # the first-party Rewind bindings. A bad registration must not sink
            # the run's own bundle.
            for msg_type, (name, blob, tier) in self.user_schemas.items():
                try:
                    register_user_schema(
                        self.bundle_dir(), blob, msg_type, name, tier=tier
                    )
                except ValueError:
                    continue
        return exit_code, status, manifest_path
