import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type KfxExperienceFlowDescriptor,
  projectKfxExperienceFlowHost,
} from '../src/capability/kfx-host.ts';

const descriptor: KfxExperienceFlowDescriptor = {
  schema: 'kungfu.kfx.experience-flow-host/v1',
  descriptorRoot: `sha256:${'1'.repeat(64)}`,
  graphRoot: `sha256:${'2'.repeat(64)}`,
  planRoot: `sha256:${'3'.repeat(64)}`,
  receiptDependencyRoot: `sha256:${'4'.repeat(64)}`,
  cutRoot: `sha256:${'5'.repeat(64)}`,
  revision: 7,
  contributions: [
    {
      contributionId: 'workbench',
      state: 'active',
      presentation: { optional: true, hosts: ['gui', 'cli'] },
    },
  ],
};

test('GUI, TUI, CLI, and Agent adapters retain the same Core identities', () => {
  const projections = (['gui', 'tui', 'cli', 'agent'] as const).map((host) =>
    projectKfxExperienceFlowHost(descriptor, host),
  );
  for (const projection of projections) {
    assert.equal(projection.descriptorRoot, descriptor.descriptorRoot);
    assert.equal(projection.graphRoot, descriptor.graphRoot);
    assert.equal(projection.planRoot, descriptor.planRoot);
    assert.equal(
      projection.receiptDependencyRoot,
      descriptor.receiptDependencyRoot,
    );
    assert.equal(projection.cutRoot, descriptor.cutRoot);
    assert.equal(projection.revision, descriptor.revision);
    assert.equal(projection.contributions[0]?.semanticState, 'active');
  }
  assert.equal(projections[0]?.contributions[0]?.presentationState, 'active');
  assert.equal(projections[1]?.contributions[0]?.presentationState, 'dormant');
  assert.equal(projections[1]?.contributions[0]?.executionEligible, true);
});
