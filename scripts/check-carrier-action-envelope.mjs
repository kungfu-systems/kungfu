#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Guard v4 against copying the pre-envelope open-layer allocation pattern.
// Business facts must use carrier_type=1000 plus action_type/schema_ref.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const allFiles = args.includes('--all');

const SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|mjs|js|cjs|ts|tsx|py|fbs)$/;

const ALLOCATION_PATTERNS = [
  {
    name: 'raw constant allocation',
    re: /\b(?:MSG_[A-Z0-9_]*|[A-Z0-9_]*MSG_TYPE|KFX_MSG_TYPE|WORK_MSG_(?:MIN|MAX))\b\s*(?::[^=\n]+)?=\s*(3\d{4}|4\d{4})\b/g,
  },
  {
    name: 'raw carrier/comment contract',
    re: /\b(?:msg_type|carrier_type)\b[^\n]{0,60}\b(3\d{4}|4\d{4})\b/g,
  },
  {
    name: 'open-layer range constant',
    re: /\b(?:OPEN_LAYER_MIN|KFX_MSGTYPE_(?:MIN|MAX))\b\s*(?::[^=\n]+)?=\s*(3\d{4}|4\d{4})\b/g,
  },
  {
    name: 'business header vocabulary',
    re: /\bMSG_[A-Z0-9_]+\b/g,
  },
];

const LEGACY_ENVELOPE_PATTERNS = [
  {
    name: 'UTF-8 JSON envelope decode',
    re: /Buffer\.from\s*\(\s*bytes\s*\)[^\n]*toString\s*\(\s*['"]utf8['"]\s*\)/g,
  },
  {
    name: 'base64 envelope transfer',
    re: /content_transfer_encoding|Buffer\.from\s*\([^\n]*['"]base64['"]\s*\)/gi,
  },
];

const NATIVE_ENVELOPE_CONSUMERS = new Set([
  'framework/api/src/capability/rewind.ts',
  'framework/api/src/capability/work.ts',
  'framework/core/src/python/kungfu/rewind/wire.py',
  'framework/core/src/python/kungfu/work/wire.py',
]);

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitMaybe(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function splitLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isFile(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

function isGenerated(rel) {
  if (
    /(?:^|\/)generated\//.test(rel) ||
    /\/fb\/[A-Z][^/]*\.py$/.test(rel) ||
    /_fb\.py$/.test(rel)
  ) {
    return true;
  }
  try {
    const head = fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .split('\n', 3)
      .join('\n');
    return /automatically generated|do not (edit|modify)/i.test(head);
  } catch {
    return false;
  }
}

function mergeBase() {
  const upstream = gitMaybe([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const candidates = [
    upstream,
    'origin/HEAD',
    'origin/dev/v4/v4.0',
    'dev/v4/v4.0',
  ].filter(Boolean);
  for (const ref of candidates) {
    const base = gitMaybe(['merge-base', String(ref), 'HEAD']);
    if (base) return base;
  }
  return null;
}

function selectedFiles() {
  const files = new Set();
  if (stagedOnly) {
    for (const file of splitLines(
      git(['diff', '--cached', '--name-only', '--diff-filter=ACM']),
    )) {
      files.add(file);
    }
  } else if (allFiles) {
    for (const file of splitLines(git(['ls-files']))) {
      files.add(file);
    }
  } else {
    const base = mergeBase();
    if (base) {
      for (const file of splitLines(
        git(['diff', '--name-only', '--diff-filter=ACM', `${base}...HEAD`]),
      )) {
        files.add(file);
      }
    }
    for (const mode of [[], ['--cached']]) {
      for (const file of splitLines(
        git(['diff', ...mode, '--name-only', '--diff-filter=ACM']),
      )) {
        files.add(file);
      }
    }
    for (const file of splitLines(
      git(['ls-files', '--others', '--exclude-standard']),
    )) {
      files.add(file);
    }
  }
  return [...files].filter(
    (file) => SOURCE_EXT.test(file) && isFile(file) && !isGenerated(file),
  );
}

function lineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

const hits = [];
for (const rel of selectedFiles()) {
  const businessEnvelopeSurface =
    rel.startsWith('framework/core/src/python/kungfu/rewind/') ||
    rel.startsWith('framework/core/src/python/kungfu/work/') ||
    rel.startsWith('framework/core/src/python/kungfu/atlas/');
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const pattern of ALLOCATION_PATTERNS) {
    if (
      pattern.name === 'business header vocabulary' &&
      !businessEnvelopeSurface
    ) {
      continue;
    }
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      hits.push({
        file: rel,
        line: lineNumber(text, match.index || 0),
        pattern: pattern.name,
        text: match[0].trim(),
      });
    }
  }
  if (NATIVE_ENVELOPE_CONSUMERS.has(rel)) {
    for (const pattern of LEGACY_ENVELOPE_PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const match of text.matchAll(pattern.re)) {
        hits.push({
          file: rel,
          line: lineNumber(text, match.index || 0),
          pattern: pattern.name,
          text: match[0].trim(),
        });
      }
    }
  }
}

if (hits.length) {
  console.error(
    '[carrier-action] raw allocation or legacy JSON/base64 envelope transport is blocked.',
  );
  console.error(
    '[carrier-action] New v4 facts must use carrier_type=1000 with action_type/schema_ref.',
  );
  console.error(
    '[carrier-action] Keep business semantics in the action envelope, not the frame header.',
  );
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line} (${hit.pattern}) ${hit.text}`);
  }
  process.exit(1);
}

console.log('[carrier-action] envelope gate passed');
