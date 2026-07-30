import contract from '@kungfu-tech/kfx/shared-modules';

export type KfxSharedModuleInputs = {
  react: unknown;
  jsxRuntime: unknown;
  reactDom: unknown;
  reactDomClient: unknown;
  api: unknown;
  capability: unknown;
  query: unknown;
};

export const KFX_SHARED_MODULE_KEYS = Object.freeze([...contract.modules]);

export function createKfxSharedModules(
  inputs: KfxSharedModuleInputs,
): Record<string, unknown> {
  const modules: Record<string, unknown> = {
    react: inputs.react,
    'react/jsx-runtime': inputs.jsxRuntime,
    'react-dom': inputs.reactDom,
    'react-dom/client': inputs.reactDomClient,
    '@kungfu-tech/api': inputs.api,
    '@kungfu-tech/api/capability': inputs.capability,
    '@kungfu-tech/api/query': inputs.query,
  };
  const missing = KFX_SHARED_MODULE_KEYS.filter((key) => !(key in modules));
  if (missing.length > 0) {
    throw new Error(
      `kfx shared module contract missing: ${missing.join(', ')}`,
    );
  }
  return modules;
}
