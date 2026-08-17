import { AgentSessionCapsuleHost } from './capsule-host.mjs';
import { AgentSessionInteractionPort } from './interaction-port.mjs';
import {
  AgentSessionCapsulePeerTransport,
  InMemoryJournalNoticePort,
} from './peer-transport.mjs';
import { createProviderAdapter } from './provider-adapters.mjs';

function sameKeys(left, right) {
  return (
    JSON.stringify(Object.keys(left ?? {}).sort()) ===
    JSON.stringify([...right].sort())
  );
}

/**
 * Main-process product adapter for Stage 5.
 *
 * It uses the real Capsule host, peer-transport authority and Interaction Port.
 * The process placement is injectable so the Stage 6 detached-worker adapter
 * can replace this in-process constructor without changing any product client.
 */
export class InProcessAgentSessionProductRuntime {
  constructor({
    pty = null,
    loadPty = null,
    baseEnv = {},
    now = () => Date.now(),
    maxOutputBytes,
    structuredRuntime = null,
  }) {
    if (pty && typeof pty.spawn !== 'function') {
      throw new Error('product runtime received an invalid node-pty module');
    }
    if (loadPty !== null && typeof loadPty !== 'function') {
      throw new Error('product runtime loadPty must be a function');
    }
    this.pty = pty;
    this.loadPty = loadPty;
    this.baseEnv = baseEnv;
    this.now = now;
    this.maxOutputBytes = maxOutputBytes;
    this.structuredRuntime = structuredRuntime;
    this.sessions = new Map();
    this.generation = 0;
  }

  list() {
    return [
      ...this.sessions.values(),
      ...(this.structuredRuntime?.list() ?? []),
    ];
  }

  get(ref) {
    const session =
      this.sessions.get(ref.sessionAttemptId) ??
      this.structuredRuntime?.get(ref) ??
      null;
    if (!session || session.workConsoleId !== ref.workConsoleId) return null;
    return session;
  }

  start(plan, execution = {}) {
    if (
      this.list().some(
        (session) => session.sessionAttemptId === plan.sessionAttemptId,
      )
    ) {
      throw new Error(`session '${plan.sessionAttemptId}' already exists`);
    }
    if (plan.transportRoute?.kind === 'structured') {
      if (!this.structuredRuntime) {
        throw new Error('structured provider route is not enabled');
      }
      return this.structuredRuntime.start(plan, execution);
    }
    if (!sameKeys(execution.env, plan.environmentNames)) {
      throw new Error(
        'execution environment names do not match the reviewed plan',
      );
    }
    this.generation += 1;
    const generation = String(this.generation);
    const pty = this.pty ?? this.loadPty?.();
    if (!pty || typeof pty.spawn !== 'function') {
      throw Object.assign(
        new Error(
          'Capsule transport requires an optional node-pty runtime; provider-native sessions remain available',
        ),
        { code: 'capsule_transport_unavailable' },
      );
    }
    this.pty = pty;
    const host = new AgentSessionCapsuleHost({
      pty,
      capsuleId: `capsule:${plan.sessionAttemptId}:${generation}`,
      runtimeIdentity: `product-runtime:${process.pid}`,
      maxOutputBytes: this.maxOutputBytes,
      now: this.now,
    });
    const env = {};
    for (const name of plan.environmentNames) {
      const value = execution.env?.[name] ?? this.baseEnv[name];
      if (typeof value === 'string') env[name] = value;
    }
    const started = host.start({
      workConsoleId: plan.workConsoleId,
      sessionAttemptId: plan.sessionAttemptId,
      capsuleGeneration: generation,
      sessionStreamEpoch: '1',
      provider: plan.provider,
      profileRoot: plan.profileRoot,
      executable: plan.executable,
      argv: plan.argv,
      cwd: plan.cwd ?? undefined,
      env,
      cols: execution.cols ?? 80,
      rows: execution.rows ?? 24,
    });
    const transport = new AgentSessionCapsulePeerTransport({
      host,
      port: new InMemoryJournalNoticePort(),
      now: this.now,
    });
    transport.register({
      coordinatorEpoch: '1',
      supervisorGeneration: '1',
    });
    const port = new AgentSessionInteractionPort({
      host,
      transport,
      adapter: createProviderAdapter({
        provider: plan.provider,
        version: plan.providerVersion,
      }),
      now: this.now,
    });
    const session = {
      workConsoleId: plan.workConsoleId,
      sessionAttemptId: plan.sessionAttemptId,
      binding: plan.binding,
      host,
      transport,
      port,
      attachments: new Map(),
      authority(actorId) {
        const controller = transport.status().controllerLease;
        return {
          leaseId: controller?.leaseId,
          holderId: actorId,
          coordinatorEpoch: '1',
          expectedForeground: started.foreground,
          sessionAttemptId: plan.sessionAttemptId,
          capsuleGeneration: generation,
          sessionStreamEpoch: '1',
          processStartIdentity: started.foreground.processStartIdentity,
        };
      },
      waitForStatusChange(afterChangeSequence) {
        return host.waitForChange(afterChangeSequence);
      },
      endControl: null,
      async end(request) {
        const controlRequest = { operation: 'end', signal: 'SIGTERM' };
        session.endControl = controlRequest;
        let controlReceipt;
        try {
          controlReceipt = transport.submitSignal({
            ...request,
            signal: controlRequest.signal,
          });
        } catch (error) {
          session.endControl = null;
          throw error;
        }
        const boundaryStatus = await host.waitForExit();
        return {
          status: controlReceipt.status,
          controlReceipt,
          boundaryStatus,
        };
      },
    };
    this.sessions.set(plan.sessionAttemptId, session);
    return session;
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      const status = session.host.status();
      if (status.inputAdmission !== 'open') continue;
      session.host.signal({
        actionId: `product-worker-shutdown:${status.sessionAttemptId}`,
        sessionAttemptId: status.sessionAttemptId,
        capsuleGeneration: status.capsuleGeneration,
        sessionStreamEpoch: status.sessionStreamEpoch,
        processStartIdentity: status.foreground.processStartIdentity,
        signal: 'SIGTERM',
      });
    }
    this.structuredRuntime?.shutdown();
  }

  planRoute(input) {
    return this.structuredRuntime?.planRoute(input) ?? null;
  }

  capabilities() {
    return this.structuredRuntime?.capabilities() ?? null;
  }
}
