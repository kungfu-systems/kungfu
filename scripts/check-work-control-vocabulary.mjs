#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_FILES = [
  'extensions/mission-control/profile.json',
  'extensions/mission-control/actions/registry.json',
  'extensions/mission-control/assessments/policies.json',
  'extensions/mission-control/claims/claims.json',
  'extensions/mission-control/collaboration/interface.json',
  'extensions/mission-control/reducers/five-questions.json',
  'extensions/mission-control/views/registry.json',
  'extensions/work-dashboard/src/view/agent-console-launch.ts',
  'extensions/work-dashboard/src/view/index.tsx',
  'extensions/work-dashboard/src/view/profile-setup.ts',
  'framework/core/src/python/kungfu/agent/action_loop.py',
  'framework/core/src/python/kungfu/assignment_orchestration.py',
  'framework/core/src/python/kungfu/cli/commands/assignment.py',
  'framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json',
  'framework/tui/src/work-control-contribution.ts',
];
const FORBIDDEN = /\bMission\b|\bGo\b|kungfu\.mission-control|mission-control/u;
const EXPLICIT_BOUNDARY = /\blegacy\b|\bcompatibility\b|\bAtlas\b|\batlas\b/u;
const PHYSICAL_COMPATIBILITY_PATH =
  /extensions\/mission-control|"extensions"\s*\/\s*"mission-control"|mission-control-actions|\.\/mission-control-profile/u;

export function auditWorkControlVocabulary(root = ROOT) {
  const issues = [];
  for (const relative of NATIVE_FILES) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    source.split('\n').forEach((line, index) => {
      if (
        FORBIDDEN.test(line) &&
        !EXPLICIT_BOUNDARY.test(line) &&
        !PHYSICAL_COMPATIBILITY_PATH.test(line)
      ) {
        issues.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  const commands = JSON.parse(
    fs.readFileSync(
      path.join(root, 'framework/core/src/python/kungfu/agent/commands.json'),
      'utf8',
    ),
  );
  for (const command of commands.commands ?? []) {
    if (
      /^(?:kungfu work|kungfu profile work-control)(?:\s|$)/u.test(
        command.name ?? '',
      ) &&
      FORBIDDEN.test(JSON.stringify(command))
    ) {
      issues.push(
        `framework/core/src/python/kungfu/agent/commands.json: native command ${command.name}`,
      );
    }
  }

  return issues;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const issues = auditWorkControlVocabulary();
  if (issues.length) {
    console.error('Work Control vocabulary boundary failed:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }
  console.log('Work Control vocabulary boundary passed');
}
