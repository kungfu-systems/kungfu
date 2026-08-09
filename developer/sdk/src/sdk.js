#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/** Stable Kungfu SDK CLI dispatcher over cohesive command domains. */

import {
  contractAdd,
  contractAdopt,
  contractAudit,
  contractEvidence,
  contractPolicy,
  contractRender,
  contractWitness,
  kfxBuild,
  kfxClean,
} from './sdk-contract.js';
import { kfd } from './sdk-kfd.js';
import {
  createApp,
  createExtension,
  createSkill,
  fail,
  parseArgs,
  product,
  usage,
} from './sdk-shared.js';

const { positional, options } = parseArgs(process.argv.slice(2));
const [command, kind, ...rest] = positional;
const directory = rest[0];

if (!command) usage(1);
if (command === 'create') {
  if (kind === 'app') createApp(directory, options);
  else if (kind === 'extension') createExtension(directory, options);
  else if (kind === 'skill') createSkill(directory, options);
  else fail(`unknown target: ${kind} (supported: app, extension, skill)`);
} else if (command === 'kfx') {
  if (kind === 'build') await kfxBuild();
  else if (kind === 'clean') kfxClean();
  else fail(`unknown kfx command: ${kind} (supported: build, clean)`);
} else if (command === 'product') {
  await product(kind, directory, options);
} else if (command === 'kfd') {
  await kfd(kind, rest, options);
} else if (command === 'contract') {
  if (kind === 'adopt') contractAdopt(directory, options);
  else if (kind === 'render') contractRender(directory, options);
  else if (kind === 'evidence') contractEvidence(directory, options);
  else if (kind === 'policy') contractPolicy(options);
  else if (kind === 'witness') contractWitness(options);
  else if (kind === 'audit') contractAudit(options);
  else if (kind === 'add') contractAdd(directory, options);
  else
    fail(
      `unknown contract command: ${kind} (supported: adopt, render, evidence, policy, witness, audit, add)`,
    );
} else {
  fail(`unknown command: ${command}`);
}
