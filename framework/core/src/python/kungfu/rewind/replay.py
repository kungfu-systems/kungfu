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
#           FlatBuffers reflection — no generated event code involved. ADR-0078
#           Decision 3: the reflection decode runs in the native generic
#           primitive (the ADR-0039 chokepoint, shared by all three runtimes)
#           rather than a hand-rolled Python reflection walk; reflection_fb (the
#           schema of schemas, generated from reflection.fbs) is used only to
#           enumerate schema fields for the absent-string None contract.
#
# `verify` diffs the two paths fact by fact. Identical output means the trace
# bundle really is decodable without the runtime that wrote it; any drift —
# schema mismatch, blob tampering, binding gaps — surfaces as a concrete diff.
#
# v1 replay scope: forensic (re-open, walk, verify). Deterministic re-execution
# is a next-stage differentiator gate, deliberately out of v1.

from __future__ import annotations

import json
import os
import re
from typing import Any

import kungfu

from kungfu.action_envelope import CARRIER_ACTION_ENVELOPE
from kungfu.action_envelope import verify_flatbuffer_payload
from kungfu.content_hash import verify_content_hash_value
from kungfu.rewind import ACTION_TYPE_NAMES
from kungfu.rewind import reflection_fb
from kungfu.rewind.fb import (
    ApprovalDecision,
    CostSnapshot,
    ModelRequest,
    ModelResponse,
    RetryMarker,
    RunBegin,
    RunEnd,
    ToolCall,
    ToolResult,
)
from kungfu.rewind.wire import unwrap_event

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime

_GENERATED: dict[str, Any] = {
    "RunBegin": RunBegin.RunBegin,
    "RunEnd": RunEnd.RunEnd,
    "ModelRequest": ModelRequest.ModelRequest,
    "ModelResponse": ModelResponse.ModelResponse,
    "ToolCall": ToolCall.ToolCall,
    "ToolResult": ToolResult.ToolResult,
    "RetryMarker": RetryMarker.RetryMarker,
    "CostSnapshot": CostSnapshot.CostSnapshot,
    "ApprovalDecision": ApprovalDecision.ApprovalDecision,
}

_SNAKE = re.compile(r"(?<!^)(?=[A-Z])")


def read_frames(runtime_dir: str, run_id: str) -> list[tuple[str, Any, bytes]]:
    """All rewind frames of a run in gen_time order: (action_type, header, bytes)."""
    locator = yjj.locator(runtime_dir)
    location = yjj.location(
        lf.enums.mode.LIVE, lf.enums.location_role.SYSTEM, "rewind", run_id, locator
    )
    frames: list[tuple[str, Any, bytes]] = []
    for header, payload in yjj.assemble(location, 0).read_bytes(
        CARRIER_ACTION_ENVELOPE
    ):
        event = unwrap_event(payload)
        if event is None:
            continue
        action_type, event_payload = event
        if action_type in ACTION_TYPE_NAMES:
            frames.append((action_type, header, event_payload))
    frames.sort(key=lambda f: f[1].gen_time)
    return frames


def decode_native(action_type: str, payload: bytes) -> dict[str, Any]:
    """The writer's own decode: flatc-generated accessors."""
    cls = _GENERATED[ACTION_TYPE_NAMES[action_type]]
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

    def __init__(self, bundle_dir: str) -> None:
        with open(os.path.join(bundle_dir, "manifest.json")) as f:
            self.manifest = json.load(f)
        self.bindings = self.manifest["schema_bindings"]
        self._schemas: dict[str, Any] = {}
        self._schema_bytes: dict[str, bytes] = {}
        self._objects: dict[str, str] = {}
        for action_type, binding in self.bindings.items():
            blob_path = os.path.join(
                bundle_dir, "schemas", binding["schema_hash"] + ".bfbs"
            )
            with open(blob_path, "rb") as f:
                blob = f.read()
            if not verify_content_hash_value(blob, binding["schema_hash"]):
                raise ValueError(
                    f"schema blob hash mismatch for action_type {action_type}"
                )
            self._schemas[action_type] = reflection_fb.Schema.GetRootAs(blob, 0)
            self._schema_bytes[action_type] = blob
            self._objects[action_type] = binding["name"]

    def _find_object(self, schema: Any, name: str) -> Any:
        for i in range(schema.ObjectsLength()):
            obj = schema.Objects(i)
            qualified = obj.Name().decode()
            if qualified == name or qualified.endswith("." + name):
                return obj
        raise KeyError(f"object {name} not in schema")

    def decode(self, action_type: str, payload: bytes) -> dict[str, Any]:
        if not verify_flatbuffer_payload(
            self._schema_bytes[action_type], payload, self._objects[action_type]
        ):
            raise ValueError(f"invalid FlatBuffers payload for {action_type}")
        # ADR-0078 Decision 3: decode through the native generic reflection
        # primitive (the ADR-0039 chokepoint) instead of re-walking the .bfbs
        # reflection schema in Python. output_default_scalars + enum_as_int make
        # its JSON match the generated-accessor facts. The one gap is that
        # FlatBuffers omits absent (non-default) strings, so fill those with None
        # to preserve the decode contract the forensic diff checks against.
        facts: dict[str, Any] = json.loads(
            yjj.decode_flatbuffer_payload_json(
                self._schema_bytes[action_type],
                payload,
                self._objects[action_type],
            )
        )
        schema = self._schemas[action_type]
        obj = self._find_object(schema, self._objects[action_type])
        for i in range(obj.FieldsLength()):
            field = obj.Fields(i)
            name = field.Name().decode()
            if (
                name not in facts
                and field.Type().BaseType() == reflection_fb.BaseType.String
            ):
                facts[name] = None
        return facts


def verify(runtime_dir: str, run_id: str, bundle_dir: str) -> tuple[int, list[str]]:
    """Diff the two decode paths. Returns (frame_count, differences)."""
    decoder = BundleDecoder(bundle_dir)
    frames = read_frames(runtime_dir, run_id)
    differences: list[str] = []
    for index, (action_type, header, payload) in enumerate(frames):
        bundled = decoder.decode(action_type, payload)
        native = decode_native(action_type, payload)
        if native != bundled:
            keys = sorted(set(native) | set(bundled))
            for key in keys:
                if native.get(key) != bundled.get(key):
                    differences.append(
                        f"frame {index} ({ACTION_TYPE_NAMES[action_type]}).{key}: "
                        f"native={native.get(key)!r} bundle={bundled.get(key)!r}"
                    )
    return len(frames), differences


def causal_tree(
    runtime_dir: str, run_id: str
) -> tuple[dict[str, Any], dict[Any, dict[str, Any]], list[Any]]:
    """Reconstruct the run's causal tree from the journal (native path)."""
    frames = read_frames(runtime_dir, run_id)
    decoder = BundleDecoder(os.path.join(runtime_dir, "rewind", run_id, "bundle"))
    spans: dict[Any, dict[str, Any]] = {}
    order: list[Any] = []
    run_facts: dict[str, Any] = {}
    pending_retry: dict[Any, Any] = {}
    for action_type, header, payload in frames:
        name = ACTION_TYPE_NAMES[action_type]
        decoder.decode(action_type, payload)
        facts = decode_native(action_type, payload)
        facts["_gen_time"] = header.gen_time
        if name in ("RunBegin", "RunEnd"):
            run_facts[name] = facts
            continue
        span = facts.get("span_id")
        if name == "RetryMarker":
            # a retry is an annotation on the attempt's span, not a node of
            # its own — the hook gives it the same span_id as the attempt
            pending_retry[span] = facts
        elif name in ("ModelRequest", "ToolCall"):
            spans[span] = {
                "open": (name, facts),
                "close": None,
                "retry": pending_retry.pop(span, None),
            }
            order.append(span)
        else:
            if span in spans:
                spans[span]["close"] = (name, facts)
    return run_facts, spans, order


def render_tree(runtime_dir: str, run_id: str) -> str:
    run_facts, spans, order = causal_tree(runtime_dir, run_id)
    begin = run_facts.get("RunBegin", {})
    end = run_facts.get("RunEnd", {})
    lines = [
        f"run {begin.get('run_id', run_id)}  command: {begin.get('command')}",
        f"  status: exit_code={end.get('exit_code')}",
    ]

    children: dict[Any, list[Any]] = {}
    roots: list[Any] = []
    for span in order:
        parent = spans[span]["open"][1].get("parent_span_id") or None
        if parent and parent in spans:
            children.setdefault(parent, []).append(span)
        else:
            roots.append(span)

    def describe(span: Any) -> str:
        kind, facts = spans[span]["open"]
        close = spans[span]["close"]
        if kind == "ModelRequest":
            head = f"model {facts.get('provider')}/{facts.get('model')}"
        else:
            head = f"tool {facts.get('tool_name')}"
        retry = spans[span].get("retry")
        if retry:
            head += f" (retry #{retry.get('attempt')})"
        if close:
            _, cf = close
            status = "ok" if cf.get("status") == 0 else "✗ error"
            head += f"  [{status}, {cf.get('latency_ns', 0) / 1e6:.1f}ms]"
            if cf.get("status") != 0 and cf.get("error"):
                head += f" — {cf.get('error')}"
        return head

    def walk(span: Any, depth: int) -> None:
        lines.append("  " * (depth + 1) + "- " + describe(span))
        for child in children.get(span, []):
            walk(child, depth + 1)

    for root in roots:
        walk(root, 1)
    return "\n".join(lines)
