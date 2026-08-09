// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  throw new Error(message);
}

function repositoryReference(root, file) {
  const absoluteRoot = fs.realpathSync(path.resolve(root));
  const absoluteFile = fs.realpathSync(path.resolve(file));
  const reference = path
    .relative(absoluteRoot, absoluteFile)
    .replaceAll('\\', '/');
  if (!reference || reference === '..' || reference.startsWith('../'))
    fail(`Gate evidence must stay inside the repository: ${absoluteFile}`);
  return reference;
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/** Write task-specific evidence when a Shifu Gate executor requested it. */
export function writeShifuGateEvidence({
  schema,
  pointers,
  root = process.cwd(),
  evidenceFile = process.env.SHIFU_GATE_EVIDENCE_FILE,
}) {
  if (!evidenceFile) return false;
  if (!schema || !Array.isArray(pointers) || pointers.length === 0)
    fail('Gate evidence requires a schema and at least one pointer');

  const evidence = {
    schema,
    pointers: pointers.map(({ id, file }) => {
      if (!id || !file) fail('Gate evidence pointers require id and file');
      if (!fs.existsSync(file))
        fail(`Gate evidence file does not exist: ${file}`);
      return {
        id,
        ref: repositoryReference(root, file),
        digest: sha256(file),
      };
    }),
  };
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  return true;
}
