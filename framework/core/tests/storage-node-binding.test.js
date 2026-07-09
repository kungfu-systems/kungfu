const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const kungfuFactory = require('../lib/kungfu');

const coreDir = path.resolve(__dirname, '..');
const bindingDir = path.join(coreDir, 'dist', 'kungfu');
const kungfu = kungfuFactory();
const nativeAvailable =
  typeof kungfu.runStorageServiceOperation === 'function' &&
  typeof kungfu.acceptStorageManifest === 'function';

function runtimeEnv() {
  const key =
    process.platform === 'darwin'
      ? 'DYLD_FALLBACK_LIBRARY_PATH'
      : process.platform === 'win32'
        ? 'PATH'
        : 'LD_LIBRARY_PATH';
  const current = process.env[key];
  return {
    ...process.env,
    KUNGFU_DIR: bindingDir,
    [key]: current ? `${bindingDir}${path.delimiter}${current}` : bindingDir,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeRecord(runtimeDir, record) {
  const payload = record.payload ?? record;
  const raw = Buffer.from(stableStringify(payload), 'utf8');
  const digest = kungfu.computeContentHashValue(raw);
  kungfu.writeStoragePayloadBytes(runtimeDir, digest, raw);
  return {
    kind: String(record.kind ?? 'record'),
    source_id: String(record.source_id),
    source_path: String(record.source_path),
    source_time: String(record.source_time ?? ''),
    schema_version: Number(record.schema_version ?? 1),
    content_type: 'application/json',
    payload_hash: digest,
    byte_len: raw.length,
    payload_state: 'present',
  };
}

function writeNodeFixture(runtimeDir) {
  const entries = [
    writeRecord(runtimeDir, {
      kind: 'note',
      source_id: 'note-a',
      source_path: 'notes/a.json',
      source_time: '2026-07-08T00:00:00Z',
      payload: { body: 'alpha', title: 'A' },
    }),
    writeRecord(runtimeDir, {
      kind: 'note',
      source_id: 'note-b',
      source_path: 'notes/b.json',
      source_time: '2026-07-09T00:00:00Z',
      payload: { body: 'beta', title: 'B' },
    }),
  ];
  return kungfu.acceptStorageManifest(runtimeDir, {
    manifest_id: 'node-imp',
    storage_source_id: 'node-synth',
    source_type: 'synthetic',
    source_coordinate: 'synthetic:node-synth',
    source_head: 'head-1',
    scope: 'source',
    range: {},
    counts: { records: entries.length },
    entries,
  });
}

function selectedNodeResults(runtimeDir) {
  return {
    capabilities: kungfu.storageServiceCapabilities(),
    optionRequest: kungfu.makeStorageServiceRequest('status', runtimeDir, {
      provider: 'content-addressed-file',
      scope: 'all',
    }),
    request: kungfu.makeStorageServiceRequest('fsck', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
    status: kungfu.runStorageServiceOperation('status', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
    fsck: kungfu.runStorageServiceOperation('fsck', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
    exported: kungfu.exportStorageRecords(runtimeDir, 'node-synth', {
      since: '2026-07-09T00:00:00Z',
    }),
    bundle: kungfu.runStorageServiceOperation('export_bundle', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
    verify: kungfu.runStorageServiceOperation('verify_sync', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
  };
}

function withStorageProvider(provider, fn) {
  const previous = process.env.KUNGFU_STORAGE_PROVIDER;
  if (provider) {
    process.env.KUNGFU_STORAGE_PROVIDER = provider;
  } else {
    Reflect.deleteProperty(process.env, 'KUNGFU_STORAGE_PROVIDER');
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, 'KUNGFU_STORAGE_PROVIDER');
    } else {
      process.env.KUNGFU_STORAGE_PROVIDER = previous;
    }
  }
}

function selectedPythonResults(runtimeDir) {
  const script = String.raw`
import json
import sys
from pathlib import Path

core_dir = Path(sys.argv[1])
runtime_dir = sys.argv[2]
sys.path.insert(0, str(core_dir / "src" / "python"))
sys.path.insert(0, str(core_dir / "dist" / "kungfu"))

from kungfu.storage import service

out = {
    "capabilities": service.service_capabilities(),
    "optionRequest": service._runtime().make_storage_service_request(
        "status",
        runtime_dir,
        {"provider": "content-addressed-file", "scope": "all"},
    ),
    "request": service._runtime().make_storage_service_request(
        "fsck",
        runtime_dir,
        {"scope": "source", "source_id": "node-synth"},
    ),
    "status": service.status(runtime_dir, source_id="node-synth"),
    "fsck": service.fsck(runtime_dir, source_id="node-synth"),
    "exported": service.export_records(
        runtime_dir,
        source_id="node-synth",
        range_filter={"since": "2026-07-09T00:00:00Z"},
    ),
    "bundle": service.build_export_bundle(runtime_dir, source_id="node-synth"),
    "verify": service.verify_local_sync(runtime_dir, source_id="node-synth"),
}
print(json.dumps(out, sort_keys=True, separators=(",", ":")))
`;
  const result = spawnSync(
    'uv',
    ['run', '--frozen', 'python', '-c', script, coreDir, runtimeDir],
    {
      cwd: coreDir,
      encoding: 'utf8',
      env: runtimeEnv(),
      shell: process.platform === 'win32',
    },
  );
  assert.equal(
    result.status,
    0,
    `python storage shim failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

const providerCases = [
  {
    name: 'content-addressed-file',
    env: undefined,
    expectedProvider: 'content-addressed-file',
    expectedPath: (runtimeDir) => path.join(runtimeDir, 'storage', 'payloads'),
  },
  {
    name: 'rocksdb',
    env: 'rocksdb',
    expectedProvider: 'rocksdb',
    expectedPath: (runtimeDir) => path.join(runtimeDir, 'storage', 'rocksdb'),
  },
];

for (const providerCase of providerCases) {
  test(
    `Node storage binding uses the shared C++ service and matches Python (${providerCase.name})`,
    {
      skip:
        nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
          ? false
          : 'built kungfu_node binding is unavailable',
    },
    () =>
      withStorageProvider(providerCase.env, () => {
        assert.equal(
          nativeAvailable,
          true,
          'built native binding must expose storage service functions',
        );
        const runtimeDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `kf-node-storage-${providerCase.name}-`),
        );
        try {
          const accepted = writeNodeFixture(runtimeDir);
          assert.equal(accepted.schema, 'kungfu.storage.import-manifest/v1');
          assert.equal(accepted.source_id, 'node-synth');

          const nodeResults = selectedNodeResults(runtimeDir);
          const pythonResults = selectedPythonResults(runtimeDir);
          assert.deepEqual(nodeResults, pythonResults);
          assert.equal(
            nodeResults.status.provider,
            providerCase.expectedProvider,
          );
          assert.equal(
            nodeResults.optionRequest.provider,
            'content-addressed-file',
          );
          assert.equal(
            nodeResults.optionRequest.provider_config_source,
            'option',
          );
          assert.equal(
            nodeResults.status.provider_runtime.lifecycle,
            providerCase.expectedProvider === 'rocksdb'
              ? 'provider-instance-owned'
              : 'stateless-filesystem',
          );
          assert.equal(nodeResults.fsck.ok, true);
          assert.equal(nodeResults.bundle.records.length, 2);
          assert.equal(nodeResults.exported.length, 1);
          assert.equal(nodeResults.verify.sync_roots_match, true);
          assert.equal(
            fs.existsSync(providerCase.expectedPath(runtimeDir)),
            true,
          );
        } finally {
          fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
      }),
  );
}
