# SPDX-License-Identifier: Apache-2.0
#
# A kfx extension running under `kungfu trace`. Unlike the traced agent (which
# stays untouched), a kfx opts into kungfu: it compiles its *own* `.fbs` to a
# `.bfbs` at runtime, registers that schema into the run, and emits events of
# its own msg_type — all through the injected capture channel. The whole point
# of the hana->FB migration is that this schema is defined by a third party and
# inserted dynamically, not baked into the kernel.

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_CORE = os.path.abspath(os.path.join(_HERE, "..", "..", "..", "framework", "core"))
# reach the kungfu package + the built binding (compile_schema lives in libkungfu)
sys.path.insert(0, os.path.join(_CORE, "src", "python"))
sys.path.insert(0, os.path.join(_CORE, "dist", "kfc"))

import flatbuffers

import kungfu
import rewind_client  # pure-stdlib hook, injected on PYTHONPATH by the supervisor

KFX_MSG_TYPE = 40001  # third-party kfx band (docs/msg-type-ranges.md)

run_id = os.environ.get("KUNGFU_REWIND_RUN_ID")
if not run_id:
    print("KUNGFU_REWIND_RUN_ID missing from injected environment", file=sys.stderr)
    sys.exit(1)

# 1. compile this kfx's schema to a .bfbs in-process (no flatc binary)
with open(os.path.join(_HERE, "kfx_event.fbs"), "r", encoding="utf-8") as f:
    fbs_text = f.read()
bfbs, error = kungfu.__binding__.yijinjing.compile_schema(fbs_text)
if error:
    print(f"kfx schema compile failed: {error}", file=sys.stderr)
    sys.exit(1)

# 2. register the schema into the run, and emit an event of its msg_type
if not rewind_client.setup():
    print("capture channel not announced", file=sys.stderr)
    sys.exit(1)
rewind_client.kfx_schema(KFX_MSG_TYPE, "KfxEvent", bfbs, tier="trusted")

# build one KfxEvent with the low-level builder (a kfx would use its own
# generated accessors; the wire result is identical). Field slots follow the
# schema's declaration order: id=0, label=1, score=2, tags=3.
builder = flatbuffers.Builder(0)
label = builder.CreateString("kfx-live")
t0 = builder.CreateString("p")
t1 = builder.CreateString("q")
builder.StartVector(4, 2, 4)
builder.PrependUOffsetTRelative(t1)
builder.PrependUOffsetTRelative(t0)
tags = builder.EndVector()
builder.StartObject(4)
builder.PrependUint32Slot(0, 42, 0)
builder.PrependUOffsetTRelativeSlot(1, label, 0)
builder.PrependFloat32Slot(2, 3.5, 0)
builder.PrependUOffsetTRelativeSlot(3, tags, 0)
builder.Finish(builder.EndObject())
rewind_client.kfx_event(KFX_MSG_TYPE, bytes(builder.Output()))

print(f"kfx compiled + registered + emitted its event under traced run {run_id}")
