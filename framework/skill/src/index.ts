// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';

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
  kungfu?: KungfuEnvironment;
  catalog: SkillCatalogEntry[];
  tools: Array<{ name: string; description: string }>;
  audit: {
    runId?: string;
    advertisedSkillsHash: string;
    [key: string]: unknown;
  };
}

export interface KungfuEnvironment {
  schema: 'kungfu.environment/v1';
  environment: 'managed-run' | 'test';
  agentEntrypoint: string;
}

export interface KungfuResolvedConfig {
  schema: 'kungfu.config.resolved/v1';
  contract: Record<string, unknown>;
  configHome: string;
  configPath: string;
  runtimeHome: string;
  sources: Array<Record<string, unknown>>;
  config: Record<string, unknown>;
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

export interface SkillManagerEntry {
  key: string;
  title: string;
  description: string;
  kind: SkillKind;
  triggers: string[];
  capabilities: string[];
  sourceHash: string;
  sourcePath: string;
  catalogEntry: SkillCatalogEntry;
  dependencies: SkillDependencyBinding;
  dependencySummary: SkillDependencyBinding['summary'];
  hasUnresolvedRequiredDependencies: boolean;
}

export interface SkillManagerView {
  schema: 'kungfu.skill-manager/v1';
  registry: {
    type: 'kfx';
    root: string;
  };
  skills: SkillManagerEntry[];
  agentInventory: AgentSkillInventory;
  summary: {
    skills: number;
    dependencies: number;
    resolved: number;
    unresolved: number;
    unresolvedRequired: number;
    kfxKeys: string[];
    unresolvedKfxKeys: string[];
  };
}

export type AgentSkillProvider = 'codex' | 'claude';

export type AgentSkillRootType =
  | 'user-home'
  | 'identity-pool'
  | 'system'
  | 'repo-local'
  | 'configured';

export interface AgentSkillInventoryRootInput {
  provider: AgentSkillProvider;
  home: string;
  rootType: AgentSkillRootType;
  path: string;
  priority?: number;
}

export interface AgentSkillInventorySymlink {
  isSymlink: boolean;
  target?: string;
  realPath?: string;
  broken?: boolean;
}

export interface AgentSkillInventoryRoot {
  provider: AgentSkillProvider;
  home: string;
  rootType: AgentSkillRootType;
  path: string;
  priority: number;
  exists: boolean;
  status: 'ok' | 'missing' | 'not-directory' | 'unreadable';
  symlink?: AgentSkillInventorySymlink;
  error?: string;
}

export interface AgentSkillInventoryEntry {
  key: string;
  title: string;
  description: string;
  provider: AgentSkillProvider;
  home: string;
  rootPath: string;
  rootType: AgentSkillRootType;
  priority: number;
  path: string;
  hash?: string;
  mtimeMs?: number;
  parseStatus:
    | 'ok'
    | 'missing-skill-md'
    | 'parse-error'
    | 'unreadable'
    | 'not-directory';
  effective: boolean;
  shadowedBy?: string;
  duplicateIndex: number;
  symlink?: AgentSkillInventorySymlink;
  error?: string;
}

export interface AgentSkillInventoryTarget {
  provider: AgentSkillProvider;
  home: string;
  label: string;
  roots: AgentSkillInventoryRoot[];
  skills: AgentSkillInventoryEntry[];
  summary: {
    roots: number;
    availableRoots: number;
    skills: number;
    effective: number;
    shadowed: number;
    errors: number;
  };
}

export interface AgentSkillInventory {
  schema: 'kungfu.agent-skill-inventory/v1';
  targets: AgentSkillInventoryTarget[];
  summary: {
    targets: number;
    roots: number;
    availableRoots: number;
    skills: number;
    effective: number;
    shadowed: number;
    errors: number;
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
  cwd?: string;
}

export interface SkillContextFileOptions extends SkillContextOptions {
  out?: string;
}

export interface SkillManagerViewOptions {
  extraPaths?: string[];
  env?: Record<string, string | undefined>;
  homeDir?: string;
  cwd?: string;
  agentSkillRoots?: AgentSkillInventoryRootInput[];
}

export interface SkillManagerViewFileOptions extends SkillManagerViewOptions {
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
  options: { kungfu?: KungfuEnvironment } = {},
): SkillContextEnvelope {
  const advertised = stableStringify(catalog.skills);
  const envelope: SkillContextEnvelope = {
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
  if (options.kungfu) envelope.kungfu = options.kungfu;
  return envelope;
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
    {
      kungfu: buildKungfuEnvironment(home, {
        source: options.source,
        extraPaths: options.extraPaths ?? [],
        env: options.env ?? process.env,
        cwd: options.cwd,
      }),
    },
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

export function buildSkillManagerView(
  home: string,
  options: SkillManagerViewOptions = {},
): SkillManagerView {
  const skills = discoverSkills(
    home,
    options.extraPaths ?? [],
    options.env ?? process.env,
  ).map((skill) => {
    const dependencies = buildSkillDependencyBinding(home, skill);
    return {
      key: skill.key,
      title: skill.title,
      description: skill.description,
      kind: skill.kind,
      triggers: skill.triggers,
      capabilities: skill.capabilities,
      sourceHash: skill.source.hash,
      sourcePath: skill.source.path,
      catalogEntry: toCatalogEntry(skill),
      dependencySummary: dependencies.summary,
      dependencies,
      hasUnresolvedRequiredDependencies: dependencies.dependencies.some(
        (row) => row.required && row.status === 'unresolved',
      ),
    };
  });
  const allRows = skills.flatMap((skill) => skill.dependencies.dependencies);
  return {
    schema: 'kungfu.skill-manager/v1',
    registry: {
      type: 'kfx',
      root: kfxRegistryRoot(home),
    },
    skills,
    agentInventory: buildAgentSkillInventory({
      env: options.env ?? process.env,
      homeDir: options.homeDir,
      cwd: options.cwd,
      extraRoots: options.agentSkillRoots,
    }),
    summary: {
      skills: skills.length,
      dependencies: allRows.length,
      resolved: allRows.filter((row) => row.status === 'resolved').length,
      unresolved: allRows.filter((row) => row.status === 'unresolved').length,
      unresolvedRequired: allRows.filter(
        (row) => row.required && row.status === 'unresolved',
      ).length,
      kfxKeys: uniqueSorted(allRows.map((row) => row.kfxKey)),
      unresolvedKfxKeys: uniqueSorted(
        allRows
          .filter((row) => row.status === 'unresolved')
          .map((row) => row.kfxKey),
      ),
    },
  };
}

export function writeSkillManagerViewFile(
  home: string,
  options: SkillManagerViewFileOptions = {},
): string {
  const view = buildSkillManagerView(home, options);
  const out = options.out
    ? resolve(options.out)
    : join(home, 'skill-manager', 'default.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(view, null, 2)}\n`, 'utf8');
  return out;
}

export function buildAgentSkillInventory(
  options: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
    cwd?: string;
    extraRoots?: AgentSkillInventoryRootInput[];
  } = {},
): AgentSkillInventory {
  const env = options.env ?? process.env;
  const userHome = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const rootInputs = uniqueAgentRootInputs([
    ...defaultAgentSkillRoots('codex', userHome, cwd, env),
    ...defaultAgentSkillRoots('claude', userHome, cwd, env),
    ...(options.extraRoots ?? []),
  ]);
  const targets = buildAgentInventoryTargets(rootInputs);
  const rootRows = targets.flatMap((target) => target.roots);
  const skillRows = targets.flatMap((target) => target.skills);
  return {
    schema: 'kungfu.agent-skill-inventory/v1',
    targets,
    summary: {
      targets: targets.length,
      roots: rootRows.length,
      availableRoots: rootRows.filter((root) => root.status === 'ok').length,
      skills: skillRows.length,
      effective: skillRows.filter((skill) => skill.effective).length,
      shadowed: skillRows.filter((skill) => !skill.effective).length,
      errors: skillRows.filter((skill) => skill.parseStatus !== 'ok').length,
    },
  };
}

export function hasAdvertisedSkills(envelope: SkillContextEnvelope): boolean {
  return envelope.catalog.length > 0;
}

export function hasContextEnvelopeInfo(
  envelope: SkillContextEnvelope,
): boolean {
  return hasAdvertisedSkills(envelope) || Boolean(envelope.kungfu);
}

export function formatSkillContextPrompt(
  envelope: SkillContextEnvelope,
): string {
  const lines = [
    'Kungfu Skill context envelope (compact, on-demand instructions):',
    stableStringify(envelope),
  ];
  if (envelope.kungfu) {
    lines.push(
      'You are running under Kungfu managed-run. Use the kungfu field only as the pointer to the canonical local Kungfu agent entrypoint. Discover config, docs, commands, skills, and kfx from that entrypoint when needed.',
    );
  }
  lines.push(
    'To load full SKILL.md content, ask the Kungfu host for kungfu.skill.read with a skill key.',
    'Skill instructions do not grant runtime privileges; kfx dependencies remain gated by kfx trust policy.',
  );
  return lines.join('\n');
}

export function injectSkillContext(
  prompt: string,
  envelope: SkillContextEnvelope,
): string {
  if (!hasContextEnvelopeInfo(envelope)) return prompt;
  return `${formatSkillContextPrompt(envelope)}\n\nUser task:\n${prompt}`;
}

export function buildKungfuEnvironment(
  home: string,
  options: {
    source?: SkillContextEnvelope['session']['source'];
    extraPaths?: string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): KungfuEnvironment {
  const config = resolveKungfuConfig({
    runtimeHome: home,
    env: options.env ?? process.env,
  });
  return {
    schema: 'kungfu.environment/v1',
    environment: options.source === 'test' ? 'test' : 'managed-run',
    agentEntrypoint: requiredString(
      objectValue(config.config.agent)?.entrypoint,
      'config.agent.entrypoint',
    ),
  };
}

export function defaultKungfuConfigHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const contract = loadKungfuConfigContract({ env });
  const resolution = objectValue(contract.resolution);
  return resolve(
    expandUserPath(
      env[
        requiredString(resolution?.configHomeEnv, 'resolution.configHomeEnv')
      ] ||
        requiredString(
          resolution?.defaultConfigHome,
          'resolution.defaultConfigHome',
        ),
    ),
  );
}

export function defaultKungfuRuntimeHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const contract = loadKungfuConfigContract({ env });
  const resolution = objectValue(contract.resolution);
  const runtimeHomeEnv = requiredString(
    resolution?.runtimeHomeEnv,
    'resolution.runtimeHomeEnv',
  );
  if (env[runtimeHomeEnv]) return resolve(expandUserPath(env[runtimeHomeEnv]));
  const templates = objectValue(resolution?.defaultRuntimeHome);
  const template = requiredString(
    templates?.[platform()] ?? templates?.default,
    `resolution.defaultRuntimeHome.${platform()}`,
  );
  return resolve(
    expandUserPath(
      expandEnvironmentTemplate(
        template,
        env,
        requiredObject(
          resolution?.environmentFallbacks,
          'resolution.environmentFallbacks',
        ),
      ),
    ),
  );
}

export function defaultKungfuConfig(
  runtimeHome = defaultKungfuRuntimeHome(),
  options: {
    configHome?: string;
    env?: Record<string, string | undefined>;
    contractPath?: string;
  } = {},
): Record<string, unknown> {
  const env = options.env ?? process.env;
  const contract = loadKungfuConfigContract({
    env,
    contractPath: options.contractPath,
  });
  const resolution = objectValue(contract.resolution);
  const configHome = resolve(
    expandUserPath(options.configHome || defaultKungfuConfigHome(env)),
  );
  const config = expandConfigPlaceholders(
    structuredClone(objectValue(contract.defaults) ?? {}),
    {
      configHome,
      runtimeHome: resolve(expandUserPath(runtimeHome)),
    },
    requiredStringArray(resolution?.placeholders, 'resolution.placeholders'),
  ) as Record<string, unknown>;
  validateKungfuConfig(config, contract);
  return config;
}

export function resolveKungfuConfig(
  options: {
    runtimeHome?: string;
    configHome?: string;
    env?: Record<string, string | undefined>;
  } = {},
): KungfuResolvedConfig {
  const env = options.env ?? process.env;
  const contract = loadKungfuConfigContract({ env });
  const resolution = objectValue(contract.resolution);
  const runtimeHomeEnv = requiredString(
    resolution?.runtimeHomeEnv,
    'resolution.runtimeHomeEnv',
  );
  const overrideFile = requiredString(
    resolution?.userOverrideFile,
    'resolution.userOverrideFile',
  );
  const runtimeHome = resolve(
    expandUserPath(
      options.runtimeHome ||
        env[runtimeHomeEnv] ||
        defaultKungfuRuntimeHome(env),
    ),
  );
  const configHome = resolve(
    expandUserPath(options.configHome || defaultKungfuConfigHome(env)),
  );
  const configPath = join(configHome, overrideFile);
  const override = readKungfuUserConfig(configPath, contract);
  const config = expandConfigPlaceholders(
    deepMerge(defaultKungfuConfig(runtimeHome, { configHome, env }), override),
    { configHome, runtimeHome },
    requiredStringArray(resolution?.placeholders, 'resolution.placeholders'),
  ) as Record<string, unknown>;
  validateKungfuConfig(config, contract);
  const metadata = kungfuConfigContractMetadata({ env });
  return {
    schema: requiredString(
      resolution?.resolvedSchema,
      'resolution.resolvedSchema',
    ) as 'kungfu.config.resolved/v1',
    contract: metadata,
    configHome,
    configPath,
    runtimeHome,
    sources: [
      {
        type: 'contract',
        schema: metadata.schema,
        id: metadata.id,
        path: metadata.path,
        hash: metadata.hash,
      },
      {
        type: 'user',
        schema:
          stringValue(objectValue(override)?.schema) ||
          requiredString(
            resolution?.overrideSchema,
            'resolution.overrideSchema',
          ),
        path: configPath,
        exists: existsSync(configPath),
      },
    ],
    config,
  };
}

const CONFIG_CONTRACT_FILE = 'kungfu-config.contract.json';
const CONFIG_CONTRACT_ENV = 'KUNGFU_CONFIG_CONTRACT';
const SKILL_MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function resolveKungfuConfigContractPath(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const explicit = options.contractPath || env[CONFIG_CONTRACT_ENV];
  if (explicit) return resolve(expandUserPath(explicit));
  for (const start of [SKILL_MODULE_DIR, options.cwd ?? process.cwd()]) {
    for (const directory of ancestorDirs(resolve(start))) {
      for (const rel of [
        join('framework', 'config', CONFIG_CONTRACT_FILE),
        join('config', CONFIG_CONTRACT_FILE),
      ]) {
        const candidate = join(directory, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(`Kungfu config contract not found: ${CONFIG_CONTRACT_FILE}`);
}

export function loadKungfuConfigContract(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
  } = {},
): Record<string, unknown> {
  const path = resolveKungfuConfigContractPath(options);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const contract = objectValue(parsed);
  if (!contract || Array.isArray(parsed)) {
    throw new Error(`Kungfu config contract must be a JSON object: ${path}`);
  }
  if (contract.schema !== 'kungfu.config.contract/v1') {
    throw new Error(
      `Kungfu config contract schema mismatch: ${String(contract.schema)}`,
    );
  }
  validateKungfuConfigContract(contract);
  validateKungfuConfig(objectValue(contract.defaults) ?? {}, contract);
  return contract;
}

export function kungfuConfigContractMetadata(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
  } = {},
): Record<string, unknown> {
  const path = resolveKungfuConfigContractPath(options);
  const contract = loadKungfuConfigContract({ ...options, contractPath: path });
  return {
    schema: contract.schema,
    id: contract.id,
    version: contract.version,
    weldedSurface: contract.weldedSurface,
    path,
    hash: kungfuConfigContractHash(path),
  };
}

export function kungfuConfigContractHash(contractPath?: string): string {
  const path = resolveKungfuConfigContractPath({ contractPath });
  return `sha256:${createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')}`;
}

export function kungfuConfigSchema(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
  } = {},
): Record<string, unknown> {
  return structuredClone(
    objectValue(loadKungfuConfigContract(options).configSchema) ?? {},
  );
}

const SKILL_CONTRACT_FILE = 'kungfu-skill.contract.json';
const SKILL_CONTRACT_ENV = 'KUNGFU_SKILL_CONTRACT';

export function resolveKungfuSkillContractPath(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const explicit = options.contractPath || env[SKILL_CONTRACT_ENV];
  if (explicit) return resolve(expandUserPath(explicit));
  const candidates: string[] = [];
  if (env.KUNGFU_DIR) {
    candidates.push(join(env.KUNGFU_DIR, 'config', SKILL_CONTRACT_FILE));
  }
  for (const start of [SKILL_MODULE_DIR, options.cwd ?? process.cwd()]) {
    for (const directory of ancestorDirs(resolve(start))) {
      candidates.push(
        join(directory, 'framework', 'skill', SKILL_CONTRACT_FILE),
        join(directory, 'skill', SKILL_CONTRACT_FILE),
        join(directory, 'config', SKILL_CONTRACT_FILE),
        join(
          directory,
          'node_modules',
          '@kungfu-tech',
          'skill',
          SKILL_CONTRACT_FILE,
        ),
      );
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  throw new Error(`Kungfu skill contract not found: ${SKILL_CONTRACT_FILE}`);
}

export function loadKungfuSkillContract(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
  } = {},
): Record<string, unknown> {
  const path = resolveKungfuSkillContractPath(options);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const contract = objectValue(parsed);
  if (!contract || Array.isArray(parsed)) {
    throw new Error(`Kungfu skill contract must be a JSON object: ${path}`);
  }
  if (contract.schema !== 'kungfu.skill.contract/v1') {
    throw new Error(
      `Kungfu skill contract schema mismatch: ${String(contract.schema)}`,
    );
  }
  validateKungfuSkillContract(contract);
  const schemaFiles = requiredObject(contract.schemaFiles, 'schemaFiles');
  for (const name of Object.keys(schemaFiles)) {
    kungfuSkillSchema(name, { ...options, contractPath: path, contract });
  }
  return contract;
}

export function kungfuSkillContractMetadata(
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
  } = {},
): Record<string, unknown> {
  const path = resolveKungfuSkillContractPath(options);
  const contract = loadKungfuSkillContract({ ...options, contractPath: path });
  return {
    schema: contract.schema,
    id: contract.id,
    version: contract.version,
    weldedSurface: contract.weldedSurface,
    path,
    hash: kungfuSkillContractHash(path),
  };
}

export function kungfuSkillContractHash(contractPath?: string): string {
  const path = resolveKungfuSkillContractPath({ contractPath });
  return `sha256:${createHash('sha256')
    .update(readFileSync(path))
    .digest('hex')}`;
}

export function kungfuSkillSchema(
  name = 'source',
  options: {
    env?: Record<string, string | undefined>;
    contractPath?: string;
    cwd?: string;
    contract?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const contractPath = resolveKungfuSkillContractPath(options);
  const contract =
    options.contract ?? loadKungfuSkillContract({ ...options, contractPath });
  const row = objectValue(
    requiredObject(contract.schemaFiles, 'schemaFiles')[name],
  );
  if (!row) throw new Error(`Kungfu skill schema is not registered: ${name}`);
  const source = requiredString(row.source, `schemaFiles.${name}.source`);
  const artifact = requiredString(row.artifact, `schemaFiles.${name}.artifact`);
  const expected = requiredString(row.schema, `schemaFiles.${name}.schema`);
  const base = dirname(contractPath);
  const candidates = [join(base, source), join(base, artifact)];
  const schemaPath = candidates.find((candidate) => existsSync(candidate));
  if (!schemaPath) {
    throw new Error(`Kungfu skill schema not found: ${source} or ${artifact}`);
  }
  const schema = objectValue(JSON.parse(readFileSync(schemaPath, 'utf8')));
  if (!schema) {
    throw new Error(`Kungfu skill schema must be a JSON object: ${schemaPath}`);
  }
  if (schema.$id !== expected) {
    throw new Error(
      `Kungfu skill schema mismatch for ${name}: ${String(schema.$id)}`,
    );
  }
  return structuredClone(schema);
}

function defaultAgentSkillRoots(
  provider: AgentSkillProvider,
  userHome: string,
  cwd: string,
  env: Record<string, string | undefined>,
): AgentSkillInventoryRootInput[] {
  const roots: AgentSkillInventoryRootInput[] = [];
  const upper = provider.toUpperCase();
  const explicitHome = env[`${upper}_HOME`];
  const defaultHome = join(userHome, `.${provider}`);
  for (const home of uniqueSorted(
    [explicitHome, defaultHome].filter(isString),
  )) {
    roots.push({
      provider,
      home,
      rootType: 'user-home',
      path: join(home, 'skills'),
      priority: 20,
    });
    roots.push({
      provider,
      home,
      rootType: 'system',
      path: join(home, 'skills', '.system'),
      priority: 10,
    });
  }
  for (const root of splitEnvPath(env[`KF_${upper}_SKILL_PATH`])) {
    roots.push({
      provider,
      home: dirname(root),
      rootType: 'configured',
      path: root,
      priority: 5,
    });
  }
  roots.push(...identityPoolSkillRoots(provider, userHome));
  roots.push(...repoLocalSkillRoots(provider, cwd, userHome));
  return roots;
}

function identityPoolSkillRoots(
  provider: AgentSkillProvider,
  userHome: string,
): AgentSkillInventoryRootInput[] {
  const root = join(userHome, '.local', 'share', 'atlas-agent', 'people');
  const rows: AgentSkillInventoryRootInput[] = [];
  for (const person of safeDirNames(root)) {
    const providerRoot = join(root, person, 'identity-pool', provider);
    for (const slot of safeDirNames(providerRoot)) {
      const home = join(providerRoot, slot);
      rows.push({
        provider,
        home,
        rootType: 'identity-pool',
        path: join(home, 'skills'),
        priority: 30,
      });
      rows.push({
        provider,
        home,
        rootType: 'system',
        path: join(home, 'skills', '.system'),
        priority: 10,
      });
    }
  }
  return rows;
}

function repoLocalSkillRoots(
  provider: AgentSkillProvider,
  cwd: string,
  userHome: string,
): AgentSkillInventoryRootInput[] {
  const rows: AgentSkillInventoryRootInput[] = [];
  for (const dir of ancestorDirs(cwd)) {
    if (resolve(dir) === resolve(userHome)) break;
    const agentsRoot = join(dir, '.agents', 'skills');
    if (existsSync(agentsRoot)) {
      rows.push({
        provider,
        home: dir,
        rootType: 'repo-local',
        path: agentsRoot,
        priority: 40,
      });
    }
    const providerRoot = join(dir, `.${provider}`, 'skills');
    if (existsSync(providerRoot)) {
      rows.push({
        provider,
        home: dir,
        rootType: 'repo-local',
        path: providerRoot,
        priority: 40,
      });
    }
  }
  return rows;
}

function buildAgentInventoryTargets(
  inputs: AgentSkillInventoryRootInput[],
): AgentSkillInventoryTarget[] {
  const byTarget = new Map<string, AgentSkillInventoryRootInput[]>();
  for (const input of inputs) {
    const key = `${input.provider}\0${resolve(input.home)}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), input]);
  }
  return [...byTarget.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, targetInputs]) => buildAgentInventoryTarget(targetInputs));
}

function buildAgentInventoryTarget(
  inputs: AgentSkillInventoryRootInput[],
): AgentSkillInventoryTarget {
  const provider = inputs[0]?.provider ?? 'codex';
  const home = resolve(inputs[0]?.home ?? '');
  const roots = inputs
    .map(inspectAgentSkillRoot)
    .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  const discovered = roots.flatMap((root) =>
    inspectAgentSkillRootEntries(root),
  );
  const skills = markEffectiveAgentSkills(discovered);
  return {
    provider,
    home,
    label: `${provider}:${home}`,
    roots,
    skills,
    summary: {
      roots: roots.length,
      availableRoots: roots.filter((root) => root.status === 'ok').length,
      skills: skills.length,
      effective: skills.filter((skill) => skill.effective).length,
      shadowed: skills.filter((skill) => !skill.effective).length,
      errors: skills.filter((skill) => skill.parseStatus !== 'ok').length,
    },
  };
}

function inspectAgentSkillRoot(
  input: AgentSkillInventoryRootInput,
): AgentSkillInventoryRoot {
  const path = resolve(input.path);
  const root: AgentSkillInventoryRoot = {
    provider: input.provider,
    home: resolve(input.home),
    rootType: input.rootType,
    path,
    priority: input.priority ?? 50,
    exists: false,
    status: 'missing',
  };
  try {
    const meta = inspectSymlink(path);
    if (meta) root.symlink = meta;
    if (!existsSync(path)) return root;
    root.exists = true;
    if (!statSync(path).isDirectory()) {
      root.status = 'not-directory';
      return root;
    }
    root.status = 'ok';
    return root;
  } catch (e) {
    root.status = 'unreadable';
    root.error = (e as Error).message;
    return root;
  }
}

function inspectAgentSkillRootEntries(
  root: AgentSkillInventoryRoot,
): AgentSkillInventoryEntry[] {
  if (root.status !== 'ok') return [];
  return agentSkillCandidateDirs(root.path).map((skillDir) =>
    inspectAgentSkillDir(root, skillDir),
  );
}

function inspectAgentSkillDir(
  root: AgentSkillInventoryRoot,
  skillDir: string,
): AgentSkillInventoryEntry {
  const path = resolve(skillDir);
  const base: AgentSkillInventoryEntry = {
    key: normalizeKey(basename(path)),
    title: basename(path),
    description: '',
    provider: root.provider,
    home: root.home,
    rootPath: root.path,
    rootType: root.rootType,
    priority: root.priority,
    path,
    parseStatus: 'ok',
    effective: false,
    duplicateIndex: 0,
  };
  try {
    const symlink = inspectSymlink(path);
    if (symlink) base.symlink = symlink;
    if (!existsSync(path)) {
      return {
        ...base,
        parseStatus: 'unreadable',
        error: 'path does not exist',
      };
    }
    if (!statSync(path).isDirectory()) {
      return { ...base, parseStatus: 'not-directory' };
    }
    const skillPath = join(path, 'SKILL.md');
    if (!existsSync(skillPath)) {
      return { ...base, parseStatus: 'missing-skill-md' };
    }
    const markdown = readFileSync(skillPath, 'utf8');
    const { frontmatter, body } = splitFrontmatter(markdown);
    const title =
      stringValue(frontmatter.title) || firstHeading(body) || basename(path);
    const description =
      stringValue(frontmatter.description) || firstParagraph(body) || '';
    const key = stringValue(frontmatter.key) || normalizeKey(basename(path));
    const stat = statSync(skillPath);
    return {
      ...base,
      key,
      title,
      description,
      hash: `sha256:${createHash('sha256').update(markdown).digest('hex')}`,
      mtimeMs: stat.mtimeMs,
      path: skillPath,
      parseStatus: 'ok',
    };
  } catch (e) {
    return {
      ...base,
      parseStatus: 'parse-error',
      error: (e as Error).message,
    };
  }
}

function markEffectiveAgentSkills(
  rows: AgentSkillInventoryEntry[],
): AgentSkillInventoryEntry[] {
  const counts = new Map<string, number>();
  const effectiveByKey = new Map<string, AgentSkillInventoryEntry>();
  return rows
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.rootPath.localeCompare(b.rootPath) ||
        a.path.localeCompare(b.path),
    )
    .map((row) => {
      const duplicateIndex = counts.get(row.key) ?? 0;
      counts.set(row.key, duplicateIndex + 1);
      const effective =
        row.parseStatus === 'ok' && !effectiveByKey.has(row.key);
      const shadowedBy = effectiveByKey.get(row.key)?.path;
      const next: AgentSkillInventoryEntry = {
        ...row,
        duplicateIndex,
        effective,
      };
      if (!effective && shadowedBy) next.shadowedBy = shadowedBy;
      if (effective) effectiveByKey.set(row.key, next);
      return next;
    });
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

function agentSkillCandidateDirs(root: string): string[] {
  if (!root || !existsSync(root)) return [];
  const absolute = resolve(root);
  if (existsSync(join(absolute, 'SKILL.md'))) return [absolute];
  try {
    if (!statSync(absolute).isDirectory()) return [absolute];
  } catch {
    return [absolute];
  }
  try {
    return readdirSync(absolute)
      .sort()
      .map((name) => join(absolute, name))
      .filter((path) => {
        if (basename(path).startsWith('.')) return false;
        try {
          const stat = statSync(path);
          return stat.isDirectory() || lstatSync(path).isSymbolicLink();
        } catch {
          return true;
        }
      });
  } catch {
    return [absolute];
  }
}

function uniqueAgentRootInputs(
  roots: AgentSkillInventoryRootInput[],
): AgentSkillInventoryRootInput[] {
  const byPath = new Map<string, AgentSkillInventoryRootInput>();
  for (const root of roots) {
    const key = [root.provider, resolve(root.home), resolve(root.path)].join(
      '\0',
    );
    const current = byPath.get(key);
    if (!current || (root.priority ?? 50) < (current.priority ?? 50)) {
      byPath.set(key, root);
    }
  }
  return [...byPath.values()];
}

function splitEnvPath(value: string | undefined): string[] {
  return value ? value.split(pathDelimiter()).filter(Boolean) : [];
}

function safeDirNames(path: string): string[] {
  try {
    return readdirSync(path)
      .sort()
      .filter((name) => {
        try {
          return statSync(join(path, name)).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function ancestorDirs(start: string): string[] {
  const rows: string[] = [];
  let current = resolve(start);
  for (;;) {
    rows.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return rows;
}

function inspectSymlink(path: string): AgentSkillInventorySymlink | undefined {
  let linkStat: ReturnType<typeof lstatSync>;
  try {
    linkStat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!linkStat.isSymbolicLink()) return undefined;
  const row: AgentSkillInventorySymlink = {
    isSymlink: true,
    target: readlinkSync(path),
  };
  try {
    row.realPath = realpathSync(path);
    row.broken = false;
  } catch {
    row.broken = true;
  }
  return row;
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

function requiredObject(value: unknown, path: string): Record<string, unknown> {
  const object = objectValue(value);
  if (!object || Array.isArray(value)) {
    throw new Error(`Kungfu config contract missing object: ${path}`);
  }
  return object;
}

function requiredString(value: unknown, path: string): string {
  const string = stringValue(value);
  if (!string)
    throw new Error(`Kungfu config contract missing string: ${path}`);
  return string;
}

function requiredStringArray(value: unknown, path: string): string[] {
  const strings = stringArrayValue(value);
  if (!strings) {
    throw new Error(`Kungfu config contract missing string array: ${path}`);
  }
  return strings;
}

function readKungfuUserConfig(
  configPath: string,
  contract: Record<string, unknown>,
): Record<string, unknown> {
  const resolution = objectValue(contract.resolution);
  if (!existsSync(configPath)) {
    return {
      schema: requiredString(
        resolution?.overrideSchema,
        'resolution.overrideSchema',
      ),
    };
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  if (!objectValue(parsed) || Array.isArray(parsed)) {
    throw new Error(
      `Kungfu config override must be a JSON object: ${configPath}`,
    );
  }
  validateKungfuConfig(parsed as Record<string, unknown>, contract, true);
  return parsed as Record<string, unknown>;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (key === 'schema') continue;
    const existing = result[key];
    if (objectValue(existing) && objectValue(value)) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function expandConfigPlaceholders(
  value: unknown,
  replacements: Record<string, string>,
  placeholders: string[],
): unknown {
  if (typeof value === 'string') {
    let expanded = value;
    for (const key of placeholders) {
      expanded = expanded.replaceAll(`\${${key}}`, replacements[key]);
    }
    return expandUserPath(expanded);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      expandConfigPlaceholders(item, replacements, placeholders),
    );
  }
  if (objectValue(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandConfigPlaceholders(item, replacements, placeholders),
      ]),
    );
  }
  return value;
}

function validateKungfuConfig(
  config: Record<string, unknown>,
  contract: Record<string, unknown>,
  partial = false,
): void {
  const schema = partial
    ? partialJsonSchema(objectValue(contract.configSchema) ?? {})
    : (objectValue(contract.configSchema) ?? {});
  const AjvCtor = Ajv as unknown as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => {
    compile: (schema: unknown) => {
      (value: unknown): boolean;
      errors?: Array<{ instancePath?: string; message?: string }>;
    };
  };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(config)) return;
  const first = validate.errors?.[0];
  const path = first?.instancePath || '<root>';
  throw new Error(
    `Kungfu config validation failed at ${path}: ${first?.message || 'invalid config'}`,
  );
}

function validateKungfuConfigContract(contract: Record<string, unknown>): void {
  const schema = requiredObject(contract.contractSchema, 'contractSchema');
  const AjvCtor = Ajv as unknown as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => {
    compile: (schema: unknown) => {
      (value: unknown): boolean;
      errors?: Array<{ instancePath?: string; message?: string }>;
    };
  };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(contract)) return;
  const first = validate.errors?.[0];
  const path = first?.instancePath || '<root>';
  throw new Error(
    `Kungfu config contract validation failed at ${path}: ${first?.message || 'invalid contract'}`,
  );
}

function validateKungfuSkillContract(contract: Record<string, unknown>): void {
  const schema = requiredObject(contract.contractSchema, 'contractSchema');
  const AjvCtor = Ajv as unknown as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => {
    compile: (schema: unknown) => {
      (value: unknown): boolean;
      errors?: Array<{ instancePath?: string; message?: string }>;
    };
  };
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(contract)) return;
  const first = validate.errors?.[0];
  const path = first?.instancePath || '<root>';
  throw new Error(
    `Kungfu skill contract validation failed at ${path}: ${first?.message || 'invalid contract'}`,
  );
}

function partialJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema))
    return schema.map((item) => partialJsonSchema(item));
  if (!objectValue(schema)) return schema;
  const { required: _required, ...result } = structuredClone(
    schema as Record<string, unknown>,
  );
  const properties = objectValue(result.properties);
  if (properties) {
    result.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        partialJsonSchema(value),
      ]),
    );
  }
  if ('items' in result) result.items = partialJsonSchema(result.items);
  return result;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === 'string')) return undefined;
  return value as string[];
}

function expandUserPath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function expandEnvironmentTemplate(
  value: string,
  env: Record<string, string | undefined>,
  fallbacks: Record<string, unknown>,
): string {
  let expanded = value;
  for (let i = 0; i < 4; i += 1) {
    let changed = false;
    for (const key of Object.keys(fallbacks).sort()) {
      const token = `\${${key}}`;
      if (!expanded.includes(token)) continue;
      expanded = expanded.replaceAll(
        token,
        env[key] ||
          requiredString(
            fallbacks[key],
            `resolution.environmentFallbacks.${key}`,
          ),
      );
      changed = true;
    }
    if (!changed) break;
  }
  return expanded;
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
