// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { type Profile, openProfile } from '@kungfu-tech/api/capability';
import { render, useApp } from 'ink';
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

const nodeRequire = createRequire(import.meta.url);

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
  };
}

function openTuiProfile(): Profile {
  const paths = runtimePaths();
  return openProfile({
    runtimeDir: paths.runtimeDir,
    bin: paths.bin,
    env: process.env,
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
  dimensions,
}: {
  profile: Profile;
  dimensions: DimensionStore;
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
        if (generation === refreshGeneration.current) {
          setModel(next);
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
    [profile, kfxPlan],
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
  }, [exit, model, refresh]);

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

function printNonInteractiveDiagnostic(): void {
  const paths = runtimePaths();
  process.stdout.write(
    `${JSON.stringify({
      schema: 'kungfu.tui.non-interactive/v1',
      status: 'not-started',
      reason: 'interactive terminal required',
      runtimeDir: paths.runtimeDir,
      next: 'run `kungfu cockpit` in a TTY',
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
        <MissionControlHost
          profile={openTuiProfile()}
          dimensions={dimensions}
        />,
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
