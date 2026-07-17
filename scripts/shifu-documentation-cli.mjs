// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  documentationValidationReceipt,
  validateDocumentationSubmissionBytes,
} from './shifu-documentation-runtime.mjs';
import {
  buildHumanSurfaceInventory,
  documentationAuthoringImpact,
  documentationSurfaceDigest,
  humanSurfaceXinfaProject,
} from './shifu-documentation-surfaces.mjs';

const DEFAULT_SUBMISSION = 'shifu.documentation.json';

/**
 * @typedef {object} SurfaceOptions
 * @property {string} policy
 * @property {string} format
 * @property {string} output
 * @property {string} since
 * @property {string} xinfa
 * @property {boolean} json
 */

/**
 * @typedef {object} FinalReadyOptions
 * @property {string} policy
 * @property {string} since
 * @property {string} xinfa
 * @property {string} parityGroup
 * @property {string} humanRoute
 * @property {string} agentRoute
 * @property {string} intent
 * @property {string} task
 * @property {string} role
 * @property {number} budget
 * @property {number} maxHops
 * @property {boolean} json
 */

/**
 * @typedef {object} ReaderOptions
 * @property {string} policy
 * @property {string} xinfa
 * @property {string} route
 * @property {string} task
 * @property {string} role
 * @property {number} budget
 * @property {string} intent
 * @property {number} maxHops
 * @property {'human'|'gui'} surface
 * @property {string} since
 * @property {boolean} json
 */

function help() {
  return `shifu docs — inspect the project-independent Documentation Protocol
  docs contract                         print the canonical contract manifest
  docs schema submission               print the project submission JSON Schema
  docs schema receipt                  print the validation receipt JSON Schema
  docs validate [--submission FILE|-] [--json]
                                        validate without executing document commands
  docs show [--submission FILE] [--json]
                                        print deterministic canonical roots and projection
  docs inventory [--policy FILE] [--format inventory|xinfa-project] [--json]
                                        close every tracked human-readable surface into an
                                        exact, classified inventory or Xinfa project submission
  docs graph --output DIR [--policy FILE] [--xinfa FILE] [--json]
                                        delegate the exact surface project to Xinfa Atlas
  docs impact --since DIR [--policy FILE] [--xinfa FILE] [--json]
                                        delegate bounded KFD-1 impact to Xinfa Atlas
  docs authoring --since REF [--policy FILE] [--json]
                                        classify changed human surfaces into generated,
                                        managed, authored, historical, or non-claim obligations
  docs final-ready --since REF [--parity-group ID] [--human-route ID]
                   [--agent-route ID] [--intent TEXT] [--task TEXT]
                   [--budget N] [--max-hops N] [--policy FILE]
                   [--xinfa FILE] [--json]
                                        bind KFD-1 impact and paired KFD-3 Human/Agent
                                        projections into one content-addressed review receipt
  docs read --intent TEXT [--route ID] [--max-hops N] [--surface human|gui]
            [--policy FILE] [--xinfa FILE] [--json]
                                        compile a bounded Human/GUI view through Xinfa
  docs context --task TEXT --budget N [--role ROLE] [--route ID] [--since DIR]
               [--policy FILE] [--xinfa FILE] [--json]
                                        compile a bounded Agent Task Chart through Xinfa
  docs xinfa compile --project FILE --output DIR [--root DIR]
                     [--visibility LEVEL] [--submission FILE]
                     [--xinfa FILE] [--json]
                                        validate the submission, delegate Atlas compilation
                                        to the public Xinfa CLI, and verify the result

Validation is diagnostic and non-qualifying. Probe providers may only reference
a Shifu Gate registry; this command never executes them.`;
}

/** @param {string[]} args @param {'read'|'context'} operation @returns {ReaderOptions} */
function parseReaderOptions(args, operation) {
  /** @type {ReaderOptions} */
  const options = {
    policy: 'shifu.documentation.surfaces.json',
    xinfa: '',
    route: '',
    task: '',
    role: 'implementer',
    budget: 0,
    intent: '',
    maxHops: 2,
    surface: 'human',
    since: '',
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--policy') options.policy = value;
      else if (arg === '--xinfa') options.xinfa = value;
      else if (arg === '--route') options.route = value;
      else if (arg === '--task') options.task = value;
      else if (arg === '--role') options.role = value;
      else if (arg === '--budget') options.budget = Number(value);
      else if (arg === '--intent') options.intent = value;
      else if (arg === '--max-hops') options.maxHops = Number(value);
      else if (arg === '--surface' && ['human', 'gui'].includes(value))
        options.surface = /** @type {'human'|'gui'} */ (value);
      else if (arg === '--since') options.since = value;
      else throw new Error(`unknown docs ${operation} option: ${arg}`);
    }
  }
  if (operation === 'read' && !options.intent)
    throw new Error('docs read requires --intent');
  if (operation === 'context' && !options.task)
    throw new Error('docs context requires --task');
  if (
    operation === 'context' &&
    (!Number.isInteger(options.budget) || options.budget <= 0)
  )
    throw new Error('docs context requires a positive integer --budget');
  if (!Number.isInteger(options.maxHops) || options.maxHops < 0)
    throw new Error('--max-hops must be a non-negative integer');
  return options;
}

/** @param {string[]} args @param {'inventory'|'graph'|'impact'} operation @returns {SurfaceOptions} */
function parseSurfaceOptions(args, operation) {
  const options = {
    policy: 'shifu.documentation.surfaces.json',
    format: 'inventory',
    output: '',
    since: '',
    xinfa: '',
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (
      ['--policy', '--format', '--output', '--since', '--xinfa'].includes(arg)
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--policy') options.policy = value;
      else if (arg === '--format') options.format = value;
      else if (arg === '--output') options.output = value;
      else if (arg === '--since') options.since = value;
      else options.xinfa = value;
    } else throw new Error(`unknown docs ${operation} option: ${arg}`);
  }
  if (!['inventory', 'xinfa-project'].includes(options.format))
    throw new Error('--format must be inventory or xinfa-project');
  if (operation === 'graph' && !options.output)
    throw new Error('docs graph requires --output');
  if (operation === 'impact' && !options.since)
    throw new Error('docs impact requires --since');
  return options;
}

/** @param {string[]} args */
function parseAuthoringOptions(args) {
  const options = {
    policy: 'shifu.documentation.surfaces.json',
    since: '',
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--policy' || arg === '--since') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--policy') options.policy = value;
      else options.since = value;
    } else throw new Error(`unknown docs authoring option: ${arg}`);
  }
  if (!options.since) throw new Error('docs authoring requires --since');
  return options;
}

/** @param {string[]} args @returns {FinalReadyOptions} */
function parseFinalReadyOptions(args) {
  /** @type {FinalReadyOptions} */
  const options = {
    policy: 'shifu.documentation.surfaces.json',
    since: '',
    xinfa: '',
    parityGroup: 'kungfu-documentation-control',
    humanRoute: '',
    agentRoute: '',
    intent:
      'review documentation authority, constraints, evidence, and next action',
    task: 'independently review documentation impact, authority, and final readiness',
    role: 'independent-reviewer',
    budget: 40960,
    maxHops: 2,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--policy') options.policy = value;
      else if (arg === '--since') options.since = value;
      else if (arg === '--xinfa') options.xinfa = value;
      else if (arg === '--parity-group') options.parityGroup = value;
      else if (arg === '--human-route') options.humanRoute = value;
      else if (arg === '--agent-route') options.agentRoute = value;
      else if (arg === '--intent') options.intent = value;
      else if (arg === '--task') options.task = value;
      else if (arg === '--role') options.role = value;
      else if (arg === '--budget') options.budget = Number(value);
      else if (arg === '--max-hops') options.maxHops = Number(value);
      else throw new Error(`unknown docs final-ready option: ${arg}`);
    }
  }
  if (!options.since) throw new Error('docs final-ready requires --since');
  if (!Number.isInteger(options.budget) || options.budget <= 0)
    throw new Error('--budget must be a positive integer');
  if (!Number.isInteger(options.maxHops) || options.maxHops < 0)
    throw new Error('--max-hops must be a non-negative integer');
  return options;
}

/** @param {string} root @param {string} requested @returns {string} */
function surfaceXinfaBinary(root, requested) {
  return path.resolve(
    root,
    requested ||
      path.join(
        'xinfa',
        'target',
        'debug',
        process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
      ),
  );
}

/** @param {any} result @param {string} operation @returns {any} */
function parseJsonOutput(result, operation) {
  if (result.error)
    throw new Error(`${operation} failed to start: ${result.error.message}`);
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(`${operation} did not emit JSON`);
  }
}

/** @param {any} project @param {(reference: string) => any} callback */
function withSurfaceProject(project, callback) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-surfaces-'));
  const reference = path.join(temporary, 'project.json');
  try {
    fs.writeFileSync(reference, `${JSON.stringify(project, null, 2)}\n`);
    return callback(reference);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** @param {string} root @param {any} inventory @param {any} project @param {SurfaceOptions} options */
function runSurfaceGraph(root, inventory, project, options) {
  const binary = surfaceXinfaBinary(root, options.xinfa);
  return withSurfaceProject(project, (reference) => {
    const compile = spawnSync(
      binary,
      [
        'atlas',
        'compile',
        '--project',
        reference,
        '--output',
        options.output,
        '--root',
        root,
        '--visibility',
        'public',
        '--json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const compileReceipt = parseJsonOutput(compile, 'Xinfa Atlas compile');
    let verifyReceipt = null;
    let verifyStatus = null;
    if (compile.status === 0) {
      const verify = spawnSync(
        binary,
        ['atlas', 'verify', '--atlas', options.output, '--json'],
        { cwd: root, encoding: 'utf8' },
      );
      verifyReceipt = parseJsonOutput(verify, 'Xinfa Atlas verify');
      verifyStatus = verify.status;
    }
    const passed =
      compile.status === 0 &&
      verifyStatus === 0 &&
      verifyReceipt?.valid === true;
    return {
      status: passed ? 0 : 1,
      receipt: {
        schema: 'shifu.documentation-xinfa-graph-receipt/v1',
        verdict: passed ? 'pass' : 'fail',
        delegated: true,
        qualifying: false,
        inventoryRoot: inventory.inventoryRoot,
        closure: inventory.closure,
        xinfa: { compile: compileReceipt, verify: verifyReceipt },
      },
    };
  });
}

/** @param {string} root @param {any} inventory @param {any} project @param {SurfaceOptions} options */
function runSurfaceImpact(root, inventory, project, options) {
  const binary = surfaceXinfaBinary(root, options.xinfa);
  return withSurfaceProject(project, (reference) => {
    const result = spawnSync(
      binary,
      [
        'atlas',
        'impact',
        '--since',
        options.since,
        '--project',
        reference,
        '--root',
        root,
        '--visibility',
        'public',
        '--json',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    return {
      status: result.status ?? 1,
      receipt: {
        schema: 'shifu.documentation-xinfa-impact-receipt/v1',
        verdict: result.status === 0 ? 'pass' : 'fail',
        delegated: true,
        qualifying: false,
        inventoryRoot: inventory.inventoryRoot,
        impact: parseJsonOutput(result, 'Xinfa Atlas impact'),
      },
    };
  });
}

/** @param {any} inventory @param {'human'|'agent'} audience @param {string} requested */
function resolveReaderRoute(inventory, audience, requested) {
  const route = requested
    ? inventory.routes.find(
        (/** @type {any} */ candidate) => candidate.id === requested,
      )
    : inventory.routes.find(
        (/** @type {any} */ candidate) =>
          candidate.audience === audience &&
          candidate.selection.mode === 'exact',
      );
  if (!route)
    throw new Error(`no ${audience} documentation route is available`);
  if (route.audience !== audience)
    throw new Error(`route ${route.id} is not a ${audience} route`);
  return route;
}

/** @param {string} root @param {any} inventory @param {any} project @param {'read'|'context'} operation @param {ReaderOptions} options */
function runSurfaceReader(root, inventory, project, operation, options) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-reader-'));
  const atlas = path.join(temporary, 'atlas');
  try {
    const graph = runSurfaceGraph(root, inventory, project, {
      policy: options.policy,
      format: 'inventory',
      output: atlas,
      since: '',
      xinfa: options.xinfa,
      json: true,
    });
    const audience = operation === 'context' ? 'agent' : 'human';
    const route = resolveReaderRoute(inventory, audience, options.route);
    let impact = null;
    if (options.since) {
      const impactResult = runSurfaceImpact(root, inventory, project, {
        policy: options.policy,
        format: 'inventory',
        output: '',
        since: options.since,
        xinfa: options.xinfa,
        json: true,
      });
      impact = impactResult.receipt;
      if (impactResult.status !== 0)
        return { status: impactResult.status, receipt: impact };
    }
    if (graph.status !== 0) return graph;
    const binary = surfaceXinfaBinary(root, options.xinfa);
    const argv =
      operation === 'context'
        ? [
            'context',
            '--atlas',
            atlas,
            '--route',
            route.id,
            '--task',
            options.task,
            '--role',
            options.role,
            '--budget',
            String(options.budget),
            '--json',
          ]
        : [
            'read',
            '--atlas',
            atlas,
            '--route',
            route.id,
            '--intent',
            options.intent,
            '--surface',
            options.surface,
            '--max-hops',
            String(options.maxHops),
            '--json',
          ];
    const delegated = spawnSync(binary, argv, { cwd: root, encoding: 'utf8' });
    const projection = parseJsonOutput(delegated, `Xinfa ${operation}`);
    const passed = delegated.status === 0;
    return {
      status: passed ? 0 : (delegated.status ?? 1),
      receipt: {
        schema: 'shifu.documentation-dual-reader-receipt/v1',
        verdict: passed ? 'pass' : 'fail',
        qualifying: false,
        delegated: true,
        operation,
        inventoryRoot: inventory.inventoryRoot,
        atlasRoot: graph.receipt.xinfa.compile.atlas_root,
        route: {
          id: route.id,
          audience: route.audience,
          parityGroup: route.parityGroup,
          capabilities: route.capabilities,
        },
        impact,
        projection,
      },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** @param {any} inventory @param {'human'|'agent'} audience @param {string} requested @param {string} parityGroup */
function resolveFinalReadyRoute(inventory, audience, requested, parityGroup) {
  const route = requested
    ? resolveReaderRoute(inventory, audience, requested)
    : inventory.routes.find(
        (/** @type {any} */ candidate) =>
          candidate.audience === audience &&
          candidate.parityGroup === parityGroup &&
          candidate.selection.mode === 'exact',
      );
  if (!route)
    throw new Error(
      `no exact ${audience} route exists for parity group ${parityGroup}`,
    );
  if (route.parityGroup !== parityGroup)
    throw new Error(
      `route ${route.id} belongs to ${route.parityGroup}, not ${parityGroup}`,
    );
  return route;
}

/** @param {any} projection */
function projectionParityBasis(projection) {
  const parity = projection?.parity || {};
  return {
    atlasRoot: parity.atlas_root || null,
    projectId: parity.project_id || null,
    cut: parity.cut || null,
    cutRoot: parity.cut_root || null,
    visibility: parity.visibility || null,
    parityGroup: parity.route?.parity_group || null,
    authorityRoot: parity.route?.authority_root || null,
    routeStatus: parity.route?.status || null,
    evidence: parity.evidence || null,
    atlasOmissions: parity.atlas_omissions || null,
    sourceRoots: parity.source_roots || null,
  };
}

/** @param {string} binary @param {string} root @param {string} atlas @param {any} route @param {'read'|'context'} operation @param {FinalReadyOptions} options */
function runFinalReadyProjection(
  binary,
  root,
  atlas,
  route,
  operation,
  options,
) {
  const argv =
    operation === 'read'
      ? [
          'read',
          '--atlas',
          atlas,
          '--route',
          route.id,
          '--intent',
          options.intent,
          '--surface',
          'human',
          '--max-hops',
          String(options.maxHops),
          '--json',
        ]
      : [
          'context',
          '--atlas',
          atlas,
          '--route',
          route.id,
          '--task',
          options.task,
          '--role',
          options.role,
          '--budget',
          String(options.budget),
          '--json',
        ];
  const delegated = spawnSync(binary, argv, { cwd: root, encoding: 'utf8' });
  return {
    exitStatus: delegated.status ?? 1,
    route: {
      id: route.id,
      audience: route.audience,
      parityGroup: route.parityGroup,
      capabilities: route.capabilities,
    },
    projection: parseJsonOutput(delegated, `Xinfa ${operation}`),
  };
}

/** @param {string} root @param {any} inventory @param {any} project @param {FinalReadyOptions} options */
function runDocumentationFinalReady(root, inventory, project, options) {
  const impact = documentationAuthoringImpact({
    root,
    since: options.since,
    policyRef: options.policy,
    inventory,
  });
  const humanRoute = resolveFinalReadyRoute(
    inventory,
    'human',
    options.humanRoute,
    options.parityGroup,
  );
  const agentRoute = resolveFinalReadyRoute(
    inventory,
    'agent',
    options.agentRoute,
    options.parityGroup,
  );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-final-ready-'),
  );
  const atlas = path.join(temporary, 'atlas');
  try {
    const graph = runSurfaceGraph(root, inventory, project, {
      policy: options.policy,
      format: 'inventory',
      output: atlas,
      since: '',
      xinfa: options.xinfa,
      json: true,
    });
    const binary = surfaceXinfaBinary(root, options.xinfa);
    const projections =
      graph.status === 0
        ? {
            human: runFinalReadyProjection(
              binary,
              root,
              atlas,
              humanRoute,
              'read',
              options,
            ),
            agent: runFinalReadyProjection(
              binary,
              root,
              atlas,
              agentRoute,
              'context',
              options,
            ),
          }
        : { human: null, agent: null };
    const humanBasis = projectionParityBasis(projections.human?.projection);
    const agentBasis = projectionParityBasis(projections.agent?.projection);
    const parityBasis = {
      group: options.parityGroup,
      human: humanBasis,
      agent: agentBasis,
    };
    const parityRoot = documentationSurfaceDigest(parityBasis);
    const parityMatched =
      JSON.stringify(humanBasis) === JSON.stringify(agentBasis) &&
      humanRoute.parityGroup === agentRoute.parityGroup;
    const machineReady =
      graph.status === 0 &&
      impact.verdict !== 'fail' &&
      projections.human?.exitStatus === 0 &&
      projections.agent?.exitStatus === 0 &&
      projections.human?.projection?.status === 'complete' &&
      projections.agent?.projection?.status === 'complete' &&
      humanBasis.routeStatus === 'current' &&
      agentBasis.routeStatus === 'current' &&
      parityMatched;
    const verdict = !machineReady
      ? 'fail'
      : impact.verdict === 'review-required'
        ? 'review-required'
        : 'pass';
    const receipt = {
      schema: 'shifu.documentation-final-ready-receipt/v1',
      verdict,
      qualifying: false,
      delegated: true,
      reviewRequired: impact.verdict === 'review-required',
      source: impact.source,
      inventory: {
        root: inventory.inventoryRoot,
        closure: inventory.closure,
      },
      impact: {
        root: impact.impactRoot,
        verdict: impact.verdict,
        obligations: impact.obligations,
        violations: impact.violations,
        summary: impact.summary,
      },
      atlas: {
        root: graph.receipt?.xinfa?.compile?.atlas_root || null,
        compile: graph.receipt?.xinfa?.compile || null,
        verify: graph.receipt?.xinfa?.verify || null,
      },
      projections,
      parity: {
        group: options.parityGroup,
        matched: parityMatched,
        root: parityRoot,
        human: humanBasis,
        agent: agentBasis,
      },
    };
    return {
      status: verdict === 'fail' ? 1 : 0,
      receipt: {
        ...receipt,
        receiptRoot: documentationSurfaceDigest(receipt),
      },
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** @param {string[]} args */
function parseXinfaOptions(args) {
  const options = {
    project: '',
    output: '',
    root: '',
    visibility: 'public',
    submission: DEFAULT_SUBMISSION,
    xinfa: '',
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (
      [
        '--project',
        '--output',
        '--root',
        '--visibility',
        '--submission',
        '--xinfa',
      ].includes(arg)
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--project') options.project = value;
      else if (arg === '--output') options.output = value;
      else if (arg === '--root') options.root = value;
      else if (arg === '--visibility') options.visibility = value;
      else if (arg === '--submission') options.submission = value;
      else options.xinfa = value;
    } else throw new Error(`unknown docs xinfa option: ${arg}`);
  }
  if (!options.project)
    throw new Error('docs xinfa compile requires --project');
  if (!options.output) throw new Error('docs xinfa compile requires --output');
  if (!['public', 'internal', 'private'].includes(options.visibility))
    throw new Error('--visibility must be public, internal, or private');
  return options;
}

/** @param {string} root @param {ReturnType<typeof parseXinfaOptions>} options */
function runXinfaCompile(root, options) {
  const binary = path.resolve(
    root,
    options.xinfa ||
      path.join(
        'xinfa',
        'target',
        'debug',
        process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
      ),
  );
  const compileArgs = [
    'atlas',
    'compile',
    '--project',
    options.project,
    '--output',
    options.output,
    '--root',
    options.root || root,
    '--visibility',
    options.visibility,
    '--json',
  ];
  const compile = spawnSync(binary, compileArgs, {
    cwd: root,
    encoding: 'utf8',
  });
  if (compile.error)
    throw new Error(`cannot execute Xinfa CLI: ${compile.error.message}`);
  let compileReceipt;
  try {
    compileReceipt = JSON.parse(compile.stdout || '{}');
  } catch {
    throw new Error('Xinfa compile did not emit a JSON receipt');
  }
  let verificationReceipt = null;
  let verifyStatus = null;
  if (compile.status === 0) {
    const verify = spawnSync(
      binary,
      ['atlas', 'verify', '--atlas', options.output, '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    if (verify.error)
      throw new Error(
        `cannot verify delegated Xinfa Atlas: ${verify.error.message}`,
      );
    verifyStatus = verify.status;
    try {
      verificationReceipt = JSON.parse(verify.stdout || '{}');
    } catch {
      throw new Error('Xinfa verify did not emit a JSON receipt');
    }
  }
  return {
    compileArgs,
    compileReceipt,
    compileStatus: compile.status,
    verificationReceipt,
    verifyStatus,
  };
}

/** @param {string[]} args */
function parseOptions(args) {
  let submission = DEFAULT_SUBMISSION;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (arg === '--submission') {
      submission = args[++index];
      if (!submission) throw new Error('--submission requires FILE or -');
    } else throw new Error(`unknown docs option: ${arg}`);
  }
  return { submission, json };
}

/** @param {string} root @param {string} ref */
function readSubmission(root, ref) {
  if (ref === '-') return fs.readFileSync(0);
  return fs.readFileSync(path.resolve(root, ref));
}

/** @param {string} root @param {string} rel @param {NodeJS.WritableStream} stdout */
function exactFile(root, rel, stdout) {
  stdout.write(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export async function runDocumentationCommand(
  /** @type {string[]} */
  args,
  /** @type {{root?:string,stdout?:NodeJS.WritableStream,stderr?:NodeJS.WritableStream}} */
  {
    root = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const sub = args[0] || 'help';
  if (sub === 'contract') {
    if (args.length !== 1)
      throw new Error('docs contract accepts no arguments');
    exactFile(root, 'docs/shifu/documentation-contract.json', stdout);
    return 0;
  }
  if (sub === 'schema') {
    if (args.length !== 2 || !['submission', 'receipt'].includes(args[1]))
      throw new Error('docs schema requires submission or receipt');
    exactFile(
      root,
      args[1] === 'submission'
        ? 'docs/shifu/schema/documentation-project-v1.schema.json'
        : 'docs/shifu/schema/documentation-validation-receipt-v1.schema.json',
      stdout,
    );
    return 0;
  }
  if (sub === 'validate' || sub === 'show') {
    const options = parseOptions(args.slice(1));
    if (sub === 'show' && options.submission === '-')
      throw new Error(
        'docs show requires a named submission so its source is auditable',
      );
    const result = validateDocumentationSubmissionBytes(
      readSubmission(root, options.submission),
      { root, checkFiles: options.submission !== '-' },
    );
    const receipt = documentationValidationReceipt(result, options.submission);
    if (sub === 'show') {
      if (!result.valid) {
        if (options.json) stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
        else
          for (const item of receipt.diagnostics)
            stderr.write(`${item.code}\t${item.path}\t${item.message}\n`);
        return 1;
      }
      const { submission, projection } = result;
      if (!submission || !projection)
        throw new Error('valid documentation result is missing its projection');
      if (options.json)
        stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
      else {
        stdout.write(`project: ${submission.project.id}\n`);
        stdout.write(`contract root: ${projection.roots.contract}\n`);
        stdout.write(`content root: ${projection.roots.content}\n`);
        stdout.write(`submission root: ${projection.roots.submission}\n`);
      }
      return 0;
    }
    if (options.json) stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else if (result.valid) {
      const { submission } = result;
      if (!submission)
        throw new Error('valid documentation result is missing its submission');
      stdout.write(
        `valid documentation submission: ${options.submission} (${submission.providers.length} providers, ${submission.routes.length} routes)\n`,
      );
      stdout.write(
        'qualification: diagnostic-only (probe execution and review remain outstanding)\n',
      );
    } else
      for (const item of receipt.diagnostics)
        stderr.write(`${item.code}\t${item.path}\t${item.message}\n`);
    return result.valid ? 0 : 1;
  }
  if (['inventory', 'graph', 'impact'].includes(sub)) {
    const operation = /** @type {'inventory'|'graph'|'impact'} */ (sub);
    const options = parseSurfaceOptions(args.slice(1), operation);
    const inventory = buildHumanSurfaceInventory({
      root,
      policyRef: options.policy,
    });
    const project = humanSurfaceXinfaProject(inventory);
    if (sub === 'inventory') {
      const value = options.format === 'xinfa-project' ? project : inventory;
      stdout.write(`${JSON.stringify(value, null, options.json ? 2 : 0)}\n`);
      return 0;
    }
    const result =
      sub === 'graph'
        ? runSurfaceGraph(root, inventory, project, options)
        : runSurfaceImpact(root, inventory, project, options);
    stdout.write(
      `${JSON.stringify(result.receipt, null, options.json ? 2 : 0)}\n`,
    );
    return result.status;
  }
  if (sub === 'authoring') {
    const options = parseAuthoringOptions(args.slice(1));
    const receipt = documentationAuthoringImpact({
      root,
      since: options.since,
      policyRef: options.policy,
    });
    stdout.write(`${JSON.stringify(receipt, null, options.json ? 2 : 0)}\n`);
    return receipt.verdict === 'fail' ? 1 : 0;
  }
  if (sub === 'final-ready') {
    const options = parseFinalReadyOptions(args.slice(1));
    const inventory = buildHumanSurfaceInventory({
      root,
      policyRef: options.policy,
    });
    const project = humanSurfaceXinfaProject(inventory);
    const result = runDocumentationFinalReady(
      root,
      inventory,
      project,
      options,
    );
    stdout.write(
      `${JSON.stringify(result.receipt, null, options.json ? 2 : 0)}\n`,
    );
    return result.status;
  }
  if (sub === 'read' || sub === 'context') {
    const operation = /** @type {'read'|'context'} */ (sub);
    const options = parseReaderOptions(args.slice(1), operation);
    const inventory = buildHumanSurfaceInventory({
      root,
      policyRef: options.policy,
    });
    const project = humanSurfaceXinfaProject(inventory);
    const result = runSurfaceReader(
      root,
      inventory,
      project,
      operation,
      options,
    );
    stdout.write(
      `${JSON.stringify(result.receipt, null, options.json ? 2 : 0)}\n`,
    );
    return result.status;
  }
  if (sub === 'xinfa') {
    if (args[1] !== 'compile')
      throw new Error('docs xinfa requires the compile operation');
    const options = parseXinfaOptions(args.slice(2));
    if (options.submission === '-')
      throw new Error(
        'docs xinfa compile requires an auditable named submission',
      );
    const validation = validateDocumentationSubmissionBytes(
      readSubmission(root, options.submission),
      { root, checkFiles: true },
    );
    const validationReceipt = documentationValidationReceipt(
      validation,
      options.submission,
    );
    let delegated = null;
    if (validation.valid) delegated = runXinfaCompile(root, options);
    const passed =
      validation.valid &&
      delegated?.compileStatus === 0 &&
      delegated?.verifyStatus === 0 &&
      delegated?.verificationReceipt?.valid === true;
    const receipt = {
      schema: 'shifu.documentation-xinfa-adapter-receipt/v1',
      verdict: passed ? 'pass' : 'fail',
      qualifying: false,
      selfCertified: false,
      delegated: true,
      submission: {
        reference: options.submission,
        valid: validation.valid,
        roots: validation.projection?.roots || null,
        receipt: validationReceipt,
      },
      xinfa: delegated
        ? {
            operation: 'atlas compile',
            argv: delegated.compileArgs,
            compile: delegated.compileReceipt,
            verify: delegated.verificationReceipt,
          }
        : null,
    };
    if (options.json) stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    else if (passed && delegated)
      stdout.write(
        `delegated Xinfa Atlas: ${delegated.compileReceipt.atlas_root}\n`,
      );
    else
      stderr.write(
        'Shifu Xinfa adapter failed; use --json for the retained receipt\n',
      );
    return passed ? 0 : 1;
  }
  if (['help', '-h', '--help'].includes(sub)) {
    stderr.write(`${help()}\n`);
    return 0;
  }
  stderr.write(`${help()}\n`);
  return 2;
}
