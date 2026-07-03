#  SPDX-License-Identifier: Apache-2.0
#
# Forensic replay — re-open a recorded run from its journal and prove the
# record self-describes.
#
# Two independent decode paths over the same recorded frames:
#   native  the writer's own path: the runtime journal reader plus the
#           flatc-generated accessors (what `kungfu rewind show` renders);
#   bundle  the reader-without-the-writer path: the run manifest's schema
#           bindings plus the content-addressed .bfbs blob, decoded through
#           FlatBuffers reflection — no generated event code involved
#           (reflection_fb.py is generated from reflection.fbs itself, the
#           schema of schemas, not from the event schema).
#
# `verify` diffs the two paths fact by fact. Identical output means the trace
# bundle really is decodable without the runtime that wrote it; any drift —
# schema mismatch, blob tampering, binding gaps — surfaces as a concrete diff.
#
# v1 replay scope: forensic (re-open, walk, verify). Deterministic re-execution
# is a next-stage differentiator gate, deliberately out of v1.

import hashlib
import json
import os
import re

import flatbuffers
import flatbuffers.encode
import flatbuffers.number_types as N
import kungfu

from kungfu.rewind import MSG_TYPE_NAMES
from kungfu.rewind import reflection_fb
from kungfu.rewind.fb import (
    ModelRequest,
    ModelResponse,
    RetryMarker,
    RunBegin,
    RunEnd,
    ToolCall,
    ToolResult,
)

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

_GENERATED = {
    "RunBegin": RunBegin.RunBegin,
    "RunEnd": RunEnd.RunEnd,
    "ModelRequest": ModelRequest.ModelRequest,
    "ModelResponse": ModelResponse.ModelResponse,
    "ToolCall": ToolCall.ToolCall,
    "ToolResult": ToolResult.ToolResult,
    "RetryMarker": RetryMarker.RetryMarker,
}

_SNAKE = re.compile(r"(?<!^)(?=[A-Z])")


def read_frames(runtime_dir, run_id):
    """All rewind frames of a run in gen_time order: (msg_type, header, bytes)."""
    locator = yjj.locator(runtime_dir)
    location = yjj.location(
        lf.enums.mode.LIVE, lf.enums.category.SYSTEM, "rewind", run_id, locator
    )
    frames = []
    for msg_type in MSG_TYPE_NAMES:
        for header, payload in yjj.assemble(location, 0).read_bytes(msg_type):
            frames.append((msg_type, header, bytes(payload)))
    frames.sort(key=lambda f: f[1].gen_time)
    return frames


def decode_native(msg_type, payload):
    """The writer's own decode: flatc-generated accessors."""
    cls = _GENERATED[MSG_TYPE_NAMES[msg_type]]
    root = cls.GetRootAs(payload, 0)
    facts = {}
    for name in dir(root):
        if (
            name.startswith("_")
            or name in ("Init", "GetRootAs")
            or name.startswith("GetRootAs")
        ):
            continue
        value = getattr(root, name)()
        if isinstance(value, bytes):
            value = value.decode()
        facts[_SNAKE.sub("_", name).lower()] = value
    return facts


class BundleDecoder:
    """The reader-without-the-writer: manifest bindings + .bfbs via reflection."""

    def __init__(self, bundle_dir):
        with open(os.path.join(bundle_dir, "manifest.json")) as f:
            self.manifest = json.load(f)
        self.bindings = self.manifest["schema_bindings"]
        self._schemas = {}
        self._objects = {}
        for msg_type, binding in self.bindings.items():
            blob_path = os.path.join(
                bundle_dir, "schemas", binding["schema_hash"] + ".bfbs"
            )
            with open(blob_path, "rb") as f:
                blob = f.read()
            if hashlib.sha256(blob).hexdigest() != binding["schema_hash"]:
                raise ValueError(f"schema blob hash mismatch for msg_type {msg_type}")
            self._schemas[int(msg_type)] = reflection_fb.Schema.GetRootAs(blob, 0)
            self._objects[int(msg_type)] = binding["name"]

    def _find_object(self, schema, name):
        for i in range(schema.ObjectsLength()):
            obj = schema.Objects(i)
            qualified = obj.Name().decode()
            if qualified == name or qualified.endswith("." + name):
                return obj
        raise KeyError(f"object {name} not in schema")

    def decode(self, msg_type, payload):
        schema = self._schemas[msg_type]
        obj = self._find_object(schema, self._objects[msg_type])
        n = flatbuffers.encode.Get(flatbuffers.packer.uoffset, payload, 0)
        table = flatbuffers.table.Table(payload, n)
        facts = {}
        for i in range(obj.FieldsLength()):
            field = obj.Fields(i)
            name = field.Name().decode()
            base_type = field.Type().BaseType()
            offset = field.Offset()
            facts[name] = self._read_field(table, base_type, offset, field)
        return facts

    @staticmethod
    def _read_field(table, base_type, offset, field):
        B = reflection_fb.BaseType
        o = table.Offset(offset)
        if base_type == B.String:
            return table.String(o + table.Pos).decode() if o else None
        scalars = {
            B.Bool: (N.BoolFlags, bool),
            B.Byte: (N.Int8Flags, int),
            B.UByte: (N.Uint8Flags, int),
            B.Short: (N.Int16Flags, int),
            B.UShort: (N.Uint16Flags, int),
            B.Int: (N.Int32Flags, int),
            B.UInt: (N.Uint32Flags, int),
            B.Long: (N.Int64Flags, int),
            B.ULong: (N.Uint64Flags, int),
        }
        if base_type in scalars:
            flags, cast = scalars[base_type]
            if not o:
                return cast(field.DefaultInteger())
            return cast(table.Get(flags, o + table.Pos))
        raise ValueError(f"unsupported base type {base_type} in rewind schema")


def verify(runtime_dir, run_id, bundle_dir):
    """Diff the two decode paths. Returns (frame_count, differences)."""
    decoder = BundleDecoder(bundle_dir)
    frames = read_frames(runtime_dir, run_id)
    differences = []
    for index, (msg_type, header, payload) in enumerate(frames):
        native = decode_native(msg_type, payload)
        bundled = decoder.decode(msg_type, payload)
        if native != bundled:
            keys = sorted(set(native) | set(bundled))
            for key in keys:
                if native.get(key) != bundled.get(key):
                    differences.append(
                        f"frame {index} ({MSG_TYPE_NAMES[msg_type]}).{key}: "
                        f"native={native.get(key)!r} bundle={bundled.get(key)!r}"
                    )
    return len(frames), differences


def causal_tree(runtime_dir, run_id):
    """Reconstruct the run's causal tree from the journal (native path)."""
    frames = read_frames(runtime_dir, run_id)
    spans = {}
    order = []
    run_facts = {}
    for msg_type, header, payload in frames:
        name = MSG_TYPE_NAMES[msg_type]
        facts = decode_native(msg_type, payload)
        facts["_gen_time"] = header.gen_time
        if name in ("RunBegin", "RunEnd"):
            run_facts[name] = facts
            continue
        span = facts.get("span_id")
        if name in ("ModelRequest", "ToolCall", "RetryMarker"):
            spans[span] = {"open": (name, facts), "close": None}
            order.append(span)
        else:
            if span in spans:
                spans[span]["close"] = (name, facts)
    return run_facts, spans, order


def render_tree(runtime_dir, run_id):
    run_facts, spans, order = causal_tree(runtime_dir, run_id)
    begin = run_facts.get("RunBegin", {})
    end = run_facts.get("RunEnd", {})
    lines = [
        f"run {begin.get('run_id', run_id)}  command: {begin.get('command')}",
        f"  status: exit_code={end.get('exit_code')}",
    ]

    children = {}
    roots = []
    for span in order:
        parent = spans[span]["open"][1].get("parent_span_id") or None
        if parent and parent in spans:
            children.setdefault(parent, []).append(span)
        else:
            roots.append(span)

    def describe(span):
        kind, facts = spans[span]["open"]
        close = spans[span]["close"]
        if kind == "ModelRequest":
            head = f"model {facts.get('provider')}/{facts.get('model')}"
        elif kind == "ToolCall":
            head = f"tool {facts.get('tool_name')}"
        else:
            head = f"retry attempt {facts.get('attempt')} of {facts.get('retry_of_span_id', '')[:8]}"
        if close:
            _, cf = close
            status = "ok" if cf.get("status") == 0 else "✗ error"
            head += f"  [{status}, {cf.get('latency_ns', 0) / 1e6:.1f}ms]"
            if cf.get("status") != 0 and cf.get("error"):
                head += f" — {cf.get('error')}"
        return head

    def walk(span, depth):
        lines.append("  " * (depth + 1) + "- " + describe(span))
        for child in children.get(span, []):
            walk(child, depth + 1)

    for root in roots:
        walk(root, 1)
    return "\n".join(lines)
