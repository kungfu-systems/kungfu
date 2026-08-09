# SPDX-License-Identifier: Apache-2.0

"""Thin Python projection of the libkungfu durability authority."""

from __future__ import annotations

import threading
import time
import weakref
from typing import Any

import kungfu
from kungfu import config as kungfu_config


def capabilities() -> dict[str, Any]:
    """Return the evidence-bound durability capability without widening it."""

    return dict(kungfu.__binding__.runtime.durability_capability_typed())


def resolve_policy(
    *,
    runtime_home: str | None = None,
    config_home: str | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Resolve requested KFD-1 policy into fail-closed runtime admission."""

    requested = kungfu_config.durability_policy(
        runtime_home=runtime_home, config_home=config_home, cwd=cwd
    )
    policy = dict(requested["policy"])
    capability = capabilities()
    activation = str(policy["activation"])
    default_profile = str(policy["defaultProfile"])
    strong_requested = default_profile != "visible" or any(
        str(rule["profile"]) != "visible" for rule in policy["rules"]
    )
    reasons: list[str] = []
    admitted = False

    if activation == "off":
        admitted = not strong_requested
        if strong_requested:
            reasons.append("strong_profile_requested_while_activation_is_off")
    elif activation == "qualified-candidate":
        admission = dict(capability.get("admission") or {})
        if policy["qualificationProfile"] != capability.get("qualification_profile"):
            reasons.append("qualification_profile_mismatch")
        if not admission.get("current_hardware_candidate_complete"):
            reasons.append("candidate_evidence_incomplete")
        evidence = str(admission.get("evidence_sha256") or "")
        if len(evidence) != 64 or any(c not in "0123456789abcdef" for c in evidence):
            reasons.append("candidate_evidence_digest_invalid")
        if policy["failurePolicy"] != "fail-closed":
            reasons.append("failure_policy_not_fail_closed")
        admitted = not reasons
    else:
        reasons.append("unsupported_activation")

    effective_profile = default_profile if admitted else None
    return {
        "schema": "kungfu.durability-policy.effective/v1",
        "authority": "libkungfu+kungfu.config",
        "contract": requested["contract"],
        "policyDigest": requested["policyDigest"],
        "requested": policy,
        "admission": {
            "admitted": admitted,
            "reasons": reasons,
            "capabilityProfile": capability.get("profile"),
            "qualificationProfile": capability.get("qualification_profile"),
            "evidenceSha256": (capability.get("admission") or {}).get(
                "evidence_sha256"
            ),
            "productionEligible": bool(capability.get("production_eligible")),
        },
        "effective": {
            "activation": activation if admitted else "refused",
            "defaultProfile": effective_profile,
            "policyDigest": requested["policyDigest"] if admitted else None,
        },
        "native": {
            "enabled": activation == "qualified-candidate",
            "qualificationProfile": policy["qualificationProfile"],
            "contractHash": requested["contract"]["hash"],
            "policyDigest": requested["policyDigest"],
            "defaultProfile": default_profile,
            "strongProfilesRequested": strong_requested,
            "segmentMaxBytes": policy["segmentMaxBytes"],
            "requestTimeoutMs": policy["requestTimeoutMs"],
            "reconcileOnTimeout": policy["reconcileOnTimeout"],
            "failurePolicy": policy["failurePolicy"],
            "group": policy["group"],
            "rules": policy["rules"],
        },
        "sources": requested["sources"],
    }


def select_profile(
    policy: dict[str, Any],
    *,
    carrier_type: int,
    source_id: int = 0,
    destination_id: int = 0,
) -> str:
    """Select one profile deterministically from the resolved ordered rules."""

    requested = dict(policy["requested"])
    matches: list[dict[str, Any]] = []
    for rule in requested["rules"]:
        match = rule["match"]
        if "carrierTypes" in match and carrier_type not in match["carrierTypes"]:
            continue
        if "sourceIds" in match and source_id not in match["sourceIds"]:
            continue
        if "destinationIds" in match and destination_id not in match["destinationIds"]:
            continue
        matches.append(rule)
    matches.sort(key=lambda rule: (-int(rule["priority"]), str(rule["id"])))
    return str(matches[0]["profile"] if matches else requested["defaultProfile"])


class ConfiguredDurabilityRuntime:
    """Execute the admitted KFD-1 durability policy through libkungfu."""

    def __init__(
        self, coordinator: Any, policy: dict[str, Any], *, data_root: str
    ) -> None:
        # The native coordinator owns this facade. Keep the inverse edge weak so
        # a short-lived Python coordinator is destroyed at function/test exit and
        # releases the process-wide native reactor slot deterministically.
        self.coordinator = weakref.proxy(coordinator)
        self.policy = policy
        self.data_root = data_root
        self._streams: set[ConfiguredDurabilityStream] = set()
        self._lock = threading.RLock()

    def open_stream(
        self,
        *,
        stream_id: int,
        container_epoch: int,
        writer_resource_id: str,
    ) -> "ConfiguredDurabilityStream":
        if self.policy["effective"]["activation"] != "qualified-candidate":
            raise RuntimeError("durability policy is not admitted for execution")
        stream = ConfiguredDurabilityStream(
            self,
            stream_id=stream_id,
            container_epoch=container_epoch,
            writer_resource_id=writer_resource_id,
        )
        with self._lock:
            self._streams.add(stream)
        return stream

    def close(self, *, flush: bool = True) -> None:
        with self._lock:
            streams = tuple(self._streams)
        for stream in streams:
            stream.close(flush=flush)

    def _forget(self, stream: "ConfiguredDurabilityStream") -> None:
        with self._lock:
            self._streams.discard(stream)


class ConfiguredDurabilityStream:
    """One fenced stream epoch using configured selection, batching and timeout."""

    def __init__(
        self,
        runtime: ConfiguredDurabilityRuntime,
        *,
        stream_id: int,
        container_epoch: int,
        writer_resource_id: str,
    ) -> None:
        self.runtime = runtime
        self.stream_id = int(stream_id)
        self.container_epoch = int(container_epoch)
        self.writer_resource_id = writer_resource_id
        self._lock = threading.RLock()
        self._timer: threading.Timer | None = None
        self._last_position: tuple[int, int] | None = None
        self._group_pending = False
        self.last_async_result: dict[str, Any] | None = None
        self.last_async_error: str | None = None
        self._closed = False
        native = runtime.policy["native"]
        self.writer = kungfu.__binding__.runtime.durability_writer_lease(
            runtime.data_root, writer_resource_id
        )
        self.status = dict(
            runtime.coordinator.durability_open(
                runtime.data_root,
                self.stream_id,
                self.container_epoch,
                writer_resource_id,
                native["qualificationProfile"],
            )
        )

    @property
    def policy_identity(self) -> dict[str, str]:
        contract = self.runtime.policy["contract"]
        return {
            "contractHash": str(contract["hash"]),
            "policyDigest": str(self.runtime.policy["policyDigest"]),
            "qualificationProfile": str(
                self.runtime.policy["native"]["qualificationProfile"]
            ),
        }

    def append(
        self,
        payload: bytes,
        *,
        carrier_type: int,
        sequence: int,
        frame_uid: int,
        source_id: int = 0,
        destination_id: int = 0,
        gen_time: int = 0,
        trigger_time: int = 0,
        data_type: int = 0,
        initial_source: int = 0,
        trigger_frame_uid: int = 0,
    ) -> dict[str, Any]:
        """Append once; return only an earned receipt or an explicit pending cut."""

        if not isinstance(payload, bytes):
            raise TypeError("durability payload must be bytes")
        with self._lock:
            self._require_open()
            profile = select_profile(
                self.runtime.policy,
                carrier_type=int(carrier_type),
                source_id=int(source_id),
                destination_id=int(destination_id),
            )
            self.status = dict(
                self.runtime.coordinator.durability_append(
                    self.writer,
                    self.stream_id,
                    self.container_epoch,
                    int(sequence),
                    int(frame_uid),
                    int(carrier_type),
                    payload,
                    int(gen_time),
                    int(trigger_time),
                    int(source_id),
                    int(destination_id),
                    int(data_type),
                    int(initial_source),
                    int(trigger_frame_uid),
                )
            )
            self._last_position = (int(sequence), int(frame_uid))
            if profile == "visible":
                receipt = dict(
                    kungfu.__binding__.runtime.durability_visible_receipt_typed(
                        int(frame_uid),
                        self.stream_id,
                        self.container_epoch,
                        int(sequence),
                        int(frame_uid),
                        profile,
                        time.time_ns(),
                    )
                )
                return self._execution("visible", profile, receipt=receipt)
            if profile == "durable_sync":
                self._cancel_timer()
                return self._request(
                    profile, int(frame_uid), int(sequence), int(frame_uid)
                )

            group = self.runtime.policy["requested"]["group"]
            self._group_pending = True
            if (
                int(group["maxDelayMs"]) == 0
                or int(self.status["pendingRecords"]) >= int(group["maxRecords"])
                or int(self.status["pendingBytes"]) >= int(group["maxBytes"])
            ):
                return self._request(
                    profile, int(frame_uid), int(sequence), int(frame_uid)
                )
            self._schedule_group_flush(int(group["maxDelayMs"]))
            return self._execution("pending", profile, status=self.status)

    def flush(self) -> dict[str, Any]:
        """Force the current pending frontier through one durable_group barrier."""

        with self._lock:
            self._require_open()
            if (
                not self._group_pending
                or self._last_position is None
                or int(self.status["pendingRecords"]) == 0
            ):
                return self._execution("idle", "durable_group", status=self.status)
            sequence, frame_uid = self._last_position
            return self._request("durable_group", frame_uid, sequence, frame_uid)

    def reconcile(
        self,
        *,
        request_id: int,
        sequence: int,
        frame_uid: int,
        requested_profile: str,
    ) -> dict[str, Any]:
        with self._lock:
            self._require_open()
            value = dict(
                self.runtime.coordinator.durability_reconcile(
                    int(request_id),
                    self.stream_id,
                    self.container_epoch,
                    int(sequence),
                    int(frame_uid),
                    requested_profile,
                )
            )
            return {
                "schema": "kungfu.durability.policy-reconciliation/v1",
                "policyIdentity": self.policy_identity,
                "reconciliation": value,
            }

    def close(self, *, flush: bool = True) -> None:
        with self._lock:
            if self._closed:
                return
            if flush and self._group_pending and self._last_position is not None:
                self.flush()
            self._cancel_timer()
            self._closed = True
        self.runtime._forget(self)

    def _request(
        self, profile: str, request_id: int, sequence: int, frame_uid: int
    ) -> dict[str, Any]:
        timeout_ms = int(self.runtime.policy["requested"]["requestTimeoutMs"])
        deadline = time.monotonic_ns() + timeout_ms * 1_000_000
        native = dict(
            self.runtime.coordinator.durability_request(
                request_id,
                self.stream_id,
                self.container_epoch,
                sequence,
                frame_uid,
                profile,
                deadline,
            )
        )
        self.status = dict(native["status"])
        receipt = dict(native["receipt"])
        state = str(receipt.get("status", "unknown"))
        reconciliation = None
        if self.runtime.policy["requested"]["reconcileOnTimeout"] and (
            native.get("error") == "timeout" or state == "unknown"
        ):
            reconciliation = dict(
                self.runtime.coordinator.durability_reconcile(
                    request_id,
                    self.stream_id,
                    self.container_epoch,
                    sequence,
                    frame_uid,
                    profile,
                )
            )
            reconciled_receipt = reconciliation.get("receipt")
            if (
                reconciliation.get("state") == "reconciled"
                and isinstance(reconciled_receipt, dict)
                and reconciled_receipt.get("status") == "succeeded"
            ):
                receipt = dict(reconciled_receipt)
                state = "succeeded"
        if state == "succeeded":
            self._group_pending = False
            self._cancel_timer()
        return self._execution(
            state,
            profile,
            receipt=receipt,
            status=self.status,
            native=native,
            reconciliation=reconciliation,
        )

    def _execution(
        self,
        state: str,
        profile: str,
        *,
        receipt: dict[str, Any] | None = None,
        status: dict[str, Any] | None = None,
        native: dict[str, Any] | None = None,
        reconciliation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {
            "schema": "kungfu.durability.policy-execution/v1",
            "policyIdentity": self.policy_identity,
            "selectedProfile": profile,
            "state": state,
            "acknowledged": state in {"visible", "succeeded"},
            "receipt": receipt,
            "status": status,
            "native": native,
            "reconciliation": reconciliation,
        }

    def _schedule_group_flush(self, delay_ms: int) -> None:
        if self._timer is not None:
            return
        self._timer = threading.Timer(delay_ms / 1000.0, self._flush_from_timer)
        self._timer.daemon = True
        self._timer.start()

    def _flush_from_timer(self) -> None:
        with self._lock:
            self._timer = None
            if self._closed:
                return
            try:
                self.last_async_result = self.flush()
                self.last_async_error = None
            except Exception as error:  # noqa: BLE001 - retained for inspection
                # Fail closed: no receipt is invented. The native status and
                # explicit reconcile API remain the authority for the caller.
                self.last_async_error = f"{type(error).__name__}: {error}"
                return

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _require_open(self) -> None:
        if self._closed:
            raise RuntimeError("durability stream is closed")


def reconcile(
    *,
    data_root: str,
    request_id: int,
    stream_id: int,
    container_epoch: int,
    sequence: int,
    frame_uid: int,
    requested_profile: str,
    writer_resource_id: str,
    qualification_profile: str,
) -> dict[str, Any]:
    """Reconcile a request against the C++ checkpoint-covered receipt index."""

    return dict(
        kungfu.__binding__.runtime.durability_reconcile_typed(
            data_root,
            request_id,
            stream_id,
            container_epoch,
            sequence,
            frame_uid,
            requested_profile,
            writer_resource_id,
            qualification_profile,
        )
    )
