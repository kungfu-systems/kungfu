// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'kfd-support-matrix.mjs');
const SHIFU = path.join(ROOT, 'shifu');
const MANIFEST = '.buildchain/kfd/adopter-manifest.json';
const GATE = '.buildchain/kfd/adopter-manifest-gate.json';
const MATRIX = '.buildchain/kfd/support-matrix.json';
const CLOSURE_PATHS = [
  MANIFEST,
  GATE,
  MATRIX,
  'developer/sdk/kfd/adopter-manifest.json',
  'developer/sdk/kfd/adopter-manifest-gate.json',
  'developer/sdk/kfd/support-matrix.json',
  'docs/qualification/kfd-support-matrix.md',
  '.buildchain/kfd/kfd-3/surfaces.json',
  '.buildchain/kfd/kfd-3/capability-query.json',
];

function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

function writeJson(root, relative, value) {
  writeFileSync(
    path.join(root, relative),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function copyRelative(target, relative) {
  const destination = path.join(target, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(ROOT, relative), destination);
}

function localEvidencePaths(manifest) {
  const result = new Set();
  for (const decision of manifest.decisions) {
    for (const group of [
      'implementationEvidence',
      'verificationEvidence',
      'negativeEvidence',
      'reviews',
    ]) {
      for (const evidence of decision[group] || []) {
        if (
          evidence.coordinate?.startsWith(
            'git+https://github.com/kungfu-systems/kungfu.git@',
          )
        ) {
          result.add(
            evidence.coordinate.slice(evidence.coordinate.indexOf('#') + 1),
          );
        }
      }
    }
    for (const witness of decision.witnessBindings || []) {
      if (witness.witnessCoordinate?.startsWith('kungfu-systems/kungfu@')) {
        result.add(
          witness.witnessCoordinate.slice(
            witness.witnessCoordinate.indexOf('#') + 1,
          ),
        );
      }
    }
  }
  return [...result];
}

function fixture(t, mutate = () => {}, args = ['--validate']) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kungfu-kfd-closure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = readJson(ROOT, MANIFEST);
  for (const relative of [...CLOSURE_PATHS, ...localEvidencePaths(manifest)]) {
    copyRelative(directory, relative);
  }
  mutate(directory);
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, KUNGFU_KFD_CLOSURE_ROOT: directory },
    encoding: 'utf8',
  });
}

function mutateJson(relative, update) {
  return (directory) => {
    const value = readJson(directory, relative);
    update(value, directory);
    writeJson(directory, relative, value);
  };
}

function diagnosis(result) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema, 'shifu.kfd-source-diagnosis/v1');
  return value;
}

test('validates the exact standard full-cut closure with the declared verifier boundary', (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.rowCount, 13);
  assert.equal(
    report.verificationMode,
    process.env.KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE === '1'
      ? 'cold-source'
      : 'published-package',
  );
  assert.match(report.manifestRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(report.manifestGateRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('fails closed when a manifest decision is omitted or duplicated', (t) => {
  for (const update of [
    (manifest) => manifest.decisions.pop(),
    (manifest) => {
      manifest.decisions[12] = structuredClone(manifest.decisions[11]);
    },
  ]) {
    const result = fixture(t, mutateJson(MANIFEST, update));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /complete KFD-1\.\.13 cut|decision order or closure/,
    );
  }
});

test('fails closed when the gate fails or loses its exact source binding', (t) => {
  const failed = fixture(
    t,
    mutateJson(GATE, (gate) => {
      gate.status = 'failed';
    }),
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /gate identity or exact cut drifted/);

  const sourceDrift = fixture(
    t,
    mutateJson(GATE, (gate) => {
      gate.gateResults[0].sourceSha = '0'.repeat(40);
    }),
  );
  assert.equal(sourceDrift.status, 1);
  assert.match(sourceDrift.stderr, /product gate projection drifted/);
});

test('fails closed when the legacy projection widens or changes authority', (t) => {
  const result = fixture(
    t,
    mutateJson(MATRIX, (matrix) => {
      matrix.authority.gateRoot = `sha256:${'0'.repeat(64)}`;
    }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not bind the standard manifest authority/);
});

test('fails closed on SDK and documentation projection drift', (t) => {
  const sdk = fixture(
    t,
    mutateJson('developer/sdk/kfd/adopter-manifest.json', (manifest) => {
      manifest.manifestId = 'stale-sdk-projection';
    }),
  );
  assert.equal(sdk.status, 1);
  assert.match(sdk.stderr, /SDK adopter manifest projection is stale/);

  const docs = fixture(t, (directory) => {
    appendFileSync(
      path.join(directory, 'docs/qualification/kfd-support-matrix.md'),
      '\nstale\n',
    );
  });
  assert.equal(docs.status, 1);
  assert.match(docs.stderr, /documentation support projection is stale/);
});

test('KFD-6 unsupported and draft evidence cannot silently widen', (t) => {
  for (const [index, state] of [
    [5, 'candidate'],
    [12, 'adopted'],
  ]) {
    const result = fixture(
      t,
      mutateJson(MANIFEST, (manifest) => {
        manifest.decisions[index].state = state;
      }),
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /projection is stale|published KFD verifier rejected|published Buildchain verifier rejected/,
    );
  }
});

test('source status reports candidate, unsupported, and draft-evidence boundaries', (t) => {
  const result = fixture(t, () => {}, ['--source-status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict, 'manifest-bound-candidate-closure');
  assert.deepEqual(report.support.candidates, [
    'KFD-1',
    'KFD-2',
    'KFD-3',
    'KFD-4',
    'KFD-5',
    'KFD-7',
  ]);
  assert.deepEqual(report.support.unsupported, ['KFD-6']);
  assert.deepEqual(report.support.draftEvidenceOnly, [
    'KFD-8',
    'KFD-9',
    'KFD-10',
    'KFD-11',
    'KFD-12',
    'KFD-13',
  ]);
  assert.equal(report.kfd3.declaredSurfaceCount, 199);
  assert.equal(report.kfd3.counts.enforced, 0);
});

test('Shifu human and agent surfaces preserve one source verdict', () => {
  const human = spawnSync(SHIFU, ['kfd', 'status'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /MANIFEST-BOUND CANDIDATE CLOSURE/);
  assert.doesNotMatch(human.stdout, /^\s*\{/u);

  const agent = spawnSync(SHIFU, ['kfd:query', 'KFD-3', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(agent.status, 0, agent.stderr);
  const report = JSON.parse(agent.stdout);
  assert.equal(report.operation, 'query');
  assert.equal(report.selection.id, 'KFD-3');
});

test('source check fails closed when retained evidence disappears', (t) => {
  const result = fixture(
    t,
    mutateJson(MANIFEST, (manifest, directory) => {
      const evidence = manifest.decisions[0].implementationEvidence[0];
      const relative = evidence.coordinate.slice(
        evidence.coordinate.indexOf('#') + 1,
      );
      unlinkSync(path.join(directory, relative));
    }),
    ['--source-check', '--json'],
  );
  assert.match(diagnosis(result).message, /is missing/);
});

test('source check rejects evidence escapes and byte-root drift', (t) => {
  const escaped = fixture(
    t,
    mutateJson(MANIFEST, (manifest) => {
      const evidence = manifest.decisions[0].implementationEvidence[0];
      evidence.coordinate = evidence.coordinate.replace(
        /#[\s\S]*$/u,
        '#../outside.json',
      );
    }),
    ['--source-check', '--json'],
  );
  assert.match(diagnosis(escaped).message, /escapes the source checkout/);

  const drifted = fixture(
    t,
    mutateJson(MANIFEST, (manifest, directory) => {
      const evidence = manifest.decisions[0].implementationEvidence[0];
      const relative = evidence.coordinate.slice(
        evidence.coordinate.indexOf('#') + 1,
      );
      appendFileSync(path.join(directory, relative), '\nroot drift\n');
    }),
    ['--source-check', '--json'],
  );
  assert.match(diagnosis(drifted).message, /root drift/);
});

test('source check rejects malformed or set-drifted KFD-3 query evidence', (t) => {
  const failed = fixture(
    t,
    mutateJson('.buildchain/kfd/kfd-3/capability-query.json', (query) => {
      query.status = 'failed';
    }),
    ['--source-check', '--json'],
  );
  assert.match(
    diagnosis(failed).message,
    /root drift|registry or capability query is invalid/,
  );

  const setDrift = fixture(
    t,
    mutateJson('.buildchain/kfd/kfd-3/capability-query.json', (query) => {
      query.capabilities.pop();
    }),
    ['--source-check', '--json'],
  );
  assert.match(
    diagnosis(setDrift).message,
    /root drift|declared surface set drifts/,
  );
});
