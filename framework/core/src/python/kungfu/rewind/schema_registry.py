#  SPDX-License-Identifier: Apache-2.0
#
# Register a runtime-compiled kfx schema into a run's open-layer registry: the
# `.bfbs` produced by `compile_schema` is content-addressed and bound to a
# msg_type in the per-run manifest, exactly like the first-party Rewind/work/
# atlas schemas (bundle.py). Once bound, every runtime (C++/Python/Node) decodes
# events of that msg_type by reflection over the `.bfbs` — no generated code.
#
# msg_type allocation (docs/msg-type-ranges.md): the open layer is 30000+; the
# third-party kfx band is 40000-49999. The `sandboxed` trust tier is confined to
# that band so an untrusted kfx cannot claim a first-party number.

import hashlib
import json
import os

from kungfu.rewind import reflection_fb

# third-party kfx dynamic schema band (docs/msg-type-ranges.md)
KFX_MSGTYPE_MIN = 40000
KFX_MSGTYPE_MAX = 49999
OPEN_LAYER_MIN = 30000

# first-party open-layer sub-ranges no kfx registration may claim
_FIRST_PARTY = ((30001, 30099), (30101, 30199), (30201, 30299))


def _in(n, lo, hi):
    return lo <= n <= hi


def _validate_msg_type(msg_type, tier):
    if msg_type < OPEN_LAYER_MIN:
        raise ValueError(
            f"msg_type {msg_type} is below the open layer ({OPEN_LAYER_MIN}); "
            "runtime kfx schemas live in the open layer"
        )
    if any(_in(msg_type, lo, hi) for lo, hi in _FIRST_PARTY):
        raise ValueError(
            f"msg_type {msg_type} is a reserved first-party number; "
            f"kfx schemas use the {KFX_MSGTYPE_MIN}-{KFX_MSGTYPE_MAX} band"
        )
    if tier == "sandboxed" and not _in(msg_type, KFX_MSGTYPE_MIN, KFX_MSGTYPE_MAX):
        raise ValueError(
            f"sandboxed kfx msg_type {msg_type} must be within "
            f"{KFX_MSGTYPE_MIN}-{KFX_MSGTYPE_MAX}"
        )


def _root_object_name(bfbs, want):
    """Confirm `bfbs` is a reflection schema that defines table `want`; return
    its fully-qualified name. Rejects a schema whose bound name is absent."""
    schema = reflection_fb.Schema.GetRootAs(bfbs, 0)
    for i in range(schema.ObjectsLength()):
        qualified = (schema.Objects(i).Name() or b"").decode()
        if qualified == want or qualified.endswith("." + want) or want == "":
            return qualified
    raise ValueError(f"table '{want}' not found in the compiled schema")


def register_user_schema(bundle_dir, bfbs, msg_type, name, *, tier="trusted",
                         schema_version="user"):
    """Content-address `bfbs` and bind `msg_type` -> it in the run manifest.

    bfbs: bytes from compile_schema. name: the event table to bind (its
    fully-qualified name is resolved from the schema). tier: 'trusted' |
    'sandboxed' (bounds the msg_type band). Returns the binding dict.

    Idempotent for an identical (msg_type, hash); raises on a conflicting
    rebinding, a bad band, or a schema missing `name`.
    """
    msg_type = int(msg_type)
    _validate_msg_type(msg_type, tier)
    qualified = _root_object_name(bytes(bfbs), name)

    schema_hash = hashlib.sha256(bytes(bfbs)).hexdigest()
    schemas_dir = os.path.join(bundle_dir, "schemas")
    os.makedirs(schemas_dir, exist_ok=True)
    blob_path = os.path.join(schemas_dir, schema_hash + ".bfbs")
    if not os.path.exists(blob_path):
        with open(blob_path, "wb") as f:
            f.write(bytes(bfbs))

    manifest_path = os.path.join(bundle_dir, "manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    else:
        manifest = {"spec_version": "0.1", "hash_algorithm": "sha256",
                    "schema_bindings": {}}
    bindings = manifest.setdefault("schema_bindings", {})

    existing = bindings.get(str(msg_type))
    if existing and existing.get("schema_hash") != schema_hash:
        raise ValueError(
            f"msg_type {msg_type} already bound to a different schema "
            f"({existing.get('name')}); rebinding is not allowed within a run"
        )

    binding = {
        "schema_kind": "flatbuffers",
        "name": qualified,
        "schema_version": schema_version,
        "schema_hash": schema_hash,
        "origin": "kfx",
        "trust_tier": tier,
    }
    bindings[str(msg_type)] = binding

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    return binding
