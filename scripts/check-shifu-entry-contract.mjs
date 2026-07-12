#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Keep participant-facing development/build commands on the Shifu entrypoint.
// Implementation files intentionally remain outside this scan: Shifu and the
// package scripts must be able to call the underlying tools they orchestrate.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKDOWN_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'CONTRIBUTING.md',
  '.github/copilot-instructions.md',
];
const CONFIG_FILES = ['.buildchain/buildchain.toml'];
const WORKFLOW_DIR = '.github/workflows';
const REQUIRED_AGENT_POINTERS = [
  'CLAUDE.md',
  '.github/copilot-instructions.md',
];
const PACKAGE_SCRIPT_EXCEPTIONS = new Set([
  // Package-manager lifecycle hooks: version is called by the release tool;
  // prepare is called by install after preinstall has proved Shifu provenance.
  'version',
  'prepare',
]);
const ALLOW = /shifu-entry-contract:\s*allow\s+(.\S.*)$/i;
const DIRECT_TOOL =
  /(?:^|&&|\|\||[;&|]|\$\(|\b(?:then|do|exec|call)\s+)(?:(?:env|sudo|command)\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:corepack(?:\.cmd)?\s+)?(pnpm|node|conan|cmake)\b/i;

/** @param {string} root */
export function governedFiles(root = ROOT) {
  const files = [...MARKDOWN_FILES, ...CONFIG_FILES].filter((rel) =>
    fs.existsSync(path.join(root, rel)),
  );
  const workflowRoot = path.join(root, WORKFLOW_DIR);
  if (fs.existsSync(workflowRoot)) {
    for (const name of fs.readdirSync(workflowRoot).sort()) {
      if (/\.ya?ml$/i.test(name)) files.push(`${WORKFLOW_DIR}/${name}`);
    }
  }
  return files;
}

/** @param {string} line */
function directTool(line) {
  const normalized = line.trim().replace(/^\$\s+/, '');
  if (!normalized || normalized.startsWith('#')) return null;
  return normalized.match(DIRECT_TOOL)?.[1]?.toLowerCase() || null;
}

/**
 * @param {string} rel
 * @param {string} text
 * @returns {{file: string, line: number, tool: string, source: string}[]}
 */
export function scanText(rel, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const markdown = /\.md$/i.test(rel);
  const yaml = /\.ya?ml$/i.test(rel);
  const toml = /\.toml$/i.test(rel);
  let shellFence = false;
  let runIndent = null;
  let allowance = null;

  for (let index = 0; index < lines.length; index += 1) {
    const source = lines[index];
    const trimmed = source.trim();
    const indent = source.length - source.trimStart().length;
    const allow = trimmed.match(ALLOW);
    if (allow) {
      allowance = allow[1].trim();
      continue;
    }

    if (markdown && /^```/.test(trimmed)) {
      if (shellFence) shellFence = false;
      else
        shellFence =
          /^```(?:sh|bash|zsh|fish|shell|console|powershell|pwsh|cmd|bat)\s*$/i.test(
            trimmed,
          );
      allowance = null;
      continue;
    }

    let command = null;
    if (markdown && shellFence) command = trimmed;
    if (toml) {
      const match = trimmed.match(/^command\s*=\s*["'](.*)["']\s*$/);
      if (match) command = match[1];
    }
    if (yaml) {
      if (runIndent !== null && trimmed && indent <= runIndent)
        runIndent = null;
      if (runIndent !== null) command = trimmed;
      const match = trimmed.match(/^(?:-\s*)?run:\s*(.*)$/);
      if (match) {
        if (/^[>|][-+]?\s*$/.test(match[1])) runIndent = indent;
        else command = match[1];
      }
    }

    const tool = command && directTool(command);
    if (tool) {
      if (allowance) {
        allowance = null;
        continue;
      }
      findings.push({ file: rel, line: index + 1, tool, source: trimmed });
    } else if (trimmed && !trimmed.startsWith('#')) {
      allowance = null;
    }
  }
  return findings;
}

/** @param {string} root */
export function checkRoot(root = ROOT) {
  const findings = [];
  for (const rel of governedFiles(root)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    findings.push(...scanText(rel, text));
  }
  for (const rel of REQUIRED_AGENT_POINTERS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      findings.push({
        file: rel,
        line: 1,
        tool: 'discovery',
        source: 'required agent pointer is missing',
      });
      continue;
    }
    if (!fs.readFileSync(file, 'utf8').includes('AGENTS.md')) {
      findings.push({
        file: rel,
        line: 1,
        tool: 'discovery',
        source: 'agent pointer must route to AGENTS.md',
      });
    }
  }

  const markerFiles = [
    ['AGENTS.md', 'Do not invoke pnpm,'],
    ['AGENTS.md', './shifu build'],
    ['shifu', 'export SHIFU_ENTRYPOINT=1'],
    ['shifu.cmd', 'set "SHIFU_ENTRYPOINT=1"'],
    ['crates/shifu/src/dispatch.rs', '"SHIFU_ENTRYPOINT", "1"'],
    ['scripts/verify.mjs', 'check-shifu-entry-contract.mjs'],
  ];
  for (const [rel, marker] of markerFiles) {
    const file = path.join(root, rel);
    if (
      !fs.existsSync(file) ||
      !fs.readFileSync(file, 'utf8').includes(marker)
    ) {
      findings.push({
        file: rel,
        line: 1,
        tool: 'runtime-marker',
        source: `missing required marker: ${marker}`,
      });
    }
  }

  const packageFile = path.join(root, 'package.json');
  const scripts =
    JSON.parse(fs.readFileSync(packageFile, 'utf8')).scripts || {};
  for (const [task, command] of Object.entries(scripts)) {
    if (PACKAGE_SCRIPT_EXCEPTIONS.has(task)) continue;
    const guardTask = task === 'preinstall' ? 'install' : task;
    const prefix = `node scripts/require-shifu.mjs ${guardTask}`;
    if (!String(command).startsWith(prefix)) {
      findings.push({
        file: 'package.json',
        line: 1,
        tool: 'runtime-guard',
        source: `script ${task} must start with: ${prefix}`,
      });
    }
  }
  return findings;
}

function main() {
  const findings = checkRoot();
  if (!findings.length) {
    console.log('[shifu-entry] participant-facing commands use Shifu');
    return;
  }
  console.error('[shifu-entry] Shifu entry contract violation:');
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line}: ${finding.tool}: ${finding.source}`,
    );
  }
  console.error(
    'Use ./shifu <task>. For a necessary implementation/bootstrap exception, add a preceding comment:',
  );
  console.error(
    '  shifu-entry-contract: allow <specific reason this cannot enter through Shifu>',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
