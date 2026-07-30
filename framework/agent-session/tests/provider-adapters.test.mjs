import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createProviderAdapter,
  parseProviderVersion,
  probeProviderVersion,
  providerAdapterMatrix,
} from '../src/provider-adapters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function fixtures(name) {
  return JSON.parse(
    fs.readFileSync(
      path.join(here, 'fixtures', 'provider-adapters', name),
      'utf8',
    ),
  );
}

for (const [provider, version, filename] of [
  ['codex', '0.144.3', 'codex-v0.144.3.json'],
  ['claude', '2.1.209', 'claude-v2.1.209.json'],
]) {
  test(`${provider} adapter classifies only versioned redacted fixtures`, () => {
    const adapter = createProviderAdapter({ provider, version });
    assert.equal(adapter.compatible, true);
    assert.equal(adapter.tested, true);
    for (const fixture of fixtures(filename)) {
      const result = adapter.inspect({
        lines: fixture.lines,
        lifecycleState: 'ready',
        inputAdmission: 'open',
        foreground: { provider },
      });
      assert.equal(result.state, fixture.expectedState, fixture.id);
      if (fixture.signatureId) {
        assert.deepEqual(
          result.signatureIds,
          [fixture.signatureId],
          fixture.id,
        );
      }
      if (fixture.reason)
        assert.equal(result.reason, fixture.reason, fixture.id);
    }
  });
}

test('version drift and foreground mismatch fail visibly to raw human fallback', () => {
  const drifted = createProviderAdapter({
    provider: 'codex',
    version: '0.145.0',
  });
  const result = drifted.inspect({
    lines: ['› prompt'],
    lifecycleState: 'ready',
    inputAdmission: 'open',
    foreground: { provider: 'codex' },
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.compatible, false);
  assert.equal(result.reason, 'adapter-version-drift');
  assert.equal(result.rawHumanFallback, true);

  const adapter = createProviderAdapter({
    provider: 'codex',
    version: '0.144.3',
  });
  assert.equal(
    adapter.inspect({
      lines: ['› prompt'],
      lifecycleState: 'ready',
      inputAdmission: 'open',
      foreground: { provider: 'custom' },
    }).reason,
    'foreground-provider-mismatch',
  );
});

test('Claude volatile state uses the latest bounded signature and fails closed on a later modal', () => {
  const adapter = createProviderAdapter({
    provider: 'claude',
    version: '2.1.209',
  });
  const inspect = (volatileTail) =>
    adapter.inspect({
      lines: [],
      volatileTail,
      lifecycleState: 'ready',
      inputAdmission: 'open',
      foreground: { provider: 'claude' },
    });
  assert.equal(
    inspect('Enter to confirm\u001b[2J\u001b[HTry "edit manual mode').state,
    'ready',
  );
  assert.equal(
    inspect('Try "edit manual mode\nDo you want to proceed?').state,
    'approval-needed',
  );
  assert.deepEqual(
    inspect('Try "edit manual mode\nClaude needs your permission').signatureIds,
    ['claude.approval.needs-permission'],
  );
  const unknown = inspect('Try "edit manual mode\nPermission required');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'unrecognized-modal-state');
});

test('Claude current VT grid supersedes erased volatile states', () => {
  const adapter = createProviderAdapter({
    provider: 'claude',
    version: '2.1.209',
  });
  const inspect = (lines, volatileTail) =>
    adapter.inspect({
      lines,
      volatileTail,
      lifecycleState: 'ready',
      inputAdmission: 'open',
      foreground: { provider: 'claude' },
    });
  assert.equal(
    inspect(['❯ Try a task'], 'Thinking… (esc to interrupt)').state,
    'ready',
  );
  assert.equal(
    inspect(['Thinking… (esc to interrupt)'], 'Claude needs your permission')
      .state,
    'busy',
  );
  const modal = inspect(
    ['Permission required', '❯ Try a task'],
    'Thinking… (esc to interrupt)',
  );
  assert.equal(modal.state, 'ready');
  assert.deepEqual(modal.signatureIds, ['claude.ready.prompt']);
  const approvalWithReadyPrompt = inspect(
    ['Bash', 'Allow', '❯ Try a task'],
    'Thinking… (esc to interrupt)',
  );
  assert.equal(approvalWithReadyPrompt.state, 'approval-needed');
  assert.deepEqual(approvalWithReadyPrompt.signatureIds, [
    'claude.approval.bash-confirmation',
  ]);
});

test('instruction encoding uses each provider bounded paste submit sequence', () => {
  const codex = createProviderAdapter({
    provider: 'codex',
    version: '0.144.3',
  });
  assert.equal(
    codex.encodeInstruction('inspect the source'),
    '\u001b[200~inspect the source\u001b[201~\r',
  );
  const claude = createProviderAdapter({
    provider: 'claude',
    version: '2.1.209',
  });
  assert.equal(
    claude.encodeInstruction('inspect the source'),
    '\u001b[200~inspect the source\u001b[201~',
  );
  assert.equal(claude.instructionSubmitStrategy, 'separate-enter');
  assert.equal(claude.instructionSubmitData, '\r');
  assert.equal(claude.instructionSubmitDelayMilliseconds, 50);
  assert.equal(codex.instructionSubmitStrategy, 'inline-enter');
  assert.equal(codex.instructionSubmitData, null);
  assert.equal(codex.instructionSubmitDelayMilliseconds, 0);
  assert.throws(
    () => codex.encodeInstruction('already submitted\n'),
    /cannot end with Enter/u,
  );
  assert.throws(
    () => codex.encodeInstruction('unsafe\u001bsequence'),
    /escape bytes/u,
  );
  assert.throws(
    () => codex.encodeInstruction('x'.repeat(65 * 1024)),
    /64 KiB/u,
  );
  assert.equal(codex.encodeKey('Enter'), '\r');
  assert.throws(
    () => codex.encodeKey('Ctrl-Alt-Delete'),
    /unsupported semantic key/u,
  );
});

test('version probe returns metadata only and never claims private-state inspection', () => {
  const probe = probeProviderVersion({
    provider: 'codex',
    executable: '/test/codex',
    run: (_command, args, options) => {
      assert.deepEqual(args, ['--version']);
      assert.equal(options.shell, false);
      return { status: 0, stdout: 'codex-cli 0.144.3\n', stderr: '' };
    },
  });
  assert.equal(
    parseProviderVersion('claude', '2.1.209 (Claude Code)'),
    '2.1.209',
  );
  assert.equal(probe.compatible, true);
  assert.equal(probe.tested, true);
  assert.equal(probe.inspectedPrivateState, false);
  assert.deepEqual(
    providerAdapterMatrix().map((entry) => entry.provider),
    ['codex', 'claude'],
  );
});
