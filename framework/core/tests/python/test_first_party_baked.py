#  SPDX-License-Identifier: Apache-2.0
#
# A frozen build has no source extensions/ tree; it reads the first-party set
# from the manifest baked next to its executable (ADR-0013). Resolution order:
# KF_FIRST_PARTY_MANIFEST, then the baked manifest, then a source scan.

import json

from kungfu.rewind import first_party


def _write_manifest(path, keys):
    path.write_text(
        json.dumps({"version": 1, "keys": {k: {"sha256": "x"} for k in keys}})
    )


def test_reads_baked_manifest_next_to_executable(tmp_path, monkeypatch):
    exe = tmp_path / "kungfu"
    exe.write_text("")
    _write_manifest(tmp_path / "first-party.json", ["work-dashboard", "rewind"])
    monkeypatch.setattr("sys.executable", str(exe))
    monkeypatch.delenv("KF_FIRST_PARTY_MANIFEST", raising=False)
    assert first_party.first_party_keys() == {"work-dashboard", "rewind"}
    assert first_party.is_first_party("work-dashboard")
    assert not first_party.is_first_party("evil")


def test_env_manifest_wins_over_baked(tmp_path, monkeypatch):
    exe = tmp_path / "kungfu"
    exe.write_text("")
    _write_manifest(tmp_path / "first-party.json", ["baked-only"])
    env_manifest = tmp_path / "env.json"
    _write_manifest(env_manifest, ["env-only"])
    monkeypatch.setattr("sys.executable", str(exe))
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(env_manifest))
    assert first_party.first_party_keys() == {"env-only"}
