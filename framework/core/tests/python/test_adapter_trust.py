#  SPDX-License-Identifier: Apache-2.0
#
# The trace supervisor injects a kfx adapter into the traced program in-process;
# an untrusted adapter cannot be sandboxed, so it must be refused, not injected
# (ADR-0013). Trust is by first-party-set membership, never by which extension
# root the package sits on.

import json
import os

from kungfu.rewind import adapters


def _write_adapter(root, key, runtime="python"):
    pkg = os.path.join(root, key)
    entry = os.path.join("src", "adapter", runtime, "index.py")
    os.makedirs(os.path.join(pkg, os.path.dirname(entry)), exist_ok=True)
    with open(os.path.join(pkg, "package.json"), "w") as f:
        json.dump(
            {
                "name": f"@kungfu-tech/kfx-adapter-{key}",
                "kungfuConfig": {
                    "key": key,
                    "config": {
                        "adapter": {"runtimes": [runtime], "entry": {runtime: entry}}
                    },
                },
            },
            f,
        )
    with open(os.path.join(pkg, entry), "w") as f:
        f.write("# adapter source\n")
    return pkg


def _write_manifest(path, keys):
    with open(path, "w") as f:
        json.dump({"version": 1, "keys": {k: {"sha256": None} for k in keys}}, f)


def _injected_keys(dirs):
    return {os.path.basename(d) for d in dirs}


def _setup(tmp_path, monkeypatch, trusted_keys):
    ext = tmp_path / "ext"
    _write_adapter(str(ext), "trusted-a")
    _write_adapter(str(ext), "evil")
    manifest = tmp_path / "first-party.json"
    _write_manifest(str(manifest), trusted_keys)
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(manifest))
    monkeypatch.setenv("KF_EXTENSION_PATH", str(ext))
    return ext


def test_untrusted_adapter_is_refused_not_injected(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, trusted_keys=["trusted-a"])
    entries, dirs, refused = adapters.discover_adapters(None, "python")
    assert _injected_keys(dirs) == {"trusted-a"}
    assert {r["key"] for r in refused} == {"evil"}
    assert len(entries) == 1


def test_extension_path_does_not_confer_trust(tmp_path, monkeypatch):
    # both adapters sit on KF_EXTENSION_PATH; membership, not the root, decides.
    _setup(tmp_path, monkeypatch, trusted_keys=[])
    entries, dirs, refused = adapters.discover_adapters(None, "python")
    assert dirs == [] and entries == []
    assert {r["key"] for r in refused} == {"trusted-a", "evil"}


def test_install_root_adapter_is_refused(tmp_path, monkeypatch):
    # an adapter dropped in <home>/extensions (the install root, runtime_dir
    # based) is not first-party and must be refused.
    home = tmp_path / "home"
    # the install root is <dirname(runtime_dir)>/extensions
    install_root = home / "extensions"
    _write_adapter(str(install_root), "installed-evil")
    manifest = tmp_path / "first-party.json"
    _write_manifest(str(manifest), ["trusted-a"])
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(manifest))
    monkeypatch.delenv("KF_EXTENSION_PATH", raising=False)
    runtime_dir = str(home / "runtime")
    entries, dirs, refused = adapters.discover_adapters(runtime_dir, "python")
    assert entries == []
    assert {r["key"] for r in refused} == {"installed-evil"}
