// SPDX-License-Identifier: Apache-2.0

export type ProductSearchKind = 'help' | 'command' | 'work' | 'view';

export type ProductSearchAction =
  | { kind: 'show-help'; topicId: string }
  | { kind: 'describe-command'; command: string }
  | { kind: 'open-work'; workId: string }
  | { kind: 'open-view'; viewId: string };

export type ProductSearchDocument = {
  id: string;
  kind: ProductSearchKind;
  title: string;
  summary: string;
  section?: string;
  keywords?: string[];
  priority?: number;
  action: ProductSearchAction;
};

export type ProductSearchResult = ProductSearchDocument & {
  score: number;
};

export type CliHelpProjection = {
  schema: 'kungfu.cli-help-projection/v1';
  sections: Array<{ id: string; title: string; summary?: string }>;
  commands: Array<{
    id: string;
    name: string;
    path: string;
    summary?: string;
    section: string;
    priority?: number;
    availability?: { state?: string; reason?: string };
  }>;
};

export type ProductSearchExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer: number;
  },
) => Promise<string>;

export type OpenProductSearchOptions = {
  bin: string;
  env: Record<string, string | undefined>;
  execFile: ProductSearchExecFile;
};

export const SYSTEM_HELP_DOCUMENTS: ProductSearchDocument[] = [
  {
    id: 'help.keyboard',
    kind: 'help',
    title: 'Keyboard shortcuts',
    summary:
      '? opens Help. Use Ctrl+K in the terminal or Cmd/Ctrl+K in the desktop app to search Kungfu.',
    keywords: ['keys', 'shortcut', 'help', 'search'],
    priority: 0,
    action: { kind: 'show-help', topicId: 'keyboard' },
  },
  {
    id: 'help.quick-commands',
    kind: 'help',
    title: 'Quick commands',
    summary:
      'Type / in the terminal input bar to list bounded product actions. Kungfu does not run arbitrary shell text.',
    keywords: ['slash', 'command', 'input', 'terminal'],
    priority: 1,
    action: { kind: 'show-help', topicId: 'quick-commands' },
  },
  {
    id: 'help.product-search',
    kind: 'help',
    title: 'Search Kungfu',
    summary:
      'One read-only search surface finds product help, available commands, views, and current Work information.',
    keywords: ['find', 'command palette', 'work', 'view'],
    priority: 2,
    action: { kind: 'show-help', topicId: 'product-search' },
  },
  {
    id: 'help.work',
    kind: 'help',
    title: 'Work information',
    summary:
      'Work results come from the current read-only Work or Profile projection. Search never creates or changes Work.',
    keywords: ['assignment', 'initiative', 'task', 'read-only'],
    priority: 3,
    action: { kind: 'show-help', topicId: 'work' },
  },
];

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function parseCliHelpProjection(raw: string): CliHelpProjection {
  const parsed = JSON.parse(raw) as Partial<CliHelpProjection>;
  if (
    parsed.schema !== 'kungfu.cli-help-projection/v1' ||
    !Array.isArray(parsed.sections) ||
    !Array.isArray(parsed.commands)
  ) {
    throw new Error('Kungfu CLI returned an invalid help projection');
  }
  return parsed as CliHelpProjection;
}

export function cliHelpSearchDocuments(
  projection: CliHelpProjection,
): ProductSearchDocument[] {
  const sections = new Map(
    projection.sections.map((section) => [section.id, section]),
  );
  const help = projection.sections.map<ProductSearchDocument>(
    (section, index) => ({
      id: `help.section.${section.id}`,
      kind: 'help',
      title: clean(section.title),
      summary: clean(section.summary) || 'Kungfu command help section.',
      section: section.id,
      keywords: ['help', 'commands', section.id],
      priority: 20 + index,
      action: { kind: 'show-help', topicId: section.id },
    }),
  );
  const commands = projection.commands.map<ProductSearchDocument>((command) => {
    const availability = command.availability?.state ?? 'available';
    const reason = clean(command.availability?.reason);
    const availabilitySummary =
      availability === 'available'
        ? ''
        : ` [${availability}${reason ? `: ${reason}` : ''}]`;
    return {
      id: `command.${command.id}`,
      kind: 'command',
      title: clean(command.path),
      summary: `${clean(command.summary)}${availabilitySummary}`.trim(),
      section: sections.get(command.section)?.title ?? command.section,
      keywords: [command.name, command.section, availability],
      priority: command.priority ?? 100,
      action: { kind: 'describe-command', command: clean(command.path) },
    };
  });
  return [...help, ...commands];
}

export async function loadCliHelpSearchDocuments(
  options: OpenProductSearchOptions,
): Promise<ProductSearchDocument[]> {
  const raw = await options.execFile(options.bin, ['--help-json'], {
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return cliHelpSearchDocuments(parseCliHelpProjection(raw));
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function kindOrder(kind: ProductSearchKind): number {
  if (kind === 'work') return 0;
  if (kind === 'command') return 1;
  if (kind === 'help') return 2;
  return 3;
}

function scoreDocument(
  document: ProductSearchDocument,
  query: string,
): number | null {
  const title = normalized(document.title);
  const summary = normalized(document.summary);
  const section = normalized(document.section ?? '');
  const keywords = normalized((document.keywords ?? []).join(' '));
  const haystack = `${title} ${summary} ${section} ${keywords}`;
  const tokens = normalized(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return 1_000 - (document.priority ?? 100);
  if (!tokens.every((token) => haystack.includes(token))) return null;
  let score = 0;
  const complete = tokens.join(' ');
  if (title === complete) score += 1_000;
  else if (title.startsWith(complete)) score += 700;
  else if (title.includes(complete)) score += 500;
  for (const token of tokens) {
    if (title.startsWith(token)) score += 160;
    else if (title.includes(token)) score += 100;
    if (keywords.includes(token)) score += 50;
    if (section.includes(token)) score += 30;
    if (summary.includes(token)) score += 15;
  }
  return score - (document.priority ?? 100) / 100;
}

export function searchProductDocuments(
  documents: ProductSearchDocument[],
  query: string,
  limit = 12,
): ProductSearchResult[] {
  const unique = new Map<string, ProductSearchDocument>();
  for (const document of documents) {
    if (!unique.has(document.id)) unique.set(document.id, document);
  }
  return [...unique.values()]
    .map((document) => {
      const score = scoreDocument(document, query);
      return score === null ? null : { ...document, score };
    })
    .filter((row): row is ProductSearchResult => row !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        kindOrder(left.kind) - kindOrder(right.kind) ||
        left.title.localeCompare(right.title),
    )
    .slice(0, Math.max(0, limit));
}
