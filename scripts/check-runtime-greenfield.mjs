#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Guard v4 runtime against reintroducing trading-era public runtime surfaces.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const allFiles = args.includes('--all');

const SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|mjs|js|cjs|ts|tsx|py|pyi)$/;
const PRE_V4_PY_TRADING_TYPES =
  /\b(AlgoOrder|AlgoOrderAction|AlgoOrderActionError|AlgoOrderInput|Asset|Basket|BasketInstrument|BlockMessage|Commission|Contract|CustomSubscribe|Entrust|HistoryOrder|HistoryTrade|Instrument|InstrumentFactor|InstrumentKey|Order|OrderAction|OrderActionError|OrderInput|OrderStat|OrderTrigger|OrderTriggerAction|OrderTriggerActionError|OrderTriggerInput|Position|PositionEnd|Quote|RequestHistoryOrder|RequestHistoryOrderError|RequestHistoryTrade|RequestHistoryTradeError|RiskSetting|Trade|TradingDay|Transaction|Tree)\b/g;
const PRE_V4_PY_TRADING_ENUMS =
  /\b(AccountType|AccountingMethodType|AlgoOrderActionFlag|BasketType|BasketVolumeType|BrokerState|BsFlag|CashReplaceFlag|CloseOutFlag|CommissionRateMode|ContractType|Currency|Direction|ETFStatus|ETFType|ExecType|HedgeFlag|InstrumentType|LedgerCategory|MarketType|Offset|OrderActionFlag|OrderStatus|OrderTriggerFlag|OrderTriggerType|PriceLevel|PriceType|Side|StrategyState|SubscribeDataType|SubscribeInstrumentType|TimeCondition|VolumeCondition)\b/g;
const LEGACY_NODE_PROFILE_STORES =
  /\b(RiskSettingStore|CommissionStore|BasketStore|BasketInstrumentStore)\b/g;
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
const LEGACY_REGISTRY_RE =
  /\b(LegacyCompiledTypes|LegacyCompiledDataTypes|LegacyCompiledTypeTags)\b/g;
const AMBIGUOUS_HASH_API_RE =
  /\b(hash_32|hash_64|hash_str_32|hash_str_64|hash_string_32|hash_string_64|hash_string_128)\b/g;
const RETIRED_PRE_V4_FAST_HASH_RE = new RegExp(
  `\\b(Mur${'mur'}Hash3|mur${'mur'}3)\\b`,
  'gi',
);
const PACKAGER_NAME = ['Py', 'Installer'].join('');
const RESET_ENVIRONMENT = ['PY', 'INSTALLER', '_RESET_ENVIRONMENT'].join('');
const BOOTLOADER_PREFIX = ['_', 'PYI', '_'].join('');
const RETIREMENT_EXCLUDED_ROOTS = [
  '.kungfu/',
  '.xinfa/',
  'docs/qualification/evidence/',
  'developer/maintainability/',
];
const RETIREMENT_SELF_DESCRIPTION_FILES = new Set([
  'scripts/check-runtime-greenfield.mjs',
  'scripts/check-product-packager-retirement.test.mjs',
]);
const HISTORICAL_TERMINOLOGY_ROOTS = ['crates/host-spike/', 'docs/research/'];
const HISTORICAL_TERMINOLOGY_FILES = new Set([
  'docs/adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md',
  'docs/adr/SHIFU-ADR-019f86da-4f90-7b07-b137-378fb5533b13.md',
]);
const RETIREMENT_LEDGER = 'docs/development/buildchain.md';
const LEDGER_ALLOWLIST = [
  /the Nuitka\/PyInstaller freeze legs were retired 2026-07-11/u,
  /run-freeze\.js` pyinstaller fallback leg/iu,
  /__run_pyinstaller` \+ PyInstaller import/u,
  /Nuitka \/ PyInstaller pins.*pyinstaller pin retired 2026-07-11/u,
];
const RETIRED_SIGNATURES = [
  ['product host constant', ['FORM', 'FROZEN'].join('_')],
  ['interpreter product-host probe', ['sys', 'frozen'].join('.')],
  ['bootloader reset environment', RESET_ENVIRONMENT],
  ['bootloader process-state prefix', BOOTLOADER_PREFIX],
];
const RETIRED_PRODUCT_TERMINOLOGY = [
  'frozen product',
  'frozen runtime',
  'frozen binary',
  'frozen host',
  'frozen dist',
  'frozen cli',
  'nuitka-frozen',
  'assertcorefrozen',
];

const RULES = [
  {
    name: 'python runtime typed AllDataTypes binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-runtime\.cpp$/,
    ],
    re: LEGACY_REGISTRY_RE,
    message:
      'Python runtime must expose neutral raw/envelope APIs, not generated business typed helpers.',
  },
  {
    name: 'python yijinjing public AllDataTypes binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-yijinjing-types\.cpp$/,
    ],
    re: /\b(StateDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes|LegacyCompiledTypeTags)\b|boost::hana::for_each\((StateDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes)/g,
    message:
      'Python yijinjing public types/state must bind CorePublic*DataTypes, not the internal schema sets.',
  },
  {
    name: 'python profile public internal registry binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-runtime\.cpp$/,
    ],
    re: /\bProfileDataTypes\b|boost::hana::for_each\(yijinjing::ProfileDataTypes/g,
    message:
      'Python runtime profile must bind CorePublicProfileDataTypes, not the internal profile schema set.',
  },
  {
    name: 'node schema public internal registry binding',
    files: [/^framework\/core\/src\/bindings\/node\/binding\/schema\.cpp$/],
    re: /\b(StateDataTypes|ProfileDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes|LegacyCompiledTypeTags)\b|boost::hana::for_each\((StateDataTypes|ProfileDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes)/g,
    message:
      'Node schema public types/carrierTypes must bind CorePublic*DataTypes, not the internal schema sets.',
  },
  {
    name: 'python yijinjing public trading stubs',
    files: [
      /^framework\/core\/stubs\/pykungfu\/yijinjing\/types\.pyi$/,
      /^framework\/core\/stubs\/pykungfu\/yijinjing\/state\.pyi$/,
      /^framework\/core\/stubs\/pykungfu\/runtime\.pyi$/,
    ],
    re: PRE_V4_PY_TRADING_TYPES,
    message:
      'Python yijinjing stubs must not expose legacy trading/profile typed classes as public v4 core types.',
  },
  {
    name: 'python yijinjing public trading enums',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-yijinjing-enums\.cpp$/,
      /^framework\/core\/stubs\/pykungfu\/yijinjing\/enums\.pyi$/,
    ],
    re: PRE_V4_PY_TRADING_ENUMS,
    message:
      'Python yijinjing enums must expose only runtime/core enums, not trading/profile enums.',
  },
  {
    name: 'node legacy profile store public surface',
    files: [
      /^framework\/core\/src\/bindings\/node\/binding\/kungfu_node\.cpp$/,
      /^framework\/core\/lib\/kungfu\.js$/,
    ],
    re: LEGACY_NODE_PROFILE_STORES,
    message:
      'Node binding must not expose trading-era profile stores as v4 core API.',
  },
  {
    name: 'legacy compiled registry names',
    files: [
      /^framework\/core\/src\/bindings\//,
      /^framework\/core\/src\/libkungfu\//,
      /^framework\/core\/src\/libyijinjing\//,
    ],
    re: LEGACY_REGISTRY_RE,
    message:
      'LegacyCompiled* registries were removed; use the current core registry only.',
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
      /^framework\/core\/stubs\/pykungfu\/runtime\.pyi$/,
    ],
    re: /\b(next_trading_day_end|trading_day_start|restore_start|KUNGFU_TRADING_DAY_FORMAT)\b/g,
    message:
      'Use neutral session/window time APIs: next_session_boundary, session_window_start, history_window_start.',
  },
  {
    name: 'trading closed-set schema registry',
    files: [
      /^framework\/core\/src\/libyijinjing\/include\/kungfu\/yijinjing\/schema\/registry\.h$/,
    ],
    re: /\b(TradingDataTypes|TradingDataTags|MarketDataTypes|is_market_data)\b/g,
    message:
      'Do not keep trading/market closed sets in the v4 yijinjing schema registry.',
  },
  {
    name: 'dead trading feed helper',
    files: [
      /^framework\/core\/src\/libkungfu\/include\/kungfu\/runtime\/cache\/cached\.h$/,
    ],
    re: /\bfeed_trading_data\b/g,
    message:
      'Closed-set trading feed helpers must not live in the v4 cache API.',
  },
  {
    name: 'ambiguous fast hash api',
    files: [
      /^framework\/core\/src\/libyijinjing\//,
      /^framework\/core\/src\/libkungfu\//,
      /^framework\/core\/src\/bindings\//,
    ],
    re: AMBIGUOUS_HASH_API_RE,
    message:
      'Use fast_hash_* for internal non-cryptographic ids; content integrity must use tagged content hashes.',
  },
  {
    name: 'storage content hash misuse',
    files: [
      /^framework\/core\/src\/libyijinjing\/include\/kungfu\/yijinjing\/storage\//,
      /^framework\/core\/src\/libyijinjing\/src\/storage\//,
    ],
    re: /\b(fast_hash_|FAST_HASH_ALGORITHM)\b/g,
    message:
      'Storage content hashes must be explicit content hashes such as sha256/blake3, not fast internal ids.',
  },
  {
    name: 'retired pre-v4 fast hash implementation',
    files: [/^framework\/core\/src\//, /^framework\/core\/stubs\//],
    re: RETIRED_PRE_V4_FAST_HASH_RE,
    message:
      'The retired pre-v4 fast hash implementation must not re-enter active runtime source.',
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

function portable(relative) {
  return relative.split(path.sep).join('/');
}

function retirementExcluded(relative) {
  return (
    RETIREMENT_SELF_DESCRIPTION_FILES.has(relative) ||
    RETIREMENT_EXCLUDED_ROOTS.some((root) => relative.startsWith(root))
  );
}

function historicalTerminology(relative) {
  return (
    relative === RETIREMENT_LEDGER ||
    HISTORICAL_TERMINOLOGY_FILES.has(relative) ||
    HISTORICAL_TERMINOLOGY_ROOTS.some((root) => relative.startsWith(root))
  );
}

function allowedLedgerLine(line) {
  return LEDGER_ALLOWLIST.some((pattern) => pattern.test(line));
}

/**
 * @param {{path: string, text: string}[]} entries
 * @param {{enforceContracts?: boolean}} [options]
 */
export function retirementIssues(entries, { enforceContracts = false } = {}) {
  const issues = [];
  const byPath = new Map(entries.map((entry) => [entry.path, entry.text]));
  for (const entry of entries) {
    const relative = portable(entry.path);
    if (retirementExcluded(relative)) continue;
    if (
      /(?:^|\/)(?:pyi-hooks)(?:\/|$)/iu.test(relative) ||
      /(?:^|\/)[^/]+\.spec$/iu.test(relative) ||
      relative.toLowerCase().includes(PACKAGER_NAME.toLowerCase())
    ) {
      issues.push(`${relative}: retired product-packager path exists`);
    }

    const lines = entry.text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const location = `${relative}:${index + 1}`;
      if (line.toLowerCase().includes(PACKAGER_NAME.toLowerCase())) {
        if (relative !== RETIREMENT_LEDGER || !allowedLedgerLine(line)) {
          issues.push(`${location}: retired product-packager name is active`);
        }
      }
      for (const [label, signature] of RETIRED_SIGNATURES) {
        if (line.includes(signature)) {
          issues.push(`${location}: ${label} re-entered`);
        }
      }
      if (!historicalTerminology(relative)) {
        const lower = line.toLowerCase();
        for (const phrase of RETIRED_PRODUCT_TERMINOLOGY) {
          if (lower.includes(phrase)) {
            issues.push(`${location}: retired product term ${phrase}`);
          }
        }
      }
    }
  }

  if (!enforceContracts) return issues;
  const requireText = (relative, fragments) => {
    const text = byPath.get(relative) || '';
    for (const fragment of fragments) {
      if (!text.includes(fragment)) {
        issues.push(
          `${relative}: required retirement contract missing ${fragment}`,
        );
      }
    }
  };
  requireText('framework/core/.gyp/run-freeze.js', [
    'requireAssemblySelector(assemblySelector())',
    "selector !== 'assemble'",
    "form: 'assembled'",
    "'kungfu-trunk'",
  ]);
  requireText(
    'framework/core/tests/qualification/runtime-activation/product_smoke.mjs',
    [
      'inspectProductLayout',
      "kind: 'rust-trunk'",
      "kind: 'python-build-standalone'",
      'retiredPackagerEnvironmentKeys: []',
    ],
  );
  requireText('framework/core/pyproject.toml', ['"nuitka~=4.1.0"']);
  requireText('framework/core/uv.lock', ['name = "nuitka"']);
  requireText(
    'framework/core/src/python/kungfu/cli/bridging/nuitka/__init__.py',
    ['from nuitka.__main__ import main as nuitka_main'],
  );
  requireText('developer/sdk/src/sdk-contract.js', ["'nuitka'"]);
  requireText(
    'framework/core/src/python/kungfu/_runtime_service/supervisor.py',
    ['CREATE_BREAKAWAY_FROM_JOB', 'getattr(error, "winerror", None) != 5'],
  );
  requireText('framework/core/tests/python/test_runtime_service.py', [
    'test_windows_supervisor_breaks_away_from_parent_job',
    'test_windows_supervisor_falls_back_when_job_forbids_breakaway',
  ]);
  return issues;
}

function trackedRetirementEntries() {
  return splitLines(git(['ls-files'])).flatMap((relative) => {
    const absolute = path.join(ROOT, relative);
    if (!isFile(relative)) return [];
    const body = fs.readFileSync(absolute);
    if (body.includes(0)) return [];
    return [{ path: portable(relative), text: body.toString('utf8') }];
  });
}

function mergeBase() {
  const upstream = gitMaybe([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const candidates = [upstream, ...devMergeBaseCandidates()].filter(Boolean);
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
    rel !==
    'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/registry.h'
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

function directLegacyRegistryNameHits(rel, text) {
  if (
    rel ===
      'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/registry.h' ||
    rel ===
      'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/types.h' ||
    rel === 'framework/core/src/libyijinjing/check-deps.mjs' ||
    rel === 'scripts/check-runtime-greenfield.mjs'
  ) {
    return [];
  }
  if (!/^framework\/core\/src\/(bindings|libkungfu|libyijinjing)\//.test(rel)) {
    return [];
  }
  const hits = [];
  LEGACY_REGISTRY_RE.lastIndex = 0;
  for (const match of text.matchAll(LEGACY_REGISTRY_RE)) {
    hits.push({
      file: rel,
      line: lineNumber(text, match.index || 0),
      rule: 'legacy compiled registry',
      message:
        'LegacyCompiled* registries must not return; use the current core registry only.',
      text: match[0],
    });
  }
  return hits;
}

function storageBindingOwnershipHits(rel, text) {
  const hits = [];
  if (rel === 'framework/core/src/libkungfu/src/runtime/storage/provider.cpp') {
    const required = [
      '#include <rocksdb/db.h>',
      'class rocksdb_storage_provider',
      'rocksdb::DB::Open',
      'rocksdb::DB::OpenForReadOnly',
    ];
    for (const needle of required) {
      if (!text.includes(needle)) {
        hits.push({
          file: rel,
          line: 1,
          rule: 'storage provider ownership',
          message:
            'RocksDB storage provider ownership must stay in the libkungfu C++ runtime storage adapter.',
          text: needle,
        });
      }
    }
  }
  if (rel === 'framework/core/src/python/kungfu/storage/service.py') {
    const required = [
      'storage_service_capabilities',
      'make_storage_service_request',
      'run_storage_service_operation',
      'accept_storage_manifest',
      'export_storage_records',
      'write_storage_payload_bytes',
    ];
    for (const needle of required) {
      if (!text.includes(`_runtime().${needle}`)) {
        hits.push({
          file: rel,
          line: 1,
          rule: 'storage binding ownership',
          message:
            'Python storage service must remain a thin shim over the libkungfu runtime storage service.',
          text: needle,
        });
      }
    }
    for (const forbidden of [
      'rocksdb',
      'storage/rocksdb',
      'payload/<sha256>',
    ]) {
      if (text.includes(forbidden)) {
        hits.push({
          file: rel,
          line: lineNumber(text, text.indexOf(forbidden)),
          rule: 'storage provider ownership',
          message:
            'Python storage helpers must not know provider internals; route through libkungfu runtime storage service.',
          text: forbidden,
        });
      }
    }
  }
  if (rel === 'framework/core/lib/kungfu.js') {
    const required = [
      'binding.storageServiceCapabilities',
      'binding.makeStorageServiceRequest',
      'binding.runStorageServiceOperation',
      'binding.acceptStorageManifest',
      'binding.loadStorageLatestManifest',
      'binding.exportStorageRecords',
      'binding.writeStoragePayloadBytes',
    ];
    for (const needle of required) {
      if (!text.includes(needle)) {
        hits.push({
          file: rel,
          line: 1,
          rule: 'storage binding ownership',
          message:
            'Node public storage API must forward to the native binding instead of owning storage semantics.',
          text: needle,
        });
      }
    }
    for (const forbidden of [
      'rocksdb',
      'storage/rocksdb',
      'payload/<sha256>',
    ]) {
      if (text.includes(forbidden)) {
        hits.push({
          file: rel,
          line: lineNumber(text, text.indexOf(forbidden)),
          rule: 'storage provider ownership',
          message:
            'Node public storage API must not know provider internals; route through the native binding.',
          text: forbidden,
        });
      }
    }
  }
  if (rel === 'framework/core/src/bindings/node/binding/kungfu_node.cpp') {
    const required = [
      '#include <kungfu/runtime/storage/json_edge.h>',
      'storage_service_api::storage_service_capabilities',
      'storage_service_api::make_storage_service_request',
      'storage_service_api::run_storage_service_operation',
      'storage_service_api::accept_storage_manifest',
      'storage_service_api::load_storage_latest_manifest',
      'storage_service_api::export_storage_records',
      'storage_service_api::write_storage_payload_bytes',
    ];
    for (const needle of required) {
      if (!text.includes(needle)) {
        hits.push({
          file: rel,
          line: 1,
          rule: 'storage binding ownership',
          message:
            'Node native storage binding must be a JSON/bytes adapter over libkungfu storage_service_api.',
          text: needle,
        });
      }
    }
    for (const forbidden of [
      'yijinjing/storage/generic_service.h',
      'source_manifest_dir(',
      'latest_manifest_path(',
      'manifest_path(',
      'read_json_file(',
      'write_json_file(',
      'rocksdb/',
      'storage/rocksdb',
      'payload/<sha256>',
    ]) {
      if (text.includes(forbidden)) {
        hits.push({
          file: rel,
          line: lineNumber(text, text.indexOf(forbidden)),
          rule: 'storage binding ownership',
          message:
            'Node native binding must not reimplement storage provider internals; keep them in libkungfu.',
          text: forbidden,
        });
      }
    }
  }
  return hits;
}

function isAllowedRuleSelfReference(rel, rule) {
  if (
    rule.name === 'ambiguous fast hash api' &&
    rel === 'framework/core/src/bindings/python/binding/py-runtime.cpp'
  ) {
    return true;
  }
  return (
    rule.name === 'legacy compiled registry names' &&
    rel === 'framework/core/src/libyijinjing/check-deps.mjs'
  );
}

const hits = [];
for (const rel of selectedFiles()) {
  const rules = RULES.filter((rule) => rule.files.some((re) => re.test(rel)));
  if (!rules.length) continue;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const rule of rules) {
    if (isAllowedRuleSelfReference(rel, rule)) continue;
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
  hits.push(...directLegacyRegistryNameHits(rel, text));
  hits.push(...storageBindingOwnershipHits(rel, text));
}

if (hits.length) {
  console.error('[runtime-greenfield] trading-era runtime surface is blocked.');
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line} (${hit.rule}) ${hit.text}`);
    console.error(`    ${hit.message}`);
  }
  process.exit(1);
}

const retirementViolations = retirementIssues(trackedRetirementEntries(), {
  enforceContracts: true,
});
if (retirementViolations.length) {
  console.error('[runtime-greenfield] product-packager retirement violations:');
  for (const issue of retirementViolations) console.error(`  - ${issue}`);
  process.exit(1);
}

console.log(
  '[runtime-greenfield] gate passed; assembled product clean; KFX AOT and Windows Job Object contracts retained',
);
