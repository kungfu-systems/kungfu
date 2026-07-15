// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { consumeXinfaAtlas } from './kungfu-xinfa-consumer.mjs';

test('Kungfu materializes Human, Agent, and GUI views without owning compiler semantics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-xinfa-consumer-'));
  try {
    const fake = path.join(root, 'xinfa');
    const parity = {
      atlas_root: `sha256:${'a'.repeat(64)}`,
      project_id: 'dogfood',
      cut: { id: 'dogfood.main', revision: `sha256:${'b'.repeat(64)}` },
      cut_root: `sha256:${'c'.repeat(64)}`,
      visibility: 'public',
      route: {
        id: 'dogfood.route',
        parity_group: 'dogfood.contributor',
        route_root: `sha256:${'d'.repeat(64)}`,
        authority_root: `sha256:${'e'.repeat(64)}`,
        status: 'current',
      },
      evidence: [],
      atlas_omissions: [],
      source_roots: {
        source: `sha256:${'f'.repeat(64)}`,
        semantic: `sha256:${'1'.repeat(64)}`,
        verification: `sha256:${'2'.repeat(64)}`,
      },
    };
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const parity = ${JSON.stringify(parity)};
if (args[0] === 'atlas') process.stdout.write(JSON.stringify({valid:true,atlas_root:parity.atlas_root}));
else if (args[0] === 'context') process.stdout.write(JSON.stringify({schema:'xinfa.task-chart/v1',projection_root:'sha256:${'3'.repeat(64)}',parity,status:'complete',budget:{max_tokens:2048,used_tokens:512},omissions:[]}));
else if (args[0] === 'read') {
  const gui = args.includes('gui');
  process.stdout.write(JSON.stringify({schema:gui?'xinfa.gui-view/v1':'xinfa.human-view/v1',projection_root:gui?'sha256:${'4'.repeat(64)}':'sha256:${'5'.repeat(64)}',atlas_root:parity.atlas_root,cut_root:parity.cut_root,parity,status:'complete',metrics:{hops_used:1},steps:gui?undefined:[{hop:0,node:'dogfood.claim',kind:'claim',status:'machine-proved',source:{path:'README.md'}}],omissions:[]}));
} else process.exit(2);
`,
    );
    fs.chmodSync(fake, 0o755);
    fs.mkdirSync(path.join(root, 'atlas'));
    const output = path.join(root, 'generated');
    const receipt = consumeXinfaAtlas(
      {
        atlas: 'atlas',
        output: 'generated',
        xinfa: 'xinfa',
        humanRoute: 'dogfood.human',
        agentRoute: 'dogfood.agent',
        intent: 'verify parity',
        task: 'change adapter',
        role: 'implementer',
        budget: '2048',
        maxHops: '2',
      },
      root,
    );
    assert.equal(receipt.verdict, 'pass');
    assert.equal(receipt.readOnly, true);
    assert.ok(fs.existsSync(path.join(output, 'human.md')));
    assert.ok(fs.existsSync(path.join(output, 'agent.json')));
    assert.throws(
      () =>
        consumeXinfaAtlas(
          {
            atlas: 'atlas',
            output: 'generated',
            xinfa: 'xinfa',
            humanRoute: 'dogfood.human',
            agentRoute: 'dogfood.agent',
            intent: 'verify parity',
            task: 'change adapter',
            role: 'implementer',
            budget: '2048',
            maxHops: '2',
          },
          root,
        ),
      /refuses to overwrite/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
