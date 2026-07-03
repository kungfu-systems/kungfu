#  SPDX-License-Identifier: Apache-2.0
#
# Export a recorded run as one portable file, and open such a file anywhere —
# offline, no services (gate G8). The export preserves the run's on-disk
# layout (journal pages + the self-describing bundle), so an opened export is
# a fully functional runtime home for that run: show, verify and the app all
# work against it exactly as against the original.

import json
import os
import zipfile

import kungfu

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

EXPORT_META = "rewind-export.json"
EXPORT_SUFFIX = ".rewind.zip"


def _run_paths(runtime_dir, run_id):
    journal_dir = os.path.join(runtime_dir, "journal", "system", "rewind", run_id)
    bundle_dir = os.path.join(runtime_dir, "rewind", run_id)
    return journal_dir, bundle_dir


def export_run(runtime_dir, run_id, out_path=None):
    """Zip one run's journal + bundle, layout-preserving. Returns the path."""
    journal_dir, bundle_dir = _run_paths(runtime_dir, run_id)
    if not os.path.isdir(journal_dir):
        raise FileNotFoundError(f"run {run_id!r} has no journal under {runtime_dir}")
    if not os.path.isdir(bundle_dir):
        raise FileNotFoundError(f"run {run_id!r} has no bundle under {runtime_dir}")

    out_path = out_path or (run_id + EXPORT_SUFFIX)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            EXPORT_META,
            json.dumps(
                {
                    "format": "kungfu-rewind-export",
                    "format_version": 1,
                    "run_id": run_id,
                    "layout": "runtime/-rooted, open with -H on the extracted dir",
                },
                indent=2,
            ),
        )
        for base in (journal_dir, bundle_dir):
            for root, _, files in os.walk(base):
                for name in files:
                    full = os.path.join(root, name)
                    arc = os.path.join("runtime", os.path.relpath(full, runtime_dir))
                    zf.write(full, arc)
    return out_path


def open_export(archive_path, target_dir):
    """Extract an export into target_dir; returns (run_id, runtime_dir)."""
    with zipfile.ZipFile(archive_path) as zf:
        meta_raw = zf.read(EXPORT_META)
        meta = json.loads(meta_raw)
        if meta.get("format") != "kungfu-rewind-export":
            raise ValueError(f"{archive_path} is not a rewind export")
        for info in zf.infolist():
            # defensive extraction: stay inside target_dir
            dest = os.path.realpath(os.path.join(target_dir, info.filename))
            if not dest.startswith(os.path.realpath(target_dir) + os.sep):
                raise ValueError(f"unsafe path in archive: {info.filename}")
        zf.extractall(target_dir)
    return meta["run_id"], os.path.join(target_dir, "runtime")
