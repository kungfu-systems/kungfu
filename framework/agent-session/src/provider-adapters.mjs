import { spawnSync } from 'node:child_process';

const PROVIDER_PROFILES = {
  codex: {
    adapterVersion: 'codex-tui/v1',
    instructionSubmitStrategy: 'separate-enter',
    instructionPasteAcknowledgement: 'first-line-visible',
    signatures: {
      blocked: [],
      approval: [
        [
          'codex.approval.project-trust',
          /do you trust the contents of this directory\?/iu,
        ],
        [
          'codex.approval.run-command',
          /would you like to run (?:this|the) command/iu,
        ],
        ['codex.approval.confirm', /press enter to confirm or esc to cancel/iu],
      ],
      busy: [
        [
          'codex.busy.interrupt-hint',
          /(?:esc to interrupt|\bWorking\b[\s\S]{0,80}\besc to inte\s*rupt\b)/iu,
        ],
      ],
      ready: [
        ['codex.ready.prompt', /^\s*›(?:\s|$)/mu],
        [
          'codex.ready.status-line',
          /^\s*gpt-[0-9][0-9A-Za-z._-]*\s+(?:low|medium|high|xhigh|max|ultra)\s+·\s+\S/mu,
        ],
      ],
    },
  },
  claude: {
    adapterVersion: 'claude-code-tui/v1',
    instructionSubmitStrategy: 'separate-enter',
    instructionPasteAcknowledgement: null,
    signatures: {
      blocked: [],
      approval: [
        ['claude.approval.needs-permission', /claude needs your permission/iu],
        [
          'claude.approval.permission-rule',
          /permission rule bash requires confirmation/iu,
        ],
        ['claude.approval.proceed', /do you want to proceed\?/iu],
        ['claude.approval.permission', /allow (?:this|the) action/iu],
        [
          'claude.approval.allow-command',
          /(?:do you want to )?allow (?:this |the )?(?:command|tool|action)/iu,
        ],
        [
          'claude.approval.run-command',
          /do you want to run (?:this|the) command/iu,
        ],
        [
          'claude.approval.bash-confirmation',
          /(?=[\s\S]*\bbash\b)(?=[\s\S]*\b(?:allow|approve|proceed)\b)/iu,
        ],
      ],
      busy: [['claude.busy.interrupt-hint', /esc to interrupt/iu]],
      ready: [
        ['claude.ready.prompt', /^\s*❯(?:\s|$)/mu],
        ['claude.ready.placeholder', /Try\s+"edit(?:\s|$)/iu],
        [
          'claude.ready.manual-placeholder',
          /(?=[\s\S]*\bTry\b)(?=[\s\S]*\bmanual\b)(?=[\s\S]*\bmode\b)/iu,
        ],
      ],
    },
  },
  synthetic: {
    adapterVersion: 'kungfu-mock-agent/v1',
    instructionSubmitStrategy: 'inline-enter',
    instructionPasteAcknowledgement: null,
    latestStateWins: true,
    signatures: {
      blocked: [['synthetic.blocked', /MOCK BLOCKED:/u]],
      approval: [['synthetic.approval', /MOCK NEEDS APPROVAL:/u]],
      busy: [['synthetic.busy', /MOCK WORKING:/u]],
      ready: [['synthetic.ready.prompt', /^\s*mock›(?:\s|$)/mu]],
    },
  },
};

const GENERIC_MODAL =
  /(?:\[(?:y|yes)\/(?:n|no)\]|\((?:y|yes)\/(?:n|no)\)|permission required|press enter|approve|allow)/iu;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const VOLATILE_ESCAPE = new RegExp(
  String.raw`${ESCAPE_CHARACTER}(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|${ESCAPE_CHARACTER}\\)|[()][0-2A-Z]|[=>78])`,
  'gu',
);
const VERSION = /([0-9]+\.[0-9]+\.[0-9]+)/u;
const NUL = String.fromCharCode(0);
const ESCAPE = String.fromCharCode(27);
const KEY_SEQUENCES = {
  Enter: '\r',
  Escape: '\u001b',
  Tab: '\t',
  ArrowUp: '\u001b[A',
  ArrowDown: '\u001b[B',
  ArrowRight: '\u001b[C',
  ArrowLeft: '\u001b[D',
  Backspace: '\u007f',
  y: 'y',
  n: 'n',
};

function requireProvider(provider) {
  const profile = PROVIDER_PROFILES[provider];
  if (!profile) {
    throw new Error(
      `provider adapter is unavailable for '${String(provider)}'`,
    );
  }
  return profile;
}

function cleanScreen(lines) {
  if (
    !Array.isArray(lines) ||
    !lines.every((line) => typeof line === 'string')
  ) {
    throw new Error('provider inspection requires redacted VT text-grid lines');
  }
  return lines.filter((line) => line.trim().length > 0).join('\n');
}

function matches(signatures, screen) {
  return signatures.find(([, pattern]) => pattern.test(screen))?.[0] ?? null;
}

function lastMatch(pattern, text) {
  const flags = `${pattern.flags.replaceAll('g', '')}g`;
  let latest = -1;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    latest = match.index;
  }
  return latest;
}

function latestVolatileState(profile, volatileTail) {
  if (typeof volatileTail !== 'string' || volatileTail.length === 0)
    return null;
  const resets = [
    `${ESCAPE_CHARACTER}[2J`,
    `${ESCAPE_CHARACTER}[?47h`,
    `${ESCAPE_CHARACTER}[?1049h`,
  ];
  const latestReset = Math.max(
    ...resets.map((marker) => volatileTail.lastIndexOf(marker)),
  );
  const currentTail =
    latestReset >= 0 ? volatileTail.slice(latestReset) : volatileTail;
  const text = currentTail.replace(VOLATILE_ESCAPE, ' ');
  const candidates = [
    ...profile.signatures.blocked.map(([signatureId, pattern]) => ({
      state: 'unknown',
      reason: 'provider-reported-blocked',
      signatureId,
      index: lastMatch(pattern, text),
    })),
    ...profile.signatures.approval.map(([signatureId, pattern]) => ({
      state: 'approval-needed',
      signatureId,
      index: lastMatch(pattern, text),
    })),
    ...profile.signatures.busy.map(([signatureId, pattern]) => ({
      state: 'busy',
      signatureId,
      index: lastMatch(pattern, text),
    })),
    ...profile.signatures.ready.map(([signatureId, pattern]) => ({
      state: 'ready',
      signatureId,
      index: lastMatch(pattern, text),
    })),
    {
      state: 'unknown',
      signatureId: null,
      index: lastMatch(GENERIC_MODAL, text),
    },
  ].filter((candidate) => candidate.index >= 0);
  candidates.sort((left, right) => right.index - left.index);
  return candidates[0] ?? null;
}

function currentScreenState(profile, screen) {
  if (profile.latestStateWins) {
    const candidates = [
      ...profile.signatures.blocked.map(([signatureId, pattern]) => ({
        state: 'unknown',
        reason: 'provider-reported-blocked',
        signatureId,
        index: lastMatch(pattern, screen),
      })),
      ...profile.signatures.approval.map(([signatureId, pattern]) => ({
        state: 'approval-needed',
        reason: null,
        signatureId,
        index: lastMatch(pattern, screen),
      })),
      ...profile.signatures.busy.map(([signatureId, pattern]) => ({
        state: 'busy',
        reason: null,
        signatureId,
        index: lastMatch(pattern, screen),
      })),
      ...profile.signatures.ready.map(([signatureId, pattern]) => ({
        state: 'ready',
        reason: null,
        signatureId,
        index: lastMatch(pattern, screen),
      })),
    ]
      .filter((candidate) => candidate.index >= 0)
      .sort((left, right) => right.index - left.index);
    if (candidates[0]) {
      const latest = candidates[0];
      return {
        state: latest.state,
        reason: latest.reason,
        signatureId: latest.signatureId,
      };
    }
  }
  const blocked = matches(profile.signatures.blocked, screen);
  if (blocked) {
    return {
      state: 'unknown',
      reason: 'provider-reported-blocked',
      signatureId: blocked,
    };
  }
  const approval = matches(profile.signatures.approval, screen);
  if (approval) {
    return { state: 'approval-needed', signatureId: approval };
  }
  const busy = matches(profile.signatures.busy, screen);
  if (busy) return { state: 'busy', signatureId: busy };
  const ready = matches(profile.signatures.ready, screen);
  if (ready) return { state: 'ready', signatureId: ready };
  if (GENERIC_MODAL.test(screen)) {
    return { state: 'unknown', signatureId: null };
  }
  return null;
}

function interactionResult({
  state,
  signatureId = null,
  reason = null,
  compatible,
}) {
  return {
    schema: 'kungfu.agent-session.provider-interaction/v1',
    state,
    compatible,
    signatureIds: signatureId ? [signatureId] : [],
    reason,
    rawHumanFallback: true,
  };
}

export function parseProviderVersion(provider, output) {
  requireProvider(provider);
  const text = String(output ?? '').trim();
  return (
    (text.match(VERSION)?.[1] ?? text.split(/\r?\n/u, 1)[0] ?? 'unknown') ||
    'unknown'
  );
}

export function probeProviderVersion({
  provider,
  executable,
  env,
  run = spawnSync,
}) {
  requireProvider(provider);
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('provider version probe requires an executable');
  }
  let result;
  try {
    result = run(executable, ['--version'], {
      encoding: 'utf8',
      env: env ?? {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
      },
      shell: false,
      timeout: 10_000,
    });
  } catch (error) {
    result = { status: null, stdout: '', stderr: '', error };
  }
  const version =
    parseProviderVersion(provider, result.stdout || result.stderr) || 'unknown';
  const adapter = createProviderAdapter({ provider, version });
  return {
    schema: 'kungfu.agent-session.provider-version-probe/v1',
    provider,
    version,
    adapterVersion: adapter.adapterVersion,
    compatible: adapter.compatible,
    tested: adapter.tested,
    warning: result.error
      ? `${provider} version probe failed: ${result.error.message ?? String(result.error)}`
      : result.status === 0
        ? null
        : `${provider} version probe exited with ${String(result.status)}`,
    versionAdmission: 'diagnostic-only',
    inspectedPrivateState: false,
  };
}

function inspectProviderInteraction(
  { provider, profile },
  { lines, volatileTail, lifecycleState, inputAdmission, foreground },
) {
  if (lifecycleState === 'ended' || inputAdmission === 'closed') {
    return interactionResult({ state: 'ended', compatible: true });
  }
  if (foreground?.provider !== provider) {
    return interactionResult({
      state: 'unknown',
      reason: 'foreground-provider-mismatch',
      compatible: false,
    });
  }
  const screen = cleanScreen(lines);
  const reviewReadyIndex = screen.lastIndexOf('MOCK READY FOR REVIEW:');
  const promptAfterReviewIndex = lastMatch(/^\s*mock›(?:\s|$)/mu, screen);
  if (
    provider === 'synthetic' &&
    reviewReadyIndex >= 0 &&
    promptAfterReviewIndex > reviewReadyIndex
  ) {
    return interactionResult({
      state: 'ready',
      signatureId: 'synthetic.ready.review',
      compatible: true,
    });
  }
  const current = currentScreenState(profile, screen);
  if (current) {
    return interactionResult({
      state: current.state,
      signatureId: current.signatureId,
      reason:
        current.reason ??
        (current.state === 'unknown' ? 'unrecognized-modal-state' : null),
      compatible: true,
    });
  }
  const latest = latestVolatileState(profile, volatileTail);
  if (latest) {
    return interactionResult({
      state: latest.state,
      signatureId: latest.signatureId,
      reason:
        latest.reason ??
        (latest.state === 'unknown' ? 'unrecognized-modal-state' : null),
      compatible: true,
    });
  }
  return interactionResult({
    state: 'unknown',
    reason: GENERIC_MODAL.test(screen)
      ? 'unrecognized-modal-state'
      : 'no-supported-state-signature',
    compatible: true,
  });
}

function encodeProviderInstruction(separateInstructionSubmit, text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('instruction text must be non-empty');
  }
  if (text.includes(NUL) || text.includes(ESCAPE)) {
    throw new Error('instruction text cannot contain NUL or escape bytes');
  }
  if (/(?:\r|\n)$/u.test(text)) {
    throw new Error('instruction text cannot end with Enter');
  }
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw new Error('instruction exceeds the 64 KiB atomic paste limit');
  }
  const submit = separateInstructionSubmit ? '' : '\r';
  return `\u001b[200~${text}\u001b[201~${submit}`;
}

function acknowledgesProviderPaste(
  acknowledgedInstructionPaste,
  { lines, text },
) {
  if (!acknowledgedInstructionPaste) return true;
  const firstLine = String(text).split(/\r?\n/u, 1)[0].trim();
  const visiblePrefix = [...firstLine].slice(0, 40).join('');
  const screen = cleanScreen(lines);
  const pasteLengths = new Set([
    String(text).length,
    [...String(text)].length,
    Buffer.byteLength(String(text), 'utf8'),
  ]);
  const collapsedPasteVisible = [...pasteLengths].some((length) =>
    screen.includes(`[Pasted Content ${String(length)} chars]`),
  );
  return (
    collapsedPasteVisible ||
    (visiblePrefix.length > 0 && screen.includes(visiblePrefix))
  );
}

function encodeProviderKey(key) {
  const sequence = KEY_SEQUENCES[key];
  if (sequence === undefined) {
    throw new Error(`unsupported semantic key '${String(key)}'`);
  }
  return sequence;
}

export function createProviderAdapter({ provider, version = 'unknown' }) {
  const profile = requireProvider(provider);
  const providerVersion =
    typeof version === 'string' && version.length > 0 ? version : 'unknown';
  const separateInstructionSubmit =
    profile.instructionSubmitStrategy === 'separate-enter';
  const acknowledgedInstructionPaste =
    profile.instructionPasteAcknowledgement === 'first-line-visible';
  return Object.freeze({
    schema: 'kungfu.agent-session.provider-adapter/v1',
    provider,
    providerVersion,
    adapterVersion: profile.adapterVersion,
    instructionSubmitStrategy: separateInstructionSubmit
      ? 'separate-enter'
      : 'inline-enter',
    instructionSubmitData: separateInstructionSubmit ? '\r' : null,
    instructionSubmitDelayMilliseconds: separateInstructionSubmit ? 50 : 0,
    instructionPasteAcknowledgement: acknowledgedInstructionPaste
      ? 'first-line-visible'
      : null,
    instructionPasteAcknowledgementPollMilliseconds: 25,
    instructionPasteAcknowledgementRetryMilliseconds: 250,
    instructionPasteAcknowledgementAttempts: 1,
    compatible: true,
    tested: true,
    knownLimits: [
      'provider-versions-are-diagnostic-only',
      'tui-signatures-may-drift-and-unknown-layouts-fail-closed',
      'instruction-paste-acknowledgement-is-best-effort',
      'delivery-receipt-does-not-prove-provider-understanding',
      'approval-and-deny-require-stage-6-real-provider-dogfood',
      'interrupt-proves-signal-delivery-not-provider-outcome',
    ],
    inspect: inspectProviderInteraction.bind(null, { provider, profile }),
    encodeInstruction: encodeProviderInstruction.bind(
      null,
      separateInstructionSubmit,
    ),
    acknowledgesInstructionPaste: acknowledgesProviderPaste.bind(
      null,
      acknowledgedInstructionPaste,
    ),
    encodeKey: encodeProviderKey,
  });
}

export function providerAdapterMatrix() {
  return Object.entries(PROVIDER_PROFILES).map(([provider, profile]) => ({
    provider,
    adapterVersion: profile.adapterVersion,
    versionPolicy: 'diagnostic-only; live signatures fail closed',
    interactionQualification: 'version-neutral-signature-gated',
    privateTranscriptRequired: false,
  }));
}
