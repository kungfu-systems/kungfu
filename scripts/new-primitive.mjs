#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  PASSPORT_REGISTRY,
  buildPrimitiveCatalog,
  generatePrimitiveCatalog,
} from './generate-primitive-catalog.mjs';
import { runDocumentationCommand } from './shifu-documentation-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const PRIMITIVE_CONTEXT_ROUTE = 'kungfu-primitive-management-agent';
export const PRIMITIVE_CONTEXT_PARITY_GROUP = 'kungfu-primitive-management';
export const PRIMITIVE_CONTEXT_ROLE = 'implementer';
export const PRIMITIVE_CONTEXT_BUDGET = 48000;

function primitiveContextTask(id) {
  return `author Kungfu Primitive ${id} through the governed passport workflow`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requiredRoot(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value || '')) {
    throw new Error(`primitive context ${label} is missing or invalid`);
  }
  return value;
}

export function primitiveContextBinding(receipt, primitiveId) {
  if (
    receipt?.schema !== 'shifu.documentation-dual-reader-receipt/v1' ||
    receipt?.verdict !== 'pass' ||
    receipt?.operation !== 'context'
  ) {
    throw new Error('primitive context receipt is missing or did not pass');
  }
  const projection = receipt.projection;
  const route = receipt.route;
  const task = primitiveContextTask(primitiveId);
  if (
    route?.id !== PRIMITIVE_CONTEXT_ROUTE ||
    route?.audience !== 'agent' ||
    route?.parityGroup !== PRIMITIVE_CONTEXT_PARITY_GROUP ||
    projection?.task?.route !== PRIMITIVE_CONTEXT_ROUTE ||
    projection?.task?.role !== PRIMITIVE_CONTEXT_ROLE ||
    projection?.task?.intent !== task
  ) {
    throw new Error('primitive context route or task binding mismatched');
  }
  if (
    projection?.schema !== 'xinfa.task-chart/v1' ||
    projection?.status !== 'complete'
  ) {
    throw new Error('primitive context Task Chart is incomplete');
  }
  if (
    (projection.omissions || []).length > 0 ||
    (projection.parity?.atlas_omissions || []).length > 0
  ) {
    throw new Error('primitive context Task Chart contains omissions');
  }
  if (
    projection.parity?.route?.id !== PRIMITIVE_CONTEXT_ROUTE ||
    projection.parity?.route?.parity_group !== PRIMITIVE_CONTEXT_PARITY_GROUP ||
    projection.parity?.route?.status !== 'current'
  ) {
    throw new Error('primitive context route authority is not current');
  }
  return {
    schema: 'kungfu.primitive-authoring-context/v1',
    route: PRIMITIVE_CONTEXT_ROUTE,
    parityGroup: PRIMITIVE_CONTEXT_PARITY_GROUP,
    intent: task,
    role: PRIMITIVE_CONTEXT_ROLE,
    budget: {
      maxTokens: projection.budget?.max_tokens,
      usedTokens: projection.budget?.used_tokens,
    },
    inventoryRoot: requiredRoot(receipt.inventoryRoot, 'inventory Root'),
    atlasRoot: requiredRoot(projection.atlas_root, 'Atlas Root'),
    cutRoot: requiredRoot(projection.cut_root, 'Cut Root'),
    routeRoot: requiredRoot(projection.parity?.route?.route_root, 'route Root'),
    authorityRoot: requiredRoot(
      projection.parity?.route?.authority_root,
      'authority Root',
    ),
    policyRoot: requiredRoot(projection.policy_root, 'policy Root'),
    projectionRoot: requiredRoot(projection.projection_root, 'projection Root'),
    sourceRoots: projection.parity?.source_roots,
    unitRoots: (projection.units || []).map((unit) => ({
      id: unit.id,
      path: unit.source?.path,
      contentRoot: requiredRoot(unit.source?.content_root, 'unit content Root'),
    })),
    status: projection.status,
    omissions: [],
  };
}

export async function compilePrimitiveContext({
  root = ROOT,
  primitiveId,
  runDocumentation = runDocumentationCommand,
}) {
  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  let errors = '';
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      errors += chunk.toString();
      callback();
    },
  });
  const task = primitiveContextTask(primitiveId);
  const status = await runDocumentation(
    [
      'context',
      '--task',
      task,
      '--role',
      PRIMITIVE_CONTEXT_ROLE,
      '--budget',
      String(PRIMITIVE_CONTEXT_BUDGET),
      '--route',
      PRIMITIVE_CONTEXT_ROUTE,
      '--json',
    ],
    { root, stdout, stderr },
  );
  if (status !== 0) {
    throw new Error(`primitive context compilation failed: ${errors.trim()}`);
  }
  let receipt;
  try {
    receipt = JSON.parse(output);
  } catch {
    throw new Error('primitive context compiler did not emit JSON');
  }
  return primitiveContextBinding(receipt, primitiveId);
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
          primitiveId: id,
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

function parseAuthoringOptions(args) {
  const values = new Map();
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (
      ![
        '--id',
        '--name',
        '--layer',
        '--started-on',
        '--actor',
        '--context-root',
      ].includes(arg)
    ) {
      throw new Error(`unknown primitive authoring option: ${arg}`);
    }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  const actor = values.get('--actor') || null;
  if (actor && !['agent', 'human'].includes(actor)) {
    throw new Error('--actor must be agent or human');
  }
  if (write && !actor) {
    throw new Error('--write requires explicit --actor agent or --actor human');
  }
  return {
    id: values.get('--id'),
    name: values.get('--name'),
    layer: values.get('--layer'),
    today: values.get('--started-on') || new Date().toISOString().slice(0, 10),
    actor,
    contextRoot: values.get('--context-root') || null,
    write,
  };
}

export async function runPrimitiveAuthoring({
  args,
  root = ROOT,
  contextCompiler = compilePrimitiveContext,
  catalogBuilder = buildPrimitiveCatalog,
  scaffoldApplier = applyPrimitiveScaffold,
}) {
  const options = parseAuthoringOptions(args);
  const scaffold = primitiveScaffold(options);
  const plan = scaffoldApplier({ root, scaffold, write: false });
  const context = await contextCompiler({
    root,
    primitiveId: scaffold.passport.primitiveDeclarations[0].id,
  });
  if (options.write && options.actor === 'agent') {
    if (!options.contextRoot) {
      throw new Error(
        'agent-managed --write requires --context-root from the current dry-run',
      );
    }
    if (options.contextRoot !== context.projectionRoot) {
      throw new Error(
        `primitive context Root is stale or mismatched: ${options.contextRoot} != ${context.projectionRoot}`,
      );
    }
  }
  const catalogRootBefore = catalogBuilder(root).catalogRoot;
  if (options.write) {
    scaffoldApplier({ root, scaffold, write: true });
  }
  return {
    schema: 'kungfu.primitive-authoring-receipt/v2',
    mode: options.write ? 'write' : 'dry-run',
    actor: options.actor || 'unspecified',
    primitiveId: scaffold.passport.primitiveDeclarations[0].id,
    context,
    catalog: {
      beforeRoot: catalogRootBefore,
      afterRoot: options.write ? catalogBuilder(root).catalogRoot : null,
    },
    paths: plan,
  };
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    const args = process.argv.slice(2);
    console.log(JSON.stringify(await runPrimitiveAuthoring({ args }), null, 2));
  } catch (error) {
    console.error(`[primitive-new] ${error.message}`);
    process.exitCode = 1;
  }
}
