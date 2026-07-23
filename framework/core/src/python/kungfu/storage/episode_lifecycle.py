# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
import signal
import threading
from typing import Any

import kungfu
from kungfu.rewind.wire import build_event_envelope
from kungfu.storage import service
from kungfu.storage.episode_control import (
    DEFAULT_WRITE_RETRY_POLICY,
    SIGNAL_ABORT_RETRY_POLICY,
    EpisodeWriteRetryPolicy,
)

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime

PUBLIC_DEST = 0


def _location_uid(runtime_dir: str, namespace: str, name: str) -> int:
    locator = yjj.locator(runtime_dir)
    location = yjj.location(
        lf.enums.mode.LIVE,
        lf.enums.location_role.SYSTEM,
        namespace,
        name,
        locator,
    )
    return int(location.uid)


def _relative_ref(runtime_dir: str, path: str) -> str:
    try:
        return os.path.relpath(path, runtime_dir)
    except ValueError:
        return path


def find_open_episode_id(runtime_dir: str, *, source: str) -> int | None:
    listed = service.episode_list(runtime_dir, limit=0)
    matches = [
        int(row["episode_id"])
        for row in listed.get("episodes", [])
        if row.get("open", {}).get("source") == source and not bool(row.get("closed"))
    ]
    return matches[-1] if matches else None


@dataclass
class RuntimeEpisodeLifecycle:
    runtime_dir: str
    namespace: str
    name: str
    title: str
    actor: str
    source: str
    episode_id: int = 0
    begin: bool = True
    retry_policy: EpisodeWriteRetryPolicy = DEFAULT_WRITE_RETRY_POLICY

    def __post_init__(self) -> None:
        self.location_uid = _location_uid(self.runtime_dir, self.namespace, self.name)
        self.recorder = yjj.action_recorder(
            self.runtime_dir, self.namespace, self.name, PUBLIC_DEST, 0
        )
        self.frame_count = 0
        self.closed = False
        self.write_retries: list[dict[str, Any]] = []
        self.abort_error: str | None = None
        if self.begin:
            begun = self._write(
                "episode_begin",
                lambda write_retry: service.episode_begin(
                    self.runtime_dir,
                    episode_id=self.episode_id,
                    title=self.title,
                    actor=self.actor,
                    source=self.source,
                    location_uid=self.location_uid,
                    write_retry=write_retry,
                ),
            )
            self.episode_id = int(begun["episode_id"])
        elif self.episode_id == 0:
            raise ValueError("episode_id is required when begin=False")
        else:
            inspected = service.episode_inspect(
                self.runtime_dir, episode_id=self.episode_id
            )
            episode = inspected.get("episode", {})
            self.frame_count = int(
                episode.get("unique_frame_count") or len(inspected.get("frames", []))
            )

    def _write(
        self,
        operation: str,
        action,
        *,
        policy: EpisodeWriteRetryPolicy | None = None,
    ):
        retry_policy = policy or self.retry_policy
        result = action(retry_policy.to_native_options())
        retry = dict(result.get("write_retry") or {})
        if not retry:
            raise RuntimeError(
                f"{operation}: native Episode write did not return a retry receipt"
            )
        self.write_retries.append(retry)
        return result

    @classmethod
    def resume_or_begin(
        cls,
        runtime_dir: str,
        *,
        namespace: str,
        name: str,
        title: str,
        actor: str,
        source: str,
    ) -> "RuntimeEpisodeLifecycle":
        episode_id = find_open_episode_id(runtime_dir, source=source)
        return cls(
            runtime_dir=runtime_dir,
            namespace=namespace,
            name=name,
            title=title,
            actor=actor,
            source=source,
            episode_id=episode_id or 0,
            begin=episode_id is None,
        )

    def record_event(self, action_type: str, payload: bytes, *, run_id: str) -> Any:
        envelope = build_event_envelope(action_type, payload, run_id=run_id)
        receipt = self.recorder.record_action(envelope)
        self.frame_count += 1
        self._write(
            "episode_attach_frame",
            lambda write_retry: service.episode_attach_frame(
                self.runtime_dir,
                episode_id=self.episode_id,
                location_uid=self.location_uid,
                frame_uid=int(receipt.frame_uid),
                trigger_frame_uid=int(receipt.trigger_frame_uid),
                stream_id=int(receipt.stream_id),
                gen_time=int(receipt.gen_time),
                trigger_time=int(receipt.trigger_time),
                carrier_type=int(receipt.carrier_type),
                source=int(receipt.source),
                dest=int(receipt.dest),
                data_length=int(receipt.data_length),
                integrity_version=int(receipt.integrity_version),
                payload_checksum=int(receipt.payload_checksum),
                frame_checksum=int(receipt.frame_checksum),
                write_retry=write_retry,
            ),
        )
        return receipt

    def attach_payload_ref(
        self, path: str, *, content_hash: str = "", ref_id: str | None = None
    ) -> None:
        # ADR-0041 stage 4: publish the payload bytes into the content store
        # first, then append the ref claiming their identity; fsck resolves
        # the ref through the store by ref_hash, not by path. ref_id stays an
        # edge label (the runtime-relative origin of the bytes). Publication
        # goes through the ADR-0040 facade, so the provider-selected backend
        # (file or engine) owns the bytes the ref claims.
        from kungfu.content_hash import compute_content_hash_value
        from kungfu.storage import content_store

        with open(path, "rb") as payload_file:
            raw = payload_file.read()
        digest = compute_content_hash_value(raw)
        if content_hash:
            declared = content_hash.split(":", 1)[-1]
            if declared != digest:
                raise ValueError(
                    f"attach_payload_ref: declared hash {content_hash} does not "
                    f"match the bytes at {path} (sha256:{digest})"
                )
        published = content_store.put_if_absent(
            self.runtime_dir,
            content_store.PAYLOADS_NAMESPACE,
            raw,
            expected_hash=f"sha256:{digest}",
        )
        if not published["ok"]:
            raise RuntimeError(
                "attach_payload_ref: publish failed: "
                f"{published['error']}: {published.get('message', '')}"
            )
        self._write(
            "episode_attach_ref",
            lambda write_retry: service.episode_attach_ref(
                self.runtime_dir,
                episode_id=self.episode_id,
                location_uid=self.location_uid,
                ref_kind="payload",
                ref_id=ref_id or _relative_ref(self.runtime_dir, path),
                ref_hash=f"sha256:{digest}",
                write_retry=write_retry,
            ),
        )

    def close(
        self,
        *,
        ok: bool,
        reason: str = "",
        retry_policy: EpisodeWriteRetryPolicy | None = None,
    ) -> None:
        if self.closed:
            return
        close = service.episode_end if ok else service.episode_abort
        self._write(
            "episode_end" if ok else "episode_abort",
            lambda write_retry: close(
                self.runtime_dir,
                episode_id=self.episode_id,
                location_uid=self.location_uid,
                last_frame_uid=int(self.recorder.last_frame_uid),
                frame_count=self.frame_count,
                reason=reason,
                write_retry=write_retry,
            ),
            policy=retry_policy,
        )
        self.closed = True

    def abort_best_effort(self, reason: str) -> bool:
        if self.closed:
            return True
        try:
            self.close(
                ok=False,
                reason=reason,
                retry_policy=SIGNAL_ABORT_RETRY_POLICY,
            )
        except BaseException as exc:
            self.abort_error = f"{type(exc).__name__}: {exc}"
            return False
        return True

    @contextmanager
    def _termination_signal_guard(self):
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        previous = signal.getsignal(signal.SIGTERM)
        if previous == signal.SIG_IGN:
            yield
            return

        def handle_sigterm(signum, _frame):
            self.abort_best_effort(f"terminated by signal {signum}")
            if callable(previous):
                previous(signum, _frame)
                return
            raise SystemExit(128 + signum)

        signal.signal(signal.SIGTERM, handle_sigterm)
        try:
            yield
        finally:
            if signal.getsignal(signal.SIGTERM) is handle_sigterm:
                signal.signal(signal.SIGTERM, previous)

    @contextmanager
    def guard(self):
        """Abort every non-closed exit, including Ctrl-C and SIGTERM.

        Hard kill and machine power loss cannot run this guard; those remain
        explicit recovery cases rather than being presented as clean aborts.
        """

        with self._termination_signal_guard():
            try:
                yield self
            except BaseException as exc:
                self.abort_best_effort(
                    f"episode scope interrupted: {type(exc).__name__}"
                )
                raise
            finally:
                if not self.closed:
                    self.abort_best_effort("episode scope exited without close")
