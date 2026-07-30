# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.storage import content_store, service


FILE = "content-addressed-file"
ROCKS = "rocksdb"


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _object_path(runtime_dir: Path, namespace: str, raw: bytes) -> Path:
    digest = _digest(raw)
    return runtime_dir / "storage" / namespace / digest[:2] / digest


def _binding(runtime_dir: Path) -> dict:
    return json.loads(
        (runtime_dir / "storage" / "backend-binding.json").read_text(encoding="utf-8")
    )


def test_empty_status_is_read_only_and_first_write_binds_file(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER", raising=False)

    status = service.backend_status(runtime_dir)

    assert status["ok"] is True
    assert status["provider"] == FILE
    assert status["binding"] is None
    assert status["inventory"]["object_count"] == 0
    assert not (runtime_dir / "storage").exists()

    raw = b"first authoritative object"
    assert content_store.put_if_absent(runtime_dir, "payloads", raw)["ok"]
    assert _binding(runtime_dir)["provider"] == FILE
    assert _binding(runtime_dir)["generation"] == 1


def test_file_to_rocks_switch_preserves_namespaces_and_routes_new_writes(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    before = {
        "payloads": b"file payload before cut",
        "schemas": b'{"type":"object"}',
    }
    for namespace, raw in before.items():
        assert content_store.put_if_absent(runtime_dir, namespace, raw)["ok"]

    switched = service.backend_switch(runtime_dir, target_provider=ROCKS)

    assert switched["ok"] is True
    assert switched["phase"] == "committed"
    assert switched["binding_committed"] is True
    assert switched["source_provider"] == FILE
    assert switched["target_provider"] == ROCKS
    assert switched["target_fsck"]["ok"] is True
    assert switched["pre_cut"] == switched["post_cut"]
    assert switched["post_cut"]["object_count"] == len(before)

    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER")
    for namespace, raw in before.items():
        assert content_store.get(runtime_dir, namespace, _digest(raw)) == raw

    after = b"post-cut rocks object"
    assert content_store.put_if_absent(runtime_dir, "payloads", after)["ok"]
    assert not _object_path(runtime_dir, "payloads", after).exists()

    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    mismatch = service.backend_status(runtime_dir)
    assert mismatch["ok"] is False
    assert "provider_binding_mismatch" in mismatch["warnings"][0]
    with pytest.raises(RuntimeError, match="provider_binding_mismatch"):
        content_store.put_if_absent(runtime_dir, "payloads", b"fenced old writer")


def test_rocks_to_file_switch_materializes_objects(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", ROCKS)
    objects = {
        "payloads": b"rocks payload",
        "schemas": b"rocks schema",
    }
    for namespace, raw in objects.items():
        assert content_store.put_if_absent(runtime_dir, namespace, raw)["ok"]
        assert not _object_path(runtime_dir, namespace, raw).exists()

    switched = service.backend_switch(runtime_dir, target_provider=FILE)

    assert switched["target_provider"] == FILE
    assert (
        switched["target_fsck"]["semantic_root"]
        == switched["post_cut"]["semantic_root"]
    )
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER")
    for namespace, raw in objects.items():
        assert _object_path(runtime_dir, namespace, raw).read_bytes() == raw
        assert content_store.get(runtime_dir, namespace, _digest(raw)) == raw


def test_mid_copy_fault_keeps_old_binding_and_rerun_resumes(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    for raw in (b"resume-a", b"resume-b", b"resume-c"):
        assert content_store.put_if_absent(runtime_dir, "payloads", raw)["ok"]

    with pytest.raises(RuntimeError, match="qualification_fault_after_copy"):
        service.backend_switch(
            runtime_dir,
            target_provider=ROCKS,
            qualification_fail_after_copied_objects=1,
        )

    assert _binding(runtime_dir)["provider"] == FILE
    state_path = runtime_dir / "storage" / "backend-switch-state.json"
    interrupted = json.loads(state_path.read_text(encoding="utf-8"))
    assert interrupted["phase"] == "copying"
    assert interrupted["copied_objects"] >= 1

    completed = service.backend_switch(runtime_dir, target_provider=ROCKS)

    assert completed["phase"] == "committed"
    assert completed["operation_id"] == interrupted["operation_id"]
    assert _binding(runtime_dir)["provider"] == ROCKS
    assert _binding(runtime_dir)["generation"] == 2


def test_concurrent_writes_are_included_or_retry_across_the_cut(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER", raising=False)
    for index in range(32):
        raw = (f"bulk-{index:03d}-" + "x" * 2048).encode()
        assert content_store.put_if_absent(runtime_dir, "payloads", raw)["ok"]

    started = threading.Event()
    written: list[bytes] = []
    failures: list[Exception] = []

    def writer() -> None:
        started.set()
        for index in range(32):
            raw = (f"racing-{index:03d}-" + "y" * 512).encode()
            deadline = time.monotonic() + 5
            while True:
                try:
                    assert content_store.put_if_absent(runtime_dir, "payloads", raw)[
                        "ok"
                    ]
                    written.append(raw)
                    break
                except RuntimeError as error:
                    if "backend_cut_in_progress" not in str(error):
                        failures.append(error)
                        return
                    if time.monotonic() >= deadline:
                        failures.append(error)
                        return
                    time.sleep(0.001)

    thread = threading.Thread(target=writer)
    thread.start()
    assert started.wait(timeout=1)
    switched = service.backend_switch(runtime_dir, target_provider=ROCKS)
    thread.join(timeout=10)

    assert not thread.is_alive()
    assert failures == []
    assert len(written) == 32
    assert switched["target_provider"] == ROCKS
    for raw in written:
        assert content_store.get(runtime_dir, "payloads", _digest(raw)) == raw


def test_process_operation_lock_rejects_a_second_switch(tmp_path, monkeypatch):
    if os.name == "nt":
        pytest.skip("POSIX qualification fixture; Windows lock path is compile-covered")
    runtime_dir = tmp_path / "runtime"
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER", raising=False)
    assert content_store.put_if_absent(runtime_dir, "payloads", b"lock fixture")["ok"]
    ready = tmp_path / "holder.ready"
    release = tmp_path / "holder.release"
    lock_path = runtime_dir / "storage" / "backend-switch.lock"
    script = """
import fcntl
import sys
import time
from pathlib import Path
lock_path, ready, release = map(Path, sys.argv[1:4])
with lock_path.open('a+b') as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    ready.write_text('ready', encoding='utf-8')
    deadline = time.monotonic() + 10
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(0.005)
"""
    holder = subprocess.Popen(
        [sys.executable, "-c", script, str(lock_path), str(ready), str(release)]
    )
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        assert ready.exists()
        with pytest.raises(RuntimeError, match="backend_switch_busy"):
            service.backend_switch(runtime_dir, target_provider=ROCKS)
        assert _binding(runtime_dir)["provider"] == FILE
        assert not (runtime_dir / "storage" / "backend-switch-state.json").exists()
    finally:
        release.write_text("release", encoding="utf-8")
        holder.wait(timeout=10)


def test_cross_process_authority_lock_fences_writes_and_final_cut(
    tmp_path, monkeypatch
):
    if os.name == "nt":
        pytest.skip("POSIX qualification fixture; Windows lock path is compile-covered")
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    assert content_store.put_if_absent(runtime_dir, "payloads", b"lock seed")["ok"]
    lock_path = runtime_dir / "storage" / "backend-authority.lock"
    holder_script = """
import fcntl
import sys
import time
from pathlib import Path
lock_path, ready, release = map(Path, sys.argv[1:4])
mode = fcntl.LOCK_EX if sys.argv[4] == 'exclusive' else fcntl.LOCK_SH
with lock_path.open('a+b') as handle:
    fcntl.flock(handle.fileno(), mode)
    ready.write_text('ready', encoding='utf-8')
    deadline = time.monotonic() + 10
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(0.005)
"""

    def hold_lock(mode: str, suffix: str):
        ready = tmp_path / f"authority-{suffix}.ready"
        release = tmp_path / f"authority-{suffix}.release"
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                holder_script,
                str(lock_path),
                str(ready),
                str(release),
                mode,
            ]
        )
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        assert ready.exists()
        return holder, release

    writer_script = """
import sys
from kungfu.storage import content_store
result = content_store.put_if_absent(sys.argv[1], 'payloads', b'cross-process write')
print(result['ok'])
"""
    holder, release = hold_lock("exclusive", "write")
    writer = subprocess.Popen(
        [sys.executable, "-c", writer_script, str(runtime_dir)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        time.sleep(0.1)
        assert writer.poll() is None
    finally:
        release.write_text("release", encoding="utf-8")
        holder.wait(timeout=10)
    stdout, stderr = writer.communicate(timeout=10)
    assert writer.returncode == 0, stderr
    assert stdout.strip() == "True"

    switch_script = """
import json
import sys
from kungfu.storage import service
print(json.dumps(service.backend_switch(sys.argv[1], target_provider='rocksdb')))
"""
    holder, release = hold_lock("shared", "cut")
    switch = subprocess.Popen(
        [sys.executable, "-c", switch_script, str(runtime_dir)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        time.sleep(0.1)
        assert switch.poll() is None
    finally:
        release.write_text("release", encoding="utf-8")
        holder.wait(timeout=10)
    stdout, stderr = switch.communicate(timeout=10)
    assert switch.returncode == 0, stderr
    assert json.loads(stdout)["target_provider"] == ROCKS


def test_pre_cut_corruption_never_publishes_target_binding(tmp_path, monkeypatch):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    raw = b"source that will be corrupted in the disposable fixture"
    assert content_store.put_if_absent(runtime_dir, "payloads", raw)["ok"]
    _object_path(runtime_dir, "payloads", raw).write_bytes(b"corrupt")

    with pytest.raises(RuntimeError, match="content_object_corrupt"):
        service.backend_switch(runtime_dir, target_provider=ROCKS)

    assert _binding(runtime_dir)["provider"] == FILE
    assert _binding(runtime_dir)["generation"] == 1
    assert not (runtime_dir / "storage" / "backend-switch-state.json").exists()


def test_rollback_reverse_syncs_new_objects_and_restart_observes_binding(
    tmp_path, monkeypatch
):
    runtime_dir = tmp_path / "runtime"
    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    original = b"before switch"
    assert content_store.put_if_absent(runtime_dir, "payloads", original)["ok"]
    service.backend_switch(runtime_dir, target_provider=ROCKS)
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER")

    after = b"written only after rocks became authoritative"
    assert content_store.put_if_absent(runtime_dir, "payloads", after)["ok"]
    assert not _object_path(runtime_dir, "payloads", after).exists()

    monkeypatch.setenv("KUNGFU_STORAGE_PROVIDER", FILE)
    rolled_back = service.backend_rollback(runtime_dir, expected_generation=2)

    assert rolled_back["action"] == "rollback"
    assert rolled_back["source_provider"] == ROCKS
    assert rolled_back["target_provider"] == FILE
    assert rolled_back["target_generation"] == 3
    assert _object_path(runtime_dir, "payloads", after).read_bytes() == after
    assert _binding(runtime_dir)["provider"] == FILE
    assert _binding(runtime_dir)["previous_provider"] == ROCKS

    script = """
import json
import sys
from kungfu.storage import content_store, service
status = service.backend_status(sys.argv[1])
payload = content_store.get(sys.argv[1], 'payloads', sys.argv[2])
print(json.dumps({'provider': status['provider'], 'generation': status['binding']['generation'], 'payload': payload.decode()}))
"""
    env = os.environ.copy()
    env.pop("KUNGFU_STORAGE_PROVIDER", None)
    restarted = subprocess.run(
        [sys.executable, "-c", script, str(runtime_dir), _digest(after)],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    observed = json.loads(restarted.stdout)
    assert observed == {
        "provider": FILE,
        "generation": 3,
        "payload": after.decode(),
    }


def test_cli_exposes_the_same_switch_receipt_and_status(tmp_path, monkeypatch):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    monkeypatch.delenv("KUNGFU_STORAGE_PROVIDER", raising=False)
    assert content_store.put_if_absent(runtime_dir, "payloads", b"cli fixture")["ok"]
    runner = CliRunner()

    switched = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "backend",
            "switch",
            "--to",
            ROCKS,
            "--expected-generation",
            "1",
            "--json",
        ],
    )
    assert switched.exit_code == 0, switched.output
    receipt = json.loads(switched.output)
    assert receipt["schema"] == "kungfu.storage.backend-switch-receipt/v1"
    assert receipt["target_provider"] == ROCKS
    assert receipt["target_generation"] == 2

    status = runner.invoke(
        kfc,
        ["--home", str(home), "storage", "backend", "status", "--json"],
    )
    assert status.exit_code == 0, status.output
    observed = json.loads(status.output)
    assert observed["provider"] == ROCKS
    assert observed["binding"]["operation_id"] == receipt["operation_id"]


def test_capabilities_declare_backend_authority_and_provider_availability():
    capabilities = service.service_capabilities()
    providers = {item["name"]: item for item in capabilities["providers"]}

    assert providers[FILE]["available"] is True
    assert providers[ROCKS]["available"] is True
    assert capabilities["backend_authority"] == {
        "schema": "kungfu.storage.backend-binding/v1",
        "status_operation": "backend_status",
        "switch_operation": "backend_switch",
        "rollback_operation": "backend_rollback",
        "cutover": "copy-verify-atomic-binding",
        "retained_provider_write_fenced": True,
        "cross_machine_consensus": False,
    }
