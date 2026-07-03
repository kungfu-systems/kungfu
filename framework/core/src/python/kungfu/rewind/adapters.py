#  SPDX-License-Identifier: Apache-2.0
#
# kfx adapter discovery — the supervisor side of the plugin bridge.
#
# Framework adapters are a kfx extension form (`kungfuConfig.config.adapter`),
# not core code. The supervisor has kungfu and reads manifests, so it does the
# discovery: it scans the same extension roots the GUI shell scans, finds
# packages whose manifest declares a python adapter, and announces their entry
# files to the child. The child-side hook stays dependency-free and only loads
# what it is told — see rewind_client._load_plugin_adapters.
#
# A manifest's adapter form:
#   "kungfuConfig": { "config": { "adapter": {
#       "targets": ["langchain_core.tools.base"],   # informative
#       "runtimes": ["python"],                      # forms this covers
#       "entry": { "python": "dist/adapter/python/index.py" }
#   } } }

import json
import os

ENV_EXTENSION_PATH = "KF_EXTENSION_PATH"
# shared contract strings with the child hooks (per runtime): the python hook
# reads ENV_PLUGIN_ADAPTERS, the node hook reads ENV_NODE_ADAPTERS.
ENV_PLUGIN_ADAPTERS = "KUNGFU_REWIND_ADAPTERS"
ENV_NODE_ADAPTERS = "KUNGFU_REWIND_NODE_ADAPTERS"


def _extension_roots(runtime_dir):
    # priority order mirrors framework/gui kfx-loader: KF_EXTENSION_PATH entries
    # (dev override) then <home>/extensions next to the runtime dir.
    roots = []
    for entry in os.environ.get(ENV_EXTENSION_PATH, "").split(os.pathsep):
        if entry:
            roots.append(entry)
    if runtime_dir:
        roots.append(os.path.join(os.path.dirname(runtime_dir), "extensions"))
    return roots


def _scan_packages(root):
    # two levels deep, so suite members nested under a suite directory are found
    if not os.path.isdir(root):
        return
    for name in sorted(os.listdir(root)):
        pkg = os.path.join(root, name)
        if os.path.isfile(os.path.join(pkg, "package.json")):
            yield pkg
        elif os.path.isdir(pkg):
            for sub in sorted(os.listdir(pkg)):
                nested = os.path.join(pkg, sub)
                if os.path.isfile(os.path.join(nested, "package.json")):
                    yield nested


def discover_adapters(runtime_dir, runtime):
    """Return (entry_files, package_dirs) for kfx packages declaring an adapter
    form for `runtime` ('python' or 'node'). First occurrence of a package path
    wins; missing entry files are skipped."""
    entries, dirs, seen = [], [], set()
    for root in _extension_roots(runtime_dir):
        for pkg in _scan_packages(root):
            try:
                with open(os.path.join(pkg, "package.json")) as f:
                    manifest = json.load(f)
            except (OSError, ValueError):
                continue
            config = (manifest.get("kungfuConfig") or {}).get("config") or {}
            adapter = config.get("adapter") or {}
            if runtime not in (adapter.get("runtimes") or []):
                continue
            entry = (adapter.get("entry") or {}).get(runtime)
            if not entry:
                continue
            path = os.path.abspath(os.path.join(pkg, entry))
            if path in seen or not os.path.exists(path):
                continue
            seen.add(path)
            entries.append(path)
            dirs.append(os.path.abspath(pkg))
    return entries, dirs
