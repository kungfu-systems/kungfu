#  SPDX-License-Identifier: Apache-2.0
#
# Python port of the guest half of framework/api/src/capability/sandbox.ts. A
# sandboxed Python child builds a capability object from its declared set alone
# and forwards each call to the trusted host over a newline-delimited JSON
# channel; the host resolves it against the real capabilities and rejects an
# undeclared one. A callback argument is replaced on the wire by a
# {"__sandboxCallback": id} marker; when the host bridges it back as an event,
# the registered callback fires.

import json
import sys
import threading


class _Channel:
    """Reads host->guest frames on a background thread: results wake the
    invoke() that is waiting on their id; events fire registered callbacks."""

    def __init__(self, read_stream, write_stream):
        self._read = read_stream
        self._write = write_stream
        self._write_lock = threading.Lock()
        self._cond = threading.Condition()
        self._results = {}
        self._seq = 0
        self._callbacks = {}
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _send(self, msg):
        line = json.dumps(msg) + "\n"
        with self._write_lock:
            self._write.write(line)
            self._write.flush()

    def _read_loop(self):
        while True:
            line = self._read.readline()
            if not line:
                break  # EOF: the host closed the channel
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            kind = msg.get("t")
            if kind == "result":
                with self._cond:
                    self._results[msg.get("id")] = msg
                    self._cond.notify_all()
            elif kind == "event":
                callback = self._callbacks.get(msg.get("callback"))
                if callback is not None:
                    callback(*msg.get("args", []))

    def _marshal(self, args):
        out = []
        for arg in args:
            if callable(arg):
                self._seq += 1
                self._callbacks[self._seq] = arg
                out.append({"__sandboxCallback": self._seq})
            else:
                out.append(arg)
        return out

    def invoke(self, cap, method, args):
        self._seq += 1
        ident = self._seq
        self._send(
            {
                "t": "invoke",
                "id": ident,
                "cap": cap,
                "method": method,
                "args": self._marshal(args),
            }
        )
        with self._cond:
            while ident not in self._results:
                self._cond.wait()
            result = self._results.pop(ident)
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "capability call failed")
        return result.get("value")


class _Capability:
    def __init__(self, channel, cap):
        self._channel = channel
        self._cap = cap

    def __getattr__(self, method):
        def call(*args):
            return self._channel.invoke(self._cap, method, list(args))

        return call


def connect(declared, read_stream=None, write_stream=None):
    """Build the capability object a sandboxed Python child receives: exactly the
    declared capabilities, each forwarded to the host over the channel (the
    child's stdio by default)."""
    channel = _Channel(read_stream or sys.stdin, write_stream or sys.stdout)
    return {cap: _Capability(channel, cap) for cap in declared}
