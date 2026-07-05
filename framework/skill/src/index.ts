// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type SkillKind = 'instruction-only' | 'kfx-backed';

export interface SkillKfxDependency {
  key: string;
  role?: string;
  version?: string;
  required?: boolean;
  [key: string]: unknown;
}

export interface SkillSource {
  schema: 'kungfu.skill/v1';
  key: string;
  title: string;
  description: string;
  kind: SkillKind;
  triggers: string[];
  capabilities: string[];
  kfx: SkillKfxDependency[];
  source: {
    path: string;
    hash: string;
  };
}

export interface SkillCatalogEntry {
  key: string;
  title: string;
  description: string;
  kind: SkillKind;
  triggers: string[];
  capabilities: string[];
  kfx: SkillKfxDependency[];
  loadPolicy: 'on-demand';
  sourceHash: string;
}

export interface SkillCatalog {
  schema: 'kungfu.skill-catalog/v1';
  skills: SkillCatalogEntry[];
}

export interface SkillContextEnvelope {
  schema: 'kungfu.skill-context/v1';
  session: {
    source: 'gui' | 'cli' | 'test';
    manager: 'node' | 'python';
    profile?: string;
    agent?: string;
    [key: string]: unknown;
  };
  catalog: SkillCatalogEntry[];
  tools: Array<{ name: string; description: string }>;
  audit: {
    runId?: string;
    advertisedSkillsHash: string;
    [key: string]: unknown;
  };
}

export interface SkillDependencyPackage {
  key: string;
  name?: string;
  version?: string;
  kind: string;
}

export interface SkillDependencyBindingRow {
  skillKey: string;
  kfxKey: string;
  role?: string;
  version?: string;
  required: boolean;
  status: 'resolved' | 'unresolved';
  registryKey: string;
  registryPath: string;
  reason?: string;
  package?: SkillDependencyPackage;
  [key: string]: unknown;
}

export interface SkillDependencyBinding {
  schema: 'kungfu.skill-dependencies/v1';
  skill: {
    key: string;
    title: string;
    kind: SkillKind;
    sourceHash: string;
    sourcePath: string;
  };
  registry: {
    type: 'kfx';
    root: string;
  };
  dependencies: SkillDependencyBindingRow[];
  summary: {
    total: number;
    resolved: number;
    unresolved: number;
  };
}

type Frontmatter = Record<string, unknown>;

export interface SkillContextOptions {
  source: SkillContextEnvelope['session']['source'];
  manager: SkillContextEnvelope['session']['manager'];
  profile?: string;
  agent?: string;
  extraPaths?: string[];
  env?: Record<string, string | undefined>;
}

export interface SkillContextFileOptions extends SkillContextOptions {
  out?: string;
}

export function parseSkill(skillDir: string): SkillSource {
  const root = resolve(skillDir);
  if (!statSync(root).isDirectory()) {
    throw new Error(`skill path is not a directory: ${skillDir}`);
  }
  const skillPath = join(root, 'SKILL.md');
  const markdown = readFileSync(skillPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(markdown);
  const title =
    stringValue(frontmatter.title) || firstHeading(body) || basename(root);
  const description =
    stringValue(frontmatter.description) || firstParagraph(body) || '';
  const kfx = kfxDependencies(frontmatter.kfx);
  const capabilities = stringList(frontmatter.capabilities);
  return {
    schema: 'kungfu.skill/v1',
    key: stringValue(frontmatter.key) || normalizeKey(basename(root)),
    title,
    description,
    kind: kfx.length || capabilities.length ? 'kfx-backed' : 'instruction-only',
    triggers: stringList(frontmatter.triggers),
    capabilities,
    kfx,
    source: {
      path: skillPath,
      hash: `sha256:${createHash('sha256').update(markdown).digest('hex')}`,
    },
  };
}

export function toCatalogEntry(skill: SkillSource): SkillCatalogEntry {
  return {
    key: skill.key,
    title: skill.title,
    description: skill.description,
    kind: skill.kind,
    triggers: skill.triggers,
    capabilities: skill.capabilities,
    kfx: skill.kfx,
    loadPolicy: 'on-demand',
    sourceHash: skill.source.hash,
  };
}

export function buildCatalog(skills: SkillSource[]): SkillCatalog {
  return {
    schema: 'kungfu.skill-catalog/v1',
    skills: skills.map(toCatalogEntry),
  };
}

export function buildContextEnvelope(
  catalog: SkillCatalog,
  session: SkillContextEnvelope['session'],
): SkillContextEnvelope {
  const advertised = stableStringify(catalog.skills);
  return {
    schema: 'kungfu.skill-context/v1',
    session,
    catalog: catalog.skills,
    tools: [
      {
        name: 'kungfu.skill.read',
        description: 'Load the full SKILL.md for a selected skill key.',
      },
    ],
    audit: {
      advertisedSkillsHash: `sha256:${createHash('sha256')
        .update(advertised)
        .digest('hex')}`,
    },
  };
}

export function skillRoots(
  home: string,
  extraPaths: string[] = [],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const roots: string[] = [];
  const envPath = env.KF_SKILL_PATH;
  if (envPath) {
    roots.push(...envPath.split(pathDelimiter()).filter(Boolean));
  }
  roots.push(...extraPaths);
  roots.push(join(home, 'skills'));
  return roots;
}

export function discoverSkills(
  home: string,
  extraPaths: string[] = [],
  env: Record<string, string | undefined> = process.env,
): SkillSource[] {
  const rows: SkillSource[] = [];
  const seen = new Set<string>();
  for (const root of skillRoots(home, extraPaths, env)) {
    for (const skillDir of candidateSkillDirs(root)) {
      let skill: SkillSource;
      try {
        skill = parseSkill(skillDir);
      } catch {
        continue;
      }
      if (seen.has(skill.key)) continue;
      seen.add(skill.key);
      rows.push(skill);
    }
  }
  return rows;
}

export function buildSkillContext(
  home: string,
  options: SkillContextOptions,
): SkillContextEnvelope {
  const session: SkillContextEnvelope['session'] = {
    source: options.source,
    manager: options.manager,
  };
  if (options.profile) session.profile = options.profile;
  if (options.agent) session.agent = options.agent;
  return buildContextEnvelope(
    buildCatalog(
      discoverSkills(
        home,
        options.extraPaths ?? [],
        options.env ?? process.env,
      ),
    ),
    session,
  );
}

export function writeSkillContextFile(
  home: string,
  options: SkillContextFileOptions,
): string {
  const envelope = buildSkillContext(home, options);
  const out = options.out
    ? resolve(options.out)
    : join(home, 'skill-context', `${options.profile || 'default'}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return out;
}

export function skillBindingRoot(home: string): string {
  return join(home, 'skill-bindings');
}

export function skillBindingPath(home: string, skillKey: string): string {
  return join(skillBindingRoot(home), `${skillKey}.json`);
}

export function buildSkillDependencyBinding(
  home: string,
  skill: SkillSource,
): SkillDependencyBinding {
  const dependencies = skill.kfx.map((dependency) =>
    dependencyBindingRow(home, skill, dependency),
  );
  const resolved = dependencies.filter(
    (row) => row.status === 'resolved',
  ).length;
  return {
    schema: 'kungfu.skill-dependencies/v1',
    skill: {
      key: skill.key,
      title: skill.title,
      kind: skill.kind,
      sourceHash: skill.source.hash,
      sourcePath: skill.source.path,
    },
    registry: {
      type: 'kfx',
      root: kfxRegistryRoot(home),
    },
    dependencies,
    summary: {
      total: dependencies.length,
      resolved,
      unresolved: dependencies.length - resolved,
    },
  };
}

export function writeSkillDependencyBinding(
  home: string,
  skill: SkillSource,
): { path: string; binding: SkillDependencyBinding } {
  const binding = buildSkillDependencyBinding(home, skill);
  const out = skillBindingPath(home, skill.key);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  return { path: out, binding };
}

export function readSkillDependencyBinding(
  home: string,
  skillKey: string,
): SkillDependencyBinding {
  return JSON.parse(readFileSync(skillBindingPath(home, skillKey), 'utf8'));
}

export function hasAdvertisedSkills(envelope: SkillContextEnvelope): boolean {
  return envelope.catalog.length > 0;
}

export function formatSkillContextPrompt(
  envelope: SkillContextEnvelope,
): string {
  return [
    'Kungfu Skill context envelope (compact, on-demand instructions):',
    stableStringify(envelope),
    'To load full SKILL.md content, ask the Kungfu host for kungfu.skill.read with a skill key.',
    'Skill instructions do not grant runtime privileges; kfx dependencies remain gated by kfx trust policy.',
  ].join('\n');
}

export function injectSkillContext(
  prompt: string,
  envelope: SkillContextEnvelope,
): string {
  if (!hasAdvertisedSkills(envelope)) return prompt;
  return `${formatSkillContextPrompt(envelope)}\n\nUser task:\n${prompt}`;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function candidateSkillDirs(root: string): string[] {
  if (!root || !existsSync(root)) return [];
  const absolute = resolve(root);
  if (existsSync(join(absolute, 'SKILL.md'))) return [absolute];
  try {
    if (!statSync(absolute).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(absolute)
    .sort()
    .map((name) => join(absolute, name))
    .filter((path) => {
      try {
        return (
          statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md'))
        );
      } catch {
        return false;
      }
    });
}

function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function splitFrontmatter(markdown: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  if (!markdown.startsWith('---\n')) {
    return { frontmatter: {}, body: markdown };
  }
  const end = markdown.indexOf('\n---\n', 4);
  if (end < 0) {
    return { frontmatter: {}, body: markdown };
  }
  return {
    frontmatter: parseSimpleYaml(markdown.slice(4, end)),
    body: markdown.slice(end + 5),
  };
}

function parseSimpleYaml(src: string): Frontmatter {
  const root: Frontmatter = {};
  const lines = src.split(/\r?\n/);
  let currentKey: string | undefined;
  let currentArray: unknown[] | undefined;
  let currentObject: Record<string, unknown> | undefined;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const listMatch = raw.match(/^ {2}-\s+(.*)$/);
    if (listMatch && currentKey && currentArray) {
      const value = listMatch[1];
      const kv = value.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (kv) {
        currentObject = { [kv[1]]: stripQuotes(kv[2]) };
        currentArray.push(currentObject);
      } else {
        currentObject = undefined;
        currentArray.push(stripQuotes(value));
      }
      continue;
    }
    const nestedMatch = raw.match(/^ {4}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (nestedMatch && currentObject) {
      currentObject[nestedMatch[1]] = stripQuotes(nestedMatch[2]);
      continue;
    }
    const scalarMatch = raw.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!scalarMatch) continue;
    currentKey = scalarMatch[1];
    currentObject = undefined;
    if (scalarMatch[2] === '') {
      currentArray = [];
      root[currentKey] = currentArray;
    } else {
      currentArray = undefined;
      root[currentKey] = stripQuotes(scalarMatch[2]);
    }
  }
  return root;
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return undefined;
}

function firstParagraph(body: string): string | undefined {
  const chunks = body
    .replace(/^#\s+.+$/m, '')
    .split(/\n\s*\n/)
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return chunks[0];
}

function normalizeKey(value: string): string {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return key || 'skill';
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function kfxDependencies(value: unknown): SkillKfxDependency[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => {
      return Boolean(item && typeof item === 'object' && stringValue(item.key));
    })
    .map((item) => ({ ...item, key: String(item.key) }));
}

function dependencyBindingRow(
  home: string,
  skill: SkillSource,
  dependency: SkillKfxDependency,
): SkillDependencyBindingRow {
  const key = String(dependency.key);
  const registryPath = join(kfxRegistryRoot(home), key);
  const resolved = resolveKfxPackage(registryPath, key);
  const version =
    dependency.version === undefined ? undefined : String(dependency.version);
  let status: SkillDependencyBindingRow['status'] = resolved
    ? 'resolved'
    : 'unresolved';
  let reason: string | undefined = resolved
    ? undefined
    : 'not installed in kfx registry';
  if (resolved && version && resolved.version !== version) {
    status = 'unresolved';
    reason = `installed version ${resolved.version} does not match ${version}`;
  }
  const row: SkillDependencyBindingRow = {
    skillKey: skill.key,
    kfxKey: key,
    role: typeof dependency.role === 'string' ? dependency.role : undefined,
    version,
    required: booleanValue(dependency.required, true),
    status,
    registryKey: key,
    registryPath,
  };
  for (const [extraKey, extraValue] of Object.entries(dependency).sort()) {
    if (!['key', 'role', 'version', 'required'].includes(extraKey)) {
      row[extraKey] = extraValue;
    }
  }
  if (resolved) row.package = resolved;
  if (reason) row.reason = reason;
  return row;
}

function resolveKfxPackage(
  packageDir: string,
  expectedKey: string,
): SkillDependencyPackage | undefined {
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  const config = objectValue(manifest.kungfuConfig);
  const key = stringValue(config?.key) || basename(packageDir);
  if (key !== expectedKey) return undefined;
  const facets = Object.keys(objectValue(config?.config) ?? {}).sort();
  return {
    key,
    name: stringValue(manifest.name),
    version: stringValue(manifest.version),
    kind: facets.length ? facets.join('+') : 'unknown',
  };
}

function kfxRegistryRoot(home: string): string {
  return join(home, 'extensions');
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return true;
    if (['false', 'no', '0'].includes(normalized)) return false;
  }
  return fallback;
}
