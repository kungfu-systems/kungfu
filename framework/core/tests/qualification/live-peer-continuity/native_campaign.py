# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import psutil


SCHEMA = "kungfu.runtime.live-peer-continuity-campaign/v1"


def _append_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_markers(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text("utf-8").splitlines()]


def _write_authority(
    path: Path, runtime_generation: str, coordinator_epoch: str
) -> None:
    _append_json(
        path,
        {
            "runtimeGeneration": runtime_generation,
            "coordinatorEpoch": coordinator_epoch,
        },
    )


def _wait_for_markers(
    path: Path, count: int, timeout: float = 20.0
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        markers = _read_markers(path)
        if len(markers) >= count:
            return markers
        time.sleep(0.1)
    raise RuntimeError(f"timed out waiting for {count} peer ready markers")


def _wait_for_process_exit(
    process: subprocess.Popen[Any], timeout: float = 5.0
) -> None:
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)


def _wait_for_coordinator_storage(
    runtime_dir: Path,
    process: subprocess.Popen[Any],
    timeout: float = 20.0,
) -> None:
    current = runtime_dir / "map" / "system" / "master" / "master" / "live" / "CURRENT"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if current.is_file():
            return
        return_code = process.poll()
        if return_code is not None:
            raise RuntimeError(
                f"Coordinator exited with code {return_code} before storage readiness"
            )
        time.sleep(0.1)
    raise RuntimeError("timed out waiting for Coordinator storage readiness")


def _stop_test_process(process: subprocess.Popen[Any] | None, *, hard: bool) -> None:
    if process is None or process.poll() is not None:
        return
    if hard:
        process.send_signal(getattr(signal, "SIGKILL", signal.SIGTERM))
    else:
        process.terminate()
    _wait_for_process_exit(process)


def _run_coordinator(
    runtime_dir: Path, runtime_generation: str, coordinator_epoch: str
) -> int:
    from kungfu import runtime_service

    print(
        json.dumps(
            {
                "event": "coordinator-starting",
                "pid": os.getpid(),
                "runtimeGeneration": runtime_generation,
                "coordinatorEpoch": coordinator_epoch,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    engine = runtime_service.CoordinatorEngine(
        str(runtime_dir.parent),
        str(runtime_dir),
        runtime_generation=runtime_generation,
        coordinator_epoch=coordinator_epoch,
    )
    try:
        engine.run()
    finally:
        engine.close()
    return 0


def _run_peer(runtime_dir: Path, marker_path: Path) -> int:
    import kungfu
    from pykungfu.runtime import peer as NativePeer

    yjj = kungfu.__binding__.runtime
    enums = kungfu.__binding__.yijinjing.enums

    class ProbePeer(NativePeer):
        def __init__(self) -> None:
            location = yjj.location(
                enums.mode.LIVE,
                enums.location_role.SYSTEM,
                "qualification",
                "continuity-probe",
                yjj.locator(str(runtime_dir)),
            )
            super().__init__(location, False, "{}")

        def on_start(self) -> None:
            from kungfu import peer_lifecycle

            lifecycle = peer_lifecycle.declare_ready_from_environment(
                {"registration": "native-peer-on-start"}
            )
            _append_json(
                marker_path,
                {
                    "event": "peer-ready",
                    "pid": os.getpid(),
                    "peerGeneration": lifecycle["peerGeneration"],
                    "hostGeneration": lifecycle["hostGeneration"],
                    "processStartIdentity": lifecycle["processStartIdentity"],
                    "readyIndex": len(_read_markers(marker_path)) + 1,
                    "observedAtNs": time.time_ns(),
                },
            )

        def on_exit(self) -> None:
            return None

    print(
        json.dumps({"event": "peer-starting", "pid": os.getpid()}, sort_keys=True),
        flush=True,
    )
    ProbePeer().run()
    return 0


def _spawn_role(
    role: str,
    runtime_dir: Path,
    log_path: Path,
    *extra: str,
) -> tuple[subprocess.Popen[Any], Any]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    stream = log_path.open("ab", buffering=0)
    process = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            role,
            "--runtime-dir",
            str(runtime_dir),
            *extra,
        ],
        stdin=subprocess.DEVNULL,
        stdout=stream,
        stderr=subprocess.STDOUT,
        env={
            **os.environ,
            "KF_HOME": str(runtime_dir.parent),
            "KF_RUNTIME_DIR": str(runtime_dir),
            "KF_CONFIG_HOME": str(runtime_dir.parent / "config"),
            "KF_LOG_LEVEL": "info",
        },
        start_new_session=True,
    )
    return process, stream


def _spawn_capsule(
    command_path: Path,
    marker_path: Path,
    rejection_path: Path,
    log_path: Path,
) -> tuple[subprocess.Popen[Any], Any]:
    stream = log_path.open("ab", buffering=0)
    process = subprocess.Popen(
        [
            os.environ.get("NODE_BINARY", "node"),
            str(Path(__file__).with_name("capsule_probe.mjs")),
            "--command-path",
            str(command_path),
            "--marker-path",
            str(marker_path),
            "--rejection-path",
            str(rejection_path),
        ],
        stdin=subprocess.DEVNULL,
        stdout=stream,
        stderr=subprocess.STDOUT,
        env=os.environ,
        start_new_session=True,
    )
    return process, stream


def _run_campaign(output_dir: Path, temp_parent: Path | None = None) -> int:
    from kungfu import peer_lifecycle

    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "report.json"
    # NNG's ipc transport inherits the platform Unix-domain socket path limit.
    # Keep this test-owned workspace short so macOS does not reject valid
    # runtime endpoints solely because $TMPDIR is deeply nested.
    with tempfile.TemporaryDirectory(prefix="kfp-", dir=temp_parent) as root:
        runtime_dir = Path(root) / "workspace" / "runtime"
        marker_path = Path(root) / "peer-ready.jsonl"
        capsule_command_path = Path(root) / "capsule-authority.jsonl"
        capsule_marker_path = Path(root) / "capsule-ready.jsonl"
        capsule_rejection_path = Path(root) / "capsule-rejection.jsonl"
        runtime_dir.mkdir(parents=True)
        coordinator: subprocess.Popen[Any] | None = None
        peer_spec: dict[str, Any] | None = None
        capsule: subprocess.Popen[Any] | None = None
        streams: list[Any] = []
        started_at = time.time_ns()
        verdict = "failed"
        error: str | None = None
        try:
            coordinator, stream = _spawn_role(
                "coordinator",
                runtime_dir,
                output_dir / "coordinator-7-1.log",
                "--runtime-generation",
                "7",
                "--coordinator-epoch",
                "1",
            )
            streams.append(stream)
            _wait_for_coordinator_storage(runtime_dir, coordinator)
            peer_spec = {
                "schema": peer_lifecycle.SPEC_SCHEMA,
                "peerId": "qualification.continuity-probe",
                "command": {
                    "argv": [
                        sys.executable,
                        str(Path(__file__).resolve()),
                        "peer",
                        "--runtime-dir",
                        str(runtime_dir),
                        "--marker-path",
                        str(marker_path),
                    ]
                },
                "readiness": {"kind": "file-handshake", "timeoutSeconds": 120},
                "recovery": {
                    "schema": peer_lifecycle.RECOVERY_SCHEMA,
                    "processExit": "restart",
                    "durableState": "declared",
                    "maxRestarts": 3,
                    "windowSeconds": 60,
                    "guidance": "The qualification Peer has no volatile workload state and re-registers from its declaration.",
                },
                "metadata": {"qualification": "live-peer-continuity"},
            }
            hosted = peer_lifecycle.ensure(peer_spec, runtime_dir)
            if not hosted["healthy"]:
                raise RuntimeError(
                    f"Peer lifecycle host did not reach Ready: {hosted['lifecycleState']}"
                )
            first = _wait_for_markers(marker_path, 1)
            peer_host_pid = int(hosted["host"]["pid"])
            peer_host_generation = int(hosted["host"]["generation"])
            peer_pid = int(first[0]["pid"])
            peer_generation = int(first[0]["peerGeneration"])
            capsule, stream = _spawn_capsule(
                capsule_command_path,
                capsule_marker_path,
                capsule_rejection_path,
                output_dir / "capsule.log",
            )
            streams.append(stream)
            _write_authority(capsule_command_path, "7", "1")
            capsule_first = _wait_for_markers(capsule_marker_path, 1)
            capsule_pid = capsule.pid
            capsule_process_identity = capsule_first[0]["providerProcessStartIdentity"]

            _stop_test_process(coordinator, hard=True)
            coordinator, stream = _spawn_role(
                "coordinator",
                runtime_dir,
                output_dir / "coordinator-7-2.log",
                "--runtime-generation",
                "7",
                "--coordinator-epoch",
                "2",
            )
            streams.append(stream)
            second = _wait_for_markers(marker_path, 2)
            _write_authority(capsule_command_path, "7", "2")
            capsule_second = _wait_for_markers(capsule_marker_path, 2)
            second_ready_pids = sorted({int(item["pid"]) for item in second})
            peer_status = peer_lifecycle.status(
                runtime_dir, "qualification.continuity-probe"
            )
            if not peer_status["healthy"] or second_ready_pids != [peer_pid]:
                raise RuntimeError(
                    "peer process did not survive Coordinator replacement: "
                    f"peer_host_pid={peer_host_pid} peer_pid={peer_pid} "
                    f"ready_pids={second_ready_pids} "
                    f"lifecycle={peer_status['lifecycleState']}"
                )

            _stop_test_process(coordinator, hard=True)
            coordinator, stream = _spawn_role(
                "coordinator",
                runtime_dir,
                output_dir / "coordinator-stale-7-1.log",
                "--runtime-generation",
                "7",
                "--coordinator-epoch",
                "1",
            )
            streams.append(stream)
            _write_authority(capsule_command_path, "7", "1")
            time.sleep(4.5)
            if len(_read_markers(marker_path)) != 2:
                raise RuntimeError("stale Coordinator authority reached Peer readiness")
            capsule_rejections = _read_markers(capsule_rejection_path)
            if (
                len(_read_markers(capsule_marker_path)) != 2
                or len(capsule_rejections) != 1
                or capsule_rejections[0].get("code") != "stale_coordinator"
            ):
                raise RuntimeError(
                    "stale Coordinator authority reached Capsule readiness"
                )

            _stop_test_process(coordinator, hard=True)
            coordinator, stream = _spawn_role(
                "coordinator",
                runtime_dir,
                output_dir / "coordinator-8-1.log",
                "--runtime-generation",
                "8",
                "--coordinator-epoch",
                "1",
            )
            streams.append(stream)
            final = _wait_for_markers(marker_path, 3)
            _write_authority(capsule_command_path, "8", "1")
            capsule_final = _wait_for_markers(capsule_marker_path, 3)
            ready_pids = sorted({int(item["pid"]) for item in final})
            peer_status = peer_lifecycle.status(
                runtime_dir, "qualification.continuity-probe"
            )
            if not peer_status["healthy"] or ready_pids != [peer_pid]:
                raise RuntimeError(
                    "runtime generation replacement did not preserve the Peer workload: "
                    f"peer_host_pid={peer_host_pid} peer_pid={peer_pid} "
                    f"ready_pids={ready_pids} "
                    f"lifecycle={peer_status['lifecycleState']}"
                )
            if [len(first), len(second), len(final)] != [1, 2, 3]:
                raise RuntimeError("unexpected Peer readiness sequence")
            if (
                capsule.poll() is not None
                or {item["pid"] for item in capsule_final} != {capsule_pid}
                or {item["providerProcessStartIdentity"] for item in capsule_final}
                != {capsule_process_identity}
                or {item["sessionStreamEpoch"] for item in capsule_final} != {"1"}
                or [len(capsule_first), len(capsule_second), len(capsule_final)]
                != [1, 2, 3]
            ):
                raise RuntimeError(
                    "Capsule workload identity did not survive Coordinator replacement"
                )

            # Hard-kill only the generic host.  The native Peer must remain
            # alive, become an adoptable orphan, and be fenced-adopted by a new
            # host generation without another Peer on_start event.
            peer_host_process = psutil.Process(peer_host_pid)
            peer_host_process.kill()
            peer_host_process.wait(timeout=5)
            orphan_deadline = time.monotonic() + 5
            orphan = peer_lifecycle.status(
                runtime_dir, "qualification.continuity-probe"
            )
            while time.monotonic() < orphan_deadline and not orphan["orphaned"]:
                time.sleep(0.1)
                orphan = peer_lifecycle.status(
                    runtime_dir, "qualification.continuity-probe"
                )
            if not orphan["adoptable"] or orphan["peer"]["pid"] != peer_pid:
                raise RuntimeError(
                    f"host crash did not expose an adoptable Peer: {orphan}"
                )
            adopted = peer_lifecycle.ensure(peer_spec, runtime_dir)
            if (
                not adopted["healthy"]
                or adopted["host"]["generation"] != peer_host_generation + 1
                or adopted["peer"]["pid"] != peer_pid
                or len(_read_markers(marker_path)) != 3
            ):
                raise RuntimeError(f"fenced Peer adoption failed: {adopted}")

            # A stale controller generation must not be able to stop the newly
            # adopted Peer.
            try:
                peer_lifecycle.stop(
                    runtime_dir,
                    "qualification.continuity-probe",
                    expected_host_generation=peer_host_generation,
                    timeout=0,
                )
            except peer_lifecycle.PeerLifecycleError as stale:
                if stale.code != "stale-host-generation":
                    raise
            else:
                raise RuntimeError("stale Peer host generation was not rejected")

            # Hard-kill the Peer itself.  The restartable declaration must
            # produce a new fenced Peer generation and a different process.
            psutil.Process(peer_pid).kill()
            restarted_markers = _wait_for_markers(marker_path, 4)
            restarted = peer_lifecycle.status(
                runtime_dir, "qualification.continuity-probe"
            )
            restart_deadline = time.monotonic() + 5
            while time.monotonic() < restart_deadline and not restarted["healthy"]:
                time.sleep(0.1)
                restarted = peer_lifecycle.status(
                    runtime_dir, "qualification.continuity-probe"
                )
            restarted_pid = int(restarted_markers[-1]["pid"])
            if (
                not restarted["healthy"]
                or restarted_pid == peer_pid
                or int(restarted_markers[-1]["peerGeneration"]) != peer_generation + 1
                or restarted["restartAttempts"] != 1
            ):
                raise RuntimeError(f"bounded Peer restart failed: {restarted}")
            verdict = "passed"
        except Exception as failure:  # noqa: BLE001
            error = str(failure)
        finally:
            _stop_test_process(coordinator, hard=True)
            if peer_spec is not None:
                try:
                    peer_lifecycle.stop(runtime_dir, "qualification.continuity-probe")
                except peer_lifecycle.PeerLifecycleError:
                    pass
            _stop_test_process(capsule, hard=False)
            for stream in streams:
                stream.close()

        logs = []
        for log_path in sorted(output_dir.glob("*.log")):
            logs.append(
                {
                    "path": log_path.name,
                    "sha256": _sha256(log_path),
                    "bytes": log_path.stat().st_size,
                }
            )
        report = {
            "schema": SCHEMA,
            "verdict": verdict,
            "startedAtNs": str(started_at),
            "completedAtNs": str(time.time_ns()),
            "platform": {"os": sys.platform, "machine": platform.machine()},
            "coverage": {
                "hardCoordinatorCrash": verdict == "passed",
                "sameGenerationEpochAdvance": verdict == "passed",
                "staleCoordinatorRejected": verdict == "passed",
                "runtimeGenerationAdvance": verdict == "passed",
                "peerPidPreserved": verdict == "passed",
                "capsulePidPreserved": verdict == "passed",
                "capsuleStreamEpochPreserved": verdict == "passed",
                "capsuleStaleAuthorityRejected": verdict == "passed",
                "independentPeerHost": verdict == "passed",
                "peerHostCrashAdopted": verdict == "passed",
                "staleHostGenerationRejected": verdict == "passed",
                "peerCrashRestarted": verdict == "passed",
                "peerGenerationAdvanced": verdict == "passed",
            },
            "claims": {
                "singleHostProcessContinuity": verdict == "passed",
                "physicalPowerLoss": False,
                "crossHostHighAvailability": False,
            },
            "rawLogs": logs,
            "error": error,
        }
        report_path.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8"
        )
        print(json.dumps(report, sort_keys=True))
        return 0 if verdict == "passed" else 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="role", required=True)
    coordinator = subparsers.add_parser("coordinator")
    coordinator.add_argument("--runtime-dir", type=Path, required=True)
    coordinator.add_argument("--runtime-generation", required=True)
    coordinator.add_argument("--coordinator-epoch", required=True)
    peer = subparsers.add_parser("peer")
    peer.add_argument("--runtime-dir", type=Path, required=True)
    peer.add_argument("--marker-path", type=Path, required=True)
    campaign = subparsers.add_parser("campaign")
    campaign.add_argument("--output-dir", type=Path, required=True)
    campaign.add_argument("--temp-parent", type=Path)
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.role == "coordinator":
        return _run_coordinator(
            args.runtime_dir, args.runtime_generation, args.coordinator_epoch
        )
    if args.role == "peer":
        return _run_peer(args.runtime_dir, args.marker_path)
    return _run_campaign(args.output_dir, args.temp_parent)


if __name__ == "__main__":
    raise SystemExit(main())
