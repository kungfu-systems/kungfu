#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PASSPORT_REGISTRY,
  generatePrimitiveCatalog,
} from './generate-primitive-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function primitiveScaffold({ id, name, layer, today }) {
  if (!/^[a-z0-9][a-z0-9-]+$/.test(id || '')) {
    throw new Error('--id must match ^[a-z0-9][a-z0-9-]+$');
  }
  if (!name || !layer) throw new Error('--name and --layer are required');
  const contractPath = `framework/primitive/contracts/${id}.contract.json`;
  const vectorPath = `tests/fixtures/primitive/${id}/vectors.json`;
  const operationPath = `framework/primitive/operation-slots/${id}.json`;
  const sdkPath = `framework/primitive/sdk-slots/${id}.json`;
  const passport = {
    id: `kungfu.primitive.${id}`,
    subject: `${name} primitive incubation`,
    subjectKind: 'identity-protocol',
    primitiveDeclarations: [
      {
        id,
        name,
        layer,
        maturity: 'incubating',
        authorityRef: contractPath,
        artifacts: [contractPath, vectorPath, operationPath, sdkPath],
        languageEvidence: { cpp: [], python: [], node: [], rust: [] },
        promotionEvidence: {
          contract: [contractPath],
          vectors: [],
          invariants: [],
          dogfoodReceipts: [],
        },
        nonClaims: [
          'Scaffold presence is not implementation, conformance, dogfood, or promotion proof.',
        ],
      },
    ],
    anchor: { type: 'git', authorityRef: contractPath },
    destinedAuthority: {
      layer,
      owner: 'pending primitive admission assignment',
      admissionAssignment: null,
    },
    incubation: {
      state: 'incubating',
      implementationPaths: [contractPath],
      startedOn: today,
      deadline: null,
      admissionTrigger:
        'Contract, vectors, invariants, four-language proofs, and retained dogfood receipts pass the primitive promotion gate.',
      currentBoundary:
        'The passport is the sole intake; generated catalog and SDK files are projections only.',
    },
    schemaOwnership: {
      class: 'none',
      registryRef: null,
      identity: null,
      rationale:
        'The scaffold does not yet declare persistent structured bytes.',
    },
    persistence: {
      policy: 'not-applicable',
      byteAuthority: contractPath,
      scriptLayerRole:
        'Scaffolding records intent and cannot mint runtime identity.',
    },
    identityProtocol: {
      mintsRoots: false,
      protocolId: null,
      implementations: [],
      vectors: [],
      goldenFixturePolicy:
        'If the primitive later mints Roots, admission requires two implementations and exact shared vectors.',
    },
  };
  return {
    passport,
    files: new Map([
      [
        contractPath,
        json({
          schema: 'kungfu.primitive.contract/v1',
          id,
          name,
          status: 'incubating',
          authority: PASSPORT_REGISTRY,
          nonClaims: passport.primitiveDeclarations[0].nonClaims,
        }),
      ],
      [
        vectorPath,
        json({
          schema: 'kungfu.primitive-vectors/v1',
          primitiveId: id,
          status: 'empty-scaffold',
          vectors: [],
        }),
      ],
      [
        operationPath,
        json({
          schema: 'kungfu.primitive-operation-slot/v1',
          primitiveId: id,
          status: 'unbound',
          operationIds: [],
        }),
      ],
      [
        sdkPath,
        json({
          schema: 'kungfu.primitive-sdk-slot/v1',
          primitiveId: id,
          status: 'unimplemented',
          languages: { cpp: [], python: [], node: [], rust: [] },
        }),
      ],
    ]),
  };
}

export function applyPrimitiveScaffold({
  root = ROOT,
  scaffold,
  write = false,
}) {
  const registryPath = path.join(root, PASSPORT_REGISTRY);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (
    registry.passports.some(
      (passport) =>
        passport.id === scaffold.passport.id ||
        passport.primitiveDeclarations?.some(
          (entry) => entry.id === scaffold.passport.primitiveDeclarations[0].id,
        ),
    )
  ) {
    throw new Error(
      `primitive already registered: ${scaffold.passport.primitiveDeclarations[0].id}`,
    );
  }
  for (const relativePath of scaffold.files.keys()) {
    if (fs.existsSync(path.join(root, relativePath))) {
      throw new Error(`scaffold target already exists: ${relativePath}`);
    }
  }
  const plan = [PASSPORT_REGISTRY, ...scaffold.files.keys()];
  if (!write) return plan;

  registry.passports.push(scaffold.passport);
  for (const [relativePath, contents] of scaffold.files) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, { flag: 'wx' });
  }
  fs.writeFileSync(registryPath, json(registry));
  generatePrimitiveCatalog({ root });
  return plan;
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    const args = process.argv.slice(2);
    const scaffold = primitiveScaffold({
      id: option(args, '--id'),
      name: option(args, '--name'),
      layer: option(args, '--layer'),
      today:
        option(args, '--started-on') || new Date().toISOString().slice(0, 10),
    });
    const write = args.includes('--write');
    const plan = applyPrimitiveScaffold({ scaffold, write });
    console.log(
      JSON.stringify(
        {
          schema: 'kungfu.primitive-scaffold-plan/v1',
          mode: write ? 'write' : 'dry-run',
          primitiveId: scaffold.passport.primitiveDeclarations[0].id,
          paths: plan,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`[primitive-new] ${error.message}`);
    process.exitCode = 1;
  }
}
