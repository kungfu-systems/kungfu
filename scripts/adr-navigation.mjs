#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAdrRecords } from './adr-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_CONTRACT = 'docs/adr-release.contract.json';
const MARKDOWN_OUTPUT = 'docs/architecture/adr-map.md';
const JSON_OUTPUT = 'docs/architecture/adr-map.json';

const DOMAINS = [
  {
    id: 'facts-storage',
    title: 'Facts, storage, and replay',
    keywords: [
      'fact',
      'storage',
      'journal',
      'episode',
      'replay',
      'durability',
      'frame',
      'payload',
      'schema',
      'query',
      'projection',
    ],
  },
  {
    id: 'agent-control',
    title: 'Agent and work control',
    keywords: [
      'agent',
      'mission',
      'assignment',
      'project-cut',
      'project cut',
      'work-state',
      'continuation',
      'claim',
      'pursuit',
    ],
  },
  {
    id: 'xinfa-docs',
    title: 'Xinfa and documentation',
    keywords: [
      'xinfa',
      'documentation',
      'semantic',
      'context',
      'human-surface',
      'shifu-documentation',
    ],
  },
  {
    id: 'extensions-sdk',
    title: 'Extensions, SDKs, and language boundaries',
    keywords: [
      'kfx',
      'extension',
      'plugin',
      'wasm',
      'sdk',
      'api',
      'binding',
      'python',
      'node',
      'rust',
      'c++',
      'polyglot',
    ],
  },
  {
    id: 'runtime',
    title: 'Runtime, live services, and lifecycle',
    keywords: [
      'runtime',
      'live',
      'peer',
      'reactor',
      'action',
      'coordination',
      'recovery',
      'lifecycle',
      'topology',
      'coordinator',
    ],
  },
  {
    id: 'build-release',
    title: 'Build, distribution, and release',
    keywords: [
      'build',
      'release',
      'distribution',
      'upgrade',
      'cache',
      'artifact',
      'package',
      'version',
      'launcher',
      'toolchain',
    ],
  },
  {
    id: 'product-ui',
    title: 'Product and user surfaces',
    keywords: [
      'gui',
      'tui',
      'desktop',
      'workbench',
      'frontend',
      'product',
      'cockpit',
      'console',
      'user',
    ],
  },
  {
    id: 'architecture-governance',
    title: 'Architecture and governance',
    keywords: [
      'architecture',
      'governance',
      'invariant',
      'trust',
      'security',
      'capability',
      'authority',
      'identity',
      'contract',
    ],
  },
];

const NAVIGATION_STOP_WORDS = new Set([
  'and',
  'are',
  'for',
  'from',
  'into',
  'not',
  'the',
  'through',
  'with',
  'without',
]);

/** @param {string} value */
function escapeMarkdown(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** @param {string} value */
function escapeMermaid(value) {
  return value.replaceAll('"', "'");
}

/** @param {string} value */
function normalizedTerms(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9+#]+/g, ' ')
    .trim();
}

/** @param {string} value */
function semanticTokens(value) {
  return new Set(
    normalizedTerms(value)
      .split(' ')
      .filter((token) => token.length > 2 && !NAVIGATION_STOP_WORDS.has(token)),
  );
}

/** @param {any} record */
function domainFor(record) {
  const haystack = ` ${normalizedTerms(`${record.theme} ${record.title}`)} `;
  const scores = DOMAINS.map((domain) => ({
    domain,
    score: domain.keywords.reduce(
      (total, keyword) =>
        total + (haystack.includes(` ${normalizedTerms(keyword)} `) ? 1 : 0),
      0,
    ),
  })).sort(
    (left, right) =>
      right.score - left.score ||
      DOMAINS.indexOf(left.domain) - DOMAINS.indexOf(right.domain),
  );
  return scores[0].score > 0
    ? scores[0].domain
    : DOMAINS.find((domain) => domain.id === 'architecture-governance');
}

/** @param {any} record @param {any[]} peers */
function navigationFor(record, peers) {
  const sourceTokens = semanticTokens(`${record.theme} ${record.title}`);
  return peers
    .filter((peer) => peer.id !== record.id)
    .map((peer) => {
      const sharedTerms = [...semanticTokens(`${peer.theme} ${peer.title}`)]
        .filter((token) => sourceTokens.has(token))
        .sort();
      const sameTheme = Boolean(record.theme) && record.theme === peer.theme;
      const score = sharedTerms.length + (sameTheme ? 4 : 0);
      const reasons = [];
      if (sameTheme) reasons.push(`same theme: ${record.theme}`);
      if (sharedTerms.length > 0)
        reasons.push(`shared terms: ${sharedTerms.slice(0, 4).join(', ')}`);
      return {
        peer,
        target: peer.id,
        score,
        reason: reasons.join('; '),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.peer.title.localeCompare(right.peer.title) ||
        left.peer.id.localeCompare(right.peer.id),
    )
    .slice(0, 4)
    .map(({ target, score, reason }) => ({ target, score, reason }));
}

/** @param {any[]} records */
function shortKeys(records) {
  const result = new Map();
  for (let width = 4; width <= 12; width += 2) {
    const candidates = records.map((record) => {
      const compact = record.id.split('-').slice(-5).join('');
      return [
        record.id,
        `${record.owner === 'shifu' ? 'SHIFU' : 'KF'} · ${compact.slice(-width)}`,
      ];
    });
    const counts = new Map();
    for (const [, key] of candidates)
      counts.set(key, (counts.get(key) || 0) + 1);
    for (const [id, key] of candidates)
      if (!result.has(id) && counts.get(key) === 1) result.set(id, key);
  }
  return result;
}

/** @param {any[]} input */
export function buildAdrNavigation(input) {
  const records = input
    .map((record) => ({ ...record, domain: domainFor(record).id }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const keys = shortKeys(records);
  const byDomain = new Map(
    DOMAINS.map((domain) => [
      domain.id,
      records
        .filter((record) => record.domain === domain.id)
        .sort(
          (left, right) =>
            left.title.localeCompare(right.title) ||
            left.id.localeCompare(right.id),
        ),
    ]),
  );
  const authoritativeEdges = [];
  for (const record of records) {
    for (const target of record.supersedes)
      authoritativeEdges.push({
        source: record.id,
        target,
        relation: 'supersedes',
        authority: 'adr-frontmatter',
      });
  }
  const projected = records.map((record) => {
    const peers = byDomain.get(record.domain) || [];
    const inferred = navigationFor(record, peers);
    return {
      key: keys.get(record.id),
      id: record.id,
      owner: record.owner,
      file: record.file,
      title: record.title,
      theme: record.theme,
      domain: record.domain,
      decisionStatus: record.decisionStatus,
      implementationStatus: record.implementationStatus,
      reviewState: record.reviewState,
      qualificationRefCount: record.qualificationRefs.length,
      authoritativeRelations: [
        ...record.supersedes.map((target) => ({
          relation: 'supersedes',
          target,
        })),
        ...record.supersededBy.map((target) => ({
          relation: 'superseded-by',
          target,
        })),
      ],
      inferredNavigationNeighbors: inferred.map((item) => item.target),
      inferredNavigation: inferred,
    };
  });
  return {
    schema: 'kungfu.adr-navigation-projection/v1',
    generatedFrom: {
      records: './shifu adr:audit -- --json',
      authority: 'ADR frontmatter and exact checked files',
      navigation:
        'deterministic whole-term domain classification and same-theme/shared-term ranking; navigation only',
    },
    summary: {
      records: projected.length,
      domains: DOMAINS.length,
      authoritativeEdges: authoritativeEdges.length,
      inferredNavigationEdges: projected.reduce(
        (total, record) => total + record.inferredNavigationNeighbors.length,
        0,
      ),
    },
    domains: DOMAINS.map((domain) => ({
      id: domain.id,
      title: domain.title,
      count: byDomain.get(domain.id)?.length || 0,
    })),
    authoritativeEdges,
    records: projected,
  };
}

/** @param {ReturnType<typeof buildAdrNavigation>} projection */
export function renderAdrNavigation(projection) {
  const byId = new Map(projection.records.map((record) => [record.id, record]));
  const lines = [
    '# ADR Map',
    '',
    'This generated page is the human navigation projection of the canonical ADR',
    'corpus. It is deliberately layered: start with the domain map, expand one',
    'domain, then open a decision or its bounded neighborhood.',
    '',
    '> Authority boundary: solid `supersedes` relations come only from ADR',
    '> frontmatter. Domain membership and nearby links are deterministic',
    '> navigation-only inferences from titles and themes. They do not create',
    '> architecture authority. Xinfa remains the graph, impact, and stale-state',
    '> authority.',
    '',
    'Use browser find to search titles, themes, statuses, or compact keys. The',
    'full IDs stay behind links so filenames do not dominate the page.',
    '',
    `Coverage: **${projection.summary.records} ADRs** across **${projection.summary.domains} domains**; **${projection.summary.authoritativeEdges} authoritative edges**.`,
    '',
    '## Domain overview',
    '',
    '```mermaid',
    'flowchart LR',
    `  root["ADR corpus · ${projection.summary.records}"]`,
    ...projection.domains.map(
      (domain, index) =>
        `  root --> d${index}["${escapeMermaid(domain.title)} · ${domain.count}"]`,
    ),
    '```',
    '',
    '## Authoritative decision relations',
    '',
  ];
  if (projection.authoritativeEdges.length === 0) {
    lines.push(
      'No authoritative ADR-to-ADR relations are currently declared.',
      '',
    );
  } else {
    lines.push('```mermaid', 'flowchart LR');
    for (const [index, edge] of projection.authoritativeEdges.entries()) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      lines.push(
        `  a${index}["${escapeMermaid(source?.key || edge.source)}"] -->|supersedes| b${index}["${escapeMermaid(target?.key || edge.target)}"]`,
      );
    }
    lines.push('```', '');
    for (const edge of projection.authoritativeEdges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      lines.push(
        `- [${source?.key}](${path.posix.relative(path.posix.dirname(MARKDOWN_OUTPUT), source?.file || '')}) **supersedes** [${target?.key}](${path.posix.relative(path.posix.dirname(MARKDOWN_OUTPUT), target?.file || '')})`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Browse by domain',
    '',
    'Each “Nearby” set is capped at four same-domain decisions, ranked by exact',
    'theme and shared title/theme terms, and explicitly navigation-only. The',
    'reason is shown beside every link. Status is `decision / implementation /',
    'review`; evidence is the number of declared qualification references.',
    '',
  );
  for (const domain of projection.domains) {
    const records = projection.records.filter(
      (record) => record.domain === domain.id,
    );
    lines.push(
      `<details id="${domain.id}">`,
      `<summary><strong>${domain.title}</strong> · ${records.length}</summary>`,
      '',
      '| Key | Decision | Theme | Status | Evidence | Nearby (navigation only) |',
      '|---|---|---|---|---:|---|',
    );
    for (const record of records) {
      const href = path.posix.relative(
        path.posix.dirname(MARKDOWN_OUTPUT),
        record.file,
      );
      const nearby = record.inferredNavigation
        .map((item) => ({ ...item, peer: byId.get(item.target) }))
        .filter((item) => item.peer)
        .map(
          (item) =>
            `[${item.peer.key}](${path.posix.relative(path.posix.dirname(MARKDOWN_OUTPUT), item.peer.file)}) (${escapeMarkdown(item.reason)})`,
        )
        .join('<br>');
      lines.push(
        `| ${record.key} | [${escapeMarkdown(record.title)}](${href}) | ${escapeMarkdown(record.theme || '—')} | ${record.decisionStatus} / ${record.implementationStatus} / ${record.reviewState} | ${record.qualificationRefCount} | ${nearby || '—'} |`,
      );
    }
    lines.push('', '</details>', '');
  }
  lines.push(
    '## Machine projection',
    '',
    'The exact records, provenance labels, authoritative edges, and bounded',
    'navigation neighbors are available in [`adr-map.json`](adr-map.json).',
    'Regenerate with `./shifu adr:map`; CI runs the same generator in `--check`',
    'mode and rejects drift.',
    '',
  );
  return lines.join('\n');
}

function outputs() {
  const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, RELEASE_CONTRACT), 'utf8'),
  );
  const projection = buildAdrNavigation(readAdrRecords(ROOT, contract));
  return new Map([
    [JSON_OUTPUT, `${JSON.stringify(projection, null, 2)}\n`],
    [MARKDOWN_OUTPUT, renderAdrNavigation(projection)],
  ]);
}

function main(argv) {
  const check = argv.includes('--check');
  const write = argv.includes('--write') || !check;
  if (argv.some((arg) => !['--check', '--write'].includes(arg)))
    throw new Error(`unknown argument: ${argv.join(' ')}`);
  for (const [relative, content] of outputs()) {
    const target = path.join(ROOT, relative);
    if (check) {
      const actual = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8')
        : '';
      if (actual !== content)
        throw new Error(`${relative} is stale; run ./shifu adr:map`);
    }
    if (write) fs.writeFileSync(target, content);
  }
  process.stdout.write(
    `[adr-map] ${check ? 'current' : 'generated'} ${MARKDOWN_OUTPUT} and ${JSON_OUTPUT}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[adr-map] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
