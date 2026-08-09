# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import time

import pytest


if importlib.util.find_spec("pykungfu") is None:
    pytest.skip("native pykungfu binding is not built", allow_module_level=True)

from click.testing import CliRunner  # noqa: E402

from kungfu.cli.commands import __registry__  # noqa: E402,F401
from kungfu.cli.commands import kfc  # noqa: E402
from kungfu.storage import service  # noqa: E402


def _tree_fingerprint(root: Path):
    if not root.exists():
        return []
    return sorted(
        (
            str(path.relative_to(root)),
            path.stat().st_size if path.is_file() else None,
            path.read_bytes() if path.is_file() else None,
        )
        for path in root.rglob("*")
    )


def _invoke_health(home: Path, *args: str):
    result = CliRunner().invoke(
        kfc,
        ["--home", str(home), "health", *args, "--json"],
        env={"KF_CONFIG_HOME": str(home / "config")},
    )
    assert result.exit_code in {0, 1, 2, 3}, result.output
    return result, json.loads(result.output)


def test_native_fast_and_deep_health_are_read_only(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"

    before_empty = _tree_fingerprint(tmp_path)
    empty_result, empty = _invoke_health(home)
    assert empty_result.exit_code == 0
    assert empty["status"] == "ready"
    assert not runtime_dir.exists()
    assert _tree_fingerprint(tmp_path) == before_empty

    service.episode_begin(
        runtime_dir,
        episode_id=41,
        location_uid=17,
        begin_time=time.time_ns(),
        title="native health read-only fixture",
    )
    before_fast = _tree_fingerprint(home)
    _, fast = _invoke_health(home)
    assert fast["mode"] == "fast"
    assert _tree_fingerprint(home) == before_fast

    before_deep = _tree_fingerprint(home)
    _, deep = _invoke_health(home, "--deep")
    assert deep["mode"] == "deep"
    assert (
        next(item for item in deep["checks"] if item["area"] == "storage")["facts"][
            "integrityScan"
        ]
        == "complete"
    )
    assert _tree_fingerprint(home) == before_deep


def test_native_fault_matrix_translates_episode_and_peer_fences(tmp_path):
    home = tmp_path / "home"
    runtime_dir = home / "runtime"
    service.episode_begin(
        runtime_dir,
        episode_id=51,
        location_uid=17,
        begin_time=1,
        title="stale native fixture",
    )
    peer_dir = runtime_dir / "peers" / "fixture-peer"
    peer_dir.mkdir(parents=True)
    (peer_dir / "state.json").write_text(
        json.dumps(
            {
                "peerId": "fixture-peer",
                "desiredState": "running",
                "lifecycleState": "ready",
                # Use a process that is provably live on every platform, then
                # falsify its creation identity. PID 1 is not inspectable on
                # all Windows runners and only proves "not ready" there.
                "hostPid": os.getpid(),
                "hostStartIdentity": "not-the-real-process-identity",
                "peerPid": None,
                "readinessState": "ready",
            }
        ),
        encoding="utf-8",
    )
    before = _tree_fingerprint(home)

    result, report = _invoke_health(home)

    assert result.exit_code == 3, report
    assert report["status"] == "blocked"
    codes = {item["code"] for item in report["problems"]}
    assert "episode_stale_recoverable" in codes
    assert "peer_ownership_unknown" in codes or "peer_not_ready" in codes
    assert _tree_fingerprint(home) == before
