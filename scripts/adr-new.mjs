#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUuidV7, formatAdrIdentity } from './adr-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {{owner: 'kungfu' | 'shifu', title: string, slug?: string, date?: string, timestamp?: number, random?: Uint8Array}} options
 */
export function planAdr(options) {
  if (!['kungfu', 'shifu'].includes(options.owner)) {
    throw new Error('--owner must be kungfu or shifu');
  }
  const title = options.title?.trim();
  if (!title) throw new Error('--title is required');
  const date = options.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('--date must use YYYY-MM-DD');
  }
  const uuid = createUuidV7({
    timestamp: options.timestamp,
    random: options.random,
  });
  const id = formatAdrIdentity(options.owner, uuid);
  const file = `docs/adr/${id}.md`;
  const content = `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ${id}
decision_status: proposed
implementation_status: not-started
review_state: unreviewed
sensitivity: public
last_reviewed: ${date}
---

# ${id}: ${title}

- Status: proposed
- Date: ${date}

## Context

Describe the decision pressure, constraints, and evidence.

## Decision

State the decision and its ownership boundary.

## Consequences

Record benefits, costs, migration needs, and falsifiable follow-up work.
`;
  return { id, file, content, sharedWrites: [] };
}

/** @param {string} root @param {{file: string, content: string}} plan */
export function writeAdr(root, plan) {
  const target = path.join(root, plan.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(target, 'wx');
    fs.writeFileSync(descriptor, plan.content, 'utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new Error(`ADR already exists: ${plan.file}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return target;
}

function parseArgs(argv) {
  const args = { owner: '', title: '', slug: '', date: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--owner') args.owner = argv[++index] || '';
    else if (arg === '--title') args.title = argv[++index] || '';
    else if (arg === '--slug') args.slug = argv[++index] || '';
    else if (arg === '--date') args.date = argv[++index] || '';
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.slug) {
    console.error(
      '[adr-new] --slug is deprecated and ignored; canonical paths are ID-only',
    );
  }
  const plan = planAdr({
    owner: /** @type {'kungfu' | 'shifu'} */ (args.owner),
    title: args.title,
    slug: args.slug || undefined,
    date: args.date || undefined,
  });
  if (!args.dryRun) writeAdr(ROOT, plan);
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 'kungfu.adr-new/v1',
        mode: args.dryRun ? 'dry-run' : 'execute',
        id: plan.id,
        file: plan.file,
        sharedWrites: plan.sharedWrites,
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[adr-new] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
