// SPDX-License-Identifier: Apache-2.0

const ROOT_PATTERN = /^sha256:[a-f0-9]{64}$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function rowFrom(value, index) {
  const record = object(value);
  if (!record) {
    return { index, valid: false, code: 'KF_GITHUB_VIEW_RECORD_INVALID' };
  }
  const event = object(record.event) ?? record;
  const receipt = object(record.receipt);
  const processing = object(record.processing);
  const payloadRoot = String(event.payloadRoot ?? '');
  const receiptRoot = String(receipt?.receiptRoot ?? '');
  return {
    index,
    valid: true,
    accepted:
      typeof record.accepted === 'boolean'
        ? record.accepted
        : event.outcome === 'observed',
    outcome: String(
      processing?.outcome ?? event.outcome ?? receipt?.outcome ?? 'unknown',
    ),
    code: String(processing?.code ?? event.code ?? receipt?.code ?? ''),
    delivery: String(event.delivery ?? ''),
    event: String(event.event ?? ''),
    action: String(event.action ?? ''),
    repository: String(event.repository ?? ''),
    sender: String(event.sender ?? ''),
    payloadRoot: ROOT_PATTERN.test(payloadRoot) ? payloadRoot : '',
    receiptRoot: ROOT_PATTERN.test(receiptRoot) ? receiptRoot : '',
    replayed:
      receipt?.code === 'KF_KFX_WEBHOOK_REPLAYED' ||
      event.code === 'KF_KFX_WEBHOOK_REPLAYED',
  };
}

export function presentGitHubEvidence(text, maximumRows = 200) {
  const input = String(text ?? '').trim();
  if (!input) return { rows: [], diagnostics: [] };
  const lines = input.startsWith('[') ? [input] : input.split(/\r?\n/);
  const values = [];
  const diagnostics = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) values.push(...parsed);
      else values.push(parsed);
    } catch {
      diagnostics.push({
        line: index + 1,
        code: 'KF_GITHUB_VIEW_JSON_INVALID',
      });
    }
    if (values.length >= maximumRows) break;
  }
  const bounded = values.slice(0, maximumRows);
  if (values.length > maximumRows) {
    diagnostics.push({ line: null, code: 'KF_GITHUB_VIEW_ROWS_TRUNCATED' });
  }
  return {
    rows: bounded.map(rowFrom),
    diagnostics,
  };
}
