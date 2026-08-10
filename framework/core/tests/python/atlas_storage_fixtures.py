# SPDX-License-Identifier: Apache-2.0

import json
from pathlib import Path

from kungfu import runtime_broker


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def admit_profile_runtime(monkeypatch, runtime_dir, config_home) -> None:
    runtime_path = Path(runtime_dir).resolve()
    _write_json(
        runtime_path.parent / "workspace-identity.json",
        {
            "schema": "kungfu.workspace.identity-material/v1",
            "workspaceKind": "project",
            "workspaceKey": "workspace:test-atlas-storage",
            "identityRoot": "sha256:" + "a" * 64,
        },
    )
    evidence = {
        "schema": "kungfu.runtime.native-readiness-evidence/v1",
        "workspaceId": runtime_broker.workspace_id(runtime_path),
        "runtimeHome": str(runtime_path.parent),
        "dataRoot": str(runtime_path),
        "minimumCut": {
            "stream_id": "1",
            "container_epoch": "1",
            "sequence": "1",
            "frame_uid": "1",
        },
        "durability": {
            "requestId": "17",
            "requestedProfile": "durable_sync",
            "writerResourceId": "00000007.0000000b",
            "qualificationProfile": "test/disposable-powercut/v1",
        },
        "projection": None,
    }
    path = runtime_broker.native_readiness_evidence_path(runtime_dir, config_home)
    _write_json(path, evidence)

    class AdmittingBroker:
        def invoke(self, plan, callback):
            activation = {"outcome": "activated"}
            return {
                "schema": "kungfu.runtime.invocation-receipt/v1",
                "planId": plan["planId"],
                "operationId": plan["operation"]["id"],
                "accepted": True,
                "activation": activation,
                "result": callback(activation),
            }

    monkeypatch.setattr(
        runtime_broker.RuntimeCapabilityBroker,
        "for_process",
        classmethod(lambda cls, *_args, **_kwargs: AdmittingBroker()),
    )
