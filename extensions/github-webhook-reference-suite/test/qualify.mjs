// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

await import('@kungfu-tech/kfx-github-webhook-ingress/test/qualify');
await import('@kungfu-tech/kfx-github-dogfood-bridge/test/qualify');

const suiteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const actualAgent = JSON.parse(
  fs.readFileSync(
    path.join(
      suiteRoot,
      'qualification',
      'actual-installed-agent-darwin-arm64.json',
    ),
    'utf8',
  ),
);

assert.equal(actualAgent.result.qualification, 'passed');
assert.equal(actualAgent.productBoundary.extractedInstalledProductOnly, true);
assert.equal(actualAgent.productBoundary.repositoryPresent, false);
assert.equal(actualAgent.productBoundary.sourceFallback, false);
assert.equal(actualAgent.result.nativePackageInstalled, false);
assert.ok(
  actualAgent.measuredInterventions.every(
    (intervention) =>
      intervention.scope === 'ephemeral-loopback-bind' &&
      intervention.userIntervention === false,
  ),
);
assert.ok(
  actualAgent.publicCommands.every((command) => command.startsWith('./kungfu')),
);
assert.ok(
  Object.values(actualAgent.roots).every((value) =>
    /^sha256:[0-9a-f]{64}$/.test(value),
  ),
);
