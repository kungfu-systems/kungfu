# SPDX-License-Identifier: Apache-2.0
"""Real-surface worker for the Episode qualification harness.

The Node coordinator owns profiles, processes, timeouts, and the final Trust
Report. This module owns only two product-facing actions:

* write a deterministic range of metadata-only Episodes;
* probe a completed runtime through list/inspect/fsck/recovery.

All Episode work goes through ``kungfu.storage.service``. Journal bytes are
never parsed or mutated here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys
import time
from typing import Any, Callable


CORE_DIR = Path(__file__).resolve().parents[3]


def _load_service() -> Any:
    sys.path.insert(0, str(CORE_DIR / "src" / "python"))
    sys.path.insert(0, str(CORE_DIR / "dist" / "kungfu"))
    from kungfu.storage import service

    return service


def _write_json(path: str | Path, value: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, target)


def _quantile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(0, math.ceil(q * len(sorted_values)) - 1)
    return sorted_values[index]


def _distribution(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "min": ordered[0] if ordered else 0.0,
        "mean": sum(ordered) / len(ordered) if ordered else 0.0,
        "p50": _quantile(ordered, 0.50),
        "p95": _quantile(ordered, 0.95),
        "p99": _quantile(ordered, 0.99),
        "max": ordered[-1] if ordered else 0.0,
    }


def _process_resources() -> tuple[int, int | None]:
    try:
        import psutil

        process = psutil.Process()
        rss = int(process.memory_info().rss)
        if hasattr(process, "num_fds"):
            descriptors = int(process.num_fds())
        elif hasattr(process, "num_handles"):
            descriptors = int(process.num_handles())
        else:
            descriptors = None
        return rss, descriptors
    except Exception:
        return 0, None


def _disk_observation(runtime_dir: Path) -> dict[str, int]:
    total_bytes = 0
    file_count = 0
    journal_files = 0
    for path in runtime_dir.rglob("*") if runtime_dir.exists() else []:
        if not path.is_file():
            continue
        file_count += 1
        try:
            total_bytes += path.stat().st_size
        except OSError:
            continue
        if path.suffix == ".journal":
            journal_files += 1
    return {
        "runtime_bytes": total_bytes,
        "runtime_files": file_count,
        "journal_files": journal_files,
    }


def _episode_id(seed: int, index: int) -> int:
    # Keep the generated id non-zero, stable, and comfortably inside uint64.
    return ((seed & 0x7FFFFFFF) << 32) | (index + 1)


def _episode_expected(
    *,
    seed: int,
    index: int,
    mode: str,
    logical_agents: int,
    abort_every: int,
) -> dict[str, Any]:
    ordinal = index + 1
    aborted = abort_every > 0 and ordinal % abort_every == 0
    token = hashlib.blake2b(f"{seed}:{index}".encode(), digest_size=8).hexdigest()
    return {
        "episode_id": _episode_id(seed, index),
        "title": f"qualification-{token}",
        "actor": f"agent-{index % logical_agents}",
        "source": f"qualification/{mode}/v1",
        "status": "aborted" if aborted else "ended",
        "begin_time": 1_000_000_000_000 + (seed % 1_000_000) * 1_000_000 + index * 2,
        "end_time": 1_000_000_000_001 + (seed % 1_000_000) * 1_000_000 + index * 2,
    }


class WriteState:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.rng = random.Random(args.seed ^ (args.worker_id << 16))
        self.successful_appends = 0
        self.busy = 0
        self.retry_count = 0
        self.retry_exhausted = 0
        self.unexpected_errors: list[dict[str, Any]] = []
        self.progress_timeouts = 0
        self.open_latency_ms: list[float] = []
        self.close_latency_ms: list[float] = []
        self.last_progress = time.perf_counter()
        self.longest_no_progress_ms = 0.0
        self.max_rss_bytes = 0
        self.max_descriptors: int | None = None

    def sample_resources(self) -> None:
        rss, descriptors = _process_resources()
        self.max_rss_bytes = max(self.max_rss_bytes, rss)
        if descriptors is not None:
            self.max_descriptors = max(self.max_descriptors or 0, descriptors)

    def mark_progress(self) -> None:
        now = time.perf_counter()
        self.longest_no_progress_ms = max(
            self.longest_no_progress_ms, (now - self.last_progress) * 1000
        )
        self.last_progress = now
        self.successful_appends += 1

    def call(
        self,
        *,
        operation: str,
        episode_id: int,
        invoke: Callable[[], Any],
        latencies: list[float],
    ) -> bool:
        attempt = 0
        while True:
            started = time.perf_counter()
            try:
                invoke()
                latencies.append((time.perf_counter() - started) * 1000)
                self.mark_progress()
                return True
            except RuntimeError as error:
                message = str(error)
                if "manifest_writer_busy" not in message:
                    self.unexpected_errors.append(
                        {
                            "operation": operation,
                            "episode_id": episode_id,
                            "error": message[:500],
                        }
                    )
                    return False
                self.busy += 1
                if attempt >= self.args.max_attempts:
                    self.retry_exhausted += 1
                    return False
                no_progress_ms = (time.perf_counter() - self.last_progress) * 1000
                if no_progress_ms > self.args.progress_timeout_ms:
                    self.progress_timeouts += 1
                    return False
                self.retry_count += 1
                exponent = min(attempt, 20)
                delay_ms = min(
                    self.args.max_delay_ms,
                    self.args.initial_delay_ms * (2**exponent),
                )
                jittered_ms = delay_ms * (0.5 + self.rng.random())
                time.sleep(jittered_ms / 1000)
                attempt += 1
            except Exception as error:
                self.unexpected_errors.append(
                    {
                        "operation": operation,
                        "episode_id": episode_id,
                        "error": f"{type(error).__name__}: {error}"[:500],
                    }
                )
                return False


def _wait_for_start(start_at_ms: int) -> None:
    while True:
        remaining = start_at_ms / 1000 - time.time()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 0.01))


def run_write(args: argparse.Namespace) -> dict[str, Any]:
    service = _load_service()
    state = WriteState(args)
    runtime_dir = Path(args.runtime_dir)
    runtime_dir.mkdir(parents=True, exist_ok=True)
    if args.start_at_ms:
        _wait_for_start(args.start_at_ms)

    started = time.perf_counter()
    completed = 0
    state.sample_resources()
    for offset in range(args.count):
        index = args.start_index + offset
        expected = _episode_expected(
            seed=args.seed,
            index=index,
            mode=args.mode,
            logical_agents=args.logical_agents,
            abort_every=args.abort_every,
        )
        episode_id = int(expected["episode_id"])
        location_uid = args.worker_id + 1
        opened = state.call(
            operation="episode_begin",
            episode_id=episode_id,
            latencies=state.open_latency_ms,
            invoke=lambda expected=expected, location_uid=location_uid: (
                service.episode_begin(
                    runtime_dir,
                    episode_id=int(expected["episode_id"]),
                    title=str(expected["title"]),
                    actor=str(expected["actor"]),
                    source=str(expected["source"]),
                    location_uid=location_uid,
                    begin_time=int(expected["begin_time"]),
                )
            ),
        )
        if not opened:
            break
        close = (
            service.episode_abort
            if expected["status"] == "aborted"
            else service.episode_end
        )
        closed = state.call(
            operation="episode_close",
            episode_id=episode_id,
            latencies=state.close_latency_ms,
            invoke=lambda close=close, expected=expected, location_uid=location_uid: (
                close(
                    runtime_dir,
                    episode_id=int(expected["episode_id"]),
                    location_uid=location_uid,
                    end_time=int(expected["end_time"]),
                    last_frame_uid=0,
                    frame_count=0,
                    reason="qualification-abort"
                    if expected["status"] == "aborted"
                    else "",
                )
            ),
        )
        if not closed:
            break
        completed += 1
        if completed % 64 == 0:
            state.sample_resources()

    state.sample_resources()
    duration = time.perf_counter() - started
    ok = (
        completed == args.count
        and state.retry_exhausted == 0
        and state.progress_timeouts == 0
        and not state.unexpected_errors
    )
    return {
        "ok": ok,
        "kind": "writer",
        "mode": args.mode,
        "worker_id": args.worker_id,
        "logical_agents": args.logical_agents,
        "start_index": args.start_index,
        "episodes_requested": args.count,
        "episodes_completed": completed,
        "duration_seconds": duration,
        "throughput_episodes_per_second": completed / duration if duration else 0.0,
        "operations": {
            "successful_appends": state.successful_appends,
            "manifest_writer_busy": state.busy,
            "retry_count": state.retry_count,
            "retry_exhausted": state.retry_exhausted,
            "unexpected_errors": len(state.unexpected_errors),
            "progress_timeouts": state.progress_timeouts,
            "longest_no_progress_interval_ms": state.longest_no_progress_ms,
        },
        "latency_ms": {
            "episode_open": _distribution(state.open_latency_ms),
            "episode_close": _distribution(state.close_latency_ms),
        },
        "resources": {
            "max_rss_bytes": state.max_rss_bytes,
            "max_descriptors": state.max_descriptors,
        },
        "errors": state.unexpected_errors,
    }


def _timed(invoke: Callable[[], Any]) -> tuple[Any, float]:
    started = time.perf_counter()
    value = invoke()
    return value, (time.perf_counter() - started) * 1000


def _sample_indices(seed: int, count: int, requested: int) -> list[int]:
    if count <= 0:
        return []
    selected = {0, count // 2, count - 1}
    rng = random.Random(seed ^ count)
    while len(selected) < min(requested, count):
        selected.add(rng.randrange(count))
    return sorted(selected)


def _issue(code: str, **detail: Any) -> dict[str, Any]:
    return {"code": code, **detail}


def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    service = _load_service()
    runtime_dir = Path(args.runtime_dir)
    errors: list[dict[str, Any]] = []
    sample_indices = _sample_indices(args.seed, args.expected_count, args.sample_count)

    page, list_page_ms = _timed(
        lambda: service.episode_list(runtime_dir, limit=args.list_limit)
    )
    expected_page_count = min(args.list_limit, args.expected_count)
    if int(page.get("episode_count", -1)) != expected_page_count:
        errors.append(
            _issue(
                "list_page_count_mismatch",
                expected=expected_page_count,
                actual=page.get("episode_count"),
            )
        )

    all_episodes, list_all_ms = _timed(
        lambda: service.episode_list(runtime_dir, limit=0)
    )
    actual_count = int(all_episodes.get("episode_count", -1))
    if actual_count != args.expected_count:
        errors.append(
            _issue(
                "episode_count_mismatch",
                expected=args.expected_count,
                actual=actual_count,
            )
        )
    semantic_record_count = sum(
        int(row.get("record_count", 0)) for row in all_episodes.get("episodes", [])
    )
    # ADR-0043: every sealed Episode carries open + close + the root
    # committed at seal
    expected_records = args.expected_count * 3
    if semantic_record_count != expected_records:
        errors.append(
            _issue(
                "episode_semantic_record_count_mismatch",
                expected=expected_records,
                actual=semantic_record_count,
            )
        )
    del all_episodes

    inspect_latency: list[float] = []
    episode_fsck_latency: list[float] = []
    readback_count = 0
    for index in sample_indices:
        expected = _episode_expected(
            seed=args.seed,
            index=index,
            mode=args.mode,
            logical_agents=args.logical_agents,
            abort_every=args.abort_every,
        )
        inspected, latency = _timed(
            lambda expected=expected: service.episode_inspect(
                runtime_dir, episode_id=int(expected["episode_id"])
            )
        )
        inspect_latency.append(latency)
        episode = inspected.get("episode", {})
        expected_subset = {
            "episode_id": expected["episode_id"],
            "title": expected["title"],
            "actor": expected["actor"],
            "source": expected["source"],
            "status": expected["status"],
            "opened": True,
            "closed": True,
            "record_count": 3,
            "frame_count": 0,
            "ref_count": 0,
        }
        mismatched = {
            key: {"expected": value, "actual": episode.get(key)}
            for key, value in expected_subset.items()
            if episode.get(key) != value
        }
        record_kinds = [row.get("record_kind") for row in inspected.get("records", [])]
        expected_kinds = ["episode_open", "episode_closed", "episode_root_committed"]
        if record_kinds != expected_kinds:
            mismatched["record_kinds"] = {
                "expected": expected_kinds,
                "actual": record_kinds,
            }
        if mismatched:
            errors.append(
                _issue(
                    "episode_readback_mismatch",
                    episode_id=expected["episode_id"],
                    mismatched=mismatched,
                )
            )
        else:
            readback_count += 1

        episode_fsck, latency = _timed(
            lambda expected=expected: service.fsck(
                runtime_dir, episode_id=int(expected["episode_id"])
            )
        )
        episode_fsck_latency.append(latency)
        if not episode_fsck.get("ok") or episode_fsck.get("warnings"):
            errors.append(
                _issue(
                    "episode_fsck_failed",
                    episode_id=expected["episode_id"],
                    status=episode_fsck.get("status"),
                    errors=episode_fsck.get("errors", []),
                    warnings=episode_fsck.get("warnings", []),
                )
            )

    full_fsck, full_fsck_ms = _timed(lambda: service.fsck(runtime_dir))
    checked = full_fsck.get("checked", {})
    if int(checked.get("episodes", -1)) != args.expected_count:
        errors.append(
            _issue(
                "fsck_episode_count_mismatch",
                expected=args.expected_count,
                actual=checked.get("episodes"),
            )
        )
    manifest_frame_count = int(checked.get("episode_manifest_records", -1))
    if manifest_frame_count < expected_records:
        errors.append(
            _issue(
                "fsck_manifest_frame_count_too_small",
                minimum=expected_records,
                actual=manifest_frame_count,
            )
        )
    warning_codes = sorted(
        str(row.get("code")) for row in full_fsck.get("warnings", [])
    )
    unexpected_warnings = sorted(set(warning_codes) - set(args.allowed_warning))
    if not full_fsck.get("ok") or unexpected_warnings:
        errors.append(
            _issue(
                "full_fsck_failed",
                status=full_fsck.get("status"),
                errors=full_fsck.get("errors", []),
                unexpected_warnings=unexpected_warnings,
            )
        )

    recovery, recovery_ms = _timed(lambda: service.episode_recover(runtime_dir))
    if int(recovery.get("recovered_count", -1)) != 0:
        errors.append(
            _issue(
                "unexpected_recovery",
                expected=0,
                actual=recovery.get("recovered_count"),
                recovered=recovery.get("recovered", []),
            )
        )

    rss, descriptors = _process_resources()
    return {
        "ok": not errors,
        "kind": "probe",
        "mode": args.mode,
        "expected_episodes": args.expected_count,
        "listed_episodes": actual_count,
        "expected_semantic_records": expected_records,
        "listed_semantic_records": semantic_record_count,
        "observed_manifest_frames": manifest_frame_count,
        "manifest_control_frames": max(0, manifest_frame_count - semantic_record_count),
        "sample_indices": sample_indices,
        "sampled_readback_ok": readback_count,
        "metrics": {
            "list_page_ms": list_page_ms,
            "list_all_ms": list_all_ms,
            "inspect_ms": _distribution(inspect_latency),
            "episode_fsck_ms": _distribution(episode_fsck_latency),
            "full_fsck_ms": full_fsck_ms,
            "clean_recovery_ms": recovery_ms,
        },
        "fsck": {
            "ok": bool(full_fsck.get("ok")),
            "status": full_fsck.get("status"),
            "checked": checked,
            "warning_codes": warning_codes,
        },
        "recovery": {
            "recovered_count": recovery.get("recovered_count"),
            "skipped_count": recovery.get("skipped_count"),
        },
        "resources": {
            **_disk_observation(runtime_dir),
            "probe_rss_bytes": rss,
            "probe_descriptors": descriptors,
        },
        "errors": errors,
    }


def validate_report(args: argparse.Namespace) -> dict[str, Any]:
    import jsonschema

    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    jsonschema.validate(report, schema)
    return {"ok": True, "schema": report.get("schema"), "report": args.report}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    write = subparsers.add_parser("write", help="write one deterministic Episode range")
    write.add_argument("--result", required=True)
    write.add_argument("--runtime-dir", required=True)
    write.add_argument("--mode", choices=("accumulation", "contention"), required=True)
    write.add_argument("--seed", type=int, required=True)
    write.add_argument("--start-index", type=int, required=True)
    write.add_argument("--count", type=int, required=True)
    write.add_argument("--logical-agents", type=int, required=True)
    write.add_argument("--worker-id", type=int, required=True)
    write.add_argument("--abort-every", type=int, default=0)
    write.add_argument("--initial-delay-ms", type=float, required=True)
    write.add_argument("--max-delay-ms", type=float, required=True)
    write.add_argument("--max-attempts", type=int, required=True)
    write.add_argument("--progress-timeout-ms", type=float, required=True)
    write.add_argument("--start-at-ms", type=int, default=0)

    probe = subparsers.add_parser("probe", help="fresh-process readback and fsck")
    probe.add_argument("--result", required=True)
    probe.add_argument("--runtime-dir", required=True)
    probe.add_argument("--mode", choices=("accumulation", "contention"), required=True)
    probe.add_argument("--seed", type=int, required=True)
    probe.add_argument("--expected-count", type=int, required=True)
    probe.add_argument("--logical-agents", type=int, required=True)
    probe.add_argument("--abort-every", type=int, default=0)
    probe.add_argument("--sample-count", type=int, required=True)
    probe.add_argument("--list-limit", type=int, required=True)
    probe.add_argument("--allowed-warning", action="append", default=[])

    validate = subparsers.add_parser(
        "validate-report", help="validate Trust Report JSON"
    )
    validate.add_argument("--report", required=True)
    validate.add_argument("--schema", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "write":
            result = run_write(args)
            _write_json(args.result, result)
            return 0 if result["ok"] else 1
        if args.command == "probe":
            result = run_probe(args)
            _write_json(args.result, result)
            return 0 if result["ok"] else 1
        result = validate_report(args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        failure = {
            "ok": False,
            "kind": args.command,
            "errors": [
                {
                    "code": "worker_exception",
                    "error": f"{type(error).__name__}: {error}"[:1000],
                }
            ],
        }
        result_path = getattr(args, "result", "")
        if result_path:
            _write_json(result_path, failure)
        else:
            print(json.dumps(failure, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
