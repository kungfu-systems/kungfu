"""Fail-closed ambient capability qualification for Python KFX services."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    ("operation", "source"),
    [
        (
            "network",
            "import socket\nsocket.create_connection(('127.0.0.1', 1), timeout=0.01)",
        ),
        (
            "process",
            "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'pass'])",
        ),
        (
            "storage",
            "open('forbidden-write.txt', 'w', encoding='utf-8').write('no')",
        ),
    ],
)
def test_ambient_effect_without_grant_fails_closed(tmp_path, operation, source):
    program = (
        "from kungfu.kfx_host import install_ambient_capability_audit\n"
        "install_ambient_capability_audit(set())\n"
        f"{source}\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=tmp_path,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert result.returncode != 0
    assert "KF_KFX_CAPABILITY_DENIED" in result.stderr
    assert operation in result.stderr
    assert not (tmp_path / "forbidden-write.txt").exists()


def test_storage_write_with_exact_grant_succeeds(tmp_path):
    target = tmp_path / "allowed-write.txt"
    program = (
        "from kungfu.kfx_host import install_ambient_capability_audit\n"
        "install_ambient_capability_audit({'storage'})\n"
        f"open({str(target)!r}, 'w', encoding='utf-8').write('ok')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=tmp_path,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert target.read_text() == "ok"


def test_process_grant_allows_anonymous_stdio_pipes_without_storage(tmp_path):
    program = (
        "import subprocess, sys\n"
        "from kungfu.kfx_host import install_ambient_capability_audit\n"
        "install_ambient_capability_audit({'process'})\n"
        "result = subprocess.run(\n"
        "    [sys.executable, '-I', '-S', '-c', 'raise SystemExit(0)'],\n"
        "    stdin=subprocess.PIPE,\n"
        "    stdout=subprocess.PIPE,\n"
        "    stderr=subprocess.PIPE,\n"
        ")\n"
        "raise SystemExit(result.returncode)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=tmp_path,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_runtime_contract_is_machine_readable_and_matches_supported_python():
    contract_path = (
        Path(__file__).resolve().parents[4]
        / "docs/qualification/python-kfx-asyncio-runtime.contract.json"
    )
    import json

    contract = json.loads(contract_path.read_text())
    assert contract["schema"] == "kungfu.python-kfx-asyncio-runtime-contract/v1"
    assert contract["supportedPython"] == ">=3.13,<3.14"
    assert (
        "asyncio-private-scheduling-fields" in contract["forbiddenProductionCoupling"]
    )
