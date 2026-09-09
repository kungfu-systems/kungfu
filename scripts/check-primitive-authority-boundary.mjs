#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCTION_ROOTS = [
  'crates/',
  'developer/',
  'extensions/',
  'framework/',
  'product/',
  'scripts/',
];
const SOURCE_FILE =
  /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|jsx|mjs|cjs|py|rs|ts|tsx)$/u;
const NON_PRODUCTION =
  /(?:^|\/)(?:fixtures?|tests?)(?:\/|$)|(?:^|\/)generated\/|\.test\.|_tests?\./u;

const AUTHORITY_ANCHORS = [
  /primitiveDeclarations/u,
  /kungfu-primitive-catalog\.contract\.json/u,
  /kungfu\.primitive-catalog\/v[0-9]+/u,
  /primitive_catalog_v[0-9]+/u,
  /load_contract\(["']primitive-catalog["']\)/u,
  /["']primitive_catalog["']/u,
];
const PASSPORT_ANCHOR = /incubation-passport\.registry\.json/u;
const PRIMITIVE_CONTEXT = /primitive/iu;

const GOVERNED_SOURCES = new Map([
  [
    'scripts/generate-primitive-catalog.mjs',
    {
      role: 'sole-derived-projection-generator',
      required: [
        /framework\/spec\/incubation\/incubation-passport\.registry\.json/u,
        /framework\/spec\/primitive\/kungfu-primitive-catalog\.contract\.json/u,
        /config\/primitive\/kungfu-primitive-catalog\.contract\.json/u,
        /primitive_catalog_v2\.hpp/u,
      ],
      forbidden: [],
    },
  ],
  [
    'scripts/new-primitive.mjs',
    {
      role: 'sole-passport-authoring-entrypoint',
      required: [/primitiveDeclarations/u, /runPrimitiveAuthoring/u],
      forbidden: [
        /framework\/spec\/primitive\/kungfu-primitive-catalog\.contract\.json/u,
        /config\/primitive\/kungfu-primitive-catalog\.contract\.json/u,
      ],
    },
  ],
  [
    'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
    {
      role: 'read-only-native-projection',
      required: [
        /#include <kungfu\/sdk\/generated\/primitive_catalog_v2\.hpp>/u,
        /json::parse\(CATALOG_JSON\.begin\(\), CATALOG_JSON\.end\(\)\)/u,
      ],
      forbidden: [
        /incubation-passport/u,
        /primitiveDeclarations/u,
        /(?:std::)?ofstream/u,
      ],
    },
  ],
  [
    'framework/core/src/python/kungfu/cli/commands/primitive.py',
    {
      role: 'read-only-installed-contract-projection',
      required: [
        /contract_runtime\.load_contract\(["']primitive-catalog["']\)/u,
      ],
      forbidden: [
        /incubation-passport/u,
        /primitiveDeclarations/u,
        /write_contract/u,
        /open\([^\n]*["'](?:w|a|x|\+)[^"']*["']/u,
      ],
    },
  ],
  [
    'scripts/buildchain-kfd-evidence.mjs',
    {
      role: 'read-only-kfd5-candidate-reference',
      required: [
        /framework\/spec\/primitive\/kungfu-primitive-catalog\.contract\.json/u,
      ],
      forbidden: [
        /incubation-passport/u,
        /primitiveDeclarations/u,
        /writeJson\([^)]*kungfu-primitive-catalog/u,
      ],
    },
  ],
  [
    'scripts/check-primitive-authority-boundary.mjs',
    {
      role: 'authority-boundary-enforcer',
      required: [/AUTHORITY_ANCHORS/u, /GOVERNED_SOURCES/u],
      forbidden: [],
    },
  ],
]);

function repositoryFiles(root) {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `cannot enumerate Primitive authority consumers: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

export function productionSource(pathname) {
  return (
    PRODUCTION_ROOTS.some((prefix) => pathname.startsWith(prefix)) &&
    SOURCE_FILE.test(pathname) &&
    !NON_PRODUCTION.test(pathname)
  );
}

export function authorityAnchored(content) {
  return (
    AUTHORITY_ANCHORS.some((pattern) => pattern.test(content)) ||
    (PASSPORT_ANCHOR.test(content) && PRIMITIVE_CONTEXT.test(content))
  );
}

export function primitiveAuthorityBoundaryIssues(entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.content]));
  const issues = [];

  for (const [pathname, content] of byPath) {
    if (!productionSource(pathname) || !authorityAnchored(content)) continue;
    if (!GOVERNED_SOURCES.has(pathname)) {
      issues.push(`undeclared-primitive-authority-source:${pathname}`);
    }
  }

  for (const [pathname, policy] of GOVERNED_SOURCES) {
    const content = byPath.get(pathname);
    if (content === undefined) {
      issues.push(`governed-primitive-authority-source-missing:${pathname}`);
      continue;
    }
    for (const required of policy.required) {
      if (!required.test(content)) {
        issues.push(
          `primitive-authority-binding-missing:${pathname}:${policy.role}`,
        );
      }
    }
    for (const forbidden of policy.forbidden) {
      if (forbidden.test(content)) {
        issues.push(`primitive-authority-bypass:${pathname}:${policy.role}`);
      }
    }
  }

  return [...new Set(issues)].sort();
}

export function scanPrimitiveAuthorityBoundary(root = ROOT) {
  const entries = repositoryFiles(root)
    .filter(productionSource)
    .map((pathname) => ({
      path: pathname,
      content: fs.readFileSync(path.join(root, pathname), 'utf8'),
    }));
  return primitiveAuthorityBoundaryIssues(entries);
}

export function checkPrimitiveAuthorityBoundary(root = ROOT) {
  const issues = scanPrimitiveAuthorityBoundary(root);
  if (issues.length) {
    throw new Error(
      `Primitive authority boundary denied: ${issues.join(', ')}`,
    );
  }
  return {
    schema: 'kungfu.primitive-authority-boundary-check/v1',
    status: 'pass',
    governedSources: [...GOVERNED_SOURCES].map(([pathname, policy]) => ({
      path: pathname,
      role: policy.role,
    })),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = checkPrimitiveAuthorityBoundary();
    console.log(
      `[primitive-authority] consumer closure is current (${result.governedSources.length} governed sources)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
