// SPDX-License-Identifier: Apache-2.0
// @ts-check

const GITHUB_PUNCTUATION = /[^\p{L}\p{M}\p{N}_ -]/gu;

/** @param {string} value */
function githubSlug(value) {
  return value.toLowerCase().replace(GITHUB_PUNCTUATION, '').replace(/ /g, '-');
}

export class ReadonlyGithubSlugger {
  constructor() {
    /** @type {Record<string, number>} */
    this.occurrences = Object.create(null);
  }

  /** @param {string} value */
  slug(value) {
    const original = githubSlug(value);
    let result = original;
    while (Object.hasOwn(this.occurrences, result)) {
      this.occurrences[original] += 1;
      result = `${original}-${this.occurrences[original]}`;
    }
    this.occurrences[result] = 0;
    return result;
  }
}

/** @param {string} value */
function inlineText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** @param {string} destination */
function normalizeDestination(destination) {
  const trimmed = destination.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Dependency-free Markdown discovery for cold, read-only source checkouts.
 * It covers headings, inline/reference links, images, and fenced examples; the
 * installed toolchain remains the richer parser and CI authority.
 *
 * @param {string} text
 */
export function parseReadonlyMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  const links = [];
  const examples = [];
  const references = new Map();
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      if (!fence) {
        fence = {
          marker: fenceMatch[1][0],
          size: fenceMatch[1].length,
          info: fenceMatch[2],
          line: lineNumber,
          body: [],
        };
      } else if (
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.size
      ) {
        const example = /(?:^|\s)docs-exec=([a-z0-9][a-z0-9-]*)\b/.exec(
          fence.info,
        );
        if (example) {
          examples.push({
            id: example[1],
            line: fence.line,
            source: fence.body.join('\n').trim(),
          });
        }
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    if (fence) {
      fence.body.push(line);
      continue;
    }

    const reference = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/.exec(line);
    if (reference) {
      references.set(reference[1].trim().toLowerCase(), {
        href: normalizeDestination(reference[2]),
        line: lineNumber,
      });
      continue;
    }

    const atx = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
    if (atx) headings.push(inlineText(atx[1]));
    else if (
      index > 0 &&
      /^\s{0,3}(?:=+|-+)\s*$/.test(line) &&
      lines[index - 1].trim()
    ) {
      headings.push(inlineText(lines[index - 1]));
    }

    const inlineLink =
      /!?\[[^\]]*\]\(\s*(<[^>]+>|(?:\\.|[^)\s])+)(?:\s+["'][^"']*["'])?\s*\)/g;
    for (const match of line.matchAll(inlineLink)) {
      links.push({
        href: normalizeDestination(match[1]),
        line: lineNumber,
      });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,3}\[[^\]]+\]:/.test(line)) continue;
    const referenceLink = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
    for (const match of line.matchAll(referenceLink)) {
      const key = (match[2] || match[1]).trim().toLowerCase();
      const reference = references.get(key);
      if (reference) links.push({ href: reference.href, line: index + 1 });
    }
  }

  return { headings, links, examples };
}
