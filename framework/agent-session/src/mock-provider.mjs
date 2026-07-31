#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const MOCK_AGENT_VERSION = '1.0.0';
export const MOCK_AGENT_SCENARIOS = Object.freeze([
  'complete',
  'question',
  'approval',
  'blocked',
  'crash',
  'multi-step',
]);
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

export function createMockAgentMachine({ scenario = 'multi-step' } = {}) {
  const selected = requireScenario(scenario);
  let phase = 'waiting-for-work';

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
      const input = String(raw)
        .replaceAll(BRACKETED_PASTE_START, '')
        .replaceAll(BRACKETED_PASTE_END, '')
        .replaceAll(/[\r\n]+/gu, '')
        .trim();

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
        if (selected === 'crash') {
          phase = 'ended';
          return result(
            [...work('start deterministic attempt'), 'MOCK CRASH: exit 23'],
            phase,
            23,
          );
        }
        if (selected === 'blocked') {
          phase = 'blocked';
          return result(
            [
              ...work('inspect required input'),
              'MOCK BLOCKED: required fixture is unavailable.',
            ],
            phase,
          );
        }
        if (selected === 'complete') {
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
        if (selected === 'approval') {
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
  });
  stdin.setEncoding('utf8');
  const emit = (transition) => {
    for (const line of transition.lines) stdout.write(`${line}\r\n`);
    if (transition.exitCode !== null) process.exitCode = transition.exitCode;
  };
  emit(machine.start());
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
