#  SPDX-License-Identifier: Apache-2.0
#
# Register a runtime-compiled kfx schema into a run's action registry: the
# `.bfbs` produced by `compile_schema` is content-addressed and bound to an
# action_type in the per-run manifest. Once bound, every runtime
# (C++/Python/Node) decodes events of that action_type by reflection over the
# `.bfbs` — no generated code.

from __future__ import annotations

import hashlib
import json
import os

from kungfu.action_envelope import CONTENT_HASH_ALGORITHM_SHA256
from kungfu.rewind import reflection_fb

_RESERVED_ACTION_PREFIXES = ("rewind.", "work.", "atlas.", "kungfu.")


def _validate_action_type(action_type: str, tier: str) -> None:
    if not action_type or "." not in action_type:
        raise ValueError("kfx action_type must be a dotted namespace string")
    if tier == "sandboxed" and not action_type.startswith("kfx."):
        raise ValueError("sandboxed kfx action_type must use the kfx.* namespace")
    if tier != "first_party" and action_type.startswith(_RESERVED_ACTION_PREFIXES):
        raise ValueError(
            f"action_type {action_type!r} is reserved for first-party schemas"
        )


def _root_object_name(bfbs: bytes, want: str) -> str:
    """Confirm `bfbs` is a reflection schema that defines table `want`; return
    its fully-qualified name. Rejects a schema whose bound name is absent."""
    schema = reflection_fb.Schema.GetRootAs(bfbs, 0)
    for i in range(schema.ObjectsLength()):
        qualified = (schema.Objects(i).Name() or b"").decode()
        if qualified == want or qualified.endswith("." + want) or want == "":
            return qualified
    raise ValueError(f"table '{want}' not found in the compiled schema")


def register_user_schema(
    bundle_dir: str,
    bfbs: bytes,
    action_type: str,
    name: str,
    *,
    tier: str = "trusted",
    schema_version: str = "user",
) -> dict[str, str]:
    """Content-address `bfbs` and bind `action_type` -> it in the run manifest.

    bfbs: bytes from compile_schema. name: the event table to bind (its
    fully-qualified name is resolved from the schema). tier: 'trusted' |
    'sandboxed' | 'first_party'. Returns the binding dict.

    Idempotent for an identical (action_type, hash); raises on a conflicting
    rebinding, a bad namespace, or a schema missing `name`.
    """
    action_type = str(action_type)
    _validate_action_type(action_type, tier)
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
        manifest = {
            "spec_version": "0.1",
            "hash_algorithm": CONTENT_HASH_ALGORITHM_SHA256,
            "schema_bindings": {},
        }
    bindings = manifest.setdefault("schema_bindings", {})

    existing = bindings.get(action_type)
    if existing and existing.get("schema_hash") != schema_hash:
        raise ValueError(
            f"action_type {action_type} already bound to a different schema "
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
    bindings[action_type] = binding

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    return binding
