#  SPDX-License-Identifier: Apache-2.0
#
# A product build has no source extensions/ tree; it reads the first-party set
# from the manifest baked at the product root (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847). Resolution order:
# KF_FIRST_PARTY_MANIFEST, then the baked manifest, then a source scan. The
# product root comes from the host seam, so the frozen form is staged the way
# the seam detects it (sys.frozen + sys.executable at the dist root).

import json
import sys

from kungfu.rewind import first_party

SHA = "a" * 64


def _write_manifest(path, keys, *, legacy=False):
    manifest = {
        "version": 1,
        "keys": {k: {"sha256": SHA} for k in keys},
    }
    if not legacy:
        manifest["schema"] = "kungfu.first-party-manifest/v1"
    path.write_text(json.dumps(manifest))


def _stage_frozen(tmp_path, monkeypatch):
    exe = tmp_path / "kungfu"
    exe.write_text("")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))


def test_reads_baked_manifest_at_the_product_root(tmp_path, monkeypatch):
    _stage_frozen(tmp_path, monkeypatch)
    _write_manifest(tmp_path / "first-party.json", ["work-dashboard", "rewind"])
    monkeypatch.delenv("KF_FIRST_PARTY_MANIFEST", raising=False)
    assert first_party.first_party_keys() == {"work-dashboard", "rewind"}
    assert first_party.is_first_party("work-dashboard")
    assert not first_party.is_first_party("evil")


def test_env_manifest_wins_over_baked(tmp_path, monkeypatch):
    _stage_frozen(tmp_path, monkeypatch)
    _write_manifest(tmp_path / "first-party.json", ["baked-only"])
    env_manifest = tmp_path / "env.json"
    _write_manifest(env_manifest, ["env-only"])
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(env_manifest))
    assert first_party.first_party_keys() == {"env-only"}


def test_schema_less_v1_manifest_remains_read_compatible(tmp_path, monkeypatch):
    manifest = tmp_path / "legacy.json"
    _write_manifest(manifest, ["legacy"], legacy=True)
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(manifest))

    assert first_party.first_party_keys() == {"legacy"}


def test_invalid_explicit_manifest_fails_closed_without_source_fallback(
    tmp_path, monkeypatch
):
    manifest = tmp_path / "invalid.json"
    _write_manifest(manifest, ["must-not-be-trusted"])
    data = json.loads(manifest.read_text())
    data["schema"] = "kungfu.first-party-manifest/v999"
    manifest.write_text(json.dumps(data))
    monkeypatch.setenv("KF_FIRST_PARTY_MANIFEST", str(manifest))

    assert first_party.first_party_keys() == set()
