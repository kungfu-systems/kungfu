const VT_ESCAPE_PATTERN = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[=>78])`;
const CSI_PATTERN = String.raw`^\x1b\[([0-9;?]*)([A-Za-z])$`;
const ESCAPE = new RegExp(VT_ESCAPE_PATTERN, 'g');

function blankGrid(cols, rows) {
  return Array.from({ length: rows }, () => Array(cols).fill(' '));
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

/**
 * A deliberately bounded, provider-neutral VT text-grid snapshot.
 *
 * The live renderer still receives the original byte stream. This model only
 * preserves the printable grid, cursor and active screen across attachment;
 * it does not claim style, hyperlink or image fidelity. Unsupported control
 * sequences are ignored instead of being exposed as printable transcript.
 */
export class VtTextGrid {
  constructor(cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    this.primary = blankGrid(cols, rows);
    this.alternate = blankGrid(cols, rows);
    this.activeBuffer = 'primary';
    this.cursor = { col: 0, row: 0 };
    this.savedCursor = { col: 0, row: 0 };
    this.pending = '';
  }

  get grid() {
    return this.activeBuffer === 'alternate' ? this.alternate : this.primary;
  }

  resize(cols, rows) {
    if (
      !Number.isInteger(cols) ||
      cols < 1 ||
      !Number.isInteger(rows) ||
      rows < 1
    ) {
      throw new Error('VT size must use positive integer cols and rows');
    }
    const resizeGrid = (source) => {
      const target = blankGrid(cols, rows);
      for (let row = 0; row < Math.min(rows, source.length); row += 1) {
        for (let col = 0; col < Math.min(cols, source[row].length); col += 1) {
          target[row][col] = source[row][col];
        }
      }
      return target;
    };
    this.primary = resizeGrid(this.primary);
    this.alternate = resizeGrid(this.alternate);
    this.cols = cols;
    this.rows = rows;
    this.cursor.col = clamp(this.cursor.col, 0, cols - 1);
    this.cursor.row = clamp(this.cursor.row, 0, rows - 1);
  }

  write(data) {
    const text = this.pending + data;
    this.pending = '';
    let offset = 0;
    for (const match of text.matchAll(ESCAPE)) {
      this.#writeText(text.slice(offset, match.index));
      this.#applyEscape(match[0]);
      offset = match.index + match[0].length;
    }
    const tail = text.slice(offset);
    const incomplete = tail.lastIndexOf('\x1b');
    if (incomplete >= 0) {
      this.#writeText(tail.slice(0, incomplete));
      this.pending = tail.slice(incomplete);
    } else {
      this.#writeText(tail);
    }
  }

  snapshot(sequence) {
    return {
      schema: 'kungfu.agent-session.vt-text-grid/v1',
      fidelity: 'printable-text-grid',
      sequence,
      cols: this.cols,
      rows: this.rows,
      activeBuffer: this.activeBuffer,
      cursor: { ...this.cursor },
      lines: this.grid.map((line) => line.join('').replace(/ +$/u, '')),
    };
  }

  #scroll() {
    this.grid.shift();
    this.grid.push(Array(this.cols).fill(' '));
    this.cursor.row = this.rows - 1;
  }

  #lineFeed() {
    this.cursor.row += 1;
    if (this.cursor.row >= this.rows) this.#scroll();
  }

  #writeText(text) {
    for (const char of text) {
      if (char === '\r') {
        this.cursor.col = 0;
      } else if (char === '\n') {
        this.#lineFeed();
      } else if (char === '\b') {
        this.cursor.col = Math.max(0, this.cursor.col - 1);
      } else if (char === '\t') {
        this.cursor.col = Math.min(
          this.cols - 1,
          (Math.floor(this.cursor.col / 8) + 1) * 8,
        );
      } else if (char >= ' ') {
        this.grid[this.cursor.row][this.cursor.col] = char;
        this.cursor.col += 1;
        if (this.cursor.col >= this.cols) {
          this.cursor.col = 0;
          this.#lineFeed();
        }
      }
    }
  }

  #applyEscape(value) {
    if (value === '\x1b7') {
      this.savedCursor = { ...this.cursor };
      return;
    }
    if (value === '\x1b8') {
      this.cursor = {
        col: clamp(this.savedCursor.col, 0, this.cols - 1),
        row: clamp(this.savedCursor.row, 0, this.rows - 1),
      };
      return;
    }
    if (value === '\x1b[?1049h' || value === '\x1b[?47h') {
      this.activeBuffer = 'alternate';
      this.alternate = blankGrid(this.cols, this.rows);
      this.cursor = { col: 0, row: 0 };
      return;
    }
    if (value === '\x1b[?1049l' || value === '\x1b[?47l') {
      this.activeBuffer = 'primary';
      this.cursor = { col: 0, row: 0 };
      return;
    }
    const csi = new RegExp(CSI_PATTERN, 'u').exec(value);
    if (!csi) return;
    const params = csi[1]
      .replace(/^\?/u, '')
      .split(';')
      .map((item) => Number(item || 0));
    const amount = params[0] || 1;
    switch (csi[2]) {
      case 'A':
        this.cursor.row = Math.max(0, this.cursor.row - amount);
        break;
      case 'B':
        this.cursor.row = Math.min(this.rows - 1, this.cursor.row + amount);
        break;
      case 'C':
        this.cursor.col = Math.min(this.cols - 1, this.cursor.col + amount);
        break;
      case 'D':
        this.cursor.col = Math.max(0, this.cursor.col - amount);
        break;
      case 'E':
        this.cursor.row = Math.min(this.rows - 1, this.cursor.row + amount);
        this.cursor.col = 0;
        break;
      case 'F':
        this.cursor.row = Math.max(0, this.cursor.row - amount);
        this.cursor.col = 0;
        break;
      case 'G':
        this.cursor.col = clamp(amount - 1, 0, this.cols - 1);
        break;
      case 'H':
      case 'f':
        this.cursor.row = clamp((params[0] || 1) - 1, 0, this.rows - 1);
        this.cursor.col = clamp((params[1] || 1) - 1, 0, this.cols - 1);
        break;
      case 'J':
        if (params[0] === 2 || params[0] === 3) {
          const replacement = blankGrid(this.cols, this.rows);
          if (this.activeBuffer === 'alternate') this.alternate = replacement;
          else this.primary = replacement;
        }
        break;
      case 'K':
        if (params[0] === 2) {
          this.grid[this.cursor.row].fill(' ');
        } else if (params[0] === 1) {
          this.grid[this.cursor.row].fill(' ', 0, this.cursor.col + 1);
        } else {
          this.grid[this.cursor.row].fill(' ', this.cursor.col);
        }
        break;
      case 'd':
        this.cursor.row = clamp(amount - 1, 0, this.rows - 1);
        break;
    }
  }
}
