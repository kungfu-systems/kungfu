import assert from 'node:assert/strict';
import test from 'node:test';
import { agentSessionSnapshotText } from '../src/view/agent-session-snapshot.ts';

test('renders retained PTY transcript lines', () => {
  assert.equal(
    agentSessionSnapshotText({ terminal: { vt: { lines: ['one', 'two'] } } }),
    'one\ntwo',
  );
});

test('renders structured-session status without requiring a terminal snapshot', () => {
  assert.equal(
    agentSessionSnapshotText({ retainedTranscript: false }),
    'Structured provider session active · terminal transcript is intentionally not retained.',
  );
});

test('renders the waiting state before a snapshot arrives', () => {
  assert.equal(agentSessionSnapshotText(null), 'Waiting for Capsule output…');
});
