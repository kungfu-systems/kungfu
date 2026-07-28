#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAMILY_QUEUE_LEASE_SCHEMA,
  MERGE_QUEUE_ADMISSION_SCHEMA,
  inspectProjectCutMergeQueueAdmission,
  parseFamilyQueueLeaseMarker,
  releaseFamilyQueueLease,
  verifyFamilyQueueLeaseAtMergeGroup,
} from './project-cut-merge-queue-admission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(
    'usage: ./shifu project-cut:queue-admission -- --base <ref> --head <ref> [family options]',
  );
}

function parseArgs(argv) {
  const values = argv[0] === '--' ? argv.slice(1) : [...argv];
  const parsed = {
    mode: 'admission',
    base: '',
    head: '',
    initiativeId: '',
    assignmentId: '',
    deliveryClass: '',
    queueAttempt: '',
    admissionProofRoots: [],
    markerFile: '',
    statusFile: '',
    expectedPrHead: '',
    expectedDevHead: '',
    candidateTree: '',
    terminalReason: '',
    evidenceRoots: [],
  };
  while (values.length > 0) {
    const option = values.shift();
    if (option === '--base') parsed.base = values.shift() ?? '';
    else if (option === '--head') parsed.head = values.shift() ?? '';
    else if (option === '--initiative-id')
      parsed.initiativeId = values.shift() ?? '';
    else if (option === '--assignment-id')
      parsed.assignmentId = values.shift() ?? '';
    else if (option === '--delivery-class')
      parsed.deliveryClass = values.shift() ?? '';
    else if (option === '--queue-attempt')
      parsed.queueAttempt = values.shift() ?? '';
    else if (option === '--admission-proof-root')
      parsed.admissionProofRoots.push(values.shift() ?? '');
    else if (option === '--verify-family-marker') {
      parsed.mode = 'verify-family-marker';
      parsed.markerFile = values.shift() ?? '';
    } else if (option === '--release-family-marker') {
      parsed.mode = 'release-family-marker';
      parsed.markerFile = values.shift() ?? '';
    } else if (option === '--status-file')
      parsed.statusFile = values.shift() ?? '';
    else if (option === '--expected-pr-head')
      parsed.expectedPrHead = values.shift() ?? '';
    else if (option === '--expected-dev-head')
      parsed.expectedDevHead = values.shift() ?? '';
    else if (option === '--candidate-tree')
      parsed.candidateTree = values.shift() ?? '';
    else if (option === '--terminal-reason')
      parsed.terminalReason = values.shift() ?? '';
    else if (option === '--evidence-root')
      parsed.evidenceRoots.push(values.shift() ?? '');
    else throw new Error(`unknown option: ${option}`);
  }
  if (parsed.mode === 'admission' && (!parsed.base || !parsed.head)) {
    throw new Error('--base and --head are required');
  }
  if (
    parsed.mode !== 'admission' &&
    (!parsed.markerFile || !parsed.expectedPrHead)
  ) {
    throw new Error('family marker mode requires marker and exact PR head');
  }
  return parsed;
}

function readInput(name) {
  return name === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(path.resolve(name), 'utf8');
}

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.mode === 'verify-family-marker') {
    const lease = parseFamilyQueueLeaseMarker(readInput(args.markerFile));
    result = verifyFamilyQueueLeaseAtMergeGroup({
      lease,
      pullRequestHead: args.expectedPrHead,
      devHead: args.expectedDevHead,
      candidateTree: args.candidateTree,
      combinedStatus: JSON.parse(readInput(args.statusFile)),
    });
  } else if (args.mode === 'release-family-marker') {
    const lease = parseFamilyQueueLeaseMarker(readInput(args.markerFile));
    if (lease === null || lease.schema !== FAMILY_QUEUE_LEASE_SCHEMA) {
      throw new Error('family queue lease marker is absent');
    }
    result = releaseFamilyQueueLease(lease, {
      expectedLeaseRoot: lease.leaseRoot,
      observedHead: args.expectedPrHead,
      terminalReason: args.terminalReason,
      evidenceRoots: args.evidenceRoots,
    });
  } else {
    const familyFields = [
      args.initiativeId,
      args.assignmentId,
      args.deliveryClass,
      args.queueAttempt,
    ];
    const hasFamily = familyFields.some(Boolean);
    if (hasFamily && !familyFields.every(Boolean)) {
      throw new Error('family admission options must be supplied together');
    }
    result = inspectProjectCutMergeQueueAdmission(
      root,
      args.base,
      args.head,
      hasFamily
        ? {
            initiativeId: args.initiativeId,
            assignmentId: args.assignmentId,
            deliveryClass: args.deliveryClass,
            queueAttempt: args.queueAttempt,
            admissionProofRoots: args.admissionProofRoots,
          }
        : null,
    );
  }
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  usage();
  console.log(
    JSON.stringify({
      schema: MERGE_QUEUE_ADMISSION_SCHEMA,
      ok: false,
      decision: 'indeterminate',
      retryable: true,
      diagnostics: [
        {
          code: 'admission-infrastructure-error',
          path: '$',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      reasonCodes: ['admission-infrastructure-error'],
    }),
  );
  process.exitCode = 2;
}
