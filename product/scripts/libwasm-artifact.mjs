// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualificationAuthority } from '@kungfu-tech/workspaces/testing/fixtures/_kfx-authority';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function libwasmArtifactPaths(platform = process.platform) {
  const host =
    platform === 'win32' ? 'kungfu-wasm-host.exe' : 'kungfu-wasm-host';
  const adapters =
    platform === 'win32'
      ? ['kungfu_libwasm_wasmtime.dll', 'kungfu_libwasm_wasmer.dll']
      : platform === 'darwin'
        ? ['libkungfu_libwasm_wasmtime.dylib', 'libkungfu_libwasm_wasmer.dylib']
        : ['libkungfu_libwasm_wasmtime.so', 'libkungfu_libwasm_wasmer.so'];
  return [
    host,
    ...adapters.map((name) => path.join('libwasm', name)),
    path.join('libwasm', 'contract.json'),
    path.join('libwasm', 'wit', 'kungfu-journal-batch.wit'),
    path.join('libwasm', 'include', 'kungfu', 'libwasm.h'),
  ];
}

export function assertLibwasmArtifact(root, platform = process.platform) {
  const required = libwasmArtifactPaths(platform);
  const missing = required.filter((relative) => {
    const target = path.join(root, relative);
    return !fs.existsSync(target) || !fs.statSync(target).isFile();
  });
  if (missing.length) {
    throw new Error(
      `production libwasm artifact incomplete; missing: ${missing.join(', ')}`,
    );
  }
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, 'libwasm', 'contract.json'), 'utf8'),
  );
  if (
    contract.schema !== 'kungfu.libwasm.contract/v1' ||
    contract.world !== 'kungfu:journal/batch@1.0.0' ||
    contract.engines?.primary !== 'wasmtime' ||
    contract.engines?.fallback !== 'wasmer'
  ) {
    throw new Error('production libwasm contract is incompatible');
  }
  const names = fs.readdirSync(path.join(root, 'libwasm'));
  if (names.some((name) => name.toLowerCase().includes('spike'))) {
    throw new Error('experimental libwasm spike artifacts must not ship');
  }
  return required;
}

export function runLibwasmArtifactSelfTest(root, platform = process.platform) {
  const host = path.join(
    root,
    platform === 'win32' ? 'kungfu-wasm-host.exe' : 'kungfu-wasm-host',
  );
  const result = spawnSync(host, ['--self-test'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `production libwasm self-test failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  const receipt = JSON.parse(result.stdout);
  if (
    receipt.schema !== 'kungfu.libwasm.self-test/v1' ||
    receipt.engines?.wasmtime?.metering !== true ||
    receipt.engines?.wasmer?.metering !== true
  ) {
    throw new Error('production libwasm self-test receipt is incomplete');
  }
  return receipt;
}

const QUALIFICATION_WASM_HEX =
  '0061736d01000000010b026000017f60027f7f017e0303020001050401010202072a03066d656d6f727902000d6b665f636f6e74726f6c5f763100000d6b665f636f6e73756d655f763100010a1d02040041070b16002000310000422086200020016a41016b310000840b0014046e616d65020d010102000370747201036c656e';

export function runLibwasmExecutionQualification(
  root,
  platform = process.platform,
) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-libwasm-'));
  try {
    const home = path.join(temporary, 'home');
    const runtimeDir = path.join(home, 'runtime');
    const sourceRoot = path.join(temporary, 'source');
    const packageDir = path.join(sourceRoot, 'libwasm-qualification');
    fs.mkdirSync(packageDir, { recursive: true });
    const module = path.join(packageDir, 'qualification.wasm');
    const bytes = Buffer.from(QUALIFICATION_WASM_HEX, 'hex');
    fs.writeFileSync(module, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(
      path.join(packageDir, 'kungfu.kfx.json'),
      `${JSON.stringify(
        {
          schema: 'kungfu.kfx.manifest/v1',
          name: '@kungfu-test/libwasm-qualification',
          version: '1.0.0',
          kungfuConfig: {
            key: 'libwasm-qualification',
            config: {
              wasm: {
                world: 'kungfu:journal/batch@1.0.0',
                entry: 'qualification.wasm',
                sha256: digest,
                capabilities: ['journal.read.batch'],
                engine: 'wasmtime',
                fallback: 'wasmer',
                limits: {
                  fuel: 100000,
                  memoryPages: 2,
                  batchFrames: 1,
                  moduleBytes: 4096,
                  outputBytes: 64,
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const executable = path.join(
      root,
      platform === 'win32' ? 'kungfu.exe' : 'kungfu',
    );
    const runKungfu = (args, label) => {
      const result = spawnSync(executable, ['-H', home, ...args], {
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(
          `${label} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`,
        );
      }
      return result;
    };
    const inspect = JSON.parse(
      runKungfu(
        [
          'kfx',
          'native',
          'inspect',
          'libwasm-qualification',
          '--root',
          `workspace=${sourceRoot}`,
        ],
        'production libwasm package inspection',
      ).stdout,
    );
    const authorityFile = path.join(temporary, 'authority.json');
    fs.writeFileSync(
      authorityFile,
      `${JSON.stringify(
        qualificationAuthority(
          REPO_ROOT,
          inspect.package.packageRoot,
          inspect.package.declaredCapabilities,
        ),
        null,
        2,
      )}\n`,
    );
    runKungfu(
      ['kfx', 'install', packageDir, '--authority-file', authorityFile],
      'production libwasm package admission',
    );
    const plan = JSON.parse(
      runKungfu(
        [
          'kfx',
          'native',
          'plan',
          '--root',
          `user=${path.join(home, 'extensions')}`,
        ],
        'production libwasm host plan',
      ).stdout,
    );
    const descriptor = plan.hostContract;
    const authorization = descriptor.runtimeAuthorizations.find(
      (item) =>
        item.packageKey === 'libwasm-qualification' && item.host === 'wasm',
    );
    if (!authorization) {
      throw new Error(
        'production libwasm host plan has no admitted WASM authorization',
      );
    }
    const host = path.join(
      root,
      platform === 'win32' ? 'kungfu-wasm-host.exe' : 'kungfu-wasm-host',
    );
    const receipts = {};
    for (const engine of ['wasmtime', 'wasmer']) {
      const args = [
        '--runtime-dir',
        runtimeDir,
        '--module',
        module,
        '--expected-sha256',
        digest,
        '--package-key',
        'libwasm-qualification',
        '--package-root',
        authorization.packageRoot,
        '--authorization-root',
        authorization.authorizationRoot,
        '--capability-grant-root',
        authorization.capabilityGrantRoot,
        '--generation-root',
        descriptor.generationRoot,
        '--cut-root',
        descriptor.cutRoot,
        '--revision',
        String(descriptor.revision),
        '--world',
        'kungfu:journal/batch@1.0.0',
        '--capabilities',
        '1',
        '--fuel',
        '100000',
        '--memory-pages',
        '2',
        '--batch-frames',
        '1',
        '--module-bytes',
        '4096',
        '--output-bytes',
        '64',
        '--source-namespace',
        'libwasm_qualification',
        '--source-name',
        'fixture',
        '--engine',
        engine,
      ];
      if (engine === 'wasmtime') args.push('--qualification-seed', '1');
      const result = spawnSync(host, args, { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(
          `production libwasm ${engine} execution qualification failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`,
        );
      }
      const receipt = JSON.parse(result.stdout);
      if (
        receipt.schema !== 'kungfu.libwasm.execution-receipt/v1' ||
        receipt.engine !== engine ||
        receipt.status !== 0 ||
        receipt.frame_count !== 1 ||
        receipt.host_to_guest_bytes_copied !== 256 ||
        !receipt.admission_event_id ||
        !receipt.execution_admission_event_id
      ) {
        throw new Error(`production libwasm ${engine} receipt is incomplete`);
      }
      receipts[engine] = receipt;
    }
    return receipts;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
