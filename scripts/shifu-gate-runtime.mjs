// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GATE_REGISTRY_SCHEMA =
  'https://libkungfu.dev/schemas/shifu/gate-registry-v1.schema.json';
export const GATE_PLAN_SCHEMA =
  'https://libkungfu.dev/schemas/shifu/gate-plan-v1.schema.json';
export const GATE_RECEIPT_SCHEMA =
  'https://libkungfu.dev/schemas/shifu/gate-receipt-v1.schema.json';

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MODES = new Set(['required', 'advisory', 'off']);
/** @type {Record<string, number>} */
const MODE_RANK = { off: 0, advisory: 1, required: 2 };
/** @type {Record<string, string[]>} */
const ACTION_KEYS = {
  task: ['kind', 'task', 'args'],
  argv: ['kind', 'command', 'args'],
  handler: ['kind', 'handler', 'parameters'],
};

/** @typedef {{code:string, path:string, message:string}} GateIssue */
/** @typedef {{mode:string, reason:string}} GateDecision */
/** @typedef {{id:string, title:string, decisions:Record<string, GateDecision>}} GateProfile */
/** @typedef {{id:string, title:string, summary:string, category:string, documentation:string, dependencies:string[], platforms:string[], runner:{capabilities:string[]}, cost:{class:string, timeoutSeconds:number}, action:any, artifacts:any[], receipt:any}} Gate */
/** @typedef {{$schema:string, schema:string, project:{id:string, title:string}, gates:Gate[], profiles:GateProfile[]}} GateRegistry */
/** @typedef {{ref:string, digest:string, registry:GateRegistry, issues:GateIssue[]}} LoadedGateRegistry */

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {string} */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** @param {unknown} value */
export function gateDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

/** @param {Gate} gate */
export function gateDefinitionDigest(gate) {
  return gateDigest(gate);
}

/** @param {Gate} gate */
export function gateActionId(gate) {
  return gateDigest({ gateId: gate.id, action: gate.action });
}

/** @param {GateIssue[]} issues @param {string} code @param {string} at @param {string} message */
function issue(issues, code, at, message) {
  issues.push({ code, path: at, message });
}

/** @param {GateIssue[]} issues @param {unknown} value @param {string} at @param {string[]} required @param {string[]} [optional] */
function exactKeys(issues, value, at, required, optional = []) {
  if (!object(value)) {
    issue(issues, 'type', at, 'must be an object');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value))
      issue(issues, 'required', `${at}/${key}`, 'is required');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      issue(issues, 'unknown-field', `${at}/${key}`, 'is not allowed by v1');
  }
  return true;
}

/** @param {GateIssue[]} issues @param {unknown} value @param {string} at @param {{id?:boolean}} [options] */
function stringField(issues, value, at, { id = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    issue(issues, 'type', at, 'must be a non-empty string');
    return false;
  }
  if (id && !ID.test(value)) {
    issue(issues, 'id', at, 'must be a lowercase stable identifier');
    return false;
  }
  return true;
}

/** @param {GateIssue[]} issues @param {unknown} value @param {string} at @param {{ids?:boolean, nonempty?:boolean}} [options] @returns {string[]} */
function stringArray(
  issues,
  value,
  at,
  { ids = false, nonempty = false } = {},
) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    issue(
      issues,
      'type',
      at,
      `must be ${nonempty ? 'a non-empty' : 'an'} array`,
    );
    return [];
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!stringField(issues, item, `${at}/${index}`, { id: ids })) continue;
    if (seen.has(item))
      issue(issues, 'duplicate', `${at}/${index}`, `duplicates ${item}`);
    seen.add(item);
  }
  return value.filter((item) => typeof item === 'string');
}

/** @param {GateIssue[]} issues @param {unknown} action @param {string} at */
function validateAction(issues, action, at) {
  if (!object(action)) {
    issue(issues, 'type', at, 'must be a structured action object');
    return;
  }
  const kind = typeof action.kind === 'string' ? action.kind : '';
  if (!Object.hasOwn(ACTION_KEYS, kind)) {
    issue(
      issues,
      'action-kind',
      `${at}/kind`,
      'must be task, argv, or handler',
    );
    return;
  }
  const required =
    kind === 'task'
      ? ['kind', 'task']
      : kind === 'argv'
        ? ['kind', 'command']
        : ['kind', 'handler'];
  exactKeys(
    issues,
    action,
    at,
    required,
    ACTION_KEYS[kind].filter((key) => !required.includes(key)),
  );
  if (kind === 'task') stringField(issues, action.task, `${at}/task`);
  if (kind === 'argv') stringField(issues, action.command, `${at}/command`);
  if (kind === 'handler') stringField(issues, action.handler, `${at}/handler`);
  if ('args' in action) stringArray(issues, action.args, `${at}/args`);
  if ('parameters' in action && !object(action.parameters))
    issue(issues, 'type', `${at}/parameters`, 'must be an object');
}

/** @param {GateIssue[]} issues @param {any} gate @param {string} at */
function validateGate(issues, gate, at) {
  const required = [
    'id',
    'title',
    'summary',
    'category',
    'documentation',
    'dependencies',
    'platforms',
    'runner',
    'cost',
    'action',
    'artifacts',
    'receipt',
  ];
  if (!exactKeys(issues, gate, at, required)) return;
  stringField(issues, gate.id, `${at}/id`, { id: true });
  stringField(issues, gate.title, `${at}/title`);
  stringField(issues, gate.summary, `${at}/summary`);
  stringField(issues, gate.category, `${at}/category`, { id: true });
  if (stringField(issues, gate.documentation, `${at}/documentation`)) {
    const doc = gate.documentation;
    if (
      path.posix.isAbsolute(doc) ||
      path.win32.isAbsolute(doc) ||
      /^[a-z][a-z0-9+.-]*:/i.test(doc) ||
      doc.split(/[\\/]/).includes('..') ||
      !doc.toLowerCase().endsWith('.md')
    )
      issue(
        issues,
        'documentation',
        `${at}/documentation`,
        'must be a repository-relative Markdown path without traversal',
      );
  }
  stringArray(issues, gate.dependencies, `${at}/dependencies`, { ids: true });
  stringArray(issues, gate.platforms, `${at}/platforms`, {
    ids: true,
    nonempty: true,
  });
  if (exactKeys(issues, gate.runner, `${at}/runner`, ['capabilities']))
    stringArray(issues, gate.runner.capabilities, `${at}/runner/capabilities`, {
      ids: true,
    });
  if (exactKeys(issues, gate.cost, `${at}/cost`, ['class', 'timeoutSeconds'])) {
    if (!['light', 'heavy'].includes(gate.cost.class))
      issue(issues, 'enum', `${at}/cost/class`, 'must be light or heavy');
    if (
      !Number.isInteger(gate.cost.timeoutSeconds) ||
      gate.cost.timeoutSeconds < 1
    )
      issue(
        issues,
        'range',
        `${at}/cost/timeoutSeconds`,
        'must be an integer >= 1',
      );
  }
  validateAction(issues, gate.action, `${at}/action`);
  if (!Array.isArray(gate.artifacts)) {
    issue(issues, 'type', `${at}/artifacts`, 'must be an array');
  } else {
    const artifactIds = new Set();
    gate.artifacts.forEach(
      (/** @type {any} */ artifact, /** @type {number} */ index) => {
        const itemAt = `${at}/artifacts/${index}`;
        if (!exactKeys(issues, artifact, itemAt, ['id', 'path', 'required']))
          return;
        stringField(issues, artifact.id, `${itemAt}/id`, { id: true });
        if (stringField(issues, artifact.path, `${itemAt}/path`)) {
          const artifactPath = artifact.path;
          if (
            path.posix.isAbsolute(artifactPath) ||
            path.win32.isAbsolute(artifactPath) ||
            /^[a-z][a-z0-9+.-]*:/i.test(artifactPath) ||
            artifactPath.split(/[\\/]/).includes('..')
          )
            issue(
              issues,
              'artifact-path',
              `${itemAt}/path`,
              'must be a repository-relative path without traversal',
            );
        }
        if (typeof artifact.required !== 'boolean')
          issue(issues, 'type', `${itemAt}/required`, 'must be boolean');
        if (artifactIds.has(artifact.id))
          issue(
            issues,
            'duplicate',
            `${itemAt}/id`,
            `duplicates ${artifact.id}`,
          );
        artifactIds.add(artifact.id);
      },
    );
  }
  if (
    exactKeys(
      issues,
      gate.receipt,
      `${at}/receipt`,
      ['expectation'],
      ['schema'],
    )
  ) {
    if (!['none', 'optional', 'required'].includes(gate.receipt.expectation))
      issue(
        issues,
        'enum',
        `${at}/receipt/expectation`,
        'must be none, optional, or required',
      );
    if ('schema' in gate.receipt)
      stringField(issues, gate.receipt.schema, `${at}/receipt/schema`);
    if (gate.receipt.expectation === 'required' && !gate.receipt.schema)
      issue(
        issues,
        'receipt-schema',
        `${at}/receipt/schema`,
        'is required for a required receipt',
      );
  }
}

/** @param {GateIssue[]} issues @param {any} profile @param {string} at */
function validateProfile(issues, profile, at) {
  if (!exactKeys(issues, profile, at, ['id', 'title', 'decisions'])) return;
  stringField(issues, profile.id, `${at}/id`, { id: true });
  stringField(issues, profile.title, `${at}/title`);
  if (!object(profile.decisions)) {
    issue(issues, 'type', `${at}/decisions`, 'must be an object');
    return;
  }
  for (const [gateId, decision] of Object.entries(profile.decisions)) {
    if (!ID.test(gateId))
      issue(
        issues,
        'id',
        `${at}/decisions/${gateId}`,
        'has an invalid gate id',
      );
    const decisionAt = `${at}/decisions/${gateId}`;
    if (!exactKeys(issues, decision, decisionAt, ['mode', 'reason'])) continue;
    if (!MODES.has(decision.mode))
      issue(
        issues,
        'enum',
        `${decisionAt}/mode`,
        'must be required, advisory, or off',
      );
    stringField(issues, decision.reason, `${decisionAt}/reason`);
  }
}

/** @param {Gate[]} gates @returns {string[][]} */
function findCycles(gates) {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  /** @type {Map<string, number>} */
  const state = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @type {string[][]} */
  const cycles = [];
  /** @param {string} id */
  function visit(id) {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependencies || []) {
      if (byId.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, 2);
  }
  for (const id of [...byId.keys()].sort()) visit(id);
  return cycles;
}

/** @param {any} registry @returns {GateIssue[]} */
export function validateGateRegistry(registry) {
  /** @type {GateIssue[]} */
  const issues = [];
  if (
    !exactKeys(issues, registry, '', [
      '$schema',
      'schema',
      'project',
      'gates',
      'profiles',
    ])
  )
    return issues;
  if (registry.$schema !== GATE_REGISTRY_SCHEMA)
    issue(issues, 'schema-id', '/$schema', `must be ${GATE_REGISTRY_SCHEMA}`);
  if (registry.schema !== 'shifu.gate-registry/v1')
    issue(
      issues,
      'schema-version',
      '/schema',
      'must be shifu.gate-registry/v1',
    );
  if (exactKeys(issues, registry.project, '/project', ['id', 'title'])) {
    stringField(issues, registry.project.id, '/project/id', { id: true });
    stringField(issues, registry.project.title, '/project/title');
  }
  if (!Array.isArray(registry.gates) || registry.gates.length === 0)
    issue(issues, 'type', '/gates', 'must be a non-empty array');
  else
    registry.gates.forEach(
      (/** @type {any} */ gate, /** @type {number} */ index) =>
        validateGate(issues, gate, `/gates/${index}`),
    );
  if (!Array.isArray(registry.profiles) || registry.profiles.length === 0)
    issue(issues, 'type', '/profiles', 'must be a non-empty array');
  else
    registry.profiles.forEach(
      (/** @type {any} */ profile, /** @type {number} */ index) =>
        validateProfile(issues, profile, `/profiles/${index}`),
    );

  const gates = /** @type {Gate[]} */ (
    Array.isArray(registry.gates) ? registry.gates.filter(object) : []
  );
  const profiles = /** @type {GateProfile[]} */ (
    Array.isArray(registry.profiles) ? registry.profiles.filter(object) : []
  );
  /** @type {Set<string>} */
  const gateIds = new Set();
  for (let index = 0; index < gates.length; index += 1) {
    const gate = gates[index];
    if (gateIds.has(gate.id))
      issue(
        issues,
        'duplicate-gate',
        `/gates/${index}/id`,
        `duplicates gate ${gate.id}`,
      );
    gateIds.add(gate.id);
  }
  /** @type {Set<string>} */
  const profileIds = new Set();
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (profileIds.has(profile.id))
      issue(
        issues,
        'duplicate-profile',
        `/profiles/${index}/id`,
        `duplicates profile ${profile.id}`,
      );
    profileIds.add(profile.id);
  }
  gates.forEach((gate, gateIndex) => {
    if (!Array.isArray(gate.dependencies)) return;
    gate.dependencies.forEach((dependency, dependencyIndex) => {
      if (!gateIds.has(dependency))
        issue(
          issues,
          'unknown-dependency',
          `/gates/${gateIndex}/dependencies/${dependencyIndex}`,
          `unknown gate ${dependency}`,
        );
      if (dependency === gate.id)
        issue(
          issues,
          'dependency-cycle',
          `/gates/${gateIndex}/dependencies/${dependencyIndex}`,
          'a gate cannot depend on itself',
        );
    });
  });
  for (const cycle of findCycles(gates))
    issue(issues, 'dependency-cycle', '/gates', cycle.join(' -> '));

  profiles.forEach((profile, profileIndex) => {
    if (!object(profile.decisions)) return;
    const decisions = profile.decisions;
    for (const gateId of [...gateIds].sort()) {
      if (!(gateId in decisions))
        issue(
          issues,
          'profile-gap',
          `/profiles/${profileIndex}/decisions/${gateId}`,
          `profile ${profile.id} must explicitly decide every gate`,
        );
    }
    for (const gateId of Object.keys(decisions)) {
      if (!gateIds.has(gateId))
        issue(
          issues,
          'unknown-gate',
          `/profiles/${profileIndex}/decisions/${gateId}`,
          `profile ${profile.id} references an unknown gate`,
        );
    }
    for (const gate of gates) {
      const decision = decisions[gate.id];
      if (!decision || !MODES.has(decision.mode)) continue;
      for (const dependency of gate.dependencies || []) {
        const dependencyDecision = decisions[dependency];
        if (
          dependencyDecision &&
          MODES.has(dependencyDecision.mode) &&
          MODE_RANK[dependencyDecision.mode] < MODE_RANK[decision.mode]
        )
          issue(
            issues,
            'profile-dependency-mode',
            `/profiles/${profileIndex}/decisions/${dependency}/mode`,
            `${dependency} cannot be weaker than dependent gate ${gate.id}`,
          );
      }
    }
  });
  return issues;
}

/** @param {string|Buffer|Uint8Array} raw */
export function validateGateRegistryBytes(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  try {
    const registry = JSON.parse(bytes.toString('utf8'));
    return { registry, digest, issues: validateGateRegistry(registry) };
  } catch (error) {
    return {
      registry: null,
      digest,
      issues: [
        {
          code: 'json-parse',
          path: '',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/** @param {string} root @param {string} [explicit] */
export function resolveGateRegistryRef(root, explicit = '') {
  return explicit || process.env.SHIFU_GATE_REGISTRY || 'shifu.gates.json';
}

/** @param {string} root @param {string} [explicit] */
export function loadGateRegistry(root, explicit = '') {
  const ref = resolveGateRegistryRef(root, explicit);
  const raw =
    ref === '-' ? fs.readFileSync(0) : fs.readFileSync(path.resolve(root, ref));
  return { ref, ...validateGateRegistryBytes(raw) };
}

/** @param {GateRegistry} registry */
function gateMap(registry) {
  return new Map(registry.gates.map((gate) => [gate.id, gate]));
}

/** @param {GateRegistry} registry @param {string} profileId */
function profileById(registry, profileId) {
  const profile = registry.profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown gate profile: ${profileId}`);
  return profile;
}

/** @param {Gate} gate @param {string|null} platform */
function platformSupported(gate, platform) {
  return (
    !platform ||
    gate.platforms.includes(platform) ||
    gate.platforms.includes('any')
  );
}

/**
 * @param {GateRegistry} registry
 * @param {string} profileId
 * @param {{ref?:string, digest?:string, includeAdvisory?:boolean, explicitGates?:string[], platform?:string|null}} [options]
 */
export function buildGatePlan(
  registry,
  profileId,
  {
    ref = 'shifu.gates.json',
    digest = '',
    includeAdvisory = false,
    explicitGates = [],
    platform = null,
  } = {},
) {
  const issues = validateGateRegistry(registry);
  if (issues.length)
    throw new Error(
      `gate registry is invalid: ${issues[0].path || '/'} ${issues[0].message}`,
    );
  const profile = profileById(registry, profileId);
  const byId = gateMap(registry);
  const explicit = [...new Set(explicitGates)].sort();
  for (const id of explicit)
    if (!byId.has(id)) throw new Error(`unknown gate: ${id}`);
  /** @type {Set<string>} */
  const selected = new Set();
  /** @type {Map<string, Set<string>>} */
  const selectedBy = new Map();
  /** @type {Array<{id:string, mode:string, reason:string}>} */
  const skipped = [];
  /** @type {Array<{id:string, mode:string, reason:string}>} */
  const unsupported = [];

  /** @param {string} id @param {string} reason */
  const addReason = (id, reason) => {
    if (!selectedBy.has(id)) selectedBy.set(id, new Set());
    selectedBy.get(id)?.add(reason);
  };
  /** @param {string} id @param {string} reason */
  const select = (id, reason) => {
    selected.add(id);
    addReason(id, reason);
  };

  /** @type {Array<[string, string]>} */
  const bases = explicit.length
    ? explicit.map((id) => [id, 'explicit'])
    : Object.entries(profile.decisions)
        .filter(
          ([, decision]) =>
            decision.mode === 'required' ||
            (includeAdvisory && decision.mode === 'advisory'),
        )
        .map(([id, decision]) => [id, `profile:${decision.mode}`]);

  for (const [id, reason] of bases.sort(([a], [b]) => a.localeCompare(b))) {
    const gate = byId.get(id);
    if (!gate) throw new Error(`unknown gate: ${id}`);
    const mode = profile.decisions[id].mode;
    if (
      !platformSupported(gate, platform) &&
      mode === 'advisory' &&
      reason === 'profile:advisory'
    ) {
      skipped.push({ id, mode, reason: `unsupported on ${platform}` });
      continue;
    }
    select(id, reason);
  }

  /** @param {string} id */
  const visit = (id) => {
    const gate = byId.get(id);
    if (!gate) throw new Error(`unknown gate: ${id}`);
    for (const dependency of [...gate.dependencies].sort()) {
      select(dependency, `dependency-of:${id}`);
      visit(dependency);
    }
  };
  for (const id of [...selected].sort()) visit(id);

  for (const id of [...selected].sort()) {
    const gate = byId.get(id);
    if (!gate) throw new Error(`unknown gate: ${id}`);
    if (!platformSupported(gate, platform))
      unsupported.push({
        id,
        mode: profile.decisions[id].mode,
        reason: `unsupported on ${platform}`,
      });
  }
  for (const gate of [...registry.gates].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (selected.has(gate.id) || skipped.some((item) => item.id === gate.id))
      continue;
    const mode = profile.decisions[gate.id].mode;
    skipped.push({
      id: gate.id,
      mode,
      reason:
        mode === 'advisory'
          ? 'advisory not requested'
          : `profile mode is ${mode}`,
    });
  }

  const ok = unsupported.length === 0;
  /** @type {Array<{index:number, gates:Array<Record<string, any>>}>} */
  const groups = [];
  if (ok) {
    const remaining = new Set(selected);
    let index = 0;
    while (remaining.size) {
      const ready = [...remaining]
        .filter((id) => {
          const gate = byId.get(id);
          if (!gate) throw new Error(`unknown gate: ${id}`);
          return gate.dependencies.every(
            (dependency) => !remaining.has(dependency),
          );
        })
        .sort();
      if (!ready.length)
        throw new Error('gate plan could not resolve dependency order');
      groups.push({
        index,
        gates: ready.map((id) => {
          const gate = byId.get(id);
          if (!gate) throw new Error(`unknown gate: ${id}`);
          return {
            id,
            mode: profile.decisions[id].mode,
            selectedBy: [...(selectedBy.get(id) || [])].sort(),
            dependencies: [...gate.dependencies].sort(),
            platforms: [...gate.platforms].sort(),
            runner: gate.runner,
            cost: gate.cost,
            action: gate.action,
            actionId: gateActionId(gate),
            definitionDigest: gateDefinitionDigest(gate),
            artifacts: gate.artifacts,
            receipt: gate.receipt,
          };
        }),
      });
      for (const id of ready) remaining.delete(id);
      index += 1;
    }
  }
  return {
    $schema: GATE_PLAN_SCHEMA,
    schema: 'shifu.gate-plan/v1',
    registry: {
      ref,
      digest,
      projectId: registry.project.id,
    },
    profile: profile.id,
    platform,
    includeAdvisory,
    explicitGates: explicit,
    ok,
    qualifying: ok && explicit.length === 0,
    groups,
    skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
    unsupported: unsupported.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
