// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectHubStarterIssues,
  validateHubStarterRepository,
} from './check-hub-starter-docker-concept.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'product/hub-starter/kungfu-hub-starter-docker.contract.json',
    ),
    'utf8',
  ),
);

function mutate(fn) {
  const value = structuredClone(CONTRACT);
  fn(value);
  return collectHubStarterIssues(value, ROOT).map(({ code }) => code);
}

test('repository passes the concept-only contract and documentation gate', async () => {
  const result = await validateHubStarterRepository(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.passedEvidence, ['concept-static']);
});

test('production or daemon evidence cannot be promoted by editing one flag', () => {
  assert.ok(
    mutate((value) => {
      value.distribution.daemonAccessed = true;
      value.evidenceLadder.find(({ id }) => id === 'daemon-smoke').status =
        'passed';
    }).includes('concept-overclaim'),
  );
  assert.ok(
    mutate((value) => {
      value.evidenceLadder.find(
        ({ id }) => id === 'production-admission',
      ).status = 'passed';
    }).includes('evidence-overclaim'),
  );
});

test('unsafe container privileges and host reach fail closed', () => {
  const issues = mutate((value) => {
    value.topology.services[0].dockerSocket = true;
    value.networking.hostNetwork = true;
    value.networking.publicPortsByDefault = ['0.0.0.0:8080'];
  });
  assert.ok(issues.includes('unsafe-service'));
  assert.ok(issues.includes('unsafe-container-authority'));
  assert.ok(issues.includes('public-port-default'));
});

test('floating tags, real Home mounts, and premature CLI claims fail closed', () => {
  const issues = mutate((value) => {
    value.compatibility.floatingTagsAllowed = true;
    value.storage.realUserHomeMount = true;
    value.oneCommand.implementationStatus = 'implemented';
  });
  assert.ok(issues.includes('floating-tag-admitted'));
  assert.ok(issues.includes('real-user-home-mount'));
  assert.ok(issues.includes('one-command-overclaim'));
});

test('the current contract assigns one writer per volume', () => {
  const issues = mutate((value) => {
    value.storage.volumes[0].writers.push('verify');
  });
  assert.ok(issues.includes('multiple-volume-writers'));
});
