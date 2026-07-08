#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Guard v4 yijinjing against reintroducing trading-era public runtime surfaces.
// This is intentionally scoped to core exposure points, not to historical
// generated schemas that still exist while the legacy longfist files are split.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const allFiles = args.includes('--all');

const SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|mjs|js|cjs|ts|tsx|py|pyi)$/;
const LEGACY_PY_LONGFIST_TYPES =
  /\b(AlgoOrder|AlgoOrderAction|AlgoOrderActionError|AlgoOrderInput|Asset|Basket|BasketInstrument|BlockMessage|Commission|Contract|CustomSubscribe|Entrust|HistoryOrder|HistoryTrade|Instrument|InstrumentFactor|InstrumentKey|Order|OrderAction|OrderActionError|OrderInput|OrderStat|OrderTrigger|OrderTriggerAction|OrderTriggerActionError|OrderTriggerInput|Position|PositionEnd|Quote|RequestHistoryOrder|RequestHistoryOrderError|RequestHistoryTrade|RequestHistoryTradeError|RiskSetting|Trade|TradingDay|Transaction|Tree)\b/g;
const LEGACY_CORE_PUBLIC_TYPES = [
  'AlgoOrder',
  'AlgoOrderAction',
  'AlgoOrderActionError',
  'AlgoOrderInput',
  'Asset',
  'AssetRequest',
  'AssetSync',
  'Basket',
  'BasketInstrument',
  'BlockMessage',
  'Commission',
  'Contract',
  'ContractRequest',
  'CustomSubscribe',
  'Depth',
  'Entrust',
  'HistoryOrder',
  'HistoryTrade',
  'Instrument',
  'InstrumentFactor',
  'InstrumentKey',
  'KeepPositionsRequest',
  'MirrorPositionsRequest',
  'Order',
  'OrderAction',
  'OrderActionError',
  'OrderInput',
  'OrderStat',
  'OrderTrigger',
  'OrderTriggerAction',
  'OrderTriggerActionError',
  'OrderTriggerInput',
  'OrderTriggerRequest',
  'Position',
  'PositionEnd',
  'PositionRequest',
  'PositionSync',
  'Quote',
  'RebuildPositionsRequest',
  'RequestHistoryOrder',
  'RequestHistoryOrderError',
  'RequestHistoryTrade',
  'RequestHistoryTradeError',
  'ResetBookRequest',
  'RiskSetting',
  'Tick',
  'Trade',
  'TradingDay',
  'Transaction',
  'Tree',
];
const CORE_PUBLIC_REGISTRIES = [
  'CorePublicDataTypes',
  'CorePublicStateDataTypes',
  'CorePublicProfileDataTypes',
];

const RULES = [
  {
    name: 'python yijinjing typed AllDataTypes binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-yijinjing\.cpp$/,
    ],
    re: /\bAllDataTypes\b|boost::hana::for_each\(AllDataTypes/g,
    message:
      'Python yijinjing must expose neutral raw/envelope APIs, not generated business typed helpers.',
  },
  {
    name: 'python longfist public AllDataTypes binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-longfist-types\.cpp$/,
    ],
    re: /\b(AllDataTypes|StateDataTypes)\b|boost::hana::for_each\((AllDataTypes|StateDataTypes)/g,
    message:
      'Python longfist public types/state must bind CorePublic*DataTypes, not the legacy internal schema sets.',
  },
  {
    name: 'python profile public internal registry binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-yijinjing\.cpp$/,
    ],
    re: /\bProfileDataTypes\b|boost::hana::for_each\(longfist::ProfileDataTypes/g,
    message:
      'Python yijinjing profile must bind CorePublicProfileDataTypes, not the internal profile schema set.',
  },
  {
    name: 'node longfist public internal registry binding',
    files: [/^framework\/core\/src\/bindings\/node\/binding\/longfist\.cpp$/],
    re: /\b(AllTypes|AllDataTypes|StateDataTypes|ProfileDataTypes)\b|boost::hana::for_each\((AllTypes|AllDataTypes|StateDataTypes|ProfileDataTypes)/g,
    message:
      'Node longfist public types/carrierTypes must bind CorePublic*DataTypes, not the legacy internal schema sets.',
  },
  {
    name: 'python longfist public trading stubs',
    files: [
      /^framework\/core\/stubs\/pykungfu\/longfist\/types\.pyi$/,
      /^framework\/core\/stubs\/pykungfu\/longfist\/state\.pyi$/,
      /^framework\/core\/stubs\/pykungfu\/yijinjing\.pyi$/,
    ],
    re: LEGACY_PY_LONGFIST_TYPES,
    message:
      'Python longfist stubs must not expose legacy trading/profile typed classes as public v4 core types.',
  },
  {
    name: 'python dispatch bench typed trading dependency',
    files: [/^framework\/core\/tests\/bench\/dispatch_load\.py$/],
    re: /\b(lf\.types\.Quote|use_quote|quote)\b/g,
    message:
      'Dispatch load bench must use raw carrier payloads, not Python trading typed bindings.',
  },
  {
    name: 'legacy trading time API',
    files: [
      /^framework\/core\/src\/libyijinjing\//,
      /^framework\/core\/src\/libkungfu\//,
      /^framework\/core\/src\/bindings\//,
      /^framework\/core\/stubs\/pykungfu\/yijinjing\.pyi$/,
    ],
    re: /\b(next_trading_day_end|trading_day_start|restore_start|KUNGFU_TRADING_DAY_FORMAT)\b/g,
    message:
      'Use neutral session/window time APIs: next_session_boundary, session_window_start, history_window_start.',
  },
  {
    name: 'trading closed-set registry',
    files: [
      /^framework\/core\/src\/libkungfu\/include\/kungfu\/longfist\/longfist\.h$/,
    ],
    re: /\b(TradingDataTypes|TradingDataTags|MarketDataTypes|is_market_data)\b/g,
    message:
      'Do not keep trading/market closed sets in the v4 longfist core registry.',
  },
  {
    name: 'dead trading feed helper',
    files: [
      /^framework\/core\/src\/libkungfu\/include\/kungfu\/yijinjing\/cache\/cached\.h$/,
    ],
    re: /\bfeed_trading_data\b/g,
    message:
      'Closed-set trading feed helpers must not live in the v4 cache API.',
  },
];

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitMaybe(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function splitLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isFile(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

function mergeBase() {
  const upstream = gitMaybe([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const candidates = [
    upstream,
    'origin/HEAD',
    'nas/dev/v4/v4.0',
    'origin/dev/v4/v4.0',
    'dev/v4/v4.0',
  ].filter(Boolean);
  for (const ref of candidates) {
    const base = gitMaybe(['merge-base', String(ref), 'HEAD']);
    if (base) return base;
  }
  return null;
}

function selectedFiles() {
  const files = new Set();
  if (stagedOnly) {
    for (const file of splitLines(
      git(['diff', '--cached', '--name-only', '--diff-filter=ACM']),
    )) {
      files.add(file);
    }
  } else if (allFiles) {
    for (const file of splitLines(git(['ls-files']))) {
      files.add(file);
    }
  } else {
    const base = mergeBase();
    if (base) {
      for (const file of splitLines(
        git(['diff', '--name-only', '--diff-filter=ACM', `${base}...HEAD`]),
      )) {
        files.add(file);
      }
    }
    for (const mode of [[], ['--cached']]) {
      for (const file of splitLines(
        git(['diff', ...mode, '--name-only', '--diff-filter=ACM']),
      )) {
        files.add(file);
      }
    }
    for (const file of splitLines(
      git(['ls-files', '--others', '--exclude-standard']),
    )) {
      files.add(file);
    }
  }
  return [...files].filter((file) => SOURCE_EXT.test(file) && isFile(file));
}

function lineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function corePublicRegistryHits(rel, text) {
  if (
    rel !== 'framework/core/src/libkungfu/include/kungfu/longfist/longfist.h'
  ) {
    return [];
  }
  const hits = [];
  for (const registry of CORE_PUBLIC_REGISTRIES) {
    const blockRe = new RegExp(
      `constexpr auto ${registry} = boost::hana::make_map\\([\\s\\S]*?\\n\\);`,
      'm',
    );
    const block = blockRe.exec(text);
    if (!block) {
      hits.push({
        file: rel,
        line: 1,
        rule: `${registry} exists`,
        message: `${registry} must stay explicit so public binding checks can audit it.`,
        text: registry,
      });
      continue;
    }
    for (const typeName of LEGACY_CORE_PUBLIC_TYPES) {
      const typeRe = new RegExp(`\\bTYPE_PAIR\\(${typeName}\\)\\b`);
      const typeMatch = typeRe.exec(block[0]);
      if (!typeMatch) continue;
      hits.push({
        file: rel,
        line: lineNumber(text, block.index + typeMatch.index),
        rule: `${registry} legacy type`,
        message:
          'CorePublic*DataTypes must stay runtime/core-only; legacy trading/profile schemas belong to internal compatibility registries.',
        text: typeName,
      });
    }
  }
  return hits;
}

const hits = [];
for (const rel of selectedFiles()) {
  const rules = RULES.filter((rule) => rule.files.some((re) => re.test(rel)));
  if (!rules.length) continue;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      hits.push({
        file: rel,
        line: lineNumber(text, match.index || 0),
        rule: rule.name,
        message: rule.message,
        text: match[0],
      });
    }
  }
  hits.push(...corePublicRegistryHits(rel, text));
}

if (hits.length) {
  console.error(
    '[yijinjing-greenfield] trading-era runtime surface is blocked.',
  );
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line} (${hit.rule}) ${hit.text}`);
    console.error(`    ${hit.message}`);
  }
  process.exit(1);
}

console.log('[yijinjing-greenfield] gate passed');
