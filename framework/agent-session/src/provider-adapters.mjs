import { spawnSync } from 'node:child_process';

const PROVIDER_PROFILES = {
  codex: {
    adapterVersion: 'codex-tui/v1',
    supportedVersion: /^0\.144\.[0-9]+$/u,
    testedVersions: ['0.144.3'],
    signatures: {
      approval: [
        [
          'codex.approval.run-command',
          /would you like to run (?:this|the) command/iu,
        ],
        ['codex.approval.confirm', /press enter to confirm or esc to cancel/iu],
      ],
      busy: [['codex.busy.interrupt-hint', /esc to interrupt/iu]],
      ready: [['codex.ready.prompt', /^\s*›(?:\s|$)/mu]],
    },
  },
  claude: {
    adapterVersion: 'claude-code-tui/v1',
    supportedVersion: /^2\.1\.[0-9]+$/u,
    testedVersions: ['2.1.209'],
    signatures: {
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
  const version = String(output ?? '').match(VERSION)?.[1] ?? null;
  if (!version) {
    throw new Error(`${provider} --version did not return a semantic version`);
  }
  return version;
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
  const result = run(executable, ['--version'], {
    encoding: 'utf8',
    env: env ?? {
      PATH: process.env.PATH,
      LANG: 'C',
      LC_ALL: 'C',
    },
    shell: false,
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${provider} version probe exited with ${String(result.status)}`,
    );
  }
  const version = parseProviderVersion(
    provider,
    result.stdout || result.stderr,
  );
  const adapter = createProviderAdapter({ provider, version });
  return {
    schema: 'kungfu.agent-session.provider-version-probe/v1',
    provider,
    version,
    adapterVersion: adapter.adapterVersion,
    compatible: adapter.compatible,
    tested: adapter.tested,
    inspectedPrivateState: false,
  };
}

export function createProviderAdapter({ provider, version }) {
  const profile = requireProvider(provider);
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('provider adapter requires an explicit version');
  }
  const compatible = profile.supportedVersion.test(version);
  const tested = profile.testedVersions.includes(version);
  return Object.freeze({
    schema: 'kungfu.agent-session.provider-adapter/v1',
    provider,
    providerVersion: version,
    adapterVersion: profile.adapterVersion,
    instructionSubmitStrategy:
      provider === 'claude' ? 'separate-enter' : 'inline-enter',
    instructionSubmitData: provider === 'claude' ? '\r' : null,
    instructionSubmitDelayMilliseconds: provider === 'claude' ? 50 : 0,
    compatible,
    tested,
    knownLimits: [
      'tui-signatures-are-versioned-and-may-drift',
      'delivery-receipt-does-not-prove-provider-understanding',
      'approval-and-deny-require-stage-6-real-provider-dogfood',
      'interrupt-proves-signal-delivery-not-provider-outcome',
    ],
    inspect({
      lines,
      volatileTail,
      lifecycleState,
      inputAdmission,
      foreground,
    }) {
      if (lifecycleState === 'ended' || inputAdmission === 'closed') {
        return interactionResult({ state: 'ended', compatible });
      }
      if (foreground?.provider !== provider) {
        return interactionResult({
          state: 'unknown',
          reason: 'foreground-provider-mismatch',
          compatible: false,
        });
      }
      if (!compatible) {
        return interactionResult({
          state: 'unknown',
          reason: 'adapter-version-drift',
          compatible: false,
        });
      }
      const screen = cleanScreen(lines);
      const current = currentScreenState(profile, screen);
      if (current) {
        return interactionResult({
          state: current.state,
          signatureId: current.signatureId,
          reason:
            current.state === 'unknown' ? 'unrecognized-modal-state' : null,
          compatible: true,
        });
      }
      const latest = latestVolatileState(profile, volatileTail);
      if (latest) {
        return interactionResult({
          state: latest.state,
          signatureId: latest.signatureId,
          reason:
            latest.state === 'unknown' ? 'unrecognized-modal-state' : null,
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
    },
    encodeInstruction(text) {
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
      const submit = provider === 'claude' ? '' : '\r';
      return `\u001b[200~${text}\u001b[201~${submit}`;
    },
    encodeKey(key) {
      const sequence = KEY_SEQUENCES[key];
      if (sequence === undefined) {
        throw new Error(`unsupported semantic key '${String(key)}'`);
      }
      return sequence;
    },
  });
}

export function providerAdapterMatrix() {
  return Object.entries(PROVIDER_PROFILES).map(([provider, profile]) => ({
    provider,
    adapterVersion: profile.adapterVersion,
    testedVersions: [...profile.testedVersions],
    versionPolicy: 'exact-minor-family; unrecognized versions fail visible',
    privateTranscriptRequired: false,
  }));
}
