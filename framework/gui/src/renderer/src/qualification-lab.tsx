// SPDX-License-Identifier: Apache-2.0

import type {
  AgentRuntimeCatalog,
  QualificationLab,
  QualificationLabAgentPlan,
  QualificationLabReport,
  QualificationLabStartupRoute,
} from '@kungfu-tech/api/capability';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

function shortRoot(value: string): string {
  return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
}

export function QualificationLabPanel({
  lab,
  startup,
  onOpenWork,
}: {
  lab: QualificationLab;
  startup: QualificationLabStartupRoute;
  onOpenWork?: () => void;
}) {
  const [agents, setAgents] = React.useState<AgentRuntimeCatalog | null>(null);
  const [selectedAgent, setSelectedAgent] = React.useState('');
  const [targetAgent, setTargetAgent] = React.useState('');
  const [agentPlan, setAgentPlan] =
    React.useState<QualificationLabAgentPlan | null>(null);
  const [targetPlan, setTargetPlan] =
    React.useState<QualificationLabAgentPlan | null>(null);
  const [report, setReport] = React.useState<QualificationLabReport | null>(
    null,
  );
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');

  const discover = React.useCallback(async () => {
    setBusy('discover');
    try {
      const catalog = await lab.discoverAgents();
      setAgents(catalog);
      const recommended =
        catalog.defaultProfileId ||
        catalog.recommendedProfileId ||
        catalog.discovered[0]?.profile.id ||
        catalog.configured[0]?.id ||
        '';
      setSelectedAgent(recommended);
      setTargetAgent(
        catalog.discovered
          .map((row) => row.profile.id)
          .find((id) => id !== recommended) || recommended,
      );
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  }, [lab]);

  React.useEffect(() => {
    void discover();
  }, [discover]);

  const runDemo = async () => {
    setBusy('demo');
    try {
      setReport(await lab.runDemo());
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };

  const previewAgent = async () => {
    if (!selectedAgent) return;
    setBusy('agent');
    try {
      const [source, target] = await Promise.all([
        lab.planAgent(selectedAgent),
        lab.planAgent(targetAgent || selectedAgent),
      ]);
      setAgentPlan(source);
      setTargetPlan(target);
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  const runAgent = async () => {
    if (!selectedAgent) return;
    setBusy('agent-run');
    try {
      setReport(await lab.runAgent(selectedAgent));
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };
  const runMigration = async () => {
    if (!selectedAgent || !targetAgent) return;
    setBusy('agent-run');
    try {
      setReport(await lab.runMigration(selectedAgent, targetAgent));
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };

  const options = Array.from(
    new Map(
      [
        ...(agents?.configured ?? []),
        ...(agents?.discovered.map((row) => row.profile) ?? []),
      ].map((profile) => [profile.id, profile]),
    ).values(),
  );
  return (
    <section
      style={{
        ...panelStyle,
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ ...mono, color: '#9cdcfe' }}>AGENT QUALIFICATION LAB</div>
      <h1 style={{ margin: '8px 0' }}>Prove continuity before configuration</h1>
      <p style={{ maxWidth: 820 }}>
        This Quickstart runs a real isolated two-session fixture offline. The
        bundled Demo Agent proves deterministic state recognition and
        continuation—not model intelligence, security, production fitness, or
        provider ranking.
      </p>
      <div style={{ ...mono, color: '#858585' }}>
        startup {startup.state} · {startup.reasonCode} · no real workspace write
      </div>
      {startup.route === 'diagnostic' ? (
        <div style={{ ...mono, color: '#f48771', marginTop: 12 }}>
          {startup.message}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button type="button" disabled={Boolean(busy)} onClick={runDemo}>
          {busy === 'demo' ? 'Running two fresh sessions…' : 'Run offline demo'}
        </button>
        {onOpenWork ? (
          <button type="button" onClick={onOpenWork}>
            Return to Work graph
          </button>
        ) : null}
      </div>
      {report ? (
        <article style={{ ...panelStyle, marginTop: 16 }}>
          <strong
            style={{
              color: report.status === 'failed' ? '#f48771' : '#4ec9b0',
            }}
          >
            {report.status}
          </strong>
          <div style={mono}>report {shortRoot(report.reportRoot)}</div>
          <div style={mono}>plan {shortRoot(report.planRoot)}</div>
          <div style={mono}>
            attempts {report.sessionAttempts.length} · fresh process · no prior
            transcript
          </div>
          <div style={{ ...mono, color: '#858585', marginTop: 6 }}>
            {report.meaning}
          </div>
        </article>
      ) : null}
      <h2 style={{ marginTop: 24 }}>Qualify your local agent</h2>
      <p>
        Kungfu discovers launch coordinates and bounded version output only. It
        does not read or copy provider credentials, prompts, chats, or sessions.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <select
          value={selectedAgent}
          onChange={(event) => setSelectedAgent(event.target.value)}
          style={{ minWidth: 320 }}
        >
          <option value="">No local agent discovered</option>
          {options.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label} · {profile.launch.executable}
            </option>
          ))}
        </select>
        <select
          aria-label="Continuation agent"
          value={targetAgent}
          onChange={(event) => setTargetAgent(event.target.value)}
          style={{ minWidth: 320 }}
        >
          <option value="">No continuation agent discovered</option>
          {options.map((profile) => (
            <option key={profile.id} value={profile.id}>
              then {profile.label} · {profile.launch.executable}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selectedAgent || Boolean(busy)}
          onClick={previewAgent}
        >
          Preview exact qualification
        </button>
        <button
          type="button"
          disabled={!agentPlan || Boolean(busy)}
          onClick={runAgent}
          title="Runs the selected provider twice in a discardable directory"
        >
          {busy === 'agent-run'
            ? 'Running selected agent…'
            : 'Run self-continuity'}
        </button>
        <button
          type="button"
          disabled={
            !agentPlan ||
            !targetPlan ||
            selectedAgent === targetAgent ||
            Boolean(busy)
          }
          onClick={runMigration}
          title="Runs the first session with the source and continuation with the target"
        >
          Run cross-provider handoff
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={discover}>
          Refresh
        </button>
      </div>
      {agentPlan ? (
        <pre
          style={{
            ...mono,
            whiteSpace: 'pre-wrap',
            padding: 12,
            background: '#111',
          }}
        >
          {JSON.stringify(agentPlan.commandPreview)}
          {'\n'}identity {agentPlan.identityRoot}
          {'\n'}plan {agentPlan.planRoot}
          {'\n'}continuation {JSON.stringify(targetPlan?.commandPreview)}
          {'\n'}continuation identity {targetPlan?.identityRoot}
          {'\n'}credential contents read: no
          {'\n'}Running uses the provider's existing authentication only after
          this explicit action.
        </pre>
      ) : null}
      {error ? (
        <div style={{ ...mono, color: '#f48771', marginTop: 12 }}>{error}</div>
      ) : null}
    </section>
  );
}
