// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProjectCut,
  buildSourceProjection,
  createProjectCutReceipt,
  semanticRoot,
  verifyProjectCut,
  verifyProjectCutReceipt,
  verifySourceProjection,
} from '../framework/project-cut/index.mjs';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const require = createRequire(import.meta.url);

function loadAjv2020() {
  try {
    return require('ajv/dist/2020.js').default;
  } catch {
    return null;
  }
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function setPath(value, dottedPath, replacement, remove = false) {
  const parts = dottedPath.split('.');
  let cursor = value;
  for (const part of parts.slice(0, -1))
    cursor = cursor[Number.isNaN(Number(part)) ? part : Number(part)];
  const last = parts.at(-1);
  if (remove) delete cursor[last];
  else cursor[last] = replacement;
}

export function loadProjectCutFixture(root = DEFAULT_ROOT) {
  const fixture = readJson(
    root,
    'framework/project-cut/fixtures/golden/project-cut-v1.json',
  );
  const { policy, projection } = buildSourceProjection(
    fixture.sourceProjectionInput,
    fixture.policy,
  );
  const input = structuredClone(fixture.projectCutInput);
  input.sourceProjection.root = projection.root;
  input.sourceProjection.policyRoot = policy.policyRoot;
  const options = {
    expectedSchemaRoot: input.interpretation.schemaRoot,
    expectedProtocolRoot: input.interpretation.protocolRoot,
    availableParentRoots: input.parentCutRoots,
    expectedProviderRoots: Object.fromEntries(
      input.episodeDelta.nativeRoots.map((entry) => [
        entry.provider,
        entry.root,
      ]),
    ),
  };
  const cut = buildProjectCut(input, options);
  const receipt = createProjectCutReceipt(cut, null, options);
  return { fixture, policy, projection, cut, receipt, options };
}

function applyNegativeCase(base, item) {
  const target = structuredClone(
    item.target === 'cut' ? base.cut : base.projection,
  );
  const options = structuredClone(base.options);
  if (item.operation === 'set') setPath(target, item.path, item.value);
  else if (item.operation === 'delete') setPath(target, item.path, null, true);
  else if (item.operation === 'reverse') {
    const parts = item.path.split('.');
    let cursor = target;
    for (const part of parts) cursor = cursor[part];
    cursor.reverse();
  } else if (item.operation === 'copy-cut-root-to-parent') {
    target.parentCutRoots = [target.cutRoot];
  } else if (item.operation === 'provider-drift') {
    target.episodeDelta.nativeRoots[0].root =
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  } else if (item.operation === 'parent-mismatch') {
    options.availableParentRoots = [];
  } else {
    throw new Error(`unknown negative fixture operation '${item.operation}'`);
  }
  return item.target === 'cut'
    ? verifyProjectCut(target, options)
    : verifySourceProjection(target, base.policy);
}

export function computeProjectCutContractRoots(root = DEFAULT_ROOT) {
  const contract = readJson(
    root,
    'framework/project-cut/project-cut.contract.json',
  );
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(
      readJson(root, path.join('framework/project-cut', relative)),
    ),
  }));
  const schemaRoot = semanticRoot({
    schema: 'project.cut.schema-bundle/v1',
    files,
  });
  const { protocolRoot: _declaredProtocolRoot, ...protocolPreimage } = contract;
  const protocolRoot = semanticRoot(protocolPreimage);
  return { contract, files, schemaRoot, protocolRoot };
}

export function checkProjectCutContract(root = DEFAULT_ROOT) {
  const roots = computeProjectCutContractRoots(root);
  if (roots.schemaRoot !== roots.contract.schemaBundle.schemaRoot)
    throw new Error(
      `schema root mismatch: expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.protocolRoot !== roots.contract.protocolRoot)
    throw new Error(
      `protocol root mismatch: expected ${roots.contract.protocolRoot}, got ${roots.protocolRoot}`,
    );
  const base = loadProjectCutFixture(root);
  if (base.receipt.rootAlgorithm !== roots.contract.rootAlgorithm.id)
    throw new Error(
      'receipt root algorithm differs from the protocol contract',
    );
  const defaultPolicy = readJson(
    root,
    'framework/project-cut/default-source-projection-policy.json',
  );
  const { policyRoot: _declaredPolicyRoot, ...policyPreimage } = defaultPolicy;
  if (semanticRoot(policyPreimage) !== defaultPolicy.policyRoot)
    throw new Error('default source projection policy root mismatch');
  if (
    defaultPolicy.policyRoot !==
      roots.contract.sourceProjection.defaultPolicyRoot ||
    roots.contract.sourceProjection.defaultPolicyPath !==
      'default-source-projection-policy.json'
  )
    throw new Error(
      'contract does not bind the default source projection policy',
    );
  if (semanticRoot(base.fixture.policy) !== semanticRoot(policyPreimage))
    throw new Error(
      'golden fixture policy differs from the bound default policy',
    );
  const expected = {
    policyRoot: base.policy.policyRoot,
    sourceProjectionRoot: base.projection.root,
    cutRoot: base.cut.cutRoot,
    serializationRoot: base.receipt.serializationRoot,
    artifactDigest: base.receipt.artifactDigest,
    receiptRoot: base.receipt.receiptRoot,
  };
  if (JSON.stringify(expected) !== JSON.stringify(base.fixture.expected))
    throw new Error(
      `golden root drift:\nexpected ${JSON.stringify(base.fixture.expected)}\nactual   ${JSON.stringify(expected)}`,
    );
  const cutResult = verifyProjectCut(base.cut, base.options);
  if (!cutResult.valid)
    throw new Error(
      `golden cut invalid: ${JSON.stringify(cutResult.diagnostics)}`,
    );
  const projectionResult = verifySourceProjection(base.projection, base.policy);
  if (!projectionResult.valid)
    throw new Error(
      `golden projection invalid: ${JSON.stringify(projectionResult.diagnostics)}`,
    );
  const receiptResult = verifyProjectCutReceipt(
    base.receipt,
    base.cut,
    null,
    base.options,
  );
  if (!receiptResult.valid)
    throw new Error(
      `golden receipt invalid: ${JSON.stringify(receiptResult.diagnostics)}`,
    );
  const schemas = Object.fromEntries(
    roots.contract.schemaBundle.files.map((relative) => [
      relative,
      readJson(root, path.join('framework/project-cut', relative)),
    ]),
  );
  const invalidCut = structuredClone(base.cut);
  Reflect.deleteProperty(invalidCut, 'interpretation');
  const invalidReceipt = createProjectCutReceipt(invalidCut);
  const schemaFixtures = [
    ['schema/source-projection-policy-v1.schema.json', base.policy],
    ['schema/source-projection-v1.schema.json', base.projection],
    ['schema/project-cut-v1.schema.json', base.cut],
    ['schema/project-cut-receipt-v1.schema.json', base.receipt],
    ['schema/project-cut-receipt-v1.schema.json', invalidReceipt],
  ];
  const Ajv2020 = loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const [relative, value] of schemaFixtures) {
      const validate = ajv.compile(schemas[relative]);
      if (!validate(value))
        throw new Error(
          `schema validation failed for ${relative}: ${JSON.stringify(validate.errors)}`,
        );
    }
  }
  const negative = readJson(
    root,
    'framework/project-cut/fixtures/negative/cases-v1.json',
  );
  for (const item of negative.cases) {
    const result = applyNegativeCase(base, item);
    if (
      result.valid ||
      !result.diagnostics.some(({ code }) => code === item.expectedCode)
    )
      throw new Error(
        `negative fixture '${item.id}' did not produce ${item.expectedCode}: ${JSON.stringify(result.diagnostics)}`,
      );
  }
  return {
    schemaRoot: roots.schemaRoot,
    protocolRoot: roots.protocolRoot,
    cutRoot: base.cut.cutRoot,
    receiptRoot: base.receipt.receiptRoot,
    schemaFiles: roots.files.length,
    schemaFixtures: Ajv2020 ? schemaFixtures.length : 0,
    schemaValidation: Ajv2020 ? 'passed' : 'skipped',
    negativeFixtures: negative.cases.length,
  };
}
