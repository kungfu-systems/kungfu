#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Runtime provenance guard for participant-facing package tasks. This is not a
// security boundary: it makes accidental direct package-manager use fail with
// the canonical correction while Shifu's internal task composition stays free
// to use pnpm, node, conan, and cmake.

import { pathToFileURL } from 'node:url';

/**
 * @param {string} task
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function shifuEntryError(task, env = process.env) {
  if (env.SHIFU_ENTRYPOINT === '1') return null;
  const command = task ? `./shifu ${task}` : './shifu <task>';
  return [
    'Direct package-manager invocation is unsupported for repository tasks.',
    `Run: ${command}`,
    'Shifu owns the pinned toolchain and build environment.',
  ].join('\n');
}

function main() {
  const task = process.argv.slice(2).join(' ').trim();
  const error = shifuEntryError(task);
  if (!error) return;
  console.error(`[shifu-entry] ${error.replaceAll('\n', '\n[shifu-entry] ')}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
