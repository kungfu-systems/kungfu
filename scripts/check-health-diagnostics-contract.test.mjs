// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const contract = readJson('framework/runtime/kungfu-diagnostics.contract.json');
const registry = readJson('framework/contract/kungfu-contracts.registry.json');

test('diagnostics contract is registered with stable statuses and exits', () => {
  const entry = registry.contracts.find(
    (candidate) => candidate.surface === 'diagnostics',
  );
  assert.ok(entry);
  assert.equal(
    entry.source,
    'framework/runtime/kungfu-diagnostics.contract.json',
  );
  assert.equal(contract.schema, 'kungfu.diagnostics.contract/v1');
  assert.deepEqual(contract.statuses, [
    'ready',
    'degraded',
    'action-required',
    'blocked',
  ]);
  assert.deepEqual(contract.exitCodes, {
    ready: 0,
    degraded: 1,
    'action-required': 2,
    blocked: 3,
  });
});

test('every problem template is actionable and never embeds execute', () => {
  for (const [code, problem] of Object.entries(contract.problemCatalog)) {
    assert.ok(problem.summary, `${code} summary`);
    assert.ok(problem.message, `${code} message`);
    assert.ok(
      ['degraded', 'action-required', 'blocked'].includes(problem.statusImpact),
      `${code} status impact`,
    );
    assert.equal(typeof problem.retryable, 'boolean', `${code} retryable`);
    assert.equal(
      typeof problem.actionRequired,
      'boolean',
      `${code} actionRequired`,
    );
    for (const action of problem.actions) {
      assert.equal(action.destructive, false, `${code} destructive action`);
      assert.ok(
        !action.command.includes('--execute'),
        `${code} health advice must stop at plan/inspection`,
      );
    }
  }
});

test('command preflight profiles are fresh, bounded, and explicit', () => {
  assert.deepEqual(Object.keys(contract.preflightProfiles).sort(), [
    'episode-recovery',
    'episode-write',
    'peer-activation',
    'runtime-activation',
  ]);
  for (const [profileId, profile] of Object.entries(
    contract.preflightProfiles,
  )) {
    assert.equal(profile.mode, 'fast', `${profileId} mode`);
    assert.equal(profile.freshness, 'command', `${profileId} freshness`);
    assert.equal(profile.cacheAllowed, false, `${profileId} cache`);
    assert.ok(profile.areas.length > 0, `${profileId} areas`);
    assert.deepEqual(Object.keys(profile.statusPolicy).sort(), [
      'action-required',
      'blocked',
      'degraded',
      'ready',
    ]);
  }
});

test('recovery classifications bind only fenced authority operations', () => {
  assert.deepEqual(contract.recoveryClassifications, [
    'automatic-safe',
    'confirmation-required',
    'manual-blocked',
  ]);
  assert.deepEqual(Object.keys(contract.recoveryActions).sort(), [
    'episode.abort-stale',
    'manual-review',
    'peer.ensure',
    'peer.restart',
    'runtime.ensure',
    'storage.rebuild-projection',
  ]);
  assert.equal(
    contract.recoveryActions['manual-review'].classification,
    'manual-blocked',
  );
  assert.equal(
    contract.recoveryActions['episode.abort-stale'].authority,
    'EpisodeRecoveryPlanner',
  );
});

test('unified recovery defaults to plan-only and requires exact execution identity', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'framework/core/src/python/kungfu/cli/commands/recover.py'),
    'utf8',
  );
  assert.match(source, /--execute/);
  assert.match(source, /--plan-id/);
  assert.match(source, /--approve/);
  assert.match(source, /execute and not plan_id/);
  assert.match(source, /plan_recovery/);
  assert.match(source, /execute_recovery/);
});

test('high-value command paths declare the registered preflight profiles', () => {
  const runtimeSource = fs.readFileSync(
    path.join(ROOT, 'framework/core/src/python/kungfu/cli/commands/runtime.py'),
    'utf8',
  );
  const storageSource = fs.readFileSync(
    path.join(ROOT, 'framework/core/src/python/kungfu/cli/commands/storage.py'),
    'utf8',
  );
  assert.match(runtimeSource, /command_preflight\("runtime-activation"\)/);
  assert.match(runtimeSource, /command_preflight\("peer-activation"\)/);
  assert.match(storageSource, /run_command_preflight\(ctx, "episode-write"\)/);
  assert.match(storageSource, /command_preflight\("episode-recovery"\)/);
});

test('fast mode contract excludes fsck and health source has no mutation calls', () => {
  assert.equal(contract.modes.fast.storageFsck, false);
  assert.equal(contract.modes.fast.episodeLimit, 100);
  const source = fs.readFileSync(
    path.join(ROOT, 'framework/core/src/python/kungfu/diagnostics.py'),
    'utf8',
  );
  for (const forbidden of [
    'ensure_coordinator(',
    'repair_apply(',
    'execute_episode_recovery(',
    'episode_projection_rebuild(',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `forbidden health call: ${forbidden}`,
    );
  }
});

test('full-profile CI requires native health and preflight performance qualification', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/core-build-profiles.yml'),
    'utf8',
  );
  const runner = fs.readFileSync(
    path.join(ROOT, 'scripts/run-health-diagnostics-tests.mjs'),
    'utf8',
  );
  assert.match(workflow, /KUNGFU_HEALTH_REQUIRE_NATIVE: "1"/);
  assert.match(workflow, /\.\/shifu test:health-diagnostics/);
  assert.match(workflow, /shifu\.cmd test:health-diagnostics/);
  assert.match(workflow, /\.\/shifu test:health-preflight-performance/);
  assert.match(workflow, /shifu\.cmd test:health-preflight-performance/);
  assert.match(runner, /KUNGFU_HEALTH_REQUIRE_NATIVE !== '1'/);
});
