import type {
  KungfuConfigValue,
  KungfuResolvedConfig,
  KungfuUiConfig,
} from '@kungfu-tech/kfx';

const SYSTEM_UI_FONT =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const SYSTEM_MONO_FONT = 'SF Mono, Menlo, Monaco, Consolas, monospace';
const DEFAULT_UI: KungfuUiConfig = {
  fontFamily: 'system',
  fontSize: 14,
  scale: 1,
};

type ExecFileSync = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv },
) => string;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function binName(): string {
  return window.process.platform === 'win32' ? 'kungfu.exe' : 'kungfu';
}

function kungfuExecutable(): string {
  const fs = window.require('node:fs') as typeof import('node:fs');
  const path = window.require('node:path') as typeof import('node:path');
  const candidates: string[] = [];
  const kfePath = window.process.env.KFE_PATH;
  if (kfePath) candidates.push(path.join(path.dirname(kfePath), binName()));
  try {
    const core = window.require('@kungfu-tech/core') as {
      executable?: { kfc?: string };
    };
    if (core.executable?.kfc) candidates.push(core.executable.kfc);
  } catch {
    // packaged builds do not resolve the workspace package; KFE_PATH covers them
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('cannot locate kungfu CLI for config operations');
  }
  return found;
}

function runConfig(args: string[]): KungfuResolvedConfig {
  const childProcess = window.require('node:child_process') as {
    execFileSync: ExecFileSync;
  };
  const output = childProcess.execFileSync(
    kungfuExecutable(),
    ['config', ...args],
    {
      encoding: 'utf8',
      env: { ...window.process.env },
    },
  );
  return JSON.parse(output) as KungfuResolvedConfig;
}

export function loadKungfuConfig(): KungfuResolvedConfig {
  return runConfig(['show', '--json']);
}

export function setKungfuConfigValue(
  key: string,
  value: KungfuConfigValue,
): KungfuResolvedConfig {
  return runConfig(['set', key, JSON.stringify(value), '--json']);
}

export function unsetKungfuConfigValue(key: string): KungfuResolvedConfig {
  return runConfig(['unset', key, '--json']);
}

export function normalizedUiConfig(
  config: KungfuResolvedConfig | null,
): KungfuUiConfig {
  const ui = config?.config.ui ?? DEFAULT_UI;
  return {
    fontFamily:
      typeof ui.fontFamily === 'string' && ui.fontFamily.trim()
        ? ui.fontFamily.trim()
        : DEFAULT_UI.fontFamily,
    fontSize: clamp(Number(ui.fontSize) || DEFAULT_UI.fontSize, 8, 48),
    scale: clamp(Number(ui.scale) || DEFAULT_UI.scale, 0.5, 3),
  };
}

export function resolvedUiFontFamily(fontFamily: string): string {
  return fontFamily === 'system' ? SYSTEM_UI_FONT : fontFamily;
}

export function resolvedMonoFontFamily(fontFamily: string): string {
  return fontFamily === 'system' ? SYSTEM_MONO_FONT : fontFamily;
}
