// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GATE_RECEIPT_SCHEMA,
  buildGatePlan,
  gateActionId,
  gateDefinitionDigest,
  gateDigest,
  validateGateRegistry,
} from './shifu-gate-runtime.mjs';

const RESULT_STATUSES = new Set([
  'pass',
  'fail',
  'advisory-fail',
  'unsupported',
  'skip',
  'error',
]);
const GATE_ACTION_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/** @typedef {{write:(chunk:any)=>any}} Writer */
/** @typedef {{id:string, ref:string, digest?:string}} EvidencePointer */
/** @typedef {{id:string, title:string, summary:string, category:string, documentation:string, dependencies:string[], platforms:string[], runner:{capabilities:string[]}, cost:{class:string,timeoutSeconds:number}, action:any, artifacts:any[], receipt:{expectation:string,schema?:string}}} Gate */
/** @typedef {{code:string, path:string, message:string}} GateIssue */

/** @param {NodeJS.Platform|string} platform */
export function normalizeGatePlatform(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return String(platform);
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** @param {string} root */
export function readGateSourceIdentity(root) {
  const sha = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!sha) return { sha: null, dirty: true };
  return {
    sha,
    dirty:
      git(root, ['status', '--porcelain', '--untracked-files=normal']) !== '',
  };
}

/** @param {any} registry @returns {Map<string, Gate>} */
function gateMap(registry) {
  return new Map(
    registry.gates.map((/** @type {Gate} */ gate) => [gate.id, gate]),
  );
}

/** @param {Map<string, Gate>} byId @param {string} id @returns {Gate} */
function requireGate(byId, id) {
  const gate = byId.get(id);
  if (!gate) throw new Error(`unknown gate: ${id}`);
  return gate;
}

/**
 * @param {any} registry
 * @param {string[]} explicitGates
 * @param {string} platform
 */
function buildExplicitPlan(registry, explicitGates, platform) {
  const byId = gateMap(registry);
  const explicit = [...new Set(explicitGates)].sort();
  const selected = new Set();
  /** @type {Map<string, Set<string>>} */
  const selectedBy = new Map();
  const unsupported = [];
  /** @param {string} id @param {string} reason */
  const select = (id, reason) => {
    if (!byId.has(id)) throw new Error(`unknown gate: ${id}`);
    selected.add(id);
    if (!selectedBy.has(id)) selectedBy.set(id, new Set());
    selectedBy.get(id)?.add(reason);
  };
  /** @param {string} id */
  const visit = (id) => {
    const gate = requireGate(byId, id);
    for (const dependency of [...gate.dependencies].sort()) {
      select(dependency, `dependency-of:${id}`);
      visit(dependency);
    }
  };
  for (const id of explicit) select(id, 'explicit');
  for (const id of explicit) visit(id);
  for (const id of [...selected].sort()) {
    const gate = requireGate(byId, id);
    if (!gate.platforms.includes('any') && !gate.platforms.includes(platform))
      unsupported.push({
        id,
        mode: null,
        reason: `unsupported on ${platform}`,
      });
  }
  const groups = [];
  if (!unsupported.length) {
    const remaining = new Set(selected);
    let index = 0;
    while (remaining.size) {
      const ready = [...remaining]
        .filter((id) =>
          requireGate(byId, id).dependencies.every(
            (/** @type {string} */ dependency) => !remaining.has(dependency),
          ),
        )
        .sort();
      if (!ready.length)
        throw new Error('gate run could not resolve dependency order');
      groups.push({
        index,
        gates: ready.map((id) => {
          const gate = requireGate(byId, id);
          return {
            id,
            mode: null,
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
    schema: 'shifu.gate-run-plan/v1',
    profile: null,
    platform,
    includeAdvisory: false,
    explicitGates: explicit,
    ok: unsupported.length === 0,
    qualifying: false,
    groups,
    skipped: [],
    unsupported,
  };
}

/**
 * @param {any} registry
 * @param {{registryRef:string, registryDigest:string, profile?:string, explicitGates?:string[], includeAdvisory?:boolean, platform?:string}} options
 */
export function buildGateRunPlan(registry, options) {
  const issues = validateGateRegistry(registry);
  if (issues.length)
    throw new Error(
      `gate registry is invalid: ${issues[0].path || '/'} ${issues[0].message}`,
    );
  const platform = normalizeGatePlatform(options.platform);
  const profile = options.profile || '';
  const explicitGates = options.explicitGates || [];
  if (Boolean(profile) === Boolean(explicitGates.length))
    throw new Error(
      'gate run requires either --profile PROFILE or one or more GATE ids',
    );
  const plan = profile
    ? buildGatePlan(registry, profile, {
        ref: options.registryRef,
        digest: options.registryDigest,
        includeAdvisory: options.includeAdvisory || false,
        platform,
      })
    : buildExplicitPlan(registry, explicitGates, platform);
  const identity = {
    registryDigest: options.registryDigest,
    profile: plan.profile,
    platform: plan.platform,
    includeAdvisory: plan.includeAdvisory,
    explicitGates: plan.explicitGates,
    qualifying: plan.qualifying,
    groups: plan.groups.map((group) => ({
      index: group.index,
      gates: group.gates.map((gate) => ({
        id: gate.id,
        mode: gate.mode,
        selectedBy: gate.selectedBy,
        dependencies: gate.dependencies,
        actionId: gate.actionId,
        definitionDigest: gate.definitionDigest,
      })),
    })),
    skipped: plan.skipped,
    unsupported: plan.unsupported,
  };
  return { ...plan, digest: gateDigest(identity) };
}

/** @param {string} value */
function cmdQuote(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/**
 * @param {any} action
 * @param {string} root
 * @param {string} platform
 */
export function buildGateActionInvocation(action, root, platform) {
  if (action.kind === 'argv')
    return { command: action.command, args: [...(action.args || [])] };
  if (action.kind !== 'task') return null;
  const taskArgs = [action.task, ...(action.args || [])];
  if (platform !== 'windows')
    return { command: path.posix.join(root, 'shifu'), args: taskArgs };
  const command = process.env.ComSpec || 'cmd.exe';
  const line = [path.join(root, 'shifu.cmd'), ...taskArgs]
    .map((item) => cmdQuote(String(item)))
    .join(' ');
  return {
    command,
    args: ['/d', '/s', '/c', `call ${line}`],
    windowsVerbatimArguments: true,
  };
}

/** @param {unknown} value */
function safeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('gate evidence must be an object');
  const record = /** @type {any} */ (value);
  const schema = record.schema;
  const pointers = record.pointers;
  if (typeof schema !== 'string' || !schema)
    throw new Error('gate evidence schema must be a non-empty string');
  if (!Array.isArray(pointers))
    throw new Error('gate evidence pointers must be an array');
  return {
    schema,
    pointers: pointers.map((pointer, index) => {
      if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer))
        throw new Error(`gate evidence pointer ${index} must be an object`);
      const keys = Object.keys(pointer);
      if (keys.some((key) => !['id', 'ref', 'digest'].includes(key)))
        throw new Error(`gate evidence pointer ${index} has an unknown field`);
      if (typeof pointer.id !== 'string' || !pointer.id)
        throw new Error(`gate evidence pointer ${index} needs id`);
      if (
        typeof pointer.ref !== 'string' ||
        !pointer.ref ||
        path.posix.isAbsolute(pointer.ref) ||
        path.win32.isAbsolute(pointer.ref) ||
        /^[a-z][a-z0-9+.-]*:/i.test(pointer.ref) ||
        pointer.ref.includes('?') ||
        pointer.ref.includes('#') ||
        pointer.ref.split(/[\\/]/).includes('..')
      )
        throw new Error(
          `gate evidence pointer ${index} must use a safe repository-relative ref`,
        );
      if (
        pointer.digest !== undefined &&
        !/^sha256:[0-9a-f]{64}$/.test(pointer.digest)
      )
        throw new Error(`gate evidence pointer ${index} has an invalid digest`);
      return {
        id: pointer.id,
        ref: pointer.ref.split(/[\\/]/).join('/'),
        ...(pointer.digest ? { digest: pointer.digest } : {}),
      };
    }),
  };
}

/**
 * @param {any} gate
 * @param {string} root
 */
function inspectArtifacts(gate, root) {
  return gate.artifacts.map((/** @type {any} */ artifact) => {
    const artifactPath = artifact.path.split(/[\\/]/).join('/');
    return {
      id: artifact.id,
      path: artifactPath,
      required: artifact.required,
      present: fs.existsSync(path.resolve(root, artifactPath)),
    };
  });
}

/** @param {string} status @param {string|null} mode */
function policyFailureStatus(status, mode) {
  if (mode === 'advisory' && ['fail', 'error', 'unsupported'].includes(status))
    return 'advisory-fail';
  return status;
}

/** @param {unknown} value @param {string} root */
function redactReceiptText(value, root) {
  if (value === null || value === undefined) return null;
  let text = String(value);
  for (const prefix of [root, os.homedir(), os.tmpdir()].filter(Boolean))
    text = text.split(prefix).join('<redacted-path>');
  return text
    .replace(/https?:\/\/\S+/gi, '<redacted-url>')
    .replace(/[A-Za-z]:\\[^\s,;]+/g, '<redacted-path>')
    .replace(
      /\/(?:Users|home|private|tmp|var|Volumes)\/[^\s,;]+/g,
      '<redacted-path>',
    )
    .replace(
      /\b(token|secret|password|credential|authorization)=\S+/gi,
      '$1=<redacted>',
    )
    .slice(0, 1000);
}

/** @param {{stdout?:string|null, stderr?:string|null}} result */
function actionFailureOutputTail(result) {
  const ansiEscape = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'gu',
  );
  const output = String(result.stderr || result.stdout || '')
    .replace(ansiEscape, '')
    .trim();
  return output.slice(-700).trim();
}

/**
 * @param {any} gate
 * @param {{root:string, platform:string, source:any, tempRoot:string, writer:Writer, handlers:Record<string,Function>}} context
 */
async function executeAction(gate, context) {
  const actionId = gateActionId(gate);
  const evidenceFile = path.join(context.tempRoot, `${gate.id}.evidence.json`);
  const started = Date.now();
  let rawStatus = 'pass';
  let exitCode = null;
  let signal = null;
  let reason = null;
  let evidence = null;
  if (gate.action.kind === 'handler') {
    const handler = context.handlers[gate.action.handler];
    if (!handler) {
      rawStatus = 'error';
      reason = `unregistered gate handler: ${gate.action.handler}`;
    } else {
      try {
        const outcome = await handler({
          gateId: gate.id,
          actionId,
          parameters: gate.action.parameters || {},
          root: context.root,
          source: context.source,
        });
        rawStatus = outcome?.status || 'pass';
        if (!RESULT_STATUSES.has(rawStatus))
          throw new Error(`handler returned invalid status: ${rawStatus}`);
        exitCode = outcome?.exitCode ?? (rawStatus === 'pass' ? 0 : null);
        reason = outcome?.reason || null;
        if (outcome?.evidence) evidence = safeEvidence(outcome.evidence);
      } catch (error) {
        rawStatus = 'error';
        reason = error instanceof Error ? error.message : String(error);
      }
    }
  } else {
    const invocation = buildGateActionInvocation(
      gate.action,
      context.root,
      context.platform,
    );
    try {
      if (!invocation)
        throw new Error(`unsupported gate action: ${gate.action.kind}`);
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: context.root,
        env: {
          ...process.env,
          SHIFU_GATE_ID: gate.id,
          SHIFU_GATE_ACTION_ID: actionId,
          SHIFU_GATE_SOURCE_SHA: context.source.sha || '',
          SHIFU_GATE_EVIDENCE_FILE: evidenceFile,
        },
        encoding: 'utf8',
        timeout: gate.cost.timeoutSeconds * 1000,
        maxBuffer: GATE_ACTION_MAX_BUFFER_BYTES,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      });
      if (result.stdout)
        context.writer.write(`[gate ${gate.id}] stdout\n${result.stdout}`);
      if (result.stderr)
        context.writer.write(`[gate ${gate.id}] stderr\n${result.stderr}`);
      exitCode = result.status;
      signal = result.signal;
      if (result.error) {
        rawStatus = 'error';
        reason =
          /** @type {any} */ (result.error).code === 'ETIMEDOUT'
            ? `action timed out after ${gate.cost.timeoutSeconds}s`
            : result.error.message;
      } else if (result.signal) {
        rawStatus = 'error';
        reason = `action terminated by signal ${result.signal}`;
      } else if (result.status !== 0) {
        rawStatus = 'fail';
        const outputTail = actionFailureOutputTail(result);
        reason = `action exited with code ${result.status}${outputTail ? `; output tail: ${outputTail}` : ''}`;
      }
    } catch (error) {
      rawStatus = 'error';
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (!evidence && fs.existsSync(evidenceFile)) {
    try {
      evidence = safeEvidence(
        JSON.parse(fs.readFileSync(evidenceFile, 'utf8')),
      );
    } catch (error) {
      rawStatus = 'error';
      reason = `invalid gate evidence: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (
    evidence &&
    gate.receipt.schema &&
    evidence.schema !== gate.receipt.schema
  ) {
    rawStatus = 'fail';
    reason = `evidence schema ${evidence.schema} does not match ${gate.receipt.schema}`;
  }
  if (
    rawStatus === 'pass' &&
    gate.receipt.expectation === 'required' &&
    evidence &&
    evidence.pointers.length === 0
  ) {
    rawStatus = 'fail';
    reason = 'required gate evidence did not declare any safe pointers';
  }
  if (
    rawStatus === 'pass' &&
    gate.receipt.expectation === 'required' &&
    !evidence
  ) {
    rawStatus = 'fail';
    reason = 'required gate evidence was not produced';
  }
  const artifacts = inspectArtifacts(gate, context.root);
  const missing = artifacts.filter(
    (/** @type {any} */ artifact) => artifact.required && !artifact.present,
  );
  if (rawStatus === 'pass' && missing.length) {
    rawStatus = 'fail';
    reason = `required artifact missing: ${missing.map((/** @type {any} */ item) => item.id).join(', ')}`;
  }
  return {
    rawStatus,
    exitCode,
    signal,
    reason: redactReceiptText(reason, context.root),
    durationMs: Date.now() - started,
    artifacts,
    evidence: {
      expectation: gate.receipt.expectation,
      schema: gate.receipt.schema || null,
      present: Boolean(evidence),
      pointers: /** @type {EvidencePointer[]} */ (evidence?.pointers || []),
    },
  };
}

/** @param {any[]} results @param {any[]} unsupported */
function overallStatus(results, unsupported) {
  if (unsupported.some((item) => item.mode !== 'advisory'))
    return 'unsupported';
  if (results.some((item) => item.status === 'error')) return 'error';
  if (results.some((item) => item.status === 'fail')) return 'fail';
  if (results.some((item) => item.status === 'unsupported'))
    return 'unsupported';
  if (results.some((item) => item.status === 'advisory-fail'))
    return 'advisory-fail';
  if (results.length && results.every((item) => item.status === 'skip'))
    return 'skip';
  return 'pass';
}

/** @param {any[]} results */
function requiredCoverage(results) {
  return results
    .filter((item) => item.policyMode === 'required')
    .every((item) => item.attempted && item.status === 'pass');
}

/**
 * @param {any} registry
 * @param {{root:string, registryRef:string, registryDigest:string, profile?:string, explicitGates?:string[], includeAdvisory?:boolean, platform?:string, capabilities?:string[], executionContext?:Record<string,unknown>|null, writer?:Writer, handlers?:Record<string,Function>, source?:{sha:string|null,dirty:boolean}, now?:()=>Date}} options
 */
export async function executeGateRun(registry, options) {
  const root = options.root;
  const platform = normalizeGatePlatform(options.platform);
  const capabilities = [
    ...new Set(['node', ...(options.capabilities || [])]),
  ].sort();
  const plan = buildGateRunPlan(registry, {
    registryRef: options.registryRef,
    registryDigest: options.registryDigest,
    profile: options.profile,
    explicitGates: options.explicitGates,
    includeAdvisory: options.includeAdvisory,
    platform,
  });
  const source = options.source || readGateSourceIdentity(root);
  const now = options.now || (() => new Date());
  const startedAt = now();
  const writer = options.writer || process.stderr;
  const byId = gateMap(registry);
  /** @type {any[]} */
  const results = [];
  /** @type {Map<string, any>} */
  const resultById = new Map();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-gate-'));
  try {
    for (const group of plan.groups) {
      for (const planned of group.gates) {
        const gate = requireGate(byId, planned.id);
        const failedDependency = gate.dependencies.find(
          (/** @type {string} */ dependency) =>
            resultById.get(dependency)?.status !== 'pass',
        );
        const base = {
          gateId: gate.id,
          policyMode: planned.mode,
          selectedBy: planned.selectedBy,
          actionId: gateActionId(gate),
          definitionDigest: gateDefinitionDigest(gate),
        };
        if (failedDependency) {
          const result = {
            ...base,
            status: 'skip',
            attempted: false,
            durationMs: 0,
            exitCode: null,
            signal: null,
            reason: `dependency ${failedDependency} did not pass`,
            artifacts: inspectArtifacts(gate, root),
            evidence: {
              expectation: gate.receipt.expectation,
              schema: gate.receipt.schema || null,
              present: false,
              pointers: [],
            },
            reproduce: {
              argv: [
                platform === 'windows' ? 'shifu.cmd' : './shifu',
                'gate',
                'run',
                gate.id,
                '--registry',
                options.registryRef,
              ],
            },
          };
          results.push(result);
          resultById.set(gate.id, result);
          continue;
        }
        const missingCapabilities = gate.runner.capabilities.filter(
          (/** @type {string} */ capability) =>
            !capabilities.includes(capability),
        );
        if (missingCapabilities.length) {
          const result = {
            ...base,
            status: policyFailureStatus('unsupported', planned.mode),
            attempted: false,
            durationMs: 0,
            exitCode: null,
            signal: null,
            reason: `missing runner capabilities: ${missingCapabilities.join(', ')}`,
            artifacts: inspectArtifacts(gate, root),
            evidence: {
              expectation: gate.receipt.expectation,
              schema: gate.receipt.schema || null,
              present: false,
              pointers: [],
            },
            reproduce: {
              argv: [
                platform === 'windows' ? 'shifu.cmd' : './shifu',
                'gate',
                'run',
                gate.id,
                '--registry',
                options.registryRef,
              ],
            },
          };
          results.push(result);
          resultById.set(gate.id, result);
          continue;
        }
        const outcome = await executeAction(gate, {
          root,
          platform,
          source,
          tempRoot,
          writer,
          handlers: options.handlers || {},
        });
        const result = {
          ...base,
          status: policyFailureStatus(outcome.rawStatus, planned.mode),
          attempted: true,
          durationMs: outcome.durationMs,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          reason: outcome.reason,
          artifacts: outcome.artifacts,
          evidence: outcome.evidence,
          reproduce: {
            argv: [
              platform === 'windows' ? 'shifu.cmd' : './shifu',
              'gate',
              'run',
              gate.id,
              '--registry',
              options.registryRef,
            ],
          },
        };
        results.push(result);
        resultById.set(gate.id, result);
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  const finishedAt = now();
  const observedAfter = options.source ? source : readGateSourceIdentity(root);
  const boundSource = {
    sha: source.sha,
    dirty:
      source.dirty ||
      observedAfter.dirty ||
      Boolean(
        source.sha && observedAfter.sha && source.sha !== observedAfter.sha,
      ),
  };
  const status = overallStatus(results, plan.unsupported);
  const requiredComplete = requiredCoverage(results);
  const qualifying = Boolean(
    plan.qualifying &&
      source.sha &&
      !boundSource.dirty &&
      requiredComplete &&
      ['pass', 'advisory-fail'].includes(status),
  );
  const receipt = {
    $schema: GATE_RECEIPT_SCHEMA,
    schema: 'shifu.gate-receipt/v1',
    runId: `gate-${randomUUID()}`,
    project: { id: registry.project.id },
    source: boundSource,
    registry: {
      ref: options.registryRef,
      digest: options.registryDigest,
      projectId: registry.project.id,
    },
    selection: {
      profile: plan.profile,
      includeAdvisory: plan.includeAdvisory,
      explicitGates: plan.explicitGates,
    },
    environment: { platform, runnerCapabilities: capabilities },
    ...(options.executionContext
      ? { execution: structuredClone(options.executionContext) }
      : {}),
    plan: {
      digest: plan.digest,
      qualifying: plan.qualifying,
      expectedActionIds: plan.groups.flatMap((group) =>
        group.gates.map((gate) => gate.actionId),
      ),
      attemptedActionIds: results
        .filter((result) => result.attempted)
        .map((result) => result.actionId),
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    status,
    ok: ['pass', 'advisory-fail'].includes(status),
    qualifying,
    results,
    skipped: plan.skipped,
    unsupported: plan.unsupported,
  };
  return { ...receipt, integrity: { digest: gateDigest(receipt) } };
}

/**
 * @param {any} receipt
 * @param {any} registry
 * @param {{root:string, registryRef:string, registryDigest:string, source?:{sha:string|null,dirty:boolean}}} options
 */
export function validateGateReceipt(receipt, registry, options) {
  /** @type {GateIssue[]} */
  const issues = [];
  /** @param {string} code @param {string} at @param {string} message */
  const add = (code, at, message) => issues.push({ code, path: at, message });
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    add('type', '/', 'receipt must be an object');
    return { valid: false, current: false, qualifying: false, issues };
  }
  if (receipt.$schema !== GATE_RECEIPT_SCHEMA)
    add('schema-id', '/$schema', `must be ${GATE_RECEIPT_SCHEMA}`);
  if (receipt.schema !== 'shifu.gate-receipt/v1')
    add('schema-version', '/schema', 'must be shifu.gate-receipt/v1');
  if (!RESULT_STATUSES.has(receipt.status))
    add('status', '/status', 'has an invalid status');
  if (!Array.isArray(receipt.results))
    add('type', '/results', 'must be an array');
  const unsigned = { ...receipt };
  Reflect.deleteProperty(unsigned, 'integrity');
  if (receipt.integrity?.digest !== gateDigest(unsigned))
    add(
      'receipt-digest',
      '/integrity/digest',
      'does not match the receipt content',
    );
  const source = options.source || readGateSourceIdentity(options.root);
  let current = true;
  if (receipt.registry?.digest !== options.registryDigest) {
    add(
      'stale-registry',
      '/registry/digest',
      'does not match the current registry',
    );
    current = false;
  }
  if (receipt.registry?.ref !== options.registryRef) {
    add(
      'registry-ref',
      '/registry/ref',
      'does not match the selected registry ref',
    );
    current = false;
  }
  if (
    receipt.source?.sha !== source.sha ||
    receipt.source?.dirty !== source.dirty
  ) {
    add(
      'stale-source',
      '/source',
      'does not match the current source SHA and dirty state',
    );
    current = false;
  }
  let plan = null;
  try {
    plan = buildGateRunPlan(registry, {
      registryRef: options.registryRef,
      registryDigest: options.registryDigest,
      profile: receipt.selection?.profile || '',
      explicitGates: receipt.selection?.explicitGates || [],
      includeAdvisory: receipt.selection?.includeAdvisory || false,
      platform: receipt.environment?.platform,
    });
    if (receipt.plan?.digest !== plan.digest) {
      add(
        'plan-digest',
        '/plan/digest',
        'does not match the current execution plan',
      );
      current = false;
    }
    if (receipt.plan?.qualifying !== plan.qualifying)
      add(
        'plan-qualification',
        '/plan/qualifying',
        'does not match the current plan',
      );
    if (gateDigest(receipt.skipped || []) !== gateDigest(plan.skipped))
      add('plan-skipped', '/skipped', 'does not match the current plan');
    if (gateDigest(receipt.unsupported || []) !== gateDigest(plan.unsupported))
      add(
        'plan-unsupported',
        '/unsupported',
        'does not match the current plan',
      );
  } catch (error) {
    add(
      'plan',
      '/selection',
      error instanceof Error ? error.message : String(error),
    );
  }
  /** @type {Map<string, any>} */
  const expected = new Map();
  for (const group of plan?.groups || [])
    for (const gate of group.gates) expected.set(gate.id, gate);
  const seen = new Set();
  if (Array.isArray(receipt.results)) {
    for (let index = 0; index < receipt.results.length; index += 1) {
      const result = receipt.results[index];
      const at = `/results/${index}`;
      if (!result || typeof result !== 'object') {
        add('type', at, 'must be an object');
        continue;
      }
      if (seen.has(result.gateId))
        add('duplicate-result', `${at}/gateId`, 'is duplicated');
      seen.add(result.gateId);
      const planned = expected.get(result.gateId);
      if (!planned) {
        add('unexpected-result', `${at}/gateId`, 'is not in the current plan');
        continue;
      }
      if (result.actionId !== planned.actionId)
        add('action-id', `${at}/actionId`, 'does not match the current action');
      if (result.policyMode !== planned.mode)
        add(
          'policy-mode',
          `${at}/policyMode`,
          'does not match the current plan',
        );
      if (result.definitionDigest !== planned.definitionDigest) {
        add(
          'definition-digest',
          `${at}/definitionDigest`,
          'does not match the current gate definition',
        );
        current = false;
      }
      if (!RESULT_STATUSES.has(result.status))
        add('status', `${at}/status`, 'has an invalid status');
    }
  }
  for (const id of expected.keys())
    if (!seen.has(id))
      add('missing-result', '/results', `is missing gate ${id}`);
  const expectedActionIds = [...expected.values()].map((gate) => gate.actionId);
  const attemptedActionIds = Array.isArray(receipt.results)
    ? receipt.results
        .filter((/** @type {any} */ result) => result?.attempted)
        .map((/** @type {any} */ result) => result.actionId)
    : [];
  if (
    gateDigest(receipt.plan?.expectedActionIds || []) !==
    gateDigest(expectedActionIds)
  )
    add(
      'expected-actions',
      '/plan/expectedActionIds',
      'does not match the current plan',
    );
  if (
    gateDigest(receipt.plan?.attemptedActionIds || []) !==
    gateDigest(attemptedActionIds)
  )
    add(
      'attempted-actions',
      '/plan/attemptedActionIds',
      'does not match result coverage',
    );
  const derivedStatus = overallStatus(
    Array.isArray(receipt.results) ? receipt.results : [],
    Array.isArray(receipt.unsupported) ? receipt.unsupported : [],
  );
  if (receipt.status !== derivedStatus)
    add(
      'overall-status',
      '/status',
      `must be ${derivedStatus} for these results`,
    );
  if (receipt.ok !== ['pass', 'advisory-fail'].includes(derivedStatus))
    add('overall-ok', '/ok', 'does not match the derived status');
  const valid = !issues.some((item) =>
    [
      'type',
      'schema-id',
      'schema-version',
      'status',
      'duplicate-result',
      'unexpected-result',
      'action-id',
      'policy-mode',
      'missing-result',
      'plan',
      'plan-qualification',
      'plan-skipped',
      'plan-unsupported',
      'receipt-digest',
      'expected-actions',
      'attempted-actions',
      'overall-status',
      'overall-ok',
    ].includes(item.code),
  );
  const qualifying = Boolean(
    valid &&
      current &&
      receipt.qualifying &&
      plan?.qualifying &&
      receipt.source?.sha &&
      !receipt.source?.dirty &&
      requiredCoverage(receipt.results || []),
  );
  if (!plan?.qualifying)
    add(
      'diagnostic-selection',
      '/selection',
      'explicit gate selection is non-qualifying',
    );
  if (!receipt.source?.sha)
    add(
      'source-unavailable',
      '/source/sha',
      'a Git source SHA is required for qualification',
    );
  if (receipt.source?.dirty)
    add(
      'dirty-source',
      '/source/dirty',
      'a dirty source checkout cannot qualify',
    );
  if (!requiredCoverage(receipt.results || []))
    add(
      'required-coverage',
      '/results',
      'every required action must be attempted and pass',
    );
  if (receipt.qualifying && !qualifying)
    add(
      'qualification',
      '/qualifying',
      'claim is not supported by current complete required coverage',
    );
  return { valid, current, qualifying, issues };
}
