#  SPDX-License-Identifier: Apache-2.0
#
# Bundle format pieces for a traced run: the content-addressed schema blob
# (schemas/<sha256>.bfbs) and the run manifest with per-run schema bindings.
# Same shape as the schema-registry slice emits and its decoder consumes —
# one msg_type binds to one schema per run; evolution happens between runs.

import hashlib
import json
import os

from kungfu.rewind import MSG_TYPE_NAMES, SCHEMA_VERSION

_BFBS_FILE = __import__("kungfu").schema_data_path(__file__, "rewind_events.bfbs")


def read_schema_blob():
    with open(_BFBS_FILE, "rb") as f:
        return f.read()


def emit(bundle_dir, journal_root, source, extra=None):
    """Write schemas/<hash>.bfbs and manifest.json under bundle_dir.

    source: dict with mode/category/group/name/dest describing the journal
    location the run was written to. Returns the manifest path.
    """
    blob = read_schema_blob()
    schema_hash = hashlib.sha256(blob).hexdigest()

    schemas_dir = os.path.join(bundle_dir, "schemas")
    os.makedirs(schemas_dir, exist_ok=True)
    blob_path = os.path.join(schemas_dir, schema_hash + ".bfbs")
    if not os.path.exists(blob_path):
        with open(blob_path, "wb") as f:
            f.write(blob)

    bindings = {
        str(msg_type): {
            "schema_kind": "flatbuffers",
            "name": name,
            "schema_version": SCHEMA_VERSION,
            "schema_hash": schema_hash,
        }
        for msg_type, name in MSG_TYPE_NAMES.items()
    }

    manifest = {
        "spec_version": "0.1",
        "source": {"root": journal_root, **source},
        "hash_algorithm": "sha256",
        "schema_bindings": bindings,
        "capture_boundary": "schema bindings cover this run's Rewind capture "
        "events only; frames of other msg_types in the same journal are out "
        "of scope for this bundle",
    }
    if extra:
        manifest.update(extra)

    manifest_path = os.path.join(bundle_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    return manifest_path
