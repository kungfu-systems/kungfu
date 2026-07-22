// System view: kfx manager. Lists every loaded kfx with its suite, declared
// capabilities, package coordinates and load source, and lets the user
// enable/disable non-system kfx individually or a whole suite as a unit; the
// choice persists through the shell state blob. Disabling never unloads code
// — it only removes views from navigation.
import {
  type KfxViewProps,
  type ManagedProfile,
  type ProfileApplicationProjection,
  type ProfileIntentPlan,
  type ProfileKfd3QualificationPlan,
  type ProfileLifecyclePlan,
  type ProfileManagerProjection,
  headingStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import React from 'react';

const healthColor: Record<ManagedProfile['health'], string> = {
  active: '#4ec9b0',
  inactive: '#9cdcfe',
  degraded: '#f48771',
  unavailable: '#dcdcaa',
  removed: '#858585',
};

function shortRoot(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;
}

const kfd3Badge = {
  qualified: '🛡️',
  untested: '◇',
  stale: '△',
  failed: '✕',
  testing: '⏳',
} as const;

function ProfileCard({
  managed,
  application,
  applicationError,
  planning,
  onPlan,
  onKfd3Plan,
  onIntentPlan,
}: {
  managed: ManagedProfile;
  application?: ProfileApplicationProjection;
  applicationError?: string;
  planning: boolean;
  onPlan: (action: 'qualify' | 'activate' | 'upgrade', source: string) => void;
  onKfd3Plan: (source: string) => void;
  onIntentPlan: (source: string, intentId: string) => void;
}) {
  const next =
    managed.lifecycleState === 'installed'
      ? 'qualify'
      : managed.lifecycleState === 'qualified'
        ? 'activate'
        : managed.lifecycleState === 'activated' &&
            managed.catalog &&
            !managed.catalog.activeExactRoot
          ? 'upgrade'
          : null;
  return (
    <article
      style={{
        border: '1px solid #3c3c3c',
        borderTop: `3px solid ${healthColor[managed.health]}`,
        borderRadius: 6,
        background: '#1f1f1f',
        padding: 12,
        minWidth: 280,
      }}
    >
      <div
        style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}
      >
        <strong style={{ color: '#9cdcfe' }}>{managed.profileId}</strong>
        <span style={{ color: healthColor[managed.health] }}>
          {managed.health}
        </span>
      </div>
      <div style={{ ...mono, color: '#858585', marginTop: 4 }}>
        {managed.lifecycleState} · revision {managed.profileRevision} · v
        {managed.profileVersion}
      </div>
      <div style={{ ...mono, marginTop: 8 }} title={managed.profileSuiteRoot}>
        suite {shortRoot(managed.profileSuiteRoot)}
      </div>
      <div style={{ ...mono }} title={managed.catalog?.catalogRoot}>
        catalog {shortRoot(managed.catalog?.catalogRoot)}
      </div>
      <div style={{ ...mono, color: '#ce9178', marginTop: 8 }}>
        permissions: {managed.grantedPermissions.join(', ') || 'none'}
      </div>
      <div style={{ ...mono, color: '#cccccc' }}>
        qualification:{' '}
        {Object.keys(managed.qualification).length
          ? 'recorded'
          : 'not recorded'}
      </div>
      {applicationError ? (
        <div style={{ ...mono, color: '#f48771', marginTop: 8 }}>
          Application projection unavailable: {applicationError}
        </div>
      ) : null}
      {application ? (
        <div
          style={{
            borderTop: '1px solid #3c3c3c',
            marginTop: 10,
            paddingTop: 10,
          }}
        >
          <div style={{ color: '#dcdcaa' }}>{application.value.summary}</div>
          <div style={{ ...mono, color: '#858585', marginTop: 4 }}>
            {application.participants
              .map((participant) => `${participant.kind}:${participant.title}`)
              .join(' · ')}
          </div>
          <div style={{ ...mono, color: '#858585' }}>
            {application.constraints.length} constraints ·{' '}
            {application.knownLimits.length} known limits ·{' '}
            <span
              title={
                application.qualified
                  ? `${application.qualification.issuer?.name ?? 'KFD-3 qualification'} · profile ${application.profileSuiteRoot} · runtime ${application.qualification.runtimeContractRoot} · receipt ${application.qualification.receiptId}`
                  : application.qualification.reason ||
                    String(
                      application.qualification.diagnosis?.message ||
                        'qualification not earned',
                    )
              }
            >
              {kfd3Badge[application.qualification.status]} KFD-3
            </span>
          </div>
          {application.qualification.status !== 'qualified' &&
          application.activeExactRoot &&
          application.qualification.nextActions.some(
            (next) => next.action === 'profile.kfd3.qualify',
          ) ? (
            <button
              type="button"
              disabled={planning}
              title="Review the exact probes before running KFD-3 qualification"
              onClick={() => onKfd3Plan(application.source)}
              style={{ ...mono, marginTop: 8, marginRight: 8 }}
            >
              Test KFD-3
            </button>
          ) : null}
          {application.intents.map((intent) => (
            <button
              key={intent.id}
              type="button"
              disabled={
                'mode' in intent.protocol &&
                intent.protocol.mode === 'shared-api'
                  ? true
                  : planning ||
                    !application.activeExactRoot ||
                    intent.missingCapabilities.length > 0
              }
              title={
                'mode' in intent.protocol &&
                intent.protocol.mode === 'shared-api'
                  ? `${intent.protocol.apiId} · the Product GUI and Agent CLI use this same capability API`
                  : intent.missingCapabilities.length
                    ? `Missing: ${intent.missingCapabilities.join(', ')}`
                    : `${intent.requiredAuthority} · inspect → advise → preview → authorize → execute → receipt → verify`
              }
              onClick={() => {
                if (!('mode' in intent.protocol)) {
                  onIntentPlan(application.source, intent.id);
                }
              }}
              style={{ ...mono, marginTop: 8, marginRight: 8 }}
            >
              {'mode' in intent.protocol &&
              intent.protocol.mode === 'shared-api'
                ? `↗ ${intent.title}`
                : intent.title}
            </button>
          ))}
        </div>
      ) : null}
      <div style={{ ...mono, color: '#cccccc' }}>
        views:{' '}
        {managed.catalog?.views.map((view) => view.title).join(', ') ||
          'none available'}
      </div>
      {managed.diagnostics.map((diagnosis) => (
        <div
          key={diagnosis.code}
          style={{
            ...mono,
            color: diagnosis.ok ? '#858585' : '#f48771',
            marginTop: 6,
          }}
        >
          {diagnosis.code}: {diagnosis.message}
        </div>
      ))}
      {next && managed.source ? (
        <button
          type="button"
          disabled={planning}
          onClick={() => onPlan(next, managed.source as string)}
          style={{ ...mono, marginTop: 10 }}
        >
          {planning ? 'planning…' : `Preview ${next} plan`}
        </button>
      ) : null}
    </article>
  );
}

function KfxManagerView({ caps, shell }: KfxViewProps) {
  const [manager, setManager] = React.useState<ProfileManagerProjection | null>(
    null,
  );
  const [error, setError] = React.useState('');
  const [applications, setApplications] = React.useState<
    Record<string, ProfileApplicationProjection>
  >({});
  const [applicationErrors, setApplicationErrors] = React.useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState<{
    plan: ProfileLifecyclePlan;
    action: 'qualify' | 'activate' | 'upgrade';
    source: string;
  } | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [pendingIntent, setPendingIntent] = React.useState<{
    plan: ProfileIntentPlan;
    source: string;
    intentId: string;
  } | null>(null);
  const [pendingKfd3, setPendingKfd3] = React.useState<{
    plan: ProfileKfd3QualificationPlan;
    source: string;
  } | null>(null);
  const [authorizedBy, setAuthorizedBy] = React.useState('');
  const profile =
    shell.profiles.find((p) => p.id === shell.state.profileId) ??
    shell.profiles[0];
  const onRefresh = shell.onRefresh;

  const refresh = React.useCallback(async () => {
    if (!caps.profile) return;
    setLoading(true);
    try {
      const next = await caps.profile.managerAsync();
      setManager(next);
      const rows = await Promise.all(
        next.profiles
          .filter((managed) => managed.source)
          .map(async (managed) => {
            try {
              return {
                profileId: managed.profileId,
                application: await caps.profile?.applicationAsync(
                  managed.source as string,
                ),
              };
            } catch (reason) {
              return {
                profileId: managed.profileId,
                error: (reason as Error).message,
              };
            }
          }),
      );
      setApplications(
        Object.fromEntries(
          rows
            .filter((row) => row.application)
            .map((row) => [row.profileId, row.application]),
        ) as Record<string, ProfileApplicationProjection>,
      );
      setApplicationErrors(
        Object.fromEntries(
          rows
            .filter((row) => row.error)
            .map((row) => [row.profileId, row.error]),
        ) as Record<string, string>,
      );
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, [caps.profile]);

  React.useEffect(() => {
    void refresh();
    return onRefresh(() => void refresh());
  }, [onRefresh, refresh]);

  const previewPlan = async (
    action: 'qualify' | 'activate' | 'upgrade',
    source: string,
  ) => {
    if (!caps.profile) return;
    setPlanning(true);
    try {
      setPending({
        plan: await caps.profile.lifecyclePlanAsync(action, source),
        action,
        source,
      });
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const previewIntent = async (source: string, intentId: string) => {
    if (!caps.profile) return;
    setPlanning(true);
    try {
      setPendingIntent({
        plan: await caps.profile.intentPlanAsync(source, intentId),
        source,
        intentId,
      });
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const previewKfd3 = async (source: string) => {
    if (!caps.profile) return;
    setPlanning(true);
    try {
      setPendingKfd3({
        plan: await caps.profile.kfd3PlanAsync(source),
        source,
      });
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const approveKfd3 = async () => {
    if (!caps.profile || !pendingKfd3 || !authorizedBy.trim()) return;
    setPlanning(true);
    try {
      await caps.profile.authorizeKfd3Async(
        pendingKfd3.source,
        pendingKfd3.plan.planId,
        'approve',
        authorizedBy.trim(),
      );
      setPendingKfd3(null);
      await refresh();
      shell.notify({ level: 'success', title: '🛡️ KFD-3 qualification earned' });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const approveIntent = async () => {
    if (!caps.profile || !pendingIntent || !authorizedBy.trim()) return;
    setPlanning(true);
    try {
      const receipt = await caps.profile.authorizeIntentAsync(
        pendingIntent.source,
        pendingIntent.intentId,
        pendingIntent.plan.planId,
        'approve',
        authorizedBy.trim(),
      );
      setPendingIntent(null);
      await refresh();
      shell.notify({
        level: receipt.verification?.verified ? 'success' : 'warning',
        title: receipt.verification?.verified
          ? 'Intent receipt verified'
          : 'Intent executed; verification incomplete',
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const approveAndApply = async () => {
    if (!caps.profile || !pending || !authorizedBy.trim()) return;
    setPlanning(true);
    try {
      await caps.profile.authorizeLifecycleAsync(
        pending.action,
        pending.source,
        String(pending.plan.corePlan.plan_id ?? ''),
        'approve',
        authorizedBy.trim(),
      );
      setPending(null);
      await refresh();
      shell.notify({
        level: 'success',
        title: `Profile ${pending.action} applied`,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const toggleKfx = (id: string, disabled: boolean) => {
    shell.updateState({
      disabledKfx: disabled
        ? shell.state.disabledKfx.filter((entry) => entry !== id)
        : [...shell.state.disabledKfx, id],
    });
  };

  const toggleSuite = (key: string, disabled: boolean) => {
    shell.updateState({
      disabledSuites: disabled
        ? shell.state.disabledSuites.filter((entry) => entry !== key)
        : [...shell.state.disabledSuites, key],
    });
  };

  const cell: React.CSSProperties = { padding: '2px 12px 2px 0' };

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>Profiles · {manager?.count ?? 0}</h2>
      <div style={{ ...mono, color: '#858585', marginBottom: 10 }}>
        Runtime activation controls composition authority. GUI focus is “
        {profile?.id}” and only controls the working surface; it does not
        activate a Profile.
      </div>
      {loading ? <div style={mono}>Loading Profile lifecycle…</div> : null}
      {error ? <div style={{ ...mono, color: '#f48771' }}>{error}</div> : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 10,
          marginBottom: 12,
        }}
      >
        {manager?.profiles.map((managed) => (
          <ProfileCard
            key={managed.profileId}
            managed={managed}
            application={applications[managed.profileId]}
            applicationError={applicationErrors[managed.profileId]}
            planning={planning}
            onPlan={(action, source) => void previewPlan(action, source)}
            onKfd3Plan={(source) => void previewKfd3(source)}
            onIntentPlan={(source, intentId) =>
              void previewIntent(source, intentId)
            }
          />
        ))}
        {!loading && manager?.count === 0 ? (
          <div style={{ ...mono, color: '#858585', padding: 12 }}>
            No Profile is installed in this workspace. An agent can start with{' '}
            <span style={{ color: '#9cdcfe' }}>
              kungfu profile capabilities --json
            </span>{' '}
            and preview an install plan; source files remain portable and do not
            require rebuilding Kungfu.
          </div>
        ) : null}
      </div>
      {pendingKfd3 ? (
        <div
          style={{
            ...mono,
            border: '1px solid #dcdcaa',
            padding: 10,
            marginBottom: 12,
          }}
        >
          <strong style={{ color: '#dcdcaa' }}>◇ KFD-3 test plan</strong>
          <div>profile {shortRoot(pendingKfd3.plan.profileSuiteRoot)}</div>
          <div>runtime {shortRoot(pendingKfd3.plan.runtimeContractRoot)}</div>
          <div>plan {shortRoot(pendingKfd3.plan.planId)}</div>
          <div style={{ color: '#858585' }}>
            {pendingKfd3.plan.probes.join(' · ')}
          </div>
          <label style={{ display: 'block', marginTop: 8 }}>
            authorized by{' '}
            <input
              value={authorizedBy}
              onChange={(event) => setAuthorizedBy(event.target.value)}
              placeholder="workspace profile operator"
              style={{ ...mono, minWidth: 220 }}
            />
          </label>
          <button
            type="button"
            disabled={planning || !authorizedBy.trim()}
            onClick={() => void approveKfd3()}
            style={{ ...mono, marginTop: 8, marginRight: 8 }}
          >
            Run exact test plan
          </button>
          <button
            type="button"
            disabled={planning}
            onClick={() => setPendingKfd3(null)}
            style={{ ...mono, marginTop: 8 }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {pending ? (
        <div
          style={{
            ...mono,
            border: '1px solid #dcdcaa',
            padding: 10,
            marginBottom: 12,
          }}
        >
          <strong style={{ color: '#dcdcaa' }}>
            Decision required before mutation
          </strong>
          <div>plan {String(pending.plan.corePlan.plan_id ?? '—')}</div>
          <div>
            {String(
              pending.plan.decisionCard.prompt ??
                'Review the exact decision card in the Agent/CLI flow.',
            )}
          </div>
          <div style={{ color: '#858585' }}>
            GUI and Agent use the same installed decision-card contract. The
            runtime re-plans and rejects drift before apply.
          </div>
          <label style={{ display: 'block', marginTop: 8 }}>
            authorized by{' '}
            <input
              value={authorizedBy}
              onChange={(event) => setAuthorizedBy(event.target.value)}
              placeholder="workspace owner identity"
              style={{ ...mono, minWidth: 220 }}
            />
          </label>
          <button
            type="button"
            disabled={planning || !authorizedBy.trim()}
            onClick={() => void approveAndApply()}
            style={{ ...mono, marginTop: 8, marginRight: 8 }}
          >
            Approve exact plan
          </button>
          <button
            type="button"
            disabled={planning}
            onClick={() => setPending(null)}
            style={{ ...mono, marginTop: 8 }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {pendingIntent ? (
        <div
          style={{
            ...mono,
            border: '1px solid #dcdcaa',
            padding: 10,
            marginBottom: 12,
          }}
        >
          <strong style={{ color: '#dcdcaa' }}>Intent decision required</strong>
          <div>intent {pendingIntent.intentId}</div>
          <div>plan {pendingIntent.plan.planId}</div>
          <div style={{ color: '#858585' }}>
            This exact plan is shared with the Agent CLI. Apply re-plans, emits
            a receipt, and verifies the same Profile and collaboration roots.
          </div>
          <label style={{ display: 'block', marginTop: 8 }}>
            authorized by{' '}
            <input
              value={authorizedBy}
              onChange={(event) => setAuthorizedBy(event.target.value)}
              placeholder="declared authority identity"
              style={{ ...mono, minWidth: 220 }}
            />
          </label>
          <button
            type="button"
            disabled={planning || !authorizedBy.trim()}
            onClick={() => void approveIntent()}
            style={{ ...mono, marginTop: 8, marginRight: 8 }}
          >
            Approve exact intent
          </button>
          <button
            type="button"
            disabled={planning}
            onClick={() => setPendingIntent(null)}
            style={{ ...mono, marginTop: 8 }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <h2 style={headingStyle}>KFX runtime · {shell.registry.length} loaded</h2>
      <table style={{ ...mono, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#858585', textAlign: 'left' }}>
            <th style={cell}>id</th>
            <th style={cell}>title</th>
            <th style={cell}>suite</th>
            <th style={cell}>capabilities</th>
            <th style={cell}>package</th>
            <th style={cell}>source</th>
            <th style={cell}>state</th>
          </tr>
        </thead>
        <tbody>
          {shell.registry.map((entry) => {
            const inProfile =
              entry.system || (profile?.kfx.includes(entry.id) ?? false);
            const disabled = shell.state.disabledKfx.includes(entry.id);
            return (
              <tr key={entry.id}>
                <td style={{ ...cell, color: '#9cdcfe' }}>{entry.id}</td>
                <td style={cell}>{entry.title}</td>
                <td style={{ ...cell, color: '#858585' }}>
                  {entry.suite ?? '—'}
                </td>
                <td style={{ ...cell, color: '#ce9178' }}>
                  {entry.capabilities.join(', ') || '—'}
                </td>
                <td style={{ ...cell, color: '#858585' }}>
                  {entry.packageName
                    ? `${entry.packageName}@${entry.version ?? '?'}`
                    : '—'}
                </td>
                <td style={{ ...cell, color: '#6a6a6a' }}>{entry.source}</td>
                <td style={cell}>
                  {entry.system ? (
                    <span style={{ color: '#6a6a6a' }}>system · always on</span>
                  ) : !inProfile ? (
                    <span style={{ color: '#6a6a6a' }}>not in profile</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleKfx(entry.id, disabled)}
                      style={{
                        ...mono,
                        padding: '1px 8px',
                        border: '1px solid #3c3c3c',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: 'transparent',
                        color: disabled ? '#f48771' : '#4ec9b0',
                      }}
                    >
                      {disabled ? 'disabled — enable' : 'enabled — disable'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2 style={{ ...headingStyle, marginTop: 12 }}>
        Suites · {Object.keys(shell.suites).length}
      </h2>
      {Object.entries(shell.suites).map(([key, suite]) => {
        const disabled = shell.state.disabledSuites.includes(key);
        const isSystem = shell.registry.some(
          (entry) => entry.suite === key && entry.system,
        );
        return (
          <div key={key} style={{ ...mono, padding: '2px 0' }}>
            <span style={{ color: '#9cdcfe' }}>{key}</span> · {suite.title} ·
            members: {suite.members.join(', ')}{' '}
            {isSystem ? (
              <span style={{ color: '#6a6a6a' }}>system · always on</span>
            ) : (
              <button
                type="button"
                onClick={() => toggleSuite(key, disabled)}
                style={{
                  ...mono,
                  padding: '1px 8px',
                  border: '1px solid #3c3c3c',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: 'transparent',
                  color: disabled ? '#f48771' : '#4ec9b0',
                }}
              >
                {disabled
                  ? 'suite disabled — enable'
                  : 'suite enabled — disable'}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export const View = KfxManagerView;
