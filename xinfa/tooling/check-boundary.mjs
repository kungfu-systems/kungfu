#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const XINFA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function scanSourceFiles(files, boundary) {
  const findings = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(XINFA_ROOT, file).split(path.sep).join('/');
    for (const namespace of boundary.core.forbiddenRustNamespaces) {
      const pattern = new RegExp(
        `\\b(?:extern\\s+crate\\s+${namespace}\\s*;|(?:use\\s+)?${namespace}::)`,
      );
      if (pattern.test(source)) {
        findings.push(`${relative}: forbidden Rust namespace ${namespace}`);
      }
    }
    for (const prefix of boundary.core.forbiddenPackagePrefixes) {
      if (source.includes(prefix)) {
        findings.push(`${relative}: forbidden package prefix ${prefix}`);
      }
    }
    for (const root of boundary.core.forbiddenRelativeRoots) {
      if (source.includes(root)) {
        findings.push(`${relative}: forbidden monorepo-relative root ${root}`);
      }
    }
  }
  return findings;
}

export function scanCargoManifest(cargo, boundary) {
  const findings = [];
  const dependencyBlock = `${cargo}\n[xinfa-boundary-end]\n`.match(
    /^\[dependencies\]\s*$([\s\S]*?)(?=^\[)/m,
  );
  const declared = new Set();
  if (dependencyBlock) {
    for (const line of dependencyBlock[1].split('\n')) {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!match) continue;
      declared.add(match[1]);
      if (/\b(?:path|git)\s*=/.test(match[2])) {
        findings.push(
          `Cargo.toml: dependency ${match[1]} must use the public registry`,
        );
      }
    }
  }
  const allowed = new Set(boundary.core.allowedDependencies);
  for (const dependency of declared) {
    if (!allowed.has(dependency)) {
      findings.push(`Cargo.toml: dependency ${dependency} is not allowlisted`);
    }
  }
  for (const dependency of allowed) {
    if (!declared.has(dependency)) {
      findings.push(
        `Cargo.toml: allowlisted dependency ${dependency} is missing`,
      );
    }
  }
  return findings;
}

export function validateBoundary(root = XINFA_ROOT) {
  const boundary = readJson(path.join(root, 'boundary.contract.json'));
  const extraction = readJson(path.join(root, 'extraction-manifest.json'));
  const product = readJson(
    path.join(root, 'contract', 'xinfa-product-v1.json'),
  );
  const findings = [];

  if (boundary.schema !== 'xinfa.standalone-boundary/v1') {
    findings.push('boundary.contract.json: unexpected schema');
  }
  if (product.schema !== 'xinfa.product-contract/v1') {
    findings.push('contract/xinfa-product-v1.json: unexpected schema');
  }
  if (extraction.schema !== 'xinfa.extraction-manifest/v1') {
    findings.push('extraction-manifest.json: unexpected schema');
  }
  if (product.product.id !== 'xinfa' || product.namespace.cli !== 'xinfa') {
    findings.push('product contract: product and CLI identity must be xinfa');
  }
  if (product.state.workspaceDefault !== '.xinfa') {
    findings.push('product contract: workspace state must default to .xinfa');
  }
  if (
    JSON.stringify(boundary.core.allowedDependencySources) !==
    JSON.stringify(['registry'])
  ) {
    findings.push(
      'boundary contract: only public registry dependencies are allowed',
    );
  }

  const extractionFiles = new Set(extraction.files);
  for (const required of [
    'Cargo.lock',
    'Cargo.toml',
    'LICENSE',
    'boundary.contract.json',
    'contract/xinfa-product-v1.json',
    'src/main.rs',
  ]) {
    if (!extractionFiles.has(required)) {
      findings.push(`extraction manifest: missing ${required}`);
    }
  }

  for (const relative of extraction.files) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      findings.push(`extraction manifest: unsafe path ${relative}`);
      continue;
    }
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) {
      findings.push(`extraction manifest: missing file ${relative}`);
    } else if (!fs.lstatSync(source).isFile()) {
      findings.push(`extraction manifest: ${relative} must be a regular file`);
    }
  }

  const cargo = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
  if (!/^name = "xinfa"$/m.test(cargo)) {
    findings.push('Cargo.toml: package name must be xinfa');
  }
  findings.push(...scanCargoManifest(cargo, boundary));

  const sourceFiles = extraction.files
    .filter((relative) => relative.endsWith('.rs') || relative === 'Cargo.toml')
    .map((relative) => path.join(root, relative));
  findings.push(...scanSourceFiles(sourceFiles, boundary));
  return findings;
}

function main() {
  const findings = validateBoundary();
  if (findings.length) {
    throw new Error(`Xinfa boundary violations:\n${findings.join('\n')}`);
  }
  console.log('[xinfa-boundary] standalone boundary passed');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[xinfa-boundary] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
