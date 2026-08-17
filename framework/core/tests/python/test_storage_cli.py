# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from click.testing import CliRunner

from kungfu.cli.commands import __registry__  # noqa: F401
from kungfu.cli.commands import kfc
from kungfu.content_hash import compute_content_hash_value
from kungfu.storage import service


@contextmanager
def _hold_manifest_writer_guard(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as holder:
        if os.name == "nt":
            import msvcrt

            if lock_path.stat().st_size == 0:
                holder.write(b"\0")
                holder.flush()
            holder.seek(0)
            msvcrt.locking(holder.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                holder.seek(0)
                msvcrt.locking(holder.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(holder.fileno(), fcntl.LOCK_UN)


def _episode_cli_process(
    home: Path, *args: str, ready_path: Path | None = None
) -> subprocess.Popen:
    python_root = Path(__file__).resolve().parents[2] / "src" / "python"
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        value for value in [str(python_root), env.get("PYTHONPATH", "")] if value
    )
    if ready_path is not None:
        env["KUNGFU_TEST_CLI_READY_PATH"] = str(ready_path)
    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import os; from pathlib import Path; "
            "from kungfu.cli.commands import main; "
            "ready = os.environ.get('KUNGFU_TEST_CLI_READY_PATH'); "
            "ready and Path(ready).write_text('ready', encoding='utf-8'); "
            "main()",
            "--home",
            str(home),
            "storage",
            "episode",
            *args,
            "--json",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _fact_material_cli_process(
    home: Path,
    payload_path: Path,
    *,
    source: str,
    subject: str,
    observation_id: str,
    ready_path: Path,
    release_path: Path,
) -> subprocess.Popen:
    python_root = Path(__file__).resolve().parents[2] / "src" / "python"
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        value for value in [str(python_root), env.get("PYTHONPATH", "")] if value
    )
    env["KUNGFU_TEST_CLI_READY_PATH"] = str(ready_path)
    env["KUNGFU_TEST_CLI_RELEASE_PATH"] = str(release_path)
    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import os, time; from pathlib import Path; "
            "from kungfu.cli.commands import main; "
            "ready = Path(os.environ['KUNGFU_TEST_CLI_READY_PATH']); "
            "release = Path(os.environ['KUNGFU_TEST_CLI_RELEASE_PATH']); "
            "ready.write_text('ready', encoding='utf-8'); "
            "exec('deadline = time.monotonic() + 10\\nwhile not release.exists() and "
            "time.monotonic() < deadline:\\n    time.sleep(0.005)'); "
            "release.exists() or (_ for _ in ()).throw(RuntimeError('release barrier timed out')); "
            "main()",
            "--home",
            str(home),
            "facts",
            "material",
            "put",
            "--type",
            "qualification-job-facts",
            "--type-version",
            "v1",
            "--source",
            source,
            "--subject",
            subject,
            "--payload-file",
            str(payload_path),
            "--observation-id",
            observation_id,
            "--action",
            "assert",
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _collect(processes: list[subprocess.Popen]) -> list[dict]:
    results = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, f"stdout={stdout}\nstderr={stderr}"
        results.append(json.loads(stdout))
    return results


def test_storage_layout_inherits_the_complete_runtime_context(tmp_path):
    home = tmp_path / "home"

    result = CliRunner().invoke(
        kfc, ["--home", str(home), "storage", "layout", "--json"]
    )

    assert result.exit_code == 0, result.output
    layout = json.loads(result.output)
    assert layout["runtime_dir"] == str(home / "runtime")


def test_storage_layout_verify_fails_on_unclassified_runtime_path(tmp_path):
    home = tmp_path / "home"
    undeclared = home / "runtime" / "undeclared-future-store"
    undeclared.mkdir(parents=True)

    result = CliRunner().invoke(
        kfc, ["--home", str(home), "storage", "layout", "--verify", "--json"]
    )

    assert result.exit_code == 1, result.output
    layout = json.loads(result.output)
    assert layout["coverage"]["complete"] is False
    assert layout["coverage"]["unclassified_durable_candidates"] == [str(undeclared)]


def test_episode_attach_payload_cli_publishes_verifiable_content(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    payload = tmp_path / "course-outline.json"
    payload.write_text('{"sections":3}\n', encoding="utf-8")
    service.episode_begin(runtime_dir, episode_id=42, begin_time=1)

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "episode",
            "attach-payload",
            "--episode-id",
            "42",
            "--path",
            str(payload),
            "--ref-id",
            "course-outline.json",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    attached = json.loads(result.output)
    assert attached["payload_reference"]["ref_id"] == "course-outline.json"
    assert attached["payload_reference"]["ref_hash"].startswith("sha256:")
    service.episode_end(runtime_dir, episode_id=42, end_time=2)
    assert service.fsck(runtime_dir, episode_id=42, verify_frames=True)["ok"] is True


def test_episode_attach_payload_cli_rejects_a_false_content_hash(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    payload = tmp_path / "course-outline.json"
    payload.write_text('{"sections":3}\n', encoding="utf-8")
    service.episode_begin(runtime_dir, episode_id=43, begin_time=1)

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "episode",
            "attach-payload",
            "--episode-id",
            "43",
            "--path",
            str(payload),
            "--content-hash",
            f"sha256:{'0' * 64}",
            "--json",
        ],
    )

    assert result.exit_code != 0
    assert "does not match the bytes" in str(result.exception)
    inspected = service.episode_inspect(runtime_dir, episode_id=43)
    assert inspected.get("refs", []) == []


def test_episode_attach_payload_cli_preserves_bare_digest_compatibility(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    payload = tmp_path / "course-outline.json"
    payload.write_text('{"sections":3}\n', encoding="utf-8")
    digest = compute_content_hash_value(payload.read_bytes())
    service.episode_begin(runtime_dir, episode_id=44, begin_time=1)

    result = CliRunner().invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "episode",
            "attach-payload",
            "--episode-id",
            "44",
            "--path",
            str(payload),
            "--content-hash",
            digest,
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    attached = json.loads(result.output)
    assert attached["payload_reference"]["ref_hash"] == f"sha256:{digest}"


def test_episode_recover_cli_plans_then_executes_a_fenced_abort(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    service.episode_begin(
        runtime_dir,
        episode_id=41,
        location_uid=17,
        begin_time=1,
        title="interrupted",
    )
    runner = CliRunner()

    planned = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "episode",
            "recover",
            "--episode-id",
            "41",
            "--stale-after-seconds",
            "0",
            "--plan",
            "--json",
        ],
    )
    assert planned.exit_code == 0, planned.output
    plan = json.loads(planned.output)
    assert plan["eligible"] is True
    assert plan["writer"]["status"] == "absent"

    executed = runner.invoke(
        kfc,
        [
            "--home",
            str(home),
            "storage",
            "episode",
            "recover",
            "--episode-id",
            "41",
            "--stale-after-seconds",
            "0",
            "--execute",
            "--reason",
            "CLI fixture",
            "--json",
        ],
    )
    assert executed.exit_code == 0, executed.output
    receipt = json.loads(executed.output)
    assert receipt["ok"] is True
    assert receipt["fence"]["resourceId"] == "00000011.00000000"
    inspected = service.episode_inspect(runtime_dir, episode_id=41)
    assert inspected["episode"]["close"]["status"] == 3
    assert inspected["episode"]["close"]["reason"] == "CLI fixture"


def test_episode_cli_absorbs_real_multi_process_manifest_contention(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    service.episode_begin(runtime_dir, episode_id=1, begin_time=1)
    service.episode_end(runtime_dir, episode_id=1, end_time=2)
    lock_path = (
        runtime_dir
        / "journal"
        / "system"
        / "storage"
        / "episode-manifest"
        / "live"
        / "writer.lock"
    )

    episode_ids = list(range(1001, 1009))
    ready_path = tmp_path / "first-cli-imported"
    with _hold_manifest_writer_guard(lock_path):
        begins = [
            _episode_cli_process(
                home,
                "begin",
                "--episode-id",
                str(episode_id),
                "--title",
                f"shell-{episode_id}",
                "--actor",
                "pytest",
                "--source",
                "multi-shell",
                ready_path=ready_path,
            )
            for episode_id in episode_ids
        ]
        # Wait for at least one independently imported public CLI before
        # releasing the native guard. This proves the retry path without
        # assuming a platform-specific Python startup duration.
        deadline = time.monotonic() + 10
        while not ready_path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready_path.exists(), "no public CLI reached command dispatch"
        time.sleep(0.2)
    begin_results = _collect(begins)

    ends = [
        _episode_cli_process(
            home,
            "end",
            "--episode-id",
            str(episode_id),
            "--reason",
            "multi-shell complete",
        )
        for episode_id in episode_ids
    ]
    end_results = _collect(ends)

    assert all(result["write_retry"]["exhausted"] is False for result in begin_results)
    assert sum(result["write_retry"]["busyRetries"] for result in begin_results) > 0
    assert all(result["write_retry"]["exhausted"] is False for result in end_results)

    listed = service.episode_list(runtime_dir, limit=0)
    listed_ids = {int(item["episode_id"]) for item in listed["episodes"]}
    assert set(episode_ids).issubset(listed_ids)
    for episode_id in episode_ids:
        inspected = service.episode_inspect(runtime_dir, episode_id=episode_id)
        assert inspected["episode"]["close"]["status"] == 2
        fsck = service.fsck(runtime_dir, episode_id=episode_id)
        assert fsck["ok"], fsck


def test_fact_cli_queues_real_multi_process_material_writers(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    writer_count = 8
    sources = [f"agent-{index}" for index in range(writer_count)]
    service.fact_type_create(
        runtime_dir,
        {
            "id": "qualification-job-facts",
            "version": "v1",
            "source_authorities": sources,
            "schema": {
                "type": "object",
                "properties": {"writer": {"type": "string"}},
                "required": ["writer"],
                "additionalProperties": False,
            },
        },
    )

    release_path = tmp_path / "release-fact-writers"
    ready_paths = [
        tmp_path / f"fact-writer-{index}.ready" for index in range(writer_count)
    ]
    payload_paths = [
        tmp_path / f"fact-writer-{index}.json" for index in range(writer_count)
    ]
    for index, payload_path in enumerate(payload_paths):
        payload_path.write_text(
            json.dumps({"writer": sources[index]}), encoding="utf-8"
        )
    processes = [
        _fact_material_cli_process(
            home,
            payload_paths[index],
            source=sources[index],
            subject=f"job-{index}",
            observation_id=f"obs-{index}",
            ready_path=ready_paths[index],
            release_path=release_path,
        )
        for index in range(writer_count)
    ]

    deadline = time.monotonic() + 10
    while (
        not all(path.exists() for path in ready_paths) and time.monotonic() < deadline
    ):
        time.sleep(0.01)
    assert all(path.exists() for path in ready_paths), (
        "not every public CLI reached command dispatch"
    )
    release_path.write_text("go", encoding="utf-8")
    results = _collect(processes)

    assert all(
        result["schema"] == "kungfu.facts.material-write/v1" for result in results
    )
    assert all(result["ok"] is True for result in results)
    assert all(
        result["receipt"]["admission"]["outcome"] == "admitted" for result in results
    )
    contract = service.fact_library_contract(runtime_dir)
    assert contract["writer_admission"] == {
        "mode": "bounded-core-wait/v1",
        "timeout_ms": 5000,
        "physical_writer": "single",
        "concurrent_clients": "queued-before-read",
    }
    catalog = service.fact_material_list(runtime_dir, type_id="qualification-job-facts")
    assert {
        row["observation_id"] for row in catalog["state"]["observation_history"]
    } == {f"obs-{index}" for index in range(writer_count)}
    for result in results:
        episode_id = int(result["receipt"]["episode_id"])
        assert service.fsck(runtime_dir, episode_id=episode_id)["ok"]
