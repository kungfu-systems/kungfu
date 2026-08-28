// System view: kfx manager. Lists every loaded kfx with its suite, declared
// capabilities, package coordinates and load source, and lets the user
// enable/disable non-system kfx individually or a whole suite as a unit; the
// choice persists through the shell state blob. Disabling never unloads code
// — it only removes views from navigation.
import {
  type KfxControlPlan,
  type KfxControlStatus,
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

function useManagerProjection({ caps, shell }: KfxViewProps) {
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
  const initialLoad = React.useRef(true);
  const [controlStatus, setControlStatus] =
    React.useState<KfxControlStatus | null>(null);
  const onRefresh = shell.onRefresh;

  const refresh = React.useCallback(async () => {
    if (!caps.profile) return;
    if (initialLoad.current) setLoading(true);
    try {
      const next = await caps.profile.managerAsync();
      setManager(next);
      initialLoad.current = false;
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
      if (caps.kfxControl) {
        setControlStatus(caps.kfxControl.status());
      }
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, [caps.kfxControl, caps.profile]);

  React.useEffect(() => {
    void refresh();
    return onRefresh(() => void refresh());
  }, [onRefresh, refresh]);

  return {
    applicationErrors,
    applications,
    controlStatus,
    error,
    loading,
    manager,
    refresh,
    setControlStatus,
    setError,
  };
}

type PlanningContext = {
  authorizedBy: string;
  caps: KfxViewProps['caps'];
  refresh: () => Promise<void>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  setPlanning: React.Dispatch<React.SetStateAction<boolean>>;
  shell: KfxViewProps['shell'];
};

function useLifecyclePlanning(context: PlanningContext) {
  const { authorizedBy, caps, refresh, setError, setPlanning, shell } = context;
  const [pending, setPending] = React.useState<{
    plan: ProfileLifecyclePlan;
    action: 'qualify' | 'activate' | 'upgrade';
    source: string;
  } | null>(null);

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

  return { approveAndApply, pending, previewPlan, setPending };
}

function useIntentPlanning(context: PlanningContext) {
  const { authorizedBy, caps, refresh, setError, setPlanning, shell } = context;
  const [pendingIntent, setPendingIntent] = React.useState<{
    plan: ProfileIntentPlan;
    source: string;
    intentId: string;
  } | null>(null);

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

  return { approveIntent, pendingIntent, previewIntent, setPendingIntent };
}

function useKfd3Planning(context: PlanningContext) {
  const { authorizedBy, caps, refresh, setError, setPlanning, shell } = context;
  const [pendingKfd3, setPendingKfd3] = React.useState<{
    plan: ProfileKfd3QualificationPlan;
    source: string;
  } | null>(null);

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

  return { approveKfd3, pendingKfd3, previewKfd3, setPendingKfd3 };
}

type ControlPlanningArgs = {
  context: PlanningContext;
  projection: ReturnType<typeof useManagerProjection>;
};

function useControlPlanning(args: ControlPlanningArgs) {
  const { context, projection } = args;
  const { authorizedBy, caps, refresh, setError, setPlanning, shell } = context;
  const { setControlStatus } = projection;
  const [pendingControl, setPendingControl] = React.useState<{
    plan: KfxControlPlan;
    operation: 'install' | 'update';
    path: string;
  } | null>(null);

  const previewControl = (operation: 'install' | 'update', path: string) => {
    if (!caps.kfxControl) return;
    setPlanning(true);
    try {
      setPendingControl({
        plan: caps.kfxControl.plan(operation, { kind: 'product', path }),
        operation,
        path,
      });
      setError('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const approveControl = async () => {
    if (!caps.kfxControl || !pendingControl || !authorizedBy.trim()) return;
    setPlanning(true);
    try {
      const receipt = caps.kfxControl.apply(
        pendingControl.operation,
        { kind: 'product', path: pendingControl.path },
        pendingControl.plan,
        authorizedBy.trim(),
      );
      setPendingControl(null);
      setControlStatus(receipt.status);
      await refresh();
      shell.notify({
        level: 'success',
        title: `KFX Control ${pendingControl.operation} settled`,
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  return { approveControl, pendingControl, previewControl, setPendingControl };
}

function useKfxManagerController({ caps, shell }: KfxViewProps) {
  const projection = useManagerProjection({ caps, shell });
  const [planning, setPlanning] = React.useState(false);
  const [authorizedBy, setAuthorizedBy] = React.useState('');
  const context = {
    authorizedBy,
    caps,
    refresh: projection.refresh,
    setError: projection.setError,
    setPlanning,
    shell,
  };
  const lifecycle = useLifecyclePlanning(context);
  const intent = useIntentPlanning(context);
  const kfd3 = useKfd3Planning(context);
  const control = useControlPlanning({ context, projection });
  const profile =
    shell.profiles.find((item) => item.id === shell.state.profileId) ??
    shell.profiles[0];

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

  return {
    ...projection,
    ...lifecycle,
    ...intent,
    ...kfd3,
    ...control,
    authorizedBy,
    planning,
    profile,
    setAuthorizedBy,
    toggleKfx,
    toggleSuite,
  };
}

type KfxManagerContentProps = {
  controller: ReturnType<typeof useKfxManagerController>;
  shell: KfxViewProps['shell'];
};

function KfxControlSection(props: KfxManagerContentProps) {
  const { controller, shell } = props;
  const {
    approveControl,
    authorizedBy,
    controlStatus,
    pendingControl,
    planning,
    previewControl,
    setAuthorizedBy,
    setPendingControl,
  } = controller;
  const managerDir = shell.registry.find(
    (entry) => entry.id === 'kfx-manager',
  )?.dir;
  return (
    <>
      <h2 style={headingStyle}>KFX Control Suite</h2>
      <div
        style={{
          ...mono,
          border: `1px solid ${controlStatus?.mode === 'active' ? '#4ec9b0' : '#f48771'}`,
          padding: 10,
          marginBottom: 12,
        }}
      >
        <div>
          mode {controlStatus?.mode ?? 'unavailable'} · revision{' '}
          {controlStatus?.revision ?? 0}
        </div>
        <div>status {shortRoot(controlStatus?.statusRoot)}</div>
        <div>active {shortRoot(controlStatus?.active?.packageRoot)}</div>
        <div>
          last known good {shortRoot(controlStatus?.lastKnownGood?.packageRoot)}
        </div>
        <div style={{ color: '#858585', marginTop: 6 }}>
          Core independently verifies the embedded bootstrap ceiling; every
          mutation settles through the public KFX Fact/Work named-Cut CAS.
        </div>
        {managerDir ? (
          <button
            type="button"
            disabled={planning}
            onClick={() =>
              previewControl(
                controlStatus?.active ? 'update' : 'install',
                managerDir,
              )
            }
            style={{ ...mono, marginTop: 8, marginRight: 8 }}
          >
            Preview exact self-{controlStatus?.active ? 'update' : 'install'}
          </button>
        ) : null}
        {controlStatus?.lastKnownGood?.sourcePath &&
        controlStatus.lastKnownGood.packageRoot !==
          controlStatus.active?.packageRoot ? (
          <button
            type="button"
            disabled={planning}
            onClick={() =>
              previewControl(
                'update',
                controlStatus.lastKnownGood?.sourcePath as string,
              )
            }
            style={{ ...mono, marginTop: 8 }}
          >
            Preview last-known-good rollback
          </button>
        ) : null}
      </div>
      {pendingControl ? (
        <div
          style={{
            ...mono,
            border: '1px solid #dcdcaa',
            padding: 10,
            marginBottom: 12,
          }}
        >
          <strong style={{ color: '#dcdcaa' }}>
            Control Suite decision required
          </strong>
          <div>plan {pendingControl.plan.controlPlanRoot}</div>
          <div>policy {pendingControl.plan.bootstrapPolicyRoot}</div>
          <div>candidate {pendingControl.plan.candidate.packageRoot}</div>
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
            onClick={() => void approveControl()}
            style={{ ...mono, marginTop: 8, marginRight: 8 }}
          >
            Approve exact Control plan
          </button>
          <button
            type="button"
            disabled={planning}
            onClick={() => setPendingControl(null)}
            style={{ ...mono, marginTop: 8 }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}

function ProfileOverviewSection(props: KfxManagerContentProps) {
  const { controller } = props;
  const {
    applicationErrors,
    applications,
    error,
    loading,
    manager,
    planning,
    previewIntent,
    previewKfd3,
    previewPlan,
    profile,
  } = controller;
  return (
    <>
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
    </>
  );
}

type DecisionPanelProps = {
  approve: () => void;
  approveLabel: string;
  authorizedBy: string;
  children: React.ReactNode;
  dismiss: () => void;
  planning: boolean;
  placeholder: string;
  setAuthorizedBy: React.Dispatch<React.SetStateAction<string>>;
  title: string;
};

function DecisionPanel(props: DecisionPanelProps) {
  const {
    approve,
    approveLabel,
    authorizedBy,
    children,
    dismiss,
    planning,
    placeholder,
    setAuthorizedBy,
    title,
  } = props;
  return (
    <div
      style={{
        ...mono,
        border: '1px solid #dcdcaa',
        padding: 10,
        marginBottom: 12,
      }}
    >
      <strong style={{ color: '#dcdcaa' }}>{title}</strong>
      {children}
      <label style={{ display: 'block', marginTop: 8 }}>
        authorized by{' '}
        <input
          value={authorizedBy}
          onChange={(event) => setAuthorizedBy(event.target.value)}
          placeholder={placeholder}
          style={{ ...mono, minWidth: 220 }}
        />
      </label>
      <button
        type="button"
        disabled={planning || !authorizedBy.trim()}
        onClick={approve}
        style={{ ...mono, marginTop: 8, marginRight: 8 }}
      >
        {approveLabel}
      </button>
      <button
        type="button"
        disabled={planning}
        onClick={dismiss}
        style={{ ...mono, marginTop: 8 }}
      >
        Dismiss
      </button>
    </div>
  );
}

function ProfileDecisionSections(props: KfxManagerContentProps) {
  const {
    approveAndApply,
    approveIntent,
    approveKfd3,
    authorizedBy,
    pending,
    pendingIntent,
    pendingKfd3,
    planning,
    setAuthorizedBy,
    setPending,
    setPendingIntent,
    setPendingKfd3,
  } = props.controller;
  return (
    <>
      {pendingKfd3 ? (
        <DecisionPanel
          approve={() => void approveKfd3()}
          approveLabel="Run exact test plan"
          authorizedBy={authorizedBy}
          dismiss={() => setPendingKfd3(null)}
          planning={planning}
          placeholder="workspace profile operator"
          setAuthorizedBy={setAuthorizedBy}
          title="◇ KFD-3 test plan"
        >
          <div>profile {shortRoot(pendingKfd3.plan.profileSuiteRoot)}</div>
          <div>runtime {shortRoot(pendingKfd3.plan.runtimeContractRoot)}</div>
          <div>plan {shortRoot(pendingKfd3.plan.planId)}</div>
          <div style={{ color: '#858585' }}>
            {pendingKfd3.plan.probes.join(' · ')}
          </div>
        </DecisionPanel>
      ) : null}
      {pending ? (
        <DecisionPanel
          approve={() => void approveAndApply()}
          approveLabel="Approve exact plan"
          authorizedBy={authorizedBy}
          dismiss={() => setPending(null)}
          planning={planning}
          placeholder="workspace owner identity"
          setAuthorizedBy={setAuthorizedBy}
          title="Decision required before mutation"
        >
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
        </DecisionPanel>
      ) : null}
      {pendingIntent ? (
        <DecisionPanel
          approve={() => void approveIntent()}
          approveLabel="Approve exact intent"
          authorizedBy={authorizedBy}
          dismiss={() => setPendingIntent(null)}
          planning={planning}
          placeholder="declared authority identity"
          setAuthorizedBy={setAuthorizedBy}
          title="Intent decision required"
        >
          <div>intent {pendingIntent.intentId}</div>
          <div>plan {pendingIntent.plan.planId}</div>
          <div style={{ color: '#858585' }}>
            This exact plan is shared with the Agent CLI. Apply re-plans, emits
            a receipt, and verifies the same Profile and collaboration roots.
          </div>
        </DecisionPanel>
      ) : null}
    </>
  );
}

const tableCell: React.CSSProperties = { padding: '2px 12px 2px 0' };

type RuntimeRowProps = {
  disabled: boolean;
  entry: KfxViewProps['shell']['registry'][number];
  inProfile: boolean;
  toggleKfx: (id: string, disabled: boolean) => void;
};

function KfxRuntimeRow(props: RuntimeRowProps) {
  const { disabled, entry, inProfile, toggleKfx } = props;
  return (
    <tr>
      <td style={{ ...tableCell, color: '#9cdcfe' }}>{entry.id}</td>
      <td style={tableCell}>{entry.title}</td>
      <td style={{ ...tableCell, color: '#858585' }}>{entry.suite ?? '—'}</td>
      <td style={{ ...tableCell, color: '#ce9178' }}>
        {entry.capabilities.join(', ') || '—'}
      </td>
      <td style={{ ...tableCell, color: '#858585' }}>
        {entry.packageName
          ? `${entry.packageName}@${entry.version ?? '?'}`
          : '—'}
      </td>
      <td style={{ ...tableCell, color: '#6a6a6a' }}>{entry.source}</td>
      <td style={tableCell}>
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
}

type SuiteRowProps = {
  disabled: boolean;
  isSystem: boolean;
  name: string;
  suite: KfxViewProps['shell']['suites'][string];
  toggleSuite: (key: string, disabled: boolean) => void;
};

function KfxSuiteRow(props: SuiteRowProps) {
  const { disabled, isSystem, name, suite, toggleSuite } = props;
  return (
    <div style={{ ...mono, padding: '2px 0' }}>
      <span style={{ color: '#9cdcfe' }}>{name}</span> · {suite.title} ·
      members: {suite.members.join(', ')}{' '}
      {isSystem ? (
        <span style={{ color: '#6a6a6a' }}>system · always on</span>
      ) : (
        <button
          type="button"
          onClick={() => toggleSuite(name, disabled)}
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
          {disabled ? 'suite disabled — enable' : 'suite enabled — disable'}
        </button>
      )}
    </div>
  );
}

function KfxRegistrySection(props: KfxManagerContentProps) {
  const { controller, shell } = props;
  const { profile, toggleKfx, toggleSuite } = controller;
  return (
    <>
      <h2 style={headingStyle}>KFX runtime · {shell.registry.length} loaded</h2>
      <table style={{ ...mono, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#858585', textAlign: 'left' }}>
            {[
              'id',
              'title',
              'suite',
              'capabilities',
              'package',
              'source',
              'state',
            ].map((label) => (
              <th key={label} style={tableCell}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shell.registry.map((entry) => (
            <KfxRuntimeRow
              key={entry.id}
              entry={entry}
              disabled={shell.state.disabledKfx.includes(entry.id)}
              inProfile={
                entry.system || (profile?.kfx.includes(entry.id) ?? false)
              }
              toggleKfx={toggleKfx}
            />
          ))}
        </tbody>
      </table>
      <h2 style={{ ...headingStyle, marginTop: 12 }}>
        Suites · {Object.keys(shell.suites).length}
      </h2>
      {Object.entries(shell.suites).map(([name, suite]) => (
        <KfxSuiteRow
          key={name}
          name={name}
          suite={suite}
          disabled={shell.state.disabledSuites.includes(name)}
          isSystem={shell.registry.some(
            (entry) => entry.suite === name && entry.system,
          )}
          toggleSuite={toggleSuite}
        />
      ))}
    </>
  );
}

function KfxManagerContent(props: KfxManagerContentProps) {
  return (
    <section style={panelStyle}>
      <KfxControlSection {...props} />
      <ProfileOverviewSection {...props} />
      <ProfileDecisionSections {...props} />
      <KfxRegistrySection {...props} />
    </section>
  );
}
function KfxManagerView(props: KfxViewProps) {
  return (
    <KfxManagerContent
      controller={useKfxManagerController(props)}
      shell={props.shell}
    />
  );
}

export const View = KfxManagerView;
