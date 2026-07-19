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
const durabilityCapabilityAvailable =
  typeof kungfu.durabilityCapabilityTyped === 'function';
const actionEnvelopeAvailable =
  typeof kungfu.encodeActionEnvelope === 'function' &&
  typeof kungfu.decodeActionEnvelope === 'function';

function runtimeEnv() {
  const key =
    process.platform === 'darwin'
      ? 'DYLD_FALLBACK_LIBRARY_PATH'
      : process.platform === 'win32'
        ? 'PATH'
        : 'LD_LIBRARY_PATH';
  const current = process.env[key];
  const runtimeBindingDir = process.env.KUNGFU_DIR || bindingDir;
  return {
    ...process.env,
    KUNGFU_DIR: runtimeBindingDir,
    [key]: current
      ? `${runtimeBindingDir}${path.delimiter}${current}`
      : runtimeBindingDir,
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

function normalizeTypedIntegers(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : `i64:${value}`;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeTypedIntegers);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeTypedIntegers(item),
      ]),
    );
  }
  return value;
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

function selectedNodeResults(runtimeDir, provider) {
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
      provider,
      scope: 'all',
    }),
    request: kungfu.makeStorageServiceRequest('fsck', runtimeDir, {
      scope: 'source',
      source_id: 'node-synth',
    }),
    status: kungfu.storageStatusTyped(runtimeDir, 'node-synth'),
    layout: kungfu.storageLayoutTyped(runtimeDir, {
      runtime_home: path.dirname(runtimeDir),
      config_home: path.join(path.dirname(runtimeDir), 'config'),
    }),
    fsck: kungfu.storageFsckTyped(runtimeDir, {
      source_id: 'node-synth',
    }),
    repair: kungfu.storageRepairPlanTyped(runtimeDir, {
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
    query: kungfu.storageQueryTyped(runtimeDir, 'entries', {
      source_id: 'node-synth',
      entry_kind: 'note',
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

function removeRuntimeDir(runtimeDir, provider) {
  try {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  } catch (error) {
    const expectedLockedDatabase =
      process.platform === 'win32' &&
      provider === 'rocksdb' &&
      error?.code === 'EBUSY' &&
      path.basename(error.path || '') === 'LOCK';
    if (!expectedLockedDatabase) {
      throw error;
    }
    // The RocksDB provider is deliberately process-cached. Windows refuses
    // to unlink its live LOCK file, unlike POSIX, so the process temp area
    // owns cleanup after this test process exits.
  }
}

test(
  'Node KFX registry projection returns the Core canonical plan root',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built native storage binding is unavailable',
  },
  () => {
    const fixtureRoot = path.join(
      coreDir,
      'src',
      'libkungfu',
      'tests',
      'fixtures',
      'native_kfx_registry',
      'roots',
      'workspace',
    );
    const request = {
      roots: [{ kind: 'workspace', path: fixtureRoot }],
      runtimeTiers: { 'optional-view': 'verified-third-party' },
    };
    const plan = kungfu.runStorageServiceOperation('kfx_runtime', '', {
      action: 'plan',
      request,
    });
    const resolved = kungfu.runStorageServiceOperation('kfx_runtime', '', {
      action: 'resolve',
      request: { ...request, suiteKey: 'example-suite' },
    });
    assert.match(plan.planRoot, /^sha256:[0-9a-f]{64}$/);
    assert.equal(plan.suites[0].suiteRoot, resolved.suite.suiteRoot);
    assert.equal(plan.suites[0].profileRoot, resolved.suite.profileRoot);
  },
);

test(
  'Node KFX assessment replays the published Buildchain envelope at the Core report root',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built native storage binding is unavailable',
  },
  () => {
    const fixtureRoot = path.join(
      coreDir,
      'src',
      'libkungfu',
      'tests',
      'fixtures',
      'native_kfx_registry',
      'roots',
      'workspace',
    );
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(
          coreDir,
          'src',
          'libkungfu',
          'tests',
          'fixtures',
          'native_kfx_contract',
          'buildchain-2.13.0-alpha.0-envelope.json',
        ),
        'utf8',
      ),
    );
    const request = {
      roots: [{ kind: 'workspace', path: fixtureRoot }],
      runtimeTiers: { 'optional-view': 'verified-third-party' },
      ...fixture.admission,
      assessmentTime: fixture.assessmentTime,
      attestation: fixture.projection.attestation,
      trustInputs: fixture.projection.trustInputs,
      kfdAssessment: fixture.projection.kfdAssessment,
    };
    const result = kungfu.runStorageServiceOperation('kfx_runtime', '', {
      action: 'assess',
      request,
    });
    assert.equal(result.trustReport.supplyChainGrade, 'kfd-attested');
    assert.equal(
      result.trustReport.reportRoot,
      fixture.expected.coreReportRoot,
    );
  },
);

test(
  'Node action envelope uses verified FlatBuffers bytes and a Raw carrier',
  {
    skip:
      actionEnvelopeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built action envelope binding is unavailable',
  },
  () => {
    const value = {
      version: 1,
      action_type: 'rewind.model.response',
      schema_ref: { id: 'kungfu.rewind.ModelResponse', version: 3 },
      actor: { id: 'agent-1', kind: 'agent' },
      session: { run_id: 'run-1' },
      payload: {
        encoding: 'flatbuffers',
        data: Buffer.from('payload'),
      },
    };
    const encoded = Buffer.from(kungfu.encodeActionEnvelope(value));
    assert.notEqual(encoded[0], '{'.charCodeAt(0));
    assert.equal(encoded.subarray(4, 8).toString('ascii'), 'KFAE');

    const decoded = kungfu.decodeActionEnvelope(encoded);
    assert.equal(decoded.action_type, value.action_type);
    assert.deepEqual(decoded.schema_ref, value.schema_ref);
    assert.equal(decoded.payload.encoding, 1);
    assert.deepEqual(Buffer.from(decoded.payload.data), Buffer.from('payload'));
    assert.equal(decoded.payload.hash_algorithm, 'sha256');
    assert.match(decoded.payload.hash, /^[0-9a-f]{64}$/);
    assert.equal(decoded.payload.byte_len, 7n);
    const envelopeSchema = fs.readFileSync(
      path.join(coreDir, 'src', 'libkungfu', 'schema', 'ActionEnvelope.bfbs'),
    );
    assert.equal(kungfu.verifyFlatbufferPayload(envelopeSchema, encoded), true);
    assert.equal(
      kungfu.verifyFlatbufferPayload(envelopeSchema, encoded.subarray(0, 16)),
      false,
    );

    const corrupted = Buffer.from(encoded);
    corrupted[corrupted.indexOf(Buffer.from('payload'))] ^= 0xff;
    assert.equal(kungfu.decodeActionEnvelope(corrupted), null);

    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kf-action-envelope-node-'),
    );
    const recorder = kungfu.ActionRecorder(runtimeDir, 'action', 'binary');
    const receipt = recorder.recordAction(value);
    assert.equal(receipt.carrierType, kungfu.ACTION_ENVELOPE_CARRIER_TYPE);
    assert.equal(receipt.dataType, 0);
  },
);

test(
  'Node durability capability preserves the libkungfu claim boundary',
  {
    skip:
      durabilityCapabilityAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'durability capability binding is unavailable',
  },
  () => {
    const report = kungfu.durabilityCapabilityTyped();
    assert.equal(report.schema, 'kungfu.durability.capability/v1');
    assert.equal(report.authority, 'libkungfu');
    assert.equal(report.support_level, 'production-candidate');
    assert.equal(report.production_eligible, false);
    assert.equal(report.restore.verified, true);
    assert.equal(report.restore.off_host, true);
    assert.equal(report.restore.independent_failure_domain, false);
    assert.equal(report.admission.current_hardware_candidate_complete, true);
    assert.equal(report.admission.candidate_profile_default_enabled, false);
    assert.equal(report.admission.clean_host_restart_qualified, true);
    assert.equal(report.admission.physical_power_loss_qualified, false);
    assert.equal(report.admission.production_eligible, false);
    assert.deepEqual(
      report.evidence.map((evidence) => evidence.id),
      [
        'live-durable-receipts',
        'projection-authority-candidate',
        'agent120-fault-campaign',
        'agent120-durability-slo',
        'same-office-offhost-restore',
        'agent120-clean-host-restart',
        'production-candidate-admission',
      ],
    );
    assert.deepEqual(
      report.profiles.map((profile) => profile.name),
      ['visible', 'durable_group', 'durable_sync', 'replicated'],
    );
  },
);

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
    kungfu.runStorageServiceOperation('episode_begin', runtimeDir, {
      episode_id: '701',
      location_uid: 17,
      title: 'typed-query',
      actor: 'binding-test',
    });
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
      const query = kungfu.storageQueryTyped(runtimeDir, 'episode_records', {
        episode_id: 701n,
      });
      const gc = kungfu.storageGcPlanTyped(runtimeDir);
      const rebuild = kungfu.storageRebuildIndexTyped(runtimeDir, {
        dry_run: true,
      });
      const compact = kungfu.storageCompactPlanTyped(runtimeDir);
      const fsck = kungfu.storageFsckTyped(runtimeDir, { episode_id: 701n });
      const repair = kungfu.storageRepairPlanTyped(runtimeDir, {
        episode_id: 701n,
        dry_run: true,
      });
      const episode = kungfu.storageEpisodeBeginTyped(runtimeDir, {
        episode_id: 702n,
        begin_time: 1000,
        title: 'typed-writer',
      });
      const heartbeat = kungfu.storageEpisodeHeartbeatTyped(runtimeDir, {
        episode_id: 702n,
        update_time: 1100,
      });
      const attachedRef = kungfu.storageEpisodeAttachRefTyped(runtimeDir, {
        episode_id: 702n,
        ref_kind: 'input_frame',
        ref_uid: 9n,
      });
      const attachedFrame = kungfu.storageEpisodeAttachFrameTyped(runtimeDir, {
        episode_id: 702n,
        frame_uid: 10n,
        gen_time: 1200,
      });
      const closed = kungfu.storageEpisodeCloseTyped(runtimeDir, {
        episode_id: 702n,
        end_time: 1300,
        frame_count: 1n,
      });
      const listed = kungfu.storageEpisodeListTyped(runtimeDir);
      const inspected = kungfu.storageEpisodeInspectTyped(runtimeDir, {
        episode_id: 702n,
      });
      kungfu.storageEpisodeBeginTyped(runtimeDir, {
        episode_id: 703n,
        begin_time: 1400,
      });
      const recovered = kungfu.storageEpisodeRecoverTyped(runtimeDir, {
        episode_id: 703n,
        end_time: 1500,
      });
      const projection =
        kungfu.storageEpisodeProjectionRebuildTyped(runtimeDir);
      const registeredSource = kungfu.storageSourceRegisterTyped(runtimeDir, {
        source_id: 'typed-source',
        kind: 'adapter',
        coordinate: 'adapter://typed',
      });
      const updatedSource = kungfu.storageSourceUpdateHeadTyped(runtimeDir, {
        source_id: 'typed-source',
        update_time: 1600,
        head: 'head-1',
      });
      const acceptedRange = kungfu.storageSourceRecordAcceptedRangeTyped(
        runtimeDir,
        {
          source_id: 'typed-source',
          manifest_id: 'manifest-1',
          accept_time: 1700,
        },
      );
      const sourceList = kungfu.storageSourceListTyped(runtimeDir);
      const sourceInspect = kungfu.storageSourceInspectTyped(runtimeDir, {
        source_id: 'typed-source',
      });
      const sourceFsck = kungfu.storageSourceRegistryFsckTyped(runtimeDir, {
        source_id: 'typed-source',
      });
      const sourceRebuild =
        kungfu.storageSourceRegistryRebuildTyped(runtimeDir);
      const layout = kungfu.storageLayoutTyped(runtimeDir, {
        runtime_home: path.dirname(runtimeDir),
      });
      assert.equal(query.query, 4);
      assert.equal(query.rows[0].body.title, 'typed-query');
      assert.equal(query.rows[0].body.location_uid, 17);
      assert.equal(gc.dry_run, true);
      assert.equal(rebuild.would_write, true);
      assert.equal(compact.dry_run, true);
      assert.equal(fsck.scope, 2);
      assert.equal(fsck.episode_id, 701n);
      assert.equal(repair.scope, 2);
      assert.equal(repair.episode_id, 701n);
      assert.equal(repair.dry_run, true);
      assert.equal(episode.episode_id, 702n);
      assert.equal(heartbeat.update_time, 1100n);
      assert.equal(attachedRef.ref_kind, 1);
      assert.equal(attachedFrame.frame_uid, 10n);
      assert.equal(closed.close.status, 2);
      assert.equal(listed.episodes[0].episode_id, 702n);
      assert.equal(inspected.content_root.status, 4);
      assert.equal(recovered.recovered[0].close.status, 3);
      assert.equal(projection.authority, 'yijinjing-journal');
      assert.equal(registeredSource.kind, 4);
      assert.equal(updatedSource.head, 'head-1');
      assert.equal(acceptedRange.status, 1);
      assert.equal(
        sourceList.sources[0].source_uid,
        registeredSource.source_uid,
      );
      assert.equal(sourceInspect.source.current_head, 'head-1');
      assert.equal(sourceFsck.journal.ok, true);
      assert.equal(sourceRebuild.authority, 'yijinjing-journal');
      assert.equal(layout.owner, 'libkungfu');
      assert.equal(layout.runtime_home, path.dirname(runtimeDir));
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

function selectedPythonResults(runtimeDir, provider) {
  const script = String.raw`
import json
import os
import sys
from pathlib import Path

core_dir = Path(sys.argv[1])
runtime_dir = sys.argv[2]
provider = sys.argv[3]
sys.path.insert(0, str(core_dir / "src" / "python"))
sys.path.insert(0, os.environ["KUNGFU_DIR"])

from kungfu.storage import service

bundle = service.build_export_bundle(runtime_dir, source_id="node-synth")
out = {
    "capabilities": service.service_capabilities(),
    "optionRequest": service._runtime().make_storage_service_request(
        "status",
        runtime_dir,
        {"provider": provider, "scope": "all"},
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
    "query": service._runtime().storage_query_typed(
        runtime_dir,
        "entries",
        source_id="node-synth",
        entry_kind="note",
        limit=10,
    ),
    "verify": service.verify_local_sync(runtime_dir, source_id="node-synth"),
}
def node_safe(value):
    if isinstance(value, dict):
        return {key: node_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [node_safe(item) for item in value]
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2**53 - 1:
        return f"i64:{value}"
    return value

print(json.dumps(node_safe(out), sort_keys=True, separators=(",", ":")))
`;
  const scriptPath = path.join(runtimeDir, 'storage-node-shim.py');
  fs.writeFileSync(scriptPath, script, 'utf8');
  const result = spawnSync(
    'uv',
    ['run', '--frozen', 'python', scriptPath, coreDir, runtimeDir, provider],
    {
      cwd: coreDir,
      encoding: 'utf8',
      env: runtimeEnv(),
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

          const nodeResults = normalizeTypedIntegers(
            selectedNodeResults(runtimeDir, providerCase.expectedProvider),
          );
          const pythonResults = selectedPythonResults(
            runtimeDir,
            providerCase.expectedProvider,
          );
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
            const stripExportCount = (value) => {
              if (Array.isArray(value)) {
                return value.map(stripExportCount);
              }
              if (value === null || typeof value !== 'object') {
                return value;
              }
              const normalized = Object.fromEntries(
                Object.entries(value).map(([key, item]) => [
                  key,
                  key === 'export_bundle_recorded' ? 0 : stripExportCount(item),
                ]),
              );
              if (normalized.table === 'export_bundle_recorded') {
                normalized.count = 0;
              }
              if (normalized.manifest_catalog) {
                normalized.manifest_catalog.exports = 0;
              }
              return normalized;
            };
            return stripExportCount({
              ...results,
              status: strip(results.status),
              layout: strip(results.layout),
            });
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
            providerCase.expectedProvider,
          );
          assert.equal(
            nodeResults.optionRequest.provider_config_source,
            'binding:generation-1',
          );
          assert.equal(
            nodeResults.status.provider_runtime.lifecycle,
            providerCase.expectedProvider === 'rocksdb'
              ? 'provider-instance-owned'
              : 'stateless-filesystem',
          );
          assert.equal(nodeResults.fsck.ok, true);
          assert.equal(nodeResults.repair.candidates.length, 0);
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
          assert.equal(nodeResults.query.rows.length, 2);
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
          removeRuntimeDir(runtimeDir, providerCase.env);
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
      const queryExamples = kungfu.runStorageServiceOperation(
        'query_plan',
        runtimeDir,
        { action: 'examples' },
      );
      const queryDefinition = structuredClone(
        queryExamples.examples[0].definition,
      );
      queryDefinition.basis.episode_id = '901';
      queryDefinition.basis.cut = { kind: 'head' };
      queryDefinition.evidence = 'proof';
      const factQuery = kungfu.runStorageServiceOperation(
        'fact_query',
        runtimeDir,
        {
          definition: queryDefinition,
        },
      );
      const queryPlan = kungfu.runStorageServiceOperation(
        'query_plan',
        runtimeDir,
        {
          action: 'explain',
          definition: factQuery.definition,
        },
      );
      assert.equal(
        fsck.qualification.schema,
        'kungfu.episode.qualification/v1',
      );
      assert.equal(
        queryPlan.logical_plan.logical_plan_hash,
        factQuery.lineage.logical_plan_hash,
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
      assert.equal(factQuery.schema, 'kungfu.query.result/v1');
      assert.equal(factQuery.rows[0].status, 'ended');
      assert.equal(factQuery.lineage.authority.kind, 'yijinjing-journal');
      assert.equal(factQuery.lineage.determinism, 'deterministic');
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

test(
  'runtime-independent query metadata does not require a storage root',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const examples = kungfu.runStorageServiceOperation('query_plan', '', {
      action: 'examples',
    });
    assert.equal(examples.schema, 'kungfu.query.examples/v1');
    assert.equal(examples.examples.length > 0, true);
  },
);

test(
  'saved query catalog is journal-backed and shared across the Node edge',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kf-saved-query-node-'),
    );
    try {
      const examples = kungfu.runStorageServiceOperation(
        'query_plan',
        runtimeDir,
        { action: 'examples' },
      );
      const savedView = {
        schema: 'kungfu.query.saved-view/v1',
        name: 'node attention',
        definition: examples.examples[0].definition,
        view: { kind: 'table', columns: ['episode_id', 'status'] },
      };
      const created = kungfu.runStorageServiceOperation(
        'saved_query_catalog',
        runtimeDir,
        { action: 'put', query_id: 'node-attention', saved_view: savedView },
      );
      assert.equal(created.revision, 1);
      assert.equal(created.saved_view_hash.startsWith('sha256:'), true);

      savedView.view = {
        kind: 'timeline',
        timeField: 'begin_time',
        labelField: 'episode_id',
      };
      const updated = kungfu.runStorageServiceOperation(
        'saved_query_catalog',
        runtimeDir,
        {
          action: 'put',
          query_id: 'node-attention',
          expected_revision: 1,
          saved_view: savedView,
        },
      );
      const listed = kungfu.runStorageServiceOperation(
        'saved_query_catalog',
        runtimeDir,
        { action: 'list' },
      );
      const rebuilt = kungfu.runStorageServiceOperation(
        'saved_query_catalog',
        runtimeDir,
        { action: 'rebuild' },
      );
      assert.equal(updated.revision, 2);
      assert.equal(listed.count, 1);
      assert.equal(listed.entries[0].saved_view.view.kind, 'timeline');
      assert.equal(rebuilt.authority_records, 2);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

test(
  'domain fact contract is owned by libkungfu across the Node edge',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const contract = kungfu.runStorageServiceOperation('fact_contract', '', {});
    assert.equal(contract.schema, 'kungfu.facts.domain-admission/v1');
    assert.equal(contract.schema_owner, 'flatbuffers');
    assert.deepEqual(contract.observation_actions, [
      'assert',
      'correct',
      'retract',
    ]);
    assert.deepEqual(contract.admission_outcomes, [
      'admitted',
      'unregistered-surface',
      'incompatible-schema',
      'ambiguous-authority',
      'unverifiable',
    ]);
    assert.equal(contract.schema_root.startsWith('sha256:'), true);
  },
);

test(
  'Fact Root KFR2 C++ authority matches every language-neutral conformance vector',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const corpus = JSON.parse(
      fs.readFileSync(
        path.join(
          coreDir,
          '..',
          '..',
          'tests',
          'fixtures',
          'fact-root-canonical',
          'vectors.json',
        ),
        'utf8',
      ),
    );
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kf-fact-root-canonical-'),
    );
    try {
      for (const vector of corpus.accepted) {
        const result = kungfu.runStorageServiceOperation(
          'fact_kernel',
          runtimeDir,
          { action: 'canonical-root', value: vector.value },
        );
        assert.equal(result.ok, true, vector.id);
        assert.equal(result.write_occurred, false, vector.id);
        assert.equal(
          result.canonical_bytes_hex,
          vector.canonicalBytesHex,
          vector.id,
        );
        assert.equal(result.root, vector.root, vector.id);
      }
      for (const vector of corpus.rejected) {
        const result = kungfu.runStorageServiceOperation(
          'fact_kernel',
          runtimeDir,
          { action: 'canonical-root', value: vector.value },
        );
        assert.equal(result.ok, false, vector.id);
        assert.equal(result.write_occurred, false, vector.id);
        assert.equal(result.failure_code, vector.failureCode, vector.id);
      }
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

test(
  'generic Fact kernel preserves immutable roots and rejects stale ref CAS without a write',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const runtimeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kf-native-fact-kernel-'),
    );
    const root = (digit) => `sha256:${digit.repeat(64)}`;
    const run = (action, request = {}) =>
      normalizeTypedIntegers(
        kungfu.runStorageServiceOperation('fact_kernel', runtimeDir, {
          action,
          ...request,
        }),
      );
    try {
      const capabilities = run('capabilities');
      assert.equal(capabilities.owner, 'libkungfu');
      assert.equal(capabilities.authority, 'yijinjing-hana-pod-journal');
      assert.equal(capabilities.clock_free_identity, true);

      const objectId = `fact:${'a'.repeat(32)}`;
      const object = run('object-put', {
        object_id: objectId,
        object_type: 'generic.note',
        created_by_receipt_root: root('1'),
      });
      assert.equal(object.ok, true);
      assert.match(object.result.object_root, /^sha256:[0-9a-f]{64}$/);

      const beforeRejectedVersion = run('query');
      const rejectedVersion = run('version-put', {
        object_id: objectId,
        body: 'unsupported-body',
        schema_root: root('2'),
        parent_version_roots: [],
        declaration_roots: [],
        admission_roots: [],
      });
      assert.equal(rejectedVersion.failure_code, 'admission-missing');
      assert.equal(rejectedVersion.write_occurred, false);
      assert.deepEqual(run('query').counts, beforeRejectedVersion.counts);

      const version = run('version-put', {
        object_id: objectId,
        body: 'opaque-body',
        schema_root: root('2'),
        parent_version_roots: [],
        declaration_roots: [root('1')],
        admission_roots: [root('3')],
      });
      assert.equal(version.ok, true);

      const endpointWithUnknownField = run('relation-add', {
        relation_id: `fact:${'b'.repeat(32)}`,
        relation_type: 'generic.reference',
        source: { kind: 'logical-object', id: objectId, display_name: 'leak' },
        target: { kind: 'logical-object', id: objectId },
        attributes_root: root('4'),
        admission_roots: [root('3')],
      });
      assert.equal(
        endpointWithUnknownField.failure_code,
        'relation-endpoint-invalid',
      );
      assert.equal(endpointWithUnknownField.write_occurred, false);

      const duplicateEpisode = run('cut-put', {
        parent_cut_roots: [],
        object_versions: [
          { object_id: objectId, version_root: version.result.version_root },
        ],
        active_relation_roots: [],
        declaration_roots: [root('1')],
        admission_roots: [root('3')],
        episode_frontier: [
          {
            episode_id: 7,
            sealed_content_root: root('5'),
            accepted_manifest_frame_uid: 'uid-a',
          },
          {
            episode_id: 7,
            sealed_content_root: root('6'),
            accepted_manifest_frame_uid: 'uid-b',
          },
        ],
        omission_roots: [],
        conflict_roots: [],
      });
      assert.equal(duplicateEpisode.failure_code, 'invalid-cut');
      assert.equal(duplicateEpisode.write_occurred, false);

      const cut = run('cut-put', {
        parent_cut_roots: [],
        object_versions: [
          { object_id: objectId, version_root: version.result.version_root },
        ],
        active_relation_roots: [],
        declaration_roots: [root('1')],
        admission_roots: [root('3')],
        episode_frontier: [],
        omission_roots: [],
        conflict_roots: [],
      });
      assert.equal(cut.ok, true);

      const moved = run('ref-cas', {
        transition_id: 'transition-1',
        ref_name: 'heads/main',
        expected_old_cut_root: null,
        expected_old_revision: 0,
        new_cut_root: cut.result.cut_root,
        kind: 'create',
        reason_root: root('1'),
      });
      assert.equal(moved.ok, true);
      assert.equal(moved.result.current_revision, 1);
      assert.equal(moved.receipt.writeOccurred, true);

      const replay = run('ref-cas', {
        transition_id: 'transition-1',
        ref_name: 'heads/main',
        expected_old_cut_root: null,
        expected_old_revision: 0,
        new_cut_root: cut.result.cut_root,
        kind: 'create',
        reason_root: root('1'),
      });
      assert.equal(replay.status, 'idempotent-replay');
      assert.equal(replay.write_occurred, false);

      const reusedTransition = run('ref-cas', {
        transition_id: 'transition-1',
        ref_name: 'heads/main',
        expected_old_cut_root: cut.result.cut_root,
        expected_old_revision: 1,
        new_cut_root: cut.result.cut_root,
        kind: 'advance',
        reason_root: root('1'),
      });
      assert.equal(reusedTransition.failure_code, 'transition-id-reused');
      assert.equal(reusedTransition.write_occurred, false);

      const missingExpectedOld = run('ref-cas', {
        transition_id: 'transition-missing-expected-old',
        ref_name: 'heads/main',
        new_cut_root: cut.result.cut_root,
        kind: 'advance',
        reason_root: root('1'),
      });
      assert.equal(missingExpectedOld.failure_code, 'expected-old-required');
      assert.equal(missingExpectedOld.write_occurred, false);

      const before = run('query');
      assert.equal(before.counts.unknown_records, 0);
      const stale = run('ref-cas', {
        transition_id: 'transition-2',
        ref_name: 'heads/main',
        expected_old_cut_root: root('9'),
        expected_old_revision: 0,
        new_cut_root: cut.result.cut_root,
        kind: 'advance',
        reason_root: root('1'),
      });
      const after = run('query');
      assert.equal(stale.failure_code, 'stale-ref');
      assert.equal(stale.write_occurred, false);
      assert.deepEqual(after.counts, before.counts);

      const projected = run('query', { ref_name: 'heads/main' });
      assert.equal(projected.cut_root, cut.result.cut_root);
      assert.deepEqual(projected.objects[0].member, [
        objectId,
        version.result.version_root,
      ]);
      assert.equal(projected.ref_resolution.revision, 1);
      assert.equal('body' in projected.objects[0], false);

      const projectedWithBodies = run('query', {
        ref_name: 'heads/main',
        include_bodies: true,
      });
      assert.equal(projectedWithBodies.objects[0].body_status, 'present');
      assert.equal(projectedWithBodies.objects[0].body, 'opaque-body');
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  },
);

test(
  'assessment contract and lifecycle operations are owned by libkungfu across the Node edge',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const contract = kungfu.runStorageServiceOperation(
      'assessment_contract',
      '',
      {},
    );
    assert.equal(contract.schema, 'kungfu.trust.assessment/v1');
    assert.equal(contract.schema_owner, 'flatbuffers');
    assert.deepEqual(contract.executor_profiles, [
      'inline',
      'thread',
      'process',
    ]);
    assert.equal(contract.schema_root.startsWith('sha256:'), true);
    assert.equal(
      kungfu
        .storageServiceCapabilities()
        .operations.includes('assessment_execute'),
      true,
    );
  },
);

test(
  'embedded assessment dispatch uses a real C++ thread without changing report identity',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () => {
    const execute = (executorProfile) => {
      const runtimeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `kf-assessment-${executorProfile}-`),
      );
      try {
        kungfu.runStorageServiceOperation('episode_begin', runtimeDir, {
          episode_id: 920,
          title: 'assessment thread dispatch',
          actor: 'node-test',
          source: 'storage-node-binding',
          begin_time: 1000,
        });
        const closed = kungfu.runStorageServiceOperation(
          'episode_end',
          runtimeDir,
          {
            episode_id: 920,
            end_time: 1100,
            frame_count: 0,
            reason: 'sealed before assessment',
          },
        );
        const root = (char) => `sha256:${char.repeat(64)}`;
        const requested = kungfu.runStorageServiceOperation(
          'assessment_request',
          runtimeDir,
          {
            system_time: 1200,
            request: {
              claim_id: 'claim-release-ready',
              claim_type: 'release-readiness',
              purpose: 'release-gate',
              work_episode_id: 920,
              work_episode_root: `sha256:${closed.content_root.root_value}`,
              query_definition_root: root('1'),
              query_proof_root: root('2'),
              contract_world: {
                id: 'kungfu-runtime',
                version: 'v1',
                root: root('3'),
              },
              fact_surfaces: [
                { id: 'release-facts', version: 'v1', root: root('4') },
              ],
              policy: {
                id: 'deterministic-assessor',
                version: 'v1',
                root: root('5'),
              },
              evidence: {
                canonical_fact_count: 3,
                conflict_count: 0,
                admitted_count: 3,
                unregistered_surface_count: 0,
                incompatible_schema_count: 0,
                ambiguous_authority_count: 0,
                unverifiable_count: 0,
              },
              deadline: 0,
              responsibility: 'workspace-coordinator',
              residual_risks: ['first built-in assessor only'],
            },
          },
        );
        return kungfu.runStorageServiceOperation(
          'assessment_execute',
          runtimeDir,
          {
            assessment_key: requested.assessment_key,
            executor_profile: executorProfile,
            system_time: 1300,
          },
        );
      } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      }
    };

    const inline = execute('inline');
    const threaded = execute('thread');
    assert.equal(inline.execution.separate_thread_dispatch, false);
    assert.equal(threaded.execution.separate_thread_dispatch, true);
    assert.deepEqual(threaded.report, inline.report);
    assert.equal(threaded.report.report_hash, inline.report.report_hash);
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
          removeRuntimeDir(runtimeDir, provider);
        }
      }),
  );
}

test(
  'Node observes the authority-atomic switch and rollback receipt',
  {
    skip:
      nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
        ? false
        : 'built kungfu_node binding is unavailable',
  },
  () =>
    withStorageProvider(null, () => {
      const runtimeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'kf-backend-switch-'),
      );
      try {
        const before = Buffer.from('node object before switch');
        assert.equal(
          kungfu.contentStorePutIfAbsent(runtimeDir, 'payloads', before).ok,
          true,
        );

        const switched = kungfu.runStorageServiceOperation(
          'backend_switch',
          runtimeDir,
          {
            target_provider: 'rocksdb',
            expected_generation: '1',
          },
        );
        assert.equal(
          switched.schema,
          'kungfu.storage.backend-switch-receipt/v1',
        );
        assert.equal(switched.source_provider, 'content-addressed-file');
        assert.equal(switched.target_provider, 'rocksdb');
        assert.equal(switched.target_generation, 2);
        assert.equal(switched.target_fsck.ok, true);

        withStorageProvider('content-addressed-file', () => {
          const mismatch = kungfu.runStorageServiceOperation(
            'backend_status',
            runtimeDir,
            {},
          );
          assert.equal(mismatch.ok, false);
          assert.match(mismatch.warnings[0], /provider_binding_mismatch/);
          assert.throws(
            () =>
              kungfu.contentStorePutIfAbsent(
                runtimeDir,
                'payloads',
                Buffer.from('must not reach retained file provider'),
              ),
            /provider_binding_mismatch/,
          );
        });

        const after = Buffer.from('node object after switch');
        const stored = kungfu.contentStorePutIfAbsent(
          runtimeDir,
          'schemas',
          after,
        );
        assert.equal(stored.ok, true);

        const rolledBack = kungfu.runStorageServiceOperation(
          'backend_rollback',
          runtimeDir,
          { expected_generation: '2' },
        );
        assert.equal(rolledBack.action, 'rollback');
        assert.equal(rolledBack.source_provider, 'rocksdb');
        assert.equal(rolledBack.target_provider, 'content-addressed-file');
        assert.equal(rolledBack.target_generation, 3);
        assert.deepEqual(
          Buffer.from(
            kungfu.contentStoreGet(runtimeDir, 'schemas', stored.hash.value),
          ),
          after,
        );

        const status = kungfu.runStorageServiceOperation(
          'backend_status',
          runtimeDir,
          {},
        );
        assert.equal(status.provider, 'content-addressed-file');
        assert.equal(status.binding.generation, 3);
        assert.equal(status.binding.operation_id, rolledBack.operation_id);
      } finally {
        removeRuntimeDir(runtimeDir, 'rocksdb');
      }
    }),
);
