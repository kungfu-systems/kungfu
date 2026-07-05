// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

type Frontmatter = Record<string, unknown>;

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

function stableStringify(value: unknown): string {
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
    const listMatch = raw.match(/^  -\s+(.*)$/);
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
    const nestedMatch = raw.match(/^    ([A-Za-z0-9_.-]+):\s*(.*)$/);
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
