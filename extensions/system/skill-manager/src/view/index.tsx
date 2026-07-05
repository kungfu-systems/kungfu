// System view: Skill Manager. Shows the Node manager's pre-agent dependency
// view: installed skills, compact catalog entries, and kfx binding status.
import {
  type KfxViewProps,
  headingStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import type { SkillManagerEntry, SkillManagerView } from '@kungfu-tech/skill';
import React from 'react';

function asSkillManagerView(value: unknown): SkillManagerView | null {
  if (
    value &&
    typeof value === 'object' &&
    (value as { schema?: unknown }).schema === 'kungfu.skill-manager/v1'
  ) {
    return value as SkillManagerView;
  }
  return null;
}

function packageLabel(
  row: SkillManagerEntry['dependencies']['dependencies'][0],
) {
  return row.package
    ? `${row.package.name ?? row.package.key}@${row.package.version ?? '?'}`
    : (row.reason ?? 'not resolved');
}

function SkillManagerViewComponent({ shell }: KfxViewProps) {
  const view = asSkillManagerView(shell.info.skillManager);
  const cell: React.CSSProperties = { padding: '2px 12px 2px 0' };
  if (!view) {
    return (
      <section style={panelStyle}>
        <h2 style={headingStyle}>Skills</h2>
        <div style={{ ...mono, color: '#f48771' }}>
          skill manager view unavailable
        </div>
        <div style={{ ...mono, color: '#6a6a6a', marginTop: 4 }}>
          KF_SKILL_MANAGER_FILE was not readable before the renderer booted
        </div>
      </section>
    );
  }

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>
        Skills · {view.summary.skills} installed ·{' '}
        {view.summary.unresolvedRequired} unresolved required kfx
      </h2>
      <div style={{ ...mono, color: '#6a6a6a', marginBottom: 8 }}>
        registry: {view.registry.root}
      </div>
      {view.skills.length === 0 ? (
        <div style={{ ...mono, color: '#6a6a6a' }}>no installed skills</div>
      ) : (
        <table style={{ ...mono, borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr style={{ color: '#858585', textAlign: 'left' }}>
              <th style={cell}>skill</th>
              <th style={cell}>kind</th>
              <th style={cell}>triggers</th>
              <th style={cell}>kfx</th>
              <th style={cell}>state</th>
            </tr>
          </thead>
          <tbody>
            {view.skills.map((skill) => (
              <React.Fragment key={skill.key}>
                <tr>
                  <td style={{ ...cell, color: '#9cdcfe' }}>{skill.key}</td>
                  <td style={cell}>{skill.kind}</td>
                  <td style={{ ...cell, color: '#ce9178' }}>
                    {skill.triggers.join(', ') || 'manual'}
                  </td>
                  <td style={cell}>
                    {skill.dependencySummary.total} total ·{' '}
                    <span style={{ color: '#4ec9b0' }}>
                      {skill.dependencySummary.resolved} resolved
                    </span>{' '}
                    ·{' '}
                    <span
                      style={{
                        color: skill.hasUnresolvedRequiredDependencies
                          ? '#f48771'
                          : '#858585',
                      }}
                    >
                      {skill.dependencySummary.unresolved} unresolved
                    </span>
                  </td>
                  <td style={cell}>
                    {skill.hasUnresolvedRequiredDependencies ? (
                      <span style={{ color: '#f48771' }}>blocked</span>
                    ) : (
                      <span style={{ color: '#4ec9b0' }}>ready</span>
                    )}
                  </td>
                </tr>
                {skill.dependencies.dependencies.map((row, index) => (
                  <tr key={`${skill.key}:${row.kfxKey}:${index}`}>
                    <td style={cell} />
                    <td style={{ ...cell, color: '#858585' }}>
                      {row.required ? 'required' : 'optional'}
                    </td>
                    <td style={{ ...cell, color: '#858585' }}>
                      role={row.role ?? '-'}
                    </td>
                    <td
                      style={{
                        ...cell,
                        color:
                          row.status === 'resolved' ? '#4ec9b0' : '#f48771',
                      }}
                    >
                      {row.status} · {row.kfxKey}
                    </td>
                    <td style={{ ...cell, color: '#6a6a6a' }}>
                      {packageLabel(row)}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
      {view.summary.unresolvedKfxKeys.length > 0 && (
        <div style={{ ...mono, color: '#f48771', marginTop: 8 }}>
          unresolved: {view.summary.unresolvedKfxKeys.join(', ')}
        </div>
      )}
    </section>
  );
}

export const View = SkillManagerViewComponent;
