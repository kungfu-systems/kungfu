#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu kfx install` / `list` disclose the trust verdict (ADR-0013): a package
# is first-party (trusted) or third-party (untrusted) by source, and each facet's
# consequence — a sandboxed view, or a refused adapter — is stated at install
# time so the trust grant is informed.

import json

from kungfu.console.commands import kfx


def _manifest(key, facet):
    return {"kungfuConfig": {"key": key, "config": {facet: {}}}}


def _write_manifest(path, keys):
    with open(path, "w") as f:
        json.dump({"version": 1, "keys": {k: {"sha256": None} for k in keys}}, f)


def _notice(tmp_path, monkeypatch, key, facet, trusted_keys):
    manifest_path = tmp_path / "first-party.json"
    _write_manifest(str(manifest_path), trusted_keys)
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(manifest_path))
    return "\n".join(kfx._trust_notice(_manifest(key, facet)))


def test_trusted_view_is_node_integrated(tmp_path, monkeypatch):
    out = _notice(tmp_path, monkeypatch, "v", "view", ["v"])
    assert "first-party" in out and "node-integrated" in out


def test_untrusted_view_is_sandboxed(tmp_path, monkeypatch):
    out = _notice(tmp_path, monkeypatch, "evil", "view", [])
    assert "third-party" in out and "sandboxed-ipc" in out


def test_untrusted_adapter_is_refused(tmp_path, monkeypatch):
    out = _notice(tmp_path, monkeypatch, "evil", "adapter", [])
    assert "third-party" in out and "REFUSED" in out


def test_trusted_adapter_may_inject(tmp_path, monkeypatch):
    out = _notice(tmp_path, monkeypatch, "a", "adapter", ["a"])
    assert "first-party" in out and "may inject" in out
