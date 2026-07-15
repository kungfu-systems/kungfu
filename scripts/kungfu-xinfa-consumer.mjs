#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {unknown} value */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** @param {unknown} value */
function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')}`;
}

/** @param {string} binary @param {string[]} args @param {string} cwd */
function xinfa(binary, args, cwd) {
  const result = spawnSync(binary, [...args, '--json'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Xinfa ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Xinfa ${args.join(' ')} did not emit JSON`);
  }
}

/** @param {Record<string, any>} projection */
function sharedParity(projection) {
  const parity = projection.parity;
  return {
    atlas_root: parity.atlas_root,
    project_id: parity.project_id,
    cut: parity.cut,
    cut_root: parity.cut_root,
    visibility: parity.visibility,
    parity_group: parity.route.parity_group,
    authority_root: parity.route.authority_root,
    status: parity.route.status,
    evidence: parity.evidence,
    atlas_omissions: parity.atlas_omissions,
    source_roots: parity.source_roots,
  };
}

/** @param {Record<string, any>} human */
function humanMarkdown(human) {
  const lines = [
    '# Xinfa Human Project View',
    '',
    `- Atlas root: \`${human.atlas_root}\``,
    `- Cut root: \`${human.cut_root}\``,
    `- Status: \`${human.status}\``,
    '',
    '## Reading Route',
    '',
  ];
  for (const step of human.steps || [])
    lines.push(
      `- hop ${step.hop}: \`${step.node}\` (${step.kind}, ${step.status}) — \`${step.source.path}\``,
    );
  lines.push(
    '',
    'This file is derived and must not be used as provider input.',
    '',
  );
  return lines.join('\n');
}

/** @param {string[]} args */
function parse(args) {
  const options = {
    atlas: '',
    output: '',
    xinfa: '',
    humanRoute: '',
    agentRoute: '',
    intent: '',
    task: '',
    role: 'implementer',
    budget: '4096',
    maxHops: '2',
  };
  const names = new Map([
    ['--atlas', 'atlas'],
    ['--output', 'output'],
    ['--xinfa', 'xinfa'],
    ['--human-route', 'humanRoute'],
    ['--agent-route', 'agentRoute'],
    ['--intent', 'intent'],
    ['--task', 'task'],
    ['--role', 'role'],
    ['--budget', 'budget'],
    ['--max-hops', 'maxHops'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = names.get(args[index]);
    if (!key)
      throw new Error(`unknown Kungfu Xinfa consumer option: ${args[index]}`);
    const value = args[++index];
    if (!value) throw new Error(`${args[index - 1]} requires a value`);
    options[key] = value;
  }
  for (const key of [
    'atlas',
    'output',
    'humanRoute',
    'agentRoute',
    'intent',
    'task',
  ])
    if (!options[key])
      throw new Error(`missing required consumer option: ${key}`);
  return options;
}

/** @param {ReturnType<typeof parse>} options @param {string} [root] */
export function consumeXinfaAtlas(options, root = ROOT) {
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
  const atlas = path.resolve(root, options.atlas);
  const output = path.resolve(root, options.output);
  if (fs.existsSync(output))
    throw new Error(
      'Kungfu Xinfa consumer refuses to overwrite an existing output directory',
    );

  const verified = xinfa(binary, ['atlas', 'verify', '--atlas', atlas], root);
  const human = xinfa(
    binary,
    [
      'read',
      '--atlas',
      atlas,
      '--route',
      options.humanRoute,
      '--intent',
      options.intent,
      '--surface',
      'human',
      '--max-hops',
      options.maxHops,
    ],
    root,
  );
  const agent = xinfa(
    binary,
    [
      'context',
      '--atlas',
      atlas,
      '--route',
      options.agentRoute,
      '--task',
      options.task,
      '--role',
      options.role,
      '--budget',
      options.budget,
    ],
    root,
  );
  const gui = xinfa(
    binary,
    [
      'read',
      '--atlas',
      atlas,
      '--route',
      options.humanRoute,
      '--intent',
      options.intent,
      '--surface',
      'gui',
      '--max-hops',
      options.maxHops,
    ],
    root,
  );
  const parity = sharedParity(human);
  if (
    JSON.stringify(stable(sharedParity(agent))) !==
      JSON.stringify(stable(parity)) ||
    JSON.stringify(stable(sharedParity(gui))) !== JSON.stringify(stable(parity))
  )
    throw new Error(
      'Human, Agent, and GUI Xinfa projections diverge on shared parity',
    );

  const projections = { human, agent, gui };
  const receipt = {
    schema: 'kungfu.xinfa-consumer-receipt/v1',
    verdict: 'pass',
    readOnly: true,
    compilerAuthority: 'xinfa-public-cli',
    atlasRoot: parity.atlas_root,
    cutRoot: parity.cut_root,
    parityRoot: digest(parity),
    projectionRoots: Object.fromEntries(
      Object.entries(projections).map(([surface, projection]) => [
        surface,
        projection.projection_root,
      ]),
    ),
    metrics: {
      humanHops: human.metrics?.hops_used ?? null,
      guiHops: gui.metrics?.hops_used ?? null,
      agentBudget: agent.budget?.max_tokens ?? null,
      agentTokens: agent.budget?.used_tokens ?? null,
      omissions: Object.fromEntries(
        Object.entries(projections).map(([surface, projection]) => [
          surface,
          projection.omissions?.length || 0,
        ]),
      ),
    },
    verify: verified,
  };

  const pending = `${output}.pending-${process.pid}`;
  fs.mkdirSync(pending, { recursive: false });
  try {
    fs.writeFileSync(
      path.join(pending, 'human.json'),
      `${JSON.stringify(human, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(pending, 'agent.json'),
      `${JSON.stringify(agent, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(pending, 'gui.json'),
      `${JSON.stringify(gui, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(pending, 'human.md'), humanMarkdown(human));
    fs.writeFileSync(
      path.join(pending, 'receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    fs.renameSync(pending, output);
  } catch (error) {
    fs.rmSync(pending, { recursive: true, force: true });
    throw error;
  }
  return receipt;
}

function main() {
  const receipt = consumeXinfaAtlas(parse(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[kungfu-xinfa] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
