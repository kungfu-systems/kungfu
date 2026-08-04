// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

type RuntimeSurfaceCliInvocation = {
  bin: string;
  env: NodeJS.ProcessEnv;
  args: (values: string[]) => string[];
};

type RuntimeSurfaceDiagnosticIo = {
  cwd: () => string;
  readFile: (file: string) => string;
  verify: (
    invocation: RuntimeSurfaceCliInvocation,
    receiptPath: string,
  ) => string;
};

const defaultDiagnosticIo: RuntimeSurfaceDiagnosticIo = {
  cwd: () => process.cwd(),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  verify: (invocation, receiptPath) =>
    execFileSync(
      invocation.bin,
      invocation.args(['runtime', 'surface', 'verify', receiptPath, '--json']),
      { env: invocation.env, encoding: 'utf8' },
    ),
};

export function observeRuntimeSurfaceDiagnostic(
  argv: string[],
  invocation: RuntimeSurfaceCliInvocation,
  io: RuntimeSurfaceDiagnosticIo = defaultDiagnosticIo,
): RuntimeSurfaceObservation | null {
  const index = argv.indexOf('--runtime-surface-receipt');
  const receiptPath = index >= 0 ? String(argv[index + 1] || '') : '';
  if (!receiptPath) return null;
  const absolute = path.resolve(io.cwd(), receiptPath);
  const receipt = JSON.parse(io.readFile(absolute)) as unknown;
  const verification = JSON.parse(io.verify(invocation, absolute)) as unknown;
  return observeRuntimeSurfaceReceipt(receipt, verification);
}

export function runtimeSurfaceDiagnostic(
  argv: string[],
  runtimeDir: string,
  invocation: RuntimeSurfaceCliInvocation,
  io: RuntimeSurfaceDiagnosticIo = defaultDiagnosticIo,
) {
  return {
    schema: 'kungfu.tui.non-interactive/v1',
    status: 'not-started',
    reason: 'interactive terminal required',
    runtimeDir,
    runtimeSurface: observeRuntimeSurfaceDiagnostic(argv, invocation, io),
    next: 'run `kungfu` in a TTY',
  };
}

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
