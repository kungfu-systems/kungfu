// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import {
  type Profile,
  type QualificationLab,
  type QualificationLabAgentPlan,
  type QualificationLabReport,
  type QualificationLabStartupRoute,
  type WorkLoop,
  openProfile,
  openQualificationLab,
  openWorkLoop,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp } from 'ink';
import React from 'react';

import { loadTuiKfxPlan } from './kfx-plan.js';
import {
  degradedMissionControlModel,
  loadMissionControlContribution,
} from './mission-control-contribution.js';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  ProfileShell,
  type ProfileShellModel,
  type TerminalDimensions,
} from './profile-shell.js';
import { TerminalLifecycle } from './terminal-lifecycle.js';
import { workLoopShellModel } from './work-loop-contribution.js';

const nodeRequire = createRequire(import.meta.url);

function cliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // This process is running inside embedded libnode. Child `kungfu` calls must
  // re-enter the ordinary CLI instead of recursively selecting the Node host.
  env.KUNGFU_AS_VARIANT = undefined;
  return env;
}

function runtimePaths() {
  const kungfuDir =
    process.env.KUNGFU_DIR ||
    path.join(
      path.dirname(nodeRequire.resolve('@kungfu-tech/core/package.json')),
      'dist',
      'kungfu',
    );
  const packagedBin = path.join(
    kungfuDir,
    process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
  );
  return {
    runtimeDir:
      process.env.KF_RUNTIME_DIR || path.join(process.cwd(), 'demo-runtime'),
    bin:
      process.env.KUNGFU_CLI_BIN ||
      process.env.KUNGFU_BIN ||
      (fs.existsSync(packagedBin) ? packagedBin : 'kungfu'),
    repoRoot: process.env.KF_WORKSPACE_ROOT || process.cwd(),
  };
}

function openTuiProfile(): Profile {
  const paths = runtimePaths();
  return openProfile({
    runtimeDir: paths.runtimeDir,
    bin: paths.bin,
    env: cliEnvironment(),
    execFileSync: (file, args, options) => execFileSync(file, args, options),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, options, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }),
  });
}

function openTuiQualificationLab(): QualificationLab {
  const paths = runtimePaths();
  return openQualificationLab({
    runtimeDir: paths.runtimeDir,
    bin: paths.bin,
    env: cliEnvironment(),
    execFileSync: (file, args, options) => execFileSync(file, args, options),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout);
        });
      }),
  });
}

function openTuiWorkLoop(): WorkLoop {
  const paths = runtimePaths();
  return openWorkLoop({
    runtimeDir: paths.runtimeDir,
    repoRoot: paths.repoRoot,
    bin: paths.bin,
    env: cliEnvironment(),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, options, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }),
  });
}

class DimensionStore {
  private listeners = new Set<(dimensions: TerminalDimensions) => void>();
  constructor(private current: TerminalDimensions) {}
  get() {
    return this.current;
  }
  update(dimensions: TerminalDimensions) {
    this.current = dimensions;
    for (const listener of this.listeners) listener(dimensions);
  }
  subscribe(listener: (dimensions: TerminalDimensions) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function MissionControlHost({
  profile,
  workLoop,
  dimensions,
  onOpenLab,
}: {
  profile: Profile;
  workLoop: WorkLoop;
  dimensions: DimensionStore;
  onOpenLab: () => void;
}) {
  const { exit } = useApp();
  const kfxPlan = React.useMemo(() => loadTuiKfxPlan(process.env), []);
  const [size, setSize] = React.useState(dimensions.get());
  const [model, setModel] = React.useState<ProfileShellModel>(() =>
    degradedMissionControlModel('loading public Profile projection'),
  );
  const [busy, setBusy] = React.useState(true);
  const [selectedCard, setSelectedCard] = React.useState(0);
  const [activeRegion, setActiveRegion] = React.useState(1);
  const refreshGeneration = React.useRef(0);

  const refresh = React.useCallback(
    async (missionId = '') => {
      const generation = ++refreshGeneration.current;
      setBusy(true);
      try {
        const next = await loadMissionControlContribution(
          profile,
          kfxPlan,
          missionId,
        );
        let loopProjection: ProfileShellModel['workLoop'];
        let loopError = '';
        try {
          const [inspection, recovery] = await Promise.all([
            workLoop.inspect(),
            workLoop.recover(),
          ]);
          loopProjection = workLoopShellModel(inspection, recovery);
        } catch (error) {
          loopError = error instanceof Error ? error.message : String(error);
        }
        if (generation === refreshGeneration.current) {
          setModel({
            ...next,
            workLoop: loopProjection,
            workLoopError: loopError || undefined,
          });
          setSelectedCard(0);
        }
      } catch (error) {
        if (generation === refreshGeneration.current) {
          setModel(degradedMissionControlModel(error));
        }
      } finally {
        if (generation === refreshGeneration.current) setBusy(false);
      }
    },
    [profile, workLoop, kfxPlan],
  );

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(
    () => () => {
      refreshGeneration.current += 1;
    },
    [],
  );
  React.useEffect(() => {
    void refresh(process.env.KF_MISSION_ID || '');
  }, [refresh]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const key = decodeShellKey(String(chunk));
      if (key === 'quit') return exit();
      if (key === 'qualification-lab') return onOpenLab();
      if (key === 'refresh') return void refresh(model.subject.id);
      if (key === 'next-card') {
        setSelectedCard((current) =>
          boundedIndex(current, 1, model.cards.length),
        );
      } else if (key === 'previous-card') {
        setSelectedCard((current) =>
          boundedIndex(current, -1, model.cards.length),
        );
      } else if (key === 'next-region') {
        setActiveRegion((current) => boundedIndex(current, 1, 3));
      } else if (key === 'previous-region') {
        setActiveRegion((current) => boundedIndex(current, -1, 3));
      } else if (key === 'next-subject' || key === 'previous-subject') {
        const current = model.navigation.findIndex(
          (row) => row.id === model.subject.id,
        );
        const delta = key === 'next-subject' ? 1 : -1;
        const next =
          model.navigation[
            boundedIndex(current, delta, model.navigation.length)
          ];
        if (next) void refresh(next.id);
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, model, onOpenLab, refresh]);

  return (
    <ProfileShell
      model={model}
      dimensions={size}
      selectedCard={selectedCard}
      activeRegion={activeRegion}
      busy={busy}
    />
  );
}

function QualificationLabHost({
  lab,
  startup,
  onOpenWork,
}: {
  lab: QualificationLab;
  startup: QualificationLabStartupRoute;
  onOpenWork?: () => void;
}) {
  const { exit } = useApp();
  const [agents, setAgents] = React.useState<
    Awaited<ReturnType<QualificationLab['discoverAgents']>> | undefined
  >();
  const [selected, setSelected] = React.useState(0);
  const [target, setTarget] = React.useState(0);
  const [report, setReport] = React.useState<QualificationLabReport>();
  const [plan, setPlan] = React.useState<QualificationLabAgentPlan>();
  const [targetPlan, setTargetPlan] =
    React.useState<QualificationLabAgentPlan>();
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const profiles = React.useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...(agents?.configured ?? []),
            ...(agents?.discovered.map((row) => row.profile) ?? []),
          ].map((profile) => [profile.id, profile]),
        ).values(),
      ),
    [agents],
  );
  const discover = React.useCallback(async () => {
    setBusy('discovering agents');
    try {
      setAgents(await lab.discoverAgents());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  }, [lab]);
  React.useEffect(() => {
    void discover();
  }, [discover]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const key = decodeShellKey(String(chunk));
      if (key === 'quit') return exit();
      if (key === 'next-card')
        return setSelected((current) =>
          boundedIndex(current, 1, profiles.length),
        );
      if (key === 'previous-card')
        return setSelected((current) =>
          boundedIndex(current, -1, profiles.length),
        );
      if (String(chunk) === ']')
        return setTarget((current) =>
          boundedIndex(current, 1, profiles.length),
        );
      if (String(chunk) === '[')
        return setTarget((current) =>
          boundedIndex(current, -1, profiles.length),
        );
      if (String(chunk) === 'w' && onOpenWork) return onOpenWork();
      if (String(chunk) === 'd' && !busy) {
        setBusy('running two fresh sessions');
        void lab
          .runDemo()
          .then((value) => {
            setReport(value);
            setError('');
          })
          .catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          )
          .finally(() => setBusy(''));
      }
      if (String(chunk) === 'p' && !busy && profiles[selected]) {
        setBusy('planning exact agent run');
        void Promise.all([
          lab.planAgent(profiles[selected].id),
          lab.planAgent(profiles[target]?.id || profiles[selected].id),
        ])
          .then(([source, continuation]) => {
            setPlan(source);
            setTargetPlan(continuation);
            setError('');
          })
          .catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          )
          .finally(() => setBusy(''));
      }
      if (String(chunk) === 'x' && !busy && plan && profiles[selected]) {
        setBusy('running selected agent twice');
        void lab
          .runAgent(profiles[selected].id)
          .then((value) => {
            setReport(value);
            setError('');
          })
          .catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          )
          .finally(() => setBusy(''));
      }
      if (
        String(chunk) === 'm' &&
        !busy &&
        plan &&
        targetPlan &&
        profiles[selected] &&
        profiles[target] &&
        selected !== target
      ) {
        setBusy('running cross-provider handoff');
        void lab
          .runMigration(profiles[selected].id, profiles[target].id)
          .then((value) => {
            setReport(value);
            setError('');
          })
          .catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          )
          .finally(() => setBusy(''));
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    busy,
    exit,
    lab,
    onOpenWork,
    plan,
    profiles,
    selected,
    target,
    targetPlan,
  ]);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan">AGENT QUALIFICATION LAB</Text>
      <Text bold>Prove continuity before configuration</Text>
      <Text>
        Offline demo: two fresh processes, no transcript, isolated evidence.
      </Text>
      <Text dimColor>
        Claims continuity only—not intelligence, security, production fitness,
        KFD certification, or provider ranking.
      </Text>
      <Text color={startup.route === 'diagnostic' ? 'red' : undefined}>
        startup {startup.state} · {startup.reasonCode} · no workspace write
      </Text>
      <Text>
        [d] demo [j/k] source [ and ] target [p] preview [x] self [m] handoff
        {onOpenWork ? ' [w] return to Work graph' : ''} [q] quit
      </Text>
      {busy ? <Text color="yellow">{busy}…</Text> : null}
      {report ? (
        <Text color={report.status === 'failed' ? 'red' : 'green'}>
          demo {report.status} · {report.reportRoot}
        </Text>
      ) : null}
      <Text bold>Local agents</Text>
      {profiles.length === 0 ? <Text dimColor>none discovered</Text> : null}
      {profiles.map((profile, index) => (
        <Text key={profile.id} color={index === selected ? 'cyan' : undefined}>
          {index === selected ? 'S' : ' '}
          {index === target ? 'T' : ' '} {profile.label} ·{' '}
          {profile.launch.executable}
        </Text>
      ))}
      {plan ? (
        <Box flexDirection="column">
          <Text>identity {plan.identityRoot}</Text>
          <Text>plan {plan.planRoot}</Text>
          <Text>{JSON.stringify(plan.commandPreview)}</Text>
          <Text>{JSON.stringify(targetPlan?.commandPreview)}</Text>
          <Text>continuation identity {targetPlan?.identityRoot}</Text>
          <Text dimColor>credential contents read: no</Text>
        </Box>
      ) : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

function ProductHost({
  lab,
  startup,
  dimensions,
}: {
  lab: QualificationLab;
  startup: QualificationLabStartupRoute;
  dimensions: DimensionStore;
}) {
  const [labOpen, setLabOpen] = React.useState(startup.route !== 'work-graph');
  if (labOpen) {
    return (
      <QualificationLabHost
        lab={lab}
        startup={startup}
        onOpenWork={
          startup.route === 'work-graph' ? () => setLabOpen(false) : undefined
        }
      />
    );
  }
  return (
    <MissionControlHost
      profile={openTuiProfile()}
      workLoop={openTuiWorkLoop()}
      dimensions={dimensions}
      onOpenLab={() => setLabOpen(true)}
    />
  );
}

function printNonInteractiveDiagnostic(): void {
  const paths = runtimePaths();
  process.stdout.write(
    `${JSON.stringify({
      schema: 'kungfu.tui.non-interactive/v1',
      status: 'not-started',
      reason: 'interactive terminal required',
      runtimeDir: paths.runtimeDir,
      next: 'run `kungfu tui` in a TTY',
    })}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Kungfu Mission Control TUI\n\nRun in an interactive terminal.\nAgent brief: `kungfu agent brief`.\n',
    );
    return;
  }
  const lab = openTuiQualificationLab();
  if (process.argv.includes('--qualification-lab-demo')) {
    const report = await lab.runDemo();
    for (const event of report.events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === 'failed') process.exitCode = 1;
    return;
  }
  if (
    process.argv.includes('--diagnostic') ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    printNonInteractiveDiagnostic();
    return;
  }

  const lifecycle = new TerminalLifecycle(
    process.stdin,
    process.stdout,
    process,
  );
  const dimensions = new DimensionStore(lifecycle.dimensions());
  let startup: QualificationLabStartupRoute;
  try {
    startup = lab.inspectSync();
  } catch (error) {
    startup = {
      schema: 'kungfu.qualification-lab.startup-route/v1',
      state: 'diagnostic',
      route: 'diagnostic',
      reasonCode: 'startup-inspection-failed',
      message: error instanceof Error ? error.message : String(error),
      runtimeDir: runtimePaths().runtimeDir,
      workGraphPresent: null,
      evidence: [],
      writeOccurred: false,
    };
  }
  let instance: ReturnType<typeof render> | undefined;
  let terminating = false;
  await lifecycle.run(
    {
      onExit: (signal) => {
        terminating = true;
        if (signal) process.exitCode = 128 + osConstants.signals[signal];
        instance?.unmount();
      },
      onResize: (size) => dimensions.update(size),
    },
    async () => {
      if (terminating) return;
      instance = render(
        <ProductHost lab={lab} startup={startup} dimensions={dimensions} />,
        {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await instance.waitUntilExit();
    },
  );
}

void main().catch((error) => {
  process.stderr.write(`Kungfu TUI failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
