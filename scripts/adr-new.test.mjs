// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { planAdr, writeAdr } from './adr-new.mjs';

const roots = [];

function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return childProcess.execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

test('plans an ADR without allocating a number or updating a shared index', () => {
  const plan = planAdr({
    owner: 'kungfu',
    title: 'Distributed identity concurrency gate',
    date: '2026-07-22',
    timestamp: Date.UTC(2026, 6, 22, 1, 2, 3, 4),
    random: Buffer.from('00112233445566778899', 'hex'),
  });

  assert.equal(plan.id, 'KF-ADR-019f8758-0efc-7011-a233-445566778899');
  assert.equal(
    plan.file,
    'docs/adr/KF-ADR-019f8758-0efc-7011-a233-445566778899.md',
  );
  assert.equal(plan.sharedWrites.length, 0);
  assert.match(plan.content, /adr_id: KF-ADR-019f8758-/);
  assert.match(plan.content, /- Status: proposed/);
});

test('keeps the deprecated slug input out of the canonical path', () => {
  const plan = planAdr({
    owner: 'shifu',
    title: '中文标题也不需要路径 slug',
    slug: 'legacy-caller-hint',
    date: '2026-07-22',
    timestamp: Date.UTC(2026, 6, 22, 1, 2, 3, 4),
    random: Buffer.from('00112233445566778899', 'hex'),
  });

  assert.equal(
    plan.file,
    'docs/adr/SHIFU-ADR-019f8758-0efc-7011-a233-445566778899.md',
  );
});

test('independent writers create distinct files and leave README untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-new-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/adr/README.md'), 'sentinel\n');
  const common = {
    owner: 'shifu',
    title: 'Offline authoring',
    date: '2026-07-22',
    timestamp: Date.UTC(2026, 6, 22, 1, 2, 3, 4),
  };
  const first = planAdr({
    ...common,
    random: Buffer.from('00112233445566778899', 'hex'),
  });
  const second = planAdr({
    ...common,
    random: Buffer.from('01112233445566778899', 'hex'),
  });

  writeAdr(root, first);
  writeAdr(root, second);

  assert.notEqual(first.file, second.file);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs/adr/README.md'), 'utf8'),
    'sentinel\n',
  );
  assert.ok(fs.existsSync(path.join(root, first.file)));
  assert.ok(fs.existsSync(path.join(root, second.file)));
});

test('refuses to overwrite an existing ADR', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-new-'));
  roots.push(root);
  const plan = planAdr({
    owner: 'kungfu',
    title: 'Collision proof',
    date: '2026-07-22',
    timestamp: Date.UTC(2026, 6, 22, 1, 2, 3, 4),
    random: Buffer.from('00112233445566778899', 'hex'),
  });

  writeAdr(root, plan);
  assert.throws(() => writeAdr(root, plan), /already exists/);
});

test('two ADR branches merge in either order without identity or index conflict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-merge-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/adr/README.md'), 'sentinel\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['add', '.']);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base']);
  const common = {
    owner: 'kungfu',
    date: '2026-07-22',
    timestamp: Date.UTC(2026, 6, 22, 1, 2, 3, 4),
  };
  const first = planAdr({
    ...common,
    title: 'First independent decision',
    random: Buffer.from('00112233445566778899', 'hex'),
  });
  const second = planAdr({
    ...common,
    title: 'Second independent decision',
    random: Buffer.from('01112233445566778899', 'hex'),
  });

  git(root, ['checkout', '-q', '-b', 'adr-a']);
  writeAdr(root, first);
  git(root, ['add', first.file]);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'adr a']);
  git(root, ['checkout', '-q', 'main']);
  git(root, ['checkout', '-q', '-b', 'adr-b']);
  writeAdr(root, second);
  git(root, ['add', second.file]);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'adr b']);

  for (const [branch, order] of [
    ['integrate-ab', ['adr-a', 'adr-b']],
    ['integrate-ba', ['adr-b', 'adr-a']],
  ]) {
    git(root, ['checkout', '-q', 'main']);
    git(root, ['checkout', '-q', '-b', branch]);
    for (const source of order) {
      git(root, [
        '-c',
        'core.hooksPath=/dev/null',
        'merge',
        '-q',
        '--no-ff',
        '--no-edit',
        source,
      ]);
    }
    assert.equal(
      fs.readFileSync(path.join(root, 'docs/adr/README.md'), 'utf8'),
      'sentinel\n',
    );
    assert.ok(fs.existsSync(path.join(root, first.file)));
    assert.ok(fs.existsSync(path.join(root, second.file)));
  }
});
