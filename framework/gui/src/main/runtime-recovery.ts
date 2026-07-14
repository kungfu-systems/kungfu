import {
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type RuntimeRecoveryReceipt = {
  schema: 'kungfu.gui.runtime-recovery/v1';
  recoveredAt: string;
  originalRuntimeDir: string;
  backupPath: string;
  reason: string;
};

function timestampSegment(now: Date): string {
  return now.toISOString().replaceAll(/[-:.]/gu, '');
}

function availableBackupPath(root: string, segment: string): string {
  const candidate = path.join(root, `runtime-${segment}`);
  if (!existsSync(candidate)) return candidate;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!existsSync(next)) return next;
  }
  throw new Error('could not allocate a unique runtime backup path');
}

export function backupAndResetRuntime(options: {
  dataHome: string;
  runtimeDir: string;
  reason: string;
  now?: Date;
}): RuntimeRecoveryReceipt {
  const dataHome = path.resolve(options.dataHome);
  const runtimeDir = path.resolve(options.runtimeDir);
  const expectedRuntimeDir = path.join(dataHome, 'runtime');
  if (runtimeDir !== expectedRuntimeDir) {
    throw new Error(
      `refusing runtime recovery outside the selected data home: ${runtimeDir}`,
    );
  }
  if (!existsSync(runtimeDir)) {
    throw new Error(`runtime directory does not exist: ${runtimeDir}`);
  }

  const now = options.now ?? new Date();
  const backupRoot = path.join(dataHome, 'backups', 'runtime-recovery');
  mkdirSync(backupRoot, { recursive: true });
  const backupPath = availableBackupPath(backupRoot, timestampSegment(now));
  renameSync(runtimeDir, backupPath);
  try {
    mkdirSync(runtimeDir, { recursive: false });
    const receipt: RuntimeRecoveryReceipt = {
      schema: 'kungfu.gui.runtime-recovery/v1',
      recoveredAt: now.toISOString(),
      originalRuntimeDir: runtimeDir,
      backupPath,
      reason: options.reason,
    };
    writeFileSync(
      path.join(backupPath, 'gui-runtime-recovery.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return receipt;
  } catch (error) {
    try {
      rmdirSync(runtimeDir);
      renameSync(backupPath, runtimeDir);
    } catch {
      // Preserve the original failure. The backup path remains intact.
    }
    throw error;
  }
}
