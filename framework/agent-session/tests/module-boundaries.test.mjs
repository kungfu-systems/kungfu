import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

function source(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

test('Agent Session facade delegates stable services within line budgets', () => {
  const registry = source(
    'framework/agent-session/src/work-console-registry.mjs',
  );
  assert.match(registry, /new ActiveWorkLeaseService/u);
  assert.match(registry, /new SessionLifecycleService/u);
  assert.match(registry, /new WorkProjectionService/u);
  assert.ok(registry.split('\n').length <= 500);

  const worker = source('framework/agent-session/src/product-worker.mjs');
  assert.match(worker, /createCapsuleNodePtyLoader/u);
  assert.doesNotMatch(worker, /from 'node-pty'/u);

  const workWindow = source('framework/tui/src/work-window/index.tsx');
  assert.match(workWindow, /projectWorkSessionState/u);
  assert.match(workWindow, /NativeWorkProjectionView/u);
  assert.ok(workWindow.split('\n').length <= 1375);
});

test('published package exports every reusable Agent Session service', () => {
  const manifest = JSON.parse(source('framework/agent-session/package.json'));
  for (const name of [
    './capsule-transport-runtime',
    './work-console-model',
    './active-work-lease',
    './session-lifecycle-service',
    './work-projection-service',
  ]) {
    assert.equal(typeof manifest.exports[name], 'string', name);
  }
});

test('Work Control actions do not depend on Agent Session lifecycle', () => {
  const assignment = source(
    'framework/core/src/python/kungfu/cli/commands/assignment.py',
  );
  assert.doesNotMatch(assignment, /bind_current_native_work/u);
  assert.doesNotMatch(assignment, /native_work_bound/u);

  const contract = JSON.parse(
    source('product/contracts/project-work-agent.contract.json'),
  );
  assert.match(contract.firstLayer.agentExecution.workOwns, /no WorkConsole/u);
  assert.match(
    contract.firstLayer.agentExecution.agentSessionObserves,
    /optional|replaceable/u,
  );
});
