import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  admit,
  digest,
  discoverBuildchainReleaseWorkflows,
  inspectLive,
  status,
  validateBuildWorkflowAuthority,
  validateExternalWorkflowInventory,
  validatePromotionWorkflowAuthority,
  validateRegistry,
} from '../framework/release/publication-control-plane.mjs';
const p = path.join(
  process.cwd(),
  'framework/release/publication-surfaces.json',
);
const get = () => JSON.parse(fs.readFileSync(p, 'utf8'));
const reroot = (v) => {
  v.protocol.protocolRoot = digest(
    Object.fromEntries(
      Object.entries(v.protocol).filter(([k]) => k !== 'protocolRoot'),
    ),
  );
  for (const c of v.rulesetContracts)
    if (c.ruleset)
      c.contractRoot = digest(
        Object.fromEntries(
          Object.entries(c).filter(([k]) => k !== 'contractRoot'),
        ),
      );
  v.repositories.buildchain.workflowInventoryRoot = digest(
    [...v.repositories.buildchain.workflowInventory].sort(),
  );
  v.registryRoot = digest(
    Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'registryRoot')),
  );
  return v;
};
test('checked registry closes workflows and invariants', () => {
  const v = get();
  assert.equal(validateRegistry(v), v);
  assert.equal(status(v).sourceAcceptance, 'passed');
});
test('build authority binds the workflow shell channel while retaining runtime routing', () => {
  const source = fs.readFileSync('.github/workflows/build.yml', 'utf8');
  const contract = JSON.parse(
    fs.readFileSync('docs/release-promotion-rehearsal.contract.json', 'utf8'),
  );
  const shellRef = contract.buildchain.build_workflow_shell_ref;
  assert.equal(validateBuildWorkflowAuthority(source, shellRef), true);
  assert.throws(
    () => validateBuildWorkflowAuthority(source, '0'.repeat(40)),
    /shell channel is invalid/u,
  );
  assert.throws(
    () =>
      validateBuildWorkflowAuthority(
        source.replace(`.build.yml@${shellRef}`, '.build.yml@v3'),
        shellRef,
      ),
    /authority drift/u,
  );
});
test('promotion authority keeps Alpha workflow routing floating and recovery runtime exact', () => {
  const source = fs.readFileSync(
    '.github/workflows/release-new-version.yml',
    'utf8',
  );
  const policy = JSON.parse(
    fs.readFileSync(
      'docs/qualification/gates/release-admission-policy.json',
      'utf8',
    ),
  );
  const runtime = policy.buildchain.runtimes.alpha.publicationRuntimeSha;
  assert.equal(validatePromotionWorkflowAuthority(source, runtime), true);
  assert.throws(
    () =>
      validatePromotionWorkflowAuthority(
        source.replace(
          'release-candidate-promote.yml@v3-alpha',
          `release-candidate-promote.yml@${runtime}`,
        ),
        runtime,
      ),
    /authority drift/u,
  );
  assert.throws(
    () =>
      validatePromotionWorkflowAuthority(
        source.replace(
          'buildchain-ref: ${{ inputs.resume-buildchain-runtime-sha }}',
          'buildchain-ref: v3-alpha',
        ),
        runtime,
      ),
    /authority drift/u,
  );
});
test('unregistered local workflow fails', () => {
  const v = get();
  v.repositories.kungfu.workflowInventory.pop();
  reroot(v);
  assert.throws(() => validateRegistry(v), /workflow inventory drift/);
});
test('conformant surface cannot omit a binding', () => {
  const v = get();
  v.surfaces[0].bindings = Object.fromEntries(
    Object.entries(v.surfaces[0].bindings).filter(
      ([key]) => key !== 'public-readback',
    ),
  );
  reroot(v);
  assert.throws(() => validateRegistry(v), /does not bind every invariant/);
});
test('surface workflow binding must be declared by the workflow inventory', () => {
  const v = get();
  v.surfaces
    .find((x) => x.id === 'product-binaries')
    .workflowBindings.push('.github/workflows/stable-candidate-patrol.yml');
  reroot(v);
  assert.throws(() => validateRegistry(v), /not surface-bound/);
});
test('prose-only isolation fails', () => {
  const v = get();
  const s = v.surfaces.find((x) => x.id === 'shifu-launcher');
  s.isolation.missingInvariants = [];
  reroot(v);
  assert.throws(() => validateRegistry(v), /partition every invariant/);
});
test('alpha and stable admit while major fails closed', () => {
  const v = get();
  assert.equal(admit(v, 'product-alpha').qualifying, true);
  assert.equal(admit(v, 'product-stable').qualifying, true);
  assert.equal(admit(v, 'product-major').qualifying, false);
});
test('isolated rehearsal never publishes', () => {
  const x = admit(get(), 'layer-artifacts', 'rehearsal');
  assert.equal(x.qualifying, true);
  assert.equal(x.publishing, false);
});
test('Buildchain inventory detects additions', () => {
  const v = get();
  const e = v.repositories.buildchain.workflowInventory;
  assert.deepEqual(discoverBuildchainReleaseWorkflows(v, e), e);
  const x = validateExternalWorkflowInventory(v, [
    ...e,
    '.github/workflows/release-surprise.yml',
  ]);
  assert.equal(x.qualifying, false);
  assert.deepEqual(x.unregistered, ['.github/workflows/release-surprise.yml']);
});

test('live inspection reads exact Buildchain and both admitted channel rulesets', () => {
  const v = get();
  const alpha = JSON.parse(
    fs.readFileSync('docs/qualification/alpha-ruleset.contract.json', 'utf8'),
  );
  const stable = JSON.parse(
    fs.readFileSync('docs/qualification/stable-ruleset.contract.json', 'utf8'),
  );
  const routes = [];
  const github = (route) => {
    routes.push(route);
    if (route.includes('/rulesets?')) return [{ id: 101 }, { id: 102 }];
    if (route.endsWith('/rulesets/101')) return { id: 101, ...alpha.ruleset };
    if (route.endsWith('/rulesets/102')) return { id: 102, ...stable.ruleset };
    if (route.includes('/git/trees/'))
      return {
        truncated: false,
        tree: v.repositories.buildchain.workflowInventory.map((path) => ({
          path,
        })),
      };
    throw new Error(`unexpected route ${route}`);
  };
  const live = inspectLive(v, { github });
  assert.equal(live.qualifying, true);
  assert.equal(
    live.rulesets.find(({ channel }) => channel === 'alpha').status,
    'matching',
  );
  assert.equal(
    live.rulesets.find(({ channel }) => channel === 'stable').status,
    'matching',
  );
  assert.equal(
    live.rulesets.find(({ channel }) => channel === 'major').status,
    'missing',
  );
  assert.equal(
    live.surfaces.find(({ id }) => id === 'product-alpha').publicationReady,
    true,
  );
  assert.equal(
    live.surfaces.find(({ id }) => id === 'product-stable').publicationReady,
    true,
  );
  assert.equal(routes.length, 4);
  assert.ok(routes.every((route) => !/[?&](method|action)=/u.test(route)));
});
