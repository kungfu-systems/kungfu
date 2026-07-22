// SPDX-License-Identifier: Apache-2.0

const [runtimeDir, operation, requestJson] = process.argv.slice(2);
if (!runtimeDir || !operation || !requestJson) {
  console.error('usage: node-call.cjs RUNTIME_DIR OPERATION REQUEST_JSON');
  process.exit(2);
}
const storage = require('@kungfu-tech/storage');
const qualificationHold = () => {
  const holdMs = Number(process.env.KUNGFU_QUALIFICATION_HOLD_MS || 0);
  if (holdMs > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
};
if (operation === '__runtime_action_interleaved__') {
  const before = storage.capabilities();
  const typed = storage.runtimeActionV1.geometryRoot(storage, runtimeDir);
  const after = storage.capabilities();
  if (!before || !after || !typed.geometryRoot || typed.wire.bytes.length === 0)
    throw new Error('interleaved legacy/runtime-action call failed');
  process.stdout.write('{"interleaved":true}\n');
  qualificationHold();
  process.exit(0);
}
if (operation === '__runtime_action_projection_semantic__') {
  const root = `sha256:${'a'.repeat(64)}`;
  let bytes;
  if (requestJson === 'reordered-envelope')
    bytes = Buffer.from(
      `{"schema":"kungfu.action-runtime.result/v1","result":{"geometryRoot":"${root}"}}`,
    );
  else if (requestJson === 'whitespace-envelope')
    bytes = Buffer.from(
      `{ "result" : { "geometryRoot" : "${root}" }, "schema" : "kungfu.action-runtime.result/v1" }`,
    );
  else throw new Error('unsupported projection-semantic case');
  const result = storage.runtimeActionV1.parseGeometryRoot({
    protocolId: 'kungfu.runtime.action',
    protocolVersion: 1,
    schemaRef: 'kungfu.action-runtime.result/v1',
    encoding: 'application/json',
    bytes,
  });
  process.stdout.write(
    `${JSON.stringify({
      geometryRoot: result.geometryRoot,
      bytesHex: result.wire.bytes.toString('hex'),
    })}\n`,
  );
  qualificationHold();
  process.exit(0);
}
if (operation === '__runtime_action_projection_negative__') {
  const root = `sha256:${'a'.repeat(64)}`;
  const wire = {
    protocolId: 'kungfu.runtime.action',
    protocolVersion: 1,
    schemaRef: 'kungfu.action-runtime.result/v1',
    encoding: 'application/json',
    bytes: Buffer.from(
      `{"result":{"geometryRoot":"${root}"},"schema":"kungfu.action-runtime.result/v1"}`,
    ),
  };
  if (requestJson === 'wrong-metadata')
    wire.schemaRef = 'kungfu.action-runtime.wrong/v1';
  else if (requestJson === 'extra-result-field')
    wire.bytes = Buffer.from(
      `{"result":{"geometryRoot":"${root}","unexpected":true},"schema":"kungfu.action-runtime.result/v1"}`,
    );
  else if (requestJson === 'wrong-layer')
    wire.bytes = Buffer.from(`{"geometryRoot":"${root}"}`);
  else if (requestJson === 'schema-punctuation-mutation')
    wire.bytes = Buffer.from(
      `{"result":{"geometryRoot":"${root}"},"schema":"kungfuXaction-runtimeXresult/v1"}`,
    );
  else if (requestJson === 'short-root')
    wire.bytes = Buffer.from(
      '{"result":{"geometryRoot":"sha256:a"},"schema":"kungfu.action-runtime.result/v1"}',
    );
  else if (requestJson === 'trailing-comma')
    wire.bytes = Buffer.from(
      `{"result":{"geometryRoot":"${root}"},"schema":"kungfu.action-runtime.result/v1",}`,
    );
  else throw new Error('unsupported projection-negative case');
  try {
    storage.runtimeActionV1.parseGeometryRoot(wire);
  } catch {
    process.stdout.write('{"rejected":true}\n');
    qualificationHold();
    process.exit(0);
  }
  throw new Error('generated projection accepted an invalid response');
}
if (
  operation === '__runtime_action_wire__' ||
  operation === '__runtime_action_geometry_root__'
) {
  const result =
    operation === '__runtime_action_geometry_root__'
      ? storage.runtimeActionV1.geometryRoot(storage, runtimeDir)
      : {
          wire: storage.callRuntimeActionRaw(
            runtimeDir,
            Buffer.from(requestJson),
          ),
        };
  const output = {
    protocolId: result.wire.protocolId,
    protocolVersion: result.wire.protocolVersion,
    schemaRef: result.wire.schemaRef,
    encoding: result.wire.encoding,
    bytesHex: result.wire.bytes.toString('hex'),
  };
  if (result.geometryRoot) output.geometryRoot = result.geometryRoot;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  qualificationHold();
  process.exit(0);
}
const capabilities = storage.capabilities();
if (!capabilities || typeof capabilities !== 'object')
  throw new Error('incomplete native capability set');
const result = storage.execute(runtimeDir, operation, JSON.parse(requestJson));
process.stdout.write(`${JSON.stringify(result)}\n`);
qualificationHold();
