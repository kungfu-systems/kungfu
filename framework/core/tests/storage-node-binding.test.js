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
const typedStatusAvailable = typeof kungfu.storageStatusTyped === 'function';

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
  const bundle = kungfu.runStorageServiceOperation(
    'export_bundle',
    runtimeDir,
    {
      scope: 'source',
      source_id: 'node-synth',
    },
  );
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
    layout: kungfu.runStorageServiceOperation('layout', runtimeDir, {
      scope: 'all',
      runtime_home: path.dirname(runtimeDir),
      config_home: path.join(path.dirname(runtimeDir), 'config'),
    }),
    fsck: kungfu.runStorageServiceOperation('fsck', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
    repair: kungfu.runStorageServiceOperation('repair_plan', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
      dry_run: true,
    }),
    repairFetch: kungfu.runStorageServiceOperation('repair_fetch', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
      dry_run: true,
    }),
    repairApply: kungfu.runStorageServiceOperation('repair_apply', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
      dry_run: true,
      bundle,
    }),
    exported: kungfu.exportStorageRecords(runtimeDir, 'node-synth', {
      since: '2026-07-09T00:00:00Z',
    }),
    bundle,
    query: kungfu.runStorageServiceOperation('query', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
      query: 'entries',
      kind: 'note',
      limit: 10,
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

test(
  'Hana typed storage status bypasses JSON stringify/parse transport',
  {
    skip:
      typedStatusAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'typed storage status binding is unavailable',
  },
  () => {
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kf-typed-status-'),
    );
    const originalParse = JSON.parse;
    const originalStringify = JSON.stringify;
    try {
      JSON.parse = () => {
        throw new Error('typed status binding must not call JSON.parse');
      };
      JSON.stringify = () => {
        throw new Error('typed status binding must not call JSON.stringify');
      };
      const status = kungfu.storageStatusTyped(runtimeDir);
      assert.equal(status.ok, true);
      assert.equal(status.source_id, null);
      assert.equal(typeof status.provider_runtime, 'object');
      assert.equal(status.provider_runtime.read_fill_cache, null);
      assert.equal(typeof status.provider_cache.entries, 'bigint');
      assert.equal(Array.isArray(status.projections), true);
      assert.equal(
        status.projections[0].verification.authority,
        'yijinjing-journal',
      );
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

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

bundle = service.build_export_bundle(runtime_dir, source_id="node-synth")
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
    "layout": service.layout(
        runtime_dir,
        runtime_home=str(Path(runtime_dir).parent),
        config_home=str(Path(runtime_dir).parent / "config"),
    ),
    "fsck": service.fsck(runtime_dir, source_id="node-synth"),
    "repair": service.repair_plan(runtime_dir, source_id="node-synth", dry_run=True),
    "repairFetch": service.repair_fetch(runtime_dir, source_id="node-synth", dry_run=True),
    "repairApply": service.repair_apply(
        runtime_dir,
        bundle,
        source_id="node-synth",
        dry_run=True,
    ),
    "exported": service.export_records(
        runtime_dir,
        source_id="node-synth",
        range_filter={"since": "2026-07-09T00:00:00Z"},
    ),
    "bundle": bundle,
    "query": service.query_projection(
        runtime_dir,
        query="entries",
        source_id="node-synth",
        kind="note",
        limit=10,
    ),
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
          const rebuilt = kungfu.runStorageServiceOperation(
            'rebuild_index',
            runtimeDir,
            { scope: 'source', source_id: 'node-synth', dry_run: false },
          );
          assert.equal(rebuilt.ok, true);

          const nodeResults = selectedNodeResults(runtimeDir);
          const pythonResults = selectedPythonResults(runtimeDir);
          // the provider cache and its live handle state are process-local
          // observability (each runtime is its own process with its own
          // cache), so they are asserted per-process and excluded from the
          // cross-runtime equality contract
          assert.equal(
            nodeResults.status.provider_runtime.instance_lifecycle,
            'process-cached',
          );
          assert.equal(nodeResults.status.provider_cache.lifecycle, 'process');
          assert.ok(nodeResults.status.provider_cache.entries >= 1);
          assert.ok(nodeResults.status.provider_cache.hits >= 1);
          const stripProcessLocal = (results) => {
            const strip = ({
              provider_runtime: _runtime,
              provider_cache: _cache,
              ...rest
            }) => rest;
            return {
              ...results,
              status: strip(results.status),
              layout: strip(results.layout),
            };
          };
          assert.deepEqual(
            stripProcessLocal(nodeResults),
            stripProcessLocal(pythonResults),
          );
          assert.equal(
            nodeResults.status.provider,
            providerCase.expectedProvider,
          );
          assert.equal(
            nodeResults.layout.schema,
            'kungfu.workspace.episode-layout/v1',
          );
          assert.equal(
            nodeResults.layout.paths.storage_dir,
            path.join(runtimeDir, 'storage'),
          );
          assert.equal(
            nodeResults.layout.paths.episode_manifest_journal,
            path.join(
              runtimeDir,
              'journal',
              'system',
              'storage',
              'episode-manifest',
              'live',
              '*.journal',
            ),
          );
          assert.equal(
            nodeResults.layout.config_home,
            path.join(path.dirname(runtimeDir), 'config'),
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
          assert.equal(
            nodeResults.repair.schema,
            'kungfu.storage.repair-plan/v1',
          );
          assert.equal(nodeResults.repair.candidate_count, 0);
          assert.equal(
            nodeResults.repairFetch.schema,
            'kungfu.storage.repair-fetch/v1',
          );
          assert.equal(nodeResults.repairFetch.read_only, true);
          assert.equal(nodeResults.repairFetch.matched_count, 0);
          assert.equal(
            nodeResults.repairApply.schema,
            'kungfu.storage.repair-apply/v1',
          );
          assert.equal(nodeResults.repairApply.dry_run, true);
          assert.equal(nodeResults.bundle.records.length, 2);
          assert.equal(nodeResults.exported.length, 1);
          assert.equal(nodeResults.query.row_count, 2);
          assert.equal(
            nodeResults.query.rows[0].storage_source_id,
            'node-synth',
          );
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

test(
  'Node projects the C++ Episode qualification contract without re-derivation',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kf-episode-qualification-node-'),
    );
    try {
      kungfu.runStorageServiceOperation('episode_begin', runtimeDir, {
        episode_id: 901,
        title: 'node qualification projection',
        actor: 'node-test',
        source: 'storage-node-binding',
        begin_time: 1000,
      });
      kungfu.runStorageServiceOperation('episode_end', runtimeDir, {
        episode_id: 901,
        end_time: 2000,
        frame_count: 0,
        reason: 'done',
      });
      const fsck = kungfu.runStorageServiceOperation('fsck', runtimeDir, {
        scope: 'episode',
        episode_id: 901,
      });
      const inspected = kungfu.runStorageServiceOperation(
        'episode_inspect',
        runtimeDir,
        { episode_id: 901 },
      );
      assert.equal(
        fsck.qualification.schema,
        'kungfu.episode.qualification/v1',
      );
      assert.equal(fsck.qualification.policy_source, 'cpp-typed-fold-fsck');
      assert.deepEqual(inspected.qualification, fsck.qualification);
      assert.equal(
        fsck.qualification.safe_capabilities.includes('replay'),
        true,
      );
      assert.equal(
        fsck.qualification.safe_capabilities.includes('append'),
        false,
      );
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

// ADR-0040 stage B: the content-store facade serves Node with the same
// vocabulary as C++/Python over both provider profiles.
for (const provider of ['content-addressed-file', 'rocksdb']) {
  test(
    `content store facade roundtrip (${provider})`,
    {
      skip:
        nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
          ? false
          : 'built kungfu_node binding is unavailable',
    },
    () =>
      withStorageProvider(provider, () => {
        const runtimeDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'kf-content-store-'),
        );
        try {
          const raw = Buffer.from(`node facade payload via ${provider}`);
          const put = kungfu.contentStorePutIfAbsent(
            runtimeDir,
            'payloads',
            raw,
          );
          assert.equal(put.ok, true);
          assert.equal(put.existed, false);
          const digest = put.hash.value;

          const again = kungfu.contentStorePutIfAbsent(
            runtimeDir,
            'payloads',
            raw,
          );
          assert.equal(again.ok, true);
          assert.equal(again.existed, true);

          assert.equal(
            kungfu.contentStoreHas(runtimeDir, 'payloads', `sha256:${digest}`),
            true,
          );
          assert.deepEqual(
            Buffer.from(kungfu.contentStoreGet(runtimeDir, 'payloads', digest)),
            raw,
          );
          const verified = kungfu.contentStoreVerify(
            runtimeDir,
            'payloads',
            digest,
          );
          assert.equal(verified.ok, true);
          assert.equal(verified.byte_length, raw.length);

          const caps = kungfu.contentStoreCapabilities(runtimeDir);
          assert.equal(
            caps.profile,
            provider === 'rocksdb' ? 'kungfu-rocksdb/v1' : 'yijinjing-file/v1',
          );
          assert.equal(caps.verified_reads, true);

          const rejected = kungfu.contentStorePutIfAbsent(
            runtimeDir,
            'payloads',
            Buffer.from('other bytes'),
            `sha256:${'0'.repeat(64)}`,
          );
          assert.equal(rejected.ok, false);
          assert.equal(rejected.error, 'hash_mismatch');
        } finally {
          fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
      }),
  );
}
