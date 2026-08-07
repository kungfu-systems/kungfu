# SPDX-License-Identifier: Apache-2.0

import json
import os
import select
import subprocess
import sys
import time

import pytest


def _run_provider_probe(tmp_path, provider, probe, *, input_bytes=b""):
    profile = {
        "id": f"kungfu.agent-runtime.{provider}.pty-probe",
        "provider": provider,
        "cwdPolicy": "workspace-root",
        "launch": {
            "executable": sys.executable,
            "argv": [],
            "interactiveArgv": ["-c", probe],
            "versionArgv": ["--version"],
            "shellMode": False,
        },
    }
    wrapper = (
        "from kungfu.agent import run_agent;"
        f"profile={profile!r};"
        "raise SystemExit(run_agent.run_native_interactive("
        "profile,"
        f"runtime_dir={str(tmp_path / 'runtime')!r},"
        f"config_home={str(tmp_path / 'config')!r},"
        f"runtime_home={str(tmp_path / 'home')!r},"
        f"workspace_root={str(tmp_path)!r},"
        "work_ref=None,"
        "work_selection={'schema':'kungfu.native-work-selection/v1','state':'none'}))"
    )
    master_fd, slave_fd = os.openpty()
    process = subprocess.Popen(
        [sys.executable, "-c", wrapper],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)
    if input_bytes:
        os.write(master_fd, input_bytes)
    chunks = []
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master_fd], [], [], 0.1)
            if ready:
                try:
                    chunks.append(os.read(master_fd, 65536))
                except OSError:
                    break
            if process.poll() is not None and not ready:
                break
        return_code = process.wait(timeout=1)
    finally:
        os.close(master_fd)
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=1)
    return return_code, b"".join(chunks).decode("utf-8").replace("\r", "")


@pytest.mark.skipif(not hasattr(os, "openpty"), reason="requires a POSIX PTY")
def test_native_interactive_runner_preserves_a_real_pty(tmp_path):
    probe = (
        "import json,os,sys;"
        "print(json.dumps({"
        "'stdin':sys.stdin.isatty(),"
        "'stdout':sys.stdout.isatty(),"
        "'stderr':sys.stderr.isatty(),"
        "'environment':os.environ.get('KUNGFU_AGENT_ENVIRONMENT'),"
        "'workspace':os.environ.get('KUNGFU_WORKSPACE_ROOT')}),flush=True)"
    )
    return_code, output = _run_provider_probe(tmp_path, "amp", probe)
    assert return_code == 0
    payload = json.loads(
        next(line for line in output.splitlines() if line.startswith("{"))
    )
    assert payload == {
        "stdin": True,
        "stdout": True,
        "stderr": True,
        "environment": "native-interactive",
        "workspace": str(tmp_path),
    }


@pytest.mark.skipif(not hasattr(os, "openpty"), reason="requires a POSIX PTY")
def test_codex_first_project_trust_prompt_round_trips_through_the_provider_pty(
    tmp_path,
):
    probe = (
        "print('Trust this project? [y/N]',flush=True);"
        "answer=input().strip().lower();"
        "print('KUNGFU_CODEX_TRUST_OK' if answer=='y' else 'TRUST_REJECTED',flush=True);"
        "raise SystemExit(0 if answer=='y' else 1)"
    )
    return_code, output = _run_provider_probe(
        tmp_path, "codex", probe, input_bytes=b"y\n"
    )
    assert return_code == 0, output
    assert "Trust this project? [y/N]" in output
    assert "KUNGFU_CODEX_TRUST_OK" in output
