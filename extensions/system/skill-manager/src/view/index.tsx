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

type AgentSkillTarget = SkillManagerView['agentInventory']['targets'][0];
type AgentSkillEntry = AgentSkillTarget['skills'][0];

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

function readSkillManagerViewFromEnv(): SkillManagerView | null {
  try {
    const win = window as unknown as {
      require?: (id: string) => {
        readFileSync: (p: string, enc: string) => string;
      };
      process?: { env?: Record<string, string | undefined> };
    };
    const managerPath = win.process?.env?.KF_SKILL_MANAGER_FILE;
    if (!managerPath || !win.require) return null;
    return asSkillManagerView(
      JSON.parse(win.require('node:fs').readFileSync(managerPath, 'utf8')),
    );
  } catch {
    return null;
  }
}

function packageLabel(
  row: SkillManagerEntry['dependencies']['dependencies'][0],
) {
  return row.package
    ? `${row.package.name ?? row.package.key}@${row.package.version ?? '?'}`
    : (row.reason ?? 'not resolved');
}

function statusColor(status: string) {
  if (status === 'ok' || status === 'resolved') return '#4ec9b0';
  if (status === 'missing') return '#858585';
  return '#f48771';
}

function shortHome(path: string) {
  const home = (
    window as unknown as { process?: { env?: Record<string, string> } }
  ).process?.env?.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function AgentSkillRow({
  skill,
  cell,
}: {
  skill: AgentSkillEntry;
  cell: React.CSSProperties;
}) {
  return (
    <tr>
      <td style={{ ...cell, color: skill.effective ? '#9cdcfe' : '#858585' }}>
        {skill.key}
      </td>
      <td style={cell}>{skill.rootType}</td>
      <td style={{ ...cell, color: statusColor(skill.parseStatus) }}>
        {skill.parseStatus}
      </td>
      <td style={cell}>{skill.effective ? 'effective' : 'shadowed'}</td>
      <td style={{ ...cell, color: '#6a6a6a' }}>
        {skill.hash ? skill.hash.slice(0, 19) : '-'}
      </td>
      <td style={{ ...cell, color: '#6a6a6a' }}>{shortHome(skill.path)}</td>
    </tr>
  );
}

function SkillManagerViewComponent({ shell }: KfxViewProps) {
  const view =
    asSkillManagerView(shell.info.skillManager) ??
    readSkillManagerViewFromEnv();
  const agentInventory = view?.agentInventory ?? {
    schema: 'kungfu.agent-skill-inventory/v1' as const,
    targets: [],
    summary: {
      targets: 0,
      roots: 0,
      availableRoots: 0,
      skills: 0,
      effective: 0,
      shadowed: 0,
      errors: 0,
    },
  };
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
      <h2 style={{ ...headingStyle, marginTop: 18 }}>
        Agent inventory · {agentInventory.summary.targets} targets ·{' '}
        {agentInventory.summary.effective} effective skills
      </h2>
      {agentInventory.targets.length === 0 ? (
        <div style={{ ...mono, color: '#6a6a6a' }}>
          no Codex or Claude skill roots discovered
        </div>
      ) : (
        agentInventory.targets.map((target) => (
          <section key={target.label} style={{ marginTop: 10 }}>
            <div style={{ ...mono, color: '#cccccc', marginBottom: 4 }}>
              {target.provider} · {shortHome(target.home)} ·{' '}
              {target.summary.effective} effective / {target.summary.skills}{' '}
              scanned
            </div>
            <div style={{ ...mono, color: '#6a6a6a', marginBottom: 4 }}>
              roots:{' '}
              {target.roots
                .map(
                  (root) =>
                    `${root.rootType}:${shortHome(root.path)}(${root.status})`,
                )
                .join(' · ')}
            </div>
            {target.skills.length === 0 ? (
              <div style={{ ...mono, color: '#6a6a6a' }}>
                no skills found in available roots
              </div>
            ) : (
              <table
                style={{ ...mono, borderCollapse: 'collapse', minWidth: 900 }}
              >
                <thead>
                  <tr style={{ color: '#858585', textAlign: 'left' }}>
                    <th style={cell}>skill</th>
                    <th style={cell}>root</th>
                    <th style={cell}>parse</th>
                    <th style={cell}>effective</th>
                    <th style={cell}>hash</th>
                    <th style={cell}>path</th>
                  </tr>
                </thead>
                <tbody>
                  {target.skills.map((skill) => (
                    <AgentSkillRow
                      key={`${target.label}:${skill.path}:${skill.duplicateIndex}`}
                      skill={skill}
                      cell={cell}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))
      )}
    </section>
  );
}

export const View = SkillManagerViewComponent;
