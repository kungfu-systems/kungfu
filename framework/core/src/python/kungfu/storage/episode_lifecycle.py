# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any

import kungfu
from kungfu.rewind.wire import wrap_event
from kungfu.storage import service

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
        if row.get("source") == source and row.get("status") == "open"
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

    def __post_init__(self) -> None:
        self.location_uid = _location_uid(self.runtime_dir, self.namespace, self.name)
        self.recorder = yjj.action_recorder(
            self.runtime_dir, self.namespace, self.name, PUBLIC_DEST, 0
        )
        self.frame_count = 0
        self.closed = False
        if self.begin:
            begun = service.episode_begin(
                self.runtime_dir,
                episode_id=self.episode_id,
                title=self.title,
                actor=self.actor,
                source=self.source,
                location_uid=self.location_uid,
            )
            self.episode_id = int(begun["episode_id"])
        elif self.episode_id == 0:
            raise ValueError("episode_id is required when begin=False")
        else:
            inspected = service.episode_inspect(
                self.runtime_dir, episode_id=self.episode_id
            )
            self.frame_count = len(inspected.get("frames", []))

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
        carrier_type, envelope = wrap_event(action_type, payload, run_id=run_id)
        receipt = self.recorder.record_bytes(carrier_type, bytes(envelope))
        self.frame_count += 1
        service.episode_attach_frame(
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
        )
        return receipt

    def attach_payload_ref(
        self, path: str, *, content_hash: str = "", ref_id: str | None = None
    ) -> None:
        # ADR-0041 stage 4: publish the payload bytes into the content store
        # first, then append the ref claiming their identity; fsck resolves
        # the ref through the store by ref_hash, not by path. ref_id stays an
        # edge label (the runtime-relative origin of the bytes).
        from kungfu.content_hash import compute_content_hash_value

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
        service.write_payload_bytes(self.runtime_dir, digest, raw)
        service.episode_attach_ref(
            self.runtime_dir,
            episode_id=self.episode_id,
            location_uid=self.location_uid,
            ref_kind="payload",
            ref_id=ref_id or _relative_ref(self.runtime_dir, path),
            ref_hash=f"sha256:{digest}",
        )

    def close(self, *, ok: bool, reason: str = "") -> None:
        if self.closed:
            return
        close = service.episode_end if ok else service.episode_abort
        close(
            self.runtime_dir,
            episode_id=self.episode_id,
            location_uid=self.location_uid,
            last_frame_uid=int(self.recorder.last_frame_uid),
            frame_count=self.frame_count,
            reason=reason,
        )
        self.closed = True
