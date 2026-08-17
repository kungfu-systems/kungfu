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
  'recovery-delivery',
  'recovery-story',
  'review-fit',
]);
export const MOCK_DELIVERABLE_PATH =
  'deliverables/mock-agent-recovery-report.md';
export const MOCK_RECOVERY_STORY_DELIVERABLE_PATH =
  'deliverables/launch-brief.md';

export function mockRecoveryStoryDeliverable() {
  return [
    '# Kungfu launch brief',
    '',
    '## Who it is for',
    '',
    'Kungfu is for developers coordinating long-running coding-agent work.',
    '',
    '## Why it matters',
    '',
    'Kungfu keeps durable local Work across agent sessions so developers can recover the current Work after an interrupted session and require independent review before completion.',
    '',
    '## Confirmed benefits',
    '',
    '- Developers can recover the current Work after an interrupted session.',
    '- Completion requires independent review.',
    '',
    '## Open questions',
    '',
    '- Public release date',
    '- Pricing',
    '- Supported integrations',
    '',
    '## Validation evidence',
    '',
    '- Audience and durable-work claims: `inputs/product-notes.md`.',
    '- Confirmed recovery and independent-review benefits: `inputs/customer-feedback.md`.',
    '- Release date, pricing, and integrations remain open: `inputs/release-facts.md`.',
    '',
    '## Unresolved risks',
    '',
    '- Publication remains blocked until the launch owner resolves the release date, pricing, and supported integrations.',
    '',
    '## Next action',
    '',
    'Ask the launch owner to review this brief and resolve the release date, pricing, and integration questions before publication.',
    '',
  ].join('\n');
}
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

export function createMockAgentInputFramer(onInput) {
  if (typeof onInput !== 'function') {
    throw new Error('Mock Agent input framer requires an input handler');
  }
  let pending = '';
  const consumeTerminator = (offset) => {
    if (pending.startsWith('\r\n', offset)) return offset + 2;
    if (pending[offset] === '\r' || pending[offset] === '\n') return offset + 1;
    return -1;
  };
  return Object.freeze({
    push(data) {
      pending += String(data);
      while (pending.length > 0) {
        const pasteStart = pending.indexOf(BRACKETED_PASTE_START);
        if (pasteStart >= 0) {
          const pasteEnd = pending.indexOf(
            BRACKETED_PASTE_END,
            pasteStart + BRACKETED_PASTE_START.length,
          );
          if (pasteEnd < 0) return;
          const frameEnd = pasteEnd + BRACKETED_PASTE_END.length;
          const nextOffset = consumeTerminator(frameEnd);
          if (nextOffset < 0) return;
          const frame = pending.slice(pasteStart, frameEnd);
          pending = pending.slice(nextOffset);
          onInput(frame);
          continue;
        }
        const terminator = pending.search(/[\r\n]/u);
        if (terminator < 0) return;
        const nextOffset = consumeTerminator(terminator);
        const frame = pending.slice(0, terminator);
        pending = pending.slice(nextOffset);
        onInput(frame);
      }
    },
  });
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
    ? `The Mock Reviewer read ${request.primaryPath} (${request.primaryRoot}); ${evidence.bytes} bytes were available for review.`
    : `The Mock Reviewer could not read the retained primary evidence: ${request.primaryPath || '(missing path)'}.`;
  return `KUNGFU_REVIEW_RESULT ${JSON.stringify({
    verdict: passed ? 'fit' : 'revision-required',
    summary: passed
      ? `The independent Mock Reviewer checked ${request.criteria.length} exact acceptance criteria against the retained deliverable.`
      : 'The independent Mock Reviewer could not verify the retained deliverable.',
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
  const recoveryScenario =
    selected === 'recovery-story' || selected === 'recovery-delivery';
  let phase = 'waiting-for-work';
  const writeDeliverable =
    effects.writeDeliverable ??
    ((relativePath = MOCK_DELIVERABLE_PATH) => ({ path: relativePath }));
  const inspectEvidence =
    effects.inspectEvidence ?? (() => ({ ok: true, bytes: 1 }));
  const nextRecoveryStep = effects.nextRecoveryStep ?? (() => 'deliverable');

  const ready = (message) => result([message, 'mock› '], phase);
  const review = () => {
    phase = 'ready-for-review';
    return result(
      [
        'MOCK VALIDATION: the deterministic fixture completed after the retained answer and explicit approval.',
        'MOCK UNRESOLVED RISKS: none inside this bounded qualification scenario.',
        'MOCK READY FOR REVIEW: deterministic changes are available.',
        'mock› ',
      ],
      phase,
    );
  };
  const work = (label) => [
    `MOCK WORKING: ${label}`,
    '  tool · inspect workspace',
    '  output · deterministic fixture observed',
    '  agent · evidence retained; no completion claimed',
  ];
  const recoveryAttempt = (behavior) => {
    if (behavior === 'disconnect') {
      return [
        'MOCK WORKING: reading the Starter Project',
        '  agent · I found the Work definition and three source notes.',
        '  tool · read product notes and customer feedback',
        '  agent · I am separating confirmed facts from open questions.',
      ];
    }
    if (behavior === 'crash') {
      return [
        'MOCK WORKING: resuming the retained launch-brief Work',
        '  agent · I recovered the objective and checks without relying on prior chat.',
        '  tool · read release facts',
        '  agent · I started drafting three evidence-backed benefits.',
      ];
    }
    return [
      'MOCK WORKING: completing the same launch brief',
      '  agent · I re-read the Project sources and original checks.',
      '  tool · write deliverables/launch-brief.md',
      '  agent · I kept release date, pricing, and integrations open.',
    ];
  };

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
          selected === 'recovery-story'
            ? nextRecoveryStep()
            : selected === 'recovery-delivery'
              ? 'deliverable'
              : selected;
        if (behavior === 'crash') {
          phase = 'ended';
          return result(
            [
              ...(recoveryScenario
                ? recoveryAttempt('crash')
                : work('start deterministic attempt')),
              'MOCK CRASH: the process stopped before submitting the draft; exit 23',
            ],
            phase,
            23,
          );
        }
        if (behavior === 'disconnect') {
          phase = 'ended';
          return result(
            [
              ...(recoveryScenario
                ? recoveryAttempt('disconnect')
                : work('stream deterministic attempt')),
              'MOCK DISCONNECTED: the transport closed before I wrote the brief; exit 75',
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
          const written = writeDeliverable(
            recoveryScenario
              ? MOCK_RECOVERY_STORY_DELIVERABLE_PATH
              : MOCK_DELIVERABLE_PATH,
          );
          phase = 'ended';
          return result(
            [
              ...(recoveryScenario
                ? recoveryAttempt('deliverable')
                : work('write bounded Project deliverable')),
              `MOCK FILE WRITTEN: ${written.path}`,
              'MOCK READY FOR REVIEW: Agent does not approve its own Work.',
            ],
            phase,
            0,
          );
        }
        if (behavior === 'review-fit') {
          const request = reviewRequest(prompt);
          phase = 'ended';
          return result(
            [
              'MOCK WORKING: reviewing the launch brief independently',
              '  agent · I received no prior transcript and opened retained evidence read-only.',
              `  tool · read ${request.primaryPath || 'the retained primary evidence'}`,
              '  agent · I checked every acceptance criterion against the file.',
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
    writeDeliverable(relativePath = MOCK_DELIVERABLE_PATH) {
      const target = resolveInsideWorkspace(relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      const content =
        relativePath === MOCK_RECOVERY_STORY_DELIVERABLE_PATH
          ? mockRecoveryStoryDeliverable().split('\n')
          : [
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
            ];
      writeFileSync(target, content.join('\n'), 'utf8');
      return { path: relativePath };
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
  const input = createMockAgentInputFramer((frame) =>
    emit(machine.input(frame)),
  );
  stdin.on('data', (data) => input.push(data));
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
