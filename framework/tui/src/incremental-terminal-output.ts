// SPDX-License-Identifier: Apache-2.0

type ResizeListener = (...args: unknown[]) => void;

export type WritableTerminal = {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write: (value: string) => unknown;
  on: (event: 'resize', listener: ResizeListener) => unknown;
  off: (event: 'resize', listener: ResizeListener) => unknown;
};

const CURSOR_HOME = '\u001b[H';
const ERASE_LINE = '\u001b[2K';

function isCursorVisibilityOnly(value: string): boolean {
  return (
    value.length > 0 &&
    value.replaceAll('\u001b[?25l', '').replaceAll('\u001b[?25h', '') === ''
  );
}

/**
 * Ink's debug renderer exposes each complete frame without log-update's
 * erase-and-repaint cycle. This adapter turns those frames into small terminal
 * patches so stable Session content remains physically untouched.
 */
export class IncrementalTerminalOutput {
  private previousLines: string[] | undefined;

  constructor(private readonly terminal: WritableTerminal) {}

  get isTTY(): boolean | undefined {
    return this.terminal.isTTY;
  }

  get columns(): number | undefined {
    return this.terminal.columns;
  }

  get rows(): number | undefined {
    return this.terminal.rows;
  }

  write(value: string): boolean {
    const frame = String(value);
    if (isCursorVisibilityOnly(frame)) {
      return this.terminal.write(frame) !== false;
    }
    const nextLines = frame.split('\n');

    if (this.previousLines === undefined) {
      this.previousLines = nextLines;
      return this.terminal.write(`${CURSOR_HOME}${frame}`) !== false;
    }

    const previousLines = this.previousLines;
    const height = Math.max(previousLines.length, nextLines.length);
    let patch = '';
    for (let index = 0; index < height; index += 1) {
      const previous = previousLines[index] ?? '';
      const next = nextLines[index] ?? '';
      if (previous === next) continue;
      patch += `\u001b[${index + 1};1H${ERASE_LINE}${next}`;
    }
    this.previousLines = nextLines;
    return patch ? this.terminal.write(patch) !== false : true;
  }

  on(event: 'resize', listener: ResizeListener): unknown {
    return this.terminal.on(event, listener);
  }

  off(event: 'resize', listener: ResizeListener): unknown {
    return this.terminal.off(event, listener);
  }
}
