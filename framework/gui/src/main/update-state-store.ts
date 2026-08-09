// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  DesktopUpdateState,
  DesktopUpdateStateStore,
} from './update-controller';
import { UPGRADE_GUIDE_URL, upgradeUserMessage } from './upgrade-message';

const PHASES = new Set([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installer-handoff',
  'reconciling',
  'deferred',
  'complete',
  'action-required',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSchema(value: unknown, schema: string): boolean {
  return value === null || (isRecord(value) && value.schema === schema);
}

function isValidState(value: unknown): value is DesktopUpdateState {
  if (!isRecord(value)) return false;
  return (
    value.schema === 'kungfu.desktop-update-state/v1' &&
    typeof value.phase === 'string' &&
    PHASES.has(value.phase) &&
    (value.version === null || typeof value.version === 'string') &&
    hasSchema(value.manifest, 'kungfu.product-upgrade.manifest/v1') &&
    hasSchema(value.plan, 'kungfu.runtime-upgrade-plan/v1') &&
    hasSchema(value.receipt, 'kungfu.runtime-upgrade-receipt/v1') &&
    (value.progressPercent === null ||
      (typeof value.progressPercent === 'number' &&
        Number.isFinite(value.progressPercent) &&
        value.progressPercent >= 0 &&
        value.progressPercent <= 100)) &&
    typeof value.reasonCode === 'string' &&
    typeof value.nextAction === 'string' &&
    typeof value.documentationUrl === 'string' &&
    typeof value.error === 'string' &&
    hasSchema(value.message, 'kungfu.product-upgrade-message/v1') &&
    typeof value.updatedAtMs === 'number' &&
    Number.isFinite(value.updatedAtMs)
  );
}

function invalidSavedState(): DesktopUpdateState {
  const reasonCode = 'desktop-updater-error';
  const message = upgradeUserMessage(reasonCode, UPGRADE_GUIDE_URL);
  return {
    schema: 'kungfu.desktop-update-state/v1',
    phase: 'error',
    version: null,
    manifest: null,
    plan: null,
    receipt: null,
    progressPercent: null,
    reasonCode,
    nextAction: message.userAction,
    documentationUrl: message.documentationUrl,
    error:
      'Saved desktop update state is invalid; check for updates again. No update was applied.',
    message,
    updatedAtMs: Date.now(),
  };
}

export function createFileUpdateStateStore(
  stateFile: string,
): DesktopUpdateStateStore {
  return {
    load() {
      if (!existsSync(stateFile)) return null;
      try {
        const value: unknown = JSON.parse(readFileSync(stateFile, 'utf8'));
        return isValidState(value) ? value : invalidSavedState();
      } catch {
        return invalidSavedState();
      }
    },
    save(state) {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(temporary, stateFile);
    },
  };
}
