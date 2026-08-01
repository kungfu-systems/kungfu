#!/usr/bin/env node

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MOCK_AGENT_VERSION = '1.1.0';
export const MOCK_AGENT_SCENARIOS = Object.freeze([
  'complete',
  'deliverable',
  'question',
  'approval',
  'blocked',
  'crash',
  'disconnect',
  'multi-step',
  'recovery-story',
  'review-fit',
]);
export const MOCK_DELIVERABLE_PATH =
  'deliverables/mock-agent-recovery-report.md';
const ESCAPE = String.fromCharCode(27);
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;

function requireScenario(value) {
  if (!MOCK_AGENT_SCENARIOS.includes(value)) {
    throw new Error(
      `unknown Mock Agent scenario '${value}'; expected ${MOCK_AGENT_SCENARIOS.join(', ')}`,
    );
  }
  return value;
}

function result(lines, phase, exitCode = null) {
  return { lines, phase, exitCode };
}

function cleanInput(raw) {
  return String(raw)
    .replaceAll(BRACKETED_PASTE_START, '')
    .replaceAll(BRACKETED_PASTE_END, '')
    .trim();
}

function reviewRequest(prompt) {
  const criteriaBlock = prompt.match(
    /Acceptance criteria:\s*\n([\s\S]*?)\n\s*\nRead the primary/iu,
  );
  const primary = prompt.match(
    /Primary evidence:\s+(.+?)\s+\((sha256:[^)]+)\)/u,
  );
  const criteria = (criteriaBlock?.[1] ?? '')
    .split(/\r?\n/gu)
    .map((line) => line.replace(/^\s*-\s+/u, '').trim())
    .filter(Boolean);
  return {
    criteria,
    primaryPath: primary?.[1]?.trim() ?? '',
    primaryRoot: primary?.[2]?.trim() ?? '',
  };
}

function mockReviewLine(prompt, inspectEvidence) {
  const request = reviewRequest(prompt);
  const evidence = inspectEvidence(request.primaryPath);
  const passed =
    request.criteria.length > 0 &&
    Boolean(request.primaryRoot) &&
    evidence.ok === true;
  const evidenceText = passed
    ? `Mock qualification read ${request.primaryPath} (${request.primaryRoot}); ${evidence.bytes} bytes retained.`
    : `Mock qualification could not read retained primary evidence: ${request.primaryPath || '(missing path)'}.`;
  return `KUNGFU_REVIEW_RESULT ${JSON.stringify({
    verdict: passed ? 'fit' : 'revision-required',
    summary: passed
      ? `Mock qualification covered ${request.criteria.length} exact acceptance criteria.`
      : 'Mock qualification could not verify retained evidence.',
    criteria: request.criteria.map((criterion) => ({
      criterion,
      passed,
      evidence: evidenceText,
    })),
    evidenceRequests: passed
      ? []
      : ['Provide readable retained primary evidence.'],
  })}`;
}

export function createMockAgentMachine({
  scenario = 'multi-step',
  effects = {},
} = {}) {
  const selected = requireScenario(scenario);
  let phase = 'waiting-for-work';
  const writeDeliverable =
    effects.writeDeliverable ?? (() => ({ path: MOCK_DELIVERABLE_PATH }));
  const inspectEvidence =
    effects.inspectEvidence ?? (() => ({ ok: true, bytes: 1 }));
  const nextRecoveryStep = effects.nextRecoveryStep ?? (() => 'deliverable');

  const ready = (message) => result([message, 'mock› '], phase);
  const review = () => {
    phase = 'ready-for-review';
    return ready('MOCK READY FOR REVIEW: deterministic changes are available.');
  };
  const work = (label) => [
    `MOCK WORKING: ${label}`,
    '  tool · inspect workspace',
    '  output · deterministic fixture observed',
    '  agent · evidence retained; no completion claimed',
  ];

  return Object.freeze({
    scenario: selected,
    start() {
      return ready(
        `Kungfu Mock Agent ${MOCK_AGENT_VERSION} · scenario ${selected}`,
      );
    },
    input(raw) {
      const prompt = cleanInput(raw);
      const input = prompt.replaceAll(/[\r\n]+/gu, '').trim();

      if (input === '__exit__') {
        phase = 'ended';
        return result(['MOCK ENDED: requested by controller.'], phase, 0);
      }
      if (input === '__reset__') {
        phase = 'waiting-for-work';
        return ready('MOCK RESET: waiting for Work.');
      }

      if (phase === 'waiting-for-work') {
        phase = 'working';
        const behavior =
          selected === 'recovery-story' ? nextRecoveryStep() : selected;
        if (behavior === 'crash') {
          phase = 'ended';
          return result(
            [...work('start deterministic attempt'), 'MOCK CRASH: exit 23'],
            phase,
            23,
          );
        }
        if (behavior === 'disconnect') {
          phase = 'ended';
          return result(
            [
              ...work('stream deterministic attempt'),
              'MOCK DISCONNECTED: transport closed before completion; exit 75',
            ],
            phase,
            75,
          );
        }
        if (behavior === 'blocked') {
          phase = 'blocked';
          return result(
            [
              ...work('inspect required input'),
              'MOCK BLOCKED: required fixture is unavailable.',
            ],
            phase,
          );
        }
        if (behavior === 'complete') {
          phase = 'ready-for-review';
          return result(
            [
              ...work('complete Work'),
              'MOCK READY FOR REVIEW: deterministic changes are available.',
              'mock› ',
            ],
            phase,
          );
        }
        if (behavior === 'deliverable') {
          const written = writeDeliverable();
          phase = 'ended';
          return result(
            [
              ...work('write bounded Project deliverable'),
              `MOCK FILE WRITTEN: ${written.path}`,
              'MOCK READY FOR REVIEW: deterministic changes are available.',
              'mock› ',
            ],
            phase,
            0,
          );
        }
        if (behavior === 'review-fit') {
          phase = 'ended';
          return result(
            [
              ...work('read retained Project evidence in qualification mode'),
              mockReviewLine(prompt, inspectEvidence),
            ],
            phase,
            0,
          );
        }
        if (behavior === 'approval') {
          phase = 'needs-approval';
          return result(
            [
              ...work('prepare bounded effect'),
              'MOCK NEEDS APPROVAL: allow the deterministic effect? [y/N]',
            ],
            phase,
          );
        }
        phase = 'needs-answer';
        return result(
          [
            ...work('analyze Work'),
            'MOCK NEEDS ANSWER: choose alpha or beta.',
            'mock› ',
          ],
          phase,
        );
      }

      if (phase === 'needs-answer') {
        if (selected === 'multi-step') {
          phase = 'needs-approval';
          return result(
            [
              `MOCK ANSWER RECEIVED: ${input || '(empty)'}`,
              ...work('prepare bounded effect'),
              'MOCK NEEDS APPROVAL: allow the deterministic effect? [y/N]',
            ],
            phase,
          );
        }
        return review();
      }

      if (phase === 'needs-approval') {
        if (/^(?:y|yes|approve)$/iu.test(input)) return review();
        phase = 'blocked';
        return result(
          ['MOCK BLOCKED: deterministic effect was denied.'],
          phase,
        );
      }

      if (phase === 'ready-for-review')
        return ready('MOCK STILL READY FOR REVIEW.');
      if (phase === 'blocked')
        return result(['MOCK BLOCKED: start a new attempt.'], phase);
      return result([], phase);
    },
    state() {
      return phase;
    },
  });
}

function parseScenario(argv, env) {
  const index = argv.indexOf('--scenario');
  return requireScenario(
    index >= 0
      ? argv[index + 1]
      : (env.KUNGFU_MOCK_AGENT_SCENARIO ?? 'multi-step'),
  );
}

function promptArgument(argv) {
  const scenarioIndex = argv.indexOf('--scenario');
  const start = scenarioIndex >= 0 ? scenarioIndex + 2 : 0;
  return argv.slice(start).join(' ').trim();
}

function workspaceEffects(env) {
  const workspaceRoot = path.resolve(
    env.KUNGFU_WORKSPACE_ROOT || process.cwd(),
  );
  const runtimeRoot = env.KUNGFU_CONTROL_RUNTIME_DIR
    ? path.resolve(env.KUNGFU_CONTROL_RUNTIME_DIR)
    : null;
  const isInside = (root, candidate) =>
    candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const resolveInsideWorkspace = (relativePath) => {
    const candidate = path.isAbsolute(relativePath)
      ? path.resolve(relativePath)
      : path.resolve(workspaceRoot, relativePath);
    if (
      !isInside(workspaceRoot, candidate) &&
      !(runtimeRoot && isInside(runtimeRoot, candidate))
    ) {
      throw new Error('Mock Agent evidence path escapes the workspace');
    }
    return candidate;
  };
  return {
    writeDeliverable() {
      const target = resolveInsideWorkspace(MOCK_DELIVERABLE_PATH);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        [
          '# Mock Agent recovery report',
          '',
          'This deterministic qualification fixture records a realistic Work recovery story.',
          '',
          '- Attempt 1: the transport disconnected before completion (exit 75).',
          '- Attempt 2: the Agent process crashed before settlement (exit 23).',
          '- Recovery: Kungfu retained both failed attempts and reopened the same Work.',
          '- Completion: a new Mock Agent attempt produced this reviewable deliverable.',
          '- Authority: process exit and Agent self-report do not settle Work; native review does.',
          '',
        ].join('\n'),
        'utf8',
      );
      return { path: MOCK_DELIVERABLE_PATH };
    },
    inspectEvidence(relativePath) {
      if (!relativePath) return { ok: false, bytes: 0 };
      const target = resolveInsideWorkspace(relativePath);
      if (!existsSync(target)) return { ok: false, bytes: 0 };
      return { ok: true, bytes: readFileSync(target).byteLength };
    },
    nextRecoveryStep() {
      if (!runtimeRoot) {
        throw new Error('Mock recovery story requires a control runtime root');
      }
      let workRef;
      try {
        workRef = JSON.parse(env.KUNGFU_WORK_REF || '{}');
      } catch {
        workRef = {};
      }
      const entityId = String(workRef.entityId || 'unbound-work');
      const identity = crypto
        .createHash('sha256')
        .update(entityId)
        .digest('hex')
        .slice(0, 24);
      const fixtureRoot = path.join(runtimeRoot, 'mock-agent-fixtures');
      const statePath = path.join(fixtureRoot, `recovery-${identity}.json`);
      let attempt = 0;
      if (existsSync(statePath)) {
        try {
          attempt = Number(JSON.parse(readFileSync(statePath, 'utf8')).attempt);
        } catch {
          attempt = 0;
        }
      }
      const nextAttempt = Number.isSafeInteger(attempt) ? attempt + 1 : 1;
      mkdirSync(fixtureRoot, { recursive: true });
      writeFileSync(
        statePath,
        `${JSON.stringify({ schema: 'kungfu.mock-agent.recovery-state/v1', attempt: nextAttempt })}\n`,
        'utf8',
      );
      return nextAttempt === 1
        ? 'disconnect'
        : nextAttempt === 2
          ? 'crash'
          : 'deliverable';
    },
  };
}

export async function runMockAgent({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (argv.includes('--version')) {
    stdout.write(`kungfu-mock-agent ${MOCK_AGENT_VERSION}\n`);
    return 0;
  }
  const machine = createMockAgentMachine({
    scenario: parseScenario(argv, env),
    effects: workspaceEffects(env),
  });
  stdin.setEncoding('utf8');
  const emit = (transition) => {
    for (const line of transition.lines) stdout.write(`${line}\r\n`);
    if (transition.exitCode !== null) {
      process.exitCode = transition.exitCode;
      stdin.pause();
      stdin.removeAllListeners('data');
    }
  };
  emit(machine.start());
  const prompt = promptArgument(argv);
  if (prompt) {
    const transition = machine.input(prompt);
    emit(transition);
    return transition.exitCode ?? 0;
  }
  stdin.on('data', (data) => emit(machine.input(data)));
  return null;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runMockAgent().catch((error) => {
    process.stderr.write(`kungfu-mock-agent: ${error.message}\n`);
    process.exitCode = 2;
  });
}
