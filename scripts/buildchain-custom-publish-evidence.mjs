#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeArtifact(artifact, index) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`required artifact ${index} must be an object`);
  }
  for (const key of ['kind', 'name', 'digest']) {
    if (!artifact[key] || typeof artifact[key] !== 'string') {
      throw new Error(`required artifact ${index}.${key} must be a string`);
    }
  }
  return {
    ...(artifact.group ? { group: artifact.group } : {}),
    kind: artifact.kind,
    name: artifact.name,
    ...(artifact.ref ? { ref: artifact.ref } : {}),
    digest: artifact.digest,
    ...(artifact.role ? { role: artifact.role } : {}),
    ...(artifact.platform ? { platform: artifact.platform } : {}),
  };
}

function generateKfdEvidence() {
  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPT_DIR, 'buildchain-kfd-evidence.mjs'), '--write'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `failed to generate Buildchain KFD evidence: ${`${result.stdout || ''}${result.stderr || ''}`.trim()}`,
    );
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (output) console.log(output);
}

function main() {
  const evidencePath = requireEnv('BUILDCHAIN_PUBLISH_EVIDENCE');
  const version = requireEnv('BUILDCHAIN_VERSION');
  generateKfdEvidence();
  const requiredArtifactsPath =
    process.env.BUILDCHAIN_PUBLISH_REQUIRED_ARTIFACTS_PATH ||
    path.join(
      process.cwd(),
      '.buildchain',
      'release-candidate',
      'publish-required-artifacts.json',
    );
  const requiredArtifacts = readJson(
    requiredArtifactsPath,
    'Buildchain required artifact list',
  );
  if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length === 0) {
    throw new Error(
      'Buildchain required artifact list must contain at least one artifact',
    );
  }

  const evidence = {
    schema: 1,
    version,
    channel: requireEnv('BUILDCHAIN_CHANNEL'),
    source_sha: requireEnv('BUILDCHAIN_SOURCE_SHA'),
    release_sha: requireEnv('BUILDCHAIN_RELEASE_SHA'),
    target_ref: requireEnv('BUILDCHAIN_TARGET_REF'),
    release_material_sha: requireEnv('BUILDCHAIN_RELEASE_MATERIAL_SHA'),
    publish_tooling_sha: requireEnv('BUILDCHAIN_PUBLISH_TOOLING_SHA'),
    artifacts: requiredArtifacts.map(normalizeArtifact),
  };

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `buildchain custom publish evidence wrote ${evidence.artifacts.length} artifacts to ${evidencePath}`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `buildchain custom publish evidence failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
