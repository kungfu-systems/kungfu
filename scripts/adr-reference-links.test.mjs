// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { checkAdrReferenceLinks } from './adr-reference-links.mjs';

const roots = [];
const ID = 'KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76';
const OTHER = 'SHIFU-ADR-019f86da-4f90-7222-b238-9683f61e7288';

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-links-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  }
  return root;
}

function run(text, lifecycle = 'authored') {
  const files = ['docs/guide.md', `docs/adr/${ID}.md`];
  const root = fixture({
    'docs/guide.md': text,
    [`docs/adr/${ID}.md`]: '# Decision\n',
  });
  return checkAdrReferenceLinks({
    root,
    files,
    lifecycles: new Map([
      ['docs/guide.md', lifecycle],
      [`docs/adr/${ID}.md`, 'historical-append-only'],
    ]),
  });
}

test('accepts a canonical direct ADR link', () => {
  assert.deepEqual(
    run(
      `# Guide\n\n[${ID}](adr/${ID}.md)\n\n[KF-ADR-019f86da](adr/${ID}.md)\n`,
    ),
    [],
  );
});

test('rejects naked, missing, malformed, and mismatched ADR references', () => {
  const findings = run(
    `# Guide\n\n${ID}\n\n${OTHER}\n\nKF-ADR-019F86DA-4F90-713D-8626-D70BCA82CB76\n\nKF-ADR-019f86da-4f90-713d-8626-d70bca82cb7g\n\nKF-ADR-1234\n\n[KF-ADR-019F86DA-4F90-713D-8626-D70BCA82CB76](adr/${ID}.md)\n\n[${ID}](adr/README.md)\n`,
  );
  assert.ok(findings.some((item) => item.code === 'unlinked-adr-reference'));
  assert.ok(findings.some((item) => item.code === 'missing-adr-target'));
  assert.deepEqual(
    findings
      .filter((item) => item.code === 'malformed-adr-reference')
      .map((item) => item.message),
    [
      'ADR identity is not a canonical owner-prefixed UUIDv7: KF-ADR-019F86DA-4F90-713D-8626-D70BCA82CB76',
      'ADR identity is not a canonical owner-prefixed UUIDv7: KF-ADR-019f86da-4f90-713d-8626-d70bca82cb7g',
      'ADR identity is not a canonical owner-prefixed UUIDv7: KF-ADR-1234',
      'ADR identity is not a canonical owner-prefixed UUIDv7: KF-ADR-019F86DA-4F90-713D-8626-D70BCA82CB76',
    ],
  );
  assert.ok(
    findings.some((item) => item.code === 'adr-reference-target-mismatch'),
  );
});

test('ignores code, fenced examples, inline HTML, and history', () => {
  const source = `# Guide

\`${ID}\`

\`\`\`text
${ID}
\`\`\`

<span data-adr="${ID}">${ID}<em>${ID}</em></span>

after <br> [${ID}](adr/${ID}.md)
`;
  assert.deepEqual(run(source), []);
  assert.deepEqual(run(`${ID}\n`, 'historical-append-only'), []);
});

test('respects quoted greater-than signs at inline HTML boundaries', () => {
  const findings = run(`<span title="/ >">${ID}</span>

<span title=">" /> ${ID}
`);
  assert.deepEqual(
    findings.map((item) => item.code),
    ['unlinked-adr-reference'],
  );
});
