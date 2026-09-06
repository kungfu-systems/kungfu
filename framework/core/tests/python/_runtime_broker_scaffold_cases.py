# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path


from kungfu import runtime_broker


ROOT = Path(__file__).parents[4]
READINESS_FIXTURES = json.loads(
    (ROOT / "tests/fixtures/runtime-activation-readiness/cases.json").read_text()
)
LEASE_FIXTURES = json.loads(
    (ROOT / "tests/fixtures/runtime-lease-recovery/cases.json").read_text()
)


def _cut(sequence="1", frame_uid="1"):
    return {
        "stream_id": "1",
        "container_epoch": "1",
        "sequence": sequence,
        "frame_uid": frame_uid,
    }


def _reconciliation(cut=None):
    cut = cut or _cut()
    return {
        "schema": "kungfu.durability.reconciliation/v1",
        "state": "reconciled",
        "recovered": True,
        "receipt": {
            "schema": "kungfu.durability.receipt/v1",
            "request_id": 17,
            "status": "succeeded",
            "durable_watermark": cut,
            "barrier_id": 23,
        },
    }


def _projection_status(cut=None):
    cut = cut or _cut()
    return {
        "schema": "kungfu.projection-candidate-status/v1",
        "authority": "libkungfu",
        "outcome": "ready",
        "hydrated": True,
        "qualification_profile": "candidate/test-local-filesystem/v1",
        "projection_watermark": cut,
    }


def _native_evidence(runtime_dir, cut=None):
    runtime_path = Path(runtime_dir).resolve()
    return {
        "schema": "kungfu.runtime.native-readiness-evidence/v1",
        "workspaceId": runtime_broker.workspace_id(runtime_path),
        "runtimeHome": str(runtime_path.parent),
        "dataRoot": str(runtime_path),
        "minimumCut": cut or _cut(),
        "durability": {
            "requestId": "17",
            "requestedProfile": "durable_sync",
            "writerResourceId": "00000007.0000000b",
            "qualificationProfile": "test/disposable-powercut/v1",
        },
        "projection": {
            "writerResourceId": "projection-restart-writer",
            "qualificationProfile": "candidate/test-local-filesystem/v1",
        },
    }


class _CutReadinessAuthority:
    def __init__(self, cut=None):
        self.cut = cut

    def establish(self, requirement, generation, diagnostics):
        cut = self.cut or requirement["minimumCut"] or _cut()
        return {
            "schema": "kungfu.runtime.readiness/v1",
            "state": "ready",
            "durableCut": cut,
            "projectionCut": cut
            if "runtime.live-projection" in requirement["requiredCapabilities"]
            else None,
            "evidence": [
                {
                    "kind": "durability-receipt",
                    "ref": f"receipt:durability:generation-{generation}",
                }
            ],
            "observedAtNs": "1",
        }


class _FileProcessHost:
    def __init__(self, counter_path, supervisor_pid=1200, coordinator_pid=1201):
        self.counter_path = Path(counter_path)
        self.supervisor_pid = supervisor_pid
        self.coordinator_pid = coordinator_pid

    def _diagnostics(self, running):
        return {
            "supervisor": {
                "pid": self.supervisor_pid if running else None,
                "running": running,
            },
            "coordinator": {
                "pid": self.coordinator_pid if running else None,
                "running": running,
            },
        }

    def inspect(self, home, runtime_dir):
        return self._diagnostics(self.counter_path.exists())

    def activate(self, home, runtime_dir):
        count = int(self.counter_path.read_text()) if self.counter_path.exists() else 0
        self.counter_path.write_text(str(count + 1))
        return self._diagnostics(True)


class _GenerationAwareProcessHost(_FileProcessHost):
    def __init__(self, counter_path):
        super().__init__(counter_path)
        self.generations = []

    def activate_with_generation(self, home, runtime_dir, generation):
        self.generations.append(generation)
        return self.activate(home, runtime_dir)


class _LeaseClock:
    def __init__(self, now_ns):
        self.value = now_ns

    def now_ns(self):
        return self.value


class _DrainHost:
    def __init__(self):
        self.calls = []

    def drain(self, home, runtime_dir):
        self.calls.append((home, runtime_dir))
        return {"coordinator": {"running": False}, "changed": True}


def _activation_worker(config_home, runtime_dir, counter_path, request_id, queue):
    requirement = runtime_broker.plan_operation(
        "projection.subscribe",
        workspace=runtime_broker.workspace_id(runtime_dir),
        request_source="python",
        minimum_cut=_cut(),
        request_id=request_id,
    )["requirement"]
    client = runtime_broker.ProcessRuntimeActivationClient(
        str(Path(runtime_dir).parent),
        runtime_dir,
        config_home=config_home,
        host=_FileProcessHost(counter_path),
        readiness_authority=_CutReadinessAuthority(),
    )
    receipt = client.activate(requirement, "python")
    queue.put(
        {
            "outcome": receipt["outcome"],
            "generation": receipt["handle"]["generation"],
        }
    )


def _ready_receipt(requirement, request_source):
    capabilities = list(requirement["requiredCapabilities"])
    authorities = list(requirement["requestedAuthorities"])
    cut = {
        "stream_id": "1",
        "container_epoch": "1",
        "sequence": "1",
        "frame_uid": "1",
    }
    return {
        "schema": runtime_broker.ACTIVATION_RECEIPT_SCHEMA,
        "requestId": requirement["requestId"],
        "requirement": dict(requirement),
        "outcome": "activated",
        "activatedBy": "test-host",
        "requestSource": request_source,
        "handle": {
            "schema": "kungfu.runtime.handle/v1",
            "runtimeId": "runtime-test",
            "requirementId": requirement["requestId"],
            "workspaceId": requirement["workspaceId"],
            "generation": "1",
            "state": "ready",
            "capabilities": capabilities,
            "grantedAuthorities": authorities,
            "readiness": {
                "schema": "kungfu.runtime.readiness/v1",
                "state": "ready",
                "durableCut": cut,
                "projectionCut": None,
                "evidence": [
                    {
                        "kind": "durability-receipt",
                        "ref": "receipt:durability:test-ready",
                    }
                ],
                "observedAtNs": "1",
            },
            "host": {
                "kind": "process",
                "hostId": "process-test",
                "diagnostics": {
                    "supervisorPid": None,
                    "coordinatorPid": None,
                    "socketPath": None,
                    "serviceInstalled": None,
                    "guiVisible": None,
                },
            },
        },
        "achievedCapabilities": capabilities,
        "missingCapabilities": [],
        "grantedAuthorities": authorities,
        "degraded": False,
        "error": None,
    }
