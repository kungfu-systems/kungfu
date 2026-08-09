import { clone } from './work-console-model.mjs';

function backendMismatch(message) {
  return Object.assign(new Error(message), {
    code: 'attempt_backend_mismatch',
  });
}

export class SessionLifecycleService {
  constructor({ find, appendReceipt, workLeases, now }) {
    this.find = find;
    this.appendReceipt = appendReceipt;
    this.workLeases = workLeases;
    this.now = now;
  }

  recordStarted(plan, receipt) {
    const { console, attempt } = this.find(plan);
    attempt.status = 'running';
    attempt.startedAt = receipt.recordedAt;
    attempt.endedAt = undefined;
    this.appendReceipt(attempt, receipt);
    console.updatedAt = receipt.recordedAt;
  }

  recordNativeStarted(plan, receipt, observer) {
    this.recordStarted(plan, receipt);
    const { console, attempt } = this.find(plan);
    attempt.backend = 'native-interactive';
    attempt.observer = clone(observer);
    this.workLeases.recordProcessEvidence(plan);
    console.backend = 'native-interactive';
    console.updatedAt = receipt.recordedAt;
  }

  recordNativeHeartbeat(ref, observer) {
    const { console, attempt } = this.find(ref);
    if (attempt.backend !== 'native-interactive') {
      throw backendMismatch(
        'native heartbeat requires a native-interactive attempt',
      );
    }
    attempt.status = 'running';
    attempt.endedAt = undefined;
    attempt.observer = clone(observer);
    this.workLeases.recordProcessEvidence(ref);
    console.updatedAt = observer.observedAt;
  }

  recordNativeEnded(ref, receipt, exit) {
    const { console, attempt } = this.find(ref);
    if (attempt.backend !== 'native-interactive') {
      throw backendMismatch('native end requires a native-interactive attempt');
    }
    attempt.status = 'exited';
    attempt.endedAt = receipt.recordedAt;
    attempt.exit = clone(exit);
    this.workLeases.release(ref);
    if (attempt.observer) {
      attempt.observer = {
        ...attempt.observer,
        state: 'disconnected',
        observedAt: receipt.recordedAt,
        diagnostic: 'provider-process-ended',
      };
    }
    this.appendReceipt(attempt, receipt);
    console.updatedAt = receipt.recordedAt;
  }

  observe(sessions) {
    let changed = false;
    for (const session of sessions) {
      const status = session.port.status();
      const found = this.find(status, false);
      if (!found) continue;
      const next = status.lifecycleState === 'ended' ? 'exited' : 'running';
      if (found.attempt.status === next) continue;
      found.attempt.status = next;
      if (next === 'exited') found.attempt.endedAt = this.now();
      found.console.updatedAt = this.now();
      changed = true;
      if (next === 'exited') this.workLeases.release(status);
    }
    return changed;
  }
}
