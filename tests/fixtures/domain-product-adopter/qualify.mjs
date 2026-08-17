// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { qualifyDomainProduct } from './product.mjs';

const require = createRequire(import.meta.url);
const packageNames = [
  '@kungfu-tech/core',
  '@kungfu-tech/kfd',
  '@kungfu-tech/buildchain',
];
const packageOnly = packageNames.every((name) => {
  const packagePath = fs.realpathSync(require.resolve(`${name}/package.json`));
  return packagePath.startsWith(
    `${fs.realpathSync(path.join(process.cwd(), 'node_modules'))}${path.sep}`,
  );
});
if (!packageOnly) throw new Error('clean-room package resolution escaped node_modules');

const golden = qualifyDomainProduct();
const negativeVectors = [
  'copied-kungfu-roots',
  'undeclared-primitive',
  'runtime-fault-omission',
  'recovery-substitution',
].map((vector) => qualifyDomainProduct({ vector }));
const passed =
  golden.status === 'passed' &&
  golden.gate.status === 'passed' &&
  golden.gate.qualifying === false &&
  golden.gate.selfCertified === false &&
  golden.adopterId !== 'kungfu-systems/kungfu' &&
  golden.fault.rejected === true &&
  golden.recovery.matchesLiveState === true &&
  negativeVectors.every(({ status }) => status === 'failed');

process.stdout.write(
  `${JSON.stringify({
    schema: 'example.domain-product.clean-room-result/v1',
    passed,
    packageOnly,
    golden,
    negativeVectors: negativeVectors.map(({ vector, status, issues }) => ({
      vector,
      status,
      issueCodes: [...new Set(issues.map(({ code }) => code))].sort(),
    })),
  })}\n`,
);
if (!passed) process.exitCode = 1;
