// SPDX-License-Identifier: Apache-2.0

import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ReleaseManifest,
  RuntimeUpgradeBridge,
  RuntimeUpgradePlan,
  RuntimeUpgradeReceipt,
} from './update-controller';

type ExecFile = typeof nodeExecFile;

type RuntimeUpgradeCliDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  execFile?: ExecFile;
};

function stableJsonPath(
  stateDir: string,
  kind: string,
  value: Record<string, unknown>,
): string {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const digest = createHash('sha256')
    .update(payload)
    .digest('hex')
    .slice(0, 24);
  const dir = path.join(stateDir, 'inputs');
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `${kind}-${digest}.json`);
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(temporary, payload, 'utf8');
  renameSync(temporary, output);
  return output;
}

export function createRuntimeUpgradeCliBridge(
  deps: RuntimeUpgradeCliDeps,
): RuntimeUpgradeBridge {
  const execFile = deps.execFile ?? nodeExecFile;

  const runJson = async <T>(args: string[]): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      execFile(
        deps.bin,
        args,
        {
          encoding: 'utf8',
          env: deps.env,
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim() || error.message));
            return;
          }
          try {
            resolve(JSON.parse(stdout) as T);
          } catch (parseError) {
            reject(
              new Error(
                `runtime upgrade CLI returned invalid JSON: ${(parseError as Error).message}`,
              ),
            );
          }
        },
      );
    });

  const manifestPath = (manifest: ReleaseManifest) =>
    stableJsonPath(deps.stateDir, 'manifest', manifest);

  return {
    async installBundledRuntime(manifest, bundledRuntimeRoot) {
      const manifestFile = manifestPath(manifest);
      const plan = await runJson<Record<string, unknown>>([
        'runtime',
        'upgrade',
        'plan-install',
        manifestFile,
        bundledRuntimeRoot,
        '--json',
      ]);
      if (
        plan.state !== 'download-allowed' ||
        typeof plan.planId !== 'string'
      ) {
        throw new Error('Core rejected the bundled runtime install plan');
      }
      return await runJson<Record<string, unknown>>([
        'runtime',
        'upgrade',
        'install',
        manifestFile,
        bundledRuntimeRoot,
        '--expected-plan-id',
        plan.planId,
        '--execute',
        '--json',
      ]);
    },

    async plan(manifest) {
      return await runJson<RuntimeUpgradePlan>([
        'runtime',
        'upgrade',
        'plan',
        manifestPath(manifest),
        '--json',
      ]);
    },

    async stage(plan) {
      const args = [
        'runtime',
        'upgrade',
        'stage',
        stableJsonPath(deps.stateDir, 'plan', plan),
        '--expected-plan-id',
        plan.planId,
      ];
      if (plan.activeGeneration !== null) {
        args.push('--current-generation', plan.activeGeneration);
      }
      args.push('--json');
      return await runJson<RuntimeUpgradeReceipt>(args);
    },

    async reconcile(receipt, readinessPassed) {
      return await runJson<RuntimeUpgradeReceipt>([
        'runtime',
        'upgrade',
        'reconcile',
        stableJsonPath(deps.stateDir, 'receipt', receipt),
        '--readiness-passed',
        readinessPassed ? 'yes' : 'no',
        '--json',
      ]);
    },
  };
}
