#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EVIDENCE_CLASS_PATTERN = /^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/u;
const DIGEST_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const REQUIRED_NON_AUTHORITIES = [
  'publication-authority',
  'runtime-authority',
  'first-party-identity',
  'system-identity',
  'kfd-compliance',
  'product-system-metadata',
  'package-metadata',
  'registry-history',
  'scan-output',
  'standalone-generation',
];
export const DEFAULT_CATALOG_PATH = path.join(
  import.meta.dirname,
  'catalog.json',
);

function fail(message) {
  throw new Error(`auditable demo catalog: ${message}`);
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not declared`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is missing`);
  }
}

function string(value, pattern, label, maximum = 4096) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is out of range`);
  }
  return value;
}

function stringArray(value, label, minimum = 1) {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.some(
      (item) =>
        typeof item !== 'string' || item.length < 1 || item.length > 4096,
    )
  ) {
    fail(`${label} is invalid`);
  }
  return [...value];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function root(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function validateDemo(value, index) {
  const label = `demos[${index}]`;
  exactKeys(
    value,
    [
      'id',
      'argv',
      'commandLabel',
      'evidenceClass',
      'terminal',
      'completion',
      'scene',
      'renditions',
      'publication',
      'claimBoundary',
      'claims',
      'nonClaims',
    ],
    [],
    label,
  );
  const id = string(value.id, ID_PATTERN, `${label}.id`, 64);
  const argv = stringArray(value.argv, `${label}.argv`);
  if (
    argv.length > 16 ||
    argv.some(
      (argument) =>
        argument.length > 256 ||
        argument.includes('\0') ||
        argument.includes('\r') ||
        argument.includes('\n'),
    )
  ) {
    fail(`${label}.argv is not a bounded exact argument vector`);
  }
  exactKeys(
    value.terminal,
    ['columns', 'rows', 'timeoutSeconds'],
    [],
    `${label}.terminal`,
  );
  const terminal = {
    columns: integer(
      value.terminal.columns,
      40,
      240,
      `${label}.terminal.columns`,
    ),
    rows: integer(value.terminal.rows, 12, 80, `${label}.terminal.rows`),
    timeoutSeconds: integer(
      value.terminal.timeoutSeconds,
      1,
      60,
      `${label}.terminal.timeoutSeconds`,
    ),
  };
  exactKeys(
    value.completion,
    ['sentinel', 'schema', 'status', 'digestField', 'countField'],
    [],
    `${label}.completion`,
  );
  const completion = {
    sentinel: string(
      value.completion.sentinel,
      null,
      `${label}.completion.sentinel`,
      128,
    ),
    schema: string(
      value.completion.schema,
      /^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/u,
      `${label}.completion.schema`,
      256,
    ),
    status: string(
      value.completion.status,
      /^[a-z][a-z0-9-]*$/u,
      `${label}.completion.status`,
      64,
    ),
    digestField: string(
      value.completion.digestField,
      DIGEST_FIELD_PATTERN,
      `${label}.completion.digestField`,
      64,
    ),
    countField: string(
      value.completion.countField,
      DIGEST_FIELD_PATTERN,
      `${label}.completion.countField`,
      64,
    ),
  };
  if (completion.digestField === completion.countField) {
    fail(`${label}.completion fields must be distinct`);
  }
  exactKeys(
    value.scene,
    ['id', 'width', 'height', 'fps', 'title', 'background', 'accent'],
    [],
    `${label}.scene`,
  );
  const scene = {
    id: string(value.scene.id, ID_PATTERN, `${label}.scene.id`, 128),
    width: integer(value.scene.width, 320, 3840, `${label}.scene.width`),
    height: integer(value.scene.height, 240, 2160, `${label}.scene.height`),
    fps: integer(value.scene.fps, 1, 60, `${label}.scene.fps`),
    title: string(value.scene.title, null, `${label}.scene.title`, 256),
    background: string(
      value.scene.background,
      /^#[0-9A-Fa-f]{6}$/u,
      `${label}.scene.background`,
      7,
    ),
    accent: string(
      value.scene.accent,
      /^#[0-9A-Fa-f]{6}$/u,
      `${label}.scene.accent`,
      7,
    ),
  };
  if (!Array.isArray(value.renditions) || value.renditions.length !== 2) {
    fail(
      `${label}.renditions must declare exactly primary and responsive captures`,
    );
  }
  const renditions = value.renditions.map((rendition, renditionIndex) => {
    const renditionLabel = `${label}.renditions[${renditionIndex}]`;
    exactKeys(
      rendition,
      ['id', 'role', 'terminal', 'scene'],
      [],
      renditionLabel,
    );
    const renditionId = string(
      rendition.id,
      ID_PATTERN,
      `${renditionLabel}.id`,
      32,
    );
    if (!['primary', 'responsive'].includes(rendition.role)) {
      fail(`${renditionLabel}.role is unsupported`);
    }
    exactKeys(
      rendition.terminal,
      ['columns', 'rows', 'timeoutSeconds'],
      [],
      `${renditionLabel}.terminal`,
    );
    const renditionTerminal = {
      columns: integer(
        rendition.terminal.columns,
        40,
        240,
        `${renditionLabel}.terminal.columns`,
      ),
      rows: integer(
        rendition.terminal.rows,
        12,
        80,
        `${renditionLabel}.terminal.rows`,
      ),
      timeoutSeconds: integer(
        rendition.terminal.timeoutSeconds,
        1,
        60,
        `${renditionLabel}.terminal.timeoutSeconds`,
      ),
    };
    exactKeys(
      rendition.scene,
      ['id', 'width', 'height', 'fps', 'title', 'background', 'accent'],
      [],
      `${renditionLabel}.scene`,
    );
    const renditionScene = {
      id: string(
        rendition.scene.id,
        ID_PATTERN,
        `${renditionLabel}.scene.id`,
        128,
      ),
      width: integer(
        rendition.scene.width,
        320,
        3840,
        `${renditionLabel}.scene.width`,
      ),
      height: integer(
        rendition.scene.height,
        240,
        2160,
        `${renditionLabel}.scene.height`,
      ),
      fps: integer(rendition.scene.fps, 1, 60, `${renditionLabel}.scene.fps`),
      title: string(
        rendition.scene.title,
        null,
        `${renditionLabel}.scene.title`,
        256,
      ),
      background: string(
        rendition.scene.background,
        /^#[0-9A-Fa-f]{6}$/u,
        `${renditionLabel}.scene.background`,
        7,
      ),
      accent: string(
        rendition.scene.accent,
        /^#[0-9A-Fa-f]{6}$/u,
        `${renditionLabel}.scene.accent`,
        7,
      ),
    };
    return {
      id: renditionId,
      role: rendition.role,
      terminal: renditionTerminal,
      scene: renditionScene,
    };
  });
  if (
    JSON.stringify(renditions.map(({ id, role }) => ({ id, role }))) !==
      JSON.stringify([
        { id: '1080p', role: 'primary' },
        { id: '720p', role: 'responsive' },
      ]) ||
    JSON.stringify(renditions[0].terminal) !== JSON.stringify(terminal) ||
    JSON.stringify(renditions[0].scene) !== JSON.stringify(scene) ||
    renditions[0].scene.width !== 1920 ||
    renditions[0].scene.height !== 1080 ||
    renditions[1].scene.width !== 1280 ||
    renditions[1].scene.height !== 720 ||
    JSON.stringify(renditions[0].terminal) ===
      JSON.stringify(renditions[1].terminal)
  ) {
    fail(`${label}.renditions must be distinct native 1080p and 720p captures`);
  }
  exactKeys(
    value.publication,
    ['readmeFeatured', 'siteSlug'],
    [],
    `${label}.publication`,
  );
  if (typeof value.publication.readmeFeatured !== 'boolean') {
    fail(`${label}.publication.readmeFeatured must be boolean`);
  }
  const publication = {
    readmeFeatured: value.publication.readmeFeatured,
    siteSlug: string(
      value.publication.siteSlug,
      ID_PATTERN,
      `${label}.publication.siteSlug`,
      64,
    ),
  };
  return {
    id,
    argv,
    commandLabel: string(
      value.commandLabel,
      /^kungfu [^\r\n]+$/u,
      `${label}.commandLabel`,
      512,
    ),
    evidenceClass: string(
      value.evidenceClass,
      EVIDENCE_CLASS_PATTERN,
      `${label}.evidenceClass`,
      256,
    ),
    terminal,
    completion,
    scene,
    renditions,
    publication,
    claimBoundary: string(
      value.claimBoundary,
      null,
      `${label}.claimBoundary`,
      4096,
    ),
    claims: stringArray(value.claims, `${label}.claims`),
    nonClaims: stringArray(value.nonClaims, `${label}.nonClaims`),
  };
}

export function loadAuditableDemo({
  catalogPath = DEFAULT_CATALOG_PATH,
  demoId,
} = {}) {
  const resolvedPath = path.resolve(catalogPath);
  const metadata = fs.lstatSync(resolvedPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 1024 * 1024
  ) {
    fail('catalog must be a bounded regular non-symlink file');
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    fail(`catalog is not valid UTF-8 JSON: ${error.message}`);
  }
  exactKeys(
    input,
    ['schema', 'authority', 'defaultDemoId', 'demos'],
    [],
    'catalog',
  );
  if (input.schema !== 'kungfu.auditable-demo.catalog/v1') {
    fail('catalog schema is unsupported');
  }
  exactKeys(
    input.authority,
    ['classification', 'grants', 'nonAuthorities'],
    [],
    'catalog.authority',
  );
  if (
    input.authority.classification !== 'capture-selection-input' ||
    !Array.isArray(input.authority.grants) ||
    input.authority.grants.length !== 0 ||
    JSON.stringify(input.authority.nonAuthorities) !==
      JSON.stringify(REQUIRED_NON_AUTHORITIES)
  ) {
    fail('catalog authority boundary is invalid');
  }
  const defaultDemoId = string(
    input.defaultDemoId,
    ID_PATTERN,
    'catalog.defaultDemoId',
    64,
  );
  if (
    !Array.isArray(input.demos) ||
    input.demos.length < 1 ||
    input.demos.length > 32
  ) {
    fail('catalog.demos must contain between 1 and 32 entries');
  }
  const demos = input.demos.map(validateDemo);
  const ids = demos.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) fail('demo ids must be unique');
  const siteSlugs = demos.map(({ publication }) => publication.siteSlug);
  if (new Set(siteSlugs).size !== siteSlugs.length) {
    fail('demo site slugs must be unique');
  }
  if (
    demos.filter(({ publication }) => publication.readmeFeatured).length !== 1
  ) {
    fail('exactly one demo must be README-featured');
  }
  if (!ids.includes(defaultDemoId)) fail('default demo id is not declared');
  const selectedId = demoId || defaultDemoId;
  if (!ID_PATTERN.test(selectedId)) fail('selected demo id is invalid');
  const demo = demos.find(({ id }) => id === selectedId);
  if (!demo) fail(`selected demo id is not declared: ${selectedId}`);
  const catalog = {
    schema: input.schema,
    authority: input.authority,
    defaultDemoId,
    demos,
  };
  return {
    schema: 'kungfu.auditable-demo.selection/v1',
    catalogPath: resolvedPath,
    catalogRoot: root(catalog),
    descriptorRoot: root(demo),
    defaultDemoId,
    demo,
  };
}

function parseCli(argv) {
  const options = { catalogPath: DEFAULT_CATALOG_PATH, demoId: '' };
  const [command, ...rest] = argv;
  if (command !== 'resolve') {
    fail('usage: catalog.mjs resolve [--catalog PATH] [--demo-id ID]');
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--catalog') options.catalogPath = rest[++index] || '';
    else if (argument === '--demo-id') options.demoId = rest[++index] || '';
    else fail(`unknown argument: ${argument}`);
  }
  if (!options.catalogPath) fail('--catalog requires a path');
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    process.stdout.write(
      stableJson(
        loadAuditableDemo({
          catalogPath: options.catalogPath,
          demoId: options.demoId,
        }),
      ),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
