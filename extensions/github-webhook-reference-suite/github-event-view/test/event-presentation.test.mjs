import assert from 'node:assert/strict';
import { presentGitHubEvidence } from '../src/view/event-presentation.mjs';

const rooted = (character) => `sha256:${character.repeat(64)}`;
const accepted = {
  accepted: true,
  event: {
    outcome: 'observed',
    delivery: 'delivery-1',
    event: 'issues',
    action: 'opened',
    repository: 'kungfu-systems/kungfu',
    sender: 'octocat',
    payloadRoot: rooted('1'),
  },
  receipt: { outcome: 'applied', receiptRoot: rooted('2') },
};
const replay = {
  accepted: false,
  receipt: { code: 'KF_KFX_WEBHOOK_REPLAYED', receiptRoot: rooted('3') },
};
const output = presentGitHubEvidence(
  `${JSON.stringify(accepted)}\n${JSON.stringify(replay)}`,
);
assert.equal(output.diagnostics.length, 0);
assert.equal(output.rows.length, 2);
assert.equal(output.rows[0].accepted, true);
assert.equal(output.rows[0].payloadRoot, rooted('1'));
assert.equal(output.rows[1].replayed, true);

const invalid = presentGitHubEvidence('{invalid');
assert.deepEqual(invalid.diagnostics, [
  { line: 1, code: 'KF_GITHUB_VIEW_JSON_INVALID' },
]);

const bounded = presentGitHubEvidence(JSON.stringify([accepted, replay]), 1);
assert.equal(bounded.rows.length, 1);
assert.equal(bounded.diagnostics[0].code, 'KF_GITHUB_VIEW_ROWS_TRUNCATED');
