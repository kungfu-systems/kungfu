// SPDX-License-Identifier: Apache-2.0
// Agent bootstrap fixture. Proves report-mode bootstrap has a stable status
// surface, can switch to managed-run without dropping the report closeout gate,
// and exposes dry-run teardown without deleting local receipts/data.

import fs from 'node:fs';
import path from 'node:path';
import { json, kfc, locate, tmpDir } from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const home = tmpDir('kf-agent-bootstrap-');
const skillDir = path.join(home, 'codex-skill');

const initial = json(
  kfc(coreDir, home, ['agent', 'status', '--target', 'codex', '--json']),
);
if (initial.configured) throw new Error('fresh home should not be configured');

const preview = json(
  kfc(coreDir, home, [
    'agent',
    'bootstrap',
    '--target',
    'codex',
    '--mode',
    'report',
    '--skill-dir',
    skillDir,
    '--json',
  ]),
);
if (preview.changed) throw new Error('bootstrap preview changed state');
if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
  throw new Error('bootstrap preview copied skill');
}

const applied = json(
  kfc(coreDir, home, [
    'agent',
    'bootstrap',
    '--target',
    'codex',
    '--mode',
    'report',
    '--skill-dir',
    skillDir,
    '--execute',
    '--json',
  ]),
);
if (!applied.changed) throw new Error('bootstrap execute did not change state');
if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
  throw new Error('bootstrap execute did not copy skill');
}

const status = json(
  kfc(coreDir, home, ['agent', 'status', '--target', 'codex', '--json']),
);
if (!status.policy?.reportCloseoutGate) {
  throw new Error(`report gate not enabled: ${JSON.stringify(status)}`);
}

const switched = json(
  kfc(coreDir, home, [
    'agent',
    'mode',
    'set',
    '--target',
    'codex',
    '--mode',
    'managed-run',
    '--execute',
    '--json',
  ]),
);
if (!switched.policy?.reportCloseoutGate) {
  throw new Error('managed-run switch dropped report closeout gate');
}

const unbootstrapPreview = json(
  kfc(coreDir, home, ['agent', 'unbootstrap', '--target', 'codex', '--json']),
);
if (unbootstrapPreview.changed) throw new Error('unbootstrap preview changed state');

const uninstallPreview = json(
  kfc(coreDir, home, ['agent', 'uninstall', '--target', 'codex', '--json']),
);
if (uninstallPreview.willDeleteData) {
  throw new Error('uninstall preview should not delete data');
}

console.log('ok agent bootstrap');
