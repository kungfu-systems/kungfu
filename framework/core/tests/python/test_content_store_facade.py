# SPDX-License-Identifier: Apache-2.0
#
# ADR-0040 content-store facade fixtures (stage B).
#
# The same immutable contract obligations run against both providers: the
# dependency-free file backend and the RocksDB-backed store in the runtime
# layer. Differences stay declared through capability discovery, never
# implied. The fsck integration case proves payload-ref resolution reads the
# backend that owns the bytes (the injection seam), not a hardcoded file
# tree.

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from kungfu.storage import content_store, service
from kungfu.storage.episode_lifecycle import RuntimeEpisodeLifecycle

PROVIDERS = ["content-addressed-file", "rocksdb"]

EXPECTED_PROFILES = {
    "content-addressed-file": "yijinjing-file/v1",
    "rocksdb": "kungfu-rocksdb/v1",
}


@pytest.fixture(params=PROVIDERS)
def provider(request, monkeypatch):
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", request.param)
    return request.param


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def test_capabilities_declare_the_backend(tmp_path, provider):
    caps = content_store.capabilities(tmp_path / "runtime")
    assert caps["profile"] == EXPECTED_PROFILES[provider]
    assert caps["hash_algorithm"] == "sha256"
    assert caps["atomic_put_if_absent"] is True
    assert caps["verified_reads"] is True
    assert caps["durability"] and caps["visibility"] and caps["concurrency"]


def test_put_get_verify_roundtrip(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    raw = f"stage-b payload via {provider}".encode()
    digest = _digest(raw)

    put = content_store.put_if_absent(runtime_dir, "payloads", raw)
    assert put["ok"] and not put["existed"]
    assert put["hash"]["value"] == digest
    assert put["byte_length"] == len(raw)

    again = content_store.put_if_absent(runtime_dir, "payloads", raw)
    assert again["ok"] and again["existed"]

    assert content_store.has(runtime_dir, "payloads", f"sha256:{digest}")
    assert content_store.get(runtime_dir, "payloads", digest) == raw

    verified = content_store.verify(runtime_dir, "payloads", f"sha256:{digest}")
    assert verified["ok"]
    assert verified["byte_length"] == len(raw)


def test_declared_hash_mismatch_rejects_and_stores_nothing(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    raw = b"bytes that will be rejected"
    wrong = "sha256:" + "0" * 64

    rejected = content_store.put_if_absent(
        runtime_dir, "payloads", raw, expected_hash=wrong
    )
    assert not rejected["ok"]
    assert rejected["error"] == "hash_mismatch"
    assert not content_store.has(runtime_dir, "payloads", _digest(raw))


def test_absent_digest_reports_not_found(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    absent = _digest(b"never published")
    verified = content_store.verify(runtime_dir, "payloads", absent)
    assert not verified["ok"]
    assert verified["error"] == "not_found"
    with pytest.raises(RuntimeError):
        content_store.get(runtime_dir, "payloads", absent)


def test_malformed_hash_is_invalid_argument(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    verified = content_store.verify(runtime_dir, "payloads", "sha256:not-a-digest")
    assert verified["error"] == "invalid_argument"
    assert not content_store.has(runtime_dir, "payloads", "sha256:not-a-digest")


def test_namespaces_partition_objects(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    raw = b"namespaced object"
    digest = _digest(raw)
    assert content_store.put_if_absent(runtime_dir, "payloads", raw)["ok"]
    assert content_store.has(runtime_dir, "payloads", digest)
    assert not content_store.has(runtime_dir, "snapshots", digest)


def test_fsck_resolves_refs_through_the_selected_backend(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    lifecycle = RuntimeEpisodeLifecycle(
        runtime_dir=str(runtime_dir),
        namespace="agent",
        name=f"facade-{provider}",
        title="stage-b lifecycle",
        actor="pytest",
        source=f"facade-{provider}",
    )
    payload_file = tmp_path / "artifact.json"
    payload_file.write_text('{"stage": "b"}', encoding="utf-8")
    lifecycle.attach_payload_ref(str(payload_file))
    lifecycle.close(ok=True)

    fsck = service.fsck(runtime_dir, episode_id=lifecycle.episode_id)
    assert fsck["ok"]
    assert fsck["status"] == "ok"

    digest = _digest(payload_file.read_bytes())
    object_path = Path(runtime_dir) / "storage" / "payloads" / digest[:2] / digest
    if provider == "rocksdb":
        # the bytes live in the engine, not the file tree: a passing fsck
        # proves resolution went through the injected engine-backed store
        assert not object_path.exists()
    else:
        assert object_path.exists()


def test_sealed_missing_ref_fails_under_both_backends(tmp_path, provider):
    runtime_dir = tmp_path / "runtime"
    service.episode_begin(
        runtime_dir,
        episode_id=9,
        title="missing ref",
        actor="pytest",
        source="facade-fixture",
        begin_time=1000,
    )
    service.episode_attach_ref(
        runtime_dir,
        episode_id=9,
        ref_kind="payload",
        ref_id="fixtures/absent.bin",
        ref_hash="sha256:" + _digest(b"never published"),
    )
    service.episode_end(
        runtime_dir, episode_id=9, end_time=2000, frame_count=0, reason="done"
    )

    fsck = service.fsck(runtime_dir, episode_id=9)
    assert not fsck["ok"]
    assert fsck["status"] == "failed"
    assert "episode_payload_ref_missing" in [e["code"] for e in fsck["errors"]]
