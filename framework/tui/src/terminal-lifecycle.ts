// SPDX-License-Identifier: Apache-2.0

import type { TerminalDimensions } from './profile-shell.js';

export const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h';
export const LEAVE_ALTERNATE_SCREEN = '\u001b[?1049l';

type Listener = (...args: unknown[]) => void;

export type TerminalInput = {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode?: (enabled: boolean) => void;
  resume?: () => void;
  pause?: () => void;
};

export type TerminalOutput = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (value: string) => unknown;
  on: (event: 'resize', listener: Listener) => unknown;
  off: (event: 'resize', listener: Listener) => unknown;
};

export type ProcessSignals = {
  on: (event: string, listener: Listener) => unknown;
  off: (event: string, listener: Listener) => unknown;
};

export class TerminalLifecycle {
  private active = false;
  private previousRaw = false;
  private previousFlowing: boolean | null = null;
  private readonly listeners: Array<[string, Listener]> = [];
  private resizeListener: Listener | null = null;

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
    private readonly signals: ProcessSignals,
  ) {}

  dimensions(): TerminalDimensions {
    return {
      columns: Math.max(20, this.output.columns ?? 80),
      rows: Math.max(10, this.output.rows ?? 24),
    };
  }

  start(options: {
    onExit: (signal?: NodeJS.Signals) => void;
    onResize: (dimensions: TerminalDimensions) => void;
  }): void {
    if (this.active) return;
    if (this.input.isTTY !== true || this.output.isTTY !== true) {
      throw new Error('interactive terminal required');
    }
    this.active = true;
    this.previousRaw = this.input.isRaw === true;
    this.previousFlowing = this.input.readableFlowing ?? null;
    try {
      this.output.write(ENTER_ALTERNATE_SCREEN);
      this.input.setRawMode?.(true);
      this.input.resume?.();

      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        const leave = () => {
          try {
            options.onExit(signal);
          } finally {
            this.restore();
          }
        };
        this.signals.on(signal, leave);
        this.listeners.push([signal, leave]);
      }
      const processExit = () => this.restore();
      this.signals.on('exit', processExit);
      this.listeners.push(['exit', processExit]);
      this.resizeListener = () => options.onResize(this.dimensions());
      this.output.on('resize', this.resizeListener);
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  async run<T>(
    options: {
      onExit: (signal?: NodeJS.Signals) => void;
      onResize: (dimensions: TerminalDimensions) => void;
    },
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      this.start(options);
      return await task();
    } finally {
      this.restore();
    }
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    const attempt = (operation: () => unknown) => {
      try {
        operation();
      } catch {
        // Restoration is best-effort and must continue through every owner.
      }
    };
    attempt(() => this.input.setRawMode?.(this.previousRaw));
    if (this.previousFlowing !== true) attempt(() => this.input.pause?.());
    attempt(() => this.output.write(LEAVE_ALTERNATE_SCREEN));
    if (this.resizeListener) {
      const resizeListener = this.resizeListener;
      attempt(() => this.output.off('resize', resizeListener));
      this.resizeListener = null;
    }
    for (const [event, listener] of this.listeners.splice(0)) {
      attempt(() => this.signals.off(event, listener));
    }
  }
}
