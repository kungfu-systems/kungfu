import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  accessSync,
  chmodSync,
  cpSync,
  existsSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { CODEX_APP_SERVER_FEATURE_FLAG } from '../framework/agent-session/src/codex-app-server-product.mjs';
import { createDetachedAgentSessionHost } from '../framework/agent-session/src/product-client.mjs';

const PROFILE_ROOT = `sha256:${'8'.repeat(64)}`;
const PRIVATE_ENV_NAMES = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
const CLAUDE_APPROVAL_SETTINGS = JSON.stringify({
  permissions: { ask: ['Bash'] },
  sandbox: { autoAllowBashIfSandboxed: false },
});
const require = createRequire(
  new URL('../framework/agent-session/package.json', import.meta.url),
);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function positiveIntegerArgument(name, fallback) {
  const value = argument(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const convergenceTimeoutMilliseconds = positiveIntegerArgument(
  '--convergence-timeout-ms',
  90_000,
);

async function eventually(
  probe,
  label,
  timeoutMs = convergenceTimeoutMilliseconds,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `${label} did not converge${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function environment() {
  const selected = {};
  for (const name of [
    'HOME',
    'PATH',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    ...PRIVATE_ENV_NAMES,
  ]) {
    if (typeof process.env[name] === 'string')
      selected[name] = process.env[name];
  }
  selected.TERM = 'xterm-256color';
  selected.LANG ??= 'C.UTF-8';
  return selected;
}

function providerArguments(provider, { claudeModel, claudeEffort }) {
  return provider === 'codex'
    ? [
        '--no-alt-screen',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'untrusted',
      ]
    : [
        '--safe-mode',
        '--permission-mode',
        'manual',
        '--settings',
        CLAUDE_APPROVAL_SETTINGS,
        ...(claudeModel ? ['--model', claudeModel] : []),
        ...(claudeEffort ? ['--effort', claudeEffort] : []),
      ];
}

function prepareCheckoutNodePty(runtimeDir) {
  const source = path.dirname(require.resolve('node-pty/package.json'));
  const target = path.join(runtimeDir, 'qualification-node-pty');
  cpSync(source, target, { recursive: true });
  if (process.platform === 'darwin') {
    const helper = path.join(
      target,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    chmodSync(helper, (statSync(helper).mode & 0o777) | 0o111);
  }
  return path.join(target, 'lib', 'index.js');
}

async function control(host, ref, operation, payload, automatic = true) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const plan = await host.invoke({
      operation: 'plan-control',
      controlOperation: operation,
      session: ref,
      payload,
    });
    try {
      return await host.invoke({
        operation,
        actorId: 'qualification-controller',
        client: 'gui',
        plan,
        expectedPlanRoot: plan.root,
        payload,
        automatic,
      });
    } catch (error) {
      if (error.code !== 'stale_plan' || attempt === 3) throw error;
    }
  }
  throw new Error('unreachable control planning state');
}

async function waitForReady(host, ref, provider, label) {
  let temporaryTrustAccepted = false;
  let observedTrustTokens = [];
  let observedReadyTokens = [];
  let adapterReason = null;
  let lastSafeStatus = null;
  let status;
  try {
    status = await eventually(async () => {
      const current = await host.invoke({ operation: 'status', session: ref });
      lastSafeStatus = {
        lifecycleState: current.lifecycleState,
        interactionState: current.interactionState,
        inputAdmission: current.inputAdmission,
        signatureIds: current.providerAdapter?.signatureIds ?? [],
        adapterReason: current.providerAdapter?.reason ?? null,
        providerSessionObserved: Boolean(current.foreground?.providerSessionId),
        providerTurnObserved: Boolean(current.foreground?.providerTurnId),
        adapterFailureCode: current.providerAdapter?.failureCode ?? null,
        adapterFailureDetail: current.providerAdapter?.failureDetail ?? null,
        adapterExit: current.providerAdapter?.exit ?? null,
        stderrBytesObserved:
          current.providerAdapter?.stderrBytesObserved ?? null,
        attemptBoundary: current.attemptBoundary ?? null,
        outputBytesObserved:
          current.output.nextSequence - current.output.earliestSequence,
      };
      if (current.interactionState === 'ready') return current;
      if (
        ['ended', 'failed'].includes(current.lifecycleState) ||
        current.inputAdmission === 'closed'
      ) {
        throw new Error(`${provider} attempt ended before ready`);
      }
      adapterReason = current.providerAdapter.reason;
      if (provider !== 'claude' || current.interactionState !== 'unknown') {
        return null;
      }
      const snapshot = await host.invoke({
        operation: 'snapshot',
        session: ref,
        requestedSequence: current.output.earliestSequence,
      });
      const volatileScreen = [
        snapshot.terminal.vt.lines.join('\n'),
        ...snapshot.terminal.frames.map((frame) => frame.data),
      ].join('\n');
      const trustTokens = [
        'Accessing',
        'workspace',
        'Quick',
        'safety',
        'trust',
        'folder',
        'No',
        'exit',
      ];
      observedTrustTokens = trustTokens.filter((token) =>
        volatileScreen.includes(token),
      );
      observedReadyTokens = [
        'Try',
        'edit',
        '<filepath>',
        'manual',
        'mode',
      ].filter((token) => volatileScreen.includes(token));
      if (
        temporaryTrustAccepted ||
        observedTrustTokens.length !== trustTokens.length
      ) {
        return null;
      }
      const accepted = await control(
        host,
        ref,
        'send-key',
        { key: 'Enter' },
        false,
      );
      if (accepted.status !== 'written') {
        throw new Error('temporary Claude workspace trust key was not written');
      }
      temporaryTrustAccepted = true;
      return null;
    }, label);
    if (status.interactionState !== 'ready') {
      throw new Error(`${label} provider ended before ready`);
    }
  } catch (error) {
    throw new Error(
      `${error.message}; adapterReason=${adapterReason ?? 'none'}; safeStatus=${JSON.stringify(lastSafeStatus)}; trustTokens=${observedTrustTokens.join(',') || 'none'}; readyTokens=${observedReadyTokens.join(',') || 'none'}`,
    );
  }
  return { status, temporaryTrustAccepted };
}

function redactedScreenSignals(snapshot, probePath) {
  const vt = snapshot?.terminal?.vt;
  const screen = Array.isArray(vt?.lines) ? vt.lines.join('\n') : '';
  return {
    currentReadyPrompt: /^\s*❯(?:\s|$)/mu.test(screen),
    currentBusyHint: /esc to interrupt/iu.test(screen),
    currentPermissionPrompt: /permission/iu.test(screen),
    currentApprovalPrompt: /(?:allow|approve|proceed)/iu.test(screen),
    currentBashPrompt: /bash(?: command)?/iu.test(screen),
    currentProbeReference: screen.includes(path.basename(probePath)),
    activeBuffer: vt?.activeBuffer ?? null,
    cursor: vt?.cursor ?? null,
    nonEmptyLines: Array.isArray(vt?.lines)
      ? vt.lines.filter((line) => line.trim().length > 0).length
      : 0,
  };
}

async function stopWorker(metadata) {
  try {
    const record = JSON.parse(await readFile(metadata, 'utf8'));
    if (Number.isInteger(record.pid)) process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}

if (!process.argv.includes('--execute')) {
  throw new Error(
    'real provider dogfood is opt-in; pass --execute with temporary --runtime-dir and --workspace paths',
  );
}

const provider = argument('--provider');
if (!['codex', 'claude'].includes(provider)) {
  throw new Error('--provider must be codex or claude');
}
const claudeModel = argument('--claude-model');
const claudeEffort = argument('--claude-effort');
if (provider !== 'claude' && (claudeModel || claudeEffort)) {
  throw new Error(
    '--claude-model and --claude-effort require --provider claude',
  );
}
if (
  claudeEffort &&
  !['low', 'medium', 'high', 'xhigh', 'max'].includes(claudeEffort)
) {
  throw new Error('--claude-effort must be low, medium, high, xhigh, or max');
}
const transport = argument('--transport') ?? 'pty';
if (!['pty', 'structured'].includes(transport)) {
  throw new Error('--transport must be pty or structured');
}
if (transport === 'structured' && provider !== 'codex') {
  throw new Error('structured transport is qualified only for codex');
}
const runtimeDir = requiredArgument('--runtime-dir');
const workspace = requiredArgument('--workspace');
const providerExecutable = requiredArgument('--provider-executable');
try {
  accessSync(providerExecutable, constants.X_OK);
} catch {
  throw new Error('--provider-executable must identify an executable file');
}
const workerExecutable = path.resolve(
  argument('--worker-executable') ?? process.execPath,
);
const workerPath = argument('--worker-path');
const ptyModule = process.argv.includes('--prepare-checkout-node-pty')
  ? prepareCheckoutNodePty(runtimeDir)
  : argument('--pty-module');
const workerEnv = { ...process.env };
workerEnv[CODEX_APP_SERVER_FEATURE_FLAG] =
  transport === 'structured' ? '1' : '0';
if (ptyModule)
  workerEnv.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE = path.resolve(ptyModule);

const hostOptions = {
  runtimeDir,
  executable: workerExecutable,
  env: workerEnv,
};
if (workerPath) hostOptions.workerPath = path.resolve(workerPath);
const host = createDetachedAgentSessionHost(hostOptions);
const ref = {
  workConsoleId: `work:provider-dogfood:${provider}`,
  sessionAttemptId: `attempt:provider-dogfood:${provider}:${Date.now()}`,
};
const token = `KUNGFU_AGENT_SESSION_${provider.toUpperCase()}_READY`;
const startedAt = Date.now();

try {
  const env = environment();
  const plan = await host.invoke({
    operation: 'plan-start',
    input: {
      ...ref,
      provider,
      providerVersion: provider === 'codex' ? '0.144.3' : '2.1.209',
      profileRoot: PROFILE_ROOT,
      executable: providerExecutable,
      argv: providerArguments(provider, { claudeModel, claudeEffort }),
      cwd: workspace,
      env,
    },
  });
  const start = await host.invoke({
    operation: 'start',
    actorId: 'qualification-controller',
    client: 'gui',
    plan,
    expectedPlanRoot: plan.root,
    attachment: {
      attachmentId: `view:provider-dogfood:${provider}`,
      presentation: 'packaged-headless',
    },
    execution: { env, cols: 120, rows: 40 },
  });
  const initialReady = await waitForReady(
    host,
    ref,
    provider,
    `${provider} ready state`,
  );
  const initial = initialReady.status;

  const restartedMain = createDetachedAgentSessionHost(hostOptions);
  const reattached = await restartedMain.invoke({
    operation: 'status',
    session: ref,
  });
  if (reattached.capsuleId !== initial.capsuleId) {
    throw new Error('main-process reconnect changed the Capsule identity');
  }

  const sequenceBeforeInstruction = initial.output.nextSequence;
  const instruct = await control(restartedMain, ref, 'instruct', {
    text: `Reply with exactly ${token}. Do not use tools.`,
  });
  if (
    transport === 'structured'
      ? instruct.status !== 'delivered'
      : instruct.status !== 'written'
  ) {
    throw new Error(`${provider} instruction was not delivered`);
  }
  const responseStatus = await eventually(async () => {
    const status = await restartedMain.invoke({
      operation: 'status',
      session: ref,
    });
    if (transport === 'structured') {
      return status.output.nextSequence > sequenceBeforeInstruction &&
        status.interactionState === 'ready'
        ? status
        : null;
    }
    return status.output.nextSequence > sequenceBeforeInstruction + 32
      ? status
      : null;
  }, `${provider} output after instruction`);

  const instructedEnd = await control(restartedMain, ref, 'end', {});
  if (
    transport === 'structured'
      ? instructedEnd.status !== 'signalled'
      : instructedEnd.status !== 'applied'
  ) {
    throw new Error(`${provider} instruction attempt did not end`);
  }
  await eventually(async () => {
    const status = await restartedMain.invoke({
      operation: 'status',
      session: ref,
    });
    return (
      status.lifecycleState === 'ended' && status.inputAdmission === 'closed'
    );
  }, `${provider} instruction attempt exit`);

  const approvalRef = {
    workConsoleId: `work:provider-dogfood:${provider}:approval`,
    sessionAttemptId: `attempt:provider-dogfood:${provider}:approval:${Date.now()}`,
  };
  const approvalPlan = await restartedMain.invoke({
    operation: 'plan-start',
    input: {
      ...approvalRef,
      provider,
      providerVersion: provider === 'codex' ? '0.144.3' : '2.1.209',
      profileRoot: PROFILE_ROOT,
      executable: providerExecutable,
      argv: providerArguments(provider, { claudeModel, claudeEffort }),
      cwd: workspace,
      env,
    },
  });
  await restartedMain.invoke({
    operation: 'start',
    actorId: 'qualification-controller',
    client: 'gui',
    plan: approvalPlan,
    expectedPlanRoot: approvalPlan.root,
    attachment: {
      attachmentId: `view:provider-dogfood:${provider}:approval`,
      presentation: 'packaged-headless',
    },
    execution: { env, cols: 120, rows: 40 },
  });
  const approvalReady = await waitForReady(
    restartedMain,
    approvalRef,
    provider,
    `${provider} approval attempt ready`,
  );
  const approvalProbe = path.join(workspace, 'qualification-tool-call-probe');
  const approvalInstruction = await control(
    restartedMain,
    approvalRef,
    'instruct',
    {
      text: `Create the qualification fixture at ${JSON.stringify(approvalProbe)} now by calling the ${provider === 'claude' ? 'Bash' : 'shell'} tool with exactly this command: printf qualification > ${JSON.stringify(approvalProbe)}. Do not use another tool or merely describe the command.`,
    },
  );
  if (
    transport === 'structured'
      ? approvalInstruction.status !== 'delivered'
      : approvalInstruction.status !== 'written'
  ) {
    throw new Error(`${provider} approval probe instruction was not delivered`);
  }
  const approvalObservations = new Set();
  let approvalLastStatus = approvalReady.status;
  let approvalSafeStatus = null;
  try {
    await eventually(async () => {
      const status = await restartedMain.invoke({
        operation: 'status',
        session: approvalRef,
      });
      approvalLastStatus = status;
      approvalObservations.add(
        JSON.stringify({
          interactionState: status.interactionState,
          signatureIds: status.providerAdapter.signatureIds,
          adapterReason: status.providerAdapter.reason,
          lifecycleState: status.lifecycleState,
          inputAdmission: status.inputAdmission,
        }),
      );
      approvalSafeStatus = {
        lifecycleState: status.lifecycleState,
        interactionState: status.interactionState,
        inputAdmission: status.inputAdmission,
        pendingControls: status.structuredControl?.pending?.length ?? null,
        adapterFailureCode: status.providerAdapter?.failureCode ?? null,
        adapterFailureDetail: status.providerAdapter?.failureDetail ?? null,
      };
      return status.interactionState === 'approval-needed';
    }, `${provider} approval-needed state`);
  } catch (error) {
    let screenSignals = { snapshotAvailable: false };
    let cleanup = 'not-attempted';
    try {
      const snapshot = await restartedMain.invoke({
        operation: 'snapshot',
        session: approvalRef,
        requestedSequence: approvalLastStatus.output.earliestSequence,
      });
      screenSignals = redactedScreenSignals(snapshot, approvalProbe);
    } catch {
      screenSignals = { snapshotAvailable: false };
    }
    try {
      const stopped = await control(restartedMain, approvalRef, 'end', {});
      cleanup = stopped.status;
    } catch {
      cleanup = 'failed';
    }
    throw new Error(
      `${error.message}; metadata=${JSON.stringify({
        safeStatus: approvalSafeStatus,
        observations: [...approvalObservations],
        outputBytesObserved:
          approvalLastStatus.output.nextSequence -
          approvalReady.status.output.nextSequence,
        probeExists: existsSync(approvalProbe),
        screenSignals,
        cleanup,
      })}`,
    );
  }
  const pendingControl = (
    await restartedMain.invoke({ operation: 'status', session: approvalRef })
  ).structuredControl?.pending?.[0];
  const denied =
    transport === 'structured'
      ? await control(
          restartedMain,
          approvalRef,
          'respond-control',
          { requestId: pendingControl?.requestId, decision: 'deny' },
          false,
        )
      : await control(
          restartedMain,
          approvalRef,
          'send-key',
          { key: 'Escape' },
          false,
        );
  if (
    transport === 'structured'
      ? denied.status !== 'delivered'
      : denied.status !== 'written'
  ) {
    throw new Error(`${provider} approval denial was not delivered`);
  }
  if (existsSync(approvalProbe)) {
    throw new Error(`${provider} approval probe executed before denial`);
  }

  const ended = await control(restartedMain, approvalRef, 'end', {});
  if (
    transport === 'structured'
      ? ended.status !== 'signalled'
      : ended.status !== 'applied'
  ) {
    throw new Error(`${provider} end signal was not delivered`);
  }
  await eventually(async () => {
    const status = await restartedMain.invoke({
      operation: 'status',
      session: approvalRef,
    });
    return (
      status.lifecycleState === 'ended' && status.inputAdmission === 'closed'
    );
  }, `${provider} provider exit`);
  if (existsSync(approvalProbe)) {
    throw new Error(`${provider} approval probe executed despite denial`);
  }

  const interruptRef = {
    workConsoleId: `work:provider-dogfood:${provider}:interrupt`,
    sessionAttemptId: `attempt:provider-dogfood:${provider}:interrupt:${Date.now()}`,
  };
  const interruptPlan = await restartedMain.invoke({
    operation: 'plan-start',
    input: {
      ...interruptRef,
      provider,
      providerVersion: provider === 'codex' ? '0.144.3' : '2.1.209',
      profileRoot: PROFILE_ROOT,
      executable: providerExecutable,
      argv: providerArguments(provider, { claudeModel, claudeEffort }),
      cwd: workspace,
      env,
    },
  });
  await restartedMain.invoke({
    operation: 'start',
    actorId: 'qualification-controller',
    client: 'gui',
    plan: interruptPlan,
    expectedPlanRoot: interruptPlan.root,
    attachment: {
      attachmentId: `view:provider-dogfood:${provider}:interrupt`,
      presentation: 'packaged-headless',
    },
    execution: { env, cols: 120, rows: 40 },
  });
  const interruptReady = await waitForReady(
    restartedMain,
    interruptRef,
    provider,
    `${provider} interrupt attempt ready`,
  );
  if (transport === 'structured') {
    const longInstruction = await control(
      restartedMain,
      interruptRef,
      'instruct',
      {
        text: 'Begin outputting consecutive integers from 1 to 10000, one per line. Do not use tools.',
      },
    );
    if (longInstruction.status !== 'delivered') {
      throw new Error(
        `${provider} interrupt probe instruction was not delivered`,
      );
    }
    await eventually(async () => {
      const status = await restartedMain.invoke({
        operation: 'status',
        session: interruptRef,
      });
      return status.interactionState === 'busy';
    }, `${provider} interrupt probe busy state`);
  }
  const interrupted = await control(
    restartedMain,
    interruptRef,
    'interrupt',
    {},
  );
  if (
    transport === 'structured'
      ? interrupted.status !== 'delivered'
      : interrupted.status !== 'applied'
  ) {
    throw new Error(`${provider} interrupt signal was not delivered`);
  }
  const interruptEnd = await control(restartedMain, interruptRef, 'end', {});
  if (
    transport === 'structured'
      ? interruptEnd.status !== 'signalled'
      : interruptEnd.status !== 'applied'
  ) {
    throw new Error(`${provider} interrupt attempt did not end`);
  }

  const report = {
    schema: 'kungfu.agent-session.provider-dogfood/v1',
    provider,
    providerVersion: initial.providerAdapter.providerVersion,
    transport,
    transportAuthority:
      transport === 'structured'
        ? 'codex-app-server-structured-events'
        : `${provider}-pty-state-adapter`,
    platform: `${process.platform}-${process.arch}`,
    worker: workerPath ? 'packaged-app' : 'source-checkout',
    cases: {
      start: start.status,
      instructAndObserveOutput: 'passed',
      approvalDetectedAndDenyKeyWritten: 'passed',
      interruptDelivered: 'passed',
      mainRestartReattach: 'passed',
      providerEndClosesInput: 'passed',
    },
    durationMilliseconds: Date.now() - startedAt,
    instructionOutputBytesObserved:
      responseStatus.output.nextSequence - sequenceBeforeInstruction,
    workspaceRoot: `sha256:${createHash('sha256').update(workspace).digest('hex')}`,
    runtimeRoot: `sha256:${createHash('sha256').update(runtimeDir).digest('hex')}`,
    rawTerminalRetained: false,
    privateEnvironmentValuesRetained: false,
    approvalPolicy:
      provider === 'claude'
        ? 'explicit-bash-ask'
        : 'provider-untrusted-approval',
    qualificationProfile: {
      convergenceTimeoutMilliseconds,
      ...(provider === 'claude'
        ? {
            model: claudeModel ?? 'provider-default',
            effort: claudeEffort ?? 'provider-default',
          }
        : {}),
    },
    temporaryWorkspaceTrustAccepted:
      initialReady.temporaryTrustAccepted ||
      approvalReady.temporaryTrustAccepted ||
      interruptReady.temporaryTrustAccepted,
    rollback:
      transport === 'structured'
        ? `${CODEX_APP_SERVER_FEATURE_FLAG}=0 creates a new PTY attempt`
        : null,
    linuxQualification: 'not-run',
    windowsQualification: 'not-run',
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await stopWorker(host.metadata);
}
