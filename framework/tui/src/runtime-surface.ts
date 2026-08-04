// SPDX-License-Identifier: Apache-2.0

export type RuntimeSurfaceObservation = {
  schema: 'kungfu.tui-runtime-surface-observation/v1';
  receiptRoot: string;
  contractRoot: string;
  operationId: string;
  runtimeSurface: 'installed-product' | 'source-checkout' | 'hybrid-boundary';
  selectedProvider: string;
  capabilities: string[];
  fallbackUsed: boolean;
  fallbackReason: string | null;
};

export function observeRuntimeSurfaceReceipt(
  value: unknown,
  verificationValue: unknown,
): RuntimeSurfaceObservation {
  if (!value || typeof value !== 'object') {
    throw new Error('Runtime Surface Receipt must be an object');
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.schema !== 'kungfu.runtime-surface-receipt/v1') {
    throw new Error('Runtime Surface Receipt schema is unsupported');
  }
  const root = String(receipt.receiptRoot || '');
  const contractRoot = String(receipt.contractRoot || '');
  if (
    !/^sha256:[0-9a-f]{64}$/.test(root) ||
    !/^sha256:[0-9a-f]{64}$/.test(contractRoot)
  ) {
    throw new Error('Runtime Surface Receipt is not content-rooted');
  }
  const selection = receipt.selection as Record<string, unknown> | undefined;
  const fallback = selection?.fallback as Record<string, unknown> | undefined;
  const runtimeSurface = receipt.runtimeSurface;
  if (
    runtimeSurface !== 'installed-product' &&
    runtimeSurface !== 'source-checkout' &&
    runtimeSurface !== 'hybrid-boundary'
  ) {
    throw new Error(
      'Runtime Surface Receipt names an unknown concrete surface',
    );
  }
  if (!verificationValue || typeof verificationValue !== 'object') {
    throw new Error('Runtime Surface Receipt verification is required');
  }
  const verification = verificationValue as Record<string, unknown>;
  if (
    verification.schema !== 'kungfu.runtime-surface-verification/v1' ||
    verification.ok !== true ||
    verification.receiptRoot !== root ||
    verification.contractRoot !== contractRoot ||
    verification.operationId !== receipt.operationId ||
    verification.runtimeSurface !== runtimeSurface ||
    verification.selectedProvider !== receipt.selectedProvider
  ) {
    throw new Error(
      'Runtime Surface Receipt disagrees with authority verification',
    );
  }
  return {
    schema: 'kungfu.tui-runtime-surface-observation/v1',
    receiptRoot: root,
    contractRoot,
    operationId: String(receipt.operationId || ''),
    runtimeSurface,
    selectedProvider: String(receipt.selectedProvider || ''),
    capabilities: Array.isArray(receipt.capabilities)
      ? receipt.capabilities.map(String)
      : [],
    fallbackUsed: fallback?.used === true,
    fallbackReason:
      typeof fallback?.reason === 'string' ? fallback.reason : null,
  };
}
