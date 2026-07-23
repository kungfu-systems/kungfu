# SPDX-License-Identifier: Apache-2.0

import json
import os
import sys
import time

from kungfu_sdk import NativeStorage, REQUIRED_CAPABILITIES, WireResponse, geometry_root
from kungfu_sdk.generated.runtime_action_v1 import parse_geometry_root
from kungfu_sdk.generated import work_lifecycle_v1


def qualification_hold() -> None:
    time.sleep(int(os.environ.get("KUNGFU_QUALIFICATION_HOLD_MS", "0")) / 1000)


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "usage: python-call.py RUNTIME_DIR OPERATION REQUEST_JSON", file=sys.stderr
        )
        return 2
    runtime_dir, operation, request_json = sys.argv[1:]
    if operation == "__runtime_action_projection_semantic__":
        root = f"sha256:{'a' * 64}"
        if request_json == "reordered-envelope":
            body = (
                '{"schema":"kungfu.action-runtime.result/v1",'
                f'"result":{{"geometryRoot":"{root}"}}}}'
            )
        elif request_json == "whitespace-envelope":
            body = (
                f'{{ "result" : {{ "geometryRoot" : "{root}" }}, '
                '"schema" : "kungfu.action-runtime.result/v1" }'
            )
        else:
            raise ValueError("unsupported projection-semantic case")
        result = parse_geometry_root(
            WireResponse(
                protocol_id="kungfu.runtime.action",
                protocol_version=1,
                schema_ref="kungfu.action-runtime.result/v1",
                encoding="application/json",
                bytes=body.encode(),
            )
        )
        print(
            json.dumps(
                {
                    "geometryRoot": result.geometry_root,
                    "bytesHex": result.wire.bytes.hex(),
                },
                separators=(",", ":"),
            )
        )
        qualification_hold()
        return 0
    if operation == "__runtime_action_projection_negative__":
        root = f"sha256:{'a' * 64}"
        wire = WireResponse(
            protocol_id="kungfu.runtime.action",
            protocol_version=1,
            schema_ref="kungfu.action-runtime.result/v1",
            encoding="application/json",
            bytes=(
                f'{{"result":{{"geometryRoot":"{root}"}},'
                '"schema":"kungfu.action-runtime.result/v1"}'
            ).encode(),
        )
        if request_json == "wrong-metadata":
            wire = WireResponse(
                **{
                    **wire.__dict__,
                    "schema_ref": "kungfu.action-runtime.wrong/v1",
                }
            )
        elif request_json == "extra-result-field":
            wire = WireResponse(
                **{
                    **wire.__dict__,
                    "bytes": (
                        f'{{"result":{{"geometryRoot":"{root}",'
                        '"unexpected":true},'
                        '"schema":"kungfu.action-runtime.result/v1"}'
                    ).encode(),
                }
            )
        elif request_json == "wrong-layer":
            wire = WireResponse(
                **{
                    **wire.__dict__,
                    "bytes": f'{{"geometryRoot":"{root}"}}'.encode(),
                }
            )
        elif request_json == "schema-punctuation-mutation":
            wire = WireResponse(
                **{
                    **wire.__dict__,
                    "bytes": (
                        f'{{"result":{{"geometryRoot":"{root}"}},'
                        '"schema":"kungfuXaction-runtimeXresult/v1"}'
                    ).encode(),
                }
            )
        elif request_json == "short-root":
            wire = WireResponse(
                **{
                    **wire.__dict__,
                    "bytes": (
                        '{"result":{"geometryRoot":"sha256:a"},'
                        '"schema":"kungfu.action-runtime.result/v1"}'
                    ).encode(),
                }
            )
        elif request_json == "trailing-comma":
            wire = WireResponse(
                **{
                    **wire.__dict__,
                    "bytes": (
                        f'{{"result":{{"geometryRoot":"{root}"}},'
                        '"schema":"kungfu.action-runtime.result/v1",}'
                    ).encode(),
                }
            )
        else:
            raise ValueError("unsupported projection-negative case")
        try:
            parse_geometry_root(wire)
        except ValueError:
            print('{"rejected":true}')
            qualification_hold()
            return 0
        raise RuntimeError("generated projection accepted an invalid response")
    with NativeStorage(runtime_dir) as storage:
        if operation == "__work_lifecycle_runtime__":
            request = json.loads(request_json)
            try:
                wire = (
                    work_lifecycle_v1.capabilities(storage)
                    if request.get("mode") == "capabilities"
                    else work_lifecycle_v1.invoke(
                        storage,
                        request["operationId"],
                        request.get("input", {}),
                        execute=request.get("execute", False),
                    )
                )
                output = {
                    "protocolId": wire.protocol_id,
                    "protocolVersion": wire.protocol_version,
                    "schemaRef": wire.schema_ref,
                    "encoding": wire.encoding,
                    "bytesHex": wire.bytes.hex(),
                }
            except Exception as error:
                output = {"rawError": str(error)}
            print(json.dumps(output, sort_keys=True, separators=(",", ":")))
            qualification_hold()
            return 0
        if operation in {
            "__runtime_action_wire__",
            "__runtime_action_geometry_root__",
        }:
            typed = (
                geometry_root(storage)
                if operation == "__runtime_action_geometry_root__"
                else None
            )
            wire = (
                typed.wire
                if typed is not None
                else storage.call_runtime_action_raw(request_json.encode("utf-8"))
            )
            output = {
                "protocolId": wire.protocol_id,
                "protocolVersion": wire.protocol_version,
                "schemaRef": wire.schema_ref,
                "encoding": wire.encoding,
                "bytesHex": wire.bytes.hex(),
            }
            if typed is not None:
                output["geometryRoot"] = typed.geometry_root
            print(json.dumps(output, sort_keys=True, separators=(",", ":")))
            qualification_hold()
            return 0
        if storage.capabilities & REQUIRED_CAPABILITIES != REQUIRED_CAPABILITIES:
            raise RuntimeError("incomplete native capability mask")
        result = storage.execute(operation, json.loads(request_json))
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    qualification_hold()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
