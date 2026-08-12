import { createHash } from 'node:crypto';

export type SkillRuntimeAuditProjection = {
  surface: 'tui';
  runtimeAuditRoot: string;
  registryStateRoot: string;
  historyRoot: string;
  diagnosisRoot: string;
  auditRoots: string[];
  dependencyRoots: string[];
  authority: 'read-only-projection';
};

export type TuiSkillRuntimeAudit = {
  schema?: unknown;
  runtimeAuditRoot?: unknown;
  documentRoot?: unknown;
  roots?: Record<string, unknown>;
  surfaceProjections?: Record<string, unknown>;
  [key: string]: unknown;
};

export function projectTuiSkillRuntimeAudit(
  value: unknown,
): SkillRuntimeAuditProjection {
  if (!value || typeof value !== 'object') {
    throw new Error('Kungfu Skill runtime audit must be an object');
  }
  const document = value as TuiSkillRuntimeAudit;
  if (document.schema !== 'kungfu.skill-runtime-audit/v2') {
    throw new Error('Kungfu Skill runtime audit schema is invalid');
  }
  const rootless = Object.fromEntries(
    Object.entries(document).filter(
      ([key]) =>
        !['runtimeAuditRoot', 'surfaceProjections', 'documentRoot'].includes(
          key,
        ),
    ),
  );
  const expectedRoot = contentRoot(rootless);
  if (document.runtimeAuditRoot !== expectedRoot) {
    throw new Error('Kungfu Skill runtime audit root mismatch');
  }
  const expectedDocumentRoot = contentRoot(
    Object.fromEntries(
      Object.entries(document).filter(([key]) => key !== 'documentRoot'),
    ),
  );
  if (document.documentRoot !== expectedDocumentRoot) {
    throw new Error('Kungfu Skill runtime audit document root mismatch');
  }
  const roots = document.roots ?? {};
  const expected: SkillRuntimeAuditProjection = {
    surface: 'tui',
    runtimeAuditRoot: expectedRoot,
    registryStateRoot: requiredRoot(roots.registryStateRoot),
    historyRoot: requiredRoot(roots.historyRoot),
    diagnosisRoot: requiredRoot(roots.diagnosisRoot),
    auditRoots: rootList(roots.auditRoots),
    dependencyRoots: rootList(roots.dependencyRoots),
    authority: 'read-only-projection',
  };
  if (stable(document.surfaceProjections?.tui) !== stable(expected)) {
    throw new Error('Kungfu Skill TUI projection changed rooted identity');
  }
  return expected;
}

export function describeTuiSkillRuntimeAudit(value: unknown): string[] {
  const projection = projectTuiSkillRuntimeAudit(value);
  const document = value as TuiSkillRuntimeAudit;
  const skills = Array.isArray(document.skills) ? document.skills : [];
  const evidence = Array.isArray(document.evidence) ? document.evidence : [];
  const scope = (document.scope ?? {}) as Record<string, unknown>;
  const recovery = (document.recovery ?? {}) as Record<string, unknown>;
  const first = (skills[0] ?? {}) as Record<string, unknown>;
  const identity = (first.identity ?? {}) as Record<string, unknown>;
  const bindings = Array.isArray(first.workBindings) ? first.workBindings : [];
  const states = Array.isArray(first.observedStates)
    ? first.observedStates.map(String)
    : [];
  const rooted = evidence.filter(
    (row) =>
      ((row as Record<string, unknown>).proof as Record<string, unknown>)
        ?.status === 'rooted',
  ).length;
  return [
    `Skill audit ${projection.runtimeAuditRoot} · run ${String(scope.runId ?? '-')} · Work ${String(scope.workRef ?? '-')}`,
    skills.length > 0
      ? `${String(identity.key ?? 'unknown')}@${String(identity.revision ?? '?')} · ${String(first.lifecycle ?? 'unproved')} · ${bindings.length} Work binding(s) · states ${states.join(',') || 'unproved'} · evidence ${rooted}/${evidence.length} rooted · recovery ${String(recovery.verdict ?? 'unproved')}`
      : `no scoped Skill · evidence ${rooted}/${evidence.length} rooted · recovery ${String(recovery.verdict ?? 'unproved')}`,
  ];
}

function rootList(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new Error('Kungfu Skill roots must be an array');
  return value.map(requiredRoot);
}

function requiredRoot(value: unknown): string {
  const text = String(value);
  if (!/^sha256:[a-f0-9]{64}$/u.test(text)) {
    throw new Error(`Kungfu Skill root is invalid: ${text}`);
  }
  return text;
}

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
