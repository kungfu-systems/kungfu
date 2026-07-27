export type KfxHost = 'gui' | 'tui' | 'cli' | 'agent';
export type KfxNodeState = 'active' | 'dormant' | 'degraded';

export type KfxHostContribution = {
  state: KfxNodeState;
  presentation?: {
    optional?: boolean;
    hosts?: KfxHost[];
  };
  [key: string]: unknown;
};

export type KfxExperienceFlowDescriptor = {
  schema: 'kungfu.kfx.experience-flow-host/v1';
  descriptorRoot: string;
  graphRoot: string;
  planRoot: string;
  receiptDependencyRoot: string;
  generation: number;
  contributions: KfxHostContribution[];
};

export type KfxHostProjection = {
  schema: 'kungfu.kfx.host-projection/v1';
  host: KfxHost;
  descriptorRoot: string;
  graphRoot: string;
  planRoot: string;
  receiptDependencyRoot: string;
  generation: number;
  contributions: Array<
    KfxHostContribution & {
      semanticState: KfxNodeState;
      presentationState: KfxNodeState;
      executionEligible: boolean;
    }
  >;
};

// Rendering stays host-native. This adapter may annotate availability, but it
// cannot change Core graph, plan, capability, authorization, or receipt roots.
export function projectKfxExperienceFlowHost(
  descriptor: KfxExperienceFlowDescriptor,
  host: KfxHost,
): KfxHostProjection {
  if (descriptor.schema !== 'kungfu.kfx.experience-flow-host/v1') {
    throw new Error('unsupported KFX Experience/Flow host descriptor');
  }
  return {
    schema: 'kungfu.kfx.host-projection/v1',
    host,
    descriptorRoot: descriptor.descriptorRoot,
    graphRoot: descriptor.graphRoot,
    planRoot: descriptor.planRoot,
    receiptDependencyRoot: descriptor.receiptDependencyRoot,
    generation: descriptor.generation,
    contributions: descriptor.contributions.map((contribution) => {
      const supported =
        contribution.presentation?.hosts?.includes(host) === true;
      const optional = contribution.presentation?.optional === true;
      const presentationState: KfxNodeState = supported
        ? 'active'
        : optional
          ? 'dormant'
          : 'degraded';
      return {
        ...contribution,
        semanticState: contribution.state,
        presentationState,
        executionEligible:
          contribution.state === 'active' && presentationState !== 'degraded',
      };
    }),
  };
}
