import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  describeTuiSkillRuntimeAudit,
  projectTuiSkillRuntimeAudit,
} from './skill-runtime-audit.js';

test('TUI preserves the shared Skill runtime audit root', () => {
  const sha = (value: string) => `sha256:${value.repeat(64)}`;
  const surfaces = ['agent', 'cli', 'gui', 'tui', 'managed-run'] as const;
  const base = {
    schema: 'kungfu.skill-runtime-audit/v2',
    authority: {},
    scope: { runId: 'run-1', workRef: 'work-1' },
    roots: {
      registryStateRoot: sha('1'),
      registryReportRoot: sha('2'),
      historyRoot: sha('3'),
      diagnosisRoot: sha('4'),
      auditRoots: [sha('5')],
      dependencyRoots: [sha('6')],
    },
    skills: [],
    evidence: [],
    recovery: {},
  };
  const runtimeAuditRoot = contentRoot(base);
  const surfaceProjections = Object.fromEntries(
    surfaces.map((surface) => [
      surface,
      {
        surface,
        runtimeAuditRoot,
        registryStateRoot: sha('1'),
        historyRoot: sha('3'),
        diagnosisRoot: sha('4'),
        auditRoots: [sha('5')],
        dependencyRoots: [sha('6')],
        authority: 'read-only-projection' as const,
      },
    ]),
  );
  const rootlessDocument = {
    ...base,
    runtimeAuditRoot,
    surfaceProjections,
  };
  const document = {
    ...rootlessDocument,
    documentRoot: contentRoot(rootlessDocument),
  };
  const projection = surfaceProjections.tui;

  assert.deepEqual(projectTuiSkillRuntimeAudit(document), projection);
  assert.throws(
    () =>
      projectTuiSkillRuntimeAudit({
        ...document,
        surfaceProjections: {
          ...surfaceProjections,
          agent: { ...surfaceProjections.agent, historyRoot: sha('8') },
        },
      }),
    /document root mismatch/u,
  );
});

test('TUI describes shared Skill identity, Work, evidence, and recovery', () => {
  const sha = (value: string) => `sha256:${value.repeat(64)}`;
  const base = {
    schema: 'kungfu.skill-runtime-audit/v2',
    authority: {},
    scope: { runId: 'run-1', workRef: 'work-1' },
    roots: {
      registryStateRoot: sha('1'),
      registryReportRoot: sha('2'),
      historyRoot: sha('3'),
      diagnosisRoot: sha('4'),
      auditRoots: [sha('5')],
      dependencyRoots: [sha('6')],
    },
    skills: [
      {
        identity: { key: 'exact-skill', revision: 2 },
        lifecycle: 'enabled',
        workBindings: [{ workRef: 'work-1' }],
        observedStates: ['advertised', 'loaded', 'invoked'],
      },
    ],
    evidence: [{ proof: { status: 'rooted', roots: [sha('7')] } }],
    recovery: { verdict: 'healthy' },
  };
  const runtimeAuditRoot = contentRoot(base);
  const surfaceProjections = Object.fromEntries(
    ['agent', 'cli', 'gui', 'tui', 'managed-run'].map((surface) => [
      surface,
      {
        surface,
        runtimeAuditRoot,
        registryStateRoot: sha('1'),
        historyRoot: sha('3'),
        diagnosisRoot: sha('4'),
        auditRoots: [sha('5')],
        dependencyRoots: [sha('6')],
        authority: 'read-only-projection',
      },
    ]),
  );
  const rootless = { ...base, runtimeAuditRoot, surfaceProjections };
  const document = { ...rootless, documentRoot: contentRoot(rootless) };

  assert.deepEqual(describeTuiSkillRuntimeAudit(document), [
    `Skill audit ${runtimeAuditRoot} · run run-1 · Work work-1`,
    'exact-skill@2 · enabled · 1 Work binding(s) · states advertised,loaded,invoked · evidence 1/1 rooted · recovery healthy',
  ]);
});

function contentRoot(value: unknown): string {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
