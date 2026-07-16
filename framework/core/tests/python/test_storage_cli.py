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
