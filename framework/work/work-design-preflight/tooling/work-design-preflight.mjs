#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';

import {
  buildAssignmentHistorySelectionRequest,
  buildAssignmentHistorySource,
  buildAssignmentOutcomeHistory,
  runAssignmentPreflight,
  verifyAssignmentPreflight,
} from '../src/work-design-preflight.mjs';

function inputPath(argv) {
  const index = argv.indexOf('--input');
  if (index < 0 || !argv[index + 1])
    throw new Error('usage: work-design-preflight --input <request.json>');
  return argv[index + 1];
}

function optionalPath(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  if (!argv[index + 1]) throw new Error(`${name} requires a JSON file`);
  return argv[index + 1];
}

try {
  const request = JSON.parse(fs.readFileSync(inputPath(process.argv), 'utf8'));
  const historyPath = optionalPath(process.argv, '--history-query');
  if (historyPath !== null) {
    const query = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const targetCohortRoot = request.adviceRequest?.targetCohortRoot;
    if (targetCohortRoot) {
      request.outcomeHistory = buildAssignmentOutcomeHistory({
        query,
        asOf: request.adviceRequest?.asOf,
        targetCohortRoot,
      });
    }
    request.selectionRequest = buildAssignmentHistorySelectionRequest({
      query,
      objectiveRoot: request.humanWorkDefinitionRoot,
      xinfaRoot: request.adviceRequest?.xinfaRoot,
      asOf: request.adviceRequest?.asOf,
      outcomeHistory: request.outcomeHistory ?? null,
    });
    request.historySource = buildAssignmentHistorySource(query);
  }
  const result = runAssignmentPreflight(request);
  const verification = verifyAssignmentPreflight(result);
  if (!verification.ok)
    throw new Error(`preflight verification failed: ${verification.reason}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
